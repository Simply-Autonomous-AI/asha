// A signal bounded by a timeout and by other signals, that keeps its bound.
//
// `AbortSignal.any([AbortSignal.timeout(ms), …])` holds its sources only weakly. With nothing else holding the timeout
// signal, a garbage collection takes it, and its timer with it, and the composite never aborts: the call it bounds
// waits on a silent peer forever (PRINCIPLES §11). Measured on Node v22.13.1, 2026-10-11: the composite aborted
// without a collection and never after five, and tests/unit/model-gateway.test.ts's embedding timeout failed under
// shuffled orders that put a collection inside its 30 ms. A composite holding its timeout is not enough either: one
// passed through AbortSignal.any again is rebuilt from its sources, and the outer holds them weakly too (the review of
// 049eb99, finding 1). So a timer holds the timeout signal until it has fired, whoever holds the composite.

/**
 * A signal that aborts after `timeoutMs` with `AbortSignal.timeout`'s own `TimeoutError`, or as soon as any of
 * `others` aborts, with its reason. The timeout is AbortSignal.timeout's: unaffected by a test's fake timers, and
 * never keeping the process alive.
 */
export function withTimeout(timeoutMs: number, ...others: readonly AbortSignal[]): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  // Held strongly, by an active timer, until just after the timeout has fired: its closure is the only reference it
  // needs. Unref'd, so it never keeps the process alive; under a test's fake timers it simply never runs. Reading
  // `timeout.aborted` (rather than a bare `void timeout`) is what makes the closure hold the reference, without a
  // `void` operator discarding anything.
  const hold = setTimeout(() => {
    if (timeout.aborted) return;
  }, timeoutMs + 1_000);
  hold.unref();
  return others.length === 0 ? timeout : AbortSignal.any([timeout, ...others]);
}
