// Driving the portal's send view from a test (docs/plans/portal.md A4, A6, A9, A20, A22): through locators only, never
// a page-side function, since the page's policy refuses a string evaluated as script.

import type { Page } from 'playwright-core';
import { expect } from 'vitest';

/** One message's block as the page shows it: its state, and its lines as the CLI would print them. */
interface Block {
  readonly state: string;
  readonly replies: string;
  readonly errors: string;
  readonly details: string;
}

type FilePick = string | { readonly name: string; readonly mimeType: string; readonly buffer: Buffer };

/** The value of a drop-down's `other…` option (src/portal/catalog.ts OTHER). */
const OTHER = '…other';

/**
 * Picks a name in a drop-down read from GET /v1/definitions (portal-scene-chat R14), once its options are in: the entry
 * when it is listed, else `other…` and the name typed in its text box; '' picks the first option (the send view's none).
 */
export async function choose(page: Page, select: string, other: string, name: string): Promise<void> {
  await page.locator(`${select} option[value="${OTHER}"]`).waitFor({ state: 'attached', timeout: 10_000 });
  if (name === '') {
    await page.selectOption(select, '');
    return;
  }
  const listed = await page.locator(`${select} option[value="${name}"]:not([disabled])`).count();
  if (listed > 0) {
    await page.selectOption(select, name);
    return;
  }
  await page.selectOption(select, OTHER);
  await page.fill(other, name);
}

/** Picks the send view's recipe (portal-scene-chat R14). */
export async function chooseRecipe(page: Page, recipe: string): Promise<void> {
  await choose(page, '#send-recipe', '#send-recipe-other', recipe);
}

/** Sends one message from the send view and waits for it to settle: the newest block's lines. */
export async function send(
  page: Page,
  fields: {
    channel?: string;
    recipe?: string;
    to?: string;
    topic?: string;
    conversation?: string;
    user?: string;
    posts?: string;
    tokens?: string;
    text: string;
    files?: readonly FilePick[];
  },
): Promise<Block> {
  const count = await page.locator('#send-log > article').count();
  if (fields.channel !== undefined) await page.fill('#send-channel', fields.channel);
  if (fields.recipe !== undefined) await chooseRecipe(page, fields.recipe);
  if (fields.to !== undefined) await page.fill('#send-to', fields.to);
  if (fields.topic !== undefined) await page.fill('#send-topic', fields.topic);
  // The conversation an answer is for (patterns-phase-3 R27), as an Answer button fills it.
  if (fields.conversation !== undefined) await page.fill('#send-conversation', fields.conversation);
  if (fields.user !== undefined) await page.fill('#send-user', fields.user);
  // A message's budget (docs/plans/patterns-phase-3.md R15): '' clears a field.
  if (fields.posts !== undefined) await page.fill('#send-posts', fields.posts);
  if (fields.tokens !== undefined) await page.fill('#send-tokens', fields.tokens);
  await page.fill('#send-text', fields.text);
  if (fields.files !== undefined)
    await page.setInputFiles('#send-files', fields.files as Parameters<Page['setInputFiles']>[1]);
  await page.click('#send-button');
  // Through locators, never a page-side function: the page's policy refuses a string evaluated as script.
  await expect.poll(() => page.locator('#send-log > article').count(), { timeout: 20_000 }).toBe(count + 1);
  await page.locator('#send-log > article:last-child:not([data-state="sending"])').waitFor({ timeout: 20_000 });
  return newest(page);
}

/** The newest block's state and lines: the session's last, newest at the bottom (portal-scene-chat R10). */
export async function newest(page: Page): Promise<Block> {
  const block = page.locator('#send-log > article').last();
  const text = async (selector: string) => (await block.locator(selector).textContent()) ?? '';
  return {
    state: (await block.getAttribute('data-state')) ?? '',
    replies: await text('pre.replies'),
    errors: await text('pre.errors'),
    details: await text('pre.details'),
  };
}
