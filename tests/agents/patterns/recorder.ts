// The demo recorder (docs/plans/demo-videos.md R1–R5): a video of one pattern demo as the portal shows it, taken beside
// the demo's own agent-suite run. `agentSuite` starts it when ASHA_RECORD_DIR is set and `finishSuite` ends it before
// its --stop; it starts no daemon of its own (the suite's first command does), follows each stop the suite makes before
// the end by loading the page again (R3), and writes what it saw to `<ASHA_RECORD_DIR>/recording.json` beside its
// frames. `npm run demos:record` (tools/demos/record.mts) then encodes the frames once and promotes the video only when
// `refusals` finds nothing (R4, R5).
//
// What a recording keeps, so promotion can judge it after the run: every frame's file and the time its capture call
// returned; each followed restart's stop, reload and watch times; every failure the page showed or reported, with its
// time and document; the sampler's violations of the frame (R2); the page's pixel ratio at each check; and each
// document's thread as text, kept before its reload; and when the end's hold last saw the thread change (`lastLineAt`,
// demo-scene-refresh R12). Times are milliseconds since the epoch, so they compare with the
// daemon log's `ts`.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core';

import { requireBrowser } from '../../helpers/browser.js';
import { AgentSuiteRunning } from '../../helpers/suite-lock.js';
import { present } from '../../../src/shared/assert-present.js';
import { TEST_DAEMON_ENV } from '../../helpers/test-daemon-env.js';

/** The page's size; the capture is at twice it (R5). */
export const VIEW = { width: 1280, height: 720 } as const;
/** Every frame's size, in pixels (R5). */
export const FRAME_SIZE = { width: 2560, height: 1440 } as const;
/** The encode's frame rate: one tick every 40 ms (R5). */
const FPS = 25;
/** A capture call slower than this fails the recording (R5). */
export const CAPTURE_BOUND_MS = 5_000;
/** The capture's slowest rate, and its longest gap between frames outside a reload's span (R5). */
export const MIN_FPS = 15;
export const MAX_GAP_MS = 500;
/** How long the recorder waits for the suite's daemon, and for a new one after a stop (R1, R3). */
const DAEMON_WAIT_MS = 60_000;
const RESTART_WAIT_MS = 120_000;
/** How often the sampler, the pixel ratio and the banner are checked, besides at each load (R2, R5). */
const CHECK_EVERY_MS = 5_000;
/** The end: the scene's speech time (SCENE.speechMs) and a second more, so the last words are seen (R1). */
export const END_HOLD_MS = 4_000 + 1_000;
/** How long a demo's video runs on after its chat's last line, at least, for its reader (demo-scene-refresh R12). */
export const LAST_LINE_HOLD_MS = 3_000;
/**
 * The end's hold, at most: a thread still changing then ends it anyway, and promotion refuses the video (R12).
 */
export const END_HOLD_MAX_MS = 15_000;
/**
 * The whole end, at most (the code review's round 3 on demo-scene-refresh, R3-DESIGN-004): the hold, then the capture's
 * last iteration, the last thread read and the browser's close, each bounded by what is left of it; an overrun is the
 * recording's failure, and the end goes on to write recording.json. It runs in the suite's afterAll before its `--stop`
 * (100 s at most, tests/agents/support.ts): 18 s + 100 s stays inside the 120 s hook bound.
 */
export const END_BUDGET_MS = 18_000;
/** How often the end's hold reads the thread (R12). */
export const HOLD_POLL_MS = 250;

/**
 * How long the end still holds (R1; demo-scene-refresh R12), in ms from `now`: until END_HOLD_MS after it `began` and
 * LAST_LINE_HOLD_MS and one HOLD_POLL_MS after the thread's last change (`lastLineAt`), so the last frame is most likely past the
 * promotion's threshold, but never past END_HOLD_MAX_MS after it began; 0 when it may end now.
 */
export function holdLeft(now: number, began: number, lastLineAt: number): number {
  // One poll past the last line's 3 s, so the last frame captured is past it too.
  const tail = lastLineAt + LAST_LINE_HOLD_MS + HOLD_POLL_MS;
  const until = Math.min(began + END_HOLD_MAX_MS, Math.max(began + END_HOLD_MS, tail));
  return Math.max(0, until - now);
}
/**
 * The end's hold (R1; demo-scene-refresh R12): reads the thread, then again every HOLD_POLL_MS until holdLeft says the
 * hold may end, and returns when the thread last changed (its first read counts as no change). A read that throws, or
 * overruns the bound the caller gives it, rejects the hold.
 */
export async function holdUntilQuiet(
  read: () => Promise<readonly string[]>,
  now: () => number,
  wait: (ms: number) => Promise<void>,
): Promise<number> {
  const began = now();
  let lastLineAt = began;
  let seen = await read();
  for (let left = holdLeft(now(), began, lastLineAt); left > 0; left = holdLeft(now(), began, lastLineAt)) {
    await wait(Math.min(HOLD_POLL_MS, left));
    const current = await read();
    if (current.length !== seen.length || current.some((line, i) => line !== seen[i])) {
      lastLineAt = now();
      seen = current;
    }
  }
  return lastLineAt;
}

/** The combined video holds each demo's last frame this long before the next title card (demo-scene-refresh R12). */
export const REEL_HOLD_MS = 3_000;
/**
 * The demos the combined video leaves out, in catalogue order otherwise (demo-scene-refresh R17): P25, supervisor
 * restart — the owner, 2026-10-16: "remove the entire P25 demo from the combined video … The P25 demo visually is not
 * good." Its own video stays on its page and in the catalogue's links.
 */
export const REEL_LEAVES_OUT: readonly string[] = ['P25'];
/** The combined video's opening page, the owner's words of 2026-10-16, line by line (demo-scene-refresh R15). */
export const OPENING_PAGE = [
  'ASHA - Autonomous Simple Harness for Agents',
  'Demo: Multi-Agent Orchestration Patterns',
  'SimplyAutonomous.AI',
] as const;
/** Its end page, the owner's words of the same message (R15). */
export const ENDING_PAGE = ['ASHA - Autonomous Simple Harness for Agents', 'SimplyAutonomous.AI'] as const;

/** The words of `text` a reader reads: each run holding a letter or a digit; a separator (·, —, /, -) is not read. */
function wordsOf(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * How long the combined video shows a demo's title card (demo-scene-refresh R13, amended by the owner on 2026-10-16:
 * "the pattern title cards should be shown for less time"): 1,000 ms and 150 ms for each word of `text`, at least
 * 3,000 ms and at most 8,000 ms.
 */
export function readingMs(text: string): number {
  return Math.min(8_000, Math.max(3_000, 1_000 + 150 * wordsOf(text)));
}

/**
 * How long the combined video shows its opening or end page (R15): 2,000 ms and 300 ms for each word — about 200
 * words a minute — and never less than 5,000 ms, R13's first rule, which the owner's amendment left to the pages.
 */
export function pageMs(text: string): number {
  return Math.max(5_000, 2_000 + 300 * wordsOf(text));
}

/** A demo's video, at most (R5, R8). */
const VIDEO_MAX_BYTES = 10_000_000;
/** Playwright's bundled ffmpeg, revision 1011, and the version line it must print (R5). */
export const FFMPEG_REVISION = 'n7.0.1-playwright-build-1011';
/** What the recorder writes beside its frames. */
export const RECORDING_FILE = 'recording.json';

/**
 * The frame (R2): a 76 px title bar over the scene's panel and the thread's panel, side by side 3 to 2 as in the
 * portal; every other part of the page hidden, the panels' own captions and forms included. Installed as a style sheet
 * of the recorder's own in every document before its first paint, so the portal's files and policy are unchanged.
 */
export const FRAME_CSS = `
html, body { overflow: hidden !important; }
body { visibility: hidden; }
#record-title, .watch-grid { visibility: visible; }
#record-title { position: fixed; z-index: 20; top: 0; left: 0; right: 0; height: 76px; box-sizing: border-box; padding: 8px 20px;
  background: var(--panel); border-bottom: 1px solid var(--line); font-family: inherit; overflow: hidden; }
#record-title h1 { margin: 0; font-size: 22px; line-height: 26px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#record-title p { margin: 2px 0 0; font-size: 13px; line-height: 16px; color: var(--muted); display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 2; overflow: hidden; }
.watch-grid { position: fixed; z-index: 10; top: 88px; left: 12px; right: 12px; bottom: 12px; margin: 0; grid-template-columns: 3fr 2fr;
  grid-template-rows: minmax(0, 1fr); }
.scene-wrap { display: flex; flex-direction: column; }
#scene { flex: 1 1 auto; height: auto !important; min-height: 0; }
.scene-wrap figcaption, #compose-form, #watch-output { display: none !important; }
`;

/**
 * `text` with every markdown link `[text](url)` replaced by its own text: the same strings as
 * `text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')`, but without that regex's super-linear backtracking on text with
 * many "[" and few or no "]" or ")" (sonarjs/super-linear-regex — confirmed with scslre, and timed: the regex took
 * over a second on 32,000 unmatched "[", this one under a millisecond). One left-to-right pass over the text; the
 * position of the next "]" and of the next ")" are each cached and only searched for again once the cursor has
 * moved past them, so a long run of unmatched "[" or "(" costs no more than its own length to rule out.
 */
function stripMarkdownLinks(text: string): string {
  let out = '';
  let i = 0;
  let nextBracket = -2; // -2: not yet searched for; -1: none found from the last search's start.
  let nextParen = -2;
  while (i < text.length) {
    const open = text.indexOf('[', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    if (nextBracket === -2 || (nextBracket !== -1 && nextBracket <= open)) nextBracket = text.indexOf(']', open + 1);
    const close = nextBracket;
    if (close === -1 || close === open + 1 || text.charAt(close + 1) !== '(') {
      out += text.charAt(open);
      i = open + 1;
      continue;
    }
    if (nextParen === -2 || (nextParen !== -1 && nextParen < close + 2)) nextParen = text.indexOf(')', close + 2);
    const closeParen = nextParen;
    if (closeParen === -1 || closeParen === close + 2) {
      out += text.charAt(open);
      i = open + 1;
      continue;
    }
    out += text.slice(open + 1, close);
    i = closeParen + 1;
  }
  return out;
}

/** A demo's title and purpose, read from its page (R2): the heading, and the paragraph under it as plain text. */
export function titleOf(pageMarkdown: string): { readonly title: string; readonly purpose: string } {
  const heading = /^# (.+)$/m.exec(pageMarkdown);
  if (heading === null) throw new Error('the demo page has no heading');
  const after = pageMarkdown.slice(heading.index + heading[0].length).replace(/^\s+/, '');
  const end = after.search(/\n\s*\n/);
  const paragraph = (end === -1 ? after : after.slice(0, end)).replace(/\s+/g, ' ').trim();
  if (paragraph === '' || paragraph.startsWith('<'))
    throw new Error('the demo page has no paragraph under its heading');
  const purpose = stripMarkdownLinks(paragraph)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1');
  return { title: present(heading[1], 'heading[1]').trim(), purpose };
}

// ------------------------------------------------------------------ what a recording keeps

/** One captured frame: its file in the run's frames folder, when it was taken and its size in pixels (R5). */
export interface Frame {
  readonly file: string;
  /** When its capture call returned. */
  readonly at: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A followed stop (R3). Its span (R4) starts at `stopAt`: the last poll that still saw the daemon live and not stopping,
 * before the poll that saw it stop (`seenAt`). Every line the stop makes the page show comes after the stop takes
 * effect, so after that last live poll; the page can see a stop before the recorder's next poll does (a 503, or a
 * daemon killed outright), so the span does not start at `seenAt`.
 */
interface Restart {
  readonly stopAt: number;
  readonly seenAt: number;
  readonly reloadAt: number;
  readonly watchingAt: number;
}

/** A text the recorder saw, with when, in ms since the epoch. */
interface TimedText {
  readonly at: number;
  readonly text: string;
}

/** What a recording keeps, its recording.json (R4, R5): every fact promotion judges it by. */
export interface RecordingFacts {
  readonly suite: string;
  readonly title: string;
  readonly purpose: string;
  readonly channel: string;
  readonly startedAt: number;
  readonly endedAt: number;
  /** Why the recorder could not record, or stopped early: no daemon in time, a portal that failed, a stop not followed. */
  readonly failed: string | null;
  readonly frames: readonly Frame[];
  readonly restarts: readonly Restart[];
  /** A stop seen and not followed by the end (R3). */
  readonly unfollowedStopAt: number | null;
  readonly pageErrors: readonly TimedText[];
  readonly banners: readonly TimedText[];
  /** Each failure note as it was added, with the document (1, 2, …: one per load) it was added to. */
  readonly failureNotes: readonly (TimedText & { readonly document: number })[];
  readonly captureErrors: readonly TimedText[];
  readonly slowCaptures: readonly { readonly at: number; readonly ms: number }[];
  /** What the sampler found on top that the frame should hide (R2). */
  readonly violations: readonly TimedText[];
  readonly pixelRatios: readonly { readonly at: number; readonly ratio: number }[];
  /** Each document's thread as text: kept before its reload, and the last one's at the end (R3, R5). */
  readonly threads: readonly { readonly document: number; readonly lines: readonly string[] }[];
  /**
   * When the end's hold last saw the thread change, or when the hold began if it never did (demo-scene-refresh R12);
   * null when the recorder failed before its end.
   */
  readonly lastLineAt: number | null;
  /** The page's reports in the daemon log (`portal.client_error`, `portal.client_error_dropped`), read at the end (R4). */
  readonly clientErrors: readonly {
    readonly at: number;
    readonly event: string;
    readonly reason: string | null;
    readonly detail: string | null;
  }[];
}

// ------------------------------------------------------------------ the capture's facts, and the encode's ticks

/** A span of time: from, to (both inclusive). */
export type Span = readonly [number, number];

/** The part of [a, b] outside every span. A gap running past a span's end counts from that end (R5). */
export function outsideSpans(a: number, b: number, spans: readonly Span[]): number {
  let left = b - a;
  for (const [s0, s1] of spans) left -= Math.max(0, Math.min(b, s1) - Math.max(a, s0));
  return left;
}

/** The longest gap between consecutive frames, its part inside any span not counted (R5). */
export function longestGap(frames: readonly Pick<Frame, 'at'>[], spans: readonly Span[]): number {
  let longest = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const previous = present(frames[i - 1], 'frames[i - 1]');
    const current = present(frames[i], 'frames[i]');
    longest = Math.max(longest, outsideSpans(previous.at, current.at, spans));
  }
  return longest;
}

/** Frames a second outside the spans: the frames taken outside them over the time outside them. */
export function framesPerSecond(frames: readonly Pick<Frame, 'at'>[], spans: readonly Span[]): number {
  if (frames.length < 2) return 0;
  const first = present(frames[0], 'frames[0]').at;
  const last = present(frames.at(-1), 'frames.at(-1)').at;
  const outside = outsideSpans(first, last, spans);
  const counted = frames.filter((f) => !spans.some(([s0, s1]) => f.at > s0 && f.at < s1)).length;
  return outside <= 0 ? 0 : counted / (outside / 1_000);
}

/** For each tick of FPS a second from the first frame to the last, the index of the last frame taken at or before it (R5). */
export function ticksOf(frames: readonly Pick<Frame, 'at'>[], fps: number = FPS): number[] {
  if (frames.length === 0) return [];
  const first = present(frames[0], 'frames[0]').at;
  const last = present(frames.at(-1), 'frames.at(-1)').at;
  const step = 1_000 / fps;
  const ticks: number[] = [];
  let i = 0;
  for (let k = 0; first + k * step <= last; k += 1) {
    const t = first + k * step;
    while (i + 1 < frames.length && present(frames[i + 1], 'frames[i + 1]').at <= t) i += 1;
    ticks.push(i);
  }
  return ticks;
}

// ------------------------------------------------------------------ promotion (R4, R5)

/** A failure note a followed stop may show during its span (R4): the stop's own lines, as src/portal prints them. */
const STOP_LINES: readonly RegExp[] = [
  /^✗ stream_cut: the daemon closed \/v1\/channel before it was done \(\w+\)$/,
  /^✗ the failure could not be reported to the daemon\b/,
  /^stopping: the daemon is stopping, and takes no new work$/,
  /^✗ the daemon is unreachable: it is not running, or has stopped; run asha --portal to start it and open a new page$/,
  /^✗ telemetry is no longer updated for this watch$/,
];

/** What the page may report during a stop's span (R4): the watch's cut. */
const STOP_REPORTS: readonly ((r: RecordingFacts['clientErrors'][number]) => boolean)[] = [
  (r) => r.reason === 'stream_cut' && (r.detail ?? '').includes('/v1/channel'),
];

/** What the one encode came to (R5): whether it succeeded, why not, and the video's bytes, length and ticks. */
export interface EncodeOutcome {
  readonly ok: boolean;
  /** Why it failed, when it did. */
  readonly reason: string | null;
  readonly bytes: number;
  readonly durationMs: number | null;
  readonly ticks: number;
}

/** What promotion judges a recording by (R4): its facts, its suite's outcomes, the tree, the encode and privacy. */
export interface PromotionInput {
  readonly recording: RecordingFacts;
  /** Each scenario of the suite's results, with its outcome. */
  readonly scenarios: readonly { readonly id: string; readonly state: string }[];
  /** R1's condition at the end, and HEAD then and at the start. */
  readonly tree: { readonly clean: boolean; readonly head: string; readonly headAtStart: string };
  readonly encode: EncodeOutcome;
  /** What no text in the video may hold (R5): the login name, the home folder and the temporary folder. */
  readonly privacy: { readonly login: string; readonly home: string; readonly tmp: string };
}

const at = (recording: RecordingFacts, t: number): string => `${((t - recording.startedAt) / 1_000).toFixed(1)} s`;

/** Reasons from the scenarios the suite ran (R4): none recorded, or one that did not pass. */
function scenarioReasons(scenarios: PromotionInput['scenarios']): string[] {
  const reasons: string[] = [];
  if (scenarios.length === 0) reasons.push('the suite recorded no scenario');
  for (const s of scenarios) if (s.state !== 'pass') reasons.push(`scenario ${s.id} did not pass (${s.state})`);
  return reasons;
}

/** Reasons the recorder itself raises, independent of a stop's span: its own failure, a stop not followed, a sampler violation, a page's own thrown error, and a video ending under LAST_LINE_HOLD_MS after its chat's last line (demo-scene-refresh R12). */
function recorderReasons(r: RecordingFacts): string[] {
  const reasons: string[] = [];
  if (r.failed !== null) reasons.push(`the recorder failed: ${r.failed}`);
  if (r.unfollowedStopAt !== null)
    reasons.push(`a stop at ${at(r, r.unfollowedStopAt)} was not followed within ${String(RESTART_WAIT_MS)} ms`);
  for (const v of r.violations) reasons.push(`the frame let ${v.text} show at ${at(r, v.at)}`);
  for (const e of r.pageErrors) reasons.push(`the page threw at ${at(r, e.at)}: ${e.text}`);
  const lastFrame = r.frames.at(-1)?.at;
  if (r.lastLineAt !== null && lastFrame !== undefined && lastFrame - r.lastLineAt < LAST_LINE_HOLD_MS)
    reasons.push(
      `the video ends ${String(lastFrame - r.lastLineAt)} ms after its chat's last line, under ${String(LAST_LINE_HOLD_MS)} ms`,
    );
  return reasons;
}

/** Reasons that depend on whether the moment was inside a followed stop's span (R4): a banner, a failure note, a client error the daemon log records. */
function stopAwareReasons(r: RecordingFacts, inStop: (t: number) => boolean): string[] {
  const reasons: string[] = [];
  for (const b of r.banners) if (!inStop(b.at)) reasons.push(`the page's banner showed at ${at(r, b.at)}: ${b.text}`);
  for (const n of r.failureNotes) {
    if (inStop(n.at) && STOP_LINES.some((line) => line.test(n.text))) continue;
    reasons.push(
      `a failure note in document ${String(n.document)} at ${at(r, n.at)}${inStop(n.at) ? ', during a stop, not one of its lines' : ''}: ${n.text}`,
    );
  }
  for (const c of r.clientErrors) {
    if (inStop(c.at) && STOP_REPORTS.some((allowed) => allowed(c))) continue;
    reasons.push(`the daemon log records ${c.event} (${c.reason ?? 'no reason'}) at ${at(r, c.at)}`);
  }
  return reasons;
}

/** Reasons about the capture calls themselves: one that failed or ran slow, a devicePixelRatio not 2. */
function captureReasons(r: RecordingFacts): string[] {
  const reasons: string[] = [];
  for (const e of r.captureErrors) reasons.push(`a capture call failed at ${at(r, e.at)}: ${e.text}`);
  for (const s of r.slowCaptures)
    reasons.push(`a capture call took ${String(s.ms)} ms at ${at(r, s.at)}, over ${String(CAPTURE_BOUND_MS)} ms`);
  for (const p of r.pixelRatios)
    if (p.ratio !== 2) reasons.push(`the page's devicePixelRatio was ${String(p.ratio)} at ${at(r, p.at)}, not 2`);
  return reasons;
}

/** Reasons about the frames themselves (R5): the wrong size, too few, too slow, or too long a gap outside a reload. */
function frameReasons(r: RecordingFacts, reloadSpans: readonly Span[]): string[] {
  const reasons: string[] = [];
  const odd = r.frames.filter((f) => f.width !== FRAME_SIZE.width || f.height !== FRAME_SIZE.height);
  if (odd.length > 0) {
    const first = present(odd[0], 'odd[0]');
    reasons.push(
      `${String(odd.length)} frame(s) not ${String(FRAME_SIZE.width)} × ${String(FRAME_SIZE.height)}, the first ${String(first.width)} × ${String(first.height)} at ${at(r, first.at)}`,
    );
  }
  if (r.frames.length < 2) reasons.push(`the capture took ${String(r.frames.length)} frame(s)`);
  else {
    const fps = framesPerSecond(r.frames, reloadSpans);
    if (fps < MIN_FPS) reasons.push(`the capture ran at ${fps.toFixed(1)} frames a second, under ${String(MIN_FPS)}`);
    const gap = longestGap(r.frames, reloadSpans);
    if (gap > MAX_GAP_MS)
      reasons.push(
        `a gap of ${String(Math.round(gap))} ms between frames outside a reload, over ${String(MAX_GAP_MS)} ms`,
      );
  }
  return reasons;
}

/** Reasons about the tree the run touched (R1). */
function treeReasons(tree: PromotionInput['tree']): string[] {
  const reasons: string[] = [];
  if (!tree.clean) reasons.push('the tree changed outside docs/patterns/videos/ and the results paths during the run');
  if (tree.head !== tree.headAtStart)
    reasons.push(`HEAD moved during the run, from ${tree.headAtStart.slice(0, 12)} to ${tree.head.slice(0, 12)}`);
  return reasons;
}

/** Reasons about the encode (R5): it failed, or the video is too large. */
function encodeReasons(encode: EncodeOutcome): string[] {
  const reasons: string[] = [];
  if (!encode.ok) reasons.push(`the encode failed: ${encode.reason ?? 'no reason given'}`);
  else if (encode.bytes > VIDEO_MAX_BYTES)
    reasons.push(`the video is ${String(encode.bytes)} bytes, over ${String(VIDEO_MAX_BYTES)}`);
  return reasons;
}

/** Reasons a private value shows in the title or in a document's thread kept before its reload (R5). */
function privacyReasons(r: RecordingFacts, privacy: PromotionInput['privacy']): string[] {
  const reasons: string[] = [];
  const texts = [
    { where: 'the title', lines: [r.title, r.purpose] },
    ...r.threads.map((t) => ({ where: `document ${String(t.document)}'s thread`, lines: t.lines })),
  ];
  for (const { where, lines } of texts)
    for (const found of privateIn(lines.join('\n'), privacy)) reasons.push(`${where} holds ${found}`);
  return reasons;
}

/**
 * Every reason the recording must not be promoted (R4, R5), each naming what failed and when; none means promote.
 * Never quotes a private value it found, only where it was.
 */
export function refusals(input: PromotionInput): string[] {
  const { recording: r, tree, encode, privacy } = input;
  const stopSpans: Span[] = r.restarts.map((x) => [x.stopAt, x.watchingAt]);
  const reloadSpans: Span[] = r.restarts.map((x) => [x.reloadAt, x.watchingAt]);
  const inStop = (t: number): boolean => stopSpans.some(([s0, s1]) => t >= s0 && t <= s1);
  return [
    ...scenarioReasons(input.scenarios),
    ...recorderReasons(r),
    ...stopAwareReasons(r, inStop),
    ...captureReasons(r),
    ...frameReasons(r, reloadSpans),
    ...treeReasons(tree),
    ...encodeReasons(encode),
    ...privacyReasons(r, privacy),
  ];
}

/** What private kinds of value `text` holds (R5): named by kind, never quoted. */
export function privateIn(text: string, privacy: PromotionInput['privacy']): string[] {
  const found: string[] = [];
  if (privacy.login !== '' && new RegExp(`\\b${escape(privacy.login)}\\b`, 'i').test(text))
    found.push('the login name');
  if (privacy.home !== '' && text.includes(privacy.home)) found.push('the home folder');
  if (privacy.tmp !== '' && text.includes(privacy.tmp)) found.push('the temporary folder');
  if (/\/(Users|home)\/[^\s/]+|\/private\/(tmp|var)\/|\/var\/folders\//.test(text))
    found.push('a home or temporary path');
  if (/\b[0-9a-f]{64}\b/i.test(text)) found.push('a 64-hex value');
  return [...new Set(found)];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------ the encode, once (R5)

/** How the encode runs ffmpeg: its arguments, its standard input (or none), and a bound on its time. */
export type RunFfmpeg = (
  args: readonly string[],
  input: AsyncIterable<Buffer> | null,
  boundMs: number,
) => Promise<{
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Why its input could not all be written — it was killed, or exited before reading it all — when that happened. */
  readonly inputError?: string;
}>;

/** The encode's arguments (R5), exactly as the plan gives them. */
export function encodeArgs(output: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-framerate',
    String(FPS),
    '-c:v',
    'mjpeg',
    '-i',
    'pipe:0',
    '-c:v',
    'libvpx',
    '-deadline',
    'good',
    '-cpu-used',
    '1',
    '-threads',
    '8',
    '-auto-alt-ref',
    '1',
    '-lag-in-frames',
    '16',
    '-qmin',
    '0',
    '-qmax',
    '50',
    '-crf',
    '10',
    '-b:v',
    '500k',
    '-an',
    '-f',
    'webm',
    output,
  ];
}

/** The `Duration` line of `ffmpeg -i <video>`'s error stream, in ms, or null when it has none. */
export function durationOf(info: string): number | null {
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  return d === null ? null : Math.round((Number(d[1]) * 3_600 + Number(d[2]) * 60 + Number(d[3])) * 1_000);
}

/** What the encode needs: the frames, where they are and where the video goes, ffmpeg's version, and its effects. */
export interface EncodeProps {
  readonly frames: readonly Frame[];
  /** The frames' folder: removed after a successful encode, kept after a failed one. */
  readonly framesDir: string;
  readonly output: string;
  /** `ffmpeg -version`'s output. */
  readonly version: string;
  readonly run: RunFfmpeg;
  readonly readFrame: (file: string) => Buffer;
  readonly exists: (path: string) => boolean;
  readonly size: (path: string) => number;
  readonly removeFrames: (dir: string) => void;
}

/** Encodes the frames once (R5), checking the version, the output path, ffmpeg's exit and error stream, its time and the duration. */
export async function encode(props: EncodeProps): Promise<EncodeOutcome> {
  const ticks = ticksOf(props.frames);
  const fail = (reason: string): EncodeOutcome => ({
    ok: false,
    reason,
    bytes: 0,
    durationMs: null,
    ticks: ticks.length,
  });
  const firstLine = present(props.version.split('\n')[0], "props.version's first line");
  if (!firstLine.includes(FFMPEG_REVISION)) return fail(`the bundled ffmpeg is not ${FFMPEG_REVISION}: ${firstLine}`);
  if (props.exists(props.output)) return fail(`${props.output} exists: ffmpeg would exit 0 without writing it`);
  if (ticks.length === 0) return fail('there are no frames to encode');
  const videoMs = (ticks.length * 1_000) / FPS;
  const boundMs = 2 * videoMs + 60_000;
  const frames = props.frames;
  const read = props.readFrame;
  async function* input(): AsyncIterable<Buffer> {
    await Promise.resolve();
    for (const i of ticks) yield read(present(frames[i], 'frames[i]').file);
  }
  const encoded = await props.run(encodeArgs(props.output), input(), boundMs);
  if (encoded.timedOut)
    return fail(`the encode took more than ${String(Math.round(boundMs))} ms, twice the video's length and 60 s`);
  if (encoded.code !== 0) return fail(`ffmpeg exited ${String(encoded.code)}: ${encoded.stderr.trim()}`);
  if (encoded.inputError !== undefined)
    return fail(`ffmpeg exited 0 without reading all its frames: ${encoded.inputError}`);
  if (encoded.stderr !== '') return fail(`ffmpeg wrote to its error stream: ${encoded.stderr.trim()}`);
  const info = await props.run(['-hide_banner', '-i', props.output], null, 30_000);
  const durationMs = durationOf(info.stderr);
  if (durationMs === null) return fail(`ffmpeg -i ${props.output} printed no Duration line`);
  if (Math.abs(durationMs - videoMs) > 40)
    return fail(
      `the video lasts ${String(durationMs)} ms, not the ${String(videoMs)} ms of its ${String(ticks.length)} ticks`,
    );
  props.removeFrames(props.framesDir);
  return { ok: true, reason: null, bytes: props.size(props.output), durationMs, ticks: ticks.length };
}

/**
 * The encode under the agent-suite lock (R12): `take` takes it, and `run` encodes while it is held. When another process
 * holds it, the encode does not run and its outcome is a failure naming the holder, so the recording is refused with the
 * others' run going on.
 */
export async function encodeUnderLock(props: {
  readonly take: () => Promise<() => Promise<void>>;
  readonly run: () => Promise<EncodeOutcome>;
}): Promise<EncodeOutcome> {
  let release: () => Promise<void>;
  try {
    release = await props.take();
  } catch (error) {
    if (error instanceof AgentSuiteRunning)
      return { ok: false, reason: `not encoded: ${error.message}`, bytes: 0, durationMs: null, ticks: 0 };
    throw error;
  }
  try {
    return await props.run();
  } finally {
    await release();
  }
}

/** Resolves when `stream` can take more, or is gone: a drain that never comes once it has closed is not waited for. */
function writable(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });
}

/**
 * ffmpeg run for real: bounded, killed past its bound, its error stream kept. A write its input can no longer take —
 * ffmpeg killed at its bound, or gone before reading it all — is data, `inputError`, never a throw: the encode fails
 * naming it (demo-videos R5; PRINCIPLES §11; the code review's round 4, R4-DESIGN-003).
 */
export function ffmpegRunner(ffmpeg: string): RunFfmpeg {
  return (args, input, boundMs) =>
    new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, [...args], { stdio: [input === null ? 'ignore' : 'pipe', 'ignore', 'pipe'] });
      let stderr = '';
      let timedOut = false;
      let inputError: string | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, boundMs);
      present(child.stderr, 'child.stderr').on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr, timedOut, ...(inputError === undefined ? {} : { inputError }) });
      });
      if (input !== null) {
        const stdin = present(child.stdin, 'child.stdin');
        stdin.on('error', (error) => {
          inputError ??= error.message;
        });
        void (async () => {
          for await (const chunk of input) {
            if (stdin.destroyed) break;
            if (!stdin.write(chunk)) await writable(stdin);
          }
          stdin.end();
        })().catch((error: unknown) => {
          child.kill('SIGKILL');
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
    });
}

// ------------------------------------------------------------------ the page side: the frame and its sampler

// Page-side code is plain JavaScript held as text: this file is type-checked for Node, without the DOM's names.

/**
 * Installs the title bar and the frame in a document, and reports each failure note and banner as it appears through
 * the binding `__ashaRecord(kind, text)` when the page has one. Called with `[css, title, purpose]`.
 */
const INSTALL_FRAME = `(([css, title, purpose]) => {
  const report = (kind, text) => { if (typeof window.__ashaRecord === 'function') window.__ashaRecord(kind, text); };
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const add = () => {
    const head = document.createElement('header');
    head.id = 'record-title';
    const h = document.createElement('h1');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = purpose;
    head.append(h, p);
    document.body.append(head);
    const seen = new WeakSet();
    const scan = () => {
      for (const note of document.querySelectorAll('#watch-thread .note.failure')) {
        if (seen.has(note)) continue;
        seen.add(note);
        report('note', (note.textContent || '').replace(/\\s+/g, ' ').trim());
      }
      const banner = document.getElementById('page-error');
      if (banner !== null && !banner.hidden && !seen.has(banner)) {
        seen.add(banner);
        report('banner', (banner.textContent || '').replace(/\\s+/g, ' ').trim());
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    scan();
  };
  if (document.body === null) document.addEventListener('DOMContentLoaded', add, { once: true });
  else add();
})`;

/** The init script that installs the frame with this demo's title and purpose (R2). */
export function frameScript(title: string, purpose: string, css: string = FRAME_CSS): string {
  return `${INSTALL_FRAME}(${JSON.stringify([css, title, purpose])});`;
}

/**
 * The frame's sampler (R2), as an expression: every 20 px across the viewport, the element on top must be in the
 * title, the scene or the thread, or be one of the two panels' own boxes or the grid between them. The page's own
 * background (the document, and the hidden body) in the frame's margins shows no part of the page. Its value is what
 * else is on top, each as tag#id.class — with ` in #id` naming its nearest ancestor that has an id, when it has none —
 * sorted.
 */
export const SAMPLE_FRAME = `(() => {
  const inside = ['#record-title', '#scene', '#watch-thread'].map((s) => document.querySelector(s));
  const boxes = ['.scene-wrap', '.thread-panel', '.thread-inner', '.watch-grid'].map((s) => document.querySelector(s));
  const other = new Set();
  for (let y = 0; y < innerHeight; y += 20) {
    for (let x = 0; x < innerWidth; x += 20) {
      const top = document.elementFromPoint(x, y);
      if (top === null || top === document.documentElement || top === document.body) continue;
      if (inside.some((e) => e !== null && e.contains(top)) || boxes.includes(top)) continue;
      const classes = typeof top.className === 'string' && top.className.trim() !== '' ? '.' + top.className.trim().split(/\\s+/).join('.') : '';
      const owner = top.id === '' && top.parentElement !== null ? top.parentElement.closest('[id]') : null;
      other.add(top.tagName.toLowerCase() + (top.id === '' ? '' : '#' + top.id) + classes + (owner === null ? '' : ' in #' + owner.id));
    }
  }
  return [...other].sort();
})()`;

/** Each line of the watched thread as text, as an expression (R3, R5). */
const THREAD_TEXT = `[...document.querySelectorAll('#watch-thread > *')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim())`;

/** Watches `channel` on the watch view, as an expression. */
function watchScript(channel: string): string {
  return `(() => {
  document.getElementById('tab-watch').click();
  document.getElementById('watch-channel').value = ${JSON.stringify(channel)};
  document.getElementById('watch-button').click();
})()`;
}

// ------------------------------------------------------------------ the recorder

/** What a suite's recorder is started with (R1): its run folder, the suite, its harness home and channel, the repository. */
export interface RecorderProps {
  /** ASHA_RECORD_DIR: the run's folder for this demo, unique to the run. */
  readonly dir: string;
  readonly suite: string;
  readonly home: string;
  readonly channel: string;
  readonly repo: string;
}

/** A recording in progress, started by startRecorder; the suite's afterAll ends it. */
export interface Recorder {
  /** Ends the recording (R1): holds the last words, stops the capture, closes the page, and writes recording.json. */
  end(): Promise<void>;
}

interface DaemonFile {
  readonly pid?: number;
  readonly stopping?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`, or a rejection naming `what` after `ms`; the timer cleared either way. */
export async function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(() => {
            reject(new Error(what));
          }, ms)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A JPEG's size, from its first start-of-frame marker. */
export function jpegSize(bytes: Buffer): { readonly width: number; readonly height: number } {
  for (let i = 2; i + 9 < bytes.length;) {
    const marker = present(bytes[i + 1], 'bytes[i + 1]');
    if (marker >= 0xc0 && marker <= 0xc2)
      return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('a frame with no start-of-frame marker');
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Starts recording the suite's demo; returns at once. Every failure is a fact of the recording (`failed`), so the suite
 * runs on as it would unrecorded, and promotion refuses the video.
 */
export function startRecorder(props: RecorderProps): Recorder {
  const startedAt = Date.now();
  mkdirSync(join(props.dir, 'frames'), { recursive: true });
  const demos = JSON.parse(readFileSync(join(props.repo, 'tests', 'agents', 'patterns', 'demos.json'), 'utf8')) as {
    readonly pattern: string;
    readonly page: string;
    readonly suite: string;
  }[];
  const demo = demos.find((d) => d.suite === `tests/agents/${props.suite}.test.ts`);
  if (demo === undefined)
    throw new Error(`ASHA_RECORD_DIR is set, but suite ${props.suite} is no pattern demo of demos.json`);
  const { title, purpose } = titleOf(readFileSync(join(props.repo, demo.page), 'utf8'));

  const facts = {
    frames: [] as Frame[],
    restarts: [] as Restart[],
    pageErrors: [] as TimedText[],
    banners: [] as TimedText[],
    failureNotes: [] as (TimedText & { document: number })[],
    captureErrors: [] as TimedText[],
    slowCaptures: [] as { at: number; ms: number }[],
    violations: [] as TimedText[],
    pixelRatios: [] as { at: number; ratio: number }[],
    threads: [] as { document: number; lines: string[] }[],
  };
  let failed: string | null = null;
  let unfollowedStopAt: number | null = null;
  let lastLineAt: number | null = null;
  let ending = false;
  let documentNo = 0;

  // daemon.json is written by create-and-rename (src/daemon/compose.ts), so it is whole or absent: absent before the
  // suite's daemon starts and once a stop has removed it, which may happen between any two reads.
  const daemonFile = (): DaemonFile | undefined => {
    let text: string;
    try {
      text = readFileSync(join(props.home, 'daemon.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return JSON.parse(text) as DaemonFile;
  };
  const liveDaemon = (): DaemonFile | undefined => {
    const d = daemonFile();
    return d !== undefined && typeof d.pid === 'number' && d.stopping !== true && alive(d.pid) ? d : undefined;
  };
  const logRecords = (): Record<string, unknown>[] => {
    const file = join(props.home, 'logs', 'daemon.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const starts = (): number => logRecords().filter((r) => r['event'] === 'daemon.started').length;
  async function awaitLive(boundMs: number): Promise<DaemonFile | undefined> {
    const deadline = Date.now() + boundMs;
    while (Date.now() <= deadline) {
      const d = liveDaemon();
      if (d !== undefined) return d;
      if (ending) return undefined;
      await sleep(200);
    }
    return undefined;
  }

  // ./asha --portal with a stub open that only reports the forwarding file's path; it must start no daemon (R1).
  const stub = join(props.dir, 'stub-bin');
  const pathFile = join(props.dir, 'forwarding-path.txt');
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, 'open'), `#!/bin/sh\nprintf '%s' "$1" > '${pathFile}'\n`);
  chmodSync(join(stub, 'open'), 0o755);
  const portal = (): string => {
    const before = starts();
    rmSync(pathFile, { force: true });
    const r = spawnSync(join(props.repo, 'asha'), ['--portal', 'user=alice'], {
      cwd: props.repo,
      env: { ...process.env, ...TEST_DAEMON_ENV, ASHA_HOME: props.home, PATH: `${stub}:${process.env['PATH'] ?? ''}` },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.error !== undefined) throw r.error;
    if (r.status !== 0) throw new Error(`asha --portal exited ${String(r.status)}: ${r.stderr.trim()}`);
    if (starts() !== before) throw new Error('asha --portal started a daemon');
    return readFileSync(pathFile, 'utf8');
  };

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let cdp: CDPSession | undefined;
  let capturing = false;
  /** True while the page loads again after a restart (R3): no capture call is issued. */
  let reloading = false;
  /** The capture call in flight, settled when the call itself settles; a reload waits for it (R3). */
  let inFlight: Promise<void> = Promise.resolve();
  let loops: Promise<void>[] = [];

  const threadText = async (): Promise<string[]> => present(page, 'page').evaluate<string[]>(THREAD_TEXT);
  const newSession = async (): Promise<CDPSession> => {
    const session = await present(context, 'context').newCDPSession(present(page, 'page'));
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width,
      height: VIEW.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    return session;
  };
  const check = async (): Promise<void> => {
    const now = Date.now();
    const p = present(page, 'page');
    facts.pixelRatios.push({ at: now, ratio: await p.evaluate<number>('devicePixelRatio') });
    for (const what of await p.evaluate<string[]>(SAMPLE_FRAME)) facts.violations.push({ at: now, text: what });
  };
  const openAndWatch = async (forwarding: string): Promise<void> => {
    documentNo += 1;
    const p = present(page, 'page');
    await p.goto(pathToFileURL(forwarding).href);
    await p.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 15_000 });
    await p.locator('#daemon-line', { hasText: /^daemon pid / }).waitFor({ state: 'attached', timeout: 15_000 });
    await p.evaluate(watchScript(props.channel));
    await p.locator('#scene[data-robots]').waitFor({ state: 'attached', timeout: 15_000 });
  };

  // Read through a call, not directly, inside the loops below: each is also written from another of this function's
  // closures (reloading and capturing from the other of capture/follow, ending from end()), a flow TypeScript cannot
  // trace across an await, so it would otherwise (wrongly) narrow a read here to the literal it held when this
  // closure was created (sonarjs/no-unnecessary-condition on a genuine, not a mistaken, check).
  const isEnding = (): boolean => ending;
  const isCapturing = (): boolean => capturing;
  const isReloading = (): boolean => reloading;

  const run = (async () => {
    const first = await awaitLive(DAEMON_WAIT_MS);
    if (first === undefined)
      throw new Error(
        isEnding()
          ? 'the suite ended before its daemon started'
          : `no live daemon of the suite's home within ${String(DAEMON_WAIT_MS)} ms`,
      );
    const browser = await chromium.launch({ headless: true, executablePath: requireBrowser('chromium') });
    context = await browser.newContext({ viewport: VIEW });
    await context.exposeBinding('__ashaRecord', (_source, kind: string, text: string) => {
      const now = Date.now();
      if (kind === 'note') facts.failureNotes.push({ at: now, text, document: documentNo });
      else facts.banners.push({ at: now, text });
    });
    await context.addInitScript({ content: frameScript(title, purpose) });
    page = await context.newPage();
    page.on('pageerror', (error) => facts.pageErrors.push({ at: Date.now(), text: String(error).slice(0, 300) }));
    await openAndWatch(portal());
    cdp = await newSession();
    await check();
    // An end begun while the page opened stops here: no capture starts after it (the code review's round 2).
    if (isEnding()) return;
    capturing = true;
    let pid = first.pid;

    const capture = (async () => {
      let lastCheck = Date.now();
      while (isCapturing()) {
        if (isReloading()) {
          await sleep(20);
          continue;
        }
        const t0 = Date.now();
        const call = cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95 });
        // A reload waits for the call itself, not for this loop's bound on it (R3).
        inFlight = call.then(
          () => undefined,
          () => undefined,
        );
        try {
          const { data } = await bounded(
            call,
            CAPTURE_BOUND_MS,
            `a capture call took more than ${String(CAPTURE_BOUND_MS)} ms`,
          );
          const bytes = Buffer.from(data, 'base64');
          const file = join(props.dir, 'frames', `f${String(facts.frames.length).padStart(6, '0')}.jpg`);
          writeFileSync(file, bytes);
          facts.frames.push({ file, at: Date.now(), ...jpegSize(bytes) });
        } catch (error) {
          facts.captureErrors.push({ at: Date.now(), text: String(error).slice(0, 300) });
          await sleep(100);
        }
        const took = Date.now() - t0;
        if (took > CAPTURE_BOUND_MS) facts.slowCaptures.push({ at: Date.now(), ms: took });
        if (Date.now() - lastCheck >= CHECK_EVERY_MS && !isReloading()) {
          lastCheck = Date.now();
          // A reload waits for the check as for a capture call: it evaluates in the page (the review, finding 6).
          const checking = check();
          inFlight = checking.then(
            () => undefined,
            () => undefined,
          );
          await checking;
        }
      }
    })();

    const follow = (async () => {
      let lastLiveAt = Date.now();
      while (isCapturing()) {
        await sleep(200);
        // Taken before the file is read: the daemon was live, and not stopping, at least until this moment.
        const polledAt = Date.now();
        const d = daemonFile();
        const stopped =
          d === undefined || d.stopping === true || typeof d.pid !== 'number' || !alive(d.pid) || d.pid !== pid;
        if (!stopped) {
          lastLiveAt = polledAt;
          continue;
        }
        const stopAt = lastLiveAt;
        const seenAt = Date.now();
        unfollowedStopAt = stopAt;
        const next = await awaitLive(RESTART_WAIT_MS);
        if (next === undefined) {
          if (!isEnding())
            failed = `a stop at ${((stopAt - startedAt) / 1_000).toFixed(1)} s was not followed: no new live daemon within ${String(RESTART_WAIT_MS)} ms`;
          return;
        }
        pid = next.pid;
        reloading = true;
        const reloadAt = Date.now();
        await bounded(inFlight, CAPTURE_BOUND_MS * 2, 'the capture call in flight did not return before the reload');
        facts.threads.push({ document: documentNo, lines: await threadText() });
        await cdp.detach();
        await openAndWatch(portal());
        cdp = await newSession();
        await check();
        const watchingAt = Date.now();
        facts.restarts.push({ stopAt, seenAt, reloadAt, watchingAt });
        lastLiveAt = watchingAt;
        unfollowedStopAt = null;
        reloading = false;
      }
    })();
    loops = [capture, follow];
    // A loop that throws ends the recording's capture, and is its failure.
    await Promise.all(
      loops.map((loop) =>
        loop.catch((error: unknown) => {
          failed ??= error instanceof Error ? error.message : String(error);
          capturing = false;
        }),
      ),
    );
  })().catch((error: unknown) => {
    failed ??= error instanceof Error ? error.message : String(error);
    capturing = false;
  });

  return {
    async end() {
      const deadline = Date.now() + END_BUDGET_MS;
      /** `promise` within what is left of the end's budget, rejecting naming `what` once it is spent. */
      const within = <T>(promise: Promise<T>, what: string, atMost = END_BUDGET_MS): Promise<T> =>
        bounded(promise, Math.max(0, Math.min(atMost, deadline - Date.now())), `${what} overran the end's budget`);
      // No page yet (the suite ended before the recorder watched): nothing to hold, and run's own reason stands.
      if (failed === null && page !== undefined) {
        // The hold (R1): END_HOLD_MS, and until the thread has not changed for LAST_LINE_HOLD_MS (demo-scene-refresh R12).
        lastLineAt = Date.now();
        try {
          lastLineAt = await holdUntilQuiet(
            () => within(threadText(), "the end's thread read", CAPTURE_BOUND_MS),
            Date.now,
            sleep,
          );
        } catch (error) {
          failed ??= `the thread could not be read during the end's hold: ${String(error)}`;
        }
      }
      ending = true;
      capturing = false;
      try {
        await within(run, "the capture's last iteration");
      } catch (error) {
        failed ??= String(error);
      }
      if (page !== undefined && !page.isClosed()) {
        try {
          facts.threads.push({ document: documentNo, lines: await within(threadText(), 'the last thread read') });
        } catch (error) {
          failed ??= `the last thread could not be read: ${String(error)}`;
        }
      }
      try {
        if (context !== undefined) await within(context.browser()?.close() ?? Promise.resolve(), "the browser's close");
      } catch (error) {
        failed ??= String(error);
      }
      const clientErrors = logRecords()
        .filter((r) => r['event'] === 'portal.client_error' || r['event'] === 'portal.client_error_dropped')
        .map((r) => ({
          at: Date.parse(String(r['ts'])),
          event: String(r['event']),
          reason: typeof r['reason'] === 'string' ? r['reason'] : null,
          detail: typeof r['detail'] === 'string' ? r['detail'] : null,
        }))
        .filter((r) => r.at >= startedAt);
      const recording: RecordingFacts = {
        suite: props.suite,
        title,
        purpose,
        channel: props.channel,
        startedAt,
        endedAt: Date.now(),
        failed,
        unfollowedStopAt,
        clientErrors,
        lastLineAt,
        ...facts,
      };
      writeFileSync(join(props.dir, RECORDING_FILE), `${JSON.stringify(recording, null, 1)}\n`);
    },
  };
}
