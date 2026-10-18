// The daemons a test run starts end with it (docs/plans/idle-shutdown.md R6, A6): TEST_DAEMON_ENV holds R6's values,
// which the CLI accepts, and every agent-suite and eval file that gives ./asha a home of its own spreads it into that
// command's environment — so a new suite or eval cannot forget it.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { lifetimeFrom } from '../../src/cli/commands.js';
import { processRunning } from '../../src/daemon/lifetime.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Every .ts file under `dir`, but the agent suite's results. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'results' ? [] : sources(path);
    return e.name.endsWith('.ts') ? [path] : [];
  });
}

describe("a test run's daemons (idle-shutdown R6)", () => {
  it('TEST_DAEMON_ENV: this process, a 10-minute idle bound, a model kept a day — and asha --server accepts it', () => {
    expect(TEST_DAEMON_ENV).toEqual({
      ASHA_EXIT_WITH_PID: String(process.pid),
      ASHA_IDLE_EXIT_MS: '600000',
      ASHA_MODEL_IDLE_MS: '86400000',
    });
    expect(lifetimeFrom(TEST_DAEMON_ENV, processRunning)).toEqual({
      idleExitMs: 600_000,
      modelIdleMs: 86_400_000,
      exitWithPid: process.pid,
    });
  });

  it('every agent-suite and eval file that sets ASHA_HOME for a command spreads TEST_DAEMON_ENV into it', () => {
    const setsHome: string[] = [];
    const missing: string[] = [];
    for (const file of [...sources(join(ROOT, 'tests', 'agents')), ...sources(join(ROOT, 'tests', 'eval'))]) {
      // A command's environment names ASHA_HOME as a key; harnessPaths({ ASHA_HOME: … }) only computes a home's paths.
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /\bASHA_HOME:/.test(line) && !line.includes('harnessPaths('));
      if (lines.length === 0) continue;
      setsHome.push(relative(ROOT, file));
      if (!readFileSync(file, 'utf8').includes('...TEST_DAEMON_ENV')) missing.push(relative(ROOT, file));
    }
    expect(setsHome.toSorted(byCodeUnit)).toEqual([
      'tests/agents/patterns/recorder.ts',
      'tests/agents/persistence-support.ts',
      'tests/agents/support.ts',
      'tests/eval/agent-files.eval.test.ts',
      'tests/eval/hello-world.eval.test.ts',
      'tests/eval/image-prune.eval.test.ts',
      'tests/eval/isolation.eval.test.ts',
      'tests/eval/lifecycle.eval.test.ts',
      'tests/eval/portal.eval.test.ts',
    ]);
    expect(missing).toEqual([]);
  });
});
