// The portal's page in the pinned headless browsers, against the real daemon (docs/plans/portal.md A4, A5, A14, A20,
// A22), each in Chromium and in Firefox, the owner's default browser (R12): the page prints what the CLI prints for
// the same messages and the same channel; text from agents reaches it only as text; and attaching files from it checks
// what a browser lets a page check, then leaves the bytes to the daemon (R8a, R8b).

import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Browser } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { STOPPING_LINE, UNAUTHORIZED_LINE } from '../../src/portal/messages.js';
import { present } from '../../src/shared/assert-present.js';
import { Routes, UPLOAD_REFUSALS } from '../../src/shared/protocol.js';
import { UPLOAD_ANSWER_MS } from '../../src/shared/timing.js';
import { sseEvent } from '../../src/shared/sse.js';
import { BROWSERS, launchBrowser } from '../helpers/browser.js';
import { portalHarness, type PortalHarness, type PortalPage } from '../helpers/portal-harness.js';
import { chooseRecipe, send } from '../helpers/portal-page.js';

/** R8a's notice, exactly as the plan states it. */
const NOTICE =
  "asha checks each file's name against its credential deny list, and refuses a file holding asha's own credential or model-server key. It cannot check which folder a file is in, since a browser does not say: a secret file with an ordinary name, such as .docker/config.json, would be sent. The command line's file= checks folders too.";

/** A space_ready answer for the space route, as the daemon streams it. */
function spaceReady(usage: { bytes: number; entries: number; cloudAgents: readonly string[] }): string {
  return sseEvent({ type: 'space_ready', channel: 'lab', ...usage } as { readonly type: string });
}

/** The URL a fetch call's first argument names, whatever form it takes. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The JSON text a fetch call's init carries as its body — every call recorded in this file sends it as a string. */
function requestBodyText(init: RequestInit | undefined): string {
  const body = present(init, 'fetch init').body;
  return typeof body === 'string' ? body : '';
}

for (const name of BROWSERS) {
  // A browser test drives a page through several requests and a 25 MB upload: bounded at 30 s, not vitest's 5 s
  // default (the slowest measured on 2026-10-02 is in the plan's gate-time record); hitting it is a failure.
  describe(`the portal in ${name}`, { timeout: 30_000 }, () => {
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

    it("sends a session of messages, printing what the CLI prints, its exit marked as the CLI's exit code would mark it (A4; R4)", async () => {
      // The CLI's run on a daemon of its own, so both start from the same state: the first message brings the agent online.
      const c = await portalHarness();
      const cliFirst = await c.cli(['user=alice', 'recipe=hello-world', 'channel=lab', 'message=hello'], {
        verbose: true,
      });
      const cliSecond = await c.cli(['user=alice', 'recipe=hello-world', 'channel=lab', 'message=hello again'], {
        verbose: true,
      });
      const quiet = await c.cli(['user=alice', 'recipe=hello-world', 'channel=lab', 'message=hello']);
      const unknown = await c.cli(['user=alice', 'recipe=no-such-recipe', 'channel=lab', 'message=hello']);
      await c.close();
      expect([cliFirst.code, cliSecond.code, quiet.code, unknown.code]).toEqual([0, 0, 0, 1]);

      p = await h.open(browser, 'alice');
      const first = await send(p.page, { channel: 'lab', recipe: 'hello-world', text: 'hello' });
      expect(first).toEqual({ state: 'done', replies: cliFirst.out, errors: quiet.err, details: cliFirst.err });
      const second = await send(p.page, { text: 'hello again' });
      expect(second).toEqual({ state: 'done', replies: cliSecond.out, errors: '', details: cliSecond.err });
      const failed = await send(p.page, { recipe: 'no-such-recipe', text: 'hello' });
      expect([failed.state, failed.replies, failed.errors]).toEqual(['failed', '', unknown.err]);
      expect(unknown.err).toMatch(/^✗ unknown_recipe: /);
      expect([p.errors, p.violations]).toEqual([[], []]);
    });

    it("shows an ask's waiting line as the CLI prints it, and its Answer button fills the form so Send sends the CLI's answer body; conversation= beside another field is refused, nothing sent (patterns-phase-3 R27; portal R8)", async () => {
      const hello = JSON.parse(await readFile(join(h.root, 'recipes', 'hello-world.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      await writeFile(
        join(h.root, 'recipes', 'asker.json'),
        JSON.stringify({ ...hello, id: 'asker', tools: ['ask_user'] }),
      );
      h.answer = (incoming) =>
        incoming.includes('The user answered what you asked them:\nyes\n') ? 'Then I will.' : { ask: 'Shall I?' };
      const cliBodies: unknown[] = [];
      const recording: typeof fetch = async (input, init) => {
        if (requestUrl(input).endsWith(Routes.conversations)) cliBodies.push(JSON.parse(requestBodyText(init)));
        return fetch(input, init);
      };
      const asked = await h.cli(['user=alice', 'recipe=asker', 'channel=lab', 'message=Ask me first.'], {
        fetch: recording,
      });
      expect([asked.code, asked.out]).toEqual([0, 'Shall I?\n']);
      const cliMatch = present(/conversation=(\S+)/.exec(asked.err), 'cli conversation id match');
      const cliId = present(cliMatch[1], 'cli conversation id');
      const cliAnswer = await h.cli(['user=alice', 'channel=lab', `conversation=${cliId}`, 'message=yes'], {
        fetch: recording,
      });
      expect([cliAnswer.code, cliAnswer.out]).toEqual([0, 'Then I will.\n']);

      p = await h.open(browser, 'alice');
      const pageBodies: unknown[] = [];
      p.page.on('request', (r) => {
        if (r.url().endsWith(Routes.conversations) && r.method() === 'POST')
          pageBodies.push(JSON.parse(present(r.postData(), 'request postData')));
      });
      const ask = await send(p.page, { channel: 'lab', recipe: 'asker', user: 'alice', text: 'Ask me first.' });
      expect([ask.state, ask.replies]).toEqual(['done', 'Shall I?\n']);
      const pageMatch = present(/conversation=(\S+)/.exec(ask.errors), 'page conversation id match');
      const pageId = present(pageMatch[1], 'page conversation id');
      // The same line the CLI printed, for the page's own conversation.
      expect(ask.errors).toBe(
        asked.err
          .replace(cliId, pageId)
          .split('\n')
          .filter((l) => l.startsWith('? '))
          .join('\n') + '\n',
      );
      await chooseRecipe(p.page, '');
      await p.page.fill('#send-channel', 'main');
      await p.page.locator('#send-log > article').last().locator('button.answer').click();
      expect([
        await p.page.inputValue('#send-channel'),
        await p.page.inputValue('#send-user'),
        await p.page.inputValue('#send-conversation'),
      ]).toEqual(['lab', 'alice', pageId]);
      const answered = await send(p.page, { text: 'yes' });
      expect([answered.state, answered.replies]).toEqual(['done', 'Then I will.\n']);
      expect(await p.page.inputValue('#send-conversation')).toBe('');
      expect(pageBodies).toEqual([
        { user: 'alice', channel: 'lab', recipe: 'asker', message: 'Ask me first.' },
        { user: 'alice', channel: 'lab', conversation: pageId, message: 'yes' },
      ]);
      expect(cliBodies).toEqual([
        { user: 'alice', channel: 'lab', recipe: 'asker', message: 'Ask me first.' },
        { user: 'alice', channel: 'lab', conversation: cliId, message: 'yes' },
      ]);
      const refused = await send(p.page, { conversation: pageId, to: 'asker-1', text: 'yes' });
      expect([refused.state, refused.errors]).toEqual([
        'failed',
        '✗ conversation= answers what an agent asked: it takes only channel=, user= and message=, not to=\n',
      ]);
      expect(pageBodies).toHaveLength(2);
    });

    it("sends a message's budget and topic as the CLI's posts=, tokens= and topic= send them, and refuses what the CLI refuses, sending nothing (patterns-phase-3 R15, R21; portal R8)", async () => {
      const cliBodies: unknown[] = [];
      const recording: typeof fetch = async (input, init) => {
        if (requestUrl(input).endsWith(Routes.conversations)) cliBodies.push(JSON.parse(requestBodyText(init)));
        return fetch(input, init);
      };
      const cli = await h.cli(
        ['user=alice', 'recipe=hello-world', 'channel=lab', 'posts=8', 'tokens=6000', 'message=hello'],
        { fetch: recording },
      );
      expect(cli.code).toBe(0);
      // No member of the channel takes the topic: both are refused unknown_topic after the same body.
      const cliTopic = await h.cli(['user=alice', 'channel=lab', 'topic=weather', 'message=Rain.'], {
        fetch: recording,
      });
      expect(cliTopic.code).toBe(1);
      p = await h.open(browser, 'alice');
      const pageBodies: unknown[] = [];
      p.page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().endsWith(Routes.conversations))
          pageBodies.push(JSON.parse(r.postData() ?? 'null'));
      });
      const sent = await send(p.page, {
        channel: 'lab',
        recipe: 'hello-world',
        posts: '8',
        tokens: '6000',
        text: 'hello',
      });
      expect(sent.state).toBe('done');
      const topic = await send(p.page, { recipe: '', posts: '', tokens: '', topic: 'weather', text: 'Rain.' });
      expect([topic.state, topic.errors]).toEqual(['failed', cliTopic.err]);
      expect(pageBodies).toEqual(cliBodies);
      expect(pageBodies).toEqual([
        { user: 'alice', channel: 'lab', recipe: 'hello-world', message: 'hello', budget: { posts: 8, tokens: 6000 } },
        { user: 'alice', channel: 'lab', topic: 'weather', message: 'Rain.' },
      ]);
      const refused = await send(p.page, { topic: '', posts: '0', text: 'hello' });
      expect([refused.state, refused.errors]).toEqual(['failed', '✗ posts= is a whole number from 1 to 32, not 0\n']);
      const both = await send(p.page, { posts: '', topic: 'weather', to: 'hewo-1', text: 'hello' });
      expect([both.state, both.errors]).toEqual([
        'failed',
        '✗ topic= and to= cannot be given together: a message goes to a topic or to one agent\n',
      ]);
      expect(pageBodies).toHaveLength(2);
      expect([p.errors, p.violations]).toEqual([[], []]);
    });

    it('watches a channel, each line as --watch prints it for the same events (A5; R5)', async () => {
      p = await h.open(browser, 'alice');
      await p.page.click('#tab-watch');
      await p.page.fill('#watch-channel', 'lab');
      await p.page.click('#watch-button');
      // The details area is hidden until asked for: attached, not visible.
      await p.page
        .locator('#watch-output pre.details', { hasText: 'watching channel "lab"' })
        .waitFor({ state: 'attached' });
      let stop!: () => void;
      const stopped = new Promise<void>((resolve) => (stop = resolve));
      const live = { out: [] as string[], err: [] as string[] };
      const watching = h.cli(['--watch', 'channel=lab'], { verbose: true, stop: stopped, live });
      await expect.poll(() => live.err.join(''), { timeout: 5_000 }).toContain('› watching channel "lab"');
      expect(
        (await h.cli(['user=bob', 'recipe=hello-world', 'channel=lab', 'message=Please say: Hello World.'])).code,
      ).toBe(0);
      await expect.poll(() => live.out.join(''), { timeout: 5_000 }).toContain('output hewo-1 → bob');
      await p.page.locator('#watch-output pre.replies', { hasText: 'output hewo-1 → bob' }).waitFor();
      stop();
      const cli = await watching;
      expect(cli.code).toBe(0);
      const page = (await p.page.locator('#watch-output pre.replies').textContent()) ?? '';
      expect(page).toBe(cli.out);
      expect(page.split('\n').filter((l) => l !== '').length).toBeGreaterThanOrEqual(4);
    });

    it("shows an agent's reply that is markup as its literal text, runs none of it, is refused in a frame, and keeps the credential out of the address, local storage and cookies (A14; R13)", async () => {
      const markup = `<img src=x onerror="fetch('/v1/stop',{method:'POST'})"> and <b>x</b>`;
      h.answer = () => markup;
      p = await h.open(browser, 'alice');
      const block = await send(p.page, { channel: 'lab', recipe: 'hello-world', text: 'hello' });
      expect([block.state, block.replies]).toEqual(['done', `${markup}\n`]);
      expect(await p.page.locator('#send-log img, #send-log b').count()).toBe(0);
      expect(p.requests.filter((r) => r.includes(Routes.stop))).toEqual([]);
      expect(p.violations).toEqual([]);
      // No fragment, nothing in local storage, no cookie.
      const state = await p.page.evaluate<string>(
        'JSON.stringify([location.href, localStorage.length, document.cookie])',
      );
      expect(JSON.parse(state)).toEqual([`${h.base}/`, 0, '']);
      // Another loopback origin framing the page: refused by frame-ancestors 'none'.
      const framing = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><iframe id="f" src="${h.base}/"></iframe>`);
      });
      await new Promise<void>((resolve) => framing.listen(0, '127.0.0.1', resolve));
      try {
        const other = await p.context.newPage();
        await other.goto(`http://127.0.0.1:${String((framing.address() as AddressInfo).port)}/`);
        await other.waitForTimeout(500);
        const frame = other.frames().find((f) => f !== other.mainFrame());
        // The portal's form never appears in the frame: the browser refused to render the page there (a page rendered
        // there would show it at once; Firefox leaves the refused frame with no document to look in).
        const portalInside =
          frame === undefined
            ? false
            : await frame.waitForSelector('#send-form', { state: 'attached', timeout: 2_000 }).then(
                () => true,
                () => false,
              );
        expect([frame?.url() === `${h.base}/`, portalInside]).toEqual([false, false]);
        await other.close();
      } finally {
        framing.closeAllConnections();
        await new Promise((resolve) => framing.close(resolve));
      }
    });

    describe('attaching files from the page (A20; R8a)', () => {
      let dir: string;
      beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'asha-attach-'));
      });
      const requested = (paths: readonly string[]) => p.requests.filter((r) => paths.some((path) => r.endsWith(path)));
      const sent = [`POST ${Routes.channelSpace}`, `POST ${Routes.channelFiles}`, `POST ${Routes.conversations}`];

      it('notes.txt goes with hello as file= sends it: the same lines, the same attachment line in the delivery, the body the manifest line and the bytes; the notice beside the picker', async () => {
        const notes = Buffer.from('some notes\n');
        await writeFile(join(dir, 'notes.txt'), notes);
        const cli = await h.cli(
          ['user=alice', 'recipe=hello-world', 'channel=lab', `file=${join(dir, 'notes.txt')}`, 'message=hello'],
          { cwd: dir },
        );
        const cliPrompt = present(h.prompts.at(-1), 'cli prompt');
        p = await h.open(browser, 'alice');
        expect(await p.page.locator('#send-notice').textContent()).toBe(NOTICE);
        const captured: { body: Buffer | null } = { body: null };
        await p.page.route(`**${Routes.channelFiles}?*`, async (route) => {
          captured.body = route.request().postDataBuffer();
          await route.continue();
        });
        const block = await send(p.page, {
          channel: 'lab',
          recipe: 'hello-world',
          text: 'hello',
          files: [join(dir, 'notes.txt')],
        });
        expect([block.state, block.replies, block.errors]).toEqual(['done', cli.out, cli.err]);
        const pagePrompt = present(h.prompts.at(-1), 'page prompt');
        const folder = (text: string) => text.replace(/upload-[0-9a-f]{16}/g, 'upload-…');
        expect(folder(pagePrompt)).toBe(folder(cliPrompt));
        expect(pagePrompt).toContain('notes.txt');
        const { createHash } = await import('node:crypto');
        const manifest = `${JSON.stringify([{ name: 'notes.txt', size: notes.length, sha256: createHash('sha256').update(notes).digest('hex') }])}\n`;
        expect(
          captured.body === null ? null : captured.body.equals(Buffer.concat([Buffer.from(manifest), notes])),
        ).toBe(true);
      });

      it.each([
        ['id_ed25519', 'id_ed25519'],
        ['.env.local', '.env.*'],
        ['server.pem', '*.pem'],
        ['credentials', 'credentials'],
      ])('%s is on the deny list by name: refused as the CLI says it, nothing sent', async (file, entry) => {
        p = await h.open(browser, 'alice');
        const block = await send(p.page, {
          channel: 'lab',
          recipe: 'hello-world',
          text: 'hello',
          files: [{ name: file, mimeType: 'application/octet-stream', buffer: Buffer.from('secret') }],
        });
        expect([block.state, block.errors]).toEqual([
          'failed',
          `✗ ${file}: on the credential deny list (a file named ${entry})\n`,
        ]);
        expect(requested(sent)).toEqual([]);
      });

      it('a config.json picked from a .docker folder is uploaded and attached, as the notice says', async () => {
        await mkdir(join(dir, '.docker'));
        await writeFile(join(dir, '.docker', 'config.json'), '{"auths":{}}\n');
        p = await h.open(browser, 'alice');
        const block = await send(p.page, {
          channel: 'lab',
          recipe: 'hello-world',
          text: 'hello',
          files: [join(dir, '.docker', 'config.json')],
        });
        expect(block.state).toBe('done');
        expect(block.details).toMatch(
          /attached config\.json as \/channel\/upload-[0-9a-f]{16}\/config\.json \(13 bytes\)/,
        );
      });

      it('more than 10 files, a file of 25,000,001 bytes, a name not in NFC: each refused as the CLI says it, nothing sent', async () => {
        p = await h.open(browser, 'alice');
        const eleven = Array.from({ length: 11 }, (_, i) => ({
          name: `f${String(i + 1)}.txt`,
          mimeType: 'text/plain',
          buffer: Buffer.from(String(i)),
        }));
        expect(
          (await send(p.page, { channel: 'lab', recipe: 'hello-world', text: 'eleven', files: eleven })).errors,
        ).toBe('✗ f11.txt: more than 10 files\n');
        expect(
          (
            await send(p.page, {
              text: 'big',
              files: [{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(25_000_001) }],
            })
          ).errors,
        ).toBe('✗ big.bin: over 25,000,000 bytes\n');
        const nfd = 'é.txt';
        expect(
          (
            await send(p.page, {
              text: 'nfd',
              files: [{ name: nfd, mimeType: 'text/plain', buffer: Buffer.from('x') }],
            })
          ).errors,
        ).toBe(`✗ ${nfd}: the name is not in Unicode NFC\n`);
        expect(requested(sent)).toEqual([]);
      });

      it("a space whose usage leaves less room than the file: the CLI's space line, nothing uploaded", async () => {
        p = await h.open(browser, 'alice', {
          before: async (page) => {
            await page.route(`**${Routes.channelSpace}`, (route) =>
              route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: spaceReady({ bytes: 255_999_995, entries: 3, cloudAgents: [] }),
              }),
            );
          },
        });
        const block = await send(p.page, {
          channel: 'lab',
          recipe: 'hello-world',
          text: 'hello',
          files: [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('0123456789') }],
        });
        expect([block.state, block.errors]).toEqual([
          'failed',
          "✗ notes.txt: channel lab's file space would hold more than 256,000,000 bytes\n",
        ]);
        expect(requested([`POST ${Routes.channelFiles}`])).toEqual([]);
      });

      it('a cloud-granted agent on the channel: its ⚠ line is shown before the upload is sent', async () => {
        let shownAtUpload = '';
        p = await h.open(browser, 'alice', {
          before: async (page) => {
            await page.route(`**${Routes.channelSpace}`, (route) =>
              route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: spaceReady({ bytes: 0, entries: 0, cloudAgents: ['cloud-1'] }),
              }),
            );
            await page.route(`**${Routes.channelFiles}?*`, async (route) => {
              shownAtUpload = (await page.locator('#send-log > article pre.errors').last().textContent()) ?? '';
              await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'probe', reason: 'space_busy' }),
              });
            });
          },
        });
        await send(p.page, {
          channel: 'lab',
          text: 'hello',
          files: [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }],
        });
        expect(shownAtUpload).toBe('⚠ cloud-1 is cloud-granted: files on channel lab may leave this machine\n');
      });

      it('every upload refusal of UPLOAD_REFUSALS is shown as the CLI prints it, the message not posted and not reported; answers outside the table are bad_status, each reported once', async () => {
        let answer: { status: number; body: string } = { status: 200, body: '' };
        p = await h.open(browser, 'alice', {
          before: async (page) => {
            await page.route(`**${Routes.channelFiles}?*`, (route) =>
              route.fulfill({ status: answer.status, contentType: 'application/json', body: answer.body }),
            );
          },
        });
        await p.page.fill('#send-channel', 'lab');
        await chooseRecipe(p.page, 'hello-world');
        const wrong: string[] = [];
        for (const [key, status] of Object.entries(UPLOAD_REFUSALS)) {
          answer = { status, body: JSON.stringify({ error: 'probe', reason: key }) };
          const block = await send(p.page, {
            text: `refused ${key}`,
            files: [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') }],
          });
          if (block.state !== 'failed' || block.errors !== `✗ upload to channel lab: ${String(status)} ${key}: probe\n`)
            wrong.push(`${key}: ${JSON.stringify(block)}`);
        }
        expect(wrong).toEqual([]);
        expect(requested([`POST ${Routes.conversations}`])).toEqual([]);
        expect(h.logger.events()).not.toContain('portal.client_error');
        for (const outside of [
          { status: 418, body: JSON.stringify({ error: 'probe', reason: 'teapot' }) },
          { status: 400, body: JSON.stringify({ error: 'probe', reason: 'nope' }) },
          { status: 400, body: 'not json' },
        ]) {
          answer = outside;
          const block = await send(p.page, {
            text: `outside ${String(outside.status)}`,
            files: [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') }],
          });
          expect([block.state, block.errors]).toEqual([
            'failed',
            `✗ bad_status: ${Routes.channelFiles} answered HTTP ${String(outside.status)}\n`,
          ]);
        }
        expect(
          h.logger.entries
            .filter((e) => e.event === 'portal.client_error')
            .map((e) => [e.fields['reason'], e.fields['detail']]),
        ).toEqual([
          ['bad_status', `${Routes.channelFiles} 418`],
          ['bad_status', `${Routes.channelFiles} 400`],
          ['bad_status', `${Routes.channelFiles} 400`],
        ]);
      });

      it("the daemon's own 401 (a wrong credential) shows run asha --portal, and its 503 while stopping shows stopping, each within 5,000 ms with a 25,000,000-byte file, neither reported", async () => {
        const big = { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(25_000_000, 0x61) };
        p = await h.open(browser, 'alice', {
          before: async (page) => {
            await page.route(`**${Routes.channelFiles}?*`, (route) =>
              route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${'f'.repeat(64)}` } }),
            );
          },
        });
        const unauthorized = await send(p.page, {
          channel: 'lab',
          recipe: 'hello-world',
          text: 'with a wrong credential',
          files: [big],
        });
        expect(Date.now() - present(p.sentAt.get(`POST ${Routes.channelFiles}`), 'sent-at time')).toBeLessThan(5_000);
        expect([unauthorized.state, unauthorized.errors]).toEqual(['failed', UNAUTHORIZED_LINE]);
        await p.context.close();
        // A held stop: the agent's stop is held, so the daemon stays stopping.
        expect((await h.cli(['--launch', 'recipe=hello-world', 'channel=lab'])).code).toBe(0);
        const held = h.holdStop();
        h.daemon.requestStop({ source: 'call' });
        p = await h.open(browser, 'alice', {
          wait: false,
          before: async (page) => {
            await page.route(`**${Routes.channelSpace}`, (route) =>
              route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: spaceReady({ bytes: 0, entries: 0, cloudAgents: [] }),
              }),
            );
          },
        });
        const stopping = await send(p.page, { channel: 'lab', text: 'while stopping', files: [big] });
        expect(Date.now() - present(p.sentAt.get(`POST ${Routes.channelFiles}`), 'sent-at time')).toBeLessThan(5_000);
        expect([stopping.state, stopping.errors]).toEqual(['stopping', STOPPING_LINE]);
        expect(h.logger.events()).not.toContain('portal.client_error');
        held.release();
        await h.daemon.stopped;
      });

      it('an upload held past UPLOAD_ANSWER_MS (the manual clock) is a timeout, shown and reported (A20 (h); R18)', async () => {
        p = await h.open(browser, 'alice', {
          clock: true,
          before: async (page) => {
            await page.route(`**${Routes.channelSpace}`, (route) =>
              route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: spaceReady({ bytes: 0, entries: 0, cloudAgents: [] }),
              }),
            );
            // Held: no answer ever comes.
            await page.route(`**${Routes.channelFiles}?*`, () => undefined);
          },
        });
        await p.page.fill('#send-channel', 'lab');
        await p.page.fill('#send-text', 'held');
        await p.page.setInputFiles('#send-files', [
          { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
        ]);
        await p.page.click('#send-button');
        await expect.poll(() => p.requests.includes(`POST ${Routes.channelFiles}`)).toBe(true);
        await p.page.clock.runFor(UPLOAD_ANSWER_MS - 1);
        expect(await p.page.locator('#send-log > article').last().getAttribute('data-state')).toBe('sending');
        await p.page.clock.runFor(1);
        await p.page.locator('#send-log > article[data-state="failed"] pre.errors', { hasText: 'timeout' }).waitFor();
        expect(await p.page.locator('#send-log > article pre.errors').last().textContent()).toBe(
          `✗ timeout: ${Routes.channelFiles} did not answer in time\n`,
        );
        await expect
          .poll(() =>
            h.logger.entries
              .filter((e) => e.event === 'portal.client_error')
              .map((e) => [e.fields['reason'], e.fields['detail']]),
          )
          .toEqual([['timeout', Routes.channelFiles]]);
      });
    });

    describe("an upload holding asha's credential, from the page (A22; R8b)", () => {
      it("the page leaves the bytes to the daemon: a copy of daemon.json first of two, the second 25,000,000 bytes — the daemon's refusal within 5,000 ms, the rest of the body drained to its end", async () => {
        const dir = await mkdtemp(join(tmpdir(), 'asha-attach-'));
        await copyFile(h.paths.daemonFile, join(dir, 'daemon-copy.json'));
        p = await h.open(browser, 'alice');
        const copy = {
          name: 'daemon-copy.json',
          mimeType: 'application/json',
          buffer: await readFile(join(dir, 'daemon-copy.json')),
        };
        const block = await send(p.page, {
          channel: 'lab',
          recipe: 'hello-world',
          text: 'read it',
          files: [
            copy,
            { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(25_000_000, 0x61) },
          ],
        });
        expect([block.state, block.errors]).toEqual([
          'failed',
          "✗ upload to channel lab: 400 holds_asha_secret: daemon-copy.json holds asha's control credential\n",
        ]);
        // The daemon's line, after the page's upload request was made: the page never checks bytes itself.
        expect(Date.now() - present(p.sentAt.get(`POST ${Routes.channelFiles}`), 'sent-at time')).toBeLessThan(5_000);
        await expect
          .poll(
            () =>
              h.logger.entries
                .filter((e) => e.event === 'files.body_drained')
                .map((e) => [e.level, e.fields['status'], e.fields['outcome']]),
            { timeout: 5_000 },
          )
          .toEqual([['info', 400, 'ended']]);
      });

      it('a refusal the daemon answers before the body (space_entries) with 25,000,000 bytes still unsent: the page shows it within 5,000 ms', async () => {
        // lab's space, made ready; then filled to 999 entries, which the page is told are 0.
        await (
          await fetch(`${h.base}${Routes.channelSpace}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${h.credential}`, 'content-type': 'application/json' },
            body: JSON.stringify({ channel: 'lab', recipe: 'hello-world' }),
          })
        ).text();
        const volume = present([...h.runtime.volumes.values()][0], 'lab volume');
        for (let i = 0; i < 999; i += 1)
          volume.entries.set(`e${String(i)}`, {
            type: 'file',
            content: Buffer.from('e'),
            owner: '1000:1000',
            mode: 0o644,
          });
        p = await h.open(browser, 'alice', {
          before: async (page) => {
            await page.route(`**${Routes.channelSpace}`, (route) =>
              route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: spaceReady({ bytes: 0, entries: 0, cloudAgents: [] }),
              }),
            );
          },
        });
        const block = await send(p.page, {
          channel: 'lab',
          text: 'full',
          files: [{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(25_000_000, 0x61) }],
        });
        expect(Date.now() - present(p.sentAt.get(`POST ${Routes.channelFiles}`), 'sent-at time')).toBeLessThan(5_000);
        expect([block.state, block.errors]).toEqual([
          'failed',
          '✗ upload to channel lab: 413 space_entries: the space would hold 1001 entries, over its bound of 1000\n',
        ]);
      });
    });
  });
}
