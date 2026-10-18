// The portal's views as its user page shows them (docs/plans/portal.md A8; docs/plans/portal-scene-chat.md A12): each
// at 1280×800 and 390×844, written to evals/probes/<ASHA_SCREENSHOTS>/screenshots/<view>-<width>.png (docs/ holds no
// images but its diagrams), which the portal's user page links. Run by `ASHA_SCREENSHOTS=<probe folder> npm run
// portal:screenshots` — the folder is named, never defaulted, so a new set never overwrites an old record; looked at,
// then committed. The views open in their chats (portal-scene-chat R8, R10); the watch view is caught during a
// scripted consult, its helper's answer held, so the scene shows work bubbles and a card.

import { resolve } from 'node:path';

import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { Routes, type StateListResponse } from '../../src/shared/protocol.js';
import { launchBrowser } from '../helpers/browser.js';
import { portalHarness } from '../helpers/portal-harness.js';
import { choose, send } from '../helpers/portal-page.js';

const FOLDER = process.env['ASHA_SCREENSHOTS'];
if (FOLDER === undefined || !/^[a-z0-9][a-z0-9.-]*$/.test(FOLDER))
  throw new Error('set ASHA_SCREENSHOTS to the probe folder the screenshots go in, e.g. portal-scene-chat-2026-10-07');
const OUT = resolve(import.meta.dirname, '..', '..', 'evals', 'probes', FOLDER, 'screenshots');
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

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
      tainted: false,
    },
  ],
  pending: [],
  totalBytes: 2_560,
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser('chromium');
});
afterAll(async () => {
  await browser.close();
});

const shot = (page: Page, view: string, width: number) =>
  page.screenshot({ path: `${OUT}/${view}-${String(width)}.png`, fullPage: true });

describe('the portal, view by view', () => {
  for (const viewport of VIEWPORTS) {
    it(`at ${String(viewport.width)}×${String(viewport.height)}`, async () => {
      const h = await portalHarness();
      await h.crew();
      const p = await h.open(browser, 'alice', {
        viewport,
        commandLine: false,
        before: async (page) => {
          await page.route(`**${Routes.state}`, (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LISTED) }),
          );
        },
      });
      const { page } = p;
      try {
        // Send: a message and its reply as a chat; the recipe drop-down, the picker and its notice above.
        await send(page, { channel: 'lab', recipe: 'hello-world', text: 'Please say: Hello World.' });
        await page.locator('#send-log > article:last-child .chat-msg.from-agent').waitFor();
        await shot(page, 'send', viewport.width);
        // Launch: a team on lab, its handles one a line.
        await page.click('#tab-launch');
        await page.selectOption('#launch-kind', 'team');
        await choose(page, '#launch-name', '#launch-other', 'crew');
        await page.fill('#launch-channel', 'lab');
        await page.click('#view-launch button[type="submit"]');
        await page.locator('#launch-log article[data-state="done"]').waitFor();
        await page.selectOption('#launch-name', 'crew');
        await shot(page, 'launch', viewport.width);
        // Watch, with the scene, the chat and the telemetry: lead-1 consults helper-1, whose answer is held, so the
        // scene shows both work bubbles and lead-1's card collecting.
        await page.click('#tab-watch');
        await page.fill('#watch-channel', 'lab');
        await page.click('#watch-button');
        await page.locator('#telemetry-rows tr[data-handle="lead-1"]').waitFor();
        /** @returns a ModelAnswer, by design not always the same shape (a reply, or a consult). */
        h.answer = (incoming) => {
          if (incoming.includes('Check the plan.')) return 'hang';
          if (incoming.includes('Please plan the trip.'))
            return { consult: [{ to: 'helper-1', text: 'Check the plan.' }] };
          return 'Hello World!';
        };
        void h.cli(['user=bob', 'channel=lab', 'to=lead-1', 'message=Please plan the trip.']);
        await page.locator('#scene[data-bubbles*="collecting 0/1"]').waitFor({ state: 'attached', timeout: 20_000 });
        await page.waitForTimeout(400);
        await shot(page, 'watch', viewport.width);
        // Status, and the stop's question.
        await page.click('#tab-status');
        await page.locator('#status-output pre.replies', { hasText: 'running:' }).waitFor();
        await page.click('#stop-button');
        await shot(page, 'status', viewport.width);
        await page.click('#stop-no');
        // State: the listing, and a reset waiting for the typed word.
        await page.click('#tab-state');
        await page.locator('#state-output pre.replies', { hasText: 'total' }).waitFor();
        await page.fill('#reset-channel', 'lab');
        await page.click('#reset-form button[type="submit"]');
        await page.locator('#reset-confirm').waitFor();
        await shot(page, 'state', viewport.width);
        // Help.
        await page.click('#tab-help');
        await shot(page, 'help', viewport.width);
        // Stopped: the stop asked for, the daemon gone.
        await page.click('#tab-status');
        await page.click('#stop-button');
        await page.click('#stop-yes');
        await page.locator('#stop-state', { hasText: 'stopped serving' }).waitFor({ timeout: 20_000 });
        await shot(page, 'stopped', viewport.width);
      } finally {
        await p.context.close();
        await h.close();
      }
    });
  }
});
