// Calls on the channel (docs/plans/agent-calls.md): a consult's record and
// its questions (R2, R3), each refusal (R2, R11), the open call keeping its
// caller working (R10), the outcomes and the one gather (R7, R8), the
// reservation of posts (R11), the close when the caller leaves (R19), and the
// spans and logs of a call (R12). Acceptance A2, A4 and A5.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallRefused, Channel, gatherText } from '../../src/daemon/channel/index.js';
import { JsonLinesLogger, type Logger } from '../../src/daemon/log.js';
import { DaemonTracer, type TraceRecord } from '../../src/daemon/traces/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type { CallRefusalReason, ConversationEvent, ConversationMessage, Delivery } from '../../src/shared/protocol.js';
import { MemoryUserLedger, RecordingLogger } from '../helpers/fakes.js';

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
/** The caller's post span, as the consult's traceparent names it. */
const POST_SPAN = 'feedfeedfeedfeed';
/** Placed in every question and answer text: no log or span record may hold it (R12). */
const SECRET = 'zebra-quartz-17';

function setup(options: { readonly logger?: Logger; readonly maxPosts?: number; readonly ids?: string } = {}) {
  const logger = options.logger ?? new RecordingLogger();
  const timeouts: { handle: string; delivery: Delivery }[] = [];
  let n = 0;
  const spans: TraceRecord[] = [];
  let spanIds = 0;
  const clock = () => new Date(Date.now());
  const tracer = new DaemonTracer({
    clock,
    newSpanId: () => (++spanIds).toString(16).padStart(16, '0'),
    record: (r) => spans.push(r),
  });
  const channel = new Channel({
    name: 'main',
    logger,
    clock,
    newId: () => `${options.ids ?? 'id'}${String(++n)}`,
    onDeliveryTimeout: (_c, handle, delivery) => timeouts.push({ handle, delivery }),
    maxAgentPostsPerConversation: options.maxPosts ?? 32,
    users: new MemoryUserLedger(),
    tracer,
  });
  const inbox = new Map<string, Delivery[]>();
  const join = (base: string, deliveryTimeoutMs = 60_000): string => {
    const box: Delivery[] = [];
    const handle = channel.join(base, { deliver: (d) => box.push(d), deliveryTimeoutMs });
    inbox.set(handle, box);
    return handle;
  };
  const user = channel.claimUser('alice');
  const events: ConversationEvent[] = [];
  /** The user's message to one agent: it holds the delivery it returns. */
  const ask = (
    to: string,
    text = 'Find out for me, and tell me yourself.',
  ): { conversation: string; delivery: Delivery } => {
    const message = channel.postToConversation({ from: user.id, kind: 'input', text, to });
    channel.watch(message.conversation, (e) => events.push(e));
    const box = present(inbox.get(to), `inbox for ${to}`);
    return { conversation: message.conversation, delivery: present(box.at(-1), `box.at(-1) for ${to}`) };
  };
  /** The delivery a callee holds for a call's question. */
  const question = (handle: string, call: string): Delivery =>
    present(
      present(inbox.get(handle), `inbox for ${handle}`).find(
        (d) => d.message.call?.role === 'question' && d.message.call.id === call,
      ),
      `question ${call} for ${handle}`,
    );
  const gathers = (handle: string): Delivery[] =>
    present(inbox.get(handle), `inbox for ${handle}`).filter((d) => d.message.call?.role === 'gather');
  return { channel, logger, timeouts, inbox, join, user, ask, question, gathers, events, spans };
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

describe('a call (agent-calls R2, R3, R10, R11, R19; A2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a consult of 3 and posts its questions in request order, each marked with the channel-minted call and the user', () => {
    const { channel, join, ask, inbox, logger } = setup();
    const [caller, b, c, d] = [join('hewo'), join('hewo'), join('hewo'), join('hewo')];
    const { conversation, delivery } = ask(caller);

    const opened = channel.openCall(
      caller,
      delivery.deliveryId,
      [
        { to: d, text: 'Say: one' },
        { to: b, text: 'Say: two' },
        { to: c, text: 'Say: three' },
      ],
      POST_SPAN,
    );

    // ids: id1 the input, id2 its delivery, id3 the call, then each question and its delivery.
    expect(opened.call).toBe('id3');
    expect(opened.messages.map((m) => [m.to, m.text])).toEqual([
      [d, 'Say: one'],
      [b, 'Say: two'],
      [c, 'Say: three'],
    ]);
    for (const m of opened.messages) {
      expect(m).toMatchObject({
        conversation,
        user: 'alice',
        from: caller,
        kind: 'internal',
        call: { id: 'id3', role: 'question' },
      });
    }
    expect([b, c, d].map((h) => present(inbox.get(h), `inbox for ${h}`).map((x) => x.message.id))).toEqual([
      [present(opened.messages[1], 'opened.messages[1]').id],
      [present(opened.messages[2], 'opened.messages[2]').id],
      [present(opened.messages[0], 'opened.messages[0]').id],
    ]);
    expect((logger as RecordingLogger).entries.filter((e) => e.event === 'channel.call_opened')).toEqual([
      {
        level: 'info',
        event: 'channel.call_opened',
        fields: { channel: 'main', conversation, call: 'id3', caller, addressees: [d, b, c] },
      },
    ]);
  });

  it('refuses each bad consult with its reason and posts nothing', () => {
    const { channel, join, ask, inbox, logger } = setup();
    const [caller, b, c] = [join('hewo'), join('hewo'), join('hewo')];
    const others = Array.from({ length: 10 }, () => join('many'));
    const { delivery } = ask(caller);
    const before = new Map([...inbox].map(([h, box]) => [h, box.length]));
    const posted = () => (logger as RecordingLogger).events().filter((e) => e === 'channel.posted').length;
    const postedBefore = posted();
    const open =
      (requests: { to: string; text: string }[], who = caller, id = delivery.deliveryId) =>
      () =>
        channel.openCall(who, id, requests, POST_SPAN);

    expect(refusal(open([{ to: b, text: 'x' }], b)), "another agent's delivery").toBe('not_holding_delivery');
    expect(refusal(open([{ to: b, text: 'x' }], caller, 'nope')), 'no such delivery').toBe('not_holding_delivery');
    expect(refusal(open([{ to: 'ghost-1', text: 'x' }])), 'unknown').toBe('unknown_handle');
    expect(refusal(open([{ to: caller, text: 'x' }])), 'self').toBe('self_addressed');
    expect(
      refusal(
        open([
          { to: b, text: 'x' },
          { to: b, text: 'y' },
        ]),
      ),
      'duplicate',
    ).toBe('duplicate_addressee');
    expect(refusal(open([b, ...others].map((to) => ({ to, text: 'x' })))), '11 addressees').toBe('too_many_addressees');
    expect(
      refusal(
        open([
          { to: b, text: 'x' },
          { to: c, text: '  ' },
        ]),
      ),
      'empty text',
    ).toBe('empty_text');
    expect(new Map([...inbox].map(([h, box]) => [h, box.length])), 'nothing delivered').toEqual(before);
    expect(posted(), 'nothing posted').toBe(postedBefore);
    expect((logger as RecordingLogger).events()).not.toContain('channel.call_opened');

    // A callee cannot consult from its question; a caller has one open call per conversation.
    const { call } = channel.openCall(caller, delivery.deliveryId, [{ to: b, text: 'x' }], POST_SPAN);
    const qBox = present(inbox.get(b), `inbox for ${b}`);
    const q = present(qBox.at(-1), `qBox.at(-1) for ${b}`);
    expect(
      refusal(() => channel.openCall(b, q.deliveryId, [{ to: c, text: 'y' }], POST_SPAN)),
      'nested',
    ).toBe('nested_call');
    expect(refusal(open([{ to: c, text: 'x' }])), 'second open call').toBe('call_open');
    expect(present(inbox.get(c), `inbox for ${c}`), 'nothing delivered to c').toHaveLength(0);
    expect(call).toBe('id3');
  });

  it('reserves 2N posts: with 27 of 32 used a consult of 3 is refused post_budget, a consult of 2 is not', () => {
    const { channel, join, ask, inbox } = setup();
    const [caller, b, c, d] = [join('hewo'), join('hewo'), join('hewo'), join('hewo')];
    const { conversation, delivery } = ask(caller);
    for (let i = 0; i < 27; i += 1)
      channel.postToConversation({
        from: d,
        kind: 'internal',
        text: `m${String(i)}`,
        conversation,
        to: caller,
        parentSpanId: POST_SPAN,
      });
    const three = [
      { to: b, text: 'x' },
      { to: c, text: 'x' },
      { to: d, text: 'x' },
    ];

    expect(refusal(() => channel.openCall(caller, delivery.deliveryId, three, POST_SPAN))).toBe('post_budget');
    expect(present(inbox.get(b), `inbox for ${b}`)).toHaveLength(0);
    channel.openCall(caller, delivery.deliveryId, three.slice(0, 2), POST_SPAN);
    // 27 + 2 questions posted, 2 answers reserved: 1 post left for anyone else, then none.
    channel.postToConversation({
      from: d,
      kind: 'internal',
      text: 'last',
      conversation,
      to: caller,
      parentSpanId: POST_SPAN,
    });
    // The post past the 32 ends the conversation and is refused (patterns-phase-3 R16).
    expect(() =>
      channel.postToConversation({
        from: d,
        kind: 'internal',
        text: 'over',
        conversation,
        to: caller,
        parentSpanId: POST_SPAN,
      }),
    ).toThrow('conversation_ended: ');
    expect(channel.isEnded(conversation)).toBe(true);
  });

  it('keeps the caller working while its call is open, after it acked its own delivery, and never concludes the conversation', () => {
    const { channel, join, ask, inbox, question, events } = setup();
    const [caller, b, c] = [join('hewo'), join('hewo'), join('hewo')];
    const { conversation, delivery } = ask(caller);
    const { call } = channel.openCall(
      caller,
      delivery.deliveryId,
      [
        { to: b, text: 'x' },
        { to: c, text: 'y' },
      ],
      POST_SPAN,
    );
    channel.ack(caller, delivery.deliveryId);
    channel.answerCall(b, question(b, call).deliveryId, { text: 'yes' });
    channel.ack(b, question(b, call).deliveryId);

    expect(channel.working(conversation), 'b done, c still asked, the caller waiting').toEqual(
      [c, caller].sort(byCodeUnit),
    );
    expect(
      events.filter((e) => e.type === 'message' && e.message.kind === 'output'),
      'no harness reply',
    ).toEqual([]);
    expect(
      present(inbox.get(caller), `inbox for ${caller}`).filter((d) => d.message.call !== undefined),
      'no answer delivered to the caller before the gather',
    ).toEqual([]);
  });

  it('gives two callers consulting the same callee in one conversation each answer on its own call', () => {
    const { channel, join, user, inbox, question, gathers } = setup();
    const [a1, a2, callee] = [join('hewo'), join('hewo'), join('hewo')];
    const input = channel.postToConversation({ from: user.id, kind: 'input', text: 'all of you' });
    const first = channel.openCall(
      a1,
      present(present(inbox.get(a1), `inbox for ${a1}`)[0], `inbox for ${a1}, entry 0`).deliveryId,
      [{ to: callee, text: 'for a1' }],
      POST_SPAN,
    );
    const second = channel.openCall(
      a2,
      present(present(inbox.get(a2), `inbox for ${a2}`)[0], `inbox for ${a2}, entry 0`).deliveryId,
      [{ to: callee, text: 'for a2' }],
      POST_SPAN,
    );

    const toA2 = channel.answerCall(callee, question(callee, second.call).deliveryId, { text: 'answer for a2' });
    const toA1 = channel.answerCall(callee, question(callee, first.call).deliveryId, { text: 'answer for a1' });

    expect([toA1.to, toA1.call, toA2.to, toA2.call]).toEqual([
      a1,
      { id: first.call, role: 'answer', outcome: 'answered' },
      a2,
      { id: second.call, role: 'answer', outcome: 'answered' },
    ]);
    expect(gathers(a1).map((d) => d.message.call)).toEqual([
      expect.objectContaining({
        id: first.call,
        answers: [{ from: callee, outcome: 'answered', text: 'answer for a1' }],
      }),
    ]);
    expect(gathers(a2).map((d) => d.message.call)).toEqual([
      expect.objectContaining({
        id: second.call,
        answers: [{ from: callee, outcome: 'answered', text: 'answer for a2' }],
      }),
    ]);
    expect(input.conversation).toBe(toA1.conversation);
  });

  it('releases the reservation of each addressee that did not answer when the call is gathered', () => {
    const { channel, join, ask, question, gathers } = setup();
    const [caller, b, c, d] = [join('hewo'), join('hewo'), join('hewo'), join('hewo')];
    const { conversation, delivery } = ask(caller);
    const { call } = channel.openCall(
      caller,
      delivery.deliveryId,
      [
        { to: b, text: 'x' },
        { to: c, text: 'x' },
        { to: d, text: 'x' },
      ],
      POST_SPAN,
    );
    channel.answerCall(b, question(b, call).deliveryId, { text: 'yes' });
    channel.answerCall(c, question(c, call).deliveryId, { pass: 'not my role' });
    channel.ack(d, question(d, call).deliveryId);
    // 3 questions + 1 answer posted, and the two answers not given are free again: 28 of 32 remain.
    for (let i = 0; i < 22; i += 1)
      channel.postToConversation({
        from: d,
        kind: 'internal',
        text: `m${String(i)}`,
        conversation,
        to: b,
        parentSpanId: POST_SPAN,
      });
    // 6 remain: a consult of 3 from the gather fits exactly; had two stayed reserved, 4 would remain and it would be refused.
    const [gather] = gathers(caller);
    expect(() =>
      channel.openCall(
        caller,
        present(gather, 'gather').deliveryId,
        [
          { to: b, text: 'x' },
          { to: c, text: 'x' },
          { to: d, text: 'x' },
        ],
        POST_SPAN,
      ),
    ).not.toThrow();
  });

  it('closes a call whose caller leaves (R19): no gather, reservations released, a later answer call_closed, the conversation concluded', () => {
    const { channel, join, ask, question, inbox, events, logger } = setup();
    const [caller, b, c, d] = [join('hewo'), join('hewo'), join('hewo'), join('hewo')];
    const { conversation, delivery } = ask(caller);
    const { call } = channel.openCall(
      caller,
      delivery.deliveryId,
      [
        { to: b, text: 'x' },
        { to: c, text: 'y' },
      ],
      POST_SPAN,
    );
    channel.answerCall(b, question(b, call).deliveryId, { text: 'yes' });

    channel.leave(caller, 'container exited with code 1');

    expect(
      channel.working(conversation),
      'the caller is no longer working; the addressees still hold their questions',
    ).toEqual([b, c]);
    expect(refusal(() => channel.answerCall(c, question(c, call).deliveryId, { text: 'late' }))).toBe('call_closed');
    channel.ack(b, question(b, call).deliveryId);
    channel.ack(c, question(c, call).deliveryId);
    expect(
      present(inbox.get(caller), `inbox for ${caller}`).filter((x) => x.message.call?.role === 'gather'),
      'no gather',
    ).toEqual([]);
    const outputs = events.flatMap((e) => (e.type === 'message' && e.message.kind === 'output' ? [e.message] : []));
    expect(outputs.map((m) => [m.from, m.to])).toEqual([['asha', 'alice']]);
    expect(present(outputs[0], 'outputs[0]').text).toContain(
      `${caller} left the channel before replying (container exited with code 1)`,
    );
    expect((logger as RecordingLogger).entries.filter((e) => e.event === 'channel.call_closed')).toEqual([
      {
        level: 'warn',
        event: 'channel.call_closed',
        fields: {
          channel: 'main',
          conversation,
          call,
          caller,
          outcomes: [
            { addressee: b, outcome: 'answered' },
            { addressee: c, outcome: null },
          ],
        },
      },
    ]);
    // Released: 2 questions + 1 answer used, nothing reserved; d can post the other 29.
    for (let i = 0; i < 29; i += 1)
      channel.postToConversation({
        from: d,
        kind: 'internal',
        text: `m${String(i)}`,
        conversation,
        to: b,
        parentSpanId: POST_SPAN,
      });
    expect(() =>
      channel.postToConversation({
        from: d,
        kind: 'internal',
        text: 'over',
        conversation,
        to: b,
        parentSpanId: POST_SPAN,
      }),
    ).toThrow('conversation_ended: ');
  });
});

describe('outcomes and the gather (agent-calls R7, R8, R10, R11; A4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A consult of 5 whose addressees answer, pass, let their question expire, leave, and ack without answering. */
  function fiveOutcomes(logger?: Logger) {
    const t = setup(logger === undefined ? {} : { logger });
    const caller = t.join('hewo', 90_000);
    const [answers, passes, expires, leaves, acks] = [
      t.join('ans'),
      t.join('pas', 10_000),
      t.join('exp', 5_000),
      t.join('lef'),
      t.join('ack'),
    ];
    const { conversation, delivery } = t.ask(caller);
    const requests = [answers, passes, expires, leaves, acks].map((to) => ({
      to,
      text: `${SECRET} question for ${to}`,
    }));
    const { call } = t.channel.openCall(caller, delivery.deliveryId, requests, POST_SPAN);
    t.channel.ack(caller, delivery.deliveryId);
    vi.advanceTimersByTime(1_000);
    t.channel.answerCall(answers, t.question(answers, call).deliveryId, { text: `${SECRET} the answer` });
    t.channel.ack(answers, t.question(answers, call).deliveryId);
    t.channel.answerCall(passes, t.question(passes, call).deliveryId, { pass: 'not my role' });
    t.channel.ack(passes, t.question(passes, call).deliveryId);
    t.channel.leave(leaves, 'container exited with code 137');
    vi.advanceTimersByTime(4_000); // exp's question expires at 5 s
    return { ...t, caller, conversation, call, handles: { answers, passes, expires, leaves, acks } };
  }

  it('delivers exactly one gather, from asha, internal, with every outcome in request order, before the last ack reports the working set', () => {
    const { channel, caller, conversation, call, handles, question, inbox, events, timeouts } = fiveOutcomes();
    expect(
      timeouts.map((t) => t.handle),
      'the expired addressee is reported',
    ).toEqual([handles.expires]);
    expect(channel.working(conversation)).toEqual([handles.acks, caller].sort(byCodeUnit));
    const seen = events.length;

    channel.ack(handles.acks, question(handles.acks, call).deliveryId);

    const gathers = present(inbox.get(caller), `inbox for ${caller}`).filter((d) => d.message.call?.role === 'gather');
    expect(gathers).toHaveLength(1);
    const gather = present(gathers[0], 'gathers[0]').message;
    expect(gather).toMatchObject({ conversation, user: 'alice', from: 'asha', to: caller, kind: 'internal' });
    expect(gather.text).toBe(`Answers to ${caller}'s call: 1 answered, 1 passed, 1 timed out, 1 left, 1 unanswered.`);
    expect(gather.call).toEqual({
      id: call,
      role: 'gather',
      context: { from: 'alice', text: 'Find out for me, and tell me yourself.' },
      requests: Object.values(handles).map((to) => ({ to, text: `${SECRET} question for ${to}` })),
      answers: [
        { from: handles.answers, outcome: 'answered', text: `${SECRET} the answer` },
        { from: handles.passes, outcome: 'passed', reason: 'not my role' },
        { from: handles.expires, outcome: 'timed_out' },
        { from: handles.leaves, outcome: 'left', detail: 'container exited with code 137' },
        { from: handles.acks, outcome: 'unanswered' },
      ],
    });
    // The gather's message event comes before the status of the ack that completed the call, which shows the caller working on it.
    const after = events.slice(seen);
    expect(after.map((e) => e.type)).toEqual(['message', 'status']);
    expect(after[0]).toMatchObject({ type: 'message', message: { id: gather.id }, working: [caller] });
    expect(after[1]).toEqual({ type: 'status', conversation: gather.conversation, working: [caller] });
    // No answer reached the caller in any other way, and nothing was an output.
    expect(
      present(inbox.get(caller), `inbox for ${caller}`).map((d) => d.message.call?.role ?? d.message.kind),
    ).toEqual(['input', 'gather']);
    expect(events.filter((e) => e.type === 'message' && e.message.kind === 'output')).toEqual([]);
  });

  it("bounds the gather's delivery by the caller's delivery timeout, like any delivery", () => {
    const { channel, caller, call, handles, question, timeouts } = fiveOutcomes();
    channel.ack(handles.acks, question(handles.acks, call).deliveryId);
    vi.advanceTimersByTime(89_999);
    expect(timeouts.map((t) => t.handle)).toEqual([handles.expires]);
    vi.advanceTimersByTime(1);
    expect(timeouts.map((t) => [t.handle, t.delivery.message.call?.role])).toEqual([
      [handles.expires, 'question'],
      [caller, 'gather'],
    ]);
  });

  it("posts an accepted answer to the caller and a pass as the callee's status, delivering neither to any agent", () => {
    const { channel, join, ask, question, inbox, events } = setup();
    const [caller, b, c] = [join('hewo'), join('hewo'), join('hewo')];
    const { conversation, delivery } = ask(caller);
    const { call } = channel.openCall(
      caller,
      delivery.deliveryId,
      [
        { to: b, text: 'x' },
        { to: c, text: 'y' },
      ],
      POST_SPAN,
    );
    const answer = channel.answerCall(b, question(b, call).deliveryId, { text: 'yes' });
    const pass = channel.answerCall(c, question(c, call).deliveryId, { pass: 'not my role' });

    expect(answer).toMatchObject({
      conversation,
      from: b,
      to: caller,
      kind: 'internal',
      text: 'yes',
      call: { id: call, role: 'answer', outcome: 'answered' },
    });
    expect(pass).toMatchObject({ conversation, from: c, to: null, kind: 'status', text: 'pass: not my role' });
    const shown = events.flatMap((e) => (e.type === 'message' ? [e.message.id] : []));
    expect(shown).toEqual(expect.arrayContaining([answer.id, pass.id]));
    expect([...inbox.values()].flat().filter((d) => d.message.id === answer.id || d.message.id === pass.id)).toEqual(
      [],
    );
    expect(
      refusal(() => channel.answerCall(b, question(b, call).deliveryId, { text: 'again' })),
      'a second answer',
    ).toBe('call_closed');
  });

  it('refuses an answer that is too large or not to a call, recording nothing', () => {
    const { channel, join, ask, question, logger } = setup();
    const [caller, b] = [join('hewo'), join('hewo')];
    const { delivery } = ask(caller);
    const { call } = channel.openCall(caller, delivery.deliveryId, [{ to: b, text: 'x' }], POST_SPAN);
    expect(refusal(() => channel.answerCall(b, question(b, call).deliveryId, { text: 'a'.repeat(1_001) }))).toBe(
      'answer_too_large',
    );
    expect(refusal(() => channel.answerCall(caller, delivery.deliveryId, { text: 'a' }))).toBe('not_a_call');
    expect(refusal(() => channel.answerCall(caller, question(b, call).deliveryId, { text: 'a' }))).toBe(
      'not_holding_delivery',
    );
    expect((logger as RecordingLogger).events()).not.toContain('channel.call_outcome');
    expect(channel.answerCall(b, question(b, call).deliveryId, { text: 'a'.repeat(1_000) }).text).toHaveLength(1_000);
  });

  it('refuses an agent that holds only call questions in a conversation its internal and output posts, and accepts its status (R6)', () => {
    const { channel, join, ask, question } = setup();
    const [caller, b] = [join('hewo'), join('hewo')];
    const { conversation, delivery } = ask(caller);
    const { call } = channel.openCall(caller, delivery.deliveryId, [{ to: b, text: 'x' }], POST_SPAN);
    const post = (kind: 'internal' | 'output') => () =>
      channel.postToConversation({
        from: b,
        kind,
        text: 'hi',
        conversation,
        ...(kind === 'internal' ? { to: caller } : {}),
        parentSpanId: POST_SPAN,
      });
    expect(refusal(post('output'))).toBe('call_answer_only');
    expect(refusal(post('internal'))).toBe('call_answer_only');
    expect(channel.post({ from: b, kind: 'status', text: 'ok', conversation }).kind).toBe('status');
    // The caller holds its own (non-call) delivery: it may post.
    expect(
      channel.postToConversation({ from: caller, kind: 'output', text: 'hello', conversation, parentSpanId: POST_SPAN })
        .kind,
    ).toBe('output');
    channel.ack(b, question(b, call).deliveryId);
  });

  it("gives a call opened from a gather that gather's context, so a context is never a gather (R3)", () => {
    const { channel, join, ask, question, gathers } = setup();
    const [caller, b] = [join('hewo'), join('hewo')];
    const { delivery } = ask(caller, 'the original request');
    const first = channel.openCall(caller, delivery.deliveryId, [{ to: b, text: 'x' }], POST_SPAN);
    channel.answerCall(b, question(b, first.call).deliveryId, { text: 'one' });
    const second = channel.openCall(
      caller,
      present(gathers(caller)[0], 'gathers(caller)[0]').deliveryId,
      [{ to: b, text: 'y' }],
      POST_SPAN,
    );
    channel.answerCall(b, question(b, second.call).deliveryId, { text: 'two' });
    const last = present(gathers(caller)[1], 'gathers(caller)[1]').message.call;
    expect(last?.role === 'gather' && last.context).toEqual({ from: 'alice', text: 'the original request' });
  });

  it('gatherText counts the non-zero outcomes in order', () => {
    expect(
      gatherText('hewo-1', [
        { from: 'a', outcome: 'passed' },
        ...Array.from({ length: 8 }, () => ({ from: 'b', outcome: 'answered' as const })),
      ]),
    ).toBe("Answers to hewo-1's call: 8 answered, 1 passed.");
  });
});

describe('the spans and logs of a call (agent-calls R12, R19; A5)', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = mkdtempSync(join(tmpdir(), 'asha-calls-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records asha.call, its question and gather deliveries as children, and the call events, never with the texts', () => {
    const file = join(dir, 'daemon.jsonl');
    const logger = new JsonLinesLogger({ file, echo: () => undefined, clock: () => new Date(Date.now()) });
    // A4's call: five outcomes, the first failing one timed_out.
    const five = setup({ logger });
    const caller = five.join('hewo', 90_000);
    const addressees = [
      five.join('ans'),
      five.join('pas'),
      five.join('exp', 5_000),
      five.join('lef'),
      five.join('ack'),
    ];
    const [ans, pas, , lef, ack] = [
      present(addressees[0], 'addressees[0]'),
      present(addressees[1], 'addressees[1]'),
      present(addressees[2], 'addressees[2]'),
      present(addressees[3], 'addressees[3]'),
      present(addressees[4], 'addressees[4]'),
    ];
    const { delivery } = five.ask(caller);
    const { call } = five.channel.openCall(
      caller,
      delivery.deliveryId,
      addressees.map((to) => ({ to, text: `${SECRET} q` })),
      POST_SPAN,
    );
    five.channel.answerCall(ans, five.question(ans, call).deliveryId, { text: `${SECRET} a` });
    five.channel.answerCall(pas, five.question(pas, call).deliveryId, { pass: 'no' });
    five.channel.ack(ans, five.question(ans, call).deliveryId);
    five.channel.ack(pas, five.question(pas, call).deliveryId);
    five.channel.leave(lef, 'bye');
    vi.advanceTimersByTime(5_000);
    five.channel.ack(ack, five.question(ack, call).deliveryId);

    const callSpan = present(
      five.spans.find((s) => s.name === 'asha.call'),
      "span named 'asha.call'",
    );
    expect(callSpan).toMatchObject({
      kind: 'call',
      handle: caller,
      channel: 'main',
      parentSpanId: POST_SPAN,
      status: 'error',
      reason: 'expired',
    });
    expect(Object.keys(callSpan)).toEqual([
      'traceId',
      'spanId',
      'parentSpanId',
      'name',
      'kind',
      'channel',
      'handle',
      'start',
      'end',
      'status',
      'reason',
    ]);
    const children = five.spans.filter((s) => s.parentSpanId === callSpan.spanId);
    const byToString = (a: unknown, b: unknown) => byCodeUnit(String(a), String(b));
    expect(children.map((s) => [s.name, s.handle]).sort(byToString)).toEqual(
      addressees.map((h) => ['asha.delivery', h]).sort(byToString),
    );
    // The gather's delivery span is open until the caller acks it; it too is the call's child.
    const gather = present(five.gathers(caller)[0], 'five.gathers(caller)[0]');
    five.channel.ack(caller, gather.deliveryId);
    expect(five.spans.at(-1)).toMatchObject({
      name: 'asha.delivery',
      handle: caller,
      parentSpanId: callSpan.spanId,
      status: 'ok',
    });

    // An all-answered call: info, span ok.
    const ok = setup({ logger, ids: 'ok' });
    const [okCaller, okCallee] = [ok.join('hewo'), ok.join('hewo')];
    const okDelivery = ok.ask(okCaller).delivery;
    const okCall = ok.channel.openCall(
      okCaller,
      okDelivery.deliveryId,
      [{ to: okCallee, text: `${SECRET} q` }],
      POST_SPAN,
    ).call;
    ok.channel.answerCall(okCallee, ok.question(okCallee, okCall).deliveryId, { text: `${SECRET} a` });
    expect(ok.spans.find((s) => s.name === 'asha.call')).toMatchObject({ status: 'ok', reason: null });

    // A2's closed call: error/agent_left.
    const closed = setup({ logger, ids: 'cl' });
    const [clCaller, clCallee] = [closed.join('hewo'), closed.join('hewo')];
    const clDelivery = closed.ask(clCaller).delivery;
    closed.channel.openCall(clCaller, clDelivery.deliveryId, [{ to: clCallee, text: `${SECRET} q` }], POST_SPAN);
    closed.channel.leave(clCaller, 'crashed');
    expect(closed.spans.find((s) => s.name === 'asha.call')).toMatchObject({ status: 'error', reason: 'agent_left' });

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(
      lines.filter((l) => l.includes(SECRET)),
      'no log line holds a question or answer text',
    ).toEqual([]);
    expect(JSON.stringify([...five.spans, ...ok.spans, ...closed.spans])).not.toContain(SECRET);
    const records = lines.map(
      (l) => JSON.parse(l) as { level: string; event: string; call?: string; [k: string]: unknown },
    );
    const ofCall = (id: string, event: string) => records.filter((r) => r.call === id && r.event === event);
    expect(ofCall(call, 'channel.call_opened').map((r) => [r.level, r['addressees']])).toEqual([['info', addressees]]);
    expect(ofCall(call, 'channel.call_outcome').map((r) => [r.level, r['addressee'], r['outcome'], r['ms']])).toEqual([
      ['info', addressees[0], 'answered', 0],
      ['info', addressees[1], 'passed', 0],
      ['info', addressees[3], 'left', 0],
      ['info', addressees[2], 'timed_out', 5_000],
      ['info', addressees[4], 'unanswered', 5_000],
    ]);
    expect(ofCall(call, 'channel.call_gathered').map((r) => [r.level, r['counts'], r['ms']])).toEqual([
      ['warn', { answered: 1, passed: 1, timed_out: 1, left: 1, unanswered: 1 }, 5_000],
    ]);
    expect(ofCall(okCall, 'channel.call_gathered').map((r) => [r.level, r['counts']])).toEqual([
      ['info', { answered: 1, passed: 0, timed_out: 0, left: 0, unanswered: 0 }],
    ]);

    // The 3am query (docs/architecture/index.md#logs) finds both calls that lost answers, and not the all-answered one.
    const query = 'select((.event=="channel.call_gathered" or .event=="channel.call_closed") and .level=="warn")';
    const found = execFileSync('jq', ['-c', query, file], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; call: string });
    const label = (c: string): string => {
      if (c === call) return 'five';
      if (c === okCall) return 'ok';
      return 'closed';
    };
    expect(found.map((r) => [r.event, label(r.call)])).toEqual([
      ['channel.call_gathered', 'five'],
      ['channel.call_closed', 'closed'],
    ]);
  });
});

/** Keeps the message type in use for readers of the helpers. */
export type { ConversationMessage };
