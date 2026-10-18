import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServedEntry } from '../../src/daemon/definitions/index.js';
import {
  CHAT_CACHE_RAM_MIB,
  LlamaCppServer,
  ModelServerFailed,
  realOrphanSweep,
} from '../../src/daemon/model-server/index.js';
import type { CachedModel } from '../../src/daemon/model-store/index.js';
import { chatCompletion } from '../../src/daemon/model-gateway/index.js';
import { FakeFetch, FakeLauncher, type FakeProcess, FakeRunner, RecordingLogger, ok } from '../helpers/fakes.js';
import { sseResponse } from '../helpers/llama-stream.js';
import { writePrivateFile } from '../../src/daemon/private-file/index.js';
import { present } from '../../src/shared/assert-present.js';

const ENTRY: ServedEntry = {
  kind: 'chat',
  id: 'demo-model',
  repo: 'Org/Demo-GGUF',
  revision: '23749fefcc72300e3a2ad315e1317431b06b590a',
  weights: 'model.gguf',
  files: [{ path: 'model.gguf', size: 1, sha256: 'a'.repeat(64) }],
  license: { id: 'apache-2.0', source: 'https://example/LICENSE', verified: '2026-09-26' },
  serve: { contextSize: 4096 },
  chat: {},
  toolCallStart: '<tool_call>\n',
};
const CACHED: CachedModel = { dir: '/models/sha256-x', weightsPath: '/models/sha256-x/model.gguf', status: 'cached' };
const LISTENING = 'main: server is listening on http://127.0.0.1:5555 - starting the main loop';
const BASE_URL = 'http://127.0.0.1:5555';

/** Lets pending promise callbacks (e.g. the exited handler) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('LlamaCppServer', () => {
  let logDir: string;
  let logger: RecordingLogger;
  let launcher: FakeLauncher;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), 'asha-ms-'));
    logger = new RecordingLogger();
    launcher = new FakeLauncher();
  });

  function server(runner: FakeRunner, fake: FakeFetch, readyTimeoutMs = 5_000, now: () => number = () => Date.now()) {
    return new LlamaCppServer({
      now,
      runner,
      launcher,
      logger,
      fetch: fake.fetch,
      logDir,
      readyTimeoutMs,
      keyFile: join(logDir, 'model-server.key'),
      writeKeyFile: writePrivateFile,
      orphans: realOrphanSweep,
    });
  }

  const llamaInstalled = () => new FakeRunner().on('llama-server --version', ok('version: 6000'));
  const healthy = () => new FakeFetch(() => new Response('{"status":"ok"}', { status: 200 }));
  const announceOnLaunch = () => {
    launcher.onLaunch = (p) => {
      p.emit(LISTENING);
    };
  };

  it('launches an embedding model for embeddings only: pooled as its entry says, batch as big as its context, no chat template', async () => {
    const runner = llamaInstalled();
    const fake = new FakeFetch(() => new Response('', { status: 200 }));
    launcher.onLaunch = (p) => {
      p.emit(LISTENING);
    };
    const embedding: ServedEntry = {
      ...ENTRY,
      kind: 'embedding',
      id: 'demo-embed',
      serve: { contextSize: 8192, pooling: 'last' },
      embed: { dimensions: 1024, queryTemplate: 'Q:{text}' },
    };
    await server(runner, fake).ensureServing(embedding, CACHED);
    expect(present(launcher.launched[0], 'launcher.launched[0]').args).toEqual([
      '--model',
      '/models/sha256-x/model.gguf',
      '--alias',
      'demo-embed',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--ctx-size',
      '8192',
      '--api-key-file',
      join(logDir, 'model-server.key'),
      '--embeddings',
      '--pooling',
      'last',
      '--ubatch-size',
      '8192',
    ]);
  });

  it('launches llama-server with the exact arguments and becomes ready after /health turns 200', async () => {
    const runner = llamaInstalled();
    const statuses = [503, 200];
    const fake = new FakeFetch(() => new Response('', { status: present(statuses.shift(), 'statuses.shift()') }));
    launcher.onLaunch = (p) => {
      p.emit('build: 6000 (abc)');
      p.emit(LISTENING);
    };

    const endpoint = await server(runner, fake).ensureServing(ENTRY, CACHED);

    expect(endpoint).toEqual({
      baseUrl: BASE_URL,
      model: 'demo-model',
      apiKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(runner.lines()).toEqual(['llama-server --version']);
    expect(launcher.launched).toHaveLength(1);
    const p = present(launcher.launched[0], 'launcher.launched[0]');
    expect(p.command).toBe('llama-server');
    expect(p.args).toEqual([
      '--model',
      '/models/sha256-x/model.gguf',
      '--alias',
      'demo-model',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      // Four slots, each with the entry's 4,096-token context: the pool is 4 × 4,096 (debt D17).
      '--parallel',
      '4',
      '--ctx-size',
      '16384',
      '--api-key-file',
      join(logDir, 'model-server.key'),
      '--jinja',
      '--prefill-assistant',
      // Prompt caching, explicit so the user's LLAMA_ARG_CACHE_* cannot change it (prompt-prefix R9): prefix reuse
      // within a slot and through the host prompt store, never chunk reuse, and the selection threshold pinned.
      '--cache-prompt',
      '--cache-ram',
      String(CHAT_CACHE_RAM_MIB),
      '--cache-idle-slots',
      '--cache-reuse',
      '0',
      '--slot-prompt-similarity',
      '0.10',
    ]);
    // LLAMA_API_KEY in the daemon's environment would add a key; emptied, it adds none.
    expect(p.options.env).toEqual({ LLAMA_API_KEY: '' });
    expect(p.options.logFile).toBe(join(logDir, 'model-server-demo-model.log'));
    expect(fake.requests.map((r) => r.url)).toEqual([`${BASE_URL}/health`, `${BASE_URL}/health`]);
    expect(fake.requests.every((r) => r.init?.signal instanceof AbortSignal)).toBe(true);
    expect(p.signals).toEqual([]);
    expect(logger.entries).toEqual([
      {
        level: 'info',
        event: 'model_server.launching',
        fields: {
          model: 'demo-model',
          weights: '/models/sha256-x/model.gguf',
          logFile: join(logDir, 'model-server-demo-model.log'),
        },
      },
      {
        level: 'info',
        event: 'model_server.ready',
        fields: {
          model: 'demo-model',
          baseUrl: BASE_URL,
          // llama-server's own pid, as the watch's first line names it (the fake's: its own + 50,000); and the watch's.
          pid: present(p.pid, 'pid') + 50_000,
          watchPid: p.pid,
        },
      },
    ]);
  });

  it('is not ready until the watch has named the pid of the llama-server it runs (idle-shutdown R5)', async () => {
    const fake = healthy();
    launcher.namesPid = false;
    announceOnLaunch();

    const error = await server(llamaInstalled(), fake, 300)
      .ensureServing(ENTRY, CACHED)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelServerFailed);
    expect((error as Error).message).toBe(`serving demo-model failed: not healthy within 300 ms:\n${LISTENING}`);
    // Announced but never named: not even polled for health.
    expect(fake.requests).toEqual([]);
    expect(logger.entries.map((e) => e.event)).toEqual(['model_server.launching']);
  });

  it("keeps the host prompt store at 8,192 MiB, the owner's answer to model-server-memory (prompt-prefix R9)", () => {
    expect(CHAT_CACHE_RAM_MIB).toBe(8_192);
  });

  it("reads the port from llama.cpp 0.5.0's announcement, which changed its wording", async () => {
    // llama.cpp 0.5.0 (build 11146, commit 7fe450e19; Homebrew, 2026-09-27) prints this line, where
    // build 8130 printed LISTENING above. Before the fix, a 0.5.0 server was never seen as up.
    const runner = llamaInstalled();
    const fake = healthy();
    launcher.onLaunch = (p) => {
      p.emit('0.02.762.784 I srv  llama_server: listening on http://127.0.0.1:65298');
    };

    const endpoint = await server(runner, fake, 1_000).ensureServing(ENTRY, CACHED);

    expect(endpoint).toEqual({
      baseUrl: 'http://127.0.0.1:65298',
      model: 'demo-model',
      apiKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(fake.requests.map((r) => r.url)).toEqual(['http://127.0.0.1:65298/health']);
  });

  it('returns the same endpoint for a second ensureServing without launching again', async () => {
    const runner = llamaInstalled();
    const fake = healthy();
    announceOnLaunch();
    const s = server(runner, fake);

    const first = await s.ensureServing(ENTRY, CACHED);
    const second = await s.ensureServing(ENTRY, CACHED);

    expect(second).toEqual({ baseUrl: BASE_URL, model: 'demo-model', apiKey: first.apiKey });
    expect(second).toBe(first);
    expect(launcher.launched).toHaveLength(1);
    expect(runner.lines()).toEqual(['llama-server --version']);
    expect(fake.requests).toHaveLength(1);
  });

  it('fails with the log tail when the process exits before becoming healthy', async () => {
    const fake = healthy();
    launcher.onLaunch = (p) => {
      p.emit('llama_model_load: error loading model: invalid magic');
      p.exit(1);
    };

    const error = await server(llamaInstalled(), fake)
      .ensureServing(ENTRY, CACHED)
      .catch((e: unknown) => e);
    await settle();

    expect(error).toBeInstanceOf(ModelServerFailed);
    expect((error as ModelServerFailed).model).toBe('demo-model');
    // The log's tail, from its first line: the watch's naming the pid, then llama-server's own.
    const watchPid = present(present(launcher.launched[0], 'launcher.launched[0]').pid, 'pid');
    expect((error as Error).message).toBe(
      'serving demo-model failed: llama-server exited (code 1, signal null) before becoming healthy:\n' +
        `asha-watch: pid ${String(watchPid + 50_000)}\n` +
        'llama_model_load: error loading model: invalid magic',
    );
    expect(fake.requests).toEqual([]);
    expect(logger.entries.filter((e) => e.level !== 'info')).toEqual([
      { level: 'warn', event: 'model_server.exited', fields: { model: 'demo-model', code: 1, signal: null } },
    ]);
  });

  it('kills the process with SIGKILL when it never announces within readyTimeoutMs', async () => {
    const fake = healthy();
    launcher.onLaunch = (p) => {
      p.emit('loading model…');
    };
    const started = Date.now();

    const error = await server(llamaInstalled(), fake, 100)
      .ensureServing(ENTRY, CACHED)
      .catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(ModelServerFailed);
    const launched = present(launcher.launched[0], 'launcher.launched[0]');
    expect((error as Error).message).toBe(
      `serving demo-model failed: not healthy within 100 ms:\nasha-watch: pid ${String(present(launched.pid, 'pid') + 50_000)}\nloading model…`,
    );
    // SIGKILL, which the launcher sends to the watch's whole group: llama-server with it.
    expect(launched.signals).toEqual(['SIGKILL']);
    expect(fake.requests).toEqual([]);
  });

  it('launches again after a failed start', async () => {
    const fake = healthy();
    let attempt = 0;
    launcher.onLaunch = (p) => {
      attempt += 1;
      if (attempt === 1) p.exit(1);
      else p.emit(LISTENING);
    };
    const s = server(llamaInstalled(), fake);

    await expect(s.ensureServing(ENTRY, CACHED)).rejects.toBeInstanceOf(ModelServerFailed);
    await expect(s.ensureServing(ENTRY, CACHED)).resolves.toEqual({
      baseUrl: BASE_URL,
      model: 'demo-model',
      apiKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(launcher.launched).toHaveLength(2);
  });

  it('requires a fresh key it writes 0600 over a leftover file, sends it only by file, and the gateway sends it (A8)', async () => {
    const keyFile = join(logDir, 'model-server.key');
    const leftover = 'f'.repeat(64);
    await writeFile(keyFile, `${leftover}\n`, { mode: 0o644 });
    const fake = new FakeFetch((url) =>
      url.endsWith('/health') ? new Response('{"status":"ok"}', { status: 200 }) : sseResponse({ content: ['hi'] }),
    );
    announceOnLaunch();

    const endpoint = await server(llamaInstalled(), fake).ensureServing(ENTRY, CACHED);

    const args = present(launcher.launched[0], 'launcher.launched[0]').args;
    expect(args.slice(args.indexOf('--api-key-file'), args.indexOf('--api-key-file') + 2)).toEqual([
      '--api-key-file',
      keyFile,
    ]);
    expect(args).not.toContain('--api-key');
    expect(args.join(' ')).not.toContain(endpoint.apiKey);
    expect(((await stat(keyFile)).mode & 0o777).toString(8), 'model-server.key mode').toBe('600');
    const key = (await readFile(keyFile, 'utf8')).trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(leftover);
    expect(endpoint.apiKey).toBe(key);
    // The readiness poll sends no key: llama-server leaves /health open.
    expect(fake.requests.map((r) => [r.url, new Headers(r.init?.headers).get('authorization')])).toEqual([
      [`${BASE_URL}/health`, null],
    ]);

    await chatCompletion({
      fetch: fake.fetch,
      endpoint,
      chatDefaults: {},
      toolCallStart: '<tool_call>\n',
      request: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
    });
    const secondRequest = present(fake.requests[1], 'fake.requests[1]');
    expect(secondRequest.url).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(new Headers(secondRequest.init?.headers).get('authorization')).toBe(`Bearer ${key}`);
    expect(logger.entries.map((e) => JSON.stringify(e)).join('\n')).not.toContain(key);
  });

  it('shares one key across every server it starts, removes the file at stopAll, and uses a new one after', async () => {
    const keyFile = join(logDir, 'model-server.key');
    announceOnLaunch();
    const s = server(llamaInstalled(), healthy());
    const chat = await s.ensureServing(ENTRY, CACHED);
    const embed = await s.ensureServing({ ...ENTRY, id: 'demo-embed' }, CACHED);
    expect(embed.apiKey).toBe(chat.apiKey);

    const stopping = s.stopAll();
    for (const p of launcher.launched) p.exit(0);
    await stopping;
    await expect(stat(keyFile)).rejects.toThrow('ENOENT');

    const again = await s.ensureServing(ENTRY, CACHED);
    expect(again.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(again.apiKey).not.toBe(chat.apiKey);
    expect((await readFile(keyFile, 'utf8')).trim()).toBe(again.apiKey);
  });

  it('stopAll sends SIGTERM, waits for the exit, and logs stopped — not an unexpected exit', async () => {
    announceOnLaunch();
    const s = server(llamaInstalled(), healthy());
    await s.ensureServing(ENTRY, CACHED);
    const p: FakeProcess = present(launcher.launched[0], 'launcher.launched[0]');
    logger.entries.length = 0;

    const stopping = s.stopAll();
    expect(p.signals).toEqual(['SIGTERM']);
    p.exit(null, 'SIGTERM');
    await stopping;
    await settle();

    expect(p.signals).toEqual(['SIGTERM']);
    expect(logger.entries).toEqual([{ level: 'info', event: 'model_server.stopped', fields: { model: 'demo-model' } }]);
  });

  it('warns on an exit nobody asked for, and serves again by relaunching', async () => {
    announceOnLaunch();
    const s = server(llamaInstalled(), healthy());
    await s.ensureServing(ENTRY, CACHED);
    logger.entries.length = 0;

    present(launcher.launched[0], 'launcher.launched[0]').exit(-1, 'SIGSEGV');
    await settle();

    expect(logger.entries).toEqual([
      { level: 'warn', event: 'model_server.exited', fields: { model: 'demo-model', code: -1, signal: 'SIGSEGV' } },
    ]);
    await expect(s.ensureServing(ENTRY, CACHED)).resolves.toEqual({
      baseUrl: BASE_URL,
      model: 'demo-model',
      apiKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(launcher.launched).toHaveLength(2);
  });

  // docs/plans/portal-demo-stop.md R3.
  it('stopIdle stops each server no agent needs and logs stopped_idle, keeps one in use, and a later ensureServing starts it again', async () => {
    announceOnLaunch();
    const s = server(llamaInstalled(), healthy());
    const OTHER: ServedEntry = { ...ENTRY, id: 'other-model' };
    await s.ensureServing(ENTRY, CACHED);
    await s.ensureServing(OTHER, CACHED);
    const [idle, used] = [
      present(launcher.launched[0], 'launcher.launched[0]'),
      present(launcher.launched[1], 'launcher.launched[1]'),
    ];
    logger.entries.length = 0;

    const stopping = s.stopIdle(() => new Set(['other-model']));
    await settle();
    expect(idle.signals).toEqual(['SIGTERM']);
    expect(used.signals).toEqual([]);
    idle.exit(null, 'SIGTERM');
    await expect(stopping).resolves.toEqual(['demo-model']);
    await settle();

    expect(logger.entries).toEqual([
      { level: 'info', event: 'model_server.stopped_idle', fields: { model: 'demo-model' } },
    ]);
    await s.ensureServing(ENTRY, CACHED);
    expect(launcher.launched).toHaveLength(3);
  });

  it('stopIdle awaits a server still starting, then reads inUse again: one a launch took meanwhile is kept', async () => {
    const s = server(llamaInstalled(), healthy());
    const serving = s.ensureServing(ENTRY, CACHED);
    await vi.waitFor(() => {
      expect(launcher.launched).toHaveLength(1);
    });
    const p = present(launcher.launched[0], 'launcher.launched[0]');
    const used = new Set<string>();

    const stopping = s.stopIdle(() => used);
    used.add('demo-model');
    p.emit(LISTENING);
    await serving;

    await expect(stopping).resolves.toEqual([]);
    expect(p.signals).toEqual([]);
  });

  it("stopIdle's server, once stopped, never takes its successor under the same id with it as it exits", async () => {
    announceOnLaunch();
    const s = server(llamaInstalled(), healthy());
    await s.ensureServing(ENTRY, CACHED);
    const old = present(launcher.launched[0], 'launcher.launched[0]');

    const stopping = s.stopIdle(() => new Set());
    await settle();
    expect(old.signals).toEqual(['SIGTERM']);
    // A launch asks for the model while the old server is still exiting: a new one starts.
    const successor = await s.ensureServing(ENTRY, CACHED);
    expect(launcher.launched).toHaveLength(2);
    old.exit(null, 'SIGTERM');
    await stopping;
    await settle();

    await expect(s.ensureServing(ENTRY, CACHED)).resolves.toBe(successor);
    expect(launcher.launched).toHaveLength(2);
    expect(logger.events('warn')).toEqual([]);
  });

  it('runs every llama-server under the watch that ends it with its daemon (idle-shutdown R5)', async () => {
    announceOnLaunch();
    await server(llamaInstalled(), healthy()).ensureServing(ENTRY, CACHED);
    expect(present(launcher.launched[0], 'launcher.launched[0]').options.dieWithParent).toBe(true);
  });

  describe('lease and unloadIdle (idle-shutdown R1, R2)', () => {
    /** A server on a clock the test moves, one model served at t = 1,000,000. */
    async function served() {
      announceOnLaunch();
      const clock = { now: 1_000_000 };
      const s = server(llamaInstalled(), healthy(), 5_000, () => clock.now);
      await s.ensureServing(ENTRY, CACHED);
      logger.entries.length = 0;
      return { s, clock, first: present(launcher.launched[0], 'launcher.launched[0]') };
    }

    it('unloads a model idle for exactly MODEL_IDLE_UNLOAD_MS since it became ready, not 1 ms before, and logs it', async () => {
      const { s, clock, first } = await served();
      clock.now += 899_999;
      await expect(s.unloadIdle(900_000)).resolves.toEqual([]);
      expect(first.signals).toEqual([]);
      clock.now += 1;
      const unloading = s.unloadIdle(900_000);
      await settle();
      expect(first.signals).toEqual(['SIGTERM']);
      first.exit(143, null);
      await expect(unloading).resolves.toEqual(['demo-model']);
      expect(logger.entries).toEqual([
        { level: 'info', event: 'model_server.unloaded_idle', fields: { model: 'demo-model', idleMs: 900_000 } },
      ]);
    });

    it('never unloads a model a lease holds, however long; its idle time counts from the release', async () => {
      const { s, clock, first } = await served();
      const lease = await s.lease(ENTRY, CACHED);
      expect(lease.endpoint).toEqual({
        baseUrl: BASE_URL,
        model: 'demo-model',
        apiKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      });
      clock.now += 3_600_000;
      await expect(s.unloadIdle(900_000)).resolves.toEqual([]);
      lease.release();
      lease.release(); // a second release changes nothing
      clock.now += 899_999;
      await expect(s.unloadIdle(900_000)).resolves.toEqual([]);
      expect(first.signals).toEqual([]);
      expect(launcher.launched).toHaveLength(1);
    });

    it('a lease after an unload starts the model again on a new server, and the old one is never handed out', async () => {
      const { s, clock, first } = await served();
      clock.now += 900_000;
      const unloading = s.unloadIdle(900_000);
      await settle();
      const leasing = s.lease(ENTRY, CACHED);
      first.exit(143, null);
      await unloading;
      const lease = await leasing;
      expect(launcher.launched).toHaveLength(2);
      expect(lease.endpoint.baseUrl).toBe(BASE_URL);
      lease.release();
      expect(present(launcher.launched[1], 'launcher.launched[1]').signals).toEqual([]);
    });

    it('logs model_server.reloaded with how long a lease waited for the model it had to start', async () => {
      const { s, clock, first } = await served();
      clock.now += 900_000;
      const unloading = s.unloadIdle(900_000);
      first.exit(143, null);
      await unloading;
      logger.entries.length = 0;
      launcher.onLaunch = () => undefined;
      const leasing = s.lease(ENTRY, CACHED);
      await vi.waitFor(() => {
        expect(launcher.launched).toHaveLength(2);
      });
      clock.now += 4_000;
      present(launcher.launched[1], 'launcher.launched[1]').emit(LISTENING);
      const lease = await leasing;
      expect(logger.entries.map((e) => [e.event, e.fields])).toEqual([
        ['model_server.launching', expect.anything()],
        ['model_server.ready', expect.anything()],
        ['model_server.reloaded', { model: 'demo-model', ms: 4_000 }],
      ]);
      // A lease of a model already served waits for nothing, and says so by logging nothing.
      logger.entries.length = 0;
      lease.release();
      (await s.lease(ENTRY, CACHED)).release();
      expect(logger.entries).toEqual([]);
    });

    it('holdServer holds the server named only while it is the one serving, and never starts one', async () => {
      const { s, clock, first } = await served();
      const firstLease = await s.lease(ENTRY, CACHED);
      firstLease.release();
      const held = present(s.holdServer('demo-model', firstLease.server), 'a hold on the serving server');
      expect(held.endpoint).toEqual(firstLease.endpoint);
      expect(held.server).toBe(firstLease.server);
      // Held: never unloaded.
      clock.now += 900_000;
      await expect(s.unloadIdle(900_000)).resolves.toEqual([]);
      held.release();
      clock.now += 900_000;
      const unloading = s.unloadIdle(900_000);
      first.exit(143, null);
      await expect(unloading).resolves.toEqual(['demo-model']);
      // Unloaded: no hold, and no server started for one.
      expect(s.holdServer('demo-model', firstLease.server)).toBeUndefined();
      expect(launcher.launched).toHaveLength(1);
      // Started again: a new server, whose number the old one's hold does not name.
      const second = await s.lease(ENTRY, CACHED);
      expect(second.server).not.toBe(firstLease.server);
      expect(s.holdServer('demo-model', firstLease.server)).toBeUndefined();
      expect(s.holdServer('demo-model', second.server)?.server).toBe(second.server);
      expect(s.holdServer('other-model', second.server)).toBeUndefined();
    });

    it('holdServer refuses a server still starting', async () => {
      const s = server(llamaInstalled(), healthy());
      const serving = s.ensureServing(ENTRY, CACHED);
      await vi.waitFor(() => {
        expect(launcher.launched).toHaveLength(1);
      });
      // The first server this instance launches is number 1.
      expect(s.holdServer('demo-model', 1)).toBeUndefined();
      present(launcher.launched[0], 'launcher.launched[0]').emit(LISTENING);
      await serving;
      expect(s.holdServer('demo-model', 1)?.server).toBe(1);
    });

    it('stopIdle never stops a server a lease holds; once released, it does', async () => {
      const { s, first } = await served();
      const lease = await s.lease(ENTRY, CACHED);
      await expect(s.stopIdle(() => new Set())).resolves.toEqual([]);
      expect(first.signals).toEqual([]);
      lease.release();
      const stopping = s.stopIdle(() => new Set());
      await settle();
      expect(first.signals).toEqual(['SIGTERM']);
      first.exit(143, null);
      await expect(stopping).resolves.toEqual(['demo-model']);
    });

    it('stopAll waits for an idle unload already under way', async () => {
      const { s, clock, first } = await served();
      clock.now += 900_000;
      const unloading = s.unloadIdle(900_000);
      await settle();
      expect(first.signals).toEqual(['SIGTERM']);
      let stopped = false;
      const stopping = s.stopAll().then(() => {
        stopped = true;
      });
      // Long past its own work (the key file's removal takes about a millisecond): it is the unload it waits for.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stopped).toBe(false);
      first.exit(143, null);
      await stopping;
      await unloading;
      expect(stopped).toBe(true);
    });
  });

  it('installs llama.cpp with Homebrew when llama-server is missing', async () => {
    const runner = new FakeRunner()
      .on('llama-server --version', 'not-found', ok('version: 6000'))
      .on('brew --version', ok('Homebrew 6'))
      .on('brew install llama.cpp', ok());
    announceOnLaunch();

    await expect(server(runner, healthy()).ensureServing(ENTRY, CACHED)).resolves.toEqual({
      baseUrl: BASE_URL,
      model: 'demo-model',
      apiKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });

    expect(runner.lines()).toEqual([
      'llama-server --version',
      'brew --version',
      'brew install llama.cpp',
      'llama-server --version',
    ]);
    expect(logger.entries.slice(0, 2)).toEqual([
      { level: 'info', event: 'host_tool.installing', fields: { tool: 'llama-server', formula: 'llama.cpp' } },
      { level: 'info', event: 'host_tool.installed', fields: { tool: 'llama-server', formula: 'llama.cpp' } },
    ]);
    expect(launcher.launched).toHaveLength(1);
  });
});
