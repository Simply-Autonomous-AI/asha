// The channel as a scene (docs/plans/portal.md R9; docs/plans/portal-scene-chat.md R1–R6, R5b, R5c): a pure simulation with
// no access to the page, unit-tested on its own; scene-draw.ts draws it. Adapted from the robot crew of the
// SimplyAutonomous.AI website (its `site/sim.js`, by the same holder under the same licences), whose floor, dock,
// wandering and bubbles it keeps — its backdrop and perspective gone since docs/plans/demo-scene-refresh.md, the whole
// canvas one flat floor. What it draws comes only from the channel: a robot per agent online, in join order — as many
// as the floor's area holds at SCENE.cellArea a robot (`capacity`), and a "+n" badge for the rest — and, for 2 s, a robot
// that left after its failure, crossed (R8) — one shared figure on the
// dock for every user who posts, a dotted arc for each message from its sender to each addressee, a speech bubble on
// the sender holding what it said, a work bubble over each agent with work open, a card over each agent collecting a
// call's answers, and each robot's antenna lamp amber while one of its model calls is streaming. No arc, bubble, robot,
// badge or lamp changes without a watch event or a telemetry answer; only idle motion (wandering, blinking, the eyes
// following the pointer) and a crossed robot's going 2 s after its leave run on their own. Each drawn robot keeps a personal space — its body, its name label and its own
// boxes — that no other robot walks into, and robots whose spaces meet move apart (R5c).

import {
  HARNESS_HANDLE,
  type CallMark,
  type ChannelMessage,
  type ConversationMessage,
  type GatherAnswer,
  type ModelDeltaEvent,
  type ModelDoneEvent,
  type TelemetryResponse,
} from '../shared/protocol.js';
import type { WatchObserver } from '../shared/lines.js';
import { present } from '../shared/assert-present.js';

/** The scene's fixed numbers (docs/plans/portal-scene-chat.md, demo-scene-refresh.md): its sizes, times and rates. */
export const SCENE = Object.freeze({
  /**
   * How many robots are drawn (docs/plans/demo-scene-refresh.md R5): the floor where a robot's feet may stand, divided
   * by this area per robot, in CSS px² at unit scale — the smallest that never draws more robots than settle apart, each
   * working (a two-line work bubble, the lead a card), at every canvas the plan's probe measured
   * (evals/probes/demo-scene-refresh-2026-10-16) — and never fewer than `minRobots`.
   */
  cellArea: 21_200,
  minRobots: 4,
  /** A scene narrower than this, in CSS px, shows one line of a work bubble and a card's title alone. */
  narrowBelow: 600,
  /** How long an arc plays, in ms. */
  arcMs: 1_600,
  /** How long a robot that left after its failure stays drawn, marked, in ms of scene time (demo-scene-refresh R8). */
  goneMs: 2_000,
  /** How long a speech bubble shows, in ms of scene time (portal-scene-chat R2). */
  speechMs: 4_000,
  /** A speech bubble's layout (R2): code points per line, and lines. */
  speechWidth: 28,
  speechLines: 2,
  /** A card's rows (R5): code points per row, and rows drawn before `+m more`. */
  cardWidth: 32,
  cardRows: 3,
  /** The boxes' font, line height, padding, gap between boxes and margin inside the canvas, in CSS px (R5b). */
  font: '600 12px ui-rounded, system-ui, sans-serif',
  lineHeight: 15,
  padding: 6,
  gap: 4,
  margin: 4,
  /** Idle wandering, in px/s at unit scale (the web site's wanderSpeed). */
  wanderSpeed: 34,
  reach: 8,
  /**
   * Personal space (R5c): the margin around what a robot covers, in CSS px; how fast two robots whose spaces meet move
   * apart, in px/s at unit scale; how long a robot stands before turning away from a space it would walk into, in ms;
   * how many floor points a new wander target is chosen from; and how long a robot's space may meet another's before it
   * walks out to a free place, once in each episode of meeting, in ms.
   */
  space: 6,
  apartSpeed: 90,
  restMs: 500,
  targetTries: 48,
  crowdedMs: 2_000,
  walkOuts: 3,
});

/** The status an agent posts as it acts in a conversation (`WORKING_STATUS` in the SDK): R4 (b)'s trigger. */
const WORKING = 'ok';

/** The task of work opened by an `ok` when the watch never saw the message it took up (R4). */
export const UNSEEN_TASK = '(not seen: the watch began later)';

/** Where an arc starts or ends: a drawn robot, the users' figure, or the badge standing for agents not drawn. */
export type Endpoint =
  { readonly kind: 'robot'; readonly handle: string } | { readonly kind: 'figure' } | { readonly kind: 'badge' };

/** A message in flight between two endpoints of the scene, drawn as an arc while it is young. */
export interface SceneArc {
  readonly from: Endpoint;
  readonly to: Endpoint;
  /** ms since it began. */
  age: number;
}

/** What a sender said, laid out (R2), its age in ms, and when it last changed (the order boxes are drawn in). */
export interface Speech {
  readonly lines: readonly string[];
  age: number;
  readonly changed: number;
}

/** One agent's robot: where it stands and faces, where it walks, its speech, its work and its space on the floor. */
export interface SceneRobot {
  readonly handle: string;
  x: number;
  y: number;
  heading: -1 | 1;
  target: { x: number; y: number };
  readonly phase: number;
  readonly shell: number;
  speech: Speech | null;
  /** ms left standing before it chooses a new target, after a step that would have entered another's space (R5c). */
  rest: number;
  /** ms its space has met another drawn robot's without a break: the episode's length so far (R5c). */
  crowded: number;
  /** Walking out of a crowd to a free place (R5c (d)): faster, and through spaces on the way. */
  escaping: boolean;
  /** How many times it has walked out in this episode; at SCENE.walkOuts it gives up until the episode ends (R5c (e)). */
  walkOuts: number;
  /**
   * Marked with a red ✕ since its failure status, until a later message of its own or its join clears it; it stands
   * still meanwhile (docs/plans/demo-scene-refresh.md R8).
   */
  failed: boolean;
}

/** A rectangle in CSS px. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One box a frame draws (R5b): whose, which kind, where, its lines, and when it last changed. */
export interface SceneBox {
  readonly handle: string;
  readonly kind: 'speech' | 'work' | 'card';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly lines: readonly string[];
  readonly changed: number;
}

/** An agent's lamp inputs (R9): its calls streaming now, its last model_done, and the latest telemetry's word. */
interface LampState {
  readonly open: Set<string>;
  lastDone: number;
  /** When the latest telemetry answer reporting a call in flight reached the page; null when the latest reported none. */
  inFlightAt: number | null;
}

/** Work an agent has open in a conversation (R4). */
interface Work {
  readonly conversation: string;
  readonly task: string;
  readonly changed: number;
}

/** A call an agent is collecting the outcomes of (R5). */
interface Card {
  readonly call: string;
  readonly conversation: string;
  readonly rows: { readonly handle: string; outcome: string | null }[];
  gathered: boolean;
  changed: number;
}

/** What a scene is made with: its size, its idle motion's randomness, the page's clock and how its text is measured. */
export interface SceneSimProps {
  readonly width: number;
  readonly height: number;
  /** For idle motion only (where a robot wanders): Math.random on the page, seeded in tests. */
  readonly rng: () => number;
  /** The page's clock, in ms: when an event or a telemetry answer reached the page. */
  readonly now: () => number;
  /**
   * A text's width in CSS px in `font`, for what a robot's personal space covers (R5c): the page measures with a canvas
   * of its own; tests use a fixed width per code point.
   */
  readonly measure: (text: string, font: string) => number;
}

/** A text's code points. */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * R3: `text` laid out in at most `maxLines` lines of at most `width` code points — whitespace collapsed and trimmed,
 * words filled greedily, a word longer than `width` split into pieces of `width`, and, when text remains after the
 * last line, that line cut to its first `width - 1` code points and `…`. An empty text gives no lines. It reads the
 * text a piece of at most `width` code points at a time and stops at the line after the last it may show, so a text
 * of any length costs no more than its first lines (an agent's text reaches here verbatim, on every frame that draws
 * its work: the code review's round 4, R4-SECURITY-001).
 */
export function bubbleLines(text: string, width: number, maxLines: number): string[] {
  const read = wordReader(text, width);
  const lines: string[][] = [];
  let line: string[] = [];
  let at = read.skip(0);
  while (at < text.length && lines.length <= maxLines) {
    const word = read.piece(at);
    at = word.end;
    const gap = line.length === 0 ? 0 : 1;
    if (!word.more && line.length + gap + word.cps.length <= width) {
      line = gap === 1 ? [...line, ' ', ...word.cps] : [...line, ...word.cps];
    } else {
      if (line.length > 0) lines.push(line);
      ({ line, at } = longWord(read, word, lines, maxLines));
    }
    at = read.skip(at);
  }
  if (line.length > 0) lines.push(line);
  return cutLines(lines, width, maxLines);
}

type WordReader = ReturnType<typeof wordReader>;
type WordPiece = ReturnType<WordReader['piece']>;

/**
 * A word that does not fit where it is, from its first piece `word`: each full piece of it a line of `lines`, until
 * they are more than `maxLines`; its last piece the line to fill, and where the text goes on.
 */
function longWord(
  read: WordReader,
  word: WordPiece,
  lines: string[][],
  maxLines: number,
): { readonly line: string[]; readonly at: number } {
  let piece = word;
  while (piece.more && lines.length <= maxLines) {
    lines.push(piece.cps);
    piece = read.piece(piece.end);
  }
  return { line: piece.cps, at: piece.end };
}

/** bubbleLines' reader of `text`: past its blanks, and its next word's next piece of at most `width` code points. */
function wordReader(
  text: string,
  width: number,
): {
  readonly skip: (at: number) => number;
  readonly piece: (at: number) => { readonly cps: string[]; readonly end: number; readonly more: boolean };
} {
  const blank = /\s*/uy;
  const piece = new RegExp(`\\S{1,${String(width)}}`, 'uy');
  return {
    skip: (at) => {
      blank.lastIndex = at;
      blank.exec(text);
      return blank.lastIndex;
    },
    piece: (at) => {
      piece.lastIndex = at;
      const cps = codePoints(present(piece.exec(text)?.[0], 'a word at a non-blank'));
      const end = piece.lastIndex;
      return { cps, end, more: end < text.length && !/\s/u.test(text.charAt(end)) };
    },
  };
}

/** R3's lines as shown: all of them when they fit in `maxLines`, else the first `maxLines`, the last cut and `…`. */
function cutLines(lines: readonly (readonly string[])[], width: number, maxLines: number): string[] {
  if (lines.length <= maxLines) return lines.map((l) => l.join(''));
  const kept = lines.slice(0, maxLines).map((l) => l.join(''));
  const last = present(kept[maxLines - 1], 'kept[maxLines - 1]');
  kept[maxLines - 1] = `${codePoints(last)
    .slice(0, width - 1)
    .join('')}…`;
  return kept;
}

/** `line` with `suffix` after it, the line first cut as R3 cuts (to fit `width` code points with the suffix). */
function withSuffix(line: string, suffix: string, width: number): string {
  const cps = codePoints(line);
  const room = width - codePoints(suffix).length;
  return cps.length <= room ? `${line}${suffix}` : `${cps.slice(0, room - 1).join('')}…${suffix}`;
}

/** R5: what became of one addressee of a call, as the scene's card and the chat thread both word it. */
export function outcomeWords(answer: Pick<GatherAnswer, 'outcome' | 'text' | 'reason' | 'detail'>): string {
  switch (answer.outcome) {
    case 'answered':
      if (answer.text === undefined) throw new Error('an answered call outcome carries its text (GatherAnswer)');
      return answer.text;
    case 'passed':
      return answer.reason === undefined || answer.reason === '' ? 'passed' : `passed: ${answer.reason}`;
    case 'left':
      if (answer.detail === undefined)
        throw new Error("a left call outcome carries the channel's detail (GatherAnswer)");
      return `left: ${answer.detail}`;
    case 'timed_out':
      return 'timed out';
    case 'unanswered':
      return 'no answer';
    default: {
      const unknown: never = answer.outcome;
      throw new Error(`no words for the call outcome ${String(unknown)}`);
    }
  }
}

/** A status that says the agent passed (R4, R5): `pass`, or `pass: <reason>`; its reason, or undefined for any other text. */
function passReason(text: string): string | undefined {
  if (text === 'pass') return '';
  return text.startsWith('pass: ') ? text.slice('pass: '.length) : undefined;
}

/**
 * The scene's state as the watch stream drives it (docs/portal/index.md#scene): the robots on the floor, the user's
 * figure, the arcs between them and each one's speech, stepped by scene time; scene-draw.ts draws it.
 */
export class SceneSim implements WatchObserver {
  /** The canvas's width, in CSS px. */
  width = 0;
  /** The canvas's height, in CSS px. */
  height = 0;
  /** The robots' scale, from the width: 1.1 to 1.7. */
  unit = 1;
  /**
   * Where the dock stands, in CSS px: 60 × unit from the right edge, at 55 % of the height less 24 × unit
   * (demo-scene-refresh R2); the users' figure stands on it.
   */
  dock = { x: 0, y: 0 };
  /** Every agent online, in join order. */
  private readonly agents: string[] = [];
  private readonly robots = new Map<string, SceneRobot>();
  /** Robots that left after their failure, each drawn until scene time `until` (R8). */
  private readonly departed: { readonly robot: SceneRobot; readonly until: number }[] = [];
  private readonly lamps = new Map<string, LampState>();
  /** Each agent's open work, by conversation (R4). */
  private readonly work = new Map<string, Work[]>();
  /** Each agent's card, at most one (R5). */
  private readonly cards = new Map<string, Card>();
  /** Per conversation, each sender's latest message to everyone (an input or an agent's internal), oldest sender first. */
  private readonly broadcasts = new Map<string, Map<string, string>>();
  /** The arcs in flight, oldest first. */
  readonly arcs: SceneArc[] = [];
  /** A user has posted while the scene is open: the figure stands on the dock. */
  figure = false;
  /** The user figure's speech: its latest message, while it shows. */
  figureSpeech: Speech | null = null;
  /** The harness badge's speech: its latest message, while it shows. */
  badgeSpeech: Speech | null = null;
  /** Counts every change an event or a telemetry answer made: a still scene is redrawn when it moves; boxes draw in its order. */
  changes = 0;
  /** Simulated time, in ms. */
  time = 0;
  private shells = 0;

  constructor(private readonly props: SceneSimProps) {
    this.layout(props.width, props.height);
  }

  /**
   * The floor and the dock for a scene of this size. The floor is the whole canvas (demo-scene-refresh R1, R2): no
   * backdrop band above it.
   */
  layout(width: number, height: number): void {
    const sx = this.width === 0 ? 1 : width / this.width;
    this.width = width;
    this.height = height;
    this.unit = Math.min(1.7, Math.max(1.1, width / 780));
    this.dock = { x: width - Math.round(60 * this.unit), y: (height - Math.round(24 * this.unit)) * 0.55 };
    for (const r of this.robots.values()) {
      r.x = this.clampX(r.x * sx);
      r.y = this.clampY(r.y);
      r.target = this.floorPoint();
      // A new floor starts every robot's personal space afresh (R5c).
      Object.assign(r, { rest: 0, crowded: 0, escaping: false, walkOuts: 0 });
    }
    // A gone robot stays where it stood on the new floor (R8).
    for (const { robot } of this.departed)
      Object.assign(robot, { x: this.clampX(robot.x * sx), y: this.clampY(robot.y) });
    this.place();
    // The floor may hold fewer robots now: an arc to or from one no longer drawn ends at the badge, as a new one would.
    const now = (e: Endpoint): Endpoint => (e.kind === 'robot' ? this.endpointOf(e.handle) : e);
    for (let i = 0; i < this.arcs.length; i += 1) {
      const arc = present(this.arcs[i], 'this.arcs[i]');
      this.arcs[i] = { ...arc, from: now(arc.from), to: now(arc.to) };
    }
  }

  /** How many robots fit this scene (R5): the walkable floor's area over SCENE.cellArea, never fewer than SCENE.minRobots. */
  capacity(): number {
    const { left, right, top, bottom } = this.limits();
    // Spans clamped at 0, as place() clamps them: two negative spans make no area.
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    return Math.max(SCENE.minRobots, Math.floor(area / (SCENE.cellArea * this.unit * this.unit)));
  }

  /** Where a drawn robot's feet may stand: anywhere its body and name label lie inside the canvas less the margin. */
  floor(): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } {
    return this.limits();
  }

  /** The robots drawn, in join order. */
  drawn(): SceneRobot[] {
    return this.agents
      .slice(0, this.capacity())
      .map((handle) => present(this.robots.get(handle), `robots.get(${handle})`));
  }

  /**
   * The robots that left after their failure and are drawn still, marked, for SCENE.goneMs (R8): not online, in no
   * capacity slot, with no personal space; a still scene keeps one until its next event.
   */
  gone(): readonly SceneRobot[] {
    return this.departed.map((d) => d.robot);
  }

  /** Every robot the renderer draws: the drawn ones, then the gone ones (R8). */
  shown(): SceneRobot[] {
    return [...this.drawn(), ...this.gone()];
  }

  /** The robots shown marked with a red ✕ (R8), in the order shown. */
  failed(): string[] {
    return this.shown()
      .filter((r) => r.failed)
      .map((r) => r.handle);
  }

  /** Every agent online, in join order (portal R9): the order R7's team lines and R15's To choice follow. */
  online(): readonly string[] {
    return this.agents;
  }

  /** The agents not drawn, which the badge stands for: `+n`, drawn only when n is at least 1. */
  badge(): number {
    return Math.max(0, this.agents.length - this.capacity());
  }

  /** Where the badge stands: the floor's lower left corner. */
  badgeAt(): { x: number; y: number } {
    return { x: 28 * this.unit, y: this.height - 30 * this.unit };
  }

  /**
   * Every robot's scale: the scene's unit wherever it stands (demo-scene-refresh R3; the web site's perspective, which
   * grew a robot with its depth on the floor, went with the backdrop).
   */
  scale(): number {
    return this.unit;
  }

  /** Each drawn robot's personal space now (R5c), in join order. */
  spaces(): { readonly handle: string; readonly space: Rect }[] {
    return this.drawn().map((r) => ({ handle: r.handle, space: this.spaceAt(r, r) }));
  }

  /** An agent's antenna lamp (R9). */
  lamp(handle: string): 'amber' | 'white' {
    const lamp = this.lamps.get(handle);
    if (lamp === undefined) return 'white';
    if (lamp.open.size > 0) return 'amber';
    return lamp.inFlightAt !== null && lamp.inFlightAt > lamp.lastDone ? 'amber' : 'white';
  }

  /** The agents whose lamp is amber, in join order (R8's `is writing…`). */
  writing(): string[] {
    return this.agents.filter((a) => this.lamp(a) === 'amber');
  }

  /** An agent's open work, oldest first (R4): each conversation and its task. */
  workOf(handle: string): readonly { readonly conversation: string; readonly task: string }[] {
    return (this.work.get(handle) ?? []).map((w) => ({ conversation: w.conversation, task: w.task }));
  }

  /** An agent's work bubble as drawn (R4): its lines and when it last changed, or null with no work open. */
  workBubble(handle: string): { readonly lines: string[]; readonly changed: number } | null {
    const open = this.work.get(handle) ?? [];
    const newest = open.at(-1);
    if (newest === undefined) return null;
    const lines = bubbleLines(`working on: ${newest.task}`, SCENE.speechWidth, this.narrow() ? 1 : SCENE.speechLines);
    if (open.length > 1)
      lines[lines.length - 1] = withSuffix(lines.at(-1) ?? '', ` +${String(open.length - 1)} more`, SCENE.speechWidth);
    return { lines, changed: newest.changed };
  }

  /** An agent's card as drawn (R5): its title, then its rows and `+m more` (only the title on a narrow scene), or null. */
  cardBubble(handle: string): { readonly lines: string[]; readonly changed: number } | null {
    const card = this.cards.get(handle);
    if (card === undefined) return null;
    const known = card.rows.filter((r) => r.outcome !== null).length;
    const title = `${card.gathered ? 'collected' : 'collecting'} ${String(known)}/${String(card.rows.length)}`;
    if (this.narrow()) return { lines: [title], changed: card.changed };
    // A row is never empty (`<handle>: …`), so it lays out in one line.
    const rows = card.rows
      .slice(0, SCENE.cardRows)
      .map((r) =>
        present(bubbleLines(`${r.handle}: ${r.outcome ?? 'waiting'}`, SCENE.cardWidth, 1)[0], 'bubbleLines(...)[0]'),
      );
    const more = card.rows.length - SCENE.cardRows;
    return { lines: [title, ...rows, ...(more > 0 ? [`+${String(more)} more`] : [])], changed: card.changed };
  }

  // ------------------------------------------------------------ events (WatchObserver)

  watching(_channel: string, agents: readonly string[]): void {
    for (const agent of agents) this.add(agent);
    this.changes += 1;
  }

  joined(agent: string): void {
    this.dropDeparted(agent);
    const robot = this.robots.get(agent);
    if (robot !== undefined) robot.failed = false;
    this.add(agent);
    this.changes += 1;
  }

  left(agent: string): void {
    const at = this.agents.indexOf(agent);
    if (at < 0) return;
    // A robot drawn and marked when it leaves stays, marked, for SCENE.goneMs (R8).
    const robot = present(this.robots.get(agent), `robots.get(${agent})`);
    if (robot.failed && at < this.capacity()) this.departed.push({ robot, until: this.time + SCENE.goneMs });
    this.agents.splice(at, 1);
    this.robots.delete(agent);
    this.lamps.delete(agent);
    this.work.delete(agent);
    this.cards.delete(agent);
    // An arc to or from it ends with it.
    for (let i = this.arcs.length - 1; i >= 0; i -= 1) {
      const arc = present(this.arcs[i], 'this.arcs[i]');
      if (
        (arc.from.kind === 'robot' && arc.from.handle === agent) ||
        (arc.to.kind === 'robot' && arc.to.handle === agent)
      )
        this.arcs.splice(i, 1);
    }
    this.place();
    this.changes += 1;
  }

  /** R1, R2 (rows M1–M11 of the plan's rendering table): an agent's status or a sender's message is spoken; nothing
   * of the harness's is drawn. */
  private speakMessage(message: ChannelMessage, fromHarness: boolean): void {
    if (fromHarness) return;
    const from = this.endpointOf(message.from);
    if (from.kind === 'figure') this.figure = true;
    this.speak(from, message.text);
    if (message.kind !== 'status') this.arcsFrom(from, message);
  }

  /**
   * R8: an agent's failure status marks its robot with a red ✕, and it stands still; any later message of its own clears
   * the mark.
   */
  private markFailure(message: ChannelMessage): void {
    const robot = this.robots.get(message.from);
    if (robot === undefined) return;
    robot.failed = message.conversation === null && message.failure === true;
    if (robot.failed) robot.target = { x: robot.x, y: robot.y };
  }

  /** Ends a gone robot's stay early: its handle joined again (R8). */
  private dropDeparted(agent: string): void {
    for (let i = this.departed.length - 1; i >= 0; i -= 1)
      if (present(this.departed[i], 'this.departed[i]').robot.handle === agent) this.departed.splice(i, 1);
  }

  /** A message addressed to everyone joins the conversation's broadcast, for R4 (b)'s `ok`. */
  private broadcastMessage(message: ChannelMessage, fromHarness: boolean, conversation: string): void {
    if (!fromHarness && message.to === null && (message.kind === 'input' || message.kind === 'internal'))
      this.broadcast(conversation, message.from, message.text);
  }

  /** R4: an agent's status outside a call — `pass[: reason]` closes its work with that outcome; `ok` with none open
   * opens it from the latest broadcast. */
  private statusMessage(message: ChannelMessage, conversation: string): void {
    const reason = passReason(message.text);
    if (reason !== undefined) {
      this.passed(conversation, message.from, reason);
      this.close(message.from, conversation);
    } else if (message.text === WORKING) {
      this.openOnOk(message.from, conversation);
    }
  }

  /** R4 (a): a message addressed to an agent — an input, or a call's question — is work it was given. */
  private workMessage(message: ConversationMessage, fromHarness: boolean, conversation: string): void {
    const to = message.to;
    if (fromHarness || to === null || !this.robots.has(to)) return;
    const given =
      message.kind === 'input' ||
      (message.kind === 'internal' && (message.call === undefined || message.call.role === 'question'));
    if (given) this.open(to, conversation, message.text);
  }

  /** R4's closing events: an output, or a call's answer, closes the sender's own work in the conversation. */
  private closeMessage(message: ConversationMessage, fromHarness: boolean, conversation: string): void {
    if (fromHarness || !this.robots.has(message.from)) return;
    const delivered =
      message.kind === 'output' ||
      (message.kind === 'internal' && (message.call === undefined || message.call.role === 'answer'));
    if (delivered) this.close(message.from, conversation);
  }

  /** An output not asking the user ends every other agent's work and card in the conversation. */
  private closeOthersOnOutput(message: ChannelMessage, conversation: string): void {
    if (message.kind !== 'output' || message.asks === true) return;
    for (const agent of [...this.work.keys(), ...this.cards.keys()])
      if (agent !== message.from) this.close(agent, conversation);
  }

  message(message: ChannelMessage): void {
    this.changes += 1;
    this.markFailure(message);
    const fromHarness = message.from === HARNESS_HANDLE;
    const conversation = message.conversation;
    this.speakMessage(message, fromHarness);
    if (conversation === null) return;
    this.broadcastMessage(message, fromHarness, conversation);
    if (message.kind === 'internal' && message.call !== undefined) this.collect(message, message.call, conversation);
    if (message.kind === 'status' && !fromHarness) {
      this.statusMessage(message, conversation);
      return;
    }
    this.workMessage(message, fromHarness, conversation);
    this.closeMessage(message, fromHarness, conversation);
    this.closeOthersOnOutput(message, conversation);
  }

  delta(part: ModelDeltaEvent): void {
    const lamp = this.lamps.get(part.handle);
    if (lamp === undefined || lamp.open.has(part.call)) return;
    lamp.open.add(part.call);
    this.changes += 1;
  }

  done(end: ModelDoneEvent): void {
    const lamp = this.lamps.get(end.handle);
    if (lamp === undefined) return;
    lamp.open.delete(end.call);
    lamp.lastDone = this.props.now();
    this.changes += 1;
  }

  /** The watch ended with an error: the scene stays as it was; the view says why. */
  error(): void {}

  /**
   * A conversation this page sent settled, by the CLI's rule (portal-scene-chat R4): every work bubble and card in it
   * ends — the visible end the watch stream does not carry when a conversation ends with no output (a budget, a
   * refusal, a restart limit).
   */
  concluded(conversation: string): void {
    for (const agent of [...this.work.keys(), ...this.cards.keys()]) this.close(agent, conversation);
    this.changes += 1;
  }

  /** A telemetry answer (R10) reached the page: each agent's calls in flight now, for its lamp. True when a lamp changed. */
  telemetry(answer: TelemetryResponse): boolean {
    const at = this.props.now();
    const before = this.agents.map((a) => this.lamp(a)).join();
    for (const agent of answer.agents) {
      const lamp = this.lamps.get(agent.handle);
      if (lamp === undefined) continue;
      lamp.inFlightAt = agent.modelCallsInFlight > 0 ? at : null;
    }
    const changed = this.agents.map((a) => this.lamp(a)).join() !== before;
    if (changed) this.changes += 1;
    return changed;
  }

  /** Ends every arc and speech bubble now (R6): a still scene shows only the latest event's, with every work bubble and card. */
  settle(): void {
    this.arcs.length = 0;
    // A still scene keeps a gone robot only until the next event (R8).
    this.departed.length = 0;
    for (const r of this.robots.values()) r.speech = null;
    this.figureSpeech = null;
    this.badgeSpeech = null;
  }

  // ------------------------------------------------------------ time

  /** Ages every arc (removing one that has fully played) and every speech bubble (figure's, badge's, each robot's). */
  private ageArcsAndSpeech(ms: number): void {
    for (let i = this.arcs.length - 1; i >= 0; i -= 1) {
      const arc = present(this.arcs[i], 'this.arcs[i]');
      arc.age += ms;
      if (arc.age >= SCENE.arcMs) this.arcs.splice(i, 1);
    }
    const age = (speech: Speech | null): Speech | null => {
      if (speech === null) return null;
      speech.age += ms;
      return speech.age >= SCENE.speechMs ? null : speech;
    };
    this.figureSpeech = age(this.figureSpeech);
    this.badgeSpeech = age(this.badgeSpeech);
    for (const r of this.robots.values()) r.speech = age(r.speech);
    // A gone robot's speech ages with it, so it fades in and ends as any other (R8).
    for (const d of this.departed) d.robot.speech = age(d.robot.speech);
  }

  /** The episode's clock (R5c): runs while a robot's space meets another's and it is not walking out, else resets. */
  private nextCrowded(r: SceneRobot, meets: boolean, ms: number): number {
    if (!meets) return 0;
    if (r.escaping) return r.crowded;
    return r.crowded + ms;
  }

  /** R5c (d), (e): tracks how long each drawn robot's space has met another's, walking it out once per episode. */
  private updateCrowding(drawn: readonly SceneRobot[], spaces: Map<SceneRobot, Rect>, ms: number): void {
    for (const r of drawn) {
      const own = present(spaces.get(r), 'spaces.get(r)');
      const meets = drawn.some((o) => o !== r && intersects(own, present(spaces.get(o), 'spaces.get(o)')));
      // The episode's clock runs while it meets a space and is not walking out.
      r.crowded = this.nextCrowded(r, meets, ms);
      if (!meets) Object.assign(r, { escaping: false, walkOuts: 0 });
      else if (!r.escaping && r.walkOuts < SCENE.walkOuts && r.crowded >= SCENE.crowdedMs) {
        Object.assign(r, { escaping: true, walkOuts: r.walkOuts + 1, rest: 0, crowded: 0 });
        r.target = this.freeTarget(r, spaces);
      }
    }
  }

  /** The heading a step takes: sideways when the move is clearly one way, else kept (R5c, the web site's rule). */
  private nextHeading(dx: number, current: -1 | 1): -1 | 1 {
    if (Math.abs(dx) <= 0.5) return current;
    return dx < 0 ? -1 : 1;
  }

  /** Idle motion for one robot not already moved apart this step (R5c (a)–(c)): standing out its rest, walking to its
   * target, or turning away from a step that would enter a space it does not meet now. */
  private wanderOne(r: SceneRobot, drawn: readonly SceneRobot[], spaces: Map<SceneRobot, Rect>, ms: number): void {
    // A robot marked failed stands still (R8).
    if (r.failed) return;
    const speed = ((r.escaping ? SCENE.apartSpeed : SCENE.wanderSpeed) * this.unit * ms) / 1_000;
    const own = spaces.get(r);
    if (r.rest > 0) {
      r.rest = Math.max(0, r.rest - ms);
      if (r.rest === 0) r.target = this.freeTarget(r, spaces);
      return;
    }
    const dx = r.target.x - r.x;
    const dy = r.target.y - r.y;
    const d = Math.hypot(dx, dy);
    if (d <= SCENE.reach) {
      r.escaping = false;
      r.target = own === undefined ? this.floorPoint() : this.freeTarget(r, spaces);
      return;
    }
    const k = Math.min(1, speed / d);
    const heading = this.nextHeading(dx, r.heading);
    const next = { x: r.x + dx * k, y: r.y + dy * k, heading };
    if (own !== undefined) {
      // R5c (a): a step that would enter a space it does not meet now is not taken; it stands, then turns away.
      const will = this.spaceAt(r, next);
      if (
        !r.escaping &&
        drawn.some(
          (o) =>
            o !== r &&
            intersects(will, present(spaces.get(o), 'spaces.get(o)')) &&
            !intersects(own, present(spaces.get(o), 'spaces.get(o)')),
        )
      ) {
        r.rest = SCENE.restMs;
        return;
      }
      spaces.set(r, will);
    }
    r.x = next.x;
    r.y = next.y;
    r.heading = heading;
  }

  /**
   * Advances the scene by `ms`: arcs and speech play out; drawn robots whose personal spaces meet move apart, and the
   * rest wander (idle motion) without walking into another's space (R5c (a), (b), (c)). A robot whose space has met
   * another's for SCENE.crowdedMs walks out to a free place at SCENE.apartSpeed, through spaces on the way, which pushes
   * cannot do when it is held on every side (R5c (d)) — once in each episode of meeting: a robot that has walked out and
   * still meets a space gives up until its space meets none, wandering at SCENE.wanderSpeed with no pair of its moved
   * apart, so a floor too small for every space does not keep its robots racing (R5c (e)).
   */
  step(ms: number): void {
    this.time += ms;
    this.ageArcsAndSpeech(ms);
    for (let i = this.departed.length - 1; i >= 0; i -= 1)
      if (present(this.departed[i], 'this.departed[i]').until <= this.time) this.departed.splice(i, 1);
    const drawn = this.drawn();
    const spaces = new Map(drawn.map((r) => [r, this.spaceAt(r, r)]));
    // R5c (e): a robot walking out, or one that has given up in this episode, is in no pair that moves apart; a marked
    // one stands still (R8).
    const moved = this.apart(
      drawn.filter((r) => !r.escaping && r.walkOuts < SCENE.walkOuts && !r.failed),
      spaces,
      ms,
    );
    this.updateCrowding(drawn, spaces, ms);
    for (const r of this.robots.values()) {
      if (moved.has(r)) continue;
      this.wanderOne(r, drawn, spaces, ms);
    }
  }

  /** How far `r` can go along `dir` before the floor's edge. */
  private room(
    r: SceneRobot,
    dir: { x: number; y: number },
    lim: { left: number; right: number; top: number; bottom: number },
  ): number {
    if (dir.x < 0) return r.x - lim.left;
    if (dir.x > 0) return lim.right - r.x;
    if (dir.y < 0) return r.y - lim.top;
    return lim.bottom - r.y;
  }

  /**
   * One pair's push apart (R5c (b)), added to each robot's accumulator: along the axis they overlap less, each by
   * half the overlap and 1 px more, or along the other axis when neither can move on the first before the floor's edge.
   */
  private pushApart(
    a: SceneRobot,
    b: SceneRobot,
    spaces: ReadonlyMap<SceneRobot, Rect>,
    lim: { left: number; right: number; top: number; bottom: number },
    add: (r: SceneRobot, x: number, y: number) => void,
  ): void {
    const A = present(spaces.get(a), 'spaces.get(a)');
    const B = present(spaces.get(b), 'spaces.get(b)');
    if (!intersects(A, B)) return;
    const left = a.x <= b.x ? -1 : 1;
    const back = a.y <= b.y ? -1 : 1;
    const sideways = {
      a: { x: left, y: 0 },
      b: { x: -left, y: 0 },
      need: Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x),
    };
    const depth = {
      a: { x: 0, y: back },
      b: { x: 0, y: -back },
      need: Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y),
    };
    const free = (axis: typeof sideways): number => this.room(a, axis.a, lim) + this.room(b, axis.b, lim);
    const [first, second] = sideways.need <= depth.need ? [sideways, depth] : [depth, sideways];
    const axis = free(first) > 0.5 ? first : second;
    const each = axis.need / 2 + 1;
    add(a, axis.a.x * each, axis.a.y * each);
    add(b, axis.b.x * each, axis.b.y * each);
  }

  /** Moves every pushed robot at most SCENE.apartSpeed in `ms`, no further than the floor's edge; what moved. */
  private applyPush(
    push: ReadonlyMap<SceneRobot, { x: number; y: number }>,
    spaces: Map<SceneRobot, Rect>,
    ms: number,
  ): Set<SceneRobot> {
    const most = (SCENE.apartSpeed * this.unit * ms) / 1_000;
    const moved = new Set<SceneRobot>();
    for (const [r, p] of push) {
      const length = Math.hypot(p.x, p.y);
      if (length === 0 || most === 0) continue;
      const k = Math.min(1, most / length);
      const x = this.clampX(r.x + p.x * k);
      const y = this.clampY(r.y + p.y * k);
      if (Math.hypot(x - r.x, y - r.y) < 0.01) continue;
      r.x = x;
      r.y = y;
      r.rest = 0;
      spaces.set(r, this.spaceAt(r, r));
      moved.add(r);
    }
    return moved;
  }

  /**
   * R5c (b): each pair of drawn robots whose spaces meet moves apart along the axis where they overlap less — sideways,
   * the one standing left (or, level, joined first) going left; or in depth, the one further back going back — each by
   * half the overlap and 1 px more, and along the other axis when neither can move on the first before the floor's edge.
   * The pixel more ends the pair's overlap: by half alone, the overlap would only halve at each step, and a box held
   * inside the canvas does not move with its robot. A robot moves at most SCENE.apartSpeed in a second, and no further
   * than the floor's edge. A robot held between others may be pushed both ways at once and not move; R5c (d) walks it
   * out. Returns the robots that moved.
   */
  private apart(drawn: readonly SceneRobot[], spaces: Map<SceneRobot, Rect>, ms: number): Set<SceneRobot> {
    const push = new Map<SceneRobot, { x: number; y: number }>();
    const add = (r: SceneRobot, x: number, y: number): void => {
      const p = push.get(r) ?? { x: 0, y: 0 };
      push.set(r, { x: p.x + x, y: p.y + y });
    };
    const lim = this.limits();
    for (let i = 0; i < drawn.length; i += 1) {
      for (let j = i + 1; j < drawn.length; j += 1) {
        this.pushApart(present(drawn[i], 'drawn[i]'), present(drawn[j], 'drawn[j]'), spaces, lim, add);
      }
    }
    return this.applyPush(push, spaces, ms);
  }

  /**
   * R5c (c): a new wander target for a drawn robot — the first of SCENE.targetTries floor points where its space meets
   * no other drawn robot's space, now or at that robot's target; with none, the one where it overlaps them least.
   */
  private freeTarget(r: SceneRobot, spaces: Map<SceneRobot, Rect>): { x: number; y: number } {
    const others: Rect[] = [];
    for (const [o, space] of spaces)
      if (o !== r) others.push(space, this.spaceAt(o, { x: o.target.x, y: o.target.y, heading: o.heading }));
    const overlapAt = (p: { x: number; y: number }): number => {
      const at = this.spaceAt(r, { x: p.x, y: p.y, heading: p.x < r.x ? -1 : 1 });
      return others.reduce((sum, o) => sum + overlapArea(at, o), 0);
    };
    let best = this.floorPoint();
    let least = overlapAt(best);
    for (let i = 1; i < SCENE.targetTries && least > 0; i += 1) {
      const p = this.floorPoint();
      const overlap = overlapAt(p);
      if (overlap < least) {
        best = p;
        least = overlap;
      }
    }
    return best;
  }

  /** A robot's personal space standing at `at` (R5c). */
  private spaceAt(r: SceneRobot, at: { readonly x: number; readonly y: number; readonly heading: -1 | 1 }): Rect {
    return personalSpace(
      this,
      { handle: r.handle, speech: r.speech, x: at.x, y: at.y, heading: at.heading },
      this.props.measure,
    );
  }

  /** Where a robot's feet may stand: the bounds clampX and clampY keep. */
  private limits(): { left: number; right: number; top: number; bottom: number } {
    return {
      left: 40 * this.unit,
      right: this.dock.x - 70 * this.unit,
      // Anywhere the body — 51.1 × its scale above its feet, its lamp's bob included (robotTop) — and the name label
      // below them lie inside the canvas less the margin (demo-scene-refresh R2).
      top: SCENE.margin + 52 * this.unit,
      bottom: this.height - 28 * this.unit,
    };
  }

  // ------------------------------------------------------------ helpers

  private narrow(): boolean {
    return this.width < SCENE.narrowBelow;
  }

  private add(agent: string): void {
    if (this.robots.has(agent)) return;
    this.agents.push(agent);
    const at = this.floorPoint();
    this.robots.set(agent, {
      handle: agent,
      x: at.x,
      y: at.y,
      heading: this.props.rng() < 0.5 ? -1 : 1,
      target: this.floorPoint(),
      phase: this.props.rng() * Math.PI * 2,
      shell: this.shells++ % 3,
      speech: null,
      rest: 0,
      crowded: 0,
      escaping: false,
      walkOuts: 0,
      failed: false,
    });
    this.lamps.set(agent, { open: new Set(), lastDone: Number.NEGATIVE_INFINITY, inFlightAt: null });
    this.place();
  }

  /** Spreads the drawn robots over the floor in join order, so each label has room; wandering starts from there. */
  private place(): void {
    const drawn = this.agents.slice(0, this.capacity());
    const { left, right, top, bottom } = this.limits();
    // A grid for the robots drawn, its cells as near square as the floor allows, spread over the whole floor in join
    // order; one robot stands in the middle.
    // A floor with no width or height (a canvas under about 190 CSS px, as at a high zoom) stands them in a line.
    const w = Math.max(0, right - left);
    const h = Math.max(0, bottom - top);
    const cols =
      h === 0 ? drawn.length : Math.max(1, Math.min(drawn.length, Math.round(Math.sqrt((drawn.length * w) / h))));
    const rows = Math.ceil(drawn.length / cols);
    drawn.forEach((handle, i) => {
      const r = present(this.robots.get(handle), `robots.get(${handle})`);
      // A robot marked failed stands where it is (R8).
      if (r.failed) return;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = cols === 1 ? left + w / 2 : left + (w * col) / (cols - 1);
      const y = rows === 1 ? top + h / 2 : top + (h * row) / (rows - 1);
      r.x = x;
      r.y = y;
      r.target = {
        x: this.clampX(x + (this.props.rng() - 0.5) * 30 * this.unit),
        y: this.clampY(y + (this.props.rng() - 0.5) * 12 * this.unit),
      };
    });
  }

  /** A message's sender or addressee as drawn: a drawn robot, the badge for an agent not drawn, else a user's figure. */
  private endpointOf(name: string): Endpoint {
    const at = this.agents.indexOf(name);
    if (at < 0) return { kind: 'figure' };
    return at < this.capacity() ? { kind: 'robot', handle: name } : { kind: 'badge' };
  }

  /** R2: what `end` said replaces what it said before. */
  private speak(end: Endpoint, text: string): void {
    const speech: Speech = {
      lines: bubbleLines(text, SCENE.speechWidth, SCENE.speechLines),
      age: 0,
      changed: this.changes,
    };
    if (end.kind === 'robot') present(this.robots.get(end.handle), `robots.get(${end.handle})`).speech = speech;
    else if (end.kind === 'figure') this.figureSpeech = speech;
    else this.badgeSpeech = speech;
  }

  private arcsFrom(from: Endpoint, message: ChannelMessage): void {
    const to: Endpoint[] =
      message.to === null
        ? this.agents.filter((a) => a !== message.from).map((a) => this.endpointOf(a))
        : [this.endpointOf(message.to)];
    // One arc to the badge stands for every agent it covers.
    const seen = new Set<string>();
    for (const end of to) {
      const key = end.kind === 'robot' ? `robot:${end.handle}` : end.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      if (end.kind === 'figure') this.figure = true;
      this.arcs.push({ from, to: end, age: 0 });
    }
  }

  private broadcast(conversation: string, from: string, text: string): void {
    let senders = this.broadcasts.get(conversation);
    if (senders === undefined) {
      senders = new Map();
      this.broadcasts.set(conversation, senders);
    }
    // Latest last: a sender that speaks again moves to the end.
    senders.delete(from);
    senders.set(from, text);
  }

  /** R4 (a): opens `agent`'s work in `conversation` with `task`, unless work there is open. */
  private open(agent: string, conversation: string, task: string): void {
    const open = this.work.get(agent) ?? [];
    if (open.some((w) => w.conversation === conversation)) return;
    this.work.set(agent, [...open, { conversation, task, changed: this.changes }]);
  }

  /** R4 (b): an `ok` with no work open there opens it with the latest message to everyone not from the agent. */
  private openOnOk(agent: string, conversation: string): void {
    if (!this.robots.has(agent)) return;
    const senders = [...(this.broadcasts.get(conversation) ?? new Map<string, string>()).entries()].filter(
      ([from]) => from !== agent,
    );
    this.open(agent, conversation, senders.at(-1)?.[1] ?? UNSEEN_TASK);
  }

  /** R4's close, and R5's: `agent`'s work and card in `conversation` end. */
  private close(agent: string, conversation: string): void {
    const open = this.work.get(agent);
    if (open !== undefined) {
      const rest = open.filter((w) => w.conversation !== conversation);
      if (rest.length === 0) this.work.delete(agent);
      else this.work.set(agent, rest);
    }
    if (this.cards.get(agent)?.conversation === conversation) this.cards.delete(agent);
  }

  /** R5: a call's question adds (or updates) its caller's card row for its addressee. */
  private collectQuestion(
    message: ConversationMessage,
    call: Extract<CallMark, { readonly role: 'question' }>,
    conversation: string,
  ): void {
    // Cards are an online agent's (a question from one that has left is not drawn, and left() cleared its card).
    if (message.to === null || !this.robots.has(message.from)) return;
    const card = this.cards.get(message.from);
    if (card !== undefined && card.call === call.id) {
      if (!card.rows.some((r) => r.handle === message.to)) card.rows.push({ handle: message.to, outcome: null });
      card.changed = this.changes;
    } else {
      this.cards.set(message.from, {
        call: call.id,
        conversation,
        rows: [{ handle: message.to, outcome: null }],
        gathered: false,
        changed: this.changes,
      });
    }
  }

  /** R5: a call's answer updates the row waiting on it on the caller's own card. */
  private collectAnswer(
    message: ConversationMessage,
    call: Extract<CallMark, { readonly role: 'answer' }>,
    caller: string,
  ): void {
    const card = this.cards.get(caller);
    const row = card?.call === call.id ? card.rows.find((r) => r.handle === message.from) : undefined;
    if (card === undefined || row === undefined) return;
    row.outcome = outcomeWords({ outcome: 'answered', text: message.text });
    card.changed = this.changes;
  }

  /** R5: a gather's every outcome, on a card from its requests when the page never saw its questions. */
  private collectGather(
    call: Extract<CallMark, { readonly role: 'gather' }>,
    caller: string,
    conversation: string,
  ): void {
    let card = this.cards.get(caller);
    if (card === undefined || card.call !== call.id) {
      card = {
        call: call.id,
        conversation,
        rows: call.requests.map((r) => ({ handle: r.to, outcome: null })),
        gathered: false,
        changed: this.changes,
      };
      this.cards.set(caller, card);
    }
    for (const answer of call.answers) {
      const row = card.rows.find((r) => r.handle === answer.from);
      if (row === undefined) card.rows.push({ handle: answer.from, outcome: outcomeWords(answer) });
      else row.outcome = outcomeWords(answer);
    }
    card.gathered = true;
    card.changed = this.changes;
  }

  /** R5: a call's question, answer or gather updates its caller's card. */
  private collect(message: ConversationMessage, call: CallMark, conversation: string): void {
    if (call.role === 'question') {
      this.collectQuestion(message, call, conversation);
      return;
    }
    const caller = message.to;
    if (caller === null || !this.robots.has(caller)) return;
    if (call.role === 'answer') {
      this.collectAnswer(message, call, caller);
      return;
    }
    this.collectGather(call, caller, conversation);
  }

  /** R5: a callee's pass in a conversation is its outcome on every card there that waits on it. */
  private passed(conversation: string, callee: string, reason: string): void {
    for (const card of this.cards.values()) {
      if (card.conversation !== conversation) continue;
      const row = card.rows.find((r) => r.handle === callee && r.outcome === null);
      if (row === undefined) continue;
      row.outcome = outcomeWords({ outcome: 'passed', reason });
      card.changed = this.changes;
    }
  }

  private floorPoint(): { x: number; y: number } {
    return {
      x: this.clampX(this.props.rng() * this.width),
      y: this.clampY(this.props.rng() * this.height),
    };
  }

  private clampX(x: number): number {
    const { left, right } = this.limits();
    return Math.min(right, Math.max(left, x));
  }

  private clampY(y: number): number {
    const { top, bottom } = this.limits();
    return Math.min(bottom, Math.max(top, y));
  }
}

/** The area two rectangles share (0 when they do not meet). */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The font of a robot's name label at scale `s`: the renderer draws it, R5c measures it. */
export function labelFont(s: number): string {
  return `600 ${String(Math.max(11, 10 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
}

/** A name label under a figure whose label line is at `y` (the renderer's own geometry): its box, centred on `x`. */
export function labelBox(
  x: number,
  y: number,
  s: number,
  text: string,
  measure: (text: string, font: string) => number,
): Rect {
  const w = measure(text, labelFont(s)) + 8;
  return { x: x - w / 2, y: y - 1, w, h: Math.max(14, 13 * s) };
}

/**
 * R5c: what a robot standing at (x, y) covers — its body from the antenna's lamp (with its bob and raised arms) to its
 * treads, its name label, and its own boxes as R5b places them before any group moves out of another's way — with
 * SCENE.space on every side.
 */
export function personalSpace(
  sim: SceneSim,
  robot: Pick<SceneRobot, 'handle' | 'speech' | 'x' | 'y' | 'heading'>,
  measure: (text: string, font: string) => number,
): Rect {
  const { antenna, scale: s } = robotTop(sim, robot.y);
  const body: Rect = { x: robot.x - 19 * s, y: antenna - 4 * s, w: 38 * s, h: robot.y - antenna + 4 * s };
  const parts: Rect[] = [
    body,
    labelBox(robot.x, robot.y + 4 * s, s, robot.handle, measure),
    ...robotBoxes(sim, robot, (t) => measure(t, SCENE.font)),
  ];
  const left = Math.min(...parts.map((p) => p.x)) - SCENE.space;
  const top = Math.min(...parts.map((p) => p.y)) - SCENE.space;
  const right = Math.max(...parts.map((p) => p.x + p.w)) + SCENE.space;
  const bottom = Math.max(...parts.map((p) => p.y + p.h)) + SCENE.space;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Where a robot's head and antenna are, for a robot standing at `y` (the renderer's own geometry, without the bob). */
export function robotTop(
  sim: SceneSim,
  y: number,
): { readonly top: number; readonly antenna: number; readonly scale: number } {
  const s = sim.scale();
  const top = y - 36 * s;
  return { top, antenna: top - 11.1 * s, scale: s };
}

/** Whether two boxes share any point (touching edges do not). */
export function intersects(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** R5b's box sizes and placement inside the canvas less the margin, for one measure. */
function boxTools(sim: SceneSim, measure: (text: string) => number) {
  const { padding, lineHeight, margin } = SCENE;
  const size = (lines: readonly string[]): { w: number; h: number } => ({
    w: Math.ceil(Math.max(0, ...lines.map(measure)) + 2 * padding),
    h: lines.length * lineHeight + 2 * padding,
  });
  const insideX = (x: number, w: number): number => Math.min(Math.max(x, margin), sim.width - margin - w);
  const insideY = (y: number, h: number): number => Math.min(Math.max(y, margin), sim.height - margin - h);
  const box = (
    handle: string,
    kind: SceneBox['kind'],
    left: number,
    top: number,
    lines: readonly string[],
    changed: number,
  ): SceneBox => {
    const { w, h } = size(lines);
    return { handle, kind, x: insideX(left, w), y: insideY(top, h), w, h, lines, changed };
  };
  return { size, box };
}

/**
 * R5b: one robot's own boxes standing where `robot` says — its work bubble above its antenna and its card above that,
 * or, when that stack would cross the canvas's top margin, both below its name label, the work bubble first, when they
 * fit there — else above, moved down to the top margin, where they may cover it (demo-scene-refresh R4); its speech bubble beside its head on its heading's side, below
 * the stack's nearest box — its work bubble, else its card — when the stack stands above it, so no two of them meet — each inside the canvas less the margin, before
 * any group moves out of another's way. `measure` gives a line's width in CSS px in SCENE.font.
 */
export function robotBoxes(
  sim: SceneSim,
  robot: Pick<SceneRobot, 'handle' | 'speech' | 'x' | 'y' | 'heading'>,
  measure: (text: string) => number,
): SceneBox[] {
  const { size, box } = boxTools(sim, measure);
  const { top, scale } = robotTop(sim, robot.y);
  const { group, aboveBottom } = stackBoxes(sim, robot, size, box);
  if (robot.speech !== null) {
    const { w, h } = size(robot.speech.lines);
    const left = robot.heading > 0 ? robot.x + 16 * scale : robot.x - 16 * scale - w;
    // Beside the head; below the robot's own stack when that stands above it, so they never meet.
    const y = aboveBottom === null ? top + 14 * scale - h : aboveBottom;
    group.push(box(robot.handle, 'speech', left, y, robot.speech.lines, robot.speech.changed));
  }
  return group;
}

/**
 * R5b's stack of one robot, its work bubble nearest the robot and its card beyond it: above its antenna when the stack
 * fits there inside the canvas's top margin, else below its name label (labelBox's bottom) when it fits there, so it
 * covers the robot only on a floor too short for either, where it stands above, moved down to the top margin
 * (demo-scene-refresh R4). `aboveBottom`: where a speech bubble below the stack starts when the stack stands above
 * the antenna — a gap under its nearest box, the work bubble, else the card; null when nothing stands above it.
 */
function stackBoxes(
  sim: SceneSim,
  robot: Pick<SceneRobot, 'handle' | 'x' | 'y'>,
  size: SizeFn,
  box: BoxFn,
): { readonly group: SceneBox[]; readonly aboveBottom: number | null } {
  const { gap, margin } = SCENE;
  const { antenna, scale } = robotTop(sim, robot.y);
  const work = sim.workBubble(robot.handle);
  const card = sim.cardBubble(robot.handle);
  const workSize = work === null ? null : size(work.lines);
  const cardSize = card === null ? null : size(card.lines);
  const workSpan = workSize === null ? 0 : workSize.h + gap;
  const height = workSpan + (cardSize?.h ?? 0) - (cardSize === null && workSize !== null ? gap : 0);
  const underLabel = robot.y + 4 * scale - 1 + Math.max(14, 13 * scale) + gap;
  // Above when it fits there; else below the label when it fits there; else — a floor too short for either, such as
  // R5a's stacked 300 px canvas — above, its bottom moved down to the top margin, as R5b had it: it may then cover the
  // robot (demo-scene-refresh R4).
  const fitsBelow = underLabel + height <= sim.height - margin;
  const above = antenna - gap - height >= margin || !fitsBelow;
  const aboveAt = Math.max(antenna - gap, margin + height);
  const group: SceneBox[] = [];
  if (work !== null && workSize !== null) {
    const y = above ? aboveAt - workSize.h : underLabel;
    group.push(box(robot.handle, 'work', robot.x - workSize.w / 2, y, work.lines, work.changed));
  }
  if (card !== null && cardSize !== null) {
    const y = above ? aboveAt - workSpan - cardSize.h : underLabel + workSpan;
    group.push(box(robot.handle, 'card', robot.x - cardSize.w / 2, y, card.lines, card.changed));
  }
  // The stack's nearest box — its work bubble, else its card — standing above: the speech starts a gap below it.
  const nearest = group[0];
  return { group, aboveBottom: above && nearest !== undefined ? nearest.y + nearest.h + gap : null };
}

type BoxFn = ReturnType<typeof boxTools>['box'];
type SizeFn = ReturnType<typeof boxTools>['size'];

/** The figure's speech group (R5b): a box beside the dock, when a user has posted and it has something to say. */
function figureSpeechGroup(sim: SceneSim, size: SizeFn, box: BoxFn): SceneBox[] | undefined {
  if (!sim.figure || sim.figureSpeech === null) return undefined;
  const s = sim.scale();
  const { h } = size(sim.figureSpeech.lines);
  return [
    box(
      'users',
      'speech',
      sim.dock.x + 12 * s,
      sim.dock.y - 34 * s - h,
      sim.figureSpeech.lines,
      sim.figureSpeech.changed,
    ),
  ];
}

/** The badge's speech group (R5b): a box beside it, when it stands for at least one agent and has something to say. */
function badgeSpeechGroup(sim: SceneSim, size: SizeFn, box: BoxFn): SceneBox[] | undefined {
  if (sim.badge() <= 0 || sim.badgeSpeech === null) return undefined;
  const b = sim.badgeAt();
  const { h } = size(sim.badgeSpeech.lines);
  return [
    box(
      'badge',
      'speech',
      b.x + 14 * sim.unit,
      b.y - 14 * sim.unit - h,
      sim.badgeSpeech.lines,
      sim.badgeSpeech.changed,
    ),
  ];
}

/** How far a group must move, up or down in steps of `gap`, to lie inside the canvas and meet no box already placed. */
function shiftFor(
  group: readonly SceneBox[],
  placed: readonly SceneBox[],
  gap: number,
  margin: number,
  height: number,
): number {
  const fits = (dy: number): boolean =>
    group.every(
      (b) =>
        b.y + dy >= margin &&
        b.y + b.h + dy <= height - margin &&
        !placed.some((p) => intersects({ ...b, y: b.y + dy }, p)),
    );
  if (fits(0)) return 0;
  for (let d = gap; d <= height; d += gap) {
    if (fits(-d)) return -d;
    if (fits(d)) return d;
  }
  return 0;
}

/**
 * R5b: every box the frame draws, placed — each shown robot's own boxes (robotBoxes; a gone robot's speech among them, R8); the figure's and the badge's
 * speech beside them; each moved inward to lie inside the canvas less the margin. Then each robot's boxes, as one group,
 * in the order they last changed (the newest last), move up — else down — in steps of the gap to the nearest place that
 * meets no box already placed, staying inside the canvas; a group with no such place keeps its own and is drawn over.
 * `measure` gives a line's width in CSS px in SCENE.font.
 */
export function layoutBubbles(sim: SceneSim, measure: (text: string) => number): SceneBox[] {
  const { gap, margin } = SCENE;
  const { size, box } = boxTools(sim, measure);
  const groups: SceneBox[][] = [];
  // A gone robot's speech stays with it (R8).
  for (const robot of sim.shown()) {
    const group = robotBoxes(sim, robot, measure);
    if (group.length > 0) groups.push(group);
  }
  const figureGroup = figureSpeechGroup(sim, size, box);
  if (figureGroup !== undefined) groups.push(figureGroup);
  const badgeGroup = badgeSpeechGroup(sim, size, box);
  if (badgeGroup !== undefined) groups.push(badgeGroup);
  // The newest group last: older ones keep their places, newer ones move out of their way.
  const newest = (g: readonly SceneBox[]): number => Math.max(...g.map((b) => b.changed));
  groups.sort((a, b) => newest(a) - newest(b));
  const placed: SceneBox[] = [];
  for (const group of groups) {
    const shift = shiftFor(group, placed, gap, margin, sim.height);
    for (const b of group) placed.push({ ...b, y: b.y + shift });
  }
  return placed.sort((a, b) => a.changed - b.changed);
}
