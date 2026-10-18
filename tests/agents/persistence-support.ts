// What the agent-persistence suites read and do beside `./asha` (docs/plans/agent-persistence.md A2, A8b, A8c, A9,
// A10, A12, A17, p20-b): the daemon log, the stored generations, files inside a container by `docker exec`, and a
// daemon killed with SIGKILL at a log event. Every wait is bounded; every command has a timeout (PRINCIPLES §11).

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readStoredEntries } from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { harnessPaths } from '../../src/shared/paths.js';
import { hostLlamaServers } from './support.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;

/** Every record of the home's daemon log, in order (both runs of a restarted daemon). */
export function daemonLog(home: string): Record<string, unknown>[] {
  const file = join(home, 'logs', 'daemon.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Polls every 200 ms until `done` holds, at most `timeoutMs`; throws naming `what` past it. */
export async function waitFor<T>(
  read: () => T,
  done: (value: T) => boolean,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`not within ${String(timeoutMs)} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Runs docker against colima's socket; a non-zero exit rejects with its stderr. */
export function docker(args: readonly string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      'docker',
      [...args],
      { env: { ...process.env, DOCKER_HOST }, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`docker ${args.join(' ')}: ${stderr || error.message}`));
        else resolve(stdout);
      },
    ),
  );
}

/** The containers of this home, running or not (`docker ps -a --filter label=asha.home=<homeId>`), by name. */
export async function homeContainers(home: string): Promise<string[]> {
  const out = await docker([
    'ps',
    '-a',
    '--filter',
    `label=asha.home=${harnessPaths({ ASHA_HOME: home }).homeId}`,
    '--format',
    '{{.Names}}',
  ]);
  return out.split('\n').filter((l) => l !== '');
}

/** The docker volumes whose name carries this home's id. */
export async function homeVolumes(home: string): Promise<string[]> {
  const id = harnessPaths({ ASHA_HOME: home }).homeId;
  return (await docker(['volume', 'ls', '--format', '{{.Name}}'])).split('\n').filter((l) => l.includes(id));
}

/** An identity's state directory: `state/agents/<channel>/<team or ->/<name>`. */
export function agentDir(home: string, channel: string, team: string, name: string): string {
  return join(home, 'state', 'agents', channel, team, name);
}

/** Its `current.json`. */
export function pointer(dir: string): {
  generation: number;
  assets: Record<string, { sha256: string; files: number; bytes: number }>;
} {
  return JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')) as never;
}

/** The generations on disk (`gen-<n>`), sorted. */
export function generations(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => /^gen-\d+$/.test(n))
    .sort(byCodeUnit);
}

/** Each regular file of a stored asset's tar, by its path inside the container (`/memory/…`), with its sha256. */
export async function storedFiles(dir: string, asset: 'memory' | 'workspace'): Promise<Map<string, string>> {
  const entries = await readStoredEntries(join(dir, `gen-${String(pointer(dir).generation)}`, `${asset}.tar`), asset);
  return new Map(entries.flatMap((e) => (e.type === 'file' ? [[`/${e.name}`, e.sha256] as const] : [])));
}

/** Each regular file under `path` inside `container`, with its sha256 (`find … -exec sha256sum`). */
export async function containerFiles(container: string, path: string): Promise<Map<string, string>> {
  const out = await docker(['exec', container, 'find', path, '-type', 'f', '-exec', 'sha256sum', '{}', '+']);
  return new Map(
    out
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [sha, file] = l.split(/\s+/, 2);
        return [present(file, 'file'), present(sha, 'sha')] as const;
      }),
  );
}

/** Each file under `path` inside `container` with its owner and group (`stat -c '%u:%g %n'`). */
export async function containerOwners(container: string, path: string): Promise<Map<string, string>> {
  const out = await docker(['exec', container, 'find', path, '-exec', 'stat', '-c', '%u:%g %n', '{}', '+']);
  return new Map(
    out
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const at = l.indexOf(' ');
        return [l.slice(at + 1), l.slice(0, at)] as const;
      }),
  );
}

/** The running container of `name` on `channel` from the daemon log's newest `agent.connected` for its handle. */
export function containerFor(home: string, handle: string): string {
  const found = daemonLog(home)
    .filter((r) => r['event'] === 'agent.connected' && r['handle'] === handle)
    .at(-1);
  if (found === undefined) throw new Error(`no agent.connected for ${handle} in ${home}`);
  return String(found['container']);
}

/**
 * Kills the daemon with SIGKILL as soon as its log holds a record `at` matches (polled every 50 ms, at most
 * `timeoutMs`): its pid from the newest `daemon.started` (never from daemon.json, which holds the credential).
 */
export async function killDaemonAt(
  home: string,
  at: (r: Record<string, unknown>, all: readonly Record<string, unknown>[]) => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = daemonLog(home);
    if (log.some((r) => at(r, log))) {
      const started = present(
        log.filter((r) => r['event'] === 'daemon.started').at(-1),
        "daemon log's newest daemon.started",
      );
      const pid = Number(started['pid']);
      process.kill(pid, 'SIGKILL');
      await waitFor(
        () => isAlive(pid),
        (alive) => !alive,
        10_000,
        `daemon ${String(pid)} gone after SIGKILL`,
      );
      await stopOrphanedModelServers(home);
      return;
    }
    if (Date.now() > deadline) throw new Error(`not within ${String(timeoutMs)} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * What debt D13 leaves after a SIGKILL: the killed daemon's llama-servers survive it, each holding its model's GPU
 * memory, and the next daemon of the home starts another beside them — on this machine the restarted daemon's first
 * chat then failed `Compute error.` (p20-b, 2026-09-29). Until persistent-macos R18 sweeps them at start, the suite
 * stops exactly the servers whose command line names this home (never another's), SIGTERM, bounded at 20 s each.
 */
async function stopOrphanedModelServers(home: string): Promise<number[]> {
  const mine = hostLlamaServers().filter((p) => p.command.includes(home));
  for (const p of mine) process.kill(p.pid, 'SIGTERM');
  for (const p of mine)
    await waitFor(
      () => isAlive(p.pid),
      (alive) => !alive,
      20_000,
      `llama-server ${String(p.pid)} of ${home} gone after SIGTERM`,
    );
  return mine.map((p) => p.pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Starts the daemon alone (`./asha --server`, detached) and waits for its `daemon.started` — a restart with no
 * launch, so what its start does (the reclaim, the state checks) can be seen before anything else runs.
 */
export async function startDaemon(asha: string, home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const before = daemonLog(home).filter((r) => r['event'] === 'daemon.started').length;
  const child = spawn(asha, ['--server'], {
    env: { ...env, ...TEST_DAEMON_ENV, ASHA_HOME: home },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  await waitFor(
    () => daemonLog(home).filter((r) => r['event'] === 'daemon.started').length,
    (n) => n > before,
    60_000,
    'the restarted daemon logs daemon.started',
  );
}

/** Every file under `root` (recursively) whose bytes contain `needle`, relative to `root`. */
export function filesContaining(root: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && readFileSync(path).includes(needle)) out.push(path.slice(root.length + 1));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
