// Amazon Bedrock, a ModelProvider (docs/plans/extension-modules.md R19, R20, R24; docs/architecture/modules-bedrock.md).
// Plain JavaScript with no dependency (R23, R37): Bedrock's OpenAI-compatible Chat Completions API on bedrock-runtime,
// authenticated by a long-term Amazon Bedrock API key as a bearer token, so no request signing and no SDK. Facts read
// 2026-10-01 from docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html (the endpoint
// https://bedrock-runtime.<region>.amazonaws.com/openai/v1/chat/completions, `Authorization: Bearer <key>`) and
// .../api-keys.html. Streamed, with the vendor's usage at its end (`stream_options.include_usage`); a required tool call
// sent as `tool_choice: "required"`, never llama.cpp's prefill (R19). Whether the pinned model honours both is recorded
// by the first opt-in live run (R19).

const REGION = 'us-east-1';
const RUNTIME = `https://bedrock-runtime.${REGION}.amazonaws.com/openai/v1/chat/completions`;
const CONTROL = `https://bedrock.${REGION}.amazonaws.com/foundation-models`;
/** Bound on silence in the stream: inside the harness's own 22 s between chunks (R19). */
const IDLE_MS = 20_000;
/** Bound on the control plane's answer. */
const REQUEST_MS = 15_000;

/** The harness's chat messages as Chat Completions messages. */
function messagesOf(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** A reason from the harness's closed set (ModelFailureReason) for a fetch that threw. */
function failure(error, signal) {
  if (signal.aborted) return { ok: false, reason: 'timeout', detail: `no chunk from Bedrock within ${IDLE_MS} ms` };
  return { ok: false, reason: 'unavailable', detail: `Bedrock could not be reached: ${error.message}` };
}

/** The request body for Bedrock's Chat Completions endpoint. */
function requestBody(args) {
  return {
    model: args.model,
    messages: messagesOf(args.messages),
    max_tokens: args.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(args.tools === undefined ? {} : { tools: args.tools }),
    ...(args.requireToolCall === true ? { tool_choice: 'required' } : {}),
    ...args.settings,
  };
}

/** One streamed line: the data event it carries, or undefined for anything else (not a data line, or `[DONE]`). */
function dataEvent(line) {
  if (!line.startsWith('data:')) return undefined;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return undefined;
  return JSON.parse(data);
}

/** One streamed event's effect on the accumulating `state` (text, tool calls, usage); `onDelta` as the harness wants it. */
function applyEvent(event, state, onDelta) {
  if (event.usage)
    state.usage = { inputTokens: event.usage.prompt_tokens, outputTokens: event.usage.completion_tokens };
  const delta = event.choices?.[0]?.delta;
  if (typeof delta?.content === 'string' && delta.content !== '') {
    state.text += delta.content;
    onDelta({ part: 'text', text: delta.content });
  }
  for (const c of delta?.tool_calls ?? []) {
    const call = (state.calls[c.index] ??= { id: '', name: '', arguments: '' });
    if (c.id) call.id = c.id;
    if (c.function?.name) call.name = c.function.name;
    if (c.function?.arguments) {
      call.arguments += c.function.arguments;
      onDelta({ part: 'tool_args', index: c.index, name: call.name, text: c.function.arguments });
    }
  }
}

/** The streamed tool calls, each with its arguments parsed: `{ ok: true, result }`, or the first bad_response failure. */
function parseToolCalls(calls) {
  const toolCalls = [];
  for (const c of calls.filter(Boolean)) {
    try {
      toolCalls.push({ id: c.id, name: c.name, arguments: c.arguments === '' ? {} : JSON.parse(c.arguments) });
    } catch {
      return {
        ok: false,
        reason: 'bad_response',
        detail: `Bedrock's tool call ${c.name} has arguments that are not JSON`,
      };
    }
  }
  return { ok: true, result: toolCalls };
}

export async function chat(args, context) {
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), IDLE_MS);
  const rearm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), IDLE_MS);
  };
  try {
    let response;
    try {
      response = await fetch(RUNTIME, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${context.secrets.AWS_BEARER_TOKEN_BEDROCK}`,
        },
        body: JSON.stringify(requestBody(args)),
        signal: controller.signal,
      });
    } catch (error) {
      return failure(error, controller.signal);
    }
    if (!response.ok || response.body === null)
      return { ok: false, reason: 'upstream_error', detail: `Bedrock answered HTTP ${response.status}` };
    const state = { text: '', calls: [], usage: undefined };
    let buffered = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        rearm();
        buffered += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          const event = dataEvent(line);
          if (event !== undefined) applyEvent(event, state, context.onDelta);
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError)
        return {
          ok: false,
          reason: 'bad_response',
          detail: `Bedrock streamed a chunk that is not JSON: ${error.message}`,
        };
      return failure(error, controller.signal);
    }
    const parsed = parseToolCalls(state.calls);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      result: { text: state.text, toolCalls: parsed.result },
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    };
  } finally {
    clearTimeout(idle);
  }
}

/** The model's lifecycle state, GetFoundationModel's modelLifecycle.status (R20): what the live check reads first. */
export async function lifecycle(args, context) {
  let response;
  try {
    response = await fetch(`${CONTROL}/${encodeURIComponent(args.model)}`, {
      headers: { authorization: `Bearer ${context.secrets.AWS_BEARER_TOKEN_BEDROCK}` },
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: `Bedrock's control plane could not be reached: ${error.message}`,
    };
  }
  if (!response.ok)
    return { ok: false, reason: 'upstream_error', detail: `GetFoundationModel answered HTTP ${response.status}` };
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, reason: 'bad_response', detail: `GetFoundationModel's answer is not JSON: ${error.message}` };
  }
  const status = body?.modelDetails?.modelLifecycle?.status;
  if (typeof status !== 'string')
    return {
      ok: false,
      reason: 'bad_response',
      detail: 'GetFoundationModel answered with no modelDetails.modelLifecycle.status',
    };
  return { ok: true, result: { status } };
}
