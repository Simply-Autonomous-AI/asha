// The demo recorder's judgement (docs/plans/demo-videos.md R4, R5; A2): every reason promotion refuses a recording,
// each on a recording that is clean but for it; the tick mapping; the encode's checks on a fake ffmpeg, its frames
// removed after a success and kept after a failure; the frame's title read from a page; and no `recordVideo` anywhere
// in the recorder.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { AgentSuiteRunning } from '../helpers/suite-lock.js';
import {
  END_BUDGET_MS,
  END_HOLD_MAX_MS,
  END_HOLD_MS,
  ENDING_PAGE,
  FFMPEG_REVISION,
  HOLD_POLL_MS,
  LAST_LINE_HOLD_MS,
  OPENING_PAGE,
  REEL_HOLD_MS,
  durationOf,
  encode,
  encodeArgs,
  encodeUnderLock,
  bounded,
  framesPerSecond,
  holdLeft,
  holdUntilQuiet,
  longestGap,
  outsideSpans,
  pageMs,
  privateIn,
  readingMs,
  refusals,
  ticksOf,
  titleOf,
  type EncodeOutcome,
  type EncodeProps,
  type Frame,
  type PromotionInput,
  type RecordingFacts,
  ffmpegRunner,
  type RunFfmpeg,
} from '../agents/patterns/recorder.js';

const T0 = 1_760_000_000_000;
/** 20 frames a second, 2560 × 1440, from T0 to T0 + 10 s, none while the page reloads (T0 + 4.5 s to T0 + 5.5 s). */
function frames(): Frame[] {
  const out: Frame[] = [];
  for (let t = T0; t <= T0 + 10_000; t += 50)
    if (t <= T0 + 4_500 || t >= T0 + 5_500)
      out.push({ file: `/frames/f${String(out.length)}.jpg`, at: t, width: 2560, height: 1440 });
  return out;
}

/** One followed stop: seen at 4 s, the reload begun at 4.5 s, the page watching again at 5.5 s. */
const RESTART = { stopAt: T0 + 4_000, seenAt: T0 + 4_100, reloadAt: T0 + 4_500, watchingAt: T0 + 5_500 };

function recording(over: Partial<RecordingFacts> = {}): RecordingFacts {
  return {
    suite: 'p20-resume',
    title: 'P20 · Checkpoint and resume',
    purpose: 'Work in progress survives a stop of the harness.',
    channel: 'main',
    startedAt: T0,
    endedAt: T0 + 10_000,
    failed: null,
    frames: frames(),
    restarts: [RESTART],
    unfollowedStopAt: null,
    pageErrors: [],
    banners: [],
    failureNotes: [],
    captureErrors: [],
    slowCaptures: [],
    violations: [],
    pixelRatios: [
      { at: T0, ratio: 2 },
      { at: T0 + 5_500, ratio: 2 },
    ],
    threads: [
      { document: 1, lines: ['p20-a', 'stopping: the daemon is stopping, and takes no new work'] },
      { document: 2, lines: ['lead-1: Done.'] },
    ],
    clientErrors: [],
    // The chat's last line 3 s before the last frame (T0 + 10 s): the least R12 allows.
    lastLineAt: T0 + 7_000,
    ...over,
  };
}

const ENCODED: EncodeOutcome = { ok: true, reason: null, bytes: 5_000_000, durationMs: 10_000, ticks: 250 };

function input(over: Partial<PromotionInput> = {}): PromotionInput {
  return {
    recording: recording(),
    scenarios: [
      { id: 'p20-a', state: 'pass' },
      { id: 'p20-b', state: 'pass' },
    ],
    tree: { clean: true, head: 'a'.repeat(40), headAtStart: 'a'.repeat(40) },
    encode: ENCODED,
    privacy: { login: 'zora', home: '/Users/zora', tmp: '/var/folders/xy/abc/T' },
    ...over,
  };
}

/** The one reason a recording clean but for one thing gets: it names what failed. */
function onlyReason(over: Partial<PromotionInput>): string {
  const reasons = refusals(input(over));
  expect(reasons).toHaveLength(1);
  return present(reasons[0], 'reasons[0]');
}

describe("the combined video's reading times and pages (demo-scene-refresh R12, R13, R15)", () => {
  it('a title card shows for 1,000 ms and 150 ms a word, 3,000 to 8,000 ms; a page 2,000 ms and 300 ms a word, at least 5,000 ms; each demo held 3,000 ms', () => {
    expect(readingMs('')).toBe(3_000);
    expect(readingMs('a b c d e f g h i j k l m')).toBe(3_000);
    expect(readingMs('a b c d e f g h i j k l m n')).toBe(3_100);
    expect(readingMs(Array.from({ length: 30 }, () => 'word').join(' '))).toBe(5_500);
    expect(readingMs(Array.from({ length: 46 }, () => 'word').join(' '))).toBe(7_900);
    expect(readingMs(Array.from({ length: 63 }, () => 'word').join(' '))).toBe(8_000);
    // A separator is not a word (R1-DESIGN-008): twenty words, not twenty-four.
    expect(readingMs('a · b — c / d - e f g h i j k l m n o p q r s t')).toBe(4_000);
    expect(pageMs('')).toBe(5_000);
    expect(pageMs('a · b — c / d - e f g h i j k')).toBe(5_300);
    expect(pageMs(Array.from({ length: 40 }, () => 'word').join(' '))).toBe(14_000);
    expect(REEL_HOLD_MS).toBe(3_000);
  });

  it("the opening and end pages are the owner's words, line by line, each for its reading time", () => {
    expect(OPENING_PAGE).toEqual([
      'ASHA - Autonomous Simple Harness for Agents',
      'Demo: Multi-Agent Orchestration Patterns',
      'SimplyAutonomous.AI',
    ]);
    expect(ENDING_PAGE).toEqual(['ASHA - Autonomous Simple Harness for Agents', 'SimplyAutonomous.AI']);
    expect(pageMs(OPENING_PAGE.join(' '))).toBe(5_300);
    expect(pageMs(ENDING_PAGE.join(' '))).toBe(5_000);
  });
});

describe("the end's hold and the chat's last line (demo-scene-refresh R12)", () => {
  it('holds END_HOLD_MS, then until LAST_LINE_HOLD_MS after the last line, never past END_HOLD_MAX_MS', () => {
    expect([END_HOLD_MS, LAST_LINE_HOLD_MS, END_HOLD_MAX_MS]).toEqual([5_000, 3_000, 15_000]);
    expect(holdLeft(0, 0, 0)).toBe(5_000);
    expect(holdLeft(4_000, 0, 0)).toBe(1_000);
    expect(holdLeft(5_000, 0, 0)).toBe(0);
    // A line at 4 s: until 7 s and one poll more, 7.25 s, so the last frame is past 7 s (R1-DESIGN-007).
    expect(holdLeft(5_000, 0, 4_000)).toBe(2_250);
    expect(holdLeft(7_000, 0, 4_000)).toBe(250);
    expect(holdLeft(7_250, 0, 4_000)).toBe(0);
    // Lines still coming at 14 s: the hold ends at 15 s anyway.
    expect(holdLeft(14_500, 0, 14_000)).toBe(500);
    expect(holdLeft(15_000, 0, 14_000)).toBe(0);
  });

  /** A fake clock, its sleep, and a thread whose lines are `at(t)`; each read is logged at its time. */
  function scripted(at: (t: number) => readonly string[], failOnRead?: number) {
    const clock = { t: 0 };
    const reads: number[] = [];
    return {
      clock,
      reads,
      read: (): Promise<readonly string[]> => {
        reads.push(clock.t);
        if (reads.length === failOnRead) return Promise.reject(new Error('the page is gone'));
        return Promise.resolve(at(clock.t));
      },
      now: () => clock.t,
      wait: (ms: number): Promise<void> => {
        clock.t += ms;
        return Promise.resolve();
      },
    };
  }

  it('holdUntilQuiet: a thread changing at 1 s and 4 s holds to 7.25 s and returns 4 s, read every 250 ms', async () => {
    // One line, a second at 1 s, a third at 4 s.
    const thread = scripted((t) => ['a', 'b', 'c'].slice(0, 1 + Number(t >= 1_000) + Number(t >= 4_000)));
    expect(await holdUntilQuiet(thread.read, thread.now, thread.wait)).toBe(4_000);
    expect(thread.clock.t).toBe(7_250);
    expect(thread.reads).toEqual(Array.from({ length: 30 }, (_, i) => i * HOLD_POLL_MS));
  });

  it('holdUntilQuiet: a thread that never changes holds END_HOLD_MS and returns when it began', async () => {
    const thread = scripted(() => ['a']);
    thread.clock.t = 1_000;
    expect(await holdUntilQuiet(thread.read, thread.now, thread.wait)).toBe(1_000);
    expect(thread.clock.t).toBe(1_000 + END_HOLD_MS);
  });

  it('holdUntilQuiet: a line changed in place counts, and a thread still changing at 15 s ends at the cap', async () => {
    const edited = scripted((t) => [t >= 2_000 ? 'b' : 'a']);
    expect(await holdUntilQuiet(edited.read, edited.now, edited.wait)).toBe(2_000);
    const busy = scripted((t) => [String(t)]);
    expect(await holdUntilQuiet(busy.read, busy.now, busy.wait)).toBe(END_HOLD_MAX_MS);
    expect(busy.clock.t).toBe(END_HOLD_MAX_MS);
  });

  it('holdUntilQuiet: a read that fails rejects the hold with its error, reading no more', async () => {
    const thread = scripted(() => ['a'], 3);
    await expect(holdUntilQuiet(thread.read, thread.now, thread.wait)).rejects.toThrow('the page is gone');
    expect(thread.reads).toEqual([0, 250, 500]);
  });

  it("bounded: a promise's value within its bound; past it, a rejection naming what was waited for", async () => {
    expect(END_BUDGET_MS).toBe(18_000);
    await expect(bounded(Promise.resolve(7), 50, 'a quick call')).resolves.toBe(7);
    await expect(bounded(new Promise<never>(() => undefined), 5, 'a call that never returns')).rejects.toThrow(
      'a call that never returns',
    );
    await expect(bounded(Promise.reject(new Error('its own failure')), 50, 'a failing call')).rejects.toThrow(
      'its own failure',
    );
  });

  it("a video ending under 3,000 ms after its chat's last line is refused, naming its tail; 3,000 ms is enough", () => {
    expect(refusals(input())).toEqual([]);
    expect(onlyReason({ recording: recording({ lastLineAt: T0 + 7_001 }) })).toBe(
      "the video ends 2999 ms after its chat's last line, under 3000 ms",
    );
  });
});

describe('promotion (R4, R5)', () => {
  it("promotes a clean recording, and one whose only failure lines and reports are a followed stop's own", () => {
    expect(refusals(input())).toEqual([]);
    const stopLines = [
      'stopping: the daemon is stopping, and takes no new work',
      '✗ telemetry is no longer updated for this watch',
      '✗ stream_cut: the daemon closed /v1/channel before it was done (TypeError)',
      '✗ the daemon is unreachable: it is not running, or has stopped; run asha --portal to start it and open a new page',
      '✗ the failure could not be reported to the daemon (TypeError)',
    ];
    const withStop = recording({
      failureNotes: stopLines.map((text, i) => ({ at: T0 + 4_100 + i * 100, text, document: 1 })),
      banners: [{ at: T0 + 4_300, text: '✗ the daemon is unreachable' }],
      clientErrors: [
        { at: T0 + 4_200, event: 'portal.client_error', reason: 'stream_cut', detail: '/v1/channel TypeError' },
      ],
    });
    expect(refusals(input({ recording: withStop }))).toEqual([]);
  });

  it('refuses a scenario that did not pass, and a suite with none', () => {
    expect(
      onlyReason({
        scenarios: [
          { id: 'p20-a', state: 'pass' },
          { id: 'p20-b', state: 'fail' },
        ],
      }),
    ).toBe('scenario p20-b did not pass (fail)');
    expect(onlyReason({ scenarios: [] })).toBe('the suite recorded no scenario');
  });

  it("refuses the recorder's own failure, a stop not followed, and the sampler's violation", () => {
    expect(onlyReason({ recording: recording({ failed: "no live daemon of the suite's home within 60000 ms" }) })).toBe(
      "the recorder failed: no live daemon of the suite's home within 60000 ms",
    );
    expect(onlyReason({ recording: recording({ unfollowedStopAt: T0 + 8_000 }) })).toBe(
      'a stop at 8.0 s was not followed within 120000 ms',
    );
    expect(
      onlyReason({ recording: recording({ violations: [{ at: T0 + 2_000, text: 'div#watch-telemetry' }] }) }),
    ).toBe('the frame let div#watch-telemetry show at 2.0 s');
  });

  it("refuses the daemon log's client errors outside a stop's span, and one inside it that is not the watch's cut", () => {
    expect(
      onlyReason({
        recording: recording({
          clientErrors: [
            { at: T0 + 1_000, event: 'portal.client_error', reason: 'bad_status', detail: '/v1/telemetry 500' },
          ],
        }),
      }),
    ).toBe('the daemon log records portal.client_error (bad_status) at 1.0 s');
    expect(
      onlyReason({
        recording: recording({
          clientErrors: [
            { at: T0 + 4_200, event: 'portal.client_error', reason: 'bad_status', detail: '/v1/telemetry 500' },
          ],
        }),
      }),
    ).toBe('the daemon log records portal.client_error (bad_status) at 4.2 s');
    expect(
      onlyReason({
        recording: recording({
          clientErrors: [{ at: T0 + 7_000, event: 'portal.client_error_dropped', reason: null, detail: null }],
        }),
      }),
    ).toBe('the daemon log records portal.client_error_dropped (no reason) at 7.0 s');
  });

  it('refuses the page throwing, and its banner outside a stop', () => {
    expect(
      onlyReason({ recording: recording({ pageErrors: [{ at: T0 + 4_200, text: 'TypeError: x is undefined' }] }) }),
    ).toBe('the page threw at 4.2 s: TypeError: x is undefined');
    expect(
      onlyReason({ recording: recording({ banners: [{ at: T0 + 9_000, text: '✗ exception: TypeError' }] }) }),
    ).toBe("the page's banner showed at 9.0 s: ✗ exception: TypeError");
  });

  it("refuses a failure note outside a stop — in a document kept before its reload too — and one inside it that is not the stop's", () => {
    expect(
      onlyReason({
        recording: recording({ failureNotes: [{ at: T0 + 2_000, text: '✗ timeout: /v1/telemetry', document: 1 }] }),
      }),
    ).toBe('a failure note in document 1 at 2.0 s: ✗ timeout: /v1/telemetry');
    expect(
      onlyReason({
        recording: recording({
          failureNotes: [{ at: T0 + 4_200, text: '✗ bad_status: /v1/telemetry answered HTTP 500', document: 1 }],
        }),
      }),
    ).toBe(
      'a failure note in document 1 at 4.2 s, during a stop, not one of its lines: ✗ bad_status: /v1/telemetry answered HTTP 500',
    );
    expect(
      onlyReason({
        recording: recording({
          failureNotes: [
            {
              at: T0 + 8_000,
              text: '✗ stream_cut: the daemon closed /v1/channel before it was done (TypeError)',
              document: 2,
            },
          ],
        }),
      }),
    ).toBe(
      'a failure note in document 2 at 8.0 s: ✗ stream_cut: the daemon closed /v1/channel before it was done (TypeError)',
    );
  });

  it('refuses a changed tree, and HEAD moved', () => {
    expect(onlyReason({ tree: { clean: false, head: 'a'.repeat(40), headAtStart: 'a'.repeat(40) } })).toBe(
      'the tree changed outside docs/patterns/videos/ and the results paths during the run',
    );
    expect(onlyReason({ tree: { clean: true, head: 'b'.repeat(40), headAtStart: 'a'.repeat(40) } })).toBe(
      `HEAD moved during the run, from ${'a'.repeat(12)} to ${'b'.repeat(12)}`,
    );
  });

  it('refuses a video over 10,000,000 bytes, and a failed encode with its reason', () => {
    expect(onlyReason({ encode: { ...ENCODED, bytes: 10_000_001 } })).toBe(
      'the video is 10000001 bytes, over 10000000',
    );
    expect(refusals(input({ encode: { ...ENCODED, bytes: 10_000_000 } }))).toEqual([]);
    expect(
      onlyReason({ encode: { ok: false, reason: 'ffmpeg exited 1: boom', bytes: 0, durationMs: null, ticks: 250 } }),
    ).toBe('the encode failed: ffmpeg exited 1: boom');
  });

  it('refuses a frame not 2560 × 1440, and a devicePixelRatio not 2', () => {
    const odd = frames().map((f, i) => (i === 4 ? { ...f, width: 1280, height: 720 } : f));
    expect(onlyReason({ recording: recording({ frames: odd }) })).toBe(
      '1 frame(s) not 2560 × 1440, the first 1280 × 720 at 0.2 s',
    );
    expect(onlyReason({ recording: recording({ pixelRatios: [{ at: T0 + 6_000, ratio: 1 }] }) })).toBe(
      "the page's devicePixelRatio was 1 at 6.0 s, not 2",
    );
  });

  it('refuses a thread holding the login name, a home path or a 64-hex value — in a document kept before a reload, the last one clean — and the title too, never quoting it', () => {
    const kept = (line: string) =>
      recording({
        threads: [
          { document: 1, lines: ['p20-a', line] },
          { document: 2, lines: ['lead-1: Done.'] },
        ],
      });
    expect(onlyReason({ recording: kept('written by Zora at noon') })).toBe("document 1's thread holds the login name");
    expect(refusals(input({ recording: kept('saved to /Users/zora/notes.txt') }))).toEqual([
      "document 1's thread holds the login name",
      "document 1's thread holds the home folder",
      "document 1's thread holds a home or temporary path",
    ]);
    expect(onlyReason({ recording: kept('saved to /private/tmp/asha-x/notes.txt') })).toBe(
      "document 1's thread holds a home or temporary path",
    );
    expect(onlyReason({ recording: kept(`token ${'c'.repeat(64)}`) })).toBe("document 1's thread holds a 64-hex value");
    expect(refusals(input({ recording: recording({ purpose: 'Run from /var/folders/xy/abc/T/x.' }) }))).toEqual([
      'the title holds the temporary folder',
      'the title holds a home or temporary path',
    ]);
    for (const reason of refusals(input({ recording: kept(`token ${'c'.repeat(64)} by zora`) }))) {
      expect(reason).not.toContain('c'.repeat(64));
      expect(reason).not.toContain('zora');
    }
  });

  it('refuses a capture call that failed or took over 5,000 ms, and a capture under 15 frames a second', () => {
    expect(
      onlyReason({ recording: recording({ captureErrors: [{ at: T0 + 3_000, text: 'Error: Target closed' }] }) }),
    ).toBe('a capture call failed at 3.0 s: Error: Target closed');
    expect(onlyReason({ recording: recording({ slowCaptures: [{ at: T0 + 3_000, ms: 5_200 }] }) })).toBe(
      'a capture call took 5200 ms at 3.0 s, over 5000 ms',
    );
    // One frame, at T0: its chat's last line 3 s before it, so the frame count is all that is wrong.
    expect(onlyReason({ recording: recording({ frames: frames().slice(0, 1), lastLineAt: T0 - 3_000 }) })).toBe(
      'the capture took 1 frame(s)',
    );
    const slow = frames().filter((_, i) => i % 2 === 0);
    // Every other frame: the last at T0 + 9.95 s, so its chat's last line 3 s before that.
    expect(onlyReason({ recording: recording({ frames: slow, lastLineAt: T0 + 6_950 }) })).toMatch(
      /^the capture ran at 10\.\d frames a second, under 15$/,
    );
  });

  it("refuses a gap over 500 ms outside a reload: one past the reload's end counted from it, and one in the stop before the reload began", () => {
    const without = (from: number, to: number) => frames().filter((f) => f.at <= from || f.at >= to);
    expect(onlyReason({ recording: recording({ frames: without(T0 + 2_000, T0 + 2_600) }) })).toBe(
      'a gap of 600 ms between frames outside a reload, over 500 ms',
    );
    // Begins inside the reload (4.5–5.5 s) and runs 600 ms past its end.
    expect(onlyReason({ recording: recording({ frames: without(T0 + 4_500, T0 + 6_100) }) })).toBe(
      'a gap of 600 ms between frames outside a reload, over 500 ms',
    );
    // During the stop's span (from 4.0 s) but before the reload began (4.5 s): not exempt.
    expect(onlyReason({ recording: recording({ frames: without(T0 + 3_850, T0 + 4_450) }) })).toBe(
      'a gap of 600 ms between frames outside a reload, over 500 ms',
    );
    expect(refusals(input({ recording: recording({ frames: without(T0 + 2_000, T0 + 2_500) }) }))).toEqual([]);
  });
});

describe("the capture's facts and the ticks (R5)", () => {
  it('maps each 40 ms tick to the last frame taken at or before it', () => {
    const taken = [{ at: 0 }, { at: 30 }, { at: 100 }, { at: 170 }];
    expect(ticksOf(taken)).toEqual([0, 1, 1, 2, 2]);
    expect(ticksOf([])).toEqual([]);
    expect(ticksOf([{ at: 5 }])).toEqual([0]);
  });

  it("counts a gap's part outside every span, and frames a second outside them", () => {
    expect(outsideSpans(0, 1_000, [[200, 400]])).toBe(800);
    expect(outsideSpans(300, 1_000, [[200, 400]])).toBe(600);
    expect(longestGap([{ at: 0 }, { at: 100 }, { at: 1_100 }], [[100, 1_000]])).toBe(100);
    expect(framesPerSecond(frames(), [[RESTART.reloadAt, RESTART.watchingAt]])).toBeCloseTo(20, 0);
  });

  it("reads the Duration line, and builds the plan's exact encode arguments", () => {
    expect(
      durationOf(
        "Input #0, matroska,webm, from 'x.webm':\n  Duration: 00:01:02.04, start: 0.000000, bitrate: 500 kb/s",
      ),
    ).toBe(62_040);
    expect(durationOf('no such line')).toBeNull();
    expect(encodeArgs('/out/p05.webm').join(' ')).toBe(
      '-hide_banner -loglevel error -f image2pipe -framerate 25 -c:v mjpeg -i pipe:0 -c:v libvpx -deadline good -cpu-used 1 -threads 8 -auto-alt-ref 1 -lag-in-frames 16 -qmin 0 -qmax 50 -crf 10 -b:v 500k -an -f webm /out/p05.webm',
    );
  });
});

describe('the encode, once (R5)', () => {
  const VERSION = `ffmpeg version ${FFMPEG_REVISION} Copyright (c) 2000-2024\nbuilt with clang`;
  /** Ten frames over 360 ms: ten ticks, a 400 ms video. */
  const TEN = Array.from({ length: 10 }, (_, i): Frame => ({
    file: `/frames/f${String(i)}.jpg`,
    at: 1_000 + i * 40,
    width: 2560,
    height: 1440,
  }));

  function fake(over: { encode?: Awaited<ReturnType<RunFfmpeg>>; info?: string; exists?: boolean } = {}) {
    const calls: { args: readonly string[]; frames: number; boundMs: number }[] = [];
    const removed: string[] = [];
    const run: RunFfmpeg = async (args, stdin, boundMs) => {
      let n = 0;
      if (stdin !== null) {
        const iterator = stdin[Symbol.asyncIterator]();
        for (let step = await iterator.next(); !step.done; step = await iterator.next()) n += 1;
      }
      calls.push({ args, frames: n, boundMs });
      if (args.includes('-i') && args.includes('pipe:0'))
        return over.encode ?? { code: 0, stderr: '', timedOut: false };
      return { code: 1, stderr: over.info ?? 'Input #0\n  Duration: 00:00:00.40, start: 0.000000', timedOut: false };
    };
    const props: EncodeProps = {
      frames: TEN,
      framesDir: '/run/p05/frames',
      output: '/run/p05/p05.webm',
      version: VERSION,
      run,
      readFrame: () => Buffer.from([0xff, 0xd8]),
      exists: () => over.exists ?? false,
      size: () => 123_456,
      removeFrames: (dir) => removed.push(dir),
    };
    return { props, calls, removed };
  }

  it('encodes each tick once, checks the duration, and removes the frames after it succeeds', async () => {
    const { props, calls, removed } = fake();
    expect(await encode(props)).toEqual({ ok: true, reason: null, bytes: 123_456, durationMs: 400, ticks: 10 });
    expect(calls.map((c) => [c.args.at(-1), c.frames])).toEqual([
      ['/run/p05/p05.webm', 10],
      ['/run/p05/p05.webm', 0],
    ]);
    expect(present(calls[0], 'calls[0]').boundMs).toBe(2 * 400 + 60_000);
    expect(removed).toEqual(['/run/p05/frames']);
  });

  it.each([
    ['ffmpeg exits non-zero', { encode: { code: 1, stderr: 'boom', timedOut: false } }, 'ffmpeg exited 1: boom'],
    [
      'ffmpeg writes to its error stream',
      { encode: { code: 0, stderr: '[mjpeg] corrupt frame', timedOut: false } },
      'ffmpeg wrote to its error stream: [mjpeg] corrupt frame',
    ],
    [
      'the encode passes its bound',
      { encode: { code: null, stderr: '', timedOut: true } },
      "the encode took more than 60800 ms, twice the video's length and 60 s",
    ],
    [
      'the duration differs by over 40 ms',
      { info: '  Duration: 00:00:00.45, start: 0.000000' },
      'the video lasts 450 ms, not the 400 ms of its 10 ticks',
    ],
    [
      'there is no Duration line',
      { info: 'Invalid data found when processing input' },
      'ffmpeg -i /run/p05/p05.webm printed no Duration line',
    ],
    ['the output path exists', { exists: true }, '/run/p05/p05.webm exists: ffmpeg would exit 0 without writing it'],
    [
      'ffmpeg exits 0 without reading all its frames',
      { encode: { code: 0, stderr: '', timedOut: false, inputError: 'write EPIPE' } },
      'ffmpeg exited 0 without reading all its frames: write EPIPE',
    ],
  ] as const)('fails when %s, keeping the frames', async (_label, over, reason) => {
    const { props, removed } = fake(over);
    expect(await encode(props)).toMatchObject({ ok: false, reason });
    expect(removed).toEqual([]);
  });

  /** 64 chunks of 1 MiB, more than any pipe holds. */
  async function* big(): AsyncIterable<Buffer> {
    await Promise.resolve();
    for (let i = 0; i < 64; i += 1) yield Buffer.alloc(1 << 20);
  }

  it("keeps a write ffmpeg can no longer take as data, never a throw: one that exits before reading its input (the code review's round 4, R4-DESIGN-003)", async () => {
    const run = ffmpegRunner('/bin/sh');
    expect(await run(['-c', 'exit 0'], big(), 10_000)).toEqual({
      code: 0,
      stderr: '',
      timedOut: false,
      inputError: 'write EPIPE',
    });
  });

  it('kills one past its bound, its writes ended, and says it timed out', async () => {
    const run = ffmpegRunner('/bin/sh');
    const started = Date.now();
    const result = await run(['-c', 'sleep 30'], big(), 200);
    expect([result.code, result.timedOut, result.stderr]).toEqual([null, true, '']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails with no frames to encode, running nothing', async () => {
    const { props, calls } = fake();
    expect(await encode({ ...props, frames: [] })).toMatchObject({
      ok: false,
      reason: 'there are no frames to encode',
      ticks: 0,
    });
    expect(calls).toEqual([]);
  });

  it("accepts a duration within 40 ms of the ticks'", async () => {
    const { props } = fake({ info: '  Duration: 00:00:00.44, start: 0.000000' });
    expect(await encode(props)).toMatchObject({ ok: true, durationMs: 440 });
  });

  it('refuses an ffmpeg that is not revision 1011, running nothing', async () => {
    const { props, calls, removed } = fake();
    expect(await encode({ ...props, version: 'ffmpeg version 6.1 Copyright (c) 2000-2023' })).toMatchObject({
      ok: false,
      reason: `the bundled ffmpeg is not ${FFMPEG_REVISION}: ffmpeg version 6.1 Copyright (c) 2000-2023`,
    });
    expect(calls).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe('the title, and what the recorder does not use', () => {
  it("reads the page's heading and the paragraph under it, as plain text", () => {
    const page =
      '---\ntitle: X\n---\n\n# P5 · Orchestrator–workers\n\nA lead splits a request into parts and gives each part to the [worker](x.md) whose `description` covers it.\n\n<div class="facts"></div>\n';
    expect(titleOf(page)).toEqual({
      title: 'P5 · Orchestrator–workers',
      purpose: 'A lead splits a request into parts and gives each part to the worker whose description covers it.',
    });
    expect(() => titleOf('no heading')).toThrow('the demo page has no heading');
  });

  it('holds no recordVideo: the frames are its own captures (R5)', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'agents', 'patterns', 'recorder.ts'), 'utf8');
    expect(source).not.toMatch(/recordVideo/);
    expect(privateIn('nothing here', { login: 'zora', home: '/Users/zora', tmp: '/var/folders/xy/abc/T' })).toEqual([]);
  });
});

describe('the encode under the agent-suite lock (R12)', () => {
  it('encodes while it holds the lock, and releases it after', async () => {
    const steps: string[] = [];
    const outcome = await encodeUnderLock({
      take: () => {
        steps.push('take');
        return Promise.resolve(() => {
          steps.push('release');
          return Promise.resolve();
        });
      },
      run: () => {
        steps.push('encode');
        return Promise.resolve({ ok: true, reason: null, bytes: 1, durationMs: 40, ticks: 1 });
      },
    });
    expect(outcome.ok).toBe(true);
    expect(steps).toEqual(['take', 'encode', 'release']);
  });

  it('while another process holds the lock, encodes nothing and fails naming the holder, so the recording is refused and the run goes on', async () => {
    let encoded = false;
    const outcome = await encodeUnderLock({
      take: () =>
        Promise.reject(
          new AgentSuiteRunning('/tmp/asha-agent-suite.lock', 4242, 'cannot start this agent suite or eval'),
        ),
      run: () => {
        encoded = true;
        return Promise.resolve({ ok: true, reason: null, bytes: 1, durationMs: 40, ticks: 1 });
      },
    });
    expect(encoded).toBe(false);
    expect(outcome).toMatchObject({ ok: false, ticks: 0 });
    expect(outcome.reason).toMatch(/^not encoded: .*pid 4242 holds \/tmp\/asha-agent-suite\.lock/);
  });

  it('any other failure to take the lock is thrown, not turned into a refusal', async () => {
    await expect(
      encodeUnderLock({
        take: async () => Promise.reject(new Error('EACCES: /tmp')),
        run: () => Promise.resolve({ ok: true, reason: null, bytes: 1, durationMs: 40, ticks: 1 }),
      }),
    ).rejects.toThrow('EACCES: /tmp');
  });
});

describe("the demo commands' resolve hook (tools/demos/ts-hooks.mjs)", () => {
  const root = join(import.meta.dirname, '..', '..');
  const load = (flags: readonly string[]) =>
    spawnSync(
      process.execPath,
      [
        ...flags,
        '--input-type=module',
        '-e',
        "import { MIN_FPS, FFMPEG_REVISION } from './tests/agents/patterns/recorder.js'; console.log(MIN_FPS, FFMPEG_REVISION);",
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );

  it("loads the recorder's TypeScript by its .js name, as package.json's demos:record runs it", () => {
    const result = load([
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      '--import',
      './tools/demos/register.mjs',
    ]);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(`15 ${FFMPEG_REVISION}`);
    expect(result.status).toBe(0);
  });

  it("loads a tool's .mts module by its .mjs name, as reel.mts and record.mts import decide.mts", () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        '--import',
        './tools/demos/register.mjs',
        '--input-type=module',
        '-e',
        "import { REEL_RATE, slugOf } from './tools/demos/decide.mjs'; console.log(REEL_RATE, slugOf('docs/patterns/p01-x.md'));",
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('2 p01-x');
    expect(result.status).toBe(0);
  });

  it('without it, the same import fails: the hook is what resolves it', () => {
    const result = load(['--experimental-transform-types', '--disable-warning=ExperimentalWarning']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ERR_MODULE_NOT_FOUND/);
  });

  it("package.json runs both demo commands with the hook and Node's TypeScript support", () => {
    const scripts = (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    for (const name of ['demos:record', 'demos:reel'])
      expect(scripts[name], name).toMatch(
        /^node --experimental-transform-types --disable-warning=ExperimentalWarning --import \.\/tools\/demos\/register\.mjs tools\/demos\/(record|reel)\.mts$/,
      );
  });
});
