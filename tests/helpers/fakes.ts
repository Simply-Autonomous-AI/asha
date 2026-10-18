// Test doubles for the daemon's seams. Each records every interaction so tests
// can assert exactly what was called, with which arguments, in which order.

import { appendFileSync } from 'node:fs';

import type { LogFields, Logger } from '../../src/daemon/log.js';
import { present } from '../../src/shared/assert-present.js';
import {
  CommandNotFound,
  type CommandResult,
  type CommandRunner,
  type RunOptions,
  type StreamOptions,
  type StreamResult,
} from '../../src/daemon/process/index.js';
import type {
  InteractiveLauncher,
  InteractiveOptions,
  InteractiveProcess,
  LaunchOptions,
  LaunchedProcess,
  ProcessExit,
  ProcessLauncher,
} from '../../src/daemon/process/launcher.js';

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields;
}

export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];
  info(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'info', event, fields });
  }
  warn(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'warn', event, fields });
  }
  error(event: string, fields: LogFields & { readonly error: unknown }): void {
    this.entries.push({ level: 'error', event, fields });
  }
  events(level?: LogEntry['level']): string[] {
    return this.entries.filter((e) => level === undefined || e.level === level).map((e) => e.event);
  }
}

export interface RecordedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
}

type Scripted =
  CommandResult | { readonly code: number; readonly stdout: Uint8Array; readonly stderr: string } | 'not-found' | Error;

/**
 * Answers each command from a queue keyed by `command arg0 arg1…`; the first
 * matching key prefix wins. An unscripted command fails the test.
 */
export class FakeRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  private readonly script: [string, Scripted[]][] = [];

  on(prefix: string, ...results: Scripted[]): this {
    this.script.push([prefix, results]);
    return this;
  }

  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const line = [command, ...args].join(' ');
    const entry = this.script.find(([prefix, results]) => line.startsWith(prefix) && results.length > 0);
    if (!entry) return Promise.reject(new Error(`FakeRunner: unscripted command: ${line}`));
    const result = present(
      entry[1].length > 1 ? entry[1].shift() : entry[1][0],
      `FakeRunner: the next scripted result for ${line}`,
    );
    if (result === 'not-found') return Promise.reject(new CommandNotFound(command));
    if (result instanceof Error) return Promise.reject(result);
    if (typeof result.stdout !== 'string')
      return Promise.reject(
        new Error(`FakeRunner: ${line} is scripted with binary stdout, which only a streamed command reads`),
      );
    return Promise.resolve({ code: result.code, stdout: result.stdout, stderr: result.stderr });
  }

  lines(): string[] {
    return this.calls.map((c) => [c.command, ...c.args].join(' '));
  }

  /** Each streamed command's standard input, read in full, by its index in `calls`. */
  readonly stdins = new Map<number, Buffer>();
  /** Each streamed command's options, by its index in `calls`. */
  readonly streamOptions = new Map<number, StreamOptions>();
  /** Chunk size a streamed command's scripted stdout is handed over in. */
  streamChunk = 64 * 1024;
  /** Called before a streamed command answers: lets a test hold one (a slow copy) or act at that point. */
  beforeStream: (line: string) => Promise<void> = () => Promise.resolve(undefined);

  /** Every chunk of `options.stdin`, read to its end and concatenated; empty when there is none. */
  private async readStdin(options: StreamOptions): Promise<Buffer> {
    const parts: Buffer[] = [];
    if (options.stdin !== undefined) for await (const chunk of options.stdin) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
  }

  /** Hands `stdout` to `options.onStdout` in `streamChunk` pieces until it answers stop; whether it did. */
  private async emitStdout(stdout: Buffer, options: StreamOptions): Promise<boolean> {
    let stopped = false;
    if (options.onStdout !== undefined) {
      for (let i = 0; i < stdout.length && !stopped; i += this.streamChunk)
        stopped = (await options.onStdout(stdout.subarray(i, i + this.streamChunk))) === 'stop';
    }
    return stopped;
  }

  /**
   * Answers a streamed command from the same script as run: its stdin read in full first, then its stdout handed to
   * onStdout in `streamChunk` pieces until it answers stop. A scripted Error or 'not-found' throws, as run's do.
   */
  async stream(command: string, args: readonly string[], options: StreamOptions): Promise<StreamResult> {
    const index = this.calls.length;
    this.calls.push({
      command,
      args,
      options: { timeoutMs: options.timeoutMs, ...(options.env === undefined ? {} : { env: options.env }) },
    });
    this.streamOptions.set(index, options);
    const line = [command, ...args].join(' ');
    const entry = this.script.find(([prefix, results]) => line.startsWith(prefix) && results.length > 0);
    if (!entry) throw new Error(`FakeRunner: unscripted command: ${line}`);
    const result = present(
      entry[1].length > 1 ? entry[1].shift() : entry[1][0],
      `FakeRunner: the next scripted result for ${line}`,
    );
    this.stdins.set(index, await this.readStdin(options));
    await this.beforeStream(line);
    if (options.signal?.aborted === true) throw options.signal.reason;
    if (result === 'not-found') throw new CommandNotFound(command);
    if (result instanceof Error) throw result;
    // Narrowed per branch, not Buffer.from(result.stdout) directly: result.stdout is `string | Uint8Array`, and
    // newer @types/node's generic Buffer<T> overloads no longer resolve across that union in one call. The
    // explicit 'utf8' is Buffer.from(string)'s own default, named only so the two branches aren't identical text.
    const stdout = typeof result.stdout === 'string' ? Buffer.from(result.stdout, 'utf8') : Buffer.from(result.stdout);
    const stopped = await this.emitStdout(stdout, options);
    if (result.stderr !== '') options.onStderr?.(Buffer.from(result.stderr));
    if (options.stderrFile !== undefined && result.stderr !== '') appendFileSync(options.stderrFile, result.stderr);
    return {
      code: stopped ? 137 : result.code,
      stderr: options.stderrFile === undefined ? result.stderr : '',
      stopped,
    };
  }
}

/**
 * The colima VM's flock table, shared by every LockingRunner of a test: one exclusive lock per tag's lock file, as
 * `flock` holds them, and the images lock (debt-paydown-2 R3), held shared by builds and exclusively by a prune.
 */
export class VmLocks {
  /** Each tag's lock file held now, and what resolves when it is released. */
  readonly held = new Map<string, Promise<void>>();
  /** Build sessions holding the images lock shared now. */
  shared = 0;
  /** Resolves when the prune holding the images lock exclusively releases it; undefined while none holds it. */
  exclusive: Promise<void> | undefined;
  /**
   * What happened to the locks, in order: `take <file>`, `release <file>` (a tag's lock, or the images lock taken by a
   * prune), `share <images lock>`, `unshare <images lock>` (a build's), `busy <images lock>` (a prune that found it held).
   */
  readonly events: string[] = [];
}

const IMAGES_LOCK = '/run/asha-images.lock';

/**
 * A FakeRunner that answers the image lock sessions as the VM would. A build's (debt-paydown R18, debt-paydown-2 R3):
 * `colima ssh … sudo sh -c exec 8>/run/asha-images.lock; flock -s -w 30 8 || exit 6; exec 9><tag lock>; flock -w 600 9
 * || exit 4; echo locked; read _ || true` waits while a prune holds the images lock, shares it, waits while another
 * session holds its tag's lock, prints `locked`, and holds both until its standard input ends. A prune's (`flock -x -n
 * 8`): prints `busy` and exits 5 when any build shares the images lock or a prune holds it; else takes it, prints
 * `locked`, and holds it until its standard input ends. `lockAnswer` scripts a build's session that exits at once with
 * a status (4: flock waited 600 s; 6: a prune held the images lock 30 s), ended as colima ends it (colimaExit, probe Q4), or that never prints and never ends ('hang',
 * until its abort); `pruneAnswer` the same for a prune's ('hang', or an exit code). Every other command goes to the
 * FakeRunner script.
 */
export class LockingRunner extends FakeRunner {
  lockAnswer: 'take' | 'hang' | number = 'take';
  pruneAnswer: 'take' | 'hang' | number = 'take';
  constructor(readonly locks = new VmLocks()) {
    super();
  }

  /** A prune session holding the images lock exclusively, extracted from `stream` for its cognitive complexity. */
  private async pruneSession(options: StreamOptions): Promise<StreamResult> {
    if (this.locks.shared > 0 || this.locks.exclusive !== undefined) {
      this.locks.events.push(`busy ${IMAGES_LOCK}`);
      await options.onStdout?.(Buffer.from('busy\n'));
      return colimaExit(5);
    }
    let free!: () => void;
    this.locks.exclusive = new Promise<void>((resolve) => (free = resolve));
    this.locks.events.push(`take ${IMAGES_LOCK}`);
    await options.onStdout?.(Buffer.from('locked\n'));
    // Held until its stdin ends, or its client is killed (an abort), which releases the lock too (probe Q2 (e)).
    const killed = await heldUntilStdinEnds(options);
    this.locks.exclusive = undefined;
    this.locks.events.push(`release ${IMAGES_LOCK}`);
    free();
    if (killed !== undefined) throw killed instanceof Error ? killed : new Error(JSON.stringify(killed));
    return { code: 0, stderr: '', stopped: false };
  }

  /** A build session sharing the images lock and holding its own tag's, extracted from `stream` for its complexity. */
  private async buildSession(lock: string, options: StreamOptions): Promise<StreamResult> {
    while (this.locks.exclusive !== undefined) await this.locks.exclusive;
    this.locks.shared += 1;
    this.locks.events.push(`share ${IMAGES_LOCK}`);
    while (this.locks.held.has(lock)) await this.locks.held.get(lock);
    let free!: () => void;
    this.locks.held.set(lock, new Promise<void>((resolve) => (free = resolve)));
    this.locks.events.push(`take ${lock}`);
    await options.onStdout?.(Buffer.from('locked\n'));
    if (options.stdin !== undefined) await drained(options.stdin);
    this.locks.held.delete(lock);
    this.locks.events.push(`release ${lock}`);
    free();
    this.locks.shared -= 1;
    this.locks.events.push(`unshare ${IMAGES_LOCK}`);
    return { code: 0, stderr: '', stopped: false };
  }

  override async stream(command: string, args: readonly string[], options: StreamOptions): Promise<StreamResult> {
    const line = [command, ...args].join(' ');
    const build =
      /^colima ssh --profile \S+ -- sudo sh -c exec 8>\/run\/asha-images\.lock; flock -s -w 30 8 \|\| exit 6; exec 9>(\/run\/asha-image-[0-9a-f]{64}\.lock); /.exec(
        line,
      )?.[1];
    const prune = /^colima ssh --profile \S+ -- sudo sh -c exec 8>\/run\/asha-images\.lock; flock -x -n 8 /.test(line);
    if (build === undefined && !prune) return super.stream(command, args, options);
    this.calls.push({ command, args, options: { timeoutMs: options.timeoutMs } });
    const answer = prune ? this.pruneAnswer : this.lockAnswer;
    if (typeof answer === 'number') return colimaExit(answer);
    if (answer === 'hang') {
      const signal = present(options.signal, 'options.signal');
      return new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        );
      });
    }
    return prune ? this.pruneSession(options) : this.buildSession(present(build, 'build'), options);
  }
}

/**
 * How `colima ssh` ends when the command it ran in the VM exits `status` (probe Q4): 0 as itself; any other status as
 * exit 1, the real one named only on its standard error.
 */
export function colimaExit(status: number): StreamResult {
  if (status === 0) return { code: 0, stderr: '', stopped: false };
  return {
    code: 1,
    stderr: `time="2026-10-03T10:53:45-05:00" level=fatal msg="exit status ${String(status)}"\n`,
    stopped: false,
  };
}

/**
 * Reads `source` to its end, discarding every value: fully drains an async iterable (a session's stdin) without
 * reading any of it. Written on the iterator protocol rather than `for await (const x of source) x;`, which is a
 * no-op expression statement every value flows through for nothing.
 */
async function drained(source: AsyncIterable<unknown>): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  for (let step = await iterator.next(); !step.done; step = await iterator.next());
}

/** Reads a session's stdin to its end; or, when its signal aborts first, resolves with the abort's reason. */
async function heldUntilStdinEnds(options: StreamOptions): Promise<unknown> {
  const signal = options.signal;
  const ended = (async () => {
    if (options.stdin !== undefined) await drained(options.stdin);
    return undefined;
  })();
  if (signal === undefined) return ended;
  if (signal.aborted) return signal.reason;
  return Promise.race([
    ended,
    new Promise<unknown>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          resolve(signal.reason);
        },
        { once: true },
      );
    }),
  ]);
}

export const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
export const fail = (code: number, stderr: string): CommandResult => ({ code, stdout: '', stderr });

let nextFakePid = 0;

export class FakeProcess implements LaunchedProcess {
  readonly signals: NodeJS.Signals[] = [];
  /** A pid of its own, as model_server.ready logs it (debt-paydown R12). */
  pid: number | undefined = 40_000 + nextFakePid++;
  readonly exited: Promise<ProcessExit>;
  private resolveExit!: (exit: ProcessExit) => void;
  private rejectExit!: (error: Error) => void;

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: LaunchOptions,
  ) {
    this.exited = new Promise((resolve, reject) => {
      this.resolveExit = resolve;
      this.rejectExit = reject;
    });
  }

  /** Simulates a line of output: appended to the log file and passed to onLine. */
  emit(line: string): void {
    if (this.options.logFile !== null) appendFileSync(this.options.logFile, `${line}\n`);
    this.options.onOutput?.(Buffer.from(`${line}\n`));
    this.options.onLine?.(line);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.resolveExit({ code, signal });
  }

  failToStart(error: Error): void {
    this.rejectExit(error);
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
  }
}

export class FakeLauncher implements ProcessLauncher {
  readonly launched: FakeProcess[] = [];
  /** Called synchronously with each new process, to script its behaviour. */
  onLaunch: (process: FakeProcess) => void = () => undefined;
  /** Whether a watched process's watch names its command's pid, as the real one does first; false: it never does. */
  namesPid = true;

  launch(command: string, args: readonly string[], options: LaunchOptions): LaunchedProcess {
    const process = new FakeProcess(command, args, options);
    this.launched.push(process);
    // As the real watch does, first: the command's own pid, the watch's pid + 50,000 here (idle-shutdown R5).
    if (options.dieWithParent === true && this.namesPid)
      process.emit(`asha-watch: pid ${String(present(process.pid, 'pid') + 50_000)}`);
    this.onLaunch(process);
    return process;
  }
}

/** An interactive process as the fake runs it: what was written, and the means to answer on stdout and stderr. */
export class FakeInteractiveProcess implements InteractiveProcess {
  readonly written: string[] = [];
  ended = false;
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<ProcessExit>;
  private resolveExit!: (exit: ProcessExit) => void;
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: InteractiveOptions,
  ) {
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
  }
  write(text: string): boolean {
    if (this.ended) return false;
    this.written.push(text);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
  }
  exit(code: number | null): void {
    this.ended = true;
    this.resolveExit({ code, signal: null });
  }
}

export class FakeInteractive implements InteractiveLauncher {
  readonly launched: FakeInteractiveProcess[] = [];
  launchInteractive(command: string, args: readonly string[], options: InteractiveOptions): InteractiveProcess {
    const process = new FakeInteractiveProcess(command, args, options);
    this.launched.push(process);
    return process;
  }
}

/** A fetch that answers from a handler and records every request. */
export class FakeFetch {
  readonly requests: { url: string; init: RequestInit | undefined }[] = [];
  constructor(private readonly handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response) {}

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    this.requests.push({ url, init });
    return this.handler(url, init);
  }) as typeof fetch;

  bodies(): unknown[] {
    return this.requests.map((r) =>
      typeof r.init?.body === 'string' ? (JSON.parse(r.init.body) as unknown) : undefined,
    );
  }
}

/**
 * A server that never answers: the request settles only through its signal, as real fetch's does — rejected with the
 * signal's reason at once when the signal is already aborted, else when it aborts.
 */
export function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  const signal = present(present(init, 'init').signal, 'init.signal');
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An in-memory user ledger: the same contract as FileUserLedger, without the file. */
export class MemoryUserLedger {
  readonly highest = new Map<string, number>();
  issue(channel: string): number {
    const n = (this.highest.get(channel) ?? 0) + 1;
    this.highest.set(channel, n);
    return n;
  }
  observe(channel: string, n: number): void {
    if (n > (this.highest.get(channel) ?? 0)) this.highest.set(channel, n);
  }
}

/**
 * A Schedule whose timers run only when the test says (`fire`), so a window
 * of refusal logging ends exactly where the test puts it.
 */
export class ManualSchedule {
  private readonly timers: { callback: () => void; ms: number; cancelled: boolean }[] = [];

  readonly schedule = (callback: () => void, ms: number): (() => void) => {
    const timer = { callback, ms, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  /** The delays of the timers still waiting. */
  pending(): number[] {
    return this.timers.filter((t) => !t.cancelled).map((t) => t.ms);
  }

  /** Runs every timer scheduled so far (not those they schedule). */
  fire(): void {
    for (const timer of this.timers.splice(0)) if (!timer.cancelled) timer.callback();
  }
}

/** An agent log (the SDK's facade) that records every entry, for asserting tool failures and file audits. */
export class RecordingAgentLog {
  readonly entries: {
    readonly level: 'info' | 'warn' | 'error';
    readonly event: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }[] = [];
  info(event: string, fields: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'info', event, fields });
  }
  warn(event: string, fields: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'warn', event, fields });
  }
  error(event: string, fields: Readonly<Record<string, unknown>> & { readonly error: unknown }): void {
    this.entries.push({ level: 'error', event, fields });
  }
}

/** CliContext's input and interrupt for a command that is not --interactive: reading input fails the test. */
export const NOT_INTERACTIVE = {
  input: {
    lines: {
      [Symbol.asyncIterator]: (): AsyncIterator<string> => {
        throw new Error('input read by a command that is not --interactive');
      },
    },
    isTerminal: false,
  },
  // Never resolves: no Ctrl-C arrives.
  interrupt: () => new Promise<void>(() => undefined),
  terminal: { stdout: false, stderr: false },
} as const;

/** A CLI context's portal opener for a command that is not --portal (docs/plans/portal.md R1): any use is a defect. */
export const NO_PORTAL = {
  portal: {
    writeFile: (): Promise<void> =>
      Promise.reject(new Error('the portal file written by a command that is not --portal')),
    open: (): never => {
      throw new Error('a browser opened by a command that is not --portal');
    },
  },
} as const;
