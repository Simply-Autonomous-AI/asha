// A pattern scenario's fixture (docs/plans/patterns-phase-1.md R3): the
// daemon's side of one conversation — the messages the channel carried, in
// order, and any other log record — turned into the records a checker reads,
// the way a real run produces them. The CLI's own ConversationTracker prints
// the conversation's events, as ./asha does, and parseTranscript reads the
// print back, as the agent suite does. The daemon's stream and log are
// modelled on src/daemon: an agent's message carries a working set that still
// holds it (it has not acked), the ack of the last one settles the
// conversation (a `status` event, working []), the harness's own "No agent
// could answer" reply is logged as `channel.no_reply` and settles at once, a
// call's question, answer and gather (the gather from the harness) are logged
// as `channel.posted` with the call's id and role, and `conversation.started`
// follows the input's `channel.posted`. An agent that leaves is an
// `agent_left` event where the fixture puts it. The conversation's deliveries
// (its asha.delivery spans) are derived as the daemon delivers, unless the
// fixture lists them; members' agent-log records and /workspace files are the
// fixture's own (patterns-phase-2 R3). Every generated log record is `info`.
// The bound is the pattern page's own (its run-command block), or the one
// given for a scenario with no page yet.
// Not modelled (no checker reads them; the rainbow's completion review,
// finding 10): working sets are each message's own, not cumulative; a
// fixture's extra log records (`channel.call_opened`, `channel.call_gathered`)
// follow every post rather than falling where the daemon logs them, carry the
// level the fixture gives them, and there is no `channel.call_outcome`.
// For phase 3 (docs/plans/patterns-phase-3.md R3, R9): a `{log}` entry among
// the messages is a daemon record placed there in the log's order, as the
// members' own records (`agent.*`) fall between the conversation's; an
// `{error}` entry is the harness ending the conversation, the stream's last
// event; an output may carry `asks`; and `next` holds a scenario's later
// commands, each posting its input into the same conversation (an answer,
// logged with `answers`: the last ask's id) and printed as a run of its own.
// A `{model}` entry is a model's tool call as the stream shows it (one
// `model_delta` of its arguments, then `model_done`), printed by the CLI's own
// DeltaPrinter, as `--verbose` prints it. For phase 4 (docs/plans/patterns-phase-4.md R7), `board` is the scenario's
// board entries as the control route reads them.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readRunBlock } from '../../../evals/patterns/run-block.js';
import { ConversationTracker } from '../../../src/cli/commands.js';
import { present } from '../../../src/shared/assert-present.js';
import { DeltaPrinter } from '../../../src/shared/lines.js';
import {
  HARNESS_HANDLE,
  type ConversationEvent,
  type ConversationMessage,
  type MessageKind,
} from '../../../src/shared/protocol.js';
import { parseTranscript, teamFiles } from '../support.js';
import type { LogRecord, ScenarioRecord } from './record.js';

const CHANNEL = 'main';
const CONVERSATION = 'c1';

/** An agent leaving the channel during the conversation (a delivery past its bound stops it: `agent_left`). */
interface FixtureDeparture {
  readonly leaves: string;
  readonly detail: string;
  /** Agents with an unacked delivery once it has left; omitted: none. */
  readonly working?: readonly string[];
}

/** One message the channel carried after the user's input. */
interface FixtureMessage {
  readonly from: string;
  /** Its addressee; omitted: everyone (null). An output's is the user. */
  readonly to?: string | null;
  readonly kind: Exclude<MessageKind, 'input'>;
  readonly text: string;
  /** Agents with an unacked delivery once it is posted; omitted: its sender alone. The harness's reply: []. */
  readonly working?: readonly string[];
  /** A call's question, answer or gather: its `channel.posted` record carries the call's id and the role, as the daemon's does. */
  readonly call?: { readonly id: string; readonly role: 'question' | 'answer' | 'gather' };
  /** An output that asks the user, leaving the conversation waiting for the answer (patterns-phase-3 R24). */
  readonly asks?: true;
}

/** A daemon record placed at this point of the log (an `agent.*` record, which carries no conversation). */
interface FixtureLog {
  readonly log: LogRecord;
}

/** The harness ends the conversation (patterns-phase-3 R18): the stream's `error` event, its last. */
interface FixtureError {
  readonly error: { readonly reason: string; readonly detail: string };
}

/** A model's tool call as the conversation's stream shows it: its arguments in one delta, then the call's end. */
interface FixtureModelCall {
  readonly model: { readonly handle: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> };
}

/** What the channel carried, and the log recorded, after a command's input, in order. */
type FixtureEntry = FixtureMessage | FixtureDeparture | FixtureLog | FixtureError | FixtureModelCall;

/** A later command of the scenario (patterns-phase-3 R9): the user's input into the same conversation, and what followed. */
interface FixtureCommand {
  readonly input: { readonly user: string; readonly to: string | null; readonly text: string };
  readonly recipients: readonly string[];
  readonly messages: readonly FixtureEntry[];
  /** The command's time; "bound+1" for one millisecond more than the pattern page's bound. */
  readonly ms: number | 'bound+1';
}

export interface Fixture {
  readonly scenario: string;
  /** The claim this fixture must fail, or null for the passing fixture. */
  readonly breaks: string | null;
  /** What was changed from the passing fixture, and why it must fail. */
  readonly note: string;
  /** The team folder whose files the record carries, teams/<team>/. */
  readonly team: string;
  /** Files to replace or add in the team's files, by path: a mutation of a recipe or a document. */
  readonly teamFiles?: Readonly<Record<string, string>>;
  /** The user's input; `topic` when it was posted to one (patterns-phase-3 R21). */
  readonly input: { readonly user: string; readonly to: string | null; readonly text: string; readonly topic?: string };
  /** The agents the input is delivered to. */
  readonly recipients: readonly string[];
  /** What the channel carried after the input, in order, any agent that left, and the members' own records. */
  readonly messages: readonly FixtureEntry[];
  /** The scenario's later commands, in order (patterns-phase-3 R9); omitted: none. */
  readonly next?: readonly FixtureCommand[];
  /** Other daemon log records of the conversation (a call opened, …), after its messages. */
  readonly log?: readonly LogRecord[];
  /** Members' own records logged before the input (an agent that joined first: patterns-phase-3, P19's mutation). */
  readonly before?: readonly LogRecord[];
  /**
   * The handles the conversation's deliveries went to (its asha.delivery spans); omitted: derived as the daemon
   * delivers — the input to its recipients, a message with an addressee to it, a gather to its caller, a call's
   * answer and a reply to no agent.
   */
  readonly deliveries?: readonly string[];
  /** Members' agent-log records, by handle. */
  readonly agentLogs?: Readonly<Record<string, readonly LogRecord[]>>;
  /** Files read from members' /workspace, by handle and path; null: absent. */
  readonly workspace?: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  /** The request's time; "bound+1" for one millisecond more than the pattern page's bound. */
  readonly ms: number | 'bound+1';
  /** The scenario's board entries as the control route reads them (patterns-phase-4 R7), in id order from 1; omitted: not read. */
  readonly board?: readonly { readonly author: string; readonly text: string }[];
}

/**
 * One entry's effect while walking a command's entries (extracted from `command` below for
 * `sonarjs/cognitive-complexity`, same logic, same order): true when it ends the conversation (an `{error}` entry).
 */
function applyEntry(
  f: FixtureEntry,
  fixture: Fixture,
  message: (m: {
    from: string;
    to: string | null;
    kind: MessageKind;
    text: string;
    asks?: true;
    topic?: string;
  }) => ConversationMessage,
  logOf: (m: ConversationMessage, call: FixtureMessage['call']) => LogRecord,
  log: LogRecord[],
  events: ConversationEvent[],
  deliveries: string[],
  onAsk: (id: string) => void,
  nextCall: () => string,
): boolean {
  if ('log' in f) {
    log.push(f.log);
    return false;
  }
  if ('error' in f) {
    events.push({ type: 'error', reason: f.error.reason as never, detail: f.error.detail });
    return true;
  }
  if ('model' in f) {
    const call = nextCall();
    events.push({
      type: 'model_delta',
      handle: f.model.handle,
      conversation: CONVERSATION,
      call,
      seq: 0,
      part: 'tool_args',
      index: 0,
      name: f.model.name,
      text: JSON.stringify(f.model.args),
    });
    events.push({ type: 'model_done', handle: f.model.handle, conversation: CONVERSATION, call, outcome: 'ok' });
    return false;
  }
  if ('leaves' in f) {
    events.push({
      type: 'agent_left',
      conversation: CONVERSATION,
      agent: f.leaves,
      detail: f.detail,
      working: f.working ?? [],
    });
    return false;
  }
  const m = message({
    from: f.from,
    to: f.kind === 'output' ? fixture.input.user : (f.to ?? null),
    kind: f.kind,
    text: f.text,
    ...(f.asks === true ? { asks: true as const } : {}),
  });
  log.push(logOf(m, f.call));
  if (m.asks === true) onAsk(m.id);
  if (m.kind === 'internal' && m.to !== null && f.call?.role !== 'answer') deliveries.push(m.to);
  events.push({ type: 'message', message: m, working: f.working ?? (m.from === HARNESS_HANDLE ? [] : [m.from]) });
  return false;
}

/** The page of the pattern a scenario belongs to: docs/patterns/pNN-*.md. */
function pageOf(root: string, scenario: string): string {
  const prefix = scenario.slice(0, 3);
  const pages = readdirSync(join(root, 'docs', 'patterns')).filter(
    (f) => f.startsWith(`${prefix}-`) && f.endsWith('.md'),
  );
  if (pages.length !== 1)
    throw new Error(`fixture ${scenario}: ${String(pages.length)} pages docs/patterns/${prefix}-*.md, not 1`);
  return `docs/patterns/${String(pages[0])}`;
}

/** The records a checker reads for this fixture, as a recorded run would give them, under its pattern page's bound. */
export function recordOf(fixture: Fixture, root: string): ScenarioRecord {
  return recordUnder(fixture, root, readRunBlock(pageOf(root, fixture.scenario), root).boundMs);
}

/** The records a checker reads for this fixture, under `boundMs` (recordOf gives it the pattern page's). */
function recordUnder(fixture: Fixture, root: string, boundMs: number): ScenarioRecord {
  let n = 0;
  const message = (m: {
    from: string;
    to: string | null;
    kind: MessageKind;
    text: string;
    asks?: true;
    topic?: string;
  }): ConversationMessage => ({
    id: `m${String(++n)}`,
    channel: CHANNEL,
    conversation: CONVERSATION,
    user: fixture.input.user,
    at: '2026-09-29T00:00:00.000Z',
    ...m,
  });
  const log: LogRecord[] = [];
  const deliveries: string[] = [];
  /** The last ask's message id: a later command's input answers it. */
  let lastAsk: string | undefined;
  let calls = 0;
  const logOf = (m: ConversationMessage, call: FixtureMessage['call']): LogRecord => {
    if (m.from === HARNESS_HANDLE && m.kind === 'output')
      return {
        level: 'info',
        event: 'channel.no_reply',
        channel: CHANNEL,
        conversation: CONVERSATION,
        to: m.to,
        agents: {},
      };
    if (m.kind === 'status')
      return {
        level: 'info',
        event: 'channel.status',
        channel: CHANNEL,
        from: m.from,
        conversation: CONVERSATION,
        text: m.text,
      };
    return {
      level: 'info',
      event: 'channel.posted',
      channel: CHANNEL,
      id: m.id,
      conversation: CONVERSATION,
      from: m.from,
      to: m.to,
      kind: m.kind,
      length: m.text.length,
      ...(call === undefined ? {} : { call: call.id, role: call.role }),
      ...(m.asks === true ? { asks: true } : {}),
      ...(m.topic === undefined ? {} : { topic: m.topic }),
    };
  };
  /** One command: its input and entries printed by the CLI's own tracker, its records added to the log in order. */
  const command = (
    input: Fixture['input'],
    recipients: readonly string[],
    entries: readonly FixtureEntry[],
    ms: number | 'bound+1',
    first: boolean,
  ) => {
    const posted = message({
      from: input.user,
      to: input.to,
      kind: 'input',
      text: input.text,
      ...(input.topic === undefined ? {} : { topic: input.topic }),
    });
    log.push({ ...logOf(posted, undefined), ...(first || lastAsk === undefined ? {} : { answers: lastAsk }) });
    if (first)
      log.push({
        level: 'info',
        event: 'conversation.started',
        channel: CHANNEL,
        conversation: CONVERSATION,
        recipe: null,
      });
    deliveries.push(...recipients);
    const events: ConversationEvent[] = [{ type: 'posted', message: posted, working: recipients }];
    let ended = false;
    for (const f of entries) {
      const entryEnded = applyEntry(
        f,
        fixture,
        message,
        logOf,
        log,
        events,
        deliveries,
        (id) => (lastAsk = id),
        () => `call-${String(++calls)}`,
      );
      if (entryEnded) ended = true;
    }
    // The last agent's ack: nobody is working any more (a conversation the harness ended has ended the stream already).
    if (!ended) events.push({ type: 'status', conversation: CONVERSATION, working: [] });
    let stderr = '';
    let stdout = '';
    const printer = new DeltaPrinter((s) => (stderr += s));
    const tracker = new ConversationTracker(
      printer.around({ stderr: (s) => (stderr += s), stdout: (s) => (stdout += s), progress: (s) => (stderr += s) }),
      { sameBuild: true, deltas: printer },
    );
    let code: number | undefined;
    for (const e of events) {
      code = tracker.handle(e);
      // The CLI stops reading once the conversation is settled, or the stream says it ended.
      if (code !== undefined) break;
    }
    if (code === undefined) throw new Error(`fixture ${fixture.scenario}: a command's conversation never settles`);
    return {
      args: [],
      code,
      stdout,
      events: parseTranscript(stderr, CHANNEL),
      ms: ms === 'bound+1' ? boundMs + 1 : ms,
    };
  };
  log.push(...(fixture.before ?? []));
  const runs = [
    command(fixture.input, fixture.recipients, fixture.messages, fixture.ms, true),
    ...(fixture.next ?? []).map((c) => command(c.input, c.recipients, c.messages, c.ms, false)),
  ];
  log.push(...(fixture.log ?? []).map((r) => ({ ...r, conversation: CONVERSATION })));
  return {
    scenario: fixture.scenario,
    run: present(runs[0], 'runs[0] (the fixture produced no run)'),
    runs,
    conversation: CONVERSATION,
    log,
    team: { ...teamFiles(fixture.team, root), ...(fixture.teamFiles ?? {}) },
    boundMs,
    deliveries: fixture.deliveries ?? deliveries,
    agentLogs: fixture.agentLogs ?? {},
    workspace: fixture.workspace ?? {},
    ...(fixture.board === undefined
      ? {}
      : {
          board: fixture.board.map((e, i) => ({
            id: i + 1,
            author: e.author,
            ts: '2026-10-03T00:00:00.000Z',
            text: e.text,
            session: 1,
          })),
        }),
  };
}
