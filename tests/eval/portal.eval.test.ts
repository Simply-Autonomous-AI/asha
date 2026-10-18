// The portal end to end on the real model (docs/plans/portal.md A19, A2's listening socket, A15's process): `./asha
// --server` run as a process under a fresh home; `./asha --portal` with a stub `open` first on PATH that records the
// file it is given; each pinned headless browser — Chromium, and Firefox, the owner's default — opening that file as
// the owner's browser would, landing on the page with no fragment, and sending the hello-world message; the watch view
// showing the reply and its arc; then the page's stop ending `--server` with exit 0. Nothing opens the owner's own
// browser: `open` is the stub.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loginNameToUserId } from '../../src/shared/protocol.js';
import { BROWSERS, launchBrowser } from '../helpers/browser.js';
import { chooseRecipe } from '../helpers/portal-page.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const ASHA = join(REPO, 'asha');
const ME = loginNameToUserId(userInfo().username);

let home: string;
let bin: string;
let opened: string;
let env: NodeJS.ProcessEnv;
let server: ChildProcess;
let serverExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    execFile(ASHA, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error && error.killed)
        reject(new Error(`asha ${args.join(' ')} exceeded ${String(timeoutMs)} ms\nstderr: ${stderr}`));
      else resolveRun({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

const records = async () =>
  (await readFile(join(home, 'logs', 'daemon.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; [k: string]: unknown });

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'asha-portal-eval-'));
  home = join(base, 'home');
  bin = join(base, 'bin');
  opened = join(base, 'opened.txt');
  await mkdir(bin);
  // The stub `open`: records the one argument it is given, and exits 0.
  await writeFile(join(bin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${opened}'\n`);
  await chmod(join(bin, 'open'), 0o755);
  env = {
    ...process.env,
    ...TEST_DAEMON_ENV,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    ASHA_HOME: home,
    ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] || join(homedir(), '.simplyautonomous', 'harness', 'models'),
  };
  server = spawn(process.execPath, [join(REPO, 'dist', 'src', 'cli', 'main.js'), '--server'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExit = new Promise((done) =>
    server.once('exit', (code, signal) => {
      done({ code, signal });
    }),
  );
  const by = Date.now() + 30_000;
  for (;;) {
    try {
      await readFile(join(home, 'daemon.json'));
      break;
    } catch {
      if (Date.now() > by) throw new Error('asha --server wrote no daemon.json within 30 s');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

afterAll(async () => {
  // Never leave the daemon running: SIGTERM if the test did not stop it.
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await serverExit;
  }
});

describe('the portal on the real model (A19; R1–R5, R12)', () => {
  it('asha --portal prints the address, opens the forwarding file, and the daemon holds one listening socket (A2)', async () => {
    const portal = await run(['--portal'], 60_000);
    const { port, pid } = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8')) as {
      port: number;
      pid: number;
    };
    expect([portal.code, portal.stdout]).toEqual([0, `portal: http://127.0.0.1:${String(port)}/\n`]);
    expect(await readFile(opened, 'utf8')).toBe(`${join(home, 'portal.html')}\n`);
    expect(pid).toBe(server.pid);
    const listening = await new Promise<string>((done, reject) =>
      execFile('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)], (error, stdout) => {
        if (error) {
          const rejection: Error = error;
          reject(rejection);
        } else done(stdout);
      }),
    );
    const sockets = listening.trim().split('\n').slice(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toContain(`127.0.0.1:${String(port)} (LISTEN)`);
  });

  for (const name of BROWSERS) {
    it(`in ${name}: the forwarding file lands on the page with no fragment; Hello World. comes back, and the watch view shows it and its arc`, async () => {
      const { port } = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8')) as { port: number };
      const browser = await launchBrowser(name);
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`file://${(await readFile(opened, 'utf8')).trim()}`);
        await page.waitForURL(`http://127.0.0.1:${String(port)}/`);
        await page.locator('#daemon-line', { hasText: /^daemon pid / }).waitFor();
        expect(page.url()).toBe(`http://127.0.0.1:${String(port)}/`);
        expect(await page.inputValue('#send-user')).toBe(ME);
        // The CLI's lines are compared: each view's command-line view ticked (portal-scene-chat R9, A9).
        await page.check('#send-cli');
        // The watch view on the channel first, then the message from the send view.
        await page.click('#tab-watch');
        await page.check('#watch-cli');
        await page.fill('#watch-channel', 'portal-eval');
        await page.click('#watch-button');
        await page
          .locator('#watch-output pre.details', { hasText: 'watching channel "portal-eval"' })
          .waitFor({ state: 'attached' });
        let arcs = 0;
        const watchArcs = setInterval(() => {
          void page
            .locator('#scene')
            .getAttribute('data-arcs')
            .then(
              (n) => (arcs = Math.max(arcs, Number(n ?? 0))),
              () => undefined,
            );
        }, 50);
        await page.click('#tab-send');
        await page.fill('#send-channel', 'portal-eval');
        await chooseRecipe(page, 'hello-world');
        await page.fill('#send-text', 'Please say: Hello World.');
        await page.click('#send-button');
        await page.locator('#send-log > article:last-child:not([data-state="sending"])').waitFor({ timeout: 600_000 });
        const block = page.locator('#send-log > article').last();
        expect([await block.getAttribute('data-state'), await block.locator('pre.replies').textContent()]).toEqual([
          'done',
          'Hello World.\n',
        ]);
        await page.click('#tab-watch');
        await page.locator('#watch-output pre.replies', { hasText: `→ ${ME}: Hello World.` }).waitFor();
        clearInterval(watchArcs);
        expect(arcs).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    }, 900_000);
  }

  it("the page's stop ends asha --server with exit 0, daemon.stopped logged (A15)", async () => {
    const { port } = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8')) as { port: number };
    const browser = await launchBrowser('chromium');
    try {
      const page = await browser.newPage();
      await page.goto(`file://${(await readFile(opened, 'utf8')).trim()}`);
      await page.waitForURL(`http://127.0.0.1:${String(port)}/`);
      await page.locator('#daemon-line', { hasText: /^daemon pid / }).waitFor();
      await page.click('#tab-status');
      await page.click('#stop-button');
      await page.click('#stop-yes');
      await page.locator('#stop-state', { hasText: 'stopped serving' }).waitFor({ timeout: 120_000 });
    } finally {
      await browser.close();
    }
    expect(await serverExit).toEqual({ code: 0, signal: null });
    const events = (await records()).map((r) => r.event);
    expect(events.filter((e) => e === 'daemon.stop_requested' || e === 'daemon.stopped')).toEqual([
      'daemon.stop_requested',
      'daemon.stopped',
    ]);
    expect((await records()).find((r) => r.event === 'daemon.stop_requested')).toMatchObject({ source: 'portal' });
  }, 300_000);
});
