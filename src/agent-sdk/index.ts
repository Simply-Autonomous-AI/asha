// The agent SDK: what code inside an agent container uses to reach the
// harness. Agents depend on the ModelClient and ChannelClient contracts; the
// harness implementation is HarnessClient. serveAgent is the agent's main
// loop: it joins the channel under the name the agent chose, learns the
// handle the channel gave it, then handles and acks every delivery — the ack
// is what tells the channel the agent has finished working on it. Each
// delivery is a span, and so is each chat, embed and conversation post it
// makes (telemetry.ts); the spans are flushed before the ack.

import { access, constants, readFile, stat } from 'node:fs/promises';

import {
  AgentEnv,
  BLACKBOARD_REFUSALS,
  CALL_REFUSAL_REASONS,
  Routes,
  TRACEPARENT_HEADER,
  traceReasonOf,
  type AgentInfo,
  type AckRequest,
  type AgentStreamEvent,
  type BlackboardEntry,
  type BlackboardPostResponse,
  type BlackboardReadResponse,
  type BlackboardRefusal,
  type CallAnswerRequest,
  type CallAnswerResponse,
  type CallRefusalReason,
  type ChannelMessage,
  type ConsultRequest,
  type ConsultResponse,
  type ChatRequest,
  type ChatResponse,
  type Delivery,
  type EmbedRequest,
  type EmbedResponse,
  type GuidanceDocument,
  type PostRequest,
  type ResumedFrom,
  type RosterResponse,
  type TraceReason,
  type AgentAsset,
  type ModuleCallRequest,
  type ModuleCallResponse,
  type ModuleToolOffer,
  LAUNCH_AGENT_TIMEOUT_MS,
  LAUNCH_REFUSAL_REASONS,
  type AgentLaunchRequest,
  type AgentLaunchResponse,
  type LaunchGrant,
} from '../shared/protocol.js';
import { withTimeout } from '../shared/abort.js';
import { present } from '../shared/assert-present.js';
import {
  TOOL_FAILURE_REASONS,
  parseImageManifest,
  parseToolParameters,
  type ImageManifest,
  type ToolFailureReason,
} from '../shared/tools.js';
import type { BlackboardAnswer, BlackboardClient } from './blackboard-tools.js';
import { blackboardTools } from './blackboard-tools.js';
import { fileTools } from './file-tools.js';
import type { AgentLog } from './log.js';
import type { AgentTelemetry, CallOutcome } from './telemetry.js';
import {
  ASK_USER,
  ASK_USER_TOOL,
  LAUNCH_AGENT,
  REPLY_WITH_FILES,
  REPLY_WITH_FILES_TOOL,
  launchAgentTool,
  type FilesReplyResult,
  type LaunchResult,
} from './channel.js';
import { AgentTools, checkImageTools, imageTool, type ImageToolHandler, type ToolImplementation } from './tools.js';

export * from './blackboard-tools.js';
export * from './channel.js';
export * from './file-tools.js';
export * from './log.js';
export * from './telemetry.js';
export * from './tools.js';
import { ONLINE_STATUS } from './channel.js';

export interface ModelClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/** Texts to vectors through the harness, with the recipe's embedding model. */
export interface EmbeddingClient {
  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<EmbedResponse>;
}

/** An open channel stream: who the channel says this agent is, and its deliveries. */
export interface ChannelSession {
  /** The agent's handle on the channel, e.g. `hewo-1`. */
  readonly handle: string;
  readonly channel: string;
  /** The tools its recipe selects, from the welcome event (docs/plans/agent-tools.md R1). */
  readonly tools: readonly string[];
  /** Its recipe's system prompt, its role text, from the welcome event (docs/plans/collaborating-agents.md R1). */
  readonly prompt: string;
  /** Its recipe's full-text documents, from the welcome event, for its system prompt on every turn (R2). */
  readonly guidance: readonly GuidanceDocument[];
  /**
   * What its recipe persists, for a persisted agent (docs/plans/agent-persistence.md R10): such an agent acks a
   * delivery only once the background work it started has settled, so the checkpoint after the ack holds it.
   */
  readonly persist?: readonly AgentAsset[];
  /** When it resumed saved state, and its handle then (R8). */
  readonly resumed?: ResumedFrom;
  /** Its granted module tools (docs/plans/extension-modules.md R10): [] for none, and from a welcome without them. */
  readonly modules: readonly ModuleToolOffer[];
  /** Its launch grant (docs/plans/patterns-phase-3.md R29), when its recipe has one: it offers `launch_agent`. */
  readonly launch?: LaunchGrant;
  /** Its recipe names `nestedCalls: true` (R33): its call turns offer consult. */
  readonly nestedCalls?: true;
  /** The agent's deliveries, in order, until the harness closes the stream. */
  readonly deliveries: AsyncIterable<Delivery>;
}

/**
 * The bound on an output with files (docs/plans/agent-files.md R12): the daemon answers it within 20 s — 10 for the
 * space's lock, then the copies — so the agent's usual 10 s request bound would cut it short.
 */
export const REPLY_WITH_FILES_TIMEOUT_MS = 30_000;

/** A module call's outcome as a tool's (extension-modules R8): its result, or a reason from the closed set. */
export type ToolOutcomeLike =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: ToolFailureReason };

/** The SDK's margin over a module tool's bound (R10): the harness answers at timeoutMs, so its answer comes first. */
export const MODULE_CALL_MARGIN_MS = 5_000;

/** Granted module tools as the agent runs them (R10): offered after the selected tools, each run through the module-call route. */
export function moduleTools(
  offers: readonly ModuleToolOffer[],
  client: { moduleCall(request: ModuleCallRequest, signal: AbortSignal): Promise<ToolOutcomeLike> },
): Map<string, ToolImplementation> {
  return new Map(
    offers.map((offer): [string, ToolImplementation] => [
      offer.name,
      {
        definition: {
          type: 'function',
          function: { name: offer.name, description: offer.description, parameters: offer.parameters },
        },
        parameters: parseToolParameters(offer.parameters),
        timeoutMs: offer.timeoutMs + MODULE_CALL_MARGIN_MS,
        run: (args, signal) => client.moduleCall({ tool: offer.name, arguments: args }, signal),
      },
    ]),
  );
}

/** A call route's answer: its value, or the channel's refusal as data (docs/plans/agent-calls.md R2, R5). */
export type CallResult<T, R extends CallRefusalReason = CallRefusalReason> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: R };

export interface ChannelClient {
  /** Joins the channel under `name`; the channel makes it unique (`name-1`, `name-2`, …). */
  open(name: string): Promise<ChannelSession>;
  post(request: PostRequest): Promise<ChannelMessage>;
  /**
   * An output with files from /channel (docs/plans/agent-files.md R12), bounded by REPLY_WITH_FILES_TIMEOUT_MS: the
   * daemon copies each out and checks it. Its 409 `file_refused` is data; any other refusal throws.
   */
  postFiles(request: {
    readonly conversation: string;
    readonly text: string;
    readonly files: readonly string[];
  }): Promise<CallResult<ChannelMessage, never> | { readonly ok: false; readonly reason: 'file_refused' }>;
  /** Opens a call while handling `request.delivery`; any 409 refusal is data (R2). */
  consult(request: ConsultRequest): Promise<CallResult<ConsultResponse>>;
  /** Answers or passes the call question held as `request.delivery`; call_closed is data, any other refusal throws (R5). */
  answerCall(request: CallAnswerRequest): Promise<CallResult<CallAnswerResponse, 'call_closed'>>;
  ack(deliveryId: string): Promise<void>;
  /** The other online agents on this agent's channel, with what each does. */
  roster(): Promise<AgentInfo[]>;
  /**
   * Launches a recipe the agent's grant names, for the delivery it holds (docs/plans/patterns-phase-3.md R30), bounded
   * by LAUNCH_AGENT_TIMEOUT_MS: the handle, or `{error}` for a refusal, the daemon stopping or the bound. Required of a
   * client whose agent has a launch grant.
   */
  launchAgent?(request: AgentLaunchRequest): Promise<LaunchResult>;
}

export interface AgentEnvironment {
  readonly harnessUrl: string;
  readonly agentToken: string;
}

/** A required agent environment variable is absent. The agent cannot run. */
export class MissingAgentEnvironment extends Error {
  constructor(readonly variable: string) {
    super(`${variable} is required; an agent never guesses how to reach the harness`);
    this.name = 'MissingAgentEnvironment';
  }
}

/** The harness rejected a request — a contract violation, not a model failure. */
export class HarnessRequestError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    readonly body: string,
    options?: ErrorOptions,
  ) {
    super(`harness rejected ${route}: HTTP ${String(status)}: ${body}`, options);
    this.name = 'HarnessRequestError';
  }
}

/**
 * The channel refused a post, a consult or an answer for a reason the turn cannot change (docs/plans/patterns-phase-3.md
 * R19, R24): the harness ended the conversation (`conversation_ended`), or one of its asks already waits for the user
 * (`ask_open`). Nothing was posted. serveAgent ends the turn here, logs `post.refused` once, and acks the delivery: the
 * agent goes on, never failing for it.
 */
export class PostRefused extends HarnessRequestError {
  constructor(
    route: string,
    readonly reason: PostRefusalReason,
    body: string,
  ) {
    super(route, 409, body);
    this.name = 'PostRefused';
  }
}

/** The refusals PostRefused carries (R19, R24). */
export const POST_REFUSALS = ['conversation_ended', 'ask_open'] as const;
export type PostRefusalReason = (typeof POST_REFUSALS)[number];

/** A 409's reason, when it is one PostRefused carries; else undefined. A body that is no JSON is the caller's to say. */
function postRefusal(text: string): PostRefusalReason | undefined {
  let reason: unknown;
  try {
    reason = (JSON.parse(text) as { reason?: unknown }).reason;
  } catch {
    return undefined;
  }
  return typeof reason === 'string' && (POST_REFUSALS as readonly string[]).includes(reason)
    ? (reason as PostRefusalReason)
    : undefined;
}

/** The channel stream went silent for longer than its bound. */
export class ChannelStreamStalled extends Error {
  constructor(readonly idleMs: number) {
    super(`no word from the harness on the channel stream for ${String(idleMs)} ms`);
    this.name = 'ChannelStreamStalled';
  }
}

export function readAgentEnvironment(env: NodeJS.ProcessEnv): AgentEnvironment {
  const harnessUrl = env[AgentEnv.harnessUrl];
  if (!harnessUrl) throw new MissingAgentEnvironment(AgentEnv.harnessUrl);
  const agentToken = env[AgentEnv.agentToken];
  if (!agentToken) throw new MissingAgentEnvironment(AgentEnv.agentToken);
  return { harnessUrl, agentToken };
}

export interface HarnessClientProps {
  readonly environment: AgentEnvironment;
  /** Bound on one model call, end to end through the harness. */
  readonly chatTimeoutMs: number;
  /** Bound on a post or an ack. */
  readonly requestTimeoutMs: number;
  /** Bound on an output with files (REPLY_WITH_FILES_TIMEOUT_MS in an image): the daemon's answer takes up to 20 s (agent-files R12). */
  readonly filesRequestTimeoutMs: number;
  /** Bound on silence on the channel stream; the harness heartbeats well inside it. */
  readonly streamIdleTimeoutMs: number;
  /** Injected for tests; the global fetch in production. */
  readonly fetch: typeof fetch;
  /** Every chat, embed and conversation post is a span of the delivery being handled. */
  readonly telemetry: AgentTelemetry;
}

/** A model call's span: ok, or the call's failure reason. */
function modelOutcome(response: ChatResponse | EmbedResponse): CallOutcome {
  return response.ok ? { status: 'ok' } : { status: 'error', reason: traceReasonOf(response.reason) };
}

/** A call route's span: ok, or refused when the channel refused it. */
function refusedOutcome(result: CallResult<unknown>): CallOutcome {
  return result.ok ? { status: 'ok' } : { status: 'error', reason: 'refused' };
}

/** A harness call that threw: the harness refused it, it timed out, it could not reach the harness, or the answer was unusable. */
function harnessFailure(error: unknown): TraceReason {
  if (error instanceof HarnessRequestError) return 'refused';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof TypeError && error.message === 'fetch failed') return 'unavailable';
  return 'bad_response';
}

// The welcome is the harness's own JSON, typed as AgentStreamEvent — but every field below is still checked as
// data, since a malformed welcome must fail loudly here rather than mis-offer a tool the agent cannot run
// (PRINCIPLES §11). Each check reads its field through `unknown`, never the welcome's declared type: that type is
// only ever as true as the harness that sent the bytes, so trusting it here would make a genuinely malformed field
// invisible to the type checker, and the field's narrower declared type (e.g. `nestedCalls?: true`) would make the
// very check that catches a wrong value (e.g. `nestedCalls: false`) look like dead code.

function invalidNestedCalls(nestedCalls: unknown): boolean {
  return nestedCalls !== undefined && nestedCalls !== true;
}

function invalidLaunch(launch: unknown): boolean {
  if (launch === undefined) return false;
  if (typeof launch !== 'object' || launch === null) return true;
  const raw = launch as Record<string, unknown>;
  return (
    !Array.isArray(raw['recipes']) ||
    !(raw['recipes'] as unknown[]).every((r) => typeof r === 'string') ||
    typeof raw['maxPerConversation'] !== 'number'
  );
}

function invalidModule(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return true;
  const m = entry as Record<string, unknown>;
  return (
    typeof m['name'] !== 'string' ||
    typeof m['description'] !== 'string' ||
    typeof m['parameters'] !== 'object' ||
    m['parameters'] === null ||
    typeof m['timeoutMs'] !== 'number'
  );
}

function invalidModules(modules: unknown): boolean {
  return modules !== undefined && (!Array.isArray(modules) || modules.some(invalidModule));
}

function invalidPersist(persist: unknown): boolean {
  return (
    persist !== undefined && (!Array.isArray(persist) || !persist.every((a) => a === 'memory' || a === 'workspace'))
  );
}

function invalidTools(tools: unknown): boolean {
  return !Array.isArray(tools) || !tools.every((t) => typeof t === 'string');
}

function invalidPrompt(prompt: unknown): boolean {
  return typeof prompt !== 'string' || prompt === '';
}

function invalidGuidanceEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return true;
  const d = entry as Record<string, unknown>;
  return typeof d['path'] !== 'string' || typeof d['text'] !== 'string';
}

function invalidGuidance(guidance: unknown): boolean {
  return !Array.isArray(guidance) || guidance.some(invalidGuidanceEntry);
}

export class HarnessClient implements ModelClient, EmbeddingClient, ChannelClient, BlackboardClient {
  constructor(private readonly props: HarnessClientProps) {}

  get requestTimeoutMs(): number {
    return this.props.requestTimeoutMs;
  }

  /** The channel's blackboard entries after `since`; bounded by `signal` and the request timeout. No span. */
  async blackboardRead(
    since: number | undefined,
    signal: AbortSignal,
  ): Promise<BlackboardAnswer<BlackboardReadResponse>> {
    const url = new URL(Routes.agentBlackboard, this.props.environment.harnessUrl);
    if (since !== undefined) url.searchParams.set('since', String(since));
    const response = await this.props.fetch(url, {
      headers: { authorization: `Bearer ${this.props.environment.agentToken}` },
      signal: withTimeout(this.props.requestTimeoutMs, signal),
    });
    return this.blackboardAnswer(response, (body) => body as BlackboardReadResponse);
  }

  /** Posts to the channel's blackboard; the harness takes the author from this agent's token. No span. */
  async blackboardPost(text: string, signal: AbortSignal): Promise<BlackboardAnswer<BlackboardEntry>> {
    const response = await this.props.fetch(new URL(Routes.agentBlackboard, this.props.environment.harnessUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.props.environment.agentToken}` },
      body: JSON.stringify({ text }),
      signal: withTimeout(this.props.requestTimeoutMs, signal),
    });
    return this.blackboardAnswer(response, (body) => (body as BlackboardPostResponse).entry);
  }

  /** 2xx is the value; exactly the routes' three refusals are data (R10); any other answer throws HarnessRequestError. */
  private async blackboardAnswer<T>(response: Response, read: (body: unknown) => T): Promise<BlackboardAnswer<T>> {
    if (response.ok) return { ok: true, value: read(await response.json()) };
    const text = await response.text();
    let error: unknown;
    try {
      error = (JSON.parse(text) as { error?: unknown }).error;
    } catch (parseError) {
      throw new HarnessRequestError(Routes.agentBlackboard, response.status, text, { cause: parseError });
    }
    if (
      typeof error === 'string' &&
      Object.hasOwn(BLACKBOARD_REFUSALS, error) &&
      BLACKBOARD_REFUSALS[error as BlackboardRefusal] === response.status
    ) {
      return { ok: false, reason: error as BlackboardRefusal };
    }
    throw new HarnessRequestError(Routes.agentBlackboard, response.status, text);
  }

  /** A `chat` span of the current delivery; outside one it throws NoDeliveryContext and sends nothing. */
  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.props.telemetry.call(
      'chat',
      (traceparent) => this.chatOnce(request, traceparent),
      modelOutcome,
      harnessFailure,
    );
  }

  /** An `embed` span of the current delivery; outside one it throws NoDeliveryContext and sends nothing. */
  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<EmbedResponse> {
    return this.props.telemetry.call(
      'embed',
      (traceparent) => this.embedOnce({ texts, purpose }, traceparent),
      modelOutcome,
      harnessFailure,
    );
  }

  /**
   * A post with a conversation is a `post` span of the current delivery
   * (outside one it throws NoDeliveryContext and sends nothing); a presence
   * status, with no conversation, is not traced.
   */
  post(request: PostRequest): Promise<ChannelMessage> {
    if (request.conversation === undefined) return this.postOnce(request, undefined);
    return this.props.telemetry.call(
      'post',
      (traceparent) => this.postOnce(request, traceparent),
      () => ({ status: 'ok' }),
      harnessFailure,
    );
  }

  /**
   * A `post` span of the current delivery: an output with files (agent-files R12), bounded by 30 s rather than the
   * 10 s of every other post. A 409 `file_refused` is data; any other refusal throws HarnessRequestError.
   */
  postFiles(request: {
    readonly conversation: string;
    readonly text: string;
    readonly files: readonly string[];
  }): Promise<CallResult<ChannelMessage, never> | { readonly ok: false; readonly reason: 'file_refused' }> {
    return this.props.telemetry.call(
      'post',
      async (traceparent) => {
        const body: PostRequest = {
          conversation: request.conversation,
          kind: 'output',
          text: request.text,
          files: request.files,
        };
        const response = await this.post_(Routes.agentMessages, body, this.props.filesRequestTimeoutMs, traceparent);
        if (response.ok)
          return { ok: true as const, value: ((await response.json()) as { message: ChannelMessage }).message };
        const text = await response.text();
        if (response.status === 409) {
          let reason: unknown;
          try {
            reason = (JSON.parse(text) as { reason?: unknown }).reason;
          } catch (parseError) {
            throw new HarnessRequestError(Routes.agentMessages, response.status, text, { cause: parseError });
          }
          if (reason === 'file_refused') return { ok: false as const, reason: 'file_refused' as const };
          const refused = postRefusal(text);
          if (refused !== undefined) throw new PostRefused(Routes.agentMessages, refused, text);
        }
        throw new HarnessRequestError(Routes.agentMessages, response.status, text);
      },
      (result) => (result.ok ? { status: 'ok' } : { status: 'error', reason: 'refused' }),
      harnessFailure,
    );
  }

  /**
   * A `post` span of the current delivery: POST /agent/v1/agents (R30), bounded at LAUNCH_AGENT_TIMEOUT_MS by a timer
   * of its own. 200 is the handle; a 409 with a launch refusal reason, a 503 (`stopping`) and the bound (`timeout`) are
   * data for the model; anything else — a 400, a 401 — is a defect and throws HarnessRequestError.
   */
  launchAgent(request: AgentLaunchRequest): Promise<LaunchResult> {
    return this.props.telemetry.call(
      'post',
      async (traceparent): Promise<LaunchResult> => {
        const bound = new AbortController();
        const timer = setTimeout(() => {
          bound.abort(new DOMException(`no answer within ${String(LAUNCH_AGENT_TIMEOUT_MS)} ms`, 'TimeoutError'));
        }, LAUNCH_AGENT_TIMEOUT_MS);
        let response: Response;
        let text: string;
        try {
          response = await this.props.fetch(new URL(Routes.agentLaunch, this.props.environment.harnessUrl), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.props.environment.agentToken}`,
              [TRACEPARENT_HEADER]: traceparent,
            },
            body: JSON.stringify(request),
            signal: bound.signal,
          });
          text = await response.text();
        } catch (error) {
          // The bound is the model's to hear (R30): the daemon stops the launch it abandons.
          if (bound.signal.aborted) return { error: 'timeout' };
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (response.ok) return { handle: (JSON.parse(text) as AgentLaunchResponse).handle };
        if (response.status === 503) return { error: 'stopping' };
        if (response.status === 409) {
          let reason: unknown;
          try {
            reason = (JSON.parse(text) as { reason?: unknown }).reason;
          } catch (parseError) {
            throw new HarnessRequestError(Routes.agentLaunch, response.status, text, { cause: parseError });
          }
          if (typeof reason === 'string' && (LAUNCH_REFUSAL_REASONS as readonly string[]).includes(reason))
            return { error: reason };
        }
        throw new HarnessRequestError(Routes.agentLaunch, response.status, text);
      },
      (result) =>
        'handle' in result
          ? { status: 'ok' }
          : { status: 'error', reason: result.error === 'timeout' ? 'timeout' : 'refused' },
      harnessFailure,
    );
  }

  /** A `post` span of the current delivery: POST /agent/v1/channel/calls. A 409 with a call refusal reason is data. */
  consult(request: ConsultRequest): Promise<CallResult<ConsultResponse>> {
    return this.props.telemetry.call(
      'post',
      async (traceparent) => {
        const response = await this.post_(Routes.agentCalls, request, this.props.requestTimeoutMs, traceparent);
        return this.callAnswer(
          Routes.agentCalls,
          response,
          (reason) => reason,
          (body) => body as ConsultResponse,
        );
      },
      refusedOutcome,
      harnessFailure,
    );
  }

  /** A `post` span of the current delivery: POST /agent/v1/channel/calls/answer. Only call_closed is data (R5). */
  answerCall(request: CallAnswerRequest): Promise<CallResult<CallAnswerResponse, 'call_closed'>> {
    return this.props.telemetry.call(
      'post',
      async (traceparent) => {
        const response = await this.post_(Routes.agentCallAnswer, request, this.props.requestTimeoutMs, traceparent);
        return this.callAnswer(
          Routes.agentCallAnswer,
          response,
          (reason) => (reason === 'call_closed' ? reason : undefined),
          (body) => body as CallAnswerResponse,
        );
      },
      refusedOutcome,
      harnessFailure,
    );
  }

  /** 2xx is the value; a 409 whose reason `accept` takes is data; any other answer throws HarnessRequestError. */
  private async callAnswer<T, R extends CallRefusalReason>(
    route: string,
    response: Response,
    accept: (reason: CallRefusalReason) => R | undefined,
    read: (body: unknown) => T,
  ): Promise<CallResult<T, R>> {
    if (response.ok) return { ok: true, value: read(await response.json()) };
    const text = await response.text();
    if (response.status === 409) {
      let reason: unknown;
      try {
        reason = (JSON.parse(text) as { reason?: unknown }).reason;
      } catch (parseError) {
        throw new HarnessRequestError(route, response.status, text, { cause: parseError });
      }
      // The conversation ended, or an ask waits: the turn ends here, never acting on the refusal as a consult's (R19).
      const refused = postRefusal(text);
      if (refused !== undefined) throw new PostRefused(route, refused, text);
      const accepted =
        typeof reason === 'string' && (CALL_REFUSAL_REASONS as readonly string[]).includes(reason)
          ? accept(reason as CallRefusalReason)
          : undefined;
      if (accepted !== undefined) return { ok: false, reason: accepted };
    }
    throw new HarnessRequestError(route, response.status, text);
  }

  /**
   * A granted module tool's call (docs/plans/extension-modules.md R8), a `post` span of the current delivery, bounded
   * by `signal` (the tool's timeoutMs + 5,000 ms, R10): a 200's answer is the tool's result or its failure reason; a
   * 400 is `invalid_arguments` and a 403 `module_forbidden`, each the model's to read; any other status — a 401
   * included — is a harness defect that fails the turn.
   */
  moduleCall(request: ModuleCallRequest, signal: AbortSignal): Promise<ToolOutcomeLike> {
    return this.props.telemetry.call(
      'post',
      async (traceparent) => {
        const response = await this.props.fetch(new URL(Routes.agentModuleCall, this.props.environment.harnessUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.props.environment.agentToken}`,
            [TRACEPARENT_HEADER]: traceparent,
          },
          body: JSON.stringify(request),
          signal,
        });
        if (response.status === 400) return { ok: false as const, reason: 'invalid_arguments' as const };
        if (response.status === 403) return { ok: false as const, reason: 'module_forbidden' as const };
        if (response.status !== 200)
          throw new HarnessRequestError(Routes.agentModuleCall, response.status, await response.text());
        const body = (await response.json()) as ModuleCallResponse;
        if (body.ok) return { ok: true as const, value: body.result };
        if (!(TOOL_FAILURE_REASONS as readonly string[]).includes(body.reason))
          throw new HarnessRequestError(
            Routes.agentModuleCall,
            200,
            `a reason outside the closed set: ${JSON.stringify(body.reason)}`,
          );
        return { ok: false as const, reason: body.reason as ToolFailureReason };
      },
      (result) => (result.ok ? { status: 'ok' } : { status: 'error', reason: 'refused' }),
      harnessFailure,
    );
  }

  private async chatOnce(request: ChatRequest, traceparent: string): Promise<ChatResponse> {
    let response: Response;
    try {
      response = await this.post_(Routes.agentChat, request, this.props.chatTimeoutMs, traceparent);
    } catch (error) {
      // Reaching the harness failed: an expected external failure, returned as data.
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      return {
        ok: false,
        reason: timedOut ? 'timeout' : 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    await this.requireOk(Routes.agentChat, response);
    return (await response.json()) as ChatResponse;
  }

  private async embedOnce(request: EmbedRequest, traceparent: string): Promise<EmbedResponse> {
    let response: Response;
    try {
      response = await this.post_(Routes.agentEmbed, request, this.props.chatTimeoutMs, traceparent);
    } catch (error) {
      // Reaching the harness failed: an expected external failure, returned as data, as for chat.
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      return {
        ok: false,
        reason: timedOut ? 'timeout' : 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    await this.requireOk(Routes.agentEmbed, response);
    return (await response.json()) as EmbedResponse;
  }

  private async postOnce(request: PostRequest, traceparent: string | undefined): Promise<ChannelMessage> {
    const response = await this.post_(Routes.agentMessages, request, this.props.requestTimeoutMs, traceparent);
    if (response.status === 409) {
      const text = await response.text();
      const refused = postRefusal(text);
      throw refused === undefined
        ? new HarnessRequestError(Routes.agentMessages, 409, text)
        : new PostRefused(Routes.agentMessages, refused, text);
    }
    await this.requireOk(Routes.agentMessages, response);
    return ((await response.json()) as { message: ChannelMessage }).message;
  }

  async ack(deliveryId: string): Promise<void> {
    const body: AckRequest = { deliveryId };
    const response = await this.post_(Routes.agentAck, body, this.props.requestTimeoutMs);
    await this.requireOk(Routes.agentAck, response);
  }

  async roster(): Promise<AgentInfo[]> {
    const response = await this.props.fetch(new URL(Routes.agentRoster, this.props.environment.harnessUrl), {
      headers: { authorization: `Bearer ${this.props.environment.agentToken}` },
      signal: AbortSignal.timeout(this.props.requestTimeoutMs),
    });
    await this.requireOk(Routes.agentRoster, response);
    return [...((await response.json()) as RosterResponse).agents];
  }

  async open(name: string): Promise<ChannelSession> {
    const events = this.stream(name)[Symbol.asyncIterator]();
    const first = await events.next();
    if (first.done || first.value.type !== 'welcome') {
      throw new HarnessRequestError(
        Routes.agentChannel,
        200,
        `expected a welcome first, got ${JSON.stringify(first.value ?? null)}`,
      );
    }
    const { handle, channel, tools, prompt, guidance, persist, resumed, modules, launch, nestedCalls } = first.value;
    if (invalidNestedCalls(nestedCalls))
      throw new HarnessRequestError(
        Routes.agentChannel,
        200,
        `the welcome's nestedCalls is not true: ${JSON.stringify(first.value)}`,
      );
    if (invalidLaunch(launch)) {
      throw new HarnessRequestError(
        Routes.agentChannel,
        200,
        `the welcome's launch is not {recipes, maxPerConversation}: ${JSON.stringify(first.value)}`,
      );
    }
    if (invalidModules(modules)) {
      throw new HarnessRequestError(
        Routes.agentChannel,
        200,
        `the welcome's modules is not a list of {name, description, parameters, timeoutMs}: ${JSON.stringify(first.value)}`,
      );
    }
    if (invalidPersist(persist)) {
      throw new HarnessRequestError(
        Routes.agentChannel,
        200,
        `the welcome's persist is not a list of "memory" and "workspace": ${JSON.stringify(first.value)}`,
      );
    }
    if (invalidTools(tools)) {
      throw new HarnessRequestError(
        Routes.agentChannel,
        200,
        `the welcome carries no tools list: ${JSON.stringify(first.value)}`,
      );
    }
    // No image carries a role of its own (collaborating-agents R1): an agent without its recipe's prompt cannot start.
    if (invalidPrompt(prompt)) {
      throw new HarnessRequestError(
        Routes.agentChannel,
        200,
        `the welcome carries no prompt: ${JSON.stringify(first.value)}`,
      );
    }
    if (invalidGuidance(guidance)) {
      throw new HarnessRequestError(
        Routes.agentChannel,
        200,
        `the welcome carries no guidance list: ${JSON.stringify(first.value)}`,
      );
    }
    // The stream is read continuously, whatever the handler is doing: its idle bound measures the harness's
    // silence, not the agent's pace. (Read only between deliveries, a turn longer than the bound left the
    // heartbeats unread and aborted a healthy stream; found by memory-crowd, 2026-09-27.)
    const queued: Delivery[] = [];
    let ended = false;
    let failure: { readonly error: unknown } | undefined;
    let wake: (() => void) | undefined;
    void (async () => {
      try {
        for (let next = await events.next(); !next.done; next = await events.next()) {
          if (next.value.type === 'delivery') queued.push(next.value.delivery);
          wake?.();
        }
      } catch (error) {
        // Delivered to the consumer at its next pull, after any delivery already queued.
        failure = { error };
      } finally {
        ended = true;
        wake?.();
      }
    })();
    async function* deliveries(): AsyncIterable<Delivery> {
      for (;;) {
        const next = queued.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (failure !== undefined) throw failure.error;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    }
    return {
      handle,
      channel,
      tools,
      prompt,
      guidance,
      ...(persist === undefined ? {} : { persist }),
      ...(resumed === undefined ? {} : { resumed }),
      modules: modules ?? [],
      ...(launch === undefined ? {} : { launch }),
      ...(nestedCalls === true ? { nestedCalls } : {}),
      deliveries: deliveries(),
    };
  }

  /** Every event on the agent's channel stream, bounded by inactivity. */
  private async *stream(name: string): AsyncIterable<AgentStreamEvent> {
    const controller = new AbortController();
    let stalled = false;
    // Read through a closure, not the `stalled` variable directly: TypeScript's control-flow analysis cannot see
    // that `onIdle` (called later, from a timer) is what sets it, and would otherwise narrow a direct read in the
    // catch block below to the value `stalled` held at declaration, `false`.
    const isStalled = (): boolean => stalled;
    let idle = setTimeout(onIdle, this.props.streamIdleTimeoutMs);
    const idleMs = this.props.streamIdleTimeoutMs;
    function onIdle(): void {
      stalled = true;
      controller.abort();
    }
    try {
      const url = new URL(Routes.agentChannel, this.props.environment.harnessUrl);
      url.searchParams.set('name', name);
      const response = await this.props.fetch(url, {
        headers: { authorization: `Bearer ${this.props.environment.agentToken}` },
        signal: controller.signal,
      });
      await this.requireOk(Routes.agentChannel, response);
      if (response.body === null) throw new HarnessRequestError(Routes.agentChannel, response.status, 'no body');
      const decoder = new TextDecoder();
      let buffered = '';
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        clearTimeout(idle);
        idle = setTimeout(onIdle, idleMs);
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          yield JSON.parse(line) as AgentStreamEvent;
          newline = buffered.indexOf('\n');
        }
      }
    } catch (error) {
      if (isStalled()) throw new ChannelStreamStalled(idleMs);
      throw error;
    } finally {
      clearTimeout(idle);
      controller.abort();
    }
  }

  private post_(route: string, body: unknown, timeoutMs: number, traceparent?: string): Promise<Response> {
    return this.props.fetch(new URL(route, this.props.environment.harnessUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.props.environment.agentToken}`,
        ...(traceparent === undefined ? {} : { [TRACEPARENT_HEADER]: traceparent }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async requireOk(route: string, response: Response): Promise<void> {
    if (!response.ok) throw new HarnessRequestError(route, response.status, await response.text());
  }
}

export interface AgentContext {
  /** This agent's handle on the channel, e.g. `hewo-1`. */
  readonly handle: string;
  readonly channel: string;
  /** Its recipe's system prompt, its role text (docs/plans/collaborating-agents.md R1): the persona's `role`. */
  readonly prompt: string;
  /** Its recipe's full-text documents (R2): the persona's `guidance`. */
  readonly guidance: readonly GuidanceDocument[];
  readonly model: ModelClient;
  readonly post: (request: PostRequest) => Promise<ChannelMessage>;
  /** Opens a call from the delivery in hand (docs/plans/agent-calls.md R2); a refusal is data. */
  readonly consult: (request: ConsultRequest) => Promise<CallResult<ConsultResponse>>;
  /** Answers or passes the call question in hand (R5); call_closed is data, any other refusal throws. */
  readonly answerCall: (request: CallAnswerRequest) => Promise<CallResult<CallAnswerResponse, 'call_closed'>>;
  /** The agent's log (its stdout): `call.refused` and `call.answer_late` go here. */
  readonly log: AgentLog;
  /** An output with files from /channel (agent-files R12): posted, or refused `file_refused` with nothing posted. */
  readonly replyWithFiles: (request: {
    readonly conversation: string;
    readonly text: string;
    readonly files: readonly string[];
  }) => Promise<FilesReplyResult>;
  /** The other online agents on the channel right now, with what each does. */
  readonly roster: () => Promise<AgentInfo[]>;
  /**
   * Launches a recipe its grant names, for the delivery `delivery` it holds (docs/plans/patterns-phase-3.md R30): the
   * handle, or `{error}` for the model. Its decide() takes it as `launchAgent` when the turn offers launch_agent.
   */
  readonly launchAgent: (delivery: string, recipe: string) => Promise<LaunchResult>;
  /** Its recipe names `nestedCalls: true` (docs/plans/patterns-phase-3.md R33): its persona's call turns offer consult. */
  readonly nestedCalls: boolean;
  /** The tools its recipe selects, offered after the channel tools and run in decide()'s tool rounds. */
  readonly tools: AgentTools;
  /**
   * Registers work this delivery started that goes on after the handler
   * returns (the memory image's remember). On SIGTERM the agent waits for it,
   * within its drain bound, before it exits; a task that rejects is logged at
   * error as `agent.background_failed`, named by `name`.
   */
  readonly background: (name: string, task: Promise<unknown>) => void;
}

export type DeliveryHandler = (delivery: Delivery, context: AgentContext) => Promise<void>;

/** The agent's process as serveAgent needs it: where SIGTERM arrives, and how to exit. */
export interface AgentProcess {
  /** Calls `listener` on SIGTERM; returns the function that stops listening. */
  onTerminate(listener: () => void): () => void;
  exit(code: number): void;
}

/**
 * An agent's main runs its agent through this: a failure is reported, then the process exits 1 at once. Setting
 * only `process.exitCode` left a failed agent running — its channel stream and timers keep Node's loop alive — dead
 * but connected until the harness's delivery bound killed it (found by agent-persistence's agent suite,
 * 2026-09-29: 111 s after a turn failed `ToolCallInvalid`). Exiting at once lets the harness see the exit and end
 * the conversation with its reply now.
 */
export async function exitOnFailure(
  run: () => Promise<void>,
  process: AgentProcess,
  report: (error: unknown) => void,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    report(error);
    process.exit(1);
  }
}

/** The real process, for an agent's main. */
export function nodeAgentProcess(process: NodeJS.Process): AgentProcess {
  return {
    onTerminate(listener) {
      process.once('SIGTERM', listener);
      return () => process.off('SIGTERM', listener);
    },
    exit: (code) => process.exit(code),
  };
}

/** The tools an image implements: its manifest (image.json, staged beside its code) and one handler per declared tool. */
interface ImageTools {
  readonly manifest: ImageManifest;
  readonly handlers: Readonly<Record<string, ImageToolHandler>>;
}

/** /workspace is missing or not a writable directory: the agent cannot start (docs/plans/agent-tools.md R15). */
export class WorkspaceUnavailable extends Error {
  constructor(
    readonly dir: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`the workspace ${dir} ${detail}; every agent image creates it, owned by the user the agent runs as`, options);
    this.name = 'WorkspaceUnavailable';
  }
}

/** /channel is missing or not a writable directory: the agent cannot start (docs/plans/agent-files.md R10). */
export class ChannelSpaceUnavailable extends Error {
  constructor(
    readonly dir: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `the channel file space ${dir} ${detail}; the harness mounts it in every agent container, owned by the user the agent runs as`,
      options,
    );
    this.name = 'ChannelSpaceUnavailable';
  }
}

/** Checks the channel's file space is a directory the agent can write (R10), as requireWorkspace checks /workspace. */
async function requireChannelSpace(dir: string): Promise<void> {
  try {
    await requireWorkspace(dir);
  } catch (error) {
    if (error instanceof WorkspaceUnavailable)
      throw new ChannelSpaceUnavailable(
        dir,
        present(
          error.message.slice(`the workspace ${dir} `.length).split(';')[0],
          'the first semicolon-separated segment',
        ),
        { cause: error },
      );
    throw error;
  }
}

/** Checks the agent's workspace is a directory it can write. */
async function requireWorkspace(dir: string): Promise<void> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new WorkspaceUnavailable(dir, 'does not exist', { cause: error });
    throw error;
  }
  if (!isDirectory) throw new WorkspaceUnavailable(dir, 'is not a directory');
  try {
    await access(dir, constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EROFS') {
      throw new WorkspaceUnavailable(dir, 'is not writable', { cause: error });
    }
    throw error;
  }
}

/** Reads an image's manifest, staged at app/images/<name>/image.json beside its compiled code. */
export async function readImageManifest(file: URL): Promise<ImageManifest> {
  return parseImageManifest(JSON.parse(await readFile(file, 'utf8')), file.pathname);
}

export interface ServeAgentProps {
  readonly client: ModelClient &
    ChannelClient &
    BlackboardClient & { moduleCall(request: ModuleCallRequest, signal: AbortSignal): Promise<ToolOutcomeLike> };
  readonly telemetry: AgentTelemetry;
  /** The base name the agent joins the channel under. */
  readonly name: string;
  readonly handler: DeliveryHandler;
  readonly process: AgentProcess;
  /** Told the handle, for the agent's own log. Default: nothing. */
  readonly onJoined?: (session: { handle: string; channel: string }) => void;
  /** The tools the image implements (none: an empty manifest and no handlers). */
  readonly imageTools: ImageTools;
  /** The directory /workspace names: `/workspace` in a container (R9, R15). */
  readonly workspace: string;
  /** The directory /channel names, or null while no channel space is mounted (docs/plans/agent-files.md). */
  readonly channelSpace: string | null;
  /** Where tool failures, crashes and file writes are recorded: the agent's log (R4, R9). */
  readonly log: AgentLog;
  /** On SIGTERM, how long to wait for started work before exiting: AGENT_DRAIN_MS in an image. */
  readonly drainMs: number;
}

/** 128 + SIGTERM's number: how a process ended by SIGTERM exits. */
export const SIGTERM_EXIT_CODE = 143;

/** Work the agent has started and not finished, by name: the delivery in hand and its background tasks. */
class StartedWork {
  private readonly names = new Map<number, string>();
  private next = 0;
  private waiters: (() => void)[] = [];

  add(name: string, task: Promise<unknown>): void {
    const id = this.next++;
    this.names.set(id, name);
    const done = (): void => {
      this.names.delete(id);
      if (this.names.size === 0) for (const wake of this.waiters.splice(0)) wake();
    };
    // Only settling is observed here; the task's owner handles its outcome.
    task.then(done, done);
  }

  get unfinished(): string[] {
    return [...this.names.values()];
  }

  /** Resolves once nothing is unfinished, including work added while waiting. */
  idle(): Promise<void> {
    return this.names.size === 0 ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * The agent's main loop. Joins the channel as `name`, then handles deliveries
 * one at a time, each as a `delivery` span; after its handler returns, it
 * flushes the spans (bounded, never failing the turn) and acks it. A handler
 * that throws is not acked: its span ends `handler_failed`, the spans are
 * flushed, and the error ends the loop — the process exits non-zero, and the
 * harness takes the agent off the channel and reports why (PRINCIPLES §9 —
 * fail loudly, never limp on). Returns, after a last flush, when the harness
 * closes the stream.
 *
 * On SIGTERM (the harness stopping it) it starts no new delivery and waits,
 * up to `drainMs`, for the work already started — the delivery in hand, to
 * its ack, and every task registered with `context.background` — logging
 * `agent.draining` and then `agent.drained`; work still unfinished at the
 * bound is logged at error as `agent.drain_incomplete`, naming each piece
 * (PRINCIPLES §11: never dropped silently). Then it flushes and exits 143.
 */
export async function serveAgent(props: ServeAgentProps): Promise<void> {
  const { client, telemetry, handler, log } = props;
  const work = new StartedWork();
  let terminated: Promise<void> | undefined;
  const drainThenExit = async (): Promise<void> => {
    const started = work.unfinished;
    if (started.length > 0) {
      log.info('agent.draining', { work: started, drainMs: props.drainMs });
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, props.drainMs);
      });
      const outcome = await Promise.race([work.idle(), bound]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        const unfinished = work.unfinished;
        log.error('agent.drain_incomplete', {
          unfinished,
          drainMs: props.drainMs,
          error: new Error(`stopping with work unfinished after ${String(props.drainMs)} ms: ${unfinished.join(', ')}`),
        });
      } else {
        log.info('agent.drained', { work: started });
      }
    }
    await telemetry.flush();
    props.process.exit(SIGTERM_EXIT_CODE);
  };
  const stopListening = props.process.onTerminate(() => {
    terminated ??= drainThenExit();
  });
  try {
    // An agent that cannot run its tools never joins the channel (R1, R15): its workspace, then the channel's file
    // space (agent-files R10), each a directory it can write, before the channel stream opens.
    await requireWorkspace(props.workspace);
    if (props.channelSpace !== null) await requireChannelSpace(props.channelSpace);
    checkImageTools(props.imageTools.manifest, props.imageTools.handlers);
    const session = await client.open(props.name);
    const available = new Map<string, ToolImplementation>([
      ...fileTools({ workspace: props.workspace, channelSpace: props.channelSpace, handle: session.handle, log }),
      ...blackboardTools(client),
      ...props.imageTools.manifest.tools.map((declared): [string, ToolImplementation] => [
        declared.name,
        imageTool(declared, present(props.imageTools.handlers[declared.name], `handler for tool "${declared.name}"`)),
      ]),
      // Granted module tools (extension-modules R10): offered after the selected tools, in the recipe's order.
      ...moduleTools(session.modules, client),
    ]);
    // A selected channel tool is offered with the agent's own and posted by the turn, never run as a tool (agent-files R12).
    // A launch grant's tool comes after the selected and granted tools (patterns-phase-3 R29), run by decide(), not as a tool.
    const launch = session.launch;
    if (launch !== undefined && client.launchAgent === undefined)
      throw new Error('the welcome carries a launch grant, and this client cannot launch: a defect in the agent');
    const tools = new AgentTools({
      selected: [
        ...session.tools,
        ...session.modules.map((m) => m.name),
        ...(launch === undefined ? [] : [LAUNCH_AGENT]),
      ],
      available,
      channel: new Map([
        [REPLY_WITH_FILES, REPLY_WITH_FILES_TOOL],
        [ASK_USER, ASK_USER_TOOL],
        ...(launch === undefined ? [] : [[LAUNCH_AGENT, launchAgentTool(launch.recipes)] as const]),
      ]),
      log,
    });
    // A persisted agent's ack follows the background work its delivery started (agent-persistence R10).
    const persisted = session.persist !== undefined;
    let turnTasks: Promise<unknown>[] | undefined;
    // Announce ourselves: the harness counts an agent as online from this message.
    await client.post({ kind: 'status', text: ONLINE_STATUS });
    props.onJoined?.({ handle: session.handle, channel: session.channel });
    const context: AgentContext = {
      handle: session.handle,
      channel: session.channel,
      prompt: session.prompt,
      guidance: session.guidance,
      model: client,
      post: (request) => client.post(request),
      consult: (request) => client.consult(request),
      answerCall: (request) => client.answerCall(request),
      log,
      replyWithFiles: async (request) => {
        const result = await client.postFiles(request);
        if (result.ok) return { ok: true };
        // The model is told file_refused and nothing else; the file and the rule are in the daemon's log (R12).
        log.warn('files.reply_refused', { conversation: request.conversation, files: request.files.length });
        return { ok: false, reason: 'file_refused' };
      },
      roster: () => client.roster(),
      nestedCalls: session.nestedCalls === true,
      launchAgent: (delivery, recipe) => {
        if (client.launchAgent === undefined)
          throw new Error('launch_agent offered with no way to launch: a defect in the agent');
        return client.launchAgent({ delivery, recipe });
      },
      tools,
      background: (name, task) => {
        work.add(name, task);
        turnTasks?.push(task);
        task.catch((error: unknown) => {
          log.error('agent.background_failed', { task: name, error });
        });
      },
    };
    // A post the channel refused for the conversation's end or a waiting ask (R19, R24) ends the turn here, normally:
    // said once, and the delivery acked.
    const run = async (delivery: Delivery): Promise<void> => {
      try {
        await handler(delivery, context);
      } catch (error) {
        if (!(error instanceof PostRefused)) throw error;
        log.warn('post.refused', { conversation: delivery.message.conversation, reason: error.reason });
      }
    };
    const handle = async (delivery: Delivery): Promise<void> => {
      turnTasks = persisted ? [] : undefined;
      try {
        await telemetry.inDelivery(delivery, () => run(delivery));
        // Settled, whatever their outcome: a failed task is logged by background(), and the ack says the turn is over.
        if (turnTasks !== undefined) await Promise.allSettled(turnTasks);
      } catch (error) {
        await telemetry.flush();
        throw error;
      } finally {
        turnTasks = undefined;
      }
      await telemetry.flush();
      await client.ack(delivery.deliveryId);
    };
    for await (const delivery of session.deliveries) {
      // Stopping: a delivery not yet started is left unacked, for the harness to count as abandoned.
      if (terminated !== undefined) break;
      // Registered before the handler starts, so a SIGTERM at any point of the turn waits for it.
      let finished!: () => void;
      work.add(`delivery ${delivery.deliveryId}`, new Promise<void>((resolve) => (finished = resolve)));
      try {
        await handle(delivery);
      } finally {
        finished();
      }
    }
    if (terminated !== undefined) {
      await terminated;
      return;
    }
    await telemetry.flush();
  } finally {
    stopListening();
  }
}
