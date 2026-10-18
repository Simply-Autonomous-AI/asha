// The daemon says it is stopping (docs/plans/debt-paydown.md R14, A12; debt D21): its stop rewrites daemon.json with
// `stopping: true` before the control API starts answering 503, keeps it through the stop, and removes it as its last
// step, after daemon.lock is released. A write that fails is logged and the stop goes on as before R14.

import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { markStopping, removeOwnDaemonFile, startDaemon } from '../../src/daemon/compose.js';
import { harnessPaths } from '../../src/shared/paths.js';
import {
  FakeModelServer,
  FakeRuntime,
  FakeStore,
  REAL_STATE,
  TEST_LIFETIME,
  fixtureRoot,
} from '../helpers/daemon-fakes.js';
import { ManualSchedule, RecordingLogger } from '../helpers/fakes.js';
import { portalStub } from '../helpers/portal-folders.js';

describe('markStopping (R14)', () => {
  it('writes the stopping file, then sets the flag', async () => {
    const order: string[] = [];
    const logger = new RecordingLogger();
    await markStopping({
      logger,
      write: () => {
        order.push('write');
      },
      remove: () => {
        order.push('remove');
        return Promise.resolve();
      },
      setStopping: () => {
        order.push('flag');
      },
    });
    expect([order, logger.entries]).toEqual([['write', 'flag'], []]);
  });

  it('a write that throws logs daemon.stopping_file_failed, sets the flag, and removes the file as before R14', async () => {
    const order: string[] = [];
    const logger = new RecordingLogger();
    const failure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    await markStopping({
      logger,
      write: () => {
        order.push('write');
        throw failure;
      },
      remove: () => {
        order.push('remove');
        return Promise.resolve();
      },
      setStopping: () => {
        order.push('flag');
      },
    });
    expect(order).toEqual(['write', 'flag', 'remove']);
    expect(logger.entries).toEqual([
      { level: 'error', event: 'daemon.stopping_file_failed', fields: { error: failure } },
    ]);
  });
});

describe('removeOwnDaemonFile (R14; completion review, finding 15)', () => {
  it("removes daemon.json while it is this daemon's, leaves a new daemon's, and takes a missing one as removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-own-'));
    const file = join(dir, 'daemon.json');
    await writeFile(file, JSON.stringify({ pid: 4242, port: 1, credential: 'c', stopping: true }));
    await removeOwnDaemonFile(file, 4242);
    await expect(stat(file)).rejects.toThrow('ENOENT');
    await removeOwnDaemonFile(file, 4242);
    await writeFile(file, JSON.stringify({ pid: 5151, port: 2, credential: 'd' }));
    await removeOwnDaemonFile(file, 4242);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ pid: 5151, port: 2, credential: 'd' });
  });
});

describe("a real daemon's stop (R14)", () => {
  it('holds daemon.json with stopping: true through the stop, then removes it after the lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-stopping-'));
    const paths = harnessPaths({ ASHA_HOME: home });
    const runtime = new FakeRuntime('127.0.0.1');
    const logger = new RecordingLogger();
    const daemon = await startDaemon({
      paths,
      root: await fixtureRoot(),
      version: 't',
      build: 't',
      pid: process.pid,
      logger,
      dependencies: {
        runtime,
        modelServer: new FakeModelServer('http://127.0.0.1:1'),
        store: new FakeStore(),
        ...REAL_STATE,
        fetch,
      },
      heartbeatMs: 1_000,
      chatTimeoutMs: 1_000,
      schedule: new ManualSchedule().schedule,
      lifetime: TEST_LIFETIME,
      portal: await portalStub(),
    });
    const running = JSON.parse(await readFile(paths.daemonFile, 'utf8')) as Record<string, unknown>;
    // The stop's reclaim is held, so the file can be read mid-stop.
    let releaseReclaim!: () => void;
    const held = new Promise<void>((resolve) => (releaseReclaim = resolve));
    let reached!: () => void;
    const atReclaim = new Promise<void>((resolve) => (reached = resolve));
    const reclaim = runtime.reclaim.bind(runtime);
    runtime.reclaim = async () => {
      reached();
      await held;
      return reclaim();
    };
    const stopped = daemon.stop();
    await atReclaim;
    expect(JSON.parse(await readFile(paths.daemonFile, 'utf8'))).toEqual({ ...running, stopping: true });
    expect(((await stat(paths.daemonFile)).mode & 0o777).toString(8)).toBe('600');
    await stat(paths.daemonLock);
    releaseReclaim();
    await stopped;
    await expect(stat(paths.daemonFile)).rejects.toThrow('ENOENT');
    await expect(stat(paths.daemonLock)).rejects.toThrow('ENOENT');
    expect(logger.events()).toContain('daemon.stopped');
  });
});
