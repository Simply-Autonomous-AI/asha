// Communication channels. Each named channel is its own set of agents and
// conversations. An agent joins under a base name it chose (`hewo`); the
// channel makes it unique by numbering (`hewo-1`, `hewo-2`, …, never reusing a
// number, so a message meant for a departed agent never reaches a newcomer).
//
// A message is delivered to everyone on the channel except its sender, or —
// when it is addressed `to` one agent — to that agent alone. Users have
// handles too (user-1, …); an `output` is addressed to the user who started
// the conversation and delivered to no agent. "Working" is
// exact: each delivery is pending until the agent acks it, and an agent is
// working on a conversation while it holds a pending delivery in it. Every
// delivery is bounded; an agent that exceeds the bound is reported through
// onDeliveryTimeout so the supervisor can stop it.
//
// Every conversation ends with an answer for the user. When no agent is
// working on it any more and none has replied, the harness replies itself,
// from HARNESS_HANDLE, saying what each agent that received it did: passed
// (with its reason), worked on it without replying, left, or timed out.
//
// Every conversation is one trace (docs/plans/otel-traces.md): its
// asha.conversation span runs from the input until its working set first
// empties, and each delivery's asha.delivery span from its creation to its
// ack, expiry, or its agent leaving.
//
// Calls (docs/plans/agent-calls.md): an agent holding a delivery consults one
// to ten named agents. The channel records the call, posts each addressee an
// `internal` question marked with it, records one outcome per addressee
// (answered, passed, timed out, left, unanswered), and once every addressee
// has one delivers exactly one gather — every outcome, in request order — to
// the caller, from HARNESS_HANDLE. While a call is open its caller counts as
// working; if the caller leaves, the call closes with no gather.
//
// A member whose agent its supervisor is restarting (docs/plans/patterns-phase-3.md
// R12) is suspended, not removed: it keeps its handle and every delivery it
// held, their bounds cleared; a delivery posted to it meanwhile is held, not
// sent; both count as working. When the restarted agent rejoins under the same
// handle and comes online, each held delivery is sent to it again, in posting
// order, carrying `restarted`, its bound starting then.
//
// The harness can end a conversation (R18): its watchers get one `error` event
// with the reason, and every later agent post, consult and answer in it is
// refused `conversation_ended`; deliveries already made run on, and it settles
// once nobody works on it, with no harness reply.
//
// In-memory and per daemon — all state lives in these instances (§10).

import {
  AGENT_FAILURE_STATUS,
  ASK_WINDOW_MS,
  CALL_MAX_DEPTH,
  agentBaseNameProblem,
  type ApprovedCall,
  CALL_MAX_ADDRESSEES,
  CALL_MAX_ANSWER_CHARS,
  HARNESS_HANDLE,
  ISSUED_USER_ID,
  NAME_PATTERN,
  USER_BASE,
  userIdProblem,
  type CallOutcome,
  type CallRefusalReason,
  type ConversationErrorReason,
  type Attachment,
  type CallRequest,
  type ReturnedFile,
  type ChannelMessage,
  type GatherAnswer,
  type TraceReason,
  type ConversationEvent,
  type ConversationMessage,
  type Delivery,
  type MessageKind,
  type ModelDeltaEvent,
  type ModelDoneEvent,
  type WatchEvent,
} from '../../shared/protocol.js';
import { traceIdFor } from '../../shared/trace-id.js';
import { present } from '../../shared/assert-present.js';
import { byCodeUnit } from '../../shared/order.js';
import type { Logger } from '../log.js';
import type { OpenSpan, Tracer } from '../traces/index.js';
import type { UserLedger } from './user-ledger.js';

export { FileUserLedger, UserLedgerCorrupt } from './user-ledger.js';

/** A post, ack or join that breaks the channel's rules. */
export class ChannelRequestInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelRequestInvalid';
  }
}

/**
 * A consult or a call's answer the channel refuses, posting and recording
 * nothing, with the reason the agent can act on (docs/plans/agent-calls.md R2,
 * R5, R6): the server answers it 409 {error, reason}.
 */
export class CallRefused extends ChannelRequestInvalid {
  constructor(
    /** Why it was refused: the reason the agent can act on. */
    readonly reason: CallRefusalReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'CallRefused';
  }
}

/** A user ID that breaks the naming rule or belongs to an agent — a malformed request, not a channel conflict. */
export class UserIdInvalid extends Error {
  constructor(
    /** The ID refused. */
    readonly id: string,
    reason: string,
  ) {
    super(`"${id}" cannot be a user ID: ${reason}`);
    this.name = 'UserIdInvalid';
  }
}

/** A user's message to a topic no online member subscribes to (patterns-phase-3 R22): nothing was posted. */
export class UnknownTopic extends Error {
  constructor(
    /** The channel the message was sent on. */
    readonly channel: string,
    /** The topic no online member subscribes to. */
    readonly topic: string,
  ) {
    super(`no agent on channel "${channel}" subscribes to topic "${topic}"`);
    this.name = 'UnknownTopic';
  }
}

/**
 * A user's answer to a conversation that is not waiting for it (docs/plans/patterns-phase-3.md R25): its detail says
 * which condition failed. Nothing was posted.
 */
export class NotAwaiting extends Error {
  constructor(
    /** Which condition failed. */
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'NotAwaiting';
  }
}

/** A message is addressed to a handle that is not on the channel. */
export class UnknownHandle extends ChannelRequestInvalid {
  constructor(
    /** The channel the message was sent on. */
    readonly channel: string,
    /** The handle that is not on it. */
    readonly handle: string,
  ) {
    super(`no agent "${handle}" on channel "${channel}"`);
    this.name = 'UnknownHandle';
  }
}

/** What a channel is made with: its name, its logger, clock and ids, and the hooks the supervisor answers. */
export interface ChannelProps {
  readonly name: string;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly newId: () => string;
  /** An agent held a delivery past its bound. The delivery is already cleared. */
  readonly onDeliveryTimeout: (channel: string, handle: string, delivery: Delivery) => void;
  /**
   * Bound on agent messages in one conversation, its posts budget when its message names none (docs/plans/patterns-phase-3.md
   * R15). Agents may delegate to each other at any point, so without it two agents could talk forever; the post past
   * the budget ends the conversation `budget_exceeded` and is refused (R16).
   */
  readonly maxAgentPostsPerConversation: number;
  /** Issued user IDs, so none is ever reused. */
  readonly users: UserLedger;
  /** Starts the conversation and delivery spans. */
  readonly tracer: Tracer;
}

/** A handle's membership of a channel: how its deliveries reach its agent, their bound, and what it subscribes to. */
export interface Member {
  readonly deliver: (delivery: Delivery) => void;
  readonly deliveryTimeoutMs: number;
  /** The topics it subscribes to (docs/plans/patterns-phase-3.md R20): a user's message to one of them reaches it. None when absent. */
  readonly topics?: readonly string[];
  /** Its recipe names `nestedCalls: true` (R33, R34): holding a call's question, it may consult others. Not when absent. */
  readonly nestedCalls?: boolean;
  /**
   * A persisted agent's journal (docs/plans/agent-persistence.md R9, R10): the channel records each delivery in it
   * before making it, hands the agent one delivery at a time, and releases the next only once the checkpoint that
   * follows an ack is promoted or has failed. Absent for an agent that does not persist.
   */
  readonly journal?: MemberJournal;
}

/** What a persisted member's journal is told, and asked, by the channel (R9 (a), R10). */
export interface MemberJournal {
  /**
   * Whether one more delivery of `message` fits the member's record of unsaved deliveries (R9 (a)): undefined when it
   * does, else the refusal's detail (the journal has logged `state.pending_full`). Asked for every persisted
   * recipient before anything is posted; the delivery id is the one the delivery will have.
   */
  fits(message: ConversationMessage, deliveryId: string): string | undefined;
  /** Records the accepted delivery; resolves once its entry is written and synced, or its write has failed (and been reported). */
  record(delivery: Delivery): Promise<void>;
  /** A re-sent delivery is about to be released (R9 (e)): its entry's attempts and new delivery id, written and synced. */
  resending(delivery: Delivery): Promise<void>;
  /** The agent acknowledged it: resolves once its checkpoint is promoted or has failed (R10). */
  acknowledged(delivery: Delivery): Promise<void>;
  /** It ended without an ack — the agent left, or it expired (R9 (c), (f)). */
  unacknowledged(delivery: Delivery, reason: 'agent_exited' | 'expired'): void;
  /** The agent left the channel, after its unacknowledged deliveries were reported (docs/plans/patterns-phase-5.md R3). */
  left(): void;
}

/** A user's message refused because a persisted recipient's record of unsaved deliveries is full (R9 (a)): nothing was posted. */
export class PendingFull extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'PendingFull';
  }
}

interface Pending {
  readonly handle: string;
  /** The delivery as last sent: a restart's re-send carries `restarted` (patterns-phase-3 R12). */
  delivery: Delivery;
  /**
   * Its bound's timer: started when it is made, or — for a persisted member — when it is released (R10); none while its
   * member is suspended, and started afresh at its re-send (patterns-phase-3 R12).
   */
  timer: NodeJS.Timeout | undefined;
  /** asha.delivery: ends at the ack, the expiry, or the agent leaving. */
  readonly span: OpenSpan;
  /** How many times a restart has sent it again (patterns-phase-3 R12). */
  resends: number;
}

/**
 * A persisted member's deliveries (R9, R10): accepted and waiting, in order; the one released to it; whether a
 * checkpoint is running; and whether releasing is held (a team launch not yet whole) or frozen (a stop begun).
 */
interface MemberQueue {
  readonly waiting: { readonly pending: Pending; state: 'recording' | 'recorded' | 'resend' }[];
  inHand: Pending | undefined;
  saving: Pending | undefined;
  held: boolean;
  frozen: boolean;
}

/** A re-sent input's entry, as the channel needs it (R9 (e)). */
export interface Resend {
  readonly originalMessage: string;
  readonly originalConversation: string;
  readonly user: string;
  readonly text: string;
  readonly savedAt: string;
  /** Whether the original was addressed to this agent; else to everyone. */
  readonly addressed: boolean;
}

type Watcher = (event: ConversationEvent) => void;

/** One open call (R3): from its consult until it is gathered or closed. */
interface CallState {
  readonly id: string;
  readonly conversation: string;
  readonly caller: string;
  readonly requests: readonly CallRequest[];
  /** The message the caller was handling — never a gather (R3). */
  readonly context: { readonly from: string; readonly text: string };
  /** One slot per addressee, in request order; undefined until its outcome is recorded (R7). */
  readonly outcomes: (GatherAnswer | undefined)[];
  /** When each question was posted, in ms. */
  readonly askedAt: number;
  /** asha.call: from the consult until the gather is delivered or the call closes (R12). */
  readonly span: OpenSpan;
  /** Answer posts still reserved from the conversation's budget (R11). */
  reserved: number;
  /**
   * A nested call's parent (docs/plans/patterns-phase-3.md R34): the call whose question its caller held when it
   * consulted, that question's asker, and the question's delivery, whose outcome the nested call's gather decides.
   */
  readonly parent?: { readonly id: string; readonly asker: string; readonly question: Delivery };
}

/** The first failing outcome's span reason (R12). */
const OUTCOME_REASON: Readonly<Record<Exclude<CallOutcome, 'answered' | 'passed'>, TraceReason>> = {
  timed_out: 'expired',
  left: 'agent_left',
  unanswered: 'unanswered',
};

/** A gather's counts, in the order R8 names them. */
const OUTCOME_ORDER: readonly CallOutcome[] = ['answered', 'passed', 'timed_out', 'left', 'unanswered'];
const OUTCOME_WORDS: Readonly<Record<CallOutcome, string>> = {
  answered: 'answered',
  passed: 'passed',
  timed_out: 'timed out',
  left: 'left',
  unanswered: 'unanswered',
};

/** The gather's text (R8): `Answers to <caller>'s call: ` and the non-zero counts, e.g. "8 answered, 1 passed.". */
export function gatherText(caller: string, answers: readonly GatherAnswer[]): string {
  const counts = OUTCOME_ORDER.map((o) => [o, answers.filter((a) => a.outcome === o).length] as const).filter(
    ([, n]) => n > 0,
  );
  const parts = counts.map(([o, n]) => `${String(n)} ${OUTCOME_WORDS[o]}`);
  return `Answers to ${caller}'s call: ${parts.join(', ')}.`;
}

/** What one addressee answered: its text, or its pass reason. */
export type CallAnswer = { readonly text: string } | { readonly pass: string };

/** A conversation's budget, fixed when its input is posted (patterns-phase-3 R15): its agent posts, and its model tokens or none. */
export interface ConversationBudget {
  readonly posts: number;
  readonly tokens: number | null;
}

interface ConversationState {
  readonly asker: string;
  /** Its budget (R15). */
  readonly budget: ConversationBudget;
  /** Model tokens its calls have used so far, counted only under a tokens budget (R17). */
  tokens: number;
  posts: number;
  /** Posts reserved by open calls for answers not yet given (R11): no other post may take them. */
  reserved: number;
  replied: boolean;
  /** An agent (not the harness) posted an output in it. */
  agentReplied: boolean;
  /** asha.conversation while it is open; undefined once the working set has first emptied. */
  span: OpenSpan | undefined;
  /** Agents that received a message in it, in order, with their last status or fate. */
  readonly involved: Map<string, string>;
  /** Nobody works on it and its asker has a reply (R9 (i)): whenSettled's callbacks have run. */
  settled: boolean;
  /** Set once when the harness ends it (patterns-phase-3 R18): every later agent post, consult and answer is refused. */
  ended: { readonly reason: ConversationErrorReason; readonly detail: string } | undefined;
  /** The ask it waits on for its user's answer (R24): at most one; cleared by the answer, the asker leaving, the window or the end. */
  waiting: AskWait | undefined;
}

/** An ask waiting for its user's answer (patterns-phase-3 R24). */
interface AskWait {
  /** The asking agent's handle. */
  readonly agent: string;
  /** The ask's message id and text. */
  readonly message: string;
  readonly text: string;
  readonly at: string;
  /** The ask's post span: the parent of the answer's delivery (R25). */
  readonly spanId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** What the harness tells the user when no agent replied: what each agent did. */
export function noReplyText(channel: string, involved: ReadonlyMap<string, string>): string {
  if (involved.size === 0) return `No agent on channel "${channel}" received this, so nobody could answer it.`;
  const lines = [...involved].map(([handle, last]) => {
    if (last.startsWith('pass: ')) return `- ${handle} passed: ${last.slice('pass: '.length)}`;
    if (last.startsWith('pass')) return `- ${handle} passed`;
    return `- ${handle} ${last}`;
  });
  return ['No agent could answer this:', ...lines].join('\n');
}

/** A message to post on the channel: who it is from, its kind and text, and where it goes. */
export interface PostProps {
  readonly from: string;
  readonly kind: MessageKind;
  readonly text: string;
  /** Required for agent posts; a user message starts its own conversation. */
  readonly conversation?: string;
  /** Deliver to this handle only. */
  readonly to?: string;
  /**
   * The sender's `post` span, from its `traceparent`: the parent of the
   * deliveries this message causes. Required on an agent's internal or output
   * message; the server has checked it names the conversation's trace.
   */
  readonly parentSpanId?: string;
  /** A user's input only: the files attached to it (docs/plans/agent-files.md R9), checked by the file spaces. */
  readonly attachments?: readonly Attachment[];
  /** An agent's output only: the files it returned (R12), copied out and checked by the file spaces. */
  readonly files?: readonly ReturnedFile[];
  /** A user's input only: its conversation's budget (patterns-phase-3 R15), each part defaulted when absent. */
  readonly budget?: { readonly posts?: number; readonly tokens?: number };
  /** A user's input only, never with `to`: the topic it is for, delivered to the members subscribed to it (R21). */
  readonly topic?: string;
  /** An agent's output only: it asks the user, and the conversation waits for their answer (R24). */
  readonly asks?: true;
}

/**
 * One named channel (docs/architecture/channel.md): its members and their handles, the conversations on it, each
 * delivery pending its acknowledgement, and the watchers it streams every event to.
 */
export class Channel {
  private readonly members = new Map<string, Member>();
  private readonly lastNumber = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  /**
   * Per conversation: the user who started it, agent posts so far, whether
   * the user has had a reply, and — for the harness's reply — each agent that
   * received a message in it, with the last thing it said or what became of it.
   */
  private readonly conversations = new Map<string, ConversationState>();
  /** Users online now — each with an open conversation — by ID, with how many they have open. */
  private readonly onlineUsers = new Map<string, number>();
  private readonly watchers = new Map<string, Set<Watcher>>();
  /** Open calls, by id (R3). A gathered or closed call is removed, so a later answer to it is refused call_closed. */
  private readonly calls = new Map<string, CallState>();
  private readonly channelWatchers = new Set<(event: WatchEvent) => void>();
  /** Persisted members' deliveries, by handle (R9, R10). */
  private readonly queues = new Map<string, MemberQueue>();
  /** Acknowledged deliveries of persisted members whose checkpoint is running: still working (R10). */
  private readonly saving = new Map<string, Pending>();
  /** whenSettled's callbacks, by conversation (R9 (i)). */
  private readonly settledCallbacks = new Map<string, (() => void)[]>();
  /** The conversation this run re-sends each original message in, by the original's id (R9 (e)). */
  private readonly resent = new Map<string, string>();
  /** The input of each conversation a re-send started, by conversation: a later member's re-send of it joins it. */
  private readonly resentInputs = new Map<string, ConversationMessage>();
  /** Members whose agent is being restarted (patterns-phase-3 R12): kept under their handle, their deliveries held. */
  private readonly suspended = new Set<string>();
  /** Question deliveries whose holder opened a nested call (R34): their ack records no outcome. */
  private readonly questionsWithChild = new Set<string>();
  /** Nested calls' gathers by delivery id (R35): the parent call's question whose outcome each decides. */
  private readonly nestedGathers = new Map<string, { readonly question: Delivery; readonly parent: string }>();

  constructor(private readonly props: ChannelProps) {}

  /** The channel's name. */
  get name(): string {
    return this.props.name;
  }

  /**
   * Joins under `<base>-<n>`, n one past the last number this base has had here. Returns the handle. A persisted
   * member (one with a journal) starts `held` when asked: nothing is released to it until release() (a team launch
   * not yet whole, R9 (e)).
   */
  join(base: string, member: Member, options: { readonly held?: boolean } = {}): string {
    const problem = agentBaseNameProblem(base);
    if (problem !== undefined) throw new ChannelRequestInvalid(problem);
    const n = (this.lastNumber.get(base) ?? 0) + 1;
    this.lastNumber.set(base, n);
    const handle = `${base}-${String(n)}`;
    this.members.set(handle, member);
    if (member.journal !== undefined)
      this.queues.set(handle, {
        waiting: [],
        inHand: undefined,
        saving: undefined,
        held: options.held === true,
        frozen: false,
      });
    this.props.logger.info('channel.joined', { channel: this.name, handle });
    this.notifyChannel({ type: 'agent_joined', agent: handle });
    return handle;
  }

  /** Releases a held persisted member: its waiting deliveries go out, one at a time (R9 (e)). */
  release(handle: string): void {
    const queue = this.queues.get(handle);
    if (queue === undefined) throw new Error(`release: ${handle} is not a persisted member of channel "${this.name}"`);
    queue.held = false;
    this.pump(handle);
  }

  /**
   * Suspends a member whose agent its supervisor is restarting (patterns-phase-3 R12): it stays on the channel under its
   * handle, every delivery it holds stays pending with its bound's timer cleared, and a delivery posted to it from now on
   * is held, not sent. Each counts as working. Suspending a suspended member changes nothing.
   */
  suspend(handle: string): void {
    const member = this.members.get(handle);
    if (member === undefined) throw new Error(`suspend: ${handle} is not on channel "${this.name}"`);
    if (member.journal !== undefined)
      throw new Error(
        `suspend: ${handle} persists its deliveries; a restart never handles them (patterns-phase-3 R10)`,
      );
    if (this.suspended.has(handle)) return;
    this.suspended.add(handle);
    let held = 0;
    for (const p of this.pending.values()) {
      if (p.handle !== handle) continue;
      clearTimeout(p.timer);
      p.timer = undefined;
      held += 1;
    }
    this.props.logger.info('channel.suspended', { channel: this.name, handle, held });
  }

  /** Whether a member is suspended (R12). */
  isSuspended(handle: string): boolean {
    return this.suspended.has(handle);
  }

  /**
   * A restarted agent's new connection takes its suspended member's place under the same handle (R12): never `join`,
   * which numbers anew. It stays suspended — nothing is sent to it — until resume(). Returns the handle.
   */
  rejoin(handle: string, member: Member): string {
    if (!this.suspended.has(handle) || !this.members.has(handle))
      throw new ChannelRequestInvalid(`${handle} is not a suspended member of channel "${this.name}"`);
    if (member.journal !== undefined)
      throw new Error(`rejoin: ${handle} cannot persist its deliveries (patterns-phase-3 R10)`);
    this.members.set(handle, member);
    this.props.logger.info('channel.rejoined', { channel: this.name, handle });
    return handle;
  }

  /**
   * Ends a member's suspension once its restarted agent is online (R12): each delivery it holds is sent to it again, in
   * posting order, carrying `restarted: {attempt}`, its bound starting now. Returns how many were sent.
   */
  resume(handle: string, attempt: number): number {
    if (!this.suspended.has(handle)) throw new Error(`resume: ${handle} is not suspended on channel "${this.name}"`);
    const member = this.members.get(handle);
    if (member === undefined) throw new Error(`resume: ${handle} is not on channel "${this.name}"`);
    this.suspended.delete(handle);
    const held = [...this.pending.entries()].filter(([, p]) => p.handle === handle);
    for (const [id, p] of held) {
      p.resends += 1;
      p.delivery = { ...p.delivery, message: { ...p.delivery.message, restarted: { attempt } } };
      p.timer = setTimeout(() => {
        this.expire(id);
      }, member.deliveryTimeoutMs);
      member.deliver(p.delivery);
    }
    this.props.logger.info('channel.resumed', { channel: this.name, handle, attempt, redelivered: held.length });
    return held.length;
  }

  /** The most times a restart has re-sent any delivery `handle` holds; 0 when it holds none (R12's re-send cap). */
  mostResent(handle: string): number {
    return Math.max(0, ...[...this.pending.values()].filter((p) => p.handle === handle).map((p) => p.resends));
  }

  /** The conversations in which `handle` holds a delivery, in the order of its first one (R13). */
  heldConversations(handle: string): string[] {
    return [
      ...new Set(
        [...this.pending.values()].filter((p) => p.handle === handle).map((p) => p.delivery.message.conversation),
      ),
    ];
  }

  /**
   * The harness ends a conversation (patterns-phase-3 R18), once: `channel.conversation_ended` at error — the channel,
   * the conversation, the reason and the detail, never a message's text or its user — and one `error` event to every
   * watcher of it. From then every agent post (statuses included), consult and answer in it is refused
   * `conversation_ended`, posting nothing; deliveries already made run on; it settles once nobody works on it, and the
   * harness posts no reply in it. A second end changes nothing.
   */
  end(conversation: string, reason: ConversationErrorReason, detail: string): void {
    const state = this.conversations.get(conversation);
    if (state === undefined) throw new Error(`end: unknown conversation ${conversation}`);
    if (state.ended !== undefined) return;
    state.ended = { reason, detail };
    this.endWait(state);
    // The facade's `error` says the same, so the 3am query reads it as any error's: no message text, no user (R18).
    this.props.logger.error('channel.conversation_ended', {
      channel: this.name,
      conversation,
      reason,
      detail,
      error: new Error(`${reason}: ${detail}`),
    });
    this.notify(conversation, { type: 'error', reason, detail });
    this.conclude(conversation);
    this.settleIfDone(conversation);
  }

  /** Whether the harness has ended a conversation (R18). */
  isEnded(conversation: string): boolean {
    return this.conversations.get(conversation)?.ended !== undefined;
  }

  /** A conversation's budget from its message's (R15): posts its value or else maxAgentPostsPerConversation, tokens its value or else none. */
  private budgetOf(given: PostProps['budget']): ConversationBudget {
    return { posts: given?.posts ?? this.props.maxAgentPostsPerConversation, tokens: given?.tokens ?? null };
  }

  /** A conversation's budget, or undefined for a conversation this channel does not hold. */
  budgetOfConversation(conversation: string): ConversationBudget | undefined {
    return this.conversations.get(conversation)?.budget;
  }

  /**
   * A model call of the conversation used `tokens` (R17): added to its total when it has a tokens budget; when the total
   * passes the budget the conversation ends `budget_exceeded`. In memory, no I/O.
   */
  spend(conversation: string, tokens: number): void {
    const state = this.conversations.get(conversation);
    if (state === undefined) throw new Error(`spend: unknown conversation ${conversation}`);
    if (state.budget.tokens === null) return;
    state.tokens += tokens;
    if (state.tokens > state.budget.tokens)
      this.end(
        conversation,
        'budget_exceeded',
        `conversation ${conversation} used ${String(state.tokens)} tokens of its budget of ${String(state.budget.tokens)}`,
      );
  }

  /** Refuses an agent's post, consult or answer in a conversation the harness has ended (R18), posting nothing. */
  private refuseIfEnded(conversation: string, who: string, what: string): void {
    const ended = this.conversations.get(conversation)?.ended;
    if (ended !== undefined)
      throw new CallRefused(
        'conversation_ended',
        `conversation ${conversation} has ended (${ended.reason}): ${who}'s ${what} is not posted`,
      );
  }

  /**
   * From a stop's start, a persisted member is released nothing more (R10): a checkpoint promoted during the stop
   * releases nothing, and a delivery posted to it meanwhile is recorded and kept for the next run.
   */
  freeze(handle: string): void {
    const queue = this.queues.get(handle);
    if (queue !== undefined) queue.frozen = true;
  }

  /** The delivery a persisted member holds released and unacknowledged, if any. */
  inHand(handle: string): Delivery | undefined {
    return this.queues.get(handle)?.inHand?.delivery;
  }

  /**
   * Brings a user online for one conversation and returns their ID: the one
   * they asked for, or else a new `user-<n>` never issued on this channel
   * (IDs are never reused; agents will keep memory keyed on them). Call the
   * returned release when their conversation closes.
   */
  claimUser(requested?: string): { readonly id: string; release(): void } {
    let id: string;
    if (requested !== undefined) {
      // user-<n>, or a name like "alice" with no -<number> ending — agent
      // handles are always <base>-<n>, so the two can never collide.
      // The shared rule (cli-interactive R16): a typed user-<n> is allowed, being the harness's own issued form.
      const problem = userIdProblem(requested, { isDefault: false });
      if (problem !== undefined) throw new UserIdInvalid(requested, problem);
      const isUserN = ISSUED_USER_ID.test(requested);
      id = requested;
      if (isUserN) this.props.users.observe(this.name, Number(requested.slice(USER_BASE.length + 1)));
    } else {
      id = `${USER_BASE}-${String(this.props.users.issue(this.name))}`;
    }
    this.onlineUsers.set(id, (this.onlineUsers.get(id) ?? 0) + 1);
    this.props.logger.info('channel.user_online', { channel: this.name, user: id });
    let released = false;
    return {
      id,
      release: () => {
        if (released) return;
        released = true;
        const open = (this.onlineUsers.get(id) ?? 1) - 1;
        if (open === 0) this.onlineUsers.delete(id);
        else this.onlineUsers.set(id, open);
      },
    };
  }

  /** The user a conversation belongs to (its asker), or undefined for a conversation this channel does not hold. */
  askerOf(conversation: string): string | undefined {
    return this.conversations.get(conversation)?.asker;
  }

  /** User IDs online now, sorted. */
  users(): string[] {
    return [...this.onlineUsers.keys()].sort(byCodeUnit);
  }

  /** Every member's handle, in code-unit order. */
  handles(): string[] {
    return [...this.members.keys()].sort(byCodeUnit);
  }

  /** Whether `handle` is a member of the channel now, online or suspended for its restart. */
  isMember(handle: string): boolean {
    return this.members.has(handle);
  }

  /**
   * The harness's word that `handle` is down (docs/plans/demo-scene-refresh.md R6, R16): online, it went offline
   * without a stop being begun (AGENT_FAILURE_STATUS, the default), or its restart is under way, failed or reached its
   * limit (`text`). A status from it outside any conversation, marked `failure`, to the channel's watchers only, as every
   * status — never delivered to an agent, counted toward no bound. Called while it is a member, suspended or not.
   */
  failed(handle: string, text: string = AGENT_FAILURE_STATUS): ChannelMessage {
    return this.postStatus({ from: handle, kind: 'status', text }, true);
  }

  /**
   * Removes an agent and clears its pending deliveries; watchers see it leave.
   * A call question it held gets the outcome `left` (which may complete a
   * call and deliver its gather); a call it opened is closed (R19).
   */
  leave(handle: string, detail: string): void {
    const member = this.members.get(handle);
    if (!this.members.delete(handle)) return;
    this.suspended.delete(handle);
    const { affected, questions, unacknowledged, parentQuestions } = this.clearPendingOf(handle);
    // A persisted member's deliveries that ended without an ack: its journal decides what becomes of their entries (R9 (c)).
    this.queues.delete(handle);
    // Its asks wait no longer (R24): an answer to one is refused not_awaiting.
    for (const state of this.conversations.values()) if (state.waiting?.agent === handle) this.endWait(state);
    for (const delivery of unacknowledged) member?.journal?.unacknowledged(delivery, 'agent_exited');
    member?.journal?.left();
    for (const conversation of affected)
      this.conversations.get(conversation)?.involved.set(handle, `left the channel before replying (${detail})`);
    this.props.logger.info('channel.left', { channel: this.name, handle, detail, abandoned: [...affected] });
    this.notifyChannel({ type: 'agent_left', agent: handle, detail });
    this.closeCallsOf(handle, parentQuestions, affected);
    for (const delivery of [...questions, ...parentQuestions])
      this.recordOutcome(delivery, handle, { outcome: 'left', detail });
    // The harness's reply, if one is due, comes first: it already says the agent left and why, and a
    // watcher that stops at "nobody working" (as the CLI does) must not stop before seeing it.
    for (const conversation of affected) this.conclude(conversation);
    for (const conversation of this.watchers.keys()) {
      this.notify(conversation, {
        type: 'agent_left',
        conversation,
        agent: handle,
        detail,
        working: this.working(conversation),
      });
    }
    for (const conversation of affected) this.settleIfDone(conversation);
  }

  /**
   * Every pending delivery `handle` held, ended and dropped (`leave()`'s first act): the conversations it touched,
   * its call questions (for R19's outcome), every delivery left unacknowledged (for the journal), and the parent
   * questions of any nested gather it held.
   */
  private clearPendingOf(handle: string): {
    affected: Set<string>;
    questions: Delivery[];
    unacknowledged: Delivery[];
    parentQuestions: Delivery[];
  } {
    const affected = new Set<string>();
    const questions: Delivery[] = [];
    const unacknowledged: Delivery[] = [];
    /** Parent questions whose outcome is `left` (patterns-phase-3 R35): of a nested gather it held, or a nested call it opened. */
    const parentQuestions: Delivery[] = [];
    for (const [id, p] of this.pending) {
      if (p.handle !== handle) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.span.end({ status: 'error', reason: 'agent_left' });
      affected.add(p.delivery.message.conversation);
      if (p.delivery.message.call?.role === 'question') questions.push(p.delivery);
      const nested = this.nestedGathers.get(id);
      if (nested !== undefined) {
        this.nestedGathers.delete(id);
        parentQuestions.push(nested.question);
      }
      unacknowledged.push(p.delivery);
    }
    return { affected, questions, unacknowledged, parentQuestions };
  }

  /** Closes every call `handle` is the caller of (R19): a nested call's parent question joins `parentQuestions`. */
  private closeCallsOf(handle: string, parentQuestions: Delivery[], affected: Set<string>): void {
    for (const call of [...this.calls.values()]) {
      if (call.caller !== handle || !this.calls.has(call.id)) continue;
      this.closeCall(call);
      if (call.parent !== undefined) parentQuestions.push(call.parent.question);
      affected.add(call.conversation);
    }
  }

  /** Posts a message and delivers it: to `to` alone, or to every member but the sender. */
  post(props: PostProps): ChannelMessage {
    if (props.kind === 'status') return this.postStatus(props);
    return this.postToConversation(props);
  }

  /** Posts a user or agent message within a conversation, and delivers it. */
  postToConversation(props: PostProps): ConversationMessage {
    const { from, kind, text, to } = props;
    if (kind === 'status') throw new Error('status messages go through post()');
    const recipient =
      kind === 'input' ? this.inputRecipient(props, from, to) : this.agentRecipient(props, kind, from, to);
    this.validatePostShape(props, kind, to);
    this.assertValidTo(kind, from, to);
    const id = this.props.newId();
    const conversation = props.conversation ?? id;
    const message = this.buildMessage(id, conversation, from, kind, recipient, text, props);
    // A reply for the user goes to no agent; anything else goes to its addressee, or to every other agent — or, for a
    // topic, to every member subscribed to it, framed as a message to everyone (patterns-phase-3 R21).
    const topic = props.topic;
    const recipients = this.recipientsFor(kind, from, to, topic);
    // R22: nothing is posted to a topic no online member subscribes to.
    if (topic !== undefined && recipients.length === 0) throw new UnknownTopic(this.name, topic);
    // Each persisted recipient's record must hold one more entry, or nothing is posted (R9 (a)).
    const deliveryIds = this.admit(recipients, message, (detail) => this.refuseFor(kind, detail));
    this.registerPost(kind, id, conversation, from, props);
    this.logPosted(id, message, from, kind, text, topic, props.asks === true);
    this.notifyChannel({ type: 'message', message });

    const state = present(this.conversations.get(message.conversation), 'conversation, just posted into or created');
    if (kind === 'output') {
      state.replied = true;
      state.agentReplied = true;
    }
    if (props.asks === true) this.armAsk(state, conversation, id, from, text, message.at, props);
    // The input's deliveries are children of the conversation; an agent's, of the post that caused them.
    const parentSpanId =
      kind === 'input'
        ? present(state.span, "the conversation's span, set when it was begun").spanId
        : present(props.parentSpanId, "the agent message's post span, checked present by agentRecipient");
    recipients.forEach((handle, i) =>
      this.deliverTo(handle, message, parentSpanId, present(deliveryIds[i], 'a delivery id at this recipient index')),
    );
    if (kind !== 'input') {
      this.notify(message.conversation, { type: 'message', message, working: this.working(message.conversation) });
    }
    return message;
  }

  /** The recipient for a user's input: `to`, if given, else none — it always starts its own conversation. */
  private inputRecipient(props: PostProps, from: string, to: string | undefined): string | null {
    if (!this.onlineUsers.has(from) || props.conversation !== undefined) {
      throw new Error('an input comes from an online user and starts its own conversation');
    }
    return to ?? null;
  }

  /**
   * The recipient for an agent's message, once the conversation's rules are checked: the sender is on the channel,
   * the conversation exists and carries its post span, the harness has not ended it (R18), the sender is not
   * answering only through the call-answer route (R6), no ask is already open (R24), and the conversation's post
   * budget has room (R16). An output always goes to the asker; anything else goes to `to` or none.
   */
  private agentRecipient(props: PostProps, kind: MessageKind, from: string, to: string | undefined): string | null {
    if (!this.members.has(from)) throw new ChannelRequestInvalid(`${from} is not on channel "${this.name}"`);
    const state = props.conversation === undefined ? undefined : this.conversations.get(props.conversation);
    if (state === undefined) throw new ChannelRequestInvalid(`unknown conversation ${String(props.conversation)}`);
    const conversation = present(props.conversation, 'props.conversation, since state was found by it above');
    // A harness defect, not a bad request: the server requires the sender's traceparent first.
    if (props.parentSpanId === undefined) throw new Error(`an agent's ${kind} message carries its post span`);
    this.refuseIfEnded(conversation, from, kind);
    this.assertNotCallAnswerOnly(conversation, from);
    this.assertAskNotOpen(conversation, props.asks === true, state);
    this.enforcePostBudget(conversation, from, kind, state);
    if (kind === 'output') {
      if (to !== undefined)
        throw new ChannelRequestInvalid('an output always goes to the user who asked; it takes no "to"');
      return state.asker;
    }
    return to ?? null;
  }

  /** R6: in a call turn an agent answers only through the answer route. */
  private assertNotCallAnswerOnly(conversation: string, from: string): void {
    const held = [...this.pending.values()].filter(
      (p) => p.handle === from && p.delivery.message.conversation === conversation,
    );
    if (
      held.length > 0 &&
      held.every((p) => p.delivery.message.call?.role === 'question' || this.nestedGathers.has(p.delivery.deliveryId))
    ) {
      throw new CallRefused(
        'call_answer_only',
        `${from} holds only call questions in conversation ${conversation}: it answers through the answer route`,
      );
    }
  }

  /** R24: one ask waits at a time; a second is refused, nothing posted. */
  private assertAskNotOpen(conversation: string, asks: boolean, state: ConversationState): void {
    if (asks && state.waiting !== undefined) {
      throw new CallRefused(
        'ask_open',
        `conversation ${conversation} already waits for the user's answer to ${state.waiting.agent}'s ask ${state.waiting.message}`,
      );
    }
  }

  /** R16: the post past the conversation's posts budget is not posted; the conversation ends, and the post is refused. */
  private enforcePostBudget(conversation: string, from: string, kind: MessageKind, state: ConversationState): void {
    if (state.posts + state.reserved >= state.budget.posts) {
      // Open calls' answers hold posts of the budget (agent-calls R11): the detail says so when they do (R16, amended).
      const held = state.reserved === 0 ? '' : ` (${String(state.reserved)} of them reserved for open calls' answers)`;
      this.end(
        conversation,
        'budget_exceeded',
        `conversation ${conversation} reached its budget of ${String(state.budget.posts)} agent posts${held}`,
      );
      this.refuseIfEnded(conversation, from, kind);
    }
  }

  /** The shape rules every post must satisfy: attachments, a budget and a topic are a user's input alone to carry; returned files and an ask are an agent's output alone. */
  private validatePostShape(props: PostProps, kind: MessageKind, to: string | undefined): void {
    if (props.attachments !== undefined && kind !== 'input') throw new Error("only a user's input carries attachments");
    if (props.budget !== undefined && kind !== 'input') throw new Error("only a user's input carries a budget");
    if (props.topic !== undefined && (kind !== 'input' || to !== undefined))
      throw new Error("only a user's input to no one agent carries a topic");
    if (props.files !== undefined && kind !== 'output') throw new Error('only an output carries returned files');
    if (props.asks !== undefined && kind !== 'output') throw new Error("only an agent's output asks the user");
  }

  /** An explicit "to" on anything but an output must name an online member other than the sender. */
  private assertValidTo(kind: MessageKind, from: string, to: string | undefined): void {
    if (kind !== 'output' && to !== undefined) {
      if (!this.members.has(to)) throw new UnknownHandle(this.name, to);
      if (to === from) throw new ChannelRequestInvalid(`${from} cannot address a message to itself`);
    }
  }

  /** The message record itself: its kind-dependent `user`, optional attachments/files/topic/asks, and its timestamp. */
  private buildMessage(
    id: string,
    conversation: string,
    from: string,
    kind: MessageKind,
    recipient: string | null,
    text: string,
    props: PostProps,
  ): ConversationMessage {
    return {
      id,
      channel: this.name,
      conversation,
      // Whose conversation this is, set by the channel alone and carried on every message in it.
      user: kind === 'input' ? from : present(this.conversations.get(conversation), 'conversation').asker,
      from,
      to: recipient,
      kind,
      text,
      at: this.props.clock().toISOString(),
      ...(props.attachments === undefined ? {} : { attachments: props.attachments }),
      ...(props.files === undefined ? {} : { files: props.files }),
      ...(props.topic === undefined ? {} : { topic: props.topic }),
      ...(props.asks === true ? { asks: true as const } : {}),
    };
  }

  /** The message's deliverees: `to` alone, or every member but the sender — narrowed to a topic's subscribers, if any. */
  private recipientsFor(kind: MessageKind, from: string, to: string | undefined, topic: string | undefined): string[] {
    if (kind === 'output') return [];
    if (to !== undefined) return [to];
    return [...this.members.entries()]
      .filter(([h, m]) => h !== from && (topic === undefined || (m.topics ?? []).includes(topic)))
      .map(([h]) => h);
  }

  /** The error `admit()` refuses an oversubscribed recipient with: a user's input is refused full, an agent's message pending_full. */
  private refuseFor(kind: MessageKind, detail: string): Error {
    return kind === 'input' ? new PendingFull(detail) : new CallRefused('pending_full', detail);
  }

  /** The side effect proper to each kind once its message is admitted: an agent post counted, or a new conversation begun. */
  private registerPost(kind: MessageKind, id: string, conversation: string, from: string, props: PostProps): void {
    if (kind !== 'input') present(this.conversations.get(conversation), 'conversation').posts += 1;
    if (kind === 'input') this.startConversation(id, from, props);
  }

  /** A user's input opens its conversation: its own asha.conversation span, its budget, and state empty of posts so far. */
  private startConversation(id: string, from: string, props: PostProps): void {
    const span = this.props.tracer.start({
      name: 'asha.conversation',
      traceId: traceIdFor(id),
      parentSpanId: null,
      channel: this.name,
      handle: HARNESS_HANDLE,
    });
    this.conversations.set(id, {
      asker: from,
      budget: this.budgetOf(props.budget),
      tokens: 0,
      posts: 0,
      reserved: 0,
      replied: false,
      agentReplied: false,
      span,
      involved: new Map(),
      settled: false,
      ended: undefined,
      waiting: undefined,
    });
  }

  /** Logs a post exactly as channel.posted records it (never the message's text, only its length). */
  private logPosted(
    id: string,
    message: ConversationMessage,
    from: string,
    kind: MessageKind,
    text: string,
    topic: string | undefined,
    asks: boolean,
  ): void {
    this.props.logger.info('channel.posted', {
      channel: this.name,
      id,
      conversation: message.conversation,
      from,
      to: message.to,
      kind,
      length: text.length,
      ...(topic === undefined ? {} : { topic }),
      ...(asks ? { asks: true } : {}),
    });
  }

  /** R24: the conversation waits for its user's answer, for at most ASK_WINDOW_MS. */
  private armAsk(
    state: ConversationState,
    conversation: string,
    id: string,
    from: string,
    text: string,
    at: string,
    props: PostProps,
  ): void {
    const spanId = present(props.parentSpanId, "the ask's post span, checked present by agentRecipient");
    const timer = setTimeout(() => {
      if (state.waiting?.message !== id) return;
      state.waiting = undefined;
      this.props.logger.info('channel.ask_expired', {
        channel: this.name,
        conversation,
        agent: from,
        ask: id,
        windowMs: ASK_WINDOW_MS,
      });
    }, ASK_WINDOW_MS);
    state.waiting = { agent: from, message: id, text, at, spanId, timer };
  }

  /**
   * One delivery id per recipient, minted now; and for each persisted recipient, whether its record of unsaved
   * deliveries holds one more entry (R9 (a)) — the first that does not throws `refuse(detail)`, before anything is
   * posted or recorded.
   */
  private admit(
    recipients: readonly string[],
    message: ConversationMessage,
    refuse: (detail: string) => Error,
  ): string[] {
    const ids = recipients.map(() => this.props.newId());
    recipients.forEach((handle, i) => {
      const detail = this.members.get(handle)?.journal?.fits(message, present(ids[i], 'an id at this recipient index'));
      if (detail !== undefined) throw refuse(detail);
    });
    return ids;
  }

  /**
   * Creates one delivery of `message` to a member, bounded by its delivery timeout, as an asha.delivery child of
   * `parentSpanId`. To an agent that does not persist it is made at once, its bound starting now. To a persisted
   * one it waits in the member's queue: its entry is recorded first, and it is released — its bound starting then —
   * only when the member holds no other delivery and no checkpoint is running (R9 (a), R10). A re-sent one is put
   * at the front of the queue, its entry updated at its release (R9 (e)).
   */
  private deliverTo(
    handle: string,
    message: ConversationMessage,
    parentSpanId: string,
    deliveryId: string,
    resend = false,
  ): Delivery {
    const state = present(this.conversations.get(message.conversation), 'conversation');
    if (!state.involved.has(handle)) state.involved.set(handle, 'received it but said nothing');
    const member = present(this.members.get(handle), `member ${handle}`);
    const span = this.props.tracer.start({
      name: 'asha.delivery',
      traceId: traceIdFor(message.conversation),
      parentSpanId,
      channel: this.name,
      handle,
    });
    const delivery: Delivery = { deliveryId, message, traceparent: span.traceparent };
    const pending: Pending = { handle, delivery, timer: undefined, span, resends: 0 };
    this.pending.set(delivery.deliveryId, pending);
    // A suspended member's delivery is held, with no bound, until its restarted agent resumes (patterns-phase-3 R12).
    if (this.suspended.has(handle)) return delivery;
    const queue = this.queues.get(handle);
    if (member.journal === undefined || queue === undefined) {
      pending.timer = setTimeout(() => {
        this.expire(delivery.deliveryId);
      }, member.deliveryTimeoutMs);
      member.deliver(delivery);
      return delivery;
    }
    if (resend) {
      // Ahead of every delivery that is not itself a re-send, behind the re-sends queued before it (R9 (e)).
      const at = queue.waiting.findIndex((w) => w.state !== 'resend');
      queue.waiting.splice(at < 0 ? queue.waiting.length : at, 0, { pending, state: 'resend' });
      this.pump(handle);
      return delivery;
    }
    const waiting = { pending, state: 'recording' as 'recording' | 'recorded' | 'resend' };
    queue.waiting.push(waiting);
    // The record's write is asynchronous (it fsyncs); the delivery is released only once it has resolved.
    void member.journal.record(delivery).then(
      () => {
        waiting.state = 'recorded';
        this.pump(handle);
      },
      (error: unknown) => {
        // The journal reports its own write failures and resolves; a rejection is a defect, said, and the delivery still made.
        this.props.logger.error('channel.journal_failed', { channel: this.name, handle, deliveryId, error });
        waiting.state = 'recorded';
        this.pump(handle);
      },
    );
    return delivery;
  }

  /**
   * Releases a persisted member's next waiting delivery when it may have one: not held or frozen, no delivery in
   * hand, no checkpoint running, and the next one recorded (R10). Its bound starts now. A re-send's entry is
   * updated and synced first (R9 (e)).
   */
  private pump(handle: string): void {
    const queue = this.queues.get(handle);
    const member = this.members.get(handle);
    if (queue === undefined || member?.journal === undefined) return;
    if (queue.held || queue.frozen || queue.inHand !== undefined || queue.saving !== undefined) return;
    const next = queue.waiting[0];
    if (next === undefined || next.state === 'recording') return;
    queue.waiting.shift();
    queue.inHand = next.pending;
    const go = (): void => {
      // It may have left, or its delivery been cleared, while the entry was written.
      if (this.pending.get(next.pending.delivery.deliveryId) !== next.pending || !this.members.has(handle)) return;
      next.pending.timer = setTimeout(() => {
        this.expire(next.pending.delivery.deliveryId);
      }, member.deliveryTimeoutMs);
      member.deliver(next.pending.delivery);
    };
    if (next.state !== 'resend') {
      go();
      return;
    }
    void member.journal.resending(next.pending.delivery).then(go, (error: unknown) => {
      this.props.logger.error('channel.journal_failed', {
        channel: this.name,
        handle,
        deliveryId: next.pending.delivery.deliveryId,
        error,
      });
      go();
    });
  }

  /** A new message in a conversation, logged (never its text) and shown to channel watchers. */
  private message(
    fields: Omit<ConversationMessage, 'id' | 'channel' | 'user' | 'at'>,
    id = this.props.newId(),
  ): ConversationMessage {
    const message: ConversationMessage = {
      id,
      channel: this.name,
      user: present(this.conversations.get(fields.conversation), 'conversation').asker,
      at: this.props.clock().toISOString(),
      ...fields,
    };
    this.props.logger.info('channel.posted', {
      channel: this.name,
      id: message.id,
      conversation: message.conversation,
      from: message.from,
      to: message.to,
      kind: message.kind,
      length: message.text.length,
      ...(message.call === undefined ? {} : { call: message.call.id, role: message.call.role }),
    });
    this.notifyChannel({ type: 'message', message });
    return message;
  }

  /** The conversation a pending delivery belongs to, if `handle` holds it; else refused not_holding_delivery. */
  heldConversation(handle: string, deliveryId: string): string {
    const p = this.pending.get(deliveryId);
    if (p === undefined || p.handle !== handle)
      throw new CallRefused('not_holding_delivery', `${handle} holds no delivery ${deliveryId}`);
    return p.delivery.message.conversation;
  }

  /**
   * Opens a call (R2, R3, R11): `caller`, holding `deliveryId`, asks each
   * addressee its text. Refused with a CallRefused, posting nothing, when the
   * caller does not hold the delivery, the delivery is itself a call question,
   * an addressee is unknown, the caller, or repeated, there are more than 10,
   * a text is empty, the caller already has a call open in the conversation,
   * or fewer than 2N agent posts remain. Otherwise it mints the call id,
   * posts one question to each addressee in request order, and returns them.
   * `parentSpanId` is the caller's post span: asha.call's parent.
   */
  openCall(
    caller: string,
    deliveryId: string,
    requests: readonly CallRequest[],
    parentSpanId: string,
  ): { readonly call: string; readonly messages: readonly ConversationMessage[] } {
    const p = this.pending.get(deliveryId);
    if (p === undefined || p.handle !== caller)
      throw new CallRefused('not_holding_delivery', `${caller} holds no delivery ${deliveryId}`);
    const held = p.delivery.message;
    const parent = this.parentCallFor(caller, deliveryId, held, p.delivery);
    if (requests.length > CALL_MAX_ADDRESSEES)
      throw new CallRefused(
        'too_many_addressees',
        `${String(requests.length)} addressees; a call has at most ${String(CALL_MAX_ADDRESSEES)}`,
      );
    this.validateCallRequests(caller, requests);
    const conversation = held.conversation;
    this.refuseIfEnded(conversation, caller, 'consult');
    this.assertNoOpenCall(caller, conversation);
    const state = present(this.conversations.get(conversation), 'conversation');
    const remaining = state.budget.posts - state.posts - state.reserved;
    if (remaining < 2 * requests.length) {
      throw new CallRefused(
        'post_budget',
        `a call of ${String(requests.length)} needs ${String(2 * requests.length)} of the conversation's agent posts; ${String(remaining)} remain`,
      );
    }
    // The context is always an input or an agent's non-call message: a gather's is its own context (R3).
    const context = held.call?.role === 'gather' ? held.call.context : { from: held.from, text: held.text };
    const id = this.props.newId();
    // Each persisted addressee's record must hold its question, or no call is opened (agent-persistence R9 (a)).
    const drafts = requests.map((request) => {
      const draft: ConversationMessage = {
        id: this.props.newId(),
        channel: this.name,
        conversation,
        user: state.asker,
        from: caller,
        to: request.to,
        kind: 'internal',
        text: request.text,
        at: this.props.clock().toISOString(),
        call: { id, role: 'question' },
      };
      return {
        draft,
        deliveryId: present(
          this.admit([request.to], draft, (detail) => new CallRefused('pending_full', detail))[0],
          "the one delivery id admit() mints for this request's sole recipient",
        ),
      };
    });
    const span = this.props.tracer.start({
      name: 'asha.call',
      traceId: traceIdFor(conversation),
      parentSpanId,
      channel: this.name,
      handle: caller,
    });
    const call: CallState = {
      id,
      conversation,
      caller,
      requests: requests.map(({ to, text }) => ({ to, text })),
      context,
      outcomes: requests.map(() => undefined),
      askedAt: this.props.clock().getTime(),
      span,
      reserved: requests.length,
      ...(parent === undefined ? {} : { parent }),
    };
    this.calls.set(id, call);
    if (parent !== undefined) this.questionsWithChild.add(deliveryId);
    state.posts += requests.length;
    state.reserved += requests.length;
    this.props.logger.info('channel.call_opened', {
      channel: this.name,
      conversation,
      call: id,
      caller,
      addressees: requests.map((r) => r.to),
      ...(parent === undefined ? {} : { parent: parent.id }),
    });
    const messages = call.requests.map((request, i) => {
      const draft = present(drafts[i], 'a draft at this request index');
      const message = this.message(
        {
          conversation,
          from: caller,
          to: request.to,
          kind: 'internal',
          text: request.text,
          call: { id, role: 'question' },
        },
        draft.draft.id,
      );
      this.deliverTo(request.to, message, span.spanId, draft.deliveryId);
      this.notify(conversation, { type: 'message', message, working: this.working(conversation) });
      return message;
    });
    return { call: id, messages };
  }

  /**
   * The nested-call parent for `openCall` (patterns-phase-3 R34): only when the held delivery is itself a call's
   * question — and then only a granted member's, of a call still at depth 1, never a nested gather's, which is
   * answered or passed, never consulted from (R35).
   */
  private parentCallFor(
    caller: string,
    deliveryId: string,
    held: ConversationMessage,
    delivery: Delivery,
  ): CallState['parent'] {
    if (held.call?.role !== 'question') {
      if (this.nestedGathers.has(deliveryId))
        throw new CallRefused(
          'nested_call',
          `delivery ${deliveryId} is a nested call's gather: its holder answers or passes`,
        );
      return undefined;
    }
    if (this.members.get(caller)?.nestedCalls !== true)
      throw new CallRefused(
        'nested_call',
        `delivery ${deliveryId} is a call's question: a callee answers or passes, and consults no one`,
      );
    const asked = this.calls.get(held.call.id);
    if (asked === undefined)
      throw new CallRefused(
        'nested_call',
        `delivery ${deliveryId} is a question of call ${held.call.id}, which is closed`,
      );
    if (asked.parent !== undefined)
      throw new CallRefused(
        'nested_call',
        `delivery ${deliveryId} is a question of a call at depth ${String(CALL_MAX_DEPTH)}: no deeper call is opened`,
      );
    return { id: asked.id, asker: held.from, question: delivery };
  }

  /** Each request is refused, nothing opened, for self-addressing, an unknown or duplicate "to", or empty text. */
  private validateCallRequests(caller: string, requests: readonly CallRequest[]): void {
    const seen = new Set<string>();
    for (const { to, text } of requests) {
      if (to === caller) throw new CallRefused('self_addressed', `${caller} cannot consult itself`);
      if (!this.members.has(to)) throw new CallRefused('unknown_handle', `no agent "${to}" on channel "${this.name}"`);
      if (seen.has(to)) throw new CallRefused('duplicate_addressee', `${to} is named more than once`);
      seen.add(to);
      if (text.trim() === '') throw new CallRefused('empty_text', `the request to ${to} has no text`);
    }
  }

  /** R2: one open call per caller per conversation; a second is refused, nothing opened. */
  private assertNoOpenCall(caller: string, conversation: string): void {
    for (const open of this.calls.values()) {
      if (open.caller === caller && open.conversation === conversation)
        throw new CallRefused(
          'call_open',
          `${caller} already has call ${open.id} open in conversation ${conversation}`,
        );
    }
  }

  /**
   * Records a callee's answer or pass (R5, R7), from the call question it
   * holds as `deliveryId` — the call, the caller and the conversation all come
   * from that delivery. An answer is posted `internal` from the callee to the
   * caller, marked with the call, and delivered to no agent; a pass is posted
   * as the callee's `pass: <reason>` status. If it is the call's last outcome,
   * the gather is delivered. Refused, recording nothing: not_holding_delivery,
   * not_a_call, answer_too_large (over 1,000 characters), call_closed (this
   * addressee's outcome is already recorded, or the call closed).
   */
  answerCall(callee: string, deliveryId: string, answer: CallAnswer): ConversationMessage {
    const p = this.pending.get(deliveryId);
    if (p === undefined || p.handle !== callee)
      throw new CallRefused('not_holding_delivery', `${callee} holds no delivery ${deliveryId}`);
    const mark = p.delivery.message.call;
    // A nested call's gather answers the question its holder was asked (patterns-phase-3 R35).
    const nested = this.nestedGathers.get(deliveryId);
    if (mark?.role !== 'question' && nested === undefined)
      throw new CallRefused('not_a_call', `delivery ${deliveryId} is not a call's question`);
    const callId =
      nested === undefined
        ? present(mark, "the delivery's call mark, since nested is undefined and mark.role was checked above").id
        : nested.parent;
    const question = nested === undefined ? p.delivery : nested.question;
    if ('text' in answer && answer.text.length > CALL_MAX_ANSWER_CHARS) {
      throw new CallRefused(
        'answer_too_large',
        `the answer is ${String(answer.text.length)} characters; at most ${String(CALL_MAX_ANSWER_CHARS)}`,
      );
    }
    this.refuseIfEnded(p.delivery.message.conversation, callee, 'answer');
    const call = this.calls.get(callId);
    const slot = call?.requests.findIndex((r) => r.to === callee);
    if (call === undefined || slot === undefined || slot < 0 || call.outcomes[slot] !== undefined) {
      throw new CallRefused('call_closed', `call ${callId} has ${callee}'s outcome already, or is closed`);
    }
    let posted: ConversationMessage;
    if ('text' in answer) {
      const state = present(this.conversations.get(call.conversation), 'conversation');
      // An answer draws only on its call's reservation (R11).
      call.reserved -= 1;
      state.reserved -= 1;
      state.posts += 1;
      const message = this.message({
        conversation: call.conversation,
        from: callee,
        to: call.caller,
        kind: 'internal',
        text: answer.text,
        call: { id: call.id, role: 'answer', outcome: 'answered' },
      });
      this.notify(call.conversation, { type: 'message', message, working: this.working(call.conversation) });
      posted = message;
      this.recordOutcome(question, callee, { outcome: 'answered', text: answer.text });
    } else {
      const status = this.postStatus({
        from: callee,
        kind: 'status',
        text: passStatusText(answer.pass),
        conversation: call.conversation,
      });
      if (status.conversation === null) throw new Error('a status posted in a conversation carries it');
      posted = status;
      this.recordOutcome(question, callee, { outcome: 'passed', reason: answer.pass });
    }
    return posted;
  }

  /**
   * Records an addressee's outcome from the question delivery it held, once
   * (a later one for the same addressee is ignored: the first recorded wins,
   * R7), and delivers the gather when it is the last. Called by the answer
   * route, ack (unanswered), expire (timed_out) and leave (left), each before
   * it reports the conversation's working set.
   */
  private recordOutcome(question: Delivery, addressee: string, outcome: Omit<GatherAnswer, 'from'>): void {
    const mark = question.message.call;
    if (mark?.role !== 'question')
      throw new Error(`recordOutcome on delivery ${question.deliveryId}, which is not a call question`);
    const call = this.calls.get(mark.id);
    if (call === undefined) return; // closed (R19): its outcomes are no longer recorded
    const slot = call.requests.findIndex((r) => r.to === addressee);
    if (slot < 0) throw new Error(`call ${call.id} has no addressee ${addressee}`);
    if (call.outcomes[slot] !== undefined) return;
    call.outcomes[slot] = { from: addressee, ...outcome };
    this.questionsWithChild.delete(question.deliveryId);
    this.props.logger.info('channel.call_outcome', {
      channel: this.name,
      conversation: call.conversation,
      call: call.id,
      addressee,
      outcome: outcome.outcome,
      ms: this.props.clock().getTime() - call.askedAt,
    });
    if (call.outcomes.every((o) => o !== undefined)) this.gather(call);
  }

  /** Delivers the one gather of a call to its caller and ends the call (R8, R11, R12). */
  private gather(call: CallState): void {
    // A caller that left closed its call (R19); a gather for one not on the channel is a harness defect.
    if (!this.members.has(call.caller))
      throw new Error(`call ${call.id}: a gather for ${call.caller}, who is not on channel "${this.name}"`);
    const answers = call.outcomes as readonly GatherAnswer[];
    this.calls.delete(call.id);
    this.releaseReservations(call);
    const failing = answers.find((a) => a.outcome !== 'answered' && a.outcome !== 'passed');
    const counts = Object.fromEntries(OUTCOME_ORDER.map((o) => [o, answers.filter((a) => a.outcome === o).length]));
    const fields = {
      channel: this.name,
      conversation: call.conversation,
      call: call.id,
      caller: call.caller,
      counts,
      ms: this.props.clock().getTime() - call.askedAt,
    };
    if (failing === undefined) this.props.logger.info('channel.call_gathered', fields);
    else this.props.logger.warn('channel.call_gathered', fields);
    const message = this.message({
      conversation: call.conversation,
      from: HARNESS_HANDLE,
      to: call.caller,
      kind: 'internal',
      text: gatherText(call.caller, answers),
      call: {
        id: call.id,
        role: 'gather',
        context: call.context,
        requests: call.requests,
        answers,
        ...(call.parent === undefined ? {} : { parent: { id: call.parent.id, asker: call.parent.asker } }),
      },
    });
    // The gather's delivery is a child of asha.call, which ends once it is delivered. It has no sender to refuse, so a
    // persisted caller's full record does not stop it: its journal delivers it unrecorded (agent-persistence R9 (a)).
    const deliveryId = this.props.newId();
    // A nested call's gather decides its parent question's outcome (patterns-phase-3 R35).
    if (call.parent !== undefined)
      this.nestedGathers.set(deliveryId, { question: call.parent.question, parent: call.parent.id });
    this.deliverTo(call.caller, message, call.span.spanId, deliveryId);
    call.span.end(
      failing === undefined
        ? { status: 'ok' }
        : { status: 'error', reason: OUTCOME_REASON[failing.outcome as keyof typeof OUTCOME_REASON] },
    );
    this.notify(call.conversation, { type: 'message', message, working: this.working(call.conversation) });
  }

  /** Closes a call whose caller left (R19): no gather, reservations released, asha.call error/agent_left. */
  private closeCall(call: CallState): void {
    if (!this.calls.delete(call.id)) return;
    this.releaseReservations(call);
    call.span.end({ status: 'error', reason: 'agent_left' });
    this.props.logger.warn('channel.call_closed', {
      channel: this.name,
      conversation: call.conversation,
      call: call.id,
      caller: call.caller,
      outcomes: call.requests.map((r, i) => ({ addressee: r.to, outcome: call.outcomes[i]?.outcome ?? null })),
    });
    // Its nested calls close with it, after it, no gather (patterns-phase-3 R36).
    for (const child of [...this.calls.values()]) if (child.parent?.id === call.id) this.closeCall(child);
  }

  /** Releases a call's answer reservations not drawn on (R11). */
  private releaseReservations(call: CallState): void {
    present(this.conversations.get(call.conversation), 'conversation').reserved -= call.reserved;
    call.reserved = 0;
  }

  /**
   * An agent's status: about itself (no conversation, e.g. "Hi") or
   * about its work in a conversation ("ok"). Shown to watchers of the
   * channel and the conversation; never delivered to agents, never counted
   * toward the agent-message bound. `failure` marks the harness's statuses
   * of an agent that is down, outside any conversation (`failed`).
   */
  private postStatus(props: PostProps, failure = false): ChannelMessage {
    const { from, text, to, conversation } = props;
    if (!this.members.has(from)) throw new ChannelRequestInvalid(`${from} is not on channel "${this.name}"`);
    if (to !== undefined) throw new ChannelRequestInvalid('a status message is not addressed to anyone');
    if (conversation !== undefined && !this.conversations.has(conversation)) {
      throw new ChannelRequestInvalid(`unknown conversation ${conversation}`);
    }
    if (conversation !== undefined) this.refuseIfEnded(conversation, from, 'status');
    const base = {
      id: this.props.newId(),
      channel: this.name,
      from,
      to: null,
      text,
      at: this.props.clock().toISOString(),
    };
    // Only the harness's own failure status, outside any conversation, is marked (Channel.failed).
    const message: ChannelMessage =
      conversation === undefined
        ? { ...base, kind: 'status', conversation: null, ...(failure ? { failure: true as const } : {}) }
        : {
            ...base,
            kind: 'status',
            conversation,
            user: present(this.conversations.get(conversation), 'conversation').asker,
          };
    this.props.logger.info('channel.status', { channel: this.name, from, conversation: message.conversation, text });
    if (message.conversation !== null) {
      const state = present(this.conversations.get(message.conversation), 'conversation');
      if (state.involved.has(from))
        state.involved.set(from, text === 'ok' ? 'worked on it but sent you no reply' : text);
    }
    this.notifyChannel({ type: 'message', message });
    if (message.conversation !== null) {
      this.notify(message.conversation, { type: 'message', message, working: this.working(message.conversation) });
    }
    return message;
  }

  /** `handle` acknowledges a delivery it holds, which ends it; refused when it holds no such delivery (agent-calls R7). */
  ack(handle: string, deliveryId: string): void {
    const p = this.pending.get(deliveryId);
    if (!p || p.handle !== handle) throw new ChannelRequestInvalid(`${handle} holds no delivery ${deliveryId}`);
    const queue = this.queues.get(handle);
    // A persisted member acks only the delivery released to it (R10): one it was never given is not its to ack.
    if (queue !== undefined && queue.inHand !== p)
      throw new ChannelRequestInvalid(`${handle} holds no delivery ${deliveryId}`);
    clearTimeout(p.timer);
    this.pending.delete(deliveryId);
    p.span.end({ status: 'ok' });
    // A call question acked with no answer or pass recorded: unanswered (R7).
    // A question whose holder opened a nested call has its outcome from that call's gather, not its ack (R34).
    if (p.delivery.message.call?.role === 'question' && !this.questionsWithChild.has(deliveryId))
      this.recordOutcome(p.delivery, handle, { outcome: 'unanswered' });
    const nested = this.nestedGathers.get(deliveryId);
    if (nested !== undefined) {
      this.nestedGathers.delete(deliveryId);
      this.recordOutcome(nested.question, handle, { outcome: 'unanswered' });
    }
    const conversation = p.delivery.message.conversation;
    const journal = this.members.get(handle)?.journal;
    if (queue === undefined || journal === undefined) {
      this.idled(conversation);
      return;
    }
    // A persisted member works on it until its checkpoint is promoted or has failed; only then is the conversation
    // idle and the member's next delivery released (R10).
    queue.inHand = undefined;
    queue.saving = p;
    this.saving.set(deliveryId, p);
    const saved = (): void => {
      this.saving.delete(deliveryId);
      const now = this.queues.get(handle);
      if (now?.saving === p) now.saving = undefined;
      this.idled(conversation);
      this.pump(handle);
    };
    void journal.acknowledged(p.delivery).then(saved, (error: unknown) => {
      // The journal reports a failed checkpoint itself and resolves; a rejection is a defect, said, and the member goes on.
      this.props.logger.error('channel.journal_failed', { channel: this.name, handle, deliveryId, error });
      saved();
    });
  }

  /**
   * What follows a change that may have left a conversation idle — an ack, an expiry, an agent leaving: the
   * harness's reply, if one is due, before the status that shows nobody working (so a watcher that stops at
   * "nobody working" has already seen it), and then, once settled, whenSettled's callbacks.
   */
  private idled(conversation: string): void {
    this.conclude(conversation);
    this.notify(conversation, { type: 'status', conversation, working: this.working(conversation) });
    this.settleIfDone(conversation);
  }

  /**
   * Calls `callback` exactly once, at the first moment nobody works on the conversation and its asker has had a
   * reply — an agent's, or the harness's own (R9 (i)); at once if that moment has passed. A settled conversation
   * is concluded: a later re-send of its message starts a new one (R9 (e)). Returns the function that drops it.
   */
  whenSettled(conversation: string, callback: () => void): () => void {
    const state = this.conversations.get(conversation);
    if (state === undefined) throw new Error(`whenSettled: unknown conversation ${conversation}`);
    if (state.settled) {
      callback();
      return () => undefined;
    }
    const list = this.settledCallbacks.get(conversation) ?? [];
    list.push(callback);
    this.settledCallbacks.set(conversation, list);
    return () => {
      const now = this.settledCallbacks.get(conversation);
      if (now !== undefined)
        this.settledCallbacks.set(
          conversation,
          now.filter((c) => c !== callback),
        );
    };
  }

  /**
   * Whether the conversation is unfinished but for the delivery `deliveryId` (docs/plans/patterns-phase-5.md R1): its
   * asker has had no reply and it has not ended, and some other work in it remains: a delivery to any agent not yet
   * acknowledged or still checkpointing. An open call always holds one — a question whose outcome is not yet recorded
   * is still pending, and its gather is pending once the last is — so calls need no test of their own (patterns-phase-5's
   * completion review, finding 4). False for a conversation this channel does not hold.
   */
  unfinishedWithout(conversation: string, deliveryId: string): boolean {
    const state = this.conversations.get(conversation);
    if (state === undefined || state.replied || state.ended !== undefined) return false;
    for (const [id, p] of [...this.pending, ...this.saving]) {
      if (id !== deliveryId && p.delivery.message.conversation === conversation) return true;
    }
    return false;
  }

  /** Whether an agent has replied to the conversation's asker (patterns-phase-5 R3): not the harness's own reply. */
  agentReplied(conversation: string): boolean {
    return this.conversations.get(conversation)?.agentReplied === true;
  }

  /** Whether a conversation has settled (R9 (i)). */
  isSettled(conversation: string): boolean {
    return this.conversations.get(conversation)?.settled === true;
  }

  private settleIfDone(conversation: string): void {
    const state = this.conversations.get(conversation);
    // An ended conversation settles once nobody works on it, with no reply (R18).
    if (
      state === undefined ||
      state.settled ||
      (!state.replied && state.ended === undefined) ||
      this.working(conversation).length > 0
    )
      return;
    state.settled = true;
    const callbacks = this.settledCallbacks.get(conversation) ?? [];
    this.settledCallbacks.delete(conversation);
    for (const callback of callbacks) callback();
  }

  /**
   * Re-sends users' inputs from before a restart to one persisted member (R9 (e)): each in its own new
   * conversation for the entry's user — who is not claimed online — addressed to this agent alone, or in the
   * conversation this run already re-sends the same original message in, while it has not settled. Queued ahead of
   * every other delivery to the member, in order, each released one at a time as any persisted delivery is. Returns
   * each one's conversation, in order.
   */
  redeliver(handle: string, resends: readonly Resend[]): { readonly conversation: string; readonly savedAt: string }[] {
    const member = this.members.get(handle);
    if (member?.journal === undefined || !this.queues.has(handle))
      throw new Error(`redeliver: ${handle} is not a persisted member of channel "${this.name}"`);
    return resends.map((resend) => {
      const existing = this.resent.get(resend.originalMessage);
      const joined = existing === undefined ? undefined : this.resentInputs.get(existing);
      let message: ConversationMessage;
      if (joined !== undefined && !present(this.conversations.get(joined.conversation), 'conversation').settled) {
        message = joined;
      } else {
        const id = this.props.newId();
        const span = this.props.tracer.start({
          name: 'asha.conversation',
          traceId: traceIdFor(id),
          parentSpanId: null,
          channel: this.name,
          handle: HARNESS_HANDLE,
        });
        this.conversations.set(id, {
          asker: resend.user,
          budget: this.budgetOf(undefined),
          tokens: 0,
          posts: 0,
          reserved: 0,
          replied: false,
          agentReplied: false,
          span,
          involved: new Map(),
          settled: false,
          ended: undefined,
          waiting: undefined,
        });
        message = {
          id,
          channel: this.name,
          conversation: id,
          user: resend.user,
          from: resend.user,
          // Framed as the original was: to this agent, or to everyone; delivered to this agent alone either way.
          to: resend.addressed ? handle : null,
          kind: 'input',
          text: resend.text,
          at: this.props.clock().toISOString(),
          redelivered: {
            savedAt: resend.savedAt,
            originalConversation: resend.originalConversation,
            originalMessage: resend.originalMessage,
          },
        };
        this.props.logger.info('channel.posted', {
          channel: this.name,
          id,
          conversation: id,
          from: resend.user,
          to: message.to,
          kind: 'input',
          length: resend.text.length,
          redelivered: true,
        });
        this.notifyChannel({ type: 'message', message });
        this.resent.set(resend.originalMessage, id);
        this.resentInputs.set(id, message);
      }
      const state = present(this.conversations.get(message.conversation), 'conversation');
      this.deliverTo(handle, message, present(state.span, "the conversation's span").spanId, this.props.newId(), true);
      return { conversation: message.conversation, savedAt: resend.savedAt };
    });
  }

  /**
   * asha's message giving an agent the result of the call its user approved (docs/plans/extension-modules.md R12 (d)):
   * the first message of a new conversation belonging to `user` — online or not, never claimed — from HARNESS_HANDLE,
   * of kind `internal`, addressed and delivered to `to` alone, carrying `approved`, which only the channel sets. Throws
   * UnknownHandle when `to` has left, and PendingFull when its record of unsaved deliveries is full: nothing is posted.
   */
  postApproved(props: {
    readonly to: string;
    readonly user: string;
    readonly text: string;
    readonly approved: ApprovedCall;
  }): ConversationMessage {
    if (!this.members.has(props.to)) throw new UnknownHandle(this.name, props.to);
    const id = this.props.newId();
    const message: ConversationMessage = {
      id,
      channel: this.name,
      conversation: id,
      user: props.user,
      from: HARNESS_HANDLE,
      to: props.to,
      kind: 'internal',
      text: props.text,
      at: this.props.clock().toISOString(),
      approved: props.approved,
    };
    const deliveryIds = this.admit([props.to], message, (detail) => new PendingFull(detail));
    const span = this.props.tracer.start({
      name: 'asha.conversation',
      traceId: traceIdFor(id),
      parentSpanId: null,
      channel: this.name,
      handle: HARNESS_HANDLE,
    });
    this.conversations.set(id, {
      asker: props.user,
      budget: this.budgetOf(undefined),
      tokens: 0,
      posts: 0,
      reserved: 0,
      replied: false,
      agentReplied: false,
      span,
      involved: new Map(),
      settled: false,
      ended: undefined,
      waiting: undefined,
    });
    // Its length, never its text: the text holds neither the arguments nor the result, and the field is not logged.
    this.props.logger.info('channel.posted', {
      channel: this.name,
      id,
      conversation: id,
      from: HARNESS_HANDLE,
      to: props.to,
      kind: 'internal',
      length: props.text.length,
      approved: props.approved.approval,
    });
    this.notifyChannel({ type: 'message', message });
    this.deliverTo(
      props.to,
      message,
      span.spanId,
      present(deliveryIds[0], 'the one delivery id admit() mints for props.to'),
    );
    return message;
  }

  /**
   * A user's answer to the ask a conversation waits on (docs/plans/patterns-phase-3.md R25): accepted only when the
   * conversation is this channel's, not ended, waiting, its asker is `from` (an online user) and the asking agent is
   * online; otherwise NotAwaiting, naming which failed, and nothing is posted. Posted as an `input` in that conversation
   * to the asking agent alone, carrying `answers` (the ask's id and text, set here alone), its delivery a child of the
   * ask's post span. The wait ends, and the conversation's reply state and its involved agents start afresh, so it ends
   * with an answer for the user as a new message does.
   */
  answer(props: { readonly from: string; readonly conversation: string; readonly text: string }): ConversationMessage {
    const { from, conversation, text } = props;
    if (!this.onlineUsers.has(from)) throw new Error('an answer comes from an online user');
    const state = this.conversations.get(conversation);
    if (state === undefined) throw new NotAwaiting(`conversation ${conversation} is not on channel "${this.name}"`);
    if (state.ended !== undefined)
      throw new NotAwaiting(`conversation ${conversation} has ended (${state.ended.reason})`);
    const wait = state.waiting;
    if (wait === undefined) throw new NotAwaiting(`conversation ${conversation} is not waiting for an answer`);
    if (state.asker !== from)
      throw new NotAwaiting(`conversation ${conversation} waits for ${state.asker}'s answer, not ${from}'s`);
    const id = this.props.newId();
    const message: ConversationMessage = {
      id,
      channel: this.name,
      conversation,
      user: from,
      from,
      to: wait.agent,
      kind: 'input',
      text,
      at: this.props.clock().toISOString(),
      answers: { ask: wait.message, text: wait.text },
    };
    const deliveryIds = this.admit([wait.agent], message, (detail) => new PendingFull(detail));
    this.endWait(state);
    // A new round: the answer ends with a reply for the user, as a new message does (R25).
    state.replied = false;
    state.agentReplied = false;
    state.settled = false;
    state.involved.clear();
    this.props.logger.info('channel.posted', {
      channel: this.name,
      id,
      conversation,
      from,
      to: wait.agent,
      kind: 'input',
      length: text.length,
      answers: wait.message,
    });
    this.notifyChannel({ type: 'message', message });
    this.deliverTo(
      wait.agent,
      message,
      wait.spanId,
      present(deliveryIds[0], 'the one delivery id admit() mints for wait.agent'),
    );
    return message;
  }

  /** The ask a conversation waits on, if any (R24): its agent, message id and text. */
  waitingOn(
    conversation: string,
  ): { readonly agent: string; readonly message: string; readonly text: string } | undefined {
    const wait = this.conversations.get(conversation)?.waiting;
    return wait === undefined ? undefined : { agent: wait.agent, message: wait.message, text: wait.text };
  }

  private endWait(state: ConversationState): void {
    if (state.waiting === undefined) return;
    clearTimeout(state.waiting.timer);
    state.waiting = undefined;
  }

  /**
   * A notice from the harness, as a status message from HARNESS_HANDLE (agent-persistence R6, R9 (d)): in a
   * conversation when there is one, else about the channel; every watcher sees it, and the CLI prints a status of
   * the harness's that opens with `⚠` on stderr, always. Never delivered to an agent.
   */
  notice(text: string, conversation?: string): void {
    const base = {
      id: this.props.newId(),
      channel: this.name,
      from: HARNESS_HANDLE,
      to: null,
      text,
      at: this.props.clock().toISOString(),
    };
    const state = conversation === undefined ? undefined : this.conversations.get(conversation);
    if (conversation !== undefined && state === undefined)
      throw new Error(`notice: unknown conversation ${conversation}`);
    const message: ChannelMessage =
      state === undefined
        ? { ...base, kind: 'status', conversation: null }
        : {
            ...base,
            kind: 'status',
            conversation: present(conversation, 'conversation, since state was found by it above'),
            user: state.asker,
          };
    this.props.logger.info('channel.notice', { channel: this.name, conversation: conversation ?? null, text });
    this.notifyChannel({ type: 'message', message });
    if (message.conversation !== null)
      this.notify(message.conversation, { type: 'message', message, working: this.working(message.conversation) });
  }

  /**
   * If nobody is working on the conversation and no agent has replied, the
   * harness replies to the user, once, saying what each agent did; then, the
   * conversation settled, whenSettled's callbacks run. Called after every
   * change that can leave a conversation idle: an ack, a timeout, an agent
   * leaving, and — for a message no agent received — its posting.
   */
  concludeIfUnanswered(conversation: string): void {
    this.conclude(conversation);
    this.settleIfDone(conversation);
  }

  private conclude(conversation: string): void {
    const state = this.conversations.get(conversation);
    if (state === undefined) throw new Error(`concludeIfUnanswered: unknown conversation ${conversation}`);
    if (this.working(conversation).length > 0) return;
    // The working set is empty: the first time, the conversation's span ends, before any event reports it.
    if (state.span !== undefined) {
      state.span.end(state.agentReplied ? { status: 'ok' } : { status: 'error', reason: 'unanswered' });
      state.span = undefined;
    }
    // The harness posts nothing in a conversation it has ended (R18): its watchers had the error event.
    if (state.replied || state.ended !== undefined) return;
    state.replied = true;
    const message: ConversationMessage = {
      id: this.props.newId(),
      channel: this.name,
      conversation,
      user: state.asker,
      from: HARNESS_HANDLE,
      to: state.asker,
      kind: 'output',
      text: noReplyText(this.name, state.involved),
      at: this.props.clock().toISOString(),
    };
    this.props.logger.info('channel.no_reply', {
      channel: this.name,
      conversation,
      to: state.asker,
      agents: Object.fromEntries(state.involved),
    });
    this.notifyChannel({ type: 'message', message });
    this.notify(conversation, { type: 'message', message, working: [] });
  }

  /**
   * Agents with an unacknowledged delivery in the conversation — a persisted agent's included from its acceptance
   * until the checkpoint that follows its ack (agent-persistence R10) — and the callers of its open calls (R10), sorted.
   */
  working(conversation: string): string[] {
    const handles = new Set<string>();
    for (const p of [...this.pending.values(), ...this.saving.values()]) {
      if (p.delivery.message.conversation === conversation) handles.add(p.handle);
    }
    for (const call of this.calls.values()) {
      if (call.conversation === conversation) handles.add(call.caller);
    }
    return [...handles].sort(byCodeUnit);
  }

  /** Subscribes to a conversation's events. Returns the unsubscribe function. */
  watch(conversation: string, watcher: Watcher): () => void {
    let set = this.watchers.get(conversation);
    if (!set) {
      set = new Set();
      this.watchers.set(conversation, set);
    }
    set.add(watcher);
    return () => {
      set.delete(watcher);
      if (set.size === 0) this.watchers.delete(conversation);
    };
  }

  /** Subscribes to everything on the channel. Returns the unsubscribe function. */
  watchAll(watcher: (event: WatchEvent) => void): () => void {
    this.channelWatchers.add(watcher);
    return () => {
      this.channelWatchers.delete(watcher);
    };
  }

  /**
   * A model call's output or its end (docs/plans/model-streaming.md R4), to the conversation's watchers and every
   * watcher of the channel. Never logged (R8: no record carries delta text) and never delivered to an agent.
   */
  publishModel(event: ModelDeltaEvent | ModelDoneEvent): void {
    this.notify(event.conversation, event);
    this.notifyChannel(event);
  }

  private notifyChannel(event: WatchEvent): void {
    for (const watcher of this.channelWatchers) watcher(event);
  }

  private expire(deliveryId: string): void {
    const p = this.pending.get(deliveryId);
    if (!p) return;
    this.pending.delete(deliveryId);
    p.span.end({ status: 'error', reason: 'expired' });
    this.props.logger.error('channel.delivery_timeout', {
      channel: this.name,
      handle: p.handle,
      deliveryId,
      conversation: p.delivery.message.conversation,
      error: new Error(`${p.handle} did not ack delivery ${deliveryId} within its bound`),
    });
    const queue = this.queues.get(p.handle);
    if (queue?.inHand === p) queue.inHand = undefined;
    this.members.get(p.handle)?.journal?.unacknowledged(p.delivery, 'expired');
    this.props.onDeliveryTimeout(this.name, p.handle, p.delivery);
    const conversation = p.delivery.message.conversation;
    this.conversations.get(conversation)?.involved.set(p.handle, 'did not finish in time');
    if (p.delivery.message.call?.role === 'question')
      this.recordOutcome(p.delivery, p.handle, { outcome: 'timed_out' });
    const nested = this.nestedGathers.get(deliveryId);
    if (nested !== undefined) {
      this.nestedGathers.delete(deliveryId);
      this.recordOutcome(nested.question, p.handle, { outcome: 'timed_out' });
    }
    this.idled(conversation);
  }

  private notify(conversation: string, event: ConversationEvent): void {
    for (const watcher of this.watchers.get(conversation) ?? []) watcher(event);
  }
}

/** A channel name that breaks the naming rule. */
export class ChannelNameInvalid extends Error {
  constructor(
    /** The name refused. */
    readonly channel: string,
  ) {
    super(`"${channel}" is not a valid channel name (${String(NAME_PATTERN)})`);
    this.name = 'ChannelNameInvalid';
  }
}

/** What every channel of a daemon is made with: a channel's props but its name. */
export type ChannelsProps = Omit<ChannelProps, 'name'>;

/** Every channel on this daemon, created the first time something uses its name. */
export class Channels {
  private readonly byName = new Map<string, Channel>();

  constructor(private readonly props: ChannelsProps) {}

  /** The channel of this name, created on first use; a name that breaks the naming rule is refused. */
  get(name: string): Channel {
    if (!NAME_PATTERN.test(name)) throw new ChannelNameInvalid(name);
    let channel = this.byName.get(name);
    if (!channel) {
      channel = new Channel({ ...this.props, name });
      this.byName.set(name, channel);
    }
    return channel;
  }

  /** The channel of that name if something has used it, creating none: a read that must not grow the map (the portal's telemetry). */
  existing(name: string): Channel | undefined {
    return this.byName.get(name);
  }
}

/** A callee's pass as its status (R7): the SDK's passStatus wording, `pass: <reason>`, or `pass` with no reason. */
function passStatusText(reason: string): string {
  const why = reason.trim();
  return why === '' ? 'pass' : `pass: ${why}`;
}
