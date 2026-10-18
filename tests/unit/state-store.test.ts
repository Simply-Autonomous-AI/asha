// The state store (docs/plans/agent-persistence.md R2, R4, R5, R6, R11; A3, A4, A9): generations promoted
// atomically — every file and the generation's directory fsynced before the pointer's rename, the identity's
// directory fsynced after it — a crash at any point leaving the previous pointer and generation byte-identical, what
// a crash left removed at the next start, links and special files refused, and listing and reset exactly.

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ASSET_BOUNDS,
  FILES_BOUNDS,
  PENDING_MAX_BYTES,
  PENDING_MAX_ENTRIES,
  PendingRecord,
  PendingRecordInvalid,
  StateInsideGitTree,
  StateStore,
  StateStoreCorrupt,
  TAR_BLOCK,
  parsePending,
  parsePointer,
  selectorProblem,
  tarDirectory,
  tarFile,
  type AgentIdentity,
  type AgentPointer,
  type ChannelPointer,
  type PendingEntry,
} from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { InjectedFault, SpyFs } from '../helpers/state-fakes.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const AGENT: AgentIdentity = { channel: 'lab', team: 'duo', name: 'keeper' };

/** A snapshot as `docker cp <c>:/memory -` would give it: memory/, then each file. */
function snapshot(files: Record<string, string>, root = 'memory'): Buffer {
  const parts = [tarDirectory(root, 1)];
  for (const [name, content] of Object.entries(files)) parts.push(tarFile(`${root}/${name}`, Buffer.from(content), 1));
  parts.push(Buffer.alloc(2 * TAR_BLOCK));
  return Buffer.concat(parts);
}

const feed =
  (archive: Buffer, chunk = 1000) =>
  async (push: (c: Uint8Array) => Promise<unknown>) => {
    for (let i = 0; i < archive.length; i += chunk)
      if ((await push(archive.subarray(i, i + chunk))) !== undefined) return;
  };

const META = {
  kind: 'agent' as const,
  recipe: 'keeper',
  image: 'memory',
  source: `sha256:${'a'.repeat(64)}`,
  schema: '1',
  lastDelivery: 'd1',
  handle: 'keeper-1',
};

let home: string;
let spy: SpyFs;
let logger: RecordingLogger;
let gitChecks: string[];
let store: StateStore;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'asha-state-')));
  spy = new SpyFs(home);
  logger = new RecordingLogger();
  gitChecks = [];
  store = new StateStore({
    dir: join(home, 'state'),
    fs: spy,
    logger,
    clock: () => new Date('2026-09-29T10:00:00.000Z'),
    insideGitTree: (path) => {
      gitChecks.push(path);
      return Promise.resolve(false);
    },
  });
});

/** Writes and promotes one generation of AGENT's memory holding `files`. */
async function save(files: Record<string, string>, delivery = 'd1'): Promise<AgentPointer> {
  const gen = await store.begin(store.agentDir(AGENT));
  const result = await gen.writeTar('memory', ASSET_BOUNDS.memory, feed(snapshot(files)));
  expect(result.ok).toBe(true);
  return gen.promote<AgentPointer>({ ...META, lastDelivery: delivery }, 'lab/duo/keeper');
}

/** Every file under the identity's directory with its sha256: what "byte-identical" compares. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), `${prefix}${e.name}/`);
      else out[`${prefix}${e.name}`] = sha(await readFile(join(d, e.name)));
    }
  };
  await walk(dir, '');
  return out;
}

describe('a checkpoint (R4, A3)', () => {
  it('promotes in order: each file written and fsynced, the generation fsynced, the pointer replaced, the identity fsynced, then the previous generation removed', async () => {
    await save({ 'a/facts.json': 'one' });
    spy.calls.length = 0;
    const second = await save({ 'a/facts.json': 'two' }, 'd2');
    const dir = 'state/agents/lab/duo/keeper';
    expect(spy.calls).toEqual([
      `mkdirExclusive ${dir}/gen-2`,
      `create ${dir}/gen-2/memory.tar`,
      ...spy.calls.filter((c) => c.startsWith('write ')),
      `sync ${dir}/gen-2/memory.tar`,
      `close ${dir}/gen-2/memory.tar`,
      `fsyncDir ${dir}/gen-2`,
      `replace ${dir}/current.json`,
      `fsyncDir ${dir}`,
      `remove ${dir}/gen-1`,
    ]);
    expect(second).toEqual({
      ...META,
      lastDelivery: 'd2',
      generation: 2,
      savedAt: '2026-09-29T10:00:00.000Z',
      assets: {
        memory: {
          bytes: expect.any(Number) as number,
          files: 1,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        },
      },
    });
    expect(JSON.parse(await readFile(join(home, dir, 'current.json'), 'utf8'))).toEqual(second);
    expect(logger.entries.filter((e) => e.event === 'state.promoted').map((e) => [e.level, e.fields])).toEqual([
      ['info', { identity: 'lab/duo/keeper', generation: 1, bytes: expect.any(Number) as number, files: 1 }],
      ['info', { identity: 'lab/duo/keeper', generation: 2, bytes: expect.any(Number) as number, files: 1 }],
    ]);
    // The stored tar is the snapshot, normalised, and its sha256 is the pointer's.
    const stored = await readFile(join(home, dir, 'gen-2', 'memory.tar'));
    expect(sha(stored)).toBe(present(second.assets.memory, 'second.assets.memory').sha256);
    expect(stored.includes(Buffer.from('two'))).toBe(true);
    expect(await readdir(join(home, dir))).toEqual(['current.json', 'gen-2']);
  });

  it('a write that throws after N bytes of a generation file leaves the previous pointer and generation byte-identical; the next start removes the partial generation (state.orphan_removed)', async () => {
    await save({ 'a/facts.json': 'one' });
    const dir = store.agentDir(AGENT);
    const before = await tree(dir);
    spy.faults.push({ op: 'write', path: 'gen-2/memory.tar', afterBytes: 700 });
    const gen = await store.begin(dir);
    // The crash: the write throws, and nothing after it runs — not even the discard.
    await expect(
      gen.writeTar('memory', ASSET_BOUNDS.memory, feed(snapshot({ 'a/facts.json': 'x'.repeat(5000) }))),
    ).rejects.toThrow(InjectedFault);
    const after = await tree(dir);
    expect(Object.keys(after).sort(byCodeUnit)).toEqual([...Object.keys(before), 'gen-2/memory.tar'].sort(byCodeUnit));
    for (const [file, hash] of Object.entries(before)) expect(after[file], file).toBe(hash);
    await store.cleanupAtStart();
    expect(await tree(dir)).toEqual(before);
    expect(logger.entries.filter((e) => e.event === 'state.orphan_removed').map((e) => [e.level, e.fields])).toEqual([
      ['warn', { kind: 'agent', identity: 'lab/duo/keeper', generation: 2 }],
    ]);
  });

  it('a pointer write that throws leaves the previous pointer and generation byte-identical, and the next start removes the new generation', async () => {
    await save({ 'a/facts.json': 'one' });
    const dir = store.agentDir(AGENT);
    const before = await tree(dir);
    spy.faults.push({ op: 'replace', path: 'current.json' });
    await expect(save({ 'a/facts.json': 'two' }, 'd2')).rejects.toThrow(InjectedFault);
    // writePrivateFile removed its own temporary; the unpromoted gen-2 is all that is new.
    expect(Object.keys(await tree(dir)).sort(byCodeUnit)).toEqual(
      [...Object.keys(before), 'gen-2/memory.tar'].sort(byCodeUnit),
    );
    await store.cleanupAtStart();
    expect(await tree(dir)).toEqual(before);
    expect(present(await store.readAgentPointer(AGENT), 'store.readAgentPointer(AGENT)').lastDelivery).toBe('d1');
  });

  it("a failed identity fsync after the pointer's rename keeps both generations: discard removes nothing, and the next start keeps the one the pointer names (R4; R1-DESIGN-001)", async () => {
    await save({ 'a/facts.json': 'one' });
    const dir = store.agentDir(AGENT);
    const gen = await store.begin(dir);
    const written = await gen.writeTar('memory', ASSET_BOUNDS.memory, feed(snapshot({ 'a/facts.json': 'two' })));
    expect(written.ok).toBe(true);
    // The identity directory's fsync, which follows the rename, fails; the generation's own fsync does not match.
    spy.faults.push({ op: 'fsyncDir', path: 'lab/duo/keeper' });
    const promoting = gen.promote<AgentPointer>({ ...META, lastDelivery: 'd2' }, 'lab/duo/keeper');
    await expect(promoting).rejects.toMatchObject({
      name: 'PromotionUnsynced',
      message: `${dir}/current.json now names generation 2, but syncing ${dir} failed: injected fault: fsyncDir lab/duo/keeper; both generations are kept, and the next start removes the one it does not name`,
      cause: expect.any(InjectedFault) as unknown,
    });
    spy.faults.length = 0;
    // The caller's discard, as both callers make it on any promote failure: the pointer's generation stays.
    await gen.discard();
    expect((await readdir(dir)).sort(byCodeUnit)).toEqual(['current.json', 'gen-1', 'gen-2']);
    expect(logger.entries.filter((e) => e.event === 'state.promoted').map((e) => e.fields['generation'])).toEqual([1]);
    await store.cleanupAtStart();
    expect((await readdir(dir)).sort(byCodeUnit)).toEqual(['current.json', 'gen-2']);
    const pointer = present(await store.readAgentPointer(AGENT), 'store.readAgentPointer(AGENT)');
    expect([pointer.generation, pointer.lastDelivery]).toEqual([2, 'd2']);
    await store.verify(dir, pointer);
    expect(logger.entries.filter((e) => e.event === 'state.orphan_removed').map((e) => [e.level, e.fields])).toEqual([
      ['warn', { kind: 'agent', identity: 'lab/duo/keeper', generation: 1 }],
    ]);
  });

  it('refuses the start, deleting nothing, when a pointer names a generation that is missing (R4, R11; R1-DESIGN-001)', async () => {
    await save({ 'a/facts.json': 'one' });
    await save({ 'a/facts.json': 'two' }, 'd2');
    const dir = store.agentDir(AGENT);
    // The pointer names gen-2; only gen-1 is on disk.
    await rename(join(dir, 'gen-2'), join(dir, 'gen-1'));
    await expect(store.cleanupAtStart()).rejects.toThrow(
      new StateStoreCorrupt(join(dir, 'gen-2'), 'the pointer names it (generation 2) and it is missing'),
    );
    expect((await readdir(dir)).sort(byCodeUnit)).toEqual(['current.json', 'gen-1']);
    expect(logger.entries.filter((e) => e.event === 'state.orphan_removed')).toEqual([]);
  });

  it('refuses a generation directory that already exists, leaving it untouched (R5, finding 8)', async () => {
    const dir = store.agentDir(AGENT);
    await mkdir(join(dir, 'gen-1'), { recursive: true });
    await writeFile(join(dir, 'gen-1', 'planted'), 'x');
    await expect(store.begin(dir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(dir, 'gen-1', 'planted'), 'utf8')).toBe('x');
  });

  it('a discarded generation leaves the previous one as it was', async () => {
    await save({ 'a/facts.json': 'one' });
    const dir = store.agentDir(AGENT);
    const before = await tree(dir);
    const gen = await store.begin(dir);
    const over = await gen.writeTar(
      'memory',
      { maxFiles: 10, maxBytes: 10, maxEntries: 10 },
      feed(snapshot({ 'a/facts.json': 'x'.repeat(100) })),
    );
    expect(over).toEqual({
      ok: false,
      reason: 'over_bound',
      entry: 'memory/a/facts.json',
      detail: 'memory is over its bound of 10 bytes',
    });
    await gen.discard();
    expect(await tree(dir)).toEqual(before);
  });

  it("bounds a channel's saved file space as the space is, at 1,000 entries with every directory counted: 999 files and 2 directories fail over_bound (agent-files R11, R15; R1-DOCS-014)", async () => {
    const parts = [tarDirectory('channel', 1), tarDirectory('channel/a', 1), tarDirectory('channel/b', 1)];
    for (let i = 0; i < 999; i++) parts.push(tarFile(`channel/b/f${String(i)}.txt`, Buffer.from('x'), 1));
    parts.push(Buffer.alloc(2 * TAR_BLOCK));
    const gen = await store.begin(store.channelDir('lab'));
    expect(await gen.writeTar('files', FILES_BOUNDS, feed(Buffer.concat(parts), 64 * 1024))).toEqual({
      ok: false,
      reason: 'over_bound',
      entry: 'channel/b/f998.txt',
      detail: 'channel is over its bound of 1000 entries',
    });
    await gen.discard();
  });

  it('creates a new identity directory and fsyncs every directory above it, up to the home', async () => {
    await save({ 'a/facts.json': 'one' });
    expect(spy.calls.slice(0, 7)).toEqual([
      'mkdirp state/agents/lab/duo/keeper',
      'fsyncDir state/agents/lab/duo',
      'fsyncDir state/agents/lab',
      'fsyncDir state/agents',
      'fsyncDir state',
      `fsyncDir ${home}`,
      'mkdirExclusive state/agents/lab/duo/keeper/gen-1',
    ]);
  });
});

describe('the store at start, and what it refuses (R4, R11, A3, A9)', () => {
  it('removes a stray writePrivateFile temporary left by a crash (state.orphan_removed, with the identity and the file)', async () => {
    await save({ 'a/facts.json': 'one' });
    const dir = store.agentDir(AGENT);
    await writeFile(join(dir, '.current.json.4242.00ff00ff00ff00ff.tmp'), '{"half":');
    await store.cleanupAtStart();
    expect(await readdir(dir)).toEqual(['current.json', 'gen-1']);
    expect(logger.entries.filter((e) => e.event === 'state.orphan_removed').map((e) => e.fields)).toEqual([
      { kind: 'agent', identity: 'lab/duo/keeper', file: '.current.json.4242.00ff00ff00ff00ff.tmp' },
    ]);
  });

  it('fails loudly, StateStoreCorrupt naming it, on a symbolic link planted anywhere under state/', async () => {
    await save({ 'a/facts.json': 'one' });
    const link = join(store.agentDir(AGENT), 'gen-1', 'escape');
    await symlink('/etc/passwd', link);
    const error = await store.cleanupAtStart().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StateStoreCorrupt);
    expect((error as Error).message).toBe(
      `saved state is corrupt: ${link}: a symbolic link: the store holds only directories and regular files; remove it with asha --reset-state`,
    );
    await expect(
      store.verify(
        store.agentDir(AGENT),
        present(await store.readAgentPointer(AGENT), 'store.readAgentPointer(AGENT)'),
      ),
    ).rejects.toThrow(StateStoreCorrupt);
  });

  it("verify refuses an asset whose sha256 is not the pointer's (R3)", async () => {
    const pointer = await save({ 'a/facts.json': 'one' });
    const file = join(store.agentDir(AGENT), 'gen-1', 'memory.tar');
    const bytes = await readFile(file);
    bytes[TAR_BLOCK * 3] = present(bytes[TAR_BLOCK * 3], 'bytes[TAR_BLOCK * 3]') ^ 1;
    await writeFile(file, bytes);
    await expect(store.verify(store.agentDir(AGENT), pointer)).rejects.toThrow(
      /its sha256 [0-9a-f]{64} is not the [0-9a-f]{64} its pointer records/,
    );
  });

  it('asks the git-tree question once per run, before the first read or write, and refuses every operation when inside one (R2)', async () => {
    await store.list();
    await store.list();
    expect(gitChecks).toEqual([join(home, 'state')]);
    const inside = new StateStore({
      dir: join(home, 'state'),
      fs: spy,
      logger,
      clock: () => new Date(),
      insideGitTree: () => Promise.resolve(true),
    });
    for (const op of [
      () => inside.list(),
      () => inside.begin(join(home, 'state', 'x')),
      () => inside.cleanupAtStart(),
      () => inside.reset({ all: true }),
      () => inside.pending(AGENT),
    ]) {
      await expect(op()).rejects.toThrow(new StateInsideGitTree(join(home, 'state')));
    }
    // Refused before any write: nothing was created.
    expect(spy.calls).toEqual([]);
  });
});

describe('listing and reset (R5, A4)', () => {
  const entry = (i: number): PendingEntry => ({
    messageId: `m${String(i)}`,
    conversation: `c${String(i)}`,
    deliveryId: `d${String(i)}`,
    daemonStartedAt: '2026-09-29T09:00:00.000Z',
    afterGeneration: 1,
    attempts: 0,
    savedAt: `2026-09-29T09:0${String(i)}:00.000Z`,
    kind: 'input',
    user: 'ivy',
    text: `do task ${String(i)}`,
    to: null,
  });

  async function populate() {
    await save({ 'a/facts.json': 'one' });
    const solo = { channel: 'lab', team: null, name: 'memory' };
    const gen = await store.begin(store.agentDir(solo));
    await gen.writeTar('workspace', ASSET_BOUNDS.workspace, feed(snapshot({ 'notes.md': 'n' }, 'workspace')));
    await gen.promote<AgentPointer>({ ...META, recipe: 'memory' }, 'lab/-/memory');
    const board = await store.begin(store.channelDir('lab'));
    await board.writeJson('board', { session: 1, entries: [] }, 0);
    await board.promote<ChannelPointer>(
      { kind: 'channel', team: 'duo', lastDelivery: null, memoryTainted: true },
      'lab',
    );
    const other = await store.begin(store.agentDir({ channel: 'other', team: null, name: 'memory' }));
    await other.writeTar('workspace', ASSET_BOUNDS.workspace, feed(snapshot({ 'x.md': 'x' }, 'workspace')));
    await other.promote<AgentPointer>({ ...META, recipe: 'memory' }, 'other/-/memory');
    const pending = await store.pending(AGENT);
    await pending.add(entry(1));
    await pending.add(entry(2));
    return pending;
  }

  it('lists every asset and every record with entries, marked full and tainted, with the total', async () => {
    const pending = await populate();
    await store.setFull(store.agentDir(AGENT), 'memory', true);
    const listed = await store.list();
    expect(listed.assets.map((a) => [a.kind, a.identity, a.asset, a.full, a.tainted, a.savedAt])).toEqual([
      ['agent', 'lab/-/memory', 'workspace', false, false, '2026-09-29T10:00:00.000Z'],
      ['agent', 'lab/duo/keeper', 'memory', true, false, '2026-09-29T10:00:00.000Z'],
      ['agent', 'other/-/memory', 'workspace', false, false, '2026-09-29T10:00:00.000Z'],
      ['channel', 'lab', 'board', false, true, '2026-09-29T10:00:00.000Z'],
    ]);
    expect(listed.pending).toEqual([
      { identity: 'lab/duo/keeper', bytes: pending.bytes, savedAt: '2026-09-29T09:01:00.000Z' },
    ]);
    expect(listed.totalBytes).toBe(listed.assets.reduce((n, a) => n + a.bytes, 0) + pending.bytes);
    await store.setFull(store.agentDir(AGENT), 'memory', false);
    expect(
      present(
        (await store.list()).assets.find((a) => a.identity === 'lab/duo/keeper'),
        "assets.find(... === 'lab/duo/keeper')",
      ).full,
    ).toBe(false);
  });

  it('removes exactly one agent — its assets and its record — and nothing else', async () => {
    await populate();
    const removed = await store.reset({ channel: 'lab', name: 'keeper', team: 'duo' });
    expect(removed).toEqual([
      { kind: 'agent', identity: 'lab/duo/keeper', asset: 'memory', bytes: expect.any(Number) as number },
      { kind: 'agent', identity: 'lab/duo/keeper', asset: 'pending', bytes: expect.any(Number) as number },
    ]);
    expect((await store.list()).assets.map((a) => a.identity)).toEqual(['lab/-/memory', 'other/-/memory', 'lab']);
  });

  it("removes a channel's agents and its board, leaving other channels; and everything with all", async () => {
    await populate();
    expect(
      ((await store.reset({ channel: 'lab' })) as { identity: string; asset: string }[]).map(
        (r) => `${r.identity} ${r.asset}`,
      ),
    ).toEqual(['lab/-/memory workspace', 'lab/duo/keeper memory', 'lab/duo/keeper pending', 'lab board']);
    expect((await store.list()).assets.map((a) => a.identity)).toEqual(['other/-/memory']);
    expect((await store.reset({ all: true })) as unknown[]).toHaveLength(1);
    expect(await store.list()).toEqual({ assets: [], pending: [], totalBytes: 0 });
  });

  it("a parent directory's fsync that fails after the removal fails the reset loudly, ENOENT included: never resolved unrecorded (PRINCIPLES §11; R1-DESIGN-020)", async () => {
    await save({ 'a.json': 'x' });
    // Something outside the store removes the team's directory between the identity's removal and its parent's fsync.
    spy.onCall = (line) => {
      if (line === 'fsyncDir state/agents/lab/duo')
        rmSync(join(home, 'state', 'agents', 'lab', 'duo'), { recursive: true });
    };
    await expect(store.reset({ channel: 'lab', team: 'duo', name: 'keeper' })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(logger.entries.filter((e) => e.event === 'state.reset')).toEqual([]);
  });

  it('answers nothing_matches for a selector naming nothing saved, removing nothing', async () => {
    await populate();
    const before = await store.list();
    expect(await store.reset({ channel: 'lab', name: 'keeper' })).toBe('nothing_matches'); // no team=: the solo "keeper", which is not saved
    expect(await store.reset({ channel: 'nowhere' })).toBe('nothing_matches');
    expect(await store.list()).toEqual(before);
  });

  it('a corrupt pointer, a corrupt record or a stray file refuses the start, is listed unreadable, and the reset the error names removes it (the completion review, finding 3)', async () => {
    await save({ 'a.json': 'x' });
    const dir = store.agentDir(AGENT);
    await writeFile(join(dir, 'current.json'), '{"generation":');
    await writeFile(join(home, 'state', 'agents', '.DS_Store'), 'ds');
    await mkdir(join(home, 'state', 'agents', 'other', '-', 'solo'), { recursive: true });
    await writeFile(
      join(home, 'state', 'agents', 'other', '-', 'solo', 'pending.json'),
      '{"entries":[{"text":"zora said"',
    );
    await writeFile(join(home, 'state', 'agents', 'other', 'stray'), 'st');
    // The start still refuses, loudly, naming the path and the remedy.
    await expect(store.cleanupAtStart()).rejects.toThrow(StateStoreCorrupt);
    await expect(store.cleanupAtStart()).rejects.toThrow('remove it with asha --reset-state');
    // Listed, never hidden: unreadable, with the bytes under it.
    const listed = await store.list();
    expect(listed.assets.map((a) => [a.kind, a.identity, a.asset, a.savedAt])).toEqual([
      ['agent', '.DS_Store', 'unreadable', 'unknown'],
      ['agent', 'other/stray', 'unreadable', 'unknown'],
      ['agent', 'lab/duo/keeper', 'unreadable', 'unknown'],
      ['agent', 'other/-/solo', 'unreadable', 'unknown'],
    ]);
    expect(JSON.stringify(listed)).not.toContain('zora');
    // One identity by name; a channel with its stray; then everything.
    expect(await store.reset({ channel: 'lab', team: 'duo', name: 'keeper' })).toEqual([
      { kind: 'agent', identity: 'lab/duo/keeper', asset: 'unreadable', bytes: expect.any(Number) as number },
    ]);
    expect(((await store.reset({ channel: 'other' })) as { identity: string }[]).map((r) => r.identity)).toEqual([
      'other/-/solo',
      'other/stray',
    ]);
    expect(((await store.reset({ all: true })) as { identity: string }[]).map((r) => r.identity)).toEqual([
      '.DS_Store',
    ]);
    await store.cleanupAtStart();
    expect(await store.list()).toEqual({ assets: [], pending: [], totalBytes: 0 });
  });

  it('lists and resets an identity whose pointer holds a null asset record as unreadable, and refuses the start with StateStoreCorrupt (R5, R11; R1-DESIGN-008)', async () => {
    await save({ 'a.json': 'x' });
    const dir = store.agentDir(AGENT);
    const pointer = JSON.parse(await readFile(join(dir, 'current.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'current.json'), JSON.stringify({ ...pointer, assets: { memory: null } }));
    await expect(store.cleanupAtStart()).rejects.toThrow(
      new StateStoreCorrupt(join(dir, 'current.json'), 'assets.memory must be {bytes, files, sha256}'),
    );
    expect((await store.list()).assets.map((a) => [a.kind, a.identity, a.asset])).toEqual([
      ['agent', 'lab/duo/keeper', 'unreadable'],
    ]);
    expect(await store.reset({ channel: 'lab', team: 'duo', name: 'keeper' })).toEqual([
      { kind: 'agent', identity: 'lab/duo/keeper', asset: 'unreadable', bytes: expect.any(Number) as number },
    ]);
  });

  it.each([
    [{ channel: '../x' }, 'channel=../x is not a valid channel name'],
    [{ channel: 'lab', name: 'a/b' }, 'name=a/b is not a valid agent name'],
    [{ channel: 'lab', name: 'a', team: '.x' }, 'team=.x is not a valid team name'],
    [{ channel: 'c'.repeat(33) }, `channel=${'c'.repeat(33)} is not a valid channel name`],
  ])('checks a selector before any path is formed: %j', (selector, problem) => {
    expect(selectorProblem(selector)).toBe(problem);
  });
});

describe('the record of unsaved deliveries (R9 (a))', () => {
  const entry = (i: number, text = `t${String(i)}`): PendingEntry => ({
    messageId: `m${String(i)}`,
    conversation: 'c',
    deliveryId: `d${String(i)}`,
    daemonStartedAt: 's',
    afterGeneration: 0,
    attempts: 0,
    savedAt: 'x',
    kind: 'input',
    user: 'ivy',
    text,
    to: null,
  });

  it('writes the whole record, then fsyncs its directory, one write at a time; an emptied record is removed', async () => {
    const record = await store.pending(AGENT);
    spy.calls.length = 0;
    expect(await Promise.all([record.add(entry(1)), record.add(entry(2))])).toEqual([{ ok: true }, { ok: true }]);
    expect(spy.calls).toEqual([
      'replace state/agents/lab/duo/keeper/pending.json',
      'fsyncDir state/agents/lab/duo/keeper',
      'replace state/agents/lab/duo/keeper/pending.json',
      'fsyncDir state/agents/lab/duo/keeper',
    ]);
    expect((await PendingRecord.load({ fs: spy, dir: store.agentDir(AGENT) })).entries).toEqual([entry(1), entry(2)]);
    const { removed, written } = record.clearThrough('d2');
    expect(removed.map((e) => e.deliveryId)).toEqual(['d1', 'd2']);
    expect(await written).toEqual({ ok: true });
    expect(await readdir(store.agentDir(AGENT))).toEqual([]);
  });

  it('bounds the record at 32 entries and 4 MiB', async () => {
    const record = await store.pending(AGENT);
    for (let i = 1; i <= PENDING_MAX_ENTRIES; i++) {
      expect(record.wouldOverflow(entry(i))).toBeUndefined();
      void record.add(entry(i));
    }
    expect(record.wouldOverflow(entry(33))).toEqual({ entries: 33, bytes: expect.any(Number) as number });
    const big = await PendingRecord.load({ fs: spy, dir: join(home, 'elsewhere') });
    const huge = entry(1, 'x'.repeat(PENDING_MAX_BYTES));
    expect(big.wouldOverflow(huge)).toEqual({ entries: 1, bytes: expect.any(Number) as number });
    expect(big.wouldOverflow(entry(1, 'x'.repeat(PENDING_MAX_BYTES - 400)))).toBeUndefined();
  });

  it('a failed write is returned, not thrown: the caller reports it (journal_failed)', async () => {
    const record = await store.pending(AGENT);
    spy.faults.push({ op: 'replace', path: 'pending.json' });
    const written = await record.add(entry(1));
    expect(written.ok).toBe(false);
    expect((written as { error: unknown }).error).toBeInstanceOf(InjectedFault);
  });

  it("refuses a record with a field outside its allow-list, or user text on an agent's entry, naming the file and never quoting it", async () => {
    const dir = store.agentDir(AGENT);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pending.json'), JSON.stringify({ entries: [{ ...entry(1), from: 'ivy' }] }));
    await expect(store.pending(AGENT)).rejects.toThrow(
      new PendingRecordInvalid(
        join(dir, 'pending.json'),
        "entries[0] has fields outside the record's allow-list: from",
      ),
    );
    await writeFile(join(dir, 'pending.json'), JSON.stringify({ entries: [{ ...entry(1), kind: 'internal' }] }));
    await expect(store.pending(AGENT)).rejects.toThrow('entries[0].user is recorded only for an input');
    await writeFile(join(dir, 'pending.json'), '{"entries":[{"text":"zora said"');
    const error = await store.pending(AGENT).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `${join(dir, 'pending.json')} is not a record of unsaved deliveries: not JSON (SyntaxError); remove it with asha --reset-state`,
    );
  });
});

describe('the pointer, parsed strictly (R4, R11)', () => {
  const H = 'b'.repeat(64);
  const record = { bytes: 1, files: 1, sha256: H };
  const agent = { ...META, generation: 1, savedAt: '2026-09-29T10:00:00.000Z', assets: { memory: record } };
  const channel = {
    kind: 'channel',
    generation: 1,
    savedAt: '2026-09-29T10:00:00.000Z',
    team: 'duo',
    assets: { files: record },
    lastDelivery: null,
    memoryTainted: false,
    filesTable: record,
  };
  const parse = (value: unknown) => parsePointer(Buffer.from(JSON.stringify(value)), '/s/current.json');

  it('reads an agent pointer and a channel pointer as written', () => {
    expect(parse(agent)).toEqual(agent);
    expect(parse(channel)).toEqual(channel);
  });

  it.each<[string, unknown, string]>([
    ['an array', [], 'not an object'],
    ['null', null, 'not an object'],
    ['no kind', { ...agent, kind: undefined }, 'kind must be "agent" or "channel"'],
    ['a generation of 0', { ...agent, generation: 0 }, 'generation must be a whole number from 1'],
    ['a fractional generation', { ...agent, generation: 1.5 }, 'generation must be a whole number from 1'],
    ['a generation as a string', { ...agent, generation: '1' }, 'generation must be a whole number from 1'],
    ['no savedAt', { ...agent, savedAt: 5 }, 'savedAt must be a string'],
    ['assets null', { ...agent, assets: null }, 'assets must be an object'],
    ['a channel asset on an agent', { ...agent, assets: { board: record } }, "assets.board is not a agent's asset"],
    ['a null asset record', { ...agent, assets: { memory: null } }, 'assets.memory must be {bytes, files, sha256}'],
    [
      'an asset record as an array',
      { ...agent, assets: { memory: [] } },
      'assets.memory must be {bytes, files, sha256}',
    ],
    [
      'an asset record as a number',
      { ...agent, assets: { memory: 7 } },
      'assets.memory must be {bytes, files, sha256}',
    ],
    [
      'a short sha256',
      { ...agent, assets: { memory: { ...record, sha256: 'ab' } } },
      'assets.memory must be {bytes, files, sha256}',
    ],
    ['no handle', { ...agent, handle: undefined }, 'handle must be a string'],
    ['a numeric lastDelivery', { ...agent, lastDelivery: 3 }, 'lastDelivery must be a string or null'],
    ['no team', { ...channel, team: undefined }, 'team must be a string'],
    ['memoryTainted as a string', { ...channel, memoryTainted: 'no' }, 'memoryTainted must be true or false'],
    ['a null filesTable', { ...channel, filesTable: null }, 'filesTable must be {bytes, files, sha256}'],
    ['a filesTable as an array', { ...channel, filesTable: [] }, 'filesTable must be {bytes, files, sha256}'],
    [
      'a filesTable with no sha256',
      { ...channel, filesTable: { bytes: 1, files: 1 } },
      'filesTable must be {bytes, files, sha256}',
    ],
    ['a filesTable without files', { ...channel, assets: { board: record } }, 'filesTable is saved only beside files'],
  ])('refuses %s with StateStoreCorrupt naming the file (R1-DESIGN-008)', (_what, value, detail) => {
    expect(() => parse(value)).toThrow(new StateStoreCorrupt('/s/current.json', detail));
  });

  it('refuses a pointer that is not JSON', () => {
    expect(() => parsePointer(Buffer.from('{"generation":'), '/s/current.json')).toThrow(
      new StateStoreCorrupt('/s/current.json', 'not JSON (SyntaxError)'),
    );
  });
});

describe('the record of unsaved deliveries, parsed strictly (R9 (a))', () => {
  const base = {
    messageId: 'm1',
    conversation: 'c1',
    deliveryId: 'd1',
    daemonStartedAt: '2026-09-29T09:00:00.000Z',
    afterGeneration: 1,
    attempts: 0,
    savedAt: '2026-09-29T09:01:00.000Z',
    kind: 'input',
    user: 'ivy',
    text: 'do task 1',
    to: null,
  };
  const parse = (value: unknown) => parsePending(JSON.stringify(value), '/s/pending.json');

  it('reads an input entry and an internal entry as written', () => {
    const internal = { ...base, kind: 'internal', user: undefined, text: undefined, to: undefined };
    expect(parse({ entries: [base, internal] })).toEqual([base, JSON.parse(JSON.stringify(internal)) as unknown]);
  });

  it.each<[string, unknown, string]>([
    ['entries that are not an array', { entries: {} }, 'expected exactly {"entries": [...]}'],
    ['an entry that is not an object', { entries: [7] }, 'entries[0] is not an object'],
    [
      'an unknown kind',
      { entries: [{ ...base, kind: 'other' }] },
      'entries[0].kind must be one of input, internal, call_question, call_gather',
    ],
    [
      'an empty deliveryId',
      { entries: [{ ...base, deliveryId: '' }] },
      'entries[0].deliveryId must be a non-empty string',
    ],
    ['a fractional attempts', { entries: [{ ...base, attempts: 1.5 }] }, 'entries[0].attempts must be a whole number'],
    [
      'a negative afterGeneration',
      { entries: [{ ...base, afterGeneration: -1 }] },
      'entries[0].afterGeneration must be a whole number',
    ],
    [
      'an input without its text',
      { entries: [{ ...base, text: undefined }] },
      'entries[0].text must be a string on an input',
    ],
    [
      'an input whose to is a number',
      { entries: [{ ...base, to: 3 }] },
      'entries[0].to must be a handle or null on an input',
    ],
    [
      'a to on an internal entry',
      { entries: [{ ...base, kind: 'internal', user: undefined, text: undefined }] },
      'entries[0].to is recorded only for an input',
    ],
    [
      'kept as false',
      { entries: [{ ...base, kept: false }] },
      'entries[0].kept is recorded only as true, and only on an input',
    ],
  ])('refuses %s, naming the file and the rule', (_what, value, detail) => {
    expect(() => parse(value)).toThrow(new PendingRecordInvalid('/s/pending.json', detail));
  });

  it('settled() resolves once every queued write has reached the disk', async () => {
    const record = await store.pending(AGENT);
    void record.add(base as PendingEntry);
    void record.add({ ...base, messageId: 'm2', deliveryId: 'd2' } as PendingEntry);
    await record.settled();
    const saved = JSON.parse(await readFile(join(store.agentDir(AGENT), 'pending.json'), 'utf8')) as {
      entries: { deliveryId: string }[];
    };
    expect(saved.entries.map((e) => e.deliveryId)).toEqual(['d1', 'd2']);
  });
});
