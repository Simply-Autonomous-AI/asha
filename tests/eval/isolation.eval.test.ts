// The eval of container confinement and secrets (docs/plans/control-api-auth.md
// A6, A10, A14), end to end through ./asha on colima's `default` profile: two
// daemons on two fresh homes (sharing the model cache), each with a memory
// agent — so each serves the chat and the embedding model — started at once.
//
// From inside each agent container it connects to its own daemon's port, the
// other daemon's port, a listener nothing allows, and both of its daemon's
// llama-servers; a control container on Docker's default bridge proves the
// listener was listening. It also looks for the credential and the model
// server key everywhere a container could hold them, then exercises the rule
// lifecycle: rules deleted by hand come back at the next launch, a restart
// reclaims a stale rule and leaves another home's alone, concurrent launches
// leave exactly one allow, and a stop removes the home's rules and network
// while the shared jump, chain and rejects stay.
//
// The VM is shared with other daemons and other containers: this file only
// touches rules tagged with its own homes' ids, plus one rule tagged with a
// made-up id that it adds and removes itself.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const ASHA = join(REPO, 'asha');
const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;
const MODELS = process.env['ASHA_MODELS_DIR'] || join(homedir(), '.simplyautonomous', 'harness', 'models');
/** A home id no daemon has: its rule must survive every other home's changes. */
const MADE_UP = 'f00dface';

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Home {
  readonly dir: string;
  readonly id: string;
  readonly env: NodeJS.ProcessEnv;
}

function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs: number },
): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        env: options.env ?? process.env,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(
            new Error(
              `${command} ${args.join(' ')} exceeded ${String(options.timeoutMs)} ms\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
          return;
        }
        if (error && typeof error.code !== 'number') {
          const rejection: Error = error;
          reject(rejection);
          return;
        }
        resolveRun({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
    child.stdin?.end(options.input ?? '');
  });
}

const asha = (home: Home, args: string[], timeoutMs: number) => run(ASHA, args, { env: home.env, timeoutMs });
const docker = (args: string[], input?: string) =>
  run('docker', args, {
    env: { ...process.env, DOCKER_HOST },
    timeoutMs: 120_000,
    ...(input === undefined ? {} : { input }),
  });

/** A command as root in the colima VM; fails the test on a non-zero exit. */
async function vm(command: string): Promise<string> {
  const result = await run('colima', ['ssh', '--profile', 'default', '--', 'sudo', 'sh', '-c', command], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) throw new Error(`colima ssh: ${command}: exit ${String(result.code)}\n${result.stderr}`);
  return result.stdout;
}

const rules = async (): Promise<string[]> => (await vm('iptables -S')).trim().split('\n');
const tagged = (all: readonly string[], id: string) =>
  all.filter((r) => r.startsWith('-A ASHA-AGENTS ') && r.includes(`--comment "asha:${id}"`));
const allow = (id: string, port: number) =>
  `-A ASHA-AGENTS -d 192.168.5.2/32 -i asha${id} -p tcp -m tcp --dport ${String(port)} -m comment --comment "asha:${id}" -j RETURN`;
/** agent-tools R14: right after its allow, each home rejects everything else arriving from its bridge. */
const homeReject = (id: string) =>
  `-A ASHA-AGENTS -i asha${id} -m comment --comment "asha:${id}" -j REJECT --reject-with icmp-port-unreachable`;
/** A home's tagged rules, in order: the allow, then the reject. */
const homeRules = (id: string, port: number) => [allow(id, port), homeReject(id)];
const SHARED = [
  '-A ASHA-AGENTS -d 192.168.5.2/32 -i asha+ -p tcp -j REJECT --reject-with tcp-reset',
  '-A ASHA-AGENTS -d 192.168.5.2/32 -i asha+ -j REJECT --reject-with icmp-port-unreachable',
];
const JUMP = '-A DOCKER-USER -i asha+ -j ASHA-AGENTS';
/** agent-tools R14: traffic to the VM itself (INPUT) passes through the same chain. */
const INPUT_JUMP = '-A INPUT -i asha+ -j ASHA-AGENTS';

async function logRecords(home: Home): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(home.dir, 'logs', 'daemon.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function daemonFile(home: Home): Promise<{ pid: number; port: number; credential: string }> {
  return JSON.parse(await readFile(join(home.dir, 'daemon.json'), 'utf8')) as {
    pid: number;
    port: number;
    credential: string;
  };
}

/** The ports of the llama-servers this home's daemon started, by model (from `model_server.ready`). */
async function modelPorts(home: Home): Promise<Record<string, number>> {
  const ready = (await logRecords(home)).filter((r) => r['event'] === 'model_server.ready');
  return Object.fromEntries(ready.map((r) => [String(r['model']), Number(new URL(String(r['baseUrl'])).port)]));
}

/** The containers this home's daemon started, in order (from `agent.starting`). */
async function containers(home: Home): Promise<string[]> {
  return (await logRecords(home)).filter((r) => r['event'] === 'agent.starting').map((r) => String(r['container']));
}

/**
 * Run inside a container: connects to host.docker.internal on each named port
 * with a 2 s connect timeout, then checks its names. In an agent container
 * (argv[2] "agent", debt-paydown R3, D18): `dns` is lookup('host.docker.internal')
 * giving 192.168.5.2 (from /etc/hosts), and `external` is resolve4('example.com'),
 * which must fail ESERVFAIL — no outside name resolves. In the control
 * ("control"): `dns` is resolve4('host.docker.internal') through Docker's DNS.
 * Prints {name: "open" | error code | "timeout", dns: "ok" | error code | address, external?: error code | "resolved"}.
 */
const PROBE = `
const net = require('net');
const targets = JSON.parse(process.argv[1]);
const connect = (port) => new Promise((done) => {
  const socket = net.connect({ host: 'host.docker.internal', port });
  const timer = setTimeout(() => { socket.destroy(); done('timeout'); }, 2000);
  socket.on('connect', () => { clearTimeout(timer); socket.end(); done('open'); });
  socket.on('error', (error) => { clearTimeout(timer); done(error.code); });
});
(async () => {
  const out = {};
  for (const [name, port] of Object.entries(targets)) out[name] = await connect(port);
  const dns = require('dns').promises;
  if (process.argv[2] === 'agent') {
    out.dns = await dns.lookup('host.docker.internal').then((r) => (r.address === '192.168.5.2' ? 'ok' : r.address), (e) => e.code);
    out.external = await dns.resolve4('example.com').then(() => 'resolved', (e) => e.code);
  } else if (process.argv[2] === 'control') {
    out.dns = await dns.resolve4('host.docker.internal').then((a) => (a.length > 0 ? 'ok' : 'empty'), (e) => e.code);
  } else throw new Error('mode: ' + process.argv[2]);
  console.log(JSON.stringify(out));
})();
`;

async function probe(container: string, targets: Record<string, number>): Promise<Record<string, string>> {
  const result = await docker(['exec', container, 'node', '-e', PROBE, JSON.stringify(targets), 'agent']);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

let a: Home;
let b: Home;
let listener: Server;
let listenerPort: number;
let accepted = 0;

async function newHome(): Promise<Home> {
  const dir = await mkdtemp(join(tmpdir(), 'asha-iso-'));
  return {
    dir,
    id: createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 8),
    env: { ...process.env, ...TEST_DAEMON_ENV, ASHA_HOME: dir, ASHA_MODELS_DIR: MODELS },
  };
}

beforeAll(async () => {
  a = await newHome();
  b = await newHome();
  listener = createServer((socket) => {
    accepted += 1;
    socket.end();
  });
  await new Promise<void>((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
  listenerPort = (listener.address() as { port: number }).port;
});

afterAll(async () => {
  // Always leave nothing running and nothing of this file's in the VM, even when a test failed.
  await asha(a, ['--stop'], 120_000);
  await asha(b, ['--stop'], 120_000);
  const left = tagged(await rules(), MADE_UP);
  for (const rule of left) await vm(`iptables -D ${rule.slice(3)}`);
  await new Promise((resolveClose) => listener.close(resolveClose));
});

describe('containers reach only their own daemon, and never hold a secret', () => {
  it('two daemons on two homes each bring a memory agent online, at once', async () => {
    const [one, two] = await Promise.all([
      asha(a, ['--launch', 'recipe=memory'], 900_000),
      asha(b, ['--launch', 'recipe=memory'], 900_000),
    ]);
    expect([one.code, one.stdout], one.stderr).toEqual([0, 'memo-1\n']);
    expect([two.code, two.stdout], two.stderr).toEqual([0, 'memo-1\n']);
    expect(a.id).not.toBe(b.id);
  });

  it('each agent container reaches its own daemon port and nothing else on the host loopback; DNS still answers (A10)', async () => {
    const [portA, portB] = [(await daemonFile(a)).port, (await daemonFile(b)).port];
    for (const [home, own, other] of [
      [a, portA, portB],
      [b, portB, portA],
    ] as const) {
      const models = await modelPorts(home);
      expect(Object.keys(models).sort(byCodeUnit)).toEqual(['qwen3-8b-q4_k_m', 'qwen3-embedding-0.6b-q8_0']);
      const [container] = await containers(home);
      const seen = await probe(present(container, 'containers(home)[0]'), {
        own,
        other,
        listener: listenerPort,
        chat: present(models['qwen3-8b-q4_k_m'], 'models["qwen3-8b-q4_k_m"]'),
        embedding: present(models['qwen3-embedding-0.6b-q8_0'], 'models["qwen3-embedding-0.6b-q8_0"]'),
      });
      expect(seen).toEqual({
        own: 'open',
        other: 'ECONNREFUSED',
        listener: 'ECONNREFUSED',
        chat: 'ECONNREFUSED',
        embedding: 'ECONNREFUSED',
        dns: 'ok',
        external: 'ESERVFAIL',
      });
    }
    expect(accepted).toBe(0);

    // The control: a container on Docker's default bridge, which no asha rule matches, reaches the listener.
    // The exact image the agents run: each build has its own tag, `asha-image-memory:<source digest>` (D23).
    const image = String(
      present(
        (await logRecords(a)).find((r) => r['event'] === 'agent.starting'),
        'agent.starting log record',
      )['tag'],
    );
    expect(image).toMatch(/^asha-image-memory:[0-9a-f]{64}$/);
    const control = await docker([
      'run',
      '--rm',
      '--network',
      'bridge',
      '--entrypoint',
      'node',
      image,
      '-e',
      PROBE,
      JSON.stringify({ listener: listenerPort }),
      'control',
    ]);
    expect(control.code, control.stderr).toBe(0);
    expect(JSON.parse(control.stdout)).toEqual({ listener: 'open', dns: 'ok' });
    expect(accepted).toBe(1);
  });

  it('no container holds the credential or the model server key, and both are refused without them (A6)', async () => {
    const { port, credential } = await daemonFile(a);
    const key = (await readFile(join(a.dir, 'model-server.key'), 'utf8')).trim();
    expect(credential).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const container = present((await containers(a))[0], 'containers(a)[0]');

    const inspect = await docker(['inspect', container]);
    const env = await docker(['exec', container, 'env']);
    const cmdline = await docker(['exec', container, 'cat', '/proc/1/cmdline']);
    for (const [what, result] of [
      ['docker inspect', inspect],
      ['env', env],
      ['/proc/1/cmdline', cmdline],
    ] as const) {
      expect(result.code, `${what}: ${result.stderr}`).toBe(0);
      expect(result.stdout.length, what).toBeGreaterThan(0);
      expect(result.stdout.includes(credential), `${what} holds the credential`).toBe(false);
      expect(result.stdout.includes(key), `${what} holds the model server key`).toBe(false);
    }
    // Every regular file outside /proc, /sys and /dev, read as root; the secrets arrive on stdin, never in an argument.
    // (node:22-alpine's BusyBox grep has no --exclude-dir and exits 2 on the image's dangling symlinks, so the scan is node.)
    const SCAN = `
      const fs = require('fs'); const path = require('path');
      const secrets = fs.readFileSync(0, 'utf8').trim().split('\\n');
      const out = { scanned: 0, matches: [], errors: [] };
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (['/proc', '/sys', '/dev'].includes(file)) continue;
          if (entry.isDirectory()) walk(file);
          else if (entry.isFile()) {
            try { const text = fs.readFileSync(file, 'latin1'); out.scanned += 1; if (secrets.some((s) => text.includes(s))) out.matches.push(file); }
            catch (error) { out.errors.push(file + ': ' + error.code); }
          }
        }
      };
      walk('/');
      console.log(JSON.stringify(out));`;
    const scan = await docker(['exec', '-i', '-u', 'root', container, 'node', '-e', SCAN], `${credential}\n${key}\n`);
    expect(scan.code, scan.stderr).toBe(0);
    const found = JSON.parse(scan.stdout) as { scanned: number; matches: string[]; errors: string[] };
    expect(found.matches).toEqual([]);
    expect(found.errors).toEqual([]);
    expect(found.scanned).toBeGreaterThan(1_000);

    // From inside the container: the control API, as the container addresses the host (403, R7), and with the
    // host's own Host header, which a container can forge (401: it has no credential).
    const REQUEST = `
      const http = require('http');
      const ask = (host) => new Promise((done) => {
        const req = http.request({ host: 'host.docker.internal', port: ${String(port)}, method: 'POST', path: '/v1/conversations', headers: host ? { host } : {} }, (res) => { res.resume(); done(res.statusCode); });
        req.on('error', (e) => done(e.code));
        req.end('{"channel":"main","message":"hi"}');
      });
      (async () => console.log(JSON.stringify([await ask(undefined), await ask('127.0.0.1:${String(port)}')])))();`;
    const asked = await docker(['exec', container, 'node', '-e', REQUEST]);
    expect(asked.code, asked.stderr).toBe(0);
    expect(JSON.parse(asked.stdout)).toEqual([403, 401]);

    // From the host, llama-server refuses a completion without the key (R10 already stops a container reaching it).
    const models = await modelPorts(a);
    const chatPort = present(models['qwen3-8b-q4_k_m'], 'models["qwen3-8b-q4_k_m"]');
    const completion = await fetch(`http://127.0.0.1:${String(chatPort)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(completion.status).toBe(401);
  });

  it('rules deleted by hand are reinstalled at the next launch, and the new container is confined (A10)', async () => {
    const port = (await daemonFile(a)).port;
    const mine = tagged(await rules(), a.id);
    expect(mine).toEqual(homeRules(a.id, port));
    for (const rule of mine) await vm(`iptables -D ${rule.slice(3)}`);
    expect(tagged(await rules(), a.id)).toEqual([]);

    const launched = await asha(a, ['--launch', 'recipe=memory', 'channel=second'], 300_000);
    expect(launched.code, launched.stderr).toBe(0);

    expect(tagged(await rules(), a.id)).toEqual(homeRules(a.id, port));
    const newest = present((await containers(a)).at(-1), 'containers(a).at(-1)');
    expect(await probe(newest, { own: port, listener: listenerPort })).toEqual({
      own: 'open',
      listener: 'ECONNREFUSED',
      dns: 'ok',
      external: 'ESERVFAIL',
    });
  });

  it('concurrent launches on one daemon leave exactly one allow and one reject for it, above the shared rejects, with the jumps first (A10; agent-tools R14)', async () => {
    const [one, two] = await Promise.all([
      asha(b, ['--launch', 'recipe=memory', 'channel=c1'], 300_000),
      asha(b, ['--launch', 'recipe=memory', 'channel=c2'], 300_000),
    ]);
    expect([one.code, two.code], `${one.stderr}\n${two.stderr}`).toEqual([0, 0]);

    const all = await rules();
    expect(tagged(all, b.id)).toEqual(homeRules(b.id, (await daemonFile(b)).port));
    const chain = all.filter((r) => r.startsWith('-A ASHA-AGENTS '));
    expect(chain.slice(-2)).toEqual(SHARED);
    expect(chain.indexOf(allow(b.id, (await daemonFile(b)).port))).toBeLessThan(chain.length - 2);
    expect(all.find((r) => r.startsWith('-A DOCKER-USER '))).toBe(JUMP);
    expect(all.filter((r) => r === JUMP)).toHaveLength(1);
    expect(all.find((r) => r.startsWith('-A INPUT '))).toBe(INPUT_JUMP);
    expect(all.filter((r) => r === INPUT_JUMP)).toHaveLength(1);
  });

  it('confining a warm launch costs at most 1 s (A14)', async () => {
    for (const home of [a, b]) {
      const ready = (await logRecords(home)).filter((r) => r['event'] === 'agent.isolation_ready');
      expect(ready.length).toBeGreaterThanOrEqual(2);
      // The first launch of a daemon creates its network; every later one is warm.
      const warm = ready.slice(1).map((r) => Number(r['durationMs']));
      expect(warm.filter((ms) => !(ms >= 0 && ms <= 1_000))).toEqual([]);
    }
  });

  it("a restart reclaims the home's stale rule and leaves another home's rule alone (A10)", async () => {
    const stopped = await asha(a, ['--stop'], 120_000);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(tagged(await rules(), a.id)).toEqual([]);
    // A stale allow of this home, as a killed daemon would leave, and another (made-up) home's allow.
    await vm(
      `iptables -I ASHA-AGENTS 1 -i asha${a.id} -d 192.168.5.2/32 -p tcp --dport 9 -m comment --comment asha:${a.id} -j RETURN`,
    );
    await vm(
      `iptables -I ASHA-AGENTS 1 -i asha${MADE_UP} -d 192.168.5.2/32 -p tcp --dport 9 -m comment --comment asha:${MADE_UP} -j RETURN`,
    );

    const relaunched = await asha(a, ['--launch', 'recipe=memory'], 600_000);
    expect(relaunched.code, relaunched.stderr).toBe(0);

    const all = await rules();
    expect(tagged(all, a.id)).toEqual(homeRules(a.id, (await daemonFile(a)).port));
    expect(tagged(all, MADE_UP)).toEqual([allow(MADE_UP, 9)]);
    const reclaimed = present(
      (await logRecords(a)).filter((r) => r['event'] === 'isolation.reclaimed').at(-1),
      'isolation.reclaimed log record',
    );
    expect(reclaimed['rules']).toBe(1);
    await vm(`iptables -D ${allow(MADE_UP, 9).slice(3)}`);
  });

  it('stopping both daemons removes their rules and networks; the jump, the chain and the shared rejects remain (A10)', async () => {
    for (const home of [a, b]) {
      const stopped = await asha(home, ['--stop'], 120_000);
      expect(stopped.code, stopped.stderr).toBe(0);
    }
    const all = await rules();
    expect(tagged(all, a.id)).toEqual([]);
    expect(tagged(all, b.id)).toEqual([]);
    expect(all).toContain(JUMP);
    expect(all).toContain(INPUT_JUMP);
    expect(all).toContain('-N ASHA-AGENTS');
    for (const reject of SHARED) expect(all).toContain(reject);
    const networks = await docker(['network', 'ls', '--format', '{{.Name}}']);
    expect(networks.code).toBe(0);
    expect(networks.stdout.split('\n')).not.toContain(`asha-${a.id}`);
    expect(networks.stdout.split('\n')).not.toContain(`asha-${b.id}`);
    for (const home of [a, b]) {
      const problems = (await logRecords(home)).filter((r) => r['level'] === 'error');
      expect(problems).toEqual([]);
    }
  });
});
