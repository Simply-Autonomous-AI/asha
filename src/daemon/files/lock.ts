// The channel's lock (docs/plans/agent-files.md R3a): one per channel, first come first served, serialising the
// space's creation, each upload's measurement and copy, each rollback, each return's copy-out, and each persisted fill
// or snapshot. A waiter may give up after its own bound, or when its signal aborts (the daemon's stop); a holder
// releases it once, and the next waiter that has not given up gets it.

/** A granted lock, with its once-only release; or why the wait gave up, having never held the lock. */
export type Acquired =
  { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly why: 'timeout' | 'aborted' };

/** One channel's lock: first come, first served, serialising every daemon operation on the channel's space. */
export class ChannelLock {
  private held = false;
  private readonly waiters: { grant: () => void; done: boolean }[] = [];

  /** Whether a holder has it now (for tests and the stop's checks). */
  get busy(): boolean {
    return this.held;
  }

  /**
   * Waits for the lock: at most `waitMs` when given, and never past `signal` aborting. Resolves with the release
   * function, or why it gave up — having never held the lock.
   */
  acquire(waitMs: number | undefined, signal?: AbortSignal): Promise<Acquired> {
    if (signal?.aborted === true) return Promise.resolve({ ok: false, why: 'aborted' });
    if (!this.held) {
      this.held = true;
      return Promise.resolve({ ok: true, release: this.releaser() });
    }
    return new Promise<Acquired>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = {
        done: false,
        grant: () => {
          finish();
          resolve({ ok: true, release: this.releaser() });
        },
      };
      const onAbort = (): void => {
        finish();
        resolve({ ok: false, why: 'aborted' });
      };
      const finish = (): void => {
        waiter.done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      if (waitMs !== undefined) {
        timer = setTimeout(() => {
          finish();
          resolve({ ok: false, why: 'timeout' });
        }, waitMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** A release that hands the lock to the next waiter still waiting, once. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (;;) {
        const next = this.waiters.shift();
        if (next === undefined) {
          this.held = false;
          return;
        }
        if (next.done) continue;
        next.grant();
        return;
      }
    };
  }
}
