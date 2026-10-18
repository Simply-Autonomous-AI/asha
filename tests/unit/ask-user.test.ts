// Asking the user and answering a conversation (docs/plans/patterns-phase-3.md R23–R27, A12): the SDK's ask_user —
// offered as the probes offered it, a final call made alone, posted as an output carrying asks; the channel's wait —
// one ask at a time, ended by the answer, the asker leaving, the window or the end; the answer — accepted only under
// R25's five conditions, delivered to the asker alone carrying `answers`, under the ask's post span, starting a new
// round that ends in a reply for the user; its frame, word for word; the CLI's conversation= and its waiting line.

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NAME, handleHelloWorld } from '../../images/hello-world/src/agent.js';
import {
  ASK_USER_TOOL,
  AgentTelemetry,
  COMMON_TOOL_DEFINITIONS,
  REPLY_WITH_FILES_TOOL,
  TRACE_LIMITS,
  answerFrame,
  callTools,
  channelTools,
  describeMessage,
  serveAgent,
  type AgentProcess,
  type BlackboardClient,
  type ChannelClient,
  type ModelClient,
  type ToolOutcomeLike,
} from '../../src/agent-sdk/index.js';
import { parseMessageArgs } from '../../src/cli/commands.js';
import { CallRefused, Channel, NotAwaiting } from '../../src/daemon/channel/index.js';
import { DaemonTracer, type TraceRecord } from '../../src/daemon/traces/index.js';
import { present } from '../../src/shared/assert-present.js';
import { ConversationTracker, EXIT, waitingLine } from '../../src/shared/lines.js';
import {
  ASK_WINDOW_MS,
  CALL_REFUSAL_REASONS,
  type AgentInfo,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ConversationEvent,
  type ConversationMessage,
  type Delivery,
  type ModuleToolOffer,
  type PostRequest,
} from '../../src/shared/protocol.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { MemoryUserLedger, RecordingAgentLog, RecordingLogger } from '../helpers/fakes.js';
import { ROOT } from '../helpers/pattern-spec.js';
import { HELLO_WORLD_PERSONA } from '../helpers/recipes.js';

const HANDLE = 'clerk-1';
const QUESTION = 'Approve posting "Office closed Friday."? Answer yes or no.';

describe('ask_user offered (R23)', () => {
  const own = [COMMON_TOOL_DEFINITIONS.read_file, ASK_USER_TOOL, COMMON_TOOL_DEFINITIONS.write_file];

  it('is defined exactly as the premise probes offered it', async () => {
    // The probes' own module, loaded as they ran it (plain JavaScript, so loaded by its URL).
    const probed = (await import(
      pathToFileURL(join(ROOT, 'tests/fixtures/probes/patterns-phase-3-2026-10-02/teams.mjs')).href
    )) as { readonly ASK_USER_TOOL: unknown };
    expect(ASK_USER_TOOL).toEqual(probed.ASK_USER_TOOL);
  });

  it('right after reply, or after reply_with_files when both are selected; never in a call turn', () => {
    expect(channelTools(HANDLE, [], own).map((t) => t.function.name)).toEqual([
      'reply',
      'ask_user',
      'list_agents',
      'pass',
      'read_file',
      'write_file',
    ]);
    expect(
      channelTools(HANDLE, ['helper-1'], [ASK_USER_TOOL, REPLY_WITH_FILES_TOOL]).map((t) => t.function.name),
    ).toEqual(['reply', 'reply_with_files', 'ask_user', 'send_message', 'consult', 'list_agents', 'pass']);
    expect(callTools('helper-1', own).map((t) => t.function.name)).toEqual([
      'reply',
      'pass',
      'read_file',
      'write_file',
    ]);
  });
});

/** A message as the channel carries it. */
const message = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  channel: 'main',
  conversation: 'm1',
  user: 'alice',
  from: 'alice',
  to: HANDLE,
  kind: 'input',
  text: 'Post the announcement: Office closed Friday.',
  at: '2026-10-02T00:00:00.000Z',
  ...over,
});
const call = (name: string, args: Record<string, unknown>, id = name) => ({ id, name, arguments: args });
const replies = (...calls: ReturnType<typeof call>[][]): ChatResponse[] =>
  calls.map((toolCalls) => ({ ok: true, text: '', toolCalls }));

/** A scripted harness client: the welcome selects ask_user; the model's replies in order (the last repeats); posts recorded. */
class Client implements ModelClient, ChannelClient, BlackboardClient {
  readonly requestTimeoutMs = 1_000;
  readonly modules: ModuleToolOffer[] = [];
  readonly posts: PostRequest[] = [];
  readonly sent: ChatMessage[][] = [];
  readonly offered: string[][] = [];
  readonly acks: string[] = [];
  constructor(
    private readonly replies: ChatResponse[],
    private readonly m: ConversationMessage = message(),
  ) {}
  moduleCall(): Promise<ToolOutcomeLike> {
    return Promise.reject(new Error('moduleCall not expected'));
  }
  open() {
    const d: Delivery = {
      deliveryId: 'd1',
      message: this.m,
      traceparent: `00-${traceIdFor(this.m.conversation)}-${'a'.repeat(16)}-01`,
    };
    async function* deliveries() {
      await Promise.resolve();
      yield d;
    }
    return Promise.resolve({
      handle: HANDLE,
      channel: 'main',
      tools: ['ask_user'],
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
  postFiles(): Promise<never> {
    return Promise.reject(new Error('unused'));
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
    return Promise.resolve([{ handle: 'helper-1', recipe: 'helper', description: 'Helps.' }]);
  }
  blackboardRead(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  blackboardPost(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
  chat(request: ChatRequest): Promise<ChatResponse> {
    this.sent.push(request.messages.map((m) => ({ ...m })));
    this.offered.push((request.tools ?? []).map((t) => t.function.name));
    return Promise.resolve(
      this.replies.length > 1 ? present(this.replies.shift(), 'the next reply') : present(this.replies[0], 'the reply'),
    );
  }
}

const NO_SIGNALS: AgentProcess = { onTerminate: () => () => undefined, exit: () => undefined };
const NO_IMAGE_TOOLS = {
  manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
  handlers: {},
};
const serve = (c: Client) =>
  serveAgent({
    client: c,
    telemetry: new AgentTelemetry({
      exporter: new InMemorySpanExporter(),
      writeLine: () => undefined,
      maxQueueSize: TRACE_LIMITS.maxQueueSize,
      maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
    }),
    name: NAME,
    handler: handleHelloWorld,
    process: NO_SIGNALS,
    imageTools: NO_IMAGE_TOOLS,
    workspace: '/tmp',
    channelSpace: null,
    log: new RecordingAgentLog(),
    drainMs: 1_000,
  });

describe('an ask posted (R23)', () => {
  it('is posted as the working status, then an output carrying asks with its text, and the delivery acked', async () => {
    const c = new Client(replies([call('ask_user', { text: QUESTION })]));
    await serve(c);
    expect(c.offered[0]).toEqual(['reply', 'ask_user', 'send_message', 'consult', 'list_agents', 'pass']);
    expect(c.posts).toEqual([
      { kind: 'status', text: 'Hi' },
      { conversation: 'm1', kind: 'status', text: 'ok' },
      { conversation: 'm1', kind: 'output', text: QUESTION, asks: true },
    ]);
    expect(c.acks).toEqual(['d1']);
  });

  it.each([
    ['reply', call('reply', { text: 'Posted.' })],
    ['send_message', call('send_message', { to: 'helper-1', text: 'hi' })],
    ['consult', call('consult', { requests: [{ to: 'helper-1', text: 'hi' }] })],
    ['pass', call('pass', { reason: 'x' })],
    ['another ask_user', call('ask_user', { text: 'Again?' }, 'ask_user-2')],
  ])('beside %s is refused as a correction, nothing posted, and the model asked again', async (_, beside) => {
    const c = new Client(
      replies([call('ask_user', { text: QUESTION }), beside], [call('ask_user', { text: QUESTION })]),
    );
    await serve(c);
    expect(c.sent).toHaveLength(2);
    const correction = present(c.sent[1], 'the second request')
      .filter((m) => m.role === 'tool')
      .map((m) => (m as { content: string }).content);
    expect(correction[0]).toBe(
      `error: ask_user is made alone: not with ${beside.name} in the same response. Ask once, and wait for the answer.`,
    );
    expect(c.posts.filter((p) => p.kind === 'output')).toEqual([
      { conversation: 'm1', kind: 'output', text: QUESTION, asks: true },
    ]);
  });

  it('with no text is refused as a correction', async () => {
    const c = new Client(replies([call('ask_user', { text: ' ' })], [call('ask_user', { text: QUESTION })]));
    await serve(c);
    expect(present(c.sent[1], 'the second request').at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'ask_user',
      content: 'error: the question has no text.',
    });
  });
});

describe("the answer's frame (R26)", () => {
  it('is the answer first, then the question, word for word, from answers alone', () => {
    const answer = message({ text: 'yes', answers: { ask: 'a1', text: QUESTION } });
    expect(answerFrame({ ask: 'a1', text: QUESTION }, 'yes')).toBe(
      `The user answered what you asked them:\nyes\nWhat you asked them:\n${QUESTION}`,
    );
    expect(describeMessage(answer, HANDLE)).toBe(
      `The user answered what you asked them:\nyes\nWhat you asked them:\n${QUESTION}`,
    );
    // Without answers the same message is an ordinary one to the agent.
    expect(describeMessage(message({ text: 'yes' }), HANDLE)).toBe('The user wrote to you:\nyes');
  });
});

function channel() {
  const logger = new RecordingLogger();
  const spans: TraceRecord[] = [];
  let n = 0;
  const clock = () => new Date('2026-10-02T00:00:00Z');
  const c = new Channel({
    name: 'main',
    logger,
    clock,
    newId: () => `id${String(++n)}`,
    onDeliveryTimeout: () => undefined,
    maxAgentPostsPerConversation: 32,
    users: new MemoryUserLedger(),
    tracer: new DaemonTracer({
      clock,
      newSpanId: () => (++n).toString(16).padStart(16, '0'),
      record: (r) => spans.push(r),
    }),
  });
  const inbox = new Map<string, Delivery[]>();
  const join = (base: string) => {
    const handle = `${base}-1`;
    c.join(base, { deliver: (d) => inbox.set(handle, [...(inbox.get(handle) ?? []), d]), deliveryTimeoutMs: 60_000 });
    return handle;
  };
  const clerk = join('clerk');
  const other = join('other');
  const alice = c.claimUser('alice');
  const bob = c.claimUser('bob');
  const events: ConversationEvent[] = [];
  /** alice's message to clerk-1, which clerk-1 answers with an ask: the conversation, the ask, the ask's post span. */
  const ask = () => {
    const input = c.postToConversation({
      from: alice.id,
      kind: 'input',
      text: 'Post the announcement: Office closed Friday.',
      to: clerk,
    });
    c.watch(input.conversation, (e) => events.push(e));
    const held = present(present(inbox.get(clerk), 'the clerk inbox').at(-1), 'the held delivery');
    const postSpan = 'b'.repeat(16);
    const asked = c.postToConversation({
      from: clerk,
      kind: 'output',
      conversation: input.conversation,
      text: QUESTION,
      parentSpanId: postSpan,
      asks: true,
    });
    c.ack(clerk, held.deliveryId);
    return { conversation: input.conversation, asked, postSpan };
  };
  return { c, logger, spans, inbox, clerk, other, alice, bob, events, ask };
}

describe('the wait (R24)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts the ask as an output carrying asks, to the asker, logged with asks; the conversation waits on it', () => {
    const { c, logger, ask } = channel();
    const { conversation, asked } = ask();
    expect(asked).toMatchObject({ kind: 'output', from: 'clerk-1', to: 'alice', text: QUESTION, asks: true });
    expect(c.waitingOn(conversation)).toEqual({ agent: 'clerk-1', message: asked.id, text: QUESTION });
    expect(
      present(
        logger.entries.find((e) => e.event === 'channel.posted' && e.fields['id'] === asked.id),
        'the posted log entry',
      ).fields,
    ).toEqual({
      channel: 'main',
      id: asked.id,
      conversation,
      from: 'clerk-1',
      to: 'alice',
      kind: 'output',
      length: QUESTION.length,
      asks: true,
    });
    expect(c.isSettled(conversation)).toBe(true);
  });

  it('refuses a second ask while one waits, ask_open, nothing posted', () => {
    const { c, logger, clerk, ask } = channel();
    const { conversation, asked } = ask();
    const posted = logger.entries.filter((e) => e.event === 'channel.posted').length;
    const second = (() => {
      try {
        c.postToConversation({
          from: clerk,
          kind: 'output',
          conversation,
          text: 'Again?',
          parentSpanId: 'c'.repeat(16),
          asks: true,
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(second).toBeInstanceOf(CallRefused);
    expect([(second as CallRefused).reason, (second as CallRefused).message]).toEqual([
      'ask_open',
      `ask_open: conversation ${conversation} already waits for the user's answer to clerk-1's ask ${asked.id}`,
    ]);
    expect(logger.entries.filter((e) => e.event === 'channel.posted')).toHaveLength(posted);
    expect(CALL_REFUSAL_REASONS).toContain('ask_open');
  });

  it(`ends after ASK_WINDOW_MS (${String(ASK_WINDOW_MS)} ms), channel.ask_expired at info; an answer then is refused`, () => {
    const { c, logger, alice, ask } = channel();
    const { conversation, asked } = ask();
    vi.advanceTimersByTime(ASK_WINDOW_MS - 1);
    expect(c.waitingOn(conversation)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(c.waitingOn(conversation)).toBeUndefined();
    expect(logger.entries.filter((e) => e.event === 'channel.ask_expired')).toEqual([
      {
        level: 'info',
        event: 'channel.ask_expired',
        fields: { channel: 'main', conversation, agent: 'clerk-1', ask: asked.id, windowMs: 600_000 },
      },
    ]);
    expect(() => c.answer({ from: alice.id, conversation, text: 'yes' })).toThrow(
      new NotAwaiting(`conversation ${conversation} is not waiting for an answer`),
    );
  });

  it('accepts an answer at 599,999 ms', () => {
    const { c, alice, ask } = channel();
    const { conversation } = ask();
    vi.advanceTimersByTime(ASK_WINDOW_MS - 1);
    expect(c.answer({ from: alice.id, conversation, text: 'yes' })).toMatchObject({
      to: 'clerk-1',
      answers: { text: QUESTION },
    });
  });

  it('ends when the asking agent leaves', () => {
    const { c, alice, clerk, ask } = channel();
    const { conversation } = ask();
    c.leave(clerk, 'exited');
    expect(c.waitingOn(conversation)).toBeUndefined();
    expect(() => c.answer({ from: alice.id, conversation, text: 'yes' })).toThrow(NotAwaiting);
  });

  it('ends when the harness ends the conversation', () => {
    const { c, alice, ask } = channel();
    const { conversation } = ask();
    c.end(conversation, 'budget_exceeded', 'x');
    expect(c.waitingOn(conversation)).toBeUndefined();
    expect(() => c.answer({ from: alice.id, conversation, text: 'yes' })).toThrow(
      new NotAwaiting(`conversation ${conversation} has ended (budget_exceeded)`),
    );
  });
});

describe('the answer (R25)', () => {
  it("is posted as an input to the asker alone carrying answers, under the ask's post span; the wait ends and a new round starts", () => {
    const { c, logger, spans, inbox, clerk, alice, events, ask } = channel();
    const { conversation, asked, postSpan } = ask();
    const settledBefore: string[] = [];
    const answer = c.answer({ from: alice.id, conversation, text: 'yes' });
    c.whenSettled(conversation, () => settledBefore.push('settled'));
    expect(answer).toMatchObject({
      conversation,
      from: 'alice',
      to: 'clerk-1',
      kind: 'input',
      text: 'yes',
      user: 'alice',
      answers: { ask: asked.id, text: QUESTION },
    });
    expect([...inbox.keys()]).toEqual(['clerk-1']);
    const delivered = present(present(inbox.get(clerk), 'the clerk inbox').at(-1), 'the delivered message');
    expect(delivered.message).toEqual(answer);
    expect(c.waitingOn(conversation)).toBeUndefined();
    expect(c.working(conversation)).toEqual(['clerk-1']);
    expect(c.isSettled(conversation)).toBe(false);
    expect(
      present(logger.entries.filter((e) => e.event === 'channel.posted').at(-1), 'the last posted log entry').fields,
    ).toEqual({
      channel: 'main',
      id: answer.id,
      conversation,
      from: 'alice',
      to: 'clerk-1',
      kind: 'input',
      length: 3,
      answers: asked.id,
    });
    // Its delivery's span is a child of the ask's post span.
    c.postToConversation({ from: clerk, kind: 'output', conversation, text: 'Posted.', parentSpanId: 'd'.repeat(16) });
    c.ack(clerk, delivered.deliveryId);
    const delivery = present(spans.filter((s) => s.name === 'asha.delivery').at(-1), 'the delivery span');
    expect(delivery.parentSpanId).toBe(postSpan);
    // whenSettled, registered after the answer, ran at the answer's settle.
    expect(settledBefore).toEqual(['settled']);
    expect(
      events.filter((e) => e.type === 'message').map((e) => (e as { message: ConversationMessage }).message.text),
    ).toEqual([QUESTION, 'Posted.']);
  });

  it("ends with the harness's no-reply output, naming what the asker did, when it does not reply", () => {
    const { c, inbox, clerk, alice, events, ask } = channel();
    const { conversation } = ask();
    c.answer({ from: alice.id, conversation, text: 'Also convert 5 metres to centimetres.' });
    const delivered = present(present(inbox.get(clerk), 'the clerk inbox').at(-1), 'the delivered message');
    c.post({
      from: clerk,
      kind: 'status',
      conversation,
      text: 'pass: handed to the user',
      parentSpanId: 'e'.repeat(16),
    });
    c.ack(clerk, delivered.deliveryId);
    const last = events.filter((e) => e.type === 'message').at(-1) as { message: ConversationMessage };
    expect(last.message).toMatchObject({
      from: 'asha',
      kind: 'output',
      to: 'alice',
      text: 'No agent could answer this:\n- clerk-1 passed: handed to the user',
    });
    expect(c.isSettled(conversation)).toBe(true);
  });

  it.each([
    ['an unknown conversation', 'nope', 'alice', 'conversation nope is not on channel "main"'],
    ['another user', undefined, 'bob', (id: string) => `conversation ${id} waits for alice's answer, not bob's`],
  ])('is refused not_awaiting for %s, nothing posted', (_, given, who, detail) => {
    const { c, logger, alice, bob, ask } = channel();
    const { conversation } = ask();
    const posted = logger.entries.filter((e) => e.event === 'channel.posted').length;
    const id = given ?? conversation;
    expect(() => c.answer({ from: who === 'alice' ? alice.id : bob.id, conversation: id, text: 'yes' })).toThrow(
      new NotAwaiting(typeof detail === 'string' ? detail : detail(id)),
    );
    expect(logger.entries.filter((e) => e.event === 'channel.posted')).toHaveLength(posted);
    expect(c.waitingOn(conversation)).toBeDefined();
  });

  it("is refused for another channel's conversation, nothing posted", () => {
    const { c, ask } = channel();
    const { conversation } = ask();
    const lab = new Channel({
      name: 'lab',
      logger: new RecordingLogger(),
      clock: () => new Date(),
      newId: () => 'x1',
      onDeliveryTimeout: () => undefined,
      maxAgentPostsPerConversation: 32,
      users: new MemoryUserLedger(),
      tracer: new DaemonTracer({ clock: () => new Date(), newSpanId: () => 'f'.repeat(16), record: () => undefined }),
    });
    const user = lab.claimUser('alice');
    expect(() => lab.answer({ from: user.id, conversation, text: 'yes' })).toThrow(
      new NotAwaiting(`conversation ${conversation} is not on channel "lab"`),
    );
    expect(c.waitingOn(conversation)).toBeDefined();
  });

  it("goes through the conversation's states in order: open, waiting, answered, settled", () => {
    const { c, inbox, clerk, alice } = channel();
    const states: string[] = [];
    const state = (conversation: string): string => {
      if (c.waitingOn(conversation) !== undefined) return 'waiting';
      if (c.isSettled(conversation)) return 'settled';
      if (c.working(conversation).length > 0) return 'open';
      return 'idle';
    };
    const input = c.postToConversation({
      from: alice.id,
      kind: 'input',
      text: 'Post the announcement: Office closed Friday.',
      to: clerk,
    });
    states.push(state(input.conversation));
    c.postToConversation({
      from: clerk,
      kind: 'output',
      conversation: input.conversation,
      text: QUESTION,
      parentSpanId: 'b'.repeat(16),
      asks: true,
    });
    c.ack(clerk, present(present(inbox.get(clerk), 'the clerk inbox').at(-1), 'the delivered message').deliveryId);
    states.push(state(input.conversation));
    c.answer({ from: alice.id, conversation: input.conversation, text: 'yes' });
    states.push(
      c.working(input.conversation).length > 0 && c.waitingOn(input.conversation) === undefined
        ? 'answered'
        : 'not answered',
    );
    c.postToConversation({
      from: clerk,
      kind: 'output',
      conversation: input.conversation,
      text: 'Posted.',
      parentSpanId: 'c'.repeat(16),
    });
    c.ack(clerk, present(present(inbox.get(clerk), 'the clerk inbox').at(-1), 'the delivered message').deliveryId);
    states.push(state(input.conversation));
    expect(states).toEqual(['open', 'waiting', 'answered', 'settled']);
  });

  it('is accepted at most once per ask, and refused for a conversation that never asked', () => {
    const { c, alice, clerk, ask } = channel();
    const { conversation } = ask();
    c.answer({ from: alice.id, conversation, text: 'yes' });
    expect(() => c.answer({ from: alice.id, conversation, text: 'yes' })).toThrow(
      new NotAwaiting(`conversation ${conversation} is not waiting for an answer`),
    );
    const plain = c.postToConversation({ from: alice.id, kind: 'input', text: 'Hello.', to: clerk });
    expect(() => c.answer({ from: alice.id, conversation: plain.conversation, text: 'yes' })).toThrow(
      new NotAwaiting(`conversation ${plain.conversation} is not waiting for an answer`),
    );
  });

  it('only an output asks', () => {
    const { c, alice } = channel();
    expect(() => c.postToConversation({ from: alice.id, kind: 'input', text: 'x', asks: true })).toThrow(
      "only an agent's output asks the user",
    );
  });
});

describe("the CLI's conversation= and waiting line (R27)", () => {
  it('reads conversation= with channel=, user= and message=, and refuses it beside any other key (exit 2)', () => {
    expect(parseMessageArgs(['user=alice', 'conversation=c1', 'message=yes'])).toEqual({
      request: { user: 'alice', channel: 'main', conversation: 'c1', message: 'yes' },
      files: [],
    });
    expect(parseMessageArgs(['channel=lab', 'conversation=c1', 'message=yes'])).toEqual({
      request: { channel: 'lab', conversation: 'c1', message: 'yes' },
      files: [],
    });
    for (const extra of ['recipe=r', 'to=clerk-1', 'topic=t', 'file=a.txt', 'posts=3', 'tokens=9']) {
      const key = present(extra.split('=')[0], 'the key before =');
      expect(parseMessageArgs(['conversation=c1', extra, 'message=yes'])).toBe(
        `conversation= answers what an agent asked: it takes only channel=, user= and message=, not ${key}=`,
      );
    }
  });

  it('prints, for an output carrying asks, the waiting line on stderr: the asker, the channel only when not main', () => {
    expect(waitingLine({ from: 'clerk-1', channel: 'main', user: 'alice', conversation: 'c1' })).toBe(
      '? clerk-1 is waiting for your answer: asha user=alice conversation=c1 message="…"\n',
    );
    expect(waitingLine({ from: 'clerk-1', channel: 'lab', user: 'alice', conversation: 'c1' })).toBe(
      '? clerk-1 is waiting for your answer: asha channel=lab user=alice conversation=c1 message="…"\n',
    );
    const out = { stdout: [] as string[], stderr: [] as string[], progress: [] as string[] };
    const tracker = new ConversationTracker(
      { stdout: (t) => out.stdout.push(t), stderr: (t) => out.stderr.push(t), progress: (t) => out.progress.push(t) },
      { sameBuild: true, deltas: null },
    );
    const input = message({ id: 'c1', conversation: 'c1' });
    expect(tracker.handle({ type: 'posted', message: input, working: ['clerk-1'] })).toBeUndefined();
    const asked = message({
      id: 'a1',
      conversation: 'c1',
      from: 'clerk-1',
      to: 'alice',
      kind: 'output',
      text: QUESTION,
      asks: true,
    });
    expect(tracker.handle({ type: 'message', message: asked, working: [] })).toBe(EXIT.ok);
    expect(out.stdout).toEqual([`${QUESTION}\n`]);
    expect(out.stderr).toEqual(['? clerk-1 is waiting for your answer: asha user=alice conversation=c1 message="…"\n']);
  });

  it('prints no waiting line for an output that does not ask', () => {
    const out: string[] = [];
    const tracker = new ConversationTracker(
      { stdout: () => undefined, stderr: (t) => out.push(t), progress: () => undefined },
      { sameBuild: true, deltas: null },
    );
    tracker.handle({ type: 'posted', message: message(), working: ['clerk-1'] });
    tracker.handle({
      type: 'message',
      message: message({ id: 'r1', from: 'clerk-1', to: 'alice', kind: 'output', text: 'Posted.' }),
      working: [],
    });
    expect(out).toEqual([]);
  });
});
