import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpanStatusCode, diag } from '@opentelemetry/api';
import { ExportResultCode, globalErrorHandler, loggingErrorHandler, setGlobalErrorHandler } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  ASK_USER,
  ASK_USER_TOOL,
  AgentTelemetry,
  AgentTools,
  ModelCallFailed,
  PostRefused,
  REPLY_WITH_FILES,
  REPLY_WITH_FILES_TOOL,
  SIGTERM_EXIT_CODE,
  TRACE_LIMITS,
  ToolCallInvalid,
  approvedFrame,
  callInstructions,
  callTools,
  channelInstructions,
  channelTools,
  nestedCallInstructions,
  nestedCallTools,
  serveAgent,
  withGuidance,
  type AgentContext,
  type AgentProcess,
  type DeliveryHandler,
} from '../../../src/agent-sdk/index.js';
import { RecordingAgentLog } from '../../helpers/fakes.js';
import {
  type AgentInfo,
  type CallAnswerRequest,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ConsultRequest,
  type ConversationMessage,
  type Delivery,
  type GuidanceDocument,
  type PostRequest,
  Routes,
  type ToolDefinition,
} from '../../../src/shared/protocol.js';
import { traceIdFor } from '../../../src/shared/trace-id.js';
import { NAME, memoryAgent, responseOf, scopeOf, withMemory } from '../../../images/memory/src/agent.js';
import { MEMORY_PROMPT } from '../../helpers/recipes.js';
import {
  AgentMemory,
  DEFAULT_POLICY,
  EmbeddingFailed,
  MemoryCache,
  MemoryStore,
  scopeKey,
  type Recall,
  type Scope,
  type Turn,
} from '../../../images/memory/src/memory/index.js';
import { roleProblems } from '../../helpers/roles.js';
import { ExtractingModel, FakeEmbedder, wordVector } from './fakes.js';
import { byCodeUnit } from '../../../src/shared/order.js';
import { present } from '../../../src/shared/assert-present.js';

/** When the agent answers: what its clock, and the memory's, say. */
const NOW = new Date('2026-09-26T12:00:00.000Z');
/** When the messages were sent: a minute before the answer, so a turn stamped with the message's time is told apart. */
const SENT = '2026-09-26T11:59:00.000Z';
/** A user's message. Its conversation is not its id, so a turn filed under the message's id is told apart too. */
const message = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  channel: 'main',
  conversation: 'c1',
  user: 'alice',
  from: 'alice',
  to: null,
  kind: 'input',
  text: 'hi',
  at: SENT,
  ...over,
});

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

/** A new temporary directory, removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** What one user's memory folder holds on disk: each file by name, parsed. */
function onDisk(root: string, scope: Scope): Record<string, unknown> {
  const dir = join(root, scopeKey(scope));
  return Object.fromEntries(
    readdirSync(dir)
      .sort(byCodeUnit)
      .map((name) => [name, JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown]),
  );
}

/** What one user's memory folder holds at this moment, as onDisk gives it; null while the folder does not exist yet. */
function folderNow(root: string, scope: Scope): Record<string, unknown> | null {
  return existsSync(join(root, scopeKey(scope))) ? onDisk(root, scope) : null;
}

/** A searchable memory as the fake embedder stores it, written at NOW. */
const stored = (id: string, text: string) => ({ id, ts: NOW.toISOString(), text, embedding: wordVector(text) });
/** A turn the agent remembered, answered at NOW (the agent's clock, never the message's `at`). */
const turn = (id: string, conversation: string, from: string, input: string, response: string): Turn => ({
  id,
  ts: NOW.toISOString(),
  conversation,
  from,
  input,
  response,
});
/** A tier's document as the store writes it, last changed at NOW. */
const doc = (tier: string, body: Record<string, unknown>) => ({
  schemaVersion: 1,
  tier,
  updatedAt: NOW.toISOString(),
  ...body,
});

/**
 * alice's memory folder once memo-1 has remembered its reply "Got it." to "My favourite colour is teal" (message m1, in
 * c1) and the fact extracted from it, every save settled: the turn in the session, its episode, and the fact — id2, as
 * the turn took id1 from the counter the test's turn and memory ids share. No procedure was extracted, so there is no
 * procedural.json.
 */
const TEAL_LEARNED = {
  'episodic.json': doc('episodic', {
    records: [stored('turn1', 'The user wrote: My favourite colour is teal\nI answered: Got it.')],
  }),
  'semantic.json': doc('semantic', { records: [stored('id2', 'The user favourite colour is teal.')] }),
  'session.json': doc('session', { turns: [turn('turn1', 'c1', 'alice', 'My favourite colour is teal', 'Got it.')] }),
};

/** The `# Memory` section once the teal fact is known: assemble's heading and instruction line, then the fact. */
const TEAL_MEMORY =
  '# Memory\n\nWhat you remember about the user you are talking to. Use it when it helps; never mention these notes.\n\n## What you know about this user\n- [2026-09-26 12:00] The user favourite colour is teal.';

/** memo-1's identity line when it shares the chat with other agents, and in every call turn (prompt-prefix R5). */
const IDENTITY = 'You are memo-1, an agent in a chat shared by the user and other agents, with the role given above.';

/** A delivery as the daemon sends it; the handler never reads its traceparent (serveAgent does). */
function delivery(deliveryId: string, m: ConversationMessage): Delivery {
  return { deliveryId, message: m, traceparent: `00-${traceIdFor(m.conversation)}-00000000000000aa-01` };
}

/** A channel turn's request for memo-1 alone on its channel: the channel layer's instructions and tools, untouched. */
const alone = (...rest: ChatMessage[]): ChatRequest => ({
  messages: [{ role: 'system', content: channelInstructions('memo-1', [], MEMORY_PROMPT) }, ...rest],
  maxTokens: 1_024,
  tools: channelTools('memo-1', [], []),
  requireToolCall: true,
});

/**
 * Each extraction a remember asked the model for, in order: its tool and the exchange it was given — the turn the
 * agent remembered. The rest of an extraction request (its instructions, the known items) is extract.ts's, checked in
 * memory.test.ts.
 */
function extractions(model: ExtractingModel): [string, string][] {
  return model.requests.flatMap((r): [string, string][] => {
    const tool = r.tools?.[0]?.function.name;
    if (tool !== 'save_facts' && tool !== 'save_procedures') return [];
    const content = present(r.messages.at(-1), 'last message').content;
    return [[tool, content.slice(content.indexOf('The exchange:'))]];
  });
}

/**
 * The two extractions one remembered turn asks for — its facts, then its procedures — about that turn's exchange, framed
 * by who wrote the turn: the user, or an agent that passed on the user's task (record memory-delegated-task-replay).
 */
function extracted(input: string, response: string, writer = 'The user'): [string, string][] {
  const exchange = `The exchange:\n${writer} wrote: ${input}\nThe assistant answered: ${response}`;
  return [
    ['save_facts', exchange],
    ['save_procedures', exchange],
  ];
}

/** The texts the embedder was given for one purpose, call by call. */
const embedded = (embedder: FakeEmbedder, purpose: 'query' | 'document'): string[][] =>
  embedder.calls.filter((c) => c.purpose === purpose).map((c) => c.texts);

/** The value thrown by `act`, to compare whole; a failure when nothing is thrown. */
function thrown(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw; nothing was thrown');
}

/** A span as the exporter is given it: what the harness's traces route receives (R12: no attributes, events or links). */
function exported(span: ReadableSpan) {
  return {
    name: span.name,
    traceId: span.spanContext().traceId,
    parent: span.parentSpanContext?.spanId,
    status: span.status,
    attributes: span.attributes,
    events: span.events,
    links: span.links,
  };
}

/**
 * The span exporter double, in place of the OTLP exporter that sends spans to the harness: every call recorded in
 * order, and each export answered at once. (InMemorySpanExporter answers on a timer, which fake timers would hold, and
 * which would let an ack that did not wait race the memory's file writes.)
 */
class RecordingSpanExporter implements SpanExporter {
  readonly calls: unknown[] = [];
  export(spans: ReadableSpan[], done: Parameters<SpanExporter['export']>[1]): void {
    this.calls.push({ export: spans.map(exported) });
    done({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    this.calls.push('shutdown');
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    this.calls.push('forceFlush');
    return Promise.resolve();
  }
}

/** OpenTelemetry's process-wide hooks back as they are before any AgentTelemetry: no diag logger, the logging error handler. */
function restoreOtelGlobals(): void {
  diag.disable();
  setGlobalErrorHandler(loggingErrorHandler());
}

/**
 * The agent's telemetry for one test. Constructing it installs OpenTelemetry's global error handler and diag logger,
 * which are process-wide (src/agent-sdk/telemetry.ts); they are put back when the test finishes, pass or fail.
 */
function agentTelemetry(exporter: SpanExporter, lines: string[]): AgentTelemetry {
  onTestFinished(restoreOtelGlobals);
  return new AgentTelemetry({
    exporter,
    writeLine: (line) => {
      lines.push(line);
    },
    maxQueueSize: TRACE_LIMITS.maxQueueSize,
    maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
  });
}

/** The process-wide hooks put back, then shown to be: a later diag message or export error no longer reaches `lines`. */
function expectOtelGlobalsRestored(lines: readonly string[]): void {
  const before = [...lines];
  restoreOtelGlobals();
  diag.error('after the test');
  globalErrorHandler(new Error('after the test'));
  expect(lines).toEqual(before);
}

describe('the memory agent graph, node by node', () => {
  it('identify: the scope is the channel and the harness-set user; a message without a user is refused', () => {
    expect(scopeOf(message({ channel: 'lab', user: 'user-3' }))).toEqual({ channel: 'lab', user: 'user-3' });
    // scopeOf throws a plain Error, never a PostRefused (which serveAgent logs and acks instead of failing). That the
    // handler refuses such a message with this error, before anything else, is shown through memoryAgent below.
    expect(thrown(() => scopeOf(message({ user: '' })))).toStrictEqual(
      new Error('message m1 carries no user, so it has no memory scope'),
    );
    // A delivery is parsed from JSON unchecked, so a message may lack the field altogether: refused the same way.
    const { user, ...noUser } = message();
    expect([user, 'user' in noUser]).toEqual(['alice', false]);
    expect(thrown(() => scopeOf(noUser as ConversationMessage))).toStrictEqual(
      new Error('message m1 carries no user, so it has no memory scope'),
    );
  });

  it('assemble: the session window as chat turns before the incoming message, each framed by its writer; the system prompt untouched (prompt-prefix R7)', () => {
    const tool: ToolDefinition = {
      type: 'function',
      function: { name: 'reply', description: 'Answer.', parameters: { type: 'object', properties: {} } },
    };
    const base: ChatRequest = {
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'You are memo-1.\n\n# Memory\nstuff\n\nThe user wrote:\nnow' },
      ],
      maxTokens: 9,
      tools: [tool],
      requireToolCall: true,
    };
    const history = [
      { id: 't', ts: NOW.toISOString(), conversation: 'c', from: 'alice', input: 'before', response: 'said' },
      { id: 'u', ts: NOW.toISOString(), conversation: 'd', from: 'hewo-1', input: 'Look up tea', response: 'found' },
    ];
    // The whole request: only the turns are added; every other field is the request's own. A turn the user wrote reads
    // as theirs; one another agent passed on for the user reads as that agent's, as its episode does (the owner,
    // 2026-10-12, record memory-delegated-task-replay, option (a)).
    expect(withMemory(base, history, 'alice')).toEqual({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'The user wrote:\nbefore' },
        { role: 'assistant', content: 'said' },
        { role: 'user', content: 'Agent hewo-1, for the user, wrote:\nLook up tea' },
        { role: 'assistant', content: 'found' },
        { role: 'user', content: 'You are memo-1.\n\n# Memory\nstuff\n\nThe user wrote:\nnow' },
      ],
      maxTokens: 9,
      tools: [
        {
          type: 'function',
          function: { name: 'reply', description: 'Answer.', parameters: { type: 'object', properties: {} } },
        },
      ],
      requireToolCall: true,
    });
    expect(withMemory(base, [], 'alice')).toEqual({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'You are memo-1.\n\n# Memory\nstuff\n\nThe user wrote:\nnow' },
      ],
      maxTokens: 9,
      tools: [
        {
          type: 'function',
          function: { name: 'reply', description: 'Answer.', parameters: { type: 'object', properties: {} } },
        },
      ],
      requireToolCall: true,
    });
    // A plain Error, the agent's own defect: a request that does not start with its system prompt, or has no messages.
    expect(thrown(() => withMemory({ ...base, messages: base.messages.slice(1) }, history, 'alice'))).toStrictEqual(
      new Error('a channel turn starts with its system prompt'),
    );
    expect(thrown(() => withMemory({ ...base, messages: [] }, history, 'alice'))).toStrictEqual(
      new Error('a channel turn starts with its system prompt'),
    );
  });

  // What the handler then does with it — remember a turn whose response is not null, never a pass — is shown through
  // memoryAgent below: a reply, a consult, and a files reply with a hand-off (send_message) remembered with their exact
  // turns; a pass not remembered (the shared prefix).
  it('remember: what a reply, a hand-off and a consult are remembered as; a pass is null', () => {
    expect(responseOf([{ id: 'a', name: 'reply', arguments: { text: 'Teal!' } }])).toBe('Teal!');
    expect(responseOf([{ id: 'a', name: 'send_message', arguments: { to: 'hewo-2', text: 'Say: hi' } }])).toBe(
      '(asked hewo-2: Say: hi)',
    );
    expect(responseOf([{ id: 'a', name: 'pass', arguments: { reason: 'no' } }])).toBeNull();
    // A consult is remembered as what was asked of whom, one line per request (agent-calls R20).
    expect(
      responseOf([
        {
          id: 'a',
          name: 'consult',
          arguments: {
            requests: [
              { to: 'hewo-2', text: 'Say: violet' },
              { to: 'hewo-3', text: 'Say: green' },
            ],
          },
        },
      ]),
    ).toBe('(consulted hewo-2: Say: violet)\n(consulted hewo-3: Say: green)');
  });

  // The owner's answer of 2026-10-11, record memory-remember-files-and-questions, option (a) "Remember both": a turn
  // answered with reply_with_files is remembered with its text and the files' names — each the last part of its path,
  // the name the file reaches the user under — and one answered with ask_user with the question asked, in the form a
  // hand-off to an agent takes.
  it("remember: a reply with files is remembered with its text and the files' names; a question to the user, with the question asked", () => {
    const files = {
      id: 'f',
      name: 'reply_with_files',
      arguments: { text: 'Here it is.', files: ['/channel/report.txt', '/channel/upload-0123456789abcdef/data.csv'] },
    };
    expect(responseOf([files])).toBe('Here it is.\n(gave the user files: report.txt, data.csv)');
    // A pass beside a files reply adds nothing: the turn took the work.
    expect(responseOf([files, { id: 'p', name: 'pass', arguments: { reason: 'no' } }])).toBe(
      'Here it is.\n(gave the user files: report.txt, data.csv)',
    );
    expect(responseOf([{ id: 'q', name: 'ask_user', arguments: { text: 'Which month do you mean?' } }])).toBe(
      '(asked the user: Which month do you mean?)',
    );
  });
});

describe('the memory agent, end to end with fakes', () => {
  /** The model's channel answer: a reply "Got it." unless the test says otherwise. */
  type Respond = (request: ChatRequest) => ChatResponse;
  const gotIt: Respond = () => ({
    ok: true,
    text: '',
    toolCalls: [{ id: 'r', name: 'reply', arguments: { text: 'Got it.' } }],
  });
  async function agent(
    options: {
      readonly roster?: AgentInfo[];
      readonly respond?: Respond;
      readonly prompt?: string;
      readonly tools?: AgentTools;
      readonly guidance?: readonly GuidanceDocument[];
      readonly nestedCalls?: boolean;
      readonly replyWithFiles?: AgentContext['replyWithFiles'];
    } = {},
  ) {
    const roster = options.roster ?? [];
    const respond = options.respond ?? gotIt;
    const root = await tempDir('asha-memo-');
    const failures: unknown[] = [];
    const channelRequests: ChatRequest[] = [];
    const model = new ExtractingModel(
      (x) => (x.includes('teal') ? ['The user favourite colour is teal.'] : []),
      () => [],
      (request) => {
        // A copy of the messages as sent: decide() goes on adding a turn's later rounds to the same list.
        channelRequests.push({ ...request, messages: [...request.messages] });
        return respond(request);
      },
    );
    const embedder = new FakeEmbedder();
    // Memory ids (id1, …) and the agent's turn ids (turn1, …) count apart, so each is known from the test's own steps.
    let memoryIds = 0;
    let turnIds = 0;
    const cache = new MemoryCache({
      store: new MemoryStore({
        root,
        onDropped: (file, count) => failures.push({ dropped: file, count }),
        onMalformed: (file, error) => failures.push({ malformed: file, error }),
      }),
      clock: () => NOW,
      onSaveFailed: (_s, _t, e) => failures.push(e),
      maxDocs: 100,
    });
    const memory = new AgentMemory({
      cache,
      embedder,
      model,
      clock: () => NOW,
      policy: DEFAULT_POLICY,
      newId: () => `id${String(++memoryIds)}`,
      onWriteFailed: (_s, e) => failures.push(e),
    });
    // Called through: the real remember runs; each call is recorded.
    const remember = vi.spyOn(memory, 'remember');
    // The agent's stdout, where it prints each pass (agent.ts): captured, never the test run's, and put back by afterEach.
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const log = new RecordingAgentLog();
    const toolsLog = new RecordingAgentLog();
    const posts: PostRequest[] = [];
    const consults: ConsultRequest[] = [];
    const answers: CallAnswerRequest[] = [];
    const backgrounds: [string, Promise<unknown>][] = [];
    const readRoster = vi.fn(() => Promise.resolve(roster));
    const context: AgentContext = {
      handle: 'memo-1',
      channel: 'main',
      // The role the daemon hands over: recipes/memory.json's prompt unless the test gives another recipe's.
      prompt: options.prompt ?? MEMORY_PROMPT,
      guidance: options.guidance ?? [],
      model,
      post: (r) => {
        posts.push(r);
        return Promise.resolve(message({ kind: r.kind, text: r.text }));
      },
      // Only a test whose recipe selects reply_with_files gives one; any other test fails if it is called.
      replyWithFiles:
        options.replyWithFiles ??
        (() => Promise.reject(new Error('not used: this recipe does not select reply_with_files'))),
      launchAgent: () => Promise.reject(new Error('not used: the memory recipe has no launch grant')),
      nestedCalls: options.nestedCalls ?? false,
      consult: (r) => {
        consults.push(r);
        return Promise.resolve({
          ok: true,
          value: { call: 'k1', messages: r.requests.map((_, i) => `q${String(i)}`) },
        });
      },
      answerCall: (r) => {
        answers.push(r);
        return Promise.resolve({ ok: true, value: { message: message({ id: 'a1' }) } });
      },
      log,
      roster: readRoster,
      tools: options.tools ?? new AgentTools({ selected: [], available: new Map(), log: toolsLog }),
      background: (name, task) => {
        backgrounds.push([name, task]);
      },
    };
    return {
      handler: memoryAgent({ memory, clock: () => NOW, newId: () => `turn${String(++turnIds)}` }),
      context,
      posts,
      consults,
      answers,
      channelRequests,
      failures,
      backgrounds,
      memory,
      cache,
      remember,
      stdout,
      log,
      toolsLog,
      readRoster,
      model,
      embedder,
      root,
    };
  }

  const ALICE: Scope = { channel: 'main', user: 'alice' };
  const BOB: Scope = { channel: 'main', user: 'bob' };

  /** A full-text document the recipe gives the agent (collaborating-agents R2). */
  const GUIDE: readonly GuidanceDocument[] = [{ path: 'guide.md', text: 'Name every colour by its hex code too.' }];
  const LOOKUP_PARAMETERS = {
    type: 'object',
    properties: { name: { type: 'string', description: 'The colour' } },
    required: ['name'],
  } as const;
  const LOOKUP: ToolDefinition = {
    type: 'function',
    function: { name: 'lookup_colour', description: 'Look up a colour by name.', parameters: LOOKUP_PARAMETERS },
  };
  /** The recipe's one selected tool: each run recorded with its arguments and whether its bound had passed. */
  function lookupTools() {
    const ran: [Readonly<Record<string, unknown>>, boolean][] = [];
    const toolsLog = new RecordingAgentLog();
    const tools = new AgentTools({
      selected: ['lookup_colour'],
      available: new Map([
        [
          'lookup_colour',
          {
            definition: LOOKUP,
            parameters: LOOKUP_PARAMETERS,
            timeoutMs: 1_000,
            run: (args, signal) => {
              ran.push([args, signal.aborted]);
              return Promise.resolve({ ok: true, value: { colour: 'teal', hex: '#008080' } });
            },
          },
        ],
      ]),
      log: toolsLog,
    });
    return { tools, ran, toolsLog };
  }

  it("given asha's result of an approved call, runs none of its context's tools: the consequential tool is answered unknown_tool (extension-modules R12 (d), A12)", async () => {
    const ran: string[] = [];
    const toolsLog = new RecordingAgentLog();
    const tools = new AgentTools({
      selected: ['ledger__transfer'],
      available: new Map([
        [
          'ledger__transfer',
          {
            definition: {
              type: 'function',
              function: {
                name: 'ledger__transfer',
                description: 'Move money.',
                parameters: { type: 'object', properties: {} },
              },
            },
            parameters: { type: 'object', properties: {} },
            timeoutMs: 1_000,
            run: () => {
              ran.push('ledger__transfer');
              return Promise.resolve({ ok: true, value: { tx: 'again' } });
            },
          },
        ],
      ]),
      log: toolsLog,
    });
    let calls = 0;
    const a = await agent({
      tools,
      respond: () =>
        calls++ === 0
          ? { ok: true, text: '', toolCalls: [{ id: 't1', name: 'ledger__transfer', arguments: {} }] }
          : { ok: true, text: '', toolCalls: [{ id: 'r', name: 'reply', arguments: { text: 'Done.' } }] },
    });
    const approved = {
      approval: '0123456789abcdef',
      module: 'ledger',
      tool: 'transfer',
      arguments: '{}',
      outcome: { ok: true as const, result: { tx: 'tx-1' } },
    };
    const RESULT = 'asha made the approved call ledger/transfer (approval 0123456789abcdef): ok';
    await a.handler(
      delivery('d1', message({ from: 'asha', kind: 'internal', to: 'memo-1', text: RESULT, approved })),
      a.context,
    );
    expect(ran).toEqual([]);
    expect(toolsLog.entries).toEqual([]);
    // Two channel calls, each whole: the one that asked for the tool — offered the channel tools alone, the message
    // framed from its `approved` field — and the one after its unknown_tool answer.
    const framed: ChatMessage = { role: 'user', content: approvedFrame(approved) };
    expect(a.channelRequests).toEqual([
      alone(framed),
      alone(
        framed,
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'ledger__transfer', arguments: {} }] },
        { role: 'tool', toolCallId: 't1', content: '{"error":"unknown_tool"}' },
      ),
    ]);
    expect(a.posts).toEqual([
      { conversation: 'c1', kind: 'status', text: 'ok' },
      { conversation: 'c1', kind: 'output', text: 'Done.' },
    ]);
    expect(a.consults).toEqual([]);
    expect(a.answers).toEqual([]);
    expect(a.log.entries).toEqual([]);
    // Neither call was a pass, so the agent printed nothing.
    expect(a.stdout.mock.calls).toEqual([]);
    expect(a.readRoster.mock.calls).toEqual([[]]);
    expect(a.remember.mock.calls).toEqual([[ALICE, turn('turn1', 'c1', 'asha', RESULT, 'Done.')]]);
    expect(a.backgrounds.map(([name]) => name)).toEqual(['memory.remember']);
    await Promise.all(a.backgrounds.map(([, task]) => task));
    expect(a.failures).toEqual([]);
    // The remember's model and embedder calls are about that turn: asha's message, for the user, and the answer —
    // shown to extraction as asha's words, as its episode reads (record memory-delegated-task-replay).
    expect(extractions(a.model)).toEqual(extracted(RESULT, 'Done.', 'Agent asha, for the user,'));
    expect(embedded(a.embedder, 'query')).toEqual([[RESULT]]);
    expect(embedded(a.embedder, 'document')).toEqual([
      [`Agent asha, for the user, wrote: ${RESULT}\nI answered: Done.`],
    ]);
    expect(a.embedder.calls).toHaveLength(2);
  });

  it("answers, then remembers: a later message from the same user carries the fact and the turn; another user's does not", async () => {
    const {
      handler,
      context,
      posts,
      consults,
      answers,
      channelRequests,
      failures,
      backgrounds,
      remember,
      stdout,
      log,
      toolsLog,
      readRoster,
      model,
      embedder,
      root,
    } = await agent();
    await handler(
      delivery('d1', message({ id: 'm1', conversation: 'c1', text: 'My favourite colour is teal' })),
      context,
    );
    expect(posts).toEqual([
      { conversation: 'c1', kind: 'status', text: 'ok' },
      { conversation: 'c1', kind: 'output', text: 'Got it.' },
    ]);

    // Not waiting for d1's write: the next recall for the same user does (read-your-writes).
    await handler(
      delivery('d2', message({ id: 'm2', conversation: 'c2', text: 'What is my favourite colour?' })),
      context,
    );
    expect(posts.slice(2)).toEqual([
      { conversation: 'c2', kind: 'status', text: 'ok' },
      { conversation: 'c2', kind: 'output', text: 'Got it.' },
    ]);

    await handler(
      delivery(
        'd3',
        message({ id: 'm3', conversation: 'c3', user: 'bob', from: 'bob', text: 'What is my favourite colour?' }),
      ),
      context,
    );
    expect(posts.slice(4)).toEqual([
      { conversation: 'c3', kind: 'status', text: 'ok' },
      { conversation: 'c3', kind: 'output', text: 'Got it.' },
    ]);

    // memo-1 is alone on its channel, so its handle is in line 1 of its instructions and its message has no identity
    // line (prompt-prefix R1, R5 as amended 2026-09-29). The memory is the agent's own: never in the system prompt every
    // agent of the recipe shares (prompt-prefix R7), but at the start of the incoming message — the # Memory section,
    // a blank line, the message — after the session window replayed as chat turns. Bob's request carries none of alice's.
    expect(channelRequests).toEqual([
      alone({ role: 'user', content: 'The user wrote:\nMy favourite colour is teal' }),
      alone(
        { role: 'user', content: 'The user wrote:\nMy favourite colour is teal' },
        { role: 'assistant', content: 'Got it.' },
        { role: 'user', content: `${TEAL_MEMORY}\n\nThe user wrote:\nWhat is my favourite colour?` },
      ),
      alone({ role: 'user', content: 'The user wrote:\nWhat is my favourite colour?' }),
    ]);
    expect(
      present(
        present(channelRequests[1], 'channelRequests[1]').messages[0],
        'channelRequests[1].messages[0]',
      ).content.split('\n')[0],
    ).toBe('You are memo-1, an agent in a chat shared by the user and no other agents.');
    expect(consults).toEqual([]);
    expect(answers).toEqual([]);
    expect(log.entries).toEqual([]);
    expect(toolsLog.entries).toEqual([]);
    // No turn passed, so the agent printed nothing.
    expect(stdout.mock.calls).toEqual([]);
    // The roster is read once per message.
    expect(readRoster.mock.calls).toEqual([[], [], []]);

    // Each answered turn is remembered under its own user, as the user's (from is who wrote the message), filed under
    // its conversation and stamped with the time the agent answered.
    expect(remember.mock.calls).toEqual([
      [ALICE, turn('turn1', 'c1', 'alice', 'My favourite colour is teal', 'Got it.')],
      [ALICE, turn('turn2', 'c2', 'alice', 'What is my favourite colour?', 'Got it.')],
      [BOB, turn('turn3', 'c3', 'bob', 'What is my favourite colour?', 'Got it.')],
    ]);
    // Each answered turn's write is registered as background work, which an agent told to stop waits for. Once the
    // tasks resolve, every tier they wrote is on disk, as it is once settled (the saves finished) resolves.
    expect(backgrounds.map(([name]) => name)).toEqual(['memory.remember', 'memory.remember', 'memory.remember']);
    await Promise.all(backgrounds.map(([, task]) => task));
    expect(failures).toEqual([]);
    // Each remembered turn is extracted once for facts and once for procedures; each message is embedded as the
    // recall's query, and each episode and new fact as a document.
    expect(extractions(model)).toEqual([
      ...extracted('My favourite colour is teal', 'Got it.'),
      ...extracted('What is my favourite colour?', 'Got it.'),
      ...extracted('What is my favourite colour?', 'Got it.'),
    ]);
    expect(embedded(embedder, 'query')).toEqual([
      ['My favourite colour is teal'],
      ['What is my favourite colour?'],
      ['What is my favourite colour?'],
    ]);
    expect(embedded(embedder, 'document')).toEqual([
      ['The user wrote: My favourite colour is teal\nI answered: Got it.'],
      ['The user favourite colour is teal.'],
      ['The user wrote: What is my favourite colour?\nI answered: Got it.'],
      ['The user wrote: What is my favourite colour?\nI answered: Got it.'],
    ]);
    expect(embedder.calls).toHaveLength(7);
    // Episodes in the agent's voice: a message the user wrote reads "The user wrote".
    expect(onDisk(root, ALICE)).toEqual({
      'episodic.json': doc('episodic', {
        records: [
          stored('turn1', 'The user wrote: My favourite colour is teal\nI answered: Got it.'),
          stored('turn2', 'The user wrote: What is my favourite colour?\nI answered: Got it.'),
        ],
      }),
      'semantic.json': doc('semantic', { records: [stored('id1', 'The user favourite colour is teal.')] }),
      'session.json': doc('session', {
        turns: [
          turn('turn1', 'c1', 'alice', 'My favourite colour is teal', 'Got it.'),
          turn('turn2', 'c2', 'alice', 'What is my favourite colour?', 'Got it.'),
        ],
      }),
    });
    expect(onDisk(root, BOB)).toEqual({
      'episodic.json': doc('episodic', {
        records: [stored('turn3', 'The user wrote: What is my favourite colour?\nI answered: Got it.')],
      }),
      'session.json': doc('session', {
        turns: [turn('turn3', 'c3', 'bob', 'What is my favourite colour?', 'Got it.')],
      }),
    });
  });

  it('never remembers a call question or a gather, recalls a gather by its context, and remembers the consulting turn (agent-calls R20)', async () => {
    // alice has told memo a fact before the call, so each turn's recall shows in its request: the memory opens a call
    // turn's and a gather's user message after the identity line, as it does a normal turn's (prompt-prefix R5;
    // docs/architecture/memory.md, recall). REQUEST and hewo-2's QUESTION share the fact's words "favourite" and
    // "colour", so a recall by either finds it; the gather's own text ("Answers to memo-1's call: 1 answered.") shares
    // none, so only a recall by the message the call was made for finds it for the gather (R20).
    const TOLD = 'My favourite colour is teal';
    const REQUEST = 'Ask hewo-2 for my favourite colour, and tell me yourself.';
    const QUESTION = 'What is her favourite colour?';
    const respond: Respond = (request) => {
      const incoming = present(request.messages.at(-1), 'last message').content;
      const reply = (text: string): ChatResponse => ({
        ok: true,
        text: '',
        toolCalls: [{ id: 'r', name: 'reply', arguments: { text } }],
      });
      // The framed message follows the agent's per-agent block (its identity line, and its memory when it has any).
      const framed = present(incoming.split('\n\n').at(-1), 'framed message');
      if (framed.startsWith('Agent hewo-2 asks you.')) return reply('I remember what users tell me.');
      if (framed.startsWith('You consulted 1 agent while working on this message from the user:'))
        return reply('hewo-2 says violet.');
      if (incoming.includes(REQUEST))
        return {
          ok: true,
          text: '',
          toolCalls: [{ id: 'k', name: 'consult', arguments: { requests: [{ to: 'hewo-2', text: 'Say: violet' }] } }],
        };
      return reply('Got it.');
    };
    const {
      handler,
      context,
      posts,
      consults,
      answers,
      backgrounds,
      channelRequests,
      memory,
      failures,
      remember,
      stdout,
      log,
      toolsLog,
      readRoster,
      model,
      embedder,
    } = await agent({
      roster: [{ handle: 'hewo-2', recipe: 'hello-world', description: 'Says whatever it is asked to say.' }],
      respond,
    });
    const recall = vi.spyOn(memory, 'recall');

    await handler(delivery('d0', message({ id: 'm0', conversation: 'c0', text: TOLD })), context);
    expect(posts).toEqual([
      { conversation: 'c0', kind: 'status', text: 'ok' },
      { conversation: 'c0', kind: 'output', text: 'Got it.' },
    ]);
    // The fact is saved before the call starts.
    await Promise.all(backgrounds.map(([, task]) => task));

    await handler(delivery('d1', message({ text: REQUEST })), context);
    // The consult is opened through the call route; the conversation hears only that memo-1 is working on it.
    expect(posts.slice(2)).toEqual([{ conversation: 'c1', kind: 'status', text: 'ok' }]);
    await handler(
      delivery(
        'd2',
        message({
          id: 'q',
          from: 'hewo-2',
          kind: 'internal',
          to: 'memo-1',
          text: QUESTION,
          call: { id: 'k9', role: 'question' },
        }),
      ),
      context,
    );
    // A call question is answered on the answer route alone: nothing more is posted.
    expect(posts).toHaveLength(3);
    const gather = message({
      id: 'g',
      from: 'asha',
      kind: 'internal',
      to: 'memo-1',
      text: "Answers to memo-1's call: 1 answered.",
      call: {
        id: 'k1',
        role: 'gather',
        context: { from: 'alice', text: REQUEST },
        requests: [{ to: 'hewo-2', text: 'Say: violet' }],
        answers: [{ from: 'hewo-2', outcome: 'answered', text: 'violet' }],
      },
    });
    await handler(delivery('d3', gather), context);
    // The gather's reply reaches the user.
    expect(posts.slice(3)).toEqual([
      { conversation: 'c1', kind: 'status', text: 'ok' },
      { conversation: 'c1', kind: 'output', text: 'hewo-2 says violet.' },
    ]);

    expect(consults).toEqual([{ delivery: 'd1', requests: [{ to: 'hewo-2', text: 'Say: violet' }] }]);
    expect(answers).toEqual([{ delivery: 'd2', text: 'I remember what users tell me.' }]);
    // A gather is recalled by the message the call was made for, not the harness's count; every recall is alice's.
    expect(recall.mock.calls).toEqual([
      [ALICE, TOLD],
      [ALICE, REQUEST],
      [ALICE, QUESTION],
      [ALICE, REQUEST],
    ]);
    // Only the user's turns are remembered: the call question's and the gather's words are not the user's.
    expect(remember.mock.calls).toEqual([
      [ALICE, turn('turn1', 'c0', 'alice', TOLD, 'Got it.')],
      [ALICE, turn('turn2', 'c1', 'alice', REQUEST, '(consulted hewo-2: Say: violet)')],
    ]);
    expect(backgrounds.map(([name]) => name)).toEqual(['memory.remember', 'memory.remember']);
    await Promise.all(backgrounds.map(([, task]) => task));

    await handler(delivery('d4', message({ id: 'm4', conversation: 'c4', text: 'Anything else?' })), context);
    expect(posts.slice(5)).toEqual([
      { conversation: 'c4', kind: 'status', text: 'ok' },
      { conversation: 'c4', kind: 'output', text: 'Got it.' },
    ]);
    // One channel call per message, each whole. Every turn after the first replays the remembered turns: the fact's,
    // then from the call on the consulting one. The call question is a call turn as agent-calls R4 gives it: its own
    // instructions, and reply (to hewo-2) and pass alone — never consult, since memo's context does not grant nested
    // calls (patterns-phase-3 R33). The gather is a normal turn, framed with the answers. The call question and the
    // gather each carry the fact their recall found, after the identity line; "Anything else?" recalls nothing.
    const others = ['hewo-2'];
    const channel: ChatMessage = { role: 'system', content: channelInstructions('memo-1', others, MEMORY_PROMPT) };
    const told: ChatMessage[] = [
      { role: 'user', content: `The user wrote:\n${TOLD}` },
      { role: 'assistant', content: 'Got it.' },
    ];
    const consulted: ChatMessage[] = [
      { role: 'user', content: `The user wrote:\n${REQUEST}` },
      { role: 'assistant', content: '(consulted hewo-2: Say: violet)' },
    ];
    const gatherFrame = [
      'You consulted 1 agent while working on this message from the user:',
      REQUEST,
      'You asked:',
      '- hewo-2: Say: violet',
      'Their answers:',
      '- hewo-2: violet',
    ].join('\n');
    expect(channelRequests).toEqual([
      {
        messages: [channel, { role: 'user', content: `${IDENTITY}\n\nThe user wrote:\n${TOLD}` }],
        maxTokens: 1_024,
        tools: channelTools('memo-1', others, []),
        requireToolCall: true,
      },
      {
        messages: [
          channel,
          ...told,
          { role: 'user', content: `${IDENTITY}\n\n${TEAL_MEMORY}\n\nThe user wrote:\n${REQUEST}` },
        ],
        maxTokens: 1_024,
        tools: channelTools('memo-1', others, []),
        requireToolCall: true,
      },
      {
        messages: [
          { role: 'system', content: callInstructions('hewo-2', MEMORY_PROMPT) },
          ...told,
          ...consulted,
          {
            role: 'user',
            content: `${IDENTITY}\n\n${TEAL_MEMORY}\n\nAgent hewo-2 asks you. Your answer goes back to hewo-2 only; the user does not see it:\n${QUESTION}`,
          },
        ],
        maxTokens: 1_024,
        tools: callTools('hewo-2', []),
        requireToolCall: true,
      },
      {
        messages: [
          channel,
          ...told,
          ...consulted,
          { role: 'user', content: `${IDENTITY}\n\n${TEAL_MEMORY}\n\n${gatherFrame}` },
        ],
        maxTokens: 1_024,
        tools: channelTools('memo-1', others, []),
        requireToolCall: true,
      },
      {
        messages: [
          channel,
          ...told,
          ...consulted,
          { role: 'user', content: `${IDENTITY}\n\nThe user wrote:\nAnything else?` },
        ],
        maxTokens: 1_024,
        tools: channelTools('memo-1', others, []),
        requireToolCall: true,
      },
    ]);
    expect(recall.mock.calls.slice(4)).toEqual([[ALICE, 'Anything else?']]);
    expect(remember.mock.calls.slice(2)).toEqual([[ALICE, turn('turn3', 'c4', 'alice', 'Anything else?', 'Got it.')]]);
    expect(backgrounds.map(([name]) => name)).toEqual(['memory.remember', 'memory.remember', 'memory.remember']);
    await Promise.all(backgrounds.map(([, task]) => task));
    expect(consults).toHaveLength(1);
    expect(answers).toHaveLength(1);
    expect(log.entries).toEqual([]);
    expect(toolsLog.entries).toEqual([]);
    // No turn passed — not the consult, the call question's reply or the gather's — so the agent printed nothing.
    expect(stdout.mock.calls).toEqual([]);
    expect(readRoster.mock.calls).toEqual([[], [], [], [], []]);
    expect(failures).toEqual([]);
    // Only the three remembered turns are extracted and embedded as documents, with the one fact the first yielded;
    // every recall embeds its query.
    expect(extractions(model)).toEqual([
      ...extracted(TOLD, 'Got it.'),
      ...extracted(REQUEST, '(consulted hewo-2: Say: violet)'),
      ...extracted('Anything else?', 'Got it.'),
    ]);
    expect(embedded(embedder, 'query')).toEqual([[TOLD], [REQUEST], [QUESTION], [REQUEST], ['Anything else?']]);
    expect(embedded(embedder, 'document')).toEqual([
      [`The user wrote: ${TOLD}\nI answered: Got it.`],
      ['The user favourite colour is teal.'],
      [`The user wrote: ${REQUEST}\nI answered: (consulted hewo-2: Say: violet)`],
      ['The user wrote: Anything else?\nI answered: Got it.'],
    ]);
    expect(embedder.calls).toHaveLength(9);
  });

  it("a delegated task from another agent is remembered under the user it carries, not the agent, and replayed and extracted as that agent's words", async () => {
    const {
      handler,
      context,
      posts,
      consults,
      answers,
      channelRequests,
      failures,
      backgrounds,
      remember,
      stdout,
      log,
      toolsLog,
      readRoster,
      model,
      embedder,
      root,
    } = await agent();
    const DELEGATED = 'The user says her favourite colour is teal';
    await handler(
      delivery('d1', message({ from: 'hewo-1', kind: 'internal', to: 'memo-1', user: 'alice', text: DELEGATED })),
      context,
    );
    // The answer to a delegated task goes to the user.
    expect(posts).toEqual([
      { conversation: 'c1', kind: 'status', text: 'ok' },
      { conversation: 'c1', kind: 'output', text: 'Got it.' },
    ]);
    await handler(delivery('d2', message({ id: 'm2', conversation: 'c2', text: 'favourite colour?' })), context);
    expect(posts.slice(2)).toEqual([
      { conversation: 'c2', kind: 'status', text: 'ok' },
      { conversation: 'c2', kind: 'output', text: 'Got it.' },
    ]);
    // alice's next message recalls the fact the agent learned from hewo-1's message: in her incoming message, never in
    // the system prompt; the delegated turn is replayed as a remembered turn under its sender's frame, as its episode
    // reads, never as alice's own words (the owner, 2026-10-12, record memory-delegated-task-replay, option (a)).
    expect(channelRequests).toEqual([
      alone({ role: 'user', content: `Agent hewo-1 wrote to you:\n${DELEGATED}` }),
      alone(
        { role: 'user', content: `Agent hewo-1, for the user, wrote:\n${DELEGATED}` },
        { role: 'assistant', content: 'Got it.' },
        { role: 'user', content: `${TEAL_MEMORY}\n\nThe user wrote:\nfavourite colour?` },
      ),
    ]);
    expect(consults).toEqual([]);
    expect(answers).toEqual([]);
    expect(log.entries).toEqual([]);
    expect(toolsLog.entries).toEqual([]);
    // Neither turn passed, so the agent printed nothing.
    expect(stdout.mock.calls).toEqual([]);
    expect(readRoster.mock.calls).toEqual([[], []]);
    // Remembered under alice, the user the message carries, with from naming the agent that wrote it.
    expect(remember.mock.calls).toEqual([
      [ALICE, turn('turn1', 'c1', 'hewo-1', DELEGATED, 'Got it.')],
      [ALICE, turn('turn2', 'c2', 'alice', 'favourite colour?', 'Got it.')],
    ]);
    expect(backgrounds.map(([name]) => name)).toEqual(['memory.remember', 'memory.remember']);
    await Promise.all(backgrounds.map(([, task]) => task));
    expect(failures).toEqual([]);
    // Extraction is shown the delegated turn as hewo-1's words too.
    expect(extractions(model)).toEqual([
      ...extracted(DELEGATED, 'Got it.', 'Agent hewo-1, for the user,'),
      ...extracted('favourite colour?', 'Got it.'),
    ]);
    expect(embedded(embedder, 'query')).toEqual([[DELEGATED], ['favourite colour?']]);
    expect(embedded(embedder, 'document')).toEqual([
      [`Agent hewo-1, for the user, wrote: ${DELEGATED}\nI answered: Got it.`],
      ['The user favourite colour is teal.'],
      ['The user wrote: favourite colour?\nI answered: Got it.'],
    ]);
    expect(embedder.calls).toHaveLength(5);
    // The episode is in the agent's voice: the agent that passed the task on, for the user.
    expect(onDisk(root, ALICE)).toEqual({
      'episodic.json': doc('episodic', {
        records: [
          stored('turn1', `Agent hewo-1, for the user, wrote: ${DELEGATED}\nI answered: Got it.`),
          stored('turn2', 'The user wrote: favourite colour?\nI answered: Got it.'),
        ],
      }),
      'semantic.json': doc('semantic', { records: [stored('id1', 'The user favourite colour is teal.')] }),
      'session.json': doc('session', {
        turns: [
          turn('turn1', 'c1', 'hewo-1', DELEGATED, 'Got it.'),
          turn('turn2', 'c2', 'alice', 'favourite colour?', 'Got it.'),
        ],
      }),
    });
    // Nothing is kept under the agent's name.
    expect(existsSync(join(root, scopeKey({ channel: 'main', user: 'hewo-1' })))).toBe(false);
  });

  it("offers its recipe's role, guidance and selected tools to the model, and runs a selected tool the model calls (collaborating-agents R1, R2)", async () => {
    // The tool's call bound is on the fake clock: armed and cleared, never waited for.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { tools, ran, toolsLog } = lookupTools();
    // A recipe of its own naming this image, with a role that is not recipes/memory.json's: the image carries no role
    // (R1), so the system message holds the role it was handed, whatever it is.
    const ROLE = 'You name colours for the user, and look each one up before you answer.';
    let calls = 0;
    const a = await agent({
      prompt: ROLE,
      guidance: GUIDE,
      tools,
      respond: () =>
        calls++ === 0
          ? { ok: true, text: '', toolCalls: [{ id: 't1', name: 'lookup_colour', arguments: { name: 'teal' } }] }
          : { ok: true, text: '', toolCalls: [{ id: 'r', name: 'reply', arguments: { text: 'Teal is #008080.' } }] },
    });
    await a.handler(delivery('d1', message({ text: 'What is teal?' })), a.context);
    // Both channel calls, whole: the system message carries the role and the guidance, the tools end with the selected
    // one, and the second call carries the tool's result.
    const system: ChatMessage = {
      role: 'system',
      content: withGuidance(channelInstructions('memo-1', [], ROLE), GUIDE),
    };
    const asked: ChatMessage = { role: 'user', content: 'The user wrote:\nWhat is teal?' };
    expect(a.channelRequests).toEqual([
      {
        messages: [system, asked],
        maxTokens: 1_024,
        tools: channelTools('memo-1', [], [LOOKUP]),
        requireToolCall: true,
      },
      {
        messages: [
          system,
          asked,
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 't1', name: 'lookup_colour', arguments: { name: 'teal' } }],
          },
          { role: 'tool', toolCallId: 't1', content: '{"colour":"teal","hex":"#008080"}' },
        ],
        maxTokens: 1_024,
        tools: channelTools('memo-1', [], [LOOKUP]),
        requireToolCall: true,
      },
    ]);
    // The tool ran once, with the model's arguments, within its bound; the call is on record (size and sha256 only).
    expect(ran).toEqual([[{ name: 'teal' }, false]]);
    expect(toolsLog.entries).toEqual([
      {
        level: 'info',
        event: 'tool.called',
        fields: {
          tool: 'lookup_colour',
          resultBytes: 33,
          resultSha256: '0b84b75e4a061252a06092196c923bdb3145bc0074762bd8207ca18124329a85',
        },
      },
    ]);
    expect(a.posts).toEqual([
      { conversation: 'c1', kind: 'status', text: 'ok' },
      { conversation: 'c1', kind: 'output', text: 'Teal is #008080.' },
    ]);
    expect(a.consults).toEqual([]);
    expect(a.answers).toEqual([]);
    expect(a.log.entries).toEqual([]);
    // Neither call was a pass, so the agent printed nothing.
    expect(a.stdout.mock.calls).toEqual([]);
    expect(a.readRoster.mock.calls).toEqual([[]]);
    expect(a.remember.mock.calls).toEqual([[ALICE, turn('turn1', 'c1', 'alice', 'What is teal?', 'Teal is #008080.')]]);
    expect(a.backgrounds.map(([name]) => name)).toEqual(['memory.remember']);
    await Promise.all(a.backgrounds.map(([, task]) => task));
    expect(a.failures).toEqual([]);
    expect(extractions(a.model)).toEqual(extracted('What is teal?', 'Teal is #008080.'));
    expect(embedded(a.embedder, 'query')).toEqual([['What is teal?']]);
    expect(embedded(a.embedder, 'document')).toEqual([
      ['The user wrote: What is teal?\nI answered: Teal is #008080.'],
      ['The user favourite colour is teal.'],
    ]);
    expect(a.embedder.calls).toHaveLength(3);
    // The tool's bound was cleared when it answered: no timer is left.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('in a call turn, a memo whose recipe grants nested calls is offered consult, with its guidance and selected tools (patterns-phase-3 R33)', async () => {
    const { tools, ran, toolsLog } = lookupTools();
    const a = await agent({
      roster: [{ handle: 'hewo-2', recipe: 'hello-world', description: 'Says whatever it is asked to say.' }],
      guidance: GUIDE,
      tools,
      nestedCalls: true,
      respond: () => ({
        ok: true,
        text: '',
        toolCalls: [{ id: 'r', name: 'reply', arguments: { text: 'I keep what users tell me.' } }],
      }),
    });
    // alice's fact, saved by an earlier run: hewo-2's question shares its words "favourite" and "colour", so the call
    // turn's recall finds it, and it opens the question's user message after the identity line (prompt-prefix R5).
    const QUESTION = 'What is her favourite colour?';
    mkdirSync(join(a.root, scopeKey(ALICE)));
    writeFileSync(
      join(a.root, scopeKey(ALICE), 'semantic.json'),
      JSON.stringify(doc('semantic', { records: [stored('id0', 'The user favourite colour is teal.')] })),
    );
    await a.handler(
      delivery(
        'd1',
        message({
          id: 'q',
          from: 'hewo-2',
          kind: 'internal',
          to: 'memo-1',
          text: QUESTION,
          call: { id: 'k9', role: 'question' },
        }),
      ),
      a.context,
    );
    // R33's call turn: its instructions say consult is there, and it is offered after reply (to hewo-2), before pass and
    // the agent's own tool; the guidance is in the system message as in any turn.
    expect(a.channelRequests).toEqual([
      {
        messages: [
          { role: 'system', content: withGuidance(nestedCallInstructions('hewo-2', MEMORY_PROMPT), GUIDE) },
          {
            role: 'user',
            content: `${IDENTITY}\n\n${TEAL_MEMORY}\n\nAgent hewo-2 asks you. Your answer goes back to hewo-2 only; the user does not see it:\n${QUESTION}`,
          },
        ],
        maxTokens: 1_024,
        tools: nestedCallTools('hewo-2', 'memo-1', ['hewo-2'], [LOOKUP]),
        requireToolCall: true,
      },
    ]);
    // Answered on the answer route alone, and not remembered: the question's words are hewo-2's.
    expect(a.answers).toEqual([{ delivery: 'd1', text: 'I keep what users tell me.' }]);
    expect(a.posts).toEqual([]);
    expect(a.consults).toEqual([]);
    expect(ran).toEqual([]);
    expect(toolsLog.entries).toEqual([]);
    expect(a.log.entries).toEqual([]);
    // The call turn replied; it did not pass, so the agent printed nothing.
    expect(a.stdout.mock.calls).toEqual([]);
    expect(a.readRoster.mock.calls).toEqual([[]]);
    expect(a.remember).not.toHaveBeenCalled();
    expect(a.backgrounds).toEqual([]);
    expect(a.failures).toEqual([]);
    expect(extractions(a.model)).toEqual([]);
    expect(embedded(a.embedder, 'query')).toEqual([[QUESTION]]);
    expect(a.embedder.calls).toHaveLength(1);
    // Nothing was written: alice's folder holds the fact it held.
    expect(onDisk(a.root, ALICE)).toEqual({
      'semantic.json': doc('semantic', { records: [stored('id0', 'The user favourite colour is teal.')] }),
    });
  });

  // A recipe may select reply_with_files or ask_user (agent-files R12, patterns-phase-3 R23), and serveAgent offers each
  // through its channel map (src/agent-sdk/index.ts). memoryAgent makes one poster per delivery: decide posts a files
  // reply through it and act says the working status through it, so the status is said once whichever comes first. What
  // such a turn leaves in memory is the owner's answer of 2026-10-11, record memory-remember-files-and-questions, option
  // (a) "Remember both": the user's message, with the reply's text and the files' names, or with the question asked.
  /** A recipe that selects one channel tool, offered as serveAgent offers it: by its channel map, never run as a tool. */
  function selecting(name: string, definition: ToolDefinition) {
    const toolsLog = new RecordingAgentLog();
    return {
      tools: new AgentTools({
        selected: [name],
        available: new Map(),
        channel: new Map([[name, definition]]),
        log: toolsLog,
      }),
      toolsLog,
    };
  }
  const REPORT = 'Send me the quarterly report';
  const ASKED_FOR_REPORT: ChatMessage = { role: 'user', content: `The user wrote:\n${REPORT}` };
  const WORKING: PostRequest = { conversation: 'c1', kind: 'status', text: 'ok' };
  /** A files reply's double: posted, and what the conversation held when it went out recorded. */
  function filesPoster(posts: () => readonly PostRequest[]) {
    const postedBefore: PostRequest[][] = [];
    const replyWithFiles = vi.fn<AgentContext['replyWithFiles']>(() => {
      postedBefore.push([...posts()]);
      return Promise.resolve({ ok: true });
    });
    return { replyWithFiles, postedBefore };
  }

  it("answers with files: the working status said once, before the files reply, which goes out once through the context; the turn remembered with the reply's text and the files' names", async () => {
    const { tools, toolsLog } = selecting(REPLY_WITH_FILES, REPLY_WITH_FILES_TOOL);
    const FILED = {
      text: 'Here is your report.',
      files: ['/channel/report.txt', '/channel/upload-0123456789abcdef/data.csv'],
    };
    const RESPONSE = 'Here is your report.\n(gave the user files: report.txt, data.csv)';
    let posts: readonly PostRequest[] = [];
    const { replyWithFiles, postedBefore } = filesPoster(() => posts);
    const a = await agent({
      tools,
      replyWithFiles,
      respond: () => ({ ok: true, text: '', toolCalls: [{ id: 'f', name: REPLY_WITH_FILES, arguments: FILED }] }),
    });
    posts = a.posts;
    await a.handler(delivery('d1', message({ text: REPORT })), a.context);
    // The one channel call, whole: reply_with_files offered right after reply (agent-files R12).
    expect(a.channelRequests).toEqual([
      {
        messages: [{ role: 'system', content: channelInstructions('memo-1', [], MEMORY_PROMPT) }, ASKED_FOR_REPORT],
        maxTokens: 1_024,
        tools: channelTools('memo-1', [], [REPLY_WITH_FILES_TOOL]),
        requireToolCall: true,
      },
    ]);
    // The files reply went out once, in the message's conversation with the model's text and paths, after the working
    // status; act had nothing left to post.
    expect(replyWithFiles.mock.calls).toEqual([[{ conversation: 'c1', ...FILED }]]);
    expect(postedBefore).toEqual([[WORKING]]);
    expect(a.posts).toEqual([WORKING]);
    expect(a.consults).toEqual([]);
    expect(a.answers).toEqual([]);
    expect(a.log.entries).toEqual([]);
    expect(toolsLog.entries).toEqual([]);
    // The files reply was not a pass, so the agent printed nothing.
    expect(a.stdout.mock.calls).toEqual([]);
    expect(a.readRoster.mock.calls).toEqual([[]]);
    expect(a.remember.mock.calls).toEqual([[ALICE, turn('turn1', 'c1', 'alice', REPORT, RESPONSE)]]);
    expect(a.backgrounds.map(([name]) => name)).toEqual(['memory.remember']);
    await Promise.all(a.backgrounds.map(([, task]) => task));
    expect(a.failures).toEqual([]);
    const EPISODE = `The user wrote: ${REPORT}\nI answered: ${RESPONSE}`;
    expect(extractions(a.model)).toEqual(extracted(REPORT, RESPONSE));
    expect(embedded(a.embedder, 'query')).toEqual([[REPORT]]);
    expect(embedded(a.embedder, 'document')).toEqual([[EPISODE]]);
    expect(a.embedder.calls).toHaveLength(2);
    expect(onDisk(a.root, ALICE)).toEqual({
      'episodic.json': doc('episodic', { records: [stored('turn1', EPISODE)] }),
      'session.json': doc('session', { turns: [turn('turn1', 'c1', 'alice', REPORT, RESPONSE)] }),
    });
  });

  it('answers with files and hands work on in one response: the working status said once, for the files reply, then the hand-off; the turn remembered with both', async () => {
    const { tools, toolsLog } = selecting(REPLY_WITH_FILES, REPLY_WITH_FILES_TOOL);
    const FILED = { text: 'Here is your report.', files: ['/channel/report.txt'] };
    const HANDED = { to: 'hewo-2', text: 'Say: the report is out' };
    const RESPONSE = 'Here is your report.\n(gave the user files: report.txt)\n(asked hewo-2: Say: the report is out)';
    let posts: readonly PostRequest[] = [];
    const { replyWithFiles, postedBefore } = filesPoster(() => posts);
    const a = await agent({
      roster: [{ handle: 'hewo-2', recipe: 'hello-world', description: 'Says whatever it is asked to say.' }],
      tools,
      replyWithFiles,
      respond: () => ({
        ok: true,
        text: '',
        toolCalls: [
          { id: 'f', name: REPLY_WITH_FILES, arguments: FILED },
          { id: 's', name: 'send_message', arguments: HANDED },
        ],
      }),
    });
    posts = a.posts;
    await a.handler(delivery('d1', message({ text: REPORT })), a.context);
    expect(a.channelRequests).toEqual([
      {
        messages: [
          { role: 'system', content: channelInstructions('memo-1', ['hewo-2'], MEMORY_PROMPT) },
          { role: 'user', content: `${IDENTITY}\n\nThe user wrote:\n${REPORT}` },
        ],
        maxTokens: 1_024,
        tools: channelTools('memo-1', ['hewo-2'], [REPLY_WITH_FILES_TOOL]),
        requireToolCall: true,
      },
    ]);
    expect(replyWithFiles.mock.calls).toEqual([[{ conversation: 'c1', ...FILED }]]);
    expect(postedBefore).toEqual([[WORKING]]);
    // The turn's one poster had said the working status for the files reply, so act did not say it again.
    expect(a.posts).toEqual([WORKING, { conversation: 'c1', kind: 'internal', text: HANDED.text, to: 'hewo-2' }]);
    expect(a.consults).toEqual([]);
    expect(a.answers).toEqual([]);
    expect(a.log.entries).toEqual([]);
    expect(toolsLog.entries).toEqual([]);
    // Neither the files reply nor the hand-off was a pass, so the agent printed nothing.
    expect(a.stdout.mock.calls).toEqual([]);
    expect(a.readRoster.mock.calls).toEqual([[]]);
    expect(a.remember.mock.calls).toEqual([[ALICE, turn('turn1', 'c1', 'alice', REPORT, RESPONSE)]]);
    expect(a.backgrounds.map(([name]) => name)).toEqual(['memory.remember']);
    await Promise.all(a.backgrounds.map(([, task]) => task));
    expect(a.failures).toEqual([]);
    const EPISODE = `The user wrote: ${REPORT}\nI answered: ${RESPONSE}`;
    expect(extractions(a.model)).toEqual(extracted(REPORT, RESPONSE));
    expect(embedded(a.embedder, 'query')).toEqual([[REPORT]]);
    expect(embedded(a.embedder, 'document')).toEqual([[EPISODE]]);
    expect(a.embedder.calls).toHaveLength(2);
    expect(onDisk(a.root, ALICE)).toEqual({
      'episodic.json': doc('episodic', { records: [stored('turn1', EPISODE)] }),
      'session.json': doc('session', { turns: [turn('turn1', 'c1', 'alice', REPORT, RESPONSE)] }),
    });
  });

  it('asks the user: the working status, then the question as an output that asks; the turn remembered with the question asked', async () => {
    const { tools, toolsLog } = selecting(ASK_USER, ASK_USER_TOOL);
    const QUESTION = 'Which month do you mean?';
    const RESPONSE = `(asked the user: ${QUESTION})`;
    const a = await agent({
      tools,
      respond: () => ({ ok: true, text: '', toolCalls: [{ id: 'q', name: ASK_USER, arguments: { text: QUESTION } }] }),
    });
    await a.handler(delivery('d1', message({ text: REPORT })), a.context);
    // The one channel call, whole: ask_user offered right after reply (patterns-phase-3 R23).
    expect(a.channelRequests).toEqual([
      {
        messages: [{ role: 'system', content: channelInstructions('memo-1', [], MEMORY_PROMPT) }, ASKED_FOR_REPORT],
        maxTokens: 1_024,
        tools: channelTools('memo-1', [], [ASK_USER_TOOL]),
        requireToolCall: true,
      },
    ]);
    // The working status, then the question, as an output carrying asks (R24). The context's replyWithFiles, which
    // throws if called, was not.
    expect(a.posts).toEqual([WORKING, { conversation: 'c1', kind: 'output', text: QUESTION, asks: true }]);
    expect(a.consults).toEqual([]);
    expect(a.answers).toEqual([]);
    expect(a.log.entries).toEqual([]);
    expect(toolsLog.entries).toEqual([]);
    // The question was not a pass, so the agent printed nothing.
    expect(a.stdout.mock.calls).toEqual([]);
    expect(a.readRoster.mock.calls).toEqual([[]]);
    expect(a.remember.mock.calls).toEqual([[ALICE, turn('turn1', 'c1', 'alice', REPORT, RESPONSE)]]);
    expect(a.backgrounds.map(([name]) => name)).toEqual(['memory.remember']);
    await Promise.all(a.backgrounds.map(([, task]) => task));
    expect(a.failures).toEqual([]);
    const EPISODE = `The user wrote: ${REPORT}\nI answered: ${RESPONSE}`;
    expect(extractions(a.model)).toEqual(extracted(REPORT, RESPONSE));
    expect(embedded(a.embedder, 'query')).toEqual([[REPORT]]);
    expect(embedded(a.embedder, 'document')).toEqual([[EPISODE]]);
    expect(a.embedder.calls).toHaveLength(2);
    expect(onDisk(a.root, ALICE)).toEqual({
      'episodic.json': doc('episodic', { records: [stored('turn1', EPISODE)] }),
      'session.json': doc('session', { turns: [turn('turn1', 'c1', 'alice', REPORT, RESPONSE)] }),
    });
  });

  // A handler that throws is not acked, and the error ends the agent's loop (src/agent-sdk/index.ts, serveAgent: "fail
  // loudly, never limp on", PRINCIPLES §9). So identify's refusal of a message with no user, and a failure in recall or
  // decide, fail the turn with that error: memory is never best-effort (a failed embedding throws EmbeddingFailed,
  // docs/architecture/memory.md#tiers), and nothing is posted, remembered or written for a turn the agent did not answer.
  const TEAL = 'My favourite colour is teal';

  // identify, the first node (docs/architecture/memory.md): a message with no user has no memory scope, so the handler
  // refuses it before recall — never recalled or answered under a scope with no user. A delivery is parsed from JSON
  // unchecked (src/agent-sdk/index.ts), so the message may lack the field altogether, or carry it empty.
  const { user: alice, ...userless } = message({ text: TEAL });
  it.each<{ readonly case: string; readonly m: ConversationMessage; readonly user: readonly [boolean, unknown] }>([
    { case: 'has no user field', m: userless as ConversationMessage, user: [false, undefined] },
    { case: "has the user ''", m: message({ text: TEAL, user: '' }), user: [true, ''] },
  ])(
    "refuses a message that $case at identify, with scopeOf's error: nothing recalled, read, asked, posted, remembered or written",
    async ({ m, user }) => {
      // Each case is what it names: alice's message, its user field missing, or there and empty.
      expect(alice).toBe('alice');
      expect(['user' in m, m.user]).toEqual(user);
      const a = await agent();
      const recall = vi.spyOn(a.memory, 'recall');
      // The plain Error scopeOf throws, unchanged. The context's replyWithFiles and launchAgent throw their own errors if
      // called, so a turn that reached either would reject with another.
      await expect(a.handler(delivery('d1', m), a.context)).rejects.toStrictEqual(
        new Error('message m1 carries no user, so it has no memory scope'),
      );
      // The turn ended at identify: no recall, so nothing embedded; no roster read; no model request, channel or
      // extraction; nothing posted, asked, answered, logged, remembered or queued; no failure reported; nothing on disk.
      expect(recall.mock.calls).toEqual([]);
      expect(a.embedder.calls).toEqual([]);
      expect(a.readRoster.mock.calls).toEqual([]);
      expect(a.model.requests).toEqual([]);
      expect(a.channelRequests).toEqual([]);
      expect(a.posts).toEqual([]);
      expect(a.consults).toEqual([]);
      expect(a.answers).toEqual([]);
      expect(a.log.entries).toEqual([]);
      expect(a.toolsLog.entries).toEqual([]);
      expect(a.remember.mock.calls).toEqual([]);
      expect(a.backgrounds).toEqual([]);
      expect(a.failures).toEqual([]);
      expect(readdirSync(a.root)).toEqual([]);
      // No call was made, so none passed: the agent printed nothing.
      expect(a.stdout.mock.calls).toEqual([]);
    },
  );

  it("fails the turn with the embedder's own error when recall cannot embed the message: nothing asked of the model, posted or remembered", async () => {
    const a = await agent();
    const failure = new EmbeddingFailed('unavailable', 'the embedding server could not be reached');
    const embed = vi.spyOn(a.embedder, 'embed').mockRejectedValueOnce(failure);
    await expect(a.handler(delivery('d1', message({ text: TEAL })), a.context)).rejects.toBe(failure);
    // The one embedding asked for is recall's query; nothing else is embedded.
    expect(embed.mock.calls).toEqual([[[TEAL], 'query']]);
    // The turn ended at recall: no roster read, no model call, nothing posted, asked, answered, logged or remembered.
    expect(a.readRoster.mock.calls).toEqual([]);
    expect(a.model.requests).toEqual([]);
    expect(a.channelRequests).toEqual([]);
    expect(a.posts).toEqual([]);
    expect(a.consults).toEqual([]);
    expect(a.answers).toEqual([]);
    expect(a.log.entries).toEqual([]);
    expect(a.toolsLog.entries).toEqual([]);
    expect(a.remember.mock.calls).toEqual([]);
    expect(a.backgrounds).toEqual([]);
    expect(a.failures).toEqual([]);
    // No call was made, so none passed: the agent printed nothing.
    expect(a.stdout.mock.calls).toEqual([]);
    // Recall's reads of the four tiers ran beside the embedding; once they end, every tier is as empty as before and
    // nothing is on disk.
    expect(
      await Promise.all([
        a.cache.get(ALICE, 'session'),
        a.cache.get(ALICE, 'episodic'),
        a.cache.get(ALICE, 'semantic'),
        a.cache.get(ALICE, 'procedural'),
      ]),
    ).toEqual([
      doc('session', { turns: [] }),
      doc('episodic', { records: [] }),
      doc('semantic', { records: [] }),
      doc('procedural', { records: [] }),
    ]);
    expect(readdirSync(a.root)).toEqual([]);
  });

  // decide's failures (src/agent-sdk/channel.ts): a model call that fails; a model answer that cannot be acted on —
  // here the one docs/plans/debt.md D10 records taking memo-1 down, an answer with no tool call; and the memory
  // image's two turn bounds (agent.ts; docs/architecture/channel.md): MAX_ROUNDS = 3, so the third list_agents lookup
  // in one message fails the agent, each earlier one answered with the roster, and MAX_CORRECTIONS = 2, so a reply
  // sent back twice to be fixed fails the agent the third time it is invalid.
  const ASKED: ChatMessage = { role: 'user', content: `The user wrote:\n${TEAL}` };
  const LOOKUP_CALL = { id: 'l', name: 'list_agents', arguments: {} };
  /** One list_agents round: the call, and the roster (memo-1 alone: no other agent) as its result. */
  const lookedUp: ChatMessage[] = [
    { role: 'assistant', content: '', toolCalls: [LOOKUP_CALL] },
    { role: 'tool', toolCallId: 'l', content: '[]' },
  ];
  const EMPTY_REPLY = { id: 'r', name: 'reply', arguments: { text: '' } };
  /** One correction: the reply with no text, and the problem sent back as its result. */
  const corrected: ChatMessage[] = [
    { role: 'assistant', content: '', toolCalls: [EMPTY_REPLY] },
    { role: 'tool', toolCallId: 'r', content: 'error: the reply has no text.' },
  ];
  it.each<{
    readonly case: string;
    readonly answer: ChatResponse;
    readonly error: Error;
    readonly requests: readonly ChatRequest[];
  }>([
    {
      case: 'the model call fails',
      answer: { ok: false, reason: 'unavailable', detail: 'the model server could not be reached' },
      error: new ModelCallFailed('unavailable', 'the model server could not be reached'),
      requests: [alone(ASKED)],
    },
    {
      case: 'the model answers with no tool call',
      answer: { ok: true, text: 'I ran out of tokens', toolCalls: [] },
      error: new ToolCallInvalid('the model answered with text instead of a tool call: I ran out of tokens'),
      requests: [alone(ASKED)],
    },
    {
      case: 'the model calls list_agents on every round',
      answer: { ok: true, text: '', toolCalls: [LOOKUP_CALL] },
      error: new ToolCallInvalid('still calling list_agents after 3 rounds'),
      requests: [alone(ASKED), alone(ASKED, ...lookedUp), alone(ASKED, ...lookedUp, ...lookedUp)],
    },
    {
      case: 'the model replies with no text on every round',
      answer: { ok: true, text: '', toolCalls: [EMPTY_REPLY] },
      error: new ToolCallInvalid('still invalid after 2 corrections: error: the reply has no text.'),
      requests: [alone(ASKED), alone(ASKED, ...corrected), alone(ASKED, ...corrected, ...corrected)],
    },
  ])(
    "fails the turn with decide's error when $case, after recall: nothing posted or remembered",
    async ({ answer, error, requests }) => {
      const a = await agent({ respond: () => answer });
      await expect(a.handler(delivery('d1', message({ text: TEAL })), a.context)).rejects.toStrictEqual(error);
      // Recall ran for the message, and the roster was read, before the channel calls, the last of which failed the turn.
      expect(embedded(a.embedder, 'query')).toEqual([[TEAL]]);
      expect(a.embedder.calls).toHaveLength(1);
      expect(a.readRoster.mock.calls).toEqual([[]]);
      expect(a.channelRequests).toEqual(requests);
      // The channel calls were the model's only requests: no extraction, since nothing was remembered.
      expect(a.model.requests).toHaveLength(requests.length);
      // Nothing posted — not even the working status — asked, answered, logged or remembered, and nothing on disk.
      expect(a.posts).toEqual([]);
      expect(a.consults).toEqual([]);
      expect(a.answers).toEqual([]);
      expect(a.log.entries).toEqual([]);
      expect(a.toolsLog.entries).toEqual([]);
      expect(a.remember.mock.calls).toEqual([]);
      expect(a.backgrounds).toEqual([]);
      expect(a.failures).toEqual([]);
      expect(readdirSync(a.root)).toEqual([]);
      // decide threw, so it gave no call to print as a pass: the agent printed nothing.
      expect(a.stdout.mock.calls).toEqual([]);
    },
  );

  // act's failures (src/agent-sdk/channel.ts, act and perform): the working status, then the reply posted to the user
  // as an output through the context's post — which can reject. With any error but a refusal, which serveAgent lets end
  // the agent; or with PostRefused, the channel's refusal of a post in a conversation the harness has ended
  // (conversation_ended, patterns-phase-3 R18, R19), which serveAgent logs `post.refused` and acks as a normal end of
  // the turn (src/agent-sdk/index.ts) — so a remember run in spite of it would go unseen. Either way the user never
  // got the answer, and remember comes only after act (agent.ts: act → remember): nothing is remembered or written,
  // and memory never says "I answered" an answer the user did not receive. The refusal is the one HarnessClient.post
  // throws for the daemon's 409: the agent route, the reason, and the daemon's body (src/daemon/server.ts, a CallRefused).
  const ENDED_BODY = JSON.stringify({
    error: "conversation_ended: conversation c1 has ended (budget_exceeded): memo-1's output is not posted",
    reason: 'conversation_ended',
  });
  it.each<{ readonly case: string; readonly error: Error }>([
    { case: 'fails to post', error: new Error('the harness could not take the post') },
    {
      case: 'is refused: the conversation has ended',
      error: new PostRefused(Routes.agentMessages, 'conversation_ended', ENDED_BODY),
    },
  ])(
    "fails the turn with the post's own error when the reply $case, at act: the user never got the answer, so nothing is remembered or written",
    async ({ error }) => {
      const a = await agent();
      // The context's post: the working status goes out; the reply's output rejects.
      const post = vi.fn<AgentContext['post']>((r) => {
        if (r.kind === 'output') return Promise.reject(error);
        return Promise.resolve(message({ kind: r.kind, text: r.text }));
      });
      await expect(a.handler(delivery('d1', message({ text: TEAL })), { ...a.context, post })).rejects.toBe(error);
      // The turn reached act: recall ran for the message — its query the one embedding, so no episode or fact was
      // embedded as a document — the roster was read, and the one channel call answered with the reply "Got it.".
      expect(a.embedder.calls).toEqual([{ texts: [TEAL], purpose: 'query' }]);
      expect(a.readRoster.mock.calls).toEqual([[]]);
      expect(a.channelRequests).toEqual([alone(ASKED)]);
      // The channel call was the model's only request: no extraction.
      expect(a.model.requests).toHaveLength(1);
      expect(extractions(a.model)).toEqual([]);
      // act said the working status, then tried the reply, once each and in that order; nothing else was posted.
      expect(post.mock.calls).toEqual([[WORKING], [{ conversation: 'c1', kind: 'output', text: 'Got it.' }]]);
      expect(a.posts).toEqual([]);
      expect(a.consults).toEqual([]);
      expect(a.answers).toEqual([]);
      expect(a.log.entries).toEqual([]);
      expect(a.toolsLog.entries).toEqual([]);
      // The reply was not a pass, so the agent printed nothing before act.
      expect(a.stdout.mock.calls).toEqual([]);
      // Not remembered, no write queued, no failure reported, nothing on disk.
      expect(a.remember.mock.calls).toEqual([]);
      expect(a.backgrounds).toEqual([]);
      expect(a.failures).toEqual([]);
      expect(readdirSync(a.root)).toEqual([]);
    },
  );
});

describe('the shared prefix across memory agents (prompt-prefix A1: R5, R7, R8; A4: R6)', () => {
  const TEN = Array.from({ length: 10 }, (_, i) => `memo-${String(i + 1)}`);
  const othersOf = (h: string) => TEN.filter((x) => x !== h);
  const MEMORY_SECTION = (h: string) =>
    `# Memory\n\n## What you know about this user\n- [2026-09-26 12:00] ${h} was told the user likes teal.`;
  /** Agent h's nth remembered turn, as its recall replays it. */
  const pastTurn = (h: string, n: number): Turn => ({
    id: `${h}-t${String(n)}`,
    ts: NOW.toISOString(),
    conversation: `c${String(n)}`,
    from: 'alice',
    input: `before ${String(n)} (${h})`,
    response: `said ${String(n)}`,
  });
  /** The recalled history for kind 2 (two turns) or 3 (three turns); none for every other kind. */
  function historyOf(h: string, kind: number): Turn[] {
    if (kind === 2) return [pastTurn(h, 1), pastTurn(h, 2)];
    if (kind === 3) return [pastTurn(h, 1), pastTurn(h, 2), pastTurn(h, 3)];
    return [];
  }
  /** A different recall per agent: none, a # Memory section, two session turns, or both with three turns. */
  const recallOf = (h: string, i: number): Recall => {
    const kind = i % 4;
    return {
      episodes: [],
      facts: [],
      procedures: [],
      history: historyOf(h, kind),
      context: kind === 1 || kind === 3 ? MEMORY_SECTION(h) : '',
    };
  };

  /** Each agent's channel request for one message to everyone, built by the real memoryAgent over its own recall. */
  async function requests(): Promise<(readonly [string, ChatRequest])[]> {
    const out: (readonly [string, ChatRequest])[] = [];
    for (const [i, h] of TEN.entries()) {
      const recall = recallOf(h, i);
      const seen: ChatRequest[] = [];
      const posts: PostRequest[] = [];
      const memory = {
        recall: vi.fn(() => Promise.resolve(recall)),
        remember: vi.fn(() => Promise.resolve(undefined)),
        settled: vi.fn(() => Promise.resolve(undefined)),
      };
      const log = new RecordingAgentLog();
      const toolsLog = new RecordingAgentLog();
      const background = vi.fn();
      const roster = vi.fn(() =>
        Promise.resolve(othersOf(h).map((handle) => ({ handle, recipe: 'memory', description: 'd' }))),
      );
      const context = {
        handle: h,
        channel: 'crowd',
        prompt: MEMORY_PROMPT,
        guidance: [],
        model: {
          chat: (r: ChatRequest): Promise<ChatResponse> => {
            seen.push({ ...r, messages: r.messages.map((m) => ({ ...m })) });
            return Promise.resolve({
              ok: true,
              text: '',
              toolCalls: [{ id: 'p', name: 'pass', arguments: { reason: 'no' } }],
            });
          },
        },
        post: (r: PostRequest) => {
          posts.push(r);
          return Promise.resolve(message({ kind: r.kind, text: r.text }));
        },
        log,
        roster,
        tools: new AgentTools({ selected: [], available: new Map(), log: toolsLog }),
        background,
      } as unknown as AgentContext;
      await memoryAgent({ memory: memory as unknown as AgentMemory, clock: () => NOW, newId: () => 'x' })(
        delivery('d1', message({ channel: 'crowd', text: 'What is my favourite colour?' })),
        context,
      );
      expect(seen, h).toHaveLength(1);
      // One recall, for alice on this channel, by the message's text; a pass is neither remembered nor background work.
      expect(memory.recall.mock.calls, h).toEqual([
        [{ channel: 'crowd', user: 'alice' }, 'What is my favourite colour?'],
      ]);
      expect(memory.remember, h).not.toHaveBeenCalled();
      expect(memory.settled, h).not.toHaveBeenCalled();
      expect(background, h).not.toHaveBeenCalled();
      // The roster is read once for the message.
      expect(roster.mock.calls, h).toEqual([[]]);
      // The pass is said in the conversation, with its reason.
      expect(posts, h).toEqual([{ conversation: 'c1', kind: 'status', text: 'pass: no' }]);
      expect(log.entries, h).toEqual([]);
      expect(toolsLog.entries, h).toEqual([]);
      out.push([h, present(seen[0], 'seen[0]')]);
    }
    return out;
  }

  it('memo-1 … memo-10, each with its own recall: system message and tools byte-identical, memory only in its own user message', async () => {
    // The agent prints each pass on its stdout; captured here, never the test run's.
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const all = await requests();
    expect(stdout.mock.calls).toEqual(TEN.map(() => ['pass: no']));
    const [, first] = present(all[0], 'all[0]');
    const firstSystem = present(first.messages[0], 'first.messages[0]').content;
    expect(
      all.filter(([, r]) => present(r.messages[0], 'r.messages[0]').content !== firstSystem).map(([h]) => h),
      "agents whose system message differs from memo-1's",
    ).toEqual([]);
    expect(
      all.filter(([, r]) => JSON.stringify(r.tools) !== JSON.stringify(first.tools)).map(([h]) => h),
      "agents whose tools differ from memo-1's",
    ).toEqual([]);
    const system = firstSystem;
    expect(system).not.toContain('memo-');
    expect(system).not.toContain('# Memory');
    expect(JSON.stringify(first.tools)).not.toContain('# Memory');
    for (const [h, request] of all) expect(roleProblems(request.messages), `${h}: role order`).toEqual([]);
    // Every agent's request, whole and written out: the channel layer's instructions and tools for an agent with nine
    // others, untouched; then its recalled session turns, oldest first, each as the user's words and the agent's answer;
    // then its own user message: the identity line, the # Memory section when it recalled one, the framed message, a
    // blank line between each (prompt-prefix R5, R7; A4). The four kinds of recall repeat every four agents.
    const own: Record<string, ChatMessage[]> = {
      // Nothing recalled.
      'memo-1': [
        {
          role: 'user',
          content:
            'You are memo-1, an agent in a chat shared by the user and other agents, with the role given above.\n\nThe user wrote:\nWhat is my favourite colour?',
        },
      ],
      // A # Memory section only.
      'memo-2': [
        {
          role: 'user',
          content:
            'You are memo-2, an agent in a chat shared by the user and other agents, with the role given above.\n\n' +
            '# Memory\n\n## What you know about this user\n- [2026-09-26 12:00] memo-2 was told the user likes teal.\n\n' +
            'The user wrote:\nWhat is my favourite colour?',
        },
      ],
      // Two session turns.
      'memo-3': [
        { role: 'user', content: 'The user wrote:\nbefore 1 (memo-3)' },
        { role: 'assistant', content: 'said 1' },
        { role: 'user', content: 'The user wrote:\nbefore 2 (memo-3)' },
        { role: 'assistant', content: 'said 2' },
        {
          role: 'user',
          content:
            'You are memo-3, an agent in a chat shared by the user and other agents, with the role given above.\n\nThe user wrote:\nWhat is my favourite colour?',
        },
      ],
      // Three session turns and a # Memory section.
      'memo-4': [
        { role: 'user', content: 'The user wrote:\nbefore 1 (memo-4)' },
        { role: 'assistant', content: 'said 1' },
        { role: 'user', content: 'The user wrote:\nbefore 2 (memo-4)' },
        { role: 'assistant', content: 'said 2' },
        { role: 'user', content: 'The user wrote:\nbefore 3 (memo-4)' },
        { role: 'assistant', content: 'said 3' },
        {
          role: 'user',
          content:
            'You are memo-4, an agent in a chat shared by the user and other agents, with the role given above.\n\n' +
            '# Memory\n\n## What you know about this user\n- [2026-09-26 12:00] memo-4 was told the user likes teal.\n\n' +
            'The user wrote:\nWhat is my favourite colour?',
        },
      ],
      'memo-5': [
        {
          role: 'user',
          content:
            'You are memo-5, an agent in a chat shared by the user and other agents, with the role given above.\n\nThe user wrote:\nWhat is my favourite colour?',
        },
      ],
      'memo-6': [
        {
          role: 'user',
          content:
            'You are memo-6, an agent in a chat shared by the user and other agents, with the role given above.\n\n' +
            '# Memory\n\n## What you know about this user\n- [2026-09-26 12:00] memo-6 was told the user likes teal.\n\n' +
            'The user wrote:\nWhat is my favourite colour?',
        },
      ],
      'memo-7': [
        { role: 'user', content: 'The user wrote:\nbefore 1 (memo-7)' },
        { role: 'assistant', content: 'said 1' },
        { role: 'user', content: 'The user wrote:\nbefore 2 (memo-7)' },
        { role: 'assistant', content: 'said 2' },
        {
          role: 'user',
          content:
            'You are memo-7, an agent in a chat shared by the user and other agents, with the role given above.\n\nThe user wrote:\nWhat is my favourite colour?',
        },
      ],
      'memo-8': [
        { role: 'user', content: 'The user wrote:\nbefore 1 (memo-8)' },
        { role: 'assistant', content: 'said 1' },
        { role: 'user', content: 'The user wrote:\nbefore 2 (memo-8)' },
        { role: 'assistant', content: 'said 2' },
        { role: 'user', content: 'The user wrote:\nbefore 3 (memo-8)' },
        { role: 'assistant', content: 'said 3' },
        {
          role: 'user',
          content:
            'You are memo-8, an agent in a chat shared by the user and other agents, with the role given above.\n\n' +
            '# Memory\n\n## What you know about this user\n- [2026-09-26 12:00] memo-8 was told the user likes teal.\n\n' +
            'The user wrote:\nWhat is my favourite colour?',
        },
      ],
      'memo-9': [
        {
          role: 'user',
          content:
            'You are memo-9, an agent in a chat shared by the user and other agents, with the role given above.\n\nThe user wrote:\nWhat is my favourite colour?',
        },
      ],
      'memo-10': [
        {
          role: 'user',
          content:
            'You are memo-10, an agent in a chat shared by the user and other agents, with the role given above.\n\n' +
            '# Memory\n\n## What you know about this user\n- [2026-09-26 12:00] memo-10 was told the user likes teal.\n\n' +
            'The user wrote:\nWhat is my favourite colour?',
        },
      ],
    };
    expect(all.map(([h, request]) => [h, request])).toEqual(
      TEN.map((h) => [
        h,
        {
          messages: [
            { role: 'system', content: channelInstructions(h, othersOf(h), MEMORY_PROMPT) },
            ...present(own[h], 'own[h]'),
          ],
          maxTokens: 1_024,
          tools: channelTools(h, othersOf(h), []),
          requireToolCall: true,
        },
      ]),
    );
    // The requests the agents built hold every kind of recall, three replayed session turns included (A4): per agent,
    // the turn pairs before its incoming message, and whether that message carries a # Memory section after its identity line.
    expect(
      all.map(([h, request]) => [
        h,
        (request.messages.length - 2) / 2,
        present(request.messages.at(-1), 'request.messages.at(-1)').content.startsWith(
          `You are ${h}, an agent in a chat shared by the user and other agents, with the role given above.\n\n# Memory\n\n`,
        ),
      ]),
    ).toEqual([
      ['memo-1', 0, false],
      ['memo-2', 0, true],
      ['memo-3', 2, false],
      ['memo-4', 3, true],
      ['memo-5', 0, false],
      ['memo-6', 0, true],
      ['memo-7', 2, false],
      ['memo-8', 3, true],
      ['memo-9', 0, false],
      ['memo-10', 0, true],
    ]);
  });
});

describe('the memory agent, persisted (docs/plans/agent-persistence.md R10; A13)', () => {
  it("acks only after the turn's remember and settled for its user: the checkpoint that follows holds what it learned", async () => {
    // Every bound serveAgent and its telemetry arm is on the fake clock: none is reached, and none is left at the end.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const root = await tempDir('asha-memo-persist-');
    // The agent's stdout, where it prints each pass: captured, never the test run's, and put back by afterEach.
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const scope = { channel: 'main', user: 'alice' };
    const failures: unknown[] = [];
    let releaseFacts!: () => void;
    const factsHeld = new Promise<void>((r) => (releaseFacts = r));
    // Resolved by the model double when the remember asks for its fact extraction.
    let factsAsked!: () => void;
    const asked = new Promise<void>((r) => (factsAsked = r));
    const inner = new ExtractingModel(
      (x) => (x.includes('teal') ? ['The user favourite colour is teal.'] : []),
      () => [],
      () => ({ ok: true, text: '', toolCalls: [{ id: 'r', name: 'reply', arguments: { text: 'Got it.' } }] }),
    );
    const model = {
      chat: async (request: ChatRequest) => {
        if (request.tools?.[0]?.function.name === 'save_facts') {
          factsAsked();
          await factsHeld;
        }
        return inner.chat(request);
      },
    };
    const embedder = new FakeEmbedder();
    let n = 0;
    const memory = new AgentMemory({
      cache: new MemoryCache({
        store: new MemoryStore({
          root,
          onDropped: (file, count) => failures.push({ dropped: file, count }),
          onMalformed: (file, error) => failures.push({ malformed: file, error }),
        }),
        clock: () => NOW,
        onSaveFailed: (_s, _t, e) => failures.push(e),
        maxDocs: 100,
      }),
      embedder,
      model,
      clock: () => NOW,
      policy: DEFAULT_POLICY,
      newId: () => `id${String(++n)}`,
      onWriteFailed: (_s, e) => failures.push(e),
    });
    // Every ack, with what the daemon's checkpoint after it would copy: alice's memory folder at that moment.
    const acks: { id: string; folder: Record<string, unknown> | null }[] = [];
    const posts: PostRequest[] = [];
    async function* deliveries(): AsyncIterable<Delivery> {
      await Promise.resolve();
      yield delivery('d1', message({ text: 'My favourite colour is teal' }));
    }
    const open = vi.fn(() =>
      Promise.resolve({
        handle: 'memo-1',
        channel: 'main',
        tools: [],
        prompt: MEMORY_PROMPT,
        guidance: [],
        modules: [],
        persist: ['memory'] as const,
        deliveries: deliveries(),
      }),
    );
    const roster = vi.fn(() => Promise.resolve([]));
    const client = {
      requestTimeoutMs: 1_000,
      chat: model.chat,
      open,
      post: (r: PostRequest) => {
        posts.push(r);
        return Promise.resolve(message({ kind: r.kind, text: r.text }));
      },
      ack: (id: string) => {
        acks.push({ id, folder: folderNow(root, scope) });
        return Promise.resolve();
      },
      consult: (): Promise<never> => Promise.reject(new Error('not used')),
      answerCall: (): Promise<never> => Promise.reject(new Error('not used')),
      roster,
      blackboardRead: () => Promise.reject(new Error('not used')),
      blackboardPost: () => Promise.reject(new Error('not used')),
      postFiles: () => Promise.reject(new Error('not used')),
      moduleCall: () => Promise.reject(new Error('not used')),
    };
    const exporter = new RecordingSpanExporter();
    const lines: string[] = [];
    const telemetry = agentTelemetry(exporter, lines);
    const log = new RecordingAgentLog();
    const exits: number[] = [];
    const stopListening = vi.fn();
    const onTerminate = vi.fn(() => stopListening);
    // The memory agent, and the moment its handler returns for the delivery.
    const handler = memoryAgent({ memory, clock: () => NOW, newId: () => `turn${String(++n)}` });
    let handlerReturned!: () => void;
    const returned = new Promise<void>((r) => (handlerReturned = r));
    const handled: DeliveryHandler = async (d, context) => {
      await handler(d, context);
      handlerReturned();
    };
    const serving = serveAgent({
      client,
      telemetry,
      name: NAME,
      handler: handled,
      process: {
        onTerminate,
        exit: (code) => {
          exits.push(code);
        },
      },
      imageTools: {
        manifest: { tools: [], answerTools: [], keepsMemory: true, eraseUser: true, stateSchema: 1 },
        handlers: {},
      },
      workspace: await tempDir('asha-memo-ws-'),
      channelSpace: null,
      log,
      drainMs: 5_000,
    });
    // The handler has returned, with the reply out, and the remember is held at its fact extraction: no ack yet.
    await asked;
    await returned;
    expect(acks).toEqual([]);
    releaseFacts();
    await serving;
    // The ack saw every tier the turn wrote on disk, whole: it came after the remember and all its saves (R10). An ack
    // that had not waited would have come before any of them — the exporter answers at once, so the flush before an
    // ack does no I/O — and found no folder, or one without the fact, which only a file write puts there.
    expect(acks).toEqual([{ id: 'd1', folder: TEAL_LEARNED }]);
    // And nothing was written after it: the folder holds what the checkpoint would have copied.
    expect(onDisk(root, scope)).toEqual(TEAL_LEARNED);
    // Online, then the turn's working status and its reply.
    expect(posts).toEqual([
      { kind: 'status', text: 'Hi' },
      { conversation: 'c1', kind: 'status', text: 'ok' },
      { conversation: 'c1', kind: 'output', text: 'Got it.' },
    ]);
    expect(failures).toEqual([]);
    expect(log.entries).toEqual([]);
    expect(lines).toEqual([]);
    // The turn replied; it did not pass, so the agent printed nothing.
    expect(stdout.mock.calls).toEqual([]);
    // Joined as memo (the image's NAME), read the roster once for the message, and never exited: the stream ended and
    // serveAgent returned.
    expect(open.mock.calls).toEqual([['memo']]);
    expect(roster.mock.calls).toEqual([[]]);
    expect(onTerminate.mock.calls).toEqual([[expect.any(Function)]]);
    expect(stopListening.mock.calls).toEqual([[]]);
    expect(exits).toEqual([]);
    // The one channel call, whole, then the remember's extractions about that turn (the held fact extraction reached
    // the model last); the message embedded as the query, and the episode and the fact as documents.
    expect(inner.requests[0]).toEqual(alone({ role: 'user', content: 'The user wrote:\nMy favourite colour is teal' }));
    expect(inner.requests).toHaveLength(3);
    expect(extractions(inner)).toEqual(extracted('My favourite colour is teal', 'Got it.').reverse());
    expect(embedded(embedder, 'query')).toEqual([['My favourite colour is teal']]);
    expect(embedded(embedder, 'document')).toEqual([
      ['The user wrote: My favourite colour is teal\nI answered: Got it.'],
      ['The user favourite colour is teal.'],
    ]);
    expect(embedder.calls).toHaveLength(3);
    // The delivery's one span, a child of the daemon's span the delivery named, in its conversation's trace: exported
    // once, and nothing else asked of the exporter.
    expect(exporter.calls).toEqual([
      {
        export: [
          {
            name: 'delivery',
            traceId: traceIdFor('c1'),
            parent: '00000000000000aa',
            status: { code: SpanStatusCode.UNSET },
            attributes: {},
            events: [],
            links: [],
          },
        ],
      },
    ]);
    // Nothing of serveAgent or its telemetry is left: no timer, and the process-wide hooks are put back.
    expect(vi.getTimerCount()).toBe(0);
    expectOtelGlobalsRestored(lines);
  });
});

describe('the memory agent at stop (the stop-time race: enterprise-targets F2)', () => {
  it('a remember in flight when SIGTERM arrives is written to disk before the agent exits', async () => {
    // The drain's bound runs on the fake clock, advanced by the test: never a real wait.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const root = await tempDir('asha-memo-stop-');
    // The agent's stdout, where it prints each pass: captured, never the test run's, and put back by afterEach.
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const scope = { channel: 'main', user: 'alice' };
    const failures: unknown[] = [];
    // The fact extraction — the remember's model call — is held until the test releases it, or the agent exits.
    let releaseFacts!: () => void;
    const factsHeld = new Promise<void>((r) => (releaseFacts = r));
    let factsAsked!: () => void;
    const asked = new Promise<void>((r) => (factsAsked = r));
    const inner = new ExtractingModel(
      (x) => (x.includes('teal') ? ['The user favourite colour is teal.'] : []),
      () => [],
      () => ({ ok: true, text: '', toolCalls: [{ id: 'r', name: 'reply', arguments: { text: 'Got it.' } }] }),
    );
    const model = {
      chat: async (request: ChatRequest) => {
        if (request.tools?.[0]?.function.name === 'save_facts') {
          factsAsked();
          await factsHeld;
        }
        return inner.chat(request);
      },
    };
    const embedder = new FakeEmbedder();
    let n = 0;
    const memory = new AgentMemory({
      cache: new MemoryCache({
        store: new MemoryStore({
          root,
          onDropped: (file, count) => failures.push({ dropped: file, count }),
          onMalformed: (file, error) => failures.push({ malformed: file, error }),
        }),
        clock: () => NOW,
        onSaveFailed: (_s, _t, e) => failures.push(e),
        maxDocs: 100,
      }),
      embedder,
      model,
      clock: () => NOW,
      policy: DEFAULT_POLICY,
      newId: () => `id${String(++n)}`,
      onWriteFailed: (_s, e) => failures.push(e),
    });
    const acks: string[] = [];
    const posts: PostRequest[] = [];
    // Every exit, with what a real exit would leave behind: alice's memory folder at that moment.
    const exits: { code: number; folder: Record<string, unknown> | null }[] = [];
    let exited!: () => void;
    const exit = new Promise<void>((r) => (exited = r));
    // Resolved when the agent asks the stream for the delivery after d1: d1's turn, to its ack, is over.
    let askedForNext!: () => void;
    const d1Done = new Promise<void>((r) => (askedForNext = r));
    // A live channel stream: one delivery, then nothing more until the process ends, which closes it.
    async function* deliveries(): AsyncIterable<Delivery> {
      yield delivery('d1', message({ text: 'My favourite colour is teal' }));
      askedForNext();
      await exit;
    }
    const open = vi.fn(() =>
      Promise.resolve({
        handle: 'memo-1',
        channel: 'main',
        tools: [],
        prompt: MEMORY_PROMPT,
        guidance: [],
        modules: [],
        deliveries: deliveries(),
      }),
    );
    const roster = vi.fn(() => Promise.resolve([]));
    const client = {
      requestTimeoutMs: 1_000,
      chat: model.chat,
      open,
      post: (r: PostRequest) => {
        posts.push(r);
        return Promise.resolve(message({ kind: r.kind, text: r.text }));
      },
      ack: (id: string) => {
        acks.push(id);
        return Promise.resolve();
      },
      consult: (): Promise<never> => Promise.reject(new Error('not used')),
      answerCall: (): Promise<never> => Promise.reject(new Error('not used')),
      roster,
      blackboardRead: () => Promise.reject(new Error('not used')),
      blackboardPost: () => Promise.reject(new Error('not used')),
      postFiles: () => Promise.reject(new Error('not used')),
      moduleCall: () => Promise.reject(new Error('not used')),
    };
    const log = new RecordingAgentLog();
    let terminate!: () => void;
    const stopListening = vi.fn();
    const onTerminate = vi.fn((listener: () => void) => {
      terminate = listener;
      return stopListening;
    });
    const proc: AgentProcess = {
      onTerminate,
      exit: (code) => {
        exits.push({ code, folder: folderNow(root, scope) });
        exited();
        // An exited process holds nothing back: the remember is let go, so nothing of the turn is left waiting.
        releaseFacts();
      },
    };
    const exporter = new RecordingSpanExporter();
    const lines: string[] = [];
    const telemetry = agentTelemetry(exporter, lines);
    const workspace = await tempDir('asha-memo-ws-');

    const serving = serveAgent({
      client,
      telemetry,
      name: NAME,
      handler: memoryAgent({ memory, clock: () => NOW, newId: () => `turn${String(++n)}` }),
      process: proc,
      imageTools: {
        manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
        handlers: {},
      },
      workspace,
      channelSpace: null,
      log,
      drainMs: 5_000,
    });
    // The reply is posted and the delivery acked; the remember is still waiting on its fact extraction.
    await asked;
    await d1Done;
    expect(acks).toEqual(['d1']);
    expect(posts).toEqual([
      { kind: 'status', text: 'Hi' },
      { conversation: 'c1', kind: 'status', text: 'ok' },
      { conversation: 'c1', kind: 'output', text: 'Got it.' },
    ]);

    terminate();
    // The drain has begun: it names the work it waits for — the remember alone, the delivery being over — and its bound.
    expect(log.entries).toEqual([
      { level: 'info', event: 'agent.draining', fields: { work: ['memory.remember'], drainMs: 5_000 } },
    ]);
    // The bound is the one timer armed, and it is on the fake clock.
    expect(vi.getTimerCount()).toBe(1);
    // A millisecond short of the bound, the agent has not exited: it is waiting for the remember, still held.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exits).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    // The extraction answers; the remember writes the fact and settles.
    releaseFacts();
    await memory.settled(scope);
    // The bound's moment: the drain ended with the remember and cleared its bound, so nothing fires. A drain that had
    // not seen the remember finish would stop here instead, logging agent.drain_incomplete.
    await vi.advanceTimersByTimeAsync(1);
    await exit;
    // At its exit every tier the turn wrote is on disk, whole.
    expect(exits).toEqual([{ code: SIGTERM_EXIT_CODE, folder: TEAL_LEARNED }]);
    // The exit closed the stream: serveAgent has returned, and nothing of it is left running, nor written after the exit.
    await serving;
    expect(onDisk(root, scope)).toEqual(TEAL_LEARNED);
    expect(failures).toEqual([]);
    // The drain waited for the remember alone, and it finished within the bound.
    expect(log.entries).toEqual([
      { level: 'info', event: 'agent.draining', fields: { work: ['memory.remember'], drainMs: 5_000 } },
      { level: 'info', event: 'agent.drained', fields: { work: ['memory.remember'] } },
    ]);
    expect(posts).toHaveLength(3);
    expect(acks).toEqual(['d1']);
    expect(lines).toEqual([]);
    // The turn replied; it did not pass, so the agent printed nothing.
    expect(stdout.mock.calls).toEqual([]);
    // Joined as memo (the image's NAME), read the roster once, listened for SIGTERM once and stopped listening when it
    // returned.
    expect(open.mock.calls).toEqual([['memo']]);
    expect(roster.mock.calls).toEqual([[]]);
    expect(onTerminate.mock.calls).toEqual([[expect.any(Function)]]);
    expect(stopListening.mock.calls).toEqual([[]]);
    // The one channel call, whole, then the remember's extractions about that turn (the held fact extraction reached
    // the model last); the message embedded as the query, and the episode and the fact as documents.
    expect(inner.requests[0]).toEqual(alone({ role: 'user', content: 'The user wrote:\nMy favourite colour is teal' }));
    expect(inner.requests).toHaveLength(3);
    expect(extractions(inner)).toEqual(extracted('My favourite colour is teal', 'Got it.').reverse());
    expect(embedded(embedder, 'query')).toEqual([['My favourite colour is teal']]);
    expect(embedded(embedder, 'document')).toEqual([
      ['The user wrote: My favourite colour is teal\nI answered: Got it.'],
      ['The user favourite colour is teal.'],
    ]);
    expect(embedder.calls).toHaveLength(3);
    // d1's span, exported once at its turn's flush; the drain's flush had nothing more to send.
    expect(exporter.calls).toEqual([
      {
        export: [
          {
            name: 'delivery',
            traceId: traceIdFor('c1'),
            parent: '00000000000000aa',
            status: { code: SpanStatusCode.UNSET },
            attributes: {},
            events: [],
            links: [],
          },
        ],
      },
    ]);
    // No timer is left — the drain's bound and the telemetry's were all cleared — and the process-wide hooks are put back.
    expect(vi.getTimerCount()).toBe(0);
    expectOtelGlobalsRestored(lines);
  });
});
