// The portal's daemon side over the real wire (docs/plans/portal.md A2, A6, A11, A15, A22): the page's files and
// their headers, the failure-report route and its bounds, telemetry against the trace file, the stop route and the
// one stop trigger, and an upload refused for holding asha's credential — through the CLI — with every way a refused
// body's drain can end. The daemon is the real one, with the integration tier's fakes (tests/helpers/portal-harness.ts).

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startDaemon } from '../../src/daemon/compose.js';
import { DRAIN_MAX_BYTES, UPLOAD_STALL_MS } from '../../src/daemon/files/index.js';
import { PORTAL_CSP, PORTAL_MODULES, PORTAL_STATIC_FILES, PortalFileMissing } from '../../src/daemon/portal/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { harnessPaths } from '../../src/shared/paths.js';
import { Routes, type TelemetryResponse } from '../../src/shared/protocol.js';
import { FakeModelServer, FakeRuntime, FakeStore, REAL_STATE, TEST_LIFETIME } from '../helpers/daemon-fakes.js';
import { ManualSchedule, RecordingLogger } from '../helpers/fakes.js';
import { builtPortal, portalStub } from '../helpers/portal-folders.js';
import { portalHarness, type PortalHarness } from '../helpers/portal-harness.js';

let h: PortalHarness;
beforeEach(async () => {
  h = await portalHarness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});

/** A request sent exactly as given — its path not normalised, as fetch would — answered with its status, headers and body. */
function raw(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: h.daemon.port, method, path, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        resolve({
          status: present(res.statusCode, 'res.statusCode'),
          headers: res.headers,
          body: Buffer.concat(parts),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const control = (path: string, init: RequestInit = {}) =>
  fetch(`${h.base}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${h.credential}` },
  });
const report = (body: unknown) =>
  control(Routes.portalErrors, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const clientErrors = () =>
  h.logger.entries.filter((e) => e.event === 'portal.client_error' || e.event === 'portal.client_error_dropped');

/** The content type the portal serves a static file under, by its extension. */
function staticFileType(name: string): string {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'image/svg+xml';
}

describe("the portal's files (A2; R2, R13)", () => {
  it('serves / and every allow-listed file byte for byte, with its type, no-store, nosniff and the policy, and no credential', async () => {
    const folders = builtPortal();
    const served: [string, string, string][] = [
      ['/', join(folders.staticDir, 'index.html'), 'text/html; charset=utf-8'],
      ...PORTAL_STATIC_FILES.map((n): [string, string, string] => [
        `/portal/static/${n}`,
        join(folders.staticDir, n),
        staticFileType(n),
      ]),
      ...PORTAL_MODULES.map((p): [string, string, string] => [
        `/portal/js/${p}`,
        join(folders.modulesDir, p),
        'text/javascript; charset=utf-8',
      ]),
    ];
    const wrong: string[] = [];
    for (const [path, file, type] of served) {
      const answer = await raw('GET', path);
      const expected = await readFile(file);
      const ok =
        answer.status === 200 &&
        answer.body.equals(expected) &&
        answer.headers['content-type'] === type &&
        answer.headers['cache-control'] === 'no-store' &&
        answer.headers['x-content-type-options'] === 'nosniff' &&
        answer.headers['content-security-policy'] === PORTAL_CSP &&
        !answer.body.toString('latin1').includes(h.credential);
      if (!ok) wrong.push(`${path}: ${String(answer.status)} ${String(answer.headers['content-type'])}`);
    }
    expect(wrong).toEqual([]);
    expect(served).toHaveLength(1 + PORTAL_STATIC_FILES.length + PORTAL_MODULES.length);
    expect(PORTAL_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it('answers 404, with the policy, to every other path outside /v1/ and /agent/ — a path out of the build, an unlisted module, anything else', async () => {
    const paths = [
      '/portal/js/../../src/cli/main.js',
      '/portal/js/%2e%2e/%2e%2e/src/cli/main.js',
      '/portal/js/x.js',
      '/portal/js/portal/',
      '/portal/static/../package.json',
      '/x',
      '/index.html',
      '/daemon.json',
    ];
    const answers = await Promise.all(paths.map(async (p) => [p, (await raw('GET', p)).status] as const));
    expect(answers.filter(([, status]) => status !== 404)).toEqual([]);
    const post = await raw('POST', '/');
    expect([post.status, post.headers['content-security-policy']]).toEqual([404, PORTAL_CSP]);
  });

  it("refuses the page's files to a foreign Host, a foreign Origin and another port's Origin, as every request is (R7), with the policy (R13)", async () => {
    const port = h.daemon.port;
    const other = port === 65_535 ? port - 1 : port + 1;
    const answered: string[] = [];
    for (const path of ['/', '/portal/static/portal.css', '/portal/js/portal/app.js']) {
      for (const [what, headers] of [
        ['foreign Host', { host: `evil.example:${String(port)}` }],
        ['foreign Origin', { origin: 'http://evil.example' }],
        ["another port's Origin", { origin: `http://127.0.0.1:${String(other)}` }],
      ] as const) {
        const answer = await raw('GET', path, headers);
        answered.push(
          `${path} ${what}: ${String(answer.status)} ${answer.headers['content-security-policy'] === PORTAL_CSP ? 'policy' : 'no policy'}`,
        );
      }
      // The daemon's own Host and Origin: served.
      expect((await raw('GET', path, { origin: `http://127.0.0.1:${String(port)}` })).status).toBe(200);
    }
    expect(answered.filter((line) => !line.endsWith(': 403 policy'))).toEqual([]);
    expect(answered).toHaveLength(9);
  });

  it('a daemon whose portal folder lacks an allow-listed file does not start, logging daemon.start_failed with its path', async () => {
    const folders = await portalStub();
    const missing = join(folders.modulesDir, 'portal', 'scene-sim.js');
    await rm(missing);
    const home = await mkdtemp(join(tmpdir(), 'asha-portal-missing-'));
    const logger = new RecordingLogger();
    const started = startDaemon({
      paths: harnessPaths({ ASHA_HOME: home }),
      root: h.root,
      version: 't',
      build: 't',
      pid: process.pid,
      logger,
      dependencies: {
        runtime: new FakeRuntime('127.0.0.1'),
        modelServer: new FakeModelServer('http://127.0.0.1:1'),
        store: new FakeStore(),
        ...REAL_STATE,
        fetch: globalThis.fetch,
      },
      heartbeatMs: 1_000,
      chatTimeoutMs: 1_000,
      schedule: new ManualSchedule().schedule,
      lifetime: TEST_LIFETIME,
      portal: folders,
    });
    await expect(started).rejects.toBeInstanceOf(PortalFileMissing);
    expect(logger.entries.map((e) => [e.level, e.event, e.fields['path']])).toEqual([
      ['error', 'daemon.start_failed', missing],
    ]);
    // Nothing was held: no daemon file, no lock.
    expect((await readdir(home)).filter((f) => f === 'daemon.json' || f === 'daemon.lock')).toEqual([]);
  });
});

describe('the failure-report route (A6; R6)', () => {
  it("204 for a report, logged portal.client_error at error with its two fields, and the facade's error naming them", async () => {
    const answer = await report({ reason: 'bad_status', detail: '/v1/state 500' });
    expect(answer.status).toBe(204);
    expect(
      clientErrors().map((e) => [
        e.level,
        e.event,
        e.fields['reason'],
        e.fields['detail'],
        Object.keys(e.fields).sort(byCodeUnit),
      ]),
    ).toEqual([['error', 'portal.client_error', 'bad_status', '/v1/state 500', ['detail', 'error', 'reason']]]);
  });

  it('413 for a body of 4,097 bytes; 400 for an unknown reason, an extra field, a detail over 200 characters; none logged as a client error', async () => {
    const big = JSON.stringify({ reason: 'exception', detail: 'x'.repeat(4_097 - 34) });
    expect(Buffer.byteLength(big)).toBe(4_097);
    const answers = [
      (await report(big)).status,
      (await report({ reason: 'nope', detail: 'x' })).status,
      (await report({ reason: 'exception', detail: 'x', extra: 1 })).status,
      (await report({ reason: 'exception', detail: 'x'.repeat(201) })).status,
      (await report('not json')).status,
    ];
    expect(answers).toEqual([413, 400, 400, 400, 400]);
    expect(clientErrors()).toEqual([]);
  });

  it('logs ten reports a window, then the dropped count when the window ends', async () => {
    for (let i = 0; i < 12; i += 1)
      expect((await report({ reason: 'timeout', detail: `/v1/telemetry ${String(i)}` })).status).toBe(204);
    expect(clientErrors().map((e) => e.event)).toEqual(Array(10).fill('portal.client_error'));
    h.clock.fire();
    expect(
      clientErrors()
        .slice(10)
        .map((e) => [e.level, e.event, e.fields]),
    ).toEqual([['warn', 'portal.client_error_dropped', { count: 2 }]]);
  });

  it('logs the dropped count at closeServer when the daemon stops before the window ends', async () => {
    for (let i = 0; i < 12; i += 1) await report({ reason: 'timeout', detail: `x ${String(i)}` });
    await h.close();
    const events = h.logger.events();
    expect(
      clientErrors()
        .slice(10)
        .map((e) => [e.event, e.fields]),
    ).toEqual([['portal.client_error_dropped', { count: 2 }]]);
    // Before the daemon's last steps: the server was closed then.
    expect(events.indexOf('portal.client_error_dropped')).toBeLessThan(events.indexOf('daemon.stopped'));
    // Its window's timer was cleared: firing it now logs nothing more.
    h.clock.fire();
    expect(clientErrors()).toHaveLength(11);
  });
});

describe('telemetry against the trace file (A11; R10)', () => {
  it("each count equals what the trace file's daemon records say for that handle, a forced model failure's reason included; channel=Bad is 400", async () => {
    expect(
      (await h.cli(['user=alice', 'recipe=hello-world', 'channel=lab', 'message=Please say: Hello World.'])).code,
    ).toBe(0);
    // A forced model failure: the model server answers 500. The agent then holds its delivery until it expires, so the
    // telemetry is read as soon as the failed call's span is recorded, while the agent is still online.
    h.answer = () => 'fail';
    const failing = h.cli(['user=alice', 'channel=lab', 'message=again']);
    let answer: TelemetryResponse | undefined;
    await vi.waitFor(
      async () => {
        answer = (await (await control(`${Routes.telemetry}?channel=lab`)).json()) as TelemetryResponse;
        expect(answer.agents[0]?.lastError?.span).toBe('asha.chat');
      },
      { timeout: 5_000, interval: 50 },
    );
    const logs = h.paths.logsDir;
    const lines = (
      await Promise.all(
        (await readdir(logs)).filter((f) => f.startsWith('traces-')).map((f) => readFile(join(logs, f), 'utf8')),
      )
    )
      .join('')
      .split('\n')
      .filter((l) => l !== '');
    const records = lines
      .map(
        (l) =>
          JSON.parse(l) as {
            name: string;
            handle: string;
            channel: string;
            start: string;
            end: string;
            status: string;
            reason: string | null;
          },
      )
      .filter((r) => r.name.startsWith('asha.') && r.handle === 'hewo-1' && r.channel === 'lab');
    const calls = records.filter((r) => r.name === 'asha.chat' || r.name === 'asha.embed');
    const errors = records.filter((r) => r.status === 'error');
    const last = present(calls.at(-1), 'last call');
    const lastError = present(errors.at(-1), 'last error');
    expect(answer).toEqual({
      channel: 'lab',
      agents: [
        {
          handle: 'hewo-1',
          recipe: 'hello-world',
          // A recipe launched alone: no team (portal-scene-chat R7).
          team: null,
          model: 'tiny-model',
          deliveries: records.filter((r) => r.name === 'asha.delivery').length,
          modelCalls: calls.length,
          lastModelCallMs: Date.parse(last.end) - Date.parse(last.start),
          modelCallsInFlight: 0,
          lastError: { span: lastError.name, reason: lastError.reason, at: lastError.end },
        },
      ],
    });
    expect(present(answer, 'answer').agents[0]).toMatchObject({
      deliveries: 1,
      modelCalls: 2,
      lastError: { span: 'asha.chat', reason: lastError.reason },
    });
    expect((await control(`${Routes.telemetry}?channel=Bad`)).status).toBe(400);
    // A channel nothing has used: no agents, and the poll creates none (Channels.existing).
    expect(await (await control(`${Routes.telemetry}?channel=ghost`)).json()).toEqual({ channel: 'ghost', agents: [] });
    // The failing message ends when the daemon stops (sooner than its delivery's 20 s bound), its stream cut.
    await h.close();
    expect((await failing).code).toBe(1);
  });
});

describe('the stop route and the one stop trigger (A15; R14)', () => {
  it('202 {pid}, then the stop: logged source portal once; a second request 503 and unlogged; a signal after it ignored; the agent stopped, the stop run once', async () => {
    expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=lab'])).code).toBe(0);
    // The agent's stop is held, so the server is still open for the second request: without the hold the test raced
    // the server's close, and lost once debt-paydown R14 took an await out of the stop's first step.
    const held = h.holdStop();
    const first = await control(Routes.stop, { method: 'POST' });
    expect([first.status, await first.json()]).toEqual([202, { pid: process.pid }]);
    const second = await control(Routes.stop, { method: 'POST' });
    // reason stopping: what tells the CLI a stopping daemon from an absent one (debt-paydown R15).
    expect([second.status, await second.json()]).toEqual([
      503,
      { error: 'the daemon is stopping', reason: 'stopping' },
    ]);
    h.daemon.requestStop({ source: 'signal', signal: 'SIGTERM' });
    held.release();
    await h.daemon.stopped;
    expect(h.logger.entries.filter((e) => e.event === 'daemon.stop_requested').map((e) => e.fields)).toEqual([
      { source: 'portal' },
      { source: 'signal', signal: 'SIGTERM', ignored: true },
    ]);
    expect(h.logger.events().filter((e) => e === 'daemon.stopping' || e === 'daemon.stopped')).toEqual([
      'daemon.stopping',
      'daemon.stopped',
    ]);
    expect(h.runtime.calls.filter((c) => c.startsWith('stop '))).toHaveLength(1);
  });
});

describe('a stop that fails (R14)', () => {
  it('a stop that fails is logged daemon.stop_failed with its source, findable at error', async () => {
    h.runtime.reclaim = () => Promise.reject(new Error('the reclaim failed, as the test asked'));
    expect((await control(Routes.stop, { method: 'POST' })).status).toBe(202);
    await expect(h.daemon.stopped).rejects.toThrow('the reclaim failed, as the test asked');
    const failed = h.logger.entries.filter((e) => e.event === 'daemon.stop_failed');
    expect(
      failed.map((e) => [e.level, e.fields['source'], e.fields['signal'], (e.fields['error'] as Error).message]),
    ).toEqual([['error', 'portal', null, 'the reclaim failed, as the test asked']]);
    await expect(h.close()).rejects.toThrow('the reclaim failed');
  });
});

describe("an upload holding asha's credential, and the drain of a refused body (A22; R8b)", () => {
  it('the CLI attaching a copy of daemon.json made outside ASHA_HOME: the daemon refuses it, the credential in no record, no trace and no answer', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'asha-outside-'));
    await copyFile(h.paths.daemonFile, join(outside, 'daemon-copy.json'));
    const run = await h.cli(
      [
        'user=alice',
        'recipe=hello-world',
        'channel=lab',
        `file=${join(outside, 'daemon-copy.json')}`,
        'message=read it',
      ],
      { cwd: outside },
    );
    expect([run.code, run.err, run.out]).toEqual([
      1,
      "✗ upload to channel lab: 400 holds_asha_secret: daemon-copy.json holds asha's control credential\n",
      '',
    ]);
    expect(h.logger.events()).not.toContain('conversation.started');
    const drained = h.logger.entries.filter((e) => e.event === 'files.body_drained');
    expect(drained.map((e) => [e.level, e.fields['status'], e.fields['outcome']])).toEqual([['info', 400, 'ended']]);
    const logs = await readdir(h.paths.logsDir);
    for (const file of logs.filter((f) => f.endsWith('.jsonl')))
      expect(await readFile(join(h.paths.logsDir, file), 'utf8')).not.toContain(h.credential);
    expect(logs).toContain('daemon.jsonl');
  });

  it("the file first of two, the second 25,000,000 bytes: the CLI shows the refusal within 5,000 ms; Node's fetch stops sending once answered, so the drain ends hung_up", async () => {
    const outside = await mkdtemp(join(tmpdir(), 'asha-outside-'));
    await copyFile(h.paths.daemonFile, join(outside, 'daemon-copy.json'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(outside, 'big.bin'), Buffer.alloc(25_000_000, 0x61));
    const started = performance.now();
    const run = await h.cli(
      [
        'user=alice',
        'recipe=hello-world',
        'channel=lab',
        `file=${join(outside, 'daemon-copy.json')}`,
        `file=${join(outside, 'big.bin')}`,
        'message=both',
      ],
      { cwd: outside },
    );
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(run.err).toBe(
      "✗ upload to channel lab: 400 holds_asha_secret: daemon-copy.json holds asha's control credential\n",
    );
    // Measured 2026-10-02: undici sends no more of a request body once its answer is complete, and closes it; a browser
    // sends it whole (the page's case, portal-browser.test.ts, ends 'ended').
    await vi.waitFor(
      () => {
        expect(
          h.logger.entries
            .filter((e) => e.event === 'files.body_drained')
            .map((e) => [e.level, e.fields['status'], e.fields['outcome']]),
        ).toEqual([['warn', 400, 'hung_up']]);
      },
      { timeout: 4_000 },
    );
  });

  /**
   * An upload begun by hand on a raw socket, its body `length` bytes long: the manifest line, then whatever the test
   * writes. A raw socket, as a browser does, sends its whole body whatever the answer: Node's http client and fetch stop
   * sending once their answer is complete. `answer` is the status line's status, as soon as it comes.
   */
  function upload(
    channel: string,
    manifest: string,
    length = 100_000_000,
  ): {
    socket: Socket;
    answer: Promise<number>;
    closed: Promise<void>;
    write: (bytes: Buffer | string) => Promise<void>;
  } {
    const socket = connect({ host: '127.0.0.1', port: h.daemon.port });
    let seen = '';
    const answer = new Promise<number>((resolve, reject) => {
      socket.on('data', (c: Buffer) => {
        seen += c.toString('latin1');
        const m = /^HTTP\/1\.1 (\d{3})/.exec(seen);
        if (m !== null) resolve(Number(m[1]));
      });
      socket.on('error', (error) => {
        reject(error);
      });
    });
    // A write the server refuses by closing (over_bound) is not this test's failure: it is what the test waits to see.
    socket.on('error', () => undefined);
    const closed = new Promise<void>((resolve) =>
      socket.on('close', () => {
        resolve();
      }),
    );
    socket.write(
      `POST ${Routes.channelFiles}?channel=${channel}&user=alice HTTP/1.1\r\nHost: 127.0.0.1:${String(h.daemon.port)}\r\nAuthorization: Bearer ${h.credential}\r\n` +
        `Content-Type: application/octet-stream\r\nContent-Length: ${String(length)}\r\n\r\n${manifest}\n`,
    );
    const write = (bytes: Buffer | string) =>
      new Promise<void>((resolve) => {
        if (socket.destroyed || socket.write(bytes)) resolve();
        else
          socket.once('drain', () => {
            resolve();
          });
      });
    return { socket, answer, closed, write };
  }
  /** Waits, without moving the faked clock (vi.waitFor would advance it), until the refusal is logged. */
  async function refused(): Promise<void> {
    while (!h.logger.events().includes('files.refused')) await new Promise((resolve) => setImmediate(resolve));
    // The drain begins once the refusal is answered: a few turns of the loop.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  const MANIFEST = JSON.stringify([{ name: 'a.bin', size: 25_000_000, sha256: 'a'.repeat(64) }]);
  const drains = () =>
    h.logger.entries.filter((e) => e.event === 'files.body_drained').map((e) => [e.level, e.fields['outcome']]);

  it('a client that stops sending after the refusal: stalled at UPLOAD_STALL_MS (manual clock), the connection closed', async () => {
    // The clock the drain's bounds are read on, faked before the upload begins.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { answer, closed, write } = upload('nospace', MANIFEST);
    await write(Buffer.alloc(1_000));
    expect(await answer).toBe(409);
    await refused();
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);
    expect(drains()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await closed;
    expect(drains()).toEqual([['warn', 'stalled']]);
  });

  it('a client that keeps sending a byte every 20 s: over_time at 60,000 ms (manual clock), the connection closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { answer, closed, write } = upload('nospace', MANIFEST);
    expect(await answer).toBe(409);
    await refused();
    for (let t = 0; t < 2; t += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      await write('x');
      // The byte read before the clock moves on.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(19_999);
    expect(drains()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await closed;
    expect(drains()).toEqual([['warn', 'over_time']]);
  });

  it('a client that hangs up during the drain: hung_up', async () => {
    const { socket, answer } = upload('nospace', MANIFEST);
    expect(await answer).toBe(409);
    socket.destroy();
    await vi.waitFor(
      () => {
        expect(drains()).toEqual([['warn', 'hung_up']]);
      },
      { timeout: 5_000 },
    );
  });

  it(`a body of exactly ${String(DRAIN_MAX_BYTES)} bytes is drained to its end; one byte more is over_bound`, async () => {
    expect(DRAIN_MAX_BYTES).toBe(250_008_192);
    for (const [extra, outcome] of [
      [0, 'ended'],
      [1, 'over_bound'],
    ] as const) {
      h.logger.entries.length = 0;
      const { socket, answer, write } = upload('nospace', MANIFEST, DRAIN_MAX_BYTES + extra);
      const rest = DRAIN_MAX_BYTES + extra - Buffer.byteLength(`${MANIFEST}\n`);
      const block = Buffer.alloc(1 << 20, 0x62);
      for (let sent = 0; sent < rest && !socket.destroyed; sent += block.length)
        await write(sent + block.length > rest ? block.subarray(0, rest - sent) : block);
      expect(await answer).toBe(409);
      await vi.waitFor(
        () => {
          expect(drains()).toEqual([[outcome === 'ended' ? 'info' : 'warn', outcome]]);
        },
        {
          timeout: 20_000,
        },
      );
    }
  }, 120_000);

  it('the daemon stopped during a drain: the drain ends closed, and the daemon stops', async () => {
    const { answer, write } = upload('nospace', MANIFEST);
    await write(Buffer.alloc(10));
    expect(await answer).toBe(409);
    await h.close();
    expect(drains()).toEqual([['warn', 'closed']]);
    expect(h.logger.events()).toContain('daemon.stopped');
  });

  it('twelve refused uploads on one kept-alive connection, each drained to its end, leave no listener behind (no MaxListeners warning)', async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      const socket = connect({ host: '127.0.0.1', port: h.daemon.port });
      let seen = '';
      socket.on('data', (c: Buffer) => (seen += c.toString('latin1')));
      const body = `${MANIFEST}\n`;
      for (let i = 1; i <= 12; i += 1) {
        socket.write(
          `POST ${Routes.channelFiles}?channel=nospace&user=alice HTTP/1.1\r\nHost: 127.0.0.1:${String(h.daemon.port)}\r\nAuthorization: Bearer ${h.credential}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`,
        );
        await vi.waitFor(() => {
          expect(seen.split('HTTP/1.1 409').length - 1).toBe(i);
        });
        await vi.waitFor(() => {
          expect(h.logger.entries.filter((e) => e.event === 'files.body_drained')).toHaveLength(i);
        });
      }
      socket.destroy();
      expect(drains()).toEqual(Array(12).fill(['info', 'ended']));
      expect(warnings).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('a drain holds no lock: during a stalled drain on lab, a second upload to lab is answered 200 within 5,000 ms', async () => {
    // lab's space, made ready as the CLI makes it.
    const space = await control(Routes.channelSpace, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'lab', recipe: 'hello-world' }),
    });
    await space.text();
    const { answer } = upload('lab', 'not a manifest');
    expect(await answer).toBe(400);
    const content = Buffer.from('second\n');
    const { createHash } = await import('node:crypto');
    const manifest = JSON.stringify([
      { name: 'b.txt', size: content.length, sha256: createHash('sha256').update(content).digest('hex') },
    ]);
    const started = performance.now();
    const second = await control(`${Routes.channelFiles}?channel=lab&user=alice`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.concat([Buffer.from(`${manifest}\n`), content]),
    });
    expect([second.status, performance.now() - started < 5_000]).toEqual([200, true]);
    expect(drains()).toEqual([]);
  });
});

describe('what can be launched, and the pattern demos (portal-scene-chat R13, R16; A16, A19)', () => {
  it("GET /v1/telemetry gives a team's member its team (portal-scene-chat R7, A7)", async () => {
    await h.crew();
    expect((await h.cli(['--launch', 'team=crew', 'channel=crew'])).code).toBe(0);
    const answer = (await (await control(`${Routes.telemetry}?channel=crew`)).json()) as TelemetryResponse;
    expect(answer.agents.map((a) => [a.handle, a.recipe, a.team])).toEqual([
      ['helper-1', 'helper', 'crew'],
      ['lead-1', 'lead', 'crew'],
    ]);
  });

  it('GET /v1/definitions: every recipe and team of the root, sorted; 401 without the credential; 404 for POST', async () => {
    await h.crew();
    const answer = await control(Routes.definitions);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      recipes: [
        { id: 'hello-world', description: 'Greets whoever asks.', model: 'tiny-model' },
        { id: 'rememberer', description: 'Remembers things.', model: 'tiny-model' },
      ],
      teams: [
        {
          id: 'crew',
          description: 'A crew.',
          members: [
            { name: 'lead', recipe: 'lead', description: 'Leads.' },
            { name: 'helper', recipe: 'helper', description: 'Helps.' },
          ],
        },
      ],
    });
    expect((await fetch(`${h.base}${Routes.definitions}`)).status).toBe(401);
    const post = await control(Routes.definitions, { method: 'POST' });
    expect([post.status, await post.json()]).toEqual([404, { error: `no route for POST ${Routes.definitions}` }]);
  });

  it('GET /v1/demos: a demo page of the root, its channel past one in use; 401 without the credential; no pages, not shipped', async () => {
    expect(await (await control(Routes.demos)).json()).toEqual({ shipped: false, demos: [] });
    await mkdir(join(h.root, 'docs', 'patterns'), { recursive: true });
    await writeFile(
      join(h.root, 'docs', 'patterns', 'p90-fixture.md'),
      '# P90 · Fixture\n\n```asha-run\n./asha --launch team=crew\n# bound: 20000 ms\n# p90-a\n./asha to=lead-1 user=alice message="hello"\n```\n',
    );
    const first = (await (await control(Routes.demos)).json()) as {
      shipped: boolean;
      demos: { channel: string; title: string; runnable: boolean }[];
    };
    expect([first.shipped, first.demos.map((d) => [d.title, d.channel, d.runnable])]).toEqual([
      true,
      [['Fixture', 'p90-1', true]],
    ]);
    // A channel the daemon has used is never a demo's: the next number is.
    expect((await h.cli(['user=alice', 'recipe=hello-world', 'channel=p90-1', 'message=hello'])).code).toBe(0);
    const second = (await (await control(Routes.demos)).json()) as { demos: { channel: string }[] };
    expect(second.demos.map((d) => d.channel)).toEqual(['p90-2']);
    expect((await fetch(`${h.base}${Routes.demos}`)).status).toBe(401);
  });
});
