import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ABANDONED,
  CHAT_IDLE_BOUND_MS,
  CHAT_QUEUE_BOUND_MS,
  DeltaSinkFailed,
  PROMPT_STORE_TEXT,
  STORE_ABANDONED,
  chatCompletion,
  embeddings,
  storeIdlePrompts,
  type ChatCompletionProps,
  type ModelDelta,
} from '../../src/daemon/model-gateway/index.js';
import type { EmbeddingModelEntry } from '../../src/daemon/definitions/index.js';
import { present } from '../../src/shared/assert-present.js';
import { AGENT_CHAT_TIMEOUT_MS, type ChatRequest } from '../../src/shared/protocol.js';
import { FakeFetch, json } from '../helpers/fakes.js';
import { collectGarbage } from '../helpers/gc.js';
import {
  STREAM_USAGE,
  llamaChunks,
  manualStream,
  sseResponse,
  sseText,
  type StreamScript,
} from '../helpers/llama-stream.js';

const ENDPOINT = { baseUrl: 'http://127.0.0.1:5555', model: 'qwen3-0.6b-q8_0', apiKey: 'k'.repeat(64) };
const REQUEST: ChatRequest = {
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Say hello.' },
  ],
  maxTokens: 64,
};
const TOOLS = [
  { type: 'function' as const, function: { name: 'send_message', description: 'd', parameters: { type: 'object' } } },
];
const REQUIRED = { ...REQUEST, tools: TOOLS, requireToolCall: true };
/** The fields the gateway adds to every chat body: a stream, its usage chunk, and progress chunks during the prompt (R1, R2, R2b). */
const STREAMING = { stream: true, stream_options: { include_usage: true }, return_progress: true };

/** The whole result the daemon sees: the agent's ChatResponse and the call's stream statistics. */
function complete(fake: FakeFetch, overrides: Partial<ChatCompletionProps> = {}) {
  return chatCompletion({
    fetch: fake.fetch,
    endpoint: ENDPOINT,
    chatDefaults: { temperature: 0.7 },
    toolCallStart: '<tool_call>\n',
    request: REQUEST,
    ...overrides,
  });
}

/** The ChatResponse the agent receives. */
async function call(fake: FakeFetch, overrides: Partial<ChatCompletionProps> = {}) {
  return (await complete(fake, overrides)).response;
}

/** A model server that streams this script. */
const streaming = (script: StreamScript) => new FakeFetch(() => sseResponse(script));
/** A model server that streams these raw chunks (JSON objects, `[DONE]`, or a raw line). */
const raw = (...lines: string[]) =>
  new FakeFetch(() => new Response(lines.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));

const reply = (id: string, fragments: readonly string[]) => ({ id, name: 'reply', fragments });

describe('chatCompletion: the request (R1, R2, R2b, R9)', () => {
  it('POSTs one streamed completion: defaults merged, harness fields winning every collision', async () => {
    const fake = streaming({ content: ['Hello.'] });

    await call(fake, {
      chatDefaults: {
        temperature: 0.7,
        top_k: 20,
        chat_template_kwargs: { enable_thinking: false },
        model: 'wrong-model',
        messages: [{ role: 'user', content: 'injected' }],
        max_tokens: 99_999,
        stream: false,
        stream_options: { include_usage: false },
        return_progress: false,
      },
    });

    expect(fake.requests).toHaveLength(1);
    const { url, init } = present(fake.requests[0], 'fake.requests[0]');
    expect(url).toBe('http://127.0.0.1:5555/v1/chat/completions');
    expect(init?.method).toBe('POST');
    // llama-server requires its key on every model route (control-api-auth R8).
    expect(init?.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${'k'.repeat(64)}` });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(fake.bodies()).toEqual([
      {
        temperature: 0.7,
        top_k: 20,
        chat_template_kwargs: { enable_thinking: false },
        model: 'qwen3-0.6b-q8_0',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Say hello.' },
        ],
        max_tokens: 64,
        ...STREAMING,
      },
    ]);
  });

  it('sends the streaming fields even when no default mentions them', async () => {
    const fake = streaming({ content: ['Hi'] });
    await call(fake, { chatDefaults: {} });
    expect(fake.bodies()).toEqual([
      { model: 'qwen3-0.6b-q8_0', messages: REQUEST.messages, max_tokens: 64, ...STREAMING },
    ]);
  });

  it('sends earlier tool calls and their results in the OpenAI shape', async () => {
    const fake = streaming({ content: ['ok'] });
    await call(fake, {
      request: {
        maxTokens: 5,
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'l1', name: 'list_agents', arguments: {} }] },
          { role: 'tool', toolCallId: 'l1', content: '[]' },
        ],
      },
    });
    expect((fake.bodies()[0] as { messages: unknown }).messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'l1', type: 'function', function: { name: 'list_agents', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'l1', content: '[]' },
    ]);
  });

  // llama.cpp 0.5.0 (b11146) lets free text come before a required tool call (upstream #22654); qwen3-8b then
  // wrote text until max_tokens and made no call at all. Opening the assistant turn with the template's
  // tool-call marker makes the turn begin with a call again, as tool_choice required did on build 8130.
  it("opens the assistant turn with the model's tool-call marker when a tool call is required, and only then", async () => {
    const fake = streaming({ content: ['x'] });
    await call(fake, { request: REQUIRED });
    await call(fake, { request: { ...REQUEST, tools: TOOLS } });
    await call(fake);
    expect(fake.bodies()).toEqual([
      {
        temperature: 0.7,
        model: 'qwen3-0.6b-q8_0',
        messages: [...REQUEST.messages, { role: 'assistant', content: '<tool_call>\n' }],
        max_tokens: 64,
        tools: TOOLS,
        tool_choice: 'required',
        ...STREAMING,
      },
      {
        temperature: 0.7,
        model: 'qwen3-0.6b-q8_0',
        messages: REQUEST.messages,
        max_tokens: 64,
        tools: TOOLS,
        ...STREAMING,
      },
      { temperature: 0.7, model: 'qwen3-0.6b-q8_0', messages: REQUEST.messages, max_tokens: 64, ...STREAMING },
    ]);
  });

  // R9: with the prefill the model does not think at all (capture 2), so a recipe that turns thinking on gets none.
  it('sends no prefill when the merged chat_template_kwargs turns thinking on, and the prefill whenever it does not (R9, A7)', async () => {
    const fake = streaming({ content: ['x'] });
    const thinking = { temperature: 0.6, chat_template_kwargs: { enable_thinking: true } };
    await call(fake, { chatDefaults: thinking, request: REQUIRED });
    await call(fake, { chatDefaults: { chat_template_kwargs: { enable_thinking: false } }, request: REQUIRED });
    // A recipe's chat_template_kwargs replaces the entry's whole (a shallow merge): no kwargs, no thinking.
    await call(fake, { chatDefaults: { chat_template_kwargs: {} }, request: REQUIRED });
    await call(fake, { chatDefaults: { chat_template_kwargs: { enable_thinking: 'true' } }, request: REQUIRED });
    const prefilled = fake
      .bodies()
      .map(
        (b) => present((b as { messages: { role: string }[] }).messages.at(-1), 'last message').role === 'assistant',
      );
    expect(prefilled).toEqual([false, true, true, true]);
    expect(fake.bodies()[0]).toEqual({
      ...thinking,
      model: 'qwen3-0.6b-q8_0',
      messages: REQUEST.messages,
      max_tokens: 64,
      tools: TOOLS,
      tool_choice: 'required',
      ...STREAMING,
    });
  });
});

describe('chatCompletion: assembling the stream (R1, R2b, A1)', () => {
  it('returns the text of content fragments, streaming each as part text in order', async () => {
    const deltas: ModelDelta[] = [];
    const result = await complete(streaming({ content: ['Hello', ' there', '.'] }), { onDelta: (d) => deltas.push(d) });
    expect(result.response).toEqual({ ok: true, text: 'Hello there.', toolCalls: [] });
    expect(deltas).toEqual([
      { part: 'text', text: 'Hello' },
      { part: 'text', text: ' there' },
      { part: 'text', text: '.' },
    ]);
  });

  it('assembles a tool call whose arguments arrive across several chunks, streaming each fragment with its index and name', async () => {
    const deltas: ModelDelta[] = [];
    const result = await complete(streaming({ toolCalls: [reply('c1', ['{', '"text"', ': "Hi', ' there."', '}'])] }), {
      request: REQUIRED,
      onDelta: (d) => deltas.push(d),
    });
    expect(result.response).toEqual({
      ok: true,
      text: '',
      toolCalls: [{ id: 'c1', name: 'reply', arguments: { text: 'Hi there.' } }],
    });
    expect(deltas).toEqual(
      ['{', '"text"', ': "Hi', ' there."', '}'].map((text) => ({ part: 'tool_args', index: 0, name: 'reply', text })),
    );
  });

  it('assembles two tool calls in index order', async () => {
    const result = await call(
      streaming({
        toolCalls: [
          { id: 'l1', name: 'list_agents', fragments: ['{', '}'] },
          { id: 's1', name: 'send_message', fragments: ['{"to":"hewo-2",', '"text":"hi"}'] },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      text: '',
      toolCalls: [
        { id: 'l1', name: 'list_agents', arguments: {} },
        { id: 's1', name: 'send_message', arguments: { to: 'hewo-2', text: 'hi' } },
      ],
    });
  });

  it('streams reasoning_content as part thinking, before the call, and leaves it out of the text (R9)', async () => {
    const deltas: ModelDelta[] = [];
    const result = await complete(
      streaming({ reasoning: ['The user', ' wants a greeting.'], toolCalls: [reply('c1', ['{"text":"Hi."}'])] }),
      {
        chatDefaults: { chat_template_kwargs: { enable_thinking: true } },
        request: REQUIRED,
        onDelta: (d) => deltas.push(d),
      },
    );
    // The same ChatResponse as the stream without thinking.
    const plain = await call(streaming({ toolCalls: [reply('c1', ['{"text":"Hi."}'])] }), { request: REQUIRED });
    expect(result.response).toEqual(plain);
    expect(result.response).toEqual({
      ok: true,
      text: '',
      toolCalls: [{ id: 'c1', name: 'reply', arguments: { text: 'Hi.' } }],
    });
    expect(deltas).toEqual([
      { part: 'thinking', text: 'The user' },
      { part: 'thinking', text: ' wants a greeting.' },
      { part: 'tool_args', index: 0, name: 'reply', text: '{"text":"Hi."}' },
    ]);
  });

  it("returns the usage chunk's counts and the stream's statistics beside the response (R8)", async () => {
    const result = await complete(streaming({ progress: 2, content: ['a', 'b'] }));
    expect(result.stats).toEqual({
      ttfcMs: expect.any(Number) as number,
      // Two progress chunks, the opening chunk, two content chunks, the finish chunk, the usage chunk.
      chunks: 7,
      promptTokens: 42,
      completionTokens: 7,
      cachedTokens: 40,
    });
  });

  it('gives the same result with no onDelta as with one (R1, A1)', async () => {
    const script: StreamScript = { reasoning: ['hmm'], content: ['x'], toolCalls: [reply('c1', ['{"text":', '"y"}'])] };
    const withSink = await complete(streaming(script), { request: REQUIRED, onDelta: () => undefined });
    const without = await complete(streaming(script), { request: REQUIRED });
    expect(without.response).toEqual(withSink.response);
    expect({ ...without.stats, ttfcMs: 0 }).toEqual({ ...withSink.stats, ttfcMs: 0 });
  });

  it('sends no delta for progress chunks, the opening chunk or an empty fragment', async () => {
    const deltas: ModelDelta[] = [];
    await complete(streaming({ progress: 3, content: ['', 'x', ''] }), { onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual([{ part: 'text', text: 'x' }]);
  });

  // The failure seen on llama.cpp 0.5.0 before the prefill: qwen3-8b wrote text until max_tokens and made no call,
  // and the gateway answered ok, so the agent reported "answered with text instead of a tool call" — not the cause.
  it('returns truncated when a required tool call never came because the output hit max_tokens', async () => {
    const response = await call(
      streaming({ content: ['I will think about which tool', ' to call first, and then'], finishReason: 'length' }),
      { request: REQUIRED },
    );
    expect(response).toEqual({
      ok: false,
      reason: 'truncated',
      detail:
        'the output reached the token limit (max_tokens 64) before a complete tool call: I will think about which tool to call first, and then',
    });
  });

  it('returns truncated, not bad_response, when the limit cut a required call off mid-arguments', async () => {
    const response = await call(streaming({ toolCalls: [reply('c1', ['{"text":'])], finishReason: 'length' }), {
      request: REQUIRED,
    });
    expect(response).toEqual({
      ok: false,
      reason: 'truncated',
      detail:
        'the output reached the token limit (max_tokens 64) before a complete tool call: tool call reply has arguments that are not JSON: {"text":',
    });
  });

  // Capture 2: at max_tokens 40 the whole budget went to thinking and the stream ended length with no call.
  it('returns truncated saying the cut came while thinking when the limit passed before any output but thinking (R9)', async () => {
    const response = await call(streaming({ reasoning: ['Okay, the user', ' wants'], finishReason: 'length' }), {
      chatDefaults: { chat_template_kwargs: { enable_thinking: true } },
      request: REQUIRED,
    });
    expect(response).toEqual({
      ok: false,
      reason: 'truncated',
      detail:
        'the output reached the token limit (max_tokens 64) while thinking, before any tool call: Okay, the user wants',
    });
  });

  it('says the cut came after thinking when the call had begun', async () => {
    const response = await call(
      streaming({ reasoning: ['ok'], toolCalls: [reply('c1', ['{"te'])], finishReason: 'length' }),
      {
        chatDefaults: { chat_template_kwargs: { enable_thinking: true } },
        request: REQUIRED,
      },
    );
    expect(response).toEqual({
      ok: false,
      reason: 'truncated',
      detail:
        'the output reached the token limit (max_tokens 64) before a complete tool call: tool call reply has arguments that are not JSON: {"te',
    });
  });

  it('still returns bad_response for malformed arguments that the limit did not cut', async () => {
    const response = await call(streaming({ toolCalls: [reply('c1', ['{"text":'])] }), { request: REQUIRED });
    expect(response).toEqual({
      ok: false,
      reason: 'bad_response',
      detail: 'tool call reply has arguments that are not JSON: {"text":',
    });
  });

  it.each([
    [
      'a required call that ended normally with text only',
      REQUIRED,
      { content: ['Hi.'] },
      { ok: true, text: 'Hi.', toolCalls: [] },
    ],
    [
      'a truncated answer when no call was required',
      { ...REQUEST, tools: TOOLS },
      { content: ['Hi th'], finishReason: 'length' },
      { ok: true, text: 'Hi th', toolCalls: [] },
    ],
    [
      'a required call that arrived whole before the limit',
      REQUIRED,
      {
        toolCalls: [{ id: 'x', name: 'send_message', fragments: ['{"to":"user",', '"text":"hi"}'] }],
        finishReason: 'length',
      },
      { ok: true, text: '', toolCalls: [{ id: 'x', name: 'send_message', arguments: { to: 'user', text: 'hi' } }] },
    ],
  ] as const)('is not truncated for %s', async (_, request, script, expected) => {
    await expect(call(streaming(script), { request })).resolves.toEqual(expected);
  });

  it.each([
    [
      'arguments that are not JSON',
      { id: 'c', name: 'f', fragments: ['{nope'] },
      'tool call f has arguments that are not JSON',
    ],
    [
      'arguments that are not an object',
      { id: 'c', name: 'f', fragments: ['[1]'] },
      'tool call f has arguments that are not an object',
    ],
    ['a call with no id', { id: '', name: 'f', fragments: ['{}'] }, 'tool call f has no id'],
  ])('returns bad_response for %s', async (_, toolCall, detail) => {
    const response = await call(streaming({ toolCalls: [toolCall] }));
    expect(response).toEqual({ ok: false, reason: 'bad_response', detail: expect.stringContaining(detail) as string });
  });

  it("returns bad_response for a tool-call fragment that arrives before its call's name", async () => {
    const chunk = {
      choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }],
    };
    const response = await call(raw(sseText([chunk, ...llamaChunks({}).slice(1)])));
    expect(response).toEqual({
      ok: false,
      reason: 'bad_response',
      detail: 'tool call 0 streamed arguments before its name',
    });
  });

  it('returns bad_response for a tool call whose index leaves a gap', async () => {
    const chunk = {
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { tool_calls: [{ index: 1, id: 'a', function: { name: 'f', arguments: '{}' } }] },
        },
      ],
    };
    const response = await call(raw(sseText([chunk, ...llamaChunks({}).slice(1)])));
    expect(response).toEqual({
      ok: false,
      reason: 'bad_response',
      detail: 'the stream has tool calls at indexes 1, not 0 to 1',
    });
  });
});

describe('chatCompletion: a stream short of complete is bad_response (R2b, A1)', () => {
  const chunks = llamaChunks({ content: ['Hello.'] });
  const done = present(chunks.at(-1), 'done chunk');
  const usage = present(chunks.at(-2), 'usage chunk');
  const finish = present(chunks.at(-3), 'finish chunk');
  const output = chunks.slice(0, -3);

  it.each([
    ['closes before data: [DONE]', sseText(chunks.slice(0, -1)), 'the stream ended before data: [DONE]'],
    ['has no usage chunk', sseText([...output, finish, done]), 'the stream has no usage chunk'],
    [
      'has no finish_reason chunk',
      sseText([...output, usage, done]),
      'a usage chunk before the chunk with finish_reason',
    ],
    [
      'has two finish_reason chunks',
      sseText([...output, finish, finish, usage, done]),
      expect.stringContaining('a chunk after the one with finish_reason: ') as string,
    ],
    [
      'sends output after its finish_reason chunk',
      sseText([...output, finish, present(output.at(-1), 'last output chunk'), usage, done]),
      expect.stringContaining('a chunk after the one with finish_reason: ') as string,
    ],
    ['has two usage chunks', sseText([...output, finish, usage, usage, done]), 'a second usage chunk'],
    ['sends a chunk after data: [DONE]', sseText([...chunks, usage]), 'data after data: [DONE]'],
    [
      'has a line that is not JSON',
      `${sseText(output)}data: {"choices":[{"delta":\n\n${sseText([finish, usage, done])}`,
      'not JSON: {"choices":[{"delta":',
    ],
    [
      'has a line that is not SSE data',
      `${sseText(output)}garbage\n\n${sseText([finish, usage, done])}`,
      'not an SSE data line: garbage',
    ],
    [
      'has a chunk without a choices array',
      sseText([...output, { id: 'x' }, finish, usage, done]),
      'a chunk without a choices array: {"id":"x"}',
    ],
    [
      'is a JSON body, not a stream',
      JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
      expect.stringContaining('not an SSE data line: {"choices"') as string,
    ],
    ['is empty', '', 'the stream ended before data: [DONE]'],
  ])('when the stream %s', async (_, body, detail) => {
    const response = await call(raw(body));
    expect(response).toEqual({ ok: false, reason: 'bad_response', detail });
  });

  it.each([
    [
      'without usage.prompt_tokens_details.cached_tokens',
      { completion_tokens: 19, prompt_tokens: 1882, total_tokens: 1901 },
      'usage.prompt_tokens_details.cached_tokens is not a non-negative integer: null',
    ],
    [
      'with a negative prompt_tokens',
      { ...STREAM_USAGE, prompt_tokens: -1 },
      'usage.prompt_tokens is not a non-negative integer: -1',
    ],
    [
      'without completion_tokens',
      { prompt_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } },
      'usage.completion_tokens is not a non-negative integer: null',
    ],
    [
      'with a count that is not an integer',
      { ...STREAM_USAGE, prompt_tokens_details: { cached_tokens: 1.5 } },
      'usage.prompt_tokens_details.cached_tokens is not a non-negative integer: 1.5',
    ],
  ])('when its usage chunk arrives %s, naming the field', async (_, usage, detail) => {
    const result = await complete(streaming({ content: ['x'], usage }));
    expect(result.response).toEqual({ ok: false, reason: 'bad_response', detail });
    expect(result.stats).toMatchObject({ promptTokens: null, completionTokens: null, cachedTokens: null });
  });

  it('never returns a shorter answer: a stream cut after its text is not ok', async () => {
    const response = await call(raw(sseText(output)));
    expect(response.ok).toBe(false);
  });
});

describe('chatCompletion: failures from the model server', () => {
  // Capture 6: a prompt over the context size is a plain HTTP 400 JSON body, not a stream.
  it('returns upstream_error with the status and up to 500 characters of the body on a non-2xx', async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: `the request exceeds the available context size, try increasing it ${'x'.repeat(600)}`,
        type: 'exceed_context_size_error',
      },
    });
    const response = await call(
      new FakeFetch(() => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })),
    );
    expect(response).toEqual({ ok: false, reason: 'upstream_error', detail: `HTTP 400: ${body.slice(0, 500)}` });
  });

  it('returns upstream_error when the stream itself reports an error', async () => {
    const error = { error: { code: 500, message: 'slot unavailable', type: 'server_error' } };
    const response = await call(raw(sseText([present(llamaChunks({})[0], 'first llama chunk'), error])));
    expect(response).toEqual({
      ok: false,
      reason: 'upstream_error',
      detail: `the stream reported an error: ${JSON.stringify(error)}`,
    });
  });

  it('returns unavailable when the connection fails', async () => {
    const fake = new FakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(call(fake)).resolves.toEqual({ ok: false, reason: 'unavailable', detail: 'fetch failed' });
  });

  it('returns unavailable, as data, when the server cuts the stream off mid-body', async () => {
    const cut = new FakeFetch(() => {
      let reads = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          // The first read gets two chunks; the second finds the connection gone.
          pull(controller) {
            reads += 1;
            if (reads === 1)
              controller.enqueue(new TextEncoder().encode(sseText(llamaChunks({ content: ['Hel'] }).slice(0, 2))));
            else controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const result = await complete(cut);
    expect(result.response).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'the response body was cut off: terminated',
    });
    expect(result.stats).toMatchObject({ chunks: 2, promptTokens: null, completionTokens: null });
  });
});

/**
 * A completion captured from the pinned llama-server 0.5.0 (build 11146) at a clean commit, not streamed: hewo-1's
 * turn sent twice, the second served from the slot's prompt cache (evals/probes/prompt-prefix-2026-09-28/capture-usage.mjs).
 * Streamed here as a synthetic stream of the same call and usage, until step 4 of model-streaming captures the pair.
 */
const CAPTURED = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'probes', 'prompt-prefix-2026-09-28', 'capture-usage.json'),
    'utf8',
  ),
) as {
  llamaServer: string;
  response: {
    usage: Record<string, unknown>;
    choices: [{ message: { tool_calls: [{ id: string; function: { name: string; arguments: string } }] } }];
  };
};

describe('the prompt token counts beside the response (prompt-prefix R10, A6)', () => {
  it('returns both counts from the usage of a captured llama-server 0.5.0 response, and the ChatResponse unchanged', async () => {
    expect(CAPTURED.llamaServer).toBe('version: 0.5.0 (build 11146, commit 7fe450e19)');
    const captured = CAPTURED.response.choices[0].message.tool_calls[0];
    const args = captured.function.arguments;
    const result = await complete(
      streaming({
        toolCalls: [{ id: captured.id, name: captured.function.name, fragments: [args.slice(0, 5), args.slice(5)] }],
        usage: CAPTURED.response.usage,
      }),
      {
        request: REQUIRED,
      },
    );
    expect(result.response).toEqual({
      ok: true,
      text: '',
      toolCalls: [{ id: 'AVYkMJSHLqcSmVJyWxRRM9f2vmY6aPiL', name: 'reply', arguments: { text: 'Good morning.' } }],
    });
    expect(result.stats).toMatchObject({ promptTokens: 1882, cachedTokens: 1881, completionTokens: 19 });
  });
});

/**
 * model-streaming A1: pairs captured from the pinned llama-server 0.5.0 (build 11146) on both chat models the gate
 * runs — the same request sent whole (`stream: false`) and streamed — by evals/probes/model-streaming-2026-09-29/
 * capture.mjs at a clean commit. The streamed result must equal the whole one in ok, text, tool-call names and
 * arguments, and failure reason (never ids or details).
 */
const CAPTURES = join(import.meta.dirname, '..', 'fixtures', 'probes', 'model-streaming-2026-09-29', 'captures');
interface Capture {
  readonly commit: string;
  readonly dirty: boolean;
  readonly llamaServer: string;
  readonly model: string;
  readonly case: string;
  readonly request: {
    readonly max_tokens: number;
    readonly tool_choice?: string;
    readonly chat_template_kwargs?: { readonly enable_thinking?: boolean };
  };
  readonly whole: { readonly status: number; readonly type: string; readonly text: string };
  readonly stream: { readonly status: number; readonly type: string; readonly text: string };
}
const PAIRS = [
  ...['text', 'tool-call', 'cut-by-max-tokens', 'over-context', 'thinking', 'thinking-cut'].map(
    (c) => `qwen3-8b-q4_k_m-${c}`,
  ),
  ...['text', 'tool-call', 'cut-by-max-tokens', 'over-context'].map((c) => `ministral-3-8b-instruct-2512-q4_k_m-${c}`),
];

/** What the whole answer says, in the terms R1 compares: ok and text and the calls' names and arguments, or the failure reason. */
function wholeOutcome(capture: Capture): unknown {
  if (capture.whole.status !== 200) return { ok: false, reason: 'upstream_error' };
  const choice = (
    JSON.parse(capture.whole.text) as {
      choices: [
        {
          finish_reason: string;
          message: { content: string | null; tool_calls?: { function: { name: string; arguments: string } }[] };
        },
      ];
    }
  ).choices[0];
  const parsed = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  const calls = (choice.message.tool_calls ?? []).map((c) => ({
    name: c.function.name,
    arguments: parsed(c.function.arguments),
  }));
  // A required call cut by the token limit — no call, or one whose arguments are not whole JSON — is truncated (the
  // non-streamed rule, unchanged).
  if (
    capture.request.tool_choice === 'required' &&
    choice.finish_reason === 'length' &&
    (calls.length === 0 || calls.some((c) => c.arguments === undefined))
  ) {
    return { ok: false, reason: 'truncated' };
  }
  return { ok: true, text: choice.message.content ?? '', toolCalls: calls };
}

describe('the paired llama-server 0.5.0 captures: streamed equals whole (A1)', () => {
  it('covers every pair the plan names, captured at a clean commit from the pinned build', () => {
    for (const name of PAIRS) {
      const capture = JSON.parse(readFileSync(join(CAPTURES, `${name}.json`), 'utf8')) as Capture;
      expect([capture.dirty, capture.llamaServer], name).toEqual([
        false,
        'version: 0.5.0 (build 11146, commit 7fe450e19)',
      ]);
    }
  });

  it.each(PAIRS)('%s', async (name) => {
    const capture = JSON.parse(readFileSync(join(CAPTURES, `${name}.json`), 'utf8')) as Capture;
    const deltas: ModelDelta[] = [];
    const result = await complete(
      new FakeFetch(
        () =>
          new Response(capture.stream.text, {
            status: capture.stream.status,
            headers: { 'content-type': capture.stream.type },
          }),
      ),
      {
        chatDefaults:
          capture.request.chat_template_kwargs === undefined
            ? {}
            : { chat_template_kwargs: capture.request.chat_template_kwargs },
        request: {
          ...REQUEST,
          maxTokens: capture.request.max_tokens,
          ...(capture.request.tool_choice === 'required' ? { tools: TOOLS, requireToolCall: true } : {}),
        },
        onDelta: (d) => deltas.push(d),
      },
    );
    const { response } = result;
    const streamed = response.ok
      ? {
          ok: true,
          text: response.text,
          toolCalls: response.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
        }
      : { ok: false, reason: response.reason };
    expect(streamed).toEqual(wholeOutcome(capture));
    if (capture.stream.status === 200) {
      // The usage chunk carries all three counts on the pinned build (amendment 1), and the deltas rebuild the output.
      expect(result.stats).toMatchObject({
        promptTokens: expect.any(Number) as number,
        completionTokens: expect.any(Number) as number,
        cachedTokens: expect.any(Number) as number,
      });
      if (response.ok) {
        expect(
          deltas
            .filter((d) => d.part === 'text')
            .map((d) => d.text)
            .join(''),
        ).toBe(response.text);
        expect(
          response.toolCalls.map(
            (_, i) =>
              JSON.parse(
                deltas
                  .filter((d) => d.part === 'tool_args' && d.index === i)
                  .map((d) => d.text)
                  .join(''),
              ) as unknown,
          ),
        ).toEqual(response.toolCalls.map((c) => c.arguments));
      }
    }
    // Thinking streams first, and only with thinking on (R9).
    const thinking = deltas.filter((d) => d.part === 'thinking');
    expect(thinking.length > 0, 'thinking deltas').toBe(capture.request.chat_template_kwargs?.enable_thinking === true);
    if (name.endsWith('-thinking-cut'))
      expect(response).toMatchObject({
        ok: false,
        reason: 'truncated',
        detail: expect.stringContaining('while thinking') as string,
      });
  });
});

describe('chatCompletion: bounded by inactivity, never by wall clock (R2, A2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A model server whose stream the test feeds, and the request's signal. */
  function fed() {
    let stream: ReturnType<typeof manualStream> | undefined;
    let signal: AbortSignal | undefined;
    const fake = new FakeFetch((_url, init) => {
      signal = present(present(init, 'fetch init').signal, 'abort signal');
      stream = manualStream(signal);
      return stream.response;
    });
    return {
      fake,
      get stream() {
        return present(stream, 'stream');
      },
      get signal() {
        return present(signal, 'signal');
      },
    };
  }
  const progressChunk = sseText([present(llamaChunks({ progress: 1 })[0], 'progress chunk')]);

  it("pins the bounds to R2's rule over every recorded measurement (A9's two runs, capture 5), the queue bound capped at the SDK's bound less 5 s", () => {
    type Measured = { dirty: boolean; llamaServer: string; max: { firstChunkMs: number; longestGapMs: number } };
    const read = (file: string) => JSON.parse(readFileSync(join(CAPTURES, '..', file), 'utf8')) as Measured;
    const runs = [read('measure-e241518.json'), read('measure.json')];
    for (const run of runs)
      expect([run.dirty, run.llamaServer]).toEqual([false, 'version: 0.5.0 (build 11146, commit 7fe450e19)']);
    expect(runs.map((r) => r.max)).toEqual([
      { firstChunkMs: 31_774, longestGapMs: 5_531 },
      { firstChunkMs: 32_670, longestGapMs: 5_411 },
    ]);
    // The plan reviewer's capture 5 (2026-09-27, the plan's Context; no record file): 27 s to a queued first chunk, 11 s gap.
    const firstChunkMs = Math.max(27_000, ...runs.map((r) => r.max.firstChunkMs));
    const longestGapMs = Math.max(11_000, ...runs.map((r) => r.max.longestGapMs));
    const rule = (ms: number) => Math.ceil((2 * ms) / 1000) * 1000;
    expect(CHAT_IDLE_BOUND_MS).toBe(rule(longestGapMs));
    expect(CHAT_QUEUE_BOUND_MS).toBe(Math.min(rule(firstChunkMs), AGENT_CHAT_TIMEOUT_MS - 5_000));
    expect([CHAT_QUEUE_BOUND_MS, CHAT_IDLE_BOUND_MS]).toEqual([55_000, 22_000]);
    expect(CHAT_QUEUE_BOUND_MS).toBeLessThan(AGENT_CHAT_TIMEOUT_MS);
    expect(CHAT_IDLE_BOUND_MS).toBeLessThan(AGENT_CHAT_TIMEOUT_MS);
  });

  it('fails timeout naming the queue bound when no chunk comes within it, and aborts the request', async () => {
    vi.useFakeTimers();
    const server = fed();
    const pending = call(server.fake);
    await vi.advanceTimersByTimeAsync(CHAT_QUEUE_BOUND_MS - 1);
    expect(server.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      detail: 'no chunk within the queue bound of 55000 ms after the request was sent',
    });
    expect(server.signal.aborted).toBe(true);
  });

  it("counts the queue bound from the call's start: a call that waited for its model's server has the rest, and says so (idle-shutdown R2)", async () => {
    vi.useFakeTimers();
    const server = fed();
    const pending = call(server.fake, { waitedMs: 15_000 });
    await vi.advanceTimersByTimeAsync(CHAT_QUEUE_BOUND_MS - 15_000 - 1);
    expect(server.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      detail:
        "no chunk within the queue bound of 55000 ms after the call began, 15000 ms of it waiting for its model's server to start",
    });
    expect(server.signal.aborted).toBe(true);
  });

  it('fails timeout naming the idle bound when the stream stalls between chunks, and aborts the request', async () => {
    vi.useFakeTimers();
    const server = fed();
    const pending = complete(server.fake);
    await vi.advanceTimersByTimeAsync(1_000);
    server.stream.send(sseText(llamaChunks({ content: ['He'] }).slice(0, 2)));
    await vi.advanceTimersByTimeAsync(CHAT_IDLE_BOUND_MS - 1);
    expect(server.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.response).toEqual({
      ok: false,
      reason: 'timeout',
      detail: 'no chunk within the idle bound of 22000 ms after the previous chunk',
    });
    expect(server.signal.aborted).toBe(true);
    expect(result.stats).toEqual({
      ttfcMs: 1_000,
      chunks: 2,
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
    });
  });

  it('counts progress chunks as activity: spaced just under the idle bound they keep a call alive past both bounds combined', async () => {
    vi.useFakeTimers();
    const server = fed();
    const pending = complete(server.fake);
    // The first progress chunk just inside the queue bound, then four more each just inside the idle bound.
    await vi.advanceTimersByTimeAsync(CHAT_QUEUE_BOUND_MS - 1);
    server.stream.send(progressChunk);
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(CHAT_IDLE_BOUND_MS - 1);
      server.stream.send(progressChunk);
    }
    expect(Date.now() - 0).toBeGreaterThan(CHAT_QUEUE_BOUND_MS + CHAT_IDLE_BOUND_MS);
    expect(server.signal.aborted).toBe(false);
    server.stream.send(sseText(llamaChunks({ content: ['Done.'] })));
    server.stream.end();
    const result = await pending;
    expect(result.response).toEqual({ ok: true, text: 'Done.', toolCalls: [] });
    // Time to the first chunk of output, the progress chunks excluded.
    expect(result.stats.ttfcMs).toBe(CHAT_QUEUE_BOUND_MS - 1 + 4 * (CHAT_IDLE_BOUND_MS - 1));
    // Five progress chunks, then the opening, content, finish and usage chunks.
    expect(result.stats.chunks).toBe(5 + 4);
  });

  // Review of 2026-09-29, finding 2: llama-server writes a `:` ping comment every 30 s by default (--sse-ping-interval);
  // a ping is not a chunk, so it must keep neither bound from firing.
  it('does not count a ping comment as a chunk: pings every 20 s leave the queue bound to fire, naming it', async () => {
    vi.useFakeTimers();
    const server = fed();
    const pending = complete(server.fake);
    for (let t = 20_000; t < CHAT_QUEUE_BOUND_MS; t += 20_000) {
      await vi.advanceTimersByTimeAsync(20_000);
      server.stream.send(':\n\n');
    }
    await vi.advanceTimersByTimeAsync(CHAT_QUEUE_BOUND_MS - 40_000);
    const result = await pending;
    expect(result.response).toEqual({
      ok: false,
      reason: 'timeout',
      detail: 'no chunk within the queue bound of 55000 ms after the request was sent',
    });
    expect(result.stats.chunks).toBe(0);
    expect(server.signal.aborted).toBe(true);
  });

  it('does not count a ping comment as a chunk after the first: the idle bound still fires', async () => {
    vi.useFakeTimers();
    const server = fed();
    const pending = call(server.fake);
    server.stream.send(sseText(llamaChunks({ content: ['He'] }).slice(0, 2)));
    await vi.advanceTimersByTimeAsync(CHAT_IDLE_BOUND_MS - 1);
    server.stream.send(':\n\n');
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      detail: 'no chunk within the idle bound of 22000 ms after the previous chunk',
    });
  });

  // Review of 2026-09-29, finding 3: the sink is the daemon's own; its throw is a harness defect, not a cut body.
  it('re-throws a throwing onDelta as DeltaSinkFailed with its cause, never as a model failure, and ends the request', async () => {
    const server = fed();
    const bug = new TypeError('publish failed: a harness bug');
    const pending = call(server.fake, {
      onDelta: () => {
        throw bug;
      },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(server.fake.requests).toHaveLength(1);
    });
    server.stream.send(sseText(llamaChunks({ content: ['He'] }).slice(0, 2)));
    const error = (await pending) as Error;
    expect(error).toBeInstanceOf(DeltaSinkFailed);
    expect([error.message, error.cause]).toEqual([
      'publishing a model delta failed: publish failed: a harness bug',
      bug,
    ]);
    expect(server.signal.aborted).toBe(true);
  });

  it("aborts the model server's request when the agent's request closes before the answer, and ends timeout", async () => {
    const server = fed();
    const closed = new AbortController();
    const pending = call(server.fake, { requestClosed: closed.signal });
    await vi.waitFor(() => {
      expect(server.fake.requests).toHaveLength(1);
    });
    server.stream.send(sseText(llamaChunks({ content: ['He'] }).slice(0, 2)));
    closed.abort();
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      detail: "the agent's request closed before the answer",
    });
    expect(server.signal.aborted).toBe(true);
  });

  it("ends an exited agent's call as unavailable, abandoned, even when its request closed too (amendment 2)", async () => {
    const server = fed();
    const closed = new AbortController();
    const abandon = new AbortController();
    const pending = call(server.fake, { requestClosed: closed.signal, abandon: abandon.signal });
    await vi.waitFor(() => {
      expect(server.fake.requests).toHaveLength(1);
    });
    closed.abort();
    abandon.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unavailable', detail: ABANDONED });
    expect(server.signal.aborted).toBe(true);
    expect(ABANDONED).toBe('abandoned: the calling agent exited');
  });

  it("ends the model server's request when it gives up on a stream the server is still sending, so the slot is freed", async () => {
    const server = fed();
    const pending = call(server.fake);
    await vi.waitFor(() => {
      expect(server.fake.requests).toHaveLength(1);
    });
    server.stream.send(`${sseText(llamaChunks({ content: ['He'] }).slice(0, 2))}data: {not json\n\n`);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'bad_response', detail: 'not JSON: {not json' });
    expect(server.signal.aborted).toBe(true);
  });

  it('ends a call abandoned before the model server answered its headers', async () => {
    const abandon = new AbortController();
    let signal: AbortSignal | undefined;
    const hanging = new FakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = present(present(init, 'fetch init').signal, 'abort signal');
          signal.addEventListener(
            'abort',
            () => {
              reject(present(signal, 'signal').reason as Error);
            },
            { once: true },
          );
        }),
    );
    const pending = call(hanging, { abandon: abandon.signal });
    abandon.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unavailable', detail: ABANDONED });
    expect(present(signal, 'signal').aborted).toBe(true);
  });
});

/** A 200 whose body the server cuts off after its first bytes: reading it fails as a cut connection does. */
const cutOff = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":[{"embe'));
        controller.error(new TypeError('terminated'));
      },
    }),
    { status: 200 },
  );

describe('an embedding body the model server cuts off', () => {
  it('is unavailable, as data', async () => {
    const response = await embeddings({
      fetch: new FakeFetch(cutOff).fetch,
      endpoint: ENDPOINT,
      entry: {
        kind: 'embedding',
        id: 'emb',
        embed: { dimensions: 3, queryTemplate: '{text}' },
      } as unknown as EmbeddingModelEntry,
      request: { texts: ['a'], purpose: 'document' },
      timeoutMs: 1_000,
    });
    expect(response).toEqual({ ok: false, reason: 'unavailable', detail: 'the response body was cut off: terminated' });
  });

  it('is a timeout, as data, when the bound passes while the body is read', async () => {
    const stalled = new FakeFetch((_url, init) => {
      const signal = present(present(init, 'fetch init').signal, 'abort signal');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
          signal.addEventListener(
            'abort',
            () => {
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    const response = await embeddings({
      fetch: stalled.fetch,
      endpoint: ENDPOINT,
      entry: {
        kind: 'embedding',
        id: 'emb',
        embed: { dimensions: 3, queryTemplate: '{text}' },
      } as unknown as EmbeddingModelEntry,
      request: { texts: ['a'], purpose: 'document' },
      timeoutMs: 50,
    });
    expect(response).toEqual({ ok: false, reason: 'timeout', detail: 'no complete response within 50 ms' });
  });
});

describe("storeIdlePrompts: the server stores its idle slots' prompts (D44, prompt-prefix amendment 2)", () => {
  const OPEN_SIGNAL = new AbortController().signal;
  const store = (f: FakeFetch, abandon = OPEN_SIGNAL) =>
    storeIdlePrompts({ fetch: f.fetch, endpoint: ENDPOINT, abandon });
  /** A server answering /tokenize with `tokens` and /completion with `completion`. */
  const server = (tokens: () => Response, completion: () => Response = () => json(200, { content: ' x' })) =>
    new FakeFetch((url) => (url.endsWith('/tokenize') ? tokens() : completion()));

  it('tokenizes the text with no special tokens, then completes those token ids, one token out, with the key and a bound', async () => {
    const f = server(() => json(200, { tokens: [13] }));
    expect(await store(f)).toEqual({ ok: true });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${'k'.repeat(64)}` };
    expect(f.requests.map((r) => [r.url, r.init?.method, r.init?.headers])).toEqual([
      ['http://127.0.0.1:5555/tokenize', 'POST', headers],
      ['http://127.0.0.1:5555/completion', 'POST', headers],
    ]);
    for (const r of f.requests) expect(r.init?.signal).toBeInstanceOf(AbortSignal);
    // A token array, whose first element is a number: llama.cpp adds no BOS, so the prompt shares no first token with a chat prompt.
    expect(f.bodies()).toEqual([{ content: '.' }, { prompt: [13], n_predict: 1 }]);
    expect(PROMPT_STORE_TEXT).toBe('.');
  });

  it.each([
    [
      '/tokenize answering non-2xx',
      () => server(() => new Response('loading', { status: 503 })),
      { ok: false, reason: 'upstream_error', detail: '/tokenize: HTTP 503: loading' },
      1,
    ],
    [
      '/tokenize answering no tokens',
      () => server(() => json(200, { tokens: [] })),
      {
        ok: false,
        reason: 'bad_response',
        detail: '/tokenize: tokens is not a non-empty list of token ids: {"tokens":[]}',
      },
      1,
    ],
    [
      '/tokenize answering text',
      () => server(() => new Response('nope', { status: 200 })),
      { ok: false, reason: 'bad_response', detail: '/tokenize: not JSON: nope' },
      1,
    ],
    [
      '/completion answering non-2xx',
      () =>
        server(
          () => json(200, { tokens: [13] }),
          () => new Response('busy', { status: 503 }),
        ),
      { ok: false, reason: 'upstream_error', detail: '/completion: HTTP 503: busy' },
      2,
    ],
    [
      'a refused connection',
      () =>
        new FakeFetch(() => {
          throw new TypeError('connect ECONNREFUSED');
        }),
      { ok: false, reason: 'unavailable', detail: '/tokenize: connect ECONNREFUSED' },
      1,
    ],
    [
      'the bound passing',
      () =>
        new FakeFetch(() => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }),
      { ok: false, reason: 'timeout', detail: `/tokenize: no response within ${String(CHAT_QUEUE_BOUND_MS)} ms` },
      1,
    ],
  ] as const)('returns %s as data, and sends nothing after it', async (_, make, expected, requests) => {
    const f = make();
    expect(await store(f)).toEqual(expected);
    expect(f.requests).toHaveLength(requests);
  });

  it('ends at once, as abandoned, when the daemon begins to stop while it waits', async () => {
    const abandon = new AbortController();
    const hanging = new FakeFetch((url, init) =>
      url.endsWith('/tokenize')
        ? json(200, { tokens: [13] })
        : new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            }),
          ),
    );
    const pending = store(hanging, abandon.signal);
    while (hanging.requests.length < 2) await new Promise((resolve) => setImmediate(resolve));
    abandon.abort();
    expect(await pending).toEqual({ ok: false, reason: 'unavailable', detail: STORE_ABANDONED });
    expect(hanging.requests.map((r) => r.url)).toEqual([
      'http://127.0.0.1:5555/tokenize',
      'http://127.0.0.1:5555/completion',
    ]);
  });
});

describe('embeddings', () => {
  const ENTRY = {
    kind: 'embedding',
    id: 'emb',
    embed: { dimensions: 3, queryTemplate: 'Instruct: find\nQuery:{text}' },
  } as unknown as EmbeddingModelEntry;
  const call = (f: FakeFetch, purpose: 'query' | 'document' = 'query', texts = ['a', 'bb']) =>
    embeddings({ fetch: f.fetch, endpoint: ENDPOINT, entry: ENTRY, request: { texts, purpose }, timeoutMs: 1_000 });

  it("writes queries with the model's template, sends documents as they are, and orders vectors by index", async () => {
    const f = new FakeFetch(() =>
      json(200, {
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ],
      }),
    );
    expect(await call(f)).toEqual({
      ok: true,
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
      ],
    });
    const firstRequest = present(f.requests[0], 'f.requests[0]');
    expect(firstRequest.url).toBe('http://127.0.0.1:5555/v1/embeddings');
    expect(firstRequest.init?.signal).toBeInstanceOf(AbortSignal);
    expect(firstRequest.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${'k'.repeat(64)}`,
    });
    expect(f.bodies()).toEqual([
      { model: 'qwen3-0.6b-q8_0', input: ['Instruct: find\nQuery:a', 'Instruct: find\nQuery:bb'] },
    ]);
    const d = new FakeFetch(() => json(200, { data: [{ index: 0, embedding: [1, 0, 0] }] }));
    await call(d, 'document', ['as is']);
    expect(d.bodies()).toEqual([{ model: 'qwen3-0.6b-q8_0', input: ['as is'] }]);
  });

  it.each([
    ['a non-2xx answer', () => new Response('boom', { status: 500 }), 'upstream_error', 'HTTP 500: boom'],
    ['a body that is not JSON', () => new Response('nope', { status: 200 }), 'bad_response', 'not JSON: nope'],
    [
      'the wrong number of vectors',
      () => json(200, { data: [{ index: 0, embedding: [1, 0, 0] }] }),
      'bad_response',
      'expected 2 embeddings',
    ],
    [
      'a vector of the wrong size',
      () =>
        json(200, {
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [1, 0, 0] },
          ],
        }),
      'bad_response',
      'data[0].embedding has 2 dimensions, expected 3',
    ],
    [
      'a vector that is not numbers',
      () =>
        json(200, {
          data: [
            { index: 0, embedding: ['x', 0, 0] },
            { index: 1, embedding: [1, 0, 0] },
          ],
        }),
      'bad_response',
      'not a list of numbers',
    ],
    [
      'two vectors for one index',
      () =>
        json(200, {
          data: [
            { index: 0, embedding: [1, 0, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        }),
      'bad_response',
      'index 0 is out of place',
    ],
  ])('returns %s as data', async (_, respond, reason, detail) => {
    const response = await call(new FakeFetch(respond));
    expect(response).toEqual({ ok: false, reason, detail: expect.stringContaining(detail) as string });
  });

  it('returns an unreachable server as data', async () => {
    const f = new FakeFetch(() => {
      throw new TypeError('connect ECONNREFUSED');
    });
    expect(await call(f)).toEqual({ ok: false, reason: 'unavailable', detail: 'connect ECONNREFUSED' });
  });

  it('ends an embedding whose agent exited at once, as unavailable, abandoned', async () => {
    const abandon = new AbortController();
    const hanging = new FakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = present(present(init, 'fetch init').signal, 'abort signal');
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason as Error);
            },
            { once: true },
          );
        }),
    );
    const pending = embeddings({
      fetch: hanging.fetch,
      endpoint: ENDPOINT,
      entry: ENTRY,
      request: { texts: ['a'], purpose: 'document' },
      timeoutMs: 60_000,
      abandon: abandon.signal,
    });
    abandon.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unavailable', detail: ABANDONED });
  });

  it('keeps an embedding to its bound across a garbage collection while it waits (the composite signal holds its timeout)', async () => {
    const hanging = new FakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = present(present(init, 'fetch init').signal, 'abort signal');
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason as Error);
            },
            { once: true },
          );
        }),
    );
    const pending = embeddings({
      fetch: hanging.fetch,
      endpoint: ENDPOINT,
      entry: ENTRY,
      request: { texts: ['a'], purpose: 'document' },
      timeoutMs: 30,
      abandon: new AbortController().signal,
    });
    await collectGarbage();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout', detail: 'no response within 30 ms' });
  }, 3_000);

  it('leaves an embedding whose agent is still there to its own bound', async () => {
    const hanging = new FakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = present(present(init, 'fetch init').signal, 'abort signal');
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason as Error);
            },
            { once: true },
          );
        }),
    );
    await expect(
      embeddings({
        fetch: hanging.fetch,
        endpoint: ENDPOINT,
        entry: ENTRY,
        request: { texts: ['a'], purpose: 'document' },
        timeoutMs: 30,
        abandon: new AbortController().signal,
      }),
    ).resolves.toEqual({ ok: false, reason: 'timeout', detail: 'no response within 30 ms' });
  });
});
