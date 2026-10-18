// Long-lived child processes (a model server, an agent container). The seam
// unit tests replace, as CommandRunner is for short commands.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { CommandNotFound } from './index.js';

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface LaunchedProcess {
  /** Its pid, or undefined when it could not be started (Node's `child.pid`). */
  readonly pid: number | undefined;
  /** Settles once, when the process exits. Rejects if it could not be started. */
  readonly exited: Promise<ProcessExit>;
  kill(signal: NodeJS.Signals): void;
}

export interface LaunchOptions {
  /** Added to the daemon's environment for this process only. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Names taken out of the daemon's environment for this process only (the decision model's HF_TOKEN,
   * docs/plans/decider-tool.md R3). Default: none.
   */
  readonly removeEnv?: readonly string[];
  /**
   * stdout and stderr are appended here; null: not written to any file by the launcher, the caller keeping its own
   * bounded copy through `onOutput` (the decision model's log, R5).
   */
  readonly logFile: string | null;
  /** Called with each line of stdout and stderr, for processes that announce state. */
  readonly onLine?: (line: string) => void;
  /** Called with each chunk of stdout and stderr, as it comes. Default: none. */
  readonly onOutput?: (chunk: Buffer) => void;
  /**
   * Runs the process under WATCH_SCRIPT, which ends it when this daemon's process ends, however it ended — SIGKILL
   * included — since macOS has no parent-death signal (docs/plans/idle-shutdown.md R5). Its first line of stderr is
   * `asha-watch: pid <n>`, the command's own pid (`pid` is the watch's). Default: false.
   */
  readonly dieWithParent?: boolean;
}

/** WATCH_SCRIPT's first line of stderr, naming the pid of the command it runs; group 1 is the pid. */
export const WATCH_PID_LINE = /^asha-watch: pid (\d+)$/;
/** After passing a stop on, how long the watch gives the command before SIGKILL (idle-shutdown R5). */
export const WATCH_KILL_AFTER_S = 8;
/**
 * The shell the watch runs in: dash, which macOS ships, and not `/bin/sh`, which on macOS is bash 3.2. Sent a burst of
 * 30 stop signals on a loaded Mac, 9 of 240 bash watches died by a signal (SIGSEGV, mostly) before passing the stop on
 * and 6 hung, never sending their SIGKILL — 8 servers left running unwatched; all 240 dash watches did their job
 * (2026-10-16, evals/probes/watch-shell-2026-10-16/; idle-shutdown R5 as amended). A Mac without dash fails the launch.
 */
export const WATCH_SHELL = '/bin/dash';

/**
 * The watch `dieWithParent` runs a process under, as `WATCH_SHELL -c WATCH_SCRIPT asha-watch <command> <args…>`, its
 * standard input a pipe whose other end only the daemon holds and never writes. It starts the command with no standard
 * input and prints `asha-watch: pid <n>` to stderr. When that pipe reaches its end — the daemon's process has ended,
 * however it ended, and the kernel closed its end — or the watch gets SIGTERM, SIGINT or SIGHUP, it sends the command
 * one SIGTERM, then SIGKILL WATCH_KILL_AFTER_S seconds later if it is still running. It exits with the command's status,
 * ending its own helpers (the pipe's reader, the SIGKILL timer) as it goes. No pid is polled: the watch is the command's
 * parent, so the command's pid cannot be reused before the watch has seen it exit. It must lead its own process group
 * (`detached`), since it ends its helpers by signalling that group: anywhere else it refuses to start, exiting 125. A
 * stop that comes before the command starts means it never does: the watch exits 143, naming no pid. One that comes in
 * the instant between the command's fork and its exec can be lost (the forked shell still has the watch's trap), and
 * then the SIGKILL ends it, WATCH_KILL_AFTER_S seconds later.
 */
export const WATCH_SCRIPT = [
  'leader=$(ps -o pgid= -p $$ | tr -d " ")',
  'if [ "$leader" != "$$" ]; then',
  '  echo "asha-watch: refused: pid $$ does not lead its process group (pgid $leader)" >&2',
  '  exit 125',
  'fi',
  'child=',
  'requested=0',
  'stopping=0',
  'interrupted=0',
  'stop() {',
  '  interrupted=1',
  '  requested=1',
  '  if [ -z "$child" ] || [ "$stopping" = 1 ]; then return; fi',
  '  stopping=1',
  '  kill -TERM "$child" 2>/dev/null',
  `  { sleep ${String(WATCH_KILL_AFTER_S)}; kill -KILL "$child" 2>/dev/null; } </dev/null >/dev/null 2>&1 3<&- &`,
  '}',
  // Set before the command starts, so a stop that comes first is not lost: no command is started, or it is passed on.
  'trap stop TERM INT HUP',
  'exec 3<&0 </dev/null',
  'if [ "$requested" = 1 ]; then exit 143; fi',
  '"$@" 3<&- &',
  'child=$!',
  `printf 'asha-watch: pid %s\\n' "$child" >&2`,
  'if [ "$requested" = 1 ]; then stop; fi',
  // The pipe's reader: its end of file is the daemon gone. Its output to /dev/null, so it never holds the command's pipes.
  '{ cat >/dev/null; kill -TERM $$; } <&3 >/dev/null 2>&1 &',
  'exec 3<&-',
  // A trapped signal ends a wait early, after its trap has run: wait again until the command itself has exited.
  'while :; do',
  '  interrupted=0',
  '  wait "$child"',
  '  status=$?',
  '  if [ "$interrupted" = 0 ]; then break; fi',
  'done',
  // The watch leads its own process group: the rest of the group is its helpers, ended now that the command has.
  "trap '' TERM INT HUP",
  'kill -TERM 0 2>/dev/null',
  'exit "$status"',
].join('\n');

export interface ProcessLauncher {
  launch(command: string, args: readonly string[], options: LaunchOptions): LaunchedProcess;
}

export class SpawnProcessLauncher implements ProcessLauncher {
  launch(command: string, args: readonly string[], options: LaunchOptions): LaunchedProcess {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    for (const name of options.removeEnv ?? []) Reflect.deleteProperty(env, name);
    const watched = options.dieWithParent === true;
    const child = watched
      ? spawn(WATCH_SHELL, ['-c', WATCH_SCRIPT, 'asha-watch', command, ...args], {
          env,
          // Standard input a pipe never written: only this process holds its other end, so its end of file is this
          // process gone (libuv marks the daemon's end close-on-exec, so no other child holds it open).
          stdio: ['pipe', 'pipe', 'pipe'],
          // Its own process group, the watch its leader: a SIGKILL (kill() below) reaches the command too.
          detached: true,
        })
      : spawn(command, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = options.logFile === null ? undefined : createWriteStream(options.logFile, { flags: 'a' });
    for (const stream of [child.stdout, child.stderr]) {
      if (log !== undefined) stream.pipe(log, { end: false });
      if (options.onOutput) {
        const onOutput = options.onOutput;
        stream.on('data', (chunk: Buffer) => {
          onOutput(chunk);
        });
      }
      if (options.onLine) {
        const onLine = options.onLine;
        createInterface({ input: stream }).on('line', onLine);
      }
    }
    const exited = new Promise<ProcessExit>((resolve, reject) => {
      child.once('error', (error) => {
        log?.end();
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new CommandNotFound(command));
        else reject(new Error(`${command} failed to start: ${error.message}`, { cause: error }));
      });
      child.once('close', (code, signal) => {
        log?.end();
        resolve({ code, signal });
      });
    });
    return {
      pid: child.pid,
      exited,
      kill: (signal) => {
        // A watched process's SIGKILL goes to its whole group, since the watch cannot pass it on; any other signal to the
        // watch alone, which passes one SIGTERM on — never two, which llama-server takes as "exit now", skipping its own
        // shutdown (idle-shutdown R5).
        if (
          watched &&
          signal === 'SIGKILL' &&
          child.pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            // ESRCH: the group has already ended, which is what was asked; anything else is a failure to surface.
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        } else child.kill(signal);
      },
    };
  }
}

/**
 * A long-lived process whose standard input the daemon writes and whose standard output it reads (an extension
 * module's container, docs/plans/extension-modules.md R5, R34): stdout handed over chunk by chunk, stderr line by
 * line, and its exit.
 */
export interface InteractiveProcess {
  /** Settles once, when the process exits; rejects if it could not be started. */
  readonly exited: Promise<ProcessExit>;
  /** Writes to its standard input; false once the input is closed (the process exited). */
  write(text: string): boolean;
  /** Closes its standard input. */
  end(): void;
  kill(signal: NodeJS.Signals): void;
}

export interface InteractiveOptions {
  /** Added to the daemon's environment for this process only: how `docker run -e NAME` gets a value off the command line. */
  readonly env: Readonly<Record<string, string>>;
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderrLine: (line: string) => void;
}

export interface InteractiveLauncher {
  launchInteractive(command: string, args: readonly string[], options: InteractiveOptions): InteractiveProcess;
}

/** The longest stderr line kept whole: past it, the rest of the line is dropped and counted (review of 2026-10-02, B-15). */
const MAX_STDERR_LINE_CHARS = 16_384;

/**
 * Splits text into lines, at most `max` characters held at once: a line longer than that is given as its first `max`
 * characters and `[N characters past max dropped]`, so a process writing no newline cannot grow the daemon's heap.
 */
export function boundedLines(onLine: (line: string) => void, max: number): { push(chunk: string): void; end(): void } {
  let held = '';
  let dropped = 0;
  const emit = (): void => {
    onLine(dropped === 0 ? held : `${held} [${dropped.toString()} characters past ${max.toString()} dropped]`);
    held = '';
    dropped = 0;
  };
  return {
    push(chunk) {
      let rest = chunk;
      for (let newline = rest.indexOf('\n'); newline >= 0; newline = rest.indexOf('\n')) {
        const piece = rest.slice(0, newline).replace(/\r$/, '');
        const room = max - held.length;
        held += piece.slice(0, Math.max(0, room));
        dropped += Math.max(0, piece.length - Math.max(0, room));
        emit();
        rest = rest.slice(newline + 1);
      }
      const room = max - held.length;
      held += rest.slice(0, Math.max(0, room));
      dropped += Math.max(0, rest.length - Math.max(0, room));
    },
    end() {
      if (held !== '' || dropped > 0) emit();
    },
  };
}

export class SpawnInteractiveLauncher implements InteractiveLauncher {
  launchInteractive(command: string, args: readonly string[], options: InteractiveOptions): InteractiveProcess {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let open = true;
    child.stdin.on('error', () => {
      // EPIPE once the process has exited: the exit is reported through `exited`, and a write after it returns false.
      open = false;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      options.onStdout(chunk);
    });
    const stderr = boundedLines(options.onStderrLine, MAX_STDERR_LINE_CHARS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr.push(chunk);
    });
    child.stderr.on('end', () => {
      stderr.end();
    });
    const exited = new Promise<ProcessExit>((resolve, reject) => {
      child.once('error', (error) => {
        open = false;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new CommandNotFound(command));
        else reject(new Error(`${command} failed to start: ${error.message}`, { cause: error }));
      });
      child.once('close', (code, signal) => {
        open = false;
        resolve({ code, signal });
      });
    });
    return {
      exited,
      write: (text) => {
        if (!open || child.stdin.destroyed) return false;
        child.stdin.write(text);
        return true;
      },
      end: () => child.stdin.end(),
      kill: (signal) => {
        child.kill(signal);
      },
    };
  }
}
