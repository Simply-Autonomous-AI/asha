// The harness side of an agent's model call: one OpenAI-compatible chat
// completion against the model server, streamed (docs/plans/model-streaming.md).
// Expected failures — a bound passed, a refused connection, a non-2xx answer, a
// stream short of complete, a required tool call cut off by the token limit —
// come back as data (PRINCIPLES §11).

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ModelFailureReason,
  ToolCall,
} from '../../shared/protocol.js';
import type { ReadableStream } from 'node:stream/web';

import { withTimeout } from '../../shared/abort.js';
import { present } from '../../shared/assert-present.js';
import type { EmbeddingModelEntry } from '../definitions/index.js';
import type { ModelEndpoint } from '../model-server/index.js';

/**
 * The bounds of a streamed chat call, by inactivity, never by wall clock (model-streaming R2): the first chunk — a
 * `prompt_progress` chunk counts — must come within the queue bound of sending the request (the call waiting for a
 * slot and its prompt), and every later chunk within the idle bound of the one before. R2's rule, over every
 * recorded measurement (docs/plans/model-streaming.md, amendment 8): twice the largest value of its kind, rounded up
 * to a whole second. The idle bound's largest gap is the plan reviewer's capture 5 (11 s, other servers sharing the
 * GPU; stated in the plan, no committed record, kept because it only widens the bound); A9's two runs saw 5,531 and
 * 5,411 ms (evals/probes/model-streaming-2026-09-29/measure.json). The queue
 * bound's largest first chunk is A9's 32,670 ms (eleven calls on four slots), so the rule gives 66,000 ms, capped at
 * AGENT_CHAT_TIMEOUT_MS less 5,000 ms: for an agent's call the daemon's bound then fires before the SDK's and names
 * the cause. (A caller with no SDK bound — the routing eval — sends one call at a time, and never queues.)
 */
export const CHAT_QUEUE_BOUND_MS = 55_000;
export const CHAT_IDLE_BOUND_MS = 22_000;

/** One piece of model output, as it is parsed from the stream: thinking, reply text, or a tool call's arguments. */
export type ModelDelta =
  | { readonly part: 'thinking' | 'text'; readonly text: string }
  | { readonly part: 'tool_args'; readonly index: number; readonly name: string; readonly text: string };

export interface ChatCompletionProps {
  readonly fetch: typeof fetch;
  readonly endpoint: ModelEndpoint;
  /** The catalogue entry's sampling parameters, with the recipe's over them. */
  readonly chatDefaults: Readonly<Record<string, unknown>>;
  /**
   * What the model's chat template opens a tool call with (the catalogue's `toolCallStart`).
   * When the request requires a tool call, the assistant turn is sent already opened with it,
   * so the model's turn is a tool call from its first token: llama.cpp's `tool_choice: required`
   * alone no longer ensures that (see docs/architecture/models.md). It is not sent when the chat
   * settings turn thinking on, since with it the model does not think (model-streaming R9).
   */
  readonly toolCallStart: string;
  readonly request: ChatRequest;
  /**
   * Aborted when the agent that made the call has exited: nobody will read the answer, so the call
   * ends at once as `unavailable` with an `abandoned:` detail. Absent — the routing eval, the probes —
   * the call is never abandoned.
   */
  readonly abandon?: AbortSignal;
  /**
   * Aborted when the agent's own request closes before the answer (its bound passed): the model server's
   * request is aborted, freeing its slot, and the call ends `timeout` (R2). Absent: nobody hangs up.
   */
  readonly requestClosed?: AbortSignal;
  /** Receives each piece of output as it is parsed (R1, R4). Absent: nothing is sent, and the result is the same. */
  readonly onDelta?: (delta: ModelDelta) => void;
  /**
   * How long the call had already waited, before this request, for its model's server to start
   * (docs/plans/idle-shutdown.md R2): the queue bound counts from the call's start, so that for an agent's call the
   * daemon's bound still fires before the SDK's and names the cause. Default 0.
   */
  readonly waitedMs?: number;
}

/**
 * The response body, or the failure reading it: the model server can cut the
 * connection mid-body, or the call's bound can pass while it is read. Both are
 * expected external failures, so data, never a throw (PRINCIPLES §11).
 */
async function bodyText(
  response: Response,
  timeoutMs: number,
  abandon: AbortSignal | undefined,
): Promise<string | { readonly ok: false; readonly reason: 'timeout' | 'unavailable'; readonly detail: string }> {
  try {
    return await response.text();
  } catch (error) {
    if (abandon?.aborted === true) return { ok: false, reason: 'unavailable', detail: ABANDONED };
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'unavailable',
      detail: timedOut
        ? `no complete response within ${String(timeoutMs)} ms`
        : `the response body was cut off: ${(error as Error).message}`,
    };
  }
}

/** The detail of a call ended because its agent exited. */
export const ABANDONED = 'abandoned: the calling agent exited';

/** The detail of a call ended because the agent's own request closed first (R2). */
export const REQUEST_CLOSED = "the agent's request closed before the answer";

/** An embedding call's wall-clock bound, and its abandonment when given. */
function callSignal(timeoutMs: number, abandon: AbortSignal | undefined): AbortSignal {
  return withTimeout(timeoutMs, ...(abandon === undefined ? [] : [abandon]));
}

/**
 * What the daemon records of one streamed call (model-streaming R8): the time from sending the request to the
 * first chunk of output (progress chunks excluded), the JSON chunks received (progress and usage chunks included,
 * `[DONE]` not), and the usage chunk's counts — prompt tokens, generated tokens, and how many prompt tokens the
 * server's prompt cache supplied (prompt-prefix R10). Null where the stream did not get that far.
 */
export interface ChatStats {
  readonly ttfcMs: number | null;
  readonly chunks: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly cachedTokens: number | null;
}

/**
 * A chat call as the daemon sees it: the `ChatResponse` the agent receives, unchanged, and the call's statistics.
 * The statistics stay in the daemon: no agent needs them, and `ChatResponse` is a published type.
 */
export interface ChatCompletion {
  readonly response: ChatResponse;
  readonly stats: ChatStats;
}

interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
}

/** usageOf's own result, kept to one return shape (sonarjs/function-return-type); unwrapped to Usage | string below. */
type UsageOutcome = { readonly ok: true; readonly value: Usage } | { readonly ok: false; readonly error: string };

function usageOutcome(chunk: object): UsageOutcome {
  const usage = (
    chunk as {
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
      };
    }
  ).usage;
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  if (!count(promptTokens))
    return {
      ok: false,
      error: `usage.prompt_tokens is not a non-negative integer: ${JSON.stringify(promptTokens ?? null)}`,
    };
  if (!count(completionTokens))
    return {
      ok: false,
      error: `usage.completion_tokens is not a non-negative integer: ${JSON.stringify(completionTokens ?? null)}`,
    };
  if (!count(cachedTokens))
    return {
      ok: false,
      error: `usage.prompt_tokens_details.cached_tokens is not a non-negative integer: ${JSON.stringify(cachedTokens ?? null)}`,
    };
  return { ok: true, value: { promptTokens, completionTokens, cachedTokens } };
}

/**
 * The token counts of a usage chunk, or the problem naming the field that is missing or not a non-negative
 * integer. A complete stream's usage chunk holds all three (R2b, amended 2026-09-29).
 */
function usageOf(chunk: object): Usage | string {
  const outcome = usageOutcome(chunk);
  return outcome.ok ? outcome.value : outcome.error;
}

/** Whether the merged chat settings turn the model's thinking on: exactly `chat_template_kwargs.enable_thinking: true` (R9). */
function thinkingOn(chatDefaults: Readonly<Record<string, unknown>>): boolean {
  const kwargs = chatDefaults['chat_template_kwargs'];
  return (
    typeof kwargs === 'object' && kwargs !== null && (kwargs as { enable_thinking?: unknown }).enable_thinking === true
  );
}

/** A stream the gateway cannot use: thrown while reading it, caught once in chatCompletion, returned as data. */
class StreamUnusable extends Error {
  constructor(
    readonly reason: 'bad_response' | 'upstream_error',
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'StreamUnusable';
  }
}

/** The `onDelta` sink threw: a harness defect, re-thrown from chatCompletion with the sink's error as its cause. */
export class DeltaSinkFailed extends Error {
  constructor(cause: unknown) {
    super(`publishing a model delta failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'DeltaSinkFailed';
  }
}

/** A tool call as its fragments arrive. */
interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Reads llama-server's stream (R1, R2b): `data: <json>` lines, each chunk a progress chunk (`prompt_progress`), an
 * output chunk (`choices[0].delta`: `reasoning_content`, `content`, `tool_calls` fragments), the one chunk with a
 * `finish_reason`, or the usage chunk (`choices: []`); then `data: [DONE]`. Anything out of that order, a line that
 * is not SSE data or not JSON, or a chunk reporting an error throws StreamUnusable.
 */
class StreamReader {
  reasoning = '';
  content = '';
  readonly calls: PartialCall[] = [];
  finishReason: string | null = null;
  usage: Usage | null = null;
  done = false;
  chunks = 0;
  ttfcMs: number | null = null;
  /** The part of the last output: whether a cut came while thinking. */
  lastPart: ModelDelta['part'] | null = null;
  private buffered = '';
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly started: number,
    private readonly onDelta: ((delta: ModelDelta) => void) | undefined,
    /** Called on every `data:` line: the activity the queue and idle bounds measure (R2). A comment is not a chunk. */
    private readonly onChunk: () => void,
  ) {}

  push(bytes: Uint8Array): void {
    this.buffered += this.decoder.decode(bytes, { stream: true });
    let newline = this.buffered.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      this.line(line.replace(/\r$/, ''));
      newline = this.buffered.indexOf('\n');
    }
  }

  /** The end of the body: a last line without a newline is still a line. */
  end(): void {
    this.buffered += this.decoder.decode();
    const last = this.buffered;
    this.buffered = '';
    if (last !== '') this.line(last.replace(/\r$/, ''));
  }

  private line(line: string): void {
    // A comment (llama-server's `--sse-ping-interval` ping is `:`) is neither a chunk nor activity: it must not keep
    // a stalled call alive past its bounds.
    if (line === '' || line.startsWith(':')) return;
    if (!line.startsWith('data: '))
      throw new StreamUnusable('bad_response', `not an SSE data line: ${line.slice(0, 200)}`);
    this.onChunk();
    if (this.done) throw new StreamUnusable('bad_response', 'data after data: [DONE]');
    const data = line.slice('data: '.length);
    if (data === '[DONE]') {
      this.done = true;
      return;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new StreamUnusable('bad_response', `not JSON: ${data.slice(0, 200)}`);
    }
    if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) {
      throw new StreamUnusable('bad_response', `a chunk that is not an object: ${data.slice(0, 200)}`);
    }
    this.chunk(chunk);
  }

  private chunk(chunk: object): void {
    if ('error' in chunk)
      throw new StreamUnusable(
        'upstream_error',
        `the stream reported an error: ${JSON.stringify(chunk).slice(0, 500)}`,
      );
    this.chunks += 1;
    if ('prompt_progress' in chunk) return;
    const choices = (chunk as { choices?: unknown }).choices;
    if (!Array.isArray(choices))
      throw new StreamUnusable(
        'bad_response',
        `a chunk without a choices array: ${JSON.stringify(chunk).slice(0, 200)}`,
      );
    if (choices.length === 0) {
      this.usageChunk(chunk);
      return;
    }
    if (this.finishReason !== null)
      throw new StreamUnusable(
        'bad_response',
        `a chunk after the one with finish_reason: ${JSON.stringify(chunk).slice(0, 200)}`,
      );
    const choice = choices[0] as {
      delta?: { reasoning_content?: unknown; content?: unknown; tool_calls?: unknown };
      finish_reason?: unknown;
    } | null;
    const delta = choice?.delta ?? {};
    if (typeof delta.reasoning_content === 'string') this.output({ part: 'thinking', text: delta.reasoning_content });
    if (typeof delta.content === 'string') this.output({ part: 'text', text: delta.content });
    if (delta.tool_calls != null) this.applyToolCalls(delta.tool_calls);
    this.applyFinishReason(choice?.finish_reason);
  }

  /** The usage chunk (`choices: []`), its own validation pulled out of chunk() to keep that method's complexity down. */
  private usageChunk(chunk: object): void {
    if (this.finishReason === null)
      throw new StreamUnusable('bad_response', 'a usage chunk before the chunk with finish_reason');
    if (this.usage !== null) throw new StreamUnusable('bad_response', 'a second usage chunk');
    const usage = usageOf(chunk);
    if (typeof usage === 'string') throw new StreamUnusable('bad_response', usage);
    this.usage = usage;
  }

  /** A chunk's tool_calls fragments, pulled out of chunk() to keep that method's complexity down. */
  private applyToolCalls(toolCalls: unknown): void {
    if (!Array.isArray(toolCalls))
      throw new StreamUnusable(
        'bad_response',
        `tool_calls is not an array: ${JSON.stringify(toolCalls).slice(0, 200)}`,
      );
    for (const fragment of toolCalls) this.toolFragment(fragment);
  }

  /** The chunk's finish_reason, when given; pulled out of chunk() to keep that method's complexity down. */
  private applyFinishReason(finish: unknown): void {
    if (finish == null) return;
    if (typeof finish !== 'string')
      throw new StreamUnusable('bad_response', `finish_reason is not a string: ${JSON.stringify(finish)}`);
    this.finishReason = finish;
  }

  private toolFragment(raw: unknown): void {
    const fragment = raw as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    } | null;
    const index = fragment?.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new StreamUnusable(
        'bad_response',
        `a tool-call fragment without an index: ${JSON.stringify(raw).slice(0, 200)}`,
      );
    }
    let call = this.calls[index];
    if (call === undefined) {
      call = { id: '', name: '', arguments: '' };
      this.calls[index] = call;
    }
    if (typeof fragment?.id === 'string' && call.id === '') call.id = fragment.id;
    if (typeof fragment?.function?.name === 'string' && fragment.function.name !== '')
      call.name = fragment.function.name;
    const args = fragment?.function?.arguments;
    if (typeof args === 'string') {
      if (call.name === '')
        throw new StreamUnusable('bad_response', `tool call ${String(index)} streamed arguments before its name`);
      this.output({ part: 'tool_args', index, name: call.name, text: args });
    }
  }

  private output(delta: ModelDelta): void {
    if (delta.part === 'tool_args')
      present(this.calls[delta.index], `this.calls[${String(delta.index)}]`).arguments += delta.text;
    else if (delta.part === 'thinking') this.reasoning += delta.text;
    else this.content += delta.text;
    if (delta.text === '') return;
    this.ttfcMs ??= Date.now() - this.started;
    this.lastPart = delta.part;
    try {
      this.onDelta?.(delta);
    } catch (error) {
      // The sink is the daemon's own (publishing to the streams): its throw is a harness defect, never the model
      // server's failure, so it is not turned into a model failure (PRINCIPLES §11).
      throw new DeltaSinkFailed(error);
    }
  }

  /**
   * The stream's calls, in index order, in the non-streamed shape, or the problem when their indexes leave a gap.
   * `flatMap` never calls back for a hole of a sparse array, so `presentIndexes` already holds only the indexes an
   * entry actually exists at — never `undefined` itself, since toolFragment only ever stores a real PartialCall.
   */
  private toolCallsOutcome():
    { readonly ok: true; readonly value: unknown[] } | { readonly ok: false; readonly error: string } {
    const presentIndexes = this.calls.flatMap((_, i) => [i]);
    if (presentIndexes.length !== this.calls.length)
      return {
        ok: false,
        error: `the stream has tool calls at indexes ${presentIndexes.join(', ')}, not 0 to ${String(this.calls.length - 1)}`,
      };
    return {
      ok: true,
      value: this.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }

  /** toolCallsOutcome(), unwrapped to one return shape (sonarjs/function-return-type) at this public boundary. */
  toolCalls(): unknown[] | string {
    const outcome = this.toolCallsOutcome();
    return outcome.ok ? outcome.value : outcome.error;
  }

  stats(): ChatStats {
    return {
      ttfcMs: this.ttfcMs,
      chunks: this.chunks,
      promptTokens: this.usage?.promptTokens ?? null,
      completionTokens: this.usage?.completionTokens ?? null,
      cachedTokens: this.usage?.cachedTokens ?? null,
    };
  }
}

/** The detail of a call whose queue bound passed, `waitedMs` of it spent waiting for its model's server to start. */
function queueBoundPassed(waitedMs: number): string {
  return waitedMs === 0
    ? `no chunk within the queue bound of ${String(CHAT_QUEUE_BOUND_MS)} ms after the request was sent`
    : `no chunk within the queue bound of ${String(CHAT_QUEUE_BOUND_MS)} ms after the call began, ${String(waitedMs)} ms of it waiting for its model's server to start`;
}

/**
 * Why the request or its body failed, in order: the agent gone, its request closed, a bound passed, the connection.
 * Pulled out of chatCompletion as its own function (not a closure defined inside it) so its four sequential checks
 * are counted toward this function's own cognitive-complexity budget, not chatCompletion's (sonarjs/cognitive-complexity).
 */
function interruptedReason(
  props: Pick<ChatCompletionProps, 'abandon' | 'requestClosed' | 'waitedMs'>,
  passed: 'queue' | 'idle' | undefined,
  error: unknown,
  midBody: boolean,
): { readonly reason: ModelFailureReason; readonly detail: string } {
  if (props.abandon?.aborted === true) return { reason: 'unavailable', detail: ABANDONED };
  if (props.requestClosed?.aborted === true) return { reason: 'timeout', detail: REQUEST_CLOSED };
  if (passed === 'queue') return { reason: 'timeout', detail: queueBoundPassed(props.waitedMs ?? 0) };
  if (passed === 'idle')
    return {
      reason: 'timeout',
      detail: `no chunk within the idle bound of ${String(CHAT_IDLE_BOUND_MS)} ms after the previous chunk`,
    };
  const message = error instanceof Error ? error.message : String(error);
  return { reason: 'unavailable', detail: midBody ? `the response body was cut off: ${message}` : message };
}

/**
 * chatCompletion's read of the response body, pulled out as its own function to keep that function's cognitive
 * complexity down: a success body is parsed by `reader`, as it streams (R1); an error body (`!response.ok`) is only
 * read for its activity — each chunk re-arms the idle bound through `rearmIdle` — and collected into `errorBody`
 * for its caller to report. `response.body` is non-null, checked by the caller just before this is called.
 */
async function readChatBody(
  response: Response,
  reader: StreamReader,
  errorBody: Uint8Array[],
  rearmIdle: () => void,
): Promise<void> {
  for await (const bytes of response.body as ReadableStream<Uint8Array>) {
    if (response.ok) reader.push(bytes);
    else {
      // An error body is no stream: each read of it is its activity.
      rearmIdle();
      errorBody.push(bytes);
    }
  }
  if (response.ok) reader.end();
}

/**
 * chatCompletion's dispatch of a readChatBody failure, pulled out to keep that function's complexity down: a
 * StreamUnusable is the model failure it names; a DeltaSinkFailed is the harness's own defect, rethrown
 * (PRINCIPLES §11), never turned into a model failure; anything else is undefined, for the caller to treat as
 * `interrupted` the way every other read failure is.
 */
function bodyReadFailed(
  error: unknown,
  failed: (reason: ModelFailureReason, detail: string) => ChatCompletion,
): ChatCompletion | undefined {
  if (error instanceof StreamUnusable) return failed(error.reason, error.detail);
  if (error instanceof DeltaSinkFailed) throw error;
  return undefined;
}

export async function chatCompletion(props: ChatCompletionProps): Promise<ChatCompletion> {
  const thinking = thinkingOn(props.chatDefaults);
  const prefill = props.request.requireToolCall === true && !thinking;
  const body = {
    ...props.chatDefaults,
    model: props.endpoint.model,
    messages: [
      ...props.request.messages.map(toOpenAi),
      ...(prefill ? [{ role: 'assistant', content: props.toolCallStart }] : []),
    ],
    max_tokens: props.request.maxTokens,
    ...(props.request.tools === undefined ? {} : { tools: props.request.tools }),
    ...(props.request.requireToolCall === true ? { tool_choice: 'required' } : {}),
    stream: true,
    stream_options: { include_usage: true },
    return_progress: true,
  };
  const started = Date.now();
  // Ends the model server's request: when a bound passes, and — in the finally — whenever the call ends.
  const ended = new AbortController();
  let passed: 'queue' | 'idle' | undefined;
  const arm = (which: 'queue' | 'idle'): NodeJS.Timeout =>
    setTimeout(
      () => {
        passed = which;
        ended.abort(new Error(`the ${which} bound passed`));
      },
      // The queue bound counts from the call's start: what it waited for its model's server comes off it (idle-shutdown R2).
      which === 'queue' ? Math.max(0, CHAT_QUEUE_BOUND_MS - (props.waitedMs ?? 0)) : CHAT_IDLE_BOUND_MS,
    );
  let timer = arm('queue');
  const signal = AbortSignal.any([
    ended.signal,
    ...(props.abandon === undefined ? [] : [props.abandon]),
    ...(props.requestClosed === undefined ? [] : [props.requestClosed]),
  ]);
  // Each chunk must come within the idle bound of the last: armed at the first, re-armed at every one.
  const reader = new StreamReader(started, props.onDelta, () => {
    clearTimeout(timer);
    timer = arm('idle');
  });
  const result = (response: ChatResponse): ChatCompletion => ({ response, stats: reader.stats() });
  const failed = (reason: ModelFailureReason, detail: string): ChatCompletion => result({ ok: false, reason, detail });
  const interrupted = (error: unknown, midBody: boolean): ChatCompletion => {
    const { reason, detail } = interruptedReason(props, passed, error, midBody);
    return failed(reason, detail);
  };
  try {
    let response: Response;
    try {
      response = await props.fetch(`${props.endpoint.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${props.endpoint.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return interrupted(error, false);
    }
    if (response.body === null)
      return failed(response.ok ? 'bad_response' : 'upstream_error', `HTTP ${String(response.status)} with no body`);
    const errorBody: Uint8Array[] = [];
    try {
      await readChatBody(response, reader, errorBody, () => {
        clearTimeout(timer);
        timer = arm('idle');
      });
    } catch (error) {
      return bodyReadFailed(error, failed) ?? interrupted(error, true);
    }
    if (!response.ok)
      return failed(
        'upstream_error',
        `HTTP ${String(response.status)}: ${Buffer.concat(errorBody).toString('utf8').slice(0, 500)}`,
      );
    return result(assemble(props.request, thinking, reader));
  } finally {
    clearTimeout(timer);
    // Whatever ended the call, the model server's request ends with it, freeing its slot (R2).
    ended.abort(new Error('the call ended'));
  }
}

/**
 * The bound of each prompt-store request: the queue bound, since the completion can wait for a slot behind the calls
 * already queued.
 */
const PROMPT_STORE_BOUND_MS = CHAT_QUEUE_BOUND_MS;

/** The text the prompt-store request is made of, tokenized with no special tokens: one token, one token out. */
export const PROMPT_STORE_TEXT = '.';

/** The detail of a prompt-store request ended because the daemon began to stop. */
export const STORE_ABANDONED = 'abandoned: the daemon is stopping';

export type PromptStoreResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'timeout' | 'unavailable' | 'upstream_error' | 'bad_response';
      readonly detail: string;
    };

export interface StoreIdlePromptsProps {
  readonly fetch: typeof fetch;
  readonly endpoint: ModelEndpoint;
  /** Aborted when the daemon begins to stop: the request ends at once, `unavailable` with STORE_ABANDONED. */
  readonly abandon: AbortSignal;
}

/**
 * Puts the prompts of a chat model server's idle slots into its host prompt store (`--cache-ram`), so that the next
 * request to land on an empty slot restores the shared prefix from there instead of computing it again (debt D44,
 * docs/plans/prompt-prefix.md, amendment 2). llama.cpp 0.5.0 saves idle slots to the store only when a task starts
 * (`--cache-idle-slots`), and a request goes to the idle slot whose prompt shares the longest prefix with it (above
 * 10 % of the request), else the least recently used: with one prompt prefix per recipe, one agent after another all
 * take the same slot, which is never idle when a task starts, so the store stays empty. The first time two of them
 * call at once, the second lands on an empty slot and computes the whole prompt (about 1,900 tokens, 4.6 s on this
 * Mac), and the first waits in the same batch.
 *
 * This starts a task that shares no first token with any chat prompt: `/tokenize` gives the tokens of
 * PROMPT_STORE_TEXT without special tokens, and `/completion` gets them as a token array, to which llama.cpp adds no
 * BOS. A text prompt would begin with BOS on a model that adds one (Ministral 3), share it with the warm slot's
 * prompt — half of a two-token prompt, over the 10 % — and take that slot. Sharing nothing, the task goes to the
 * least recently used slot, an empty one while there is one, and the warm slot, idle, is saved. The answer says the
 * task ran, not what was saved. Expected failures come back as data (PRINCIPLES §11).
 */
export async function storeIdlePrompts(props: StoreIdlePromptsProps): Promise<PromptStoreResult> {
  const post = async (
    path: string,
    body: unknown,
  ): Promise<{ readonly ok: true; readonly text: string } | Extract<PromptStoreResult, { ok: false }>> => {
    let response: Response;
    const signal = withTimeout(PROMPT_STORE_BOUND_MS, props.abandon);
    try {
      response = await props.fetch(`${props.endpoint.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${props.endpoint.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (props.abandon.aborted) return { ok: false, reason: 'unavailable', detail: STORE_ABANDONED };
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      return {
        ok: false,
        reason: timedOut ? 'timeout' : 'unavailable',
        detail: timedOut
          ? `${path}: no response within ${String(PROMPT_STORE_BOUND_MS)} ms`
          : `${path}: ${(error as Error).message}`,
      };
    }
    const text = await bodyText(response, PROMPT_STORE_BOUND_MS, props.abandon);
    if (typeof text !== 'string')
      return props.abandon.aborted
        ? { ok: false, reason: 'unavailable', detail: STORE_ABANDONED }
        : { ...text, detail: `${path}: ${text.detail}` };
    if (!response.ok)
      return {
        ok: false,
        reason: 'upstream_error',
        detail: `${path}: HTTP ${String(response.status)}: ${text.slice(0, 500)}`,
      };
    return { ok: true, text };
  };
  const tokenized = await post('/tokenize', { content: PROMPT_STORE_TEXT });
  if (!tokenized.ok) return tokenized;
  let tokens: unknown;
  try {
    tokens = (JSON.parse(tokenized.text) as { tokens?: unknown }).tokens;
  } catch {
    return { ok: false, reason: 'bad_response', detail: `/tokenize: not JSON: ${tokenized.text.slice(0, 200)}` };
  }
  if (
    !Array.isArray(tokens) ||
    tokens.length === 0 ||
    !tokens.every((t) => Number.isInteger(t) && (t as number) >= 0)
  ) {
    return {
      ok: false,
      reason: 'bad_response',
      detail: `/tokenize: tokens is not a non-empty list of token ids: ${tokenized.text.slice(0, 200)}`,
    };
  }
  const completed = await post('/completion', { prompt: tokens, n_predict: 1 });
  return completed.ok ? { ok: true } : completed;
}

/** The ChatResponse of a complete stream, judged as the non-streamed answer to the same request is (R1, R2b). */
function assemble(request: ChatRequest, thinking: boolean, reader: StreamReader): ChatResponse {
  if (!reader.done) return { ok: false, reason: 'bad_response', detail: 'the stream ended before data: [DONE]' };
  if (reader.finishReason === null)
    return { ok: false, reason: 'bad_response', detail: 'the stream has no chunk with a finish_reason' };
  if (reader.usage === null) return { ok: false, reason: 'bad_response', detail: 'the stream has no usage chunk' };
  const raw = reader.toolCalls();
  if (typeof raw === 'string') return { ok: false, reason: 'bad_response', detail: raw };
  const toolCalls = parseToolCalls(raw);
  // A required call cut off by the token limit is not the model choosing text over a call, nor a malformed
  // call: say which it was. With the prefill the model is inside the call from its first token, so the cut
  // usually leaves partial arguments ("{\"text\":"), which parseToolCalls rejects. Without it — thinking on — the
  // whole budget can go to thinking (capture 2), and the detail says so (R9).
  if (
    request.requireToolCall === true &&
    reader.finishReason === 'length' &&
    (typeof toolCalls === 'string' || toolCalls.length === 0)
  ) {
    const limit = `the output reached the token limit (max_tokens ${String(request.maxTokens)})`;
    if (thinking && reader.lastPart === 'thinking')
      return {
        ok: false,
        reason: 'truncated',
        detail: `${limit} while thinking, before any tool call: ${reader.reasoning.slice(-200)}`,
      };
    const written = typeof toolCalls === 'string' ? toolCalls : reader.content;
    return { ok: false, reason: 'truncated', detail: `${limit} before a complete tool call: ${written.slice(0, 200)}` };
  }
  if (typeof toolCalls === 'string') return { ok: false, reason: 'bad_response', detail: toolCalls };
  return { ok: true, text: reader.content, toolCalls };
}

/** A chat turn in the OpenAI wire shape llama-server speaks. */
function toOpenAi(message: ChatMessage): unknown {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls === undefined || message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

/** parseToolCalls's own result, kept to one return shape (sonarjs/function-return-type); unwrapped below. */
type ToolCallsParseOutcome =
  { readonly ok: true; readonly value: ToolCall[] } | { readonly ok: false; readonly error: string };

function parseToolCallsOutcome(raw: unknown): ToolCallsParseOutcome {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw))
    return { ok: false, error: `tool_calls is not an array: ${JSON.stringify(raw).slice(0, 200)}` };
  const calls: ToolCall[] = [];
  for (const call of raw) {
    const fn = (call as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
    const rawId = (call as { id?: unknown } | null)?.id;
    if (typeof fn?.name !== 'string' || typeof fn.arguments !== 'string') {
      return {
        ok: false,
        error: `tool call without a name and arguments string: ${JSON.stringify(call).slice(0, 200)}`,
      };
    }
    let args: unknown;
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      return {
        ok: false,
        error: `tool call ${fn.name} has arguments that are not JSON: ${fn.arguments.slice(0, 200)}`,
      };
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return {
        ok: false,
        error: `tool call ${fn.name} has arguments that are not an object: ${fn.arguments.slice(0, 200)}`,
      };
    }
    // A tool result answers its call by id, so a call without one cannot be answered.
    if (typeof rawId !== 'string' || rawId === '') return { ok: false, error: `tool call ${fn.name} has no id` };
    calls.push({ id: rawId, name: fn.name, arguments: args as Record<string, unknown> });
  }
  return { ok: true, value: calls };
}

/** The model's tool calls, arguments parsed; a description of the problem when they are malformed. */
function parseToolCalls(raw: unknown): ToolCall[] | string {
  const outcome = parseToolCallsOutcome(raw);
  return outcome.ok ? outcome.value : outcome.error;
}

export interface EmbeddingsProps {
  readonly fetch: typeof fetch;
  readonly endpoint: ModelEndpoint;
  /** The embedding model's catalogue entry: its query template and vector size. */
  readonly entry: EmbeddingModelEntry;
  readonly request: EmbedRequest;
  readonly timeoutMs: number;
  /** As ChatCompletionProps.abandon. */
  readonly abandon?: AbortSignal;
}

/**
 * The harness side of an agent's embedding call: llama-server's
 * OpenAI-compatible `/v1/embeddings`. A query is written with the model's
 * query template; documents are sent as they are. Expected failures come back
 * as data, like chat; a vector of the wrong size is a bad response.
 */
/**
 * embeddings's own per-item validation of the response's `data`, pulled out of embeddings to keep that function's
 * cognitive complexity down: each item's embedding is checked and placed at the server's own index (R1's "order by
 * it, not by position").
 */
function parseEmbeddingVectors(
  data: readonly unknown[],
  inputLength: number,
  dimensions: number,
): { readonly ok: true; readonly vectors: number[][] } | { readonly ok: false; readonly detail: string } {
  const vectors: number[][] = [];
  for (const [i, item] of data.entries()) {
    const { embedding, index } = (item ?? {}) as { embedding?: unknown; index?: unknown };
    if (!Array.isArray(embedding) || !embedding.every((x) => typeof x === 'number')) {
      return { ok: false, detail: `data[${String(i)}].embedding is not a list of numbers` };
    }
    if (embedding.length !== dimensions) {
      return {
        ok: false,
        detail: `data[${String(i)}].embedding has ${String(embedding.length)} dimensions, expected ${String(dimensions)}`,
      };
    }
    // The server says which input each vector belongs to; order by it, not by position.
    const at = typeof index === 'number' ? index : i;
    if (at < 0 || at >= inputLength || vectors[at] !== undefined)
      return { ok: false, detail: `data[${String(i)}].index ${String(index)} is out of place` };
    vectors[at] = embedding;
  }
  return { ok: true, vectors };
}

export async function embeddings(props: EmbeddingsProps): Promise<EmbedResponse> {
  const { entry, request } = props;
  const input = request.texts.map((t) =>
    request.purpose === 'query' ? entry.embed.queryTemplate.replace('{text}', t) : t,
  );
  let response: Response;
  try {
    response = await props.fetch(`${props.endpoint.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${props.endpoint.apiKey}` },
      body: JSON.stringify({ model: props.endpoint.model, input }),
      signal: callSignal(props.timeoutMs, props.abandon),
    });
  } catch (error) {
    if (props.abandon?.aborted === true) return { ok: false, reason: 'unavailable', detail: ABANDONED };
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'unavailable',
      detail: timedOut ? `no response within ${String(props.timeoutMs)} ms` : (error as Error).message,
    };
  }
  const text = await bodyText(response, props.timeoutMs, props.abandon);
  if (typeof text !== 'string') return text;
  if (!response.ok)
    return { ok: false, reason: 'upstream_error', detail: `HTTP ${String(response.status)}: ${text.slice(0, 500)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad_response', detail: `not JSON: ${text.slice(0, 200)}` };
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== input.length) {
    return {
      ok: false,
      reason: 'bad_response',
      detail: `expected ${String(input.length)} embeddings in data: ${text.slice(0, 200)}`,
    };
  }
  const vectors = parseEmbeddingVectors(data, input.length, entry.embed.dimensions);
  return vectors.ok
    ? { ok: true, vectors: vectors.vectors }
    : { ok: false, reason: 'bad_response', detail: vectors.detail };
}
