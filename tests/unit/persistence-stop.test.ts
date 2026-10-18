// A persisted agent's stop, on a fake clock (docs/plans/agent-persistence.md R10; A8a cases 1–9, A13): no signal
// until its delivery in hand is acknowledged — until S+65 s in a full stop — then its checkpoint, bounded by 5 s,
// then `drain` with the whole seconds left to S+70 s and never fewer than 3; with no ack, stop_unsaved and `kill`;
// nothing released once the stop begins; a persisted channel's board checkpointed once its persisted agents are
// checkpointed and its other agents have exited; the whole full stop ending at 85 s against the CLI's 90 s (case 8, corrected from 86 s); and
// the same sequence run to the bounded stop's deadlines. The filesystem is in memory, so fake time alone drives it.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityInUse, boundedStopDeadlines } from '../../src/daemon/agents/index.js';
import { STATE_CHECKPOINT_MS } from '../../src/daemon/agents/persisted.js';
import { stopDaemon } from '../../src/daemon/compose.js';
import { PendingRecord } from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import type { Delivery } from '../../src/shared/protocol.js';
import { assetTar, harness, type Harness } from '../helpers/persistence.js';
import { MemoryStateFs } from '../helpers/state-fakes.js';

const S = 0;
const IDENTITY = { channel: 'main', team: null, name: 'keeper' };

let fs: MemoryStateFs;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: S });
  fs = new MemoryStateFs();
});
afterEach(() => {
  vi.useRealTimers();
});

/** The keeper online on main, holding `delivery` (released, unacknowledged), its copies taking `copyMs` for /memory. */
async function holding(copyMs = 0): Promise<{ h: Harness; c: string; delivery: Delivery }> {
  const h = await harness({ fs });
  await h.supervisor.launchNew('keeper', h.main, h.sink);
  const c = h.container();
  present(h.runtime.contents.get(c), `runtime contents for ${c}`).set(
    '/memory',
    assetTar('memory', { 'u/f.json': 'saved' }),
  );
  h.runtime.onCopy = (_name, path) =>
    path === '/memory' && copyMs > 0
      ? new Promise((resolve) =>
          setTimeout(() => {
            resolve(undefined);
          }, copyMs),
        )
      : Promise.resolve(undefined);
  h.input('task');
  await vi.advanceTimersByTimeAsync(0);
  return { h, c, delivery: present(present(h.inbox.get(c), `inbox for ${c}`)[0], `inbox for ${c}, entry 0`) };
}

/** Advances fake time to `at` ms. */
async function to(at: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(at - Date.now());
}

const stops = (h: Harness) => h.runtime.stopRecords.map((s) => [s.mode, s.graceS, s.at]);
const at = (h: Harness, event: string) => h.logger.entries.filter((e) => e.event === event);

describe('the full stop of a persisted agent (A8a cases 1–6)', () => {
  it('(1) an ack at 50 s — past the old 30 s wait — is awaited with no signal, checkpointed, then drained with the seconds left to 70 s', async () => {
    const { h, c, delivery } = await holding(4_900);
    const stopping = h.supervisor.stopAll('daemon stopping');
    await to(49_999);
    expect(h.runtime.stopRecords).toEqual([]);
    await to(50_000);
    h.ack(c, delivery);
    await to(54_900);
    await stopping;
    expect(stops(h)).toEqual([['drain', 15, 54_900]]);
    // The turn's writes are in the promoted generation, and its entry is gone.
    expect(at(h, 'state.promoted').map((e) => e.fields['generation'])).toEqual([1]);
    expect((await PendingRecord.load({ fs, dir: h.state.agentDir(IDENTITY) })).entries).toEqual([]);
  });

  it('(2) an ack at 64.9 s and a 5 s checkpoint: drain with the 3 s floor at 69.9 s, never 0; it exits 143, agent.exited, no agent.stop_killed', async () => {
    const { h, c, delivery } = await holding(5_000);
    const stopping = h.supervisor.stopAll('daemon stopping');
    await to(64_900);
    h.ack(c, delivery);
    await to(69_900);
    await stopping;
    expect(stops(h)).toEqual([['drain', 3, 69_900]]);
    expect(at(h, 'agent.exited').map((e) => e.fields['code'])).toEqual([143]);
    expect(at(h, 'agent.stop_killed')).toEqual([]);
  });

  it('(3) with nothing in flight, it checkpoints at once — before any runtime.stop — then drains with the whole 70 s, the stop having begun at 1 s', async () => {
    const { h, c, delivery } = await holding();
    h.ack(c, delivery);
    await vi.advanceTimersByTimeAsync(0);
    const promotedBefore = at(h, 'state.promoted').length;
    await to(1_000);
    const stopping = h.supervisor.stopAll('daemon stopping');
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    expect(at(h, 'state.promoted')).toHaveLength(promotedBefore + 1);
    expect(h.runtime.calls.filter((l) => l.startsWith('copyOut') || l.startsWith('stop')).slice(-3)).toEqual([
      `copyOut ${c} /memory`,
      `copyOut ${c} /workspace`,
      `stop ${c} drain 70`,
    ]);
    expect(stops(h)).toEqual([['drain', 70, 1_000]]);
  });

  it('(4) an ack that comes at 66 s: stop_unsaved at 65 s and kill at once; its entry kept for the next run; the late ack not checkpointed', async () => {
    const { h, c, delivery } = await holding();
    const stopping = h.supervisor.stopAll('daemon stopping');
    await to(65_000);
    await stopping;
    expect(stops(h)).toEqual([['kill', undefined, 65_000]]);
    expect(at(h, 'state.stop_unsaved').map((e) => [e.level, e.fields])).toEqual([
      ['warn', { identity: 'main/-/keeper' }],
    ]);
    await to(66_000);
    expect(() => {
      h.ack(c, delivery);
    }).toThrow('token is not a running agent');
    expect(at(h, 'state.promoted')).toEqual([]);
    expect((await PendingRecord.load({ fs, dir: h.state.agentDir(IDENTITY) })).entries.map((e) => e.text)).toEqual([
      'task',
    ]);
  });

  it('(5) a checkpoint that never finishes is abandoned at 5 s, save_failed timeout, the previous generation byte-identical, then drained with the floor or more', async () => {
    const { h, c, delivery } = await holding();
    h.ack(c, delivery);
    await vi.advanceTimersByTimeAsync(0);
    const before = new Map(fs.files);
    h.runtime.onCopy = () => new Promise(() => undefined);
    const stopping = h.supervisor.stopAll('daemon stopping');
    await to(5_000);
    await stopping;
    expect(at(h, 'state.save_failed').map((e) => [e.fields['reason'], e.fields['asset']])).toEqual([
      ['timeout', 'memory'],
    ]);
    for (const [path, bytes] of before)
      if (path.includes('/gen-1/') || path.endsWith('current.json'))
        expect(present(fs.files.get(path), `file at ${path}`).equals(bytes), path).toBe(true);
    expect([...fs.dirs].filter((d) => /\/gen-\d+$/.test(d))).toEqual([`${h.state.agentDir(IDENTITY)}/gen-1`]);
    expect(stops(h)).toEqual([['drain', 65, 5_000]]);
  });

  it('(5b) the bound holds whatever hangs: a checkpoint whose write of memory.tar never returns is abandoned at 5 s too, and logged once', async () => {
    const { h, c, delivery } = await holding();
    h.ack(c, delivery);
    await vi.advanceTimersByTimeAsync(0);
    const promoted = at(h, 'state.promoted').length;
    let held = false;
    fs.delay = (line) =>
      !held && line.startsWith('write') && line.endsWith('/memory.tar') ? ((held = true), 3_600_000) : 0;
    const stopping = h.supervisor.stopAll('daemon stopping');
    await to(5_000);
    await stopping;
    expect(at(h, 'state.save_failed').map((e) => [e.fields['reason'], e.fields['asset']])).toEqual([
      ['timeout', 'memory'],
    ]);
    expect(stops(h)).toEqual([['drain', 65, 5_000]]);
    // The write returns an hour later: the abandoned generation is discarded, nothing promoted, nothing more logged.
    await to(3_605_000);
    expect(at(h, 'state.promoted')).toHaveLength(promoted);
    expect(at(h, 'state.save_failed')).toHaveLength(1);
    expect([...fs.dirs].filter((d) => /\/gen-\d+$/.test(d))).toEqual([`${h.state.agentDir(IDENTITY)}/gen-1`]);
  });

  it('(5c) outside a stop, a checkpoint that hangs is abandoned at STATE_CHECKPOINT_MS, and the next delivery is released', async () => {
    const { h, c, delivery } = await holding();
    h.input('second');
    await vi.advanceTimersByTimeAsync(0);
    let held = false;
    fs.delay = (line) =>
      !held && line.startsWith('write') && line.endsWith('/memory.tar') ? ((held = true), 3_600_000) : 0;
    h.ack(c, delivery);
    await to(STATE_CHECKPOINT_MS - 1);
    expect(at(h, 'state.save_failed')).toEqual([]);
    expect(present(h.inbox.get(c), `inbox for ${c}`).map((d) => d.message.text)).toEqual(['task']);
    await to(STATE_CHECKPOINT_MS);
    expect(at(h, 'state.save_failed').map((e) => [e.fields['reason'], e.fields['asset']])).toEqual([
      ['timeout', 'memory'],
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(present(h.inbox.get(c), `inbox for ${c}`).map((d) => d.message.text)).toEqual(['task', 'second']);
  });

  it('(5d) outside a stop, a copy that finally returns long after its own bound is discarded quietly too, nothing logged or promoted again', async () => {
    const { h, c, delivery } = await holding();
    await vi.advanceTimersByTimeAsync(0);
    let held = false;
    // workspace, the *last* asset: by the time its write finally returns, every asset before it (memory) has
    // already copied cleanly, so copyAssets resolves with no failure of its own — only then does save() see the
    // signal its own bound aborted long ago, and discards the generation itself (persisted.ts save(), ~line 540).
    fs.delay = (line) =>
      !held && line.startsWith('write') && line.endsWith('/workspace.tar') ? ((held = true), 3_600_000) : 0;
    h.ack(c, delivery);
    await to(STATE_CHECKPOINT_MS);
    expect(at(h, 'state.save_failed').map((e) => [e.fields['reason'], e.fields['asset']])).toEqual([
      ['timeout', 'memory'],
    ]);
    // The write that was abandoned finally returns, an hour after it began: discarded in the background — nothing
    // ever promoted, nothing more said — the comment on PersistedAgent.save() names this exactly (R10's own-bound
    // race, as opposed to a stop's tighter one, which (5), (5b) and (5c) above already cover).
    await to(STATE_CHECKPOINT_MS + 3_600_000 + 10_000);
    expect(at(h, 'state.save_failed')).toHaveLength(1);
    expect(at(h, 'state.promoted')).toEqual([]);
    expect([...fs.dirs].filter((d) => /\/gen-\d+$/.test(d))).toEqual([]);
  });

  it("a generation already on disk where the checkpoint's own would go fails it write_failed, logged, nothing promoted", async () => {
    const { h, c, delivery } = await holding();
    // Nothing has promoted yet (no pointer): the checkpoint's own begin() would take gen-1 — already there.
    fs.dirs.add(`${h.state.agentDir(IDENTITY)}/gen-1`);
    h.ack(c, delivery);
    await vi.advanceTimersByTimeAsync(0);
    expect(at(h, 'state.save_failed').map((e) => [e.fields['reason'], e.fields['asset']])).toEqual([
      ['write_failed', 'memory'],
    ]);
    expect(at(h, 'state.promoted')).toEqual([]);
  });

  it('a reset holds what it removes: a launch of the identity while it runs is refused identity_in_use, and succeeds after (the completion review, finding 7)', async () => {
    const { h, c, delivery } = await holding();
    h.ack(c, delivery);
    await vi.advanceTimersByTimeAsync(0);
    h.runtime.exit(c, 0);
    await vi.advanceTimersByTimeAsync(0);
    fs.delay = (line) => (line.startsWith('remove') && line.endsWith('/keeper') ? 1_000 : 0);
    const resetting = h.supervisor.state.reset({ channel: 'main', name: 'keeper' });
    await vi.advanceTimersByTimeAsync(10);
    await expect(h.supervisor.launchNew('keeper', h.main, h.sink)).rejects.toThrow(new IdentityInUse('main/-/keeper'));
    await to(Date.now() + 1_000);
    expect(await resetting).toMatchObject({ ok: true });
    fs.delay = () => 0;
    await h.supervisor.launchNew('keeper', h.main, h.sink);
    expect(h.runtime.starts).toHaveLength(2);
  });

  it("(6) a delivery another agent posts to it during the ack wait is recorded and synced, never released — not even when the stop's checkpoint is promoted — and kept for the next run", async () => {
    const { h, c, delivery } = await holding();
    await h.supervisor.launchNew('greeter', h.main, h.sink);
    const g = h.container(1);
    h.input('for greeter', 'ivy', 'keep-2');
    await vi.advanceTimersByTimeAsync(0);
    const held = present(present(h.inbox.get(g), `inbox for ${g}`)[0], `inbox for ${g}, entry 0`);
    h.runtime.onStop = (name, mode) => {
      // The greeter drains for 10 s, finishing its turn — which posts to the keeper — while the stop runs.
      if (name === g)
        setTimeout(() => {
          h.runtime.exit(name, 143);
        }, 10_000);
      else h.runtime.exit(name, mode === 'drain' ? 143 : 137);
      return Promise.resolve();
    };
    const stopping = h.supervisor.stopAll('daemon stopping');
    await to(1_000);
    h.supervisor.post(
      present(h.tokens.get(g), `token for ${g}`),
      { kind: 'internal', conversation: held.message.conversation, to: 'keep-1', text: 'late' },
      'c'.repeat(16),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fs.calls.filter((l) => l.includes('pending.json'))).toContain(
      `replace ${h.state.agentDir(IDENTITY)}/pending.json`,
    );
    await to(2_000);
    h.ack(c, delivery);
    await to(20_000);
    await stopping;
    expect(present(h.inbox.get(c), `inbox for ${c}`).map((d) => d.message.text)).toEqual(['task']);
    expect(
      (await PendingRecord.load({ fs, dir: h.state.agentDir(IDENTITY) })).entries.map((e) => [e.kind, e.messageId]),
    ).toEqual([['internal', expect.any(String)]]);
  });
});

describe("a persisted channel's final checkpoint, and the whole stop's timing (A8a cases 7, 8)", () => {
  it("(7) starts only once the persisted agent's checkpoint is promoted and the other agent has exited at its 70 s grace", async () => {
    const h = await harness({ fs });
    await h.supervisor.launchTeam('mixed', h.main, h.teamSink);
    const [lee, pat] = [h.container(0), h.container(1)];
    h.runtime.onStop = (name, mode) => {
      if (name === pat && mode === 'drain')
        setTimeout(() => {
          h.runtime.exit(name, 137);
        }, 70_000);
      else h.runtime.exit(name, mode === 'drain' ? 143 : 137);
      return Promise.resolve();
    };
    h.input('for lee', 'ivy', 'lee-1');
    await vi.advanceTimersByTimeAsync(0);
    const delivery = present(present(h.inbox.get(lee), `inbox for ${lee}`)[0], `inbox for ${lee}, entry 0`);
    const stopping = h.supervisor.stopAll('daemon stopping');
    await to(20_000);
    h.ack(lee, delivery);
    await to(69_999);
    const board = () => fs.calls.filter((l) => l.startsWith('create') && l.endsWith('/board.json'));
    // The ack's checkpoint of the board (every ack on the channel) is done; the final one waits for pat.
    const beforeFinal = board().length;
    await to(70_000);
    await stopping;
    expect(board()).toHaveLength(beforeFinal + 1);
    expect(stops(h)).toEqual([
      ['drain', 70, 0],
      ['drain', 50, 20_000],
    ]);
  });

  it('(8) the worst case ends daemon.stopped at 85.000 s: an ack at 64.999 s and a 5 s checkpoint, an agent killed at 70 s, the channel 70–75 s, then the reclaim (1 s) beside the model servers (10 s; extension-modules A38 (d), corrected from 86.000 s)', async () => {
    const h = await harness({ fs });
    await h.supervisor.launchTeam('mixed', h.main, h.teamSink);
    const [lee, pat] = [h.container(0), h.container(1)];
    h.runtime.onStop = (name, mode) => {
      if (name === pat && mode === 'drain')
        setTimeout(() => {
          h.runtime.exit(name, 137);
        }, 70_000);
      else h.runtime.exit(name, mode === 'drain' ? 143 : 137);
      return Promise.resolve();
    };
    h.runtime.onCopy = (_n, path) =>
      path === '/memory'
        ? new Promise((resolve) =>
            setTimeout(() => {
              resolve(undefined);
            }, 5_000),
          )
        : Promise.resolve(undefined);
    h.input('for lee', 'ivy', 'lee-1');
    await vi.advanceTimersByTimeAsync(0);
    const delivery = present(present(h.inbox.get(lee), `inbox for ${lee}`)[0], `inbox for ${lee}, entry 0`);
    // The board's final write takes its whole 5 s.
    fs.delay = (line) => (line.startsWith('write') && line.endsWith('/board.json') && Date.now() >= 70_000 ? 5_000 : 0);
    const stopped = stopDaemon({
      logger: h.logger,
      beginStopping: () => Promise.resolve(undefined),
      removeDaemonFile: () => Promise.resolve(undefined),
      supervisor: h.supervisor,
      closeServer: () => Promise.resolve(undefined),
      runtime: {
        reclaim: () =>
          new Promise((resolve) =>
            setTimeout(() => {
              resolve({ volumes: 0 });
            }, 1_000),
          ),
      },
      modelServer: { stopAll: () => new Promise((resolve) => setTimeout(resolve, 10_000)) },
      closeTraces: () => undefined,
      release: () => Promise.resolve(undefined),
    });
    await to(64_999);
    h.ack(lee, delivery);
    await to(85_000);
    await stopped;
    const times = new Map(h.logger.entries.map((e, i) => [`${e.event}#${String(i)}`, e]));
    expect(times.size).toBeGreaterThan(0);
    expect(stops(h)).toEqual([
      ['drain', 70, 0],
      ['drain', 3, 69_999],
    ]);
    expect(Date.now()).toBe(85_000);
    expect(h.logger.events().at(-1)).toBe('daemon.stopped');
  });
});

describe("a stop's timeline is fake time's alone (the portal's completion review, finding 5)", () => {
  // Case (8) timed out about once in 200 loaded runs: an agent's exit read its log file's tail on the way to `gone`,
  // which every stop waits on, so a real read finishing after fake time had moved on shifted the stop (75 s, 85 s, or
  // never). The tail is for a launch that failed; a stop must not wait on reading it.
  it("an online agent's stop ends with no read of its log: with the log a FIFO nobody writes, the stop still ends", async () => {
    const { h, c, delivery } = await holding();
    h.ack(c, delivery);
    await vi.advanceTimersByTimeAsync(0);
    // Opening a FIFO with no writer never returns: a read of the log would hold the stop for ever.
    execFileSync('mkfifo', [join(h.home, 'logs', 'agents', `${c}.log`)]);
    let ended = false;
    void h.supervisor.stopAll('daemon stopping').then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(0);
    // Real turns of the event loop: none is needed, and a read could not finish in them anyway.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect([ended, Date.now()]).toEqual([true, 0]);
    expect(at(h, 'agent.exited').map((e) => e.fields['container'])).toEqual([c]);
  });
});

describe("the persisted stop run to the bounded stop's deadlines (A8a case 9)", () => {
  it('an ack at 29 s: a checkpoint ending by 34 s, then drain with 6 s (40 − 34)', async () => {
    const { h, c, delivery } = await holding(4_900);
    const stopping = h.supervisor.stopAll('SIGTERM', boundedStopDeadlines(0));
    await to(29_000);
    h.ack(c, delivery);
    await to(34_000);
    await stopping;
    expect(stops(h)).toEqual([['drain', 6, 33_900]]);
  });

  it('no ack by 30 s: stop_unsaved and kill at 30 s', async () => {
    const { h } = await holding();
    const stopping = h.supervisor.stopAll('SIGTERM', boundedStopDeadlines(0));
    await to(30_000);
    await stopping;
    expect(stops(h)).toEqual([['kill', undefined, 30_000]]);
    expect(at(h, 'state.stop_unsaved')).toHaveLength(1);
  });

  it('a checkpoint still running at T+35 s is abandoned, timeout; a channel checkpoint starting at T+35 s is abandoned at T+40 s', async () => {
    const h = await harness({ fs });
    await h.supervisor.launchTeam('mixed', h.main, h.teamSink);
    await to(32_000);
    // The stop's clock started 32 s ago (T = 0): nothing in flight, the checkpoint starts now, capped at T+35 s.
    h.runtime.onCopy = () => new Promise(() => undefined);
    fs.delay = (line) => (line.startsWith('write') && line.endsWith('/board.json') ? 60_000 : 0);
    const stopping = h.supervisor.stopAll('SIGTERM', boundedStopDeadlines(0));
    await to(35_000);
    expect(at(h, 'state.save_failed').map((e) => [e.fields['identity'], e.fields['reason']])).toEqual([
      ['main/mixed/lee', 'timeout'],
    ]);
    await to(40_000);
    await stopping;
    expect(at(h, 'state.save_failed').map((e) => [e.fields['identity'], e.fields['reason']])).toEqual([
      ['main/mixed/lee', 'timeout'],
      ['main', 'timeout'],
    ]);
  });
});

describe("one channel's stop of a persisted agent (docs/plans/portal-demo-stop.md R2): as the daemon's full stop, from its own start", () => {
  it("no ack by 65 s: stop_unsaved and kill at 65 s; its entry kept for the next run, as at the daemon's stop, not removed as agent_exited", async () => {
    const { h } = await holding();

    const stopping = h.supervisor.stopChannel('main', 'cli', () => undefined);
    await to(65_000);
    await expect(stopping).resolves.toEqual(['keep-1']);

    expect(stops(h)).toEqual([['kill', undefined, 65_000]]);
    expect(at(h, 'state.stop_unsaved').map((e) => [e.level, e.fields])).toEqual([
      ['warn', { identity: 'main/-/keeper' }],
    ]);
    expect(at(h, 'state.redelivery_failed')).toEqual([]);
    expect((await PendingRecord.load({ fs, dir: h.state.agentDir(IDENTITY) })).entries.map((e) => e.text)).toEqual([
      'task',
    ]);
  });

  it('a checkpoint that never finishes is abandoned at 5 s, save_failed timeout, then drained with the seconds left to 70 s', async () => {
    const { h, c, delivery } = await holding();
    h.ack(c, delivery);
    await vi.advanceTimersByTimeAsync(0);
    h.runtime.onCopy = () => new Promise(() => undefined);

    const stopping = h.supervisor.stopChannel('main', 'cli', () => undefined);
    await to(5_000);
    await stopping;

    expect(at(h, 'state.save_failed').map((e) => [e.fields['reason'], e.fields['asset']])).toEqual([
      ['timeout', 'memory'],
    ]);
    expect(stops(h)).toEqual([['drain', 65, 5_000]]);
  });

  it('releases no delivery to a persisted agent once the stop begins: one posted to it then is recorded, never released, and kept', async () => {
    const { h, c, delivery } = await holding();
    await h.supervisor.launchNew('greeter', h.main, h.sink);
    const g = h.container(1);
    h.input('for greeter', 'ivy', 'keep-2');
    await vi.advanceTimersByTimeAsync(0);
    const held = present(present(h.inbox.get(g), `inbox for ${g}`)[0], `inbox for ${g}, entry 0`);
    h.runtime.onStop = (name, mode) => {
      // The greeter drains for 10 s, finishing its turn — which posts to the keeper — while the stop runs.
      if (name === g)
        setTimeout(() => {
          h.runtime.exit(name, 143);
        }, 10_000);
      else h.runtime.exit(name, mode === 'drain' ? 143 : 137);
      return Promise.resolve();
    };

    const stopping = h.supervisor.stopChannel('main', 'cli', () => undefined);
    await to(1_000);
    h.supervisor.post(
      present(h.tokens.get(g), `token for ${g}`),
      { kind: 'internal', conversation: held.message.conversation, to: 'keep-1', text: 'late' },
      'c'.repeat(16),
    );
    await to(2_000);
    h.ack(c, delivery);
    await to(20_000);
    await stopping;

    expect(present(h.inbox.get(c), `inbox for ${c}`).map((d) => d.message.text)).toEqual(['task']);
    expect(
      (await PendingRecord.load({ fs, dir: h.state.agentDir(IDENTITY) })).entries.map((e) => [e.kind, e.messageId]),
    ).toEqual([['internal', expect.any(String)]]);
  });

  it("a daemon stop that comes during a channel's stop leaves the channel's final checkpoint to it: once, and no EEXIST", async () => {
    const h = await harness({ fs });
    await h.supervisor.launchTeam('pair', h.main, h.teamSink);
    const boards = () => fs.calls.filter((l) => l.startsWith('create') && l.endsWith('/board.json')).length;
    const before = boards();
    fs.delay = (line) => (line.startsWith('write') && line.endsWith('/board.json') ? 2_000 : 0);

    const channelStop = h.supervisor.stopChannel('main', 'cli', () => undefined);
    await to(500);
    const daemonStop = h.supervisor.stopAll('daemon stopping');
    await to(20_000);
    await channelStop;
    await daemonStop;

    expect(at(h, 'state.save_failed')).toEqual([]);
    expect(boards() - before).toBe(1);
  });

  it('a board checkpoint an ack begins during the stop is bounded by 5 s, not the 60 s of a checkpoint outside a stop', async () => {
    const h = await harness({ fs });
    await h.supervisor.launchTeam('pair', h.main, h.teamSink);
    const [ann, bea] = [h.container(0), h.container(1)];
    h.input('for ann', 'ivy', 'ann-1');
    h.input('for bea', 'ivy', 'bea-1');
    await vi.advanceTimersByTimeAsync(0);
    const forAnn = present(present(h.inbox.get(ann), `inbox for ${ann}`)[0], `inbox for ${ann}, entry 0`);
    const forBea = present(present(h.inbox.get(bea), `inbox for ${bea}`)[0], `inbox for ${bea}, entry 0`);
    fs.delay = (line) => (line.startsWith('write') && line.endsWith('/board.json') ? 60_000 : 0);
    const boardFailures = () =>
      at(h, 'state.save_failed')
        .filter((e) => e.fields['identity'] === 'main')
        .map((e) => e.fields['reason']);

    const stopping = h.supervisor.stopChannel('main', 'cli', () => undefined);
    // ann's ack begins its checkpoint and the board's; bea still holds hers, so the channel's final has not begun.
    await to(20_000);
    h.ack(ann, forAnn);
    await to(24_999);
    expect(boardFailures()).toEqual([]);
    await to(25_000);
    expect(boardFailures()).toEqual(['timeout']);
    await to(30_000);
    h.ack(bea, forBea);
    await to(90_000);
    await stopping;
  });
});
