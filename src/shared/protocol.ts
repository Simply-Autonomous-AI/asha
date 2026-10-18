// The wire contract between the three parties: the `asha` CLI, the daemon,
// and the agents running in containers. Both sides of every call import these
// types, so a change here is a change to every consumer — treat it as a
// published surface (PRINCIPLES §10). Browser-safe: it imports only modules that import nothing, so the portal's
// page loads it too (docs/plans/portal.md R15); traceIdFor, which needs node:crypto, is in trace-id.ts.

import { present } from './assert-present.js';

/** Paths of the daemon's two APIs. */
export const Routes = {
  // Control API — CLI to daemon.
  health: '/v1/health',
  conversations: '/v1/conversations',
  channel: '/v1/channel',
  /** A channel's file space, made ready before an upload: an SSE stream of SpaceEvent (docs/plans/agent-files.md R3a). */
  channelSpace: '/v1/channel/space',
  /** POST: a message's attachments, one upload (R3a). GET `<this>/<id>`: a file an agent returned (R12a). */
  channelFiles: '/v1/channel/files',
  // Agent API — container to daemon, bearer-token authenticated.
  agentChannel: '/agent/v1/channel',
  agentMessages: '/agent/v1/channel/messages',
  agentAck: '/agent/v1/channel/ack',
  /** Open a call: consult one to ten agents (docs/plans/agent-calls.md R2). */
  agentCalls: '/agent/v1/channel/calls',
  /** A callee's answer or pass, from the call question it holds (R5). */
  agentCallAnswer: '/agent/v1/channel/calls/answer',
  agentChat: '/agent/v1/model/chat',
  agentEmbed: '/agent/v1/model/embed',
  agentRoster: '/agent/v1/channel/agents',
  /** OTLP/HTTP JSON spans from an agent (docs/plans/otel-traces.md R9). */
  agentTraces: '/agent/v1/traces',
  /** The caller's channel's blackboard: GET reads, POST appends (docs/plans/agent-tools.md R10). */
  agentBlackboard: '/agent/v1/blackboard',
  /** A granted module tool's call (docs/plans/extension-modules.md R8): one JSON answer, never a stream. */
  agentModuleCall: '/agent/v1/modules/call',
  /** An agent launches a recipe its launch grant names onto its channel (docs/plans/patterns-phase-3.md R30). Agent token only. */
  agentLaunch: '/agent/v1/agents',
  /** GET `<this>/<id>`: a pending approval request; POST `<this>/<id>`: its approval (R12 (b)). Control credential. */
  approvals: '/v1/approvals',
  /** A metered module's opt-in (R18b, R36). Control credential. */
  modulesEnable: '/v1/modules/enable',
  // Control API — launching an agent without posting a message.
  agents: '/v1/agents',
  /** Saved state: listing, and resetting or erasing one user (docs/plans/agent-persistence.md R5, R16). */
  state: '/v1/state',
  stateReset: '/v1/state/reset',
  // The portal's control routes (docs/plans/portal.md R6, R10, R14).
  /** POST: the daemon's stop, as `--stop`'s SIGTERM begins it: 202 `{pid}`, then the stop (R14). */
  stop: '/v1/stop',
  /**
   * POST `{channel}`: every agent on one channel stopped, then every model server no agent needs, the daemon left
   * running: an SSE stream of ChannelStopEvent (docs/plans/portal-demo-stop.md R1–R3).
   */
  channelStop: '/v1/channel/stop',
  /** POST: the page's failure report, `{reason, detail}`: 204 (R6). */
  portalErrors: '/v1/portal/errors',
  /** GET `?channel=<name>`: each online agent's telemetry on the channel, TelemetryResponse (R10). */
  telemetry: '/v1/telemetry',
  /** GET `?channel=<name>[&since=<id>]`: one channel's blackboard, a BlackboardReadResponse (docs/plans/patterns-phase-4.md R1). */
  blackboard: '/v1/blackboard',
  /** GET: every recipe and team the daemon can launch, a DefinitionsResponse (docs/plans/portal-scene-chat.md R13). */
  definitions: '/v1/definitions',
  /** GET: every pattern demo the daemon's root holds, a DemosResponse (portal-scene-chat R16). */
  demos: '/v1/demos',
} as const;

/** Environment variables the harness sets on every agent container. */
export const AgentEnv = {
  harnessUrl: 'ASHA_URL',
  agentToken: 'ASHA_AGENT_TOKEN',
} as const;

/** Bound on one model call made by an agent, end to end through the harness (each image's `HarnessClient`). */
export const AGENT_CHAT_TIMEOUT_MS = 60_000;

/**
 * Stopping an agent (docs/architecture/channel.md#stop). The harness sends its
 * container SIGTERM and, AGENT_STOP_GRACE_MS later, SIGKILL (`docker stop
 * --timeout`). On SIGTERM the agent SDK waits up to AGENT_DRAIN_MS for the work
 * it has started — the delivery in hand and its background tasks, such as a
 * memory write — logs at error whatever is unfinished, and exits. The drain
 * covers one whole model call at its bound plus the span flush (a call begun
 * just before SIGTERM can finish); it is shorter than the grace, so an agent
 * exits by itself, having said what it left undone, before it is killed.
 * (First set at 20 s; the review of 86ea40d measured 215 of 4,468 memory-suite
 * chats over 20 s, p99 32 s, max 56 s, so 20 s would have cut calls the client
 * still allowed.)
 */
export const AGENT_DRAIN_MS = 65_000;
export const AGENT_STOP_GRACE_MS = 70_000;

/**
 * How long the supervisor waits for an agent's container to exit after its channel stream closed with no stop begun
 * by the daemon (docs/plans/patterns-phase-3.md R11): an exit in that time is a crash, logged `agent.exited_unexpectedly`
 * and never a drain's kill; none begins today's drain stop. Over 15 times the slowest exit measured after a stream
 * closed (132 ms, the plan's probe K).
 */
export const RESTART_EXIT_WAIT_MS = 2_000;

/**
 * A persisted agent's stop (docs/plans/agent-persistence.md R10). The daemon waits, without signalling the
 * container, for the ack of its delivery in flight — until AGENT_DRAIN_MS into a full stop, and until
 * STATE_BOUNDED_ACK_MS into the bounded stop (docs/plans/persistent-macos.md R20, whose abandon is at 35 s) —
 * then checkpoints it, each checkpoint bounded by STATE_STOP_CHECKPOINT_MS (about five times the slowest snapshot
 * measured, 944 ms p95 for 256 MB of channel files, probe E2d), then stops the container with `drain` and the
 * whole seconds left until the stop's container deadline, never fewer than STATE_STOP_MIN_GRACE_MS: the SDK's
 * 2 s span-flush bound (TRACE_LIMITS.flushTimeoutMs) and 1 s to exit. A full stop sums to 65 + 5 s, the
 * container's grace overlapping the channel's 5 s checkpoint to 75 s, then the reclaim (about 1 s) and the model
 * servers' 10 s: 86 s, inside the CLI's 90 s (`timing.serverStopMs`).
 */
export const STATE_BOUNDED_ACK_MS = 30_000;
export const STATE_STOP_CHECKPOINT_MS = 5_000;
export const STATE_STOP_MIN_GRACE_MS = 3_000;

/** What a recipe may persist for its agent (R1): its memory tiers and its /workspace. */
export const AGENT_ASSETS = ['memory', 'workspace'] as const;
export type AgentAsset = (typeof AGENT_ASSETS)[number];
/** What a team may persist for its channel (R1): the blackboard and the channel file space. */
export const CHANNEL_ASSETS = ['board', 'files'] as const;
export type ChannelAsset = (typeof CHANNEL_ASSETS)[number];

/**
 * The first line of a re-sent message's framing (R9 (e), the owner's answer to `resume-duplicate-actions`): the
 * agent is told it is a retry, so it can check before acting again.
 */
export const RETRY_LINE = 'This message was sent before the harness restarted; some of its work may already be done.';

/**
 * The first line of the framing of a message the channel re-sends to an agent its supervisor restarted
 * (docs/plans/patterns-phase-3.md R12), as RETRY_LINE is a persisted re-send's: the agent can check before acting again.
 */
export const RESTART_LINE = 'This message was sent before you were restarted; some of its work may already be done.';

/** How long a conversation waits for the user's answer to an ask (docs/plans/patterns-phase-3.md R24): ten minutes. */
export const ASK_WINDOW_MS = 600_000;

/** The channel a message or watch uses when none is named. */
export const DEFAULT_CHANNEL = 'main';

/** Channel names, and the base names agents choose for themselves. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// ------------------------------------------------------------------ channel

/**
 * - `input`: the user's message, injected into the channel by the CLI. Starts a conversation.
 * - `internal`: agent to agents. The user sees it only as progress.
 * - `output`: agent to the user — a reply the CLI prints.
 * - `status`: an agent announcing itself ("Hi"), that it has taken
 *   on work in a conversation ("ok"), or that it passes ("pass: …");
 *   and the harness's statuses posted as the agent's (demo-scene-refresh
 *   R6, R14, R16). Shown to the user and watchers; never delivered to
 *   agents.
 */
export type MessageKind = 'input' | 'internal' | 'output' | 'status';

/**
 * Users have IDs on a channel like agents have handles. A user may name
 * themselves (`user=alice`, or `user=user-3` to be that user again);
 * otherwise the harness issues a new `user-<n>` — never one issued before on
 * the channel, because agents will keep memory keyed on user IDs. No agent
 * may join under this base name.
 */
export const USER_BASE = 'user';

/**
 * Why `base` cannot be an agent's base name on a channel, or undefined when it can: it matches NAME_PATTERN and is not
 * USER_BASE. `Channel.join` checks with it, and so does a launch grant's recipe id (docs/plans/patterns-phase-3.md R29),
 * which becomes the launched agent's base name.
 */
export function agentBaseNameProblem(base: string): string | undefined {
  return NAME_PATTERN.test(base) && base !== USER_BASE
    ? undefined
    : `"${base}" is not a usable agent name (${String(NAME_PATTERN)}, not "${USER_BASE}")`;
}

/**
 * The harness's own handle on every channel. It posts one `output` when a
 * conversation ends with no agent having replied to the user, saying what each
 * agent did. No user may take this ID, and no agent handle can equal it
 * (agent handles are always <base>-<n>).
 */
export const HARNESS_HANDLE = 'asha';

/** The user-ID rule's reasons, one per rule (cli-interactive R16): the CLI and `Channel.claimUser` give the same. */
export const USER_ID_REASONS = {
  pattern: 'a user ID is 1 to 32 characters: a lowercase letter, then lowercase letters, digits or hyphens',
  issued: 'user-<n> is the form the harness issues',
  number: 'only an issued ID (user-<n>) may end in -<number>',
  harness: '"asha" is the harness\'s own name',
} as const;

/** `user-<n>`: an issued user ID, `<n>` a number from 1 with no leading zero. */
export const ISSUED_USER_ID = new RegExp(`^${USER_BASE}-[1-9][0-9]*$`);

/**
 * What is wrong with `id` as a user ID, or undefined when nothing is. The rules, in order: (1) NAME_PATTERN; (2) for
 * the CLI's default only (the converted login name), not the issued form; (3) no -<number> ending but an issued ID's;
 * (4) not the harness's handle. A typed `user-3` is allowed; a login name that converts to it is not.
 */
export function userIdProblem(id: string, props: { readonly isDefault: boolean }): string | undefined {
  if (!NAME_PATTERN.test(id)) return USER_ID_REASONS.pattern;
  const issued = ISSUED_USER_ID.test(id);
  if (props.isDefault && issued) return USER_ID_REASONS.issued;
  if (!issued && /-\d+$/.test(id)) return USER_ID_REASONS.number;
  if (id === HARNESS_HANDLE) return USER_ID_REASONS.harness;
  return undefined;
}

/**
 * A login name converted to fit the user-ID rule, character by character and nothing else: ASCII `A`–`Z` lowercased,
 * each `.` and `_` made `-`, every other character kept — no trimming, dropping, truncating or collapsing, and no
 * lowercasing beyond ASCII, whose result would depend on the Unicode tables of the Node release.
 */
export function loginNameToUserId(name: string): string {
  return name.replace(/[A-Z._]/g, (c) => (c === '.' || c === '_' ? '-' : c.toLowerCase()));
}

interface MessageBase {
  readonly id: string;
  /** The channel it was posted on. */
  readonly channel: string;
  /** The sender's handle: a user's (`user-1`) or an agent's (`hewo-1`). */
  readonly from: string;
  /**
   * Who it is for: one agent's handle, or null for everyone on the channel.
   * An `output` message is always for the user who started the conversation.
   */
  readonly to: string | null;
  readonly kind: MessageKind;
  readonly text: string;
  /** ISO-8601. */
  readonly at: string;
}

// ------------------------------------------------------------------ calls

/** Most addressees of one call (docs/plans/agent-calls.md R11). */
export const CALL_MAX_ADDRESSEES = 10;
/** Most characters of one answer to a call (R5, R11). */
export const CALL_MAX_ANSWER_CHARS = 1_000;

/**
 * What became of one addressee of a call (R7), recorded once: it answered, it
 * passed, its question's delivery expired, it left the channel, or it acked
 * the question without answering.
 */
export type CallOutcome = 'answered' | 'passed' | 'timed_out' | 'left' | 'unanswered';

/** One request of a call: its addressee and the text it is asked. */
export interface CallRequest {
  readonly to: string;
  readonly text: string;
}

/** One addressee's outcome in a gather, in request order. */
export interface GatherAnswer {
  readonly from: string;
  readonly outcome: CallOutcome;
  /** For `answered`: the answer. */
  readonly text?: string;
  /** For `passed`: the reason given. */
  readonly reason?: string;
  /** For `left`: the channel's detail. */
  readonly detail?: string;
}

/**
 * The mark the channel sets on a message that belongs to a call; only the
 * channel sets it. A `question` is delivered to one addressee; an `answer` is
 * shown to watchers and delivered to no agent; a `gather` is delivered to the
 * caller once every addressee has an outcome, holding them all (R3, R7, R8).
 * The `context` is the message the caller was handling when it consulted —
 * never a gather (R3).
 */
export type CallMark =
  | { readonly id: string; readonly role: 'question' }
  | { readonly id: string; readonly role: 'answer'; readonly outcome: 'answered' }
  | {
      readonly id: string;
      readonly role: 'gather';
      readonly context: { readonly from: string; readonly text: string };
      readonly requests: readonly CallRequest[];
      readonly answers: readonly GatherAnswer[];
      /**
       * On a nested call's gather (docs/plans/patterns-phase-3.md R34, R35): the call whose question its caller held when
       * it consulted, and that question's asker. The gather is then a call turn answering `asker`.
       */
      readonly parent?: { readonly id: string; readonly asker: string };
    };

/** How deep calls nest (R34): a granted callee's consult is a call of depth 2, and no deeper call is opened. */
export const CALL_MAX_DEPTH = 2;

/**
 * Why the channel refused a consult, a call's answer, or a callee's other post
 * — the `reason` of a 409 `{error, reason}` (docs/plans/agent-calls.md R2, R5,
 * R6). Nothing is posted or recorded.
 */
export const CALL_REFUSAL_REASONS = [
  // consult (R2)
  'not_holding_delivery',
  'nested_call',
  'unknown_handle',
  'self_addressed',
  'duplicate_addressee',
  'too_many_addressees',
  'empty_text',
  'call_open',
  'post_budget',
  // answer (R5)
  'not_a_call',
  'answer_too_large',
  'call_closed',
  // a callee's internal or output post (R6)
  'call_answer_only',
  // a post or consult that would take a persisted recipient's record of unsaved deliveries past its bound
  // (docs/plans/agent-persistence.md R9 (a))
  'pending_full',
  // any agent post, consult or answer in a conversation the harness has ended (docs/plans/patterns-phase-3.md R18)
  'conversation_ended',
  // an ask in a conversation one of whose asks already waits for the user (R24)
  'ask_open',
] as const;

/** One of CALL_REFUSAL_REASONS: why the channel refused a consult or a call's answer. */
export type CallRefusalReason = (typeof CALL_REFUSAL_REASONS)[number];

/** `POST /agent/v1/channel/calls`: consult, while handling `delivery`, each addressee with its text. */
export interface ConsultRequest {
  readonly delivery: string;
  readonly requests: readonly CallRequest[];
}

/** 200 to a consult: the call's id, minted by the channel, and the questions posted, in request order. */
export interface ConsultResponse {
  readonly call: string;
  readonly messages: readonly string[];
}

/** `POST /agent/v1/channel/calls/answer`: the callee's answer, or its pass with a reason, to the question it holds as `delivery`. */
export type CallAnswerRequest =
  { readonly delivery: string; readonly text: string } | { readonly delivery: string; readonly pass: string };

/** 200 to an answer: the answer posted (internal, to the caller), or the pass status posted. */
export interface CallAnswerResponse {
  readonly message: ChannelMessage;
}

/** One file attached to a user's input, as the agents receive it: where it lies in /channel (docs/plans/agent-files.md R9). */
export interface Attachment {
  /** `/channel/upload-<16 hex>/<name>`. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** One file an agent returned with its reply (R12): fetched by its id from `GET /v1/channel/files/<id>` (R12a). */
export interface ReturnedFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** A message that belongs to a conversation — every kind can. */
export interface ConversationMessage extends MessageBase {
  /** On a user's input only: the files attached to it, each at its /channel path (agent-files R9). */
  readonly attachments?: readonly Attachment[];
  /** On an agent's output only: the files it returned with it (agent-files R12). */
  readonly files?: readonly ReturnedFile[];
  /** Set by the channel alone on a call's question, answer and gather (docs/plans/agent-calls.md). */
  readonly call?: CallMark;
  /** The id of the `input` message this conversation started with. */
  readonly conversation: string;
  /**
   * The user the conversation belongs to: the one who started it. The channel
   * sets it on the input and on every message after it — agents' messages to
   * each other, statuses, replies — and nobody else can. It is how an agent
   * knows whose data (e.g. memory) a message may touch, however many agents it
   * passed through. Unique only within its channel: scope by (channel, user).
   */
  readonly user: string;
  /**
   * Set by the channel alone on a user's input re-sent after a restart (docs/plans/agent-persistence.md R9 (e)):
   * when it was first sent, and the conversation and message it was first sent as.
   */
  readonly redelivered?: Redelivered;
  /**
   * Set by the channel alone on asha's message giving an agent the result of a call the user approved
   * (docs/plans/extension-modules.md R12 (d)): the agent's turn is framed from this field alone, never from the text.
   * A field, not a kind: an older CLI prints the message as any internal one.
   */
  readonly approved?: ApprovedCall;
  /**
   * Set by the channel alone on a delivery it re-sends to an agent its supervisor restarted (docs/plans/patterns-phase-3.md
   * R12): which restart of the agent it follows. The agent frames the message with RESTART_LINE from this field alone.
   */
  readonly restarted?: { readonly attempt: number };
  /**
   * On an agent's output only, set by the channel from the agent's `ask_user` (docs/plans/patterns-phase-3.md R24): the
   * output asks the user, and the conversation waits for their answer.
   */
  readonly asks?: true;
  /**
   * On a user's input to a topic, set by the channel (docs/plans/patterns-phase-3.md R21): the topic it was posted to. It
   * was delivered to the members subscribed to it, `to` null, so each agent frames it as a message to everyone.
   */
  readonly topic?: string;
  /**
   * On a user's answer to an ask, set by the channel alone (docs/plans/patterns-phase-3.md R25, R26): the ask it answers,
   * its id and text. The asking agent frames the message from this field alone, the answer first, then its question.
   */
  readonly answers?: { readonly ask: string; readonly text: string };
}

/** The result of an approved consequential call, as asha gives it to the agent that asked (R12 (d)). */
export interface ApprovedCall {
  readonly approval: string;
  readonly module: string;
  readonly tool: string;
  /** The RFC 8785 form of the arguments, as a string: what the user saw and approved. */
  readonly arguments: string;
  readonly outcome: { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly reason: string };
}

/** When a resumed agent's saved state was saved, and the handle it had then (docs/plans/agent-persistence.md R8). */
export interface ResumedFrom {
  readonly savedAt: string;
  readonly previousHandle: string;
}

/** A re-sent input's origin (R9 (e)). */
interface Redelivered {
  readonly savedAt: string;
  readonly originalConversation: string;
  readonly originalMessage: string;
}

/** An agent's status about itself rather than a conversation, e.g. "Hi". */
export interface PresenceMessage extends MessageBase {
  readonly kind: 'status';
  readonly conversation: null;
  /**
   * Set by the harness alone: the agent is down — online, it went offline without a stop being begun, its container
   * exited or its channel stream closed (AGENT_FAILURE_STATUS, docs/plans/demo-scene-refresh.md R6) — or its restart
   * is under way, failed, or reached its limit (restartingStatus, restartFailedStatus, restartLimitStatus, R16).
   */
  readonly failure?: true;
}

/** The text of the status the harness posts for an agent that went offline without being stopped (demo-scene-refresh R6, R7). */
export const AGENT_FAILURE_STATUS = 'system failure — offline';

/** The launcher's status as its launch of an agent from `recipe` begins (demo-scene-refresh R14). */
export function launchingStatus(recipe: string): string {
  return `launching a new ${recipe} agent`;
}

/** The launcher's status when its launch of an agent from `recipe` failed, with the launch's reason (R14). */
export function launchFailedStatus(recipe: string, reason: string): string {
  return `could not launch a ${recipe} agent: ${reason}`;
}

/** The harness's status for an agent whose restart begins (demo-scene-refresh R16): which of its allowed restarts. */
export function restartingStatus(attempt: number, max: number, withinMs: number): string {
  return `restarting (${String(attempt)} of ${String(max)} within ${String(Math.round(withinMs / 1_000))} s)`;
}

/** The harness's status for an agent whose restart did not come online (R16), and why. */
export function restartFailedStatus(attempt: number, why: string): string {
  return `restart ${String(attempt)} failed: ${why}`;
}

/** The harness's status for an agent that went down once more than its restarts allow (R16): it is taken off. */
export function restartLimitStatus(restarts: number, withinMs: number): string {
  return `restart limit reached (${String(restarts)} within ${String(Math.round(withinMs / 1_000))} s): removed`;
}

/**
 * The harness's status for an agent taken off because the message it held was sent again as many times as its restarts
 * allow (R16; the code review's round 3): the other limit, whatever the window holds.
 */
export function restartResentLimitStatus(times: number): string {
  return `restart limit reached (the message it held sent again ${String(times)} times): removed`;
}

/** The harness's status for a restarted agent sent again what it held when it went down (R16). */
export function resentStatus(count: number): string {
  return count === 1 ? 'sent again the message it held' : `sent again the ${String(count)} messages it held`;
}

/** Whether a status's text is one the harness posts for an agent (R6, R14, R16), which no agent may post itself. */
export function isHarnessStatus(text: string): boolean {
  return (
    text === AGENT_FAILURE_STATUS ||
    text.startsWith('launching a new ') ||
    text.startsWith('could not launch a ') ||
    text.startsWith('restarting (') ||
    /^restart \d+ failed: /.test(text) ||
    text.startsWith('restart limit reached (') ||
    text.startsWith('sent again the ')
  );
}

/** Any message on a channel: one in a conversation, or an agent's own presence status outside one. */
export type ChannelMessage = ConversationMessage | PresenceMessage;

/**
 * One message delivered to one agent. The agent is *working* until it acks the
 * delivery; the SDK acks automatically once its handler returns.
 */
export interface Delivery {
  readonly deliveryId: string;
  readonly message: ConversationMessage;
  /**
   * W3C trace context naming the daemon's `asha.delivery` span for this
   * delivery: `00-<traceIdFor(conversation)>-<span id>-01`. The agent's
   * `delivery` span is its child.
   */
  readonly traceparent: string;
}

/**
 * What the harness sends on an agent's channel stream. `welcome` comes first:
 * the agent asked to be called by a base name (`hewo`), and the channel made
 * it unique (`hewo-1`) — that handle is how others address it. `tools` names
 * the tools its recipe selects (common and image tools, docs/plans/agent-tools.md
 * R1): the agent offers exactly those, after the channel tools. `prompt` is its
 * recipe's system prompt, its role text (docs/plans/collaborating-agents.md R1):
 * no image carries one. `guidance` is its recipe's full-text documents, in the
 * recipe's order, as the recipe folder holds them at launch (R2): the agent puts
 * them in its system prompt on every turn. All travel here, never in the
 * container's environment.
 */
export type AgentStreamEvent =
  | {
      readonly type: 'welcome';
      readonly handle: string;
      readonly channel: string;
      readonly tools: readonly string[];
      readonly prompt: string;
      readonly guidance: readonly GuidanceDocument[];
      /**
       * Present only for a persisted agent (docs/plans/agent-persistence.md R10): what its recipe persists. Such an
       * agent acks a delivery only once the background work the delivery started has settled.
       */
      readonly persist?: readonly AgentAsset[];
      /** Present only when the agent resumed saved state (R8): when it was saved, and the handle it had then. */
      readonly resumed?: ResumedFrom;
      /**
       * The module tools its recipe grants (docs/plans/extension-modules.md R10), in the recipe's `modules` order: each
       * one's wire name, description, argument schema and bound; [] for none. The agent offers them after its selected
       * tools and runs each through the module-call route. An older SDK ignores the field.
       */
      readonly modules?: readonly ModuleToolOffer[];
      /**
       * Present only for a recipe with a launch grant (docs/plans/patterns-phase-3.md R29): the recipes it may launch and
       * how many per conversation. The agent offers `launch_agent` after its selected tools.
       */
      readonly launch?: LaunchGrant;
      /** Present only for a recipe that names `nestedCalls: true` (R33): its call turns may consult other agents first. */
      readonly nestedCalls?: true;
    }
  | { readonly type: 'delivery'; readonly delivery: Delivery }
  | { readonly type: 'heartbeat' };

/** A recipe's launch grant (docs/plans/patterns-phase-3.md R29): recipe ids in its team's folder, and a cap per conversation. */
export interface LaunchGrant {
  /** 1 to LAUNCH_MAX_RECIPES distinct ids, each a recipe file `<id>.json` in the granting recipe's team folder. */
  readonly recipes: readonly string[];
  /** 1 to LAUNCH_MAX_PER_CONVERSATION: how many agents the holder may launch for one conversation. */
  readonly maxPerConversation: number;
}

/** A launch grant's bounds (R29). */
export const LAUNCH_MAX_RECIPES = 3;
export const LAUNCH_MAX_PER_CONVERSATION = 3;
/** The most a launchable recipe's `startupTimeoutMs` may be (R29): the launch lies inside one turn's tool round. */
export const LAUNCHED_STARTUP_MAX_MS = 30_000;
/** The SDK's bound on `launch_agent` (R30): over LAUNCHED_STARTUP_MAX_MS, so the daemon's own answer comes first. */
export const LAUNCH_AGENT_TIMEOUT_MS = 35_000;

/** `POST /agent/v1/agents` (R30): the delivery the caller holds, and the recipe to launch. */
export interface AgentLaunchRequest {
  readonly delivery: string;
  readonly recipe: string;
}

/** Its 200: the launched agent's handle, once it is online. */
export interface AgentLaunchResponse {
  readonly handle: string;
}

/** Its 409 reasons (R30); 503 is `stopping`. */
export const LAUNCH_REFUSAL_REASONS = ['not_holding_delivery', 'not_granted', 'launch_cap', 'launch_failed'] as const;
export type LaunchRefusalReason = (typeof LAUNCH_REFUSAL_REASONS)[number];

/** One granted module tool, as the welcome carries it (extension-modules R10). */
export interface ModuleToolOffer {
  /** `<module>__<tool>`. */
  readonly name: string;
  readonly description: string;
  /** Its arguments as JSON Schema (the ToolParameters subset). */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

/** `POST /agent/v1/modules/call` (extension-modules R8): a granted tool's wire name and its arguments. */
export interface ModuleCallRequest {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** 200 to a module call (R8): its result, or a reason from TOOL_FAILURE_REASONS. */
export type ModuleCallResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

/** A full-text document of an agent's recipe: its path under /workspace, and its text (collaborating-agents R2). */
export interface GuidanceDocument {
  readonly path: string;
  readonly text: string;
}

/**
 * `POST /agent/v1/channel/messages`. `to` addresses one agent by handle; omit
 * it to post to everyone. `conversation` is required except on a `status`
 * message about the agent itself.
 */
export interface PostRequest {
  readonly conversation?: string;
  readonly kind: 'internal' | 'output' | 'status';
  readonly text: string;
  readonly to?: string;
  /**
   * An output's files (agent-files R12, `reply_with_files`): 1 to 10 paths, each `/channel/<name>` or
   * `/channel/upload-<16 hex>/<name>`. A refusal is 409 `{error, reason: 'file_refused', file, rule}`, nothing posted.
   */
  readonly files?: readonly string[];
  /**
   * An output that asks the user (docs/plans/patterns-phase-3.md R23, R24): `ask_user`'s. The conversation then waits for
   * the user's answer; a second ask while one waits is refused 409 `{reason: 'ask_open'}`, nothing posted.
   */
  readonly asks?: true;
}

/** `POST /agent/v1/channel/ack`. */
export interface AckRequest {
  readonly deliveryId: string;
}

// ---------------------------------------------------------------- model calls

/**
 * The role of one message of a chat call, as the OpenAI-shaped chat completion API names it.
 *
 * @public — part of the HTTP API's wire, for its clients (docs/architecture/index.md), though no harness code names it.
 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * One turn of a chat. An assistant turn may carry the tool calls the model
 * made; a `tool` turn is the result of one of them, matched by its id.
 */
export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

/** A function the model may call, in the OpenAI tool shape. */
export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the arguments object. */
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

/** A call the model chose to make. `arguments` is the parsed JSON object. */
export interface ToolCall {
  /** The model's id for the call; a `tool` message answers it by this id. */
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** An agent's chat call (`POST /v1/chat`): its messages, its token budget, and the tools the model may call. */
export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  /** Upper bound on generated tokens. Required: an agent states its budget. */
  readonly maxTokens: number;
  /** Functions the model may call instead of, or as well as, answering. */
  readonly tools?: readonly ToolDefinition[];
  /**
   * Make the model answer with at least one tool call (never plain text).
   * Omitted or false: it may answer either way. Requires `tools`.
   */
  readonly requireToolCall?: boolean;
}

/**
 * Expected failures of a model call are data, not exceptions (PRINCIPLES §11),
 * drawn from this small stable set.
 */
export const MODEL_FAILURE_REASONS = [
  'timeout', // the model server did not answer within the bound
  'unavailable', // the model server could not be reached
  'upstream_error', // the model server answered non-2xx
  'bad_response', // the model server answered 2xx with an unusable body
  'truncated', // a required tool call never came: the output reached the token limit first
  // docs/plans/extension-modules.md R18b, R19: a metered provider's call refused before the vendor is called.
  'budget_exceeded', // the call's reservation would pass a cap
  'budget_meter_unavailable', // metering.json does not parse: never a reset to zero
] as const;

/** One of MODEL_FAILURE_REASONS: why a model call failed. */
export type ModelFailureReason = (typeof MODEL_FAILURE_REASONS)[number];

/**
 * `POST /agent/v1/model/embed`: texts to vectors, with the recipe's
 * embedding model. A `query` is written the way the model wants a search
 * query (its catalogue `queryTemplate`); a `document` is sent as it is.
 */
export interface EmbedRequest {
  readonly texts: readonly string[];
  readonly purpose: 'query' | 'document';
}

/** The answer to an embed call: one vector a text, or the model's failure and its reason. */
export type EmbedResponse =
  | { readonly ok: true; readonly vectors: readonly (readonly number[])[] }
  | { readonly ok: false; readonly reason: ModelFailureReason; readonly detail: string };

/** The answer to a chat call: the reply's text and tool calls, or the model's failure and its reason. */
export type ChatResponse =
  | { readonly ok: true; readonly text: string; readonly toolCalls: readonly ToolCall[] }
  | { readonly ok: false; readonly reason: ModelFailureReason; readonly detail: string };

// ------------------------------------------------------------ conversations

/**
 * `POST /v1/agents`: start a new instance of a recipe's agent on a channel, or every member of a team
 * (teams/<team>/team.json, docs/plans/collaborating-agents.md R5) — exactly one of `recipe` and `team`.
 *
 * @public — part of the HTTP API's wire, for its clients (docs/architecture/index.md), though no harness code names it.
 */
export type LaunchRequest = (
  { readonly channel: string; readonly recipe: string } | { readonly channel: string; readonly team: string }
) & {
  /**
   * Follow the conversations of the users' messages the launch re-sends after a restart (docs/plans/agent-persistence.md
   * R9 (i)). Sent only to a daemon of the CLI's own build: an older daemon's closed body refuses the key.
   */
  readonly followResent?: true;
};

/**
 * `POST /v1/channel/stop`'s body (docs/plans/portal-demo-stop.md R1); `source` says who asked, for the log (R2).
 *
 * @public — part of the HTTP API's wire, for its clients (docs/architecture/index.md), though no harness code names it.
 */
export interface ChannelStopRequest {
  readonly channel: string;
  readonly source: 'portal' | 'cli';
}

/**
 * One event of the SSE stream `POST /v1/channel/stop` answers with (docs/plans/portal-demo-stop.md R1): `stopping`
 * with the handles to stop; one `agent_stopped` per agent as it is gone; one `model_server_stopped` per model server
 * then stopped because no agent needs it (R3); then exactly one of `stopped` or `error`. The daemon's heartbeat
 * comment, every 10,000 ms, keeps a reader's idle bound from firing through a stop of up to about 70 s (R2).
 */
export type ChannelStopEvent =
  | { readonly type: 'stopping'; readonly channel: string; readonly handles: readonly string[] }
  | { readonly type: 'agent_stopped'; readonly handle: string }
  | { readonly type: 'model_server_stopped'; readonly model: string }
  | {
      readonly type: 'stopped';
      readonly channel: string;
      readonly handles: readonly string[];
      readonly modelServers: readonly string[];
    }
  | { readonly type: 'error'; readonly reason: 'channel_stop_failed'; readonly detail: string };

/**
 * One event of the SSE stream `POST /v1/agents` responds with (docs/plans/model-streaming.md R5). A recipe's launch
 * ends after `launched` or `error`; a team's streams `member`, that member's phases and `launched` for each member
 * in team.json's order, and ends after `team_launched` or `error`. With `followResent` (agent-persistence R9 (i)),
 * a launch that re-sends users' messages then streams, for each re-sent conversation in the order they start,
 * `resending`, the conversation's events, and `settled`, and ends once every one has settled.
 */
export type LaunchEvent =
  | { readonly type: 'phase'; readonly phase: OnlinePhase; readonly detail: string }
  /** The new agent's own announcement on the channel; `resumed` when it resumed saved state (agent-persistence R8). */
  | { readonly type: 'announced'; readonly message: ChannelMessage; readonly resumed?: ResumedFrom }
  /** A team's member about to be launched: its name in team.json and its recipe's id. */
  | { readonly type: 'member'; readonly name: string; readonly recipe: string }
  /**
   * `exposesFiles`: the agent is cloud-granted and the channel's file space holds a file (agent-files R7): the CLI
   * warns that the files may leave this machine. An older CLI ignores the field.
   */
  | { readonly type: 'launched'; readonly agent: AgentSummary; readonly exposesFiles?: true }
  /** Every member of the team is online. */
  | { readonly type: 'team_launched'; readonly team: string; readonly agents: readonly AgentSummary[] }
  /** A user's message from before the restart is being re-sent, in this conversation (R9 (h), (i)). */
  | { readonly type: 'resending'; readonly conversation: string; readonly savedAt: string }
  | { readonly type: 'message'; readonly message: ConversationMessage; readonly working: readonly string[] }
  | { readonly type: 'status'; readonly conversation: string; readonly working: readonly string[] }
  | {
      readonly type: 'agent_left';
      readonly conversation: string;
      readonly agent: string;
      readonly detail: string;
      readonly working: readonly string[];
    }
  | ModelDeltaEvent
  | ModelDoneEvent
  /** A re-sent conversation has settled: nobody works on it, and its asker has a reply (`Channel.whenSettled`). */
  | { readonly type: 'settled'; readonly conversation: string }
  | { readonly type: 'error'; readonly reason: ConversationErrorReason; readonly detail: string };

/** An online agent, as other agents see it: its handle, and what its recipe says it does. */
export interface AgentInfo {
  readonly handle: string;
  readonly recipe: string;
  readonly description: string;
}

/** `GET /agent/v1/channel/agents`: the other online agents on the caller's channel. */
export interface RosterResponse {
  readonly agents: readonly AgentInfo[];
}

/**
 * `POST /v1/conversations`: optionally bring a recipe's agent online on the
 * channel, then post the user's message there — to everyone, or to one agent.
 */
export interface ConversationRequest {
  /** The asking user's ID; omitted, the harness assigns one that isn't online. */
  readonly user?: string;
  readonly channel: string;
  /** Bring this recipe's agent online on the channel first (reusing one already online). */
  readonly recipe?: string;
  /** Address one agent by handle. */
  readonly to?: string;
  readonly message: string;
  /** An upload's id (agent-files R3a): the files it copied into the channel's space are attached to this message. */
  readonly attachments?: string;
  /** A topic (docs/plans/patterns-phase-3.md R21), never with `to`: the message reaches the members subscribed to it. */
  readonly topic?: string;
  /**
   * The conversation this message answers (R25): it waits for this user's answer to an agent's ask. With it the body
   * holds `channel`, `user` and `message` and no other key.
   */
  readonly conversation?: string;
  /**
   * The conversation's budget (docs/plans/patterns-phase-3.md R15): at least one of its agent posts, 1–BUDGET_POSTS_MAX,
   * and its model tokens, 1–BUDGET_TOKENS_MAX. Absent: 32 posts and no tokens budget. A daemon of an older build refuses
   * the key (its closed body: 400).
   */
  readonly budget?: ConversationBudgetRequest;
}

/** A message's budget (R15): a closed object, at least one key. */
export interface ConversationBudgetRequest {
  readonly posts?: number;
  readonly tokens?: number;
}

/** A message's posts budget at most (R15): the daemon's default, the most a conversation ever has. */
export const BUDGET_POSTS_MAX = 32;
/** A message's tokens budget at most (R15). */
export const BUDGET_TOKENS_MAX = 1_000_000;

/**
 * A message's budget from the text the user typed (R15) — the CLI's `posts=` and `tokens=`, the portal's fields — each
 * a whole number in its range with no sign or leading zero; undefined for neither; an error string naming the first
 * that is not one.
 */
export function budgetOfText(values: {
  readonly posts?: string;
  readonly tokens?: string;
}): ConversationBudgetRequest | string | undefined {
  const budget: { posts?: number; tokens?: number } = {};
  // One `problem`, and the one `return` at the end: not a `return` of a different literal shape (string, undefined,
  // object) at each failure (sonarjs/function-return-type).
  let problem: string | undefined;
  for (const key of ['posts', 'tokens'] as const) {
    if (problem !== undefined) break;
    const value = values[key];
    if (value === undefined) continue;
    const most = key === 'posts' ? BUDGET_POSTS_MAX : BUDGET_TOKENS_MAX;
    if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > most)
      problem = `${key}= is a whole number from 1 to ${most.toLocaleString('en-US')}, not ${value}`;
    else budget[key] = Number(value);
  }
  return problem ?? (Object.keys(budget).length === 0 ? undefined : budget);
}

/** What is wrong with a budget as a request carries it (R15), or undefined: the server and the CLI give the same. */
export function budgetProblem(value: unknown): string | undefined {
  const rule = `budget is {"posts": <1–${String(BUDGET_POSTS_MAX)}>, "tokens": <1–${String(BUDGET_TOKENS_MAX)}>}, each a whole number, at least one of them`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return rule;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((k) => k !== 'posts' && k !== 'tokens')) return rule;
  const { posts, tokens } = value as { posts?: unknown; tokens?: unknown };
  const whole = (v: unknown, most: number): boolean =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= most;
  if (posts !== undefined && !whole(posts, BUDGET_POSTS_MAX)) return rule;
  if (tokens !== undefined && !whole(tokens, BUDGET_TOKENS_MAX)) return rule;
  return undefined;
}

/**
 * `POST /v1/channel/space` (agent-files R3a): make the channel's file space ready, bringing `recipe`'s image if needed.
 *
 * @public — part of the HTTP API's wire, for its clients (docs/architecture/index.md), though no harness code names it.
 */
export interface SpaceRequest {
  readonly channel: string;
  readonly recipe?: string;
}

/**
 * One event of the SSE stream `POST /v1/channel/space` answers (agent-files R3a): the steps of making the container
 * runtime and an image ready, then `space_ready` with the space's measured usage and the cloud-granted agents its
 * files may reach (R7), or `error`.
 */
export type SpaceEvent =
  | { readonly type: 'phase'; readonly phase: OnlinePhase; readonly detail: string }
  | {
      readonly type: 'space_ready';
      readonly channel: string;
      readonly bytes: number;
      readonly entries: number;
      readonly cloudAgents: readonly string[];
    }
  | { readonly type: 'error'; readonly reason: ConversationErrorReason; readonly detail: string };

/** One file of an upload's manifest, the first line of its body (R3a). */
export interface UploadManifestEntry {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** 200 to an upload (R3a): its id, and where each file now lies. */
export interface UploadResponse {
  readonly upload: string;
  readonly files: readonly {
    readonly name: string;
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

/**
 * Why an upload was refused, each with its status (R3a): a manifest, body or bound rule (400, 413), no space (409),
 * too many unused uploads (429), the lock or the copy's bound (503), a failed copy or rollback, or a measurement
 * that failed (500). Every one copies nothing into the space, or rolls back what it copied.
 */
export const UPLOAD_REFUSALS = {
  bad_manifest: 400,
  body_short: 400,
  body_long: 400,
  body_stalled: 400,
  sha256_mismatch: 400,
  no_space: 409,
  space_entries: 413,
  space_bytes: 413,
  too_many_uploads: 429,
  space_busy: 503,
  copy_timeout: 503,
  stopping: 503,
  copy_failed: 500,
  rollback_failed: 500,
  measure_failed: 500,
  /** The file holds the running daemon's control credential or model-server key (docs/plans/portal.md R8b). */
  holds_asha_secret: 400,
} as const;

/** One of UPLOAD_REFUSALS' keys: why an upload was refused. */
export type UploadRefusal = keyof typeof UPLOAD_REFUSALS;

/** The steps of bringing an agent online, in order. */
export type OnlinePhase =
  | 'container_runtime' // colima installed and running
  | 'model' // model files present and verified in the cache
  | 'model_server' // llama-server serving the model
  | 'image' // agent image current
  | 'agent'; // an agent already online on the channel is reused

/** Why a conversation the CLI or the portal began ended in an error, each reason commented below. */
export type ConversationErrorReason =
  | 'bad_request' // the request itself is malformed
  | 'unknown_recipe' // no recipes/<name>.json
  | 'unknown_team' // no teams/<name>/team.json
  | 'unknown_image' // the recipe names an image with no images/<name>/Dockerfile
  | 'prerequisite' // a host tool is missing and cannot be installed
  | 'container_runtime' // colima or docker failed
  | 'model_fetch' // download or verification of model files failed
  | 'model_server' // the model server failed to start
  | 'image_build' // docker build failed
  | 'agent_start' // the agent did not connect to the channel in time
  | 'unknown_handle' // `to` names no agent on the channel
  | 'slow_reader' // the stream's reader fell more than SSE_MAX_UNWRITTEN_BYTES behind: the daemon ended that stream
  // docs/plans/agent-persistence.md:
  | 'pending_full' // a persisted recipient's record of unsaved deliveries is full (R9 (a)): nothing was posted
  | 'identity_in_use' // a persisted launch's identity is already online, or being erased (R2, R16)
  | 'memory_egress_forbidden' // a cloud-granted launch onto a channel whose saved state held memory (R7)
  | 'state_image_mismatch' // saved state from another image (R12)
  | 'state_schema_changed' // saved state of another state schema (R12)
  | 'persist_mismatch' // a team whose persist differs from the online channel's (R14)
  | 'state_inside_git_tree' // ASHA_HOME/state is inside a git tree (R2)
  // docs/plans/agent-files.md:
  | 'files_space_in_use' // a persisted team's saved files onto a channel whose space already holds entries (R15)
  // docs/plans/extension-modules.md (M10):
  | 'module_refused' // a launch's module grants, roots, bounds or approvals are refused, before any container starts (R18c, R25, R29, R30, R34)
  | 'module_unavailable' // a granted module could not be made ready: an old engine, a missing secret, its container (R6 (a), R7, R34)
  // docs/plans/patterns-phase-3.md — the harness ended the conversation (R18):
  | 'budget_exceeded' // it reached its post or token budget (R16, R17)
  | 'restart_limit' // an agent working on it exited more often than its recipe's restart allows (R13)
  | 'unknown_topic' // a message to a topic no online member of the channel subscribes to: nothing was posted (R22)
  | 'not_awaiting' // an answer to a conversation that is not waiting for this user's answer: nothing was posted (R25)
  | 'internal'; // a harness defect — a bug, not an expected failure

/**
 * One piece of a model's output as a call streams it (docs/plans/model-streaming.md R4): `call` is the call's
 * `asha.chat` span id, `seq` counts from 0 per call. `thinking` is the model's reasoning, `text` its reply text,
 * `tool_args` a fragment of the raw JSON arguments of its tool call `index`, named `name`. The conversation comes
 * from the call's validated trace (R3), never from the agent.
 */
export type ModelDeltaEvent = {
  readonly type: 'model_delta';
  readonly handle: string;
  readonly conversation: string;
  readonly call: string;
  readonly seq: number;
  readonly text: string;
} & (
  { readonly part: 'thinking' | 'text' } | { readonly part: 'tool_args'; readonly index: number; readonly name: string }
);

/** A model call's end, once per call and after its last delta (R4): `ok`, or why it failed. */
export interface ModelDoneEvent {
  readonly type: 'model_done';
  readonly handle: string;
  readonly conversation: string;
  readonly call: string;
  readonly outcome: 'ok' | ModelFailureReason;
}

/**
 * One event of the SSE stream `POST /v1/conversations` responds with (R5). After
 * `posted`, every `message` and `status` carries `working`: the agents with an
 * unacknowledged delivery in this conversation. The CLI closes the stream when
 * it has what it needs; the daemon ends it only on `error`.
 */
export type ConversationEvent =
  | { readonly type: 'phase'; readonly phase: OnlinePhase; readonly detail: string }
  /**
   * The agent brought online for this conversation, announcing itself on the channel; `resumed` when it resumed saved
   * state (agent-persistence R8); `exposesFiles` when it is cloud-granted and the channel's file space holds a file
   * (agent-files R7).
   */
  | {
      readonly type: 'announced';
      readonly message: ChannelMessage;
      readonly resumed?: ResumedFrom;
      readonly exposesFiles?: true;
    }
  | { readonly type: 'posted'; readonly message: ConversationMessage; readonly working: readonly string[] }
  | { readonly type: 'message'; readonly message: ConversationMessage; readonly working: readonly string[] }
  /** `conversation` since agent-persistence R9 (i): which conversation the working set is of. */
  | { readonly type: 'status'; readonly conversation: string; readonly working: readonly string[] }
  | {
      readonly type: 'agent_left';
      readonly conversation: string;
      readonly agent: string;
      readonly detail: string;
      readonly working: readonly string[];
    }
  | ModelDeltaEvent
  | ModelDoneEvent
  | { readonly type: 'error'; readonly reason: ConversationErrorReason; readonly detail: string };

/**
 * One event of the SSE stream `GET /v1/channel` responds with (R5): everything
 * that happens on the channel, across every conversation — the models' output
 * included — until the watcher hangs up, or the daemon ends it with `error`.
 */
export type WatchEvent =
  | { readonly type: 'watching'; readonly channel: string; readonly agents: readonly string[] }
  | { readonly type: 'message'; readonly message: ChannelMessage }
  | { readonly type: 'agent_joined'; readonly agent: string }
  | { readonly type: 'agent_left'; readonly agent: string; readonly detail: string }
  | ModelDeltaEvent
  | ModelDoneEvent
  | { readonly type: 'error'; readonly reason: ConversationErrorReason; readonly detail: string };

/** One online agent, as `GET /v1/agents` lists it. */
export interface AgentSummary {
  readonly handle: string;
  readonly channel: string;
  readonly recipe: string;
  readonly image: string;
  /** The cloud modules and hosted models it may send data to (extension-modules R21); absent for none. */
  readonly cloud?: readonly string[];
}

/** An enabled metered module's spend, in USD, UTC (extension-modules R21). */
interface ModuleSpend {
  readonly module: string;
  readonly day: number;
  readonly dayCap: number;
  readonly month: number;
  readonly monthCap: number;
}

/** The daemon's answer to `GET /v1/health`: its pid, version, build and start, the agents online and any metered spend. */
export interface HealthResponse {
  readonly ok: true;
  readonly pid: number;
  readonly version: string;
  /** Fingerprint of the compiled code the daemon runs (src/shared/build.ts); the CLI warns when its own differs. */
  readonly build: string;
  /** When the daemon started, ISO 8601. */
  readonly startedAt: string;
  readonly agents: readonly AgentSummary[];
  /** Each enabled metered module's spend (extension-modules R21); absent when none is enabled. */
  readonly spend?: readonly ModuleSpend[];
}

/** `POST /v1/stop`'s answer (docs/plans/portal.md R14): the pid of the daemon that is about to stop. */
export interface StopResponse {
  readonly pid: number;
}

/** One online agent's telemetry (R10): counted from the daemon's own spans since it joined, never an agent's. */
export interface AgentTelemetry {
  readonly handle: string;
  readonly recipe: string;
  /** The team it was launched with; null for a recipe launched alone (docs/plans/portal-scene-chat.md R7). */
  readonly team: string | null;
  /** Its recipe's model, by catalogue id. */
  readonly model: string;
  /** `asha.delivery` spans recorded for it. */
  readonly deliveries: number;
  /** `asha.chat` and `asha.embed` spans recorded for it. */
  readonly modelCalls: number;
  /** The duration of its most recently ended model-call span, in ms; null before the first. */
  readonly lastModelCallMs: number | null;
  /** Its model calls in flight now. */
  readonly modelCallsInFlight: number;
  /** Its most recently ended daemon span with status `error`: which span, why, and when it ended; null for none. */
  readonly lastError: { readonly span: string; readonly reason: string; readonly at: string } | null;
}

/** `GET /v1/telemetry?channel=<name>` (R10): one entry per agent online on the channel, sorted by handle. */
export interface TelemetryResponse {
  readonly channel: string;
  readonly agents: readonly AgentTelemetry[];
}

/** A recipe or team that does not parse (portal-scene-chat R13): its id, and why, with paths relative to the daemon's root. */
export interface DefinitionProblem {
  readonly id: string;
  readonly problem: string;
}

/** A recipe the daemon can launch alone (R13). */
export interface CatalogRecipe {
  readonly id: string;
  readonly description: string;
  readonly model: string;
}

/** A team the daemon can launch (R13): its members in the team file's order. */
export interface CatalogTeam {
  readonly id: string;
  readonly description: string;
  readonly members: readonly { readonly name: string; readonly recipe: string; readonly description: string }[];
}

/** `GET /v1/definitions` (R13): recipes and teams, each sorted by id, test fixtures (`suite-*`) left out. */
export interface DefinitionsResponse {
  readonly recipes: readonly (CatalogRecipe | DefinitionProblem)[];
  readonly teams: readonly (CatalogTeam | DefinitionProblem)[];
}

/** One scenario of a pattern demo (R16): each message command as the request the CLI would send for it. */
export interface DemoScenario {
  readonly id: string;
  /** `conversation: "@previous"` stands for the previous step's conversation, filled in by the page (R17). */
  readonly steps: readonly ConversationRequest[];
}

/** What every listed demo holds (R16). */
interface DemoBase {
  readonly pattern: string;
  readonly title: string;
  readonly page: string;
  readonly team: string;
  readonly boundMs: number;
  /** The first `pNN-<k>` naming no channel on the daemon. */
  readonly channel: string;
}

/** A pattern demo the page can run, or one it cannot, saying why (R16), from its page's `asha-run` block. */
export type Demo =
  | (DemoBase & { readonly runnable: true; readonly scenarios: readonly DemoScenario[] })
  | (DemoBase & { readonly runnable: false; readonly reason: string; readonly scenarios: readonly [] });

/** A demo page whose block does not parse (R16). */
export interface DemoProblem {
  readonly pattern: string;
  readonly page: string;
  readonly problem: string;
}

/** `GET /v1/demos` (R16): `shipped` false, and no demos, when the daemon's root holds no `docs/patterns/`. */
export interface DemosResponse {
  readonly shipped: boolean;
  readonly demos: readonly (Demo | DemoProblem)[];
}

// ------------------------------------------------------------- saved state

/** What a saved asset belongs to: an agent (`<channel>/<team or ->/<name>`) or a channel (`<channel>`). */
type StateKind = 'agent' | 'channel';

/** One saved asset, as `--list-state` prints it (docs/plans/agent-persistence.md R5). */
export interface StateAsset {
  readonly kind: StateKind;
  readonly identity: string;
  /** `unreadable`: an identity whose pointer or record does not read, or a stray file; its `savedAt` is `unknown`. */
  readonly asset: AgentAsset | ChannelAsset | 'unreadable';
  readonly bytes: number;
  /** When the generation holding it was promoted, ISO 8601. */
  readonly savedAt: string;
  /** A bound is reached (R6, R14): later saves of it fail until reset or erase. */
  readonly full: boolean;
  /** A channel whose saved state was written while an agent that keeps memory was online on it (R7). */
  readonly tainted: boolean;
}

/** A persisted agent's record of unsaved deliveries (R9), when it holds any. */
export interface StatePending {
  readonly identity: string;
  readonly bytes: number;
  /** The oldest entry's savedAt. */
  readonly savedAt: string;
}

/** `GET /v1/state`. `totalBytes` counts every asset and every pending record. */
export interface StateListResponse {
  readonly assets: readonly StateAsset[];
  readonly pending: readonly StatePending[];
  readonly totalBytes: number;
}

/**
 * What a reset or an erase names (R5, R16): everything, a channel's agents and its board and files, or one agent
 * (`team` for a team member; a solo launch's `name` is its recipe's id).
 */
export type StateSelector =
  { readonly all: true } | { readonly channel: string; readonly name?: string; readonly team?: string };

/**
 * `POST /v1/state/reset`: the selector's fields, and `user` for R16's per-user erase.
 *
 * @public — part of the HTTP API's wire, for its clients (docs/architecture/index.md), though no harness code names it.
 */
export type StateResetRequest = StateSelector & { readonly user?: string };

/**
 * One removed thing: an asset, or (`pending`) an agent's record of unsaved deliveries, or (`unreadable`) an identity
 * whose pointer or record could not be read, or a stray file where the store keeps only directories — removed whole,
 * its bytes those of every file under it, so a corrupt store is always recoverable by the reset its error names.
 */
export interface StateRemoved {
  readonly kind: StateKind;
  readonly identity: string;
  readonly asset: AgentAsset | ChannelAsset | 'pending' | 'unreadable';
  readonly bytes: number;
}

/** 200 to a reset without `user`. A refusal is 409 `{error, reason}` with reason `online` or `nothing_matches`, removing nothing. */
export interface StateResetResponse {
  readonly removed: readonly StateRemoved[];
}

/** Why a reset or an erase was refused before anything was removed (409). */
export type StateRefusalReason = 'online' | 'nothing_matches';

/** Why one identity's erase failed (R16), its previous generation kept. */
export type EraseFailureReason =
  'erase_unsupported' | 'exit_nonzero' | 'timeout' | 'bad_output' | 'save_failed' | 'erase_not_subset';

/**
 * One event of the SSE stream a reset with `user` answers (R16): per identity as it finishes, one of `erased`,
 * `no_memory` or `erase_failed`; then one `kept` per shared asset the selector covers; then `erase_done`.
 */
export type StateEraseEvent =
  | {
      readonly type: 'erased';
      readonly identity: string;
      readonly files: number;
      readonly bytes: number;
      readonly pendingMessages: number;
    }
  | { readonly type: 'no_memory'; readonly identity: string; readonly pendingMessages: number }
  /** `pendingMessages`: the user's unsaved messages already removed before the failure (the record is written first). */
  | {
      readonly type: 'erase_failed';
      readonly identity: string;
      readonly reason: EraseFailureReason;
      readonly pendingMessages: number;
    }
  | {
      readonly type: 'kept';
      readonly kind: StateKind;
      readonly identity: string;
      readonly asset: AgentAsset | ChannelAsset;
    }
  | { readonly type: 'erase_done' }
  | { readonly type: 'error'; readonly reason: ConversationErrorReason; readonly detail: string };

/**
 * Written by `asha --server` (mode 0600, by create-and-rename) so the CLI can
 * find the daemon and authenticate to it.
 */
export interface DaemonFile {
  readonly pid: number;
  readonly port: number;
  /** The control credential: sent as `Authorization: Bearer <credential>` on every `/v1/` request. */
  readonly credential: string;
  /**
   * Written true when the daemon begins to stop; the file is removed once its lock is released (docs/plans/debt-paydown.md
   * R14, R15). Absent while it runs. An older CLI ignores it.
   */
  readonly stopping?: true;
}

// ------------------------------------------------------------------ traces

/** The header an agent's chat, embed and conversation post carry: its own span, in W3C trace context form. */
export const TRACEPARENT_HEADER = 'traceparent';

/** A W3C trace context's parts: the trace and the parent span an agent's request continues. */
export interface TraceParent {
  readonly traceId: string;
  readonly spanId: string;
}

/** `00-<trace id>-<span id>-01`: version 00, sampled. */
export function formatTraceparent(parent: TraceParent): string {
  return `00-${parent.traceId}-${parent.spanId}-01`;
}

/** A `traceparent` value asha accepts — version 00, lowercase hex, non-zero IDs, sampled — or undefined. */
export function parseTraceparent(value: string | undefined): TraceParent | undefined {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(value ?? '');
  if (m === null) return undefined;
  const traceId = present(m[1], 'parseTraceparent: capture group 1 (trace id)');
  const spanId = present(m[2], 'parseTraceparent: capture group 2 (span id)');
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

/**
 * Why a span ended in error: the only status messages a span may carry
 * (docs/plans/otel-traces.md R4). The model-call reasons are
 * ModelFailureReason's.
 */
export const TRACE_REASONS = [
  'handler_failed',
  'agent_left',
  'expired',
  'unanswered',
  'timeout',
  'unavailable',
  'upstream_error',
  'bad_response',
  'truncated',
  'refused',
  // A metered provider's refusals (extension-modules R18b, R19): every ModelFailureReason is a TraceReason.
  'budget_exceeded',
  'budget_meter_unavailable',
] as const satisfies readonly string[];

/** One of TRACE_REASONS: why a span ended in error. */
export type TraceReason = (typeof TRACE_REASONS)[number];

/** A failed model call's span says why with its ModelFailureReason: every one is a TraceReason (checked by the compiler here). */
export function traceReasonOf(reason: ModelFailureReason): TraceReason {
  return reason;
}

/** The spans an agent sends: one per delivery, and one per chat, embed and conversation post. */
export const AGENT_SPAN_NAMES = ['delivery', 'chat', 'embed', 'post'] as const;
export type AgentSpanName = (typeof AGENT_SPAN_NAMES)[number];

// ---------------------------------------------------------------- blackboard

/** Bounds of one channel's blackboard (docs/plans/agent-tools.md R10). */
export const BLACKBOARD_MAX_ENTRIES = 256;
/**
 * The most bytes of JSON one read answers with — `{entries, more}` as sent, which is what enters an agent's
 * context. A post whose entry would not fit one read alone is refused `entry_too_large`, so every entry can be
 * read (agent-tools R10; counted as text bytes until the completion review's finding 4, 2026-09-27).
 */
export const BLACKBOARD_MAX_READ_BYTES = 8 * 1024;

/** One blackboard entry. `author` is the poster's handle, taken from its token; `id` counts up from 1 per channel. */
export interface BlackboardEntry {
  readonly id: number;
  readonly author: string;
  /** ISO-8601. */
  readonly ts: string;
  readonly text: string;
  /**
   * The channel's session it was posted in: 1, plus one each time a persisted board is resumed
   * (docs/plans/agent-persistence.md R14), so an agent can tell an earlier session's handles from this one's.
   */
  readonly session: number;
}

/** `GET /agent/v1/blackboard?since=<id>`: entries after `since`, in order, at most 8 KiB of text; `more` when some were left out. */
export interface BlackboardReadResponse {
  readonly entries: readonly BlackboardEntry[];
  readonly more: boolean;
}

/** `POST /agent/v1/blackboard` answers 200 with the stored entry. */
export interface BlackboardPostResponse {
  readonly entry: BlackboardEntry;
}

/**
 * The refusals of the blackboard routes, each `{error: <reason>}` with nothing stored: text over 8 KiB (413),
 * a post beyond 256 entries (409), empty text or a body that is not `{text: string}`, or a bad `since` (400).
 */
export const BLACKBOARD_REFUSALS = { entry_too_large: 413, blackboard_full: 409, invalid_arguments: 400 } as const;

/** One of BLACKBOARD_REFUSALS' keys: why a blackboard write was refused. */
export type BlackboardRefusal = keyof typeof BLACKBOARD_REFUSALS;
