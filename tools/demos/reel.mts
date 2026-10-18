// npm run demos:reel (docs/plans/demo-videos.md R6, R12): the combined demo video. A local page opens on the owner's
// opening page, plays every promoted demo video in catalogue order but those REEL_LEAVES_OUT names (P25, R17) at
// playback rate 2, each after a title card naming
// the demo and its purpose — 1 s and 150 ms a word, 3 s to 8 s — and holds each one's last frame 3 s; then the end
// page (docs/plans/demo-scene-refresh.md R12, R13, R15). The pinned headless Chromium shows it at 1280 × 720,
// captured at 2× and encoded once as each demo's video is (R5), into
// docs/patterns/videos/demos.webm (git-ignored: the website keeps the combined video, decision demo-reel-mp4) with its
// sidecar demos.json, which is committed. Refuses to start on a change outside the results paths,
// unless every video it plays is promoted (since R17 not P25's, which it leaves out), and while another process holds
// the agent-suite lock, naming it; holds the lock for the whole run. Exits 1 on any failure. What it decides — the
// demos, the parts, the bounds and the sidecar — is in decide.mts, with its tests.
//
// Runs with Node's TypeScript support and the resolve hook beside it (package.json `demos:reel`).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';

import { RESULTS_PATHS } from '../../evals/patterns/selection.js';
import { isAlive } from '../../src/daemon/process/pid-lock.js';
import { browsersPath, pinnedRevision, requireBrowser } from '../../tests/helpers/browser.js';
import {
  AGENT_SUITE_LOCK,
  AgentSuiteRunning,
  LIGHT_RUNS_DIR,
  agentSuiteSetup,
  nodeLightRunFs,
  stderrLogger,
} from '../../tests/helpers/suite-lock.js';
import {
  CAPTURE_BOUND_MS,
  FRAME_SIZE,
  MAX_GAP_MS,
  MIN_FPS,
  ENDING_PAGE,
  OPENING_PAGE,
  REEL_LEAVES_OUT,
  bounded,
  REEL_HOLD_MS,
  VIEW,
  encode,
  ffmpegRunner,
  framesPerSecond,
  jpegSize,
  longestGap,
  titleOf,
  type Frame,
} from '../../tests/agents/patterns/recorder.js';

import {
  ENDING_MS,
  OPENING_MS,
  REEL_RATE,
  catalogueOrder,
  playbackBoundMs,
  reelDemos,
  reelPart,
  reelSidecar,
  unpromoted,
  type DemoEntry,
  type ReelPart,
} from './decide.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const VIDEOS = join(REPO, 'docs', 'patterns', 'videos');
/** A page call's bound, besides the video's own wait: a renderer that stops answering fails the reel, never stalls it. */
const PAGE_CALL_MS = 15_000;

/** A part's video, as promoted. */
const videoOf = (part: ReelPart): string => join(VIDEOS, `${part.slug}.webm`);

/** The page that plays the reel: the opening page, then each part's card and video, then the end page, each driven by the reel (page-side code is text). */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #0f1720; overflow: hidden; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; }
  #card { position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 0 120px; color: #f4f6f8; }
  #card h1 { margin: 0 0 18px; font-size: 44px; font-weight: 600; }
  #card p { margin: 0; font-size: 22px; line-height: 32px; color: #b7c2cc; }
  #page { position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 28px; padding: 0 60px; text-align: center; color: #f4f6f8; }
  #page p { margin: 0; font-size: 30px; line-height: 40px; color: #b7c2cc; }
  #page p:first-child { font-size: 40px; line-height: 50px; font-weight: 600; color: #f4f6f8; white-space: nowrap; }
  video { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #0f1720; }
  [hidden] { display: none !important; }
</style></head><body>
  <div id="page" hidden></div>
  <div id="card" hidden><h1></h1><p></p></div>
  <video id="part" muted playsinline hidden></video>
</body></html>
`;

const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

/** What the combined video is made from must be a commit (PRINCIPLES §13): no change outside the results paths. */
const treeClean = (): boolean => git('status', '--porcelain', '--', '.', ...RESULTS_PATHS.map((p) => `:!${p}`)) === '';

async function main(): Promise<number> {
  if (!treeClean()) {
    process.stderr.write(
      '✗ the tree has a change outside the results paths: commit it first, so the combined video names the commit it was made from\n',
    );
    return 1;
  }
  // The demos the combined video leaves out (R17) are skipped; every other promoted demo plays.
  const demos = reelDemos(
    catalogueOrder(
      JSON.parse(readFileSync(join(REPO, 'tests', 'agents', 'patterns', 'demos.json'), 'utf8')) as DemoEntry[],
      readFileSync(join(REPO, 'docs', 'patterns', 'index.md'), 'utf8'),
    ),
    REEL_LEAVES_OUT,
  );
  const missing = unpromoted(demos, (file) => existsSync(join(VIDEOS, file)));
  if (missing.length > 0) {
    process.stderr.write(
      `✗ every video the combined video plays must be promoted first; not promoted: ${missing.join(', ')}\n`,
    );
    return 1;
  }
  const parts = demos.map((d) => {
    const slug = d.page.slice('docs/patterns/'.length, -'.md'.length);
    const sidecar = JSON.parse(readFileSync(join(VIDEOS, `${slug}.json`), 'utf8')) as { readonly durationMs: number };
    return reelPart(d, titleOf(readFileSync(join(REPO, d.page), 'utf8')), {
      sha256: createHash('sha256')
        .update(readFileSync(join(VIDEOS, `${slug}.webm`)))
        .digest('hex'),
      durationMs: sidecar.durationMs,
    });
  });
  const ffmpeg = join(browsersPath(), `ffmpeg-${pinnedRevision('ffmpeg')}`, 'ffmpeg-mac');
  if (!existsSync(ffmpeg)) {
    process.stderr.write(`✗ the bundled ffmpeg is not installed at ${ffmpeg}\n`);
    return 1;
  }
  const version = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' });

  // The whole run under the agent-suite lock (R12): never beside a suite, an eval or another encode.
  let release: () => Promise<void>;
  try {
    release = await agentSuiteSetup({
      lockFile: AGENT_SUITE_LOCK,
      pid: process.pid,
      dir: LIGHT_RUNS_DIR,
      fs: nodeLightRunFs,
      isAlive,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      stderr: (text) => {
        process.stderr.write(text);
      },
      logger: stderrLogger,
    });
  } catch (error) {
    if (error instanceof AgentSuiteRunning) {
      process.stderr.write(`✗ ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  try {
    return await reel(parts, ffmpeg, version);
  } finally {
    await release();
  }
}

async function reel(parts: readonly ReelPart[], ffmpeg: string, version: string): Promise<number> {
  const commit = git('rev-parse', 'HEAD');
  const startedAt = new Date().toISOString();
  const dir = mkdtempSync(join(tmpdir(), 'asha-reel-'));
  mkdirSync(join(dir, 'frames'));
  writeFileSync(join(dir, 'reel.html'), PAGE);
  process.stderr.write(`› the reel of ${String(parts.length)} demos into ${dir}\n`);
  const browser = await chromium.launch({ headless: true, executablePath: requireBrowser('chromium') });
  const frames: Frame[] = [];
  const failures: string[] = [];
  const ended: { pattern: string; at: string }[] = [];
  let capturing = true;
  try {
    // Every browser call bounded, as the page's are: Playwright gives these none, and the reel holds the lock every
    // suite and eval waits on (the code review's round 4, R4-DESIGN-005).
    const context = await bounded(
      browser.newContext({ viewport: VIEW }),
      PAGE_CALL_MS,
      `opening the reel's browser context took more than ${String(PAGE_CALL_MS)} ms`,
    );
    const page = await bounded(
      context.newPage(),
      PAGE_CALL_MS,
      `opening the reel's page took more than ${String(PAGE_CALL_MS)} ms`,
    );
    page.on('pageerror', (error) => failures.push(`the reel's page threw: ${String(error)}`));
    await page.goto(pathToFileURL(join(dir, 'reel.html')).href);
    const cdp = await bounded(
      context.newCDPSession(page),
      PAGE_CALL_MS,
      `opening the reel's CDP session took more than ${String(PAGE_CALL_MS)} ms`,
    );
    await bounded(
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width: VIEW.width,
        height: VIEW.height,
        deviceScaleFactor: 2,
        mobile: false,
      }),
      PAGE_CALL_MS,
      `setting the reel's device metrics took more than ${String(PAGE_CALL_MS)} ms`,
    );
    const capture = (async () => {
      while (capturing) {
        const t0 = Date.now();
        try {
          const call = cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95 });
          let timer: NodeJS.Timeout | undefined;
          const { data } = await Promise.race([
            call,
            new Promise<never>(
              (_, reject) =>
                (timer = setTimeout(() => {
                  reject(new Error(`a capture call took more than ${String(CAPTURE_BOUND_MS)} ms`));
                }, CAPTURE_BOUND_MS)),
            ),
          ]).finally(() => {
            clearTimeout(timer);
          });
          const bytes = Buffer.from(data, 'base64');
          const file = join(dir, 'frames', `f${String(frames.length).padStart(6, '0')}.jpg`);
          writeFileSync(file, bytes);
          frames.push({ file, at: Date.now(), ...jpegSize(bytes) });
        } catch (error) {
          failures.push(`a capture call failed: ${String(error)}`);
          capturing = false;
        }
        if (Date.now() - t0 > CAPTURE_BOUND_MS) failures.push(`a capture call took ${String(Date.now() - t0)} ms`);
      }
    })();
    /** Shows a page of lines alone (R15), each line a paragraph, for `ms`. */
    const showPage = async (lines: readonly string[], ms: number): Promise<void> => {
      await bounded(
        page.evaluate(`(() => {
        const sheet = document.getElementById('page');
        sheet.replaceChildren(...${JSON.stringify(lines)}.map((line) => {
          const p = document.createElement('p');
          p.textContent = line;
          return p;
        }));
        document.getElementById('card').hidden = true;
        document.getElementById('part').hidden = true;
        sheet.hidden = false;
      })()`),
        PAGE_CALL_MS,
        'showing a page',
      );
      await new Promise((r) => setTimeout(r, ms));
    };
    process.stderr.write('› the opening page\n');
    // A page call that throws or overruns is the reel's failure, kept with its frames (the code review's round 2).
    try {
      await showPage(OPENING_PAGE, OPENING_MS);
      for (const part of parts) {
        if (failures.length > 0) break;
        process.stderr.write(`› ${part.pattern}\n`);
        await bounded(
          page.evaluate(`(() => {
        const card = document.getElementById('card');
        card.querySelector('h1').textContent = ${JSON.stringify(part.title)};
        card.querySelector('p').textContent = ${JSON.stringify(part.purpose)};
        document.getElementById('part').hidden = true;
        document.getElementById('page').hidden = true;
        card.hidden = false;
      })()`),
          PAGE_CALL_MS,
          `${part.pattern}'s card`,
        );
        await new Promise((r) => setTimeout(r, part.cardMs));
        // Its `ended`, within half its length (it plays at 2×) and 10 s more (R6).
        const boundMs = playbackBoundMs(part);
        const outcome = await bounded(
          page.evaluate<string>(`new Promise((resolve) => {
        const video = document.getElementById('part');
        const timer = setTimeout(() => resolve('timeout'), ${String(boundMs)});
        video.onended = () => { clearTimeout(timer); resolve('ended'); };
        video.onerror = () => { clearTimeout(timer); resolve('error: ' + (video.error ? video.error.message || video.error.code : 'unknown')); };
        video.src = ${JSON.stringify(pathToFileURL(videoOf(part)).href)};
        video.playbackRate = ${String(REEL_RATE)};
        video.defaultPlaybackRate = ${String(REEL_RATE)};
        document.getElementById('card').hidden = true;
        video.hidden = false;
        video.play().catch((e) => { clearTimeout(timer); resolve('error: ' + e.message); });
      })`),
          boundMs + PAGE_CALL_MS,
          `${part.pattern}'s playback`,
        );
        if (outcome !== 'ended')
          failures.push(`${part.pattern} did not reach ended within ${String(boundMs)} ms: ${outcome}`);
        else ended.push({ pattern: part.pattern, at: new Date().toISOString() });
        // Its last frame, held for its reader (demo-scene-refresh R12): an ended video shows its last frame.
        await new Promise((r) => setTimeout(r, REEL_HOLD_MS));
      }
      if (failures.length === 0) {
        process.stderr.write('› the end page\n');
        await showPage(ENDING_PAGE, ENDING_MS);
      }
    } catch (error) {
      failures.push(`the reel's page failed: ${String(error)}`);
    }
    capturing = false;
    await capture;
  } finally {
    capturing = false;
    // A close that overruns is a failure, kept in failed.json, not a wait for ever.
    await bounded(browser.close(), PAGE_CALL_MS, `closing the browser took more than ${String(PAGE_CALL_MS)} ms`).catch(
      (error: unknown) => {
        failures.push(`the browser did not close: ${String(error)}`);
      },
    );
  }
  const odd = frames.filter((f) => f.width !== FRAME_SIZE.width || f.height !== FRAME_SIZE.height).length;
  if (odd > 0) failures.push(`${String(odd)} frame(s) not ${String(FRAME_SIZE.width)} × ${String(FRAME_SIZE.height)}`);
  const fps = framesPerSecond(frames, []);
  if (fps < MIN_FPS) failures.push(`the capture ran at ${fps.toFixed(1)} frames a second, under ${String(MIN_FPS)}`);
  const gap = longestGap(frames, []);
  if (gap > MAX_GAP_MS)
    failures.push(`a gap of ${String(Math.round(gap))} ms between frames, over ${String(MAX_GAP_MS)} ms`);
  if (failures.length > 0) {
    writeFileSync(join(dir, 'failed.json'), `${JSON.stringify({ failures }, null, 1)}\n`);
    for (const f of failures) process.stderr.write(`✗ ${f}\n`);
    process.stderr.write(`› kept in ${dir}\n`);
    return 1;
  }
  process.stderr.write(`› encoding ${String(frames.length)} frames\n`);
  const output = join(dir, 'demos.webm');
  const encoded = await encode({
    frames,
    framesDir: join(dir, 'frames'),
    output,
    version,
    run: ffmpegRunner(ffmpeg),
    readFrame: (file) => readFileSync(file),
    exists: existsSync,
    size: (path) => statSync(path).size,
    removeFrames: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
  });
  if (!encoded.ok) {
    process.stderr.write(`✗ the encode failed: ${String(encoded.reason)}\n› kept in ${dir}\n`);
    return 1;
  }
  const sidecar = reelSidecar({
    commit,
    dirty: !treeClean() || git('rev-parse', 'HEAD') !== commit,
    startedAt,
    runFolder: dir.replace(tmpdir(), '<tmp>'),
    parts,
    ended,
    encoded,
    sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
    frames,
    leftOut: REEL_LEAVES_OUT,
  });
  const video = join(VIDEOS, 'demos.webm');
  copyFileSync(output, `${video}.partial`);
  renameSync(`${video}.partial`, video);
  writeFileSync(join(VIDEOS, 'demos.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
  process.stdout.write(
    `wrote docs/patterns/videos/demos.webm (${String(encoded.bytes)} bytes, ${String(encoded.durationMs)} ms)\n`,
  );
  return 0;
}

process.exitCode = await main();
