// The channel's side of a restart and of the end of a conversation (docs/plans/patterns-phase-3.md R12, R18; A8, A10):
// a suspended member keeps its handle and its deliveries, holds new ones and counts as working, and a rejoin then a
// resume re-sends what it held, in posting order, carrying `restarted`, each bound started afresh; a conversation the
// harness ends gives its watchers one `error` event and one `channel.conversation_ended` record however many refusals
// follow, refuses every agent post, status, consult and answer in it `conversation_ended`, lets a call open at the end
// run to its gather, posts no harness reply, and settles once nobody works on it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallRefused, Channel } from '../../src/daemon/channel/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { DaemonTracer, type TraceRecord } from '../../src/daemon/traces/index.js';
import type { CallRefusalReason, ConversationEvent, Delivery } from '../../src/shared/protocol.js';
import { MemoryUserLedger, RecordingLogger } from '../helpers/fakes.js';

const POST = 'feedfeedfeedfeed';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const logger = new RecordingLogger();
  let n = 0;
  const spans: TraceRecord[] = [];
  let spanIds = 0;
  const clock = () => new Date(Date.now());
  const channel = new Channel({
    name: 'main',
    logger,
    clock,
    newId: () => `id${String(++n)}`,
    onDeliveryTimeout: () => undefined,
    maxAgentPostsPerConversation: 32,
    users: new MemoryUserLedger(),
    tracer: new DaemonTracer({
      clock,
      newSpanId: () => (++spanIds).toString(16).padStart(16, '0'),
      record: (r) => spans.push(r),
    }),
  });
  const inbox = new Map<string, Delivery[]>();
  const member = (handle: string, timeoutMs = 10_000) => ({
    deliver: (d: Delivery) => inbox.set(handle, [...(inbox.get(handle) ?? []), d]),
    deliveryTimeoutMs: timeoutMs,
  });
  const join = (base: string): string => channel.join(base, member(`${base}-1`));
  const user = channel.claimUser('alice');
  const events: ConversationEvent[] = [];
  const ask = (to: string | undefined, text = 'hi', budget?: { posts?: number; tokens?: number }): string => {
    const message = channel.postToConversation({
      from: user.id,
      kind: 'input',
      text,
      ...(to === undefined ? {} : { to }),
      ...(budget === undefined ? {} : { budget }),
    });
    channel.watch(message.conversation, (e) => events.push(e));
    return message.conversation;
  };
  const at = (event: string) => logger.entries.filter((e) => e.event === event);
  /** The most recent delivery to `handle`. */
  const last = (handle: string): Delivery =>
    present(present(inbox.get(handle), `inbox for ${handle}`).at(-1), `last delivery for ${handle}`);
  return { channel, logger, inbox, member, join, user, events, ask, at, spans, last };
}

function refusal(fn: () => unknown): CallRefusalReason {
  try {
    fn();
  } catch (error) {
    if (error instanceof CallRefused) return error.reason;
    throw error;
  }
  throw new Error('not refused');
}

describe('a suspended member (R12, A8)', () => {
  it('keeps its handle and its deliveries, their bounds cleared; holds a new one; counts as working; and a resume re-sends them in posting order with restarted, bounds afresh', async () => {
    const t = setup();
    t.join('work');
    const one = t.ask('work-1', 'first');
    t.channel.suspend('work-1');
    // Its bound was cleared: no expiry while it is suspended.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.at('channel.delivery_timeout')).toEqual([]);
    const two = t.ask('work-1', 'second');
    expect(present(t.inbox.get('work-1'), "inbox for 'work-1'").map((d) => d.message.text)).toEqual(['first']);
    expect(t.channel.working(one)).toEqual(['work-1']);
    expect(t.channel.working(two)).toEqual(['work-1']);
    expect(t.channel.handles()).toEqual(['work-1']);
    expect(t.channel.isSuspended('work-1')).toBe(true);
    expect(t.channel.heldConversations('work-1')).toEqual([one, two]);
    expect(t.channel.mostResent('work-1')).toBe(0);
    // The restarted agent's connection takes the member's place: same handle, still holding.
    const resent: Delivery[] = [];
    expect(t.channel.rejoin('work-1', { deliver: (d) => resent.push(d), deliveryTimeoutMs: 5_000 })).toBe('work-1');
    expect(resent).toEqual([]);
    expect(t.channel.resume('work-1', 1)).toBe(2);
    expect(resent.map((d) => [d.message.conversation, d.message.text, d.message.restarted])).toEqual([
      [one, 'first', { attempt: 1 }],
      [two, 'second', { attempt: 1 }],
    ]);
    // The first keeps its delivery id: the agent acks the delivery it was first sent as.
    expect(present(resent[0], 'resent[0]').deliveryId).toBe(
      present(present(t.inbox.get('work-1'), "inbox for 'work-1'")[0], "inbox for 'work-1', entry 0").deliveryId,
    );
    expect(t.channel.mostResent('work-1')).toBe(1);
    expect(t.channel.isSuspended('work-1')).toBe(false);
    // Each bound starts at the re-send: the new member's 5 s.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(t.at('channel.delivery_timeout')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.at('channel.delivery_timeout')).toHaveLength(2);
    expect(t.at('channel.joined')).toHaveLength(1);
    expect(t.at('channel.suspended').map((e) => e.fields)).toEqual([{ channel: 'main', handle: 'work-1', held: 1 }]);
    expect(t.at('channel.resumed').map((e) => e.fields)).toEqual([
      { channel: 'main', handle: 'work-1', attempt: 1, redelivered: 2 },
    ]);
  });

  it('refuses a rejoin of a handle that is not suspended', () => {
    const t = setup();
    t.join('work');
    expect(() => t.channel.rejoin('work-1', t.member('work-1'))).toThrow(
      'work-1 is not a suspended member of channel "main"',
    );
    expect(() => t.channel.rejoin('nobody-1', t.member('nobody-1'))).toThrow(
      'nobody-1 is not a suspended member of channel "main"',
    );
  });

  it('a suspended member that leaves takes its deliveries with it, as any member does', () => {
    const t = setup();
    t.join('work');
    const c = t.ask('work-1');
    t.channel.suspend('work-1');
    t.channel.leave('work-1', 'restart limit reached');
    expect(t.channel.handles()).toEqual([]);
    expect(t.channel.working(c)).toEqual([]);
    expect(t.channel.isSuspended('work-1')).toBe(false);
  });
});

describe('the end of a conversation (R18, A10)', () => {
  it('logs one channel.conversation_ended with exactly its fields and sends one error event, however many ends and refusals follow', () => {
    const t = setup();
    t.join('ping');
    const c = t.ask('ping-1', 'secret words');
    t.channel.end(c, 'budget_exceeded', `conversation ${c} reached its budget of 8 agent posts`);
    t.channel.end(c, 'restart_limit', 'again');
    for (let i = 0; i < 3; i += 1)
      expect(
        refusal(() =>
          t.channel.post({ from: 'ping-1', kind: 'internal', text: 'ping', conversation: c, parentSpanId: POST }),
        ),
      ).toBe('conversation_ended');
    expect(t.events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', reason: 'budget_exceeded', detail: `conversation ${c} reached its budget of 8 agent posts` },
    ]);
    const ended = t.at('channel.conversation_ended');
    expect(ended.map((e) => [e.level, Object.keys(e.fields).sort(byCodeUnit)])).toEqual([
      ['error', ['channel', 'conversation', 'detail', 'error', 'reason']],
    ]);
    expect(present(ended[0], 'ended[0]').fields).toMatchObject({
      channel: 'main',
      conversation: c,
      reason: 'budget_exceeded',
      detail: `conversation ${c} reached its budget of 8 agent posts`,
    });
    // Never a message's text, never its user.
    expect(JSON.stringify(ended)).not.toContain('secret words');
    expect(JSON.stringify(ended)).not.toContain('alice');
    expect(t.channel.isEnded(c)).toBe(true);
  });

  it('refuses every agent post kind in it — internal, output, status — and a consult and an answer, posting nothing', () => {
    const t = setup();
    t.join('lead');
    t.join('helper');
    const c = t.ask('lead-1');
    const held = t.last('lead-1');
    t.channel.openCall('lead-1', held.deliveryId, [{ to: 'helper-1', text: 'What?' }], POST);
    const question = t.last('helper-1');
    t.channel.end(c, 'budget_exceeded', 'ended');
    const posted = t.at('channel.posted').length;
    const statuses = t.at('channel.status').length;
    expect(
      refusal(() =>
        t.channel.post({
          from: 'lead-1',
          kind: 'internal',
          text: 'x',
          to: 'helper-1',
          conversation: c,
          parentSpanId: POST,
        }),
      ),
    ).toBe('conversation_ended');
    expect(
      refusal(() => t.channel.post({ from: 'lead-1', kind: 'output', text: 'x', conversation: c, parentSpanId: POST })),
    ).toBe('conversation_ended');
    expect(refusal(() => t.channel.post({ from: 'lead-1', kind: 'status', text: 'ok', conversation: c }))).toBe(
      'conversation_ended',
    );
    expect(refusal(() => t.channel.answerCall('helper-1', question.deliveryId, { text: 'yes' }))).toBe(
      'conversation_ended',
    );
    expect(refusal(() => t.channel.answerCall('helper-1', question.deliveryId, { pass: 'no' }))).toBe(
      'conversation_ended',
    );
    expect(t.at('channel.posted')).toHaveLength(posted);
    expect(t.at('channel.status')).toHaveLength(statuses);
    // A status about itself, in no conversation, is not this conversation's: still posted.
    t.channel.post({ from: 'lead-1', kind: 'status', text: 'Hi' });
  });

  it('refuses a consult in it', () => {
    const t = setup();
    t.join('lead');
    t.join('helper');
    const c = t.ask('lead-1');
    t.channel.end(c, 'budget_exceeded', 'ended');
    expect(
      refusal(() =>
        t.channel.openCall('lead-1', t.last('lead-1').deliveryId, [{ to: 'helper-1', text: 'What?' }], POST),
      ),
    ).toBe('conversation_ended');
  });

  it("lets a call open at the end run to its gather: the refused answer's ack records unanswered; then no harness reply, and it settles once nobody works", () => {
    const t = setup();
    t.join('lead');
    t.join('helper');
    const c = t.ask('lead-1');
    const held = t.last('lead-1');
    const { call } = t.channel.openCall('lead-1', held.deliveryId, [{ to: 'helper-1', text: 'What?' }], POST);
    t.channel.ack('lead-1', held.deliveryId);
    t.channel.end(c, 'budget_exceeded', 'ended');
    let settled = false;
    t.channel.whenSettled(c, () => (settled = true));
    const question = t.last('helper-1');
    expect(refusal(() => t.channel.answerCall('helper-1', question.deliveryId, { text: 'yes' }))).toBe(
      'conversation_ended',
    );
    t.channel.ack('helper-1', question.deliveryId);
    const gather = t.last('lead-1');
    expect(gather.message.call).toMatchObject({
      id: call,
      role: 'gather',
      answers: [{ from: 'helper-1', outcome: 'unanswered' }],
    });
    expect(t.channel.working(c)).toEqual(['lead-1']);
    expect(settled).toBe(false);
    // The caller's reply is refused in turn; its ack ends the work.
    expect(
      refusal(() => t.channel.post({ from: 'lead-1', kind: 'output', text: 'x', conversation: c, parentSpanId: POST })),
    ).toBe('conversation_ended');
    t.channel.ack('lead-1', gather.deliveryId);
    expect(t.channel.working(c)).toEqual([]);
    expect(settled).toBe(true);
    expect(t.channel.isSettled(c)).toBe(true);
    expect(t.at('channel.no_reply')).toEqual([]);
    expect(t.events.some((e) => e.type === 'message' && e.message.from === 'asha' && e.message.kind === 'output')).toBe(
      false,
    );
  });

  it('a conversation ended while nobody works on it settles at once, with no harness reply', () => {
    const t = setup();
    t.join('work');
    const c = t.ask('work-1');
    t.channel.ack('work-1', t.last('work-1').deliveryId);
    // Concluded already: the harness replied, as any unanswered conversation. A later end changes nothing of that.
    expect(t.at('channel.no_reply')).toHaveLength(1);
    const d = t.ask('work-1');
    t.channel.end(d, 'restart_limit', 'work-1 exited 3 times within 60 s; not restarted');
    t.channel.ack('work-1', t.last('work-1').deliveryId);
    expect(t.channel.isSettled(d)).toBe(true);
    expect(t.at('channel.no_reply')).toHaveLength(1);
    expect(t.channel.isSettled(c)).toBe(true);
  });

  it('refuses to end a conversation it does not hold', () => {
    const t = setup();
    expect(() => {
      t.channel.end('nope', 'budget_exceeded', 'x');
    }).toThrow('end: unknown conversation nope');
  });
});

describe("a conversation's posts budget (R15, R16, A10)", () => {
  /** `n` agent posts alternating ping-1 → pong-1 and back, as P17's pair makes them; each one's outcome. */
  function pingPong(t: ReturnType<typeof setup>, conversation: string, n: number): ('posted' | CallRefusalReason)[] {
    const out: ('posted' | CallRefusalReason)[] = [];
    for (let i = 0; i < n; i += 1) {
      const [from, to] = i % 2 === 0 ? ['ping-1', 'pong-1'] : ['pong-1', 'ping-1'];
      try {
        t.channel.post({
          from: from,
          to: to,
          kind: 'internal',
          text: i % 2 === 0 ? 'ping' : 'pong',
          conversation,
          parentSpanId: POST,
        });
        out.push('posted');
      } catch (error) {
        if (!(error instanceof CallRefused)) throw error;
        out.push(error.reason);
      }
    }
    return out;
  }

  it('posts 1: the first agent post is accepted, the second refused conversation_ended and the conversation ended budget_exceeded', () => {
    const t = setup();
    t.join('ping');
    t.join('pong');
    const c = t.ask('ping-1', 'Start.', { posts: 1 });
    expect(t.channel.budgetOfConversation(c)).toEqual({ posts: 1, tokens: null });
    expect(pingPong(t, c, 2)).toEqual(['posted', 'conversation_ended']);
    expect(t.events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', reason: 'budget_exceeded', detail: `conversation ${c} reached its budget of 1 agent posts` },
    ]);
  });

  it('posts 8: the ninth is refused, and every later one, with one error event and one record', () => {
    const t = setup();
    t.join('ping');
    t.join('pong');
    const c = t.ask('ping-1', 'Start.', { posts: 8 });
    expect(pingPong(t, c, 11)).toEqual([
      ...Array<string>(8).fill('posted'),
      'conversation_ended',
      'conversation_ended',
      'conversation_ended',
    ]);
    expect(t.events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(t.at('channel.conversation_ended')).toHaveLength(1);
    // Exactly eight agent messages were posted in it.
    expect(
      t.at('channel.posted').filter((e) => e.fields['conversation'] === c && e.fields['kind'] === 'internal'),
    ).toHaveLength(8);
  });

  it('no budget: 31 posts see no refusal, the 32nd is accepted, the 33rd refused and the conversation ended budget_exceeded (it threw before)', () => {
    const t = setup();
    t.join('ping');
    t.join('pong');
    const c = t.ask('ping-1', 'Start.');
    expect(t.channel.budgetOfConversation(c)).toEqual({ posts: 32, tokens: null });
    expect(pingPong(t, c, 31)).toEqual(Array<string>(31).fill('posted'));
    expect(t.channel.isEnded(c)).toBe(false);
    expect(pingPong(t, c, 2)).toEqual(['posted', 'conversation_ended']);
    expect(t.events.filter((e) => e.type === 'error').map((e) => (e as { detail: string }).detail)).toEqual([
      `conversation ${c} reached its budget of 32 agent posts`,
    ]);
  });

  it("counts an open call's reserved answers: the post that would take one ends the conversation, the detail naming them (R16, amended)", () => {
    const t = setup();
    t.join('ping');
    t.join('pong');
    t.join('other');
    const c = t.ask('ping-1', 'Start.', { posts: 8 });
    const held = t.last('ping-1');
    t.channel.openCall('ping-1', held.deliveryId, [{ to: 'other-1', text: 'And you?' }], POST);
    // 1 question posted and 1 answer reserved: 6 more posts fit, the 7th would take the reserved one.
    expect(pingPong(t, c, 7)).toEqual([...Array<string>(6).fill('posted'), 'conversation_ended']);
    expect(t.events.filter((e) => e.type === 'error').map((e) => (e as { detail: string }).detail)).toEqual([
      `conversation ${c} reached its budget of 8 agent posts (1 of them reserved for open calls' answers)`,
    ]);
  });

  it('statuses do not count toward it', () => {
    const t = setup();
    t.join('ping');
    t.join('pong');
    const c = t.ask('ping-1', 'Start.', { posts: 1 });
    for (let i = 0; i < 5; i += 1) t.channel.post({ from: 'ping-1', kind: 'status', text: 'ok', conversation: c });
    expect(pingPong(t, c, 1)).toEqual(['posted']);
  });

  it("a consult's reservation is counted against it: a call of 3 is refused post_budget with posts 5 and no post yet; a call of 2 is opened", () => {
    const t = setup();
    for (const base of ['lead', 'a', 'b', 'c']) t.join(base);
    const c = t.ask('lead-1', 'go', { posts: 5 });
    const held = t.last('lead-1').deliveryId;
    expect(
      refusal(() =>
        t.channel.openCall(
          'lead-1',
          held,
          [
            { to: 'a-1', text: 'x' },
            { to: 'b-1', text: 'x' },
            { to: 'c-1', text: 'x' },
          ],
          POST,
        ),
      ),
    ).toBe('post_budget');
    expect(t.channel.isEnded(c)).toBe(false);
    t.channel.openCall(
      'lead-1',
      held,
      [
        { to: 'a-1', text: 'x' },
        { to: 'b-1', text: 'x' },
      ],
      POST,
    );
  });

  it("a budget is only an input's", () => {
    const t = setup();
    t.join('ping');
    const c = t.ask('ping-1');
    expect(() =>
      t.channel.post({
        from: 'ping-1',
        kind: 'internal',
        text: 'x',
        conversation: c,
        parentSpanId: POST,
        budget: { posts: 2 },
      }),
    ).toThrow("only a user's input carries a budget");
  });
});
