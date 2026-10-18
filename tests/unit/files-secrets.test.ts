// The daemon refuses an upload holding asha's own secrets (docs/plans/portal.md R8b; A21): the file spaces with the
// fake Docker and `ownSecrets` injected — two values of 64 lowercase hex, as the control credential and the
// model-server key are — every offset and chunk size, the held-back length, the order of failures, near misses, the
// scan's time, and the model server's key known before its file is written.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ChannelFileSpaces, SecretScan, type OwnSecret } from '../../src/daemon/files/index.js';
import { LlamaCppServer, realOrphanSweep } from '../../src/daemon/model-server/index.js';
import { serializeError } from '../../src/daemon/log.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { FakeModelServer, FakeRuntime } from '../helpers/daemon-fakes.js';
import { FakeFetch, FakeLauncher, FakeRunner, RecordingLogger } from '../helpers/fakes.js';

const IMAGE = `asha-image-x:${'a'.repeat(64)}`;
const VOLUME = 'asha-abcd1234-0123abcd-lab';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
// The two fake secrets, each the sha256 of its label: 64 lowercase hex, as the real ones are, and no quoted literal
// a secret scanner's generic rule would match (docs/plans/oss-release.md R6).
const CREDENTIAL = sha(Buffer.from('the fake control credential'));
const KEY = sha(Buffer.from('the fake model-server key'));

function secrets(...values: [string, string][]): OwnSecret[] {
  return values.map(([which, value]) => ({ which, value }));
}

async function ready(own: () => readonly OwnSecret[]) {
  const runtime = new FakeRuntime();
  const logger = new RecordingLogger();
  const calls = { own: 0 };
  const spaces = new ChannelFileSpaces({
    runtime,
    logger,
    homeId: 'abcd1234',
    runId: '0123abcd',
    clock: () => new Date('2026-10-02T12:00:00.000Z'),
    ownSecrets: () => {
      calls.own += 1;
      return own();
    },
  });
  await spaces.ensure('lab', IMAGE);
  runtime.calls.length = 0;
  runtime.copyIns.length = 0;
  return { runtime, logger, spaces, calls };
}

/** An upload's body: the manifest's line, then each file's bytes in chunks of `chunk` bytes. */
function body(files: { name: string; content: Buffer; sha256?: string }[], chunk: number): AsyncIterable<Uint8Array> {
  const manifest = JSON.stringify(
    files.map((f) => ({ name: f.name, size: f.content.length, sha256: f.sha256 ?? sha(f.content) })),
  );
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield Buffer.from(`${manifest}\n`);
      for (const f of files) for (let i = 0; i < f.content.length; i += chunk) yield f.content.subarray(i, i + chunk);
    },
  };
}

/** `size` bytes of filler with `value` at `offset`. */
function holding(value: string, offset: number, size = 200): Buffer {
  const content = Buffer.alloc(size, 'x');
  content.write(value, offset, 'utf8');
  return content;
}

describe("an upload holding asha's own secrets (R8b, A21)", () => {
  it('finds the credential at every offset of a 200-byte file read in chunks of 1, 7, 63, 64, 65 and 100 bytes, and passes on no byte of it', async () => {
    const offenders: string[] = [];
    let uploads = 0;
    for (const chunk of [1, 7, 63, 64, 65, 100]) {
      const t = await ready(() => secrets(['control credential', CREDENTIAL], ['model-server key', KEY]));
      for (let offset = 0; offset + CREDENTIAL.length <= 200; offset += 1) {
        uploads += 1;
        const content = holding(CREDENTIAL, offset);
        t.runtime.copyIns.length = 0;
        t.runtime.rollbacks.length = 0;
        t.logger.entries.length = 0;
        const result = await t.spaces.upload({
          channel: 'lab',
          user: 'alice',
          body: body([{ name: 'notes.txt', content }], chunk),
        });
        const input = t.runtime.copyIns[0];
        if (input === undefined) {
          offenders.push(`chunk ${String(chunk)}, offset ${String(offset)}: no copy began (${JSON.stringify(result)})`);
          continue;
        }
        // Its tar: the folder's header, the file's header, then a prefix of the file ending before the value's first byte.
        const passed = input.bytes.subarray(1024);
        const ok =
          !result.ok &&
          result.status === 400 &&
          result.reason === 'holds_asha_secret' &&
          result.detail === "notes.txt holds asha's control credential" &&
          !input.endBlocks &&
          passed.length <= offset &&
          passed.equals(content.subarray(0, passed.length)) &&
          t.runtime.rollbacks.length === 1 &&
          t.logger.entries.filter((e) => e.event === 'files.refused').length === 1;
        if (!ok)
          offenders.push(
            `chunk ${String(chunk)}, offset ${String(offset)}: ${JSON.stringify({ ...result, drain: undefined })}, ${String(passed.length)} bytes of the file passed`,
          );
      }
      // ownSecrets is asked once per upload.
      if (t.calls.own !== 137)
        offenders.push(`chunk ${String(chunk)}: ownSecrets asked ${String(t.calls.own)} times for 137 uploads`);
    }
    expect(offenders).toEqual([]);
    expect(uploads).toBe(822);
  });

  it("refuses with the model-server key alone, its record exactly channel, reason, name and error, and rolls the upload's folder back once", async () => {
    const t = await ready(() => secrets(['control credential', CREDENTIAL], ['model-server key', KEY]));
    const result = await t.spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'k.txt', content: holding(KEY, 10) }], 64),
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      reason: 'holds_asha_secret',
      detail: "k.txt holds asha's model-server key",
    });
    expect(t.runtime.rollbacks).toEqual([
      { volume: VOLUME, image: IMAGE, folder: expect.stringMatching(/^upload-[0-9a-f]{16}$/) as string },
    ]);
    const refused = t.logger.entries.filter((e) => e.event === 'files.refused');
    expect(refused.map((e) => [e.level, Object.keys(e.fields).sort(byCodeUnit)])).toEqual([
      ['error', ['channel', 'error', 'name', 'reason']],
    ]);
    const first = present(refused[0], 'the files.refused entry');
    expect(first.fields).toMatchObject({ channel: 'lab', reason: 'holds_asha_secret', name: 'k.txt' });
    expect((first.fields['error'] as Error).message).toBe("k.txt holds asha's model-server key");
  });

  it('holds back one byte less than the longest value: a third, 100-character value split across a chunk boundary is found', async () => {
    const third = 'z'.repeat(100);
    const t = await ready(() =>
      secrets(['control credential', CREDENTIAL], ['model-server key', KEY], ['test secret', third]),
    );
    // 64-byte chunks: the value starts 30 bytes before a boundary and runs 70 past it.
    const content = holding(third, 34, 300);
    const result = await t.spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'z.txt', content }], 64),
    });
    expect(result).toMatchObject({ ok: false, reason: 'holds_asha_secret', detail: "z.txt holds asha's test secret" });
    expect(present(t.runtime.copyIns[0], 'the upload copyIn').bytes.subarray(1024).length).toBeLessThanOrEqual(34);
  });

  it('checks the model-server key from the moment the model server has made it: accepted before, refused after', async () => {
    const model = new FakeModelServer('http://127.0.0.1:1');
    const t = await ready(() => [
      { which: 'control credential', value: CREDENTIAL },
      ...(model.apiKeyMade() === undefined
        ? []
        : [{ which: 'model-server key', value: present(model.apiKeyMade(), 'the model-server key') }]),
    ]);
    const before = await t.spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'k.txt', content: holding(KEY, 5) }], 64),
    });
    model.key = KEY;
    const after = await t.spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'k.txt', content: holding(KEY, 5) }], 64),
    });
    expect([before.ok, after.ok ? 'accepted' : after.reason]).toEqual([true, 'holds_asha_secret']);
    expect(t.calls.own).toBe(2);
  });

  it('a value in the second of two files refuses at that file', async () => {
    const t = await ready(() => secrets(['control credential', CREDENTIAL]));
    const first = Buffer.from('an ordinary first file\n');
    const second = holding(CREDENTIAL, 50);
    const result = await t.spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body(
        [
          { name: 'a.txt', content: first },
          { name: 'b.txt', content: second },
        ],
        64,
      ),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'holds_asha_secret',
      detail: "b.txt holds asha's control credential",
    });
    // The first file passed whole, padded; the second's header, then no byte at or after the value.
    const tar = present(t.runtime.copyIns[0], 'the upload copyIn').bytes;
    expect(tar.subarray(1024, 1024 + first.length).equals(first)).toBe(true);
    expect(tar.length).toBeLessThanOrEqual(1024 + 512 + 512 + 50);
  });

  it('finds the credential ending at the last byte of a 25,000,000-byte file', async () => {
    const t = await ready(() => secrets(['control credential', CREDENTIAL]));
    const content = holding(CREDENTIAL, 25_000_000 - CREDENTIAL.length, 25_000_000);
    const result = await t.spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'big.bin', content }], 65_536),
    });
    expect(result).toMatchObject({ ok: false, reason: 'holds_asha_secret' });
    expect(present(t.runtime.copyIns[0], 'the upload copyIn').bytes.length - 1024).toBeLessThanOrEqual(
      25_000_000 - CREDENTIAL.length,
    );
  });

  it("accepts near misses: the credential's first 63 characters, its last 63, and the credential in upper case (the refusal does not fire)", async () => {
    const t = await ready(() => secrets(['control credential', CREDENTIAL], ['model-server key', KEY]));
    const files = [
      { name: 'head.txt', content: holding(CREDENTIAL.slice(0, 63), 20) },
      { name: 'tail.txt', content: holding(CREDENTIAL.slice(1), 20) },
      { name: 'upper.txt', content: holding(CREDENTIAL.toUpperCase(), 20) },
    ];
    const result = await t.spaces.upload({ channel: 'lab', user: 'alice', body: body(files, 7) });
    if (!result.ok) throw new Error(result.detail);
    // Passed on whole: each file's bytes in the space are exactly what was sent.
    const uploaded = present(result.answer.files[0], 'the first uploaded file');
    const folder = present(uploaded.path.split('/')[2], 'the folder segment of the uploaded path');
    const volume = present(t.runtime.volumes.get(VOLUME), 'the upload volume');
    for (const f of files) expect(volume.entries.get(`${folder}/${f.name}`)).toMatchObject({ content: f.content });
  });

  it('a file holding the credential whose manifest names another sha256 is refused holds_asha_secret: met first, before the sha256 is checked', async () => {
    const t = await ready(() => secrets(['control credential', CREDENTIAL]));
    const result = await t.spaces.upload({
      channel: 'lab',
      user: 'alice',
      body: body([{ name: 'a.txt', content: holding(CREDENTIAL, 9), sha256: 'f'.repeat(64) }], 64),
    });
    expect(result).toMatchObject({ ok: false, reason: 'holds_asha_secret' });
  });

  it('puts neither value in any logger call, any result, or any error message', async () => {
    const t = await ready(() => secrets(['control credential', CREDENTIAL], ['model-server key', KEY]));
    const results = [
      await t.spaces.upload({
        channel: 'lab',
        user: 'alice',
        body: body([{ name: 'a.txt', content: holding(CREDENTIAL, 3) }], 64),
      }),
      await t.spaces.upload({
        channel: 'lab',
        user: 'alice',
        body: body([{ name: 'b.txt', content: holding(KEY, 3) }], 64),
      }),
    ];
    const logged = JSON.stringify(
      t.logger.entries.map((e) => ({
        ...e,
        fields: Object.fromEntries(
          Object.entries(e.fields).map(([k, v]) => [k, v instanceof Error ? serializeError(v) : v]),
        ),
      })),
    );
    const answered = JSON.stringify(results.map((r) => ({ ...r, drain: undefined })));
    for (const value of [CREDENTIAL, KEY]) {
      expect(logged).not.toContain(value);
      expect(answered).not.toContain(value);
    }
  });

  it('scans 25,000,000 bytes in 64 KiB chunks in under 1,000 ms (median of 5)', () => {
    const scan = new SecretScan(secrets(['control credential', CREDENTIAL], ['model-server key', KEY]));
    const chunk = Buffer.alloc(65_536);
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = '0123456789abcdef'.charCodeAt((i * 7) % 16);
    const times: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const file = scan.file();
      const started = performance.now();
      for (let sent = 0; sent < 25_000_000; sent += chunk.length) {
        const out = file.push(sent + chunk.length > 25_000_000 ? chunk.subarray(0, 25_000_000 - sent) : chunk);
        if (typeof out === 'string') throw new Error(`the filler matched ${out}`);
      }
      file.end();
      times.push(performance.now() - started);
    }
    const median = present(times.toSorted((a, b) => a - b)[2], 'the median run time');
    expect(median).toBeLessThan(1_000);
  });
});

describe("the model server's key is known before its file is written (R8b)", () => {
  it('apiKeyMade() is already the key while the key file is being written, and undefined before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-key-'));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const written: string[] = [];
    const server = new LlamaCppServer({
      runner: new FakeRunner(),
      launcher: new FakeLauncher(),
      logger: new RecordingLogger(),
      fetch: new FakeFetch(() => new Response('{}')).fetch,
      logDir: dir,
      readyTimeoutMs: 1_000,
      keyFile: join(dir, 'model-server.key'),
      writeKeyFile: async (path, content) => {
        written.push(path);
        await held;
        await import('node:fs/promises').then((fs) => fs.writeFile(path, content, { mode: 0o600 }));
      },
      orphans: realOrphanSweep,
      now: () => Date.now(),
    });
    expect(server.apiKeyMade()).toBeUndefined();
    // Make the key as serving a model does, its file write held.
    const making = (server as unknown as { apiKey(): Promise<string> }).apiKey();
    await Promise.resolve();
    const made = server.apiKeyMade();
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    expect(written).toEqual([join(dir, 'model-server.key')]);
    release();
    expect(await making).toBe(made);
    expect(await readFile(join(dir, 'model-server.key'), 'utf8')).toBe(`${String(made)}\n`);
  });
});
