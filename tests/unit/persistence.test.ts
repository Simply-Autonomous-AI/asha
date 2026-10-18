// A persisted agent, model-free (docs/plans/agent-persistence.md R2–R4, R6, R8–R13; A2, A5, A7, A8's model-free
// tests, A10, A11, A13): FakeRuntime as the container, the test as the agent, the real state store on disk. A
// delivery is recorded and synced before it is made; the next is held until the ack's checkpoint is promoted; a
// restart resumes the state byte for byte and re-sends an unsaved user's message once, to the agent alone. Every
// positive expectation waits on its condition (until), bounded; an absence is asserted only once a state that
// makes it certain has been reached — a held copy, a record written.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IdentityInUse,
  StateImageMismatch,
  StateSchemaChanged,
  TeamLaunchFailed,
} from '../../src/daemon/agents/index.js';
import { CallRefused, PendingFull } from '../../src/daemon/channel/index.js';
import {
  PENDING_MAX_ENTRIES,
  PendingRecord,
  nodeStateFs,
  readStoredEntries,
  type PendingEntry,
} from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { RETRY_LINE, type Delivery } from '../../src/shared/protocol.js';
import { describeMessage } from '../../src/agent-sdk/channel.js';
import { KEEPER, assetTar, harness, persistenceRoot, settle, until, type Harness } from '../helpers/persistence.js';
import { InjectedFault, MemoryStateFs, SpyFs } from '../helpers/state-fakes.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const IDENTITY = { channel: 'main', team: null, name: 'keeper' };

afterEach(() => {
  vi.useRealTimers();
});

/** Launches the keeper alone on main and waits until it is online. */
async function launchKeeper(h: Harness): Promise<string> {
  const agent = await h.supervisor.launchNew('keeper', h.main, h.sink);
  return agent.handle;
}

/** What the keeper's container holds, as the test sets it: its /memory and /workspace. */
function holds(h: Harness, container: string, memory: Record<string, string>, workspace: Record<string, string>): void {
  const contents = present(h.runtime.contents.get(container), `runtime contents for ${container}`);
  contents.set('/memory', assetTar('memory', memory));
  contents.set('/workspace', assetTar('workspace', workspace));
}

/** The deliveries a container received, once there are `n`. */
async function received(h: Harness, container: string, n: number): Promise<Delivery[]> {
  await until(() => {
    expect(h.inbox.get(container)?.length).toBe(n);
  });
  return present(h.inbox.get(container), `inbox for ${container}`);
}

/** The record of unsaved deliveries on disk. */
const record = (h: Harness) => PendingRecord.load({ fs: nodeStateFs, dir: h.state.agentDir(IDENTITY) });

/** Acks the n-th delivery and waits for its checkpoint to end: promoted, or its save failed. */
async function ackAndSave(h: Harness, container: string, delivery: Delivery): Promise<void> {
  const before = h.logger.entries.filter((e) => e.event === 'state.promoted' || e.event === 'state.save_failed').length;
  h.ack(container, delivery);
  await until(() => {
    expect(
      h.logger.entries.filter((e) => e.event === 'state.promoted' || e.event === 'state.save_failed').length,
    ).toBeGreaterThan(before);
  });
  await until(() => {
    expect(h.main.working(delivery.message.conversation)).toEqual([]);
  });
}

describe('a delivery to a persisted agent (R9 (a), R10; A8 test 1, A13)', () => {
  it("is recorded — written, then its directory fsynced — before it is made; and the next is held until the ack's checkpoint is promoted", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'asha-p-')));
    const spy = new SpyFs(home);
    const h = await harness({ home, fs: spy });
    await launchKeeper(h);
    const c = h.container();
    // The agent's receipt of each delivery, in the same record as the filesystem's calls.
    const inbox = present(h.inbox.get(c), `inbox for ${c}`);
    const push = inbox.push.bind(inbox);
    inbox.push = (...d) => {
      spy.calls.push(`deliver ${present(d[0], 'the pushed delivery').message.text}`);
      return push(...d);
    };
    spy.calls.length = 0;
    const dir = 'state/agents/main/-/keeper';
    const relevant = () =>
      spy.calls.filter((l) => l.includes('pending.json') || l.startsWith('deliver') || l === `fsyncDir ${dir}`);
    h.input('one');
    // Its entry written and its directory synced, then — only then — the delivery made.
    await until(() => {
      expect(relevant()).toEqual([`replace ${dir}/pending.json`, `fsyncDir ${dir}`, 'deliver one']);
    });
    h.input('two');
    // "two" is recorded, and waits: one delivery at a time, the next only after the ack's checkpoint.
    await until(() => {
      expect(relevant()).toEqual([
        `replace ${dir}/pending.json`,
        `fsyncDir ${dir}`,
        'deliver one',
        `replace ${dir}/pending.json`,
        `fsyncDir ${dir}`,
      ]);
    });
    await settle();
    expect(inbox.map((d) => d.message.text)).toEqual(['one']);
    holds(h, c, { 'a/facts.json': '1' }, { 'notes.md': 'n' });
    // The copy is held: "two" is not released while the checkpoint runs.
    let release!: () => void;
    const held = new Promise<undefined>(
      (resolve) =>
        (release = () => {
          resolve(undefined);
        }),
    );
    h.runtime.onCopy = () => held;
    const firstDelivery = present(inbox[0], 'inbox entry 0');
    h.ack(c, firstDelivery);
    await until(() => {
      expect(h.runtime.calls).toContain(`copyOut ${c} /memory`);
    });
    await settle();
    expect(inbox.map((d) => d.message.text)).toEqual(['one']);
    expect(h.main.working(firstDelivery.message.conversation)).toEqual(['keep-1']);
    h.runtime.onCopy = () => Promise.resolve(undefined);
    release();
    await received(h, c, 2);
    expect(inbox.map((d) => d.message.text)).toEqual(['one', 'two']);
    // The checkpoint followed the ack: promoted, naming it, and its entry cleared from the record.
    const pointer = present(await h.state.readAgentPointer(IDENTITY), "keeper's agent pointer");
    expect(pointer).toMatchObject({
      kind: 'agent',
      generation: 1,
      recipe: 'keeper',
      image: 'keeper-image',
      schema: '1',
      lastDelivery: firstDelivery.deliveryId,
      handle: 'keep-1',
    });
    expect(Object.keys(pointer.assets).sort(byCodeUnit)).toEqual(['memory', 'workspace']);
    await until(async () => {
      expect((await record(h)).entries.map((e) => e.text)).toEqual(['two']);
    });
    expect(h.logger.entries.filter((e) => e.event === 'state.promoted').map((e) => e.fields)).toEqual([
      { identity: 'main/-/keeper', generation: 1, bytes: expect.any(Number) as number, files: 2 },
    ]);
    expect(h.logger.events('error')).toEqual([]);
  });

  it('counts a held delivery in the working set, and starts its bound at its release, not its posting (R10; A8 test 9)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = await harness({ fs: new MemoryStateFs() });
    await launchKeeper(h);
    const c = h.container();
    h.input('one');
    const second = h.input('two');
    await vi.advanceTimersByTimeAsync(0);
    expect(present(h.inbox.get(c), `inbox for ${c}`).map((d) => d.message.text)).toEqual(['one']);
    expect(h.main.working(second.conversation)).toEqual(['keep-1']);
    // Held behind "one" for longer than its own 120 s bound: it does not expire while held.
    await vi.advanceTimersByTimeAsync(KEEPER.messageTimeoutMs - 1);
    h.ack(c, present(present(h.inbox.get(c), `inbox for ${c}`)[0], `inbox for ${c}, entry 0`));
    await vi.advanceTimersByTimeAsync(0);
    expect(present(h.inbox.get(c), `inbox for ${c}`).map((d) => d.message.text)).toEqual(['one', 'two']);
    await vi.advanceTimersByTimeAsync(KEEPER.messageTimeoutMs - 1);
    expect(h.logger.events('error')).toEqual([]);
    // Its bound runs from its release: it expires 120 s after it, not after its posting.
    await vi.advanceTimersByTimeAsync(1);
    expect(h.logger.events('error')).toEqual(['channel.delivery_timeout', 'state.redelivery_failed']);
    const redeliveryFailed = present(
      h.logger.entries.find((e) => e.event === 'state.redelivery_failed'),
      'the state.redelivery_failed log entry',
    );
    expect(redeliveryFailed.fields['reason']).toBe('expired');
  });
});

describe('a failed save (R6; A5)', () => {
  it('is logged at error, noticed on the channel once per run, and the agent keeps running: its next delivery is made', async () => {
    const h = await harness();
    await launchKeeper(h);
    const c = h.container();
    // /workspace past its bound of 256 files: the copy is stopped at the entry over it.
    const contents = present(h.runtime.contents.get(c), `runtime contents for ${c}`);
    contents.set('/memory', assetTar('memory', { 'a/f.json': 'x' }));
    contents.set(
      '/workspace',
      assetTar('workspace', Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${String(i)}.md`, 'x']))),
    );
    const one = h.input('one');
    h.watch(one.conversation);
    h.input('two');
    const [first] = await received(h, c, 1);
    await ackAndSave(h, c, present(first, 'the first delivery'));
    expect(
      h.logger.entries
        .filter((e) => e.event === 'state.save_failed')
        .map((e) => [e.level, e.fields['identity'], e.fields['asset'], e.fields['reason']]),
    ).toEqual([['error', 'main/-/keeper', 'workspace', 'over_bound']]);
    // The notice, in the conversation the save followed, from the harness, before the conversation settled.
    const notices = h.events.filter(
      (e) => e.type === 'message' && e.message.from === 'asha' && e.message.kind === 'status',
    );
    expect(notices.map((e) => (e as { message: { text: string } }).message.text)).toEqual([
      "⚠ keep-1's state is not being saved (over_bound); what it does from now on is lost when it stops",
    ]);
    // Still running: the next delivery is made.
    const both = await received(h, c, 2);
    expect(both.map((d) => d.message.text)).toEqual(['one', 'two']);
    // No generation was promoted; the acknowledged turn's entry went with the ack.
    expect(await h.state.readAgentPointer(IDENTITY)).toBeUndefined();
    await ackAndSave(h, c, present(both[1], 'the second delivery'));
    // A second failure in the same run: logged, not noticed again.
    expect(h.logger.events().filter((e) => e === 'state.save_failed')).toHaveLength(2);
    expect(h.logger.events().filter((e) => e === 'channel.notice')).toHaveLength(1);
  });

  it('a /memory past 64 MiB fails every later checkpoint whichever user it follows, with one notice, and --list-state marks it full', async () => {
    const h = await harness();
    await launchKeeper(h);
    const c = h.container();
    holds(h, c, { 'u1/facts.json': 'ok' }, {});
    h.input('first', 'ivy');
    const firstReceived = await received(h, c, 1);
    await ackAndSave(h, c, present(firstReceived[0], 'the first delivery'));
    expect(present(await h.state.readAgentPointer(IDENTITY), "keeper's agent pointer").generation).toBe(1);
    // Past the bound: 64 MiB and one byte of files.
    present(h.runtime.contents.get(c), `runtime contents for ${c}`).set(
      '/memory',
      assetTar('memory', { 'u1/facts.json': 'x'.repeat(64 * 1024 * 1024 + 1) }),
    );
    let n = 1;
    for (const user of ['ivy', 'jack']) {
      h.input(`from ${user}`, user);
      n += 1;
      const soFar = await received(h, c, n);
      await ackAndSave(h, c, present(soFar.at(-1), `delivery ${String(n - 1)}`));
    }
    expect(h.logger.entries.filter((e) => e.event === 'state.save_failed').map((e) => e.fields['reason'])).toEqual([
      'over_bound',
      'over_bound',
    ]);
    expect(h.logger.events().filter((e) => e === 'channel.notice')).toHaveLength(1);
    expect(present(await h.state.readAgentPointer(IDENTITY), "keeper's agent pointer").generation).toBe(1);
    expect((await h.state.list()).assets.find((a) => a.asset === 'memory')).toMatchObject({
      identity: 'main/-/keeper',
      full: true,
    });
  });

  it("a failed checkpoint after an ack keeps the acknowledged message in the record — logged at error — and the next run re-sends it with the retry line (R9 (b); the lead's decision, 2026-09-29)", async () => {
    const first = await harness({ daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await launchKeeper(first);
    const c = first.container();
    // Past /memory's bound: the checkpoint after the ack fails over_bound.
    holds(first, c, { 'u1/facts.json': 'x'.repeat(64 * 1024 * 1024 + 1) }, {});
    first.input('answered, never saved', 'ivy');
    const firstReceived = await received(first, c, 1);
    await ackAndSave(first, c, present(firstReceived[0], 'the first delivery'));
    expect(
      first.logger.entries.filter((e) => e.event === 'state.save_failed').map((e) => [e.level, e.fields['reason']]),
    ).toEqual([['error', 'over_bound']]);
    expect((await record(first)).entries.map((e) => [e.kind, e.text])).toEqual([['input', 'answered, never saved']]);
    // The next run: re-sent once, framed as a retry.
    const h = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    await launchKeeper(h);
    const [resentEntry] = await received(h, h.container(), 1);
    const resent = present(resentEntry, 'the resent delivery');
    expect(resent.message.text).toBe('answered, never saved');
    expect(describeMessage(resent.message, 'keep-1').split('\n')[0]).toBe(RETRY_LINE);
    // At most once (R9 (e)): its attempt is counted before it goes, so a third run that finds it unacknowledged drops it.
    await until(async () => {
      expect((await record(h)).entries.map((e) => [e.text, e.attempts])).toEqual([['answered, never saved', 1]]);
    });
    const third = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-30T00:00:00.000Z' });
    await launchKeeper(third);
    await settle();
    expect(third.inbox.get(third.container()) ?? []).toEqual([]);
    expect(
      third.logger.entries.filter((e) => e.event === 'state.redelivery_failed').map((e) => e.fields['reason']),
    ).toEqual(['daemon_lost']);
  });

  it("a stop's checkpoint promoted after a failed ack's follows the acknowledged message: it leaves the record, the pointer names it, and nothing is re-sent (R9 (b); the review of 8c8af95)", async () => {
    const first = await harness({ daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await launchKeeper(first);
    const c = first.container();
    holds(first, c, { 'u1/facts.json': 'x'.repeat(64 * 1024 * 1024 + 1) }, {});
    first.input('answered, saved by the stop', 'ivy');
    const [deliveryEntry] = await received(first, c, 1);
    const delivery = present(deliveryEntry, 'the delivery');
    await ackAndSave(first, c, delivery);
    expect((await record(first)).entries.map((e) => e.text)).toEqual(['answered, saved by the stop']);
    // Back under the bound: the stop's checkpoint, with nothing in hand, is promoted.
    holds(first, c, { 'u1/facts.json': 'ok' }, {});
    await first.supervisor.stopAll('daemon stopping');
    expect(present(await first.state.readAgentPointer(IDENTITY), "keeper's agent pointer").lastDelivery).toBe(
      delivery.deliveryId,
    );
    expect((await record(first)).entries).toEqual([]);
    const h = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    await launchKeeper(h);
    await settle();
    expect(h.inbox.get(h.container()) ?? []).toEqual([]);
  });

  it("a checkpoint whose identity fsync fails after the pointer's rename is write_failed and discards nothing: the pointer's generation is kept, and the next start removes the previous one (R4; R1-DESIGN-001)", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'asha-p-')));
    const spy = new SpyFs(home);
    const h = await harness({ home, fs: spy });
    await launchKeeper(h);
    const c = h.container();
    const dir = h.state.agentDir(IDENTITY);
    holds(h, c, { 'u1/facts.json': 'one' }, {});
    h.input('one');
    const [first] = await received(h, c, 1);
    await ackAndSave(h, c, present(first, 'the first delivery'));
    // Armed by the pointer's rename, the identity directory's next fsync fails once.
    let armed = false;
    spy.onCall = (line) => {
      if (line === `replace ${relative(home, dir)}/current.json`) armed = true;
      else if (armed && line === `fsyncDir ${relative(home, dir)}`) {
        armed = false;
        throw new InjectedFault({ op: 'fsyncDir', path: relative(home, dir) });
      }
    };
    holds(h, c, { 'u1/facts.json': 'two' }, {});
    h.input('two');
    const both = await received(h, c, 2);
    await ackAndSave(h, c, present(both[1], 'the second delivery'));
    expect(
      h.logger.entries
        .filter((e) => e.event === 'state.save_failed' || e.event === 'state.cleanup_failed')
        .map((e) => [e.event, e.fields['asset'], e.fields['reason']]),
    ).toEqual([['state.save_failed', 'memory', 'write_failed']]);
    expect((await readdir(dir)).filter((n) => n.startsWith('gen-')).sort(byCodeUnit)).toEqual(['gen-1', 'gen-2']);
    expect(present(await h.state.readAgentPointer(IDENTITY), "keeper's agent pointer").generation).toBe(2);
    await h.state.cleanupAtStart();
    expect((await readdir(dir)).filter((n) => n.startsWith('gen-'))).toEqual(['gen-2']);
  });

  it('a record write that fails is journal_failed, logged and noticed, and the delivery is still made (A8 test 8)', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'asha-p-')));
    const spy = new SpyFs(home);
    const h = await harness({ home, fs: spy });
    await launchKeeper(h);
    spy.faults.push({ op: 'replace', path: 'pending.json' });
    h.input('one');
    await received(h, h.container(), 1);
    expect(
      h.logger.entries
        .filter((e) => e.event === 'state.save_failed')
        .map((e) => [e.fields['asset'], e.fields['reason']]),
    ).toEqual([['pending', 'journal_failed']]);
    expect(h.logger.events().filter((e) => e === 'channel.notice')).toHaveLength(1);
  });
});

describe('a restart (R3, R8, R9 (b)–(e), R12, R13; A2, A7, A8 tests 2, 3, 6, 7, A10, A11)', () => {
  /** A keeper saved once, holding `memory` and `workspace`, and one unsaved input from an earlier run. */
  async function earlierRun(root?: string) {
    const h = await harness({ ...(root === undefined ? {} : { root }), daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await launchKeeper(h);
    const c = h.container();
    holds(h, c, { 'u1/facts.json': '{"fact":"blue"}' }, { 'notes.md': 'kept', 'guidance.md': 'edited' });
    h.input('saved one', 'ivy');
    const savedOne = await received(h, c, 1);
    await ackAndSave(h, c, present(savedOne[0], 'the first delivery'));
    // Accepted and delivered, never acknowledged: the run ends (a crash) with it unsaved.
    h.input('do task 3', 'ivy');
    await received(h, c, 2);
    return h;
  }

  it('restores every saved file byte for byte, resumes with the previous handle, and re-sends the unsaved input once, to the agent alone, marked', async () => {
    const first = await earlierRun();
    const stored = await readFile(join(first.home, 'state/agents/main/-/keeper/gen-1/memory.tar'));
    const h = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    await launchKeeper(h);
    const c = h.container();
    // The restore: the saved tars' entries, then the end — byte for byte what was stored, owner 1000.
    const restored = present(h.runtime.restored.get(c), `restored bytes for ${c}`);
    expect(restored.includes(stored.subarray(0, stored.length - 1024))).toBe(true);
    const restoredMemory = present(
      present(h.runtime.contents.get(c), `runtime contents for ${c}`).get('/memory'),
      `/memory contents for ${c}`,
    );
    expect(sha(restoredMemory)).toBe(sha(stored));
    const pointer = present(await h.state.readAgentPointer(IDENTITY), "keeper's agent pointer");
    // Its announcement is reported with what it resumed: the checkpoint's time and handle.
    expect(h.reports).toContain(`announced keep-1 resumed ${pointer.savedAt} keep-1`);
    const resumedEvent = present(
      h.logger.entries.find((e) => e.event === 'agent.resumed'),
      'the agent.resumed log entry',
    );
    expect(resumedEvent.fields).toEqual({
      identity: 'main/-/keeper',
      handle: 'keep-1',
      savedAt: pointer.savedAt,
      generation: 1,
      bytes: expect.any(Number) as number,
      files: 3,
      imageChanged: false,
    });
    // The re-send: first, to this agent alone, in a new conversation for ivy, marked, attempts counted before it went.
    const [resentEntry] = await received(h, c, 1);
    const resent = present(resentEntry, 'the resent delivery');
    expect([
      resent.message.text,
      resent.message.user,
      resent.message.from,
      resent.message.to,
      resent.message.kind,
    ]).toEqual(['do task 3', 'ivy', 'ivy', null, 'input']);
    expect(resent.message.redelivered).toEqual({
      savedAt: expect.any(String) as string,
      originalConversation: expect.any(String) as string,
      originalMessage: expect.any(String) as string,
    });
    expect((await record(h)).entries.map((e) => [e.text, e.attempts, e.deliveryId])).toEqual([
      ['do task 3', 1, resent.deliveryId],
    ]);
    const resentRedelivered = present(resent.message.redelivered, "the resent delivery's redelivered record");
    expect(
      h.logger.entries
        .filter((e) => e.event.startsWith('state.pending') || e.event === 'state.redelivered')
        .map((e) => [e.level, e.event, e.fields]),
    ).toEqual([
      ['warn', 'state.pending_found', { identity: 'main/-/keeper', entries: 1, savedAt: resentRedelivered.savedAt }],
      ['info', 'state.redelivered', { identity: 'main/-/keeper', originalMessage: resentRedelivered.originalMessage }],
    ]);
    // The launch's sink heard of it in the tick it started.
    expect(h.reports.filter((r) => r.startsWith('resent '))).toEqual([
      `resent ${resent.message.conversation} ${resentRedelivered.savedAt}`,
    ]);
    // The SDK frames it with the retry line first (R9 (e)).
    expect(describeMessage(resent.message, 'keep-1').split('\n')).toEqual([RETRY_LINE, 'The user wrote:', 'do task 3']);
    // Its ack clears it with the checkpoint that follows.
    holds(h, c, { 'u1/facts.json': '2' }, {});
    await ackAndSave(h, c, resent);
    expect((await record(h)).entries).toEqual([]);
  });

  it('never re-sends a message twice: a re-send the daemon lost is removed at the next launch, daemon_lost', async () => {
    const first = await earlierRun();
    const second = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    await launchKeeper(second);
    await received(second, second.container(), 1);
    await until(async () => {
      expect((await record(second)).entries.map((e) => e.attempts)).toEqual([1]);
    });
    // The second run dies too, the re-send unacknowledged.
    const third = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-30T00:00:00.000Z' });
    await launchKeeper(third);
    await settle();
    expect(present(third.inbox.get(third.container()), `inbox for ${third.container()}`)).toEqual([]);
    expect(
      third.logger.entries
        .filter((e) => e.event === 'state.redelivery_failed')
        .map((e) => [e.level, e.fields['reason']]),
    ).toEqual([['error', 'daemon_lost']]);
    expect((await record(third)).entries).toEqual([]);
  });

  it("a crash between the pointer's rename and the record's rewrite re-sends nothing at the next launch: state.pending_cleared (A8 test 2)", async () => {
    const root = await persistenceRoot();
    const home = await realpath(await mkdtemp(join(tmpdir(), 'asha-p-')));
    const spy = new SpyFs(home);
    const h = await harness({ root, home, fs: spy, daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await launchKeeper(h);
    const c = h.container();
    holds(h, c, { 'u1/facts.json': '1' }, {});
    h.input('saved', 'ivy');
    const [deliveryEntry] = await received(h, c, 1);
    const delivery = present(deliveryEntry, 'the delivery');
    // The crash: no write of the record after this point reaches the disk.
    spy.onCall = (line) => {
      if (line.includes('pending.json')) throw new Error('crashed');
    };
    h.ack(c, delivery);
    await until(async () => {
      expect((await h.state.readAgentPointer(IDENTITY))?.lastDelivery).toBe(delivery.deliveryId);
    });
    expect((await record(h)).entries.map((e) => e.deliveryId)).toEqual([delivery.deliveryId]);
    const again = await harness({ root, home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    await launchKeeper(again);
    await settle();
    expect(present(again.inbox.get(again.container()), `inbox for ${again.container()}`)).toEqual([]);
    expect(
      again.logger.entries.filter((e) => e.event.startsWith('state.pending')).map((e) => [e.level, e.event, e.fields]),
    ).toEqual([['info', 'state.pending_cleared', { identity: 'main/-/keeper', entries: 1 }]]);
  });

  it('a crash after the record is written and before the delivery is made re-sends it exactly once at the next launch (A8 test 3)', async () => {
    const root = await persistenceRoot();
    const home = await realpath(await mkdtemp(join(tmpdir(), 'asha-p-')));
    const spy = new SpyFs(home);
    const h = await harness({ root, home, fs: spy, daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await launchKeeper(h);
    // The crash: the record's directory sync never returns, so the delivery is never made.
    const dir = `fsyncDir state/agents/main/-/keeper`;
    let written = false;
    spy.onCall = (line) => {
      if (line === dir) {
        written = true;
        throw new Error('crashed');
      }
    };
    h.input('never delivered', 'ivy');
    await until(() => {
      expect(written).toBe(true);
    });
    const again = await harness({ root, home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    await launchKeeper(again);
    const [resentEntry] = await received(again, again.container(), 1);
    const resent = present(resentEntry, 'the resent delivery');
    expect(resent.message.text).toBe('never delivered');
    expect(again.logger.events().filter((e) => e === 'state.redelivered')).toHaveLength(1);
  });

  it('refuses saved state from another image, or another state schema, naming the reset; resumes another source, saying so (R12; A10)', async () => {
    const first = await earlierRun();
    const pointer = join(first.home, 'state/agents/main/-/keeper/current.json');
    const saved = JSON.parse(await readFile(pointer, 'utf8')) as Record<string, unknown>;
    const write = (p: object) => writeFile(pointer, JSON.stringify({ ...saved, ...p }));
    await write({ image: 'other-image' });
    const a = await harness({ root: first.root, home: first.home });
    await expect(a.supervisor.launchNew('keeper', a.main, a.sink)).rejects.toThrow(
      new StateImageMismatch(
        'main/-/keeper',
        'other-image',
        'keeper-image',
        'asha --reset-state channel=main name=keeper',
      ),
    );
    await write({ schema: '2' });
    const b = await harness({ root: first.root, home: first.home });
    await expect(b.supervisor.launchNew('keeper', b.main, b.sink)).rejects.toThrow(
      new StateSchemaChanged('main/-/keeper', '2', '1', 'asha --reset-state channel=main name=keeper'),
    );
    expect(b.runtime.starts).toEqual([]);
    // Another asha.source — a changed image tag of the same image and schema — resumes, imageChanged.
    await write({ source: `sha256:${'f'.repeat(64)}` });
    const c = await harness({ root: first.root, home: first.home });
    await launchKeeper(c);
    const resumedEvent = present(
      c.logger.entries.find((e) => e.event === 'agent.resumed'),
      'the agent.resumed log entry',
    );
    expect(resumedEvent.fields['imageChanged']).toBe(true);
    expect(c.logger.events('error')).toEqual([]);
  });

  it('refuses a second persisted launch of the same identity while it is online: identity_in_use, before any container starts (R2; A2)', async () => {
    const h = await harness();
    await launchKeeper(h);
    await expect(h.supervisor.launchNew('keeper', h.main, h.sink)).rejects.toThrow(new IdentityInUse('main/-/keeper'));
    expect(h.runtime.starts).toHaveLength(1);
    // Another channel is another identity.
    await h.supervisor.launchNew('keeper', h.channels.get('other'), h.sink);
    expect(h.runtime.starts).toHaveLength(2);
  });

  it("keeps a restored document's edits, copies in a missing one, and — past the bound — skips it, logged (R13; A11)", async () => {
    const root = await persistenceRoot({
      'recipes/keeper.json': JSON.stringify({
        ...KEEPER,
        tools: ['list_files', 'read_file', 'write_file', 'append_file'],
        documents: [
          { path: 'guidance.md', fullText: true },
          { path: 'extra.md', fullText: false },
          { path: 'more.md', fullText: false },
        ],
      }),
      'recipes/guidance.md': 'original guidance',
      'recipes/extra.md': 'extra',
      'recipes/more.md': 'more',
    });
    const first = await harness({ root, daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await launchKeeper(first);
    const c = first.container();
    // 255 files, an edited guidance.md among them: room for one more.
    const files = Object.fromEntries(Array.from({ length: 254 }, (_, i) => [`f${String(i)}.md`, 'x']));
    holds(first, c, {}, { ...files, 'guidance.md': 'edited guidance' });
    first.input('x');
    const firstReceived = await received(first, c, 1);
    await ackAndSave(first, c, present(firstReceived[0], 'the first delivery'));
    const h = await harness({ root, home: first.home });
    await launchKeeper(h);
    const file = join(first.home, 'restored.tar');
    const restoredWorkspace = present(
      present(h.runtime.contents.get(h.container()), `runtime contents for ${h.container()}`).get('/workspace'),
      `/workspace contents for ${h.container()}`,
    );
    await writeFile(file, restoredWorkspace);
    const entries = await readStoredEntries(file, 'workspace');
    const names = entries.filter((e) => e.type === 'file').map((e) => e.name);
    expect(names).toHaveLength(256);
    expect(names).toContain('workspace/extra.md');
    expect(names).not.toContain('workspace/more.md');
    // The persisted copy won: the edit is kept.
    expect(entries.find((e) => e.name === 'workspace/guidance.md')).toMatchObject({ sha256: sha('edited guidance') });
    expect(
      h.logger.entries.filter((e) => e.event.startsWith('state.documents')).map((e) => [e.level, e.event, e.fields]),
    ).toEqual([
      ['info', 'state.documents_added', { identity: 'main/-/keeper', paths: ['extra.md'] }],
      ['warn', 'state.documents_skipped', { identity: 'main/-/keeper', paths: ['more.md'], reason: 'over_bound' }],
    ]);
    // The system prompt's full text is the recipe folder's, not the edited copy's (R13).
    const welcomedRecords = [
      ...(h.supervisor['records'] as unknown as Map<string, { guidance: { text: string }[] }>).values(),
    ];
    const welcomed = present(welcomedRecords[0], "the welcomed agent's record");
    expect(welcomed.guidance.map((g) => g.text)).toEqual(['original guidance']);
  });

  it('restores state saved a week earlier: nothing expires (R8; A7)', async () => {
    const week = 7 * 24 * 3600 * 1000;
    const first = await earlierRun();
    const h = await harness({ root: first.root, home: first.home, clock: () => new Date(Date.now() + week) });
    await launchKeeper(h);
    expect(
      present(h.runtime.restored.get(h.container()), `restored bytes for ${h.container()}`).length,
    ).toBeGreaterThan(0);
    expect(h.logger.entries.find((e) => e.event === 'agent.resumed')).toBeDefined();
  });
});

describe("the record's entries that are not re-sent (R9 (c)–(e); A8 tests 5, 7)", () => {
  /** A saved keeper whose record holds `entries`, planted. */
  async function planted(entries: readonly PendingEntry[]) {
    const first = await harness({ daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await launchKeeper(first);
    const c = first.container();
    holds(first, c, {}, {});
    first.input('x');
    const firstReceived = await received(first, c, 1);
    await ackAndSave(first, c, present(firstReceived[0], 'the first delivery'));
    await writeFile(join(first.state.agentDir(IDENTITY), 'pending.json'), JSON.stringify({ entries }));
    return first;
  }
  const entry = (i: number, extra: Partial<PendingEntry> = {}): PendingEntry => ({
    messageId: `orig${String(i)}`,
    conversation: `conv${String(i)}`,
    deliveryId: `d${String(i)}`,
    daemonStartedAt: '2026-09-28T00:00:00.000Z',
    afterGeneration: 1,
    attempts: 0,
    savedAt: `2026-09-28T00:0${String(i)}:00.000Z`,
    kind: 'input',
    user: 'ivy',
    text: `task ${String(i)}`,
    to: null,
    ...extra,
  });
  const noUser = (e: PendingEntry): PendingEntry => ({
    messageId: e.messageId,
    conversation: e.conversation,
    deliveryId: e.deliveryId,
    daemonStartedAt: e.daemonStartedAt,
    afterGeneration: e.afterGeneration,
    attempts: e.attempts,
    savedAt: e.savedAt,
    kind: e.kind,
  });

  it("skips an agent's message and a call's question or gather, with the notice; removes one of this run (same_run) and one whose user the rule refuses (user_invalid)", async () => {
    const first = await planted([
      noUser(entry(1, { kind: 'internal' })),
      noUser(entry(2, { kind: 'call_question' })),
      noUser(entry(3, { kind: 'call_gather' })),
      entry(4, { daemonStartedAt: '2026-09-29T00:00:00.000Z' }),
      entry(5, { user: 'Not A User' }),
      entry(6),
    ]);
    const h = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    const watched: { from: string; text: string }[] = [];
    h.main.watchAll((e) => {
      if (e.type === 'message' && e.message.from === 'asha')
        watched.push({ from: e.message.from, text: e.message.text });
    });
    await launchKeeper(h);
    const [resentEntry] = await received(h, h.container(), 1);
    const resent = present(resentEntry, 'the resent delivery');
    expect(resent.message.text).toBe('task 6');
    expect(
      h.logger.entries
        .filter((e) => ['state.redelivery_skipped', 'state.redelivery_failed'].includes(e.event))
        .map((e) => [e.event, e.fields['kind'] ?? e.fields['reason']]),
    ).toEqual([
      ['state.redelivery_skipped', 'internal'],
      ['state.redelivery_skipped', 'call_question'],
      ['state.redelivery_skipped', 'call_gather'],
      ['state.redelivery_failed', 'same_run'],
      ['state.redelivery_failed', 'user_invalid'],
    ]);
    expect(watched.map((w) => w.text)).toEqual([
      "⚠ keep-1 could not resume an agent's message from before the restart",
    ]);
    // None of these events names the user or the text (R9 (h)).
    for (const e of h.logger.entries.filter((x) => x.event.startsWith('state.')))
      expect(JSON.stringify(e.fields)).not.toMatch(/ivy|task \d|Not A User/);
  });

  it('removes the entries of deliveries that end without an ack within one run — the agent exits — and a relaunch in the same run re-sends nothing', async () => {
    const h = await harness();
    await launchKeeper(h);
    const c = h.container();
    h.input('one');
    h.input('two');
    await received(h, c, 1);
    await until(async () => {
      expect((await record(h)).entries).toHaveLength(2);
    });
    h.runtime.exit(c, 1);
    await until(() => {
      expect(h.logger.entries.filter((e) => e.event === 'state.redelivery_failed')).toHaveLength(2);
    });
    expect(
      h.logger.entries.filter((e) => e.event === 'state.redelivery_failed').map((e) => [e.level, e.fields['reason']]),
    ).toEqual([
      ['error', 'agent_exited'],
      ['error', 'agent_exited'],
    ]);
    await until(async () => {
      expect((await record(h)).entries).toEqual([]);
    });
    await launchKeeper(h);
    await settle();
    expect(present(h.inbox.get(h.container(1)), `inbox for ${h.container(1)}`)).toEqual([]);
  });
});

describe("a persisted recipient's full record (R9 (a); A8 test 8)", () => {
  it("refuses a user's message and an agent's post and consult, posting nothing, each logged state.pending_full with its kind", async () => {
    const h = await harness();
    await launchKeeper(h);
    // Fill the record: 32 accepted deliveries (the first in hand, the rest waiting).
    for (let i = 0; i < PENDING_MAX_ENTRIES; i += 1) h.input(`m${String(i)}`);
    await until(async () => {
      expect((await record(h)).entries).toHaveLength(PENDING_MAX_ENTRIES);
    });
    const posted = () => h.logger.events().filter((e) => e === 'channel.posted').length;
    const before = posted();
    expect(() => h.input('one too many')).toThrow(
      new PendingFull(
        "agent main/-/keeper's record of unsaved deliveries is full: at most 32 entries and 4194304 bytes",
      ),
    );
    expect(posted()).toBe(before);
    // An agent's post to it, from a delivery another agent holds: CallRefused pending_full, the 409 the SDK throws on.
    const greeter = await h.supervisor.launchNew('greeter', h.main, h.sink);
    expect(greeter.handle).toBe('keep-2');
    h.input('for the greeter', 'ivy', 'keep-2');
    const [heldEntry] = await received(h, h.container(1), 1);
    const held = present(heldEntry, 'the held delivery');
    const container1 = h.container(1);
    const token = present(h.tokens.get(container1), `token for ${container1}`);
    const now = posted();
    const post = () =>
      h.supervisor.post(
        token,
        { kind: 'internal', conversation: held.message.conversation, text: 'hi', to: 'keep-1' },
        'a'.repeat(16),
      );
    expect(post).toThrow(CallRefused);
    expect(post).toThrow(/^pending_full: agent main\/-\/keeper's record of unsaved deliveries is full/);
    // And a consult of it: refused, no call opened.
    expect(() =>
      h.supervisor.consult(token, held.deliveryId, [{ to: 'keep-1', text: 'what?' }], 'b'.repeat(16)),
    ).toThrow(/^pending_full: /);
    expect(posted()).toBe(now);
    expect(
      h.logger.entries
        .filter((e) => e.event === 'state.pending_full')
        .map((e) => [e.level, e.fields['kind'], e.fields['entries']]),
    ).toEqual([
      ['warn', 'input', 33],
      ['warn', 'internal', 33],
      ['warn', 'internal', 33],
      ['warn', 'call_question', 33],
    ]);
  });
});

describe('team members (R9 (e), (i); R10 rollback)', () => {
  it('a team whose second member fails to start stops the first with the persisted stop — checkpointed, then drained 70 s — and discards none of its saved messages', async () => {
    const h = await harness();
    let starts = 0;
    const onStart = h.runtime.onStart;
    h.runtime.onStart = (spec) => {
      starts += 1;
      if (starts === 2)
        queueMicrotask(() => {
          h.runtime.exit(spec.name, 1);
        });
      else onStart(spec);
    };
    await expect(h.supervisor.launchTeam('pair', h.main, h.teamSink)).rejects.toThrow(TeamLaunchFailed);
    // The member that failed was killed; the one online was checkpointed (nothing in hand), then drained with 70 s.
    expect(h.runtime.stopRecords.map((s) => [s.name, s.mode, s.graceS])).toEqual([
      [h.container(1), 'kill', undefined],
      [h.container(0), 'drain', 70],
    ]);
    // The channel's file space was created before the first member started, its root read back (agent-files R10).
    expect(h.runtime.calls.filter((l) => l.startsWith('copyOut'))).toEqual([
      'copyOut asha-abcd1234-0123abcd-main-files /channel',
      `copyOut ${h.container(0)} /memory`,
      `copyOut ${h.container(0)} /workspace`,
    ]);
    expect(h.reports.some((r) => r.startsWith('team launched'))).toBe(false);
  });
});

describe('where state is kept (R2; A2)', () => {
  it('writes only under ASHA_HOME/state/, mode 0700 directories and 0600 files', async () => {
    const h = await harness();
    await launchKeeper(h);
    const c = h.container();
    holds(h, c, { 'a/f.json': '1' }, { 'n.md': 'n' });
    h.input('x');
    const firstReceived = await received(h, c, 1);
    await ackAndSave(h, c, present(firstReceived[0], 'the first delivery'));
    const walk = async (d: string): Promise<string[]> => {
      const out = [d];
      for (const e of await readdir(d, { withFileTypes: true }))
        out.push(...(e.isDirectory() ? await walk(join(d, e.name)) : [join(d, e.name)]));
      return out;
    };
    const paths = await walk(join(h.home, 'state'));
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) {
      const info = await stat(p);
      expect((info.mode & 0o777).toString(8), p).toBe(info.isDirectory() ? '700' : '600');
    }
    // Nothing else of the agent's state anywhere in the home: only state/, logs/ and staging/ exist.
    expect((await readdir(h.home)).sort(byCodeUnit)).toEqual(['logs', 'staging', 'state']);
  });
});
