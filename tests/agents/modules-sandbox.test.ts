// The module sandbox on the real container runtime (docs/plans/extension-modules.md R5, R6, R7, R30, R33, R34, R38;
// A5, A28's colima cases, A30's colima cases, A38 (d)). No daemon and no model: the module host, the plugin runner and
// the runtime are composed here as the daemon composes them (compose.ts, createModuleServices), for a home id no daemon
// has, under $TMPDIR (which colima does not mount), confined (ensureReady) and reclaimed at the end. Fixture modules
// try every way out from inside their own containers on colima's `default` profile and report what each attempt got;
// the proxy's records come back through the host's log. Everything this file makes carries the home's label and is
// removed by the reclaim; the fixture module and plugin image tags it builds are removed by name.
//
// First run 2026-10-02 once colima's disk was freed: it found the proxy's start race and D53 (a module reached the VM's
// sshd at its network's gateway), both fixed; records in evals/probes/extension-modules-2026-10-01/README.md#sandbox.

import { execFile, type ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ColimaRuntime } from '../../src/daemon/container-runtime/index.js';
import type { PluginContainer, PluginSpec } from '../../src/daemon/container-runtime/index.js';
import {
  appendOpen,
  createModuleServices,
  realSetTimer,
  type InstalledModule,
  type ModuleServices,
} from '../../src/daemon/modules/index.js';
import { ExecCommandRunner } from '../../src/daemon/process/index.js';
import { SpawnInteractiveLauncher, SpawnProcessLauncher } from '../../src/daemon/process/launcher.js';
import { FileSecretStore } from '../../src/daemon/secrets/index.js';
import { present } from '../../src/shared/assert-present.js';
import { parseModuleManifest } from '../../src/shared/modules.js';
import { harnessPaths, insideGitTree, type HarnessPaths } from '../../src/shared/paths.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { fixtureSecret, pluginManifest, toolModuleManifest, writeModuleDir } from '../helpers/modules.js';
import { REPO } from './support.js';

const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;
/** The port the confinement allows agents to reach on the host, as a daemon's would be (no daemon runs here). Not 9: fetch refuses port 9 itself ("bad port"), so the attempt would never leave the module. */
const DAEMON_PORT = 51234;
const LOCK = '{"lockfileVersion":3,"packages":{"":{}}}\n';

/** `execFile`'s callback error as `run()`'s exit code: 0 for none, its numeric code, or -1 when not numeric. */
function execCode(error: ExecFileException | null): number {
  if (error === null) return 0;
  return typeof error.code === 'number' ? error.code : -1;
}

function run(command: string, args: readonly string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(
      command,
      [...args],
      { env: { ...process.env, DOCKER_HOST }, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        resolve({
          code: execCode(error),
          out: `${stdout}${stderr}`,
        });
      },
    ),
  );
}
const docker = (args: readonly string[]) => run('docker', args);
/** Polls `docker ps` for the home's running containers until each pattern names one, failing after 30 s with the list. */
async function running(patterns: readonly RegExp[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const names = (await docker(['ps', '--filter', `label=asha.home=${paths.homeId}`, '--format', '{{.Names}}'])).out
      .trim()
      .split('\n');
    if (patterns.every((p) => names.some((n) => p.test(n)))) return;
    if (Date.now() > deadline)
      throw new Error(
        `after 30 s docker lists ${JSON.stringify(names)}, not each of ${patterns.map(String).join(', ')}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The escape module: every attempt to leave by any way but its own hosts, each outcome reported. */
const ESCAPE = `
import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns/promises';
import tls from 'node:tls';
const tcp = (host, port) => new Promise((done) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); done('timeout'); }, 5000);
  s.on('connect', () => { clearTimeout(t); s.destroy(); done('open'); });
  s.on('error', (e) => { clearTimeout(t); done(e.code ?? e.message); });
});
const get = (url) => fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => 'status ' + r.status, (e) => 'refused ' + String(e.cause?.code ?? e.cause?.message ?? e.message));
const sniMismatch = (host) => new Promise((done) => {
  const s = net.connect({ host: 'asha-egress', port: 3128 });
  const t = setTimeout(() => { s.destroy(); done('timeout'); }, 8000);
  s.on('error', (e) => { clearTimeout(t); done(e.code ?? e.message); });
  s.once('connect', () => s.write('CONNECT ' + host + ':443 HTTP/1.1\\r\\nHost: ' + host + ':443\\r\\n\\r\\n'));
  s.once('data', (d) => {
    const line = d.toString().split('\\r\\n')[0];
    if (!/ 200 /.test(line)) { clearTimeout(t); s.destroy(); done('proxy ' + line); return; }
    const secure = tls.connect({ socket: s, servername: 'evil.example', rejectUnauthorized: false });
    secure.on('error', (e) => { clearTimeout(t); done('closed ' + (e.code ?? e.message)); });
    secure.on('secureConnect', () => { clearTimeout(t); done('tls-open'); });
  });
});
export async function call(tool, args) {
  if (tool !== 'probe') return { ok: false, reason: 'unknown_tool', detail: tool };
  const r = {};
  r.rawTcp = await tcp('1.1.1.1', 443);
  // A LAN-style address, 192.0.2.1:999 (TEST-NET-1, RFC 5737; debt-paydown R4, D60): unreachable because the
  // module's --internal network has no route at all, not because a rule refuses it (probe P2: ENETUNREACH).
  r.lanTcp = await tcp('192.0.2.1', 999);
  // The bridge's own address in the VM (the network's .1): its sshd, and every port the VM publishes, must be closed
  // to a module (review of 2026-10-02, B-11).
  const own = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  const gateway = own.address.split('.').slice(0, 3).join('.') + '.1';
  r.gatewaySsh = await tcp(gateway, 22);
  // IPv6 (review of D53's fix): the network is --ipv6=false, so the module's interface must carry no IPv6 at all — not
  // even link-local, by which the VM's bridge (which does hold an fe80 address) would be reachable past an IPv4 rule.
  r.ipv6Disabled = (await import('node:fs')).readFileSync('/proc/sys/net/ipv6/conf/eth0/disable_ipv6', 'utf8').trim();
  r.ipv6Addresses = String(Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv6' && !i.internal).length);
  r.dns = await dns.resolve4('example.com').then(() => 'resolved', (e) => e.code);
  r.proxyName = await dns.lookup('asha-egress').then(() => 'resolved', (e) => e.code);
  r.loopback = await get('https://127.0.0.1/');
  r.hostDaemon = await get('http://host.docker.internal:' + args.port + '/v1/health');
  r.private10 = await get('https://10.0.0.1/');
  r.colimaHost = await get('https://192.168.5.2/');
  r.sni = await sniMismatch(args.allowed);
  r.otherModule = await get('https://' + args.other + '/');
  r.otherModuleAddress = await get('https://' + args.otherAddress + '/');
  r.plainHttp = await get('http://' + args.allowed + '/');
  r.allowed = await get('https://' + args.allowed + '/');
  return { ok: true, result: r };
}
`;

let home: string;
let paths: HarnessPaths;
let logger: RecordingLogger;
let runtime: ColimaRuntime;
let services: ModuleServices;
let project: string;
const madeImages: string[] = [];
/** Each plugin container as created, inspected while it exists. */
const inspected: { name: string; inspect: Record<string, unknown> }[] = [];

function installed(raw: Record<string, unknown>, dir: string): InstalledModule {
  return { manifest: parseModuleManifest(raw, 'module.json', String(raw['id'])), dir };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'asha-agents-modules-'));
  paths = harnessPaths({ ASHA_HOME: home });
  await mkdir(paths.stagingDir, { recursive: true });
  logger = new RecordingLogger();
  const homeId = paths.homeId;
  runtime = new ColimaRuntime({
    runner: new ExecCommandRunner(),
    launcher: new SpawnProcessLauncher(),
    interactive: new SpawnInteractiveLauncher(),
    logger,
    profile: 'default',
    homeId,
    clock: () => new Date(),
  });
  await runtime.ensureReady(DAEMON_PORT);
  const modulesDir = join(home, 'modules');
  const files = { 'index.mjs': ESCAPE, 'package-lock.json': LOCK };
  const tool = (id: string, host: string) => ({
    ...toolModuleManifest({}, files),
    id,
    hosts: [host],
    secrets: ['ESCAPE_KEY'],
    tools: [
      {
        name: 'probe',
        description: 'Try to escape.',
        classes: ['egress', 'untrusted-input'],
        timeoutMs: 60_000,
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'integer', description: 'The daemon port' },
            other: { type: 'string', description: 'Another module' },
            otherAddress: { type: 'string', description: "Another module's address" },
            allowed: { type: 'string', description: 'Its host' },
          },
          required: ['port', 'other', 'otherAddress', 'allowed'],
        },
      },
    ],
  });
  const a = tool('escape_a', 'a-allowed.example');
  const b = tool('escape_b', 'b-allowed.example');
  const dirA = await writeModuleDir(a, files, modulesDir);
  const dirB = await writeModuleDir(b, files, modulesDir);
  // The fixture plugin: a shell program in a tar, installed as the installer leaves it.
  project = await mkdtemp(join(tmpdir(), 'asha-agents-project-'));
  await writeFile(join(project, 'ok.txt'), 'project text\n');
  const archiveDir = await mkdtemp(join(tmpdir(), 'asha-agents-archive-'));
  await writeFile(
    join(archiveDir, 'fixture-cli'),
    '#!/bin/sh\n# copy <src> <dst>: copies a read path to a write path; env: prints its environment\ncase "$1" in\n  copy) mkdir -p "$3" && cp "$2" "$3/copied.txt" && id -u && stat -c %u:%g "$2" ;;\n  env) env | sort; echo "secret=$PIPELINE_KEY" ;;\n  reach) NODE_USE_ENV_PROXY=1 node -e "fetch(\\"https://\\" + process.argv[1] + \\"/\\", { signal: AbortSignal.timeout(8000) }).then((r) => console.log(\\"status \\" + r.status), (e) => console.log(\\"refused \\" + (e.cause?.code ?? e.message)))" "$2" 2>/dev/null ;;\nesac\n',
    { mode: 0o755 },
  );
  const tar = join(archiveDir, 'cli.tar');
  const made = await run('tar', ['-cf', tar, '-C', archiveDir, 'fixture-cli']);
  expect(made.code, made.out).toBe(0);
  const archive = await readFile(tar);
  const sha = createHash('sha256').update(archive).digest('hex');
  const dockerfile =
    'ARG ASHA_PLUGIN_BASE\nFROM ${ASHA_PLUGIN_BASE}\nARG ASHA_ARCHIVE\nUSER root\nCOPY ${ASHA_ARCHIVE} /tmp/cli.tar\nRUN tar -xf /tmp/cli.tar -C /usr/local/bin && rm /tmp/cli.tar\nUSER 1000:1000\n';
  const plugin = pluginManifest(
    {
      hosts: ['api.pipeline.example'],
      executable: {
        ...(pluginManifest()['executable'] as Record<string, unknown>),
        archives: {
          aarch64: { url: 'https://example.test/cli.tar', sha256: sha, file: 'cli.tar' },
          x86_64: { url: 'https://example.test/cli.tar', sha256: sha, file: 'cli.tar' },
        },
      },
      commands: [
        {
          name: 'copy',
          description: 'Copy.',
          classes: ['egress'],
          timeoutMs: 60_000,
          prefix: ['copy'],
          arguments: {
            src: { type: 'path', mode: 'read', description: 'From' },
            dst: { type: 'path', mode: 'write', description: 'To' },
          },
        },
        { name: 'env', description: 'Env.', classes: ['egress'], timeoutMs: 60_000, prefix: ['env'], arguments: {} },
        {
          name: 'reach',
          description: 'Fetch a host.',
          classes: ['egress'],
          timeoutMs: 60_000,
          prefix: ['reach'],
          arguments: {
            host: { type: 'enum', values: ['api.pipeline.example', 'other.example'], description: 'The host' },
          },
        },
      ],
    },
    dockerfile,
  );
  const dirP = await writeModuleDir(plugin, { Dockerfile: dockerfile }, modulesDir);
  await writeFile(join(dirP, 'cli.tar'), archive);
  const arch = (await runtime.vmArchitecture()) as 'aarch64' | 'x86_64';
  await writeFile(
    join(dirP, '.asha-install.json'),
    JSON.stringify({ architecture: arch, archive: { file: 'cli.tar', sha256: sha } }),
  );
  const store = new FileSecretStore({
    home,
    dir: paths.secretsDir,
    logger,
    pid: process.pid,
    isAlive: () => false,
    insideGitTree,
  });
  await store.set('escape_a', 'ESCAPE_KEY', fixtureSecret('ESCAPE_A'));
  await store.set('escape_b', 'ESCAPE_KEY', fixtureSecret('ESCAPE_B'));
  await store.set('fixture_cli', 'PIPELINE_KEY', fixtureSecret('PIPELINE_KEY'));
  const installedModules = new Map([
    [
      'escape_a',
      installed(JSON.parse(await readFile(join(dirA, 'module.json'), 'utf8')) as Record<string, unknown>, dirA),
    ],
    [
      'escape_b',
      installed(JSON.parse(await readFile(join(dirB, 'module.json'), 'utf8')) as Record<string, unknown>, dirB),
    ],
    [
      'fixture_cli',
      installed(JSON.parse(await readFile(join(dirP, 'module.json'), 'utf8')) as Record<string, unknown>, dirP),
    ],
  ]);
  // The runtime as the plugin runner sees it, each plugin container inspected right after it is created.
  const watching = new Proxy(runtime, {
    get(target, key, receiver) {
      if (key !== 'pluginContainer') return Reflect.get(target, key, receiver) as unknown;
      return (spec: PluginSpec): PluginContainer => {
        const c = target.pluginContainer(spec);
        return {
          ...c,
          create: async (signal) => {
            await c.create(signal);
            const out = await docker(['inspect', spec.name]);
            inspected.push({
              name: spec.name,
              inspect: present((JSON.parse(out.out) as Record<string, unknown>[])[0], `docker inspect of ${spec.name}`),
            });
          },
        };
      };
    },
  });
  services = createModuleServices({
    runtime: watching,
    root: REPO,
    paths,
    logger,
    installed: installedModules,
    files: {
      readForPlugin: () => Promise.reject(new Error('this file names no channel path')),
      writeFromPlugin: () => Promise.reject(new Error('this file names no channel path')),
    },
    secrets: store,
    setTimer: realSetTimer,
    now: () => Date.now(),
    online: () => true,
    appendOpen,
  });
}, 1_200_000);

afterAll(async () => {
  services.host.stop();
  const reclaimed = await runtime.reclaim();
  for (const repo of ['asha-module-escape_a', 'asha-module-escape_b', 'asha-plugin-fixture_cli']) {
    const tags = await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repo]);
    for (const tag of tags.out
      .trim()
      .split('\n')
      .filter((t) => t !== ''))
      madeImages.push(tag);
  }
  const removed = await Promise.all(madeImages.map((tag) => docker(['image', 'rm', tag])));
  expect(reclaimed).toBeDefined();
  expect(removed.filter((r) => r.code !== 0).map((r) => r.out)).toEqual([]);
}, 300_000);

const never = new AbortController().signal;

describe('a module tries every way out (R5, R6; A5)', () => {
  it('fails every attempt but its own host, which reaches the proxy; the proxy refuses and logs each', async () => {
    await services.host.acquire('escape_a', 'lab');
    await services.host.acquire('escape_b', 'lab');
    // acquire returns once `docker run` is spawned; the container exists a moment later (its first call's line waits
    // in the pipe meanwhile). Wait, bounded, until docker lists both modules and the proxy.
    await running([/^asha-mod-escape_a-lab-/, /^asha-mod-escape_b-lab-/, new RegExp(`^asha-egress-${paths.homeId}$`)]);
    const containerB = (
      await docker([
        'ps',
        '--filter',
        `label=asha.home=${paths.homeId}`,
        '--filter',
        'label=asha.module=escape_b',
        '--format',
        '{{.Names}}',
      ])
    ).out.trim();
    const addressB = (
      await docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', containerB])
    ).out.trim();
    expect(addressB).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const outcome = await services.host.call({
      module: 'escape_a',
      channel: 'lab',
      tool: 'probe',
      arguments: { port: DAEMON_PORT, other: containerB, otherAddress: addressB, allowed: 'a-allowed.example' },
      timeoutMs: 60_000,
      consequential: false,
      abandon: never,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const r = (outcome as { result: Record<string, string> }).result;
    // No route out: the internal network has none, and no outside name resolves; the proxy's own name does.
    expect(r['rawTcp']).toMatch(/ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|timeout/);
    expect(r['lanTcp']).toMatch(/ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|timeout/);
    // Nor the VM's sshd by the bridge's address (B-11): a reject answers ECONNREFUSED; 'open' is the VM reached.
    expect(r['gatewaySsh']).toMatch(/ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|timeout/);
    expect([r['ipv6Disabled'], r['ipv6Addresses']]).toEqual(['1', '0']);
    expect(r['dns']).not.toBe('resolved');
    expect(r['proxyName']).toBe('resolved');
    // Through the proxy: every target off the list refused, plain http refused, the SNI mismatch cut.
    for (const key of [
      'loopback',
      'hostDaemon',
      'private10',
      'colimaHost',
      'otherModule',
      'otherModuleAddress',
      'plainHttp',
    ])
      expect({ key, got: r[key] }).toEqual({ key, got: expect.stringMatching(/^refused /) as string });
    expect(r['sni']).toMatch(/^closed /);
    // The allowlisted host reached the proxy (offline: it ends without a connection), logged with the module and host.
    expect(r['allowed']).toMatch(/^refused /);
    const refusals = logger.entries
      .filter((e) => e.event === 'egress.refused')
      .map((e) => [e.fields['module'], e.fields['host'], e.fields['rule']]);
    // Every attempt through the proxy, refused, each logged with the module, the host and the rule, in the order made.
    // Node's fetch tunnels plain http through CONNECT too (undici), so plain http is refused by its port (80, not 443);
    // another module's container name holds `_`, no host name, so it is a bad request.
    expect(refusals).toEqual([
      ['escape_a', '127.0.0.1', 'not_allowed'],
      ['escape_a', 'host.docker.internal', 'port'],
      ['escape_a', '10.0.0.1', 'not_allowed'],
      ['escape_a', '192.168.5.2', 'not_allowed'],
      ['escape_a', 'a-allowed.example', 'sni_mismatch'],
      ['escape_a', `${containerB}:443`, 'bad_request'],
      ['escape_a', addressB, 'not_allowed'],
      ['escape_a', 'a-allowed.example', 'port'],
    ]);
    // The proxy logs the allowed host's connection only once it has ended (resolved, or failed to): after it destroyed
    // the module's socket, on its own stdout, a pipe the module's answer does not wait for — so the record may reach the
    // logger after the call returns (the gate at f158f6f read it before it came, 2026-10-03; patterns-phase-5's gate).
    // Waited for, bounded: 30 s, past the resolver's own retries.
    const connections = () =>
      logger.entries.filter((e) => e.event === 'egress.connection').map((e) => [e.fields['module'], e.fields['host']]);
    const deadline = Date.now() + 30_000;
    while (!connections().some(([m, h]) => m === 'escape_a' && h === 'a-allowed.example') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connections()).toContainEqual(['escape_a', 'a-allowed.example']);
  }, 300_000);

  it("refuses module A, on its own network, an entry only module B's list allows", async () => {
    const outcome = await services.host.call({
      module: 'escape_a',
      channel: 'lab',
      tool: 'probe',
      arguments: {
        port: DAEMON_PORT,
        other: 'b-allowed.example',
        otherAddress: '172.16.0.1',
        allowed: 'a-allowed.example',
      },
      timeoutMs: 60_000,
      consequential: false,
      abandon: never,
    });
    expect((outcome as { result: Record<string, string> }).result['otherModule']).toMatch(/^refused /);
    expect(
      logger.entries.filter((e) => e.event === 'egress.refused').map((e) => [e.fields['module'], e.fields['host']]),
    ).toContainEqual(['escape_a', 'b-allowed.example']);
  }, 300_000);

  it('runs each module and the proxy with every limit, read-only, labelled, with only its own secret', async () => {
    const names = (await docker(['ps', '--filter', `label=asha.home=${paths.homeId}`, '--format', '{{.Names}}'])).out
      .trim()
      .split('\n');
    const failures = logger.entries
      .filter((e) => e.level === 'error')
      .map((e) => [
        e.event,
        (e.fields['module'] as string | undefined) ?? '',
        (e.fields['error'] as Error | undefined)?.message ?? '',
      ]);
    expect({ names, failures }).toMatchObject({
      names: expect.arrayContaining([
        expect.stringMatching(/^asha-mod-escape_a-/),
        expect.stringMatching(/^asha-mod-escape_b-/),
        `asha-egress-${paths.homeId}`,
      ]) as string[],
    });
    // Each module network's bridge is asham + 10 hex, under the asha+ jumps (D53).
    const networks = (
      await docker([
        'network',
        'ls',
        '--filter',
        `label=asha.home=${paths.homeId}`,
        '--filter',
        'label=asha.module',
        '--format',
        '{{.Name}}',
      ])
    ).out
      .trim()
      .split('\n');
    for (const network of networks) {
      const bridge = (
        await docker(['network', 'inspect', '--format', '{{index .Options "com.docker.network.bridge.name"}}', network])
      ).out.trim();
      expect({ network, bridge }).toEqual({ network, bridge: expect.stringMatching(/^asham[0-9a-f]{10}$/) as string });
    }
    for (const name of names) {
      const inspect = present(
        (
          JSON.parse((await docker(['inspect', name])).out) as {
            HostConfig: Record<string, unknown>;
            Config: { Env: string[]; Labels: Record<string, string> };
          }[]
        )[0],
        `docker inspect of ${name}`,
      );
      expect({
        name,
        capDrop: inspect.HostConfig['CapDrop'],
        securityOpt: inspect.HostConfig['SecurityOpt'],
        pids: inspect.HostConfig['PidsLimit'],
        memory: inspect.HostConfig['Memory'],
        cpus: inspect.HostConfig['NanoCpus'],
        readOnly: inspect.HostConfig['ReadonlyRootfs'],
        home: inspect.Config.Labels['asha.home'],
      }).toEqual({
        name,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges'],
        pids: 256,
        memory: 512 * 1024 * 1024,
        cpus: 1_000_000_000,
        readOnly: true,
        home: paths.homeId,
      });
      const env = inspect.Config.Env.join('\n');
      if (name.includes('escape_a'))
        expect([env.includes(fixtureSecret('ESCAPE_A')), env.includes(fixtureSecret('ESCAPE_B'))]).toEqual([
          true,
          false,
        ]);
      if (name.includes('escape_b'))
        expect([env.includes(fixtureSecret('ESCAPE_A')), env.includes(fixtureSecret('ESCAPE_B'))]).toEqual([
          false,
          true,
        ]);
      if (name.startsWith('asha-egress-')) expect(env.includes('fixture-secret')).toBe(false);
    }
    const rules = await run('colima', ['ssh', '--', 'sudo', 'iptables', '-S'], 60_000);
    expect(rules.out).toContain(`asha:${paths.homeId}`);
    expect(rules.out).toContain(`ashae${paths.homeId}`);
  }, 300_000);
});

describe('a command plugin call on colima (R30, R33; A28, A30)', () => {
  it('copies a root file in owned 1000:1000 with no mount, writes the write path back, and removes its container', async () => {
    const out = await mkdtemp(join(tmpdir(), 'asha-agents-rw-'));
    await services.host.acquire('fixture_cli', 'lab');
    const plugin = present(services.installed.get('fixture_cli'), 'the installed fixture_cli plugin');
    const command = (plugin.manifest as unknown as { commands: { name: string }[] }).commands.find(
      (c) => c.name === 'copy',
    ) as never;
    const outcome = await services.plugins.call({
      agent: 'ops-1',
      channel: 'lab',
      plugin,
      command,
      arguments: { src: '/roots/project/ok.txt', dst: '/roots/rw/out' },
      roots: [
        { name: 'project', host: project, mode: 'read' },
        { name: 'rw', host: out, mode: 'read-write' },
      ],
      consequential: false,
      abandon: never,
    });
    expect(outcome).toEqual({ ok: true, result: { exit_code: 0, stdout: '1000\n1000:1000\n', stderr: '' } });
    expect(await readFile(join(out, 'out', 'copied.txt'), 'utf8')).toBe('project text\n');
    const created = present(inspected.at(-1), 'the last inspected plugin container');
    expect((created.inspect as { Mounts: unknown[] }).Mounts).toEqual([]);
    expect((created.inspect as { HostConfig: { Memory: number } }).HostConfig.Memory).toBe(1024 * 1024 * 1024);
    expect((await docker(['ps', '-a', '--filter', `name=${created.name}`, '--format', '{{.Names}}'])).out.trim()).toBe(
      '',
    );
  }, 300_000);

  it("sets the secret on that one command's container, redacts it from the result, and runs a second call in another container", async () => {
    const plugin = present(services.installed.get('fixture_cli'), 'the installed fixture_cli plugin');
    const command = (plugin.manifest as unknown as { commands: { name: string }[] }).commands.find(
      (c) => c.name === 'env',
    ) as never;
    const call = () =>
      services.plugins.call({
        agent: 'ops-1',
        channel: 'lab',
        plugin,
        command,
        arguments: {},
        roots: [],
        consequential: false,
        abandon: never,
      });
    const first = await call();
    const second = await call();
    for (const outcome of [first, second]) {
      const stdout = (outcome as { result: { stdout: string } }).result.stdout;
      expect(stdout).toContain('secret=[redacted]');
      expect(stdout).toContain('CLI_CONFIG_FILE=/dev/null');
      expect(stdout).not.toContain(fixtureSecret('PIPELINE_KEY'));
    }
    const [a, b] = inspected.slice(-2);
    expect(present(a, 'the second-to-last inspected container').name).not.toBe(
      present(b, 'the last inspected container').name,
    );
    expect(JSON.stringify(logger.entries)).not.toContain(fixtureSecret('PIPELINE_KEY'));
  }, 300_000);
});

describe("a command plugin reaches its declared endpoint and no other (R27, R6; A25's colima half)", () => {
  it('its CONNECT to the declared host reaches the proxy (offline: resolve_failed); one to any other host is refused not_allowed', async () => {
    const plugin = present(services.installed.get('fixture_cli'), 'the installed fixture_cli plugin');
    const command = (plugin.manifest as unknown as { commands: { name: string }[] }).commands.find(
      (c) => c.name === 'reach',
    ) as never;
    const reach = (host: string) =>
      services.plugins.call({
        agent: 'ops-1',
        channel: 'lab',
        plugin,
        command,
        arguments: { host },
        roots: [],
        consequential: false,
        abandon: never,
      });
    const before = logger.entries.length;
    const declared = await reach('api.pipeline.example');
    const other = await reach('other.example');
    expect(
      [declared, other].map((o) => (o as { result: { exit_code: number; stdout: string } }).result.stdout.trim()),
    ).toEqual([expect.stringMatching(/^refused /), expect.stringMatching(/^refused /)]);
    const records = logger.entries
      .slice(before)
      .filter((e) => e.event === 'egress.connection' || e.event === 'egress.refused')
      .map((e) => [e.event, e.fields['module'], e.fields['host'], e.fields['rule'] ?? e.fields['outcome']]);
    expect(records).toEqual([
      ['egress.connection', 'fixture_cli', 'api.pipeline.example', 'resolve_failed'],
      ['egress.refused', 'fixture_cli', 'other.example', 'not_allowed'],
    ]);
  }, 300_000);
});

describe('the reclaim with module objects (R5, R34; A38 (d))', () => {
  it('removes 16 module containers and networks, the cost against an empty reclaim within 3,000 ms (amended 2026-10-02 from 1,500 ms: P7 and this suite measured the removal by Docker itself at 2.4–2.6 s), and leaves nothing labelled', async () => {
    const empty: number[] = [];
    const full: number[] = [];
    for (let trial = 0; trial < 2; trial += 1) {
      for (let channel = 0; channel < 16; channel += 1)
        await services.host.acquire('escape_b', `r${String(trial)}c${String(channel)}`);
      const t0 = Date.now();
      await runtime.reclaim();
      full.push(Date.now() - t0);
      // The host's own bookkeeping is reset by a new services object in the daemon; here the slots are released.
      for (let channel = 0; channel < 16; channel += 1)
        await services.host.release('escape_b', `r${String(trial)}c${String(channel)}`);
      await runtime.ensureReady(DAEMON_PORT);
      const t1 = Date.now();
      await runtime.reclaim();
      empty.push(Date.now() - t1);
      await runtime.ensureReady(DAEMON_PORT);
    }
    // The figures, in the run's log whatever the outcome (§13).
    process.stderr.write(
      `A38 (d) reclaim ms: with 16 module containers and networks ${JSON.stringify(full)}, without ${JSON.stringify(empty)}\n`,
    );
    for (let i = 0; i < 2; i += 1)
      expect(
        {
          trial: i,
          added: present(full[i], `full[${String(i)}]`) - present(empty[i], `empty[${String(i)}]`) <= 3_000,
        },
        JSON.stringify({ full, empty }),
      ).toEqual({
        trial: i,
        added: true,
      });
    await runtime.reclaim();
    expect(
      (await docker(['ps', '-a', '--filter', `label=asha.home=${paths.homeId}`, '--format', '{{.Names}}'])).out.trim(),
    ).toBe('');
    expect(
      (
        await docker(['network', 'ls', '--filter', `label=asha.home=${paths.homeId}`, '--format', '{{.Name}}'])
      ).out.trim(),
    ).toBe('');
    const rules = await run('colima', ['ssh', '--', 'sudo', 'iptables', '-S'], 60_000);
    expect(rules.out).not.toContain(`asha:${paths.homeId}`);
    await runtime.ensureReady(DAEMON_PORT);
  }, 1_200_000);
});
