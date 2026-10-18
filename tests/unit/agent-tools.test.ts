// The SDK's tool layer (docs/plans/agent-tools.md R1, R3–R5, R8, R10, R15):
// the selection an agent offers, decide()'s tool rounds with their bounds and
// the turn budget, tool failures and crashes in the agent's log, per-tool
// timeouts, and the start checks. A scripted fake model drives every turn.

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentTools,
  AgentToolsInvalid,
  COMMON_TOOL_DEFINITIONS,
  HarnessClient,
  LIST_AGENTS_TOOL,
  PASS_TOOL,
  REPLY_TOOL,
  ToolCallInvalid,
  ToolCrashed,
  TurnBudget,
  WorkspaceUnavailable,
  act,
  blackboardTools,
  decide,
  fileTools,
  imageTool,
  serveAgent,
  type AgentProcess,
  type BlackboardClient,
  type ChannelClient,
  type ImageToolHandler,
  type ModelClient,
  type ToolImplementation,
} from '../../src/agent-sdk/index.js';
import { AgentTelemetry, TRACE_LIMITS } from '../../src/agent-sdk/telemetry.js';
import {
  type AgentInfo,
  type BlackboardEntry,
  type ChatRequest,
  type ChatResponse,
  type ConversationMessage,
  type Delivery,
  type PostRequest,
  type ToolCall,
} from '../../src/shared/protocol.js';
import { present } from '../../src/shared/assert-present.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { COMMON_TOOL_NAMES, parseImageManifest, type ImageManifest } from '../../src/shared/tools.js';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { MAX_TOKENS, NAME, handleHelloWorld, helloWorldTurn } from '../../images/hello-world/src/agent.js';
import { HELLO_WORLD_PERSONA } from '../helpers/recipes.js';
import { FakeFetch, RecordingAgentLog, json } from '../helpers/fakes.js';

const HANDLE = 'hewo-1';
const NO_SIGNALS: AgentProcess = { onTerminate: () => () => undefined, exit: () => undefined };

const message = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  channel: 'main',
  conversation: 'm1',
  user: 'user-1',
  from: 'user',
  to: null,
  kind: 'input',
  text: 'Please say: Hello World.',
  at: '2026-09-27T00:00:00.000Z',
  ...over,
});
const delivery = (id: string, m: ConversationMessage): Delivery => ({
  deliveryId: id,
  message: m,
  traceparent: `00-${traceIdFor(m.conversation)}-00000000000000aa-01`,
});

/** A response with these calls, in order. */
const calls = (...made: [name: string, args: Record<string, unknown>][]): ChatResponse => ({
  ok: true,
  text: '',
  toolCalls: made.map(([name, args], i) => ({ id: `c${String(i)}`, name, arguments: args })),
});
const reply = (text: string): ChatResponse => calls(['reply', { text }]);

/** A model answering from a script, in order; it records every request. */
class ScriptedModel implements ModelClient {
  readonly requests: ChatRequest[] = [];
  constructor(private readonly script: (request: ChatRequest, index: number) => ChatResponse) {}
  chat(request: ChatRequest): Promise<ChatResponse> {
    // A snapshot: decide() goes on appending to the same messages array, as a request on the wire could not see.
    this.requests.push({ ...request, messages: [...request.messages] });
    return Promise.resolve(this.script(request, this.requests.length - 1));
  }
}

const scripted = (...responses: ChatResponse[]) =>
  new ScriptedModel((_r, i) => present(responses[Math.min(i, responses.length - 1)], 'the scripted response'));

/** The tool messages of a request, in order. */
const toolResults = (request: ChatRequest) =>
  request.messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'asha-tools-ws-'));
}

/** The six common tools on a temporary workspace, no channel space, and a blackboard that is never reached. */
async function commonTools(log = new RecordingAgentLog(), blackboard: BlackboardClient = NO_BLACKBOARD) {
  const dir = await workspace();
  const available = new Map<string, ToolImplementation>([
    ...fileTools({ workspace: dir, channelSpace: null, handle: HANDLE, log }),
    ...blackboardTools(blackboard),
  ]);
  return { dir, log, tools: new AgentTools({ selected: [...COMMON_TOOL_NAMES], available, log }) };
}

const NO_BLACKBOARD: BlackboardClient = {
  requestTimeoutMs: 1_000,
  blackboardRead: () => Promise.reject(new Error('no blackboard in this test')),
  blackboardPost: () => Promise.reject(new Error('no blackboard in this test')),
};

const baseRequest = (tools: AgentTools): ChatRequest => ({
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
  ],
  maxTokens: 64,
  tools: [REPLY_TOOL, LIST_AGENTS_TOOL, PASS_TOOL, ...tools.definitions],
  requireToolCall: true,
});

const decideWith = (model: ModelClient, tools: AgentTools) =>
  decide({
    model,
    request: baseRequest(tools),
    message: message(),
    roster: [],
    maxRounds: 3,
    maxCorrections: 2,
    tools,
  });

/** What act() posts with: posts recorded; no call is expected (a consult or an answer fails the test). */
const actContext = (posts: PostRequest[]) => ({
  post: (r: PostRequest) => Promise.resolve((posts.push(r), message())),
  consult: (): Promise<never> => Promise.reject(new Error('no consult in this test')),
  answerCall: (): Promise<never> => Promise.reject(new Error('no call answer in this test')),
  log: new RecordingAgentLog(),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the tool loop in decide() (R3, A3)', () => {
  it('(a) runs write_file, then read_file, with the parsed arguments, each result in the next request, then returns the reply', async () => {
    const { dir, tools } = await commonTools();
    const model = scripted(
      calls(['write_file', { path: 'note.txt', content: 'hello there' }]),
      calls(['read_file', { path: 'note.txt' }]),
      reply('It says: hello there'),
    );

    const final = await decideWith(model, tools);

    expect(final).toEqual([{ id: 'c0', name: 'reply', arguments: { text: 'It says: hello there' } }]);
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('hello there');
    expect(model.requests).toHaveLength(3);
    expect(toolResults(present(model.requests[1], 'request 1'))).toEqual([
      JSON.stringify({ path: '/workspace/note.txt', size: 11 }),
    ]);
    expect(toolResults(present(model.requests[2], 'request 2'))).toEqual([
      JSON.stringify({ path: '/workspace/note.txt', size: 11 }),
      JSON.stringify({ content: 'hello there', size: 11 }),
    ]);
    // The assistant turn carrying each call precedes its result, matched by id.
    expect(
      present(model.requests[2], 'request 2')
        .messages.slice(2)
        .map((m) => m.role),
    ).toEqual(['assistant', 'tool', 'assistant', 'tool']);
  });

  it('(b) runs write_file from a response that also replies, answers the reply "not run", posts nothing, and counts one round', async () => {
    const { dir, tools } = await commonTools();
    const write = calls(['write_file', { path: 'a.txt', content: 'x' }], ['reply', { text: 'too early' }]);
    const again = calls(['list_files', { path: '.' }]);
    // The mixed response, then five more rounds, then the reply: six rounds in all, which the bound allows.
    const model = scripted(write, again, again, again, again, again, reply('done'));
    const posts: PostRequest[] = [];

    const final = await decideWith(model, tools);
    await act(final, [], delivery('d1', message()), actContext(posts));

    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('x');
    expect(toolResults(present(model.requests[1], 'request 1'))).toEqual([
      JSON.stringify({ path: '/workspace/a.txt', size: 1 }),
      'not run: call it again once you have the results',
    ]);
    expect(posts).toEqual([
      { conversation: 'm1', kind: 'status', text: 'ok' },
      { conversation: 'm1', kind: 'output', text: 'done' },
    ]);
    // One more tool round after the same start passes the bound: the mixed response was one round.
    const over = scripted(write, again, again, again, again, again, again, reply('never'));
    await expect(decideWith(over, (await commonTools()).tools)).rejects.toThrow('still calling tools after 6 rounds');
  });

  it('(c) answers a tool not offered unknown_tool, and a wrong-typed argument invalid_arguments without running the handler, and goes on to the reply', async () => {
    const log = new RecordingAgentLog();
    const handler = vi.fn<ImageToolHandler>(() => Promise.resolve({ ok: true, value: 'ran' }));
    const manifest = parseImageManifest(
      {
        tools: [
          {
            name: 'count_words',
            description: 'Counts words.',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            class: 'files',
            timeoutMs: 50,
          },
        ],
      },
      'image.json',
    );
    const tools = new AgentTools({
      selected: ['count_words'],
      available: new Map([['count_words', imageTool(present(manifest.tools[0], 'the count_words tool'), handler)]]),
      log,
    });
    const model = scripted(calls(['shell', { cmd: 'ls' }]), calls(['count_words', { path: 7 }]), reply('ok'));

    const final = await decideWith(model, tools);

    expect(final.map((c) => c.name)).toEqual(['reply']);
    expect(toolResults(present(model.requests[2], 'request 2'))).toEqual([
      '{"error":"unknown_tool"}',
      '{"error":"invalid_arguments"}',
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(log.entries).toEqual([
      { level: 'warn', event: 'tool.failed', fields: { tool: 'shell', reason: 'unknown_tool' } },
      { level: 'warn', event: 'tool.failed', fields: { tool: 'count_words', reason: 'invalid_arguments' } },
    ]);
  });

  it.each([
    ['a missing required key', {}],
    ['an unknown key', { path: 'a', extra: true }],
    ['a wrong type', { path: ['a'] }],
    ['a value below its minimum', { path: 'a', offset: -1 }],
  ])('refuses read_file with %s as invalid_arguments', async (_, args) => {
    const { tools } = await commonTools();
    expect(await tools.run({ id: 'x', name: 'read_file', arguments: args }, new TurnBudget())).toBe(
      '{"error":"invalid_arguments"}',
    );
  });

  it('(d) fails the turn with ToolCallInvalid after exactly 6 tool rounds when the model never stops', async () => {
    const { tools } = await commonTools();
    const model = scripted(calls(['list_files', { path: '.' }]));

    const error = await decideWith(model, tools).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolCallInvalid);
    expect((error as Error).message).toBe(
      "the model's tool call cannot be acted on: still calling tools after 6 rounds",
    );
    // Six rounds ran (six results went back); the seventh response is the one refused.
    expect(model.requests).toHaveLength(7);
    expect(toolResults(present(model.requests[6], 'request 6'))).toHaveLength(6);
  });

  it('(e) answers the third 8 KiB read of a turn turn_budget_exceeded, with none of its content', async () => {
    const { dir, log, tools } = await commonTools();
    await writeFile(join(dir, 'big.txt'), 'a'.repeat(3 * 8192));
    const model = scripted(
      calls(['read_file', { path: 'big.txt' }]),
      calls(['read_file', { path: 'big.txt', offset: 8192 }]),
      calls(['read_file', { path: 'big.txt', offset: 16384 }]),
      reply('read'),
    );

    await decideWith(model, tools);

    const results = toolResults(present(model.requests[3], 'request 3'));
    // Each result's JSON — what enters the context — is at most 8 KiB, and nearly that; the third would pass 16 KiB.
    for (const r of results.slice(0, 2)) {
      expect(Buffer.byteLength(r)).toBeGreaterThan(8_100);
      expect(Buffer.byteLength(r)).toBeLessThanOrEqual(8192);
    }
    expect(results[2]).toBe('{"error":"turn_budget_exceeded"}');
    expect(log.entries.filter((e) => e.event === 'tool.failed')).toEqual([
      { level: 'warn', event: 'tool.failed', fields: { tool: 'read_file', reason: 'turn_budget_exceeded' } },
    ]);
  });

  it('keeps list_agents rounds apart from tool rounds: a lookup does not use up a tool round', async () => {
    const { tools } = await commonTools();
    const tool = calls(['list_files', { path: '.' }]);
    const model = scripted(calls(['list_agents', {}]), tool, tool, tool, tool, tool, tool, reply('fine'));
    await expect(
      decide({
        model,
        request: baseRequest(tools),
        message: message(),
        roster: [],
        maxRounds: 3,
        maxCorrections: 2,
        tools,
      }),
    ).resolves.toHaveLength(1);
  });
});

describe('tool failures, crashes and bounds (R4, R5, A4)', () => {
  it('returns {error: "not_found"} to the model, logs one tool.failed warn line with no argument or content, and the turn goes on', async () => {
    const { log, tools } = await commonTools();
    const model = scripted(calls(['read_file', { path: 'secret-name.txt' }]), reply('no such file'));

    const final = await decideWith(model, tools);

    expect(final.map((c) => c.name)).toEqual(['reply']);
    expect(toolResults(present(model.requests[1], 'request 1'))).toEqual(['{"error":"not_found"}']);
    expect(log.entries).toEqual([
      { level: 'warn', event: 'tool.failed', fields: { tool: 'read_file', reason: 'not_found' } },
    ]);
    expect(JSON.stringify(log.entries)).not.toContain('secret-name');
  });

  it('logs a handler that throws as one tool.crashed error line and fails the turn', async () => {
    const log = new RecordingAgentLog();
    const boom = new Error('disk on fire');
    const manifest = parseImageManifest(
      {
        tools: [
          {
            name: 'explode',
            description: 'x',
            parameters: { type: 'object', properties: {} },
            class: 'files',
            timeoutMs: 50,
          },
        ],
      },
      'image.json',
    );
    const tools = new AgentTools({
      selected: ['explode'],
      available: new Map([
        ['explode', imageTool(present(manifest.tools[0], 'the manifest tool'), async () => Promise.reject(boom))],
      ]),
      log,
    });

    const error = await decideWith(scripted(calls(['explode', {}]), reply('never')), tools).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolCrashed);
    expect((error as ToolCrashed).cause).toBe(boom);
    expect(log.entries).toEqual([{ level: 'error', event: 'tool.crashed', fields: { tool: 'explode', error: boom } }]);
  });

  it('fails the turn when an image tool returns more than 8 KiB', async () => {
    const log = new RecordingAgentLog();
    const manifest = parseImageManifest(
      {
        tools: [
          {
            name: 'big',
            description: 'x',
            parameters: { type: 'object', properties: {} },
            class: 'files',
            timeoutMs: 50,
          },
        ],
      },
      'image.json',
    );
    const tools = new AgentTools({
      selected: ['big'],
      available: new Map([
        [
          'big',
          imageTool(present(manifest.tools[0], 'the manifest tool'), () =>
            Promise.resolve({ ok: true, value: 'x'.repeat(8192) }),
          ),
        ],
      ]),
      log,
    });
    await expect(tools.run({ id: 'c', name: 'big', arguments: {} }, new TurnBudget())).rejects.toThrow(
      'tool big crashed: its result is 8194 bytes of JSON, over the 8192 one result may carry',
    );
  });

  it('times out a file tool at 10 s, a blackboard call at the request timeout, and an image tool at its manifest bound, on a fake clock', async () => {
    vi.useFakeTimers();
    const log = new RecordingAgentLog();
    const dir = await workspace();
    const never = new Promise<void>(() => undefined);
    const files = fileTools({ workspace: dir, channelSpace: null, handle: HANDLE, log, beforeOpen: () => never });
    await writeFile(join(dir, 'a.txt'), 'x');
    const stalled = new FakeFetch(() => new Promise<Response>(() => undefined));
    const client = new HarnessClient({
      environment: { harnessUrl: 'http://host.test:1', agentToken: 't' },
      chatTimeoutMs: 1_000,
      requestTimeoutMs: 3_000,
      filesRequestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 1_000,
      fetch: stalled.fetch,
      telemetry: new AgentTelemetry({
        exporter: new InMemorySpanExporter(),
        writeLine: () => undefined,
        maxQueueSize: TRACE_LIMITS.maxQueueSize,
        maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
      }),
    });
    const manifest = parseImageManifest(
      {
        tools: [
          {
            name: 'slow',
            description: 'x',
            parameters: { type: 'object', properties: {} },
            class: 'files',
            timeoutMs: 50,
          },
        ],
      },
      'image.json',
    );
    const available = new Map<string, ToolImplementation>([
      ...files,
      ...blackboardTools(client),
      ['slow', imageTool(present(manifest.tools[0], 'the manifest tool'), () => new Promise(() => undefined))],
    ]);
    const tools = new AgentTools({ selected: ['read_file', 'blackboard_read', 'slow'], available, log });

    for (const [name, args, bound] of [
      ['slow', {}, 50],
      ['blackboard_read', {}, 3_000],
      ['read_file', { path: 'a.txt' }, 10_000],
    ] as const) {
      let result: string | undefined;
      void tools.run({ id: 'c', name, arguments: args }, new TurnBudget()).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(bound - 1);
      expect(result, `${name} before ${String(bound)} ms`).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result, `${name} at ${String(bound)} ms`).toBe('{"error":"timeout"}');
    }
    expect(stalled.requests.map((r) => r.url)).toEqual(['http://host.test:1/agent/v1/blackboard']);
    expect(log.entries.map((e) => [e.event, e.fields['tool'], e.fields['reason']])).toEqual([
      ['tool.failed', 'slow', 'timeout'],
      ['tool.failed', 'blackboard_read', 'timeout'],
      ['tool.failed', 'read_file', 'timeout'],
    ]);
  });
});

describe('the turn budget across the blackboard and files (R3, R10, A16)', () => {
  it("answers a third result after nearly 8 KiB of blackboard and 8 KiB of file turn_budget_exceeded; the budget counts each result's JSON", async () => {
    const entry = (id: number, text: string): BlackboardEntry => ({
      id,
      author: 'hewo-2',
      ts: '2026-09-27T00:00:00.000Z',
      text,
      session: 1,
    });
    // Two entries whose read is exactly 8 KiB of JSON.
    const framing = Buffer.byteLength(JSON.stringify({ entries: [entry(1, ''), entry(2, '')], more: false }));
    const half = (8192 - framing) / 2;
    const read = {
      entries: [entry(1, 'b'.repeat(Math.floor(half))), entry(2, 'c'.repeat(Math.ceil(half)))],
      more: false,
    };
    expect(Buffer.byteLength(JSON.stringify(read))).toBe(8192);
    const board: BlackboardClient = {
      requestTimeoutMs: 1_000,
      blackboardRead: () => Promise.resolve({ ok: true, value: read }),
      blackboardPost: () => Promise.reject(new Error('unused')),
    };
    const { dir, tools } = await commonTools(new RecordingAgentLog(), board);
    await writeFile(join(dir, 'f.txt'), 'f'.repeat(8192));
    await writeFile(join(dir, 'g.txt'), 'g');
    const budget = new TurnBudget();

    const first = await tools.run({ id: '1', name: 'blackboard_read', arguments: {} }, budget);
    const second = await tools.run({ id: '2', name: 'read_file', arguments: { path: 'f.txt' } }, budget);
    const third = await tools.run({ id: '3', name: 'read_file', arguments: { path: 'g.txt' } }, budget);

    expect(first).toBe(JSON.stringify(read));
    expect(Buffer.byteLength(second)).toBeLessThanOrEqual(8192);
    expect(third).toBe('{"error":"turn_budget_exceeded"}');
    // What the budget holds is exactly the two results' JSON as sent.
    expect(budget.used).toBe(Buffer.byteLength(first) + Buffer.byteLength(second));
    expect(budget.used).toBeGreaterThan(16 * 1024 - 100);
  });
});

describe('an agent offers exactly its selected tools (R1, R8, A1)', () => {
  const twoTools: ImageManifest = parseImageManifest(
    {
      tools: [
        {
          name: 'count_words',
          description: 'Counts words.',
          parameters: { type: 'object', properties: {} },
          class: 'files',
          timeoutMs: 50,
        },
        {
          name: 'summarise',
          description: 'Summarises.',
          parameters: { type: 'object', properties: {} },
          class: 'files',
          timeoutMs: 50,
        },
      ],
    },
    'image.json',
  );
  const handlers: Record<string, ImageToolHandler> = {
    count_words: () => Promise.resolve({ ok: true, value: 3 }),
    summarise: () => Promise.resolve({ ok: true, value: 's' }),
  };

  /** A channel client whose welcome selects `selected`; it records what it was asked. */
  class Channel implements ChannelClient, ModelClient, BlackboardClient {
    readonly requestTimeoutMs = 1_000;
    readonly chats: ChatRequest[] = [];
    readonly opened: string[] = [];
    readonly posts: PostRequest[] = [];
    constructor(
      private readonly selected: string[],
      private readonly responses: ChatResponse[],
      private readonly others: AgentInfo[] = [],
    ) {}
    open(name: string) {
      this.opened.push(name);
      async function* deliveries() {
        await Promise.resolve();
        yield delivery('d1', message());
      }
      return Promise.resolve({
        handle: HANDLE,
        channel: 'main',
        tools: this.selected,
        prompt: HELLO_WORLD_PERSONA.role,
        guidance: [],
        modules: [],
        deliveries: deliveries(),
      });
    }
    moduleCall(): Promise<never> {
      return Promise.reject(new Error('moduleCall not expected: no module is granted'));
    }
    post(r: PostRequest) {
      this.posts.push(r);
      return Promise.resolve(message());
    }
    async ack() {}
    postFiles(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    consult(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    answerCall(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    roster() {
      return Promise.resolve(this.others);
    }
    chat(r: ChatRequest) {
      this.chats.push(r);
      return Promise.resolve(
        present(this.responses[Math.min(this.chats.length - 1, this.responses.length - 1)], 'the scripted response'),
      );
    }
    blackboardRead(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    blackboardPost(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
  }
  const telemetry = () =>
    new AgentTelemetry({
      exporter: new InMemorySpanExporter(),
      writeLine: () => undefined,
      maxQueueSize: TRACE_LIMITS.maxQueueSize,
      maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
    });
  const serve = async (c: Channel, manifest: ImageManifest, h: Record<string, ImageToolHandler>, dir?: string) =>
    serveAgent({
      client: c,
      telemetry: telemetry(),
      name: NAME,
      handler: handleHelloWorld,
      process: NO_SIGNALS,
      imageTools: { manifest, handlers: h },
      workspace: dir ?? (await workspace()),
      channelSpace: null,
      drainMs: 1_000,
      log: new RecordingAgentLog(),
    });

  it('offers the channel tools, then exactly the two the welcome selects, on every request — never the unselected one', async () => {
    const c = new Channel(['count_words', 'read_file'], [calls(['count_words', {}]), reply('3 words')]);

    await serve(c, twoTools, handlers);

    expect(c.chats).toHaveLength(2);
    for (const request of c.chats) {
      expect(request.tools).toEqual([
        REPLY_TOOL,
        LIST_AGENTS_TOOL,
        PASS_TOOL,
        twoToolsDefinition('count_words'),
        COMMON_TOOL_DEFINITIONS.read_file,
      ]);
    }
    expect(toolResults(present(c.chats[1], 'the second chat request'))).toEqual(['3']);
    expect(c.posts.map((p) => p.text)).toEqual(['Hi', 'ok', '3 words']);
  });

  function twoToolsDefinition(name: string) {
    const declared = present(
      twoTools.tools.find((t) => t.name === name),
      `the ${name} tool`,
    );
    return { type: 'function', function: { name, description: declared.description, parameters: declared.parameters } };
  }

  it("offers both existing recipes' selection — the six common tools — after the channel tools: hello-world's request grows from 5 tools to 11 (R8, A7; consult added by agent-calls R1)", async () => {
    const c = new Channel(
      [...COMMON_TOOL_NAMES],
      [reply('Hello World.')],
      [{ handle: 'hewo-2', recipe: 'hello-world', description: 'd' }],
    );
    await serve(c, { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null }, {});
    expect(
      present(present(c.chats[0], 'the first chat request').tools, 'its tools').map((t) => t.function.name),
    ).toEqual(['reply', 'send_message', 'consult', 'list_agents', 'pass', ...COMMON_TOOL_NAMES]);
    expect(present(c.chats[0], 'the first chat request').tools).toHaveLength(11);
    // The routing eval offers exactly what the recipe selects.
    expect(HELLO_WORLD_PERSONA.tools.map((t) => t.function.name)).toEqual(
      (
        JSON.parse(await readFile(join(import.meta.dirname, '..', '..', 'recipes', 'hello-world.json'), 'utf8')) as {
          tools: unknown;
        }
      ).tools,
    );
    expect(
      present(helloWorldTurn(message(), HANDLE, [], HELLO_WORLD_PERSONA).tools, 'the turn request tools').slice(3),
    ).toEqual(HELLO_WORLD_PERSONA.tools);
    expect(helloWorldTurn(message(), HANDLE, [], HELLO_WORLD_PERSONA).maxTokens).toBe(MAX_TOKENS);
  });

  it("with 11 selected tools, on a channel with another agent, the first model request carries 16 tools, the gateway's bound: the five channel tools, then the 11 (R2, A2)", async () => {
    const five = parseImageManifest(
      {
        tools: ['t1', 't2', 't3', 't4', 't5'].map((name) => ({
          name,
          description: name,
          parameters: { type: 'object', properties: {} },
          class: 'files',
          timeoutMs: 50,
        })),
      },
      'image.json',
    );
    const fiveHandlers = Object.fromEntries(
      five.tools.map((t): [string, ImageToolHandler] => [t.name, () => Promise.resolve({ ok: true, value: t.name })]),
    );
    const c = new Channel(
      [...COMMON_TOOL_NAMES, 't1', 't2', 't3', 't4', 't5'],
      [reply('ok')],
      [{ handle: 'hewo-2', recipe: 'hello-world', description: 'd' }],
    );
    await serve(c, five, fiveHandlers);
    expect(
      present(present(c.chats[0], 'the first chat request').tools, 'its tools').map((t) => t.function.name),
    ).toEqual([
      'reply',
      'send_message',
      'consult',
      'list_agents',
      'pass',
      ...COMMON_TOOL_NAMES,
      't1',
      't2',
      't3',
      't4',
      't5',
    ]);
    expect(present(c.chats[0], 'the first chat request').tools).toHaveLength(16);
  });

  it('fails the start, before joining, when the image registers a handler it does not declare, or declares one with no handler', async () => {
    for (const [h, detail] of [
      [
        { ...handlers, extra: present(handlers['summarise'], 'the summarise handler') },
        'a handler is registered for "extra", which image.json does not declare',
      ],
      [
        { count_words: present(handlers['count_words'], 'the count_words handler') },
        '"summarise" is declared in image.json but has no handler',
      ],
    ] as const) {
      const c = new Channel([], [reply('x')]);
      const error = await serve(c, twoTools, h).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AgentToolsInvalid);
      expect((error as Error).message).toContain(detail);
      expect(c.opened).toEqual([]);
    }
  });

  it('fails the start when the welcome selects a tool the agent does not implement', async () => {
    const c = new Channel(['teleport'], [reply('x')]);
    const error = await serve(c, twoTools, handlers).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentToolsInvalid);
    expect((error as Error).message).toBe(
      'the agent\'s tools are invalid: the welcome selects "teleport", which this agent does not implement',
    );
    expect(c.posts).toEqual([]);
  });

  it('fails the start naming /workspace when it is missing or not writable, before joining (R15, A14)', async () => {
    const missing = join(await workspace(), 'absent');
    const c = new Channel([], [reply('x')]);
    const error = await serve(
      c,
      { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
      {},
      missing,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceUnavailable);
    expect((error as Error).message).toBe(
      `the workspace ${missing} does not exist; every agent image creates it, owned by the user the agent runs as`,
    );
    expect(c.opened).toEqual([]);

    const file = join(await workspace(), 'a-file');
    await writeFile(file, '');
    await expect(
      serve(
        new Channel([], [reply('x')]),
        { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
        {},
        file,
      ),
    ).rejects.toThrow(`the workspace ${file} is not a directory`);

    const readOnly = await workspace();
    await mkdir(join(readOnly, 'ro'), { mode: 0o500 });
    await expect(
      serve(
        new Channel([], [reply('x')]),
        { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
        {},
        join(readOnly, 'ro'),
      ),
    ).rejects.toThrow(`the workspace ${join(readOnly, 'ro')} is not writable`);
  });
});

describe('act() after the tool rounds', () => {
  it('refuses an own-tool call, which decide() never returns, before posting anything', async () => {
    const posts: PostRequest[] = [];
    const call: ToolCall = { id: 'c', name: 'read_file', arguments: { path: 'a' } };
    await expect(act([call], [], delivery('d1', message()), actContext(posts))).rejects.toThrow(
      'act() was given read_file, which decide() runs in its tool rounds',
    );
    expect(posts).toEqual([]);
  });
});

describe('the blackboard client (R10)', () => {
  const client = (f: FakeFetch) =>
    new HarnessClient({
      environment: { harnessUrl: 'http://host.test:1', agentToken: 'tok' },
      chatTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      filesRequestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 1_000,
      fetch: f.fetch,
      telemetry: new AgentTelemetry({
        exporter: new InMemorySpanExporter(),
        writeLine: () => undefined,
        maxQueueSize: TRACE_LIMITS.maxQueueSize,
        maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
      }),
    });
  const signal = new AbortController().signal;

  it('reads with since and posts with the token, and no traceparent (no span)', async () => {
    const entry = { id: 3, author: 'hewo-1', ts: 't', text: 'hi' };
    const f = new FakeFetch((_url, init) =>
      init?.method === 'POST' ? json(200, { entry }) : json(200, { entries: [entry], more: false }),
    );
    const c = client(f);
    expect(await c.blackboardRead(2, signal)).toEqual({ ok: true, value: { entries: [entry], more: false } });
    expect(await c.blackboardRead(undefined, signal)).toEqual({ ok: true, value: { entries: [entry], more: false } });
    expect(await c.blackboardPost('hi', signal)).toEqual({ ok: true, value: entry });
    expect(f.requests.map((r) => r.url)).toEqual([
      'http://host.test:1/agent/v1/blackboard?since=2',
      'http://host.test:1/agent/v1/blackboard',
      'http://host.test:1/agent/v1/blackboard',
    ]);
    expect(f.requests.map((r) => (r.init?.headers as Record<string, string>)['authorization'])).toEqual([
      'Bearer tok',
      'Bearer tok',
      'Bearer tok',
    ]);
    expect(f.requests.map((r) => (r.init?.headers as Record<string, string>)['traceparent'])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(f.bodies()).toEqual([undefined, undefined, { text: 'hi' }]);
  });

  it.each([
    [413, 'entry_too_large'],
    [409, 'blackboard_full'],
    [400, 'invalid_arguments'],
  ] as const)('turns exactly the refusal %d %s into data; any other refusal throws', async (status, reason) => {
    const c = client(new FakeFetch(() => json(status, { error: reason })));
    expect(await c.blackboardPost('x', signal)).toEqual({ ok: false, reason });
  });

  it.each([
    [500, { error: 'internal error; see the daemon log' }],
    [400, { error: 'entry_too_large' }],
    [401, { error: 'missing or unknown agent token' }],
  ])('throws HarnessRequestError on %d %j', async (status, body) => {
    const c = client(new FakeFetch(() => json(status, body)));
    await expect(c.blackboardPost('x', signal)).rejects.toThrow(
      `harness rejected /agent/v1/blackboard: HTTP ${String(status)}`,
    );
  });
});
