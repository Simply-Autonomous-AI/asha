// Egress (docs/plans/agent-tools.md R14, A11): from inside a real agent
// container, started by ./asha on colima's `default` profile, a connection to
// anything but the daemon's port fails — the internet, the colima VM itself
// (its gateway on the agent's own bridge and its address on the host
// network), a LAN address and another host port. The daemon's port
// is reached. The control needs no network (Objective 1: the gate needs the
// network only to fill cold caches): a peer this test starts inside the VM — a
// host-network container listening on the VM's own addresses — and a listener
// on the host are reached by a control container on Docker's default bridge,
// which no asha rule matches, and refused to the agent, so those refusals are
// the rules' doing and not an absent peer. Every refusal is the REJECT's
// answer, ECONNREFUSED at once — never a timeout. The internet and LAN probes
// are refusal checks only, which need no network. The LAN probe's address is
// 192.0.2.1:999, in TEST-NET-1 (RFC 5737, reserved for documentation): the
// home's REJECT answers it inside the VM, so the answer is the same on any
// network the Mac is on (debt-paydown R4, D60; probe P2).
//
// DNS (debt-paydown R2, D18): from the same agent container no outside name
// resolves — resolve4 of example.com and of host.docker.internal each fail with
// ESERVFAIL, since the container's resolver forwards from its own namespace to
// 192.0.2.1, which the home's REJECT refuses — while host.docker.internal comes
// from /etc/hosts (lookup gives 192.168.5.2). The control: a container of the
// same image on the same home network with none of those flags, which resolves
// host.docker.internal by DNS (the VM's own resolver answers it; no network needed). A query sent straight to a
// resolver outside the container — 1.1.1.1, the VM's 192.168.5.1, the bridge gateway — gets no answer over UDP
// (refused or timed out, as probe P1 saw) and is refused over TCP port 53 (the completion review's finding 5).

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { agentSuite, containerOf, type AgentSuite } from './support.js';

const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;

/** Connects to each {name: [host, port]} with a 3 s bound; prints {name: "open" | error code | "timeout"}. */
const PROBE = `
const net = require('net');
const targets = JSON.parse(process.argv[1]);
const connect = ([host, port]) => new Promise((done) => {
  const socket = net.connect({ host, port });
  const timer = setTimeout(() => { socket.destroy(); done('timeout'); }, 3000);
  socket.on('connect', () => { clearTimeout(timer); socket.end(); done('open'); });
  socket.on('error', (error) => { clearTimeout(timer); done(error.code); });
});
(async () => {
  const out = {};
  for (const [name, target] of Object.entries(targets)) out[name] = await connect(target);
  console.log(JSON.stringify(out));
})();
`;

/** Each DNS check from inside a container: {name: address(es) | error code}, and resolv.conf's lines. */
const DNS_PROBE = `
const dns = require('dns');
const fs = require('fs');
const settle = (p) => p.then((ok) => ({ ok }), (error) => ({ error: error.code }));
/** A query sent straight to one resolver, over UDP (Node's resolver), with a 3 s bound and one try. */
const direct = (server) => { const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 }); r.setServers([server]); return settle(r.resolve4('example.com')); };
(async () => {
  const servers = JSON.parse(process.argv[1] || '[]');
  const out = {
    direct: Object.fromEntries(await Promise.all(servers.map(async (s) => [s, await direct(s)]))),
    resolve4External: await settle(dns.promises.resolve4('example.com')),
    resolve4Host: await settle(dns.promises.resolve4('host.docker.internal')),
    lookupHost: await settle(dns.promises.lookup('host.docker.internal').then((r) => r.address)),
    resolvConf: fs.readFileSync('/etc/resolv.conf', 'utf8').split('\\n').filter((l) => l.trim() !== ''),
  };
  console.log(JSON.stringify(out));
})();
`;

function docker(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      [...args],
      { env: { ...process.env, DOCKER_HOST }, timeout: 120_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error(`docker ${args.join(' ')} exceeded 120 s\n${stderr}`));
          return;
        }
        if (error && typeof error.code !== 'number') {
          const dockerError: Error = present(error, 'the docker exec error');
          reject(dockerError);
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

let suite: AgentSuite;
let listener: Server;
let listenerPort: number;
let accepted = 0;
/** The VM-local peer: a container on the VM's host network, listening on every VM address. */
const PEER = `asha-egress-peer-${String(process.pid)}`;
const PEER_PORT = 40_000 + (process.pid % 10_000);
/** The DNS control: on the home network with none of the agent's DNS flags, removed after. */
const DNS_CONTROL = `asha-egress-dns-control-${String(process.pid)}`;
/** What labels this test's own containers: never `asha.home`, so no daemon's reclaim takes them for an agent's. */
const PROBE_LABEL = 'asha.test=egress';

beforeAll(async () => {
  suite = await agentSuite('egress', 'egress');
  listener = createServer((socket) => {
    accepted += 1;
    socket.end();
  });
  await new Promise<void>((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
  listenerPort = (listener.address() as { port: number }).port;
});

afterAll(async () => {
  const removed = await docker(['rm', '--force', PEER]);
  // The DNS control runs with --rm; this removes it only if a failed run left it.
  const removedControl = await docker(['rm', '--force', DNS_CONTROL]);
  await suite.finish();
  await new Promise((resolveClose) => listener.close(resolveClose));
  expect(removed.code, removed.stderr).toBe(0);
  expect(removedControl.code === 0 || /No such container/.test(removedControl.stderr), removedControl.stderr).toBe(
    true,
  );
});

describe('an agent container reaches only the daemon (agent-tools R14)', () => {
  it('refuses the internet, the VM, the LAN and another host port from inside a real agent container, and reaches the daemon (A11)', async (ctx) => {
    suite.begin(ctx, {
      id: 'egress',
      title: 'Connections from inside a hello-world agent container',
      agents: [],
      expectation:
        "From hewo-1's container: 1.1.1.1:443, the VM (its bridge gateway and 192.168.5.1, on sshd's port and on a peer the test starts in the VM), 192.0.2.1:999 (TEST-NET-1; the home's REJECT answers it inside the VM) and another host port are refused (ECONNREFUSED); the daemon's port is open. No outside name resolves: resolve4 of example.com and of host.docker.internal fail with ESERVFAIL, lookup of host.docker.internal gives 192.168.5.2 from /etc/hosts, and resolv.conf forwards to 192.0.2.1; a query straight to 1.1.1.1, to 192.168.5.1 or to the bridge gateway gets no answer (UDP), and their TCP port 53 is refused. A control container on Docker's default bridge reaches the VM peer, sshd and the other host port; a DNS control on the home network without the agent's DNS flags resolves host.docker.internal to 192.168.5.2; no network needed.",
    });
    const launched = await suite.send(ctx, ['--launch', 'recipe=hello-world', 'channel=egress'], 600_000);
    expect([launched.code, launched.stdout], launched.stderr).toEqual([0, 'hewo-1\n']);
    const container = containerOf(suite.home, 'egress', 'hewo-1');
    // The exact image the agent runs: each build has its own tag, `asha-image-hello-world:<source digest>` (D23).
    const inspectedImage = await docker(['inspect', '--format', '{{.Config.Image}}', container]);
    expect(inspectedImage.code, inspectedImage.stderr).toBe(0);
    const image = inspectedImage.stdout.trim();
    expect(image).toMatch(/^asha-image-hello-world:[0-9a-f]{64}$/);
    const peer = await docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      PEER,
      '--label',
      PROBE_LABEL,
      '--network',
      'host',
      '--entrypoint',
      'node',
      image,
      '-e',
      `require('net').createServer((s) => s.end()).listen(${String(PEER_PORT)}, '0.0.0.0')`,
    ]);
    expect(peer.code, peer.stderr).toBe(0);

    const port = (JSON.parse(readFileSync(join(suite.home, 'daemon.json'), 'utf8')) as { port: number }).port;
    const network = await docker([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}',
      container,
    ]);
    expect(network.code, network.stderr).toBe(0);
    const bridgeGateway = network.stdout.trim();
    expect(bridgeGateway).toMatch(/^\d+\.\d+\.\d+\.1$/);

    const probed = await docker([
      'exec',
      container,
      'node',
      '-e',
      PROBE,
      JSON.stringify({
        internet: ['1.1.1.1', 443],
        vmBridgeGateway: [bridgeGateway, 22],
        vmHostNetwork: ['192.168.5.1', 22],
        vmPeer: [bridgeGateway, PEER_PORT],
        vmPeerHostNetwork: ['192.168.5.1', PEER_PORT],
        lan: ['192.0.2.1', 999],
        otherHostPort: ['host.docker.internal', listenerPort],
        daemon: ['host.docker.internal', port],
      }),
    ]);
    expect(probed.code, probed.stderr).toBe(0);
    expect(JSON.parse(probed.stdout)).toEqual({
      internet: 'ECONNREFUSED',
      vmBridgeGateway: 'ECONNREFUSED',
      vmHostNetwork: 'ECONNREFUSED',
      vmPeer: 'ECONNREFUSED',
      vmPeerHostNetwork: 'ECONNREFUSED',
      lan: 'ECONNREFUSED',
      otherHostPort: 'ECONNREFUSED',
      daemon: 'open',
    });
    expect(accepted).toBe(0);

    // DNS (R2): no outside name resolves from the agent container, by any path; host.docker.internal comes from /etc/hosts.
    // And straight to a resolver outside the container (completion review, finding 5): an outside one, the VM's own on
    // its host network, and the VM's address on the agent's bridge — each refused or unanswered, never an answer.
    const dnsAgent = await docker([
      'exec',
      container,
      'node',
      '-e',
      DNS_PROBE,
      JSON.stringify(['1.1.1.1', '192.168.5.1', bridgeGateway]),
    ]);
    expect(dnsAgent.code, dnsAgent.stderr).toBe(0);
    const resolved = JSON.parse(dnsAgent.stdout) as {
      direct: Record<string, { ok?: unknown; error?: string }>;
      resolve4External: unknown;
      resolve4Host: unknown;
      lookupHost: unknown;
      resolvConf: string[];
    };
    expect(
      Object.fromEntries(
        Object.entries(resolved.direct).map(([server, answer]) => [
          server,
          answer.ok === undefined && ['ECONNREFUSED', 'ETIMEOUT'].includes(String(answer.error)) ? 'no answer' : answer,
        ]),
      ),
      'DNS straight to a resolver outside the agent container',
    ).toEqual({ '1.1.1.1': 'no answer', '192.168.5.1': 'no answer', [bridgeGateway]: 'no answer' });
    // TCP port 53 too, which DNS falls back to: refused at once, as every other port.
    const dnsTcp = await docker([
      'exec',
      container,
      'node',
      '-e',
      PROBE,
      JSON.stringify({ outside: ['1.1.1.1', 53], vm: ['192.168.5.1', 53], bridge: [bridgeGateway, 53] }),
    ]);
    expect(dnsTcp.code, dnsTcp.stderr).toBe(0);
    expect(JSON.parse(dnsTcp.stdout), 'TCP port 53 from the agent container').toEqual({
      outside: 'ECONNREFUSED',
      vm: 'ECONNREFUSED',
      bridge: 'ECONNREFUSED',
    });
    expect(
      {
        resolve4External: resolved.resolve4External,
        resolve4Host: resolved.resolve4Host,
        lookupHost: resolved.lookupHost,
      },
      'DNS from the agent container',
    ).toEqual({
      resolve4External: { error: 'ESERVFAIL' },
      resolve4Host: { error: 'ESERVFAIL' },
      lookupHost: { ok: '192.168.5.2' },
    });
    expect(resolved.resolvConf, "the agent container's resolv.conf").toContain('# ExtServers: [192.0.2.1]');
    // The daemon's port stays reachable by the name /etc/hosts now gives (asserted `open` above).

    // The DNS control: the same image on the same home network, none of the agent's DNS flags, this test's label only.
    const homeNetwork = await docker([
      'inspect',
      '--format',
      '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}',
      container,
    ]);
    expect(homeNetwork.code, homeNetwork.stderr).toBe(0);
    expect(homeNetwork.stdout.trim()).toMatch(/^asha-[0-9a-f]{8}$/);
    const dnsControl = await docker([
      'run',
      '--rm',
      '--name',
      DNS_CONTROL,
      '--label',
      PROBE_LABEL,
      '--network',
      homeNetwork.stdout.trim(),
      '--entrypoint',
      'node',
      image,
      '-e',
      DNS_PROBE,
      '[]',
    ]);
    expect(dnsControl.code, dnsControl.stderr).toBe(0);
    expect(
      (JSON.parse(dnsControl.stdout) as { resolve4Host: unknown }).resolve4Host,
      'DNS control: host.docker.internal by DNS',
    ).toEqual({ ok: ['192.168.5.2'] });

    // The control: the same probe on Docker's default bridge reaches the peers the agent could not — all local, no network.
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
      JSON.stringify({
        vmPeer: ['172.17.0.1', PEER_PORT],
        vmPeerHostNetwork: ['192.168.5.1', PEER_PORT],
        vm: ['172.17.0.1', 22],
        otherHostPort: ['host.docker.internal', listenerPort],
      }),
    ]);
    expect(control.code, control.stderr).toBe(0);
    expect(JSON.parse(control.stdout)).toEqual({
      vmPeer: 'open',
      vmPeerHostNetwork: 'open',
      vm: 'open',
      otherHostPort: 'open',
    });
    expect(accepted).toBe(1);
  });
});

describe('agents on one home cannot reach each other (completion review finding 5)', () => {
  it('refuses a connection from one agent container to another on the same network; the other listens, as it itself proves', async (ctx) => {
    suite.begin(ctx, {
      id: 'agent-to-agent',
      title: 'From one agent container to another on the same bridge',
      agents: ['hewo-1'],
      expectation:
        "A second agent's container listens on a port (reached from inside itself); hewo-1's container cannot reach it across the bridge.",
    });
    const second = await suite.send(ctx, ['--launch', 'recipe=hello-world', 'channel=egress'], 600_000);
    expect([second.code, second.stdout], second.stderr).toEqual([0, 'hewo-2\n']);
    const [first, other] = [containerOf(suite.home, 'egress', 'hewo-1'), containerOf(suite.home, 'egress', 'hewo-2')];
    const address = await docker([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      other,
    ]);
    expect(address.code, address.stderr).toBe(0);
    const ip = address.stdout.trim();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const listening = await docker([
      'exec',
      '--detach',
      other,
      'node',
      '-e',
      `require('net').createServer((s) => s.end()).listen(${String(PEER_PORT)}, '0.0.0.0')`,
    ]);
    expect(listening.code, listening.stderr).toBe(0);
    // The listener is up: the second container reaches it on its own address.
    const self = await docker(['exec', other, 'node', '-e', PROBE, JSON.stringify({ self: [ip, PEER_PORT] })]);
    expect(JSON.parse(self.stdout)).toEqual({ self: 'open' });
    const across = await docker(['exec', first, 'node', '-e', PROBE, JSON.stringify({ otherAgent: [ip, PEER_PORT] })]);
    expect(across.code, across.stderr).toBe(0);
    expect(JSON.parse(across.stdout)).toEqual({ otherAgent: 'ECONNREFUSED' });
  });
});
