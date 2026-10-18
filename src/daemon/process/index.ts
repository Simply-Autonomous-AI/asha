// Running host commands. CommandRunner is the seam every host-touching adapter
// (colima, docker, brew) goes through, so unit tests can assert the exact
// command sequence without running anything.

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

import { present } from '../../shared/assert-present.js';

// The module's public surface beyond the command runner (PRINCIPLES §10): the long-lived process launchers and the
// pid lock, which consumers import from here, never from launcher.ts or pid-lock.ts.
export {
  SpawnInteractiveLauncher,
  SpawnProcessLauncher,
  WATCH_PID_LINE,
  type InteractiveLauncher,
  type LaunchedProcess,
  type ProcessExit,
  type ProcessLauncher,
} from './launcher.js';
export { LockHeld, acquirePidLock, isAlive } from './pid-lock.js';

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Every command is bounded (PRINCIPLES §11). */
  readonly timeoutMs: number;
  /** Added to the daemon's environment for this command only. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Written to the command's standard input, which is then closed. Keeps a script or a secret off the command
   * line; bytes carry an archive (`docker cp -`, collaborating-agents R2).
   */
  readonly stdin?: string | Uint8Array;
}

export interface CommandRunner {
  /**
   * Runs a command to completion. A non-zero exit is returned as data — the
   * caller knows what it means. A missing binary or a timeout throws.
   */
  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult>;
  /**
   * Runs a command whose input or output is too large to hold (docs/plans/agent-persistence.md R11: a snapshot of up
   * to 64 MiB, a restore streamed from its stored file): standard input from an iterable, standard output handed to
   * `onStdout` chunk by chunk, awaited, so a slow reader slows the command. `onStdout` answering `stop` ends it early
   * (SIGKILL; `stopped: true`). A non-zero exit is data; a missing binary, a timeout or an abort throws.
   */
  stream(command: string, args: readonly string[], options: StreamOptions): Promise<StreamResult>;
}

export interface StreamOptions {
  /** Every command is bounded (PRINCIPLES §11). */
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Written to standard input chunk by chunk, then closed. */
  readonly stdin?: AsyncIterable<Uint8Array>;
  /** Each chunk of standard output; `stop` ends the command. Without it, standard output is discarded. */
  readonly onStdout?: (chunk: Buffer) => Promise<'more' | 'stop'>;
  /** Standard error is appended to this file instead of being returned (a one-shot container's log). */
  readonly stderrFile?: string;
  /** Each chunk of standard error, besides what is kept or logged (a plugin call's capture, extension-modules R33). */
  readonly onStderr?: (chunk: Buffer) => void;
  /** Aborting it kills the command and rejects with the signal's reason (a stop's checkpoint past its bound). */
  readonly signal?: AbortSignal;
}

export interface StreamResult {
  readonly code: number;
  /** The last 64 KiB of standard error ('' when it went to a file). */
  readonly stderr: string;
  /** `onStdout` answered `stop`, and the command was killed. */
  readonly stopped: boolean;
}

/** How much of a streamed command's standard error is kept for its error message. */
const STREAM_STDERR_KEPT = 64 * 1024;

/** The binary is not on PATH. */
export class CommandNotFound extends Error {
  constructor(readonly command: string) {
    super(`command not found on PATH: ${command}`);
    this.name = 'CommandNotFound';
  }
}

/** The command did not finish within its bound and was killed. */
export class CommandTimedOut extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly timeoutMs: number,
  ) {
    super(`${command} ${args.join(' ')} did not finish within ${timeoutMs.toString()} ms`);
    this.name = 'CommandTimedOut';
  }
}

export class ExecCommandRunner implements CommandRunner {
  stream(command: string, args: readonly string[], options: StreamOptions): Promise<StreamResult> {
    return streamCommand(command, args, options);
  }

  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let stdinError: Error | undefined;
      const child = execFile(
        command,
        [...args],
        {
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, ...options.env },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            if (stdinError !== undefined) {
              reject(
                new Error(`${command} exited 0 without reading its standard input: ${stdinError.message}`, {
                  cause: stdinError,
                }),
              );
              return;
            }
            resolve({ code: 0, stdout, stderr });
            return;
          }
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new CommandNotFound(command));
            return;
          }
          if (error.killed) {
            reject(new CommandTimedOut(command, args, options.timeoutMs));
            return;
          }
          if (typeof error.code === 'number') {
            const unread = stdinError === undefined ? '' : `\n(its standard input was not read: ${stdinError.message})`;
            resolve({ code: error.code, stdout, stderr: `${stderr}${unread}` });
            return;
          }
          reject(new Error(`${command} failed to run: ${error.message}`, { cause: error }));
        },
      );
      if (options.stdin !== undefined) {
        // A command that exits before reading all of its input closes the pipe (EPIPE). The callback
        // above reports it: as a failure when the command still exited 0, else beside its own error.
        child.stdin?.on('error', (error) => {
          stdinError = error;
        });
        child.stdin?.end(options.stdin);
      }
    });
  }
}

/** Runs `command`, streaming as CommandRunner.stream describes; ExecCommandRunner's implementation of it. */
function streamCommand(command: string, args: readonly string[], options: StreamOptions): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const log = options.stderrFile === undefined ? undefined : createWriteStream(options.stderrFile, { flags: 'a' });
    let stderr = '';
    let stopped = false;
    let timedOut = false;
    let aborted = false;
    let failure: { readonly error: unknown } | undefined;
    let stdinError: Error | undefined;
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    child.stderr.on('data', (chunk: Buffer) => {
      options.onStderr?.(chunk);
      if (log !== undefined) log.write(chunk);
      else stderr = (stderr + chunk.toString('utf8')).slice(-STREAM_STDERR_KEPT);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    // Standard output, one chunk at a time to the consumer: the stream is paused while it works.
    let pumping: Promise<void> = Promise.resolve();
    const onStdout = options.onStdout;
    if (onStdout === undefined) child.stdout.resume();
    else {
      child.stdout.on('data', (chunk: Buffer) => {
        if (stopped || failure !== undefined) return;
        child.stdout.pause();
        pumping = pumping
          .then(async () => {
            if ((await onStdout(chunk)) === 'stop') {
              stopped = true;
              kill();
            }
          })
          .then(
            () => {
              if (!stopped) child.stdout.resume();
            },
            (error: unknown) => {
              failure = { error };
              kill();
            },
          );
      });
    }
    // Standard input from the iterable, honouring the pipe's backpressure. A command that exits early closes the pipe.
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    void (async () => {
      if (options.stdin !== undefined) {
        for await (const chunk of options.stdin) {
          if (child.stdin.destroyed) return;
          if (!child.stdin.write(chunk))
            await new Promise<void>((drained) => child.stdin.once('drain', drained).once('close', drained));
        }
      }
      child.stdin.end();
    })().catch((error: unknown) => {
      // The input itself failed (a stored file that cannot be read): the command must not run on half an input.
      failure = { error };
      kill();
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      log?.end();
      reject(
        error.code === 'ENOENT'
          ? new CommandNotFound(command)
          : new Error(`${command} failed to run: ${error.message}`, { cause: error }),
      );
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void pumping.then(() => {
        log?.end();
        if (failure !== undefined) reject(toRejectReason(failure.error));
        else if (timedOut) reject(new CommandTimedOut(command, args, options.timeoutMs));
        else if (aborted) reject(toRejectReason(present(options.signal, 'options.signal').reason));
        else if (stopped) resolve({ code: code ?? 137, stderr, stopped: true });
        else if (code === null)
          reject(new Error(`${command} ${args.join(' ')} was killed by ${signal ?? 'an unknown signal'}`));
        else if (stdinError !== undefined && code === 0)
          reject(
            new Error(`${command} exited 0 without reading its standard input: ${stdinError.message}`, {
              cause: stdinError,
            }),
          );
        else resolve({ code, stderr, stopped: false });
      });
    });
  });
}

/**
 * A caught or signalled value, as the `Error` a promise must reject with (PRINCIPLES §9: a rejection reason that is
 * not an `Error` loses its stack and type). Every caller here passes an `Error` today (the tests always abort with
 * one); the `String(value)` branch is a deliberate narrow refinement, uncovered by any test either way, kept so a
 * future non-Error reason still fails loudly instead of rejecting with a bare unknown value.
 */
function toRejectReason(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The last `lines` lines of a command's output, for error messages. */
export function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}
