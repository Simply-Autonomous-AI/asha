// How long a daemon and its model servers live (docs/plans/idle-shutdown.md): a model server idle past its bound is
// unloaded (R1); a daemon started to leave when it has nothing to do stops itself (R3, R4); one started for a test run
// stops when that run's process has ended (R6). Each check is a Schedule's timer, which never keeps the process alive,
// and every one is cleared when the daemon begins to stop, whoever began it.

import type { Logger } from './log.js';
import type { Schedule } from './refusal-log/index.js';

/** R1's bound unless ASHA_MODEL_IDLE_MS sets one: 15 minutes, the owner's default of 2026-10-15. */
export const MODEL_IDLE_UNLOAD_MS = 900_000;
/** R3: the idle bound the CLI's auto-start gives the daemon it spawns: 30 minutes, the owner's default of 2026-10-15. */
export const DAEMON_IDLE_EXIT_MS = 1_800_000;
/** R1, R3: how often the model and idle checks run, at most (a shorter bound is checked as often as it is long). */
export const LIFETIME_CHECK_MS = 60_000;
/** R6: how often the process a daemon exits with is checked. */
export const PARENT_WATCH_MS = 5_000;

/** The daemon's lifetime, from its environment (R1, R3, R4, R6). */
export interface LifetimeOptions {
  /** R1: a model server idle this long is unloaded. */
  readonly modelIdleMs: number;
  /** R3: with nothing to do this long, the daemon stops itself; absent, it never stops for idleness (R4). */
  readonly idleExitMs?: number;
  /** R6: the daemon stops once this process has ended; absent, no process is watched. */
  readonly exitWithPid?: number;
}

/** Why the lifetime stops a daemon: idle for `idleMs` (measured), or the process it exits with gone. */
export type LifetimeStop =
  { readonly source: 'idle'; readonly idleMs: number } | { readonly source: 'parent_exited'; readonly pid: number };

export interface DaemonLifetimeProps {
  readonly options: LifetimeOptions;
  /** Its timers: `timerSchedule` in production, never keeping the process alive. */
  readonly schedule: Schedule;
  readonly now: () => number;
  /** Whether the daemon's agents have work: any agent in any phase, a launch, restart or approved call (R3). */
  readonly busy: () => boolean;
  /** R1: the model server's unloadIdle. */
  readonly unloadIdle: (idleMs: number) => Promise<string[]>;
  /** R6: whether a process of this user still runs: false once it has ended or its pid is another user's. */
  readonly running: (pid: number) => boolean;
  /** The daemon's one stop trigger. */
  readonly requestStop: (stop: LifetimeStop) => void;
  readonly logger: Logger;
}

/**
 * The daemon's lifetime watch. Requests and streams in progress are counted by event (`begin`); the agents' work is
 * read at each check (`busy`); the idle clock starts when the last of them ends and restarts with the next, so a
 * daemon is idle only when it has had neither for the whole bound (R3).
 */
export class DaemonLifetime {
  /** Requests and streams in progress on the daemon's socket. */
  private open = 0;
  /** When the daemon last had work: a request or stream ended, or a check found the agents busy. */
  private lastActive: number;
  private readonly cancels = new Set<() => void>();
  private started = false;
  private ended = false;
  /** An unload still running: the next check waits for it rather than start a second. */
  private unloading = false;

  constructor(private readonly props: DaemonLifetimeProps) {
    this.lastActive = props.now();
  }

  /** A request or stream has begun: the daemon has work until the returned function is called; a second call does nothing. */
  begin(): () => void {
    this.open += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.open -= 1;
      this.lastActive = this.props.now();
    };
  }

  /** Arms the checks: called once the daemon has started (after `daemon.started`), never twice. */
  start(): void {
    if (this.started) throw new Error('the daemon lifetime was started twice');
    this.started = true;
    const { modelIdleMs, idleExitMs, exitWithPid } = this.props.options;
    this.lastActive = this.props.now();
    // The model check never stops the daemon: it runs until end().
    this.every(Math.min(LIFETIME_CHECK_MS, modelIdleMs), () => {
      this.unload(modelIdleMs);
      return true;
    });
    if (idleExitMs !== undefined) this.every(Math.min(LIFETIME_CHECK_MS, idleExitMs), () => this.checkIdle(idleExitMs));
    if (exitWithPid !== undefined) this.every(PARENT_WATCH_MS, () => this.checkParent(exitWithPid));
  }

  /** Clears every check: the daemon has begun to stop, whoever began it. Idempotent. */
  end(): void {
    this.ended = true;
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
  }

  /**
   * Runs `check` every `ms` until end() or until it returns false (it has begun the stop): each run schedules the next,
   * so a check never overlaps itself.
   */
  private every(ms: number, check: () => boolean): void {
    const arm = (): void => {
      const cancel = this.props.schedule(() => {
        this.cancels.delete(cancel);
        if (this.ended) return;
        if (check()) arm();
      }, ms);
      this.cancels.add(cancel);
    };
    arm();
  }

  /** R1: the idle models unloaded, unless the last check's unload is still running. */
  private unload(idleMs: number): void {
    if (this.unloading) return;
    this.unloading = true;
    this.props.unloadIdle(idleMs).then(
      () => {
        this.unloading = false;
      },
      (error: unknown) => {
        this.unloading = false;
        this.props.logger.error('model_server.unload_failed', { idleMs, error });
      },
    );
  }

  /** R3: false once it has begun the stop — idle for the whole bound — and true while the daemon goes on. */
  private checkIdle(idleExitMs: number): boolean {
    const now = this.props.now();
    if (this.open > 0 || this.props.busy()) {
      this.lastActive = now;
      return true;
    }
    const idleMs = now - this.lastActive;
    if (idleMs < idleExitMs) return true;
    this.end();
    this.props.requestStop({ source: 'idle', idleMs });
    return false;
  }

  /** R6: false once it has begun the stop — the process it exits with has ended — and true while it runs. */
  private checkParent(pid: number): boolean {
    if (this.props.running(pid)) return true;
    this.end();
    this.props.requestStop({ source: 'parent_exited', pid });
    return false;
  }
}

/**
 * Whether a process of this user still runs, by signal 0: ESRCH, no process; EPERM, the pid is now another user's —
 * so the process it named has ended (R6). Any other failure throws.
 */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}
