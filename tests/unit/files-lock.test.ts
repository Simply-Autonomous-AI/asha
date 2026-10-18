// The channel's lock (docs/plans/agent-files.md R3a): first come, first served; a waiter gives up after its own bound
// or when its signal aborts, having never held it; a release is once-only and hands the lock to the next waiter
// still waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelLock, type Acquired } from '../../src/daemon/files/lock.js';

/** The release of a granted lock; a refusal fails the test. */
function releaseOf(acquired: Acquired): () => void {
  if (!acquired.ok) throw new Error(`the lock was not granted: ${acquired.why}`);
  return acquired.release;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ChannelLock', () => {
  it('grants a free lock at once, then its waiters in order, each once the one before releases', async () => {
    const lock = new ChannelLock();
    const first = releaseOf(await lock.acquire(undefined));
    const order: string[] = [];
    const second = lock.acquire(1_000).then((a) => {
      order.push('second');
      return a;
    });
    const third = lock.acquire(1_000).then((a) => {
      order.push('third');
      return a;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    first();
    // A second release of the same grant hands nothing on.
    first();
    const secondRelease = releaseOf(await second);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['second']);
    secondRelease();
    releaseOf(await third)();
    expect(order).toEqual(['second', 'third']);
  });

  it("gives up after its own bound, 'timeout', never holding it; the next release skips it", async () => {
    const lock = new ChannelLock();
    const holder = releaseOf(await lock.acquire(undefined));
    const timedOut = lock.acquire(500);
    const after = lock.acquire(10_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(await timedOut).toEqual({ ok: false, why: 'timeout' });
    holder();
    expect((await after).ok).toBe(true);
  });

  it("gives up when its signal aborts, 'aborted', whether already aborted or while waiting; the next release skips it", async () => {
    const lock = new ChannelLock();
    const holder = releaseOf(await lock.acquire(undefined));
    const done = new AbortController();
    done.abort();
    expect(await lock.acquire(undefined, done.signal)).toEqual({ ok: false, why: 'aborted' });
    const stop = new AbortController();
    const waiting = lock.acquire(10_000, stop.signal);
    const after = lock.acquire(10_000);
    stop.abort();
    expect(await waiting).toEqual({ ok: false, why: 'aborted' });
    holder();
    expect((await after).ok).toBe(true);
    // The aborted waiter's bound was cleared: no timeout fires for it later.
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
