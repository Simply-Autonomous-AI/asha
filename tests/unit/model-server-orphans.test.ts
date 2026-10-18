// A killed daemon's model servers are stopped at the next start (docs/plans/debt-paydown.md R12, R13, A10; debt D13).
// LlamaCppServer.reclaimOrphans with an injected runner (the `ps` table), signaller, liveness and clock: it selects
// exactly the llama-server processes whose command names this home's absolute key file, signals nothing else,
// SIGTERMs them at once, SIGKILLs survivors at 3,000 ms, gives up at 4,000 ms, and removes the key file.

import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LlamaCppServer, type OrphanSweepProps } from '../../src/daemon/model-server/index.js';
import { CommandTimedOut, type CommandResult } from '../../src/daemon/process/index.js';
import { writePrivateFile } from '../../src/daemon/private-file/index.js';
import { harnessPaths } from '../../src/shared/paths.js';
import { FakeFetch, FakeLauncher, FakeRunner, RecordingLogger, fail, ok } from '../helpers/fakes.js';

const PS = 'ps -axww -o pid=,ppid=,command=';

/** A process table and a fake clock: each pid dies at the time its script says, or never. */
class Table implements OrphanSweepProps {
  readonly signals: { readonly pid: number; readonly signal: NodeJS.Signals; readonly at: number }[] = [];
  private t = 0;
  /** pid → when it dies, by the signal that kills it: ms after that signal; never; or 'eperm', another user's. */
  constructor(
    private readonly dies: Readonly<
      Record<number, { readonly on: NodeJS.Signals; readonly afterMs: number } | 'never' | 'eperm'>
    >,
  ) {}
  private deadAt = new Map<number, number>();
  signal = (pid: number, signal: NodeJS.Signals): void => {
    if (this.dies[pid] === 'eperm') throw Object.assign(new Error(`kill EPERM ${String(pid)}`), { code: 'EPERM' });
    this.signals.push({ pid, signal, at: this.t });
    const d = this.dies[pid];
    if (d !== undefined && d !== 'never' && d.on === signal && !this.deadAt.has(pid))
      this.deadAt.set(pid, this.t + d.afterMs);
  };
  isAlive = (pid: number): boolean => {
    const at = this.deadAt.get(pid);
    return at === undefined || at > this.t;
  };
  sleep = (ms: number): Promise<void> => {
    this.t += ms;
    return Promise.resolve();
  };
  now = (): number => this.t;
}

async function setup(
  table: string,
  dies: ConstructorParameters<typeof Table>[0],
  psResult?: CommandResult | Error | ((keyFile: string) => (CommandResult | Error)[]),
) {
  const dir = await mkdtemp(join(tmpdir(), 'asha-orphans-'));
  const keyFile = join(dir, 'model-server.key');
  await writeFile(keyFile, 'stale\n');
  const answers =
    typeof psResult === 'function'
      ? psResult(keyFile)
      : [
          psResult ??
            ok(table.replaceAll('<KEY>', keyFile).replaceAll('<RELKEY>', join(basename(dir), 'model-server.key'))),
        ];
  const runner = new FakeRunner().on(PS, ...answers);
  const logger = new RecordingLogger();
  const processes = new Table(dies);
  const server = new LlamaCppServer({
    runner,
    launcher: new FakeLauncher(),
    logger,
    fetch: new FakeFetch(() => new Response('')).fetch,
    logDir: dir,
    readyTimeoutMs: 1_000,
    keyFile,
    writeKeyFile: writePrivateFile,
    orphans: processes,
    now: () => Date.now(),
  });
  return { server, runner, logger, processes, keyFile, dir };
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    },
  );

/** One process of each kind the sweep must tell apart. */
const MIXED = [
  '  101     1 /opt/homebrew/bin/llama-server --model /m/a.gguf --port 0 --api-key-file <KEY> --jinja',
  '  102     1 /opt/homebrew/bin/llama-server --model /m/a.gguf --api-key-file /elsewhere/home/model-server.key --jinja',
  // A relative key path whose text is the absolute one's tail: what a daemon given a relative ASHA_HOME before R13 passed.
  '  103     1 llama-server --model /m/a.gguf --api-key-file <RELKEY> --jinja',
  '  104     1 llama-server --model /m/a.gguf --host 127.0.0.1 --port 18790',
  '  105     1 llama-server --model /m/a.gguf --api-key-file <KEY>2 --jinja',
  '  106     1 /usr/local/bin/node /x/stand-in.js --api-key-file <KEY>',
  '  107 95356 /bin/zsh -c echo llama-server --api-key-file <KEY>',
].join('\n');

describe('LlamaCppServer.reclaimOrphans (debt-paydown R12, A10; D13)', () => {
  it("runs ps -axww -o pid=,ppid=,command= once, bounded at 2,000 ms, and signals exactly this home's server: not another home's, a relative path, no key file, a key path with a suffix, or another program", async () => {
    const { server, runner, processes, logger, keyFile } = await setup(MIXED, { 101: { on: 'SIGTERM', afterMs: 50 } });
    expect(await server.reclaimOrphans()).toBe(1);
    expect(runner.calls.map((c) => [c.command, c.args, c.options])).toEqual([
      ['ps', ['-axww', '-o', 'pid=,ppid=,command='], { timeoutMs: 2_000 }],
    ]);
    expect(processes.signals).toEqual([{ pid: 101, signal: 'SIGTERM', at: 0 }]);
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'model_server.orphan_stopped', fields: { pid: 101, signal: 'SIGTERM', ms: 100 } },
    ]);
    expect(await exists(keyFile)).toBe(false);
  });

  it('selects a key path at the end of the command too, and SIGTERMs every orphan at once before waiting', async () => {
    const table = [
      '  201     1 llama-server --model /m/a.gguf --api-key-file <KEY> --jinja',
      '  202     1 llama-server --model /m/b.gguf --api-key-file <KEY>',
    ].join('\n');
    const { server, processes, logger } = await setup(table, {
      201: { on: 'SIGTERM', afterMs: 250 },
      202: { on: 'SIGTERM', afterMs: 120 },
    });
    expect(await server.reclaimOrphans()).toBe(2);
    expect(processes.signals).toEqual([
      { pid: 201, signal: 'SIGTERM', at: 0 },
      { pid: 202, signal: 'SIGTERM', at: 0 },
    ]);
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'model_server.orphan_stopped', fields: { pid: 202, signal: 'SIGTERM', ms: 200 } },
      { level: 'warn', event: 'model_server.orphan_stopped', fields: { pid: 201, signal: 'SIGTERM', ms: 300 } },
    ]);
  });

  it('SIGKILLs a survivor at 3,000 ms, then logs it stopped by SIGKILL', async () => {
    const { server, processes, logger } = await setup('  301 1 llama-server --api-key-file <KEY>', {
      301: { on: 'SIGKILL', afterMs: 10 },
    });
    expect(await server.reclaimOrphans()).toBe(1);
    expect(processes.signals).toEqual([
      { pid: 301, signal: 'SIGTERM', at: 0 },
      { pid: 301, signal: 'SIGKILL', at: 3_000 },
    ]);
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'model_server.orphan_stopped', fields: { pid: 301, signal: 'SIGKILL', ms: 3_100 } },
    ]);
  });

  it('logs model_server.orphan_survived at error for one still alive at 4,000 ms, and returns: the start goes on; the key file is removed', async () => {
    const { server, processes, logger, keyFile } = await setup('  401 1 llama-server --api-key-file <KEY>', {
      401: 'never',
    });
    expect(await server.reclaimOrphans()).toBe(0);
    expect(processes.signals).toEqual([
      { pid: 401, signal: 'SIGTERM', at: 0 },
      { pid: 401, signal: 'SIGKILL', at: 3_000 },
    ]);
    expect(processes.now()).toBe(4_000);
    expect(logger.entries).toEqual([
      {
        level: 'error',
        event: 'model_server.orphan_survived',
        fields: { pid: 401, error: new Error('llama-server pid 401 still alive after SIGKILL') },
      },
    ]);
    expect(await exists(keyFile)).toBe(false);
  });

  it("lists again before SIGKILL, and never sends it to a pid that is no longer this home's server (ended, its pid taken by another process)", async () => {
    // The first listing finds this home's server; the second, before SIGKILL, finds its pid held by another program.
    const { server, runner, processes, logger } = await setup('', { 501: 'never' }, (keyFile) => [
      ok(`  501 1 llama-server --api-key-file ${keyFile}`),
      ok('  501 1 /usr/bin/vim notes.txt'),
    ]);
    expect(await server.reclaimOrphans()).toBe(1);
    expect(runner.calls.map((c) => c.command)).toEqual(['ps', 'ps']);
    expect(processes.signals).toEqual([{ pid: 501, signal: 'SIGTERM', at: 0 }]);
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'model_server.orphan_stopped', fields: { pid: 501, signal: 'SIGTERM', ms: 3_000 } },
    ]);
  });

  it("logs one it may not signal (EPERM, another user's) as surviving and goes on, signalling the rest", async () => {
    const table = ['  601 1 llama-server --api-key-file <KEY>', '  602 1 llama-server --api-key-file <KEY>'].join('\n');
    const { server, processes, logger } = await setup(table, { 601: 'eperm', 602: { on: 'SIGTERM', afterMs: 10 } });
    expect(await server.reclaimOrphans()).toBe(1);
    expect(processes.signals).toEqual([{ pid: 602, signal: 'SIGTERM', at: 0 }]);
    expect(logger.entries).toEqual([
      {
        level: 'error',
        event: 'model_server.orphan_survived',
        fields: { pid: 601, error: Object.assign(new Error('kill EPERM 601'), { code: 'EPERM' }) },
      },
      { level: 'warn', event: 'model_server.orphan_stopped', fields: { pid: 602, signal: 'SIGTERM', ms: 100 } },
    ]);
  });

  it('with no orphan signals nothing, waits for nothing, logs nothing, and removes the stale key file', async () => {
    const { server, processes, logger, keyFile } = await setup(
      '  1 0 /sbin/launchd\n  104 1 llama-server --model /m/a.gguf --port 18790',
      {},
    );
    expect(await server.reclaimOrphans()).toBe(0);
    expect([processes.signals, processes.now(), logger.entries]).toEqual([[], 0, []]);
    expect(await exists(keyFile)).toBe(false);
  });

  it('a ps that fails or times out throws, signalling nothing and keeping the key file', async () => {
    for (const result of [fail(1, 'ps: illegal option'), new CommandTimedOut('ps', ['-axww'], 2_000)]) {
      const { server, processes, keyFile } = await setup(MIXED, {}, result);
      await expect(server.reclaimOrphans()).rejects.toThrow(
        result instanceof CommandTimedOut
          ? CommandTimedOut
          : /ps -axww -o pid=,ppid=,command= exited 1: ps: illegal option/,
      );
      expect(processes.signals).toEqual([]);
      expect(await exists(keyFile)).toBe(true);
    }
  });

  it('refuses a key file that is not absolute: it would not name one home', async () => {
    const { processes } = await setup('', {});
    const server = new LlamaCppServer({
      runner: new FakeRunner(),
      launcher: new FakeLauncher(),
      logger: new RecordingLogger(),
      fetch: new FakeFetch(() => new Response('')).fetch,
      logDir: '/tmp',
      readyTimeoutMs: 1,
      keyFile: 'home/model-server.key',
      writeKeyFile: writePrivateFile,
      orphans: processes,
      now: () => Date.now(),
    });
    await expect(server.reclaimOrphans()).rejects.toThrow(
      'the model server key file home/model-server.key is not an absolute path',
    );
  });
});

describe('the model server key file is an absolute path (debt-paydown R13)', () => {
  it('harnessPaths gives an absolute key path for a relative ASHA_HOME, under the resolved home', () => {
    const paths = harnessPaths({ ASHA_HOME: 'rel/home' });
    expect(paths.modelServerKey).toBe(join(resolve('rel/home'), 'model-server.key'));
    expect(paths.modelServerKey.startsWith('/')).toBe(true);
  });
});
