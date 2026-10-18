// The fake-clock guard (tests/helpers/fake-clock-guard.ts): a test that has timed out cannot move the fake clock the
// next test runs on. Loaded for every unit and integration test by the suites' setup files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { byCodeUnit } from '../../src/shared/order.js';
import { CLOCK_MOVES, asTest, runningTest } from '../helpers/fake-clock-guard.js';

const ROOT = join(import.meta.dirname, '..', '..');

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame'],
    now: 0,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Each clock move, called as a test would. */
const CALLS: Record<(typeof CLOCK_MOVES)[number], () => unknown> = {
  advanceTimersByTime: () => vi.advanceTimersByTime(60_000),
  advanceTimersByTimeAsync: () => vi.advanceTimersByTimeAsync(60_000),
  advanceTimersToNextTimer: () => vi.advanceTimersToNextTimer(),
  advanceTimersToNextTimerAsync: () => vi.advanceTimersToNextTimerAsync(),
  advanceTimersToNextFrame: () => vi.advanceTimersToNextFrame(),
  runAllTimers: () => vi.runAllTimers(),
  runAllTimersAsync: () => vi.runAllTimersAsync(),
  runOnlyPendingTimers: () => vi.runOnlyPendingTimers(),
  runOnlyPendingTimersAsync: () => vi.runOnlyPendingTimersAsync(),
  runAllTicks: () => vi.runAllTicks(),
  setSystemTime: () => vi.setSystemTime(60_000),
};

describe('the fake-clock guard', () => {
  it('runs each test as its own: the signal it reads is the test context’s, after awaits and timers too', async ({
    signal,
  }) => {
    expect(runningTest()).toBe(signal);
    await Promise.resolve();
    expect(runningTest()).toBe(signal);
    const later = await new Promise<AbortSignal | undefined>((resolve) =>
      setImmediate(() => {
        resolve(runningTest());
      }),
    );
    expect(later).toBe(signal);
  });

  it.each(CLOCK_MOVES)(
    '%s, called by a test that has timed out, refuses with its abort and moves nothing',
    async (name) => {
      let fired = 0;
      setTimeout(() => (fired += 1), 1_000);
      const timedOut = AbortSignal.abort(new Error('Test timed out in 5000ms.'));
      const outcome = await Promise.resolve()
        .then(() => asTest(timedOut, CALLS[name]))
        .then(
          () => 'moved',
          (error: unknown) => error,
        );
      expect(outcome).toBe(timedOut.reason);
      expect(Date.now()).toBe(0);
      expect(fired).toBe(0);
    },
  );

  it('an async move refuses by rejecting, not by throwing where it is called', () => {
    const timedOut = AbortSignal.abort();
    const result = asTest(timedOut, () => vi.advanceTimersByTimeAsync(1_000));
    expect(result).toBeInstanceOf(Promise);
    return expect(result).rejects.toBe(timedOut.reason);
  });

  it('a test still running moves the clock as before, its timers firing', async () => {
    let fired = 0;
    setTimeout(() => (fired += 1), 1_000);
    await asTest(new AbortController().signal, () => vi.advanceTimersByTimeAsync(1_000));
    expect(Date.now()).toBe(1_000);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(500);
    expect(Date.now()).toBe(1_500);
  });

  it("guards every call of vi's that moves the clock or fires its timers", () => {
    const moves = Object.keys(vi).filter((key) =>
      /^(advanceTimers|runAllTimers|runOnlyPendingTimers|runAllTicks|setSystemTime)/.test(key),
    );
    expect([...moves].sort(byCodeUnit)).toEqual([...CLOCK_MOVES].sort(byCodeUnit));
  });

  it('is loaded by the unit and the integration suites', () => {
    for (const config of ['vitest.config.mts', 'vitest.integration.config.mts']) {
      expect(readFileSync(join(ROOT, config), 'utf8'), config).toContain("'tests/helpers/fake-clock-guard.setup.ts'");
    }
  });
});
