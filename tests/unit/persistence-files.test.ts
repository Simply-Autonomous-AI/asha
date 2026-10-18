// A persisted channel's file space across a stop (docs/plans/agent-files.md R15; A12; debt D43): saved in the board's
// generation with its file table, restored before the first agent starts, refused onto a space already in use, and
// at the stop saved without any upload no posted message named. The supervisor and file spaces run against a fake
// Docker (FakeRuntime keeps each volume's entries) and the real state store on disk.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TeamLaunchFailed, classify } from '../../src/daemon/agents/index.js';
import { readStoredEntries } from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type { DockerOutcome } from '../../src/daemon/container-runtime/index.js';
import { FIXTURE_RECIPE, applyTar } from '../helpers/daemon-fakes.js';
import { KEEPER, harness, persistenceRoot, until, type Harness } from '../helpers/persistence.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const VOLUME = 'asha-abcd1234-0123abcd-main';

/** Teams persisting their files: `kept` (board and files), `filesonly`, and `boardonly` for the mismatch. */
const TEAMS = {
  'teams/kept/team.json': JSON.stringify({
    id: 'kept',
    description: 'Keeps its board and files.',
    persist: ['board', 'files'],
    members: [{ name: 'kim', recipe: 'kim.json' }],
  }),
  'teams/kept/kim.json': JSON.stringify({ ...KEEPER, id: 'kim', persist: ['workspace'] }),
  'teams/boardonly/team.json': JSON.stringify({
    id: 'boardonly',
    description: 'Keeps its board.',
    persist: ['board'],
    members: [{ name: 'kim', recipe: 'kim.json' }],
  }),
  'teams/boardonly/kim.json': JSON.stringify({ ...KEEPER, id: 'kim', persist: ['workspace'] }),
};

/** An upload's body. */
function body(files: { name: string; content: Buffer }[]): AsyncIterable<Uint8Array> {
  const all = Buffer.concat([
    Buffer.from(
      `${JSON.stringify(files.map((f) => ({ name: f.name, size: f.content.length, sha256: sha(f.content) })))}\n`,
    ),
    ...files.map((f) => f.content),
  ]);
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield all;
    },
  };
}

/** An upload a posted message named: kept in the space and the file table. */
async function attached(h: Harness, name: string, content: string) {
  const r = await h.files.upload({
    channel: 'main',
    user: 'ivy',
    body: body([{ name, content: Buffer.from(content) }]),
  });
  if (!r.ok) throw new Error(r.detail);
  expect(h.files.claim('main', r.answer.upload).ok).toBe(true);
  h.files.used('main', r.answer.upload, { user: 'ivy', agents: ['kim-1'] });
  return r.answer;
}

/** A user's message delivered to kim and acknowledged: the channel's checkpoint follows. */
async function ackOne(h: Harness, text: string): Promise<void> {
  const before = h.inbox.get(h.container(0))?.length ?? 0;
  h.input(text, 'ivy');
  // A persisted member's next delivery is released once the checkpoint before it has run (agent-persistence R10).
  await until(() => {
    expect(h.inbox.get(h.container(0))?.length ?? 0).toBe(before + 1);
  });
  const member0 = h.container(0);
  h.ack(
    member0,
    present(present(h.inbox.get(member0), `inbox for ${member0}`).at(-1), `inbox for ${member0}, last entry`),
  );
}

/** The channel's promoted generation: its pointer and the entries of its files.tar. */
async function saved(h: Harness) {
  const pointer = await h.state.readChannelPointer('main');
  if (pointer === undefined) throw new Error('no channel pointer');
  const dir = h.state.channelDir('main');
  const entries =
    pointer.assets.files === undefined
      ? []
      : await readStoredEntries(h.state.assetPath(dir, pointer, 'files'), 'channel');
  const table = await h.state.readFilesTable(dir, pointer);
  const tableText =
    pointer.filesTable === undefined
      ? ''
      : await readFile(join(dir, `gen-${String(pointer.generation)}`, 'files-table.json'), 'utf8');
  return { pointer, entries, table, tableText };
}

// Each case writes generations to the real disk, fsync included, and waits on them with `until` (10 s a wait): bounded at
// 30 s, not vitest's 5 s, which legitimate work passed under disk load — a case that takes about 0.34 s alone (measured
// 2026-10-11) took over 5 s in a full shuffled run while Spotlight indexed at 98 % CPU (PRINCIPLES §14.5).
describe("a persisted channel's files (R15, A12)", { timeout: 30_000 }, () => {
  it('saves board.json, files.tar rooted at channel/ and files-table.json in one generation; the table is exactly {path, size, sha256, user, time} and holds no message text', async () => {
    const h = await harness({ root: await persistenceRoot(TEAMS) });
    await h.supervisor.launchTeam('kept', h.main, h.teamSink);
    const a = await attached(h, 'notes.txt', 'the attachment\n');
    await ackOne(h, 'canary-7d1f message text');
    await until(async () => {
      expect((await h.state.readChannelPointer('main'))?.assets.files).toBeDefined();
    });
    const { pointer, entries, table, tableText } = await saved(h);
    expect(Object.keys(pointer.assets).sort(byCodeUnit)).toEqual(['board', 'files']);
    expect(pointer.filesTable).toEqual({ bytes: Buffer.byteLength(tableText), files: 1, sha256: sha(tableText) });
    const firstFile = present(a.files[0], "a's first file");
    const folder = present(firstFile.path.split('/')[2], "a's first file's folder segment");
    expect(entries).toEqual([
      { name: 'channel', type: 'directory' },
      { name: `channel/${folder}`, type: 'directory' },
      { name: `channel/${folder}/notes.txt`, type: 'file', size: 15, sha256: sha('the attachment\n') },
    ]);
    expect(table).toEqual([
      {
        path: firstFile.path,
        size: 15,
        sha256: sha('the attachment\n'),
        user: 'ivy',
        time: expect.any(String) as string,
      },
    ]);
    expect(tableText).not.toContain('canary-7d1f');
    expect(tableText).not.toContain('"name"');
  });

  it('a restart fills the new space from files.tar before the first agent starts, and restores the file table', async () => {
    const root = await persistenceRoot(TEAMS);
    const first = await harness({ root });
    await first.supervisor.launchTeam('kept', first.main, first.teamSink);
    const a = await attached(first, 'notes.txt', 'kept across a stop\n');
    await ackOne(first, 'one');
    await until(async () => {
      expect((await first.state.readChannelPointer('main'))?.assets.files).toBeDefined();
    });
    const before = first.files.table('main');
    await first.supervisor.stopAll('test');

    const second = await harness({ root, home: first.home, runId: '4567cdef' });
    await second.supervisor.launchTeam('kept', second.main, second.teamSink);
    const volume = 'asha-abcd1234-4567cdef-main';
    const fillIndex = second.runtime.calls.indexOf(`copyIn ${volume}-files`);
    expect(fillIndex).toBeGreaterThan(-1);
    expect(fillIndex).toBeLessThan(second.runtime.calls.indexOf(`start ${second.container(0)}`));
    const secondVolume = present(second.runtime.volumes.get(volume), `volume ${volume}`);
    const restartedFile = present(a.files[0], "a's first file");
    expect(secondVolume.entries.get(restartedFile.path.slice('/channel/'.length))).toMatchObject({
      type: 'file',
      content: Buffer.from('kept across a stop\n'),
      owner: '1000:1000',
    });
    expect(secondVolume.rootOwner).toBe('1000:1000');
    expect(second.files.table('main')).toEqual(before);
  });

  it('a space over its bound fails the save over_bound, keeps the previous generation, and says so on the channel once', async () => {
    const h = await harness({ root: await persistenceRoot(TEAMS) });
    await h.supervisor.launchTeam('kept', h.main, h.teamSink);
    await ackOne(h, 'one');
    await until(async () => {
      expect((await h.state.readChannelPointer('main'))?.generation).toBe(1);
    });
    const space = present(h.runtime.volumes.get(VOLUME), `volume ${VOLUME}`);
    for (let i = 0; i < 1_001; i++)
      space.entries.set(`f${String(i)}`, { type: 'file', content: Buffer.from('x'), owner: '1000:1000', mode: 0o644 });
    const notices: string[] = [];
    h.main.watchAll((e) => {
      if (e.type === 'message' && e.message.text.startsWith('⚠')) notices.push(e.message.text);
    });
    await ackOne(h, 'two');
    await until(() => {
      expect(h.logger.entries.some((e) => e.event === 'state.save_failed')).toBe(true);
    });
    await ackOne(h, 'three');
    await until(() => {
      expect(h.logger.entries.filter((e) => e.event === 'state.save_failed')).toHaveLength(2);
    });
    expect(
      h.logger.entries
        .filter((e) => e.event === 'state.save_failed')
        .map((e) => [e.fields['asset'], e.fields['reason']]),
    ).toEqual([
      ['files', 'over_bound'],
      ['files', 'over_bound'],
    ]);
    expect((await h.state.readChannelPointer('main'))?.generation).toBe(1);
    expect(notices).toEqual([
      "⚠ channel main's files are not being saved (over_bound); what changes in /channel from now on is lost when it stops",
    ]);
  });

  it('onto a channel whose space holds a file this run: refused files_space_in_use and the space unchanged; onto an empty one: filled', async () => {
    const root = await persistenceRoot({ ...TEAMS, 'recipes/greeter.json': JSON.stringify(FIXTURE_RECIPE) });
    const first = await harness({ root });
    await first.supervisor.launchTeam('kept', first.main, first.teamSink);
    await attached(first, 'saved.txt', 'from the last run\n');
    await ackOne(first, 'one');
    await until(async () => {
      expect((await first.state.readChannelPointer('main'))?.assets.files).toBeDefined();
    });
    await first.supervisor.stopAll('test');

    // In use: an agent of this run made the space, a file was attached, the agent left.
    const busy = await harness({ root, home: first.home, runId: '4567cdef', base: 'greet' });
    const greeter = await busy.supervisor.launchNew('greeter', busy.main, busy.sink);
    await attached(busy, 'this-run.txt', 'this run\n');
    await busy.supervisor.stopHandle('main', greeter.handle, 'test');
    const volume = 'asha-abcd1234-4567cdef-main';
    const busyVolume = present(busy.runtime.volumes.get(volume), `volume ${volume}`);
    const entries = [...busyVolume.entries.keys()];
    const error = await busy.supervisor.launchTeam('kept', busy.main, busy.teamSink).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamLaunchFailed);
    expect(classify(error)).toBe('files_space_in_use');
    expect((error as Error).message).toContain("channel main's file space already holds files this run put there");
    expect((error as Error).message).toContain('asha --stop');
    expect([...busyVolume.entries.keys()]).toEqual(entries);

    // Empty: the agent left before any file came.
    const empty = await harness({ root, home: first.home, runId: '89abcdef', base: 'greet' });
    const g = await empty.supervisor.launchNew('greeter', empty.main, empty.sink);
    await empty.supervisor.stopHandle('main', g.handle, 'test');
    await empty.supervisor.launchTeam('kept', empty.main, empty.teamSink);
    const emptyVolume = present(
      empty.runtime.volumes.get('asha-abcd1234-89abcdef-main'),
      'volume asha-abcd1234-89abcdef-main',
    );
    const filled = [...emptyVolume.entries.keys()];
    expect(filled.some((n) => n.endsWith('/saved.txt'))).toBe(true);
  });

  it('a team persisting only the board, launched onto an online channel persisting board and files: persist_mismatch', async () => {
    const h = await harness({ root: await persistenceRoot(TEAMS) });
    await h.supervisor.launchTeam('kept', h.main, h.teamSink);
    const error = await h.supervisor.launchTeam('boardonly', h.main, h.teamSink).catch((e: unknown) => e);
    expect(classify(error)).toBe('persist_mismatch');
    expect((error as Error).message).toContain(
      'channel main is online persisting [board, files], and team boardonly persists [board]',
    );
  });

  it('a team persisting only the board, launched after a restart onto a channel whose saved state holds board and files: persist_mismatch, the generation kept (completion review, finding 6)', async () => {
    const root = await persistenceRoot(TEAMS);
    const first = await harness({ root });
    await first.supervisor.launchTeam('kept', first.main, first.teamSink);
    await attached(first, 'notes.txt', 'kept across a stop\n');
    await ackOne(first, 'one');
    await until(async () => {
      expect((await first.state.readChannelPointer('main'))?.assets.files).toBeDefined();
    });
    await first.supervisor.stopAll('test');
    const saved = await first.state.readChannelPointer('main');

    const second = await harness({ root, home: first.home, runId: '4567cdef' });
    const error = await second.supervisor
      .launchTeam('boardonly', second.main, second.teamSink)
      .catch((e: unknown) => e);
    expect(classify(error)).toBe('persist_mismatch');
    expect((error as Error).message).toContain(
      "channel main's saved state holds [board, files], and team boardonly persists [board]: its next save would drop files; launch a team that persists them, or remove them with asha --reset-state channel=main",
    );
    expect(second.runtime.calls.filter((c) => c.startsWith('start '))).toEqual([]);
    expect(await second.state.readChannelPointer('main')).toEqual(saved);
  });

  it("at the stop the final checkpoint takes the lock with an upload in flight (aborted, not rolled back), finishes within 5 s, and saves no unused upload's folder or records", async () => {
    const h = await harness({ root: await persistenceRoot(TEAMS) });
    await h.supervisor.launchTeam('kept', h.main, h.teamSink);
    const used = await attached(h, 'used.txt', 'named by a message\n');
    const unused = await h.files.upload({
      channel: 'main',
      user: 'ivy',
      body: body([{ name: 'unused.txt', content: Buffer.from('answered, never named') }]),
    });
    if (!unused.ok) throw new Error(unused.detail);
    // A failed copy whose rollback failed: its folder stays in the space.
    h.runtime.onCopyIn = async (_n, input): Promise<DockerOutcome> => {
      await applyTar(present(h.runtime.volumes.get(VOLUME), `volume ${VOLUME}`), input.bytes);
      return { kind: 'exited', code: 1, stderr: 'failed after extracting' };
    };
    h.runtime.onRollback = () => Promise.resolve({ kind: 'exited', code: 1, stderr: 'cannot remove' });
    expect(
      await h.files.upload({
        channel: 'main',
        user: 'ivy',
        body: body([{ name: 'failed.txt', content: Buffer.from('f') }]),
      }),
    ).toMatchObject({ ok: false, reason: 'rollback_failed' });
    h.runtime.onRollback = () => Promise.resolve(undefined);
    // In flight: extracted, then held until the stop kills it.
    h.runtime.onCopyIn = async (_n, input, signal) => {
      await applyTar(present(h.runtime.volumes.get(VOLUME), `volume ${VOLUME}`), input.bytes);
      return new Promise((_, reject) =>
        signal?.addEventListener(
          'abort',
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        ),
      );
    };
    const inFlight = h.files.upload({
      channel: 'main',
      user: 'ivy',
      body: body([{ name: 'inflight.txt', content: Buffer.from('i') }]),
    });
    await until(() => {
      const volume = present(h.runtime.volumes.get(VOLUME), `volume ${VOLUME}`);
      expect([...volume.entries.keys()].some((n) => n.endsWith('/inflight.txt'))).toBe(true);
    });
    const started = performance.now();
    await h.supervisor.stopAll('test');
    const tookMs = performance.now() - started;
    expect(await inFlight).toMatchObject({ ok: false, reason: 'stopping' });
    expect(h.runtime.rollbacks).toHaveLength(1);
    expect(tookMs).toBeLessThan(5_000);
    const { entries, table } = await saved(h);
    const usedFile = present(used.files[0], "used's first file");
    const usedFolder = present(usedFile.path.split('/')[2], "used's first file's folder segment");
    expect(entries.map((e) => e.name).sort(byCodeUnit)).toEqual([
      'channel',
      `channel/${usedFolder}`,
      `channel/${usedFolder}/used.txt`,
    ]);
    expect(table.map((r) => r.path)).toEqual([usedFile.path]);
    expect(Object.keys(present(table[0], 'the table, entry 0')).sort(byCodeUnit)).toEqual([
      'path',
      'sha256',
      'size',
      'time',
      'user',
    ]);
  });
});
