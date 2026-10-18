// The portal's page in the pinned headless Chromium, against the real daemon (docs/plans/portal.md A6, A9, A10, A11,
// A15): every failure the page can meet shown where it happened and reported as R6 says — never quoting stream data,
// a user ID or the credential — and each bound of R18 passed on a manual clock; every view against runCli on the same
// daemon or the same fixture; the scene drawing a message's arc within 1,000 ms and holding still with reduced motion;
// the telemetry panel; and the stop.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, Page, Route } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { UNAUTHORIZED_LINE, UNREACHABLE_LINE, STOPPING_LINE } from '../../src/portal/messages.js';
import {
  Routes,
  type ConversationEvent,
  type StateEraseEvent,
  type StateListResponse,
} from '../../src/shared/protocol.js';
import { sseEvent } from '../../src/shared/sse.js';
import {
  DOWNLOAD_IDLE_MS,
  HEALTH_TIMEOUT_MS,
  SERVER_STOP_MS,
  STREAM_IDLE_MS,
  UPLOAD_ANSWER_MS,
} from '../../src/shared/timing.js';
import { launchBrowser } from '../helpers/browser.js';
import { portalHarness, type PortalHarness, type PortalPage } from '../helpers/portal-harness.js';
import { choose, newest, send } from '../helpers/portal-page.js';

const CANARY = 'CANARY-6d1f';
const CANARY_USER = 'canary-user';

let browser: Browser;
let h: PortalHarness;
let p: PortalPage;
beforeAll(async () => {
  browser = await launchBrowser('chromium');
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  h = await portalHarness();
});
afterEach(async () => {
  await p.context.close();
  await h.close();
});

const sse = (events: readonly object[]): string => events.map((e) => sseEvent(e as { type: string })).join('');
const fulfilSse = (body: string) => (route: Route) =>
  route.fulfill({ status: 200, contentType: 'text/event-stream', body });
const reports = () =>
  h.logger.entries
    .filter((e) => e.event === 'portal.client_error')
    .map((e) => [e.fields['reason'], e.fields['detail']]);
const msg = (over: Record<string, unknown>) => ({
  id: 'm1',
  channel: 'lab',
  conversation: 'c1',
  user: 'alice',
  from: 'alice',
  to: null,
  kind: 'input',
  text: 'hi',
  at: '2026-10-02T12:00:00.000Z',
  ...over,
});

/** A view's error lines. */
const errorsOf = async (page: Page, view: string): Promise<string> =>
  (await page.locator(`${view} pre.errors`).first().textContent()) ?? '';

describe(
  'every failure shown where it happened and reported as R6 says, a canary in its way (A6; R6, R18)',
  { timeout: 60_000 },
  () => {
    it('request_failed, bad_status, exception (a SyntaxError, an SseProtocolError, a TypeError), stream_cut and stream_error: each shown and reported once, no canary in any record', async () => {
      let state: (route: Route) => Promise<void> = (route) => route.abort('failed');
      let conversation: string = '';
      p = await h.open(browser, CANARY_USER, {
        before: async (page) => {
          await page.route(`**${Routes.state}`, (route) => state(route));
          await page.route(`**${Routes.conversations}`, (route) => fulfilSse(conversation)(route));
        },
      });
      /** The state view's listing, its route answered by `answer`: the line it shows. */
      const listState = async (answer: (route: Route) => Promise<void>, shows: string) => {
        state = answer;
        await p.page.click('#state-refresh');
        await p.page.locator('#state-output pre.errors', { hasText: shows }).waitFor();
        return errorsOf(p.page, '#state-output');
      };
      await p.page.click('#tab-state');
      // request_failed: the request could not be sent, the daemon still answering (the report reaches it).
      await p.page.locator('#state-output pre.errors', { hasText: 'request_failed' }).waitFor();
      expect(await errorsOf(p.page, '#state-output')).toBe(
        `✗ request_failed: ${Routes.state} could not be sent (TypeError)\n`,
      );
      expect(
        await listState(
          (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }),
          'bad_status',
        ),
      ).toBe(`✗ bad_status: ${Routes.state} answered HTTP 500\n`);
      // A JSON route answering the canary: JSON.parse's SyntaxError quotes it — shown here, never reported.
      expect(
        await listState(
          (route) => route.fulfill({ status: 200, contentType: 'application/json', body: CANARY }),
          'exception',
        ),
      ).toMatch(/^✗ exception: SyntaxError: /);
      // A stream whose line is the canary: SseDecoder's SseProtocolError quotes it.
      conversation = `${CANARY}\n\n`;
      await p.page.click('#tab-send');
      const decoded = await send(p.page, { channel: 'lab', text: CANARY });
      expect([decoded.state, decoded.errors.startsWith('✗ exception: SseProtocolError: ')]).toEqual(['failed', true]);
      // A stream that ends before it settles.
      conversation = sse([{ type: 'phase', phase: 'agent', detail: 'hewo-1 online' }]);
      const cut = await send(p.page, { text: CANARY });
      expect([cut.state, cut.errors]).toEqual([
        'failed',
        '✗ the daemon closed the conversation before it settled; see its log\n',
      ]);
      // An error event, its detail the canary.
      conversation = sse([{ type: 'error', reason: 'internal', detail: CANARY }]);
      const errored = await send(p.page, { text: CANARY });
      expect([errored.state, errored.errors]).toEqual(['failed', `✗ internal: ${CANARY}\n`]);
      // A forced exception: a health answer with no agents breaks the status view's code.
      await p.page.route(`**${Routes.health}`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
      );
      await p.page.click('#tab-status');
      await p.page.locator('#status-output pre.errors', { hasText: 'exception: TypeError' }).waitFor();
      await expect.poll(reports).toEqual([
        ['request_failed', `${Routes.state} TypeError`],
        ['bad_status', `${Routes.state} 500`],
        ['exception', 'SyntaxError'],
        ['exception', 'SseProtocolError'],
        ['stream_cut', Routes.conversations],
        ['stream_error', `${Routes.conversations} internal`],
        ['exception', 'TypeError'],
      ]);
      const log = await readFile(join(h.paths.logsDir, 'daemon.jsonl'), 'utf8');
      for (const secret of [CANARY, CANARY_USER, h.credential]) expect(log).not.toContain(secret);
    });

    it('each bound of R18 passed against a stalled fake, on the manual clock: a JSON request, a stream, an upload and a download, each a timeout, reported', async () => {
      const id = 'd'.repeat(32);
      const files = [{ id, name: 'out.txt', size: 4, sha256: 'e'.repeat(64) }];
      p = await h.open(browser, 'alice', {
        clock: true,
        before: async (page) => {
          // Each route held: no answer ever comes.
          await page.route(`**${Routes.state}`, () => undefined);
          await page.route(`**${Routes.channelFiles}?*`, () => undefined);
          await page.route(`**${Routes.channelFiles}/${id}`, () => undefined);
          await page.route(
            `**${Routes.channelSpace}`,
            fulfilSse(
              sseEvent({ type: 'space_ready', channel: 'lab', bytes: 0, entries: 0, cloudAgents: [] } as {
                type: string;
              }),
            ),
          );
        },
      });
      // A JSON request: 3,000 ms.
      await p.page.click('#tab-state');
      await p.page.clock.runFor(HEALTH_TIMEOUT_MS);
      await p.page.locator('#state-output pre.errors', { hasText: 'timeout' }).waitFor();
      // An upload: UPLOAD_ANSWER_MS.
      await p.page.click('#tab-send');
      await p.page.fill('#send-channel', 'lab');
      await p.page.fill('#send-text', 'with a file');
      await p.page.setInputFiles('#send-files', [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') }]);
      await p.page.click('#send-button');
      await expect.poll(() => p.requests.includes(`POST ${Routes.channelFiles}`)).toBe(true);
      await p.page.clock.runFor(UPLOAD_ANSWER_MS);
      await p.page.locator('#send-log > article[data-state="failed"] pre.errors', { hasText: 'timeout' }).waitFor();
      // A stream silent for STREAM_IDLE_MS: no answer at all to the conversation.
      await p.page.route(`**${Routes.conversations}`, () => undefined);
      await p.page.fill('#send-text', 'silent');
      await p.page.click('#send-button');
      await expect.poll(() => p.requests.filter((r) => r === `POST ${Routes.conversations}`).length).toBe(1);
      await p.page.clock.runFor(STREAM_IDLE_MS);
      await expect.poll(async () => (await newest(p.page)).errors).toContain('timeout');
      // A download silent for DOWNLOAD_IDLE_MS: a reply that returns a file, then nothing from its route.
      await p.page.unroute(`**${Routes.conversations}`);
      await p.page.route(
        `**${Routes.conversations}`,
        fulfilSse(
          sse([
            { type: 'posted', message: msg({}), working: ['hewo-1'] },
            {
              type: 'message',
              message: msg({ id: 'm2', from: 'hewo-1', to: 'alice', kind: 'output', text: 'here', files }),
              working: [],
            },
          ]),
        ),
      );
      await p.page.fill('#send-text', 'a file please');
      await p.page.click('#send-button');
      await p.page.locator('#send-log > article:last-child button.download').waitFor();
      await p.page.click('#send-log > article:last-child button.download');
      await expect.poll(() => p.requests.includes(`GET ${Routes.channelFiles}/${id}`)).toBe(true);
      await p.page.clock.runFor(DOWNLOAD_IDLE_MS);
      await expect
        .poll(async () => (await newest(p.page)).errors)
        .toContain(`✗ file out.txt: no bytes for ${String(DOWNLOAD_IDLE_MS / 1_000)} s`);
      await expect.poll(reports).toEqual([
        ['timeout', Routes.state],
        ['timeout', Routes.channelFiles],
        ['timeout', Routes.conversations],
        ['timeout', Routes.channelFiles],
      ]);
    });

    it('503 while stopping shows stopping, unreported; a report the daemon refuses is shown and not sent again; a wrong credential says run asha --portal; a daemon gone is unreachable, neither reported nor retried', async () => {
      let reportAnswer = 204;
      p = await h.open(browser, 'alice', {
        before: async (page) => {
          await page.route(`**${Routes.state}`, (route) =>
            route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'the daemon is stopping' }),
            }),
          );
          await page.route(`**${Routes.portalErrors}`, (route) =>
            reportAnswer === 204
              ? route.continue()
              : route.fulfill({ status: reportAnswer, contentType: 'application/json', body: '{}' }),
          );
        },
      });
      await p.page.click('#tab-state');
      await p.page.locator('#state-output pre.errors', { hasText: 'stopping' }).waitFor();
      expect(await errorsOf(p.page, '#state-output')).toBe(STOPPING_LINE);
      // The report route answering 500: the failure and the failed report shown, one report sent, none retried.
      reportAnswer = 500;
      await p.page.unroute(`**${Routes.state}`);
      await p.page.route(`**${Routes.state}`, (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
      );
      await p.page.click('#state-refresh');
      await p.page.locator('#state-output pre.errors', { hasText: 'could not be reported' }).waitFor();
      expect(await errorsOf(p.page, '#state-output')).toBe(
        `✗ bad_status: ${Routes.state} answered HTTP 500\n✗ the failure could not be reported to the daemon: it answered HTTP 500\n`,
      );
      await p.page.waitForTimeout(500);
      expect(p.requests.filter((r) => r === `POST ${Routes.portalErrors}`)).toHaveLength(1);
      await p.context.close();
      // A wrong credential: the page says to run asha --portal, and reports nothing.
      p = await h.open(browser, 'alice', { credential: 'f'.repeat(64) });
      await p.page.locator('#page-error', { hasText: 'run asha --portal' }).waitFor();
      expect(await p.page.locator('#page-error').textContent()).toBe(UNAUTHORIZED_LINE);
      expect(p.requests.filter((r) => r === `POST ${Routes.portalErrors}`)).toEqual([]);
      await p.context.close();
      // The daemon gone: unreachable, the one report attempt failing, never retried.
      p = await h.open(browser, 'alice');
      await h.close();
      await p.page.click('#tab-status');
      await p.page.locator('#status-output pre.errors', { hasText: 'unreachable' }).waitFor();
      expect(await errorsOf(p.page, '#status-output')).toBe(
        `✗ request_failed: ${Routes.health} could not be sent (TypeError)\n${UNREACHABLE_LINE}`,
      );
      await p.page.waitForTimeout(500);
      expect(p.requests.filter((r) => r === `POST ${Routes.portalErrors}`)).toHaveLength(1);
      expect(reports()).toEqual([]);
    });
  },
);

describe('every view against runCli (A9; R4, R8)', { timeout: 60_000 }, () => {
  /** A launch from the page: its block's lines. */
  async function launch(page: Page, kind: 'recipe' | 'team', name: string, channel: string) {
    await page.click('#tab-launch');
    const count = await page.locator('#launch-log article').count();
    await page.selectOption('#launch-kind', kind);
    // A drop-down of GET /v1/definitions (portal-scene-chat R14): the entry, or other… with the name typed.
    await choose(page, '#launch-name', '#launch-other', name);
    await page.fill('#launch-channel', channel);
    await page.click('#view-launch button[type="submit"]');
    await expect.poll(() => page.locator('#launch-log article').count()).toBe(count + 1);
    await page.locator('#launch-log article:first-child:not([data-state="sending"])').waitFor();
    const block = page.locator('#launch-log article').first();
    const text = async (selector: string) => (await block.locator(selector).textContent()) ?? '';
    return {
      state: await block.getAttribute('data-state'),
      replies: await text('pre.replies'),
      errors: await text('pre.errors'),
      details: await text('pre.details'),
    };
  }

  it('launch recipe= and team=: the handles one a line, and the details as --verbose prints them', async () => {
    const c = await portalHarness();
    await c.crew();
    const recipe = await c.cli(['--launch', 'recipe=hello-world', 'channel=lab'], { verbose: true });
    const team = await c.cli(['--launch', 'team=crew', 'channel=crew'], { verbose: true });
    await c.close();
    await h.crew();
    p = await h.open(browser, 'alice');
    expect(await launch(p.page, 'recipe', 'hello-world', 'lab')).toEqual({
      state: 'done',
      replies: recipe.out,
      errors: '',
      details: recipe.err,
    });
    expect(await launch(p.page, 'team', 'crew', 'crew')).toEqual({
      state: 'done',
      replies: team.out,
      errors: '',
      details: team.err,
    });
    expect([recipe.out, team.out]).toEqual(['hewo-1\n', 'lead-1\nhelper-1\n']);
  });

  it('status: the lines --status prints', async () => {
    expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=lab'])).code).toBe(0);
    const cli = await h.cli(['--status']);
    p = await h.open(browser, 'alice');
    await p.page.click('#tab-status');
    await p.page.locator('#status-output pre.replies', { hasText: 'running:' }).waitFor();
    expect(await p.page.locator('#status-output pre.replies').textContent()).toBe(cli.out);
  });

  describe('saved state, from a fixture both are given', () => {
    const LISTED: StateListResponse = {
      assets: [
        {
          kind: 'agent',
          identity: 'lab/-/hewo',
          asset: 'memory',
          bytes: 2_048,
          savedAt: '2026-10-02T10:00:00.000Z',
          full: false,
          tainted: false,
        },
        {
          kind: 'channel',
          identity: 'lab',
          asset: 'board',
          bytes: 512,
          savedAt: '2026-10-02T10:01:00.000Z',
          full: false,
          tainted: true,
        },
      ],
      pending: [{ identity: 'lab/-/hewo', bytes: 100, savedAt: '2026-10-02T09:00:00.000Z' }],
      totalBytes: 2_660,
    };
    const REMOVED = {
      removed: [
        { kind: 'agent', identity: 'lab/-/hewo', asset: 'memory', bytes: 2_048 },
        { kind: 'channel', identity: 'lab', asset: 'board', bytes: 512 },
      ],
    };
    const ERASE: StateEraseEvent[] = [
      { type: 'erased', identity: 'lab/-/hewo', files: 3, bytes: 900, pendingMessages: 1 },
      { type: 'kept', kind: 'channel', identity: 'lab', asset: 'board' },
      { type: 'erase_done' },
    ];
    /** The CLI's fetch: the fixture's answers for the state routes, the real daemon for the rest. */
    const fixtureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === Routes.state)
        return new Response(JSON.stringify(LISTED), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === Routes.stateReset) {
        const rawBody = init?.body;
        const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '') as { user?: string };
        if (body.user === undefined)
          return new Response(JSON.stringify(REMOVED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        return new Response(sse(ERASE), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    const routes = async (page: Page) => {
      await page.route(`**${Routes.state}`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LISTED) }),
      );
      await page.route(`**${Routes.stateReset}`, (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}') as { user?: string };
        return body.user === undefined
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REMOVED) })
          : fulfilSse(sse(ERASE))(route);
      });
    };

    it('--list-state: the same lines and total', async () => {
      const cli = await h.cli(['--list-state'], { fetch: fixtureFetch });
      p = await h.open(browser, 'alice', { before: routes });
      await p.page.click('#tab-state');
      await p.page.locator('#state-output pre.replies', { hasText: 'total' }).waitFor();
      expect(await p.page.locator('#state-output pre.replies').textContent()).toBe(cli.out);
    });

    it('--reset-state channel=lab: what goes listed, the reset refused until reset is typed, then the removals', async () => {
      const cli = await h.cli(['--reset-state', 'channel=lab', '--yes'], { fetch: fixtureFetch });
      p = await h.open(browser, 'alice', { before: routes });
      await p.page.click('#tab-state');
      await p.page.fill('#reset-channel', 'lab');
      await p.page.click('#reset-form button[type="submit"]');
      await p.page.locator('#reset-confirm').waitFor();
      expect(await p.page.locator('#reset-go').isDisabled()).toBe(true);
      await p.page.fill('#reset-typed', 'rese');
      expect(await p.page.locator('#reset-go').isDisabled()).toBe(true);
      expect(p.requests.filter((r) => r === `POST ${Routes.stateReset}`)).toEqual([]);
      await p.page.fill('#reset-typed', 'reset');
      await p.page.click('#reset-go');
      await p.page.locator('#reset-output pre.replies', { hasText: 'removed channel lab board' }).waitFor();
      expect(await p.page.locator('#reset-output pre.replies').textContent()).toBe(cli.out);
    });

    it('--reset-state … user=alice: each erase event as the CLI prints it', async () => {
      const cli = await h.cli(['--reset-state', 'channel=lab', 'name=hewo', 'user=alice'], { fetch: fixtureFetch });
      p = await h.open(browser, 'alice', { before: routes });
      await p.page.click('#tab-state');
      await p.page.fill('#reset-channel', 'lab');
      await p.page.fill('#reset-name', 'hewo');
      await p.page.fill('#reset-user', 'alice');
      await p.page.click('#reset-form button[type="submit"]');
      await p.page.locator('#reset-output pre.replies', { hasText: 'kept channel lab board' }).waitFor();
      expect(await p.page.locator('#reset-output pre.replies').textContent()).toBe(cli.out);
      expect(cli.code).toBe(0);
    });
  });

  it("a returned file: its line as the CLI prints a reply's files, and downloaded through the browser, its bytes and sha256 the record's", async () => {
    const bytes = Buffer.from('returned bytes\n');
    const file = {
      id: 'a'.repeat(32),
      name: 'out.txt',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    p = await h.open(browser, 'alice', {
      before: async (page) => {
        await page.route(
          `**${Routes.conversations}`,
          fulfilSse(
            sse([
              { type: 'posted', message: msg({}), working: ['hewo-1'] },
              {
                type: 'message',
                message: msg({ id: 'm2', from: 'hewo-1', to: 'alice', kind: 'output', text: 'here', files: [file] }),
                working: [],
              },
            ]),
          ),
        );
        await page.route(`**${Routes.channelFiles}/${file.id}`, (route) =>
          route.fulfill({ status: 200, contentType: 'application/octet-stream', body: bytes }),
        );
      },
    });
    const block = await send(p.page, { channel: 'lab', text: 'a file please' });
    expect([block.state, block.replies]).toEqual(['done', 'here\n']);
    expect(await p.page.locator('#send-log > article:last-child p.file-line').first().textContent()).toContain(
      `  file out.txt (${String(bytes.length)} bytes, sha256 ${file.sha256})`,
    );
    const [download] = await Promise.all([
      p.page.waitForEvent('download'),
      p.page.click('#send-log > article:last-child button.download'),
    ]);
    expect(download.suggestedFilename()).toBe('out.txt');
    const saved = await readFile(await download.path());
    expect([saved.equals(bytes), createHash('sha256').update(saved).digest('hex')]).toEqual([true, file.sha256]);
  });

  it('a cloud-granted agent coming onto a space holding files, and an agent leaving: the ⚠ line and the left-the-channel line, as the CLI prints them', async () => {
    const events: ConversationEvent[] = [
      {
        type: 'announced',
        message: msg({ id: 'p1', from: 'cloud-1', kind: 'status', conversation: null, text: 'Hi' }) as never,
        exposesFiles: true,
      },
      { type: 'posted', message: msg({}) as never, working: ['cloud-1', 'hewo-2'] },
      { type: 'agent_left', conversation: 'c1', agent: 'hewo-2', detail: 'stopped', working: ['cloud-1'] },
      {
        type: 'message',
        message: msg({ id: 'm2', from: 'cloud-1', to: 'alice', kind: 'output', text: 'done' }) as never,
        working: [],
      },
    ];
    const body = sse(events);
    const cliFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return new URL(url).pathname === Routes.conversations
        ? new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : globalThis.fetch(input, init);
    }) as typeof fetch;
    const cli = await h.cli(['user=alice', 'channel=lab', 'message=hi'], { verbose: true, fetch: cliFetch });
    p = await h.open(browser, 'alice', {
      before: async (page) => {
        await page.route(`**${Routes.conversations}`, fulfilSse(body));
      },
    });
    const block = await send(p.page, { channel: 'lab', text: 'hi' });
    expect([block.replies, block.details]).toEqual([cli.out, cli.err]);
    expect(block.errors).toBe('⚠ cloud-1 is cloud-granted: files on channel lab may leave this machine\n');
    expect(block.details).toContain('› hewo-2 left the channel: stopped\n');
  });
});

describe('the scene in the browser (A10; R9)', { timeout: 60_000 }, () => {
  const attr = (page: Page, name: string) => page.locator('#scene').getAttribute(name);

  it('a message posted by the CLI on the watched channel is an arc within 1,000 ms of its event reaching the page, and its line is in the log', async () => {
    p = await h.open(browser, 'alice');
    await p.page.click('#tab-watch');
    await p.page.fill('#watch-channel', 'lab');
    await p.page.click('#watch-button');
    await expect.poll(() => attr(p.page, 'data-frames')).not.toBeNull();
    expect(
      (await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', 'message=Please say: Hello World.'])).code,
    ).toBe(0);
    await expect.poll(() => attr(p.page, 'data-arcs'), { timeout: 2_000 }).not.toBe('0');
    const eventAt = Number(await attr(p.page, 'data-event-at'));
    const drawnAt = Number(await attr(p.page, 'data-drawn-at'));
    expect(drawnAt - eventAt).toBeLessThan(1_000);
    expect(await attr(p.page, 'data-robots')).toBe('hewo-1');
    await p.page.locator('#watch-output pre.replies', { hasText: 'output hewo-1 → bob: Hello World!' }).waitFor();
  });

  it('with reduced motion: one still frame, redrawn only on an event, while the log still updates', async () => {
    p = await h.open(browser, 'alice', { reducedMotion: true });
    await p.page.click('#tab-watch');
    await p.page.fill('#watch-channel', 'lab');
    await p.page.click('#watch-button');
    // The watching event's frame drawn: from here, only an event redraws the scene.
    await p.page
      .locator('#watch-output pre.details', { hasText: 'watching channel "lab"' })
      .waitFor({ state: 'attached' });
    await p.page.waitForTimeout(100);
    const still = await attr(p.page, 'data-frames');
    // Two telemetry answers come and go, with no event: the frame stays.
    await p.page.waitForTimeout(2_500);
    expect(await attr(p.page, 'data-frames')).toBe(still);
    expect(
      (await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', 'message=Please say: Hello World.'])).code,
    ).toBe(0);
    await p.page.locator('#watch-output pre.replies', { hasText: 'output hewo-1 → bob' }).waitFor();
    expect(Number(await attr(p.page, 'data-frames'))).toBeGreaterThan(Number(still));
  });
});

describe('the telemetry panel (A11; R10)', { timeout: 60_000 }, () => {
  it("shows each agent's counts within 2,000 ms of their record, and a failure's reason", async () => {
    p = await h.open(browser, 'alice');
    await p.page.click('#tab-watch');
    await p.page.fill('#watch-channel', 'lab');
    await p.page.click('#watch-button');
    expect(
      (await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', 'message=Please say: Hello World.'])).code,
    ).toBe(0);
    const row = p.page.locator('#telemetry-rows tr[data-handle="hewo-1"]');
    // Each cell by its label: the Team column (portal-scene-chat R7) moved the others along.
    const cells = async (...labels: string[]) =>
      Promise.all(labels.map(async (l) => (await row.locator(`td[data-label="${l}"]`).textContent()) ?? ''));
    await expect
      .poll(() => cells('Agent', 'Recipe', 'Team', 'Model', 'Deliveries', 'Model calls'), {
        timeout: 2_000,
        interval: 100,
      })
      .toEqual(['hewo-1', 'hello-world', '—', 'tiny-model', '1', '1']);
    h.answer = () => 'fail';
    void h.cli(['user=bob', 'channel=lab', 'message=again']);
    await expect
      .poll(async () => (await cells('Last error'))[0], { timeout: 4_000, interval: 100 })
      .toMatch(/^asha\.chat \S+ at \d\d:\d\d:\d\dZ$/);
  });
});

describe('the stop (A15; R14)', { timeout: 60_000 }, () => {
  it('asks first, then says stopping, and once nothing answers, that the daemon stopped serving — never stopped', async () => {
    p = await h.open(browser, 'alice');
    await p.page.click('#tab-status');
    // The running daemon's lines, shown before the stop, and gone once it is asked for: never a stale view.
    await p.page.locator('#status-output pre.replies', { hasText: 'running: pid' }).waitFor();
    await p.page.click('#stop-button');
    await p.page.locator('#stop-confirm').waitFor();
    expect(p.requests.filter((r) => r === `POST ${Routes.stop}`)).toEqual([]);
    await p.page.click('#stop-yes');
    await p.page.locator('#stop-state', { hasText: 'stopped serving' }).waitFor({ timeout: 10_000 });
    expect(await p.page.locator('#stop-state').textContent()).toBe(
      'stopped serving: the daemon is finishing its stop (its agents, containers and model servers)',
    );
    expect(await p.page.locator('#status-output pre.replies').textContent()).toBe('');
    await h.daemon.stopped;
  });

  it('a stop held past 90,000 ms (manual clock): stopping all the while, then the ✗ line --stop prints', async () => {
    expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=lab'])).code).toBe(0);
    const held = h.holdStop();
    p = await h.open(browser, 'alice', { clock: true });
    await p.page.click('#tab-status');
    await p.page.click('#stop-button');
    await p.page.click('#stop-yes');
    await p.page.locator('#stop-state', { hasText: 'stopping (pid' }).waitFor();
    for (let t = 0; t < SERVER_STOP_MS / 1_000 - 1; t += 1) {
      await p.page.clock.runFor(1_000);
      // The health request the timer started, answered 503, before the clock moves on.
      await p.page.waitForTimeout(15);
    }
    expect(await p.page.locator('#stop-state').textContent()).toMatch(/^stopping \(pid \d+\)$/);
    await p.page.clock.runFor(1_000);
    await p.page.locator('#status-output pre.errors', { hasText: 'still running' }).waitFor();
    expect(await errorsOf(p.page, '#status-output')).toBe(
      `✗ daemon pid ${String(process.pid)} is still running ${String(SERVER_STOP_MS)} ms after the stop\n`,
    );
    held.release();
    await h.daemon.stopped;
  });
});
