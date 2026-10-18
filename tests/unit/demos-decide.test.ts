// The demo commands' decisions (tools/demos/decide.mts; the code review's round 3 on demo-scene-refresh, R3-COVERAGE-001,
// -002): the catalogue's order and a demo outside it, the demos named on the command line, the combined video's demos
// less those it leaves out (R17) and which are not promoted, each part's card time and playback bound (R6, R13), and
// every field of both sidecars, `afterLastLineMs` among them (R12), each with exact values.

import { describe, expect, it } from 'vitest';

import {
  ENDING_MS,
  OPENING_MS,
  REEL_RATE,
  catalogueOrder,
  demoSidecar,
  playbackBoundMs,
  reelDemos,
  reelPart,
  reelSidecar,
  selectWanted,
  slugOf,
  unpromoted,
  type DemoEntry,
} from '../../tools/demos/decide.mjs';
import {
  ENDING_PAGE,
  OPENING_PAGE,
  REEL_HOLD_MS,
  REEL_LEAVES_OUT,
  type Frame,
  type RecordingFacts,
} from '../agents/patterns/recorder.js';

const demo = (pattern: string, slug: string): DemoEntry => ({ pattern, page: `docs/patterns/${slug}.md` });
const P01 = demo('P1', 'p01-delegation');
const P02 = demo('P2', 'p02-router');
const P25 = demo('P25', 'p25-restart');
const CATALOGUE = '| # | Pattern |\n|---|---|\n| P2 | Router |\n| P1 | Delegation |\n| P25 | Restart |\n';

/** Frames every 100 ms from `from` to `to`, at the recorder's frame size. */
const frames = (from: number, to: number): Frame[] =>
  Array.from({ length: (to - from) / 100 + 1 }, (_, i) => ({
    file: `f${String(i)}.jpg`,
    at: from + i * 100,
    width: 2560,
    height: 1440,
  }));

describe("the demos, their order and the command line's choice (demo-videos R1)", () => {
  it('a slug from its page; the catalogue table orders the demos, and one outside it is named', () => {
    expect(slugOf('docs/patterns/p05-orchestrator-workers.md')).toBe('p05-orchestrator-workers');
    expect(catalogueOrder([P01, P25, P02], CATALOGUE)).toEqual([P02, P01, P25]);
    expect(() => catalogueOrder([demo('P9', 'p09-debate')], CATALOGUE)).toThrow(
      "P9 of demos.json is not in the catalogue's table",
    );
  });

  it('no argument records every demo; pNN in any case records that one; anything else is a problem naming it', () => {
    const all = [P01, P02, P25];
    expect(selectWanted([], all)).toEqual({ demos: all });
    expect(selectWanted(['P02', 'p01'], all)).toEqual({ demos: [P01, P02] });
    expect(selectWanted(['p99'], all)).toEqual({ problem: 'p99 names no pattern demo: give pNN, such as p05' });
    expect(selectWanted(['p01', 'router'], all)).toEqual({
      problem: 'router names no pattern demo: give pNN, such as p05',
    });
  });
});

describe('the combined video (demo-videos R6; demo-scene-refresh R12, R13, R15, R17)', () => {
  it('plays every demo but those it leaves out, and names those whose video or sidecar is not promoted', () => {
    expect(REEL_LEAVES_OUT).toEqual(['P25']);
    expect(reelDemos([P02, P01, P25], REEL_LEAVES_OUT)).toEqual([P02, P01]);
    const promoted = new Set(['p01-delegation.webm', 'p01-delegation.json', 'p02-router.webm']);
    expect(unpromoted([P01, P02], (f) => promoted.has(f))).toEqual(['P2']);
    expect(unpromoted([P01], (f) => promoted.has(f))).toEqual([]);
  });

  it("a part's card time is its words' reading time, and its playback is bounded by half its length and 10 s", () => {
    const part = reelPart(
      P01,
      { title: 'P1 · Delegation', purpose: 'One agent hands the whole task on.' },
      { sha256: 'a'.repeat(64), durationMs: 41_000 },
    );
    expect(part).toEqual({
      pattern: 'P1',
      slug: 'p01-delegation',
      title: 'P1 · Delegation',
      purpose: 'One agent hands the whole task on.',
      sha256: 'a'.repeat(64),
      durationMs: 41_000,
      cardMs: 3_000,
    });
    // Nine words: 1 s and 150 ms each is 2.35 s, under the card's 3 s.
    expect(part.cardMs).toBe(3_000);
    const long = reelPart(P01, { title: 'P1', purpose: Array.from({ length: 30 }, () => 'word').join(' ') }, part);
    expect(long.cardMs).toBe(1_000 + 150 * 31);
    expect(REEL_RATE).toBe(2);
    expect(playbackBoundMs(part)).toBe(30_500);
    expect([OPENING_MS, ENDING_MS]).toEqual([5_300, 5_000]);
  });

  it('its sidecar holds every field, each part with its card time and when it ended', () => {
    const parts = [
      reelPart(P02, { title: 'P2 · Router', purpose: 'Triage.' }, { sha256: 'b'.repeat(64), durationMs: 20_000 }),
      reelPart(P01, { title: 'P1 · Delegation', purpose: 'Hand-off.' }, { sha256: 'a'.repeat(64), durationMs: 30_000 }),
    ];
    const sidecar = reelSidecar({
      commit: 'c'.repeat(40),
      dirty: false,
      startedAt: '2026-10-16T12:00:00.000Z',
      runFolder: '<tmp>/asha-reel-x',
      parts,
      ended: [
        { pattern: 'P1', at: '2026-10-16T12:00:40.000Z' },
        { pattern: 'P2', at: '2026-10-16T12:00:20.000Z' },
      ],
      encoded: { durationMs: 60_000, bytes: 1_234 },
      sha256: 'd'.repeat(64),
      frames: frames(1_000, 2_000),
      leftOut: ['P25'],
    });
    expect(sidecar).toEqual({
      commit: 'c'.repeat(40),
      dirty: false,
      startedAt: '2026-10-16T12:00:00.000Z',
      runFolder: '<tmp>/asha-reel-x',
      parts: [
        {
          pattern: 'P2',
          video: 'p02-router.webm',
          sha256: 'b'.repeat(64),
          cardMs: 3_000,
          endedAt: '2026-10-16T12:00:20.000Z',
        },
        {
          pattern: 'P1',
          video: 'p01-delegation.webm',
          sha256: 'a'.repeat(64),
          cardMs: 3_000,
          endedAt: '2026-10-16T12:00:40.000Z',
        },
      ],
      durationMs: 60_000,
      bytes: 1_234,
      sha256: 'd'.repeat(64),
      frames: 11,
      framesPerSecond: 11,
      longestGapMs: 100,
      frameSize: { width: 2560, height: 1440 },
      playbackRate: 2,
      opening: { lines: OPENING_PAGE, ms: 5_300 },
      ending: { lines: ENDING_PAGE, ms: 5_000 },
      holdMs: REEL_HOLD_MS,
      leftOut: ['P25'],
    });
  });

  it('a part with no ended record is no sidecar: it names the part', () => {
    const part = reelPart(P01, { title: 'P1', purpose: 'x' }, { sha256: 'a'.repeat(64), durationMs: 1_000 });
    expect(() =>
      reelSidecar({
        commit: 'c'.repeat(40),
        dirty: false,
        startedAt: 's',
        runFolder: 'r',
        parts: [part],
        ended: [],
        encoded: { durationMs: 1, bytes: 1 },
        sha256: 'd'.repeat(64),
        frames: [],
        leftOut: [],
      }),
    ).toThrow('the ended record for P1');
  });
});

describe("a promoted demo's sidecar (demo-videos R5, R7; demo-scene-refresh R12)", () => {
  /** A recording with frames from 1 s to 2 s, one restart reloading from 1.4 s to 1.7 s, its last line at 1.5 s. */
  const recording = (over: Partial<RecordingFacts> = {}): RecordingFacts => ({
    suite: 'p01-delegation',
    title: 'P1 · Delegation',
    purpose: 'Hand-off.',
    channel: 'main',
    startedAt: 0,
    endedAt: 2_100,
    failed: null,
    frames: frames(1_000, 2_000),
    restarts: [{ stopAt: 1_300, seenAt: 1_350, reloadAt: 1_400, watchingAt: 1_700 }],
    unfollowedStopAt: null,
    pageErrors: [],
    banners: [],
    failureNotes: [],
    captureErrors: [],
    slowCaptures: [],
    violations: [],
    pixelRatios: [],
    threads: [],
    lastLineAt: 1_500,
    clientErrors: [],
    ...over,
  });
  const input = (over: Partial<RecordingFacts> = {}) => ({
    pattern: 'P1',
    commit: 'c'.repeat(40),
    startedAt: '2026-10-16T12:00:00.000Z',
    runFolder: '<tmp>/asha-record-x/p01-delegation',
    models: ['qwen3-8b-q4_k_m'],
    recording: recording(over),
    encoded: { durationMs: 1_000 },
    bytes: 99,
    sha256: 'e'.repeat(64),
    scenarios: [{ id: 'p01-a', state: 'pass' }],
  });

  it('holds every field, its rate and gap outside the reload, and how long it runs on after the last line', () => {
    expect(demoSidecar(input())).toEqual({
      pattern: 'P1',
      commit: 'c'.repeat(40),
      startedAt: '2026-10-16T12:00:00.000Z',
      runFolder: '<tmp>/asha-record-x/p01-delegation',
      models: ['qwen3-8b-q4_k_m'],
      durationMs: 1_000,
      bytes: 99,
      sha256: 'e'.repeat(64),
      frames: 11,
      // 9 frames outside the 0.3 s reload, over the 0.7 s outside it.
      framesPerSecond: 12.9,
      longestGapMs: 100,
      frameSize: { width: 2560, height: 1440 },
      title: 'P1 · Delegation',
      restartsFollowed: 1,
      afterLastLineMs: 500,
      scenarios: [{ id: 'p01-a', outcome: 'pass' }],
    });
  });

  it('a recording with no last line or no frame is no sidecar: it names what is missing', () => {
    expect(() => demoSidecar(input({ lastLineAt: null }))).toThrow("the chat's last line");
    expect(() => demoSidecar(input({ frames: [] }))).toThrow('the last frame');
  });
});
