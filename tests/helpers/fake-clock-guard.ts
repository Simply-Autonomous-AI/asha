// A test that times out runs on. Vitest fails it and starts the next test, but the body keeps running, on the fake
// clock the next test now uses (vi.useFakeTimers is one clock per worker). On 2026-10-11, under a load average of 11,
// a restart test timed out and its later `vi.advanceTimersByTimeAsync` moved the next test's clock past the time that
// test asked for ("Negative ticks are not supported"), read at first as a second defect. So every test runs with its
// own signal, which vitest aborts when it times out, and vi's clock moves refuse once the calling test's has aborted:
// the timed-out body stops at its next move, and the next test's clock stays its own.

import { AsyncLocalStorage } from 'node:async_hooks';

import { aroundEach, vi } from 'vitest';

/** vi's calls that move the fake clock or fire its timers. */
export const CLOCK_MOVES = [
  'advanceTimersByTime',
  'advanceTimersByTimeAsync',
  'advanceTimersToNextTimer',
  'advanceTimersToNextTimerAsync',
  'advanceTimersToNextFrame',
  'runAllTimers',
  'runAllTimersAsync',
  'runOnlyPendingTimers',
  'runOnlyPendingTimersAsync',
  'runAllTicks',
  'setSystemTime',
] as const;

/** The signal of the test each async context belongs to; none outside a test (a file's top level, beforeAll). */
const tests = new AsyncLocalStorage<AbortSignal>();

/** The signal of the test the caller belongs to, or undefined outside a test. */
export function runningTest(): AbortSignal | undefined {
  return tests.getStore();
}

/** Runs `run` as part of the test whose signal is `signal`, as aroundEach runs each test: for this guard's own tests. */
export function asTest<T>(signal: AbortSignal, run: () => T): T {
  return tests.run(signal, run);
}

/** Binds every test to its signal and wraps vi's clock moves; once per test file, from the suites' setup file. */
export function installFakeClockGuard(): void {
  aroundEach(async (runTest, { signal }) => {
    await tests.run(signal, runTest);
  });
  const utils = vi as unknown as Record<(typeof CLOCK_MOVES)[number], (...args: unknown[]) => unknown>;
  for (const name of CLOCK_MOVES) {
    const move = utils[name].bind(vi);
    utils[name] = (...args: unknown[]) => {
      const signal = tests.getStore();
      if (signal?.aborted === true) {
        // An async move rejects, as a timer's failure would, rather than throwing where `.then` is chained.
        if (name.endsWith('Async')) return Promise.reject(signal.reason as Error);
        throw signal.reason;
      }
      return move(...args);
    };
  }
}
