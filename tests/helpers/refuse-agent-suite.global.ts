// globalSetup of the unit and integration configs: registers this run in LIGHT_RUNS_DIR, then refuses to start while
// an agent suite or eval holds the machine-wide lock (tests/helpers/suite-lock.ts; debt-paydown R20). The teardown
// removes the registration, so an agent suite waiting for it starts.

import { isAlive } from '../../src/daemon/process/pid-lock.js';
import {
  AGENT_SUITE_LOCK,
  LIGHT_RUNS_DIR,
  nodeLightRunFs,
  refuseWhileAgentSuiteRuns,
  registerLightRun,
} from './suite-lock.js';

export default async function setup(): Promise<() => Promise<void>> {
  return registerLightRun({
    dir: LIGHT_RUNS_DIR,
    pid: process.pid,
    fs: nodeLightRunFs,
    refuse: () =>
      refuseWhileAgentSuiteRuns({
        file: AGENT_SUITE_LOCK,
        isAlive,
        what: 'refusing to start this unit or integration run',
      }),
  });
}
