// The portal's scene and chats in the pinned headless browsers, against the real daemon and its fakes
// (docs/plans/portal-scene-chat.md A5–A11, A17, A18, A20, A21), each in Chromium and in Firefox: the panels' one height,
// the scene's bubbles as the canvas reports them, the robots' personal spaces, the team lines, the watch thread built from every class of message
// (a crafted stream, so every row of the plan's rendering table is met), the thread following the newest message, the
// command-line views kept for the tab, the send view's chat, markup shown as text, the launch view's drop-downs, the
// message box under the thread, and Run demo.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LEAVING_HOLD_MS } from '../../src/portal/client.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type { ChannelMessage, ChannelStopEvent, WatchEvent } from '../../src/shared/protocol.js';
import { AGENT_FAILURE_STATUS, Routes } from '../../src/shared/protocol.js';
import { sseEvent } from '../../src/shared/sse.js';
import { BROWSERS, launchBrowser } from '../helpers/browser.js';
import {
  HELLO_RECIPE,
  portalHarness,
  type ModelAnswer,
  type PortalHarness,
  type PortalPage,
} from '../helpers/portal-harness.js';
import { choose, chooseRecipe } from '../helpers/portal-page.js';

const AT = '2026-10-07T12:34:56.000Z';
/** A fresh id for each fixture message: not random, only unique — `Math.random` would flag as pseudo-random use. */
let nextMsgId = 0;
const msg = (over: Partial<ChannelMessage> & Pick<ChannelMessage, 'from' | 'kind'>): WatchEvent => {
  nextMsgId += 1;
  return {
    type: 'message',
    message: {
      id: `m${String(nextMsgId)}`,
      channel: 'routed',
      conversation: 'c1',
      user: 'alice',
      to: null,
      text: 't',
      at: AT,
      ...over,
    } as ChannelMessage,
  };
};

/** Every row of the plan's rendering table (M1–M11), a join, a leave, and a model still writing. */
const EVERY_ROW: readonly WatchEvent[] = [
  { type: 'watching', channel: 'routed', agents: ['lead-1', 'helper-1', 'other-1'] },
  { type: 'agent_joined', agent: 'late-1' },
  msg({ from: 'lead-1', kind: 'status', conversation: null, text: 'Hi' }),
  msg({ from: 'alice', to: 'lead-1', kind: 'input', text: 'Do two things' }),
  msg({ from: 'alice', kind: 'input', topic: 'news', text: 'Big news', conversation: 'c2' }),
  msg({ from: 'lead-1', kind: 'status', text: 'ok' }),
  msg({ from: 'lead-1', to: 'helper-1', kind: 'internal', text: 'Part one', call: { id: 'k1', role: 'question' } }),
  msg({ from: 'lead-1', to: 'other-1', kind: 'internal', text: 'Part two', call: { id: 'k1', role: 'question' } }),
  msg({
    from: 'helper-1',
    to: 'lead-1',
    kind: 'internal',
    text: 'One done',
    call: { id: 'k1', role: 'answer', outcome: 'answered' },
  }),
  msg({ from: 'other-1', kind: 'status', text: 'pass: busy' }),
  msg({
    from: 'asha',
    to: 'lead-1',
    kind: 'internal',
    text: "Answers to lead-1's call: 1 answered.",
    call: {
      id: 'k1',
      role: 'gather',
      context: { from: 'alice', text: 'Do two things' },
      requests: [
        { to: 'helper-1', text: 'Part one' },
        { to: 'other-1', text: 'Part two' },
      ],
      answers: [
        { from: 'helper-1', outcome: 'answered', text: 'One done' },
        { from: 'other-1', outcome: 'passed', reason: 'busy' },
      ],
    },
  }),
  msg({ from: 'lead-1', to: 'late-1', kind: 'internal', text: 'You finish it' }),
  msg({ from: 'lead-1', kind: 'status', text: 'consult refused: post_budget' }),
  msg({ from: 'lead-1', kind: 'status', text: 'consult refused: brand_new_reason' }),
  // A reason that is a plain object's inherited key names no words either (the code review's round 2).
  msg({ from: 'lead-1', kind: 'status', text: 'consult refused: constructor' }),
  msg({ from: 'lead-1', kind: 'internal', text: 'Anyone free?' }),
  msg({ from: 'asha', kind: 'status', conversation: null, text: '⚠ resumed late-1' }),
  msg({ from: 'asha', to: 'late-1', kind: 'internal', text: 'the result' }),
  msg({ from: 'late-1', to: 'alice', kind: 'output', text: 'All done' }),
  msg({ from: 'asha', to: 'alice', kind: 'output', text: 'No agent could answer this' }),
  // lead-1's model wrote and finished: no writing line for it; helper-1's is still writing.
  {
    type: 'model_delta',
    handle: 'lead-1',
    conversation: 'c1',
    call: 'w0',
    seq: 0,
    part: 'text',
    text: 'y',
  },
  { type: 'model_done', handle: 'lead-1', conversation: 'c1', call: 'w0', outcome: 'ok' },
  {
    type: 'model_delta',
    handle: 'helper-1',
    conversation: 'c1',
    call: 'w1',
    seq: 0,
    part: 'text',
    text: 'x',
  },
  // helper-1 went offline unasked: the harness's failure status, marked (demo-scene-refresh R7, R8).
  msg({ from: 'helper-1', kind: 'status', conversation: null, text: AGENT_FAILURE_STATUS, failure: true }),
  { type: 'agent_left', agent: 'other-1', detail: 'stopped' },
];

/** Serves `events` as the watch stream of channel `channel` (the page reads it as the daemon's). */
async function routeStream(page: Page, events: readonly WatchEvent[], channel = 'routed'): Promise<void> {
  await page.route(`**/v1/channel?name=${channel}`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: events.map((e) => sseEvent(e)).join(''),
    }),
  );
}

/** The state a watch of a routed stream ends in: routeStream serves every event at once and closes the stream. */
const routedEnd = (channel: string): string =>
  `The watch of channel ${channel} ended; see the chat or its command-line view.`;

/**
 * Watches `channel` until #watch-state reads `state`. A daemon's stream stays open, so `Watching channel …` stays; a
 * routed stream ends at once, so its watch waits for routedEnd — `Watching` lasted only until the stream closed, and a
 * runner that looked later never saw it (v0.2.4's CI, 2026-10-18).
 */
async function watch(page: Page, channel: string, state = `Watching channel ${channel}.`): Promise<void> {
  await page.click('#tab-watch');
  // The button stops an open watch; a new channel is watched once it has stopped.
  if ((await page.textContent('#watch-button')) === 'Stop watching') {
    await page.click('#watch-button');
    await page.locator('#watch-button', { hasText: /^Watch$/ }).waitFor();
  }
  await page.fill('#watch-channel', channel);
  await page.click('#watch-button');
  await page.locator('#watch-state', { hasText: state }).waitFor();
}

/** The thread's entries, each as `<class>: <text>` (the writing lines last). */
async function entries(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const node of await page.locator('#watch-thread > *').all()) {
    const cls = (await node.getAttribute('class')) ?? '';
    if (cls === 'writing-lines') {
      for (const w of await node.locator('.writing').allTextContents()) out.push(`writing: ${w}`);
      continue;
    }
    const text = cls.startsWith('chat-msg')
      ? `${(await node.locator('header').textContent()) ?? ''} | ${(await node.locator('.text').textContent()) ?? ''}`
      : (await node.locator('p').allTextContents()).join(' / ');
    out.push(`${cls}: ${text}`);
  }
  return out;
}

/** The id of the element that has the focus. */
async function focused(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => (globalThis as unknown as { document: { activeElement: { id: string } | null } }).document.activeElement?.id,
  );
}

/** Whether an element lies wholly inside the viewport, as the user sees the page. */
async function inView(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((node) => {
    const box = (
      node as unknown as { getBoundingClientRect(): { top: number; bottom: number } }
    ).getBoundingClientRect();
    return box.top >= 0 && box.bottom <= (globalThis as unknown as { innerHeight: number }).innerHeight;
  });
}

const bubbles = async (page: Page): Promise<{ handle: string; kind: string; lines: string[] }[]> =>
  JSON.parse((await page.locator('#scene').getAttribute('data-bubbles')) ?? '[]') as never;

/**
 * Each pair of robots whose personal spaces, as the canvas reports them (whole CSS px), overlap by more than 1 px each
 * way: the rounding to whole pixels can make two spaces that only touch overlap by 1 px.
 */
async function spacesMeeting(page: Page): Promise<{ robots: number; meeting: string[] }> {
  const spaces = JSON.parse((await page.locator('#scene').getAttribute('data-spaces')) ?? '[]') as {
    handle: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }[];
  const meeting: string[] = [];
  for (let i = 0; i < spaces.length; i += 1) {
    for (let j = i + 1; j < spaces.length; j += 1) {
      const a = present(spaces[i], 'space');
      const b = present(spaces[j], 'space');
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > 1 && h > 1) meeting.push(`${a.handle}~${b.handle}`);
    }
  }
  return { robots: spaces.length, meeting };
}

for (const name of BROWSERS) {
  describe(`the portal's scene and chats in ${name}`, { timeout: 60_000 }, () => {
    let browser: Browser;
    let h: PortalHarness;
    let p: PortalPage;
    beforeAll(async () => {
      browser = await launchBrowser(name);
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

    it('the watch thread shows every class of message as its row of the table says, and who is writing (A8; R8)', async () => {
      p = await h.open(browser, 'alice', { commandLine: false, before: (page) => routeStream(page, EVERY_ROW) });
      await watch(p.page, 'routed', routedEnd('routed'));
      await p.page.locator('#watch-thread .note.failure', { hasText: 'closed the channel stream' }).waitFor();
      const shown = await entries(p.page);
      const time = '12:34:56Z';
      expect(shown.filter((e) => !e.includes('closed the channel stream'))).toEqual([
        'note: late-1 joined',
        `chat-msg from-agent kind-status: lead-1 → everyone${time} | Hi`,
        `chat-msg from-user: alice → lead-1${time} | Do two things`,
        `chat-msg from-user: alice → topic news${time} | Big news`,
        'note: lead-1: ok',
        `chat-msg from-agent kind-internal call-question: lead-1 → helper-1asks${time} | Part one`,
        `chat-msg from-agent kind-internal call-question: lead-1 → other-1asks${time} | Part two`,
        `chat-msg from-agent kind-internal call-answer: helper-1 → lead-1answers${time} | One done`,
        'note: other-1: pass: busy',
        'note gather: collected 2/2 answers / helper-1: One done / other-1: passed: busy',
        `chat-msg from-agent kind-internal: lead-1 → late-1${time} | You finish it`,
        'note warning: lead-1 could not ask: this conversation has used up its posts budget (32 agent posts unless the message set Posts budget; each agent asked takes 2) (consult refused: post_budget)',
        'note: lead-1: consult refused: brand_new_reason',
        'note: lead-1: consult refused: constructor',
        `chat-msg from-agent kind-internal: lead-1 → everyone${time} | Anyone free?`,
        'note: asha: ⚠ resumed late-1',
        'note: asha → late-1: the result',
        `chat-msg from-agent kind-output: late-1 → alice${time} | All done`,
        'note: asha: No agent could answer this',
        `chat-msg from-agent kind-status agent-offline: helper-1 → everyone${time} | system failure — offline`,
        'note: other-1 left',
        'writing: helper-1 is writing…',
      ]);
      // The scene marks helper-1 with its red ✕ (demo-scene-refresh R8).
      expect(await p.page.locator('#scene').getAttribute('data-failed')).toBe('helper-1');
      // Show details belongs to the command-line view: disabled in the chat (R8).
      expect(await p.page.isDisabled('#watch-details')).toBe(true);
      // The last model writing finishes: no writing line is left.
      await routeStream(
        p.page,
        [
          { type: 'watching', channel: 'routed2', agents: ['helper-1'] },
          {
            type: 'model_delta',
            handle: 'helper-1',
            conversation: 'c1',
            call: 'w1',
            seq: 0,
            part: 'text',
            text: 'x',
          },
          { type: 'model_done', handle: 'helper-1', conversation: 'c1', call: 'w1', outcome: 'ok' },
        ],
        'routed2',
      );
      await watch(p.page, 'routed2', routedEnd('routed2'));
      await p.page.locator('#watch-thread .note.failure', { hasText: 'closed the channel stream' }).waitFor();
      expect((await entries(p.page)).filter((e) => e.startsWith('writing:'))).toEqual([]);
      expect([p.errors, p.violations]).toEqual([[], []]);
    });

    it('the thread follows the newest message, unless the user has scrolled up (A8; R8)', async () => {
      p = await h.open(browser, 'alice', { commandLine: false });
      await watch(p.page, 'lab');
      for (let i = 0; i < 10; i += 1)
        expect(
          (await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', `message=message ${String(i)}`])).code,
        ).toBe(0);
      const thread = p.page.locator('#watch-thread');
      /** A scrollable element's own metrics (named here rather than relying on the DOM lib, which this file does without). */
      type Scrollable = { scrollTop: number; scrollHeight: number; clientHeight: number };
      const metrics = async () =>
        thread.evaluate((el: Scrollable) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
      await expect.poll(async () => await thread.locator('.chat-msg.kind-output').count()).toBe(10);
      let m = await metrics();
      expect(m.height).toBeGreaterThan(m.client);
      expect(m.height - m.top - m.client).toBeLessThanOrEqual(1);
      // Scrolled up 100 px: a new message leaves it there.
      await thread.evaluate((el: Scrollable) => (el.scrollTop = el.scrollHeight - el.clientHeight - 100));
      const up = (await metrics()).top;
      expect((await h.cli(['user=bob', 'channel=lab', 'message=while scrolled up'])).code).toBe(0);
      await expect.poll(async () => await thread.locator('.chat-msg.kind-output').count()).toBe(11);
      expect((await metrics()).top).toBe(up);
      // At the bottom again: the next message is followed.
      await thread.evaluate((el: Scrollable) => (el.scrollTop = el.scrollHeight));
      expect((await h.cli(['user=bob', 'channel=lab', 'message=at the bottom'])).code).toBe(0);
      await expect.poll(async () => await thread.locator('.chat-msg.kind-output').count()).toBe(12);
      m = await metrics();
      expect(m.height - m.top - m.client).toBeLessThanOrEqual(1);
    });

    it('the scene and the thread are one height side by side, fixed heights stacked, the thread scrolling inside (A5; R5a)', async () => {
      p = await h.open(browser, 'alice', { commandLine: false });
      await watch(p.page, 'lab');
      const height = async (selector: string) =>
        present(await p.page.locator(selector).boundingBox(), 'bounding box').height;
      expect(await height('#scene')).toBe(420);
      expect(Math.abs((await height('.scene-wrap')) - (await height('.thread-panel')))).toBeLessThanOrEqual(1);
      const before = await height('.thread-panel');
      for (let i = 0; i < 8; i += 1)
        expect((await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', `message=fill ${String(i)}`])).code).toBe(
          0,
        );
      await expect.poll(async () => p.page.locator('#watch-thread .chat-msg').count()).toBeGreaterThanOrEqual(16);
      expect(await height('.thread-panel')).toBe(before);
      await p.page.setViewportSize({ width: 390, height: 844 });
      expect(await height('#scene')).toBe(300);
      expect(await height('.thread-panel')).toBe(360);
    });

    it("the canvas reports each box it draws: a message's speech within 1,000 ms; with reduced motion, the work bubble and card stay (A5, A6; R2, R5b, R6)", async () => {
      p = await h.open(browser, 'alice', { commandLine: false });
      await watch(p.page, 'lab');
      expect(
        (await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', 'message=Please say: Hello World.'])).code,
      ).toBe(0);
      await expect
        .poll(async () => (await bubbles(p.page)).find((b) => b.handle === 'hewo-1' && b.kind === 'speech')?.lines, {
          timeout: 1_000,
          interval: 50,
        })
        .toEqual(['Hello World!']);
      await p.context.close();
      const reduced: WatchEvent[] = [
        { type: 'watching', channel: 'routed', agents: ['lead-1', 'helper-1'] },
        msg({ from: 'alice', to: 'lead-1', kind: 'input', text: 'Do it' }),
        msg({
          from: 'lead-1',
          to: 'helper-1',
          kind: 'internal',
          text: 'Part one',
          call: { id: 'k1', role: 'question' },
        }),
      ];
      p = await h.open(browser, 'alice', {
        commandLine: false,
        reducedMotion: true,
        before: (page) => routeStream(page, reduced),
      });
      await watch(p.page, 'routed', routedEnd('routed'));
      await expect
        .poll(async () =>
          (await bubbles(p.page)).map((b) => `${b.handle} ${b.kind} ${b.lines.join('|')}`).sort(byCodeUnit),
        )
        .toEqual([
          'helper-1 work working on: Part one',
          'lead-1 card collecting 0/1|helper-1: waiting',
          'lead-1 speech Part one',
          'lead-1 work working on: Do it',
        ]);
    });

    it("the robots keep their personal spaces apart with the page's own fonts: P5's four, each with a box over its head (A21; R5c)", async () => {
      const p5: WatchEvent[] = [
        { type: 'watching', channel: 'routed', agents: ['lead-1', 'worker-a-1', 'worker-b-1', 'worker-c-1'] },
        msg({
          from: 'alice',
          to: 'lead-1',
          kind: 'input',
          text: "Please do three things: translate 'thank you' into French, add 17 and 25, and say Hello World.",
        }),
        msg({
          from: 'lead-1',
          to: 'worker-a-1',
          kind: 'internal',
          text: "Translate 'thank you' into French.",
          call: { id: 'k1', role: 'question' },
        }),
        msg({
          from: 'lead-1',
          to: 'worker-b-1',
          kind: 'internal',
          text: 'Add 17 and 25.',
          call: { id: 'k1', role: 'question' },
        }),
        msg({
          from: 'lead-1',
          to: 'worker-c-1',
          kind: 'internal',
          text: 'Say: Hello World.',
          call: { id: 'k1', role: 'question' },
        }),
      ];
      p = await h.open(browser, 'alice', { commandLine: false, before: (page) => routeStream(page, p5) });
      await watch(p.page, 'routed', routedEnd('routed'));
      await expect
        .poll(async () => (await bubbles(p.page)).filter((b) => b.kind === 'work').length, {
          timeout: 5_000,
          interval: 50,
        })
        .toBe(4);
      // Apart within the unit tests' 12 s bound, then still apart frame after frame for 2 s.
      await expect
        .poll(async () => spacesMeeting(p.page), { timeout: 12_000, interval: 100 })
        .toEqual({ robots: 4, meeting: [] });
      const frames = Number(await p.page.locator('#scene').getAttribute('data-frames'));
      for (let i = 0; i < 20; i += 1) {
        await p.page.waitForTimeout(100);
        expect(await spacesMeeting(p.page), `sample ${String(i)}`).toEqual({ robots: 4, meeting: [] });
      }
      expect(Number(await p.page.locator('#scene').getAttribute('data-frames'))).toBeGreaterThan(frames + 30);
    });

    it("the scene's canvas is, at each window width, a size the unit tests of personal space sweep (A21; R5a, R5c)", async () => {
      p = await h.open(browser, 'alice', { commandLine: false });
      await p.page.click('#tab-watch');
      const sizes: string[] = [];
      for (const [width, height] of [
        [1280, 860],
        [1000, 760],
        [900, 760],
        [800, 760],
        [760, 800],
        [375, 800],
      ] as const) {
        await p.page.setViewportSize({ width, height });
        sizes.push(
          await p.page.locator('#scene').evaluate((node) => {
            const box = (
              node as unknown as { getBoundingClientRect(): { width: number; height: number } }
            ).getBoundingClientRect();
            return `${String(Math.round(box.width))} × ${String(Math.round(box.height))}`;
          }),
        );
      }
      // scene-sim.test.ts: 694, 550 and 490 × 420 hold every space; 430 × 420 and the stacked 300 px canvases (718 to
      // 333 wide) do not, and R5c (e) bounds the robots' motion there.
      expect(sizes).toEqual(['694 × 420', '550 × 420', '490 × 420', '430 × 420', '718 × 300', '333 × 300']);
    });

    it('a second watch in one page draws its own scene, as the first does: its robots, frame after frame (A5; R2; found 2026-10-08)', async () => {
      // Found by the owner: after the first demo in a page, every demo's scene stayed empty — the new scene never drew.
      await h.crew();
      expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=one'])).code).toBe(0);
      expect((await h.cli(['--launch', 'team=crew', 'channel=two'])).code).toBe(0);
      p = await h.open(browser, 'alice', { commandLine: false });
      const robots = async (): Promise<string> => (await p.page.locator('#scene').getAttribute('data-robots')) ?? '';
      const drawnAt = async (): Promise<number> => Number(await p.page.locator('#scene').getAttribute('data-drawn-at'));
      // A channel watched after its agents joined: the watch's first event names them sorted (Channel.handles).
      for (const [channel, expected] of [
        ['one', 'hewo-1'],
        ['two', 'helper-1 lead-1'],
        ['one', 'hewo-1'],
      ] as const) {
        await watch(p.page, channel);
        await expect.poll(robots, { timeout: 2_000 }).toBe(expected);
        const at = await drawnAt();
        await expect.poll(drawnAt, { timeout: 1_000 }).toBeGreaterThan(at);
      }
    });

    it('a page reloaded while it watches reports no failure: its stream was ended by the browser, not cut by the daemon (portal R6; found 2026-10-08)', async () => {
      // Found in the live demo's log: a reload logged portal.client_error stream_cut "/v1/channel TypeError" at error
      // level. Firefox ends the page's requests after beforeunload and before pagehide, and the page reported the end;
      // the page now holds a report LEAVING_HOLD_MS after beforeunload, and a reloaded page is gone long before.
      // Chromium ends them after pagehide and never sent the report: there this test checks only that nothing is.
      expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=lab'])).code).toBe(0);
      const robots = async (): Promise<string> => (await p.page.locator('#scene').getAttribute('data-robots')) ?? '';
      p = await h.open(browser, 'alice', { commandLine: false });
      const before = h.logger.entries.length;
      await watch(p.page, 'lab');
      await expect.poll(robots, { timeout: 2_000 }).toBe('hewo-1');
      await p.page.reload();
      const reloadedAt = Date.now();
      await p.page.locator('#daemon-line', { hasText: /^daemon pid / }).waitFor();
      // The reloaded page works: it watches again, and its scene draws.
      await watch(p.page, 'lab');
      await expect.poll(robots, { timeout: 2_000 }).toBe('hewo-1');
      // Past the hold: a report the reload caused would have been sent by now.
      await p.page.waitForTimeout(Math.max(0, reloadedAt + LEAVING_HOLD_MS + 500 - Date.now()));
      expect(p.requests.filter((r) => r === `POST ${Routes.portalErrors}`)).toEqual([]);
      expect(
        h.logger.entries
          .slice(before)
          .filter((e) => e.level !== 'info')
          .map((e) => [e.level, e.event]),
      ).toEqual([]);
    });

    it('a page whose beforeunload fires but which stays (a navigation answered 204) reports what it meets afterwards (portal R6; review of 0a4cadd)', async () => {
      // 0a4cadd stopped every report once beforeunload had fired; a navigation answered 204 (or as a download) fires it
      // and leaves the page where it is, which then never reported a failure again (found by its adversarial review).
      expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=lab'])).code).toBe(0);
      let navigated: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (navigated = resolve));
      p = await h.open(browser, 'alice', {
        commandLine: false,
        before: async (page) => {
          // F9 navigates from the page itself, as a link would (the page's policy refuses a string evaluated as script).
          await page.addInitScript({
            content: "addEventListener('keydown', (e) => { if (e.key === 'F9') location.href = '/v1/nothing'; });",
          });
          await page.route('**/v1/nothing', (route) => {
            navigated();
            return route.fulfill({ status: 204 });
          });
          await page.route('**/v1/channel?name=broken', (route) =>
            route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal error"}' }),
          );
        },
      });
      const before = h.logger.entries.length;
      await watch(p.page, 'lab');
      const url = p.page.url();
      await p.page.keyboard.press('F9');
      // The navigation's request is sent after its beforeunload: the page has begun to leave, and is answered 204.
      await started;
      if ((await p.page.textContent('#watch-button')) === 'Stop watching') await p.page.click('#watch-button');
      await p.page.locator('#watch-button', { hasText: /^Watch$/ }).waitFor();
      await p.page.fill('#watch-channel', 'broken');
      await p.page.click('#watch-button');
      await p.page.locator('#watch-thread .note.failure', { hasText: '✗ bad_status' }).waitFor();
      expect(p.page.url()).toBe(url);
      // Every report the page met after its beforeunload, sent once the hold showed it stayed. Firefox also ended the
      // watch of lab when the navigation began, and reports that end as a cut stream.
      const reported = (): string[][] =>
        h.logger.entries
          .slice(before)
          .filter((e) => e.level !== 'info')
          .map((e) => [e.level, e.event, String(e.fields['reason']), String(e.fields['detail'])])
          .sort((a, b) => byCodeUnit(String(a), String(b)));
      await expect.poll(reported, { timeout: LEAVING_HOLD_MS + 5_000 }).toEqual(
        name === 'firefox'
          ? [
              ['error', 'portal.client_error', 'bad_status', '/v1/channel 500'],
              ['error', 'portal.client_error', 'stream_cut', '/v1/channel TypeError'],
            ]
          : [['error', 'portal.client_error', 'bad_status', '/v1/channel 500']],
      );
    });

    it('the watch view names the team and the recipe launched alone, and the Team column (A7; R7)', async () => {
      await h.crew();
      p = await h.open(browser, 'alice', { commandLine: false });
      await watch(p.page, 'lab');
      expect((await h.cli(['--launch', 'team=crew', 'channel=lab'])).code).toBe(0);
      expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=lab'])).code).toBe(0);
      await expect
        .poll(async () => p.page.locator('#watch-teams p').allTextContents(), { timeout: 5_000 })
        .toEqual(['team crew: lead-1, helper-1', 'recipe hello-world: hewo-1']);
      const team = async (handle: string) =>
        (await p.page.locator(`#telemetry-rows tr[data-handle="${handle}"] td[data-label="Team"]`).textContent()) ?? '';
      expect([await team('lead-1'), await team('helper-1'), await team('hewo-1')]).toEqual(['crew', 'crew', '—']);
    });

    it("each command-line view's checkbox lasts for the tab and never reaches the browser's lasting storage (A9; R9)", async () => {
      p = await h.open(browser, 'alice', { commandLine: false });
      expect(await p.page.isChecked('#send-cli')).toBe(false);
      await p.page.check('#send-cli');
      await p.page.click('#tab-watch');
      await p.page.check('#watch-cli');
      await p.page.reload();
      await p.page.locator('#daemon-line', { hasText: /^daemon pid / }).waitFor();
      expect(await p.page.isChecked('#send-cli')).toBe(true);
      expect(await p.page.isChecked('#watch-cli')).toBe(true);
      const storage = await p.context.storageState();
      expect(storage.origins.flatMap((o) => o.localStorage)).toEqual([]);
      expect(storage.cookies).toEqual([]);
    });

    it("the send view's chat: your message on the right, the reply on the left naming its agent; a refusal a note; an ask's waiting line (A10; R10)", async () => {
      p = await h.open(browser, 'alice', { commandLine: false });
      await p.page.fill('#send-channel', 'lab');
      await chooseRecipe(p.page, 'hello-world');
      await p.page.fill('#send-text', 'hello');
      await p.page.click('#send-button');
      const block = p.page.locator('#send-log > article').last();
      // The reply arrives before the conversation settles (the CLI's rule): the exchange is marked done once it has.
      await block.locator('.chat-msg.from-agent').waitFor();
      await p.page.locator('#send-log > article[data-state="done"]').last().waitFor();
      expect(await block.locator('.chat-msg.from-user .text').textContent()).toBe('hello');
      expect(await block.locator('.chat-msg.from-agent header .who').textContent()).toBe('hewo-1 → alice');
      expect(await block.locator('.chat-msg.from-agent header time').textContent()).toMatch(/^\d\d:\d\d:\d\dZ$/);
      expect(await block.locator('.chat-msg.from-agent .text').textContent()).toBe('Hello World!');
      // The command-line view's lines are there, and hidden; the block's own copy of the text too: the bubble shows it.
      expect(await block.locator('pre.replies').isVisible()).toBe(false);
      expect(await block.locator(':scope > p.text').isVisible()).toBe(false);
      expect(await block.locator('.chat-msg.from-user').isVisible()).toBe(true);
      // A listed recipe chosen: the other… text box is hidden; other… chosen, it shows.
      expect(await p.page.isVisible('#send-recipe-other')).toBe(false);
      await chooseRecipe(p.page, 'no-such-recipe');
      expect(await p.page.isVisible('#send-recipe-other')).toBe(true);
      await p.page.fill('#send-text', 'hello');
      await p.page.click('#send-button');
      const refused = p.page.locator('#send-log > article').last();
      await refused.locator('.note.failure').waitFor();
      await p.page.locator('#send-log > article:last-child[data-state="failed"]').waitFor();
      expect(await refused.locator('.note.failure').textContent()).toMatch(/^✗ unknown_recipe: /);
      const hello = JSON.parse(await readFile(join(h.root, 'recipes', 'hello-world.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      await writeFile(
        join(h.root, 'recipes', 'asker.json'),
        JSON.stringify({ ...hello, id: 'asker', tools: ['ask_user'] }),
      );
      h.answer = () => ({ ask: 'Shall I?' });
      await chooseRecipe(p.page, 'asker');
      await p.page.fill('#send-text', 'Ask me first.');
      await p.page.click('#send-button');
      const asked = p.page.locator('#send-log > article').last();
      await asked.locator('.chat-msg.from-agent .waiting').waitFor();
      expect(await asked.locator('.chat-msg.from-agent .waiting').textContent()).toMatch(
        /is waiting for your answer: asha channel=lab user=alice conversation=\S+ message="…"$/,
      );
      expect(await asked.locator('button.answer').count()).toBe(1);
    });

    it('a reply that is markup is shown as its text in the chat and in the canvas, and runs nothing (A11; R11)', async () => {
      const markup = '<img src=x onerror="document.title=\'pwned\'"><b>bold</b>';
      h.answer = () => markup;
      p = await h.open(browser, 'alice', { commandLine: false });
      await watch(p.page, 'lab');
      await p.page.click('#tab-send');
      await p.page.fill('#send-channel', 'lab');
      await chooseRecipe(p.page, 'hello-world');
      await p.page.fill('#send-text', 'hello');
      await p.page.click('#send-button');
      // The canvas's speech first: it shows for SCENE.speechMs from the reply's event.
      await p.page.locator('#watch-thread .chat-msg.kind-output').waitFor({ state: 'attached' });
      await expect
        .poll(
          async () =>
            (await bubbles(p.page)).find((b) => b.handle === 'hewo-1' && b.kind === 'speech')?.lines.join(' ') ?? '',
          { timeout: 2_000, interval: 50 },
        )
        .toContain('<img src=x');
      const block = p.page.locator('#send-log > article').last();
      await block.locator('.chat-msg.from-agent').waitFor();
      expect(await block.locator('.chat-msg.from-agent .text').textContent()).toBe(markup);
      expect(await p.page.locator('#send-log img, #send-log b, #watch-thread img, #watch-thread b').count()).toBe(0);
      expect(await p.page.locator('#watch-thread .chat-msg.kind-output .text').textContent()).toBe(markup);
      expect(await p.page.title()).toBe('asha portal');
      expect([p.errors, p.violations]).toEqual([[], []]);
    });

    it("the launch view's drop-down, details and list; the send view's recipe drop-down; a failed read shown and reported (A17; R14)", async () => {
      await h.crew();
      await writeFile(
        join(h.root, 'recipes', 'broken.json'),
        JSON.stringify({ ...HELLO_RECIPE, id: 'broken', tools: 'not a list' }),
      );
      p = await h.open(browser, 'alice', { commandLine: false });
      // The send view's recipe: none first (no recipe sent), every recipe, the broken one disabled, other… last.
      await p.page.locator('#send-recipe option[value="…other"]').waitFor({ state: 'attached' });
      // An option's value and disabled, read as the page's own properties (this file is type-checked without the DOM's names).
      const options = await p.page.locator('#send-recipe option').evaluateAll((os) =>
        os.map((o) => {
          const opt = o as unknown as { value: string; textContent: string | null; disabled: boolean };
          return [opt.value, opt.textContent, opt.disabled];
        }),
      );
      expect(options[0]).toEqual(['', 'none — the agents already on the channel', false]);
      expect(options).toContainEqual(['hello-world', 'hello-world — Greets whoever asks.', false]);
      expect(options.find((o) => o[0] === 'broken')?.[2]).toBe(true);
      expect(options.at(-1)).toEqual(['…other', 'other…', false]);
      // A recipe added later is listed once the send view is shown again.
      await writeFile(
        join(h.root, 'recipes', 'late.json'),
        JSON.stringify({ ...HELLO_RECIPE, id: 'late', description: 'Came later.' }),
      );
      expect(await p.page.locator('#send-recipe option[value="late"]').count()).toBe(0);
      await p.page.click('#tab-watch');
      await p.page.click('#tab-send');
      await p.page.locator('#send-recipe option[value="late"]').waitFor({ state: 'attached' });
      const bodies: unknown[] = [];
      p.page.on('request', (r) => {
        if (r.method() === 'POST' && new URL(r.url()).pathname === Routes.conversations)
          bodies.push(JSON.parse(r.postData() ?? '{}'));
      });
      expect((await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', 'message=hi'])).code).toBe(0);
      await p.page.fill('#send-channel', 'lab');
      await chooseRecipe(p.page, '');
      await p.page.fill('#send-text', 'to whoever is there');
      await p.page.click('#send-button');
      await expect.poll(() => bodies.length).toBe(1);
      expect(bodies[0]).toEqual({ user: 'alice', channel: 'lab', message: 'to whoever is there' });
      // The launch view.
      await p.page.click('#tab-launch');
      await p.page.locator('#launch-name option[value="…other"]').waitFor({ state: 'attached' });
      expect(await p.page.locator('#launch-name option[value="hello-world"]').textContent()).toBe(
        'hello-world — Greets whoever asks.',
      );
      expect(await p.page.locator('#launch-name option[value="broken"]').getAttribute('disabled')).toBe('');
      expect(await p.page.locator('#launch-name option[value="broken"]').textContent()).toMatch(
        /^broken — cannot launch: recipes\/broken\.json: /,
      );
      await p.page.selectOption('#launch-kind', 'team');
      await p.page.selectOption('#launch-name', 'crew');
      expect(await p.page.textContent('#launch-detail')).toBe('A crew. Members: lead (lead), helper (helper).');
      expect(
        await p.page
          .locator('#launch-list article')
          .evaluateAll((as) =>
            as.map((a) => (a as unknown as { getAttribute(name: string): string | null }).getAttribute('data-id')),
          ),
      ).toEqual(['crew', 'broken', 'hello-world', 'late', 'rememberer']);
      expect(await p.page.locator('#launch-list article[data-id="broken"] button.choose').count()).toBe(0);
      const before = p.requests.filter((r) => r === `POST ${Routes.agents}`).length;
      // Choose from a card scrolled out of the form's sight: the choice is seen where the user is — the form brought
      // into view, Name focused (the owner, 2026-10-09: with the list scrolled, Choose seemed to do nothing).
      const size = present(p.page.viewportSize(), 'viewport size');
      await p.page.setViewportSize({ width: size.width, height: 240 });
      const card = p.page.locator('#launch-list article[data-id="hello-world"] button.choose');
      await card.scrollIntoViewIfNeeded();
      expect(await inView(p.page, '#launch-form')).toBe(false);
      await card.click();
      expect([await p.page.inputValue('#launch-kind'), await p.page.inputValue('#launch-name')]).toEqual([
        'recipe',
        'hello-world',
      ]);
      expect(await inView(p.page, '#launch-form')).toBe(true);
      expect(await focused(p.page)).toBe('launch-name');
      await p.page.setViewportSize(size);
      // Choose launches nothing however it is pressed (R14). A double click whose second click lands on Launch — the
      // form's scroll can put Launch under the pointer — and a held Return on Choose (a repeated keydown) each launch
      // nothing: a launch adds its block to the log as it is submitted, so none may be there.
      const late = p.page.locator('#launch-list article[data-id="late"] button.choose');
      const centre = async (selector: string): Promise<{ x: number; y: number }> => {
        const box = present(await p.page.locator(selector).boundingBox(), 'bounding box');
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      await late.scrollIntoViewIfNeeded();
      const first = await centre('#launch-list article[data-id="late"] button.choose');
      await p.page.mouse.click(first.x, first.y);
      expect(await p.page.inputValue('#launch-name')).toBe('late');
      const second = await centre('#launch-button');
      await p.page.mouse.move(second.x, second.y);
      await p.page.mouse.down({ clickCount: 2 });
      await p.page.mouse.up({ clickCount: 2 });
      expect(await p.page.locator('#launch-log > article').count()).toBe(0);
      await late.focus();
      await p.page.keyboard.down('Enter');
      await p.page.keyboard.down('Enter');
      await p.page.keyboard.up('Enter');
      expect(await focused(p.page)).toBe('launch-name');
      expect(await p.page.locator('#launch-log > article').count()).toBe(0);
      expect(p.requests.filter((r) => r === `POST ${Routes.agents}`)).toHaveLength(before);
      expect(await p.page.isVisible('#launch-other')).toBe(false);
      await p.page.fill('#launch-channel', 'lab2');
      await p.page.click('#view-launch button[type="submit"]');
      await p.page.locator('#launch-log > article[data-state="done"]').waitFor();
      // The launch's handle, as --launch prints it, is shown: the send view's chat hides no line here.
      expect(await p.page.locator('#launch-log > article pre.replies').first().isVisible()).toBe(true);
      expect(await p.page.locator('#launch-log > article pre.replies').first().textContent()).toBe('hewo-1\n');
      // A name typed through other….
      await choose(p.page, '#launch-name', '#launch-other', 'rememberer');
      expect(await p.page.inputValue('#launch-name')).toBe('rememberer');
      await p.page.selectOption('#launch-name', '…other');
      expect(await p.page.isVisible('#launch-other')).toBe(true);
      await p.page.fill('#launch-other', 'hello-world');
      await p.page.fill('#launch-channel', 'lab3');
      await p.page.click('#view-launch button[type="submit"]');
      await expect.poll(() => p.page.locator('#launch-log > article[data-state="done"]').count()).toBe(2);
      await p.context.close();
      // The route failing: shown in the launch view, reported once.
      p = await h.open(browser, 'alice', {
        commandLine: false,
        before: async (page) => {
          await page.route('**/v1/definitions', (route) =>
            route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal error"}' }),
          );
        },
      });
      await p.page.click('#tab-launch');
      await p.page.locator('#launch-list pre.errors', { hasText: '✗ bad_status' }).waitFor();
      await expect
        .poll(() => p.requests.filter((r) => r === `POST ${Routes.portalErrors}`).length)
        .toBeGreaterThanOrEqual(1);
    });

    it("the message box under the thread posts as the page's user: Return sends, Shift+Return and composition do not; a refusal is a note (A18; R15)", async () => {
      p = await h.open(browser, 'alice', { commandLine: false });
      expect((await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', 'message=hi'])).code).toBe(0);
      await watch(p.page, 'lab');
      await expect
        .poll(async () => p.page.locator('#compose-to option').allTextContents())
        .toEqual(['everyone', 'hewo-1']);
      expect(await p.page.textContent('#compose-as')).toBe('as alice');
      const bodies: unknown[] = [];
      p.page.on('request', (r) => {
        if (r.method() === 'POST' && new URL(r.url()).pathname === Routes.conversations)
          bodies.push(JSON.parse(r.postData() ?? '{}'));
      });
      await p.page.selectOption('#compose-to', 'hewo-1');
      await p.page.fill('#compose-text', 'line one');
      await p.page.press('#compose-text', 'Shift+Enter');
      await p.page.locator('#compose-text').pressSequentially('line two');
      await p.page.locator('#compose-text').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
      expect(bodies).toEqual([]);
      await p.page.press('#compose-text', 'Enter');
      await expect.poll(() => bodies.length).toBe(1);
      expect(bodies[0]).toEqual({ user: 'alice', channel: 'lab', to: 'hewo-1', message: 'line one\nline two' });
      expect(await p.page.inputValue('#compose-text')).toBe('');
      await p.page.locator('#watch-thread .chat-msg.from-user', { hasText: 'line one' }).waitFor();
      await expect.poll(async () => p.page.locator('#watch-thread .chat-msg.kind-output').count()).toBe(1);
      // Stopping the watch hides the box at once: nothing is posted to a watch that is ending (R15).
      await p.page.click('#watch-button');
      expect(await p.page.isVisible('#compose-form')).toBe(false);
      // A channel with no agent and no recipe: the harness's reply, as the watch stream carries it (row M11).
      await watch(p.page, 'empty');
      await p.page.fill('#compose-text', 'anyone?');
      await p.page.press('#compose-text', 'Enter');
      await p.page
        .locator('#watch-thread .note', {
          hasText: 'asha: No agent on channel "empty" received this, so nobody could answer it.',
        })
        .waitFor();
      // A message the daemon refuses: the CLI's ✗ line for it, as a note.
      await p.page.route('**/v1/conversations', (route) =>
        route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"refused for the test"}' }),
      );
      await p.page.fill('#compose-text', 'refused');
      await p.page.press('#compose-text', 'Enter');
      await p.page.locator('#watch-thread .note.failure').first().waitFor();
      expect(await p.page.locator('#watch-thread .note.failure').first().textContent()).toMatch(
        /^✗ .*400.*refused for the test/,
      );
      await p.page.unroute('**/v1/conversations');
      await p.context.close();
      p = await h.open(browser, undefined, { commandLine: false });
      await watch(p.page, 'lab');
      expect(await p.page.textContent('#compose-as')).toMatch(/^This page has no user ID/);
      const sent = p.requests.filter((r) => r === `POST ${Routes.conversations}`).length;
      await p.page.fill('#compose-text', 'hello');
      await p.page.press('#compose-text', 'Enter');
      await p.page.locator('#watch-thread .note.failure', { hasText: 'This page has no user ID' }).waitFor();
      expect(p.requests.filter((r) => r === `POST ${Routes.conversations}`)).toHaveLength(sent);
    });

    it("Run demo: a fresh channel watched, the team launched, each scenario sent as the page's user, @previous filled in; again on the next channel; a failed launch stops it (A20; R17)", async () => {
      await h.crew();
      await mkdir(join(h.root, 'docs', 'patterns'), { recursive: true });
      await writeFile(
        join(h.root, 'docs', 'patterns', 'p90-fixture.md'),
        '# P90 · Fixture\n\n```asha-run\n./asha --launch team=crew\n# bound: 20000 ms\n# p90-a\n./asha to=lead-1 user=bob message="Please pass."\n# p90-b\n./asha to=lead-1 user=bob message="Ask me first."\n./asha user=bob conversation=@previous message="yes"\n```\n',
      );
      await writeFile(
        join(h.root, 'docs', 'patterns', 'p91-copy.md'),
        '# P91 · Copy\n\n```asha-run\n./asha --launch team=crew\n# bound: 20000 ms\n# p91-a\n./asha to=lead-1 user=bob message="hi"\n./asha --stop\n./asha --launch team=crew\n```\n',
      );
      const lead = JSON.parse(await readFile(join(h.root, 'teams', 'crew', 'lead.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      await writeFile(join(h.root, 'teams', 'crew', 'lead.json'), JSON.stringify({ ...lead, tools: ['ask_user'] }));
      h.answer = (incoming): ModelAnswer => {
        // Each tail computed on its own statement (never nested in another ternary's branch), innermost first, so the
        // final line keeps the chain's exact precedence: an answer to "yes", else asked-first, else passed, else the
        // default — in that order, whichever other conditions also happen to hold.
        const otherwise = incoming.includes('Please pass.') ? { pass: 'not mine' } : 'Hello World!';
        const askedOrOtherwise = incoming.includes('Ask me first.') ? { ask: 'Shall I?' } : otherwise;
        return incoming.includes('The user answered what you asked them:\nyes\n') ? 'Then I will.' : askedOrOtherwise;
      };
      // No user ID: Run demo stays disabled, whatever is chosen.
      p = await h.open(browser, undefined, { commandLine: false });
      await p.page.click('#tab-watch');
      await p.page.locator('#demo-select option[value="P90"]').waitFor({ state: 'attached' });
      await p.page.selectOption('#demo-select', 'P90');
      expect(await p.page.isDisabled('#demo-run')).toBe(true);
      await p.context.close();
      p = await h.open(browser, 'alice', { commandLine: false });
      const bodies: { user?: string; channel?: string; conversation?: string }[] = [];
      p.page.on('request', (r) => {
        if (r.method() === 'POST' && new URL(r.url()).pathname === Routes.conversations)
          bodies.push(JSON.parse(r.postData() ?? '{}') as never);
      });
      await p.page.click('#tab-watch');
      await p.page.locator('#demo-select option[value="P90"]').waitFor({ state: 'attached' });
      expect(await p.page.textContent('#demo-select option[value="P90"]')).toBe('P90 · Fixture');
      expect(await p.page.getAttribute('#demo-select option[value="P91"]', 'disabled')).toBe('');
      expect(await p.page.textContent('#demo-select option[value="P91"]')).toBe(
        'P91 · Copy — scenario p91-a runs "./asha --stop", which this page cannot (portal-restart)',
      );
      await p.page.selectOption('#demo-select', 'P90');
      await p.page.click('#demo-run');
      // Disabled while it runs (R17).
      expect(await p.page.isDisabled('#demo-run')).toBe(true);
      await p.page
        .locator('#watch-thread .note', { hasText: 'its agents stay online on channel p90-1' })
        .waitFor({ timeout: 30_000 });
      const notes = await p.page.locator('#watch-thread .note').allTextContents();
      expect(
        notes.filter((n) => /^demo |^p90-|its agents stay/.test(n)).map((n) => n.replace(/in \d+\.\d s/, 'in N s')),
      ).toEqual([
        'demo P90 on channel p90-1',
        'p90-a',
        // A scenario that ends with exit 1 (as several demos do) is reported so, and the next one still runs.
        'p90-a: exit 1 in N s (bound 20 s)',
        'p90-b',
        'p90-b: exit 0, 0 in N s (bound 20 s)',
        'its agents stay online on channel p90-1; Stop demo ends them',
      ]);
      expect(await p.page.textContent('#watch-state')).toBe('Watching channel p90-1.');
      expect(p.requests.filter((r) => r === `POST ${Routes.agents}`)).toHaveLength(1);
      expect(bodies.map((b) => [b.user, b.channel])).toEqual([
        ['alice', 'p90-1'],
        ['alice', 'p90-1'],
        ['alice', 'p90-1'],
      ]);
      const third = present(bodies[2], 'third body');
      expect(third.conversation).toMatch(/^[0-9a-z-]+$/);
      expect(third.conversation).not.toBe('@previous');
      expect(await p.page.isEnabled('#demo-run')).toBe(true);
      // Again: the next channel.
      await p.page.click('#demo-run');
      await p.page
        .locator('#watch-thread .note', { hasText: 'its agents stay online on channel p90-2' })
        .waitFor({ timeout: 30_000 });
      // The second demo's scene is drawn, as the first's was (found 2026-10-08: it stayed empty).
      const drawnAt = async (): Promise<number> => Number(await p.page.locator('#scene').getAttribute('data-drawn-at'));
      expect(await p.page.locator('#scene').getAttribute('data-robots')).toBe('lead-1 helper-1');
      const at = await drawnAt();
      await expect.poll(drawnAt, { timeout: 1_000 }).toBeGreaterThan(at);
      await p.context.close();
      // A launch that fails stops the demo, sending nothing.
      p = await h.open(browser, 'alice', {
        commandLine: false,
        before: async (page) => {
          await page.route('**/v1/agents', (route) =>
            route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal error"}' }),
          );
        },
      });
      await p.page.click('#tab-watch');
      await p.page.locator('#demo-select option[value="P90"]').waitFor({ state: 'attached' });
      await p.page.selectOption('#demo-select', 'P90');
      await p.page.click('#demo-run');
      await p.page
        .locator('#watch-thread .note.failure', { hasText: '✗ demo P90: the launch of team crew failed' })
        .waitFor();
      expect(p.requests.filter((r) => r === `POST ${Routes.conversations}`)).toEqual([]);
      await p.context.close();
      // The demos' read failing: shown in the chat, reported once (portal R6).
      p = await h.open(browser, 'alice', {
        commandLine: false,
        before: async (page) => {
          await page.route('**/v1/demos', (route) =>
            route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal error"}' }),
          );
        },
      });
      await p.page.click('#tab-watch');
      await p.page.locator('#watch-thread .note.failure', { hasText: '✗ bad_status' }).waitFor();
      await expect
        .poll(() => p.requests.filter((r) => r === `POST ${Routes.portalErrors}`).length)
        .toBeGreaterThanOrEqual(1);
    });

    it('Stop demo: hidden while a demo runs, shown once it ends; pressed, its lines follow the closing note, the agents leave the scene and the watch stays open; a failed stop is a failure note, reported (portal-demo-stop A5: R5, R6)', async () => {
      await h.crew();
      await mkdir(join(h.root, 'docs', 'patterns'), { recursive: true });
      await writeFile(
        join(h.root, 'docs', 'patterns', 'p90-fixture.md'),
        '# P90 · Fixture\n\n```asha-run\n./asha --launch team=crew\n# bound: 20000 ms\n# p90-a\n./asha to=lead-1 user=bob message="Please pass."\n```\n',
      );
      await writeFile(
        join(h.root, 'docs', 'patterns', 'p92-other.md'),
        '# P92 · Other\n\n```asha-run\n./asha --launch team=crew\n# bound: 20000 ms\n# p92-a\n./asha to=lead-1 user=bob message="hi"\n```\n',
      );
      p = await h.open(browser, 'alice', { commandLine: false });
      // The scenario's message is held: the team is launched and watched, and the demo still runs.
      let send!: () => void;
      const held = new Promise<void>((resolve) => (send = resolve));
      await p.page.route('**/v1/conversations', async (route) => {
        await held;
        await route.continue();
      });
      await p.page.click('#tab-watch');
      await p.page.locator('#demo-select option[value="P90"]').waitFor({ state: 'attached' });
      await p.page.selectOption('#demo-select', 'P90');
      await p.page.click('#demo-run');
      await expect
        .poll(() => p.page.locator('#scene').getAttribute('data-robots'), { timeout: 30_000 })
        .toBe('lead-1 helper-1');
      // The team is on the watched channel; choosing another demo redraws the controls, and the button stays hidden
      // only because the demo runs (R5).
      await p.page.selectOption('#demo-select', 'P92');
      expect(await p.page.isHidden('#demo-stop')).toBe(true);
      await p.page.selectOption('#demo-select', 'P90');
      send();
      const closing = 'its agents stay online on channel p90-1; Stop demo ends them';
      await p.page.locator('#watch-thread .note', { hasText: closing }).waitFor({ timeout: 30_000 });
      await p.page.unroute('**/v1/conversations');
      await p.page.locator('#demo-stop').waitFor({ state: 'visible' });
      const notes = () => p.page.locator('#watch-thread .note').allTextContents();
      // The closing note ends the demo's own notes; an agent's status (`lead-1: ok`) may still follow it on the channel,
      // as it did in Firefox in the gate at 88621b4, since a scenario settles when its reply is posted.
      const demoNotes = (all: readonly string[]) => all.filter((n) => /^demo |^p90-|its agents stay/.test(n));
      expect(demoNotes(await notes()).at(-1)).toBe(closing);

      await p.page.click('#demo-stop');
      await p.page
        .locator('#watch-thread .note', { hasText: 'stopped the model server for tiny-model' })
        .waitFor({ timeout: 30_000 });
      const after = await notes();
      const stopLines = after.filter((n) => n.startsWith('stopped '));
      expect([...stopLines].sort(byCodeUnit)).toEqual([
        'stopped helper-1',
        'stopped lead-1',
        'stopped the model server for tiny-model',
      ]);
      expect(stopLines.at(-1)).toBe('stopped the model server for tiny-model');
      // The run's notes end with the closing note; the stop's lines come after it.
      expect(after.indexOf(closing)).toBeLessThan(after.indexOf(present(stopLines[0], 'first stop line')));
      expect(after.filter((n) => n.startsWith('✗'))).toEqual([]);
      // The agents leave the scene; the watch stays open on the channel.
      await expect.poll(() => p.page.locator('#scene').getAttribute('data-robots'), { timeout: 10_000 }).toBe('');
      expect(await p.page.textContent('#watch-state')).toBe('Watching channel p90-1.');
      expect(await p.page.textContent('#watch-output')).toContain('stopped the model server for tiny-model');
      expect(p.requests.filter((r) => r === `POST ${Routes.channelStop}`)).toHaveLength(1);
      // Stopped: nothing is left to stop.
      expect(await p.page.isHidden('#demo-stop')).toBe(true);

      // Again, on the next channel; this time the stop fails, twice: each a failure note with its reason, reported,
      // and the button stays for another try (R6).
      await p.page.click('#demo-run');
      await p.page
        .locator('#watch-thread .note', { hasText: 'its agents stay online on channel p90-2' })
        .waitFor({ timeout: 30_000 });
      const reports = () => p.requests.filter((r) => r === `POST ${Routes.portalErrors}`).length;
      const failures = () => p.page.locator('#watch-thread .note.failure').allTextContents();
      await p.page.route('**/v1/channel/stop', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused for the test"}' }),
      );
      let reported = reports();
      await p.page.click('#demo-stop');
      await p.page.locator('#watch-thread .note.failure').first().waitFor();
      expect(await failures()).toEqual(['✗ bad_status: /v1/channel/stop answered HTTP 500']);
      await expect.poll(reports).toBeGreaterThan(reported);
      await p.page.locator('#demo-stop:enabled').waitFor();
      // The daemon's own failure, as its stream ends: the error's detail.
      await p.page.unroute('**/v1/channel/stop');
      const detail = 'the stop of channel p90-2 failed: helper-1 still running after the stop';
      const failing: ChannelStopEvent[] = [
        { type: 'stopping', channel: 'p90-2', handles: ['lead-1', 'helper-1'] },
        { type: 'agent_stopped', handle: 'lead-1' },
        { type: 'error', reason: 'channel_stop_failed', detail },
      ];
      await p.page.route('**/v1/channel/stop', (route) =>
        route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
          body: failing.map((e) => sseEvent(e)).join(''),
        }),
      );
      reported = reports();
      await p.page.click('#demo-stop');
      await p.page.locator('#watch-thread .note.failure', { hasText: detail }).waitFor();
      expect((await failures()).at(-1)).toBe(`✗ ${detail}`);
      await expect.poll(reports).toBeGreaterThan(reported);
      await p.page.locator('#demo-stop:enabled').waitFor();
      expect(await p.page.isVisible('#demo-stop')).toBe(true);
      expect(await p.page.locator('#scene').getAttribute('data-robots')).toBe('lead-1 helper-1');
      await p.page.unroute('**/v1/channel/stop');
      // Hidden on a channel no demo started, though an agent is on it; shown again on the demo's (R5).
      expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=lab'])).code).toBe(0);
      await watch(p.page, 'lab');
      await expect.poll(() => p.page.locator('#scene').getAttribute('data-robots'), { timeout: 10_000 }).toBe('hewo-1');
      await p.page.locator('#demo-stop').waitFor({ state: 'hidden' });
      await watch(p.page, 'p90-2');
      await p.page.locator('#demo-stop').waitFor({ state: 'visible' });
      // Hidden once the demo's channel has no agent: its agents stopped from the command line.
      const elsewhere = await h.cli(['--stop', 'channel=p90-2']);
      expect(elsewhere.code).toBe(0);
      await p.page.locator('#demo-stop').waitFor({ state: 'hidden' });
      expect(await p.page.textContent('#watch-state')).toBe('Watching channel p90-2.');
    });
  });
}
