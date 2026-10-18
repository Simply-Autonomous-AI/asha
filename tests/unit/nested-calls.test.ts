// Hierarchical teams (docs/plans/patterns-phase-3.md R33–R36, A14): a granted callee consults from the question it
// holds — a call of depth 2, and no deeper; `channel.call_opened` names the parent; the question's ack records nothing;
// the nested call's gather carries its parent and is a call turn answering the parent's asker, whose answer, pass,
// silence, expiry or departure is the parent outcome, exactly once; a nested gather held allows only the answer route;
// a parent closed closes its child with no gather; `working` lists the child's caller; the budget counts both levels.
// And the SDK's side: a granted call turn's instructions and tools, a nested gather's, and every other call turn as
// before; `nestedCalls` only true.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CALL_PASS_TOOL,
  act,
  decide,
  callAnswerTool,
  callInstructions,
  callTools,
  channelAgents,
  channelTurn,
  consultTool,
  describeMessage,
  identityLine,
  nestedCallLine,
  withGuidance,
  COMMON_TOOL_DEFINITIONS,
} from '../../src/agent-sdk/index.js';
import { CallRefused, Channel } from '../../src/daemon/channel/index.js';
import { DefinitionError, parseRecipe } from '../../src/daemon/definitions/index.js';
import { DaemonTracer } from '../../src/daemon/traces/index.js';
import type {
  ChatRequest,
  ChatResponse,
  ConsultRequest,
  ConversationMessage,
  Delivery,
  PostRequest,
} from '../../src/shared/protocol.js';
import { present } from '../../src/shared/assert-present.js';
import { RecordingAgentLog } from '../helpers/fakes.js';
import { MemoryUserLedger, RecordingLogger } from '../helpers/fakes.js';

/** top-1 asks lead-1 (granted) and other-1; lead-1 asks red-1 and orange-1. */
function team(timeoutMs = 60_000) {
  const logger = new RecordingLogger();
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
    tracer: new DaemonTracer({ clock, newSpanId: () => (++n).toString(16).padStart(16, '0'), record: () => undefined }),
  });
  const inbox = new Map<string, Delivery[]>();
  const join = (base: string, nestedCalls = false) => {
    const handle = `${base}-1`;
    c.join(base, {
      deliver: (d) => inbox.set(handle, [...(inbox.get(handle) ?? []), d]),
      deliveryTimeoutMs: timeoutMs,
      nestedCalls,
    });
    return handle;
  };
  for (const [base, granted] of [
    ['top', false],
    ['lead', true],
    ['other', false],
    ['red', true],
    ['orange', false],
  ] as const)
    join(base, granted);
  const alice = c.claimUser('alice');
  const last = (handle: string) =>
    present(present(inbox.get(handle), `inbox[${handle}]`).at(-1), `the last delivery to ${handle}`);
  const span = 'a'.repeat(16);
  /** alice → top-1; top-1 consults lead-1 and other-1; lead-1 consults red-1 and orange-1. */
  const nest = () => {
    const input = c.postToConversation({ from: alice.id, kind: 'input', text: 'Numbers?', to: 'top-1' });
    const top = c.openCall(
      'top-1',
      last('top-1').deliveryId,
      [
        { to: 'lead-1', text: 'Your numbers?' },
        { to: 'other-1', text: 'Yours?' },
      ],
      span,
    );
    const question = last('lead-1');
    const child = c.openCall(
      'lead-1',
      question.deliveryId,
      [
        { to: 'red-1', text: 'Your number?' },
        { to: 'orange-1', text: 'Yours?' },
      ],
      span,
    );
    return { conversation: input.conversation, top: top.call, question, child: child.call };
  };
  /** The workers answer; lead-1 acks its question: the child's gather reaches lead-1. */
  const workersAnswer = (child: string) => {
    for (const [worker, text] of [
      ['red-1', '4'],
      ['orange-1', '7'],
    ] as const) {
      const held = last(worker);
      if (held.message.call?.id !== child) throw new Error(`${worker} holds no question of call ${child}`);
      c.answerCall(worker, held.deliveryId, { text });
    }
    return last('lead-1');
  };
  const outcomes = () =>
    logger.entries
      .filter((e) => e.event === 'channel.call_outcome')
      .map((e) => [e.fields['call'], e.fields['addressee'], e.fields['outcome']]);
  return { c, logger, inbox, last, nest, workersAnswer, outcomes, span };
}

describe('a granted callee consults from its question (R34)', () => {
  it("opens a call of depth 2, logged with its parent, and the question's ack records no outcome", () => {
    const { c, logger, nest, outcomes } = team();
    const { top, question, child } = nest();
    expect(logger.entries.filter((e) => e.event === 'channel.call_opened').map((e) => e.fields)).toEqual([
      expect.objectContaining({ call: top, caller: 'top-1', addressees: ['lead-1', 'other-1'] }),
      expect.objectContaining({ call: child, caller: 'lead-1', addressees: ['red-1', 'orange-1'], parent: top }),
    ]);
    expect(
      present(logger.entries.filter((e) => e.event === 'channel.call_opened')[0], 'the first call_opened entry').fields,
    ).not.toHaveProperty('parent');
    c.ack('lead-1', question.deliveryId);
    expect(outcomes()).toEqual([]);
    // Open, its caller works on the conversation (R36).
    expect(c.working(question.message.conversation)).toContain('lead-1');
  });

  it("refuses a consult from a question of a call at depth 2, even granted (red-1), and an ungranted callee's as before", () => {
    const { c, last, nest } = team();
    nest();
    const refused = (caller: string) => {
      try {
        c.openCall(caller, last(caller).deliveryId, [{ to: 'top-1', text: 'x' }], 'b'.repeat(16));
      } catch (error) {
        return [(error as CallRefused).reason, (error as Error).message];
      }
      return undefined;
    };
    expect(refused('red-1')).toEqual([
      'nested_call',
      `nested_call: delivery ${last('red-1').deliveryId} is a question of a call at depth 2: no deeper call is opened`,
    ]);
    expect(refused('orange-1')).toEqual([
      'nested_call',
      `nested_call: delivery ${last('orange-1').deliveryId} is a call's question: a callee answers or passes, and consults no one`,
    ]);
    expect(refused('other-1')).toEqual([
      'nested_call',
      `nested_call: delivery ${last('other-1').deliveryId} is a call's question: a callee answers or passes, and consults no one`,
    ]);
  });
});

describe('the nested gather (R35)', () => {
  it("carries its parent, and lead-1's answer from it is its parent outcome: an answer to top-1 in top-1's call", () => {
    const { c, nest, workersAnswer, outcomes, last } = team();
    const { top, question, child } = nest();
    c.ack('lead-1', question.deliveryId);
    const gather = workersAnswer(child);
    expect(gather.message.call).toMatchObject({
      id: child,
      role: 'gather',
      context: { from: 'top-1', text: 'Your numbers?' },
      parent: { id: top, asker: 'top-1' },
    });
    const answer = c.answerCall('lead-1', gather.deliveryId, { text: '4, 7' });
    expect(answer).toMatchObject({
      from: 'lead-1',
      to: 'top-1',
      kind: 'internal',
      text: '4, 7',
      call: { id: top, role: 'answer' },
    });
    c.ack('lead-1', gather.deliveryId);
    c.answerCall('other-1', last('other-1').deliveryId, { text: '3, 2' });
    expect(outcomes()).toEqual([
      [child, 'red-1', 'answered'],
      [child, 'orange-1', 'answered'],
      [top, 'lead-1', 'answered'],
      [top, 'other-1', 'answered'],
    ]);
    // Exactly once: a second answer from the gather is call_closed.
    expect(() => c.answerCall('lead-1', gather.deliveryId, { text: 'again' })).toThrow(CallRefused);
    expect(last('top-1').message.call).toMatchObject({
      id: top,
      role: 'gather',
      answers: [
        { from: 'lead-1', outcome: 'answered', text: '4, 7' },
        { from: 'other-1', outcome: 'answered', text: '3, 2' },
      ],
    });
  });

  it.each([
    ['passed', (c: Channel, d: Delivery) => c.answerCall('lead-1', d.deliveryId, { pass: 'no numbers' })],
    [
      'unanswered',
      (c: Channel, d: Delivery) => {
        c.ack('lead-1', d.deliveryId);
      },
    ],
    [
      'left',
      (c: Channel) => {
        c.leave('lead-1', 'exited');
      },
    ],
  ])('records the parent outcome %s', (outcome, act) => {
    const { c, nest, workersAnswer, outcomes } = team();
    const { top, question, child } = nest();
    c.ack('lead-1', question.deliveryId);
    act(c, workersAnswer(child));
    expect(outcomes().filter(([call]) => call === top)).toEqual([[top, 'lead-1', outcome]]);
  });

  it('records left when the holder leaves with its child call open, closing the child with no gather', () => {
    const { c, logger, nest, outcomes, inbox } = team();
    const { top, question, child } = nest();
    c.ack('lead-1', question.deliveryId);
    const before = present(inbox.get('lead-1'), "inbox['lead-1']").length;
    c.leave('lead-1', 'exited');
    expect(outcomes().filter(([call]) => call === top)).toEqual([[top, 'lead-1', 'left']]);
    expect(logger.entries.filter((e) => e.event === 'channel.call_closed').map((e) => e.fields['call'])).toEqual([
      child,
    ]);
    expect(present(inbox.get('lead-1'), "inbox['lead-1']")).toHaveLength(before);
  });

  it('allows only the answer route while the nested gather is held: call_answer_only', () => {
    const { c, nest, workersAnswer } = team();
    const { conversation, question, child } = nest();
    c.ack('lead-1', question.deliveryId);
    workersAnswer(child);
    const posted = () =>
      c.postToConversation({ from: 'lead-1', kind: 'output', conversation, text: 'x', parentSpanId: 'c'.repeat(16) });
    expect(posted).toThrow(CallRefused);
    expect(posted).toThrow('call_answer_only');
  });

  it("closes a parent's open child calls, with no gather, when the parent's caller leaves (R36)", () => {
    const { c, logger, nest, inbox } = team();
    const { top, question, child } = nest();
    c.ack('lead-1', question.deliveryId);
    c.leave('top-1', 'exited');
    expect(logger.entries.filter((e) => e.event === 'channel.call_closed').map((e) => e.fields['call'])).toEqual([
      top,
      child,
    ]);
    const gathers = (h: string) => (inbox.get(h) ?? []).filter((d) => d.message.call?.role === 'gather');
    // The child is closed: its answers are refused, and no gather ever reaches lead-1.
    const redLast = present(present(inbox.get('red-1'), "inbox['red-1']").at(-1), "the last delivery to 'red-1'");
    expect(() => c.answerCall('red-1', redLast.deliveryId, { text: '4' })).toThrow('call_closed');
    expect(gathers('lead-1')).toEqual([]);
  });

  it("posts both levels' messages in the conversation: 9 agent posts for one lead's shape (p07-a, with two, has 13)", () => {
    const { c, nest, last, logger, workersAnswer } = team();
    const { conversation, question, child } = nest();
    c.ack('lead-1', question.deliveryId);
    const gather = workersAnswer(child);
    c.answerCall('lead-1', gather.deliveryId, { text: '4, 7' });
    c.ack('lead-1', gather.deliveryId);
    // other-1 granted nothing: it answers; the top's gather comes; top-1 replies.
    c.answerCall('other-1', last('other-1').deliveryId, { text: '3, 2' });
    c.postToConversation({
      from: 'top-1',
      kind: 'output',
      conversation,
      text: 'warm: 4, 7; cool: 3, 2',
      parentSpanId: 'd'.repeat(16),
    });
    // Questions 2 + 2, answers 2 + 2, the reply 1: 9 here (p07-a's two leads make it 13).
    const posts = logger.entries.filter(
      (e) => e.event === 'channel.posted' && e.fields['kind'] !== 'input' && e.fields['from'] !== 'asha',
    ).length;
    expect(posts).toBe(9);
  });
});

describe("both levels count against the conversation's posts (R36)", () => {
  it.each([
    // top-1's call: 2 questions and 2 answers reserved; lead-1's: 2 and 2 more.
    [7, 'refused post_budget'],
    [8, 'opened'],
  ])("a budget of %i posts: lead-1's nested call is %s", (posts, outcome) => {
    const { c, last } = team();
    const alice = present(c.users()[0], 'c.users()[0]');
    c.postToConversation({ from: alice, kind: 'input', text: 'Numbers?', to: 'top-1', budget: { posts } });
    c.openCall(
      'top-1',
      last('top-1').deliveryId,
      [
        { to: 'lead-1', text: 'Your numbers?' },
        { to: 'other-1', text: 'Yours?' },
      ],
      'a'.repeat(16),
    );
    const open = () =>
      c.openCall(
        'lead-1',
        last('lead-1').deliveryId,
        [
          { to: 'red-1', text: 'n?' },
          { to: 'orange-1', text: 'n?' },
        ],
        'a'.repeat(16),
      );
    if (outcome === 'opened') expect(open().messages).toHaveLength(2);
    else expect(open).toThrow("post_budget: a call of 2 needs 4 of the conversation's agent posts; 3 remain");
  });
});

describe('the nested gather times out (R35)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the parent outcome timed_out at its expiry', () => {
    const { c, nest, workersAnswer, outcomes } = team(1_000);
    const { top, question, child } = nest();
    c.ack('lead-1', question.deliveryId);
    workersAnswer(child);
    vi.advanceTimersByTime(1_000);
    expect(outcomes().filter(([call]) => call === top)).toContainEqual([top, 'lead-1', 'timed_out']);
  });
});

// ---------------------------------------------------------------- the SDK

const question: ConversationMessage = {
  id: 'q1',
  channel: 'main',
  conversation: 'c1',
  user: 'alice',
  from: 'top-1',
  to: 'lead-warm-1',
  kind: 'internal',
  text: "What are your colours' numbers?",
  at: '2026-10-02T00:00:00.000Z',
  call: { id: 'k1', role: 'question' },
};
const own = [COMMON_TOOL_DEFINITIONS.read_file];
const persona = {
  role: 'you lead the warm-colour workers.',
  guidance: [{ path: 'lead-warm.md', text: '1. Consult.\n' }],
  tools: own,
};
const turn = (message: ConversationMessage, nestedCalls: boolean) =>
  channelTurn({
    handle: 'lead-warm-1',
    others: ['top-1', 'red-1', 'orange-1'],
    persona: { ...persona, ...(nestedCalls ? { nestedCalls: true } : {}) },
    message,
    maxTokens: 1_024,
    memory: '',
  });

describe("a granted callee's call turn (R33)", () => {
  it('offers reply, consult and pass, then its own, with the nested call line in place of the fourth', () => {
    const request = turn(question, true);
    const standard = withGuidance(callInstructions('top-1', persona.role), persona.guidance);
    expect(present(request.messages[0], 'request.messages[0]').content).toBe(
      standard.replace(
        `Agent top-1 has asked you something. Answer with a tool call: reply to answer top-1, or pass if you cannot.`,
        nestedCallLine('top-1'),
      ),
    );
    expect(nestedCallLine('top-1')).toBe(
      'Agent top-1 has asked you something. Answer with a tool call: reply to answer top-1, consult to ask other agents first (their answers come back to you, and then you answer top-1), or pass if you cannot.',
    );
    expect(request.tools).toEqual([
      callAnswerTool('top-1'),
      consultTool(channelAgents('lead-warm-1', ['top-1', 'red-1', 'orange-1'])),
      CALL_PASS_TOOL,
      ...own,
    ]);
  });

  it('is byte for byte as before for a callee that is not granted', () => {
    const request = turn(question, false);
    expect(present(request.messages[0], 'request.messages[0]').content).toBe(
      withGuidance(callInstructions('top-1', persona.role), persona.guidance),
    );
    expect(request.tools).toEqual(callTools('top-1', own));
  });

  it("frames a nested gather as any gather, in a call turn answering its parent's asker", () => {
    const gather: ConversationMessage = {
      ...question,
      id: 'g1',
      from: 'asha',
      to: 'lead-warm-1',
      text: "Answers to lead-warm-1's call: 2 answered.",
      call: {
        id: 'k2',
        role: 'gather',
        context: { from: 'top-1', text: question.text },
        requests: [
          { to: 'red-1', text: 'n?' },
          { to: 'orange-1', text: 'n?' },
        ],
        answers: [
          { from: 'red-1', outcome: 'answered', text: '4' },
          { from: 'orange-1', outcome: 'answered', text: '7' },
        ],
        parent: { id: 'k1', asker: 'top-1' },
      },
    };
    const request = turn(gather, true);
    expect(request.messages).toEqual([
      { role: 'system', content: withGuidance(callInstructions('top-1', persona.role), persona.guidance) },
      { role: 'user', content: [identityLine('lead-warm-1'), describeMessage(gather, 'lead-warm-1')].join('\n\n') },
    ]);
    expect(request.tools).toEqual(callTools('top-1', own));
  });
});

describe('nestedCalls in a recipe (R33)', () => {
  const recipe = {
    id: 'lead',
    image: 'hello-world',
    description: 'x',
    prompt: 'x',
    model: 'm',
    startupTimeoutMs: 1,
    messageTimeoutMs: 1,
    chat: {},
    tools: [],
  };
  it('is true or absent', () => {
    expect(parseRecipe({ ...recipe, nestedCalls: true }, 'r.json').nestedCalls).toBe(true);
    expect(parseRecipe(recipe, 'r.json')).not.toHaveProperty('nestedCalls');
  });
  it.each(['yes', false, 1])('refuses %j at load', (value) => {
    expect(() => parseRecipe({ ...recipe, nestedCalls: value }, 'r.json')).toThrow(DefinitionError);
    expect(() => parseRecipe({ ...recipe, nestedCalls: value }, 'r.json')).toThrow(
      `r.json: nestedCalls must be true when given, not ${JSON.stringify(value)}`,
    );
  });
});

describe("a granted callee's consult, acted on (R33, R34)", () => {
  const consult = {
    id: 'c1',
    name: 'consult',
    arguments: {
      requests: [
        { to: 'red-1', text: 'Your number?' },
        { to: 'orange-1', text: 'Yours?' },
      ],
    },
  };
  const delivery: Delivery = {
    deliveryId: 'dq',
    message: question,
    traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01',
  };

  it('says it is working, then opens the call from the question it holds; nothing is answered', async () => {
    const posts: PostRequest[] = [];
    const consults: ConsultRequest[] = [];
    const answers: unknown[] = [];
    await act([consult], ['top-1', 'red-1', 'orange-1'], delivery, {
      post: (r) => {
        posts.push(r);
        return Promise.resolve(question);
      },
      consult: (r) => {
        consults.push(r);
        return Promise.resolve({ ok: true, value: { call: 'k2', messages: ['m1', 'm2'] } });
      },
      answerCall: (r) => {
        answers.push(r);
        return Promise.resolve({ ok: true, value: { message: question } });
      },
      log: new RecordingAgentLog(),
    });
    expect(posts).toEqual([{ conversation: 'c1', kind: 'status', text: 'ok' }]);
    expect(consults).toEqual([{ delivery: 'dq', requests: consult.arguments.requests }]);
    expect(answers).toEqual([]);
  });

  it('refuses, as a correction, a consult beside an answer in the same response', async () => {
    const sent: ChatRequest[] = [];
    const replies: ChatResponse[] = [
      { ok: true, text: '', toolCalls: [consult, { id: 'r1', name: 'reply', arguments: { text: '4, 7' } }] },
      { ok: true, text: '', toolCalls: [consult] },
    ];
    const calls = await decide({
      model: {
        chat: (r: ChatRequest) => {
          sent.push(r);
          return Promise.resolve(present(replies.shift(), 'replies.shift()'));
        },
      },
      request: turn(question, true),
      message: question,
      roster: ['top-1', 'red-1', 'orange-1'].map((handle) => ({ handle, recipe: 'x', description: 'x' })),
      maxRounds: 3,
      maxCorrections: 2,
    });
    expect(calls).toEqual([consult]);
    expect(present(sent[1], 'sent[1]').messages.at(-2)).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      content:
        'error: consult is made alone: not with reply in the same response. Put every agent in one consult, and reply once the answers are back.',
    });
  });
});
