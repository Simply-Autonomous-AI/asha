// The daemon's files and home (docs/plans/control-api-auth.md R2, A3): a new home is
// 0700, an existing one keeps its mode; daemon.json is written 0600 by create-and-rename
// with a fresh credential at every start, and removed at stop. Also the helpers behind it.

import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { startDaemon, stopDaemon } from '../../src/daemon/compose.js';
import { writePrivateFile, writePrivateFileSync } from '../../src/daemon/private-file/index.js';
import { ExecCommandRunner } from '../../src/daemon/process/index.js';
import { RefusalLog } from '../../src/daemon/refusal-log/index.js';
import { createDaemonServer, type DaemonServerProps } from '../../src/daemon/server.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { ensureHome, harnessPaths } from '../../src/shared/paths.js';
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

/** A path's permission bits, as `ls` would show them in octal: '0600'. */
const mode = async (path: string) => `0${((await stat(path)).mode & 0o777).toString(8)}`;

async function start(home: string, reclaimVolumes = 0, modelServer = new FakeModelServer('http://127.0.0.1:1')) {
  const logger = new RecordingLogger();
  const runtime = new FakeRuntime('127.0.0.1');
  // What the start's reclaim reports removed: a dead run's volumes (agent-files R10a).
  runtime.reclaimVolumes = reclaimVolumes;
  const daemon = await startDaemon({
    paths: harnessPaths({ ASHA_HOME: home }),
    root: await fixtureRoot(),
    version: 't',
    build: 't',
    pid: process.pid,
    logger,
    dependencies: { runtime, modelServer, store: new FakeStore(), ...REAL_STATE, fetch },
    heartbeatMs: 1_000,
    chatTimeoutMs: 1_000,
    schedule: new ManualSchedule().schedule,
    lifetime: TEST_LIFETIME,
    portal: await portalStub(),
  });
  return { daemon, logger, runtime, modelServer };
}

describe('the daemon home and daemon.json (A3)', () => {
  it('creates a new home 0700, and writes daemon.json 0600 with a fresh credential that the daemon accepts', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'asha-files-')), 'new', 'home');

    const { daemon, runtime, modelServer } = await start(home);
    try {
      expect(await mode(home)).toBe('0700');
      const file = join(home, 'daemon.json');
      expect(await mode(file)).toBe('0600');
      const content = JSON.parse(await readFile(file, 'utf8')) as { pid: number; port: number; credential: string };
      expect(Object.keys(content).sort(byCodeUnit)).toEqual(['credential', 'pid', 'port']);
      expect(content.pid).toBe(process.pid);
      expect(content.port).toBe(daemon.port);
      expect(Buffer.from(content.credential, 'hex').byteLength).toBeGreaterThanOrEqual(16);
      expect(content.credential).toMatch(/^[0-9a-f]{64}$/);
      const answer = await fetch(`http://127.0.0.1:${String(daemon.port)}/v1/health`, {
        headers: { authorization: `Bearer ${content.credential}` },
      });
      expect(answer.status).toBe(200);
      // What a dead daemon of this home left in the runtime is reclaimed before anything else, then its model servers;
      // then asha's old image versions are pruned (debt-paydown-2 R1).
      expect(runtime.calls).toEqual(['reclaim', 'pruneImages']);
      expect(modelServer.reclaimed).toBe(1);
    } finally {
      await daemon.stop();
    }
    await expect(stat(join(home, 'daemon.json'))).rejects.toThrow('ENOENT');
  });

  it("keeps an existing home's mode, replaces a stale 0644 daemon.json, ignores a leftover temporary file, and changes the credential at every start", async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-files-'));
    await chmod(home, 0o755);
    const file = join(home, 'daemon.json');
    await writeFile(file, JSON.stringify({ pid: 1, port: 1 }), { mode: 0o644 });
    await chmod(file, 0o644);
    const leftover = join(home, '.daemon.json.99999.0123456789abcdef.tmp');
    await writeFile(leftover, 'half');

    const first = await start(home);
    const one = JSON.parse(await readFile(file, 'utf8')) as { credential: string };
    expect(await mode(file)).toBe('0600');
    expect(await mode(home)).toBe('0755');
    await first.daemon.stop();
    await expect(stat(file)).rejects.toThrow('ENOENT');

    const second = await start(home);
    const two = JSON.parse(await readFile(file, 'utf8')) as { credential: string };
    await second.daemon.stop();

    expect(two.credential).not.toBe(one.credential);
    expect(await readFile(leftover, 'utf8')).toBe('half');
    // No temporary file of its own is left behind.
    expect((await readdir(home)).filter((f) => f.endsWith('.tmp'))).toEqual([
      '.daemon.json.99999.0123456789abcdef.tmp',
    ]);
  });

  it('the server cannot be created without the credential: it exists before listen', () => {
    const props = {} as Omit<DaemonServerProps, 'credential'>;
    // @ts-expect-error — `credential` is a required prop of createDaemonServer (checked by the typecheck step).
    const make = () => createDaemonServer(props);
    expect(make).toBeTypeOf('function');
  });
});

describe('ensureHome and homeId', () => {
  it('creates missing parents too, and leaves an existing home as it is', async () => {
    const base = await mkdtemp(join(tmpdir(), 'asha-home-'));
    const paths = harnessPaths({ ASHA_HOME: join(base, 'a', 'b') });
    await ensureHome(paths);
    expect(await mode(paths.home)).toBe('0700');
    await chmod(paths.home, 0o750);
    await ensureHome(paths);
    expect(await mode(paths.home)).toBe('0750');
  });

  it('is the first 8 hex characters of the sha256 of the absolute home, and names model-server.key', () => {
    const paths = harnessPaths({ ASHA_HOME: 'relative/home' });
    expect(paths.homeId).toBe(createHash('sha256').update(resolve('relative/home')).digest('hex').slice(0, 8));
    expect(harnessPaths({ ASHA_HOME: '/x/y' }).homeId).toBe(
      createHash('sha256').update('/x/y').digest('hex').slice(0, 8),
    );
    expect(harnessPaths({ ASHA_HOME: '/x/y' }).modelServerKey).toBe('/x/y/model-server.key');
  });
});

describe('writePrivateFile', () => {
  it('writes 0600 over a 0644 file by rename, leaving no temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-private-'));
    const target = join(dir, 'secret');
    await writeFile(target, 'old', { mode: 0o644 });
    await writePrivateFile(target, 'new\n');
    expect(await readFile(target, 'utf8')).toBe('new\n');
    expect(await mode(target)).toBe('0600');
    expect(await readdir(dir)).toEqual(['secret']);
  });

  it('fails loudly, leaving no temporary file, when the rename cannot happen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-private-'));
    await mkdir(join(dir, 'secret', 'inside'), { recursive: true });
    await expect(writePrivateFile(join(dir, 'secret'), 'x')).rejects.toThrow(/EISDIR|ENOTEMPTY|EEXIST|EPERM/);
    expect(await readdir(dir)).toEqual(['secret']);
  });
});

describe('writePrivateFileSync (debt-paydown R14)', () => {
  it('writes 0600 over a 0644 file by rename, leaving no temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-private-'));
    const target = join(dir, 'secret');
    await writeFile(target, 'old', { mode: 0o644 });
    writePrivateFileSync(target, 'new\n');
    expect(await readFile(target, 'utf8')).toBe('new\n');
    expect(await mode(target)).toBe('0600');
    expect(await readdir(dir)).toEqual(['secret']);
  });

  it('fails loudly, leaving no temporary file, when the rename cannot happen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-private-'));
    await mkdir(join(dir, 'secret', 'inside'), { recursive: true });
    expect(() => {
      writePrivateFileSync(join(dir, 'secret'), 'x');
    }).toThrow(/EISDIR|ENOTEMPTY|EEXIST|EPERM/);
    expect(await readdir(dir)).toEqual(['secret']);
  });
});

describe('RefusalLog', () => {
  const refusal = { reason: 'credential_missing', api: 'v1', method: 'GET', path: '/v1/health' } as const;

  it('logs the first at once, counts the rest of the window, and keeps windows per reason and API', () => {
    const logger = new RecordingLogger();
    const clock = new ManualSchedule();
    const log = new RefusalLog({ logger, schedule: clock.schedule, windowMs: 1_000 });

    log.record(refusal);
    log.record({ ...refusal, path: '/v1/channel' });
    log.record({ ...refusal, api: 'agent', reason: 'token_missing', path: '/agent/v1/channel' });
    expect(clock.pending()).toEqual([1_000, 1_000]);
    clock.fire();
    clock.fire();
    log.record(refusal);

    expect(logger.entries).toEqual([
      {
        level: 'warn',
        event: 'http.refused',
        fields: { method: 'GET', path: '/v1/health', reason: 'credential_missing', api: 'v1', count: 1 },
      },
      {
        level: 'warn',
        event: 'http.refused',
        fields: { method: 'GET', path: '/agent/v1/channel', reason: 'token_missing', api: 'agent', count: 1 },
      },
      {
        level: 'warn',
        event: 'http.refused',
        fields: { method: 'GET', path: '/v1/channel', reason: 'credential_missing', api: 'v1', count: 1 },
      },
      {
        level: 'warn',
        event: 'http.refused',
        fields: { method: 'GET', path: '/v1/health', reason: 'credential_missing', api: 'v1', count: 1 },
      },
    ]);
  });

  // Completion review F4: a refusal right after a window that had refusals is not "after a quiet second", so it is
  // counted in a new window, not logged at once; otherwise a flood costs two records per key per window.
  it('keeps counting in a new window when refusals continue past a window that had some', () => {
    const logger = new RecordingLogger();
    const clock = new ManualSchedule();
    const log = new RefusalLog({ logger, schedule: clock.schedule, windowMs: 1_000 });
    log.record(refusal);
    log.record(refusal);
    clock.fire();
    expect(logger.entries.map((e) => e.fields['count'])).toEqual([1, 1]);
    expect(clock.pending()).toEqual([1_000]);

    log.record(refusal);
    expect(logger.entries).toHaveLength(2);
    clock.fire();
    expect(logger.entries.map((e) => e.fields['count'])).toEqual([1, 1, 1]);
    expect(clock.pending()).toEqual([1_000]);

    // A window with nothing counted closes for good: the next refusal is after a quiet window and is logged at once.
    clock.fire();
    expect(clock.pending()).toEqual([]);
    log.record(refusal);
    expect(logger.entries.map((e) => e.fields['count'])).toEqual([1, 1, 1, 1]);
  });

  it('flush logs pending counts and cancels every window', () => {
    const logger = new RecordingLogger();
    const clock = new ManualSchedule();
    const log = new RefusalLog({ logger, schedule: clock.schedule, windowMs: 1_000 });
    for (let i = 0; i < 3; i += 1) log.record(refusal);
    log.flush();
    expect(logger.entries.map((e) => e.fields['count'])).toEqual([1, 2]);
    expect(clock.pending()).toEqual([]);
    log.flush();
    expect(logger.entries).toHaveLength(2);
  });
});

describe('ExecCommandRunner standard input', () => {
  it('writes stdin to the command and closes it', async () => {
    const result = await new ExecCommandRunner().run('sh', ['-s'], {
      timeoutMs: 5_000,
      stdin: 'echo "from stdin: $((1 + 2))"\n',
    });
    expect(result).toEqual({ code: 0, stdout: 'from stdin: 3\n', stderr: '' });
  });

  it('returns a non-zero exit as data, with the script output', async () => {
    const result = await new ExecCommandRunner().run('sh', ['-s'], {
      timeoutMs: 5_000,
      stdin: 'echo oops >&2\nexit 3\n',
    });
    expect(result).toEqual({ code: 3, stdout: '', stderr: 'oops\n' });
  });
});

describe("the channel file spaces at a daemon's start and stop (agent-files R10, R10a; A8, A11)", () => {
  const filesRecords = (logger: RecordingLogger) => logger.entries.filter((e) => e.event.startsWith('files.'));

  it('two starts of one home draw different runIds, 8 hex each, logged on daemon.started', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-run-'));
    const runIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { daemon, logger } = await start(home);
      await daemon.stop();
      runIds.push(
        String(
          present(
            logger.entries.find((e) => e.event === 'daemon.started'),
            'the daemon.started entry',
          ).fields['runId'],
        ),
      );
    }
    expect(runIds[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(runIds[1]).toMatch(/^[0-9a-f]{8}$/);
    expect(runIds[0]).not.toBe(runIds[1]);
  });

  it("a start whose reclaim removed 2 of a dead run's volumes logs files.stale_space_removed {volumes: 2} at warn; a stop removing none logs no files record", async () => {
    const { daemon, logger, runtime } = await start(await mkdtemp(join(tmpdir(), 'asha-run-')), 2);
    runtime.reclaimVolumes = 0;
    await daemon.stop();
    expect(filesRecords(logger)).toEqual([
      { level: 'warn', event: 'files.stale_space_removed', fields: { volumes: 2 } },
    ]);
  });

  it('a start removing none logs no files record; a stop removing 2 logs files.space_removed {volumes: 2} at info', async () => {
    const { daemon, logger, runtime } = await start(await mkdtemp(join(tmpdir(), 'asha-run-')));
    expect(filesRecords(logger)).toEqual([]);
    runtime.reclaimVolumes = 2;
    await daemon.stop();
    expect(filesRecords(logger)).toEqual([{ level: 'info', event: 'files.space_removed', fields: { volumes: 2 } }]);
  });

  it('a stop whose reclaim failed on a volume logs daemon.reclaim_failed naming it, still stops the model servers and releases the lock, then fails', async () => {
    const logger = new RecordingLogger();
    const done: string[] = [];
    const failure = new Error(
      'isolation reclaim failed: reclaim: volume asha-abcd1234-0123abcd-lab could not be removed: volume is in use',
    );
    const stopped = stopDaemon({
      logger,
      beginStopping: () => Promise.resolve(),
      removeDaemonFile: () => Promise.resolve(),
      supervisor: { stopAll: () => Promise.resolve(), approvedSettled: () => Promise.resolve() },
      closeServer: () => Promise.resolve(),
      runtime: { reclaim: async () => Promise.reject(failure) },
      modelServer: {
        stopAll: () => {
          done.push('model servers');
          return Promise.resolve();
        },
      },
      closeTraces: () => {
        done.push('traces');
      },
      release: () => {
        done.push('lock');
        return Promise.resolve();
      },
    });
    await expect(stopped).rejects.toBe(failure);
    expect(logger.entries.filter((e) => e.level === 'error')).toEqual([
      { level: 'error', event: 'daemon.reclaim_failed', fields: { error: failure } },
    ]);
    expect(done).toEqual(['model servers', 'traces', 'lock']);
    expect(logger.events()).not.toContain('daemon.stopped');
    expect(filesRecords(logger)).toEqual([]);
  });
});

describe("the start's orphan sweep (debt-paydown R13, A10; D13)", () => {
  it('runs after the runtime reclaim and before the server listens; a sweep that throws logs daemon.orphan_sweep_failed, releases the lock, and fails the start', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-sweep-'));
    const order: string[] = [];
    const failure = new Error('ps -axww -o pid=,ppid=,command= exited 1: ps: illegal option');
    const modelServer = new FakeModelServer('http://127.0.0.1:1');
    modelServer.reclaimOrphansWith = () => {
      order.push('sweep');
      return Promise.reject(failure);
    };
    const logger = new RecordingLogger();
    const runtime = new FakeRuntime('127.0.0.1');
    const reclaim = runtime.reclaim.bind(runtime);
    runtime.reclaim = async () => {
      order.push('runtime reclaim');
      return reclaim();
    };
    const started = startDaemon({
      paths: harnessPaths({ ASHA_HOME: home }),
      root: await fixtureRoot(),
      version: 't',
      build: 't',
      pid: process.pid,
      logger,
      dependencies: { runtime, modelServer, store: new FakeStore(), ...REAL_STATE, fetch },
      heartbeatMs: 1_000,
      chatTimeoutMs: 1_000,
      schedule: new ManualSchedule().schedule,
      lifetime: TEST_LIFETIME,
      portal: await portalStub(),
    });
    await expect(started).rejects.toBe(failure);
    expect(order).toEqual(['runtime reclaim', 'sweep']);
    expect(logger.entries.filter((e) => e.level === 'error')).toEqual([
      { level: 'error', event: 'daemon.orphan_sweep_failed', fields: { error: failure } },
    ]);
    expect(logger.events()).not.toContain('daemon.started');
    // It never listened: no daemon.json; and the lock is free: the next start takes it.
    await expect(stat(join(home, 'daemon.json'))).rejects.toThrow('ENOENT');
    await expect(stat(join(home, 'daemon.lock'))).rejects.toThrow('ENOENT');
    const next = await start(home);
    expect(next.modelServer.reclaimed).toBe(1);
    await next.daemon.stop();
  });
});

describe("the start's image prune (debt-paydown-2 R1, A2)", () => {
  /** Starts a daemon whose runtime and model server record, into one list, the order of the start's steps. */
  async function orderedStart(onPrune: () => Promise<void>) {
    const home = await mkdtemp(join(tmpdir(), 'asha-prune-'));
    const order: string[] = [];
    const logger = new RecordingLogger();
    const runtime = new FakeRuntime('127.0.0.1');
    const modelServer = new FakeModelServer('http://127.0.0.1:1');
    const reclaim = runtime.reclaim.bind(runtime);
    runtime.reclaim = async () => {
      order.push('runtime reclaim');
      return reclaim();
    };
    modelServer.reclaimOrphansWith = () => {
      order.push('orphan sweep');
      return Promise.resolve(0);
    };
    runtime.onPrune = async () => {
      // The server is not listening yet: no daemon.json, no daemon.started.
      order.push(`prune (listening: ${String(logger.events().includes('daemon.started'))})`);
      await onPrune();
    };
    const daemon = await startDaemon({
      paths: harnessPaths({ ASHA_HOME: home }),
      root: await fixtureRoot(),
      version: 't',
      build: 't',
      pid: process.pid,
      logger,
      dependencies: { runtime, modelServer, store: new FakeStore(), ...REAL_STATE, fetch },
      heartbeatMs: 1_000,
      chatTimeoutMs: 1_000,
      schedule: new ManualSchedule().schedule,
      lifetime: TEST_LIFETIME,
      portal: await portalStub(),
    });
    order.push('started');
    return { daemon, order, logger, runtime };
  }

  it('runs once, after the runtime reclaim and the orphan sweep and before the server listens', async () => {
    const { daemon, order, runtime } = await orderedStart(() => Promise.resolve());
    try {
      expect(order).toEqual(['runtime reclaim', 'orphan sweep', 'prune (listening: false)', 'started']);
      expect(runtime.calls).toEqual(['reclaim', 'pruneImages']);
    } finally {
      await daemon.stop();
    }
  });

  it('a prune that throws is logged image.prune_failed at error, and the start still reaches daemon.started', async () => {
    const failure = new Error('the prune broke');
    const { daemon, order, logger } = await orderedStart(() => Promise.reject(failure));
    try {
      expect(order).toEqual(['runtime reclaim', 'orphan sweep', 'prune (listening: false)', 'started']);
      expect(logger.entries.filter((e) => e.level === 'error')).toEqual([
        { level: 'error', event: 'image.prune_failed', fields: { removed: [], error: failure } },
      ]);
      expect(logger.events()).toContain('daemon.started');
    } finally {
      await daemon.stop();
    }
  });
});
