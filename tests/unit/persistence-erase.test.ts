// Erasing one user's saved memory (docs/plans/agent-persistence.md R5, R10, R16; A16): the recorded image built and
// its erase label re-checked; run once over a copy of the saved /memory with no network, no environment and no
// --rm, exactly its arguments; its one stdout line read; its /memory checked, without knowing its layout, to be the
// current generation less exactly what it reported; only then promoted — anything else keeps the previous
// generation byte-identical and says why, without the user's ID; the container removed on every path; the user's
// inputs removed from the record of unsaved deliveries; an identity being erased counted as online.

import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IdentityInUse, parseErased, subsetProblem } from '../../src/daemon/agents/index.js';
import { PendingRecord, nodeStateFs, readStoredEntries } from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import type { StateEraseEvent } from '../../src/shared/protocol.js';
import {
  KEEPER,
  KEEPER_MANIFEST,
  assetTar,
  harness,
  persistenceRoot,
  until,
  type Harness,
} from '../helpers/persistence.js';
import { splitRestore } from '../helpers/daemon-fakes.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const IDENTITY = { channel: 'main', team: null, name: 'keeper' };
const MEMORY = {
  'aaaa/semantic.json': 'ivy likes teal',
  'aaaa/session.json': 'ivy said hi',
  'bbbb/semantic.json': 'jack likes red',
};

/** A keeper saved with MEMORY and a /workspace, then stopped, plus one of ivy's and one of jack's unsaved inputs. */
async function saved(root?: string): Promise<Harness> {
  const first = await harness({ ...(root === undefined ? {} : { root }), daemonStartedAt: '2026-09-28T00:00:00.000Z' });
  await first.supervisor.launchNew('keeper', first.main, first.sink);
  const c = first.container();
  present(first.runtime.contents.get(c), `runtime contents for ${c}`).set('/memory', assetTar('memory', MEMORY));
  present(first.runtime.contents.get(c), `runtime contents for ${c}`).set(
    '/workspace',
    assetTar('workspace', { 'notes.md': 'shared notes' }),
  );
  first.input('remember teal', 'ivy');
  await until(() => {
    expect(first.inbox.get(c)).toHaveLength(1);
  });
  first.ack(c, present(present(first.inbox.get(c), `inbox for ${c}`)[0], `inbox for ${c}, entry 0`));
  await until(async () => {
    expect((await first.state.readAgentPointer(IDENTITY))?.generation).toBe(1);
  });
  first.input('unsaved from ivy', 'ivy');
  first.input('unsaved from jack', 'jack');
  await until(async () => {
    expect((await PendingRecord.load({ fs: nodeStateFs, dir: first.state.agentDir(IDENTITY) })).entries).toHaveLength(
      2,
    );
  });
  await first.supervisor.stopAll('daemon stopping');
  return first;
}

/** Every file under the identity's directory with its sha256. */
async function tree(h: Harness): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), `${prefix}${e.name}/`);
      else out[`${prefix}${e.name}`] = sha(await readFile(join(d, e.name)));
    }
  };
  await walk(h.state.agentDir(IDENTITY), '');
  return out;
}

/** Runs one erase through the supervisor, collecting its events. */
async function erase(
  h: Harness,
  user: string,
  selector: { channel: string; name?: string; team?: string } = { channel: 'main', name: 'keeper' },
) {
  const prepared = await h.supervisor.state.prepareErase(selector, user);
  if (!prepared.ok) return prepared;
  const events: StateEraseEvent[] = [];
  await prepared.run((e) => events.push(e));
  return events;
}

/** What an honest image leaves: /memory without the named folder. */
const without = (folder: string) => (_spec: unknown, memory: Buffer) => {
  const kept = Object.fromEntries(Object.entries(MEMORY).filter(([k]) => !k.startsWith(`${folder}/`)));
  const removed = Object.entries(MEMORY).filter(([k]) => k.startsWith(`${folder}/`));
  expect(memory.length).toBeGreaterThan(0);
  const files = String(removed.length);
  const bytes = String(removed.reduce((n, [, v]) => n + v.length, 0));
  return Promise.resolve({
    run: {
      kind: 'exited' as const,
      code: 0,
      stdout: `{"erased":{"files":${files},"bytes":${bytes}}}\n`,
      overflow: false,
    },
    memoryAfter: assetTar('memory', kept),
  });
};

describe('an erase (R16; A16)', () => {
  it('runs the one-shot with exactly its arguments, no network flag of its own to set, the home label via the runtime, and a restore of /memory alone; promotes the smaller generation; removes the container', async () => {
    const first = await saved();
    const h = await harness({ root: first.root, home: first.home });
    h.runtime.onOneShot = without('aaaa');
    const before = present(await h.state.readAgentPointer(IDENTITY), "keeper's agent pointer, before the erase");
    // The saved /memory, read before the erase: its promotion deletes the previous generation.
    const stored = await readFile(join(h.state.agentDir(IDENTITY), `gen-${String(before.generation)}`, 'memory.tar'));
    const events = await erase(h, 'ivy');
    expect(events).toEqual([
      {
        type: 'erased',
        identity: 'main/-/keeper',
        files: 2,
        bytes: 'ivy likes teal'.length + 'ivy said hi'.length,
        pendingMessages: 1,
      },
      { type: 'kept', kind: 'agent', identity: 'main/-/keeper', asset: 'workspace' },
      { type: 'erase_done' },
    ]);
    const shot = present(h.runtime.oneShots[0], 'the one-shot run');
    expect(shot.spec).toMatchObject({
      image: expect.stringMatching(/^asha-image-keeper-image:[0-9a-f]{64}$/) as string,
      args: ['erase-user', '--channel', 'main', '--user', 'ivy'],
      timeoutMs: 60_000,
      maxStdoutBytes: 4096,
    });
    expect(shot.spec.logFile).toMatch(new RegExp(`${first.home}/logs/agents/asha-erase-main-[0-9a-f]{6}\\.log$`));
    // Its /memory: the saved one, byte for byte; nothing of /workspace.
    expect(sha(shot.memory)).toBe(sha(stored));
    expect(h.runtime.calls.filter((c) => c.startsWith('oneShot'))).toEqual([
      `oneShot ${shot.spec.name} run`,
      `oneShot ${shot.spec.name} copyOut /memory`,
      `oneShot ${shot.spec.name} remove`,
    ]);
    const after = present(await h.state.readAgentPointer(IDENTITY), "keeper's agent pointer, after the erase");
    expect(after.generation).toBe(before.generation + 1);
    const beforeWorkspace = present(before.assets.workspace, "before's workspace asset record");
    const afterWorkspace = present(after.assets.workspace, "after's workspace asset record");
    expect(afterWorkspace.sha256).toBe(beforeWorkspace.sha256);
    const file = join(h.state.agentDir(IDENTITY), `gen-${String(after.generation)}`, 'memory.tar');
    expect((await readStoredEntries(file, 'memory')).map((e) => e.name)).toEqual([
      'memory',
      'memory/bbbb',
      'memory/bbbb/semantic.json',
    ]);
    // The previous generation is gone; the stored tars hold none of ivy's text.
    expect((await readdir(h.state.agentDir(IDENTITY))).filter((n) => n.startsWith('gen-'))).toEqual([
      `gen-${String(after.generation)}`,
    ]);
    expect((await readFile(file)).includes(Buffer.from('ivy likes teal'))).toBe(false);
    // Her unsaved input is gone from the record; jack's stays.
    expect(
      (await PendingRecord.load({ fs: nodeStateFs, dir: h.state.agentDir(IDENTITY) })).entries.map((e) => e.user),
    ).toEqual(['jack']);
    expect(
      h.logger.entries
        .filter((e) => e.event.startsWith('state.erase') || e.event === 'state.user_erased')
        .map((e) => [e.level, e.event, e.fields]),
    ).toEqual([
      ['info', 'state.erase_started', { identity: 'main/-/keeper' }],
      ['info', 'state.user_erased', { identity: 'main/-/keeper', files: 2, bytes: 25 }],
    ]);
    for (const e of h.logger.entries) expect(JSON.stringify(e.fields)).not.toContain('ivy');
  });

  it('says no_memory, promoting nothing, when the image held nothing of the user', async () => {
    const first = await saved();
    const h = await harness({ root: first.root, home: first.home });
    const before = await tree(h);
    h.runtime.onOneShot = (_s, memory) =>
      Promise.resolve({
        run: { kind: 'exited', code: 0, stdout: '{"erased":{"files":0,"bytes":0}}\n', overflow: false },
        memoryAfter: memory,
      });
    expect(await erase(h, 'nobody')).toEqual([
      { type: 'no_memory', identity: 'main/-/keeper', pendingMessages: 0 },
      { type: 'kept', kind: 'agent', identity: 'main/-/keeper', asset: 'workspace' },
      { type: 'erase_done' },
    ]);
    expect(await tree(h)).toEqual(before);
  });

  it.each([
    [
      'a non-zero exit',
      () => Promise.resolve({ run: { kind: 'exited' as const, code: 1, stdout: '', overflow: false } }),
      'exit_nonzero',
    ],
    ['the 60 s bound passed', () => Promise.resolve({ run: { kind: 'timeout' as const } }), 'timeout'],
    [
      'no line',
      () => Promise.resolve({ run: { kind: 'exited' as const, code: 0, stdout: '', overflow: false } }),
      'bad_output',
    ],
    [
      'a malformed line',
      () =>
        Promise.resolve({
          run: { kind: 'exited' as const, code: 0, stdout: '{"erased":{"files":"2"}}\n', overflow: false },
        }),
      'bad_output',
    ],
    [
      '4 KiB + 1 of output',
      () => Promise.resolve({ run: { kind: 'exited' as const, code: 0, stdout: 'x'.repeat(4096), overflow: true } }),
      'bad_output',
    ],
    [
      'a line naming the user',
      () => Promise.resolve({ run: { kind: 'exited' as const, code: 0, stdout: 'ivy\n', overflow: false } }),
      'bad_output',
    ],
    [
      'an image that changes another file',
      () =>
        Promise.resolve({
          run: { kind: 'exited' as const, code: 0, stdout: '{"erased":{"files":2,"bytes":25}}\n', overflow: false },
          memoryAfter: assetTar('memory', { 'bbbb/semantic.json': 'jack likes blue' }),
        }),
      'erase_not_subset',
    ],
    [
      'an image that adds a file',
      () =>
        Promise.resolve({
          run: { kind: 'exited' as const, code: 0, stdout: '{"erased":{"files":2,"bytes":25}}\n', overflow: false },
          memoryAfter: assetTar('memory', { 'bbbb/semantic.json': 'jack likes red', 'cccc/new.json': 'x' }),
        }),
      'erase_not_subset',
    ],
    [
      'an image that reports one file fewer than it deleted',
      () =>
        Promise.resolve({
          run: { kind: 'exited' as const, code: 0, stdout: '{"erased":{"files":1,"bytes":14}}\n', overflow: false },
          memoryAfter: assetTar('memory', { 'bbbb/semantic.json': 'jack likes red' }),
        }),
      'erase_not_subset',
    ],
    [
      'a failed copy out',
      () =>
        Promise.resolve({
          run: { kind: 'exited' as const, code: 0, stdout: '{"erased":{"files":2,"bytes":25}}\n', overflow: false },
        }),
      'save_failed',
    ],
  ])(
    '%s: erase_failed with exactly its reason, the previous generation byte-identical, no user ID logged, the container removed',
    async (_what, script, reason) => {
      const first = await saved();
      const h = await harness({ root: first.root, home: first.home });
      const before = await tree(h);
      h.runtime.onOneShot = script;
      const events = await erase(h, 'ivy');
      expect((events as StateEraseEvent[])[0]).toEqual({
        type: 'erase_failed',
        identity: 'main/-/keeper',
        reason,
        pendingMessages: 0,
      });
      expect(await tree(h)).toEqual(before);
      expect(
        h.logger.entries.filter((e) => e.event === 'state.erase_failed').map((e) => [e.level, e.fields['reason']]),
      ).toEqual([['error', reason]]);
      for (const e of h.logger.entries)
        expect(
          JSON.stringify({ ...e.fields, error: (e.fields['error'] as Error | undefined)?.message ?? '' }),
        ).not.toContain('ivy');
      expect(h.runtime.calls.filter((c) => c.endsWith(' remove'))).toHaveLength(1);
    },
  );

  it("a failed docker rm is logged state.cleanup_failed and does not replace the erase's outcome; a full memory is no longer full after it (the completion review, findings 8 and 9)", async () => {
    const first = await saved();
    const h = await harness({ root: first.root, home: first.home });
    await h.state.setFull(h.state.agentDir(IDENTITY), 'memory', true);
    expect((await h.state.list()).assets.find((a) => a.asset === 'memory')).toMatchObject({ full: true });
    h.runtime.onOneShot = without('aaaa');
    h.runtime.onOneShotRemove = () => Promise.reject(new Error('docker rm --force failed'));
    const events = (await erase(h, 'ivy')) as StateEraseEvent[];
    expect(events[0]).toMatchObject({ type: 'erased', identity: 'main/-/keeper' });
    expect(
      h.logger.entries.filter((e) => e.event === 'state.cleanup_failed').map((e) => [e.level, e.fields['what']]),
    ).toEqual([['error', 'container']]);
    expect((await h.state.list()).assets.find((a) => a.asset === 'memory')).toMatchObject({ full: false });
  });

  it('refuses an image built without asha.erase-user=true: erase_unsupported, re-checked on the built image', async () => {
    const root = await persistenceRoot();
    const first = await saved(root);
    await writeFile(
      join(root, 'images/keeper-image/image.json'),
      JSON.stringify({ ...KEEPER_MANIFEST, eraseUser: undefined }),
    );
    const h = await harness({ root, home: first.home });
    const before = await tree(h);
    expect(((await erase(h, 'ivy')) as StateEraseEvent[])[0]).toEqual({
      type: 'erase_failed',
      identity: 'main/-/keeper',
      reason: 'erase_unsupported',
      pendingMessages: 0,
    });
    expect(h.runtime.oneShots).toEqual([]);
    expect(await tree(h)).toEqual(before);
  });

  it("refuses an image whose state schema is not the saved one's, or a recorded image gone: erase_unsupported, nothing erased (the code review's round 4, R4-COVERAGE-001)", async () => {
    for (const change of ['schema', 'gone'] as const) {
      const root = await persistenceRoot();
      const first = await saved(root);
      if (change === 'schema')
        await writeFile(
          join(root, 'images/keeper-image/image.json'),
          JSON.stringify({ ...KEEPER_MANIFEST, stateSchema: 2 }),
        );
      else await rm(join(root, 'images/keeper-image'), { recursive: true });
      const h = await harness({ root, home: first.home });
      const before = await tree(h);
      // The memory refused; the workspace, which an erase never touches, kept; the erase done.
      expect(await erase(h, 'ivy'), change).toEqual([
        { type: 'erase_failed', identity: 'main/-/keeper', reason: 'erase_unsupported', pendingMessages: 0 },
        { type: 'kept', kind: 'agent', identity: 'main/-/keeper', asset: 'workspace' },
        { type: 'erase_done' },
      ]);
      expect(h.runtime.oneShots, change).toEqual([]);
      expect(await tree(h), change).toEqual(before);
    }
  });

  it('refuses before it begins — nothing erased for any identity — an identity online, or a selector naming no saved memory', async () => {
    const first = await saved();
    const h = await harness({ root: first.root, home: first.home });
    await h.supervisor.launchNew('keeper', h.main, h.sink);
    expect(await erase(h, 'ivy')).toEqual({
      ok: false,
      reason: 'online',
      detail: 'main/-/keeper is online; stop it first (asha --stop)',
    });
    expect(await erase(h, 'ivy', { channel: 'elsewhere' })).toEqual({
      ok: false,
      reason: 'nothing_matches',
      detail: 'nothing saved matches channel=elsewhere',
    });
    expect(h.runtime.oneShots).toEqual([]);
  });

  it("lists what is saved, and refuses a reset whose selector names nothing saved, removing nothing (the code review's round 4, R4-COVERAGE-001)", async () => {
    const first = await saved();
    const h = await harness({ root: first.root, home: first.home });
    const before = await tree(h);
    expect(await h.supervisor.state.reset({ channel: 'elsewhere' })).toEqual({
      ok: false,
      reason: 'nothing_matches',
      detail: 'nothing saved matches channel=elsewhere',
    });
    expect(await tree(h)).toEqual(before);
    // Each asset by its identity, its tar's size and the time it was saved; the unsaved deliveries pending.
    const at = expect.any(String) as unknown as string;
    expect(await h.supervisor.state.list()).toEqual({
      assets: [
        {
          kind: 'agent',
          identity: 'main/-/keeper',
          asset: 'memory',
          bytes: 5_632,
          savedAt: at,
          full: false,
          tainted: false,
        },
        {
          kind: 'agent',
          identity: 'main/-/keeper',
          asset: 'workspace',
          bytes: 2_560,
          savedAt: at,
          full: false,
          tainted: false,
        },
      ],
      pending: [{ identity: 'main/-/keeper', bytes: 512, savedAt: at }],
      totalBytes: 8_704,
    });
  });

  it('holds the identity in use while it runs: a launch is refused identity_in_use, a reset and a second erase as online; after it, the reset succeeds', async () => {
    const first = await saved();
    const h = await harness({ root: first.root, home: first.home });
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    h.runtime.onOneShot = async (spec, memory) => {
      await held;
      return without('aaaa')(spec, memory);
    };
    const prepared = await h.supervisor.state.prepareErase({ channel: 'main', name: 'keeper' }, 'ivy');
    if (!prepared.ok) throw new Error('refused');
    const running = prepared.run(() => undefined);
    await expect(h.supervisor.launchNew('keeper', h.main, h.sink)).rejects.toThrow(new IdentityInUse('main/-/keeper'));
    expect(await h.supervisor.state.reset({ channel: 'main', name: 'keeper' })).toEqual({
      ok: false,
      reason: 'online',
      detail: 'main/-/keeper is online; stop it first (asha --stop)',
    });
    expect(await h.supervisor.state.prepareErase({ channel: 'main', name: 'keeper' }, 'jack')).toEqual({
      ok: false,
      reason: 'online',
      detail: 'main/-/keeper is online; stop it first (asha --stop)',
    });
    finish();
    await running;
    expect(await h.supervisor.state.reset({ channel: 'main', name: 'keeper' })).toMatchObject({ ok: true });
  });
});

describe('the erase contract, without the image (R16)', () => {
  it('reads exactly one line of two whole numbers, nothing more', () => {
    expect(parseErased('{"erased":{"files":2,"bytes":40}}\n')).toEqual({ files: 2, bytes: 40 });
    expect(parseErased('{"erased":{"files":0,"bytes":0}}')).toEqual({ files: 0, bytes: 0 });
    for (const bad of [
      '',
      '{"erased":{"files":-1,"bytes":0}}\n',
      '{"erased":{"files":1,"bytes":0}}\nmore\n',
      ' {"erased":{"files":1,"bytes":0}}\n',
      '{"erased":{"bytes":0,"files":1}}\n',
    ])
      expect(parseErased(bad), bad).toBeUndefined();
  });

  it('a subset check that knows no layout: same paths and sha256, nothing new, removed equal to reported', () => {
    const f = (name: string, text: string) => ({ name, type: 'file' as const, size: text.length, sha256: sha(text) });
    const d = (name: string) => ({ name, type: 'directory' as const });
    const before = [d('memory'), d('memory/a'), f('memory/a/x', 'xx'), d('memory/b'), f('memory/b/y', 'yyy')];
    expect(
      subsetProblem(before, [d('memory'), d('memory/b'), f('memory/b/y', 'yyy')], { files: 1, bytes: 2 }),
    ).toBeUndefined();
    expect(subsetProblem(before, [d('memory'), d('memory/b'), f('memory/b/y', 'YYY')], { files: 1, bytes: 2 })).toBe(
      'memory/b/y changed',
    );
    expect(subsetProblem(before, [...before, f('memory/c', '')], { files: 0, bytes: 0 })).toBe('memory/c is new');
    expect(subsetProblem(before, [d('memory'), d('memory/b'), f('memory/b/y', 'yyy')], { files: 0, bytes: 0 })).toBe(
      '1 files and 2 bytes were removed, and the erase reported 0 and 0',
    );
    expect(
      subsetProblem(
        before,
        [d('memory'), d('memory/a'), { name: 'memory/b', type: 'file', size: 0, sha256: sha('') }],
        { files: 2, bytes: 5 },
      ),
    ).toBe('memory/b changed from a directory to a file');
  });

  it("splits a restore archive by top directory (the fake runtime's view of one)", () => {
    const parts = splitRestore(
      Buffer.concat([assetTar('memory', { a: '1' }).subarray(0, -1024), assetTar('workspace', { b: '2' })]),
    );
    expect([...parts.keys()]).toEqual(['/memory', '/workspace']);
    expect(KEEPER.persist).toEqual(['memory', 'workspace']);
  });
});
