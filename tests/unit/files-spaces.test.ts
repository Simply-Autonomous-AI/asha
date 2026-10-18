// The channel file spaces (docs/plans/agent-files.md R3a, R6, R10–R15; A3, A4, A5, A6, A8, A12), against a fake
// Docker that keeps each volume's entries and applies the tars it is given (tests/helpers/daemon-fakes.ts), and an
// injected clock (vitest's fake timers) for every bound.

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelFileSpaces,
  FileSpaceRemoveFailed,
  FileSpaceUnavailable,
  MAX_RECORDS,
  SPACE_LOCK_WAIT_MS,
  SpaceHoldsFiles,
  type DownloadSink,
  type DrainOutcome,
  type SnapshotPlan,
  type SpaceFill,
  type UploadResult,
} from '../../src/daemon/files/index.js';
import { TarParser, tarDirectory, tarFile, type TarHeader } from '../../src/daemon/state/tar.js';
import type { DockerOutcome } from '../../src/daemon/container-runtime/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { FakeRuntime, applyTar, type FakeEntry } from '../helpers/daemon-fakes.js';
import { RecordingLogger } from '../helpers/fakes.js';

const HOME = 'abcd1234';
const RUN = '0123abcd';
const VOLUME = `asha-${HOME}-${RUN}-lab`;
const HOLDER = `${VOLUME}-files`;
const IMAGE = `asha-image-x:${'a'.repeat(64)}`;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Random hex drawn in order from `draws`, then counting up: a test can make the first folder drawn a taken one. */
function randomFrom(draws: string[]) {
  let n = 0;
  return (bytes: number): string => draws.shift() ?? (n++).toString(16).padStart(bytes * 2, '0');
}

async function setup(options: { draws?: string[] } = {}) {
  await Promise.resolve();
  const runtime = new FakeRuntime();
  const logger = new RecordingLogger();
  const spaces = new ChannelFileSpaces({
    runtime,
    logger,
    homeId: HOME,
    runId: RUN,
    randomHex: randomFrom(options.draws ?? []),
    clock: () => new Date('2026-09-30T12:00:00.000Z'),
    ownSecrets: () => [],
  });
  return { runtime, logger, spaces };
}

async function ready(options: { draws?: string[] } = {}) {
  const t = await setup(options);
  await t.spaces.ensure('lab', IMAGE);
  t.runtime.calls.length = 0;
  t.runtime.copyIns.length = 0;
  return t;
}

/** An upload's body: the manifest line, then the files' bytes, in chunks; `cut` bytes of the files left off the end. */
function body(
  files: { name: string; content: Buffer; size?: number; sha256?: string }[],
  options: { cut?: number; extra?: Buffer; manifest?: string } = {},
) {
  const manifest =
    options.manifest ??
    JSON.stringify(
      files.map((f) => ({ name: f.name, size: f.size ?? f.content.length, sha256: f.sha256 ?? sha(f.content) })),
    );
  let data = Buffer.concat([...files.map((f) => f.content), options.extra ?? Buffer.alloc(0)]);
  if (options.cut !== undefined) data = data.subarray(0, data.length - options.cut);
  const all = Buffer.concat([Buffer.from(`${manifest}\n`), data]);
  const reads = { count: 0 };
  return {
    reads,
    iterable: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (let i = 0; i < all.length; i += 1000) {
          reads.count += 1;
          yield all.subarray(i, i + 1000);
        }
      },
    } as AsyncIterable<Uint8Array>,
  };
}

/** A body that sends its manifest and `first` bytes, then nothing more (a stalled client). */
function stalledBody(manifest: string, first: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.concat([Buffer.from(`${manifest}\n`), first]);
      await new Promise(() => undefined);
    },
  };
}

/** A body that sends exactly these chunks, then ends. */
function sends(...parts: (string | Buffer)[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      for (const part of parts) yield typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    },
  };
}

/** A refused upload's drain, which every refusal met after the body began to be read carries (docs/plans/portal.md R8b). */
function drainOf(result: UploadResult): (closed: Promise<void>) => Promise<DrainOutcome> {
  if (result.ok || result.drain === undefined) throw new Error(`no drain: ${JSON.stringify(result)}`);
  return result.drain;
}

/** The entries of a tar the fake was given: name, type, owner, mode, size. */
function tarEntries(bytes: Buffer): { name: string; type: string; owner: string; mode: string; size: number }[] {
  const out: { name: string; type: string; owner: string; mode: string; size: number }[] = [];
  for (let at = 0; at + 512 <= bytes.length;) {
    const h = bytes.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (o: number, l: number) => {
      const s = h.subarray(o, o + l).toString('utf8');
      const nul = s.indexOf('\0');
      return nul === -1 ? s : s.slice(0, nul);
    };
    const oct = (o: number, l: number) => parseInt(field(o, l).trim() || '0', 8);
    const size = oct(124, 12);
    out.push({
      name: field(0, 100),
      type: field(156, 1),
      owner: `${String(oct(108, 8))}:${String(oct(116, 8))}`,
      mode: oct(100, 8).toString(8),
      size,
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const file = (content: string | Buffer, owner = '1000:1000'): FakeEntry => ({
  type: 'file',
  // Narrowed per branch, not Buffer.from(content) directly: newer @types/node's generic Buffer<T> overloads no
  // longer resolve across a string | Buffer union in one call. The explicit 'utf8' is Buffer.from(string)'s own
  // default, named only so the two branches aren't identical text.
  content: typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content),
  owner,
  mode: 0o644,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('creating a space (R10, A3)', () => {
  it('runs the volume, its label read-back, the holder, the root tar and the owner read-back, in that order, under one lock', async () => {
    const { runtime, spaces, logger } = await setup({ draws: ['5'.repeat(32)] });
    expect(await spaces.ensure('lab', IMAGE)).toBe(VOLUME);
    expect(runtime.calls).toEqual([
      `createVolume ${VOLUME}`,
      `volumeLabel ${VOLUME} asha.space`,
      `createHolder ${HOLDER} ${IMAGE} ${VOLUME}`,
      `copyIn ${HOLDER}`,
      `copyIn ${HOLDER} input ended, end blocks present`,
      `copyIn ${HOLDER} exit 0`,
      `copyOut ${HOLDER} /channel`,
    ]);
    expect(present(runtime.volumes.get(VOLUME), 'the lab volume').labels).toEqual({
      'asha.home': HOME,
      'asha.space': '5'.repeat(32),
    });
    expect(runtime.holders.get(HOLDER)).toEqual({
      name: HOLDER,
      image: IMAGE,
      volume: VOLUME,
      labels: { 'asha.home': HOME, 'asha.space': '5'.repeat(32) },
    });
    // The root's tar: the one `channel/` directory, 1000:1000, 0755.
    expect(tarEntries(present(runtime.copyIns[0], 'the first copyIn').bytes)).toEqual([
      { name: 'channel/', type: '5', owner: '1000:1000', mode: '755', size: 0 },
    ]);
    expect(present(runtime.volumes.get(VOLUME), 'the lab volume').rootOwner).toBe('1000:1000');
    expect(logger.entries).toEqual([
      { level: 'info', event: 'files.space_created', fields: { channel: 'lab', volume: VOLUME } },
    ]);
    // A second ensure, and a concurrent one, create nothing more.
    runtime.calls.length = 0;
    await Promise.all([spaces.ensure('lab', IMAGE), spaces.ensure('lab', IMAGE)]);
    expect(runtime.calls).toEqual([]);
  });

  it('a root read back as 0:0 removes the holder and the volume, logs files.space_create_failed and fails naming the space', async () => {
    const { runtime, spaces, logger } = await setup();
    // docker cp exits 0 but leaves the root root's: the read-back must refuse it.
    runtime.onCopyIn = () => Promise.resolve({ kind: 'exited', code: 0, stderr: '' });
    const error = await spaces.ensure('lab', IMAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileSpaceUnavailable);
    expect((error as Error).message).toBe(
      "the file space of channel lab could not be created (owner): the space's root is owned 0:0, not 1000:1000: no agent could write it",
    );
    expect(runtime.calls.slice(-2)).toEqual([`removeContainer ${HOLDER}`, `removeVolume ${VOLUME}`]);
    expect(runtime.volumes.size).toBe(0);
    expect(runtime.holders.size).toBe(0);
    expect(
      logger.entries.map((e) => [e.level, e.event, e.fields['channel'], e.fields['volume'], e.fields['step']]),
    ).toEqual([['error', 'files.space_create_failed', 'lab', VOLUME, 'owner']]);
    expect(spaces.exists('lab')).toBe(false);
  });

  it('a volume whose asha.space label reads back other than the value drawn fails with step volume_taken, makes no holder and removes no volume', async () => {
    const { runtime, spaces, logger } = await setup({ draws: ['1'.repeat(32)] });
    runtime.volumes.set(VOLUME, {
      labels: { 'asha.home': 'ffff0000', 'asha.space': '9'.repeat(32) },
      rootOwner: '1000:1000',
      entries: new Map([['old.txt', file("a crashed run's attachment")]]),
    });
    await expect(spaces.ensure('lab', IMAGE)).rejects.toThrow(
      `the file space of channel lab could not be created (volume_taken): volume ${VOLUME} already existed`,
    );
    expect(runtime.calls).toEqual([`createVolume ${VOLUME}`, `volumeLabel ${VOLUME} asha.space`]);
    expect(runtime.volumes.has(VOLUME)).toBe(true);
    expect(logger.entries.map((e) => [e.event, e.fields['step']])).toEqual([
      ['files.space_create_failed', 'volume_taken'],
    ]);
  });

  it('any other failed step removes what was made and logs files.space_create_failed with the docker error', async () => {
    const { runtime, spaces, logger } = await setup();
    runtime.failSpace.holder = new Error('docker create asha-…-files failed:\nUnable to find image');
    await expect(spaces.ensure('lab', IMAGE)).rejects.toThrow(
      'the file space of channel lab could not be created (holder): docker create asha-…-files failed:\nUnable to find image',
    );
    expect(runtime.calls.at(-1)).toBe(`removeVolume ${VOLUME}`);
    const first = present(logger.entries[0], 'the first log entry');
    expect(first.fields).toMatchObject({ channel: 'lab', volume: VOLUME, step: 'holder' });
    expect((first.fields['error'] as Error).message).toContain('Unable to find image');
  });

  it.each([
    [
      'passes its bound',
      { kind: 'timeout' } satisfies DockerOutcome,
      'timeout',
      'docker cp did not finish within its bound',
    ],
    [
      'exits 1',
      { kind: 'exited', code: 1, stderr: 'Error: no space left on device' } satisfies DockerOutcome,
      '1',
      'docker cp exited 1: Error: no space left on device',
    ],
  ])(
    'a root tar whose copy %s removes the holder and the volume, logs files.space_create_failed step root, and fails naming the step',
    async (_label, outcome, exit, detail) => {
      const { runtime, spaces, logger } = await setup();
      runtime.onCopyIn = () => Promise.resolve(outcome);
      const error = await spaces.ensure('lab', IMAGE).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FileSpaceUnavailable);
      expect(error).toEqual(new FileSpaceUnavailable('lab', 'root', detail));
      expect(runtime.calls).toEqual([
        `createVolume ${VOLUME}`,
        `volumeLabel ${VOLUME} asha.space`,
        `createHolder ${HOLDER} ${IMAGE} ${VOLUME}`,
        `copyIn ${HOLDER}`,
        `copyIn ${HOLDER} input ended, end blocks present`,
        `copyIn ${HOLDER} exit ${exit}`,
        `removeContainer ${HOLDER}`,
        `removeVolume ${VOLUME}`,
      ]);
      expect(
        logger.entries.map((e) => [e.level, e.event, { ...e.fields, error: (e.fields['error'] as Error).message }]),
      ).toEqual([
        [
          'error',
          'files.space_create_failed',
          {
            channel: 'lab',
            volume: VOLUME,
            step: 'root',
            error: `the file space of channel lab could not be created (root): ${detail}`,
            cleanup: [],
          },
        ],
      ]);
      expect([spaces.exists('lab'), spaces.volumeOf('lab'), runtime.volumes.size, runtime.holders.size]).toEqual([
        false,
        undefined,
        0,
        0,
      ]);
    },
  );

  it('refuses a home id or a run id that is not 8 hex characters; volumeOf names a space’s volume, and none for a channel without one', async () => {
    const { runtime, spaces } = await ready();
    const make = (homeId: string, runId: string) => () =>
      new ChannelFileSpaces({
        runtime,
        logger: new RecordingLogger(),
        homeId,
        runId,
        clock: () => new Date(0),
        ownSecrets: () => [],
      });
    expect(make('ABCD1234', RUN)).toThrow(new Error('homeId must be 8 hex characters, not "ABCD1234"'));
    expect(make(HOME, 'x; rm -rf /')).toThrow(new Error('runId must be 8 hex characters, not "x; rm -rf /"'));
    expect([spaces.volumeOf('lab'), spaces.volumeOf('other')]).toEqual([VOLUME, undefined]);
  });
});

describe('removing a space (docs/plans/portal-demo-stop.md R2)', () => {
  it('removes the holder, then the volume, under the lock; forgets the space; logs files.space_removed; and a later ensure makes a new one', async () => {
    const t = await ready();

    await t.spaces.remove('lab');

    expect(t.runtime.calls).toEqual([`removeContainer ${HOLDER}`, `removeVolume ${VOLUME}`]);
    expect(t.spaces.exists('lab')).toBe(false);
    expect(t.logger.entries.filter((e) => e.event.startsWith('files.space_remove'))).toEqual([
      { level: 'info', event: 'files.space_removed', fields: { channel: 'lab', volume: VOLUME } },
    ]);
    await t.spaces.ensure('lab', IMAGE);
    expect(t.spaces.exists('lab')).toBe(true);
  });

  it("kills its upload in flight (no rollback), refuses a new one, and removes at once; another channel's upload goes on", async () => {
    const t = await ready();
    await t.spaces.ensure('other', IMAGE);
    let killedFor = '';
    t.runtime.onCopyIn = async (name, _i, signal) =>
      name === HOLDER
        ? new Promise((_, reject) =>
            signal?.addEventListener(
              'abort',
              () => {
                killedFor = name;
                reject(signal.reason as Error);
              },
              { once: true },
            ),
          )
        : undefined;
    const inFlight = t.spaces.upload({
      channel: 'lab',
      user: 'u',
      body: body([{ name: 'a', content: Buffer.from('a') }]).iterable,
    });
    await vi.advanceTimersByTimeAsync(10);

    const removing = t.spaces.remove('lab');
    expect(await inFlight).toMatchObject({
      ok: false,
      status: 503,
      reason: 'stopping',
      detail: 'channel lab is stopping; the copy was killed',
    });
    await removing;

    expect(killedFor).toBe(HOLDER);
    expect(t.runtime.rollbacks).toEqual([]);
    expect(t.spaces.exists('lab')).toBe(false);
    expect(
      await t.spaces.upload({
        channel: 'lab',
        user: 'u',
        body: body([{ name: 'b', content: Buffer.from('b') }]).iterable,
      }),
    ).toMatchObject({ ok: false, status: 409, reason: 'no_space' });
    expect(
      await t.spaces.upload({
        channel: 'other',
        user: 'u',
        body: body([{ name: 'c', content: Buffer.from('c') }]).iterable,
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a channel with no space, removing nothing', async () => {
    const t = await setup();

    await expect(t.spaces.remove('lab')).rejects.toThrow('channel lab has no file space');
    expect(t.runtime.calls).toEqual([]);
  });

  it('a failed removal logs files.space_remove_failed and throws FileSpaceRemoveFailed, the volume left for the reclaim', async () => {
    const t = await ready();
    t.runtime.removeVolume = () => Promise.reject(new Error('docker volume rm exited 1: volume is in use'));

    await expect(t.spaces.remove('lab')).rejects.toThrow(FileSpaceRemoveFailed);
    expect(
      t.logger.entries.filter((e) => e.event === 'files.space_remove_failed').map((e) => e.fields['channel']),
    ).toEqual(['lab']);
  });
});

describe('an upload (R3a, A4)', () => {
  it('copies one tar: the folder and each file, all 1000:1000, folder 0755 and files 0644, into upload-<16 hex>; answers path, size and sha256; claim gives the same', async () => {
    const { runtime, spaces } = await ready();
    const a = Buffer.from('alpha\n');
    const b = Buffer.alloc(1500, 7);
    const result = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([
        { name: 'a.txt', content: a },
        { name: 'a.txt', content: b },
      ]).iterable,
    });
    if (!result.ok) throw new Error(result.detail);
    const uploaded = present(result.answer.files[0], 'the first uploaded file');
    const folder = present(uploaded.path.split('/')[2], 'the folder segment of the uploaded path');
    expect(folder).toMatch(/^upload-[0-9a-f]{16}$/);
    expect(result.answer.files).toEqual([
      { name: 'a.txt', path: `/channel/${folder}/a.txt`, size: 6, sha256: sha(a) },
      { name: 'a-2.txt', path: `/channel/${folder}/a-2.txt`, size: 1500, sha256: sha(b) },
    ]);
    expect(result.answer.upload).toMatch(/^[0-9a-f]{32}$/);
    expect(tarEntries(present(runtime.copyIns[0], 'the first copyIn').bytes)).toEqual([
      { name: `channel/${folder}/`, type: '5', owner: '1000:1000', mode: '755', size: 0 },
      { name: `channel/${folder}/a.txt`, type: '0', owner: '1000:1000', mode: '644', size: 6 },
      { name: `channel/${folder}/a-2.txt`, type: '0', owner: '1000:1000', mode: '644', size: 1500 },
    ]);
    expect(present(runtime.copyIns[0], 'the first copyIn').endBlocks).toBe(true);
    expect(present(runtime.volumes.get(VOLUME), 'the lab volume').entries.get(`${folder}/a-2.txt`)).toEqual({
      type: 'file',
      content: b,
      owner: '1000:1000',
      mode: 0o644,
    });
    expect(spaces.claim('lab', result.answer.upload)).toEqual({
      ok: true,
      attachments: result.answer.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    });
  });

  it('redraws the folder while the measurement shows an entry of that name', async () => {
    const { runtime, spaces } = await ready({ draws: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'] });
    present(runtime.volumes.get(VOLUME), 'the lab volume').entries.set('upload-aaaaaaaaaaaaaaaa', {
      type: 'dir',
      owner: '1000:1000',
    });
    const result = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'n.txt', content: Buffer.from('n') }]).iterable,
    });
    expect(result.ok && present(result.answer.files[0], 'the first uploaded file').path).toBe(
      '/channel/upload-bbbbbbbbbbbbbbbb/n.txt',
    );
  });

  it.each([
    ['a short body', { cut: 3 }, 'body_short'],
    ['a second file whose sha256 differs', { badSecond: true }, 'sha256_mismatch'],
    ['a body longer than its manifest', { extra: Buffer.from('more') }, 'body_long'],
  ] as const)(
    "%s: 400 %s, docker cp's input ended without end blocks and its exit (0) awaited, then exactly one rollback of the folder",
    async (_label, how, reason) => {
      const { runtime, spaces, logger } = await ready();
      const files = [
        { name: 'a.txt', content: Buffer.from('first file\n') },
        {
          name: 'b.txt',
          content: Buffer.from('second file\n'),
          ...('badSecond' in how ? { sha256: 'f'.repeat(64) } : {}),
        },
      ];
      const result = await spaces.upload({
        channel: 'lab',
        user: 'alice',
        body: body(files, {
          ...('cut' in how ? { cut: how.cut } : {}),
          ...('extra' in how ? { extra: how.extra } : {}),
        }).iterable,
      });
      expect(result).toMatchObject({ ok: false, status: 400, reason });
      const folder = present(runtime.rollbacks[0], 'the first rollback').folder;
      expect(runtime.rollbacks).toEqual([{ volume: VOLUME, image: IMAGE, folder }]);
      expect(runtime.calls.filter((c) => !c.startsWith('copyOut'))).toEqual([
        `copyIn ${HOLDER}`,
        `copyIn ${HOLDER} input ended, end blocks absent`,
        `copyIn ${HOLDER} exit 0`,
        `rollback ${VOLUME} ${folder}`,
      ]);
      expect([...present(runtime.volumes.get(VOLUME), 'the lab volume').entries.keys()]).toEqual([]);
      expect(logger.events('error')).toEqual(['files.refused']);
    },
  );

  it('a body that stalls 30 s: 400 body_stalled, input ended without end blocks, rolled back', async () => {
    const { runtime, spaces } = await ready();
    const pending = spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: stalledBody(JSON.stringify([{ name: 'a.txt', size: 100, sha256: 'a'.repeat(64) }]), Buffer.alloc(10)),
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runtime.rollbacks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, status: 400, reason: 'body_stalled' });
    expect(present(runtime.copyIns[0], 'the first copyIn').endBlocks).toBe(false);
    expect(runtime.rollbacks).toHaveLength(1);
  });

  it("a body that stalls 30 s after its files' last byte, before it ends: 400 body_stalled naming no file, the file copied whole without end blocks, rolled back", async () => {
    const { runtime, spaces, logger } = await ready();
    const content = Buffer.from('ten bytes!');
    const pending = spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: stalledBody(JSON.stringify([{ name: 'a.txt', size: content.length, sha256: sha(content) }]), content),
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runtime.rollbacks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({
      ok: false,
      status: 400,
      reason: 'body_stalled',
      detail: 'no body bytes for 30000 ms',
      drain: expect.any(Function) as (closed: Promise<void>) => Promise<DrainOutcome>,
    });
    const folder = present(runtime.rollbacks[0], 'the rollback').folder;
    expect(runtime.rollbacks).toEqual([{ volume: VOLUME, image: IMAGE, folder }]);
    const copied = present(runtime.copyIns[0], 'the first copyIn');
    expect([tarEntries(copied.bytes), copied.endBlocks]).toEqual([
      [
        { name: `channel/${folder}/`, type: '5', owner: '1000:1000', mode: '755', size: 0 },
        { name: `channel/${folder}/a.txt`, type: '0', owner: '1000:1000', mode: '644', size: 10 },
      ],
      false,
    ]);
    expect(
      logger.entries
        .filter((e) => e.event === 'files.refused')
        .map((e) => [e.level, { ...e.fields, error: (e.fields['error'] as Error).message }]),
    ).toEqual([['error', { channel: 'lab', reason: 'body_stalled', name: null, error: 'no body bytes for 30000 ms' }]]);
  });

  it.each([
    ['a manifest line that is not JSON', () => sends('[{"name":"a.txt",\n'), 'the manifest line is not JSON'],
    [
      'a manifest line with no newline in its first 8 KiB',
      () => sends(...Array.from({ length: 10 }, () => 'x'.repeat(1_000)), '\n'),
      'the manifest line is over 8192 bytes',
    ],
    [
      'a body that ends before its manifest line does',
      () => sends('[{"name":"a.txt"'),
      'the body ended before its manifest line did',
    ],
  ])('%s: 400 bad_manifest, saying so, nothing measured or copied', async (_label, sent, detail) => {
    const { runtime, spaces, logger } = await ready();
    expect(await spaces.upload({ channel: 'lab', user: 'alice', body: sent() })).toEqual({
      ok: false,
      status: 400,
      reason: 'bad_manifest',
      detail,
      drain: expect.any(Function) as (closed: Promise<void>) => Promise<DrainOutcome>,
    });
    expect(runtime.calls).toEqual([]);
    expect(
      logger.entries
        .filter((e) => e.event !== 'files.space_created')
        .map((e) => [e.level, e.event, { ...e.fields, error: (e.fields['error'] as Error).message }]),
    ).toEqual([['error', 'files.refused', { channel: 'lab', reason: 'bad_manifest', name: null, error: detail }]]);
  });

  it('a body that stalls 30 s inside its manifest line: 400 body_stalled, nothing measured or copied', async () => {
    const { runtime, spaces } = await ready();
    const pending = spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('[{"name":"a.txt"');
          await new Promise(() => undefined);
        },
      },
    });
    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({
      ok: false,
      status: 400,
      reason: 'body_stalled',
      detail: 'no body bytes for 30000 ms',
      drain: expect.any(Function) as (closed: Promise<void>) => Promise<DrainOutcome>,
    });
    expect(runtime.calls).toEqual([]);
  });

  it("the daemon's stop during an upload's measurement: 503 stopping, nothing copied or rolled back", async () => {
    const { runtime, spaces } = await ready();
    runtime.onCopy = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve(undefined);
        }, 1_000),
      );
    const pending = spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('a') }]).iterable,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(runtime.calls).toEqual([`copyOut ${HOLDER} /channel`]);
    spaces.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({
      ok: false,
      status: 503,
      reason: 'stopping',
      detail: 'the daemon is stopping',
      drain: expect.any(Function) as (closed: Promise<void>) => Promise<DrainOutcome>,
    });
    expect([runtime.copyIns, runtime.rollbacks]).toEqual([[], []]);
  });

  it('a measurement whose copy out throws (not the stop) fails the upload with that error, loudly, and releases the lock', async () => {
    const { runtime, spaces } = await ready();
    const copyOut = runtime.copyOut.bind(runtime);
    const spawn = new Error('spawn docker EAGAIN');
    runtime.copyOut = () => Promise.reject(spawn);
    const failed = await spaces
      .upload({ channel: 'lab', user: 'alice', body: body([{ name: 'a.txt', content: Buffer.from('a') }]).iterable })
      .catch((e: unknown) => e);
    expect(failed).toBe(spawn);
    expect([runtime.copyIns, runtime.rollbacks]).toEqual([[], []]);
    runtime.copyOut = copyOut;
    const next = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'b.txt', content: Buffer.from('b') }]).iterable,
    });
    expect(next.ok).toBe(true);
  });

  it('docker cp exiting 1: 500 copy_failed, files.copy_failed reason exit, rolled back', async () => {
    const { runtime, spaces, logger } = await ready();
    runtime.onCopyIn = () =>
      Promise.resolve({ kind: 'exited', code: 1, stderr: 'Error: cannot overwrite non-directory' });
    const result = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('x') }]).iterable,
    });
    // A refusal after the body began to be read carries its drain (docs/plans/portal.md R8b).
    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: 'copy_failed',
      detail: 'the copy into the space failed: docker cp exited 1',
      drain: expect.any(Function) as (closed: Promise<void>) => Promise<DrainOutcome>,
    });
    const failed = present(
      logger.entries.find((e) => e.event === 'files.copy_failed'),
      'the files.copy_failed log entry',
    );
    expect(Object.keys(failed.fields).sort(byCodeUnit)).toEqual(['channel', 'error', 'folder', 'reason', 'volume']);
    expect(failed.fields).toMatchObject({
      channel: 'lab',
      volume: VOLUME,
      folder: present(runtime.rollbacks[0], 'the first rollback').folder,
      reason: 'exit',
    });
    expect(runtime.rollbacks).toHaveLength(1);
  });

  it('docker cp past its bound (killed): 503 copy_timeout, files.copy_failed reason timeout, rolled back, and no later measurement', async () => {
    const { runtime, spaces, logger } = await ready();
    runtime.onCopyIn = () => Promise.resolve({ kind: 'timeout' });
    const result = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('x') }]).iterable,
    });
    expect(result).toMatchObject({ ok: false, status: 503, reason: 'copy_timeout' });
    expect(
      present(
        logger.entries.find((e) => e.event === 'files.copy_failed'),
        'the files.copy_failed log entry',
      ).fields,
    ).toMatchObject({ reason: 'timeout' });
    const calls = runtime.calls;
    expect(calls.at(-1)).toBe(`rollback ${VOLUME} ${present(runtime.rollbacks[0], 'the first rollback').folder}`);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runtime.calls).toEqual(calls);
  });

  it.each([
    ['exits 1', { kind: 'exited', code: 1, stderr: "rm: can't remove" } satisfies DockerOutcome],
    ['passes its 60 s', { kind: 'timeout' } satisfies DockerOutcome],
  ])(
    'a rollback that %s: files.rollback_failed naming the folder, 500 rollback_failed, and it is not run again',
    async (_label, outcome) => {
      const { runtime, spaces, logger } = await ready();
      runtime.onCopyIn = () => Promise.resolve({ kind: 'exited', code: 1, stderr: 'boom' });
      runtime.onRollback = () => Promise.resolve(outcome);
      const result = await spaces.upload({
        channel: 'lab',
        user: 'alice',
        body: body([{ name: 'a.txt', content: Buffer.from('x') }]).iterable,
      });
      expect(result).toMatchObject({ ok: false, status: 500, reason: 'rollback_failed' });
      const failed = present(
        logger.entries.find((e) => e.event === 'files.rollback_failed'),
        'the files.rollback_failed log entry',
      );
      expect(Object.keys(failed.fields).sort(byCodeUnit)).toEqual(['channel', 'error', 'folder', 'volume']);
      expect(failed.fields['folder']).toBe(present(runtime.rollbacks[0], 'the first rollback').folder);
      await vi.advanceTimersByTimeAsync(700_000);
      expect(runtime.rollbacks).toHaveLength(1);
    },
  );

  it.each([
    [
      'a manifest line over 8 KiB',
      JSON.stringify([{ name: 'x'.repeat(200), size: 1, sha256: 'a'.repeat(64) }]).padEnd(8 * 1024 + 10, ' '),
    ],
    ['0 files', '[]'],
    [
      '11 files',
      JSON.stringify(
        Array.from({ length: 11 }, (_, i) => ({ name: `f${String(i)}`, size: 1, sha256: 'a'.repeat(64) })),
      ),
    ],
    ['a name with a slash', JSON.stringify([{ name: '../x', size: 1, sha256: 'a'.repeat(64) }])],
    ['a size over 25,000,000', JSON.stringify([{ name: 'x', size: 25_000_001, sha256: 'a'.repeat(64) }])],
    ['a bad sha256', JSON.stringify([{ name: 'x', size: 1, sha256: 'A'.repeat(64) }])],
    ['an extra field', JSON.stringify([{ name: 'x', size: 1, sha256: 'a'.repeat(64), mode: 1 }])],
  ])('%s: 400 bad_manifest before any file byte is read, nothing measured or copied', async (_label, manifest) => {
    const { runtime, spaces } = await ready();
    const sent = body([{ name: 'x', content: Buffer.alloc(20_000) }], { manifest });
    const result = await spaces.upload({ channel: 'lab', user: 'alice', body: sent.iterable });
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'bad_manifest' });
    expect(runtime.calls).toEqual([]);
    // At most the reads that held the manifest's line: never the 20,000 bytes after it.
    expect(sent.reads.count).toBeLessThanOrEqual(10);
  });

  it('a channel with no space: 409 no_space, and none is created', async () => {
    const { runtime, spaces } = await setup();
    expect(
      await spaces.upload({
        channel: 'lab',
        user: 'alice',
        body: body([{ name: 'a', content: Buffer.from('a') }]).iterable,
      }),
    ).toMatchObject({ ok: false, status: 409, reason: 'no_space' });
    expect(runtime.calls).toEqual([]);
  });

  it("two concurrent uploads are serialised: the second measures after the first's copy", async () => {
    const { runtime, spaces } = await ready();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    runtime.onCopyIn = async (_n, input) =>
      input.bytes.includes(Buffer.from('first')) ? (await held, undefined) : undefined;
    const first = spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a', content: Buffer.from('first') }]).iterable,
    });
    const second = spaces.upload({
      channel: 'lab',
      user: 'bob',
      body: body([{ name: 'b', content: Buffer.from('second') }]).iterable,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(runtime.calls.filter((c) => c.startsWith('copyOut'))).toHaveLength(1);
    release();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(runtime.calls.filter((c) => !c.includes('input ended'))).toEqual([
      `copyOut ${HOLDER} /channel`,
      `copyIn ${HOLDER}`,
      `copyIn ${HOLDER} exit 0`,
      `copyOut ${HOLDER} /channel`,
      `copyIn ${HOLDER}`,
      `copyIn ${HOLDER} exit 0`,
    ]);
  });

  it('an upload that waits 60 s for the lock: 503 space_busy, copying nothing', async () => {
    const { runtime, spaces } = await ready();
    runtime.onCopyIn = async () => new Promise(() => undefined);
    void spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a', content: Buffer.from('a') }]).iterable,
    });
    const second = spaces.upload({
      channel: 'lab',
      user: 'bob',
      body: body([{ name: 'b', content: Buffer.from('b') }]).iterable,
    });
    await vi.advanceTimersByTimeAsync(59_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toMatchObject({ ok: false, status: 503, reason: 'space_busy' });
    expect(runtime.copyIns.filter((c) => c.bytes.includes(Buffer.from('b')))).toEqual([]);
  });

  it('the 101st unused upload on one channel: 429 too_many_uploads, copying nothing', async () => {
    const { runtime, spaces } = await ready();
    for (let i = 0; i < 100; i++)
      expect(
        (
          await spaces.upload({
            channel: 'lab',
            user: 'u',
            body: body([{ name: `f${String(i)}`, content: Buffer.from('x') }]).iterable,
          })
        ).ok,
      ).toBe(true);
    const copies = runtime.copyIns.length;
    expect(
      await spaces.upload({
        channel: 'lab',
        user: 'u',
        body: body([{ name: 'x', content: Buffer.from('x') }]).iterable,
      }),
    ).toMatchObject({ ok: false, status: 429, reason: 'too_many_uploads' });
    expect(runtime.copyIns).toHaveLength(copies);
  });

  it('an upload unused for 601 s is rolled back and its file-table records dropped; a used one is kept', async () => {
    const { runtime, spaces } = await ready();
    const unused = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('a') }]).iterable,
    });
    const used = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'b.txt', content: Buffer.from('b') }]).iterable,
    });
    if (!unused.ok || !used.ok) throw new Error('upload failed');
    const unusedFile = present(unused.answer.files[0], 'the unused upload file');
    const usedFile = present(used.answer.files[0], 'the used upload file');
    expect(spaces.claim('lab', used.answer.upload).ok).toBe(true);
    spaces.used('lab', used.answer.upload, { user: 'alice', agents: ['hewo-1'] });
    expect(spaces.table('lab').map((r) => r.path)).toEqual([unusedFile.path, usedFile.path]);
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.rollbacks.map((r) => r.folder)).toEqual([unusedFile.path.split('/')[2]]);
    expect(spaces.table('lab').map((r) => r.path)).toEqual([usedFile.path]);
    expect(spaces.claim('lab', unused.answer.upload)).toEqual({
      ok: false,
      detail: `attachments ${unused.answer.upload} is unknown, expired or already used`,
    });
  });

  it('a claimed upload does not expire while its conversation brings an agent online: past 601 s it is not rolled back, and used() then keeps it (completion review, finding 1)', async () => {
    const { runtime, spaces } = await ready();
    const up = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('a') }]).iterable,
    });
    if (!up.ok) throw new Error(up.detail);
    expect(spaces.claim('lab', up.answer.upload).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(601_000);
    expect(runtime.rollbacks).toEqual([]);
    spaces.used('lab', up.answer.upload, { user: 'alice', agents: ['hewo-1'] });
    expect(spaces.table('lab').map((r) => r.path)).toEqual([present(up.answer.files[0], 'the uploaded file').path]);
  });

  it('a claimed upload is refused when used again, on another channel, or unknown; a refused conversation rolls it back', async () => {
    const { runtime, spaces } = await ready();
    await spaces.ensure('other', IMAGE);
    const up = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('a') }]).iterable,
    });
    if (!up.ok) throw new Error(up.detail);
    expect(spaces.claim('other', up.answer.upload)).toEqual({
      ok: false,
      detail: `attachments ${up.answer.upload} was uploaded to another channel`,
    });
    expect(spaces.claim('lab', 'f'.repeat(32))).toMatchObject({ ok: false });
    expect(spaces.claim('lab', up.answer.upload).ok).toBe(true);
    expect(spaces.claim('lab', up.answer.upload)).toEqual({
      ok: false,
      detail: `attachments ${up.answer.upload} is already used`,
    });
    spaces.refused('lab', up.answer.upload);
    await vi.advanceTimersByTimeAsync(10);
    expect(runtime.rollbacks.map((r) => r.folder)).toEqual([
      present(up.answer.files[0], 'the uploaded file').path.split('/')[2],
    ]);
    expect(spaces.table('lab')).toEqual([]);
  });

  it('used() of an upload never claimed, or unknown, is a defect: it throws naming it, logs nothing, and leaves the upload claimable', async () => {
    const { spaces, logger } = await ready();
    const up = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('a') }]).iterable,
    });
    if (!up.ok) throw new Error(up.detail);
    const by = { user: 'alice', agents: ['hewo-1'] };
    expect(() => {
      spaces.used('lab', up.answer.upload, by);
    }).toThrow(new Error(`used: upload ${up.answer.upload} was not claimed on channel lab`));
    expect(() => {
      spaces.used('lab', 'f'.repeat(32), by);
    }).toThrow(new Error(`used: upload ${'f'.repeat(32)} was not claimed on channel lab`));
    expect(logger.entries.filter((e) => e.event === 'files.attached')).toEqual([]);
    expect(spaces.claim('lab', up.answer.upload).ok).toBe(true);
  });

  it('with the space at 998 entries, 2 files make 1,001 with their folder: 413 space_entries; 1 file is accepted', async () => {
    const { runtime, spaces } = await ready();
    const entries = present(runtime.volumes.get(VOLUME), 'the lab volume').entries;
    for (let i = 0; i < 998; i++)
      entries.set(
        `e${String(i)}`,
        i % 2 === 0 ? { type: 'dir', owner: '1000:1000' } : { type: 'link', target: '/etc' },
      );
    expect(
      await spaces.upload({
        channel: 'lab',
        user: 'u',
        body: body([
          { name: 'a', content: Buffer.from('a') },
          { name: 'b', content: Buffer.from('b') },
        ]).iterable,
      }),
    ).toEqual({
      ok: false,
      status: 413,
      reason: 'space_entries',
      detail: 'the space would hold 1001 entries, over its bound of 1000',
      drain: expect.any(Function) as (closed: Promise<void>) => Promise<DrainOutcome>,
    });
    expect(
      (
        await spaces.upload({
          channel: 'lab',
          user: 'u',
          body: body([{ name: 'a', content: Buffer.from('a') }]).iterable,
        })
      ).ok,
    ).toBe(true);
  });

  it('a space whose files would pass 256,000,000 bytes: 413 space_bytes', async () => {
    const { runtime, spaces } = await ready();
    present(runtime.volumes.get(VOLUME), 'the lab volume').entries.set('big', {
      type: 'file',
      content: Buffer.alloc(0),
      owner: '1000:1000',
      mode: 0o644,
    });
    // The fake's measurement reads sizes from the tar it builds: a 255,999,999-byte file is simulated by its header's size.
    const measuredBig = Buffer.alloc(255_999_995);
    present(runtime.volumes.get(VOLUME), 'the lab volume').entries.set('big', {
      type: 'file',
      content: measuredBig,
      owner: '1000:1000',
      mode: 0o644,
    });
    expect(
      await spaces.upload({
        channel: 'lab',
        user: 'u',
        body: body([{ name: 'a', content: Buffer.alloc(6) }]).iterable,
      }),
    ).toMatchObject({ ok: false, status: 413, reason: 'space_bytes' });
    expect(
      (
        await spaces.upload({
          channel: 'lab',
          user: 'u',
          body: body([{ name: 'a', content: Buffer.alloc(5) }]).iterable,
        })
      ).ok,
    ).toBe(true);
  });

  it('holding the lock through a measurement, a copy and a rollback of 59 s each, after waiting 59 s for it, is answered within 240 s', async () => {
    const { runtime, spaces } = await ready();
    const slow = <T>(value: T): Promise<T> =>
      new Promise((r) =>
        setTimeout(() => {
          r(value);
        }, 59_000),
      );
    let first = true;
    runtime.onCopyIn = async (_n, input) => {
      if (input.bytes.includes(Buffer.from('holder of the lock'))) return slow(undefined);
      return slow({ kind: 'exited', code: 1, stderr: 'fails, so a rollback runs' });
    };
    runtime.onCopy = async () => {
      if (first) {
        first = false;
        return undefined;
      }
      return slow(undefined);
    };
    runtime.onRollback = async () => slow(undefined);
    void spaces.upload({
      channel: 'lab',
      user: 'u',
      body: body([{ name: 'h', content: Buffer.from('holder of the lock') }]).iterable,
    });
    await vi.advanceTimersByTimeAsync(1);
    const start = Date.now();
    let answered: number | undefined;
    const timed = spaces
      .upload({ channel: 'lab', user: 'u', body: body([{ name: 't', content: Buffer.from('timed') }]).iterable })
      .then((r) => {
        answered = Date.now() - start;
        return r;
      });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(await timed).toMatchObject({ ok: false, reason: 'copy_failed' });
    expect(answered).toBeLessThanOrEqual(240_000);
    expect(answered).toBeGreaterThanOrEqual(4 * 59_000 - 1_000);
  });
});

describe("a refused upload's drain (docs/plans/portal.md R8b)", () => {
  const MANIFEST = JSON.stringify([{ name: 'a.txt', size: 100, sha256: 'a'.repeat(64) }]);
  /** The upload refused 409 no_space (no space was made), with its drain. */
  async function refused(sent: AsyncIterable<Uint8Array>) {
    const t = await setup();
    const result = await t.spaces.upload({ channel: 'lab', user: 'alice', body: sent });
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'no_space' });
    return { ...t, drain: drainOf(result) };
  }
  const drained = (logger: RecordingLogger) => logger.entries.filter((e) => e.event === 'files.body_drained');

  it('a body that sends nothing for 30 s after its refusal: the drain ends stalled, logged files.body_drained at warn', async () => {
    const { logger, drain } = await refused(stalledBody(MANIFEST, Buffer.alloc(0)));
    let outcome: DrainOutcome | undefined;
    void drain(new Promise(() => undefined)).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('stalled');
    expect(drained(logger)).toEqual([
      {
        level: 'warn',
        event: 'files.body_drained',
        fields: { channel: 'lab', status: 409, bytes: 0, outcome: 'stalled' },
      },
    ]);
  });

  it.each([
    [false, 'hung_up'],
    [true, 'closed'],
  ] as const)(
    'a body whose reading fails after more bytes (the daemon stopped: %s): the drain counts them and ends %s, logged at warn',
    async (stopping, outcome) => {
      const { spaces, logger, drain } = await refused({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield Buffer.from(`${MANIFEST}\n`);
          yield Buffer.alloc(500, 1);
          throw new Error('aborted');
        },
      });
      if (stopping) spaces.stop();
      expect(await drain(new Promise(() => undefined))).toBe(outcome);
      expect(drained(logger)).toEqual([
        { level: 'warn', event: 'files.body_drained', fields: { channel: 'lab', status: 409, bytes: 500, outcome } },
      ]);
    },
  );

  it.each([
    [false, 'hung_up'],
    [true, 'closed'],
  ] as const)(
    'a connection that closes while the drain waits (the daemon stopped: %s): it ends %s, logged at warn',
    async (stopping, outcome) => {
      const { spaces, logger, drain } = await refused(stalledBody(MANIFEST, Buffer.alloc(0)));
      let close!: () => void;
      const draining = drain(new Promise<void>((resolve) => (close = resolve)));
      await vi.advanceTimersByTimeAsync(10);
      if (stopping) spaces.stop();
      close();
      expect(await draining).toBe(outcome);
      expect(drained(logger)).toEqual([
        { level: 'warn', event: 'files.body_drained', fields: { channel: 'lab', status: 409, bytes: 0, outcome } },
      ]);
    },
  );

  it('a body that keeps sending a byte every 25 s: the drain ends over_time at 60 s, having read 2 bytes', async () => {
    const { logger, drain } = await refused({
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(`${MANIFEST}\n`);
        for (let i = 0; i < 10; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25_000));
          yield Buffer.from('x');
        }
      },
    });
    let outcome: DrainOutcome | undefined;
    void drain(new Promise(() => undefined)).then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('over_time');
    expect(drained(logger)).toEqual([
      {
        level: 'warn',
        event: 'files.body_drained',
        fields: { channel: 'lab', status: 409, bytes: 2, outcome: 'over_time' },
      },
    ]);
  });
});

describe('the stop (R3a, A4)', () => {
  it('aborts an upload in flight (its copy killed, no rollback), answers a new one 503, and keeps no space busy', async () => {
    const { runtime, spaces } = await ready();
    runtime.onCopyIn = async (_n, _i, signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener(
          'abort',
          () => {
            reject(signal.reason as Error);
          },
          { once: true },
        ),
      );
    const inFlight = spaces.upload({
      channel: 'lab',
      user: 'u',
      body: body([{ name: 'a', content: Buffer.from('a') }]).iterable,
    });
    await vi.advanceTimersByTimeAsync(10);
    spaces.stop();
    expect(await inFlight).toMatchObject({ ok: false, status: 503, reason: 'stopping' });
    expect(runtime.rollbacks).toEqual([]);
    expect(
      await spaces.upload({
        channel: 'lab',
        user: 'u',
        body: body([{ name: 'b', content: Buffer.from('b') }]).iterable,
      }),
    ).toMatchObject({ ok: false, status: 503, reason: 'stopping' });
    // The final checkpoint takes the lock at once.
    const snap = await spaces.snapshot('lab', () => () => Promise.resolve('more'), new AbortController().signal);
    expect(snap.ok).toBe(true);
  });

  it("cancels an unused upload's pending expiry — no rollback when its 600 s pass — and kills a rollback one-shot running for an expiry", async () => {
    const { runtime, spaces } = await ready();
    const a = await spaces.upload({
      channel: 'lab',
      user: 'u',
      body: body([{ name: 'a', content: Buffer.from('a') }]).iterable,
    });
    expect(a.ok).toBe(true);
    spaces.stop();
    await vi.advanceTimersByTimeAsync(700_000);
    expect(runtime.rollbacks).toEqual([]);

    const t = await ready();
    const b = await t.spaces.upload({
      channel: 'lab',
      user: 'u',
      body: body([{ name: 'b', content: Buffer.from('b') }]).iterable,
    });
    expect(b.ok).toBe(true);
    let killed = false;
    t.runtime.onRollback = async (_spec, signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener(
          'abort',
          () => {
            killed = true;
            reject(signal.reason as Error);
          },
          { once: true },
        ),
      );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(t.runtime.rollbacks).toHaveLength(1);
    t.spaces.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(killed).toBe(true);
    expect(t.logger.events()).toContain('files.rollback_abandoned');
  });
});

describe('the file table (R6, A5)', () => {
  it('records each uploaded file with exactly path, size, sha256, user and time; the 1,001st record drops the oldest', async () => {
    const { runtime, spaces } = await ready();
    const first = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('a') }]).iterable,
    });
    if (!first.ok) throw new Error(first.detail);
    const firstFile = present(first.answer.files[0], 'the first uploaded file');
    expect(spaces.table('lab')).toEqual([
      {
        path: firstFile.path,
        size: 1,
        sha256: sha('a'),
        user: 'alice',
        time: '2026-09-30T12:00:00.000Z',
      },
    ]);
    expect(spaces.claim('lab', first.answer.upload).ok).toBe(true);
    spaces.used('lab', first.answer.upload, { user: 'alice', agents: [] });
    for (let i = 0; i < MAX_RECORDS / 10; i++) {
      const up = await spaces.upload({
        channel: 'lab',
        user: 'bob',
        body: body(Array.from({ length: 10 }, (_, j) => ({ name: `f${String(j)}`, content: Buffer.from(String(i)) })))
          .iterable,
      });
      if (!up.ok) throw new Error(up.detail);
      expect(spaces.claim('lab', up.answer.upload).ok).toBe(true);
      spaces.used('lab', up.answer.upload, { user: 'bob', agents: [] });
      // An agent deletes the files; their records stay (the table is the attachments' record, not the space's listing).
      present(runtime.volumes.get(VOLUME), 'the lab volume').entries.clear();
    }
    expect(spaces.table('lab')).toHaveLength(MAX_RECORDS);
    expect(spaces.table('lab').some((r) => r.path === firstFile.path)).toBe(false);
  }, 30_000);

  it('used() logs one files.attached per file with exactly user, channel, agents, name, size, sha256', async () => {
    const { spaces, logger } = await ready();
    const up = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([
        { name: 'a.txt', content: Buffer.from('a') },
        { name: 'b.txt', content: Buffer.from('bb') },
      ]).iterable,
    });
    if (!up.ok) throw new Error(up.detail);
    spaces.claim('lab', up.answer.upload);
    spaces.used('lab', up.answer.upload, { user: 'alice', agents: ['hewo-1', 'hewo-2'] });
    expect(logger.entries.filter((e) => e.event === 'files.attached')).toEqual([
      {
        level: 'info',
        event: 'files.attached',
        fields: {
          user: 'alice',
          channel: 'lab',
          agents: ['hewo-1', 'hewo-2'],
          name: 'a.txt',
          size: 1,
          sha256: sha('a'),
        },
      },
      {
        level: 'info',
        event: 'files.attached',
        fields: {
          user: 'alice',
          channel: 'lab',
          agents: ['hewo-1', 'hewo-2'],
          name: 'b.txt',
          size: 2,
          sha256: sha('bb'),
        },
      },
    ]);
  });
});

describe('returning files (R12, R12a, A6)', () => {
  const ret = (spaces: ChannelFileSpaces, paths: string[]) =>
    spaces.returnFiles({ channel: 'lab', conversation: 'c1', user: 'alice', handle: 'hewo-1', paths });

  it('copies out a top-level file and an attachment by its folder, records each for download, and logs files.returned', async () => {
    const { runtime, spaces, logger } = await ready();
    const entries = present(runtime.volumes.get(VOLUME), 'the lab volume').entries;
    entries.set('out.txt', file('result\n'));
    entries.set('upload-0123456789abcdef', { type: 'dir', owner: '1000:1000' });
    entries.set('upload-0123456789abcdef/report.pdf', file(Buffer.alloc(1_000_000, 3)));
    entries.set('upload-0123456789abcdef/other.txt', file('other'));
    const result = await ret(spaces, ['/channel/out.txt', '/channel/upload-0123456789abcdef/report.pdf']);
    if (!result.ok) throw new Error(result.rule);
    expect(result.files.map(({ name, size, sha256 }) => ({ name, size, sha256 }))).toEqual([
      { name: 'out.txt', size: 7, sha256: sha('result\n') },
      { name: 'report.pdf', size: 1_000_000, sha256: sha(Buffer.alloc(1_000_000, 3)) },
    ]);
    expect(runtime.calls.filter((c) => c.startsWith('copyOut'))).toEqual([
      `copyOut ${HOLDER} /channel/out.txt`,
      `copyOut ${HOLDER} /channel/upload-0123456789abcdef`,
    ]);
    expect(logger.entries.filter((e) => e.event === 'files.returned').map((e) => e.fields)).toEqual([
      { user: 'alice', channel: 'lab', handle: 'hewo-1', name: 'out.txt', size: 7, sha256: sha('result\n') },
      {
        user: 'alice',
        channel: 'lab',
        handle: 'hewo-1',
        name: 'report.pdf',
        size: 1_000_000,
        sha256: sha(Buffer.alloc(1_000_000, 3)),
      },
    ]);
    const got: Buffer[] = [];
    const sink: DownloadSink = {
      begin: () => undefined,
      write: (c) => {
        got.push(c);
        return Promise.resolve();
      },
    };
    expect(await spaces.download(present(result.files[1], 'the second returned file').id, sink)).toEqual({
      ok: true,
    });
    expect(Buffer.concat(got).equals(Buffer.alloc(1_000_000, 3))).toBe(true);
  });

  it('refuses the whole reply for a link, a folder replaced by a link, another folder, a linked folder, a subfolder, a dot name, outside paths, 25,000,001 bytes and 11 files', async () => {
    const { runtime, spaces, logger } = await ready();
    const entries = present(runtime.volumes.get(VOLUME), 'the lab volume').entries;
    entries.set('ok.txt', file('fine'));
    entries.set('p', { type: 'link', target: '/etc/hosts' });
    entries.set('upload-aaaaaaaaaaaaaaaa', { type: 'link', target: '/etc' });
    entries.set('other', { type: 'dir', owner: '1000:1000' });
    entries.set('other/x.txt', file('x'));
    entries.set('d', { type: 'link', target: '/etc' });
    entries.set('sub', { type: 'dir', owner: '1000:1000' });
    entries.set('sub/x.txt', file('x'));
    entries.set('.hidden', file('h'));
    entries.set('big', file(Buffer.alloc(25_000_001)));
    // An attachment's folder in which an agent planted a link: the folder's other entries pass the same entry rules.
    entries.set('upload-cccccccccccccccc', { type: 'dir', owner: '1000:1000' });
    entries.set('upload-cccccccccccccccc/report.pdf', file('pdf'));
    entries.set('upload-cccccccccccccccc/evil', { type: 'link', target: '/etc' });
    const cases: [string[], string][] = [
      [['/channel/upload-cccccccccccccccc/report.pdf'], '/channel/upload-cccccccccccccccc/report.pdf'],
      [['/channel/ok.txt', '/channel/p'], '/channel/p'],
      [['/channel/upload-aaaaaaaaaaaaaaaa/passwd'], '/channel/upload-aaaaaaaaaaaaaaaa/passwd'],
      [['/channel/other/x.txt'], '/channel/other/x.txt'],
      [['/channel/d/passwd'], '/channel/d/passwd'],
      [['/channel/sub/x.txt'], '/channel/sub/x.txt'],
      [['/channel/.hidden'], '/channel/.hidden'],
      [['/etc/passwd'], '/etc/passwd'],
      [['/workspace/x'], '/workspace/x'],
      [['/channel/big'], '/channel/big'],
      [Array.from({ length: 11 }, () => '/channel/ok.txt'), '/channel/ok.txt'],
    ];
    for (const [paths, refused] of cases) {
      const result = await ret(spaces, paths);
      expect(result.ok, paths.join(' ')).toBe(false);
      if (!result.ok) expect(result.file, paths.join(' ')).toBe(refused);
    }
    expect(logger.events('error').filter((e) => e === 'files.refused')).toHaveLength(cases.length);
    for (const e of logger.entries.filter((x) => x.event === 'files.refused')) {
      expect(Object.keys(e.fields).sort(byCodeUnit)).toEqual(['channel', 'error', 'name', 'reason']);
      expect(JSON.stringify(e.fields)).not.toContain('alice');
    }
    expect(logger.events().filter((e) => e === 'files.returned')).toEqual([]);
  });

  it('a return that waits 10 s for the lock fails file_refused, copying nothing', async () => {
    const { runtime, spaces } = await ready();
    present(runtime.volumes.get(VOLUME), 'the lab volume').entries.set('out.txt', file('x'));
    runtime.onCopyIn = async () => new Promise(() => undefined);
    void spaces.upload({ channel: 'lab', user: 'u', body: body([{ name: 'a', content: Buffer.from('a') }]).iterable });
    await vi.advanceTimersByTimeAsync(5);
    const returned = ret(spaces, ['/channel/out.txt']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await returned).toEqual({ ok: false, file: '/channel/out.txt', rule: 'the space was busy for 10000 ms' });
    expect(runtime.calls.filter((c) => c.includes('/channel/out.txt'))).toEqual([]);
  });

  it("refuses a file not in the space, a copy that fails otherwise (naming its error), a folder named as a file, a path more than one folder deep, and an upload's folder that is not a folder", async () => {
    const { runtime, spaces, logger } = await ready();
    const entries = present(runtime.volumes.get(VOLUME), 'the lab volume').entries;
    entries.set('denied.txt', file('x'));
    entries.set('results', { type: 'dir', owner: '1000:1000' });
    entries.set('results/r.txt', file('r'));
    entries.set('upload-dddddddddddddddd', file('a file where a folder should be'));
    const denied = `docker cp ${HOLDER}:/channel/denied.txt - exited 1: Error response from daemon: permission denied`;
    runtime.onCopy = (_name, path) =>
      Promise.resolve(path === '/channel/denied.txt' ? { ok: false, detail: denied } : undefined);
    const cases: [string, string][] = [
      ['/channel/missing.txt', 'no such file in the space'],
      ['/channel/denied.txt', denied],
      ['/channel/results', 'results: not a regular file'],
      ['/channel/upload-dddddddddddddddd/x/y.txt', 'a path more than one folder deep'],
      ['/channel/upload-dddddddddddddddd/report.pdf', "upload-dddddddddddddddd: the upload's folder is not a folder"],
    ];
    for (const [path, rule] of cases) expect(await ret(spaces, [path]), path).toEqual({ ok: false, file: path, rule });
    expect(runtime.calls.filter((c) => c.startsWith('copyOut'))).toEqual([
      `copyOut ${HOLDER} /channel/missing.txt`,
      `copyOut ${HOLDER} /channel/denied.txt`,
      `copyOut ${HOLDER} /channel/results`,
      `copyOut ${HOLDER} /channel/upload-dddddddddddddddd`,
    ]);
    expect(
      logger.entries
        .filter((e) => e.event !== 'files.space_created')
        .map((e) => [e.level, e.event, { ...e.fields, error: (e.fields['error'] as Error).message }]),
    ).toEqual(
      cases.map(([path, rule]) => [
        'error',
        'files.refused',
        { channel: 'lab', reason: 'file_refused', name: path.split('/').at(-1), error: rule },
      ]),
    );
  });

  it("refuses a copy out that holds a second entry beside a top-level file, or two entries of the attachment's name in its folder", async () => {
    const { runtime, spaces } = await ready();
    const folder = 'upload-eeeeeeeeeeeeeeee';
    const tars: Record<string, Buffer> = {
      '/channel/out.txt': Buffer.concat([
        tarFile('out.txt', Buffer.from('one'), 1),
        tarFile('extra.txt', Buffer.from('two'), 1),
        Buffer.alloc(1024),
      ]),
      [`/channel/${folder}`]: Buffer.concat([
        tarDirectory(folder, 1),
        tarFile(`${folder}/r.pdf`, Buffer.from('one'), 1),
        tarFile(`${folder}/r.pdf`, Buffer.from('two'), 1),
        Buffer.alloc(1024),
      ]),
    };
    runtime.copyOut = async (name, path, onChunk) => {
      runtime.calls.push(`copyOut ${name} ${path}`);
      await onChunk(present(tars[path], `the tar of ${path}`));
      return { ok: true };
    };
    expect(await ret(spaces, ['/channel/out.txt'])).toEqual({
      ok: false,
      file: '/channel/out.txt',
      rule: 'extra.txt: more than one entry',
    });
    expect(await ret(spaces, [`/channel/${folder}/r.pdf`])).toEqual({
      ok: false,
      file: `/channel/${folder}/r.pdf`,
      rule: `${folder}/r.pdf: more than one entry of that name`,
    });
    expect(runtime.calls).toEqual([`copyOut ${HOLDER} /channel/out.txt`, `copyOut ${HOLDER} /channel/${folder}`]);
  });

  it("the daemon's stop during a return's copy out refuses it 'the daemon is stopping'; a copy out that throws otherwise fails the return loudly, its lock released", async () => {
    const { runtime, spaces } = await ready();
    present(runtime.volumes.get(VOLUME), 'the lab volume').entries.set('out.txt', file('x'));
    runtime.onCopy = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve(undefined);
        }, 1_000),
      );
    const returning = ret(spaces, ['/channel/out.txt']);
    await vi.advanceTimersByTimeAsync(10);
    expect(runtime.calls).toEqual([`copyOut ${HOLDER} /channel/out.txt`]);
    spaces.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await returning).toEqual({ ok: false, file: '/channel/out.txt', rule: 'the daemon is stopping' });

    const t = await ready();
    present(t.runtime.volumes.get(VOLUME), 'the lab volume').entries.set('out.txt', file('x'));
    const copyOut = t.runtime.copyOut.bind(t.runtime);
    const spawn = new Error('spawn docker EAGAIN');
    t.runtime.copyOut = () => Promise.reject(spawn);
    expect(await ret(t.spaces, ['/channel/out.txt']).catch((e: unknown) => e)).toBe(spawn);
    t.runtime.copyOut = copyOut;
    expect((await ret(t.spaces, ['/channel/out.txt'])).ok).toBe(true);
  });

  it("a return waiting for the lock when the daemon stops is refused 'the daemon is stopping', copying nothing", async () => {
    const { runtime, spaces } = await ready();
    present(runtime.volumes.get(VOLUME), 'the lab volume').entries.set('out.txt', file('x'));
    // A snapshot holds the lock: its copy out never answers.
    runtime.onCopy = () => new Promise(() => undefined);
    void spaces.snapshot('lab', () => () => Promise.resolve('more'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    const returning = ret(spaces, ['/channel/out.txt']);
    await vi.advanceTimersByTimeAsync(10);
    spaces.stop();
    expect(await returning).toEqual({ ok: false, file: '/channel/out.txt', rule: 'the daemon is stopping' });
    expect(runtime.calls).toEqual([`copyOut ${HOLDER} /channel`]);
  });

  it('a download of a file changed after the reply ends one byte short, refused; an unknown id and the 1,001st-oldest are unknown', async () => {
    const { runtime, spaces, logger } = await ready();
    const entries = present(runtime.volumes.get(VOLUME), 'the lab volume').entries;
    entries.set('out.txt', file('original'));
    const result = await ret(spaces, ['/channel/out.txt']);
    if (!result.ok) throw new Error(result.rule);
    const firstReturned = present(result.files[0], 'the first returned file');
    entries.set('out.txt', file('changed!'));
    const got: Buffer[] = [];
    expect(
      await spaces.download(firstReturned.id, {
        begin: () => undefined,
        write: (c) => {
          got.push(c);
          return Promise.resolve();
        },
      }),
    ).toEqual({
      ok: false,
      reason: 'refused',
      rule: `the file changed since the reply: 8 bytes, sha256 ${sha('changed!')}`,
    });
    expect(Buffer.concat(got).toString()).toBe('changed');
    const refused = present(
      logger.entries.find((e) => e.event === 'files.refused'),
      'the files.refused log entry',
    );
    expect(refused.fields).toMatchObject({
      channel: 'lab',
      reason: 'download_refused',
      name: 'out.txt',
    });
    expect(
      await spaces.download('0'.repeat(32), { begin: () => undefined, write: () => Promise.resolve() }),
    ).toMatchObject({ ok: false, reason: 'unknown' });
    const firstId = firstReturned.id;
    for (let i = 0; i < MAX_RECORDS; i++) expect((await ret(spaces, ['/channel/out.txt'])).ok).toBe(true);
    expect(await spaces.download(firstId, { begin: () => undefined, write: () => Promise.resolve() })).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
  }, 30_000);
});

describe("a persisted channel's snapshot (R15, A12)", () => {
  it('leaves out the folder and records of every upload no posted message named — answered but unused, failed, rollback failed, aborted — and keeps a used one', async () => {
    const { runtime, spaces } = await ready();
    const used = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'kept.txt', content: Buffer.from('kept') }]).iterable,
    });
    const unused = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'unused.txt', content: Buffer.from('u') }]).iterable,
    });
    if (!used.ok || !unused.ok) throw new Error('upload failed');
    spaces.claim('lab', used.answer.upload);
    spaces.used('lab', used.answer.upload, { user: 'alice', agents: [] });
    // A failed copy whose rollback failed too: its folder stays in the space.
    runtime.onCopyIn = async (_n, input) => {
      // Extracted as Docker would, then failed: its folder is in the space.
      await applyTar(present(runtime.volumes.get(VOLUME), 'the lab volume'), input.bytes);
      return { kind: 'exited', code: 1, stderr: 'failed after extracting' };
    };
    runtime.onRollback = () => Promise.resolve({ kind: 'exited', code: 1, stderr: 'cannot' });
    const failed = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'failed.txt', content: Buffer.from('f') }]).iterable,
    });
    expect(failed).toMatchObject({ ok: false, reason: 'rollback_failed' });
    runtime.onRollback = () => Promise.resolve(undefined);
    const names: string[] = [];
    const parser = new TarParser({
      entry: (h: TarHeader) => {
        names.push(h.name);
        return Promise.resolve(undefined);
      },
      data: () => Promise.resolve(),
      entryEnd: () => Promise.resolve(undefined),
      end: () => Promise.resolve(),
    });
    let plan: SnapshotPlan | undefined;
    const snap = await spaces.snapshot(
      'lab',
      (given) => {
        plan = given;
        return async (chunk) => (await parser.push(chunk), 'more');
      },
      new AbortController().signal,
    );
    if (!snap.ok || plan === undefined) throw new Error('no snapshot');
    const safePlan = plan;
    const kept = names.map((n) => n.replace(/\/$/, '')).filter((n) => !safePlan.skip(n));
    const usedFile = present(used.answer.files[0], 'the used upload file');
    const usedFolder = present(usedFile.path.split('/')[2], 'the used file folder');
    expect(kept.toSorted(byCodeUnit)).toEqual(
      ['channel', `channel/${usedFolder}`, `channel/${usedFolder}/kept.txt`].sort(byCodeUnit),
    );
    expect(names.some((n) => n.includes('failed.txt'))).toBe(true);
    expect(plan.table.map((r) => r.path)).toEqual([usedFile.path]);
    expect(Object.keys(present(plan.table[0], 'the first table record')).sort(byCodeUnit)).toEqual([
      'path',
      'sha256',
      'size',
      'time',
      'user',
    ]);
  });
});

describe('a fill given to a space that exists or is being made (R15; completion review, finding 2)', () => {
  const kept = {
    path: '/channel/kept.txt',
    size: 4,
    sha256: sha(Buffer.from('kept')),
    user: 'alice',
    time: '2026-09-30T00:00:00.000Z',
  };
  const fill = (): SpaceFill => ({
    archive: async function* () {
      await Promise.resolve();
      yield Buffer.concat([
        tarDirectory('channel/', 1),
        tarFile('channel/kept.txt', Buffer.from('kept'), 1),
        Buffer.alloc(1024),
      ]);
    },
    table: [kept],
  });

  it('an existing empty space is filled from it, its table restored', async () => {
    const { runtime, spaces } = await ready();
    await spaces.ensure('lab', IMAGE, fill());
    expect(runtime.copyIns).toHaveLength(1);
    expect(spaces.table('lab')).toEqual([kept]);
  });

  it('a space being created by another call is filled once that creation ends', async () => {
    const { runtime, spaces } = await setup();
    const plain = spaces.ensure('lab', IMAGE);
    const filled = spaces.ensure('lab', IMAGE, fill());
    expect(await filled).toBe(await plain);
    expect(runtime.copyIns).toHaveLength(2);
    expect(spaces.table('lab')).toEqual([kept]);
  });

  it('an existing space that holds a file refuses it, SpaceHoldsFiles, copying nothing: never dropped silently', async () => {
    const { runtime, spaces } = await ready();
    const up = await spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: Buffer.from('a') }]).iterable,
    });
    if (!up.ok) throw new Error(up.detail);
    runtime.copyIns.length = 0;
    await expect(spaces.ensure('lab', IMAGE, fill())).rejects.toBeInstanceOf(SpaceHoldsFiles);
    expect(runtime.copyIns).toEqual([]);
    expect(spaces.table('lab').map((r) => r.path)).toEqual([present(up.answer.files[0], 'the uploaded file').path]);
  });
});

describe('failures that leave nothing behind, and bounded lock waits (R3a, R10, R12a, R15; the R1 code review)', () => {
  const saved = (): SpaceFill => ({
    archive: async function* () {
      await Promise.resolve();
      yield Buffer.concat([
        tarDirectory('channel/', 1),
        tarFile('channel/a.txt', Buffer.from('aaaa'), 1),
        tarFile('channel/b.txt', Buffer.from('bbbb'), 1),
        Buffer.alloc(1024),
      ]);
    },
    table: [],
  });
  const fieldsOf = (logger: RecordingLogger, event: string) =>
    logger.entries
      .filter((e) => e.event === event)
      .map((e): [string, Record<string, unknown>] => [
        e.level,
        { ...e.fields, error: (e.fields['error'] as Error).message },
      ]);
  const upload = (spaces: ChannelFileSpaces, name = 'a.txt') =>
    spaces.upload({ channel: 'lab', user: 'alice', body: body([{ name, content: Buffer.from('x') }]).iterable });
  const ret = (spaces: ChannelFileSpaces, paths: string[]) =>
    spaces.returnFiles({ channel: 'lab', conversation: 'c1', user: 'alice', handle: 'hewo-1', paths });

  it('a fill into an existing space that fails after extracting part of the saved files empties the space again, logs files.space_create_failed with its cleanup, and a later fill is accepted (R1-DESIGN-005, R1-DOCS-025)', async () => {
    const { runtime, spaces, logger } = await ready();
    runtime.onCopyIn = async (name, input) => {
      await applyTar(runtime.spaceOf(name), input.bytes);
      return { kind: 'exited', code: 1, stderr: 'Error: no space left on device' };
    };
    await expect(spaces.fillIfEmpty('lab', saved())).rejects.toThrow(
      new FileSpaceUnavailable('lab', 'fill', 'docker cp exited 1: Error: no space left on device'),
    );
    expect(runtime.calls.filter((c) => c.startsWith('emptySpace'))).toEqual([`emptySpace ${VOLUME}`]);
    expect(await spaces.usage('lab')).toEqual({ bytes: 0, entries: 0 });
    expect(fieldsOf(logger, 'files.space_create_failed')).toEqual([
      [
        'error',
        {
          channel: 'lab',
          volume: VOLUME,
          step: 'fill',
          error: 'docker cp exited 1: Error: no space left on device',
          cleanup: [],
        },
      ],
    ]);
    runtime.onCopyIn = () => Promise.resolve(undefined);
    expect(await spaces.fillIfEmpty('lab', saved())).toBe(true);
    expect((await spaces.usage('lab')).entries).toBe(2);
  });

  it("a failed fill whose emptying fails too names it in files.space_create_failed's cleanup", async () => {
    const { runtime, spaces, logger } = await ready();
    runtime.onCopyIn = () => Promise.resolve({ kind: 'exited', code: 1, stderr: 'boom' });
    runtime.onEmptySpace = () => Promise.resolve({ kind: 'exited', code: 1, stderr: 'rm: cannot remove' });
    await expect(spaces.fillIfEmpty('lab', saved())).rejects.toBeInstanceOf(FileSpaceUnavailable);
    expect(fieldsOf(logger, 'files.space_create_failed').map(([, f]) => f['cleanup'])).toEqual([
      ['space: emptying it exited 1: rm: cannot remove'],
    ]);
  });

  it('a fill whose copy rejects empties the space and fails step fill with the rejection as its cause; an emptying that rejects too is named in the cleanup', async () => {
    const { runtime, spaces, logger } = await ready();
    const killed = new Error('docker cp - holder:/ was killed by SIGTERM');
    runtime.onCopyIn = () => Promise.reject(killed);
    runtime.onEmptySpace = () => Promise.reject(new Error('spawn docker EAGAIN'));
    const error = await spaces.fillIfEmpty('lab', saved()).catch((e: unknown) => e);
    expect(error).toEqual(new FileSpaceUnavailable('lab', 'fill', killed.message, { cause: killed }));
    expect((error as Error).cause).toBe(killed);
    expect(runtime.calls.filter((c) => c.startsWith('emptySpace'))).toEqual([`emptySpace ${VOLUME}`]);
    expect(fieldsOf(logger, 'files.space_create_failed')).toEqual([
      [
        'error',
        {
          channel: 'lab',
          volume: VOLUME,
          step: 'fill',
          error: killed.message,
          cleanup: ['space: emptying it failed: spawn docker EAGAIN'],
        },
      ],
    ]);
    expect(spaces.table('lab')).toEqual([]);
  });

  it("an unused upload's expiry waits for the lock at most 60 s: past it, its records already dropped, files.rollback_failed names its folder and no rollback runs; one the daemon's stop ends logs nothing", async () => {
    const t = await ready();
    const up = await upload(t.spaces);
    if (!up.ok) throw new Error(up.detail);
    const folder = present(present(up.answer.files[0], 'the uploaded file').path.split('/')[2], 'its folder');
    // A snapshot holds the lock: its copy out never answers.
    t.runtime.onCopy = () => new Promise(() => undefined);
    void t.spaces.snapshot('lab', () => () => Promise.resolve('more'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(600_000);
    expect([t.spaces.table('lab'), fieldsOf(t.logger, 'files.rollback_failed')]).toEqual([[], []]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fieldsOf(t.logger, 'files.rollback_failed')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fieldsOf(t.logger, 'files.rollback_failed')).toEqual([
      ['error', { channel: 'lab', volume: VOLUME, folder, error: 'the lock was busy past 60000 ms' }],
    ]);
    expect(t.runtime.rollbacks).toEqual([]);
    expect(t.spaces.claim('lab', up.answer.upload)).toEqual({
      ok: false,
      detail: `attachments ${up.answer.upload} is unknown, expired or already used`,
    });

    const s = await ready();
    expect((await upload(s.spaces)).ok).toBe(true);
    s.runtime.onCopy = () => new Promise(() => undefined);
    void s.spaces.snapshot('lab', () => () => Promise.resolve('more'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(600_000);
    s.spaces.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect([s.runtime.rollbacks, s.logger.entries.filter((e) => e.event.startsWith('files.rollback'))]).toEqual([
      [],
      [],
    ]);
  });

  it('a copy that rejects for any reason but the stop is rolled back, logged files.copy_failed, and answered 500 copy_failed; a snapshot leaves its folder out (R1-DESIGN-006)', async () => {
    const { runtime, spaces, logger } = await ready();
    runtime.onCopyIn = async (name, input) => {
      await applyTar(runtime.spaceOf(name), input.bytes);
      throw new Error('docker cp - holder:/ was killed by SIGTERM');
    };
    expect(await upload(spaces)).toEqual({
      ok: false,
      status: 500,
      reason: 'copy_failed',
      detail: 'the copy into the space failed: docker cp - holder:/ was killed by SIGTERM',
      drain: expect.any(Function) as (closed: Promise<void>) => Promise<DrainOutcome>,
    });
    const folder = present(runtime.rollbacks[0], 'the rollback').folder;
    expect(fieldsOf(logger, 'files.copy_failed')).toEqual([
      [
        'error',
        {
          channel: 'lab',
          volume: VOLUME,
          folder,
          reason: 'error',
          error: 'docker cp - holder:/ was killed by SIGTERM',
        },
      ],
    ]);
    expect(await spaces.usage('lab')).toEqual({ bytes: 0, entries: 0 });
    let plan: SnapshotPlan | undefined;
    await spaces.snapshot(
      'lab',
      (taken) => {
        plan = taken;
        return () => Promise.resolve('more');
      },
      new AbortController().signal,
    );
    expect(present(plan, 'the snapshot plan').skip(`channel/${folder}`)).toBe(true);
  });

  it('a rollback that rejects is files.rollback_failed naming channel, volume and folder, and the upload answers 500 rollback_failed; so is an expiry’s (R14; R1-DOCS-008)', async () => {
    const { runtime, spaces, logger } = await ready();
    runtime.onCopyIn = () => Promise.resolve({ kind: 'exited', code: 1, stderr: 'x' });
    runtime.onRollback = () => Promise.reject(new Error('spawn docker EAGAIN'));
    const refused = await upload(spaces);
    const folder = present(runtime.rollbacks[0], 'the rollback').folder;
    expect(refused).toMatchObject({
      ok: false,
      status: 500,
      reason: 'rollback_failed',
      detail: `the failed copy's folder ${folder} could not be removed`,
    });
    expect(fieldsOf(logger, 'files.rollback_failed')).toEqual([
      ['error', { channel: 'lab', volume: VOLUME, folder, error: 'spawn docker EAGAIN' }],
    ]);
    // An unused upload's expiry, its rollback rejecting: the same record, once.
    runtime.onCopyIn = () => Promise.resolve(undefined);
    const used = await upload(spaces, 'b.txt');
    if (!used.ok) throw new Error(used.detail);
    logger.entries.length = 0;
    await vi.advanceTimersByTimeAsync(600_001);
    const expired = present(runtime.rollbacks[1], 'the expiry rollback').folder;
    expect(fieldsOf(logger, 'files.rollback_failed')).toEqual([
      ['error', { channel: 'lab', volume: VOLUME, folder: expired, error: 'spawn docker EAGAIN' }],
    ]);
  });

  it('the 100-unused bound is checked again under the lock: two uploads arriving together at 99 leave 100, the second answered 429, copying nothing (R1-RELIABILITY-005)', async () => {
    const { runtime, spaces } = await ready();
    for (let i = 0; i < 99; i++) expect((await upload(spaces, `f${String(i)}`)).ok).toBe(true);
    const copies = runtime.copyIns.length;
    const [first, second] = await Promise.all([upload(spaces, 'x'), upload(spaces, 'y')]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, status: 429, reason: 'too_many_uploads' });
    expect(runtime.copyIns).toHaveLength(copies + 1);
  });

  it('a returned file that grew since the reply is refused before any byte is sent: its sink never begun (R12a; R1-DOCS-009)', async () => {
    const { runtime, spaces } = await ready();
    const entries = present(runtime.volumes.get(VOLUME), 'the lab volume').entries;
    entries.set('out.txt', file('original'));
    const result = await ret(spaces, ['/channel/out.txt']);
    if (!result.ok) throw new Error(result.rule);
    entries.set('out.txt', file('original and grown since'));
    let begun = false;
    const got: Buffer[] = [];
    expect(
      await spaces.download(present(result.files[0], 'the returned file').id, {
        begin: () => {
          begun = true;
        },
        write: (c) => {
          got.push(c);
          return Promise.resolve();
        },
      }),
    ).toEqual({ ok: false, reason: 'refused', rule: 'out.txt: the file changed since the reply: 24 bytes, not 8' });
    expect([begun, got]).toEqual([false, []]);
  });

  it('a fill waits for the lock at most SPACE_LOCK_WAIT_MS, failing step lock; so does a removal, even during the daemon’s stop, which removes spaces itself (R1-DESIGN-004)', async () => {
    const { runtime, spaces, logger } = await ready();
    // A snapshot holds the lock: its copy out never answers.
    runtime.onCopy = () => new Promise(() => undefined);
    void spaces.snapshot('lab', () => () => Promise.resolve('more'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    const filling = spaces.fillIfEmpty('lab', saved()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SPACE_LOCK_WAIT_MS - 1);
    expect(runtime.copyIns).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await filling).toEqual(
      new FileSpaceUnavailable('lab', 'lock', `the space's lock was busy past ${String(SPACE_LOCK_WAIT_MS)} ms`),
    );
    expect(fieldsOf(logger, 'files.space_create_failed')).toEqual([
      [
        'error',
        {
          channel: 'lab',
          volume: VOLUME,
          step: 'lock',
          error: `the space's lock was busy past ${String(SPACE_LOCK_WAIT_MS)} ms`,
          cleanup: [],
        },
      ],
    ]);
    const removing = spaces.remove('lab').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    spaces.stop();
    await vi.advanceTimersByTimeAsync(SPACE_LOCK_WAIT_MS - 1);
    expect(runtime.calls.filter((c) => c.startsWith('remove'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await removing).toEqual(
      new FileSpaceRemoveFailed('lab', `the space's lock was busy past ${String(SPACE_LOCK_WAIT_MS)} ms`),
    );
    expect(runtime.calls.filter((c) => c.startsWith('remove'))).toEqual([]);
  });

  it('a creation waits for the lock at most SPACE_LOCK_WAIT_MS, failing step lock with nothing made (R1-DESIGN-004)', async () => {
    const { runtime, spaces, logger } = await ready();
    // A removal holds the lock: its holder's removal never answers.
    runtime.removeContainer = () => new Promise(() => undefined);
    void spaces.remove('lab');
    await vi.advanceTimersByTimeAsync(0);
    const creating = spaces.ensure('lab', IMAGE).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SPACE_LOCK_WAIT_MS);
    expect(await creating).toEqual(
      new FileSpaceUnavailable('lab', 'lock', `the space's lock was busy past ${String(SPACE_LOCK_WAIT_MS)} ms`),
    );
    expect(fieldsOf(logger, 'files.space_create_failed').map(([, f]) => f['step'])).toEqual(['lock']);
    expect(runtime.calls.filter((c) => c.startsWith('createVolume'))).toEqual([]);
  });
});

describe("a command plugin call's read of the space and its write-back (extension-modules R30; agent-files R11, R13)", () => {
  const live = () => new AbortController().signal;
  const into = (chunks: Buffer[]) => (chunk: Buffer) => {
    chunks.push(chunk);
    return Promise.resolve('more' as const);
  };
  /** A plugin's write-back of one file: its tar, as the call's copy-out read it. */
  const written = (name: string, content: string) => () =>
    sends(Buffer.concat([tarFile(`channel/${name}`, Buffer.from(content), 1), Buffer.alloc(1024)]));
  /** A snapshot holding the channel's lock: its copy out never answers. */
  async function holdLock(t: Awaited<ReturnType<typeof ready>>) {
    t.runtime.onCopy = () => new Promise(() => undefined);
    void t.spaces.snapshot('lab', () => () => Promise.resolve('more'), live());
    await vi.advanceTimersByTimeAsync(0);
  }

  it("reads a path of the space, or all of it, by docker cp <holder>:/channel/<rel> -, each chunk to the call, under the channel's lock", async () => {
    const { runtime, spaces } = await ready();
    present(runtime.volumes.get(VOLUME), 'the lab volume').entries.set('in.txt', file('input\n'));
    const one: Buffer[] = [];
    expect(await spaces.readForPlugin('lab', 'in.txt', into(one), live())).toEqual({ ok: true });
    const all: Buffer[] = [];
    expect(await spaces.readForPlugin('lab', '', into(all), live())).toEqual({ ok: true });
    expect([tarEntries(Buffer.concat(one)), tarEntries(Buffer.concat(all))]).toEqual([
      [{ name: 'in.txt', type: '0', owner: '1000:1000', mode: '644', size: 6 }],
      [
        { name: 'channel/', type: '5', owner: '1000:1000', mode: '755', size: 0 },
        { name: 'channel/in.txt', type: '0', owner: '1000:1000', mode: '644', size: 6 },
      ],
    ]);
    expect(runtime.calls).toEqual([`copyOut ${HOLDER} /channel/in.txt`, `copyOut ${HOLDER} /channel`]);
  });

  it('a read answers a channel with no space, a lock busy for 10 s, and a call ended or a daemon stopped while it waits, copying nothing', async () => {
    const t = await ready();
    expect(await t.spaces.readForPlugin('other', 'x', into([]), live())).toEqual({
      ok: false,
      detail: 'channel other has no file space',
    });
    await holdLock(t);
    const busy = t.spaces.readForPlugin('lab', 'x', into([]), live());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await busy).toEqual({ ok: false, detail: 'the space was busy for 10000 ms' });
    const call = new AbortController();
    const ended = t.spaces.readForPlugin('lab', 'x', into([]), call.signal);
    const stopped = t.spaces.readForPlugin('lab', 'x', into([]), live());
    await vi.advanceTimersByTimeAsync(10);
    call.abort(new Error('the call passed its bound'));
    expect(await ended).toEqual({ ok: false, detail: 'the call ended before the space was free' });
    t.spaces.stop();
    expect(await stopped).toEqual({ ok: false, detail: 'the call ended before the space was free' });
    // The snapshot's copy out alone.
    expect(t.runtime.calls).toEqual([`copyOut ${HOLDER} /channel`]);
  });

  it('writes a plugin’s tar back into the space under the lock once a measurement shows it fits: measured, then copied', async () => {
    const { runtime, spaces } = await ready();
    expect(
      await spaces.writeFromPlugin('lab', { entries: 1, bytes: 7 }, written('out.txt', 'result\n'), live()),
    ).toEqual({
      ok: true,
    });
    expect(runtime.calls).toEqual([
      `copyOut ${HOLDER} /channel`,
      `copyIn ${HOLDER}`,
      `copyIn ${HOLDER} input ended, end blocks present`,
      `copyIn ${HOLDER} exit 0`,
    ]);
    expect(present(runtime.volumes.get(VOLUME), 'the lab volume').entries.get('out.txt')).toEqual(file('result\n'));
  });

  it('a write-back that would pass the space’s 1,000 entries or 256,000,000 bytes, its own included, is refused space_full, copying nothing; one that reaches a bound exactly is copied (R11)', async () => {
    const { runtime, spaces } = await ready();
    const entries = present(runtime.volumes.get(VOLUME), 'the lab volume').entries;
    entries.set('kept', { type: 'dir', owner: '1000:1000' });
    entries.set('kept/five', file('12345'));
    const write = (adds: { entries: number; bytes: number }) =>
      spaces.writeFromPlugin('lab', adds, written('w.txt', 'w'), live());
    expect(await write({ entries: 999, bytes: 1 })).toEqual({
      ok: false,
      reason: 'space_full',
      detail: 'the space would hold 1001 entries, over its bound of 1000',
    });
    expect(await write({ entries: 1, bytes: 255_999_996 })).toEqual({
      ok: false,
      reason: 'space_full',
      detail: 'the space would hold 256000001 bytes, over its bound of 256000000',
    });
    expect(runtime.copyIns).toEqual([]);
    expect(await write({ entries: 998, bytes: 255_999_995 })).toEqual({ ok: true });
    expect(runtime.copyIns).toHaveLength(1);
  });

  it.each([
    [
      'passes its bound',
      { kind: 'timeout' } satisfies DockerOutcome,
      'the copy into the space did not finish within its bound',
    ],
    [
      'exits 1',
      { kind: 'exited', code: 1, stderr: 'Error: cannot overwrite non-directory' } satisfies DockerOutcome,
      'the copy into the space failed: docker cp exited 1: Error: cannot overwrite non-directory',
    ],
  ])('a write-back whose copy %s fails, saying so', async (_label, outcome, detail) => {
    const { runtime, spaces } = await ready();
    runtime.onCopyIn = () => Promise.resolve(outcome);
    expect(await spaces.writeFromPlugin('lab', { entries: 1, bytes: 1 }, written('w.txt', 'w'), live())).toEqual({
      ok: false,
      reason: 'failed',
      detail,
    });
    expect(runtime.copyIns).toHaveLength(1);
  });

  it('a write-back whose measurement meets an entry not under channel/ fails, naming it, copying nothing', async () => {
    const { runtime, spaces } = await ready();
    runtime.copyOut = async (name, path, onChunk) => {
      runtime.calls.push(`copyOut ${name} ${path}`);
      await onChunk(
        Buffer.concat([tarDirectory('channel', 1), tarFile('etc/passwd', Buffer.from('root'), 1), Buffer.alloc(1024)]),
      );
      return { ok: true };
    };
    expect(await spaces.writeFromPlugin('lab', { entries: 1, bytes: 1 }, written('w.txt', 'w'), live())).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'measuring the space failed: etc/passwd: not under channel/',
    });
    expect([runtime.calls, runtime.copyIns]).toEqual([[`copyOut ${HOLDER} /channel`], []]);
  });

  it('a write-back answers a channel with no space, a lock busy for 60 s, and a call ended while it waits, copying nothing', async () => {
    const t = await ready();
    expect(await t.spaces.writeFromPlugin('other', { entries: 1, bytes: 1 }, written('w.txt', 'w'), live())).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'channel other has no file space',
    });
    await holdLock(t);
    const busy = t.spaces.writeFromPlugin('lab', { entries: 1, bytes: 1 }, written('w.txt', 'w'), live());
    await vi.advanceTimersByTimeAsync(59_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await busy).toEqual({ ok: false, reason: 'failed', detail: 'the space was busy for 60000 ms' });
    const call = new AbortController();
    const ended = t.spaces.writeFromPlugin('lab', { entries: 1, bytes: 1 }, written('w.txt', 'w'), call.signal);
    await vi.advanceTimersByTimeAsync(10);
    call.abort(new Error('the call passed its bound'));
    expect(await ended).toEqual({ ok: false, reason: 'failed', detail: 'the call ended before the space was free' });
    expect([t.runtime.calls, t.runtime.copyIns]).toEqual([[`copyOut ${HOLDER} /channel`], []]);
  });
});
