import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { CatalogueEntry, CatalogueFile } from '../../src/daemon/definitions/index.js';
import {
  HuggingFaceModelStore,
  ModelDigestMismatch,
  ModelFetchFailed,
  treeDigest,
} from '../../src/daemon/model-store/index.js';
import { LockHeld } from '../../src/daemon/process/pid-lock.js';
import { present } from '../../src/shared/assert-present.js';
import { FakeFetch, RecordingLogger } from '../helpers/fakes.js';

const BASE = 'https://hf.example';
const REVISION = '23749fefcc72300e3a2ad315e1317431b06b590a';
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

const WEIGHTS = new TextEncoder().encode('GGUF fake weights \u0000\u0001\u0002 payload');
const CONFIG = new TextEncoder().encode('{"nested":true}\n');
const CONTENT: Readonly<Record<string, Uint8Array>> = { 'model.gguf': WEIGHTS, 'sub/x.json': CONFIG };

const fileOf = (path: string, data: Uint8Array): CatalogueFile => ({
  path,
  size: data.byteLength,
  sha256: sha256(data),
});

function entryWith(files: readonly CatalogueFile[]): CatalogueEntry {
  return {
    kind: 'chat',
    id: 'demo-model',
    repo: 'Org/Demo-GGUF',
    revision: REVISION,
    weights: 'model.gguf',
    files,
    license: { id: 'apache-2.0', source: 'https://example/LICENSE', verified: '2026-09-26' },
    serve: { contextSize: 2048 },
    chat: {},
    toolCallStart: '<tool_call>\n',
  };
}

const ENTRY = entryWith([fileOf('model.gguf', WEIGHTS), fileOf('sub/x.json', CONFIG)]);
const urlOf = (path: string) => `${BASE}/Org/Demo-GGUF/resolve/${REVISION}/${path}`;

/** Serves CONTENT by URL, the way the Hub's resolve endpoint does. */
const serveContent = (url: string): Response => {
  const path = url.slice(urlOf('').length);
  const data = CONTENT[path];
  return data === undefined ? new Response('not found', { status: 404 }) : new Response(data);
};

describe('treeDigest', () => {
  const a = { path: 'a.gguf', size: 1, sha256: 'a'.repeat(64) };
  const b = { path: 'b/c.json', size: 2, sha256: 'b'.repeat(64) };

  it('is sha256 over the path-sorted `path\\0sha256\\n` lines', () => {
    const expected = sha256(`a.gguf\0${'a'.repeat(64)}\nb/c.json\0${'b'.repeat(64)}\n`);
    expect(treeDigest([a, b])).toBe(expected);
    expect(treeDigest([a, b])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order files are listed in', () => {
    expect(treeDigest([b, a])).toBe(treeDigest([a, b]));
  });

  it('changes when any file sha256 or path changes', () => {
    const base = treeDigest([a, b]);
    expect(treeDigest([{ ...a, sha256: `${'a'.repeat(63)}0` }, b])).not.toBe(base);
    expect(treeDigest([a, { ...b, sha256: `0${'b'.repeat(63)}` }])).not.toBe(base);
    expect(treeDigest([{ ...a, path: 'a2.gguf' }, b])).not.toBe(base);
  });
});

describe('HuggingFaceModelStore.ensure', () => {
  let modelsDir: string;
  let logger: RecordingLogger;
  let aliveAsked: number[];

  beforeEach(async () => {
    modelsDir = join(await mkdtemp(join(tmpdir(), 'asha-models-')), 'models');
    logger = new RecordingLogger();
    aliveAsked = [];
  });

  function store(fake: FakeFetch, overrides: { stallTimeoutMs?: number; alive?: boolean } = {}) {
    return new HuggingFaceModelStore({
      modelsDir,
      baseUrl: BASE,
      fetch: fake.fetch,
      logger,
      stallTimeoutMs: overrides.stallTimeoutMs ?? 5_000,
      pid: 4242,
      isAlive: (pid) => {
        aliveAsked.push(pid);
        return overrides.alive ?? false;
      },
    });
  }

  const finalDir = (entry: CatalogueEntry = ENTRY) => join(modelsDir, `sha256-${treeDigest(entry.files)}`);

  it('returns a cached directory without fetching anything', async () => {
    await mkdir(finalDir(), { recursive: true });
    const fake = new FakeFetch(serveContent);

    const result = await store(fake).ensure(ENTRY);

    expect(result).toEqual({ dir: finalDir(), weightsPath: join(finalDir(), 'model.gguf'), status: 'cached' });
    expect(fake.requests).toEqual([]);
    expect(logger.entries).toEqual([
      { level: 'info', event: 'model.cache_hit', fields: { model: 'demo-model', dir: finalDir() } },
    ]);
  });

  it('downloads every file from its pinned URL into sha256-<tree digest>/<path>', async () => {
    const fake = new FakeFetch(serveContent);

    const result = await store(fake).ensure(ENTRY);

    expect(result).toEqual({ dir: finalDir(), weightsPath: join(finalDir(), 'model.gguf'), status: 'downloaded' });
    expect(fake.requests.map((r) => r.url)).toEqual([urlOf('model.gguf'), urlOf('sub/x.json')]);
    expect(fake.requests.map((r) => r.init?.redirect)).toEqual(['follow', 'follow']);
    expect(fake.requests.every((r) => r.init?.signal instanceof AbortSignal)).toBe(true);
    expect(new Uint8Array(await readFile(join(finalDir(), 'model.gguf')))).toEqual(WEIGHTS);
    expect(new Uint8Array(await readFile(join(finalDir(), 'sub', 'x.json')))).toEqual(CONFIG);
    // Promoted, staging gone, lock released: only the final directory remains.
    expect(await readdir(modelsDir)).toEqual([`sha256-${treeDigest(ENTRY.files)}`]);
    expect(logger.entries).toEqual([
      {
        level: 'info',
        event: 'model.file_downloading',
        fields: { model: 'demo-model', path: 'model.gguf', size: WEIGHTS.byteLength },
      },
      {
        level: 'info',
        event: 'model.file_downloading',
        fields: { model: 'demo-model', path: 'sub/x.json', size: CONFIG.byteLength },
      },
      { level: 'info', event: 'model.downloaded', fields: { model: 'demo-model', dir: finalDir() } },
    ]);
    expect(aliveAsked).toEqual([]);
  });

  it('then serves the second ensure from the cache with no further fetches', async () => {
    const fake = new FakeFetch(serveContent);
    const s = store(fake);
    await s.ensure(ENTRY);
    await expect(s.ensure(ENTRY)).resolves.toEqual({
      dir: finalDir(),
      weightsPath: join(finalDir(), 'model.gguf'),
      status: 'cached',
    });
    expect(fake.requests).toHaveLength(2);
  });

  it('throws ModelDigestMismatch on a wrong sha256 and leaves no final dir, staging dir or lock', async () => {
    const wrong = 'f'.repeat(64);
    const entry = entryWith([fileOf('model.gguf', WEIGHTS), { ...fileOf('sub/x.json', CONFIG), sha256: wrong }]);
    const fake = new FakeFetch(serveContent);

    const error = await store(fake)
      .ensure(entry)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelDigestMismatch);
    expect(error).toMatchObject({ path: 'sub/x.json', expected: wrong, actual: sha256(CONFIG) });
    expect((error as Error).message).toBe(`sub/x.json: sha256 ${sha256(CONFIG)} does not match the pinned ${wrong}`);
    expect(await readdir(modelsDir)).toEqual([]);
    expect(fake.requests).toHaveLength(2);
    expect(logger.events()).not.toContain('model.downloaded');
  });

  it('throws ModelFetchFailed size_mismatch when the byte count differs from the pin', async () => {
    const entry = entryWith([{ ...fileOf('model.gguf', WEIGHTS), size: WEIGHTS.byteLength + 1 }]);
    const fake = new FakeFetch(serveContent);

    const error = await store(fake)
      .ensure(entry)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelFetchFailed);
    expect(error).toMatchObject({ reason: 'size_mismatch', url: urlOf('model.gguf') });
    expect((error as Error).message).toBe(
      `downloading ${urlOf('model.gguf')} failed (size_mismatch): received ${String(WEIGHTS.byteLength)} bytes, pinned size is ${String(WEIGHTS.byteLength + 1)}`,
    );
    expect(await readdir(modelsDir)).toEqual([]);
  });

  it('throws ModelFetchFailed http_status on a 404', async () => {
    const fake = new FakeFetch(() => new Response('Entry not found', { status: 404 }));

    const error = await store(fake)
      .ensure(ENTRY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelFetchFailed);
    expect(error).toMatchObject({ reason: 'http_status', url: urlOf('model.gguf') });
    expect((error as Error).message).toBe(`downloading ${urlOf('model.gguf')} failed (http_status): HTTP 404`);
    expect(fake.requests).toHaveLength(1);
    expect(await readdir(modelsDir)).toEqual([]);
  });

  it('throws ModelFetchFailed network when the connection fails', async () => {
    const cause = new TypeError('fetch failed');
    const fake = new FakeFetch(() => Promise.reject(cause));

    const error = await store(fake)
      .ensure(ENTRY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelFetchFailed);
    expect(error).toMatchObject({ reason: 'network' });
    expect((error as Error).cause).toBe(cause);
    expect(await readdir(modelsDir)).toEqual([]);
  });

  it('throws ModelFetchFailed stalled when the body stops delivering bytes', async () => {
    const first = new Uint8Array([1, 2, 3, 4, 5]);
    // One chunk, then silence. Aborting the request errors the body, as the real fetch does.
    const fake = new FakeFetch((_url, init) => {
      const signal = present(present(init, 'fetch init').signal, 'abort signal');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          signal.addEventListener(
            'abort',
            () => {
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      });
      return new Response(body);
    });
    const started = Date.now();

    const error = await store(fake, { stallTimeoutMs: 50 })
      .ensure(ENTRY)
      .catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(ModelFetchFailed);
    expect(error).toMatchObject({ reason: 'stalled', url: urlOf('model.gguf') });
    expect((error as Error).message).toBe(
      `downloading ${urlOf('model.gguf')} failed (stalled): no bytes for 50 ms after 5 bytes`,
    );
    expect(fake.requests).toHaveLength(1);
    expect(await readdir(modelsDir)).toEqual([]);
  });

  it('refuses with LockHeld, fetching nothing, while a live process holds the cache lock', async () => {
    await mkdir(modelsDir, { recursive: true });
    await writeFile(join(modelsDir, '.lock'), '999');
    const fake = new FakeFetch(serveContent);

    const error = await store(fake, { alive: true })
      .ensure(ENTRY)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LockHeld);
    expect((error as LockHeld).holderPid).toBe(999);
    expect(aliveAsked).toEqual([999]);
    expect(fake.requests).toEqual([]);
    expect(await readFile(join(modelsDir, '.lock'), 'utf8')).toBe('999');
    expect(await readdir(modelsDir)).toEqual(['.lock']);
  });
});
