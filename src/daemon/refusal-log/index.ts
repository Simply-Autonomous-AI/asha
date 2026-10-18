// Logging the daemon's refusals (401 and 403), bounded. Every peer — an agent
// container included — reaches the daemon as 127.0.0.1, so an unbounded log
// line per refusal would let any of them grow daemon.jsonl without limit.
//
// Per key (the reason and the API family): the first refusal after a quiet
// window is logged at once, with `count: 1` and its method and path; further
// refusals for that key within the window are counted, and logged as one
// record with their count when the window ends (the method and path are the
// last one's). A window that ends with refusals counted opens another, so a
// flood costs one record per key per window. `flush` logs every pending count
// (the daemon calls it as it stops).

import type { Logger } from '../log.js';

export type RefusalReason =
  | 'credential_missing'
  | 'credential_invalid'
  | 'token_missing'
  | 'token_invalid'
  | 'host_forbidden'
  | 'origin_forbidden';

/** Which API a refused path belongs to: `/v1/…`, `/agent/…`, or anything else. */
export type ApiFamily = 'v1' | 'agent' | 'other';

/** Runs `callback` once after `ms`; the returned function cancels it. */
export type Schedule = (callback: () => void, ms: number) => () => void;

/** The production Schedule: a timer that does not keep the process alive. */
export const timerSchedule: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

export interface Refusal {
  readonly reason: RefusalReason;
  readonly api: ApiFamily;
  readonly method: string;
  /** The request's path, without its query string (which may carry a secret). */
  readonly path: string;
}

export interface RefusalLogProps {
  readonly logger: Logger;
  readonly schedule: Schedule;
  readonly windowMs: number;
}

interface Window {
  count: number;
  last: Refusal;
  cancel: () => void;
}

export class RefusalLog {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly props: RefusalLogProps) {}

  record(refusal: Refusal): void {
    const key = `${refusal.reason}|${refusal.api}`;
    const open = this.windows.get(key);
    if (open !== undefined) {
      open.count += 1;
      open.last = refusal;
      return;
    }
    this.write(refusal, 1);
    this.open(key, refusal);
  }

  /** Logs every pending count now, and closes every window. */
  flush(): void {
    for (const window of this.windows.values()) {
      window.cancel();
      if (window.count > 0) this.write(window.last, window.count);
    }
    this.windows.clear();
  }

  private open(key: string, refusal: Refusal): void {
    const window: Window = { count: 0, last: refusal, cancel: () => undefined };
    window.cancel = this.props.schedule(() => {
      this.close(key, window);
    }, this.props.windowMs);
    this.windows.set(key, window);
  }

  private close(key: string, window: Window): void {
    this.windows.delete(key);
    if (window.count === 0) return;
    this.write(window.last, window.count);
    // Refusals kept coming: the next one is not after a quiet window, so keep counting.
    this.open(key, window.last);
  }

  private write(refusal: Refusal, count: number): void {
    this.props.logger.warn('http.refused', {
      method: refusal.method,
      path: refusal.path,
      reason: refusal.reason,
      api: refusal.api,
      count,
    });
  }
}
