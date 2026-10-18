// A persisted channel and a team's persisted members (docs/plans/agent-persistence.md R7, R8, R9 (e), R14; A6,
// A8 test 6's team case, A12): the board resumed with its ids and a new session, `state.channel_full` once, a team
// onto an online channel persisting something else refused, a relaunched team getting its handles back, a
// member's re-sends held until the team is whole and one conversation per original message across members, and
// a channel saved while an agent that keeps memory was online marked tainted, which a cloud-granted launch is
// refused onto.

import type { FileSpaces, SnapshotPlan } from '../../src/daemon/files/index.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  MemoryEgressForbidden,
  PersistMismatch,
  TeamLaunchFailed,
  egressRefusal,
} from '../../src/daemon/agents/index.js';
import { parseRecipe } from '../../src/daemon/definitions/index.js';
import { isCloudGrantedRecipe } from '../../src/daemon/modules/index.js';
import { present } from '../../src/shared/assert-present.js';
import { parseModuleManifest } from '../../src/shared/modules.js';
import { FIXTURE_RECIPE } from '../helpers/daemon-fakes.js';
import { cloudToolManifest, providerManifest, toolModuleManifest } from '../helpers/modules.js';
import { BLACKBOARD_MAX_ENTRIES } from '../../src/shared/protocol.js';
import { PersistedChannel, fullStopDeadlines, savedBoard } from '../../src/daemon/agents/persisted.js';
import { StateStore, StateStoreCorrupt, TAR_BLOCK, type ChannelPointer } from '../../src/daemon/state/index.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { harness, settle, until, type Harness } from '../helpers/persistence.js';
import { MemoryStateFs } from '../helpers/state-fakes.js';

/** Acks a delivery and waits for the channel's checkpoint that follows every ack on it. */
async function ackAndBoard(h: Harness, container: string, n: number): Promise<void> {
  const before = h.logger.entries.filter((e) => e.event === 'state.promoted' && e.fields['identity'] === 'main').length;
  const delivery = present(
    present(h.inbox.get(container), `inbox for ${container}`)[n],
    `inbox for ${container}, entry ${String(n)}`,
  );
  h.ack(container, delivery);
  await until(() => {
    expect(
      h.logger.entries.filter((e) => e.event === 'state.promoted' && e.fields['identity'] === 'main').length,
    ).toBeGreaterThan(before);
  });
}

describe("a team's persisted board (R14; A12)", () => {
  it('is resumed after a restart: its entries keep their ids, the next id continues, and every new entry carries the next session', async () => {
    const first = await harness({ daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await first.supervisor.launchTeam('solo', first.main, first.teamSink);
    const c = first.container();
    const token = present(first.tokens.get(c), `token for ${c}`);
    expect(first.supervisor.blackboardPost(token, 'first note')).toMatchObject({
      ok: true,
      entry: { id: 1, session: 1 },
    });
    expect(first.supervisor.blackboardPost(token, 'second note')).toMatchObject({
      ok: true,
      entry: { id: 2, session: 1 },
    });
    first.input('go', 'ivy', 'kim-1');
    await until(() => {
      expect(first.inbox.get(c)).toHaveLength(1);
    });
    await ackAndBoard(first, c, 0);
    const pointer = present(await first.state.readChannelPointer('main'), "channel pointer for 'main'");
    // kim keeps memory, so a channel checkpoint while it is online is tainted (R7).
    expect(pointer).toMatchObject({ kind: 'channel', team: 'solo', memoryTainted: true });
    expect(pointer.assets.board).toMatchObject({ files: 2 });
    // The restart: a new daemon, the team relaunched on a fresh channel.
    const h = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    await h.supervisor.launchTeam('solo', h.main, h.teamSink);
    const hc = h.container();
    const t = present(h.tokens.get(hc), `token for ${hc}`);
    expect(h.supervisor.blackboardRead(t, 0).entries.map((e) => [e.id, e.text, e.session])).toEqual([
      [1, 'first note', 1],
      [2, 'second note', 1],
    ]);
    expect(h.supervisor.blackboardPost(t, 'after the restart')).toMatchObject({
      ok: true,
      entry: { id: 3, session: 2 },
    });
    // The control API's read of the board (docs/plans/patterns-phase-4.md R3): the resumed board as it stands.
    expect(h.supervisor.channelBlackboard(h.main, 0).entries.map((e) => [e.id, e.text, e.session])).toEqual([
      [1, 'first note', 1],
      [2, 'second note', 1],
      [3, 'after the restart', 2],
    ]);
    // The same handle as before, and the welcome names it as its previous one (R8).
    expect(h.reports.filter((r) => r.startsWith('announced'))).toEqual([
      expect.stringMatching(/^announced kim-1 resumed \S+ kim-1$/),
    ]);
  });

  it("logs state.channel_full once per channel per run when the board's bound is reached, with the reset command", async () => {
    const h = await harness();
    await h.supervisor.launchTeam('solo', h.main, h.teamSink);
    const hc = h.container();
    const token = present(h.tokens.get(hc), `token for ${hc}`);
    for (let i = 0; i < BLACKBOARD_MAX_ENTRIES; i += 1) h.supervisor.blackboardPost(token, `n${String(i)}`);
    expect(h.supervisor.blackboardPost(token, 'over')).toEqual({ ok: false, reason: 'blackboard_full' });
    expect(h.supervisor.blackboardPost(token, 'over again')).toEqual({ ok: false, reason: 'blackboard_full' });
    expect(h.logger.entries.filter((e) => e.event === 'state.channel_full').map((e) => [e.level, e.fields])).toEqual([
      ['warn', { channel: 'main', asset: 'board', reset: 'asha --reset-state channel=main' }],
    ]);
  });

  it("refuses a team onto an online channel whose persisted assets differ from the team's: persist_mismatch, naming both", async () => {
    const h = await harness();
    await h.supervisor.launchTeam('plain', h.main, h.teamSink);
    const error = await h.supervisor.launchTeam('solo', h.main, h.teamSink).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamLaunchFailed);
    expect((error as TeamLaunchFailed).cause).toEqual(new PersistMismatch('main', [], 'solo', ['board']));
    expect((error as Error).message).toContain(
      'channel main is online persisting [], and team solo persists [board]; stop it first (asha --stop)',
    );
    expect(h.runtime.starts).toHaveLength(1);
  });
});

describe('team members persisted across a restart (R8, R9 (e); A8 test 6, A12)', () => {
  it("re-sends a message two members' records both hold in one conversation, released only once the team is whole", async () => {
    const first = await harness({ daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await first.supervisor.launchTeam('pair', first.main, first.teamSink);
    // One message to everyone: each member's record holds it; neither acks before the crash.
    first.input('everyone, do it', 'ivy');
    const firstMember0 = first.container(0);
    const firstMember1 = first.container(1);
    await until(() => {
      expect([
        present(first.inbox.get(firstMember0), `inbox for ${firstMember0}`).length,
        present(first.inbox.get(firstMember1), `inbox for ${firstMember1}`).length,
      ]).toEqual([1, 1]);
    });
    const h = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    const conversations: string[] = [];
    const agents = await h.supervisor.launchTeam('pair', h.main, {
      ...h.teamSink,
      launched: (a) => {
        h.teamSink.launched(a);
        // Nothing is released to a member before the team is whole.
        const pending = [...h.inbox.values()].reduce((n, l) => n + l.length, 0);
        conversations.push(`at launched ${a.handle}: ${String(pending)}`);
      },
    });
    expect(agents.map((a) => a.handle)).toEqual(['ann-1', 'bea-1']);
    expect(conversations).toEqual(['at launched ann-1: 0', 'at launched bea-1: 0']);
    const member0 = h.container(0);
    const member1 = h.container(1);
    await until(() => {
      expect([
        present(h.inbox.get(member0), `inbox for ${member0}`).length,
        present(h.inbox.get(member1), `inbox for ${member1}`).length,
      ]).toEqual([1, 1]);
    });
    const a = present(present(h.inbox.get(member0), `inbox for ${member0}`)[0], `inbox for ${member0}, entry 0`);
    const b = present(present(h.inbox.get(member1), `inbox for ${member1}`)[0], `inbox for ${member1}, entry 0`);
    // One conversation, joined by the second member; each delivery to its member alone.
    expect(a.message.conversation).toBe(b.message.conversation);
    expect([a.message.redelivered, b.message.redelivered]).toEqual([expect.any(Object), expect.any(Object)]);
    const aRedelivered = present(a.message.redelivered, "a's redelivered record");
    expect(h.reports.filter((r) => r.startsWith('resent') || r.startsWith('team launched'))).toEqual([
      'team launched ann-1 bea-1',
      `resent ${a.message.conversation} ${aRedelivered.savedAt}`,
      `resent ${a.message.conversation} ${aRedelivered.savedAt}`,
    ]);
    // It settles only once both have acknowledged.
    let settled = false;
    h.main.whenSettled(a.message.conversation, () => (settled = true));
    h.ack(h.container(0), a);
    await settle();
    expect(settled).toBe(false);
    h.ack(h.container(1), b);
    await until(() => {
      expect(settled).toBe(true);
    });
  });

  it('a re-send released at a solo join comes before any other delivery to the agent', async () => {
    const first = await harness({ daemonStartedAt: '2026-09-28T00:00:00.000Z' });
    await first.supervisor.launchNew('keeper', first.main, first.sink);
    first.input('from before', 'ivy');
    await until(() => {
      expect(first.inbox.get(first.container())).toHaveLength(1);
    });
    const h = await harness({ root: first.root, home: first.home, daemonStartedAt: '2026-09-29T00:00:00.000Z' });
    await h.supervisor.launchNew('keeper', h.main, h.sink);
    h.input('after the restart', 'jack');
    const c = h.container();
    await until(() => {
      expect(h.inbox.get(c)).toHaveLength(1);
    });
    expect(present(present(h.inbox.get(c), `inbox for ${c}`)[0], `inbox for ${c}, entry 0`).message.text).toBe(
      'from before',
    );
  });
});

describe('memory kept off cloud-granted agents across sessions (R7; A6)', () => {
  it('records memoryTainted on a channel checkpoint written while an agent that keeps memory is online, and keeps it', async () => {
    const h = await harness();
    // kim's image declares keepsMemory: a checkpoint of the channel while it is online is tainted.
    await h.supervisor.launchTeam('solo', h.main, h.teamSink);
    h.input('go', 'ivy', 'kim-1');
    await until(() => {
      expect(h.inbox.get(h.container())).toHaveLength(1);
    });
    await ackAndBoard(h, h.container(), 0);
    const taintedPointer = present(await h.state.readChannelPointer('main'), "channel pointer for 'main'");
    expect(taintedPointer.memoryTainted).toBe(true);
    expect((await h.state.list()).assets.find((a) => a.kind === 'channel')).toMatchObject({ tainted: true });
  });

  it('refuses a cloud-granted launch onto a tainted channel, naming the reset; allows it untainted, and any launch that is not cloud-granted', () => {
    expect(egressRefusal('main', true, true)).toEqual(new MemoryEgressForbidden('main'));
    expect(new MemoryEgressForbidden('main').message).toBe(
      "channel main's saved state was written while an agent that keeps memory was online on it, so no agent granted a cloud service may join it; remove it with asha --reset-state channel=main",
    );
    expect(egressRefusal('main', true, false)).toBeUndefined();
    expect(egressRefusal('main', false, true)).toBeUndefined();
  });

  it('a recipe is cloud-granted when it grants a module that lists a host, or names a hosted model; never for a local-only module (extension-modules R25, M15)', () => {
    const recipe = (over: Record<string, unknown>) =>
      parseRecipe({ ...FIXTURE_RECIPE, ...over }, 'recipes/greeter.json');
    const installed = new Map([
      ['fixture_tool', { manifest: parseModuleManifest(toolModuleManifest(), 'm'), dir: '/m/fixture_tool' }],
      ['fixture_search', { manifest: parseModuleManifest(cloudToolManifest(), 'm'), dir: '/m/fixture_search' }],
      ['fixture_provider', { manifest: parseModuleManifest(providerManifest(), 'm'), dir: '/m/fixture_provider' }],
    ]);
    expect(isCloudGrantedRecipe(recipe({}), installed)).toBe(false);
    expect(isCloudGrantedRecipe(recipe({ modules: ['fixture_tool/lookup'] }), installed)).toBe(false);
    expect(isCloudGrantedRecipe(recipe({ modules: ['fixture_search/search'] }), installed)).toBe(true);
    expect(isCloudGrantedRecipe(recipe({ model: 'fixture_provider/small' }), installed)).toBe(true);
  });

  it('after --reset-state channel=… the channel is no longer tainted', async () => {
    const h = await harness();
    await h.supervisor.launchTeam('solo', h.main, h.teamSink);
    h.input('go', 'ivy', 'kim-1');
    await until(() => {
      expect(h.inbox.get(h.container())).toHaveLength(1);
    });
    await ackAndBoard(h, h.container(), 0);
    const saved = join(h.state.channelDir('main'), 'current.json');
    const savedPointer = JSON.parse(await readFile(saved, 'utf8')) as ChannelPointer;
    expect(savedPointer.memoryTainted).toBe(true);
    const fresh = await harness({ root: h.root, home: h.home });
    expect(await fresh.state.reset({ channel: 'main' })).not.toBe('nothing_matches');
    expect(await fresh.state.readChannelPointer('main')).toBeUndefined();
    await writeFile(join(h.home, 'marker'), 'x');
  });
});

describe("the stop's final board checkpoint (R10; the completion review's finding 1)", () => {
  it('folds a waiting checkpoint into the final one: one promotion after the running one, no save_failed, nothing after final returns', async () => {
    const fs = new MemoryStateFs();
    const logger = new RecordingLogger();
    const state = new StateStore({
      dir: '/home/state',
      fs,
      logger,
      clock: () => new Date(),
      insideGitTree: () => Promise.resolve(false),
    });
    let n = 0;
    const board = {
      snapshot: () => ({ session: 1, entries: [{ id: ++n, author: 'a', ts: 't', text: 'x', session: 1 }] }),
    };
    const channel = new PersistedChannel({
      channel: 'main',
      team: 't',
      assets: ['board'],
      files: {} as FileSpaces,
      notice: () => undefined,
      state,
      logger,
      board: () => board as never,
      keepsMemoryOnline: () => false,
      pointer: undefined,
      stopDeadlines: () => undefined,
    });
    channel.request(); // running
    channel.request(); // waiting
    await channel.final(fullStopDeadlines(Date.now()));
    const at = () => logger.entries.map((e) => [e.level, e.event, e.fields['generation'] ?? e.fields['reason']]);
    expect(at()).toEqual([
      ['info', 'state.promoted', 1],
      ['info', 'state.promoted', 2],
    ]);
    await settle();
    expect(at()).toHaveLength(2);
    // A request after the final one begins starts nothing.
    channel.request();
    await settle();
    expect(at()).toHaveLength(2);
  });

  it("logs save_failed timeout and saves nothing more when the checkpoint it races against — begun outside any stop, bound by the full STATE_CHECKPOINT_MS — has not finished by final's own tighter bound", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fs = new MemoryStateFs();
      const logger = new RecordingLogger();
      const state = new StateStore({
        dir: '/home/state',
        fs,
        logger,
        clock: () => new Date(),
        insideGitTree: () => Promise.resolve(false),
      });
      const board = { snapshot: () => ({ session: 1, entries: [] }) };
      // The board's write never returns within final's 5 s bound (STATE_STOP_CHECKPOINT_MS), though it would return
      // well within the checkpoint's own, much longer bound (STATE_CHECKPOINT_MS) it was given outside a stop.
      fs.delay = (line) => (line.startsWith('write') && line.endsWith('/board.json') ? 3_600_000 : 0);
      const channel = new PersistedChannel({
        channel: 'main',
        team: 't',
        assets: ['board'],
        files: {} as FileSpaces,
        notice: () => undefined,
        state,
        logger,
        board: () => board as never,
        keepsMemoryOnline: () => false,
        pointer: undefined,
        stopDeadlines: () => undefined,
      });
      channel.request();
      await vi.advanceTimersByTimeAsync(0);
      const finalDone = channel.final(fullStopDeadlines(Date.now()));
      await vi.advanceTimersByTimeAsync(5_000);
      await finalDone;
      expect(logger.entries.map((e) => [e.level, e.event, e.fields['asset'], e.fields['reason']])).toEqual([
        ['error', 'state.save_failed', 'board', 'timeout'],
      ]);
      expect(logger.entries.filter((e) => e.event === 'state.promoted')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('writeFilesAsset (agent-files R15): a snapshot that answers not ok fails the checkpoint', () => {
  it("logs save_failed copy_failed naming the snapshot's own detail, nothing promoted, noticed once", async () => {
    const fs = new MemoryStateFs();
    const logger = new RecordingLogger();
    const state = new StateStore({
      dir: '/home/state',
      fs,
      logger,
      clock: () => new Date(),
      insideGitTree: () => Promise.resolve(false),
    });
    const notices: string[] = [];
    const files = {
      // Streams a structurally valid (if empty) tar — its end-of-archive blocks, as a real docker cp always ends
      // with — so writeTar's own normaliser succeeds; only afterward does the snapshot itself answer not ok, as a
      // real one does when the lock could not be acquired before the checkpoint's signal aborted.
      snapshot: async (
        _channel: string,
        start: (taken: SnapshotPlan) => (chunk: Buffer) => Promise<'more' | 'stop'>,
      ) => {
        const push = start({ skip: () => false, table: [] });
        await push(Buffer.alloc(2 * TAR_BLOCK));
        return { ok: false as const, detail: 'the checkpoint ended before the space was free' };
      },
    } as unknown as FileSpaces;
    const channel = new PersistedChannel({
      channel: 'main',
      team: 't',
      assets: ['files'],
      files,
      notice: (text) => notices.push(text),
      state,
      logger,
      board: () => ({ snapshot: () => ({ session: 1, entries: [] }) }) as never,
      keepsMemoryOnline: () => false,
      pointer: undefined,
      stopDeadlines: () => undefined,
    });
    channel.request();
    await settle();
    expect(logger.entries.map((e) => [e.level, e.event, e.fields['asset'], e.fields['reason']])).toEqual([
      ['error', 'state.save_failed', 'files', 'copy_failed'],
    ]);
    expect(logger.entries.find((e) => e.event === 'state.save_failed')?.fields['error']).toEqual(
      new Error('the checkpoint ended before the space was free'),
    );
    expect(notices).toEqual([
      "⚠ channel main's files are not being saved (copy_failed); what changes in /channel from now on is lost when it stops",
    ]);
    expect(logger.entries.filter((e) => e.event === 'state.promoted')).toEqual([]);
  });
});

describe('savedBoard (agent-persistence R14): a malformed board fails loudly, StateStoreCorrupt', () => {
  async function pointerWithBoard(
    content: string,
  ): Promise<{ readonly state: StateStore; readonly pointer: ChannelPointer }> {
    const fs = new MemoryStateFs();
    const state = new StateStore({
      dir: '/home/state',
      fs,
      logger: new RecordingLogger(),
      clock: () => new Date(),
      insideGitTree: () => Promise.resolve(false),
    });
    const dir = state.channelDir('main');
    const gen = await state.begin(dir);
    await gen.writeJson('board', { session: 1, entries: [] }, 0);
    const pointer = await gen.promote<ChannelPointer>(
      { kind: 'channel', team: 't', lastDelivery: null, memoryTainted: false },
      'main',
    );
    fs.files.set(state.assetPath(dir, pointer, 'board'), Buffer.from(content));
    return { state, pointer };
  }

  it('not JSON: StateStoreCorrupt naming the parse error', async () => {
    const { state, pointer } = await pointerWithBoard('{not json');
    const path = state.assetPath(state.channelDir('main'), pointer, 'board');
    await expect(savedBoard(state, pointer, 'main')).rejects.toEqual(
      new StateStoreCorrupt(path, 'not JSON (SyntaxError)'),
    );
  });

  it('valid JSON but the wrong shape: StateStoreCorrupt naming the rule', async () => {
    const { state, pointer } = await pointerWithBoard(JSON.stringify({ session: 0, entries: [] }));
    const path = state.assetPath(state.channelDir('main'), pointer, 'board');
    await expect(savedBoard(state, pointer, 'main')).rejects.toEqual(
      new StateStoreCorrupt(path, 'not a board: expected {session, entries: [{id, author, ts, text, session}]}'),
    );
  });

  it('an entry of the wrong shape is also refused', async () => {
    const { state, pointer } = await pointerWithBoard(
      JSON.stringify({ session: 1, entries: [{ id: 1, author: 'a', ts: 't', text: 'x' }] }),
    );
    await expect(savedBoard(state, pointer, 'main')).rejects.toThrow(StateStoreCorrupt);
  });
});
