// The module host (docs/plans/extension-modules.md R5, R6 (a), R7, R19, R34, R35; A7, A32): one container per
// (module, channel), calls framed as NDJSON and matched by id, every bound on an injected clock, a failing container
// restarted within its budget, and every failure a reason from the caller's closed set.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_LINE_BYTES,
  ModuleHost,
  ModuleUnavailable,
  PROVIDER_IDLE_MS,
  PROVIDER_QUEUE_MS,
  type CallOutcome,
  type InstalledModule,
} from '../../src/daemon/modules/index.js';
import type { SecretStore } from '../../src/daemon/secrets/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { parseModuleManifest } from '../../src/shared/modules.js';
import { FakeRuntime, type FakeAttached } from '../helpers/daemon-fakes.js';
import { RecordingLogger } from '../helpers/fakes.js';
import {
  cloudToolManifest,
  pluginManifest,
  fixtureSecret,
  providerManifest,
  TestTimers,
  toolModuleManifest,
} from '../helpers/modules.js';

const NEVER = new AbortController().signal;

function installed(raw: Record<string, unknown>): InstalledModule {
  return { manifest: parseModuleManifest(raw, 'module.json', String(raw['id'])), dir: `/modules/${String(raw['id'])}` };
}

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, Record<string, string>>();
  get(module: string): Promise<Readonly<Record<string, string>>> {
    return Promise.resolve({ ...(this.values.get(module) ?? {}) });
  }
  set(module: string, name: string, value: string): Promise<void> {
    this.values.set(module, { ...(this.values.get(module) ?? {}), [name]: value });
    return Promise.resolve();
  }
  names(module: string): Promise<readonly string[]> {
    return Promise.resolve(Object.keys(this.values.get(module) ?? {}).sort(byCodeUnit));
  }
  deleteModule(module: string): Promise<void> {
    this.values.delete(module);
    return Promise.resolve();
  }
  allValues(): Promise<readonly string[]> {
    return Promise.resolve([...this.values.values()].flatMap((v) => Object.values(v)));
  }
}

const TOOL = installed(toolModuleManifest());
const SEARCH = installed(cloudToolManifest());
const PROVIDER = installed(providerManifest());

function setup(
  modules: readonly InstalledModule[] = [TOOL],
  harnessImage: (name: string) => Promise<unknown> = (name) =>
    Promise.resolve({ tag: `asha-harness-${name}:t`, built: false }),
) {
  const runtime = new FakeRuntime('127.0.0.1');
  const logger = new RecordingLogger();
  const timers = new TestTimers();
  const secrets = new MemorySecrets();
  for (const m of modules)
    for (const name of m.manifest.secrets)
      secrets.values.set(m.manifest.id, { ...(secrets.values.get(m.manifest.id) ?? {}), [name]: fixtureSecret(name) });
  const clock = { t: 1_000_000 };
  let ids = 0;
  const host = new ModuleHost({
    runtime,
    images: {
      harness: async (name) => (await harnessImage(name)) as never,
      module: (m) => Promise.resolve({ tag: `asha-module-${m.manifest.id}:t`, built: false } as never),
      plugin: (m) => Promise.resolve({ tag: `asha-plugin-${m.manifest.id}:t`, built: false } as never),
    },
    installed: new Map(modules.map((m) => [m.manifest.id, m])),
    secrets,
    logger,
    homeId: 'h1',
    newId: () => `call${String(ids++).padStart(4, '0')}`,
    setTimer: timers.setTimer,
    now: () => clock.t,
  });
  /** Module containers started, in order (the proxy left out). */
  const modulesStarted = (): FakeAttached[] =>
    runtime.attached.filter((a) => a.spec.labels['asha.role'] !== 'egress-proxy');
  return { runtime, logger, timers, secrets, clock, host, modulesStarted };
}

/** Lets every queued microtask and the next macrotask run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const call = (host: ModuleHost, over: Partial<Parameters<ModuleHost['call']>[0]> = {}): Promise<CallOutcome> =>
  host.call({
    module: 'fixture_tool',
    channel: 'a',
    tool: 'lookup',
    arguments: { word: 'x' },
    timeoutMs: 5_000,
    consequential: false,
    abandon: NEVER,
    ...over,
  });

describe('one container per (module, channel) (R34)', () => {
  it("starts exactly two containers for two agents on a and one on b, and stops each when its channel's last granting agent leaves", async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    await s.host.acquire('fixture_tool', 'a');
    await s.host.acquire('fixture_tool', 'b');
    expect(s.modulesStarted().map((c) => [c.spec.network, c.spec.labels])).toEqual([
      ['asha-m-h1-fixture_tool-a', { 'asha.module': 'fixture_tool', 'asha.channel': 'a' }],
      ['asha-m-h1-fixture_tool-b', { 'asha.module': 'fixture_tool', 'asha.channel': 'b' }],
    ]);
    // Each module network internal, labelled; the egress network once, with its bridge.
    expect([...s.runtime.networks.entries()].map(([name, spec]) => [name, spec.internal])).toEqual([
      ['asha-egress-h1', false],
      ['asha-m-h1-fixture_tool-a', true],
      ['asha-m-h1-fixture_tool-b', true],
    ]);
    expect(s.runtime.calls.filter((c) => c.startsWith('installEgressRules'))).toEqual(['installEgressRules ashaeh1']);
    expect(s.runtime.calls.filter((c) => c === 'engineVersion')).toEqual(['engineVersion']);

    await s.host.release('fixture_tool', 'a');
    expect(s.modulesStarted().map((c) => c.removed)).toEqual([false, false]);
    await s.host.release('fixture_tool', 'a');
    expect(s.modulesStarted().map((c) => c.removed)).toEqual([true, false]);
    expect(s.runtime.networks.has('asha-m-h1-fixture_tool-a')).toBe(false);
    // The proxy was told to stop listening on a's network, then disconnected from it.
    const proxy = present(
      s.runtime.attached.find((c) => c.spec.labels['asha.role'] === 'egress-proxy'),
      'the egress proxy container',
    );
    expect(proxy.requests().map((r) => r['op'])).toEqual(['listen', 'listen', 'close']);
    expect(s.runtime.calls).toContain('disconnectNetwork asha-m-h1-fixture_tool-a asha-egress-h1');
    // A second release of a channel with no agent left stops nothing more.
    await s.host.release('fixture_tool', 'a');
    expect(s.runtime.calls.filter((c) => c.startsWith('removeAttached'))).toHaveLength(1);
    await s.host.release('fixture_tool', 'b');
    expect(s.modulesStarted().map((c) => c.removed)).toEqual([true, true]);
    expect(s.logger.events('error')).toEqual([]);
  });

  it("tells the proxy each module's own hosts on its own network (R6 (c))", async () => {
    const s = setup([TOOL, SEARCH]);
    await s.host.acquire('fixture_tool', 'a');
    await s.host.acquire('fixture_search', 'a');
    const proxy = present(
      s.runtime.attached.find((c) => c.spec.labels['asha.role'] === 'egress-proxy'),
      'the egress proxy container',
    );
    expect(proxy.requests()).toEqual([
      { op: 'listen', address: '10.99.0.2', module: 'fixture_tool', hosts: [] },
      { op: 'listen', address: '10.99.1.2', module: 'fixture_search', hosts: ['api.search.example'] },
    ]);
    expect(proxy.spec.env).toEqual({});
  });
});

describe('secrets (R7, A7)', () => {
  it('passes each module only its own declared secrets, and the proxy none', async () => {
    const other = installed({ ...cloudToolManifest(), id: 'other_search', secrets: ['OTHER_KEY'] });
    const s = setup([SEARCH, other]);
    await s.host.acquire('fixture_search', 'a');
    await s.host.acquire('other_search', 'a');
    expect(s.runtime.attached.map((c) => [c.spec.name.replace(/-call\d+$/, ''), c.spec.env])).toEqual([
      ['asha-egress-h1', {}],
      ['asha-mod-fixture_search-a', { SEARCH_KEY: fixtureSecret('SEARCH_KEY') }],
      ['asha-mod-other_search-a', { OTHER_KEY: fixtureSecret('OTHER_KEY') }],
    ]);
  });

  it('fails the acquire, naming the secret and the command, when a declared secret is not set; nothing is started', async () => {
    const s = setup([SEARCH]);
    s.secrets.values.clear();
    const error = await s.host.acquire('fixture_search', 'a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModuleUnavailable);
    expect((error as Error).message).toBe(
      'module fixture_search is unavailable: its secret SEARCH_KEY is not set: asha --set-secret module=fixture_search name=SEARCH_KEY',
    );
    expect(s.modulesStarted()).toEqual([]);
    expect(s.runtime.networks.has('asha-m-h1-fixture_search-a')).toBe(false);
  });

  it("redacts a module's secret from its stderr, and re-logs a JSON stderr line as module.record (R35)", async () => {
    const s = setup([SEARCH]);
    await s.host.acquire('fixture_search', 'a');
    const module = present(s.modulesStarted()[0], 's.modulesStarted()[0]');
    const secret = fixtureSecret('SEARCH_KEY');
    module.stderr(`oops ${secret} and ${secret.slice(0, 12)}`);
    module.stderr('{"event":"fetching","n":1}');
    const lines = s.logger.entries.filter((e) => e.event === 'module.stderr' || e.event === 'module.record');
    expect(lines.map((e) => [e.event, e.fields])).toEqual([
      ['module.stderr', { module: 'fixture_search', channel: 'a', line: 'oops [redacted] and [redacted]' }],
      ['module.record', { module: 'fixture_search', channel: 'a', record: { event: 'fetching', n: 1 } }],
    ]);
    expect(JSON.stringify(s.logger.entries)).not.toContain(secret.slice(0, 12));
  });
  it("redacts a module's secret from its answers — a result, a refusal's detail, a stderr line split in the secret (review of 2026-10-02, B-8, B-13)", async () => {
    const s = setup([SEARCH]);
    await s.host.acquire('fixture_search', 'a');
    const module = present(s.modulesStarted()[0], 's.modulesStarted()[0]');
    const secret = fixtureSecret('SEARCH_KEY');
    const first = call(s.host, { module: 'fixture_search', tool: 'search', arguments: { query: 'x' } });
    const second = call(s.host, { module: 'fixture_search', tool: 'search', arguments: { query: 'y' } });
    await settle();
    const [a, b] = module.requests().map((r) => r['id'] as string);
    module.respond({ id: a, ok: true, result: { text: `key ${secret}`, [secret]: [secret.slice(0, 9)] } });
    module.respond({ id: b, ok: false, reason: 'module_unavailable', detail: `vendor said ${secret} is bad` });
    expect(await first).toEqual({ ok: true, result: { text: 'key [redacted]', '[redacted]': ['[redacted]'] } });
    expect(await second).toEqual({ ok: false, reason: 'module_unavailable', detail: 'vendor said [redacted] is bad' });
    module.stderr(`key ${secret.slice(0, 10)}`);
    module.stderr(`${secret.slice(10)} end`);
    const lines = s.logger.entries.filter((e) => e.event === 'module.stderr').map((e) => e.fields['line']);
    expect(lines).toEqual(['key [redacted]', '[redacted] end']);
    expect(JSON.stringify(s.logger.entries)).not.toContain(secret.slice(10));
  });
});

describe('the engine (R6 (a))', () => {
  it('fails every granting acquire, naming the version, on a Docker Engine older than 26.0.0 — checked once', async () => {
    const s = setup();
    s.runtime.engine = '25.0.0';
    for (const channel of ['a', 'b']) {
      const error = await s.host.acquire('fixture_tool', channel).catch((e: unknown) => e);
      expect((error as Error).message).toContain("the colima VM's Docker Engine is 25.0.0, older than 26.0.0");
    }
    expect(s.runtime.calls.filter((c) => c === 'engineVersion')).toEqual(['engineVersion']);
    expect(s.runtime.networks.size).toBe(0);
    expect(s.logger.events('error')).toEqual(['module.engine_too_old']);
  });
});

describe('calls (R34)', () => {
  it('writes one request line per call and matches two answers given out of order by id', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const module = present(s.modulesStarted()[0], 's.modulesStarted()[0]');
    const first = call(s.host, { arguments: { word: 'one' }, idempotencyKey: 'k1' });
    const second = call(s.host, { arguments: { word: 'two' } });
    await settle();
    expect(module.requests()).toEqual([
      { id: 'call0001', tool: 'lookup', arguments: { word: 'one' }, idempotencyKey: 'k1' },
      { id: 'call0002', tool: 'lookup', arguments: { word: 'two' } },
    ]);
    module.respond({ id: 'call0002', ok: true, result: 'second' });
    module.respond({ id: 'call0001', ok: false, reason: 'not_found', detail: 'no such word' });
    expect(await first).toEqual({ ok: false, reason: 'not_found', detail: 'no such word' });
    expect(await second).toEqual({ ok: true, result: 'second' });
    expect(s.timers.pending()).toBe(0);
  });

  it('carries the usage with the answer, and an answer split across chunks', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const module = present(s.modulesStarted()[0], 's.modulesStarted()[0]');
    const outcome = call(s.host);
    await settle();
    module.stdout('{"id":"call0001","ok":tr');
    module.stdout('ue,"result":1,"usage":{"units":2}}\n');
    expect(await outcome).toEqual({ ok: true, result: 1, usage: { units: 2 } });
  });

  it('ends a call timeout at its timeoutMs, logged; a late answer to it is a warning, not a failure', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const module = present(s.modulesStarted()[0], 's.modulesStarted()[0]');
    const outcome = call(s.host);
    await settle();
    expect(s.timers.fire(5_000)).toBe(1);
    expect(await outcome).toEqual({ ok: false, reason: 'timeout', detail: 'no answer within 5000 ms' });
    module.respond({ id: 'call0001', ok: true, result: 'late' });
    expect(s.logger.events()).toEqual(expect.arrayContaining(['module.failed', 'module.late_answer']));
    expect(module.removed).toBe(false);
  });

  it('ends a consequential call unknown_outcome at its bound (R13)', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const outcome = call(s.host, { consequential: true });
    await settle();
    s.timers.fire(5_000);
    expect(await outcome).toEqual({ ok: false, reason: 'unknown_outcome', detail: 'no answer within 5000 ms' });
  });

  it('ends every call in flight module_unavailable when the container exits, a consequential one unknown_outcome; the next call starts a new container', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const module = present(s.modulesStarted()[0], 's.modulesStarted()[0]');
    const plain = call(s.host);
    const consequential = call(s.host, { consequential: true });
    await settle();
    module.exit(1);
    expect(await plain).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: 'its container exited with code 1',
    });
    expect(await consequential).toEqual({
      ok: false,
      reason: 'unknown_outcome',
      detail: 'its container exited with code 1',
    });
    const next = call(s.host);
    await settle();
    expect(s.modulesStarted()).toHaveLength(2);
    const second = present(s.modulesStarted()[1], 's.modulesStarted()[1]');
    second.respond({ id: present(second.requests()[0], 'second.requests()[0]')['id'], ok: true, result: 'again' });
    expect(await next).toEqual({ ok: true, result: 'again' });
  });

  it('fails the module on a line that is not JSON: the calls in flight end module_unavailable and the container is removed', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const module = present(s.modulesStarted()[0], 's.modulesStarted()[0]');
    const outcome = call(s.host);
    await settle();
    module.stdout('this is not json\n');
    expect(await outcome).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: 'it wrote a line that is not JSON',
    });
    await settle();
    expect(module.removed).toBe(true);
  });

  it("fails the module on a reason outside the tool's closed set, and on an answer to a call it was never given", async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const outcome = call(s.host);
    await settle();
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').respond({ id: 'call0001', ok: false, reason: 'made_up' });
    expect(await outcome).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: 'it answered call0001 with neither {ok: true, result} nor {ok: false, reason} from its closed set',
    });
    const again = call(s.host);
    await settle();
    present(s.modulesStarted()[1], 's.modulesStarted()[1]').respond({ id: 'nobody', ok: true, result: 1 });
    expect(await again).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: 'it answered a call it was never given (nobody)',
    });
  });

  it('reads a line of exactly 1 MiB, and fails the calls in flight on one of 1 MiB + 1 byte', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const exact = call(s.host);
    await settle();
    const head = '{"id":"call0001","ok":true,"result":"';
    const tail = '"}';
    const line = head + 'x'.repeat(MAX_LINE_BYTES - head.length - tail.length) + tail;
    expect(Buffer.byteLength(line)).toBe(MAX_LINE_BYTES);
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').stdout(`${line}\n`);
    expect(((await exact) as { ok: true; result: string }).result).toHaveLength(
      MAX_LINE_BYTES - head.length - tail.length,
    );
    const over = call(s.host);
    await settle();
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').stdout(
      `${head.replace('call0001', 'call0002')}${'x'.repeat(MAX_LINE_BYTES - head.length - tail.length + 1)}${tail}\n`,
    );
    expect(await over).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: `it wrote a line of ${String(MAX_LINE_BYTES + 1)} bytes, over ${String(MAX_LINE_BYTES)}`,
    });
  });

  it('fails the calls when more than 1 MiB arrives with no newline', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const outcome = call(s.host);
    await settle();
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').stdout('x'.repeat(MAX_LINE_BYTES + 1));
    expect(await outcome).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: `it wrote a line of more than ${String(MAX_LINE_BYTES)} bytes`,
    });
  });

  it('restarts a module that keeps exiting at most 3 times in 10 minutes, then answers module_unavailable with no fourth start', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    for (let restart = 1; restart <= 3; restart += 1) {
      present(s.modulesStarted().at(-1), 's.modulesStarted().at(-1)').exit(1);
      await settle();
      const outcome = call(s.host);
      await settle();
      expect(s.modulesStarted()).toHaveLength(1 + restart);
      const started = present(s.modulesStarted().at(-1), 's.modulesStarted().at(-1)');
      started.respond({
        id: present(started.requests()[0], 'started.requests()[0]')['id'],
        ok: true,
        result: restart,
      });
      expect(await outcome).toEqual({ ok: true, result: restart });
      s.clock.t += 60_000;
    }
    present(s.modulesStarted().at(-1), 's.modulesStarted().at(-1)').exit(1);
    await settle();
    expect(await call(s.host)).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: 'module fixture_tool was restarted 3 times in 10 minutes; launch its agents again',
    });
    expect(s.modulesStarted()).toHaveLength(4);
    // R6 (d): the rules were verified right before each of the four starts, the restarts included (review B-24).
    const order = s.runtime.calls.filter(
      (c) => c.startsWith('verifyEgressRules ashae') || c.startsWith('runAttached asha-mod-'),
    );
    const starts = order.flatMap((c, i) => (c.startsWith('runAttached') ? [order[i - 1]?.split(' ')[0]] : []));
    expect(starts).toEqual(['verifyEgressRules', 'verifyEgressRules', 'verifyEgressRules', 'verifyEgressRules']);
    // Still exhausted later: only a new launch (a new acquire after the last release) starts it again.
    s.clock.t += 20 * 60_000;
    expect((await call(s.host)).ok).toBe(false);
    expect(s.modulesStarted()).toHaveLength(4);
  });

  it('restarts again once a restart has left the 10-minute window', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    for (let restart = 1; restart <= 4; restart += 1) {
      present(s.modulesStarted().at(-1), 's.modulesStarted().at(-1)').exit(1);
      await settle();
      const outcome = call(s.host);
      await settle();
      const started = present(s.modulesStarted().at(-1), 's.modulesStarted().at(-1)');
      started.respond({
        id: present(started.requests()[0], 'started.requests()[0]')['id'],
        ok: true,
        result: restart,
      });
      expect(await outcome).toEqual({ ok: true, result: restart });
      s.clock.t += 4 * 60_000;
    }
    expect(s.modulesStarted()).toHaveLength(5);
  });

  it('answers a call on a channel where the module is not running module_unavailable, starting nothing', async () => {
    const s = setup();
    expect(await call(s.host)).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: 'module fixture_tool is not running on channel a',
    });
    expect(s.runtime.attached).toEqual([]);
  });
});

describe('agents leaving (R34)', () => {
  it('ends a call that is not consequential at once when its agent leaves, logged abandoned', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const controller = new AbortController();
    const outcome = call(s.host, { abandon: controller.signal });
    await settle();
    controller.abort();
    expect(await outcome).toEqual({ ok: false, reason: 'module_unavailable', detail: 'abandoned' });
    expect(
      present(
        s.logger.entries.find((e) => e.event === 'module.failed'),
        'the module.failed log entry',
      ).fields,
    ).toMatchObject({
      module: 'fixture_tool',
      tool: 'lookup',
      channel: 'a',
      reason: 'abandoned',
    });
  });

  it('lets a consequential call run on when its agent leaves, for its audit', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const controller = new AbortController();
    const outcome = call(s.host, { abandon: controller.signal, consequential: true });
    await settle();
    controller.abort();
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').respond({ id: 'call0001', ok: true, result: 'done' });
    expect(await outcome).toEqual({ ok: true, result: 'done' });
  });

  it("ends a consequential call unknown_outcome when the channel's last agent leaves and the container stops first", async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const outcome = call(s.host, { consequential: true });
    await settle();
    await s.host.release('fixture_tool', 'a');
    expect(await outcome).toEqual({
      ok: false,
      reason: 'unknown_outcome',
      detail: 'abandoned: the container was stopped',
    });
    expect(s.logger.entries.filter((e) => e.event === 'module.failed').map((e) => e.fields['reason'])).toEqual([
      'abandoned',
    ]);
  });

  it('once stopping, releases nothing one by one (the reclaim removes everything), and ends calls in flight with their containers', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const outcome = call(s.host, { consequential: true });
    await settle();
    s.host.stop();
    await s.host.release('fixture_tool', 'a');
    expect(s.runtime.calls.filter((c) => c.startsWith('removeAttached') || c.startsWith('removeNetwork'))).toEqual([]);
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').exit(137);
    expect(await outcome).toEqual({ ok: false, reason: 'unknown_outcome', detail: 'the daemon stopped' });
    expect(s.timers.pending()).toBe(0);
  });
});

describe('a provider (R19)', () => {
  const chat = (host: ModuleHost, onDelta: (d: unknown) => void, abandon = NEVER) =>
    host.provider({
      module: 'fixture_provider',
      channel: 'a',
      tool: 'chat',
      arguments: { model: 'vendor.small-model-v1' },
      onDelta,
      abandon,
    });

  it('hands each delta on in order and keeps the call alive past the first-chunk bound while deltas come', async () => {
    const s = setup([PROVIDER]);
    await s.host.acquire('fixture_provider', 'a');
    const deltas: unknown[] = [];
    const outcome = chat(s.host, (d) => deltas.push(d));
    await settle();
    const module = present(s.modulesStarted()[0], 's.modulesStarted()[0]');
    module.respond({ id: 'call0001', delta: { part: 'text', text: 'a' } });
    // The first-chunk bound is cancelled by the delta; the idle bound runs from it.
    expect(s.timers.fire(PROVIDER_QUEUE_MS)).toBe(0);
    module.respond({ id: 'call0001', delta: { part: 'text', text: 'b' } });
    module.respond({
      id: 'call0001',
      ok: true,
      result: { text: 'ab', toolCalls: [] },
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(await outcome).toEqual({
      ok: true,
      result: { text: 'ab', toolCalls: [] },
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(deltas).toEqual([
      { part: 'text', text: 'a' },
      { part: 'text', text: 'b' },
    ]);
    expect(s.timers.pending()).toBe(0);
  });

  it('ends timeout 22,000 ms after the last delta, and at 55,000 ms when no chunk came', async () => {
    const s = setup([PROVIDER]);
    await s.host.acquire('fixture_provider', 'a');
    const idle = chat(s.host, () => undefined);
    await settle();
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').respond({
      id: 'call0001',
      delta: { part: 'text', text: 'a' },
    });
    expect(s.timers.fire(PROVIDER_IDLE_MS)).toBe(1);
    expect(await idle).toEqual({
      ok: false,
      reason: 'timeout',
      detail: `no chunk within ${String(PROVIDER_IDLE_MS)} ms`,
    });
    const silent = chat(s.host, () => undefined);
    await settle();
    expect(s.timers.fire(PROVIDER_QUEUE_MS)).toBe(1);
    expect(await silent).toEqual({
      ok: false,
      reason: 'timeout',
      detail: `no first chunk within ${String(PROVIDER_QUEUE_MS)} ms`,
    });
  });

  it("answers a provider's failures with ModelFailureReasons: unavailable when it is not running, and on exit", async () => {
    const s = setup([PROVIDER]);
    expect(await chat(s.host, () => undefined)).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'module fixture_provider is not running on channel a',
    });
    await s.host.acquire('fixture_provider', 'a');
    const outcome = chat(s.host, () => undefined);
    await settle();
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').respond({
      id: 'call0001',
      ok: false,
      reason: 'module_unavailable',
    });
    // module_unavailable is a tool's reason, not a provider's: the module broke the contract.
    expect(await outcome).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: 'it answered call0001 with neither {ok: true, result} nor {ok: false, reason} from its closed set',
    });
  });

  it('refuses a delta for a tool call: only a provider streams', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const outcome = call(s.host);
    await settle();
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').respond({
      id: 'call0001',
      delta: { part: 'text', text: 'a' },
    });
    expect(await outcome).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: "it streamed a delta for a call that is not a provider's",
    });
  });
});

describe("the egress proxy's records", () => {
  it('re-logs each through the facade at its level: a connection info, a refusal warn, a failure inside a connection error (lint-format R11)', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const proxy = present(
      s.runtime.attached.find((c) => c.spec.labels['asha.role'] === 'egress-proxy'),
      'the egress proxy container',
    );
    const before = s.logger.entries.length;
    proxy.stderr('{"event":"egress.refused","module":"fixture","host":"evil.test","rule":"not_allowed"}');
    proxy.stderr('{"event":"egress.handle_failed","module":"fixture","host":"","detail":"dial exploded"}');
    proxy.stderr('{"event":"something.else","n":1}');
    expect(s.logger.entries.slice(before)).toEqual([
      {
        level: 'warn',
        event: 'egress.refused',
        fields: { module: 'fixture', host: 'evil.test', rule: 'not_allowed' },
      },
      {
        level: 'error',
        event: 'egress.handle_failed',
        fields: { module: 'fixture', host: '', error: new Error('dial exploded') },
      },
      {
        level: 'info',
        event: 'module.record',
        fields: { module: 'egress-proxy', record: { event: 'something.else', n: 1 } },
      },
    ]);
  });
});

describe('the egress proxy exiting (review of 2026-10-02)', () => {
  it('sets the proxy up again on the next call — its old container and network removed first — and the call goes through', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    const proxy = present(
      s.runtime.attached.find((c) => c.spec.labels['asha.role'] === 'egress-proxy'),
      'the egress proxy container',
    );
    proxy.exit(1);
    await settle();
    expect(
      present(
        s.logger.entries.find((e) => e.event === 'module.failed'),
        'the module.failed log entry',
      ).fields,
    ).toMatchObject({ module: 'egress-proxy' });
    present(s.modulesStarted()[0], 's.modulesStarted()[0]').exit(1);
    await settle();
    const outcome = call(s.host);
    await settle();
    await settle();
    const next = present(s.modulesStarted().at(-1), 's.modulesStarted().at(-1)');
    next.respond({ id: present(next.requests()[0], 'next.requests()[0]')['id'], ok: true, result: 'again' });
    expect(await outcome).toEqual({ ok: true, result: 'again' });
    const proxies = s.runtime.attached.filter((c) => c.spec.labels['asha.role'] === 'egress-proxy');
    expect(proxies).toHaveLength(2);
    const order = s.runtime.calls.filter((c) => /asha-egress-h1/.test(c));
    expect(order.indexOf('removeNetwork asha-egress-h1')).toBeGreaterThan(-1);
    expect(order.indexOf('removeNetwork asha-egress-h1')).toBeLessThan(
      order.lastIndexOf('createNetwork asha-egress-h1'),
    );
  });
});

describe("each module network's bridge named under asha (D53: the sandbox suite reached the VM's sshd at the bridge's gateway)", () => {
  it('names the bridge asham + 10 hex of sha256(home, module, channel): fixed per slot, distinct across slots and homes', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    await s.host.acquire('fixture_tool', 'b');
    const bridges = [...s.runtime.networks.values()].filter((n) => n.internal).map((n) => [n.name, n.bridge]);
    const expected = (channel: string) => {
      const key = `h1\0fixture_tool\0${channel}`;
      return `asham${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
    };
    expect(bridges).toEqual([
      ['asha-m-h1-fixture_tool-a', expected('a')],
      ['asha-m-h1-fixture_tool-b', expected('b')],
    ]);
    expect(bridges.every(([, bridge]) => /^asham[0-9a-f]{10}$/.test(present(bridge, 'bridge')))).toBe(true);
    expect(expected('a')).not.toBe(
      `asham${createHash('sha256').update('h2\0fixture_tool\0a').digest('hex').slice(0, 10)}`,
    );
  });
});

describe('the egress proxy starting (the gate at 360ac36: "No such container: asha-egress-…")', () => {
  it('connects no module network to the proxy before its program says ready, then listens and starts the module', async () => {
    const s = setup();
    s.runtime.proxyStart = 'manual';
    let done = false;
    const acquired = s.host.acquire('fixture_tool', 'a').then(() => (done = true));
    await settle();
    await settle();
    expect(s.runtime.calls.filter((c) => c.startsWith('runAttached asha-egress-h1'))).toHaveLength(1);
    expect(
      s.runtime.calls.filter((c) => c.startsWith('connectNetwork') || c.startsWith('createNetwork asha-m-')),
    ).toEqual([]);
    expect(done).toBe(false);
    present(
      s.runtime.attached.find((c) => c.spec.labels['asha.role'] === 'egress-proxy'),
      'the egress proxy container',
    ).ready();
    await acquired;
    expect(s.runtime.calls.filter((c) => c.startsWith('connectNetwork'))).toEqual([
      'connectNetwork asha-m-h1-fixture_tool-a asha-egress-h1 asha-egress',
    ]);
    expect(s.modulesStarted()).toHaveLength(1);
    expect(s.logger.events('error')).toEqual([]);
  });

  it('fails the acquire when the proxy never says ready within 10,000 ms, removes its container and network, and sets it up anew next time', async () => {
    const s = setup();
    s.runtime.proxyStart = 'never';
    const failing = s.host.acquire('fixture_tool', 'a').catch((e: unknown) => e);
    await settle();
    await settle();
    expect(s.runtime.calls.filter((c) => c === 'removeNetwork asha-egress-h1')).toEqual([]);
    expect(s.timers.live.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([10_000]);
    expect(s.timers.fire(10_000)).toBe(1);
    const error = await failing;
    expect(error).toBeInstanceOf(ModuleUnavailable);
    expect((error as Error).message).toBe(
      'module fixture_tool is unavailable: the egress proxy did not start: no ready line within 10000 ms',
    );
    expect(s.runtime.calls.filter((c) => /asha-egress-h1|ashaeh1/.test(c))).toEqual([
      'createNetwork asha-egress-h1',
      'installEgressRules ashaeh1',
      'verifyEgressRules ashaeh1',
      'runAttached asha-egress-h1 asha-harness-egress-proxy:t asha-egress-h1',
      'removeAttached asha-egress-h1',
      'removeNetwork asha-egress-h1',
    ]);
    expect(s.runtime.networks.has('asha-egress-h1')).toBe(false);
    expect(s.modulesStarted()).toEqual([]);
    // One failure record, the setup's; the proxy's own exit, caused by that removal, is not a second.
    await settle();
    expect(
      s.logger.entries
        .filter((e) => e.event === 'module.failed')
        .map((e) => [e.level, e.fields['module'], (e.fields['error'] as Error).message]),
    ).toEqual([['error', 'egress-proxy', 'the egress proxy did not start: no ready line within 10000 ms']]);
    s.runtime.proxyStart = 'auto';
    await s.host.acquire('fixture_tool', 'a');
    expect(s.runtime.calls.filter((c) => c === 'createNetwork asha-egress-h1')).toHaveLength(2);
    expect(s.modulesStarted()).toHaveLength(1);
  });

  it('removes the egress network when a later step of its setup fails (the proxy image), so the next acquire can create it', async () => {
    let failures = 1;
    const s = setup([TOOL], (name) => {
      if (failures-- > 0) return Promise.reject(new Error('docker build failed: no space left on device'));
      return Promise.resolve({ tag: `asha-harness-${name}:t`, built: false });
    });
    const error = await s.host.acquire('fixture_tool', 'a').catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'module fixture_tool is unavailable: docker build failed: no space left on device',
    );
    expect(s.runtime.networks.has('asha-egress-h1')).toBe(false);
    expect(s.runtime.calls.filter((c) => /asha-egress-h1|ashaeh1/.test(c))).toEqual([
      'createNetwork asha-egress-h1',
      'installEgressRules ashaeh1',
      'removeNetwork asha-egress-h1',
    ]);
    expect(
      s.logger.entries.filter((e) => e.event === 'module.failed').map((e) => (e.fields['error'] as Error).message),
    ).toEqual(['docker build failed: no space left on device']);
    await s.host.acquire('fixture_tool', 'a');
    expect(s.runtime.calls.filter((c) => c === 'createNetwork asha-egress-h1')).toHaveLength(2);
    expect(s.modulesStarted()).toHaveLength(1);
  });

  it('a proxy that exits before its ready line fails the acquire with its exit, and the next acquire removes it and starts again', async () => {
    const s = setup();
    s.runtime.proxyStart = 'manual';
    const failing = s.host.acquire('fixture_tool', 'a').catch((e: unknown) => e);
    await settle();
    await settle();
    present(
      s.runtime.attached.find((c) => c.spec.labels['asha.role'] === 'egress-proxy'),
      'the egress proxy container',
    ).exit(125);
    const error = await failing;
    expect((error as Error).message).toBe(
      'module fixture_tool is unavailable: the egress proxy did not start: it exited with code 125',
    );
    expect(s.runtime.networks.has('asha-egress-h1')).toBe(false);
    // Reported once, by the setup: proxyExited does not report the exit again.
    await settle();
    expect(
      s.logger.entries.filter((e) => e.event === 'module.failed').map((e) => (e.fields['error'] as Error).message),
    ).toEqual(['the egress proxy did not start: it exited with code 125']);
    s.runtime.proxyStart = 'auto';
    await s.host.acquire('fixture_tool', 'a');
    expect(s.runtime.attached.filter((c) => c.spec.labels['asha.role'] === 'egress-proxy')).toHaveLength(2);
    expect(s.modulesStarted()).toHaveLength(1);
  });
});

describe('an acquire while the last release is still tearing down (review of 2026-10-02, B-10)', () => {
  it('waits for the old network to be removed, then creates it again and starts a new container', async () => {
    const s = setup();
    await s.host.acquire('fixture_tool', 'a');
    let open!: () => void;
    s.runtime.removeNetworkGate = new Promise<void>((resolve) => (open = resolve));
    const released = s.host.release('fixture_tool', 'a');
    await settle();
    const acquired = s.host.acquire('fixture_tool', 'a');
    await settle();
    expect(s.runtime.calls.filter((c) => c === 'createNetwork asha-m-h1-fixture_tool-a internal')).toHaveLength(1);
    s.runtime.removeNetworkGate = undefined;
    open();
    await released;
    await acquired;
    expect(s.runtime.calls.filter((c) => c === 'createNetwork asha-m-h1-fixture_tool-a internal')).toHaveLength(2);
    expect(s.runtime.networks.has('asha-m-h1-fixture_tool-a')).toBe(true);
    expect(s.modulesStarted()).toHaveLength(2);
    expect(s.logger.events('error')).toEqual([]);
  });
});

describe('the engine version unread (review of 2026-10-02, B-21)', () => {
  it('fails that acquire, and asks again at the next, which goes on', async () => {
    const s = setup();
    s.runtime.engineFailures = 1;
    const error = await s.host.acquire('fixture_tool', 'a').catch((e: unknown) => e);
    expect((error as Error).message).toContain('Cannot connect to the Docker daemon');
    await settle();
    await s.host.acquire('fixture_tool', 'a');
    expect(s.runtime.calls.filter((c) => c === 'engineVersion')).toEqual(['engineVersion', 'engineVersion']);
    expect(s.modulesStarted()).toHaveLength(1);
  });
});

describe('a command plugin call (R6 (d); review of 2026-10-02, B-24)', () => {
  it('verifies the egress rules before every call, and starts no container of its own', async () => {
    const PLUGIN = installed(pluginManifest());
    const s = setup([PLUGIN]);
    await s.host.acquire(PLUGIN.manifest.id, 'a');
    const before = s.runtime.calls.filter((c) => c.startsWith('verifyEgressRules')).length;
    for (let i = 0; i < 3; i += 1)
      expect(await s.host.pluginSlot(PLUGIN.manifest.id, 'a')).toMatchObject({
        network: `asha-m-h1-${PLUGIN.manifest.id}-a`,
        image: `asha-plugin-${PLUGIN.manifest.id}:t`,
      });
    expect(s.runtime.calls.filter((c) => c.startsWith('verifyEgressRules')).length - before).toBe(3);
    expect(s.modulesStarted()).toEqual([]);
  });
});
