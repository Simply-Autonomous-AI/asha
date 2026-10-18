// The agent SDK's side of files for agents (docs/plans/agent-files.md R9, R10, R12; A3, A6, A13): the attachment line
// in the user turn, reply_with_files offered right after reply in a normal turn only, posted inside the turn with a
// refusal returned to the model as a correction, its 30 s bound, the /channel start check — and every request the
// gate's model-facing checks send byte-identical to the plan's base commit for every recipe that does not select it.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { describe, expect, it } from 'vitest';

import {
  AgentTelemetry,
  AgentTools,
  COMMON_TOOL_DEFINITIONS,
  ChannelSpaceUnavailable,
  FILE_REFUSED_RESULT,
  HarnessClient,
  REPLY_TOOL,
  REPLY_WITH_FILES_TIMEOUT_MS,
  REPLY_WITH_FILES_TOOL,
  TRACE_LIMITS,
  ToolCallInvalid,
  TurnBudget,
  callTools,
  fileTools,
  channelTools,
  describeMessage,
  serveAgent,
  type AgentProcess,
  type BlackboardClient,
  type ChannelClient,
  type ModelClient,
  type ToolOutcomeLike,
} from '../../src/agent-sdk/index.js';
import {
  type AgentInfo,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ConversationMessage,
  type Delivery,
  type ModuleToolOffer,
  type PostRequest,
} from '../../src/shared/protocol.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { NAME, handleHelloWorld, helloWorldTurn } from '../../images/hello-world/src/agent.js';
import { FakeFetch, RecordingAgentLog } from '../helpers/fakes.js';
import { HELLO_WORLD_PERSONA } from '../helpers/recipes.js';
import { corpusPrints, type RequestPrint } from '../helpers/request-corpus.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const HANDLE = 'hewo-1';
const WORKSPACE = mkdtempSync(join(tmpdir(), 'asha-sdk-files-'));

const message = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  channel: 'main',
  conversation: 'm1',
  user: 'user-1',
  from: 'user-1',
  to: null,
  kind: 'input',
  text: 'What is the locker code in ./notes.txt?',
  at: '2026-09-30T00:00:00.000Z',
  ...over,
});

const delivery = (m: ConversationMessage): Delivery => ({
  deliveryId: 'd1',
  message: m,
  traceparent: `00-${traceIdFor(m.conversation)}-${'a'.repeat(16)}-01`,
});

type Reply = ChatResponse;
const filesCall = (files: string[], text = 'Here it is.'): Reply => ({
  ok: true,
  text: '',
  toolCalls: [{ id: 'f1', name: 'reply_with_files', arguments: { text, files } }],
});
const replyCall = (text: string): Reply => ({
  ok: true,
  text: '',
  toolCalls: [{ id: 'r1', name: 'reply', arguments: { text } }],
});

/** A scripted harness client: the welcome selects `selected`; replies in order (the last repeats); outputs with files answered from `filesResults`. */
class Client implements ModelClient, ChannelClient, BlackboardClient {
  readonly requestTimeoutMs = 1_000;
  readonly modules: ModuleToolOffer[] = [];
  moduleCall(): Promise<ToolOutcomeLike> {
    return Promise.reject(new Error('moduleCall not expected'));
  }
  readonly posts: unknown[] = [];
  readonly sent: ChatMessage[][] = [];
  readonly opened: string[] = [];
  readonly acks: string[] = [];
  filesResults: ({ ok: true } | { ok: false; reason: 'file_refused' })[] = [{ ok: true }];
  constructor(
    private readonly selected: string[],
    private readonly replies: Reply[],
    private readonly m: ConversationMessage = message(),
  ) {}
  open(name: string) {
    this.opened.push(name);
    const d = delivery(this.m);
    async function* deliveries() {
      await Promise.resolve();
      yield d;
    }
    return Promise.resolve({
      handle: HANDLE,
      channel: 'main',
      tools: this.selected,
      prompt: HELLO_WORLD_PERSONA.role,
      guidance: [],
      modules: this.modules,
      deliveries: deliveries(),
    });
  }
  post(request: PostRequest) {
    this.posts.push(request);
    return Promise.resolve(message({ kind: request.kind, text: request.text }));
  }
  postFiles(request: { conversation: string; text: string; files: readonly string[] }) {
    this.posts.push({ files: request });
    const result =
      this.filesResults.length > 1
        ? present(this.filesResults.shift(), 'the next files result')
        : present(this.filesResults[0], 'the files result');
    return Promise.resolve(
      result.ok ? { ok: true as const, value: message({ kind: 'output', text: request.text }) } : result,
    );
  }
  ack(id: string) {
    this.acks.push(id);
    return Promise.resolve();
  }
  consult(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  answerCall(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  roster(): Promise<AgentInfo[]> {
    return Promise.resolve([]);
  }
  blackboardRead(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  blackboardPost(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  chat(request: ChatRequest): Promise<ChatResponse> {
    this.sent.push(request.messages.map((m) => ({ ...m })));
    return Promise.resolve(
      this.replies.length > 1 ? present(this.replies.shift(), 'the next reply') : present(this.replies[0], 'the reply'),
    );
  }
}

const NO_SIGNALS: AgentProcess = { onTerminate: () => () => undefined, exit: () => undefined };
const telemetry = () =>
  new AgentTelemetry({
    exporter: new InMemorySpanExporter(),
    writeLine: () => undefined,
    maxQueueSize: TRACE_LIMITS.maxQueueSize,
    maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
  });
const NO_IMAGE_TOOLS = {
  manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
  handlers: {},
};

function serve(c: Client, channelSpace: string | null = null) {
  return serveAgent({
    client: c,
    telemetry: telemetry(),
    name: NAME,
    handler: handleHelloWorld,
    process: NO_SIGNALS,
    imageTools: NO_IMAGE_TOOLS,
    workspace: WORKSPACE,
    channelSpace,
    log: new RecordingAgentLog(),
    drainMs: 1_000,
  });
}

describe('every request the gate puts to a model is byte-identical to the base commit for a recipe without reply_with_files (A13)', () => {
  it('every routing, held-out and rainbow case and every eval message: messages, each tool, the rest', async () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/unit/fixtures/request-prints-3d310b5.json'), 'utf8')) as {
      base: string;
      prints: Record<string, RequestPrint>;
    };
    expect(fixture.base).toBe('3d310b5');
    const now = await corpusPrints(ROOT);
    // Requests added since the base, each by the plan that added it; every other request is the base's, byte for byte.
    // debt-paydown R8: the approved-result cases (evals/routing/approved.ts), new requests that change no other one.
    const added = [
      'routing/approved-budget-exceeded',
      'routing/approved-injection',
      'routing/approved-injection-false-failure',
      'routing/approved-injection-fence',
      'routing/approved-injection-link',
      'routing/approved-ok',
      'routing/approved-ok-other-agent',
      'routing/approved-plugin-exit-255',
      'routing/approved-unknown-outcome',
    ];
    expect(Object.keys(now).sort(byCodeUnit)).toEqual([...Object.keys(fixture.prints), ...added].sort(byCodeUnit));
    expect(Object.keys(now).length).toBeGreaterThanOrEqual(60);
    const differences: string[] = [];
    for (const [id, base] of Object.entries(fixture.prints)) {
      const p = present(now[id], `now's print of ${id}`);
      if (p.messages !== base.messages) differences.push(`${id}: its messages`);
      if (p.rest !== base.rest) differences.push(`${id}: its other fields`);
      if (p.toolOrder.join() !== base.toolOrder.join())
        differences.push(`${id}: its tools' order ${p.toolOrder.join(',')}`);
      for (const [tool, digest] of Object.entries(base.tools))
        if (p.tools[tool] !== digest) differences.push(`${id}: tool ${tool}`);
    }
    // Each difference names the request and the part (a tool by its name) that changed.
    expect(differences).toEqual([]);
  });

  it('a message with one attachment adds exactly its one Attached file: line after the text, and nothing else (R9)', () => {
    const attachment = { path: '/channel/upload-0123456789abcdef/notes.txt', size: 44, sha256: 'a'.repeat(64) };
    const without = helloWorldTurn(message(), HANDLE, [], HELLO_WORLD_PERSONA);
    const withOne = helloWorldTurn(message({ attachments: [attachment] }), HANDLE, [], HELLO_WORLD_PERSONA);
    expect(withOne.tools).toEqual(without.tools);
    expect(withOne.messages[0]).toEqual(without.messages[0]);
    expect(present(withOne.messages[1], "withOne's second message").content).toBe(
      `${present(without.messages[1], "without's second message").content}\nAttached file: /channel/upload-0123456789abcdef/notes.txt (44 bytes)`,
    );
    expect(
      describeMessage(
        message({
          attachments: [attachment, { ...attachment, path: '/channel/upload-0123456789abcdef/b.pdf', size: 9 }],
        }),
        HANDLE,
      ),
    ).toBe(
      'The user wrote:\nWhat is the locker code in ./notes.txt?\nAttached file: /channel/upload-0123456789abcdef/notes.txt (44 bytes)\nAttached file: /channel/upload-0123456789abcdef/b.pdf (9 bytes)',
    );
  });
});

describe('reply_with_files offered (R12, A13)', () => {
  const own = [COMMON_TOOL_DEFINITIONS.read_file, REPLY_WITH_FILES_TOOL, COMMON_TOOL_DEFINITIONS.write_file];
  it('right after reply in a normal turn, alone or with other agents; every other tool unchanged', () => {
    expect(channelTools(HANDLE, [], own).map((t) => t.function.name)).toEqual([
      'reply',
      'reply_with_files',
      'list_agents',
      'pass',
      'read_file',
      'write_file',
    ]);
    expect(channelTools(HANDLE, ['hewo-2'], own).map((t) => t.function.name)).toEqual([
      'reply',
      'reply_with_files',
      'send_message',
      'consult',
      'list_agents',
      'pass',
      'read_file',
      'write_file',
    ]);
    const without = channelTools(
      HANDLE,
      ['hewo-2'],
      own.filter((t) => t !== REPLY_WITH_FILES_TOOL),
    );
    expect(channelTools(HANDLE, ['hewo-2'], own).filter((t) => t !== REPLY_WITH_FILES_TOOL)).toEqual(without);
    expect(channelTools(HANDLE, [], own)[0]).toBe(REPLY_TOOL);
  });

  it('never in a call turn', () => {
    expect(callTools('hewo-2', own).map((t) => t.function.name)).toEqual(['reply', 'pass', 'read_file', 'write_file']);
  });

  it("is selected through the welcome as a channel tool: in the agent's definitions in the recipe's order, never run as a tool", async () => {
    const log = new RecordingAgentLog();
    const tools = new AgentTools({
      selected: ['read_file', 'reply_with_files'],
      available: fileTools({ workspace: WORKSPACE, channelSpace: null, handle: HANDLE, log }),
      channel: new Map([['reply_with_files', REPLY_WITH_FILES_TOOL]]),
      log,
    });
    expect(tools.definitions).toEqual([COMMON_TOOL_DEFINITIONS.read_file, REPLY_WITH_FILES_TOOL]);
    await expect(
      tools.run(
        { id: 'x', name: 'reply_with_files', arguments: { text: 't', files: ['/channel/a'] } },
        new TurnBudget(),
      ),
    ).rejects.toThrow('reply_with_files is a channel tool: decide() posts it, it is never run as a tool');
    // Not selected: an agent without it is refused it at start as any unimplemented name would be, and offers nothing of it.
    expect(
      new AgentTools({
        selected: ['read_file'],
        available: fileTools({ workspace: WORKSPACE, channelSpace: null, handle: HANDLE, log }),
        channel: new Map([['reply_with_files', REPLY_WITH_FILES_TOOL]]),
        log,
      }).definitions,
    ).toEqual([COMMON_TOOL_DEFINITIONS.read_file]);
  });
});

describe('a reply with files posted inside the turn (R12, A6)', () => {
  it('is posted to the daemon with its text and paths, after the turn says it is working, and the delivery is acked', async () => {
    const c = new Client(['reply_with_files', 'read_file'], [filesCall(['/channel/out.txt'])]);
    await serve(c);
    expect(c.posts).toEqual([
      { kind: 'status', text: 'Hi' },
      { conversation: 'm1', kind: 'status', text: 'ok' },
      { files: { conversation: 'm1', text: 'Here it is.', files: ['/channel/out.txt'] } },
    ]);
    expect(c.acks).toEqual(['d1']);
  });

  it("refused: the model is given exactly {ok: false, reason: 'file_refused'} as that call's result and asked again; its valid reply is then posted", async () => {
    const c = new Client(['reply_with_files'], [filesCall(['/channel/p']), replyCall('I cannot send that file.')]);
    c.filesResults = [{ ok: false, reason: 'file_refused' }, { ok: true }];
    await serve(c);
    // The second request ends with the refused call and its tool result: nothing else about the file or the rule.
    expect(c.sent).toHaveLength(2);
    expect(present(c.sent[1], 'the second request').slice(-2)).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'f1', name: 'reply_with_files', arguments: { text: 'Here it is.', files: ['/channel/p'] } }],
      },
      { role: 'tool', toolCallId: 'f1', content: '{"ok":false,"reason":"file_refused"}' },
    ]);
    expect(FILE_REFUSED_RESULT).toBe('{"ok":false,"reason":"file_refused"}');
    expect(c.posts).toEqual([
      { kind: 'status', text: 'Hi' },
      { conversation: 'm1', kind: 'status', text: 'ok' },
      { files: { conversation: 'm1', text: 'Here it is.', files: ['/channel/p'] } },
      { conversation: 'm1', kind: 'output', text: 'I cannot send that file.' },
    ]);
  });

  it('refused past maxCorrections: the turn fails ToolCallInvalid, no reply posted, nothing acked', async () => {
    const c = new Client(['reply_with_files'], [filesCall(['/channel/p'])]);
    c.filesResults = [{ ok: false, reason: 'file_refused' }];
    const error = await serve(c).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallInvalid);
    expect(c.posts.filter((p) => (p as { kind?: string }).kind === 'output')).toEqual([]);
    // One first try and two corrections: three refused posts, three model calls.
    expect(c.posts.filter((p) => 'files' in (p as object))).toHaveLength(3);
    expect(c.sent).toHaveLength(3);
    expect(c.acks).toEqual([]);
  });

  it('a malformed reply_with_files (no files, eleven files, no text) goes back to the model as an error, nothing posted', async () => {
    const c = new Client(
      ['reply_with_files'],
      [filesCall([]), filesCall(Array.from({ length: 11 }, (_, i) => `/channel/f${String(i)}`)), replyCall('ok then')],
    );
    await serve(c);
    expect(present(c.sent[1], 'the second request').at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'f1',
      content: 'error: files is a list of 1 to 10 paths in /channel, such as "/channel/result.txt".',
    });
    expect(c.posts.filter((p) => 'files' in (p as object))).toEqual([]);
  });
});

describe('the bound on an output with files (R12, A6)', () => {
  /** A harness that never answers: each request ends only when its own bound aborts it. */
  /** A server that never answers, noting when each request was aborted: the client's bound, its only end. */
  function silent() {
    const ended: { route: string; at: number }[] = [];
    const fake = new FakeFetch(
      (url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            ended.push({ route: new URL(url).pathname, at: performance.now() });
            reject(present(init.signal, 'the abort signal').reason as Error);
          });
        }),
    );
    const t = telemetry();
    const c = new HarnessClient({
      environment: { harnessUrl: 'http://host.test:1', agentToken: 't' },
      chatTimeoutMs: 1_000,
      requestTimeoutMs: 100,
      filesRequestTimeoutMs: 400,
      streamIdleTimeoutMs: 1_000,
      fetch: fake.fetch,
      telemetry: t,
    });
    return { c, t, ended };
  }

  it('the output with files is bounded by filesRequestTimeoutMs, every other post by requestTimeoutMs', async () => {
    const { c, t, ended } = silent();
    // Each bound is timed from the call, before which the client cannot have begun it: timed from inside the fake's
    // fetch, the work the client does first came off it, and a loaded run measured 80.68 ms of a 100 ms bound.
    const began: number[] = [];
    await t.inDelivery(delivery(message()), async () => {
      began.push(performance.now());
      await expect(c.post({ conversation: 'm1', kind: 'output', text: 'x' })).rejects.toThrow();
      began.push(performance.now());
      await expect(c.postFiles({ conversation: 'm1', text: 'x', files: ['/channel/a'] })).rejects.toThrow();
    });
    expect(ended.map((e) => e.route)).toEqual(['/agent/v1/channel/messages', '/agent/v1/channel/messages']);
    const after = (i: number): number =>
      present(ended[i], 'an ended request').at - present(began[i], "the call's start");
    // A timer fires no earlier than its delay, but for a millisecond's rounding.
    expect(after(0)).toBeGreaterThanOrEqual(99);
    expect(after(0)).toBeLessThan(350);
    expect(after(1)).toBeGreaterThanOrEqual(399);
  });

  it('every image passes REPLY_WITH_FILES_TIMEOUT_MS (30 s) as its bound, and 10 s for every other post', () => {
    expect(REPLY_WITH_FILES_TIMEOUT_MS).toBe(30_000);
    for (const image of ['hello-world', 'memory', 'suite-erase-fails']) {
      const main = readFileSync(join(ROOT, 'images', image, 'src', 'main.ts'), 'utf8');
      expect(main, image).toContain('requestTimeoutMs: 10_000,');
      expect(main, image).toContain('filesRequestTimeoutMs: REPLY_WITH_FILES_TIMEOUT_MS,');
      expect(main, image).toContain("channelSpace: '/channel',");
    }
  });

  it('a 409 file_refused is data; any other refusal throws', async () => {
    const answers = [
      new Response(JSON.stringify({ error: 'x', reason: 'file_refused', file: '/channel/p', rule: 'a link' }), {
        status: 409,
      }),
      new Response('{"error":"no"}', { status: 400 }),
    ];
    const t = telemetry();
    const c = new HarnessClient({
      environment: { harnessUrl: 'http://host.test:1', agentToken: 't' },
      chatTimeoutMs: 1_000,
      requestTimeoutMs: 100,
      filesRequestTimeoutMs: 400,
      streamIdleTimeoutMs: 1_000,
      fetch: new FakeFetch(() => present(answers.shift(), 'the next answer')).fetch,
      telemetry: t,
    });
    await t.inDelivery(delivery(message()), async () => {
      expect(await c.postFiles({ conversation: 'm1', text: 'x', files: ['/channel/p'] })).toEqual({
        ok: false,
        reason: 'file_refused',
      });
      await expect(c.postFiles({ conversation: 'm1', text: 'x', files: ['/channel/p'] })).rejects.toThrow('HTTP 400');
    });
  });
});

describe('the /channel start check (R10, A3)', () => {
  it('an SDK whose /channel is missing, or a file, fails its start before it opens the channel stream', async () => {
    for (const make of [
      () => join(WORKSPACE, 'no-such-channel'),
      () => (writeFileSync(join(WORKSPACE, 'a-file'), 'x'), join(WORKSPACE, 'a-file')),
    ]) {
      const c = new Client([], [replyCall('x')]);
      const error = await serve(c, make()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChannelSpaceUnavailable);
      expect(c.opened).toEqual([]);
    }
  });

  it('a writable /channel directory: the agent starts and opens its stream', async () => {
    const c = new Client([], [replyCall('x')]);
    await serve(c, mkdtempSync(join(tmpdir(), 'asha-channel-')));
    expect(c.opened).toEqual([NAME]);
  });
});
