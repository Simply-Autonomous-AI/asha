// The recorder's frame on the real portal page (docs/plans/demo-videos.md R9, R2; A4), in Chromium only — the
// recorder's browser. The page runs on the integration tier's daemon, watching a channel whose stream is crafted, with
// the recorder's own frame installed before its first paint and its device metrics set as the recorder sets them. The
// recorder's own sampler finds nothing but the title, the scene and the thread; the title names the demo; the scene
// draws at the frame's size. Each part the frame must hide, let show, is named by the sampler; a frame without its
// title fails the title's check.

import type { Browser, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ChannelMessage, WatchEvent } from '../../src/shared/protocol.js';
import { sseEvent } from '../../src/shared/sse.js';
import { FRAME_CSS, SAMPLE_FRAME, VIEW, frameScript } from '../agents/patterns/recorder.js';
import { launchBrowser } from '../helpers/browser.js';
import { portalHarness, type PortalHarness, type PortalPage } from '../helpers/portal-harness.js';

const TITLE = 'P5 · Orchestrator–workers';
const PURPOSE =
  'A lead splits a request into parts and gives each part to the worker whose description covers it, then combines their results.';

const AT = '2026-10-11T00:00:00.000Z';
const msg = (
  id: string,
  over: Partial<ChannelMessage> & Pick<ChannelMessage, 'from' | 'kind' | 'text'>,
): WatchEvent => ({
  type: 'message',
  message: { id, channel: 'demo', conversation: 'c1', user: 'alice', to: null, at: AT, ...over } as ChannelMessage,
});
const STREAM: readonly WatchEvent[] = [
  { type: 'watching', channel: 'demo', agents: ['lead-1', 'worker-1'] },
  msg('m1', { from: 'alice', to: 'lead-1', kind: 'input', text: 'Split this.' }),
  msg('m2', { from: 'lead-1', to: 'worker-1', kind: 'internal', text: 'Take the first part.' }),
];

let browser: Browser;
let h: PortalHarness;
let p: PortalPage | undefined;

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
  await p?.context.close();
  p = undefined;
  await h.close();
});

/** The portal page with the frame installed (its CSS and title given), metrics as the recorder's, watching the crafted channel. */
async function framed(css: string = FRAME_CSS, title: string = TITLE): Promise<Page> {
  // The frame hides the daemon line, so the page is waited on as the recorder waits on it: the line attached.
  p = await h.open(browser, 'alice', {
    commandLine: false,
    wait: false,
    viewport: { width: VIEW.width, height: VIEW.height },
    before: async (page) => {
      await page.addInitScript({ content: frameScript(title, PURPOSE, css) });
      await page.route('**/v1/channel?name=demo', (route) =>
        route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: STREAM.map((e) => sseEvent(e)).join(''),
        }),
      );
    },
  });
  const cdp = await p.context.newCDPSession(p.page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.width,
    height: VIEW.height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const page = p.page;
  await page.locator('#daemon-line', { hasText: /^daemon pid / }).waitFor({ state: 'attached', timeout: 15_000 });
  await page.evaluate(
    "document.getElementById('tab-watch').click(); document.getElementById('watch-channel').value = 'demo'; document.getElementById('watch-button').click();",
  );
  await expect
    .poll(() => page.locator('#scene').getAttribute('data-robots'), { timeout: 10_000 })
    .toBe('lead-1 worker-1');
  return page;
}

const sample = async (page: Page): Promise<string[]> => page.evaluate<string[]>(SAMPLE_FRAME);
const titleShown = async (page: Page): Promise<string> =>
  (await page.evaluate<string>("document.querySelector('#record-title h1')?.textContent ?? ''")).trim();

describe("the recorder's frame on the portal page, in Chromium (demo-videos R9, R2; A4)", { timeout: 60_000 }, () => {
  it("shows only the title, the scene and the thread; the title names the demo; the scene draws at the frame's size, 3 to 2 beside the thread", async () => {
    const page = await framed();

    expect(await sample(page)).toEqual([]);
    expect(await titleShown(page)).toBe(TITLE);
    const geometry = await page.evaluate<{
      dpr: number;
      client: number;
      backing: number;
      scene: number;
      thread: number;
      title: number;
      purposeLines: number;
    }>(`(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const canvas = document.getElementById('scene');
      return { dpr: devicePixelRatio, client: canvas.getBoundingClientRect().width, backing: canvas.width,
        scene: box('.scene-wrap').width, thread: box('.thread-panel').width, title: box('#record-title').height,
        purposeLines: Math.round(box('#record-title p').height / 16) };
    })()`);
    expect(geometry.dpr).toBe(2);
    expect(geometry.backing).toBe(Math.round(geometry.client * 2));
    expect(geometry.scene / geometry.thread).toBeCloseTo(1.5, 1);
    expect(geometry.title).toBe(76);
    expect(geometry.purposeLines).toBeLessThanOrEqual(2);
    const drawnAt = async (): Promise<number> => Number(await page.locator('#scene').getAttribute('data-drawn-at'));
    const first = await drawnAt();
    await expect.poll(drawnAt, { timeout: 2_000 }).toBeGreaterThan(first);
  });

  it.each([
    [
      'the telemetry',
      '#telemetry { visibility: visible; position: fixed; z-index: 30; top: 300px; left: 40px; }',
      'in #telemetry',
    ],
    ["the scene's caption", '.scene-wrap figcaption { display: block !important; }', 'figcaption.muted'],
    ['the message box', '#compose-form { display: flex !important; }', 'in #compose-form'],
    [
      'the command-line view',
      '#watch-output { display: block !important; min-height: 200px; }',
      'div#watch-output.watch-log',
    ],
  ])('names %s when the frame lets it show', async (_label, leak, named) => {
    const page = await framed(`${FRAME_CSS}\n${leak}`);

    const found = await sample(page);
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some((what) => what.includes(named)),
      `the sampler found ${JSON.stringify(found)}`,
    ).toBe(true);
  });

  it('fails the title check when the frame leaves the title out', async () => {
    const page = await framed(FRAME_CSS, '');

    expect(await titleShown(page)).not.toBe(TITLE);
  });
});
