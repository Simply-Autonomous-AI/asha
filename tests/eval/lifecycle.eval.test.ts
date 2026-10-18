// The daemon's lifecycle, end to end through ./asha (docs/plans/debt-paydown.md, docs/plans/idle-shutdown.md):
// - idle-shutdown R5: a daemon killed with SIGKILL takes its llama-server with it, within 10 s, through the watch the
//   server runs under; the next start finds nothing to sweep.
// - A11 (R12, R13; D13): a llama-server whose watch and daemon were both killed outright outlives them; the next
//   daemon of that home stops it before it listens, logging model_server.orphan_stopped naming it and no other pid.
// - A13 (R14–R16; D21): while a daemon stops, --status says "stopping (pid …)", a second --stop waits for it and says
//   "stopped (pid …)", and a launch started meanwhile says it waits, then starts a new daemon.
// Each scenario has a home of its own; the model cache is shared, as every eval's is. Only processes this test made
// are ever signalled: the daemon whose pid its own home's daemon.json names (checked to be an asha daemon), the watch
// over its server (checked to be one), and — in the teardown, only if the sweep failed — a llama-server or a watch
// whose command names its own home's key file.

import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { WATCH_SHELL } from '../../src/daemon/process/launcher.js';
import { present } from '../../src/shared/assert-present.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const ASHA = join(REPO, 'asha');
const MODELS = process.env['ASHA_MODELS_DIR'] || join(homedir(), '.simplyautonomous', 'harness', 'models');

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const homes: string[] = [];
async function newHome(name: string): Promise<{ readonly home: string; readonly env: NodeJS.ProcessEnv }> {
  const home = join(await mkdtemp(join(tmpdir(), `asha-eval-${name}-`)), 'home');
  homes.push(home);
  return { home, env: { ...process.env, ...TEST_DAEMON_ENV, ASHA_HOME: home, ASHA_MODELS_DIR: MODELS } };
}

function asha(env: NodeJS.ProcessEnv, args: readonly string[], timeoutMs: number): Promise<Run> {
  return new Promise((done, fail) => {
    execFile(ASHA, [...args], { env, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error?.killed) {
        fail(
          new Error(`asha ${args.join(' ')} exceeded ${String(timeoutMs)} ms\nstdout: ${stdout}\nstderr: ${stderr}`),
        );
      } else if (error && typeof error.code !== 'number') {
        const rejection: Error = error;
        fail(rejection);
      } else done({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

/** ./asha started in the background: its output so far, and its end. */
function background(env: NodeJS.ProcessEnv, args: readonly string[], timeoutMs: number) {
  const child = spawn(ASHA, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c: Buffer) => (out.stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (out.stderr += c.toString()));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const ended = new Promise<Run>((done, fail) => {
    child.once('error', fail);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === null)
        fail(new Error(`asha ${args.join(' ')} was killed (bound ${String(timeoutMs)} ms)\nstderr: ${out.stderr}`));
      else done({ code, ...out });
    });
  });
  return { out, ended };
}

function records(home: string): Record<string, unknown>[] {
  return readFileSync(join(home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

/** A live process's command line (ps), or null when no process holds the pid. */
function commandOf(pid: number): Promise<string | null> {
  return new Promise((done, fail) =>
    execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 2_000 }, (error, stdout, stderr) => {
      if (error === null) done(stdout.trim());
      else if (error.code === 1 && stdout === '' && stderr === '') done(null);
      else fail(new Error(`ps -p ${String(pid)}: ${stderr}`));
    }),
  );
}

/** Polls `check` every 100 ms until it holds, at most `ms`; throws naming `what` past it. */
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  if (!Number.isFinite(ms)) throw new Error(`${what}: the bound ${String(ms)} is not a number`);
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${String(ms)} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The llama-servers left behind, by pid and home: killed in the teardown only if a sweep under test failed. */
const orphans: { pid: number; keyFile: string }[] = [];

afterAll(async () => {
  for (const home of homes)
    await asha({ ...process.env, ...TEST_DAEMON_ENV, ASHA_HOME: home, ASHA_MODELS_DIR: MODELS }, ['--stop'], 120_000);
  for (const { pid, keyFile } of orphans) {
    const command = await commandOf(pid);
    if (command !== null && command.includes(` --api-key-file ${keyFile}`)) process.kill(pid, 'SIGKILL');
  }
}, 300_000);

/**
 * The newest model_server.ready in `home`'s log, its two pids checked: llama-server's own (`pid`, its command naming
 * the home's key file) and the watch it runs under (`watchPid`, WATCH_SHELL running asha-watch). Each is put on the
 * teardown's list, kept only if its command still names this home's key file.
 */
async function servedPids(home: string): Promise<{ readonly server: number; readonly watch: number }> {
  const keyFile = join(home, 'model-server.key');
  const ready = records(home).filter((r) => r['event'] === 'model_server.ready');
  // The model hello-world's recipe names, read from it: the recipe is the whole agent.
  const recipe = JSON.parse(readFileSync(join(REPO, 'recipes', 'hello-world.json'), 'utf8')) as { model: string };
  expect(ready.map((r) => r['model']).at(-1)).toBe(recipe.model);
  const record = present(ready.at(-1), 'the last model_server.ready');
  const server = Number(record['pid']);
  const watch = Number(record['watchPid']);
  for (const pid of [server, watch])
    expect(Number.isInteger(pid) && pid > 0, `model_server.ready ${JSON.stringify(record)}`).toBe(true);
  orphans.push({ pid: server, keyFile }, { pid: watch, keyFile });
  const serverCommand = await commandOf(server);
  expect(serverCommand).toMatch(/^\S*llama-server --model /);
  expect(serverCommand).toContain(` --api-key-file ${keyFile} `);
  const watchCommand = await commandOf(watch);
  expect(watchCommand?.startsWith(`${WATCH_SHELL} -c `), String(watchCommand)).toBe(true);
  expect(watchCommand).toContain(' asha-watch llama-server --model ');
  return { server, watch };
}

/** The pid of the daemon `home` started, checked to be an asha daemon. */
async function daemonOf(home: string): Promise<number> {
  const daemon = (JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }).pid;
  expect(await commandOf(daemon)).toMatch(/\/dist\/src\/cli\/main\.js --server$/);
  return daemon;
}

describe("a killed daemon's model server ends with it, and the next start sweeps one whose watch died too (idle-shutdown R5; debt-paydown R12, R13, A11; D13)", () => {
  it('SIGKILL to the daemon ends its llama-server within 10 s; with the watch killed first, the server outlives both and the next daemon stops it before it listens, naming it alone', async () => {
    const { home, env } = await newHome('orphan');
    const launched = await asha(env, ['--launch', 'recipe=hello-world'], 600_000);
    expect(launched.code, launched.stderr).toBe(0);
    const first = await servedPids(home);

    // R5: the daemon killed as a crash would; its watch sees the pipe end and stops the server.
    const daemon = await daemonOf(home);
    const killedAt = Date.now();
    process.kill(daemon, 'SIGKILL');
    await until(() => !alive(daemon), 10_000, `daemon ${String(daemon)} gone after SIGKILL`);
    await until(
      () => !alive(first.server),
      Math.max(0, killedAt + 10_000 - Date.now()),
      `llama-server ${String(first.server)} gone within 10,000 ms of its daemon's SIGKILL`,
    );
    await until(() => !alive(first.watch), 2_000, `watch ${String(first.watch)} gone after its server`);

    // Nothing left for the next start's sweep: it stops no process.
    const again = await asha(env, ['--launch', 'recipe=hello-world'], 600_000);
    expect(again.code, again.stderr).toBe(0);
    expect(records(home).filter((r) => r['event'] === 'model_server.orphan_stopped')).toEqual([]);
    const second = await servedPids(home);

    // The sweep's case: the watch killed outright first, so nothing stops the server when its daemon dies.
    process.kill(second.watch, 'SIGKILL');
    await until(() => !alive(second.watch), 10_000, `watch ${String(second.watch)} gone after SIGKILL`);
    const daemon2 = await daemonOf(home);
    process.kill(daemon2, 'SIGKILL');
    await until(() => !alive(daemon2), 10_000, `daemon ${String(daemon2)} gone after SIGKILL`);
    // The premise: its server outlived both.
    expect(alive(second.server), `llama-server ${String(second.server)} after its watch and daemon were killed`).toBe(
      true,
    );

    const third = await asha(env, ['--launch', 'recipe=hello-world'], 600_000);
    expect(third.code, third.stderr).toBe(0);
    const log = records(home);
    const started = log.filter((r) => r['event'] === 'daemon.started');
    expect(started).toHaveLength(3);
    // The log's time field is ts.
    const thirdStarted = present(started[2], 'started[2]');
    const startedAt = Date.parse(String(thirdStarted['ts']));
    expect(Number.isFinite(startedAt), `daemon.started ts ${String(thirdStarted['ts'])}`).toBe(true);
    await until(
      () => !alive(second.server),
      Math.max(0, startedAt + 15_000 - Date.now()),
      `llama-server ${String(second.server)} gone within 15,000 ms of the new daemon.started`,
    );
    const stopped = log.filter((r) => r['event'] === 'model_server.orphan_stopped');
    expect(stopped.map((r) => r['pid'])).toEqual([second.server]);
    // Stopped before the new daemon listened, so well inside the bound.
    expect(Date.parse(String(present(stopped[0], 'stopped[0]')['ts'])) <= startedAt + 15_000).toBe(true);
    expect(
      log.filter((r) => r['event'] === 'model_server.orphan_survived' || r['event'] === 'daemon.orphan_sweep_failed'),
    ).toEqual([]);
    orphans.length = 0;
  }, 1_800_000);
});

describe('the CLI sees a stopping daemon (debt-paydown R14–R16, A13; D21)', () => {
  it('--status says stopping, a second --stop waits and says stopped, and a launch meanwhile waits, then starts a new daemon', async () => {
    const { home, env } = await newHome('stopping');
    const launched = await asha(env, ['--launch', 'team=suite-files', 'channel=lab'], 600_000);
    expect(launched.code, launched.stderr).toBe(0);
    const [firstLine] = launched.stdout.trim().split('\n');
    const a = present(firstLine, 'launched.stdout first line');
    const daemon = (JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number }).pid;

    // A turn in progress for 15 s, so the stop drains it.
    const turn = background(env, ['--verbose', 'channel=lab', `to=${a}`, 'user=alice', 'message=wait 15'], 120_000);
    await until(() => turn.out.stderr.includes(`› alice → ${a} on lab: wait 15`), 30_000, 'the wait posted');
    const firstStop = background(env, ['--stop'], 120_000);

    const stopping: Run[] = [];
    await until(
      async () => {
        const status = await asha(env, ['--status'], 30_000);
        stopping.push(status);
        return status.stdout === `stopping (pid ${String(daemon)})\n`;
      },
      10_000,
      '--status says stopping',
    );
    expect(present(stopping.at(-1), 'stopping.at(-1)').code).toBe(1);

    const launch = background(env, ['--launch', 'team=suite-files', 'channel=lab'], 600_000);
    const secondStop = await asha(env, ['--stop'], 120_000);
    expect([secondStop.code, secondStop.stdout, secondStop.stderr]).toEqual([
      0,
      `stopped (pid ${String(daemon)})\n`,
      '',
    ]);
    expect(alive(daemon)).toBe(false);
    expect((await firstStop.ended).code).toBe(0);

    const relaunched = await launch.ended;
    expect(relaunched.code, relaunched.stderr).toBe(0);
    expect(relaunched.stderr.split('\n')[0]).toBe(
      `⚠ the asha daemon (pid ${String(daemon)}) is stopping; waiting for it to stop`,
    );
    const started = records(home).filter((r) => r['event'] === 'daemon.started');
    expect(started.map((r) => r['pid'] === daemon)).toEqual([true, false]);
    await turn.ended;
  }, 1_200_000);
});

describe('a daemon told to leave when it has nothing to do does (idle-shutdown R3, A3)', () => {
  it('asha --server with ASHA_IDLE_EXIT_MS of 3 s and nothing to do stops itself and exits 0, its stop logged with source idle', async () => {
    const { home, env } = await newHome('idle');
    const started = Date.now();
    const server = background({ ...env, ASHA_IDLE_EXIT_MS: '3000' }, ['--server'], 120_000);
    const ended = await server.ended;
    expect(ended.code, ended.stderr).toBe(0);
    const log = records(home);
    const requested = log.filter((r) => r['event'] === 'daemon.stop_requested');
    expect(requested.map((r) => r['source'])).toEqual(['idle']);
    expect(Number(present(requested[0], 'the stop request')['idleMs'])).toBeGreaterThanOrEqual(3_000);
    expect(log.map((r) => r['event'])).toContain('daemon.stopped');
    // Its start, 3 s with nothing to do, at most one more check of 3 s, then the stop's own work.
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 180_000);
});
