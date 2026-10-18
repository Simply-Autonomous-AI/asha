// The demo commands' decisions, as functions of their inputs (the code review's round 3 on demo-scene-refresh,
// R3-COVERAGE-001, -002): which demos `npm run demos:record` records and in what order, which the combined video plays
// and which of those are not yet promoted (docs/plans/demo-videos.md R1, R6; demo-scene-refresh R17), each part's
// title card time (R13), and the two sidecars, every field named. The scripts (record.mts, reel.mts) read the files,
// run the browser and ffmpeg, and write; what they decide is here, with its tests (tests/unit/demos-decide.test.ts).

import { present } from '../../src/shared/assert-present.js';
import {
  ENDING_PAGE,
  FRAME_SIZE,
  OPENING_PAGE,
  REEL_HOLD_MS,
  framesPerSecond,
  longestGap,
  pageMs,
  readingMs,
  type EncodeOutcome,
  type Frame,
  type RecordingFacts,
} from '../../tests/agents/patterns/recorder.js';

/** A demo as tests/agents/patterns/demos.json lists it. */
export interface DemoEntry {
  readonly pattern: string;
  readonly page: string;
}

/** The combined video's playback rate (demo-videos R6). */
export const REEL_RATE = 2;
/** The opening and end pages' times (demo-scene-refresh R15), computed once: shown and recorded alike. */
export const OPENING_MS = pageMs(OPENING_PAGE.join(' '));
export const ENDING_MS = pageMs(ENDING_PAGE.join(' '));

/** The page's slug: `docs/patterns/p05-orchestrator-workers.md` → `p05-orchestrator-workers`. */
export const slugOf = (page: string): string => page.slice('docs/patterns/'.length, -'.md'.length);

/** The demos in the order the catalogue's table (docs/patterns/index.md, its text) lists their patterns. */
export function catalogueOrder<D extends DemoEntry>(demos: readonly D[], catalogue: string): D[] {
  const listed = [...catalogue.matchAll(/^\| (P\d+) \|/gm)].map((m) => present(m[1], "the catalogue row's pattern id"));
  // Every demo checked, not only those a sort compares: one demo alone is compared with nothing.
  const outside = demos.find((d) => !listed.includes(d.pattern));
  if (outside !== undefined) throw new Error(`${outside.pattern} of demos.json is not in the catalogue's table`);
  return [...demos].sort((a, b) => listed.indexOf(a.pattern) - listed.indexOf(b.pattern));
}

/**
 * `argv`'s wanted patterns (`pNN`, any case) matched against `all`, in `all`'s order: every demo when none is named; a
 * problem naming the first argument that names no demo.
 */
export function selectWanted<D extends DemoEntry>(
  argv: readonly string[],
  all: readonly D[],
): { readonly demos: D[] } | { readonly problem: string } {
  const wanted = argv.map((a) => a.toLowerCase());
  const named = (d: D, w: string): boolean => slugOf(d.page).startsWith(`${w}-`);
  for (const w of wanted)
    if (!/^p\d{2}$/.test(w) || !all.some((d) => named(d, w)))
      return { problem: `${w} names no pattern demo: give pNN, such as p05` };
  return { demos: wanted.length === 0 ? [...all] : all.filter((d) => wanted.some((w) => named(d, w))) };
}

/** The demos the combined video plays: every one but those `leftOut` names (demo-scene-refresh R17), in order. */
export const reelDemos = <D extends DemoEntry>(demos: readonly D[], leftOut: readonly string[]): D[] =>
  demos.filter((d) => !leftOut.includes(d.pattern));

/** The patterns of `demos` whose video or sidecar is not promoted, by whether `promoted(<slug>.webm|.json)` holds. */
export const unpromoted = (demos: readonly DemoEntry[], promoted: (file: string) => boolean): string[] =>
  demos.filter((d) => !promoted(`${slugOf(d.page)}.webm`) || !promoted(`${slugOf(d.page)}.json`)).map((d) => d.pattern);

/** One part of the combined video. */
export interface ReelPart {
  readonly pattern: string;
  readonly slug: string;
  readonly title: string;
  readonly purpose: string;
  readonly sha256: string;
  readonly durationMs: number;
  /** Its title card's time (demo-scene-refresh R13). */
  readonly cardMs: number;
}

/** A part from its demo, its page's title and purpose, its video's sha256 and its sidecar's length. */
export function reelPart(
  demo: DemoEntry,
  page: { readonly title: string; readonly purpose: string },
  video: { readonly sha256: string; readonly durationMs: number },
): ReelPart {
  return {
    pattern: demo.pattern,
    slug: slugOf(demo.page),
    title: page.title,
    purpose: page.purpose,
    sha256: video.sha256,
    durationMs: video.durationMs,
    cardMs: readingMs(`${page.title} ${page.purpose}`),
  };
}

/** How long the reel waits for a part's `ended`: half its length (it plays at 2×) and 10 s more (demo-videos R6). */
export const playbackBoundMs = (part: ReelPart): number => Math.round(part.durationMs / REEL_RATE) + 10_000;

/** What the combined video's sidecar is made from. */
export interface ReelSidecarInput {
  readonly commit: string;
  readonly dirty: boolean;
  readonly startedAt: string;
  readonly runFolder: string;
  readonly parts: readonly ReelPart[];
  /** When each part reached `ended`, by pattern. */
  readonly ended: readonly { readonly pattern: string; readonly at: string }[];
  readonly encoded: Pick<EncodeOutcome, 'durationMs' | 'bytes'>;
  readonly sha256: string;
  readonly frames: readonly Frame[];
  readonly leftOut: readonly string[];
}

/** The combined video's sidecar, docs/patterns/videos/demos.json (demo-videos R6, R7; demo-scene-refresh R12–R17). */
export function reelSidecar(input: ReelSidecarInput): Record<string, unknown> {
  return {
    commit: input.commit,
    dirty: input.dirty,
    startedAt: input.startedAt,
    runFolder: input.runFolder,
    parts: input.parts.map((p) => ({
      pattern: p.pattern,
      video: `${p.slug}.webm`,
      sha256: p.sha256,
      cardMs: p.cardMs,
      endedAt: present(
        input.ended.find((e) => e.pattern === p.pattern),
        `the ended record for ${p.pattern}`,
      ).at,
    })),
    durationMs: input.encoded.durationMs,
    bytes: input.encoded.bytes,
    sha256: input.sha256,
    frames: input.frames.length,
    framesPerSecond: Number(framesPerSecond(input.frames, []).toFixed(1)),
    longestGapMs: Math.round(longestGap(input.frames, [])),
    frameSize: { width: FRAME_SIZE.width, height: FRAME_SIZE.height },
    playbackRate: REEL_RATE,
    // The pages and holds of demo-scene-refresh R12, R13, R15; each part's card time is in its entry.
    opening: { lines: OPENING_PAGE, ms: OPENING_MS },
    ending: { lines: ENDING_PAGE, ms: ENDING_MS },
    holdMs: REEL_HOLD_MS,
    leftOut: input.leftOut,
  };
}

/** What a demo's sidecar is made from. */
export interface DemoSidecarInput {
  readonly pattern: string;
  readonly commit: string;
  readonly startedAt: string;
  readonly runFolder: string;
  readonly models: readonly string[];
  readonly recording: RecordingFacts;
  readonly encoded: Pick<EncodeOutcome, 'durationMs'>;
  readonly bytes: number;
  readonly sha256: string;
  readonly scenarios: readonly { readonly id: string; readonly state: string }[];
}

/** A promoted demo's sidecar, docs/patterns/videos/<slug>.json (demo-videos R5, R7; demo-scene-refresh R12). */
export function demoSidecar(input: DemoSidecarInput): Record<string, unknown> {
  const { recording } = input;
  const reloads = recording.restarts.map((r) => [r.reloadAt, r.watchingAt] as const);
  return {
    pattern: input.pattern,
    commit: input.commit,
    startedAt: input.startedAt,
    runFolder: input.runFolder,
    models: input.models,
    durationMs: input.encoded.durationMs,
    bytes: input.bytes,
    sha256: input.sha256,
    frames: recording.frames.length,
    framesPerSecond: Number(framesPerSecond(recording.frames, reloads).toFixed(1)),
    longestGapMs: Math.round(longestGap(recording.frames, reloads)),
    frameSize: { width: FRAME_SIZE.width, height: FRAME_SIZE.height },
    title: recording.title,
    restartsFollowed: recording.restarts.length,
    // At least how long the video runs on after its chat's last line — from the later of the end's hold beginning and
    // the last change it saw (demo-scene-refresh R12); refusals require 3,000 ms or more.
    afterLastLineMs:
      present(recording.frames.at(-1), 'the last frame').at - present(recording.lastLineAt, "the chat's last line"),
    scenarios: input.scenarios.map((s) => ({ id: s.id, outcome: s.state })),
  };
}
