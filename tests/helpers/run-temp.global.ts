// The first globalSetup of every vitest config: the run's temporary files in a folder of its own, removed at the run's
// end (tests/helpers/run-temp.ts). First, so that every later setup's temporary files go there too.

import { tmpdir } from 'node:os';

import { isAlive } from '../../src/daemon/process/pid-lock.js';
import { runTempSetup } from './run-temp.js';

export default function setup(): () => void {
  return runTempSetup({ base: tmpdir(), pid: process.pid, isAlive, env: process.env }).teardown;
}
