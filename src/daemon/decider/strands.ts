// The decision model on the host (docs/plans/decider-tool.md R3–R9): strands-decider 0.1.0's own app, run by asha's
// launcher (decider/launch.py) from the venv in the model cache, on a Unix socket in a 0700 folder — no TCP port, no
// key — on MPS. Two requests at once crash or hang torch's MPS backend (probes P3, P3b: 10 crash reports on the owner's
// Mac), so exactly one request is ever in it: calls wait in one first-in, first-out queue of at most four, each answered
// within 30,000 ms of its arrival, each request bounded at 10,000 ms, a hang killed. Spawned through the same
// ProcessLauncher llama-server is, and stopped the same way (SIGTERM, then SIGKILL after 10,000 ms).

import { appendFileSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { present } from '../../shared/assert-present.js';
import type { Logger } from '../log.js';
import type { LaunchedProcess, ProcessExit, ProcessLauncher } from '../process/index.js';
import {
  DeciderFailed,
  type Decider,
  type DeciderOutcome,
  type StrandsAnswer,
  type StrandsRequest,
  type StrandsResponse,
} from './contract.js';
import { IN_USE_DIR } from './in-use.js';
import type { DeciderLayout } from './layout.js';

/** R5: a start is ready within 20,000 ms of its spawn, polled every 250 ms, each poll bounded at 2,000 ms. */
export const START_TIMEOUT_MS = 20_000;
export const HEALTH_POLL_MS = 250;
export const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
/** R8: a call is answered within 30,000 ms of its arrival; a request to the model is bounded at 10,000 ms. */
export const CALL_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 10_000;
/** R8: calls waiting behind the one in the model. */
export const QUEUE_MAX = 4;
/** R8: the model's window; a response that read this many tokens or more was cut (probes P2, P8). */
export const WINDOW_TOKENS = 4_096;
/** R6, R7: the stop's SIGTERM grace, as llama-server's. */
export const STOP_GRACE_MS = 10_000;
/** R9: the restarts after an exit or a kill allowed in any 10 minutes; past them, the decision model is given up. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 600_000;
/** R5: logs/decider.log holds at most 1 MiB a start. */
export const LOG_MAX_BYTES = 1024 * 1024;
/** R4: the longest socket path macOS binds (sun_path is 104 bytes with its NUL; probe P5). */
export const SOCKET_PATH_MAX_BYTES = 103;

/** An HTTP answer over the socket: its status and body text (the body is never logged: a 422 quotes its input, P2). */
export interface SocketAnswer {
  readonly status: number;
  readonly body: string;
}

/** The request did not finish within its bound. */
export class SocketRequestTimedOut extends Error {
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`${path} did not answer within ${String(timeoutMs)} ms`);
    this.name = 'SocketRequestTimedOut';
  }
}

/** One HTTP request over a Unix socket: resolves with the answer, rejects with SocketRequestTimedOut or the connection's error. */
export type SocketRequest = (
  socketPath: string,
  request: { readonly method: 'GET' | 'POST'; readonly path: string; readonly body?: string },
  timeoutMs: number,
) => Promise<SocketAnswer>;

/** The real one: node's http client, given the socket path. */
export const nodeSocketRequest: SocketRequest = (socketPath, { method, path, body }, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers:
          body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new SocketRequestTimedOut(path, timeoutMs)), timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });

/** The filesystem calls the decision model's process makes: its socket folders, its in-use file and its log. */
export interface DeciderRuntimeFs {
  /** What is at a path, links not followed; null when nothing is. */
  inspect(path: string): Promise<{
    readonly directory: boolean;
    readonly link: boolean;
    readonly uid: number;
    readonly mode: number;
  } | null>;
  /** Creates a folder, failing EEXIST when anything is there (exclusive create), with exactly this mode. */
  makeDir(path: string, mode: number): Promise<void>;
  /** Removes a folder and what it holds; gone already is fine. */
  removeDir(path: string): Promise<void>;
  /** Creates a file that must not exist yet, holding `text`. */
  createFile(path: string, text: string): Promise<void>;
  /** Replaces a file's text. */
  writeFile(path: string, text: string): Promise<void>;
  /** Removes a file; gone already is fine. */
  removeFile(path: string): Promise<void>;
  /** Empties the log file (creating it). Synchronous, as the logger's own writes are. */
  truncateLog(path: string): void;
  appendLog(path: string, chunk: Buffer): void;
}

export const nodeDeciderRuntimeFs: DeciderRuntimeFs = {
  inspect: async (path) => {
    try {
      const info = await lstat(path);
      return { directory: info.isDirectory(), link: info.isSymbolicLink(), uid: info.uid, mode: info.mode & 0o7777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  makeDir: async (path, mode) => {
    await mkdir(path, { mode });
    // The umask may have taken bits off; the mode is exactly what is asked, never more.
    await chmod(path, mode);
  },
  removeDir: (path) => rm(path, { recursive: true, force: true }),
  createFile: async (path, text) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text, { flag: 'wx' });
  },
  writeFile: (path, text) => writeFile(path, text),
  removeFile: (path) => rm(path, { force: true }),
  truncateLog: (path) => {
    writeFileSync(path, '');
  },
  appendLog: (path, chunk) => {
    appendFileSync(path, chunk);
  },
};

export interface StrandsDeciderProps {
  /** Where the model's parts are: read at each start (the catalogue and the lock). */
  readonly layout: () => Promise<DeciderLayout>;
  readonly launcher: ProcessLauncher;
  readonly request: SocketRequest;
  readonly logger: Logger;
  /** logs/decider.log: the model's stdout and stderr, emptied at each start, at most LOG_MAX_BYTES (R5). */
  readonly logFile: string;
  /** The folder under which `asha-<uid>/` holds the socket folders: `/tmp` (R4); a test's own. */
  readonly socketRoot: string;
  readonly uid: number;
  /** The model cache: its `.decider-in-use/` folder holds this daemon's in-use file (R6). */
  readonly modelsDir: string;
  /** The daemon's pid: its in-use file's name (R6). */
  readonly pid: number;
  readonly fs: DeciderRuntimeFs;
  readonly randomHex: () => string;
}

/** A call: its request, and how it is answered once. */
interface Call {
  readonly request: StrandsRequest;
  readonly settle: (outcome: DeciderOutcome) => void;
  settled: boolean;
}

/** The decision model's process while it lives. */
interface Running {
  readonly child: LaunchedProcess;
  readonly socketDir: string;
  readonly socketPath: string;
  /** Resolves true once healthy, false when the start failed (logged decider.start_failed). */
  ready: Promise<boolean>;
  /** Settles once it has exited and its socket folder is removed. */
  readonly gone: Promise<void>;
  /** The daemon asked it to end: its exit is not decider.exited. */
  requested: boolean;
  /** The call whose request is in it now; answered decider_unavailable if it exits. */
  inFlight: Call | undefined;
}

/** strands-decider on the host, behind the Decider contract (R12). */
export class StrandsDecider implements Decider {
  private holders = 0;
  private inUse = false;
  private running: Running | undefined;
  /** A start going on: every caller of start() is given the same one. */
  private starting: Promise<Running | undefined> | undefined;
  /** A stop of the last process, still ending: a new start waits for it. */
  private ending: Promise<void> = Promise.resolve();
  private readonly queue: Call[] = [];
  private working = false;
  /** When each restart (a start not made by a launch, R9) began. */
  private readonly restarts: number[] = [];
  private gaveUp = false;
  private stopped: Promise<void> | undefined;
  private logBytes = 0;
  private logDropped = 0;

  constructor(private readonly props: StrandsDeciderProps) {}

  async acquire(): Promise<void> {
    this.holders += 1;
    if (this.holders > 1 || this.stopped !== undefined) return;
    // R6: the in-use file from the first acquire until the last release, read by asha --remove-decider (R15b).
    if (!this.inUse) {
      await this.props.fs.createFile(this.inUseFile(), '');
      this.inUse = true;
    }
    // Not awaited: a launch never waits for the model to be ready; the first decide waits at most its 30,000 ms.
    if (this.running === undefined && !this.gaveUp) void this.start('launch');
  }

  async release(): Promise<void> {
    if (this.holders === 0) throw new Error('decider released more often than it was acquired');
    this.holders -= 1;
    if (this.holders > 0 || this.stopped !== undefined) return;
    this.fail(this.queue.splice(0), 'decider_unavailable');
    await this.stopProcess();
    await this.dropInUse();
  }

  decide(request: StrandsRequest): Promise<DeciderOutcome> {
    if (this.stopped !== undefined || this.gaveUp) return Promise.resolve({ ok: false, reason: 'decider_unavailable' });
    if (this.queue.length >= QUEUE_MAX) return Promise.resolve({ ok: false, reason: 'decider_busy' });
    return new Promise<DeciderOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const at = this.queue.indexOf(call);
        if (at >= 0) this.queue.splice(at, 1);
        call.settle({ ok: false, reason: 'timeout' });
      }, CALL_TIMEOUT_MS);
      const call: Call = {
        request,
        settled: false,
        settle: (outcome) => {
          if (call.settled) return;
          call.settled = true;
          clearTimeout(timer);
          resolve(outcome);
        },
      };
      this.queue.push(call);
      void this.work();
    });
  }

  stopAll(): Promise<void> {
    this.stopped ??= (async () => {
      this.fail(this.queue.splice(0), 'decider_unavailable');
      await this.stopProcess();
      await this.dropInUse();
    })();
    return this.stopped;
  }

  private inUseFile(): string {
    return join(this.props.modelsDir, IN_USE_DIR, String(this.props.pid));
  }

  private async dropInUse(): Promise<void> {
    if (!this.inUse) return;
    this.inUse = false;
    await this.props.fs.removeFile(this.inUseFile());
  }

  private fail(calls: readonly Call[], reason: 'decider_unavailable'): void {
    for (const call of calls) call.settle({ ok: false, reason });
  }

  /** Takes the calls in order, one at a time: exactly one request is ever in the model (R8). */
  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (let call = this.queue.shift(); call !== undefined; call = this.queue.shift()) {
        if (call.settled) continue;
        await this.serve(call);
      }
    } finally {
      this.working = false;
    }
  }

  /**
   * Obtains a process to serve `call` when none is already running, restarting it (R9); settles `call` and returns
   * undefined when it cannot — the caller then does nothing more.
   */
  private async restartFor(call: Call): Promise<Running | undefined> {
    if (this.stopped !== undefined || this.holders === 0) {
      call.settle({ ok: false, reason: 'decider_unavailable' });
      return undefined;
    }
    // R9: a start that follows an exit, a hang's kill or a failed start counts; past MAX_RESTARTS in RESTART_WINDOW_MS, given up.
    const now = Date.now();
    while (
      this.restarts.length > 0 &&
      present(this.restarts[0], 'the oldest queued restart time') <= now - RESTART_WINDOW_MS
    )
      this.restarts.shift();
    if (this.gaveUp || this.restarts.length >= MAX_RESTARTS) {
      if (!this.gaveUp) {
        this.gaveUp = true;
        this.props.logger.error('decider.gave_up', {
          restarts: this.restarts.length,
          withinMs: RESTART_WINDOW_MS,
          error: new Error(
            `the decision model ended ${String(MAX_RESTARTS + 1)} times within ${String(RESTART_WINDOW_MS / 60_000)} minutes; every decide call is answered decider_unavailable until the daemon restarts`,
          ),
        });
      }
      this.fail([call, ...this.queue.splice(0)], 'decider_unavailable');
      return undefined;
    }
    this.restarts.push(now);
    const running = await this.start('restart');
    if (running === undefined) call.settle({ ok: false, reason: 'decider_unavailable' });
    return running;
  }

  private async serve(call: Call): Promise<void> {
    let running = this.running ?? (this.starting === undefined ? undefined : await this.starting);
    running ??= await this.restartFor(call);
    if (running === undefined) return;
    if (!(await running.ready) || this.running !== running) {
      call.settle({ ok: false, reason: 'decider_unavailable' });
      return;
    }
    // Answered by its own bound while it waited for the start: never sent.
    if (call.settled) return;
    running.inFlight = call;
    try {
      call.settle(await this.ask(running, call.request));
    } finally {
      running.inFlight = undefined;
    }
  }

  /** One request to the model (R8): its answer, or a hang killed. */
  private async ask(running: Running, request: StrandsRequest): Promise<DeciderOutcome> {
    let answer: SocketAnswer;
    try {
      answer = await this.props.request(
        running.socketPath,
        { method: 'POST', path: '/v1/systemone', body: JSON.stringify(request) },
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof SocketRequestTimedOut) {
        // P3's sixth trial: a hung model answers nothing, ever. Killed; the next call starts another (R9).
        this.props.logger.error('decider.hung', {
          pid: running.child.pid ?? null,
          timeoutMs: REQUEST_TIMEOUT_MS,
          error,
        });
        running.requested = true;
        running.child.kill('SIGKILL');
        if (this.running === running) this.running = undefined;
        return { ok: false, reason: 'timeout' };
      }
      // The connection failed: the process exited (its exit is logged decider.exited), or never listened.
      if (this.running === running && !running.requested)
        this.props.logger.warn('decider.request_failed', {
          pid: running.child.pid ?? null,
          error: new Error((error as Error).message),
        });
      return { ok: false, reason: 'decider_unavailable' };
    }
    if (answer.status !== 200) {
      // The daemon checks every request before it is sent: a refusal is a defect, said loudly, its body never logged.
      this.props.logger.error('decider.request_refused', {
        status: answer.status,
        error: new Error(`POST /v1/systemone answered HTTP ${String(answer.status)}`),
      });
      return { ok: false, reason: 'decider_unavailable' };
    }
    const response = parseResponse(answer.body);
    if (typeof response === 'string') {
      this.props.logger.error('decider.response_invalid', { error: new Error(response) });
      return { ok: false, reason: 'decider_unavailable' };
    }
    // R8: the text was cut at the model's window, so the answer is about part of it: never given as a decision.
    if (response.inputTokens >= WINDOW_TOKENS) return { ok: false, reason: 'input_too_large' };
    return { ok: true, response };
  }

  /**
   * Starts the model (R3–R5): the socket folder made and checked, the process spawned, its in-use line written, and
   * its health polled. Resolves with the process once spawned (its `ready` says whether it became healthy), or
   * undefined when it could not be spawned (logged decider.start_failed).
   */
  private start(why: 'launch' | 'restart'): Promise<Running | undefined> {
    this.starting ??= this.spawn(why).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async spawn(why: 'launch' | 'restart'): Promise<Running | undefined> {
    await this.ending;
    if (this.stopped !== undefined || this.running !== undefined) return this.running;
    let socketDir: string | undefined;
    try {
      const layout = await this.props.layout();
      const root = join(this.props.socketRoot, `asha-${String(this.props.uid)}`);
      await this.ownFolder(root);
      socketDir = join(root, `decider-${this.props.randomHex()}`);
      const socketPath = join(socketDir, 'decider.sock');
      const bytes = Buffer.byteLength(socketPath);
      if (bytes > SOCKET_PATH_MAX_BYTES)
        throw new DeciderFailed(
          `the decision model's socket path ${socketPath} is ${String(bytes)} bytes, over the ${String(SOCKET_PATH_MAX_BYTES)} a macOS socket path holds`,
        );
      await this.props.fs.makeDir(socketDir, 0o700);
      this.props.fs.truncateLog(this.props.logFile);
      this.logBytes = 0;
      this.logDropped = 0;
      const child = this.props.launcher.launch(
        layout.python,
        [layout.launcher, layout.checkpointDir, socketPath, 'mps'],
        {
          env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
          removeEnv: ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
          logFile: null,
          onOutput: (chunk) => {
            this.copyOutput(chunk);
          },
        },
      );
      const dir = socketDir;
      let markGone!: () => void;
      const gone = new Promise<void>((resolve) => (markGone = resolve));
      const running: Running = {
        child,
        socketDir: dir,
        socketPath,
        ready: Promise.resolve(false),
        gone,
        requested: false,
        inFlight: undefined,
      };
      this.running = running;
      child.exited.then(
        (exit) => void this.exited(running, exit).finally(markGone),
        (error: unknown) => {
          this.props.logger.error('decider.start_failed', { why, error });
          if (this.running === running) this.running = undefined;
          void this.props.fs.removeDir(dir).finally(markGone);
        },
      );
      if (this.inUse && child.pid !== undefined)
        await this.props.fs.writeFile(this.inUseFile(), `${String(child.pid)} ${socketPath}\n`);
      this.props.logger.info('decider.starting', { why, pid: child.pid ?? null, socket: socketPath });
      running.ready = this.awaitReady(running, why);
      return running;
    } catch (error) {
      if (socketDir !== undefined && this.running === undefined) await this.props.fs.removeDir(socketDir);
      this.props.logger.error('decider.start_failed', { why, error });
      return undefined;
    }
  }

  /** `/tmp/asha-<uid>`: made 0700 when absent; anything else there but this user's 0700 folder fails the start (R4). */
  private async ownFolder(root: string): Promise<void> {
    let found = await this.props.fs.inspect(root);
    if (found === null) {
      try {
        await this.props.fs.makeDir(root, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      found = await this.props.fs.inspect(root);
    }
    if (found === null || found.link || !found.directory || found.uid !== this.props.uid || found.mode !== 0o700) {
      const what = describeFound(found, this.props.uid);
      throw new DeciderFailed(
        `${root} must be a folder owned by uid ${String(this.props.uid)} with mode 0700, and is ${what}: remove it, then try again`,
      );
    }
  }

  /** Polls /health every 250 ms, each poll bounded at 2,000 ms, until 20,000 ms from the spawn (R5); a model not ready is killed. */
  private async awaitReady(running: Running, why: 'launch' | 'restart'): Promise<boolean> {
    const until = Date.now() + START_TIMEOUT_MS;
    let last = 'no health check completed';
    while (Date.now() < until && this.running === running && !running.requested) {
      try {
        const answer = await this.props.request(
          running.socketPath,
          { method: 'GET', path: '/health' },
          Math.min(HEALTH_REQUEST_TIMEOUT_MS, Math.max(1, until - Date.now())),
        );
        if (answer.status === 200) {
          this.props.logger.info('decider.ready', { why, pid: running.child.pid ?? null });
          return true;
        }
        last = `GET /health answered HTTP ${String(answer.status)}`;
      } catch (error) {
        // Refused, or no socket yet, while the model loads: remembered, and polled again.
        last = `GET /health failed: ${(error as Error).message}`;
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    if (this.running !== running || running.requested) return false;
    running.requested = true;
    running.child.kill('SIGKILL');
    this.running = undefined;
    this.props.logger.error('decider.start_failed', {
      why,
      pid: running.child.pid ?? null,
      error: new Error(`the decision model was not healthy within ${String(START_TIMEOUT_MS)} ms; last check: ${last}`),
    });
    return false;
  }

  /** Its exit (R9): one nobody asked for is decider.exited, and the call in it is answered decider_unavailable. */
  private async exited(running: Running, exit: ProcessExit): Promise<void> {
    if (this.running === running) this.running = undefined;
    running.inFlight?.settle({ ok: false, reason: 'decider_unavailable' });
    if (running.requested) {
      this.props.logger.info('decider.stopped', {
        pid: running.child.pid ?? null,
        code: exit.code,
        signal: exit.signal,
        droppedLogBytes: this.logDropped,
      });
    } else {
      this.props.logger.error('decider.exited', {
        pid: running.child.pid ?? null,
        code: exit.code,
        signal: exit.signal,
        droppedLogBytes: this.logDropped,
        error: new Error(
          `the decision model exited (code ${String(exit.code)}, signal ${String(exit.signal)}); see ${this.props.logFile}`,
        ),
      });
    }
    await this.props.fs.removeDir(running.socketDir);
  }

  /** SIGTERM, then SIGKILL after STOP_GRACE_MS (R6, R7); resolves once it has exited and its socket folder is gone. */
  private async stopProcess(): Promise<void> {
    // A start going on is let finish, then stopped: it is never left running behind the stop.
    if (this.starting !== undefined) await this.starting;
    const running = this.running;
    if (running === undefined) return this.ending;
    this.running = undefined;
    running.requested = true;
    running.child.kill('SIGTERM');
    const grace = setTimeout(() => {
      running.child.kill('SIGKILL');
    }, STOP_GRACE_MS);
    this.ending = running.gone.finally(() => {
      clearTimeout(grace);
    });
    return this.ending;
  }

  /** Copies the model's output to logs/decider.log, at most LOG_MAX_BYTES a start; past it, counted and said once (R5). */
  private copyOutput(chunk: Buffer): void {
    const room = Math.max(0, LOG_MAX_BYTES - this.logBytes);
    const kept = chunk.subarray(0, room);
    if (kept.length > 0) {
      this.props.fs.appendLog(this.props.logFile, kept);
      this.logBytes += kept.length;
    }
    if (kept.length < chunk.length) {
      if (this.logDropped === 0)
        this.props.logger.warn('decider.log_full', { file: this.props.logFile, maxBytes: LOG_MAX_BYTES });
      this.logDropped += chunk.length - kept.length;
    }
  }
}

/** What `ownFolder` found at the socket root, named for the message it throws when the folder is not this user's own. */
function describeFound(found: Awaited<ReturnType<DeciderRuntimeFs['inspect']>>, uid: number): string {
  if (found === null) return 'nothing';
  if (found.link) return 'a symbolic link';
  if (!found.directory) return 'not a folder';
  if (found.uid !== uid) return `owned by uid ${String(found.uid)}`;
  return `mode ${found.mode.toString(8).padStart(4, '0')}`;
}

/** `parseResponseOutcome`'s result: always one object shape, so the step that builds it never mixes return types. */
type ResponseOutcome =
  { readonly ok: true; readonly value: StrandsResponse } | { readonly ok: false; readonly error: string };

/** The validation behind `parseResponse`, kept to one return shape (sonarjs/function-return-type). */
function parseResponseOutcome(body: string): ResponseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, error: 'the decision model answered 200 with a body that is not JSON' };
  }
  const o = raw as { answers?: unknown; usage?: { input_tokens?: unknown } } | null;
  if (typeof o !== 'object' || o === null || typeof o.answers !== 'object' || o.answers === null)
    return { ok: false, error: 'the decision model answered 200 without answers' };
  const tokens = o.usage?.input_tokens;
  if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0)
    return { ok: false, error: 'the decision model answered 200 without usage.input_tokens' };
  const answers: Record<string, StrandsAnswer> = {};
  for (const [name, value] of Object.entries(o.answers as Record<string, unknown>)) {
    const a = value as { type?: unknown; choice?: unknown; confidence?: unknown; noul?: unknown } | null;
    if (a?.type === 'choice' && typeof a.choice === 'string' && typeof a.confidence === 'number')
      answers[name] = { type: 'choice', choice: a.choice, confidence: a.confidence };
    else if (a?.type === 'noul' && typeof a.noul === 'number') answers[name] = { type: 'noul', noul: a.noul };
    else
      return {
        ok: false,
        error: `the decision model's answer ${JSON.stringify(name).slice(0, 40)} is neither a choice nor a noul`,
      };
  }
  return { ok: true, value: { answers, inputTokens: tokens } };
}

/** A 200's body as the daemon reads it: each answer and `usage.input_tokens`; or why it cannot be read. */
export function parseResponse(body: string): StrandsResponse | string {
  const outcome = parseResponseOutcome(body);
  return outcome.ok ? outcome.value : outcome.error;
}
