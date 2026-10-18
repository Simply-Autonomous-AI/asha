import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Channel,
  ChannelNameInvalid,
  ChannelRequestInvalid,
  Channels,
  UnknownHandle,
  UserIdInvalid,
  noReplyText,
} from '../../src/daemon/channel/index.js';
import type {
  ChannelMessage,
  ConversationEvent,
  ConversationMessage,
  Delivery,
  WatchEvent,
} from '../../src/shared/protocol.js';
import { USER_ID_REASONS } from '../../src/shared/protocol.js';
import { present } from '../../src/shared/assert-present.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { DaemonTracer, type TraceRecord } from '../../src/daemon/traces/index.js';
import { MemoryUserLedger, RecordingLogger } from '../helpers/fakes.js';

const AT = '2026-09-26T12:00:00.000Z';
/** The sending agent's post span, as its traceparent names it. */
const POST_SPAN = 'feedfeedfeedfeed';

/** `inbox`'s box for `handle`, which setup's `join` always creates: missing would be the test's own bug. */
function box(inbox: Map<string, Delivery[]>, handle: string): Delivery[] {
  return present(inbox.get(handle), `inbox.get(${JSON.stringify(handle)})`);
}

/** The first (often only) delivery in `inbox`'s box for `handle`. */
function firstDelivery(inbox: Map<string, Delivery[]>, handle: string): Delivery {
  return present(box(inbox, handle)[0], `inbox.get(${JSON.stringify(handle)})[0]`);
}

function setup(name = 'main') {
  const logger = new RecordingLogger();
  const timeouts: { channel: string; handle: string; delivery: Delivery }[] = [];
  let n = 0;
  const spans: TraceRecord[] = [];
  let spanIds = 0;
  const tracer = new DaemonTracer({
    clock: () => new Date(AT),
    newSpanId: () => (++spanIds).toString(16).padStart(16, '0'),
    record: (r) => spans.push(r),
  });
  const channel = new Channel({
    name,
    logger,
    clock: () => new Date(AT),
    newId: () => `id${String(++n)}`,
    onDeliveryTimeout: (c, handle, delivery) => timeouts.push({ channel: c, handle, delivery }),
    maxAgentPostsPerConversation: 3,
    users: new MemoryUserLedger(),
    tracer,
  });
  const inbox = new Map<string, Delivery[]>();
  const join = (base: string, deliveryTimeoutMs = 1_000): string => {
    const box: Delivery[] = [];
    const handle = channel.join(base, { deliver: (d) => box.push(d), deliveryTimeoutMs });
    inbox.set(handle, box);
    return handle;
  };
  const events: ConversationEvent[] = [];
  /** The first user online on the channel: user-1. */
  const user = channel.claimUser();
  return { channel, logger, timeouts, inbox, join, events, user, spans };
}

describe('Channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('numbers each base name, and never reuses a number after an agent leaves', () => {
    const { channel, join } = setup();
    expect(join('hewo')).toBe('hewo-1');
    expect(join('hewo')).toBe('hewo-2');
    expect(join('scout')).toBe('scout-1');
    channel.leave('hewo-2', 'bye');
    expect(join('hewo')).toBe('hewo-3');
    expect(channel.handles()).toEqual(['hewo-1', 'hewo-3', 'scout-1']);
  });

  it.each(['user', 'Hewo', '1abc', 'a b', '', 'x'.repeat(33)])('refuses the agent name %j', (base) => {
    const { channel } = setup();
    expect(() => channel.join(base, { deliver: () => undefined, deliveryTimeoutMs: 1 })).toThrow(ChannelRequestInvalid);
  });

  it('delivers a user message to every member and starts a conversation named by its id', () => {
    const { channel, inbox, join } = setup();
    join('a');
    join('b');

    const message = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });

    expect(message).toEqual({
      id: 'id1',
      channel: 'main',
      conversation: 'id1',
      user: 'user-1',
      from: 'user-1',
      to: null,
      kind: 'input',
      text: 'hi',
      at: AT,
    });
    // Span 1 is the conversation's; each delivery names its own asha.delivery span, in the conversation's trace.
    expect(inbox.get('a-1')).toEqual([
      { deliveryId: 'id2', message, traceparent: `00-${traceIdFor('id1')}-0000000000000002-01` },
    ]);
    expect(inbox.get('b-1')).toEqual([
      { deliveryId: 'id3', message, traceparent: `00-${traceIdFor('id1')}-0000000000000003-01` },
    ]);
    expect(channel.working('id1')).toEqual(['a-1', 'b-1']);
  });

  it('delivers an addressed message to that agent alone, and only it counts as working', () => {
    const { channel, inbox, join } = setup();
    join('a');
    join('b');

    const message = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'just you', to: 'b-1' });

    expect(message.to).toBe('b-1');
    expect(inbox.get('a-1')).toEqual([]);
    expect(box(inbox, 'b-1').map((d) => d.message.id)).toEqual([message.id]);
    expect(channel.working(message.conversation)).toEqual(['b-1']);
  });

  it('lets an agent address another agent in the conversation', () => {
    const { channel, inbox, join } = setup();
    join('a');
    join('b');
    join('c');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });

    const handoff = channel.post({
      from: 'a-1',
      kind: 'internal',
      text: 'b, take this',
      conversation: user.conversation,
      to: 'b-1',
      parentSpanId: POST_SPAN,
    });

    expect(box(inbox, 'b-1').map((d) => d.message.id)).toEqual([user.id, handoff.id]);
    expect(box(inbox, 'c-1').map((d) => d.message.id)).toEqual([user.id]);
  });

  it('refuses an agent post past the per-conversation bound, ending its conversation budget_exceeded, counting each conversation separately (patterns-phase-3 R16)', () => {
    const { channel, join } = setup();
    join('a');
    join('b');
    const one = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    const two = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    for (const from of ['a-1', 'b-1', 'a-1'])
      channel.post({ from, kind: 'internal', text: 'x', conversation: one.conversation, parentSpanId: POST_SPAN });

    expect(() =>
      channel.post({
        from: 'b-1',
        kind: 'internal',
        text: 'x',
        conversation: one.conversation,
        parentSpanId: POST_SPAN,
      }),
    ).toThrow(
      `conversation_ended: conversation ${one.conversation} has ended (budget_exceeded): b-1's internal is not posted`,
    );
    expect(channel.isEnded(one.conversation)).toBe(true);
    expect(channel.isEnded(two.conversation)).toBe(false);
    expect(() =>
      channel.post({ from: 'a-1', kind: 'output', text: 'x', conversation: two.conversation, parentSpanId: POST_SPAN }),
    ).not.toThrow();
  });

  it("carries an agent's status to watchers without delivering it to agents or counting toward the bound", () => {
    const { channel, join, inbox, events } = setup();
    join('a');
    join('b');
    const channelEvents: WatchEvent[] = [];
    channel.watchAll((e) => channelEvents.push(e));
    const online = channel.post({ from: 'a-1', kind: 'status', text: 'Hi' });
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.watch(user.conversation, (e) => events.push(e));
    const working = channel.post({ from: 'a-1', kind: 'status', text: 'working', conversation: user.conversation });
    for (let i = 0; i < 5; i += 1)
      channel.post({ from: 'a-1', kind: 'status', text: 'working', conversation: user.conversation });

    expect(online).toEqual({
      id: 'id1',
      channel: 'main',
      conversation: null,
      from: 'a-1',
      to: null,
      kind: 'status',
      text: 'Hi',
      at: AT,
    });
    expect(working.conversation).toBe(user.conversation);
    expect(box(inbox, 'b-1').map((d) => d.message.kind)).toEqual(['input']);
    expect(events[0]).toEqual({ type: 'message', message: working, working: ['a-1', 'b-1'] });
    expect(channelEvents.slice(0, 3)).toEqual([
      { type: 'message', message: online },
      { type: 'message', message: user },
      { type: 'message', message: working },
    ]);
    // Six statuses, and agent messages are still allowed: statuses don't count toward the bound of 3.
    expect(() =>
      channel.post({
        from: 'a-1',
        kind: 'output',
        text: 'x',
        conversation: user.conversation,
        parentSpanId: POST_SPAN,
      }),
    ).not.toThrow();
  });

  it('refuses a status that is addressed, from a non-member, or for an unknown conversation', () => {
    const { channel, join } = setup();
    join('a');
    expect(() => channel.post({ from: 'a-1', kind: 'status', text: 'x', to: 'a-1' })).toThrow(
      'a status message is not addressed to anyone',
    );
    expect(() => channel.post({ from: 'ghost-1', kind: 'status', text: 'x' })).toThrow(
      'ghost-1 is not on channel "main"',
    );
    expect(() => channel.post({ from: 'a-1', kind: 'status', text: 'x', conversation: 'nope' })).toThrow(
      'unknown conversation nope',
    );
  });

  it('refuses to address an agent that is not on the channel, or oneself', () => {
    const { channel, join } = setup();
    join('a');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    const error = (() => {
      try {
        channel.postToConversation({ from: 'user-1', kind: 'input', text: 'x', to: 'ghost-1' });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(UnknownHandle);
    expect((error as Error).message).toBe('no agent "ghost-1" on channel "main"');
    expect(() =>
      channel.post({
        from: 'a-1',
        kind: 'internal',
        text: 'x',
        conversation: user.conversation,
        to: 'a-1',
        parentSpanId: POST_SPAN,
      }),
    ).toThrow('a-1 cannot address a message to itself');
  });

  it('does not deliver an agent its own message, and reports it to watchers with the working set', () => {
    const { channel, inbox, join, events } = setup();
    join('a');
    join('b');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.watch(user.conversation, (e) => events.push(e));

    const reply = channel.post({
      from: 'a-1',
      kind: 'internal',
      text: 'b, take half',
      conversation: user.conversation,
      parentSpanId: POST_SPAN,
    });

    expect(box(inbox, 'a-1').map((d) => d.message.id)).toEqual([user.id]);
    expect(box(inbox, 'b-1').map((d) => d.message.id)).toEqual([user.id, reply.id]);
    expect(events).toEqual([{ type: 'message', message: reply, working: ['a-1', 'b-1'] }]);
  });

  it('an agent stops working on a conversation when it acks its last delivery there', () => {
    const { channel, inbox, join, events } = setup();
    join('a');
    join('b');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.watch(user.conversation, (e) => events.push(e));

    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    channel.ack('b-1', firstDelivery(inbox, 'b-1').deliveryId);

    // Neither replied, so the harness answers the user before the status that shows nobody working.
    expect(events).toEqual([
      { type: 'status', conversation: user.conversation, working: ['b-1'] },
      {
        type: 'message',
        working: [],
        message: {
          id: 'id4',
          channel: 'main',
          conversation: user.conversation,
          user: 'user-1',
          from: 'asha',
          to: 'user-1',
          kind: 'output',
          text: 'No agent could answer this:\n- a-1 received it but said nothing\n- b-1 received it but said nothing',
          at: AT,
        },
      },
      { type: 'status', conversation: user.conversation, working: [] },
    ]);
  });

  it('keeps conversations separate: work in one does not count in another', () => {
    const { channel, inbox, join } = setup();
    join('a');
    const one = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'one' });
    const two = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'two' });
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);

    expect(channel.working(one.conversation)).toEqual([]);
    expect(channel.working(two.conversation)).toEqual(['a-1']);
  });

  it('rejects an ack for a delivery the agent does not hold', () => {
    const { channel, inbox, join } = setup();
    join('a');
    join('b');
    channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    const bDelivery = firstDelivery(inbox, 'b-1').deliveryId;

    expect(() => {
      channel.ack('a-1', bDelivery);
    }).toThrow(`a-1 holds no delivery ${bDelivery}`);
    channel.ack('b-1', bDelivery);
    expect(() => {
      channel.ack('b-1', bDelivery);
    }).toThrow(`b-1 holds no delivery ${bDelivery}`);
  });

  it.each([
    ['a non-member', 'ghost-1', 'id1', 'ghost-1 is not on channel "main"'],
    ['an unknown conversation', 'a-1', 'nope', 'unknown conversation nope'],
    ['a missing conversation', 'a-1', undefined, 'unknown conversation undefined'],
  ] as const)('rejects a post from %s', (_, from, conversation, message) => {
    const { channel, join } = setup();
    join('a');
    channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    expect(() =>
      channel.post({
        from,
        kind: 'output',
        text: 'x',
        parentSpanId: POST_SPAN,
        ...(conversation === undefined ? {} : { conversation }),
      }),
    ).toThrow(message);
  });

  it('a leaving agent stops counting as working, and conversation watchers see it leave', () => {
    const { channel, join, events, logger } = setup();
    join('a');
    join('b');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.watch(user.conversation, (e) => events.push(e));

    channel.leave('a-1', 'container exited with code 1');

    expect(events).toEqual([
      {
        type: 'agent_left',
        conversation: user.conversation,
        agent: 'a-1',
        detail: 'container exited with code 1',
        working: ['b-1'],
      },
    ]);
    expect(channel.isMember('a-1')).toBe(false);
    expect(logger.entries.at(-1)).toEqual({
      level: 'info',
      event: 'channel.left',
      fields: {
        channel: 'main',
        handle: 'a-1',
        detail: 'container exited with code 1',
        abandoned: [user.conversation],
      },
    });
  });

  it('expires a delivery held past its bound, logs it as an error, reports the agent, and updates watchers', () => {
    const { channel, join, timeouts, logger, inbox, events } = setup();
    join('slow', 500);
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.watch(user.conversation, (e) => events.push(e));

    vi.advanceTimersByTime(499);
    expect(timeouts).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(timeouts).toEqual([{ channel: 'main', handle: 'slow-1', delivery: box(inbox, 'slow-1')[0] }]);
    expect(channel.working(user.conversation)).toEqual([]);
    expect(events).toEqual([
      {
        type: 'message',
        working: [],
        message: expect.objectContaining({
          from: 'asha',
          to: 'user-1',
          kind: 'output',
          text: 'No agent could answer this:\n- slow-1 did not finish in time',
        }) as unknown as ConversationMessage,
      },
      { type: 'status', conversation: user.conversation, working: [] },
    ]);
    expect(logger.events('error')).toEqual(['channel.delivery_timeout']);
  });

  it('an acked delivery never expires', () => {
    const { channel, join, timeouts, inbox } = setup();
    join('a', 500);
    channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    vi.advanceTimersByTime(5_000);
    expect(timeouts).toEqual([]);
  });

  it('a channel watcher sees joins, every message of every kind and conversation, and leaves', () => {
    const { channel, join } = setup();
    const seen: WatchEvent[] = [];
    const unwatch = channel.watchAll((e) => seen.push(e));
    join('a');
    const one = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'one' });
    const note = channel.post({
      from: 'a-1',
      kind: 'internal',
      text: 'thinking',
      conversation: one.conversation,
      parentSpanId: POST_SPAN,
    });
    const two = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'two', to: 'a-1' });
    const reply = channel.post({
      from: 'a-1',
      kind: 'output',
      text: 'done',
      conversation: two.conversation,
      parentSpanId: POST_SPAN,
    });
    channel.leave('a-1', 'bye');
    unwatch();
    join('b');

    expect(seen).toEqual([
      { type: 'agent_joined', agent: 'a-1' },
      { type: 'message', message: one },
      { type: 'message', message: note },
      { type: 'message', message: two },
      { type: 'message', message: reply },
      { type: 'agent_left', agent: 'a-1', detail: 'bye' },
      // a-1 left holding conversation one, which nobody had answered: the harness answers it
      // (before conversation watchers hear of the leave; the channel watcher heard it first).
      {
        type: 'message',
        message: expect.objectContaining({
          conversation: one.conversation,
          from: 'asha',
          to: 'user-1',
          kind: 'output',
          text: 'No agent could answer this:\n- a-1 left the channel before replying (bye)',
        }) as unknown as ChannelMessage,
      },
    ]);
  });

  it('stops notifying a conversation watcher after it unsubscribes', () => {
    const { channel, join, events, inbox } = setup();
    join('a');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    const unwatch = channel.watch(user.conversation, (e) => events.push(e));
    unwatch();
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    expect(events).toEqual([]);
  });
});

describe('user identity on every conversation message', () => {
  it('carries the user who started the conversation on every message in it, however many agents it passes through', () => {
    const { channel, inbox, join } = setup();
    join('a');
    join('b');
    const input = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'ask b', to: 'a-1' });
    const status = channel.post({ from: 'a-1', kind: 'status', text: 'ok', conversation: input.conversation });
    const task = channel.post({
      from: 'a-1',
      kind: 'internal',
      text: 'Say: hi',
      conversation: input.conversation,
      to: 'b-1',
      parentSpanId: POST_SPAN,
    });
    const broadcast = channel.post({
      from: 'b-1',
      kind: 'internal',
      text: 'anyone?',
      conversation: input.conversation,
      parentSpanId: POST_SPAN,
    });
    const reply = channel.post({
      from: 'b-1',
      kind: 'output',
      text: 'hi',
      conversation: input.conversation,
      parentSpanId: POST_SPAN,
    });

    for (const m of [input, status, task, broadcast, reply])
      expect(m).toEqual(expect.objectContaining({ conversation: input.conversation, user: 'user-1' }));
    // The delegated task reached b-1 with the user it started with.
    expect(box(inbox, 'b-1').map((d) => [d.message.text, d.message.user])).toEqual([['Say: hi', 'user-1']]);
  });

  it("keeps two users apart when both talk at once: each message carries its own conversation's user", () => {
    const { channel, inbox, join } = setup();
    join('a');
    const alice = channel.claimUser('alice');
    const one = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'mine' });
    const two = channel.postToConversation({ from: alice.id, kind: 'input', text: 'hers' });
    channel.post({ from: 'a-1', kind: 'status', text: 'ok', conversation: two.conversation });
    channel.post({ from: 'a-1', kind: 'status', text: 'ok', conversation: one.conversation });

    expect(box(inbox, 'a-1').map((d) => [d.message.text, d.message.user])).toEqual([
      ['mine', 'user-1'],
      ['hers', 'alice'],
    ]);
  });

  it('a status with no conversation (a presence, like "Hi") carries no user', () => {
    const { channel, join } = setup();
    join('a');
    expect(channel.post({ from: 'a-1', kind: 'status', text: 'Hi' })).not.toHaveProperty('user');
  });
});

describe('the harness reply when no agent answers', () => {
  it("reports each agent's pass reason, once, and logs it", () => {
    const { channel, inbox, join, events, logger } = setup();
    join('a');
    join('b');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'translate this' });
    channel.watch(user.conversation, (e) => events.push(e));
    channel.post({ from: 'a-1', kind: 'status', text: 'pass: not my role', conversation: user.conversation });
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    channel.post({ from: 'b-1', kind: 'status', text: 'pass', conversation: user.conversation });
    channel.ack('b-1', firstDelivery(inbox, 'b-1').deliveryId);
    channel.concludeIfUnanswered(user.conversation);

    const replies = events.filter((e) => e.type === 'message' && e.message.kind === 'output');
    const expected: ConversationEvent[] = [
      {
        type: 'message',
        working: [],
        message: expect.objectContaining({
          from: 'asha',
          to: 'user-1',
          text: 'No agent could answer this:\n- a-1 passed: not my role\n- b-1 passed',
        }) as unknown as ConversationMessage,
      },
    ];
    expect(replies).toEqual(expected);
    expect(logger.events()).toContain('channel.no_reply');
  });

  it('says an agent worked on it but sent no reply when it said ok and nothing reached the user', () => {
    const { channel, inbox, join, events } = setup();
    join('a');
    join('b');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go', to: 'a-1' });
    channel.watch(user.conversation, (e) => events.push(e));
    channel.post({ from: 'a-1', kind: 'status', text: 'ok', conversation: user.conversation });
    channel.post({
      from: 'a-1',
      kind: 'internal',
      text: 'Say: go',
      conversation: user.conversation,
      to: 'b-1',
      parentSpanId: POST_SPAN,
    });
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    channel.post({ from: 'b-1', kind: 'status', text: 'pass: cannot', conversation: user.conversation });
    channel.ack('b-1', firstDelivery(inbox, 'b-1').deliveryId);

    const reply = events.find((e) => e.type === 'message' && e.message.from === 'asha');
    expect(reply).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          text: 'No agent could answer this:\n- a-1 worked on it but sent you no reply\n- b-1 passed: cannot',
        }) as unknown as ConversationMessage,
      }),
    );
  });

  it('stays quiet when an agent replied, even after everyone finishes', () => {
    const { channel, inbox, join, events } = setup();
    join('a');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.watch(user.conversation, (e) => events.push(e));
    channel.post({
      from: 'a-1',
      kind: 'output',
      text: 'done',
      conversation: user.conversation,
      parentSpanId: POST_SPAN,
    });
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    channel.concludeIfUnanswered(user.conversation);
    expect(events.filter((e) => e.type === 'message' && e.message.from === 'asha')).toEqual([]);
  });

  it('does not answer while an agent is still working', () => {
    const { channel, inbox, join, events } = setup();
    join('a');
    join('b');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.watch(user.conversation, (e) => events.push(e));
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    channel.concludeIfUnanswered(user.conversation);
    expect(events.filter((e) => e.type === 'message')).toEqual([]);
    expect(channel.working(user.conversation)).toEqual(['b-1']);
  });

  it('answers at once a message that no agent received', () => {
    const { channel, events } = setup('empty');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'anyone?' });
    channel.watch(user.conversation, (e) => events.push(e));
    channel.concludeIfUnanswered(user.conversation);
    const expected: ConversationEvent[] = [
      {
        type: 'message',
        working: [],
        message: expect.objectContaining({
          from: 'asha',
          to: 'user-1',
          text: 'No agent on channel "empty" received this, so nobody could answer it.',
        }) as unknown as ConversationMessage,
      },
    ];
    expect(events).toEqual(expected);
  });

  it('when the last agent leaves unanswered, a conversation watcher gets the harness reply before the leave', () => {
    const { channel, join, events } = setup();
    join('a');
    const user = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.watch(user.conversation, (e) => events.push(e));
    channel.leave('a-1', 'container exited with code 1');
    expect(events).toEqual([
      {
        type: 'message',
        working: [],
        message: expect.objectContaining({
          from: 'asha',
          text: 'No agent could answer this:\n- a-1 left the channel before replying (container exited with code 1)',
        }) as unknown as ConversationMessage,
      },
      {
        type: 'agent_left',
        conversation: user.conversation,
        agent: 'a-1',
        detail: 'container exited with code 1',
        working: [],
      },
    ]);
  });

  it('refuses an unknown conversation loudly', () => {
    const { channel } = setup();
    expect(() => {
      channel.concludeIfUnanswered('nope');
    }).toThrow('concludeIfUnanswered: unknown conversation nope');
  });

  it('noReplyText lists agents in the order they received the message', () => {
    expect(
      noReplyText(
        'main',
        new Map([
          ['b-1', 'pass: busy'],
          ['a-1', 'did not finish in time'],
        ]),
      ),
    ).toBe('No agent could answer this:\n- b-1 passed: busy\n- a-1 did not finish in time');
  });

  it("no user may take the harness's handle", () => {
    const { channel } = setup();
    expect(() => channel.claimUser('asha')).toThrow(UserIdInvalid);
  });
});

describe('Channel users', () => {
  it('issues a new user-<n> for each unnamed user and never reuses one, even after it goes offline', () => {
    const { channel, user } = setup();
    expect(user.id).toBe('user-1');
    expect(channel.claimUser().id).toBe('user-2');
    user.release();
    expect(channel.users()).toEqual(['user-2']);
    expect(channel.claimUser().id).toBe('user-3');
  });

  it('never issues a number a user named themselves', () => {
    const { channel } = setup();
    expect(channel.claimUser('user-5').id).toBe('user-5');
    expect(channel.claimUser().id).toBe('user-6');
  });

  it('gives a user the ID they ask for, counting each open conversation', () => {
    const { channel } = setup();
    const a = channel.claimUser('alice');
    const b = channel.claimUser('alice');
    expect([a.id, b.id]).toEqual(['alice', 'alice']);
    a.release();
    expect(channel.users()).toContain('alice');
    b.release();
    b.release();
    expect(channel.users()).not.toContain('alice');
    expect(channel.claimUser('user-7').id).toBe('user-7');
  });

  // The shared user-ID rule (cli-interactive R16): claimUser gives the same reasons as the CLI for rules (1), (3), (4).
  it.each([
    ['hewo-3', 'number'],
    ['Alice', 'pattern'],
    ['a b', 'pattern'],
    ['', 'pattern'],
    ['user-0', 'number'],
    ['asha', 'harness'],
  ] as const)("refuses the user ID %j with the rule's reason (%s)", (id, rule) => {
    const claim = () => setup().channel.claimUser(id);
    expect(claim).toThrow(UserIdInvalid);
    expect(claim).toThrow(`"${id}" cannot be a user ID: ${USER_ID_REASONS[rule]}`);
  });

  it('accepts a typed user-3, which only the default may not take', () => {
    expect(setup().channel.claimUser('user-3').id).toBe('user-3');
  });

  it('addresses an output to the user who started the conversation and delivers it to no agent', () => {
    const { channel, join, inbox } = setup();
    join('a');
    join('b');
    const alice = channel.claimUser('alice');
    const asked = channel.postToConversation({ from: alice.id, kind: 'input', text: 'go' });

    const reply = channel.postToConversation({
      from: 'a-1',
      kind: 'output',
      text: 'done',
      conversation: asked.conversation,
      parentSpanId: POST_SPAN,
    });

    expect(reply.to).toBe('alice');
    expect(box(inbox, 'b-1').map((d) => d.message.kind)).toEqual(['input']);
    expect(() =>
      channel.postToConversation({
        from: 'a-1',
        kind: 'output',
        text: 'x',
        conversation: asked.conversation,
        to: 'b-1',
        parentSpanId: POST_SPAN,
      }),
    ).toThrow('an output always goes to the user who asked');
  });

  it('refuses an input from anyone but an online user', () => {
    const { channel, join } = setup();
    join('a');
    expect(() => channel.postToConversation({ from: 'a-1', kind: 'input', text: 'x' })).toThrow(
      'an input comes from an online user',
    );
    expect(() => channel.postToConversation({ from: 'user-9', kind: 'input', text: 'x' })).toThrow(
      'an input comes from an online user',
    );
  });
});

describe('Channels', () => {
  const props = {
    logger: new RecordingLogger(),
    clock: () => new Date(AT),
    newId: () => 'x',
    onDeliveryTimeout: () => undefined,
    maxAgentPostsPerConversation: 3,
    users: new MemoryUserLedger(),
    tracer: new DaemonTracer({ clock: () => new Date(AT), newSpanId: () => 'a'.repeat(16), record: () => undefined }),
  };

  it('creates a channel on first use and returns the same one after', () => {
    const channels = new Channels(props);
    const lab = channels.get('lab');
    expect(lab.name).toBe('lab');
    expect(channels.get('lab')).toBe(lab);
    expect(channels.get('main')).not.toBe(lab);
  });

  it("existing() finds a channel already used and creates none for a name nothing used (the portal's telemetry poll)", () => {
    const channels = new Channels(props);
    expect(channels.existing('lab')).toBeUndefined();
    expect(channels.existing('lab')).toBeUndefined();
    const lab = channels.get('lab');
    expect(channels.existing('lab')).toBe(lab);
    expect(channels.existing('main')).toBeUndefined();
  });

  it('keeps agents on different channels apart, each numbered on its own', () => {
    const channels = new Channels(props);
    const deliver = { deliver: () => undefined, deliveryTimeoutMs: 1_000 };
    expect(channels.get('main').join('hewo', deliver)).toBe('hewo-1');
    expect(channels.get('lab').join('hewo', deliver)).toBe('hewo-1');
    expect(channels.get('main').handles()).toEqual(['hewo-1']);
    expect(channels.get('lab').handles()).toEqual(['hewo-1']);
  });

  it.each(['', 'Main', '-x', 'a/b'])('refuses the channel name %j', (name) => {
    expect(() => new Channels(props).get(name)).toThrow(ChannelNameInvalid);
  });
});

describe('Channel spans (docs/plans/otel-traces.md R5, A8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const span = (n: number): string => n.toString(16).padStart(16, '0');
  const summary = (
    spans: readonly {
      name: string;
      spanId: string;
      parentSpanId: string | null;
      handle: string;
      status: string;
      reason: string | null;
    }[],
  ) => spans.map((r) => [r.name, r.spanId, r.parentSpanId, r.handle, r.status, r.reason]);

  it("links conversation → delivery → (the post) → delivery, all in the conversation's trace, ending ok when an agent replied", () => {
    const { channel, join, inbox, spans } = setup();
    join('a');
    join('b');
    const input = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go', to: 'a-1' });
    expect(spans).toEqual([]);
    channel.post({
      from: 'a-1',
      kind: 'internal',
      text: 'b, do it',
      conversation: input.conversation,
      to: 'b-1',
      parentSpanId: POST_SPAN,
    });
    channel.post({
      from: 'b-1',
      kind: 'output',
      text: 'done',
      conversation: input.conversation,
      parentSpanId: POST_SPAN,
    });
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    expect(summary(spans)).toEqual([['asha.delivery', span(2), span(1), 'a-1', 'ok', null]]);
    channel.ack('b-1', firstDelivery(inbox, 'b-1').deliveryId);
    expect(summary(spans)).toEqual([
      ['asha.delivery', span(2), span(1), 'a-1', 'ok', null],
      ['asha.delivery', span(3), POST_SPAN, 'b-1', 'ok', null],
      ['asha.conversation', span(1), null, 'asha', 'ok', null],
    ]);
    expect(new Set(spans.map((r) => r.traceId))).toEqual(new Set([traceIdFor(input.conversation)]));
    expect(new Set(spans.map((r) => r.channel))).toEqual(new Set(['main']));
    expect(firstDelivery(inbox, 'b-1').traceparent).toBe(`00-${traceIdFor(input.conversation)}-${span(3)}-01`);
  });

  it('ends a delivery that expires error/expired, and the conversation error/unanswered, before the status that shows nobody working', () => {
    const { channel, join, spans, events } = setup();
    join('a', 1_000);
    const input = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    const seen: string[] = [];
    channel.watch(input.conversation, (e) => {
      events.push(e);
      // What was on record when each event went out.
      seen.push(`${e.type}:${spans.map((r) => r.name).join(',')}`);
    });
    vi.advanceTimersByTime(1_000);
    expect(summary(spans)).toEqual([
      ['asha.delivery', span(2), span(1), 'a-1', 'error', 'expired'],
      ['asha.conversation', span(1), null, 'asha', 'error', 'unanswered'],
    ]);
    expect(seen).toEqual(['message:asha.delivery,asha.conversation', 'status:asha.delivery,asha.conversation']);
    expect(events.at(-1)).toEqual({ type: 'status', conversation: input.conversation, working: [] });
  });

  it('ends the delivery of an agent that leaves holding it error/agent_left', () => {
    const { channel, join, spans } = setup();
    join('a');
    join('b');
    channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    channel.leave('a-1', 'container exited with code 137');
    expect(summary(spans)).toEqual([['asha.delivery', span(2), span(1), 'a-1', 'error', 'agent_left']]);
    channel.leave('b-1', 'container exited with code 137');
    expect(summary(spans)).toEqual([
      ['asha.delivery', span(2), span(1), 'a-1', 'error', 'agent_left'],
      ['asha.delivery', span(3), span(1), 'b-1', 'error', 'agent_left'],
      ['asha.conversation', span(1), null, 'asha', 'error', 'unanswered'],
    ]);
  });

  it('ends a conversation the harness concludes error/unanswered, before its status event', () => {
    const { channel, join, inbox, spans } = setup();
    join('a');
    const input = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    const order: string[] = [];
    channel.watch(input.conversation, (e) => order.push(`${e.type}:${String(spans.length)}`));
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    expect(summary(spans)).toEqual([
      ['asha.delivery', span(2), span(1), 'a-1', 'ok', null],
      ['asha.conversation', span(1), null, 'asha', 'error', 'unanswered'],
    ]);
    // Both records were written before the harness's reply and the status that shows nobody working.
    expect(order).toEqual(['message:2', 'status:2']);
  });

  it('ends a conversation no agent received at once, error/unanswered', () => {
    const { channel, spans } = setup();
    const input = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'anyone?' });
    channel.concludeIfUnanswered(input.conversation);
    expect(summary(spans)).toEqual([['asha.conversation', span(1), null, 'asha', 'error', 'unanswered']]);
  });

  it('ends the conversation only the first time its working set empties', () => {
    const { channel, join, inbox, spans } = setup();
    join('a');
    join('b');
    const input = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go', to: 'a-1' });
    channel.post({
      from: 'a-1',
      kind: 'output',
      text: 'done',
      conversation: input.conversation,
      parentSpanId: POST_SPAN,
    });
    channel.ack('a-1', firstDelivery(inbox, 'a-1').deliveryId);
    channel.post({
      from: 'a-1',
      kind: 'internal',
      text: 'b, later',
      conversation: input.conversation,
      to: 'b-1',
      parentSpanId: POST_SPAN,
    });
    channel.ack('b-1', firstDelivery(inbox, 'b-1').deliveryId);
    expect(spans.filter((r) => r.name === 'asha.conversation')).toHaveLength(1);
    expect(summary(spans).at(-1)).toEqual(['asha.delivery', span(3), POST_SPAN, 'b-1', 'ok', null]);
  });

  it("refuses, as a harness defect, an agent's message with deliveries but no post span", () => {
    const { channel, join } = setup();
    join('a');
    join('b');
    const input = channel.postToConversation({ from: 'user-1', kind: 'input', text: 'go' });
    expect(() => channel.post({ from: 'a-1', kind: 'internal', text: 'x', conversation: input.conversation })).toThrow(
      "an agent's internal message carries its post span",
    );
  });
});
