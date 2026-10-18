// The container runtime's extension-module operations (docs/plans/extension-modules.md R5, R6 (a), (d), R28, R30,
// R34, R38): the commands ColimaRuntime runs, exactly, and the VM scripts run for real against a fake iptables.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  ColimaRuntime,
  EGRESS_REJECTED,
  egressRulesScript,
  installScript,
  MODULE_LOCAL_REJECT,
  reclaimScript,
  removeHomeNetworks,
} from '../../src/daemon/container-runtime/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { DOCKER_TABLE, FakeVm, warmFakeCommands } from '../helpers/fake-iptables.js';
import {
  FakeInteractive,
  FakeLauncher,
  FakeRunner,
  LockingRunner,
  RecordingLogger,
  fail,
  ok,
} from '../helpers/fakes.js';

const HOME_ID = 'abcd1234';
const BRIDGE = `ashae${HOME_ID}`;
const SOCKET = 'unix:///Users/u/.colima/default/docker.sock';
const STATUS = JSON.stringify({ runtime: 'docker', docker_socket: SOCKET });

function runtimeWith(runner: FakeRunner) {
  const interactive = new FakeInteractive();
  const logger = new RecordingLogger();
  const runtime = new ColimaRuntime({
    runner,
    launcher: new FakeLauncher(),
    interactive,
    logger,
    profile: 'default',
    homeId: HOME_ID,
    clock: () => new Date('2026-10-01T00:00:00Z'),
  });
  return { runtime, interactive, logger };
}

/** A runtime whose colima is running (ensureRunning has read the docker socket), with nothing confined. */
async function running(runner: FakeRunner) {
  runner.on('colima version', ok('0.10.1')).on('docker --version', ok()).on('colima status', ok(STATUS));
  const made = runtimeWith(runner);
  await made.runtime.ensureRunning();
  runner.calls.length = 0;
  return made;
}

describe('ensureRunning (R28): colima up, nothing confined', () => {
  it('runs only the probes and the status: no network, no rule', async () => {
    const runner = new FakeRunner()
      .on('colima version', ok('0.10.1'))
      .on('docker --version', ok())
      .on('colima status', ok(STATUS));
    const { runtime } = runtimeWith(runner);
    await expect(runtime.ensureRunning()).resolves.toBe('ready');
    expect(runner.lines()).toEqual(['colima version', 'docker --version', 'colima status --profile default --json']);
  });
});

describe('the VM and the engine (R6 (a), R28)', () => {
  it('reads uname -m in the VM and the engine version', async () => {
    const runner = new FakeRunner().on('colima ssh', ok('aarch64\n')).on('docker version', ok('29.2.1\n'));
    const { runtime } = await running(runner);
    await expect(runtime.vmArchitecture()).resolves.toBe('aarch64');
    await expect(runtime.engineVersion()).resolves.toBe('29.2.1');
    expect(runner.lines()).toEqual([
      'colima ssh --profile default -- uname -m',
      'docker version --format {{.Server.Version}}',
    ]);
  });

  it('refuses an architecture line that is not one', async () => {
    const runner = new FakeRunner().on('colima ssh', ok('aarch64; rm -rf /\n'));
    const { runtime } = await running(runner);
    await expect(runtime.vmArchitecture()).rejects.toThrow('not an architecture');
  });
});

describe('networks (R5, R6)', () => {
  it("creates a module's network internal and labelled with the home, and the egress bridge named", async () => {
    const runner = new FakeRunner().on('docker network create', ok('id\n'));
    const { runtime } = await running(runner);
    await runtime.createNetwork({
      name: 'asha-m-abcd1234-0011aabb',
      internal: true,
      labels: { 'asha.module': 'tavily', 'asha.channel': 'lab' },
    });
    await runtime.createNetwork({ name: `asha-egress-${HOME_ID}`, internal: false, bridge: BRIDGE, labels: {} });
    expect(runner.lines()).toEqual([
      'docker network create --driver bridge --internal --ipv6=false --label asha.home=abcd1234 --label asha.module=tavily --label asha.channel=lab asha-m-abcd1234-0011aabb',
      `docker network create --driver bridge --opt com.docker.network.bridge.name=${BRIDGE} --ipv6=false --label asha.home=abcd1234 asha-egress-${HOME_ID}`,
    ]);
    expect(runner.calls.every((c) => c.options.env?.['DOCKER_HOST'] === SOCKET)).toBe(true);
  });

  it('refuses a bridge name that is not an asha bridge', async () => {
    const { runtime } = await running(new FakeRunner());
    await expect(runtime.createNetwork({ name: 'n', internal: false, bridge: 'eth0', labels: {} })).rejects.toThrow(
      'not an asha bridge name',
    );
    // A module bridge is asham + exactly 10 hex (D53); 9, 11 or another letter is refused.
    for (const bridge of ['asham012345678', 'asham0123456789a', 'ashamg123456789', 'ashax0123456789'])
      await expect(runtime.createNetwork({ name: 'n', internal: true, bridge, labels: {} })).rejects.toThrow(
        'not an asha bridge name',
      );
  });

  it('creates a module network internal with its bridge named asham + 10 hex, so the asha+ jumps reach it (D53)', async () => {
    const runner = new FakeRunner().on('docker network create', ok('id\n'));
    const { runtime } = await running(runner);
    await runtime.createNetwork({
      name: 'asha-m-abcd1234-tavily-lab',
      internal: true,
      bridge: 'asham0123456789',
      labels: { 'asha.module': 'tavily' },
    });
    expect(runner.lines()).toEqual([
      'docker network create --driver bridge --internal --opt com.docker.network.bridge.name=asham0123456789 --ipv6=false --label asha.home=abcd1234 --label asha.module=tavily asha-m-abcd1234-tavily-lab',
    ]);
  });

  it('connects the proxy with its alias and reads its address on that network; a network already gone is not a failure to remove', async () => {
    const runner = new FakeRunner()
      .on('docker network connect', ok())
      .on(
        'docker inspect',
        ok(JSON.stringify({ 'asha-m-1': { IPAddress: '172.30.0.3' }, other: { IPAddress: '172.31.0.2' } })),
      )
      .on('docker network rm', fail(1, 'Error response from daemon: network asha-m-1 not found'));
    const { runtime } = await running(runner);
    await expect(runtime.connectNetwork('asha-m-1', 'asha-egress-abcd1234', 'asha-egress')).resolves.toBe('172.30.0.3');
    await expect(runtime.removeNetwork('asha-m-1')).resolves.toBeUndefined();
    expect(runner.lines().slice(0, 2)).toEqual([
      'docker network connect --alias asha-egress asha-m-1 asha-egress-abcd1234',
      'docker inspect --format {{json .NetworkSettings.Networks}} asha-egress-abcd1234',
    ]);
  });
});

describe('attached containers (R5, R34)', () => {
  it('runs a module with every limit, read-only with a 64 MiB /tmp, its secrets passed by name only', async () => {
    const { runtime, interactive } = await running(new FakeRunner());
    runtime.runAttached({
      name: 'asha-mod-x',
      image: 'img:1',
      network: 'asha-m-1',
      env: { SEARCH_KEY: 'value-never-in-argv' },
      labels: { 'asha.module': 'x' },
      onStdout: () => undefined,
      onStderrLine: () => undefined,
    });
    const launched = present(interactive.launched[0], 'interactive.launched[0]');
    expect([launched.command, ...launched.args].join(' ')).toBe(
      'docker run --pull never --interactive --rm --name asha-mod-x --network asha-m-1 --label asha.home=abcd1234 --label asha.module=x --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m -e SEARCH_KEY img:1',
    );
    expect(launched.args.join(' ')).not.toContain('value-never-in-argv');
    expect(launched.options.env).toEqual({ SEARCH_KEY: 'value-never-in-argv', DOCKER_HOST: SOCKET });
  });
});

describe('plugin containers (R30, R33)', () => {
  it('creates one with every limit and 1g of memory, on its network, the executable its entrypoint, never a mount', async () => {
    const runner = new FakeRunner().on('docker create', ok());
    const { runtime } = await running(runner);
    const plugin = runtime.pluginContainer({
      name: 'asha-plugin-1',
      image: 'p:1',
      network: 'asha-m-2',
      entrypoint: 'fixture-cli',
      args: ['pipeline', 'get-state', '--name', 'x'],
      env: { PIPELINE_KEY: 'k' },
      labels: {},
    });
    await plugin.create(new AbortController().signal);
    expect(runner.lines()[0]).toBe(
      'docker create --pull never --name asha-plugin-1 --network asha-m-2 --label asha.home=abcd1234 --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --cpus 1 --memory 1g -e PIPELINE_KEY -e HTTPS_PROXY=http://asha-egress:3128 -e HTTP_PROXY=http://asha-egress:3128 --entrypoint fixture-cli p:1 pipeline get-state --name x',
    );
    expect(runner.lines()[0]).not.toMatch(/ -v | --mount /);
  });

  it('refuses a container variable the docker CLI or the harness uses (PATH, DYLD_*, DOCKER_*, *_PROXY), running nothing (review H1)', async () => {
    const runner = new FakeRunner().on('docker create', ok());
    const { runtime } = await running(runner);
    for (const name of ['PATH', 'DYLD_INSERT_LIBRARIES', 'DOCKER_CONFIG', 'HTTPS_PROXY', 'HOME']) {
      const plugin = runtime.pluginContainer({
        name: 'asha-plugin-1',
        image: 'p:1',
        network: 'asha-m-2',
        entrypoint: 'x',
        args: [],
        env: { [name]: '/evil' },
        labels: {},
      });
      await expect(plugin.create(new AbortController().signal)).rejects.toThrow(
        `a container's variables may not include ${name}`,
      );
    }
    expect(() =>
      runtime.runAttached({
        name: 'm',
        image: 'i',
        network: 'n',
        env: { LD_PRELOAD: 'x' },
        labels: {},
        onStdout: () => undefined,
        onStderrLine: () => undefined,
      }),
    ).toThrow('may not include LD_PRELOAD');
    expect(runner.lines()).toEqual([]);
  });

  it('keeps at most maxBytes of each stream, and counts every byte', async () => {
    const runner = new FakeRunner().on('docker start --attach', {
      code: 3,
      stdout: 'x'.repeat(100),
      stderr: 'e'.repeat(50),
    });
    const { runtime } = await running(runner);
    const run = await runtime
      .pluginContainer({ name: 'p', image: 'i', network: 'n', entrypoint: 'e', args: [], env: {}, labels: {} })
      .run(1_000, 40, new AbortController().signal);
    expect(run).toEqual({
      kind: 'exited',
      code: 3,
      stdout: Buffer.from('x'.repeat(40)),
      stderr: Buffer.from('e'.repeat(40)),
      stdoutBytes: 100,
      stderrBytes: 50,
    });
  });
});

describe('build arguments (R28, E3)', () => {
  it('passes each build argument to docker build', async () => {
    // Inspected, then again under the tag's build lock (debt-paydown R18), then built.
    const runner = new LockingRunner()
      .on(
        'docker image inspect',
        fail(1, 'Error: No such image'),
        fail(1, 'Error: No such image'),
        ok('{"asha.source":"sha256:' + 'c'.repeat(64) + '"}'),
      )
      .on('docker build', ok());
    const { runtime } = await running(runner);
    await runtime.ensureImage({
      repository: 'asha-plugin-x',
      contextDir: '/ctx',
      sourceDigest: `sha256:${'c'.repeat(64)}`,
      labels: {},
      buildArgs: { ASHA_ARCHIVE: 'cli.tar', ASHA_PLUGIN_BASE: 'asha-image-plugin-base:1' },
    });
    expect(runner.lines()[3]).toBe(
      `docker build --network=none --label asha.source=sha256:${'c'.repeat(64)} --build-arg ASHA_ARCHIVE=cli.tar --build-arg ASHA_PLUGIN_BASE=asha-image-plugin-base:1 --tag asha-plugin-x:${'c'.repeat(64)} /ctx`,
    );
  });
});

// Each test runs the real rule scripts through a fake VM of shell processes: 2–3.6 s alone (2026-10-02), so vitest's
// 5 s default left too little room, and under the whole unit run's load one passed it twice (portal's build). The
// bound is a guard, set well above the slowest run (PRINCIPLES §14.5); the assertions are unchanged.
describe('egress rules in the VM (R6 (d), A5)', { timeout: 20_000 }, () => {
  // The fakes' first runs, macOS's assessment of each new executable, here rather than in a test.
  beforeAll(warmFakeCommands, 60_000);

  const rules = (vm: FakeVm) => vm.chain('ASHA-AGENTS');

  it('inserts every reject from the egress bridge, tagged with the home, once; verify passes', async () => {
    const vm = await FakeVm.create(DOCKER_TABLE);
    expect((await vm.run(installScript(HOME_ID, 51234))).code).toBe(0);
    const first = await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'install'));
    expect([first.code, first.stdout.trim()]).toEqual([
      0,
      `asha-egress: ready inserted=${String(EGRESS_REJECTED.length + 1)}`,
    ]);
    const second = await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'install'));
    expect(second.stdout.trim()).toBe('asha-egress: ready inserted=0');
    const egress = (await rules(vm)).filter((r) => r.startsWith(`-i ${BRIDGE} `));
    expect(egress.toSorted(byCodeUnit)).toEqual(
      EGRESS_REJECTED.map((cidr) => `-i ${BRIDGE} -d ${cidr} -m comment --comment asha:${HOME_ID} -j REJECT`).sort(
        byCodeUnit,
      ),
    );
    // D53: every module bridge's traffic to the VM's own addresses (its gateway, the VM's sshd) rejected, once, shared by every home.
    expect((await rules(vm)).filter((r) => r.startsWith('-i asham+ '))).toEqual([MODULE_LOCAL_REJECT]);
    expect(MODULE_LOCAL_REJECT).toBe('-i asham+ -m addrtype --dst-type LOCAL -j REJECT');
    expect((await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'verify'))).code).toBe(0);
    // The shared rejects stay the chain's last two rules, as agent-tools R14's layout has them and the isolation eval
    // asserts (the gate at c6b98fc found the module reject appended after them).
    const chain = await rules(vm);
    expect(chain.slice(-2).map((r) => r.replace(/ --reject-with icmp-port-unreachable$/, ''))).toEqual([
      '-i asha+ -d 192.168.5.2/32 -p tcp -j REJECT --reject-with tcp-reset',
      '-i asha+ -d 192.168.5.2/32 -j REJECT',
    ]);
    // A second home installs no second copy.
    const other = await vm.run(egressRulesScript('ffff0000', 'ashaeffff0000', 'install'));
    expect([other.code, other.stdout.trim()]).toEqual([
      0,
      `asha-egress: ready inserted=${String(EGRESS_REJECTED.length)}`,
    ]);
    expect((await rules(vm)).filter((r) => r.startsWith('-i asham+ '))).toHaveLength(1);
  });

  it("verify fails, naming it, when the module bridges' reject of the VM's own addresses is deleted (D53)", async () => {
    const vm = await FakeVm.create(DOCKER_TABLE);
    await vm.run(installScript(HOME_ID, 51234));
    await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'install'));
    await vm.run(`iptables -w -D ASHA-AGENTS ${MODULE_LOCAL_REJECT}`);
    const verify = await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'verify'));
    expect([verify.code, verify.stderr.trim().split('\n').at(-1)]).toEqual([
      5,
      "asha-egress: verify: the reject of the VM's own addresses from module bridges (asham+) is missing",
    ]);
  });

  it('verify fails, naming the reject, when one is deleted', async () => {
    const vm = await FakeVm.create(DOCKER_TABLE);
    await vm.run(installScript(HOME_ID, 51234));
    await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'install'));
    await vm.run(
      `iptables -w -D ASHA-AGENTS -i ${BRIDGE} -d 100.64.0.0/10 -m comment --comment asha:${HOME_ID} -j REJECT`,
    );
    const verify = await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'verify'));
    expect([verify.code, verify.stderr.trim().split('\n').at(-1)]).toEqual([
      5,
      `asha-egress: verify: the reject of 100.64.0.0/10 from ${BRIDGE} is missing`,
    ]);
  });

  it("refuses to run before an agent's confinement exists (no chain), and refuses another home's bridge", async () => {
    const vm = await FakeVm.create(DOCKER_TABLE);
    const run = await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'install'));
    expect([run.code, run.stderr.trim()]).toEqual([
      5,
      "asha-egress: the chain ASHA-AGENTS is missing: an agent's confinement must be in place first",
    ]);
    expect(() => egressRulesScript(HOME_ID, 'ashaeffffffff', 'install')).toThrow("not this home's egress bridge");
  });

  it("an agent's next confinement keeps the egress rejects; the reclaim removes them with the agent rules", async () => {
    const vm = await FakeVm.create(DOCKER_TABLE);
    await vm.run(installScript(HOME_ID, 51234));
    await vm.run(egressRulesScript(HOME_ID, BRIDGE, 'install'));
    const again = await vm.run(installScript(HOME_ID, 51234));
    expect([again.code, again.stdout.trim()]).toEqual([
      0,
      'asha-isolation: ready jump_fixed=0 input_jump_fixed=0 home_rules_replaced=0',
    ]);
    expect((await rules(vm)).filter((r) => r.startsWith(`-i ${BRIDGE} `))).toHaveLength(EGRESS_REJECTED.length);
    // The reclaim, with a docker that lists nothing.
    await vm.addCommand('docker', '#!/bin/sh\nexit 0\n');
    const reclaimed = await vm.run(reclaimScript(HOME_ID));
    expect([reclaimed.code, reclaimed.stdout.trim()]).toEqual([
      0,
      `asha-isolation: reclaimed rules=${String(2 + EGRESS_REJECTED.length)} containers=0 network=0 volumes=0 networks=0`,
    ]);
    expect((await rules(vm)).filter((r) => r.includes(`asha:${HOME_ID}`))).toEqual([]);
    // The shared reject stays: another home's modules may be running (D53).
    expect((await rules(vm)).filter((r) => r.startsWith('-i asham+ '))).toEqual([MODULE_LOCAL_REJECT]);
  });
});

describe("the reclaim's removal of the home network (R1-DESIGN-002)", () => {
  it('a home-network listing that fails fails the reclaim, never read as no network', async () => {
    const vm = await FakeVm.create(DOCKER_TABLE);
    await vm.run(installScript(HOME_ID, 51234));
    await vm.addCommand(
      'docker',
      `#!/bin/sh
case "$*" in *"name=^asha-${HOME_ID}$"*) echo 'Cannot connect to the Docker daemon' >&2; exit 1 ;; esac
exit 0
`,
    );
    const reclaimed = await vm.run(reclaimScript(HOME_ID));
    expect([reclaimed.code === 0, reclaimed.stdout.trim(), reclaimed.stderr.trim()]).toEqual([
      false,
      '',
      'Cannot connect to the Docker daemon',
    ]);
  });
});

describe("the reclaim's sweep of the home's labelled networks (R5, M2)", () => {
  async function sweep(present: readonly string[], rm: 'ok' | 'busy') {
    const dir = await mkdtemp(join(tmpdir(), 'asha-net-sweep-'));
    const vm = await FakeVm.create(DOCKER_TABLE);
    await vm.addCommand(
      'docker',
      `#!/bin/sh
echo "$*" >> ${join(dir, 'log')}
if [ "$1 $2" = "network ls" ]; then printf '%s\\n' ${present.map((n) => `'${n}'`).join(' ')}; exit 0; fi
if [ "$1 $2" = "network rm" ]; then shift 2; ${rm === 'ok' ? 'printf "%s\\n" "$@"; exit 0' : 'echo "Error response from daemon: error while removing network: network $1 has active endpoints" >&2; exit 1'}; fi
exit 2
`,
    );
    const run = await vm.run(`set -eu\n${removeHomeNetworks(HOME_ID)}echo "networks=$removed_networks"\n`);
    const { readFile } = await import('node:fs/promises');
    return { ...run, docker: (await readFile(join(dir, 'log'), 'utf8')).trim().split('\n') };
  }

  it('removes each labelled network and reports networks=2', async () => {
    const r = await sweep(['asha-m-1', `asha-egress-${HOME_ID}`], 'ok');
    expect([r.code, r.stdout]).toEqual([0, 'networks=2\n']);
    // One `docker network rm` naming them all (P7).
    expect(r.docker).toEqual([
      `network ls --quiet --filter label=asha.home=${HOME_ID}`,
      `network rm asha-m-1 asha-egress-${HOME_ID}`,
    ]);
  });

  it('a network that cannot be removed fails the sweep, naming it', async () => {
    const r = await sweep(['asha-m-1'], 'busy');
    expect(r.code).toBe(6);
    expect(r.stderr.trim()).toBe(
      'asha-isolation: reclaim: networks could not be removed: Error response from daemon: error while removing network: network asha-m-1 has active endpoints',
    );
  });

  it('runs after the containers and the volumes in the reclaim', () => {
    const script = reclaimScript(HOME_ID);
    const containers = script.indexOf('containers=$(');
    const volumes = script.indexOf('volumes=$(docker volume ls');
    const networks = script.indexOf('labelled_networks=$(docker network ls --quiet --filter label=asha.home=');
    expect(containers).toBeGreaterThan(0);
    expect(volumes).toBeGreaterThan(containers);
    expect(networks).toBeGreaterThan(volumes);
  });
});
