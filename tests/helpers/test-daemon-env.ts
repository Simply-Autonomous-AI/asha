// The lifetime of every daemon a test run starts through ./asha (docs/plans/idle-shutdown.md R6): spread into the
// environment of each command a suite or eval runs, so a daemon it auto-starts, or starts with --server, ends with
// the run — however the run ends — instead of lingering for days.

/**
 * - ASHA_EXIT_WITH_PID: the vitest process running the test file; the daemon stops within 5 s of its end.
 * - ASHA_IDLE_EXIT_MS: 10 minutes, a backstop should that pid be reused by another of this user's processes first.
 * - ASHA_MODEL_IDLE_MS: a day, so no model is unloaded during a run: the replies the gate asserts never follow a reload.
 */
export const TEST_DAEMON_ENV = {
  ASHA_EXIT_WITH_PID: String(process.pid),
  ASHA_IDLE_EXIT_MS: '600000',
  ASHA_MODEL_IDLE_MS: '86400000',
} as const;
