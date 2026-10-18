// The machine-wide agent-suite lock (tests/helpers/suite-lock.ts), on a
// temporary file: the configs use AGENT_SUITE_LOCK, which the integration
// test exercises through a real vitest run.

import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_SUITE_LOCK,
  AgentSuiteRunning,
  LIGHT_RUNS_DIR,
  LightRunsStillRunning,
  refuseWhileAgentSuiteRuns,
  registerLightRun,
  takeAgentSuiteLock,
  waitForLightRuns,
  type LightRunFs,
} from '../helpers/suite-lock.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { RecordingLogger } from '../helpers/fakes.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('the agent-suite lock', () => {
  let file: string;
  let logger: RecordingLogger;
  beforeEach(async () => {
    file = join(await mkdtemp(join(tmpdir(), 'asha-suite-lock-')), 'asha-agent-suite.lock');
    logger = new RecordingLogger();
  });
  const liveOnly = (live: readonly number[]) => (pid: number) => live.includes(pid);

  it('is one fixed path for every process on the machine, not read from TMPDIR', () => {
    expect(AGENT_SUITE_LOCK).toBe('/tmp/asha-agent-suite.lock');
  });

  it('holds the taker pid while taken and is gone once released', async () => {
    const release = await takeAgentSuiteLock({ file, pid: 4242, isAlive: liveOnly([]), logger });
    expect(await readFile(file, 'utf8')).toBe('4242');
    await release();
    expect(await exists(file)).toBe(false);
    expect(logger.entries).toEqual([]);
  });

  it('refuses a second taker while the holder lives, naming the holder pid, and leaves the lock as it was', async () => {
    await takeAgentSuiteLock({ file, pid: 4242, isAlive: liveOnly([4242]), logger });

    const error = await takeAgentSuiteLock({ file, pid: 5151, isAlive: liveOnly([4242]), logger }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AgentSuiteRunning);
    expect((error as AgentSuiteRunning).holderPid).toBe(4242);
    expect((error as Error).message).toBe(
      `cannot start this agent suite or eval: an agent suite or eval is running on this machine (pid 4242 holds ${file}); ` +
        'only one runs at a time, and a unit or integration run beside it breaks its timing bounds (AGENTS.md §3). Wait for it to finish.',
    );
    expect(await readFile(file, 'utf8')).toBe('4242');
  });

  it("reclaims a dead holder's lock for the new taker, and records that it did", async () => {
    await writeFile(file, '4242');

    await takeAgentSuiteLock({ file, pid: 5151, isAlive: liveOnly([]), logger });
    expect(await readFile(file, 'utf8')).toBe('5151');
    expect(logger.entries.map((e) => [e.level, e.event, e.fields])).toEqual([
      ['warn', 'lock.stale_cleared', { file, holder: 4242 }],
    ]);
  });

  describe('a unit or integration run', () => {
    it('refuses to start while a live process holds it, naming the holder pid', async () => {
      await writeFile(file, '4242');
      const asked: number[] = [];
      const error = await refuseWhileAgentSuiteRuns({
        file,
        isAlive: (pid) => (asked.push(pid), true),
        what: 'refusing to start',
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AgentSuiteRunning);
      expect((error as Error).message).toContain(
        `refusing to start: an agent suite or eval is running on this machine (pid 4242 holds ${file})`,
      );
      expect(asked).toEqual([4242]);
    });

    it('starts when no lock exists, asking about no pid', async () => {
      const asked: number[] = [];
      await expect(
        refuseWhileAgentSuiteRuns({ file, isAlive: (pid) => (asked.push(pid), true), what: 'x' }),
      ).resolves.toBeUndefined();
      expect(asked).toEqual([]);
    });

    it("starts when the holder is dead, and leaves the dead holder's lock for the next taker to reclaim", async () => {
      await writeFile(file, '4242');
      await expect(refuseWhileAgentSuiteRuns({ file, isAlive: liveOnly([]), what: 'x' })).resolves.toBeUndefined();
      expect(await readFile(file, 'utf8')).toBe('4242');
    });
  });
});

/** An in-memory folder of registrations, recording every operation. */
class Runs implements LightRunFs {
  readonly files = new Set<string>();
  readonly ops: string[] = [];
  mkdir(dir: string): Promise<void> {
    this.ops.push(`mkdir ${dir}`);
    return Promise.resolve();
  }
  createNew(path: string): Promise<void> {
    this.ops.push(`create ${path}`);
    if (this.files.has(path)) return Promise.reject(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }));
    this.files.add(path);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.ops.push(`remove ${path}`);
    this.files.delete(path);
    return Promise.resolve();
  }
  list(dir: string): Promise<string[]> {
    return Promise.resolve([...this.files].filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)));
  }
}

describe('unit and integration runs register, and an agent suite waits for them (debt-paydown R20, A17; D29)', () => {
  it('the registrations are one fixed folder, /tmp/asha-light-runs', () => {
    expect(LIGHT_RUNS_DIR).toBe('/tmp/asha-light-runs');
  });

  it('registers before the refusal check, and the check sees the registration; the teardown removes it', async () => {
    const runs = new Runs();
    const seen: string[][] = [];
    const teardown = await registerLightRun({
      dir: '/r',
      pid: 4242,
      fs: runs,
      refuse: () => {
        seen.push([...runs.files]);
        return Promise.resolve();
      },
    });
    expect(seen).toEqual([['/r/4242']]);
    expect(runs.ops).toEqual(['mkdir /r', 'create /r/4242']);
    await teardown();
    expect([runs.ops.at(-1), [...runs.files]]).toEqual(['remove /r/4242', []]);
  });

  it("replaces a killed run's registration left under the pid this run now holds (completion review, finding 18)", async () => {
    const runs = new Runs();
    runs.files.add('/r/4242');
    await registerLightRun({ dir: '/r', pid: 4242, fs: runs, refuse: () => Promise.resolve(undefined) });
    expect(runs.ops).toEqual(['mkdir /r', 'create /r/4242', 'remove /r/4242', 'create /r/4242']);
    expect([...runs.files]).toEqual(['/r/4242']);
  });

  it('a refused run removes its registration and throws the refusal', async () => {
    const runs = new Runs();
    const refusal = new AgentSuiteRunning('/tmp/asha-agent-suite.lock', 777, 'refusing');
    await expect(
      registerLightRun({ dir: '/r', pid: 4242, fs: runs, refuse: async () => Promise.reject(refusal) }),
    ).rejects.toBe(refusal);
    expect(runs.ops).toEqual(['mkdir /r', 'create /r/4242', 'remove /r/4242']);
    expect([...runs.files]).toEqual([]);
  });

  /** A fake clock and sleep, and the lines written to stderr. */
  const waiting = (runs: Runs, alive: (pid: number, t: number) => boolean) => {
    let t = 0;
    const sleeps: number[] = [];
    const err: string[] = [];
    const logger = new RecordingLogger();
    const props = {
      dir: '/r',
      fs: runs,
      isAlive: (pid: number) => alive(pid, t),
      sleep: (ms: number) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
      now: () => t,
      stderr: (text: string) => {
        err.push(text);
      },
      logger,
    };
    return { props, sleeps, err, logger, time: () => t };
  };

  it('waits while a registered run lives, polling every 1,000 ms and saying so once; clears a dead one, logged', async () => {
    const runs = new Runs();
    for (const name of ['111', '222', 'notes.txt']) runs.files.add(`/r/${name}`);
    const w = waiting(runs, (pid, t) => pid === 111 && t < 3_000);
    // 111 finishes at 3,000 ms, its teardown removing its registration.
    await waitForLightRuns({
      ...w.props,
      sleep: async (ms) => {
        await w.props.sleep(ms);
        if (w.time() >= 3_000) runs.files.delete('/r/111');
      },
    });
    expect(w.sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(w.err).toEqual([
      'waiting for unit or integration runs to finish (pids 111) before this agent suite or eval starts\n',
    ]);
    expect(w.logger.entries).toEqual([
      { level: 'warn', event: 'suite.stale_registration_cleared', fields: { pid: 222 } },
    ]);
    // A live run's registration is its own to remove; the stranger's file is left alone.
    expect([...runs.files].sort(byCodeUnit)).toEqual(['/r/notes.txt']);
  });

  it('with nothing registered, or no folder, starts at once', async () => {
    const w = waiting(new Runs(), () => true);
    await waitForLightRuns(w.props);
    expect([w.sleeps, w.err]).toEqual([[], []]);
    const missing = waiting(new Runs(), () => true);
    // A real Runs instance, its list() overridden on the instance itself (never spread: spreading an instance
    // would copy its own fields but lose the class's other methods on the prototype, sonarjs/no-misused-spread).
    const noFolder = new Runs();
    noFolder.list = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await waitForLightRuns({ ...missing.props, fs: noFolder });
    expect(missing.sleeps).toEqual([]);
  });

  it('fails at 300,000 ms naming the live pids', async () => {
    const runs = new Runs();
    for (const name of ['333', '111']) runs.files.add(`/r/${name}`);
    const w = waiting(runs, () => true);
    const error = await waitForLightRuns(w.props).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LightRunsStillRunning);
    expect((error as Error).message).toBe(
      'unit or integration runs still running after 300000 ms (pids 111, 333): an agent suite or eval does not start beside them (AGENTS.md §3)',
    );
    expect([w.time(), w.sleeps.length, w.err.length]).toEqual([300_000, 300, 1]);
  });
});
