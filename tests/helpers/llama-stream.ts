// A stand-in for llama-server's streamed chat completion (`stream: true`), in the shape the plan reviewer captured
// from llama-server 0.5.0 on 2026-09-27 (docs/plans/model-streaming.md#context, captures 1–4): an opening chunk,
// one chunk per fragment of `reasoning_content`, `content` or a tool call's arguments (the first fragment of a call
// carrying its id and name), a chunk with `finish_reason` and `timings`, a usage chunk with `choices: []`, then
// `data: [DONE]`. SYNTHETIC: step 4 of the plan replaces the unit fixtures with paired captures of the pinned server.

/** One tool call as the model streams it: its id and name once, then its arguments in fragments. */
interface StreamedToolCall {
  readonly id: string;
  readonly name: string;
  readonly fragments: readonly string[];
}

export interface StreamScript {
  /** `prompt_progress` chunks sent first (return_progress). */
  readonly progress?: number;
  readonly reasoning?: readonly string[];
  readonly content?: readonly string[];
  readonly toolCalls?: readonly StreamedToolCall[];
  /** Default: `tool_calls` when there are calls, else `stop`. */
  readonly finishReason?: string;
  /** The usage chunk's `usage`; null sends no usage chunk. */
  readonly usage?: Record<string, unknown> | null;
  /** Send `data: [DONE]` (default true). */
  readonly done?: boolean;
}

/** The usage llama-server 0.5.0 sends in a non-streamed response (prompt-prefix R10), assumed the same streamed. */
export const STREAM_USAGE = {
  completion_tokens: 7,
  prompt_tokens: 42,
  total_tokens: 49,
  prompt_tokens_details: { cached_tokens: 40 },
};

const BASE = {
  created: 1_790_000_000,
  id: 'chatcmpl-test',
  model: 'm',
  system_fingerprint: 'b11146-7fe450e19',
  object: 'chat.completion.chunk',
};
const choice = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
  ...BASE,
  choices: [{ finish_reason: finishReason, index: 0, delta }],
});

/** The chunks of a streamed completion, in order; the string `[DONE]` for the terminator. */
export function llamaChunks(script: StreamScript): (Record<string, unknown> | '[DONE]')[] {
  const chunks: (Record<string, unknown> | '[DONE]')[] = [];
  for (let i = 0; i < (script.progress ?? 0); i += 1) {
    // As llama.cpp's server writes a progress chunk (server-task.cpp, read by the review of 2026-09-29 in the
    // vendored source, not the pinned build): an empty assistant delta beside prompt_progress.
    chunks.push({
      ...choice({ role: 'assistant', content: null }),
      prompt_progress: { total: 6010, cache: 0, processed: 2048 * (i + 1), time_ms: 4600 * (i + 1) },
    });
  }
  chunks.push(choice({ role: 'assistant', content: null }));
  for (const text of script.reasoning ?? []) chunks.push(choice({ reasoning_content: text }));
  for (const text of script.content ?? []) chunks.push(choice({ content: text }));
  for (const [index, call] of (script.toolCalls ?? []).entries()) {
    call.fragments.forEach((fragment, i) =>
      chunks.push(
        choice({
          tool_calls: [
            i === 0
              ? { index, id: call.id, type: 'function', function: { name: call.name, arguments: fragment } }
              : { index, function: { arguments: fragment } },
          ],
        }),
      ),
    );
  }
  const finish = script.finishReason ?? ((script.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop');
  chunks.push({ ...choice({}, finish), timings: { prompt_n: 2, predicted_n: 7 } });
  if (script.usage !== null) chunks.push({ ...BASE, choices: [], usage: script.usage ?? STREAM_USAGE });
  if (script.done !== false) chunks.push('[DONE]');
  return chunks;
}

/**
 * The stream of a non-streamed assistant message (`{content, tool_calls}`), as a fake model server built for
 * `stream: false` answers: its content as one fragment, each call's arguments in two, split at their middle.
 */
export function scriptOf(message: {
  readonly content?: string | null;
  readonly tool_calls?: readonly { id: string; function: { name: string; arguments: string } }[];
}): StreamScript {
  return {
    content: typeof message.content === 'string' && message.content !== '' ? [message.content] : [],
    toolCalls: (message.tool_calls ?? []).map((c) => {
      const half = Math.ceil(c.function.arguments.length / 2);
      return {
        id: c.id,
        name: c.function.name,
        fragments: [c.function.arguments.slice(0, half), c.function.arguments.slice(half)],
      };
    }),
  };
}

/** The SSE text of chunks, as llama-server writes it: `data: <json>` and a blank line each. */
export function sseText(chunks: readonly (Record<string, unknown> | string)[]): string {
  return chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
}

/** A 200 `text/event-stream` response carrying the script's chunks, each chunk of text its own network read. */
export function sseResponse(script: StreamScript | readonly (Record<string, unknown> | string)[]): Response {
  const chunks = Array.isArray(script) ? script : llamaChunks(script as StreamScript);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(sseText([chunk])));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A streamed response the test feeds by hand, which errors with the request's abort reason when its signal aborts,
 * as the real fetch's body does.
 */
export function manualStream(signal: AbortSignal): {
  readonly response: Response;
  send(text: string): void;
  end(): void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener(
        'abort',
        () => {
          c.error(signal.reason);
        },
        { once: true },
      );
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (text) => {
      controller.enqueue(encoder.encode(text));
    },
    end: () => {
      controller.close();
    },
  };
}
