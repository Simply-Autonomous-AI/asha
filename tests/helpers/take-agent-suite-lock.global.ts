// globalSetup of the agent-suite and eval configs: holds the machine-wide
// agent-suite lock for the whole run, and releases it at teardown
// (tests/helpers/suite-lock.ts). The holder is vitest's own process, so a
// run killed before its teardown leaves a dead pid, which the next taker reclaims.
// Once it holds the lock, it waits for every unit or integration run still registered (debt-paydown R20).

import { isAlive } from '../../src/daemon/process/pid-lock.js';
import { AGENT_SUITE_LOCK, LIGHT_RUNS_DIR, agentSuiteSetup, nodeLightRunFs, stderrLogger } from './suite-lock.js';

export default async function setup(): Promise<() => Promise<void>> {
  return agentSuiteSetup({
    lockFile: AGENT_SUITE_LOCK,
    pid: process.pid,
    dir: LIGHT_RUNS_DIR,
    fs: nodeLightRunFs,
    isAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    stderr: (text) => {
      process.stderr.write(text);
    },
    logger: stderrLogger,
  });
}
