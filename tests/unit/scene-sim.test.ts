// The channel's scene as a simulation, with no page (docs/plans/portal.md R9, A10; docs/plans/portal-scene-chat.md
// R1–R6, R5b, R5c, A1–A5, A21): robots per agent in join order, the crew's size by width and its badge, arcs per
// message, a speech bubble holding what each sender said, work bubbles and collecting cards, each robot's lamp from the
// model's deltas and the telemetry, the boxes' layout inside the canvas, each robot's personal space, and nothing
// changing without an event.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { observeWatchEvent } from '../../src/shared/lines.js';
import { AGENT_FAILURE_STATUS } from '../../src/shared/protocol.js';
import type {
  CallMark,
  ChannelMessage,
  GatherAnswer,
  TelemetryResponse,
  WatchEvent,
} from '../../src/shared/protocol.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type { SceneRobot } from '../../src/portal/scene-sim.js';
import {
  SCENE,
  SceneSim,
  UNSEEN_TASK,
  bubbleLines,
  intersects,
  labelBox,
  layoutBubbles,
  outcomeWords,
  personalSpace,
  robotBoxes,
  robotTop,
  type Endpoint,
  type Rect,
} from '../../src/portal/scene-sim.js';

const REPO = join(import.meta.dirname, '..', '..');

/** A seeded generator for idle motion only. */
function seeded(seed = 7): () => number {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648;
  };
}

function scene(width = 1_280, clock = { now: 0 }, height = 300, seed = 7) {
  const sim = new SceneSim({
    width,
    height,
    rng: seeded(seed),
    now: () => clock.now,
    measure: (text) => 7 * Array.from(text).length,
  });
  return {
    sim,
    clock,
    apply: (event: WatchEvent) => {
      observeWatchEvent(event, sim);
    },
  };
}

const message = (over: Partial<ChannelMessage> & Pick<ChannelMessage, 'from' | 'kind'>): ChannelMessage => ({
  id: 'm',
  channel: 'lab',
  conversation: 'c1',
  user: 'alice',
  to: null,
  text: 't',
  at: '2026-10-02T12:00:00.000Z',
  ...over,
});
const post = (over: Partial<ChannelMessage> & Pick<ChannelMessage, 'from' | 'kind'>): WatchEvent => ({
  type: 'message',
  message: message(over),
});
const question = (id: string): CallMark => ({ id, role: 'question' });
const answer = (id: string): CallMark => ({ id, role: 'answer', outcome: 'answered' });
const gather = (id: string, requests: readonly string[], answers: readonly GatherAnswer[]): CallMark => ({
  id,
  role: 'gather',
  context: { from: 'alice', text: 'the request' },
  requests: requests.map((to) => ({ to, text: 'q' })),
  answers,
});

const arcs = (sim: SceneSim): string[] => sim.arcs.map((a) => `${end(a.from)}→${end(a.to)}`);
const end = (e: Endpoint): string => (e.kind === 'robot' ? e.handle : e.kind);
const handles = (sim: SceneSim): string[] => sim.drawn().map((r) => r.handle);
const speech = (sim: SceneSim, handle: string): readonly string[] | null =>
  sim.drawn().find((r) => r.handle === handle)?.speech?.lines ?? null;
const tasks = (sim: SceneSim, handle: string): string[] => sim.workOf(handle).map((w) => w.task);
const telemetry = (inFlight: Record<string, number>): TelemetryResponse => ({
  channel: 'lab',
  agents: Object.entries(inFlight).map(([handle, n]) => ({
    handle,
    recipe: 'r',
    team: null,
    model: 'm',
    deliveries: 0,
    modelCalls: 0,
    lastModelCallMs: null,
    modelCallsInFlight: n,
    lastError: null,
  })),
});
const w = (n: number, c = 'w'): string => c.repeat(n);

describe('the scene (portal R9, A10)', () => {
  it('two agents join: exactly two robots, with those handles', () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: [] });
    apply({ type: 'agent_joined', agent: 'hewo-1' });
    apply({ type: 'agent_joined', agent: 'hewo-2' });
    expect(handles(sim)).toEqual(['hewo-1', 'hewo-2']);
    expect(sim.badge()).toBe(0);
  });

  it('a message from hewo-1 to hewo-2 is one arc between them; one to nobody in particular, an arc to each other agent', () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['hewo-1', 'hewo-2', 'hewo-3'] });
    apply(post({ from: 'hewo-1', to: 'hewo-2', kind: 'internal' }));
    expect(arcs(sim)).toEqual(['hewo-1→hewo-2']);
    sim.settle();
    apply(post({ from: 'hewo-1', to: null, kind: 'internal' }));
    expect(arcs(sim)).toEqual(['hewo-1→hewo-2', 'hewo-1→hewo-3']);
  });

  it("draws as many robots as its floor holds — 10 at the demo videos' frame, 6 at the portal's default, 4 when narrow — and +n for the rest (demo-scene-refresh R5)", () => {
    const agents = (n: number) => Array.from({ length: n }, (_, i) => `hewo-${String(i + 1)}`);
    for (const [width, height, n, drawn] of [
      [727, 614, 12, 10],
      [694, 420, 8, 6],
      [348, 300, 8, 4],
      [727, 614, 4, 4],
    ] as const) {
      const { sim, apply } = scene(width, { now: 0 }, height);
      apply({ type: 'watching', channel: 'lab', agents: agents(n) });
      expect([sim.drawn().length, sim.badge()], `${String(width)} × ${String(height)}, ${String(n)} agents`).toEqual([
        drawn,
        n - drawn,
      ]);
      // The rule: the walkable floor's area over SCENE.cellArea at the scene's scale, never under SCENE.minRobots.
      const f = sim.floor();
      const rule = Math.floor(((f.right - f.left) * (f.bottom - f.top)) / (SCENE.cellArea * sim.unit * sim.unit));
      expect(sim.capacity()).toBe(Math.max(SCENE.minRobots, rule));
    }
  });

  it('never draws more robots than the probe found settle apart, working, at each canvas it measured (R5, A2)', () => {
    const record = JSON.parse(
      readFileSync(join(REPO, 'tests', 'fixtures', 'probes', 'demo-scene-refresh-2026-10-16', 'capacity.json'), 'utf8'),
    ) as Record<string, { readonly holds: number; readonly capacity: number }>;
    expect(Object.keys(record).length).toBeGreaterThanOrEqual(6);
    for (const [size, { holds, capacity }] of Object.entries(record)) {
      const [width, height] = size.split('×').map(Number) as [number, number];
      const { sim } = scene(width, { now: 0 }, height);
      // The record was taken under today's rule, and holds it: at most what settles, or the minimum on a floor too
      // small for it (R5c (e)).
      expect(sim.capacity(), size).toBe(capacity);
      expect(capacity, size).toBeLessThanOrEqual(Math.max(holds, SCENE.minRobots));
    }
    expect(SCENE.narrowBelow).toBe(600);
  });

  it("join order: watching's agents in its order, then each agent_joined; a message to an agent not drawn arcs to the badge", () => {
    // The portal's default canvas: six robots drawn (R5).
    const { sim, apply } = scene(694, { now: 0 }, 420);
    expect(sim.capacity()).toBe(6);
    apply({ type: 'watching', channel: 'lab', agents: ['c-1', 'a-1', 'b-1'] });
    apply({ type: 'agent_joined', agent: 'z-1' });
    expect(handles(sim)).toEqual(['c-1', 'a-1', 'b-1', 'z-1']);
    expect(sim.online()).toEqual(['c-1', 'a-1', 'b-1', 'z-1']);
    for (const agent of ['d-1', 'e-1', 'f-1']) apply({ type: 'agent_joined', agent });
    expect([handles(sim), sim.badge()]).toEqual([['c-1', 'a-1', 'b-1', 'z-1', 'd-1', 'e-1'], 1]);
    apply(post({ from: 'c-1', to: 'f-1', kind: 'internal' }));
    expect(arcs(sim)).toEqual(['c-1→badge']);
    // The first drawn agent leaves: the one behind the badge is drawn in its place.
    apply({ type: 'agent_left', agent: 'c-1', detail: 'stopped' });
    expect([handles(sim), sim.badge(), arcs(sim)]).toEqual([['a-1', 'b-1', 'z-1', 'd-1', 'e-1', 'f-1'], 0, []]);
  });

  it("the lamp is amber exactly between a call's first model_delta and its model_done; writing() names it", () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['hewo-1', 'hewo-2'] });
    expect(sim.lamp('hewo-1')).toBe('white');
    apply({ type: 'model_delta', handle: 'hewo-1', conversation: 'c1', call: 'k1', seq: 0, part: 'text', text: 'He' });
    expect([sim.lamp('hewo-1'), sim.writing()]).toEqual(['amber', ['hewo-1']]);
    apply({ type: 'model_delta', handle: 'hewo-1', conversation: 'c1', call: 'k1', seq: 1, part: 'text', text: 'llo' });
    expect(sim.lamp('hewo-1')).toBe('amber');
    apply({ type: 'model_done', handle: 'hewo-1', conversation: 'c1', call: 'k1', outcome: 'ok' });
    expect([sim.lamp('hewo-1'), sim.writing()]).toEqual(['white', []]);
  });

  it('a telemetry answer with a call in flight lights the lamp only when it reached the page after the last model_done', () => {
    const { sim, apply, clock } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['hewo-1'] });
    clock.now = 1_000;
    sim.telemetry(telemetry({ 'hewo-1': 1 }));
    expect(sim.lamp('hewo-1')).toBe('amber');
    clock.now = 2_000;
    apply({ type: 'model_done', handle: 'hewo-1', conversation: 'c1', call: 'k1', outcome: 'ok' });
    // The answer older than the done: white.
    expect(sim.lamp('hewo-1')).toBe('white');
    clock.now = 3_000;
    sim.telemetry(telemetry({ 'hewo-1': 1 }));
    expect(sim.lamp('hewo-1')).toBe('amber');
    clock.now = 4_000;
    sim.telemetry(telemetry({ 'hewo-1': 0 }));
    expect(sim.lamp('hewo-1')).toBe('white');
  });

  it('with no event, no arc, bubble, robot, badge or lamp changes over 60 simulated seconds; only idle motion runs', () => {
    const { sim, apply } = scene(390);
    apply({ type: 'watching', channel: 'lab', agents: ['hewo-1', 'hewo-2', 'hewo-3', 'hewo-4', 'hewo-5'] });
    apply(post({ from: 'alice', to: 'hewo-2', kind: 'input' }));
    apply(post({ from: 'hewo-1', to: 'hewo-2', kind: 'internal' }));
    apply({ type: 'model_delta', handle: 'hewo-3', conversation: 'c1', call: 'k1', seq: 0, part: 'text', text: 'x' });
    // The message's arc and speech play out.
    for (let t = 0; t < SCENE.arcMs + SCENE.speechMs; t += 16) sim.step(16);
    const snapshot = () => ({
      arcs: arcs(sim),
      speech: sim.drawn().map((r) => r.speech),
      work: handles(sim).map((h) => sim.workBubble(h)),
      robots: handles(sim),
      badge: sim.badge(),
      lamps: handles(sim).map((h) => sim.lamp(h)),
      figure: sim.figure,
      changes: sim.changes,
    });
    const before = snapshot();
    const at = sim.drawn().map((r) => [r.x, r.y]);
    for (let t = 0; t < 60_000; t += 16) sim.step(16);
    expect(snapshot()).toEqual(before);
    expect(before).toMatchObject({
      arcs: [],
      robots: ['hewo-1', 'hewo-2', 'hewo-3', 'hewo-4'],
      badge: 1,
      lamps: ['white', 'white', 'amber', 'white'],
    });
    // The work given to hewo-2 stays: it ends only on an event (R4).
    expect(before.work[1]).not.toBeNull();
    // Idle motion: the robots wandered.
    expect(sim.drawn().map((r) => [r.x, r.y])).not.toEqual(at);
  });
});

describe('bubbleLines (portal-scene-chat R3, A2): the normative table', () => {
  it.each([
    ['Hi', 28, 2, ['Hi']],
    ['  a\n\tb  ', 28, 2, ['a b']],
    ['', 28, 2, []],
    ['   ', 28, 2, []],
    ['Please ask greeter-1 to say Hello World.', 28, 2, ['Please ask greeter-1 to say', 'Hello World.']],
    [
      'one two three four five six seven eight nine ten eleven',
      28,
      2,
      ['one two three four five six', 'seven eight nine ten eleven'],
    ],
    [
      'one two three four five six seven eight nine ten eleven twelve',
      28,
      2,
      ['one two three four five six', 'seven eight nine ten eleven…'],
    ],
    [w(40), 28, 2, [w(28), w(12)]],
    [w(70), 28, 2, [w(28), `${w(27)}…`]],
    ['🙂'.repeat(30), 28, 1, [`${'🙂'.repeat(27)}…`]],
  ] as const)('(%j, %i, %i)', (text, width, maxLines, expected) => {
    expect(bubbleLines(text, width, maxLines)).toEqual(expected);
  });

  it('every line holds at most `width` code points', () => {
    const text = 'a quick brown fox jumps over the lazy dog '.repeat(20) + w(100) + ' 🙂🙂🙂';
    for (const [width, lines] of [
      [28, 2],
      [32, 1],
      [10, 5],
    ] as const) {
      const out = bubbleLines(text, width, lines);
      expect(out).toHaveLength(lines);
      for (const line of out) expect(Array.from(line).length).toBeLessThanOrEqual(width);
    }
  });
});

describe("bubbleLines reads no more of a text than its lines need (the code review's round 4, R4-SECURITY-001)", () => {
  /** R3's rule as it was first written: the whole text split into lines, then the excess cut — the oracle. */
  function reference(text: string, width: number, maxLines: number): string[] {
    const words = text
      .replace(/\s+/gu, ' ')
      .trim()
      .split(' ')
      .filter((x) => x !== '');
    const lines: string[][] = [];
    let line: string[] = [];
    for (const word of words) {
      let rest = Array.from(word);
      const gap = line.length === 0 ? 0 : 1;
      if (line.length + gap + rest.length <= width) {
        if (gap === 1) line.push(' ');
        line.push(...rest);
        continue;
      }
      if (line.length > 0) lines.push(line);
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      line = rest;
    }
    if (line.length > 0) lines.push(line);
    if (lines.length <= maxLines) return lines.map((l) => l.join(''));
    const kept = lines.slice(0, maxLines).map((l) => l.join(''));
    kept[maxLines - 1] = `${Array.from(kept[maxLines - 1] ?? '')
      .slice(0, width - 1)
      .join('')}…`;
    return kept;
  }

  it('lays out 2,000 seeded texts exactly as the rule as first written did', () => {
    const rng = seeded(11);
    const pick = <T>(xs: readonly T[]): T => present(xs[Math.floor(rng() * xs.length)], 'a pick');
    const pieces = ['a', 'bc', 'def', 'ghij', '🙂', 'é', 'longwordlongword', w(30), w(57)];
    const blanks = [' ', '  ', '\n', '\t ', ' \u00a0'];
    for (let i = 0; i < 2_000; i += 1) {
      const text =
        Array.from({ length: Math.floor(rng() * 12) }, () => `${pick(blanks)}${pick(pieces)}`).join('') +
        pick(['', ' ']);
      const width = pick([1, 2, 5, 10, 28, 32]);
      const maxLines = pick([1, 2, 3, 5]);
      expect(bubbleLines(text, width, maxLines), JSON.stringify([text, width, maxLines])).toEqual(
        reference(text, width, maxLines),
      );
    }
  });

  it('lays out a word of 1,000,000 code points as its first lines, 1,000 times well within a second', () => {
    const word = w(1_000_000);
    const started = performance.now();
    for (let i = 0; i < 1_000; i += 1) expect(bubbleLines(word, 28, 2)).toEqual([w(28), `${w(27)}…`]);
    expect(bubbleLines(`${' '.repeat(10)}${word}`, 28, 1)).toEqual([`${w(27)}…`]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('outcomeWords (R5)', () => {
  it('words each outcome of a call', () => {
    expect(outcomeWords({ outcome: 'answered', text: 'merci' })).toBe('merci');
    expect(outcomeWords({ outcome: 'passed', reason: 'busy' })).toBe('passed: busy');
    expect(outcomeWords({ outcome: 'passed', reason: '' })).toBe('passed');
    expect(outcomeWords({ outcome: 'left', detail: 'stopped' })).toBe('left: stopped');
    expect(outcomeWords({ outcome: 'timed_out' })).toBe('timed out');
    expect(outcomeWords({ outcome: 'unanswered' })).toBe('no answer');
  });

  it('an outcome missing what it carries fails loudly (PRINCIPLES §9): never an empty row', () => {
    expect(() => outcomeWords({ outcome: 'answered' })).toThrow('an answered call outcome carries its text');
    expect(() => outcomeWords({ outcome: 'left' })).toThrow('a left call outcome carries');
  });
});

describe('speech (R1, R2, A1, A2)', () => {
  it('a presence status Hi shows Hi; an ok in a conversation shows ok; neither draws an arc; a notice from asha draws nothing', () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'helper-1'] });
    apply(post({ from: 'lead-1', kind: 'status', conversation: null, text: 'Hi' }));
    expect(speech(sim, 'lead-1')).toEqual(['Hi']);
    apply(post({ from: 'helper-1', kind: 'status', text: 'ok' }));
    expect(speech(sim, 'helper-1')).toEqual(['ok']);
    expect(arcs(sim)).toEqual([]);
    const before = sim.drawn().map((r) => r.speech);
    apply(post({ from: 'asha', kind: 'status', conversation: null, text: '⚠ resumed' }));
    expect([sim.drawn().map((r) => r.speech), sim.figure, sim.figureSpeech, arcs(sim)]).toEqual([
      before,
      false,
      null,
      [],
    ]);
  });

  it('an input from alice: the figure stands and says its text; an internal message: its sender says it, for 4,000 ms; a newer one replaces it', () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'greeter-1'] });
    apply(post({ from: 'alice', to: 'lead-1', kind: 'input', text: 'Please ask greeter-1 to say Hello World.' }));
    expect([sim.figure, sim.figureSpeech?.lines]).toEqual([true, ['Please ask greeter-1 to say', 'Hello World.']]);
    apply(post({ from: 'lead-1', to: 'greeter-1', kind: 'internal', text: 'Say: Hello World' }));
    expect(speech(sim, 'lead-1')).toEqual(['Say: Hello World']);
    expect(speech(sim, 'lead-1')).toEqual(bubbleLines('Say: Hello World', 28, 2));
    for (let t = 0; t < 3_984; t += 16) sim.step(16);
    expect(speech(sim, 'lead-1')).toEqual(['Say: Hello World']);
    sim.step(16);
    expect(speech(sim, 'lead-1')).toBeNull();
    apply(post({ from: 'greeter-1', to: 'alice', kind: 'output', text: 'Hello World' }));
    apply(post({ from: 'greeter-1', kind: 'status', text: 'ok' }));
    expect(speech(sim, 'greeter-1')).toEqual(['ok']);
  });

  it('a gather, an approved call result and an output from asha draw no bubble and no arc', () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['lead-1'] });
    apply(
      post({
        from: 'asha',
        to: 'lead-1',
        kind: 'internal',
        text: "Answers to lead-1's call: 0 answered.",
        call: gather('k', [], []),
      }),
    );
    apply(post({ from: 'asha', to: 'lead-1', kind: 'internal', text: 'the result' }));
    apply(post({ from: 'asha', to: 'alice', kind: 'output', text: 'No agent could answer this' }));
    expect([speech(sim, 'lead-1'), sim.figure, sim.figureSpeech, arcs(sim)]).toEqual([null, false, null, []]);
  });
});

describe('work (R4, A3)', () => {
  const team = () => {
    const s = scene();
    s.apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'worker-1', 'worker-2'] });
    return s;
  };

  it('opens on an addressed input, a hand-off and a call question, each with its text', () => {
    const { sim, apply } = team();
    apply(post({ from: 'alice', to: 'lead-1', kind: 'input', text: 'do it' }));
    apply(post({ from: 'lead-1', to: 'worker-1', kind: 'internal', text: 'you do it', conversation: 'c2' }));
    apply(post({ from: 'lead-1', to: 'worker-2', kind: 'internal', text: 'part two', call: question('k') }));
    expect([tasks(sim, 'lead-1'), tasks(sim, 'worker-1'), tasks(sim, 'worker-2')]).toEqual([
      ['do it'],
      ['you do it'],
      ['part two'],
    ]);
    expect(sim.workBubble('worker-2')?.lines).toEqual(['working on: part two']);
  });

  it('opens on ok with the latest message to everyone, never a status, else the unseen task; a second ok and a gather change nothing', () => {
    const { sim, apply } = team();
    apply(post({ from: 'alice', to: null, kind: 'input', text: 'translate good morning' }));
    // A status to everyone is not a task.
    apply(post({ from: 'worker-2', kind: 'status', text: 'pass: not mine' }));
    apply(post({ from: 'worker-1', kind: 'status', text: 'ok' }));
    expect(tasks(sim, 'worker-1')).toEqual(['translate good morning']);
    apply(post({ from: 'worker-1', kind: 'status', text: 'ok' }));
    apply(post({ from: 'asha', to: 'worker-1', kind: 'internal', text: 'Answers', call: gather('k', [], []) }));
    expect(tasks(sim, 'worker-1')).toEqual(['translate good morning']);
    apply(post({ from: 'lead-1', kind: 'status', text: 'ok', conversation: 'c9' }));
    expect(tasks(sim, 'lead-1')).toEqual([UNSEEN_TASK]);
  });

  it("ok skips the agent's own message to everyone and takes the one before it", () => {
    const { sim, apply } = team();
    apply(post({ from: 'alice', to: null, kind: 'input', text: 'first' }));
    apply(post({ from: 'worker-1', to: null, kind: 'internal', text: 'my own' }));
    apply(post({ from: 'worker-1', kind: 'status', text: 'ok' }));
    expect(tasks(sim, 'worker-1')).toEqual(['first']);
  });

  it.each([
    ['its output', post({ from: 'worker-1', to: 'alice', kind: 'output', text: 'done' })],
    ['its hand-off', post({ from: 'worker-1', to: 'worker-2', kind: 'internal', text: 'over to you' })],
    ['its call answer', post({ from: 'worker-1', to: 'lead-1', kind: 'internal', text: '42', call: answer('k') })],
    ['its pass', post({ from: 'worker-1', kind: 'status', text: 'pass' })],
    ['its pass with a reason', post({ from: 'worker-1', kind: 'status', text: 'pass: busy' })],
    ["another sender's output to a user", post({ from: 'lead-1', to: 'alice', kind: 'output', text: 'all done' })],
    [
      "asha's output to a user",
      post({ from: 'asha', to: 'alice', kind: 'output', text: 'No agent could answer this' }),
    ],
  ] as const)('closes on %s', (_name, closing) => {
    const { sim, apply } = team();
    apply(post({ from: 'lead-1', to: 'worker-1', kind: 'internal', text: 'q', call: question('k') }));
    expect(tasks(sim, 'worker-1')).toEqual(['q']);
    apply(closing);
    expect(tasks(sim, 'worker-1')).toEqual([]);
    expect(sim.workBubble('worker-1')).toBeNull();
  });

  it('closes when the agent leaves', () => {
    const { sim, apply } = team();
    apply(post({ from: 'alice', to: 'worker-1', kind: 'input', text: 'q' }));
    apply({ type: 'agent_left', agent: 'worker-1', detail: 'stopped' });
    apply({ type: 'agent_joined', agent: 'worker-1' });
    expect(tasks(sim, 'worker-1')).toEqual([]);
  });

  it("stays open across its own question, an output that asks the user, another conversation's output, and its consult refused", () => {
    const { sim, apply } = team();
    apply(post({ from: 'alice', to: 'lead-1', kind: 'input', text: 'do it' }));
    apply(post({ from: 'lead-1', to: 'worker-1', kind: 'internal', text: 'q', call: question('k') }));
    apply(post({ from: 'worker-2', to: 'alice', kind: 'output', text: 'Which one?', asks: true }));
    apply(post({ from: 'worker-2', to: 'alice', kind: 'output', text: 'elsewhere', conversation: 'c2' }));
    apply(post({ from: 'lead-1', kind: 'status', text: 'consult refused: call_open' }));
    expect(tasks(sim, 'lead-1')).toEqual(['do it']);
  });

  it('two open: the newer is shown with +1 more; on a narrow scene in one line', () => {
    const { sim, apply } = team();
    apply(post({ from: 'alice', to: 'lead-1', kind: 'input', text: 'first job', conversation: 'c1' }));
    apply(post({ from: 'alice', to: 'lead-1', kind: 'input', text: 'second job', conversation: 'c2' }));
    // 30 code points with the suffix: the line is cut as R3 cuts, then the suffix follows.
    expect(sim.workBubble('lead-1')?.lines).toEqual(['working on: second … +1 more']);
    apply(
      post({
        from: 'alice',
        to: 'lead-1',
        kind: 'input',
        text: 'a third job whose text is long enough to wrap',
        conversation: 'c3',
      }),
    );
    expect(sim.workBubble('lead-1')?.lines).toEqual(['working on: a third job', 'whose text is long … +2 more']);
    const narrow = scene(390);
    narrow.apply({ type: 'watching', channel: 'lab', agents: ['lead-1'] });
    narrow.apply(post({ from: 'alice', to: 'lead-1', kind: 'input', text: 'a job with a long description' }));
    expect(narrow.sim.workBubble('lead-1')?.lines).toEqual(['working on: a job with a…']);
  });
});

describe('collecting (R5, A4)', () => {
  const caller = (agents = ['lead-1', 'a-1', 'b-1', 'c-1', 'd-1', 'e-1'], width = 1_280) => {
    const s = scene(width);
    s.apply({ type: 'watching', channel: 'lab', agents });
    s.apply(post({ from: 'alice', to: 'lead-1', kind: 'input', text: 'do three things' }));
    return s;
  };

  it('questions open the card, answers and a pass fill it, and the gather sets every outcome', () => {
    const { sim, apply } = caller();
    for (const to of ['a-1', 'b-1', 'c-1'])
      apply(post({ from: 'lead-1', to, kind: 'internal', text: `q ${to}`, call: question('k') }));
    expect(sim.cardBubble('lead-1')?.lines).toEqual(['collecting 0/3', 'a-1: waiting', 'b-1: waiting', 'c-1: waiting']);
    apply(post({ from: 'b-1', to: 'lead-1', kind: 'internal', text: '42', call: answer('k') }));
    apply(post({ from: 'c-1', kind: 'status', text: 'pass: busy' }));
    expect(sim.cardBubble('lead-1')?.lines).toEqual(['collecting 2/3', 'a-1: waiting', 'b-1: 42', 'c-1: passed: busy']);
    apply(
      post({
        from: 'asha',
        to: 'lead-1',
        kind: 'internal',
        text: 'Answers',
        call: gather(
          'k',
          ['a-1', 'b-1', 'c-1'],
          [
            { from: 'a-1', outcome: 'timed_out' },
            { from: 'b-1', outcome: 'answered', text: '42' },
            { from: 'c-1', outcome: 'passed', reason: 'busy' },
          ],
        ),
      }),
    );
    expect(sim.cardBubble('lead-1')?.lines).toEqual([
      'collected 3/3',
      'a-1: timed out',
      'b-1: 42',
      'c-1: passed: busy',
    ]);
  });

  it('a gather over five outcomes; six addressees draw three rows and +3 more; a narrow scene draws the title only', () => {
    const { sim, apply } = caller();
    apply(
      post({
        from: 'asha',
        to: 'lead-1',
        kind: 'internal',
        text: 'Answers',
        call: gather(
          'k',
          ['a-1', 'b-1', 'c-1', 'd-1', 'e-1'],
          [
            { from: 'a-1', outcome: 'answered', text: 'merci' },
            { from: 'b-1', outcome: 'passed', reason: 'busy' },
            { from: 'c-1', outcome: 'left', detail: 'stopped' },
            { from: 'd-1', outcome: 'timed_out' },
            { from: 'e-1', outcome: 'unanswered' },
          ],
        ),
      }),
    );
    // A gather for questions the page never saw opens the card from its requests.
    expect(sim.cardBubble('lead-1')?.lines).toEqual([
      'collected 5/5',
      'a-1: merci',
      'b-1: passed: busy',
      'c-1: left: stopped',
      '+2 more',
    ]);
    const six = caller(['lead-1', 'a-1', 'b-1', 'c-1', 'd-1', 'e-1', 'f-1']);
    for (const to of ['a-1', 'b-1', 'c-1', 'd-1', 'e-1', 'f-1'])
      six.apply(post({ from: 'lead-1', to, kind: 'internal', text: 'q', call: question('k') }));
    expect(six.sim.cardBubble('lead-1')?.lines).toEqual([
      'collecting 0/6',
      'a-1: waiting',
      'b-1: waiting',
      'c-1: waiting',
      '+3 more',
    ]);
    const narrow = caller(['lead-1', 'a-1'], 348);
    narrow.apply(post({ from: 'lead-1', to: 'a-1', kind: 'internal', text: 'q', call: question('k') }));
    expect(narrow.sim.cardBubble('lead-1')?.lines).toEqual(['collecting 0/1']);
  });

  it('the card closes with the work bubble, on a question of another call, and on leaving', () => {
    const one = caller();
    one.apply(post({ from: 'lead-1', to: 'a-1', kind: 'internal', text: 'q', call: question('k') }));
    one.apply(post({ from: 'lead-1', to: 'alice', kind: 'output', text: 'done' }));
    expect([one.sim.cardBubble('lead-1'), one.sim.workBubble('lead-1')]).toEqual([null, null]);
    const two = caller();
    two.apply(post({ from: 'lead-1', to: 'a-1', kind: 'internal', text: 'q', call: question('k1') }));
    two.apply(post({ from: 'lead-1', to: 'b-1', kind: 'internal', text: 'q', call: question('k2') }));
    expect(two.sim.cardBubble('lead-1')?.lines).toEqual(['collecting 0/1', 'b-1: waiting']);
    two.apply({ type: 'agent_left', agent: 'lead-1', detail: 'stopped' });
    expect(two.sim.cardBubble('lead-1')).toBeNull();
  });

  it("keeps a two-line speech below a card that stands above with no work bubble, so the two never meet (R5b; the code review's R4-DESIGN-002)", () => {
    // A watch begun after the lead took its message: its question opens a card, and it has no work in view.
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'a-1'] });
    apply(
      post({
        from: 'lead-1',
        to: 'a-1',
        kind: 'internal',
        text: 'Please look up the three figures the user asked for and say each',
        call: question('k'),
      }),
    );
    expect([sim.workBubble('lead-1'), sim.cardBubble('lead-1')?.lines]).toEqual([
      null,
      ['collecting 0/1', 'a-1: waiting'],
    ]);
    const lead = present(
      sim.shown().find((r) => r.handle === 'lead-1'),
      'lead-1 shown',
    );
    const boxes = robotBoxes(sim, lead, (text) => 7 * Array.from(text).length);
    const card = present(
      boxes.find((b) => b.kind === 'card'),
      'the card',
    );
    const speech = present(
      boxes.find((b) => b.kind === 'speech'),
      'the speech',
    );
    expect(speech.lines).toHaveLength(2);
    // The stack stands above, and the speech starts a gap below the card's bottom.
    expect(card.y + card.h).toBeLessThan(robotTop(sim, lead.y).antenna);
    expect(speech.y).toBe(card.y + card.h + SCENE.gap);
    expect(intersects(card, speech)).toBe(false);
  });

  it('a question or a gather for an agent that is not online makes no card', () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['a-1'] });
    apply(post({ from: 'gone-1', to: 'a-1', kind: 'internal', text: 'q', call: question('k') }));
    apply(
      post({
        from: 'asha',
        to: 'gone-1',
        kind: 'internal',
        text: 'Answers',
        call: gather('k', ['a-1'], [{ from: 'a-1', outcome: 'answered', text: 'x' }]),
      }),
    );
    expect([sim.cardBubble('gone-1'), sim.cardBubble('a-1')]).toEqual([null, null]);
  });

  it("concluded(): a conversation this page sent settled, every work bubble and card in it ends, another conversation's stays", () => {
    const { sim, apply } = caller();
    apply(post({ from: 'lead-1', to: 'a-1', kind: 'internal', text: 'q', call: question('k') }));
    apply(post({ from: 'alice', to: 'b-1', kind: 'input', text: 'other job', conversation: 'c2' }));
    sim.concluded('c1');
    expect([sim.workBubble('lead-1'), sim.cardBubble('lead-1'), sim.workBubble('a-1'), tasks(sim, 'b-1')]).toEqual([
      null,
      null,
      null,
      ['other job'],
    ]);
  });

  it('an agent behind the badge keeps its work and card and draws neither', () => {
    const agents = ['a-1', 'b-1', 'c-1', 'd-1', 'e-1', 'f-1', 'g-1'];
    const { sim, apply } = scene(1_280);
    apply({ type: 'watching', channel: 'lab', agents });
    apply(post({ from: 'alice', to: 'g-1', kind: 'input', text: 'job' }));
    apply(post({ from: 'g-1', to: 'a-1', kind: 'internal', text: 'q', call: question('k') }));
    expect([tasks(sim, 'g-1'), sim.cardBubble('g-1')?.lines[0]]).toEqual([['job'], 'collecting 0/1']);
    expect(layoutBubbles(sim, (t) => 7 * Array.from(t).length).filter((b) => b.handle === 'g-1')).toEqual([]);
  });
});

/** A caller's open call: its id and each addressee not yet asked, then not yet answered. */
interface OpenConsult {
  id: string;
  unasked: Set<string>;
  unanswered: Set<string>;
  answers: GatherAnswer[];
  requests: string[];
}

const MESSAGE_LINE = /^› (\S+) → (\S+?)(?: on \S+)?: (.*)$/;
const CONSULT_LINE = /^› (\S+) consult: (\{.*\})$/;
const INTERNAL_LINE = /^› internal (\S+) → (\S+): (.*)$/;
const OUTPUT_LINE = /^› output (\S+) → (\S+):$/;
// A status (`› greeter-1: pass: …`); a model's streamed output (`› greeter-1 pass: {`) has no colon after the handle.
const STATUS_LINE = /^› (\S+): (.*)$/;

/**
 * `replayEvents`'s "› internal FROM → TO: TEXT" line: the gather that collects every request's answer (from asha,
 * once every requested agent answered), a question to a just-opened consult's request, an answer to an open
 * question, or an internal message with no call.
 */
function replayInternal(
  events: WatchEvent[],
  open: Map<string, OpenConsult>,
  base: (from: string, to: string | null, kind: ChannelMessage['kind'], text: string) => ChannelMessage,
  from: string,
  to: string,
  text: string,
): void {
  const asking = open.get(from);
  const asked = open.get(to);
  if (from === 'asha' && asked !== undefined) {
    events.push({
      type: 'message',
      message: {
        ...base(from, to, 'internal', text),
        call: {
          id: asked.id,
          role: 'gather',
          context: { from: 'alice', text: '' },
          requests: asked.requests.map((r) => ({ to: r, text: '' })),
          answers: asked.answers,
        },
      } as ChannelMessage,
    });
    open.delete(to);
  } else if (asking?.unasked.has(to)) {
    asking.unasked.delete(to);
    events.push({
      type: 'message',
      message: { ...base(from, to, 'internal', text), call: question(asking.id) } as ChannelMessage,
    });
  } else if (asked?.unanswered.has(from)) {
    asked.unanswered.delete(from);
    asked.answers.push({ from, outcome: 'answered', text });
    events.push({
      type: 'message',
      message: { ...base(from, to, 'internal', text), call: answer(asked.id) } as ChannelMessage,
    });
  } else {
    events.push({ type: 'message', message: base(from, to, 'internal', text) });
  }
}

/** Rebuilds the watch events of a recorded run from its stderr (the CLI's --verbose lines): calls from its consult lines. */
function replayEvents(stderr: string, channel: string): WatchEvent[] {
  const events: WatchEvent[] = [];
  const at = '2026-10-03T00:00:00.000Z';
  let conversation = 'replay';
  let calls = 0;
  const open = new Map<string, OpenConsult>();
  const base = (from: string, to: string | null, kind: ChannelMessage['kind'], text: string): ChannelMessage => ({
    id: `m${String(events.length)}`,
    channel,
    conversation,
    user: 'alice',
    from,
    to,
    kind,
    text,
    at,
  });
  for (const line of stderr.split('\n')) {
    const asMessage = MESSAGE_LINE.exec(line);
    if (asMessage !== null && !line.startsWith('› internal ') && !line.startsWith('› output ')) {
      conversation = `c${String(events.length)}`;
      const to = present(asMessage[2], 'asMessage[2]');
      events.push({
        type: 'message',
        message: base(
          present(asMessage[1], 'asMessage[1]'),
          to === channel ? null : to,
          'input',
          present(asMessage[3], 'asMessage[3]'),
        ),
      });
      continue;
    }
    const asConsult = CONSULT_LINE.exec(line);
    if (asConsult !== null) {
      const requests = (
        JSON.parse(present(asConsult[2], 'asConsult[2]')) as { requests: { to: string }[] }
      ).requests.map((r) => r.to);
      calls += 1;
      open.set(present(asConsult[1], 'asConsult[1]'), {
        id: `k${String(calls)}`,
        unasked: new Set(requests),
        unanswered: new Set(requests),
        answers: [],
        requests,
      });
      continue;
    }
    const asInternal = INTERNAL_LINE.exec(line);
    if (asInternal !== null) {
      replayInternal(
        events,
        open,
        base,
        present(asInternal[1], 'asInternal[1]'),
        present(asInternal[2], 'asInternal[2]'),
        present(asInternal[3], 'asInternal[3]'),
      );
      continue;
    }
    const asOutput = OUTPUT_LINE.exec(line);
    if (asOutput !== null) {
      events.push({
        type: 'message',
        message: base(present(asOutput[1], 'asOutput[1]'), present(asOutput[2], 'asOutput[2]'), 'output', 'the reply'),
      });
      continue;
    }
    const asStatus = STATUS_LINE.exec(line);
    if (asStatus !== null)
      events.push({
        type: 'message',
        message: base(present(asStatus[1], 'asStatus[1]'), null, 'status', present(asStatus[2], 'asStatus[2]')),
      });
  }
  return events;
}

describe('work over recorded runs (R4, A3): no bubble left open, and one on each agent given work', () => {
  it.each([
    [
      'p05-orchestrator-workers',
      'p05-a',
      ['lead-1', 'worker-a-1', 'worker-b-1', 'worker-c-1'],
      ['worker-a-1', 'worker-b-1', 'worker-c-1'],
    ],
    ['p12-self-selection', 'p12-a', ['translator-1', 'greeter-1'], ['translator-1']],
    ['p24-group-chat', 'p24-a', ['manager-1', 'alpha-1', 'beta-1', 'gamma-1'], ['alpha-1', 'beta-1', 'gamma-1']],
  ] as const)('%s %s', (suite, scenario, agents, given) => {
    const results = JSON.parse(
      readFileSync(join(REPO, 'tests', 'fixtures', 'agent-results', `${suite}.json`), 'utf8'),
    ) as {
      commit: string;
      scenarios: { scenario: { id: string }; runs: { args: string[]; stderr: string }[] }[];
    };
    const scenarioRun = present(
      results.scenarios.find((s) => s.scenario.id === scenario),
      `results.scenarios with id ${scenario}`,
    );
    const run = present(
      scenarioRun.runs.find((r) => r.args.some((a) => a.startsWith('message='))),
      `${scenario}'s run with a message= argument`,
    );
    const events = replayEvents(run.stderr, 'main');
    // The replay rebuilt the run's calls: every given agent was asked or took up the message.
    expect(events.length).toBeGreaterThan(3);
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'main', agents: [...agents] });
    const opened = new Set<string>();
    for (const event of events) {
      apply(event);
      for (const agent of agents) if (sim.workOf(agent).length > 0) opened.add(agent);
    }
    for (const agent of given)
      expect(opened, `${agent} had work at some point (${suite} at ${results.commit.slice(0, 7)})`).toContain(agent);
    expect(agents.filter((a) => sim.workOf(a).length > 0 || sim.cardBubble(a) !== null)).toEqual([]);
  });
});

/**
 * `layout`'s P5a check at one (x, heading) of the lead's robot (R5a, R5b): exactly a card, speech and work box, each
 * inside the canvas, no two meeting, and at 694 px the card five lines tall (the plan's extreme).
 */
function checkLeadBoxesAt(
  sim: SceneSim,
  measure: (t: string) => number,
  inside: (b: { x: number; y: number; w: number; h: number }) => boolean,
  width: number,
  x: number,
  heading: -1 | 1,
): void {
  const boxes = layoutBubbles(sim, measure).filter((b) => b.handle === 'lead-1');
  expect(boxes.map((b) => b.kind).sort(byCodeUnit)).toEqual(['card', 'speech', 'work']);
  if (width === 694)
    expect(
      present(
        boxes.find((b) => b.kind === 'card'),
        "boxes.find(kind === 'card')",
      ).lines,
    ).toHaveLength(5);
  for (const box of boxes)
    expect(inside(box), `${box.kind} at x=${String(x)} heading=${String(heading)}: ${JSON.stringify(box)}`).toBe(true);
  // No two boxes of one robot meet (R5b).
  for (const a of boxes)
    for (const b of boxes)
      if (a !== b)
        expect(intersects(a, b), `${a.kind} and ${b.kind} at x=${String(x)} heading=${String(heading)}`).toBe(false);
}

describe('layout (R5a, R5b, R6, A5)', () => {
  it.each([
    [718, 300],
    [333, 300],
    [727, 614],
  ] as const)(
    'at %i × %i, at every height it may stand, the tallest stack stands above the antenna when it fits, else below the label when it fits, else above at the top margin (demo-scene-refresh R4)',
    (width, height) => {
      const { sim, apply } = scene(width, { now: 0 }, height);
      apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'a-1', 'b-1', 'c-1'] });
      apply(
        post({
          from: 'alice',
          to: 'lead-1',
          kind: 'input',
          text: 'a request long enough to fill two lines of the bubble',
        }),
      );
      for (const to of ['a-1', 'b-1', 'c-1', 'd-1', 'e-1'])
        apply(
          post({
            from: 'lead-1',
            to,
            kind: 'internal',
            text: 'a question long enough to wrap twice',
            call: question('k'),
          }),
        );
      const measure = (text: string) => 7 * Array.from(text).length;
      const lead = present(sim.drawn()[0], 'sim.drawn()[0]');
      const { top, bottom } = sim.floor();
      const s = sim.scale();
      const seen = new Set<string>();
      for (let y = top; y <= bottom; y += 4) {
        Object.assign(lead, { x: sim.width / 2, y });
        const stack = robotBoxes(sim, lead, measure).filter((b) => b.kind !== 'speech');
        const highest = Math.min(...stack.map((b) => b.y));
        const lowest = Math.max(...stack.map((b) => b.y + b.h));
        const height = lowest - highest;
        const antenna = robotTop(sim, y).antenna;
        const labelBottom = y + 4 * s - 1 + Math.max(14, 13 * s);
        const fitsAbove = antenna - SCENE.gap - height >= SCENE.margin;
        const fitsBelow = labelBottom + SCENE.gap + height <= sim.height - SCENE.margin;
        if (fitsAbove) {
          expect(lowest, `y ${String(y)}: above`).toBeCloseTo(antenna - SCENE.gap, 6);
          seen.add('above');
        } else if (fitsBelow) {
          expect(highest, `y ${String(y)}: below`).toBeCloseTo(labelBottom + SCENE.gap, 6);
          seen.add('below');
        } else {
          expect(highest, `y ${String(y)}: neither fits`).toBeCloseTo(SCENE.margin, 6);
          seen.add('margin');
        }
      }
      // Each canvas's cases (measured 2026-10-16): only the stacked 718 × 300 floor has a band, feet at y 145–189,
      // where the tallest stack fits neither above nor below; the narrow one's boxes are one line, and the tall frame
      // has room.
      const want: Record<string, readonly string[]> = {
        '718 × 300': ['above', 'below', 'margin'],
        '333 × 300': ['above', 'below'],
        '727 × 614': ['above', 'below'],
      };
      expect([...seen].sort(byCodeUnit)).toEqual(want[`${String(width)} × ${String(height)}`]);
    },
  );

  const measure = (t: string): number => 7 * Array.from(t).length;
  const inside = (sim: SceneSim) => (b: { x: number; y: number; w: number; h: number }) =>
    b.x >= SCENE.margin &&
    b.y >= SCENE.margin &&
    b.x + b.w <= sim.width - SCENE.margin &&
    b.y + b.h <= sim.height - SCENE.margin;

  it.each([
    [694, 420],
    [348, 300],
  ] as const)(
    "at %i × %i, every box lies inside the canvas with a robot at the floor's top and at each side",
    (width, height) => {
      const { sim, apply } = scene(width, { now: 0 }, height);
      apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'a-1', 'b-1', 'c-1'] });
      apply(
        post({
          from: 'alice',
          to: 'lead-1',
          kind: 'input',
          text: 'a request long enough to fill two lines of the bubble',
        }),
      );
      // Five addressees: the card at its tallest, the title, three rows and +2 more (the plan's extreme).
      for (const to of ['a-1', 'b-1', 'c-1', 'd-1', 'e-1'])
        apply(
          post({
            from: 'lead-1',
            to,
            kind: 'internal',
            text: 'a question long enough to wrap twice',
            call: question('k'),
          }),
        );
      const robot = present(sim.drawn()[0], 'sim.drawn()[0]');
      const { top, bottom } = sim.floor();
      for (const x of [0, sim.width / 2, sim.width]) {
        for (const heading of [-1, 1] as const) {
          robot.x = x;
          robot.y = top;
          robot.heading = heading;
          checkLeadBoxesAt(sim, measure, inside(sim), width, x, heading);
        }
      }
      // At the floor's top the tallest stack cannot stand above the antenna: it stands below the name label, never
      // meeting the robot's body or label (demo-scene-refresh R4); at the floor's bottom it stands above the antenna.
      const stack = () => layoutBubbles(sim, measure).filter((b) => b.handle === 'lead-1' && b.kind !== 'speech');
      robot.x = sim.width / 2;
      robot.y = top;
      const s = sim.scale();
      const labelBottom = top + 4 * s - 1 + Math.max(14, 13 * s);
      expect(Math.min(...stack().map((b) => b.y))).toBeGreaterThanOrEqual(labelBottom + SCENE.gap - 0.001);
      robot.y = bottom;
      expect(Math.max(...stack().map((b) => b.y + b.h))).toBeLessThanOrEqual(
        robotTop(sim, bottom).antenna - SCENE.gap + 0.001,
      );
    },
  );

  it.each([
    [694, 420],
    [348, 300],
  ] as const)(
    'P5 at %i × %i: the lead, its card and three workers each working and speaking — no two boxes meet (R5b)',
    (width, height) => {
      const { sim, apply } = scene(width, { now: 0 }, height);
      apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'worker-a-1', 'worker-b-1', 'worker-c-1'] });
      apply(
        post({
          from: 'alice',
          to: 'lead-1',
          kind: 'input',
          text: "Please do three things: translate 'thank you' into French, add 17 and 25, and say Hello World.",
        }),
      );
      const asks = {
        'worker-a-1': "Translate 'thank you' into French.",
        'worker-b-1': 'Add 17 and 25.',
        'worker-c-1': 'Say: Hello World.',
      };
      for (const [to, text] of Object.entries(asks))
        apply(post({ from: 'lead-1', to, kind: 'internal', text, call: question('k') }));
      apply(post({ from: 'worker-b-1', to: 'lead-1', kind: 'internal', text: '42', call: answer('k') }));
      // The robots where place() put them, idle motion not yet run: the closest they stand.
      const boxes = layoutBubbles(sim, measure);
      expect(
        boxes
          .filter((b) => b.kind === 'work')
          .map((b) => b.handle)
          .sort(byCodeUnit),
      ).toEqual(['lead-1', 'worker-a-1', 'worker-c-1']);
      for (const a of boxes)
        for (const b of boxes)
          if (a !== b) expect(intersects(a, b), `${a.handle} ${a.kind} and ${b.handle} ${b.kind}`).toBe(false);
      for (const box of boxes) expect(inside(sim)(box), `${box.handle} ${box.kind}`).toBe(true);
    },
  );

  it('boxes come in the order they last changed; the newest is drawn last', () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply(post({ from: 'alice', to: 'b-1', kind: 'input', text: 'first', conversation: 'c1' }));
    apply(post({ from: 'alice', to: 'a-1', kind: 'input', text: 'second', conversation: 'c2' }));
    const boxes = layoutBubbles(sim, measure);
    // b-1's work is older than a-1's though b-1 is drawn after it; boxes changed by one event keep the robots' order.
    expect(boxes.map((b) => `${b.handle} ${b.kind} ${b.lines.join('|')}`)).toEqual([
      'b-1 work working on: first',
      'a-1 work working on: second',
      'users speech second',
    ]);
  });

  it('settle ends arcs and speech only: work bubbles and cards stay (reduced motion)', () => {
    const { sim, apply } = scene();
    apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'a-1'] });
    apply(post({ from: 'alice', to: 'lead-1', kind: 'input', text: 'job' }));
    sim.settle();
    apply(post({ from: 'lead-1', to: 'a-1', kind: 'internal', text: 'q', call: question('k') }));
    expect(layoutBubbles(sim, measure).map((b) => `${b.handle} ${b.kind}`)).toEqual([
      'lead-1 work',
      'lead-1 card',
      'lead-1 speech',
      'a-1 work',
    ]);
    sim.settle();
    expect(layoutBubbles(sim, measure).map((b) => `${b.handle} ${b.kind}`)).toEqual([
      'lead-1 work',
      'lead-1 card',
      'a-1 work',
    ]);
    expect(arcs(sim)).toEqual([]);
  });
});

/** Every 3 s (R5c), each robot says something long enough to wrap, giving its space a speech bubble on the side it
 * faces: a target's space is weighed facing the way the robot will walk to it. */
function speakEveryThreeSeconds(apply: (event: WatchEvent) => void, t: number): void {
  if (t % 3_000 !== 0) return;
  for (const h of ['a-1', 'b-1'])
    apply(post({ from: h, kind: 'status', conversation: null, text: `${h} says something long enough for two lines` }));
}

/**
 * One step's retargeted robots (R5c): each whose wander target changed since `before`, checked that where it chose
 * to go (facing the way it will walk there) meets no other robot's space; returns how many retargeted.
 */
function checkRetargets(
  sim: SceneSim,
  measure: (t: string) => number,
  before: Map<string, { x: number; y: number }>,
  t: number,
): number {
  const spaces = sim.spaces();
  let retargets = 0;
  for (const r of sim.drawn()) {
    const was = present(before.get(r.handle), `before.get(${r.handle})`);
    if (was.x === r.target.x && was.y === r.target.y) continue;
    retargets += 1;
    // Where it chose to go, as it chose (facing the way it will walk): no other robot's space there, less the
    // ground the others covered in this step.
    const there = personalSpace(
      sim,
      { ...r, x: r.target.x, y: r.target.y, heading: r.target.x < r.x ? -1 : 1 },
      measure,
    );
    const shrunk = { x: there.x + 1, y: there.y + 1, w: there.w - 2, h: there.h - 2 };
    for (const o of spaces)
      if (o.handle !== r.handle)
        expect(intersects(shrunk, o.space), `${r.handle}'s target at ${String(t)} ms meets ${o.handle}`).toBe(false);
  }
  return retargets;
}

// Its seeded crowds step minutes of the scene: 0.6–1.7 s each alone here, up to 5.1 s on GitHub's runner under the
// whole unit run (2026-10-18), past vitest's 5 s default once. The bound is a guard, set well above the slowest run
// (PRINCIPLES §14.5); the assertions are unchanged.
describe('personal space (portal-scene-chat R5c, A21)', { timeout: 20_000 }, () => {
  const measure = (t: string): number => 7 * Array.from(t).length;
  /** Each pair of drawn robots whose spaces meet, as `a~b`. */
  const meeting = (sim: SceneSim): string[] => {
    const spaces = sim.spaces();
    const out: string[] = [];
    for (let i = 0; i < spaces.length; i += 1)
      for (let j = i + 1; j < spaces.length; j += 1) {
        const a = present(spaces[i], 'spaces[i]');
        const b = present(spaces[j], 'spaces[j]');
        if (intersects(a.space, b.space)) out.push(`${a.handle}~${b.handle}`);
      }
    return out;
  };
  const within = (inner: Rect, outer: Rect, margin: number): boolean =>
    inner.x - outer.x >= margin - 1e-9 &&
    inner.y - outer.y >= margin - 1e-9 &&
    outer.x + outer.w - (inner.x + inner.w) >= margin - 1e-9 &&
    outer.y + outer.h - (inner.y + inner.h) >= margin - 1e-9;
  /** The P5 run's opening: the lead given the request, and its three questions, so every robot has a box over its head. */
  const p5 = (apply: (event: WatchEvent) => void): void => {
    apply(
      post({
        from: 'alice',
        to: 'lead-1',
        kind: 'input',
        text: "Please do three things: translate 'thank you' into French, add 17 and 25, and say Hello World.",
      }),
    );
    const asks = {
      'worker-a-1': "Translate 'thank you' into French.",
      'worker-b-1': 'Add 17 and 25.',
      'worker-c-1': 'Say: Hello World.',
    };
    for (const [to, text] of Object.entries(asks))
      apply(post({ from: 'lead-1', to, kind: 'internal', text, call: question('k') }));
  };
  const P5_AGENTS = ['lead-1', 'worker-a-1', 'worker-b-1', 'worker-c-1'];

  it("a robot's space covers its body with its antenna's bob, its name label and its own boxes, SCENE.space beyond the furthest", () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['lead-1', 'a-1'] });
    apply(
      post({
        from: 'alice',
        to: 'lead-1',
        kind: 'input',
        text: 'a request long enough to fill two lines of the bubble',
      }),
    );
    apply(
      post({
        from: 'lead-1',
        to: 'a-1',
        kind: 'internal',
        text: 'a question long enough to wrap twice',
        call: question('k'),
      }),
    );
    const lead = present(sim.drawn()[0], 'sim.drawn()[0]');
    const { space } = present(sim.spaces()[0], 'sim.spaces()[0]');
    const own = robotBoxes(sim, lead, measure);
    expect(own.map((b) => b.kind)).toEqual(['work', 'card', 'speech']);
    const s = sim.scale();
    const label = labelBox(lead.x, lead.y + 4 * s, s, 'lead-1', measure);
    for (const part of [...own, label]) expect(within(part, space, SCENE.space), JSON.stringify(part)).toBe(true);
    // The antenna's lamp at the top of its bob (1.6 × scale), and the arms raised (17 × scale each side).
    expect(space.y).toBeLessThanOrEqual(robotTop(sim, lead.y).antenna - 1.6 * s - SCENE.space);
    expect(space.x).toBeLessThanOrEqual(lead.x - 17 * s - SCENE.space);
    expect(space.x + space.w).toBeGreaterThanOrEqual(lead.x + 17 * s + SCENE.space);
    // SCENE.space beyond the furthest part, exactly, on the sides the boxes and the label reach.
    const parts = [...own, label];
    expect(Math.min(...parts.map((p) => p.x)) - space.x).toBeCloseTo(SCENE.space, 9);
    expect(space.y + space.h - Math.max(...parts.map((p) => p.y + p.h))).toBeCloseTo(SCENE.space, 9);
    // The same as the exported function gives, so the scene and its tests share one geometry.
    expect(personalSpace(sim, lead, measure)).toEqual(space);
  });

  it("an idle robot's space is exactly its body with the antenna's bob and its arms, and its name label, with SCENE.space beyond", () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['hewo-1'] });
    const r = present(sim.drawn()[0], 'sim.drawn()[0]');
    const s = sim.scale();
    const { antenna } = robotTop(sim, r.y);
    const label = labelBox(r.x, r.y + 4 * s, s, 'hewo-1', measure);
    // The body: 19 × scale each side (the arms raised, with their round caps), from 4 × scale above the lamp's top (its
    // bob) to the treads; the label below it.
    const left = Math.min(r.x - 19 * s, label.x) - SCENE.space;
    const right = Math.max(r.x + 19 * s, label.x + label.w) + SCENE.space;
    const top = antenna - 4 * s - SCENE.space;
    const bottom = Math.max(r.y, label.y + label.h) + SCENE.space;
    const { space } = present(sim.spaces()[0], 'sim.spaces()[0]');
    expect(space.x).toBeCloseTo(left, 9);
    expect(space.x + space.w).toBeCloseTo(right, 9);
    expect(space.y).toBeCloseTo(top, 9);
    expect(space.y + space.h).toBeCloseTo(bottom, 9);
  });

  it('idle robots, with no boxes, that stand on one spot move apart within 3 s', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1', 'c-1'] });
    const mid = { x: 300, y: sim.height / 2 };
    for (const r of sim.drawn()) Object.assign(r, { x: mid.x, y: mid.y, target: { ...mid } });
    expect(meeting(sim)).toEqual(['a-1~b-1', 'a-1~c-1', 'b-1~c-1']);
    let t = 0;
    while (meeting(sim).length > 0) {
      expect(t, `still meeting ${meeting(sim).join(', ')}`).toBeLessThanOrEqual(3_000);
      sim.step(16);
      t += 16;
    }
  });

  it('two robots whose spaces meet move apart, each at most SCENE.apartSpeed a second, until they do not; then they stay apart', () => {
    const { sim, apply } = scene(1_000, { now: 0 }, 560);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply(
      post({
        from: 'alice',
        to: 'a-1',
        kind: 'input',
        text: 'the first job, long enough for two lines',
        conversation: 'c1',
      }),
    );
    apply(
      post({
        from: 'alice',
        to: 'b-1',
        kind: 'input',
        text: 'the second job, long enough for two lines',
        conversation: 'c2',
      }),
    );
    const [a, b] = sim.drawn() as [SceneRobot, SceneRobot];
    const mid = { x: 400, y: sim.height / 2 };
    for (const r of [a, b]) Object.assign(r, { x: mid.x, y: mid.y, target: { ...mid } });
    expect(meeting(sim)).toEqual(['a-1~b-1']);
    const most = (SCENE.apartSpeed * sim.unit * 16) / 1_000;
    let t = 0;
    while (meeting(sim).length > 0) {
      const before = [a.x, a.y, b.x, b.y] as const;
      sim.step(16);
      t += 16;
      expect(Math.hypot(a.x - before[0], a.y - before[1])).toBeLessThanOrEqual(most + 1e-9);
      expect(Math.hypot(b.x - before[2], b.y - before[3])).toBeLessThanOrEqual(most + 1e-9);
      expect(t, 'apart within 3 s').toBeLessThanOrEqual(3_000);
    }
    // On one spot their spaces overlap less in depth than sideways: the one joined first went back.
    expect(a.y).toBeLessThan(b.y);
    expect(a.x).toBe(b.x);
    for (let k = 0; k < 30_000; k += 16) {
      sim.step(16);
      expect(meeting(sim), `at ${String(k)} ms after`).toEqual([]);
    }
  });

  it('a robot never walks into a space it does not meet, and a new wander target is a free place when one exists', () => {
    // Two robots on a wide floor: a free place is always among the floor points tried.
    const { sim, apply } = scene(1_000, { now: 0 }, 560);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    ['a-1', 'b-1'].forEach((to, i) => {
      apply(
        post({
          from: 'alice',
          to,
          kind: 'input',
          text: `job ${String(i)}, long enough to fill two lines`,
          conversation: `c${String(i)}`,
        }),
      );
    });
    let settleT = 0;
    while (meeting(sim).length > 0) {
      expect(settleT, 'apart within 12 s').toBeLessThanOrEqual(12_000);
      sim.step(16);
      settleT += 16;
    }
    let retargets = 0;
    for (let t = 0; t < 60_000; t += 16) {
      // Each robot speaks every 3 s, so its space holds a speech bubble on the side it faces: a target's space is
      // weighed facing the way the robot will walk to it.
      speakEveryThreeSeconds(apply, t);
      const before = new Map(sim.drawn().map((r) => [r.handle, { ...r.target }]));
      sim.step(16);
      expect(meeting(sim), `at ${String(t)} ms`).toEqual([]);
      retargets += checkRetargets(sim, measure, before, t);
    }
    expect(retargets).toBeGreaterThanOrEqual(5);
  });

  /** A lead and `n - 1` workers wander close with no boxes, then each is given work at once (the lead a card too). */
  const crowd = (width: number, height: number, seed: number, n: number) => {
    const { sim, apply } = scene(width, { now: 0 }, height, seed);
    const workers = ['worker-a-1', 'worker-b-1', 'worker-c-1', 'worker-d-1', 'worker-e-1'].slice(0, n - 1);
    apply({ type: 'watching', channel: 'lab', agents: ['lead-1', ...workers] });
    for (let t = 0; t < 10_000 + seed * 517; t += 16) sim.step(16);
    if (n === 4) p5(apply);
    else {
      apply(
        post({
          from: 'alice',
          to: 'lead-1',
          kind: 'input',
          text: "Please do three things: translate 'thank you' into French, add 17 and 25, and say Hello World.",
        }),
      );
      for (const to of workers)
        apply(
          post({
            from: 'lead-1',
            to,
            kind: 'internal',
            text: `A question for ${to}, long enough to wrap.`,
            call: question('k'),
          }),
        );
    }
    return sim;
  };
  /** Steps until no spaces meet, failing past `bound` ms; then `stay` ms more in which none may meet. */
  const apartWithin = (sim: SceneSim, bound: number, stay: number, what: string): void => {
    let t = 0;
    while (meeting(sim).length > 0) {
      sim.step(16);
      t += 16;
      if (t > bound) expect.fail(`${what}: still meeting after ${String(bound)} ms: ${meeting(sim).join(', ')}`);
    }
    for (let k = 0; k < stay; k += 16) {
      sim.step(16);
      if (meeting(sim).length > 0) expect.fail(`${what}, ${String(k)} ms after: ${meeting(sim).join(', ')}`);
    }
  };
  // The page's own canvases, as portal-chat.test.ts's A21 case reads them: beside the chat (R5a: 420 px tall) at a
  // window of 1280 px or more, 1000 and 900 px; and the demo videos' frame. Each floor holds every space.
  const ROOMY = [
    [727, 614],
    [694, 420],
    [550, 420],
    [490, 420],
  ] as const;

  it.each(ROOMY)(
    'P5 at %i × %i: four robots given their boxes while standing close separate within 12 s, in 20 seeded runs, and stay apart',
    (width, height) => {
      for (let seed = 1; seed <= 20; seed += 1)
        apartWithin(crowd(width, height, seed, 4), 12_000, 30_000, `seed ${String(seed)}`);
    },
  );

  it.each(ROOMY)(
    'at %i × %i: six robots given their boxes while standing close separate within 60 s, in 10 seeded runs, and stay apart',
    (width, height) => {
      for (let seed = 1; seed <= 10; seed += 1)
        apartWithin(crowd(width, height, seed, 6), 60_000, 30_000, `seed ${String(seed)}`);
    },
  );

  // Floors that do not hold every space: the narrowest canvas beside the chat (an 800 px window), the widest and narrowest
  // stacked ones (R5a: 300 px tall; 760 and 375 px windows), and six robots at an 1100 px window's 610 px and stacked.
  it.each([
    [430, 420, 4],
    [718, 300, 4],
    [333, 300, 4],
    [610, 420, 6],
    [718, 300, 6],
  ] as const)(
    'a floor too small for every space (%i × %i, %i robots): from 30 s after the boxes came, no robot moves faster than it wanders (R5c (e))',
    (width, height, n) => {
      for (let seed = 1; seed <= 5; seed += 1) {
        const sim = crowd(width, height, seed, n);
        const wander = (SCENE.wanderSpeed * sim.unit * 16) / 1_000 + 1e-9;
        let met = 0;
        for (let t = 0; t < 60_000; t += 16) {
          const before = sim.drawn().map((r) => [r.x, r.y] as const);
          sim.step(16);
          if (meeting(sim).length > 0) met += 1;
          for (const r of sim.drawn())
            expect(r.walkOuts, `seed ${String(seed)}: ${r.handle}'s walk-outs`).toBeLessThanOrEqual(SCENE.walkOuts);
          if (t < 30_000) continue;
          sim.drawn().forEach((r, i) => {
            const was = present(before[i], 'before[i]');
            const d = Math.hypot(r.x - was[0], r.y - was[1]);
            if (d > wander)
              expect.fail(
                `seed ${String(seed)}, ${String(t)} ms: ${r.handle} moved ${d.toFixed(2)} px in 16 ms (wander ${wander.toFixed(2)})`,
              );
          });
        }
        // The floor is too small: spaces still meet (R5b keeps the boxes apart where the canvas has room).
        expect(met, `seed ${String(seed)}`).toBeGreaterThan(0);
      }
    },
  );

  it('a robot held on every side walks out to a free place, through spaces on its way (R5c (d))', () => {
    // A canvas 300 px tall (R5a's stacked layout): on the flat floor of a 420 px one there is room on every axis
    // (demo-scene-refresh, 2026-10-16), so the hold is found on a shorter floor.
    const { sim, apply } = scene(560, { now: 0 }, 300, 1);
    apply({ type: 'watching', channel: 'lab', agents: P5_AGENTS });
    p5(apply);
    // worker-a-1 between the lead on its left, worker-c-1 above at the floor's top and worker-b-1 below at its bottom,
    // the floor's right edge beyond: pushed apart pair by pair, it has room on no axis (searched for, 2026-10-16).
    const f = sim.floor();
    const at: Record<string, [number, number]> = {
      'lead-1': [f.left, f.top + 100],
      'worker-a-1': [f.right, f.top + 100],
      'worker-b-1': [f.right, f.bottom],
      'worker-c-1': [f.right - 40, f.top],
    };
    for (const r of sim.drawn()) {
      const [x, y] = present(at[r.handle], `at[${r.handle}]`);
      Object.assign(r, { x, y, target: { x, y }, rest: 60_000 });
    }
    expect(meeting(sim)).toEqual(['worker-a-1~worker-b-1', 'worker-a-1~worker-c-1']);
    let escaped: string | undefined;
    let t = 0;
    while (meeting(sim).length > 0) {
      sim.step(16);
      t += 16;
      escaped ??= sim.drawn().find((r) => r.escaping)?.handle;
      expect(t, `still meeting ${meeting(sim).join(', ')}`).toBeLessThanOrEqual(12_000);
    }
    expect(escaped).toBeDefined();
    expect(t).toBeGreaterThanOrEqual(SCENE.crowdedMs);
    // The episode ended: every robot's clock and walk-outs start again, so a later crowding may walk out again.
    sim.step(16);
    expect(sim.drawn().map((r) => [r.crowded, r.walkOuts, r.escaping])).toEqual(P5_AGENTS.map(() => [0, 0, false]));
  });

  it("a new floor size starts every robot's personal space afresh: no walk-out, rest or episode carried over", () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    for (const r of sim.drawn()) Object.assign(r, { escaping: true, walkOuts: 2, crowded: 1_500, rest: 300 });
    sim.layout(560, 420);
    expect(sim.drawn().map((r) => [r.escaping, r.walkOuts, r.crowded, r.rest])).toEqual([
      [false, 0, 0, 0],
      [false, 0, 0, 0],
    ]);
  });
});

describe('a failure in the scene (docs/plans/demo-scene-refresh.md R8, A4)', () => {
  /** An agent's presence status, the harness's failure status when `failure`. */
  const presence = (from: string, text: string, failure = false): WatchEvent => ({
    type: 'message',
    message: {
      id: 'p',
      channel: 'lab',
      from,
      to: null,
      kind: 'status',
      text,
      at: '2026-10-16T12:00:00.000Z',
      conversation: null,
      ...(failure ? { failure: true as const } : {}),
    },
  });
  const failure = (from: string): WatchEvent => presence(from, AGENT_FAILURE_STATUS, true);
  const at = (sim: SceneSim, handle: string): string => {
    const r = present(
      sim.shown().find((x) => x.handle === handle),
      `${handle} shown`,
    );
    return `${r.x.toFixed(3)},${r.y.toFixed(3)}`;
  };

  it('its failure status marks the robot, which stands still; a later message of its own clears the mark', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply(failure('a-1'));
    expect(sim.failed()).toEqual(['a-1']);
    expect(speech(sim, 'a-1')).toEqual([AGENT_FAILURE_STATUS]);
    const still = at(sim, 'a-1');
    const b = at(sim, 'b-1');
    for (let i = 0; i < 300; i += 1) sim.step(20);
    expect(at(sim, 'a-1')).toBe(still);
    expect(at(sim, 'b-1')).not.toBe(b);
    apply(presence('a-1', 'Hi'));
    expect(sim.failed()).toEqual([]);
    for (let i = 0; i < 300; i += 1) sim.step(20);
    expect(at(sim, 'a-1')).not.toBe(still);
  });

  it('a marked robot keeps its place when another joins: the floor is spread again around it (R1-DESIGN-004)', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply(failure('a-1'));
    // Off the grid place() spreads the floor in, so a re-spread would show.
    Object.assign(present(sim.drawn()[0], 'a-1'), { x: 301, y: 251 });
    const still = at(sim, 'a-1');
    apply({ type: 'agent_joined', agent: 'c-1' });
    expect(at(sim, 'a-1')).toBe(still);
    apply({ type: 'agent_left', agent: 'b-1', detail: 'stopped' });
    expect(at(sim, 'a-1')).toBe(still);
  });

  it('a canvas whose floor has no width or height stands its robots at finite places, never NaN (R1-DESIGN-005)', () => {
    for (const [width, height] of [
      [150, 300],
      [694, 60],
      [120, 50],
    ] as const) {
      const { sim, apply } = scene(width, { now: 0 }, height);
      apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1', 'c-1', 'd-1'] });
      for (const r of sim.drawn())
        expect([r.x, r.y].every(Number.isFinite), `${String(width)} × ${String(height)}`).toBe(true);
    }
  });

  it('a marked robot is not pushed: a robot standing on it walks out of its space alone', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply(failure('a-1'));
    const a = present(sim.drawn()[0], 'a-1');
    const b = present(sim.drawn()[1], 'b-1');
    // Mid-floor, where a push either way has room.
    Object.assign(a, { x: 300, y: 250, target: { x: 300, y: 250 } });
    Object.assign(b, { x: 304, y: 250, target: { x: 304, y: 250 } });
    const still = at(sim, 'a-1');
    for (let i = 0; i < 50; i += 1) sim.step(20);
    expect(at(sim, 'a-1')).toBe(still);
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(4);
  });

  it('a marked robot that leaves stays, marked, for 2,000 ms of scene time — not online, holding no space — then goes', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply(failure('a-1'));
    apply({ type: 'agent_left', agent: 'a-1', detail: 'restart limit reached' });
    expect(sim.online()).toEqual(['b-1']);
    expect(handles(sim)).toEqual(['b-1']);
    expect(sim.spaces().map((s) => s.handle)).toEqual(['b-1']);
    expect(sim.gone().map((r) => r.handle)).toEqual(['a-1']);
    expect(sim.shown().map((r) => r.handle)).toEqual(['b-1', 'a-1']);
    expect(sim.failed()).toEqual(['a-1']);
    expect(
      layoutBubbles(sim, (t) => 7 * t.length)
        .filter((b) => b.handle === 'a-1')
        .map((b) => b.kind),
    ).toEqual(['speech']);
    sim.step(SCENE.goneMs - 1);
    expect(sim.gone().map((r) => r.handle)).toEqual(['a-1']);
    sim.step(1);
    expect(sim.gone()).toEqual([]);
    expect(sim.failed()).toEqual([]);
  });

  it("a gone robot's speech ages with the scene: it fades in and ends as any other", () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply(failure('a-1'));
    apply({ type: 'agent_left', agent: 'a-1', detail: 'restart limit reached' });
    const gone = present(sim.gone()[0], 'a-1 gone');
    sim.step(100);
    expect(present(gone.speech, "a-1's speech").age).toBe(100);
    sim.step(SCENE.goneMs - 100);
    expect(sim.gone()).toEqual([]);
  });

  it('a gone robot keeps its place on a resized floor, scaled with it and held to its bounds (R8)', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1', 'c-1'] });
    for (const h of ['a-1', 'b-1']) {
      apply(failure(h));
      apply({ type: 'agent_left', agent: h, detail: 'restart limit reached' });
    }
    const [a, b] = sim.gone();
    Object.assign(present(a, 'a-1 gone'), { x: 300, y: 250 });
    Object.assign(present(b, 'b-1 gone'), { x: 680, y: 410 });
    sim.layout(500, 420);
    // At 500 wide the unit is 1.1: the floor's right bound is the dock's 434 less 77, its bottom 420 less 30.8.
    expect(sim.gone().map((r) => [r.handle, r.x, r.y])).toEqual([
      ['a-1', 300 * (500 / 694), 250],
      ['b-1', 357, 389.2],
    ]);
  });

  it('a resize that holds fewer robots ends their arcs at the badge, so every arc ends at something drawn', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1', 'c-1', 'd-1', 'e-1', 'f-1'] });
    expect(sim.capacity()).toBe(6);
    apply(post({ from: 'a-1', to: 'f-1', kind: 'internal', text: 'over to you' }));
    sim.layout(650, 420);
    expect(sim.capacity()).toBe(5);
    const drawn = new Set(handles(sim));
    expect(sim.arcs.map((a) => [end(a.from), end(a.to)])).toEqual([['a-1', 'badge']]);
    for (const a of sim.arcs)
      for (const e of [a.from, a.to]) if (e.kind === 'robot') expect(drawn.has(e.handle), e.handle).toBe(true);
  });

  it('an unmarked robot that leaves goes at once', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply({ type: 'agent_left', agent: 'a-1', detail: 'channel stream closed' });
    expect(sim.shown().map((r) => r.handle)).toEqual(['b-1']);
  });

  it('a still scene (reduced motion) keeps a gone robot until the next event; its join ends its stay and clears its mark', () => {
    const { sim, apply } = scene(694, { now: 0 }, 420);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1'] });
    apply(failure('a-1'));
    apply({ type: 'agent_left', agent: 'a-1', detail: 'restart limit reached' });
    sim.settle();
    expect(sim.gone()).toEqual([]);
    apply(failure('b-1'));
    apply({ type: 'agent_left', agent: 'b-1', detail: 'restart limit reached' });
    apply({ type: 'agent_joined', agent: 'b-1' });
    expect(sim.gone()).toEqual([]);
    expect(sim.shown().map((r) => r.handle)).toEqual(['b-1']);
    expect(sim.failed()).toEqual([]);
  });

  it('a robot behind the +n badge shows nothing when it fails and leaves', () => {
    const { sim, apply } = scene(348, { now: 0 }, 300);
    apply({ type: 'watching', channel: 'lab', agents: ['a-1', 'b-1', 'c-1', 'd-1', 'e-1'] });
    expect(sim.badge()).toBe(1);
    apply(failure('e-1'));
    expect(sim.failed()).toEqual([]);
    apply({ type: 'agent_left', agent: 'e-1', detail: 'restart limit reached' });
    expect(sim.gone()).toEqual([]);
  });
});
