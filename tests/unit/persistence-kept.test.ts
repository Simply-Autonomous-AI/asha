// A persisted agent's kept input (docs/plans/patterns-phase-5.md R1–R4, R6; A2), model-free: FakeRuntime as the
// containers, the test as both agents of the `mixed` team — `lee`, persisted, and `pat`, not — the real state store on
// disk. A user's input whose conversation is unfinished when the checkpoint after its turn is promoted stays in
// pending.json, marked kept, until that conversation settles; a stop leaves it, and the next run re-sends it, so a
// conversation waiting on a call when the daemon stops completes after the restart.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PendingRecord,
  PendingRecordInvalid,
  nodeStateFs,
  parsePending,
  type PendingEntry,
} from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import type { Delivery } from '../../src/shared/protocol.js';
import { harness, persistenceRoot, settle, until, type Harness } from '../helpers/persistence.js';
import { SpyFs } from '../helpers/state-fakes.js';

const LEE = { channel: 'main', team: 'mixed', name: 'lee' };
const SPAN = 'b'.repeat(16);

/** The mixed team online: lee (lee-1, persisted) and pat (pat-1). */
async function mixed(h: Harness): Promise<{ lee: string; pat: string }> {
  const agents = await h.supervisor.launchTeam('mixed', h.main, h.teamSink);
  expect(agents.map((a) => a.handle)).toEqual(['lee-1', 'pat-1']);
  return { lee: h.container(0), pat: h.container(1) };
}

const token = (h: Harness, container: string) => present(h.tokens.get(container), `token for ${container}`);
const record = (h: Harness) => PendingRecord.load({ fs: nodeStateFs, dir: h.state.agentDir(LEE) });
const events = (h: Harness, prefix: string) =>
  h.logger.entries.filter((e) => e.event.startsWith(prefix)).map((e) => [e.level, e.event, e.fields]);

/** The n-th delivery to a container, once it has arrived. */
async function nth(h: Harness, container: string, n: number): Promise<Delivery> {
  await until(() => {
    expect(present(h.inbox.get(container), `inbox for ${container}`).length).toBeGreaterThanOrEqual(n);
  });
  return present(
    present(h.inbox.get(container), `inbox for ${container}`)[n - 1],
    `inbox for ${container}, entry ${String(n - 1)}`,
  );
}

/** Acks a delivery of lee's and waits until the checkpoint after it has been promoted (or failed). */
async function ackLee(h: Harness, lee: string, delivery: Delivery): Promise<void> {
  const before = h.logger.entries.filter((e) => e.event === 'state.promoted' || e.event === 'state.save_failed').length;
  h.ack(lee, delivery);
  await until(() => {
    expect(
      h.logger.entries.filter((e) => e.event === 'state.promoted' || e.event === 'state.save_failed').length,
    ).toBeGreaterThan(before);
  });
  // The promotion's clearing has been written: the delivery's entry is gone, or kept (R1) — never left as it was.
  await until(async () => {
    const entry = (await record(h)).entries.find((e) => e.deliveryId === delivery.deliveryId);
    expect(entry === undefined || entry.kept === true).toBe(true);
  });
}

/** Alice's input to lee; lee consults pat about it, and acks. Returns the input's delivery and pat's question. */
async function consulting(h: Harness, lee: string, pat: string): Promise<{ input: Delivery; question: Delivery }> {
  h.input('ask pat', 'alice', 'lee-1');
  const input = await nth(h, lee, 1);
  h.supervisor.consult(token(h, lee), input.deliveryId, [{ to: 'pat-1', text: 'your word?' }], SPAN);
  const question = await nth(h, pat, 1);
  await ackLee(h, lee, input);
  return { input, question };
}

describe('an input whose conversation is unfinished at its checkpoint is kept (R1, R6)', () => {
  it('kept while lee waits on its call: kept: true on disk, state.pending_kept with entries 1', async () => {
    const h = await harness();
    const { lee, pat } = await mixed(h);
    const { input } = await consulting(h, lee, pat);
    const entries = (await record(h)).entries;
    expect(entries.map((e) => [e.deliveryId, e.kind, e.kept, e.attempts])).toEqual([
      [input.deliveryId, 'input', true, 0],
    ]);
    expect(events(h, 'state.pending_kept')).toEqual([
      ['info', 'state.pending_kept', { identity: 'main/mixed/lee', entries: 1 }],
    ]);
  });

  it('removed as today when the turn replies: no state.pending_kept, and pending.json written exactly twice — its entry, then its removal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-kept-'));
    const spy = new SpyFs(home);
    const h = await harness({ fs: spy, home });
    const { lee } = await mixed(h);
    spy.calls.length = 0;
    h.input('hello', 'alice', 'lee-1');
    const input = await nth(h, lee, 1);
    h.supervisor.post(token(h, lee), { conversation: input.message.conversation, kind: 'output', text: 'hi' }, SPAN);
    await ackLee(h, lee, input);
    expect(spy.calls.filter((c) => c.endsWith('lee/pending.json'))).toEqual([
      'replace state/agents/main/mixed/lee/pending.json',
      'remove state/agents/main/mixed/lee/pending.json',
    ]);
    expect(events(h, 'state.pending_kept')).toEqual([]);
    expect((await record(h)).entries).toEqual([]);
  });

  it("kept when another agent's delivery in the conversation is unacknowledged (a hand-off), removed when the asker already has a reply", async () => {
    const h = await harness();
    const { lee, pat } = await mixed(h);
    h.input('pass it on', 'alice', 'lee-1');
    const first = await nth(h, lee, 1);
    h.supervisor.post(
      token(h, lee),
      { conversation: first.message.conversation, kind: 'internal', text: 'over to you', to: 'pat-1' },
      SPAN,
    );
    await nth(h, pat, 1);
    await ackLee(h, lee, first);
    expect((await record(h)).entries.map((e) => e.kept)).toEqual([true]);
    // A second input: lee replies and hands off too — the asker has a reply, so nothing is kept for it.
    h.input('again', 'alice', 'lee-1');
    const second = await nth(h, lee, 2);
    h.supervisor.post(token(h, lee), { conversation: second.message.conversation, kind: 'output', text: 'done' }, SPAN);
    h.supervisor.post(
      token(h, lee),
      { conversation: second.message.conversation, kind: 'internal', text: 'fyi', to: 'pat-1' },
      SPAN,
    );
    await ackLee(h, lee, second);
    expect((await record(h)).entries.map((e) => [e.deliveryId, e.kept])).toEqual([[first.deliveryId, true]]);
  });

  it('kept when a gather to lee is already waiting behind its checkpoint', async () => {
    const h = await harness();
    const { lee, pat } = await mixed(h);
    h.input('ask pat', 'alice', 'lee-1');
    const input = await nth(h, lee, 1);
    h.supervisor.consult(token(h, lee), input.deliveryId, [{ to: 'pat-1', text: 'your word?' }], SPAN);
    const question = await nth(h, pat, 1);
    // pat answers before lee acks: the call is gathered, its gather held for lee behind the checkpoint.
    h.supervisor.answerCall(token(h, pat), question.deliveryId, { text: 'marigold' });
    h.ack(pat, question);
    await settle();
    await ackLee(h, lee, input);
    const entries = (await record(h)).entries;
    expect(entries.map((e) => [e.kind, e.kept])).toEqual([
      ['input', true],
      ['call_gather', undefined],
    ]);
  });

  it('a later promotion leaves it; its conversation settling removes it, state.pending_settled', async () => {
    const h = await harness();
    const { lee, pat } = await mixed(h);
    const { question } = await consulting(h, lee, pat);
    h.supervisor.answerCall(token(h, pat), question.deliveryId, { text: 'marigold' });
    h.ack(pat, question);
    const gather = await nth(h, lee, 2);
    expect(gather.message.call?.role).toBe('gather');
    // The gather turn's promotion clears the gather and leaves the kept input; the settle that follows removes it.
    h.supervisor.post(
      token(h, lee),
      { conversation: gather.message.conversation, kind: 'output', text: 'marigold' },
      SPAN,
    );
    await ackLee(h, lee, gather);
    await until(async () => {
      expect((await record(h)).entries).toEqual([]);
    });
    expect(events(h, 'state.pending_settled')).toEqual([
      ['info', 'state.pending_settled', { identity: 'main/mixed/lee', entries: 1 }],
    ]);
  });

  it('the agent leaving outside a stop removes it, state.redelivery_failed agent_exited; nothing of it writes the record after', async () => {
    const h = await harness();
    const { lee, pat } = await mixed(h);
    const { question } = await consulting(h, lee, pat);
    h.runtime.exit(lee, 1);
    await until(async () => {
      expect((await record(h)).entries).toEqual([]);
    });
    expect(
      h.logger.entries.filter((e) => e.event === 'state.redelivery_failed').map((e) => [e.level, e.fields['reason']]),
    ).toEqual([['error', 'agent_exited']]);
    // A relaunch's record, written meanwhile, is not overwritten by the first run's callbacks when the call ends.
    const fresh = await PendingRecord.load({ fs: nodeStateFs, dir: h.state.agentDir(LEE) });
    const planted: PendingEntry = {
      messageId: 'm9',
      conversation: 'c9',
      deliveryId: 'd9',
      daemonStartedAt: '2026-01-01T00:00:00.000Z',
      afterGeneration: 0,
      attempts: 0,
      savedAt: '2026-01-01T00:00:00.000Z',
      kind: 'input',
      user: 'alice',
      text: 'x',
      to: null,
    };
    expect(await fresh.add(planted)).toEqual({ ok: true });
    h.ack(pat, question);
    await settle();
    expect((await record(h)).entries).toEqual([planted]);
  });
});

describe('the unfinished rule, clause by clause, and one conversation at a time (R1, R3; the completion review, findings 3 and 6)', () => {
  it('an input whose conversation has ended is not kept, though a hand-off in it is unacknowledged', async () => {
    const h = await harness();
    const { lee, pat } = await mixed(h);
    h.input('pass it on', 'alice', 'lee-1');
    const input = await nth(h, lee, 1);
    h.supervisor.post(
      token(h, lee),
      { conversation: input.message.conversation, kind: 'internal', text: 'over to you', to: 'pat-1' },
      SPAN,
    );
    await nth(h, pat, 1);
    h.main.end(input.message.conversation, 'budget_exceeded', 'the test ends it');
    await ackLee(h, lee, input);
    expect((await record(h)).entries).toEqual([]);
    expect(events(h, 'state.pending_kept')).toEqual([]);
  });

  it("one kept conversation settling removes its own input only; another's stays kept", async () => {
    const h = await harness();
    const { lee, pat } = await mixed(h);
    h.input('first', 'alice', 'lee-1');
    const a = await nth(h, lee, 1);
    h.supervisor.post(
      token(h, lee),
      { conversation: a.message.conversation, kind: 'internal', text: 'over to you', to: 'pat-1' },
      SPAN,
    );
    const handedA = await nth(h, pat, 1);
    await ackLee(h, lee, a);
    h.input('second', 'alice', 'lee-1');
    const b = await nth(h, lee, 2);
    h.supervisor.post(
      token(h, lee),
      { conversation: b.message.conversation, kind: 'internal', text: 'over to you too', to: 'pat-1' },
      SPAN,
    );
    await nth(h, pat, 2);
    await ackLee(h, lee, b);
    expect((await record(h)).entries.map((e) => [e.deliveryId, e.kept])).toEqual([
      [a.deliveryId, true],
      [b.deliveryId, true],
    ]);
    // pat answers the first conversation and acks: it settles; the second does not.
    h.supervisor.post(token(h, pat), { conversation: a.message.conversation, kind: 'output', text: 'done' }, SPAN);
    h.ack(pat, handedA);
    await until(async () => {
      expect((await record(h)).entries.map((e) => e.deliveryId)).toEqual([b.deliveryId]);
    });
    expect(events(h, 'state.pending_settled')).toEqual([
      ['info', 'state.pending_settled', { identity: 'main/mixed/lee', entries: 1 }],
    ]);
  });
});

describe('a stop, and the next run (R2–R4)', () => {
  it('while stopping: a settle with only the harness reply leaves the kept input; one with an agent reply removes it', async () => {
    // Only the harness's reply: lee hands off to pat, pat acks without replying during the stop.
    const quiet = await harness();
    const q = await mixed(quiet);
    quiet.input('pass it on', 'alice', 'lee-1');
    const a = await nth(quiet, q.lee, 1);
    quiet.supervisor.post(
      token(quiet, q.lee),
      { conversation: a.message.conversation, kind: 'internal', text: 'over to you', to: 'pat-1' },
      SPAN,
    );
    const handed = await nth(quiet, q.pat, 1);
    await ackLee(quiet, q.lee, a);
    const stopping = quiet.supervisor.stopAll('daemon stopping');
    quiet.ack(q.pat, handed);
    await stopping;
    expect((await record(quiet)).entries.map((e) => e.kept)).toEqual([true]);
    expect(events(quiet, 'state.pending_settled')).toEqual([]);
    // An agent's reply: pat answers alice during the stop.
    const answered = await harness();
    const r = await mixed(answered);
    answered.input('pass it on', 'alice', 'lee-1');
    const b = await nth(answered, r.lee, 1);
    answered.supervisor.post(
      token(answered, r.lee),
      { conversation: b.message.conversation, kind: 'internal', text: 'over to you', to: 'pat-1' },
      SPAN,
    );
    const handedB = await nth(answered, r.pat, 1);
    await ackLee(answered, r.lee, b);
    const stoppingB = answered.supervisor.stopAll('daemon stopping');
    answered.supervisor.post(
      token(answered, r.pat),
      { conversation: b.message.conversation, kind: 'output', text: 'done it' },
      SPAN,
    );
    answered.ack(r.pat, handedB);
    await stoppingB;
    expect((await record(answered)).entries).toEqual([]);
    expect(events(answered, 'state.pending_settled')).toEqual([
      ['info', 'state.pending_settled', { identity: 'main/mixed/lee', entries: 1 }],
    ]);
  });

  it('end to end: a stop while lee waits on its call; the next run re-sends the input once, lee consults again, and the conversation ends with nothing kept', async () => {
    const root = await persistenceRoot();
    const first = await harness({ root, daemonStartedAt: '2026-10-01T00:00:00.000Z' });
    const f = await mixed(first);
    const { input } = await consulting(first, f.lee, f.pat);
    await first.supervisor.stopAll('daemon stopping');
    // The input kept; and — when pat's departure gathered the call before lee's — the gather recorded for the frozen lee.
    const kept = (await record(first)).entries;
    expect(kept.map((e) => [e.messageId, e.kept, e.attempts])[0]).toEqual([input.message.id, true, 0]);
    expect(kept.slice(1).map((e) => e.kind)).toEqual(kept.length === 1 ? [] : ['call_gather']);

    const second = await harness({
      root,
      home: first.home,
      daemonStartedAt: '2026-10-02T00:00:00.000Z',
      idPrefix: 'run2-',
    });
    const s = await mixed(second);
    const resent = await nth(second, s.lee, 1);
    expect([resent.message.text, resent.message.redelivered?.originalMessage]).toEqual(['ask pat', input.message.id]);
    // The re-sent conversation is a new one: R1 must read it, not the original the record names (finding 2).
    expect(resent.message.conversation).not.toBe(input.message.conversation);
    // The re-send's write counts the attempt and drops the mark.
    await until(async () => {
      expect((await record(second)).entries.map((e) => [e.attempts, e.kept])).toEqual([[1, undefined]]);
    });
    second.supervisor.consult(token(second, s.lee), resent.deliveryId, [{ to: 'pat-1', text: 'your word?' }], SPAN);
    const question = await nth(second, s.pat, 1);
    await ackLee(second, s.lee, resent);
    // Kept again: its re-sent conversation is waiting on the call.
    expect((await record(second)).entries.map((e) => [e.attempts, e.kept])).toEqual([[1, true]]);
    second.supervisor.answerCall(token(second, s.pat), question.deliveryId, { text: 'marigold' });
    second.ack(s.pat, question);
    const gather = await nth(second, s.lee, 2);
    second.supervisor.post(
      token(second, s.lee),
      { conversation: gather.message.conversation, kind: 'output', text: 'marigold' },
      SPAN,
    );
    await ackLee(second, s.lee, gather);
    await until(async () => {
      expect((await record(second)).entries).toEqual([]);
    });
    expect(events(second, 'state.redelivered')).toHaveLength(1);
    expect(events(second, 'state.pending_settled')).toEqual([
      ['info', 'state.pending_settled', { identity: 'main/mixed/lee', entries: 1 }],
    ]);
    expect(second.main.isSettled(gather.message.conversation)).toBe(true);
  });

  it("a re-sent kept input answered in one turn is removed by that turn's promotion", async () => {
    const root = await persistenceRoot();
    const first = await harness({ root, daemonStartedAt: '2026-10-01T00:00:00.000Z' });
    const f = await mixed(first);
    await consulting(first, f.lee, f.pat);
    await first.supervisor.stopAll('daemon stopping');
    const second = await harness({ root, home: first.home, daemonStartedAt: '2026-10-02T00:00:00.000Z' });
    const s = await mixed(second);
    const resent = await nth(second, s.lee, 1);
    second.supervisor.post(
      token(second, s.lee),
      { conversation: resent.message.conversation, kind: 'output', text: 'from memory' },
      SPAN,
    );
    await ackLee(second, s.lee, resent);
    expect((await record(second)).entries).toEqual([]);
    expect(events(second, 'state.pending_kept')).toEqual([]);
  });

  it('a kept input re-sent and lost with its run is not re-sent again: daemon_lost', async () => {
    const root = await persistenceRoot();
    const first = await harness({ root, daemonStartedAt: '2026-10-01T00:00:00.000Z' });
    const f = await mixed(first);
    await consulting(first, f.lee, f.pat);
    await first.supervisor.stopAll('daemon stopping');
    const second = await harness({ root, home: first.home, daemonStartedAt: '2026-10-02T00:00:00.000Z' });
    const s = await mixed(second);
    const resent = await nth(second, s.lee, 1);
    second.supervisor.consult(token(second, s.lee), resent.deliveryId, [{ to: 'pat-1', text: 'your word?' }], SPAN);
    await ackLee(second, s.lee, resent);
    await second.supervisor.stopAll('daemon stopping');
    expect((await record(second)).entries.filter((e) => e.kind === 'input').map((e) => [e.attempts, e.kept])).toEqual([
      [1, true],
    ]);
    const third = await harness({ root, home: first.home, daemonStartedAt: '2026-10-03T00:00:00.000Z' });
    await mixed(third);
    await settle();
    expect(third.inbox.get(third.container(0))).toEqual([]);
    expect(
      third.logger.entries.filter((e) => e.event === 'state.redelivery_failed').map((e) => e.fields['reason']),
    ).toEqual(['daemon_lost']);
  });

  it.each<[string, Partial<PendingEntry>, string]>([
    ['daemon_lost', { attempts: 1 }, 'daemon_lost'],
    ['same_run', { daemonStartedAt: '2026-10-02T00:00:00.000Z' }, 'same_run'],
    ['user_invalid', { user: 'Not A User' }, 'user_invalid'],
  ])(
    'a gather in the conversation of an input that is not re-sent (%s) is skipped with the notice, not superseded (R4; finding 5)',
    async (_, variant, reason) => {
      const h0 = await harness({ daemonStartedAt: '2026-10-01T00:00:00.000Z' });
      const pending = await h0.state.pending(LEE);
      const base = {
        daemonStartedAt: '2026-10-01T00:00:00.000Z',
        afterGeneration: 0,
        attempts: 0,
        savedAt: '2026-10-01T00:00:00.000Z',
      };
      expect(
        await pending.add({
          ...base,
          messageId: 'm1',
          conversation: 'c1',
          deliveryId: 'd1',
          kind: 'input',
          user: 'alice',
          text: 'ask pat',
          to: 'lee-1',
          kept: true,
          ...variant,
        }),
      ).toEqual({ ok: true });
      expect(
        await pending.add({ ...base, messageId: 'm2', conversation: 'c1', deliveryId: 'd2', kind: 'call_gather' }),
      ).toEqual({ ok: true });
      const h = await harness({ root: h0.root, home: h0.home, daemonStartedAt: '2026-10-02T00:00:00.000Z' });
      await mixed(h);
      await settle();
      expect(h.inbox.get(h.container(0))).toEqual([]);
      expect(
        h.logger.entries
          .filter((e) => e.event.startsWith('state.redelivery'))
          .map((e) => [e.event, e.fields['kind'] ?? e.fields['reason']]),
      ).toEqual([
        ['state.redelivery_failed', reason],
        ['state.redelivery_skipped', 'call_gather'],
      ]);
    },
  );

  it("at a launch, a gather in a re-sent input's conversation is superseded with no notice; one in another conversation is skipped with the notice", async () => {
    const h0 = await harness({ daemonStartedAt: '2026-10-01T00:00:00.000Z' });
    const pending = await h0.state.pending(LEE);
    const base = {
      daemonStartedAt: '2026-10-01T00:00:00.000Z',
      afterGeneration: 0,
      attempts: 0,
      savedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(
      await pending.add({
        ...base,
        messageId: 'm1',
        conversation: 'c1',
        deliveryId: 'd1',
        kind: 'input',
        user: 'alice',
        text: 'ask pat',
        to: 'lee-1',
        kept: true,
      }),
    ).toEqual({ ok: true });
    expect(
      await pending.add({ ...base, messageId: 'm2', conversation: 'c1', deliveryId: 'd2', kind: 'call_gather' }),
    ).toEqual({ ok: true });
    expect(
      await pending.add({ ...base, messageId: 'm3', conversation: 'c2', deliveryId: 'd3', kind: 'call_gather' }),
    ).toEqual({ ok: true });
    const h = await harness({ root: h0.root, home: h0.home, daemonStartedAt: '2026-10-02T00:00:00.000Z' });
    await mixed(h);
    const resent = await nth(h, h.container(0), 1);
    expect(resent.message.text).toBe('ask pat');
    expect(
      h.logger.entries
        .filter((e) => e.event === 'state.redelivery_superseded' || e.event === 'state.redelivery_skipped')
        .map((e) => [e.level, e.event, e.fields]),
    ).toEqual([
      ['info', 'state.redelivery_superseded', { identity: 'main/mixed/lee', kind: 'call_gather' }],
      ['warn', 'state.redelivery_skipped', { identity: 'main/mixed/lee', kind: 'call_gather' }],
    ]);
    expect(h.logger.entries.filter((e) => e.event === 'channel.notice').map((e) => e.fields['text'])).toEqual([
      "⚠ lee-1 could not resume an agent's message from before the restart",
    ]);
  });
});

describe("kept on the record's allow-list (R6)", () => {
  const input = {
    messageId: 'm',
    conversation: 'c',
    deliveryId: 'd',
    daemonStartedAt: 'x',
    afterGeneration: 0,
    attempts: 0,
    savedAt: 'y',
    kind: 'input',
    user: 'alice',
    text: 't',
    to: null,
  };
  const gather = {
    messageId: 'm',
    conversation: 'c',
    deliveryId: 'd',
    daemonStartedAt: 'x',
    afterGeneration: 0,
    attempts: 0,
    savedAt: 'y',
    kind: 'call_gather',
  };
  const parse = (entry: object) => () => parsePending(JSON.stringify({ entries: [entry] }), 'pending.json');

  it('reads kept: true on an input', () => {
    expect(parse({ ...input, kept: true })()).toEqual([{ ...input, kept: true }]);
  });

  it('refuses kept: false, kept as a string, and kept on a call_gather, naming the entry', () => {
    for (const entry of [
      { ...input, kept: false },
      { ...input, kept: 'true' },
      { ...gather, kept: true },
    ]) {
      expect(parse(entry)).toThrow(PendingRecordInvalid);
      expect(parse(entry)).toThrow('entries[0].kept is recorded only as true, and only on an input');
    }
  });
});
