// The gateway's provider path (docs/plans/extension-modules.md R18b, R19): a recipe whose model is a ModelProvider's is
// served through the same `/agent/v1/model/chat` and `/embed` contract, by the provider's container, so the agent's code
// does not change. Never llama.cpp's means — no tool-call prefill, no `return_progress`, no prompt-store request — but
// the vendor's own: the request names `requireToolCall`, which the provider sends as its forced tool choice. It streams
// under model-streaming's bounds (55 s to the first chunk, 22 s between chunks) and events, and returns the vendor's
// usage with its end. A metered provider's call is reserved before it is sent and settled after (R18b).

import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ModelFailureReason,
  ToolCall,
} from '../../shared/protocol.js';
import type { ChatCompletion, ModelDelta } from '../model-gateway/index.js';
import type { Logger } from '../log.js';
import type { CallOutcome, ModuleHost } from './host.js';
import type { ProviderModelRef } from './launch.js';
import type { Meter, Reservation } from './meter.js';

export interface ProviderCallProps {
  readonly host: Pick<ModuleHost, 'provider'>;
  readonly meter: Pick<Meter, 'reserve' | 'settle'>;
  readonly logger: Logger;
  readonly ref: ProviderModelRef;
  readonly channel: string;
  readonly conversation: string;
  /** Aborted when the agent exited, or its request closed before the answer. */
  readonly abandon: AbortSignal;
  readonly now: () => number;
}

/** A provider's usage: the tokens the vendor reports (R19). */
interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function usageOf(outcome: CallOutcome): ProviderUsage | undefined {
  if (!outcome.ok) return undefined;
  const u = outcome.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  if (
    typeof u?.inputTokens !== 'number' ||
    typeof u.outputTokens !== 'number' ||
    u.inputTokens < 0 ||
    u.outputTokens < 0
  )
    return undefined;
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
}

/** The call's worst case in USD (R18b): its messages' and tools' UTF-8 bytes as input tokens, and maxTokens as output. */
export function providerReservation(
  ref: ProviderModelRef,
  request: { readonly messages: unknown; readonly tools?: unknown; readonly maxTokens: number },
): number {
  const bytes =
    Buffer.byteLength(JSON.stringify(request.messages), 'utf8') +
    (request.tools === undefined ? 0 : Buffer.byteLength(JSON.stringify(request.tools), 'utf8'));
  return (bytes * ref.model.prices.inputUsdPerMTok + request.maxTokens * ref.model.prices.outputUsdPerMTok) / 1_000_000;
}

async function reserve(
  props: ProviderCallProps,
  usd: number,
): Promise<
  | { readonly ok: true; readonly reservation: Reservation | undefined }
  | { readonly ok: false; readonly reason: ModelFailureReason; readonly detail: string }
> {
  if (props.ref.installed.manifest.cost.model !== 'metered') return { ok: true, reservation: undefined };
  const reserved = await props.meter.reserve(props.ref.module, props.conversation, usd);
  if (reserved.ok) return { ok: true, reservation: reserved.reservation };
  if (reserved.reason === 'budget_exceeded')
    return {
      ok: false,
      reason: 'budget_exceeded',
      detail: `the ${reserved.cap} cap of ${String(reserved.limit)} USD would be passed (${String(reserved.spent)} USD spent)`,
    };
  if (reserved.reason === 'budget_meter_unavailable')
    return { ok: false, reason: 'budget_meter_unavailable', detail: 'metering.json does not parse' };
  return { ok: false, reason: 'unavailable', detail: `module ${props.ref.module} is not enabled` };
}

/** Settles a reservation to the vendor's usage, or charges it in full — logged as a failure — when there is none (R18b). */
async function settle(
  props: ProviderCallProps,
  reservation: Reservation | undefined,
  outcome: CallOutcome,
): Promise<void> {
  if (reservation === undefined) return;
  const usage = usageOf(outcome);
  if (usage === undefined) {
    props.logger.error('module.failed', {
      module: props.ref.module,
      tool: 'chat',
      reason: outcome.ok ? 'no_usage' : outcome.reason,
      error: new Error('the call reported no usage: charged its whole reservation'),
    });
    await props.meter.settle(reservation, 'full');
    return;
  }
  const { prices } = props.ref.model;
  await props.meter.settle(
    reservation,
    (usage.inputTokens * prices.inputUsdPerMTok + usage.outputTokens * prices.outputUsdPerMTok) / 1_000_000,
  );
}

/** A delta from the provider, checked to be one of model-streaming's pieces; undefined when it is not. */
function asDelta(raw: unknown): ModelDelta | undefined {
  const d = raw as { part?: unknown; text?: unknown; index?: unknown; name?: unknown } | null;
  if (d === null || typeof d !== 'object' || typeof d.text !== 'string') return undefined;
  if (d.part === 'thinking' || d.part === 'text') return { part: d.part, text: d.text };
  if (d.part === 'tool_args' && typeof d.index === 'number' && typeof d.name === 'string')
    return { part: 'tool_args', index: d.index, name: d.name, text: d.text };
  return undefined;
}

/** A chat through a provider (R19): the gateway's ChatCompletion, its stats from the provider's chunks and usage. */
export async function providerChat(
  props: ProviderCallProps,
  request: ChatRequest,
  onDelta: (delta: ModelDelta) => void,
): Promise<ChatCompletion> {
  const started = props.now();
  let first: number | null = null;
  let chunks = 0;
  const reserved = await reserve(props, providerReservation(props.ref, request));
  const noStats = { ttfcMs: null, chunks: 0, promptTokens: null, completionTokens: null, cachedTokens: null };
  if (!reserved.ok)
    return { response: { ok: false, reason: reserved.reason, detail: reserved.detail }, stats: noStats };
  const outcome = await props.host.provider({
    module: props.ref.module,
    channel: props.channel,
    tool: 'chat',
    arguments: {
      model: props.ref.model.id,
      messages: request.messages,
      maxTokens: request.maxTokens,
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      ...(request.requireToolCall === undefined ? {} : { requireToolCall: request.requireToolCall }),
      settings: props.ref.settings,
    },
    onDelta: (raw) => {
      chunks += 1;
      first ??= props.now() - started;
      const delta = asDelta(raw);
      if (delta === undefined) {
        props.logger.error('module.failed', {
          module: props.ref.module,
          tool: 'chat',
          reason: 'bad_delta',
          error: new Error('the provider streamed a delta that is not thinking, text or tool_args'),
        });
        return;
      }
      onDelta(delta);
    },
    abandon: props.abandon,
  });
  await settle(props, reserved.reservation, outcome);
  const usage = usageOf(outcome);
  const stats = {
    ttfcMs: first,
    chunks,
    promptTokens: usage?.inputTokens ?? null,
    completionTokens: usage?.outputTokens ?? null,
    cachedTokens: null,
  };
  if (!outcome.ok)
    return { response: { ok: false, reason: outcome.reason as ModelFailureReason, detail: outcome.detail }, stats };
  const result = outcome.result as { text?: unknown; toolCalls?: unknown } | null;
  const calls = result?.toolCalls;
  if (
    result === null ||
    typeof result !== 'object' ||
    typeof result.text !== 'string' ||
    !Array.isArray(calls) ||
    !calls.every(isToolCall)
  ) {
    return {
      response: { ok: false, reason: 'bad_response', detail: 'the provider answered with no {text, toolCalls}' },
      stats,
    };
  }
  const response: ChatResponse = { ok: true, text: result.text, toolCalls: calls as ToolCall[] };
  if (request.requireToolCall === true && response.toolCalls.length === 0)
    return {
      response: {
        ok: false,
        reason: 'truncated',
        detail: 'a tool call was required and the provider answered with none',
      },
      stats,
    };
  return { response, stats };
}

function isToolCall(c: unknown): boolean {
  const call = c as { id?: unknown; name?: unknown; arguments?: unknown } | null;
  return (
    call !== null &&
    typeof call === 'object' &&
    typeof call.id === 'string' &&
    typeof call.name === 'string' &&
    typeof call.arguments === 'object' &&
    call.arguments !== null &&
    !Array.isArray(call.arguments)
  );
}

/** An embedding call through a provider (R19). */
export async function providerEmbed(props: ProviderCallProps, request: EmbedRequest): Promise<EmbedResponse> {
  const reserved = await reserve(props, providerReservation(props.ref, { messages: request.texts, maxTokens: 0 }));
  if (!reserved.ok) return { ok: false, reason: reserved.reason, detail: reserved.detail };
  const outcome = await props.host.provider({
    module: props.ref.module,
    channel: props.channel,
    tool: 'embed',
    arguments: { model: props.ref.model.id, texts: request.texts, purpose: request.purpose },
    onDelta: () => undefined,
    abandon: props.abandon,
  });
  await settle(props, reserved.reservation, outcome);
  if (!outcome.ok) return { ok: false, reason: outcome.reason as ModelFailureReason, detail: outcome.detail };
  const vectors = (outcome.result as { vectors?: unknown } | null)?.vectors;
  const dimensions = props.ref.model.dimensions;
  if (
    !Array.isArray(vectors) ||
    vectors.length !== request.texts.length ||
    !vectors.every((v) => Array.isArray(v) && v.length === dimensions && v.every((x) => typeof x === 'number'))
  ) {
    return {
      ok: false,
      reason: 'bad_response',
      detail: `the provider answered with no ${String(request.texts.length)} vectors of ${String(dimensions)} numbers`,
    };
  }
  return { ok: true, vectors: vectors as number[][] };
}
