// Draws the scene (scene-sim.ts) on the watch view's canvas (docs/plans/portal.md R9; docs/plans/portal-scene-chat.md
// R1–R6, R5b). Adapted from the SimplyAutonomous.AI website's renderer (its `site/robots.js`, by the same holder under
// the same licences): one flat floor over the whole canvas (its backdrop and perspective gone,
// docs/plans/demo-scene-refresh.md R1), the dashed dock, and each robot — rounded body, visor with
// two eyes that blink and follow the pointer, treads, arms and an antenna lamp — now labelled with its agent's handle,
// with the boxes layoutBubbles places: what each sender said, each agent's work, each call's card. Every text is drawn
// with fillText, never as markup (portal R13). Colours come from portal.css's custom properties.

import { present } from '../shared/assert-present.js';
import {
  SCENE,
  labelFont,
  layoutBubbles,
  robotTop,
  type Endpoint,
  type SceneBox,
  type SceneRobot,
  type SceneSim,
} from './scene-sim.js';

interface Colours {
  readonly floor: string;
  readonly shells: readonly [string, string, string];
  readonly visor: string;
  readonly eyes: string;
  readonly tread: string;
  readonly signal: string;
  readonly shadow: string;
  readonly amber: string;
  readonly ink: string;
  readonly card: string;
  readonly failure: string;
}

/** Draws a SceneSim on its canvas, one frame a call, its colours read from portal.css's custom properties. */
export class SceneRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly colours: Colours;
  private pointer: { x: number; y: number } | null = null;
  private frames = 0;
  private readonly now: () => number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sim: SceneSim,
    win: Window,
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('the canvas has no 2D context');
    this.ctx = ctx;
    this.now = () => win.performance.now();
    const css = win.getComputedStyle(win.document.documentElement);
    const token = (name: string): string => {
      const value = css.getPropertyValue(name).trim();
      if (value === '') throw new Error(`portal.css defines no colour ${name}`);
      return value;
    };
    this.colours = {
      floor: token('--scene-floor'),
      shells: [token('--scene-shell'), token('--scene-shell-2'), token('--scene-shell-3')],
      visor: token('--scene-visor'),
      eyes: token('--scene-eyes'),
      tread: token('--scene-tread'),
      signal: token('--scene-signal'),
      shadow: token('--scene-shadow'),
      amber: token('--scene-amber'),
      ink: token('--ink'),
      card: token('--scene-card'),
      failure: token('--scene-failure'),
    };
    canvas.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.offsetX, y: e.offsetY };
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
    });
  }

  /** Sizes the canvas's backing store to its CSS size and the device's pixel ratio; returns the CSS size. */
  size(devicePixelRatio: number): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: rect.width, height: rect.height };
  }

  /** Draws one frame; `animate` false draws a still frame (reduced motion): no bob, no blink. */
  draw(animate: boolean): void {
    const { ctx, sim } = this;
    ctx.clearRect(0, 0, sim.width, sim.height);
    this.floor();
    this.dock();
    const robots = sim.shown().sort((a, b) => a.y - b.y);
    for (const robot of robots) this.robot(robot, animate);
    if (sim.badge() > 0) this.badge(sim.badge());
    this.arcs();
    ctx.font = SCENE.font;
    const boxes = layoutBubbles(sim, (text) => ctx.measureText(text).width);
    for (const box of boxes) this.box(box);
    // What this frame shows, for the page's tests (portal A10; portal-scene-chat A5, A6): counts, handles and each
    // box's lines, as attributes set with setAttribute — text, never markup.
    this.canvas.setAttribute(
      'data-bubbles',
      JSON.stringify(boxes.map((b) => ({ handle: b.handle, kind: b.kind, lines: b.lines }))),
    );
    // Each drawn robot's personal space (portal-scene-chat R5c), whole CSS px, for the page's tests.
    this.canvas.setAttribute(
      'data-spaces',
      JSON.stringify(
        sim.spaces().map(({ handle, space }) => ({
          handle,
          x: Math.round(space.x),
          y: Math.round(space.y),
          w: Math.round(space.w),
          h: Math.round(space.h),
        })),
      ),
    );
    this.frames += 1;
    this.canvas.setAttribute('data-frames', String(this.frames));
    this.canvas.setAttribute('data-arcs', String(sim.arcs.length));
    this.canvas.setAttribute(
      'data-robots',
      sim
        .drawn()
        .map((r) => r.handle)
        .join(' '),
    );
    this.canvas.setAttribute('data-badge', String(sim.badge()));
    // The robots marked with a red ✕ (docs/plans/demo-scene-refresh.md R8), drawn or gone.
    this.canvas.setAttribute('data-failed', sim.failed().join(' '));
    this.canvas.setAttribute(
      'data-lamps',
      sim
        .drawn()
        .map((r) => sim.lamp(r.handle))
        .join(' '),
    );
    this.canvas.setAttribute('data-drawn-at', String(this.now()));
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    this.ctx.beginPath();
    this.ctx.roundRect(x, y, w, h, r);
  }

  /** The floor: the whole canvas, one colour (demo-scene-refresh R1). */
  private floor(): void {
    const { ctx, sim, colours: C } = this;
    ctx.fillStyle = C.floor;
    ctx.fillRect(0, 0, sim.width, sim.height);
  }

  private shadow(x: number, y: number, s: number): void {
    const { ctx } = this;
    ctx.fillStyle = this.colours.shadow;
    ctx.beginPath();
    ctx.ellipse(x, y, 13 * s, 4 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The dock, dashed, where the users' figure stands once a user has posted. */
  private dock(): void {
    const { ctx, sim, colours: C } = this;
    const { dock } = sim;
    const s = this.sim.scale();
    ctx.strokeStyle = C.amber;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([5 * s, 4 * s]);
    ctx.lineWidth = 1.5;
    this.roundRect(dock.x - 30 * s, dock.y - 12 * s, 60 * s, 30 * s, 4 * s);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (!sim.figure) return;
    // The users: one figure, a head and shoulders.
    const x = dock.x;
    const base = dock.y + 6 * s;
    this.shadow(x, base, s * 0.8);
    ctx.fillStyle = C.signal;
    this.roundRect(x - 10 * s, base - 22 * s, 20 * s, 22 * s, 9 * s);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, base - 29 * s, 7 * s, 0, Math.PI * 2);
    ctx.fill();
    this.label(x, base + 12 * s, s, 'users');
  }

  private badge(n: number): void {
    const { ctx, sim, colours: C } = this;
    const at = sim.badgeAt();
    const s = sim.unit;
    ctx.fillStyle = C.visor;
    this.roundRect(at.x - 18 * s, at.y - 11 * s, 36 * s, 22 * s, 11 * s);
    ctx.fill();
    ctx.fillStyle = C.eyes;
    ctx.font = `700 ${String(12 * s)}px ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${String(n)}`, at.x, at.y + 0.5);
  }

  private label(x: number, y: number, s: number, text: string): void {
    const { ctx } = this;
    ctx.font = labelFont(s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    this.roundRect(x - w / 2, y - 1, w, Math.max(14, 13 * s), 4);
    ctx.fill();
    ctx.fillStyle = this.colours.ink;
    ctx.fillText(text, x, y + 1);
  }

  /** The speech bubble a speech box draws (R5b): the figure's, the badge's, or a shown robot's (drawn, or gone, R8); `null` for none. */
  private speechOf(box: SceneBox): SceneSim['figureSpeech'] {
    if (box.kind !== 'speech') return null;
    if (box.handle === 'users') return this.sim.figureSpeech;
    if (box.handle === 'badge') return this.sim.badgeSpeech;
    return this.sim.shown().find((r) => r.handle === box.handle)?.speech ?? null;
  }

  /** A box line's fill colour: a card's first line signals, a work box's first line is amber, else the eye colour. */
  private lineColour(card: boolean, kind: SceneBox['kind'], i: number): string {
    const { colours: C } = this;
    if (card) return i === 0 ? C.signal : C.ink;
    if (kind === 'work' && i === 0) return C.amber;
    return C.eyes;
  }

  /**
   * One box of layoutBubbles (R5b): speech dark with light text, fading in over its first 120 ms; a work bubble dark
   * with an amber edge; a card light with dark text and a signal edge. Each line is drawn with fillText.
   */
  private box(box: SceneBox): void {
    const { ctx, colours: C } = this;
    const speech = this.speechOf(box);
    ctx.globalAlpha = speech === null ? 1 : Math.min(1, (speech.age + 1) / 120);
    const card = box.kind === 'card';
    ctx.fillStyle = card ? C.card : C.visor;
    ctx.strokeStyle = box.kind === 'work' ? C.amber : C.signal;
    ctx.lineWidth = box.kind === 'speech' ? 1 : 1.5;
    this.roundRect(box.x, box.y, box.w, box.h, 7);
    ctx.fill();
    ctx.stroke();
    ctx.font = SCENE.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    box.lines.forEach((line, i) => {
      ctx.fillStyle = this.lineColour(card, box.kind, i);
      ctx.fillText(line, box.x + SCENE.padding, box.y + SCENE.padding + i * SCENE.lineHeight + 1);
    });
    ctx.globalAlpha = 1;
  }

  private robot(robot: SceneRobot, animate: boolean): void {
    const { ctx, sim, colours: C } = this;
    const s = this.sim.scale();
    const t = sim.time / 1_000;
    const bob = animate ? Math.abs(Math.sin(t * 6 + robot.phase)) * 1.6 * s : 0;
    const x = robot.x;
    const base = robot.y;
    const shell = present(C.shells[robot.shell % 3], 'C.shells[robot.shell % 3]');
    this.shadow(x, base, s);
    // Treads.
    ctx.fillStyle = C.tread;
    this.roundRect(x - 11 * s, base - 7 * s, 22 * s, 7 * s, 3.5 * s);
    ctx.fill();
    // Body.
    const top = robotTop(sim, base).top - bob;
    ctx.fillStyle = shell;
    this.roundRect(x - 13 * s, top, 26 * s, 30 * s, 8 * s);
    ctx.fill();
    // Arms: raised while its model is working.
    const working = sim.lamp(robot.handle) === 'amber';
    ctx.strokeStyle = shell;
    ctx.lineWidth = 3 * s;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + side * 12 * s, top + 16 * s);
      ctx.lineTo(x + side * 17 * s, working ? top - 2 * s : top + 24 * s);
      ctx.stroke();
    }
    // Visor and eyes, which look at the pointer when it is near, else ahead.
    ctx.fillStyle = C.visor;
    this.roundRect(x - 9.5 * s, top + 5 * s, 19 * s, 12 * s, 5 * s);
    ctx.fill();
    let lookX = robot.heading * 1.8 * s;
    let lookY = 0;
    const p = this.pointer;
    if (p !== null && Math.hypot(p.x - x, p.y - top) < 260) {
      const a = Math.atan2(p.y - top, p.x - x);
      lookX = Math.cos(a) * 2.4 * s;
      lookY = Math.sin(a) * 1.6 * s;
    }
    const blink = animate && (t + robot.phase) % 4.2 < 0.12;
    ctx.fillStyle = C.eyes;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(
        x + side * 4.2 * s + lookX,
        top + 11 * s + lookY,
        2.2 * s,
        blink ? 0.4 * s : 2.4 * s,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    // Antenna lamp: amber while one of its model calls is streaming, white otherwise.
    ctx.strokeStyle = shell;
    ctx.lineWidth = 1.6 * s;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top - 7 * s);
    ctx.stroke();
    ctx.fillStyle = working ? C.amber : C.eyes;
    ctx.beginPath();
    ctx.arc(x, top - 8.5 * s, 2.6 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.tread;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    if (robot.failed) this.failureMark(x, top, s);
    this.label(x, base + 4 * s, s, robot.handle);
  }

  /** R8: a red ✕ across a failed robot's body and visor, from its antenna's foot to its treads. */
  private failureMark(x: number, top: number, s: number): void {
    const { ctx } = this;
    ctx.strokeStyle = this.colours.failure;
    ctx.lineWidth = 4 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 15 * s, top - 2 * s);
    ctx.lineTo(x + 15 * s, top + 32 * s);
    ctx.moveTo(x + 15 * s, top - 2 * s);
    ctx.lineTo(x - 15 * s, top + 32 * s);
    ctx.stroke();
  }

  private at(end: Endpoint): { x: number; y: number } {
    const { sim } = this;
    if (end.kind === 'figure') return { x: sim.dock.x, y: sim.dock.y - 34 * this.sim.scale() };
    if (end.kind === 'badge') return sim.badgeAt();
    const robot = sim.drawn().find((r) => r.handle === end.handle);
    if (robot === undefined) throw new Error(`an arc ends at ${end.handle}, which is not drawn`);
    return { x: robot.x, y: robot.y - 50 * this.sim.scale() };
  }

  /** Each message's arcs, dotted, a dot travelling from sender to addressee. */
  private arcs(): void {
    const { ctx, sim, colours: C } = this;
    ctx.strokeStyle = C.signal;
    ctx.lineWidth = 1.5;
    for (const arc of sim.arcs) {
      const a = this.at(arc.from);
      const b = this.at(arc.to);
      const lift = Math.min(a.y, b.y) - 40 * sim.unit;
      const cx = (a.x + b.x) / 2;
      ctx.globalAlpha = Math.min(1, (arc.age + 1) / 100);
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, lift, b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const u = Math.min(1, arc.age / 900);
      const px = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * cx + u * u * b.x;
      const py = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * lift + u * u * b.y;
      ctx.fillStyle = C.signal;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
