// The scene's renderer (src/portal/scene-draw.ts; docs/plans/portal-scene-chat.md R1–R6, demo-scene-refresh R1, R3,
// R8), against a recording canvas context (tests/helpers/fake-canvas.ts) and a SceneSim in a known state: the colours
// it reads and the one it lacks, the backing store's size, the floor as one fill of the whole canvas, each robot at one
// scale with its label, the red ✕ on a failed robot alone, the users' figure, the badge, an arc, a box's colours, the
// eyes that follow the pointer, the bob and blink of an animated frame, and the attributes each frame sets.

import { describe, expect, it } from 'vitest';

import { SceneRenderer } from '../../src/portal/scene-draw.js';
import { SCENE, SceneSim, labelFont, robotTop } from '../../src/portal/scene-sim.js';
import { present } from '../../src/shared/assert-present.js';
import { observeWatchEvent } from '../../src/shared/lines.js';
import { AGENT_FAILURE_STATUS, type ChannelMessage, type WatchEvent } from '../../src/shared/protocol.js';
import { FakeCanvas, fakeWindow, recordingContext, type DrawCall } from '../helpers/fake-canvas.js';

/** portal.css's scene colours, each a distinct name, so a call's colour says which token it is. */
const TOKENS = {
  '--scene-floor': 'floor',
  '--scene-shell': 'shell-1',
  '--scene-shell-2': 'shell-2',
  '--scene-shell-3': 'shell-3',
  '--scene-visor': 'visor',
  '--scene-eyes': 'eyes',
  '--scene-tread': 'tread',
  '--scene-signal': 'signal',
  '--scene-shadow': 'shadow',
  '--scene-amber': 'amber',
  '--ink': 'ink',
  '--scene-card': 'card',
  '--scene-failure': 'failure',
} as const;

/** A scene of `agents`, 694 × 420 CSS px, its renderer on a recording canvas, and a way to apply watch events. */
function rendered(agents: readonly string[] = ['a-1', 'b-1']) {
  const clock = { now: 0 };
  const sim = new SceneSim({
    width: 694,
    height: 420,
    rng: () => 0.5,
    now: () => clock.now,
    measure: (text) => 7 * Array.from(text).length,
  });
  const { ctx, calls } = recordingContext();
  const canvas = new FakeCanvas(ctx, { width: 694, height: 420 });
  const renderer = new SceneRenderer(canvas.asCanvas(), sim, fakeWindow(clock, TOKENS));
  const apply = (event: WatchEvent): void => {
    observeWatchEvent(event, sim);
  };
  apply({ type: 'watching', channel: 'lab', agents });
  /** The calls of one frame, drawn now. */
  const frame = (animate = false): DrawCall[] => {
    calls.length = 0;
    renderer.draw(animate);
    return [...calls];
  };
  return { sim, clock, canvas, renderer, apply, frame };
}

const message = (over: Partial<ChannelMessage> & Pick<ChannelMessage, 'from' | 'kind'>): WatchEvent => ({
  type: 'message',
  message: {
    id: 'm',
    channel: 'lab',
    conversation: 'c1',
    user: 'user',
    to: null,
    text: 't',
    at: '2026-10-16T12:00:00.000Z',
    ...over,
  } as ChannelMessage,
});

const failure = (from: string): WatchEvent => ({
  type: 'message',
  message: {
    id: 'p',
    channel: 'lab',
    from,
    to: null,
    kind: 'status',
    text: AGENT_FAILURE_STATUS,
    at: '2026-10-16T12:00:00.000Z',
    conversation: null,
    failure: true,
  },
});

/** Each index of `calls` where property `name` is set to `value`. */
const setsAt = (calls: readonly DrawCall[], name: string, value: unknown): number[] =>
  calls.flatMap((c, i) => (c[0] === '=' && c[1] === name && c[2] === value ? [i] : []));

describe('the scene renderer (portal-scene-chat R1–R6; demo-scene-refresh R1, R3, R8)', () => {
  it('reads every colour from portal.css, and names the one it lacks; a canvas with no 2D context is refused', () => {
    const sim = new SceneSim({ width: 10, height: 10, rng: () => 0, now: () => 0, measure: () => 0 });
    const { ctx } = recordingContext();
    const lacking = Object.fromEntries(Object.entries(TOKENS).filter(([name]) => name !== '--scene-failure'));
    expect(
      () =>
        new SceneRenderer(
          new FakeCanvas(ctx, { width: 1, height: 1 }).asCanvas(),
          sim,
          fakeWindow({ now: 0 }, lacking),
        ),
    ).toThrow('portal.css defines no colour --scene-failure');
    expect(
      () =>
        new SceneRenderer(
          new FakeCanvas(null, { width: 1, height: 1 }).asCanvas(),
          sim,
          fakeWindow({ now: 0 }, TOKENS),
        ),
    ).toThrow('the canvas has no 2D context');
  });

  it("sizes the backing store to the CSS size at the device's pixel ratio, at most 2, and 1 when it has none", () => {
    const { canvas, renderer } = rendered();
    expect(renderer.size(3)).toEqual({ width: 694, height: 420 });
    expect([canvas.width, canvas.height]).toEqual([1_388, 840]);
    expect(renderer.size(1.5)).toEqual({ width: 694, height: 420 });
    expect([canvas.width, canvas.height]).toEqual([1_041, 630]);
    renderer.size(0);
    expect([canvas.width, canvas.height]).toEqual([694, 420]);
  });

  it('clears, then fills the whole canvas with the floor colour, before anything else is drawn (R1)', () => {
    const { frame } = rendered([]);
    expect(frame().slice(0, 4)).toEqual([
      ['clearRect', 0, 0, 694, 420],
      ['=', 'fillStyle', 'floor'],
      ['fillRect', 0, 0, 694, 420],
      ['=', 'strokeStyle', 'amber'],
    ]);
  });

  it("sets each frame's attributes: frames, robots, lamps, arcs, badge, failed, bubbles, spaces and the time drawn", () => {
    const { canvas, clock, frame, sim } = rendered();
    clock.now = 1_234.5;
    frame();
    frame();
    expect({
      frames: canvas.getAttribute('data-frames'),
      robots: canvas.getAttribute('data-robots'),
      lamps: canvas.getAttribute('data-lamps'),
      arcs: canvas.getAttribute('data-arcs'),
      badge: canvas.getAttribute('data-badge'),
      failed: canvas.getAttribute('data-failed'),
      bubbles: canvas.getAttribute('data-bubbles'),
      at: canvas.getAttribute('data-drawn-at'),
    }).toEqual({
      frames: '2',
      robots: 'a-1 b-1',
      lamps: 'white white',
      arcs: '0',
      badge: '0',
      failed: '',
      bubbles: '[]',
      at: '1234.5',
    });
    expect(JSON.parse(present(canvas.getAttribute('data-spaces'), 'data-spaces'))).toEqual(
      sim.spaces().map(({ handle, space }) => ({
        handle,
        x: Math.round(space.x),
        y: Math.round(space.y),
        w: Math.round(space.w),
        h: Math.round(space.h),
      })),
    );
  });

  it('draws every robot at the one scale, labelled with its handle under its treads (R3)', () => {
    const { frame, sim } = rendered();
    const calls = frame();
    const s = sim.scale();
    for (const robot of sim.drawn()) {
      const top = robotTop(sim, robot.y).top;
      // Its body: 26 × 30 at the scale, from its top.
      expect(calls).toContainEqual(['roundRect', robot.x - 13 * s, top, 26 * s, 30 * s, 8 * s]);
      expect(calls).toContainEqual(['fillText', robot.handle, robot.x, robot.y + 4 * s + 1]);
    }
    expect(setsAt(calls, 'font', labelFont(s))).toHaveLength(2);
  });

  it('crosses a failed robot with a red ✕ from its antenna to its treads, and no other (R8)', () => {
    const { apply, canvas, frame, sim } = rendered();
    apply(failure('a-1'));
    const calls = frame();
    const s = sim.scale();
    const a = present(
      sim.drawn().find((r) => r.handle === 'a-1'),
      'a-1 drawn',
    );
    const top = robotTop(sim, a.y).top;
    const marks = setsAt(calls, 'strokeStyle', 'failure');
    expect(marks).toHaveLength(1);
    const at = present(marks[0], 'the mark');
    expect(calls.slice(at, at + 8)).toEqual([
      ['=', 'strokeStyle', 'failure'],
      ['=', 'lineWidth', 4 * s],
      ['=', 'lineCap', 'round'],
      ['beginPath'],
      ['moveTo', a.x - 15 * s, top - 2 * s],
      ['lineTo', a.x + 15 * s, top + 32 * s],
      ['moveTo', a.x + 15 * s, top - 2 * s],
      ['lineTo', a.x - 15 * s, top + 32 * s],
    ]);
    expect(calls[at + 8]).toEqual(['stroke']);
    expect(canvas.getAttribute('data-failed')).toBe('a-1');
  });

  it("draws the users' figure at the dock, labelled, once a user has posted, and an arc from it to the agent", () => {
    const { apply, canvas, frame, sim } = rendered();
    expect(frame().filter((c) => c[0] === 'fillText' && c[1] === 'users')).toEqual([]);
    apply(message({ from: 'user', kind: 'input', to: 'a-1', text: 'Please say hi.' }));
    const calls = frame();
    const s = sim.scale();
    expect(calls).toContainEqual(['arc', sim.dock.x, sim.dock.y + 6 * s - 29 * s, 7 * s, 0, Math.PI * 2]);
    expect(calls).toContainEqual(['fillText', 'users', sim.dock.x, sim.dock.y + 6 * s + 12 * s + 1]);
    expect(canvas.getAttribute('data-arcs')).toBe('1');
    expect(calls.filter((c) => c[0] === 'quadraticCurveTo')).toHaveLength(1);
  });

  it('draws the badge with the count of agents not drawn, when there are more than the floor holds', () => {
    const many = Array.from({ length: 30 }, (_, i) => `a-${String(i + 1)}`);
    const { canvas, frame, sim } = rendered(many);
    const calls = frame();
    const hidden = sim.badge();
    expect(hidden).toBeGreaterThan(0);
    expect(calls).toContainEqual(['fillText', `+${String(hidden)}`, sim.badgeAt().x, sim.badgeAt().y + 0.5]);
    expect(canvas.getAttribute('data-badge')).toBe(String(hidden));
  });

  it("draws an agent's speech dark with light text, fading in, and its lines by fillText at the box's padding (R5b)", () => {
    const { apply, canvas, frame } = rendered();
    apply(message({ from: 'a-1', kind: 'output', to: 'user', text: 'Hello World.' }));
    const calls = frame();
    const [box] = JSON.parse(present(canvas.getAttribute('data-bubbles'), 'bubbles')) as {
      handle: string;
      kind: string;
      lines: string[];
    }[];
    expect(box).toEqual({ handle: 'a-1', kind: 'speech', lines: ['Hello World.'] });
    const text = calls.findIndex((c) => c[0] === 'fillText' && c[1] === 'Hello World.');
    expect(calls[text - 1]).toEqual(['=', 'fillStyle', 'eyes']);
    // Faded in by its age: 0 ms old, 1/120 of the way.
    expect(
      calls
        .slice(0, text)
        .filter((c) => c[0] === '=' && c[1] === 'globalAlpha')
        .at(-1),
    ).toEqual(['=', 'globalAlpha', 1 / 120]);
    expect(setsAt(calls, 'font', SCENE.font).length).toBeGreaterThan(0);
  });

  it('turns the eyes to a pointer within 260 px, and ahead again when it leaves', () => {
    const { canvas, frame, sim } = rendered(['a-1']);
    const eyes = (calls: readonly DrawCall[]): unknown[] => calls.filter((c) => c[0] === 'ellipse').slice(1, 3);
    const ahead = eyes(frame());
    const robot = present(sim.drawn()[0], 'a-1');
    canvas.dispatch('pointermove', { offsetX: robot.x + 100, offsetY: robot.y });
    const looking = eyes(frame());
    expect(looking).not.toEqual(ahead);
    canvas.dispatch('pointerleave');
    expect(eyes(frame())).toEqual(ahead);
    canvas.dispatch('pointermove', { offsetX: robot.x + 1_000, offsetY: robot.y });
    expect(eyes(frame())).toEqual(ahead);
  });

  it('bobs and blinks only in an animated frame; a still one is the same at any time', () => {
    const { clock, frame, sim } = rendered(['a-1']);
    const still = frame(false);
    for (let i = 0; i < 20; i += 1) sim.step(20);
    clock.now = 400;
    const robot = present(sim.drawn()[0], 'a-1');
    const s = sim.scale();
    const t = sim.time / 1_000;
    const bob = Math.abs(Math.sin(t * 6 + robot.phase)) * 1.6 * s;
    expect(bob).toBeGreaterThan(0);
    const top = robotTop(sim, robot.y).top;
    expect(frame(true)).toContainEqual(['roundRect', robot.x - 13 * s, top - bob, 26 * s, 30 * s, 8 * s]);
    expect(frame(false)).toContainEqual(['roundRect', robot.x - 13 * s, top, 26 * s, 30 * s, 8 * s]);
    expect(still.length).toBeGreaterThan(0);
  });
});
