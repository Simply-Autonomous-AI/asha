// The signals that stop `asha --server` (and end `asha --watch`): SIGINT
// (Ctrl-C), SIGTERM (`asha --stop`, a service manager, a shutdown) and SIGHUP
// (the terminal of a foreground `asha --server` closing). Each handler stays
// installed until it is removed — for the server, until the process exits —
// so a second signal during a stop reaches asha, which logs it, instead of
// Node's default action, which ends the process at once with nothing logged.
// (Until 2026-09-27 the handlers were installed with `process.once` and
// SIGHUP had none: a second signal, or a closed terminal, killed a stopping
// daemon silently — debt D21.)

/** Every signal asha treats as "stop". */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** Where signals arrive: the process, or a fake in tests. */
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

/** Calls `listener` on every shutdown signal until the returned function is called. */
export type ShutdownSignals = (listener: (signal: ShutdownSignal) => void) => () => void;

/** Shutdown signals from `source`: a handler per signal, kept (never `once`) until removed. */
export function shutdownSignals(source: SignalSource): ShutdownSignals {
  return (listener) => {
    const handlers = SHUTDOWN_SIGNALS.map(
      (signal) =>
        [
          signal,
          () => {
            listener(signal);
          },
        ] as const,
    );
    for (const [signal, handler] of handlers) source.on(signal, handler);
    return () => {
      for (const [signal, handler] of handlers) source.off(signal, handler);
    };
  };
}
