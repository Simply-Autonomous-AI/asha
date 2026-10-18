// The unit config, run for real by vitest, refuses to start while the
// machine-wide agent-suite lock is held (tests/helpers/suite-lock.ts), and
// starts once it is released.
//
// It holds the real lock (AGENT_SUITE_LOCK) for the few seconds of one
// refused vitest start: the point is the real config and the real path. If
// another agent suite or eval holds it already, that holder is the one the
// refusal must name (reachable only when one took it after this integration
// run started, since the integration config refuses to start while it is
// held). An agent suite starting on this machine in those seconds
// is refused, naming this process, as it would be beside any other.

import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isAlive } from '../../src/daemon/process/pid-lock.js';
import {
  AGENT_SUITE_LOCK,
  AgentSuiteRunning,
  agentSuiteSetup,
  nodeLightRunFs,
  stderrLogger,
  takeAgentSuiteLock,
} from '../helpers/suite-lock.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const VITEST = join(REPO, 'node_modules', '.bin', 'vitest');

// ESC written via its character code, not a literal control character in the pattern (no-control-regex).
const ESC = String.fromCharCode(0x1b);
const ANSI_SGI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function vitest(args: readonly string[]): Promise<{ code: number; out: string }> {
  return new Promise((done, fail) =>
    execFile(VITEST, [...args], { cwd: REPO, timeout: 60_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error?.killed) {
        fail(new Error(`vitest ${args.join(' ')} exceeded 60 s\n${stdout}${stderr}`));
        return;
      }
      let code: number;
      if (error === null) {
        code = 0;
      } else {
        code = typeof error.code === 'number' ? error.code : -1;
      }
      // Colour codes stripped: a FORCE_COLOR in the environment colours vitest's report (the parse below reads it as text).
      done({
        code,
        out: `${stdout}${stderr}`.replace(ANSI_SGI, ''),
      });
    }),
  );
}

describe('the unit config and the agent-suite lock', () => {
  it('exits non-zero, naming the holder pid, while the lock is held, and runs once it is released', async () => {
    let release: (() => Promise<void>) | undefined;
    let holder = process.pid;
    try {
      release = await takeAgentSuiteLock({ file: AGENT_SUITE_LOCK, pid: process.pid, isAlive, logger: stderrLogger });
    } catch (error) {
      if (!(error instanceof AgentSuiteRunning)) throw error;
      holder = error.holderPid;
    }
    try {
      expect(Number.parseInt(await readFile(AGENT_SUITE_LOCK, 'utf8'), 10)).toBe(holder);
      const refused = await vitest(['run', '--config', 'vitest.config.mts', 'tests/unit/pid-lock.test.ts']);
      expect(refused.code, refused.out).not.toBe(0);
      expect(refused.out).toContain(
        `an agent suite or eval is running on this machine (pid ${String(holder)} holds ${AGENT_SUITE_LOCK})`,
      );
      expect(refused.out).not.toContain('Test Files');
    } finally {
      await release?.();
    }
    // Released (or held by another suite, which this cannot release): only this process's lock gates the second half.
    if (release === undefined) return;
    const ran = await vitest(['run', '--config', 'vitest.config.mts', 'tests/unit/pid-lock.test.ts']);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toMatch(/Test Files\s+1 passed/);
    // Two vitest starts, each bounded at 60 s above; about 0.5 s each on an idle machine (2026-09-27).
  }, 150_000);
});

describe('an agent suite waits for a registered unit or integration run (debt-paydown R20, A17; D29)', () => {
  it("the agent-suite setup, on the real filesystem, waits while a live child's registration stands, and proceeds within 2 s of its exit", async () => {
    // A lock and a folder of this test's own: the real ones are this integration run's (its own registration among them).
    const dir = await mkdtemp(join(tmpdir(), 'asha-light-runs-'));
    const lockFile = join(dir, 'asha-agent-suite.lock');
    const runs = join(dir, 'runs');
    await mkdir(runs);
    // The "unit run": a child that lives 3 s, registered by its pid.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 3000)'], { stdio: 'ignore' });
    const exitedAt = new Promise<number>((done) =>
      child.once('exit', () => {
        done(Date.now());
      }),
    );
    await writeFile(join(runs, String(child.pid)), `${String(child.pid)}\n`);
    const said: string[] = [];
    const started = Date.now();
    const release = await agentSuiteSetup({
      lockFile,
      pid: process.pid,
      dir: runs,
      fs: nodeLightRunFs,
      isAlive,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: () => Date.now(),
      stderr: (text) => {
        said.push(text);
      },
      logger: stderrLogger,
    });
    const proceeded = Date.now();
    try {
      const exited = await exitedAt;
      // It waited for the child (2.5 s at least of its 3 s), and went on within 2 s of its exit.
      expect(proceeded - started).toBeGreaterThanOrEqual(2_500);
      expect(proceeded - exited).toBeLessThanOrEqual(2_000);
      expect(said).toEqual([
        `waiting for unit or integration runs to finish (pids ${String(child.pid)}) before this agent suite or eval starts\n`,
      ]);
      // It holds the lock meanwhile, and the dead child's registration was cleared.
      expect(await readFile(lockFile, 'utf8')).toBe(String(process.pid));
      await expect(stat(join(runs, String(child.pid)))).rejects.toThrow('ENOENT');
    } finally {
      await release();
    }
  }, 30_000);
});
