// The state store's tar reader and writer (docs/plans/agent-persistence.md R11, A9): a snapshot is read as it
// streams, only directories and regular files under the asset's root are accepted, bounds are counted as it goes,
// and what is stored is a normalised tar — owner 1000, modes 0755/0644/0755, no links, no specials — never extracted.
// Fixtures are real archives from the system tar (bsdtar), so the reader is proven against a real writer's output.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TarNormaliser,
  padOf,
  readStoredEntries,
  tarDirectory,
  tarEntryHeader,
  tarFile,
  TAR_BLOCK,
  type NormaliseResult,
} from '../../src/daemon/state/tar.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asha-tar-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

/** `root` and everything under it, depth first, each directory's entries sorted: the order the archive is written in. */
function walkSorted(dir: string, path: string): string[] {
  const full = join(dir, path);
  if (!lstatSync(full).isDirectory()) return [path];
  return [
    path,
    ...readdirSync(full)
      .sort(byCodeUnit)
      .flatMap((name) => walkSorted(dir, `${path}/${name}`)),
  ];
}

/** The system tar's archive of `root` under `dir`, in the given format, its entries in walkSorted's order (-n: listed, not recursed). */
function systemTar(dir: string, root: string, format: 'ustar' | 'pax' | 'gnutar' = 'ustar'): Buffer {
  return execFileSync('tar', [
    '--no-mac-metadata',
    '--no-xattrs',
    '--no-acls',
    `--format=${format}`,
    '-n',
    '-cf',
    '-',
    '-C',
    dir,
    ...walkSorted(dir, root),
  ]);
}

/** Feeds `archive` to a normaliser in chunks of `chunk` bytes; returns the result and the normalised bytes. */
async function normalise(
  archive: Buffer,
  root: string,
  bounds = { maxFiles: 100, maxBytes: 1 << 20, maxEntries: 200 },
  chunk = 777,
): Promise<{ result: NormaliseResult; out: Buffer; fed: number }> {
  const parts: Buffer[] = [];
  const n = new TarNormaliser({
    root,
    ...bounds,
    write: (b) => {
      parts.push(Buffer.from(b));
      return Promise.resolve();
    },
  });
  let fed = 0;
  for (let i = 0; i < archive.length; i += chunk) {
    fed += 1;
    const failure = await n.push(archive.subarray(i, i + chunk));
    if (failure !== undefined) return { result: failure, out: Buffer.concat(parts), fed };
  }
  // finish() is synchronous (NormaliseResult, not a Promise): no await needed.
  return { result: n.finish(), out: Buffer.concat(parts), fed };
}

/** Parses the headers of a normalised tar: name, type, uid, gid, mode, size, uname. */
function headers(tar: Buffer): { name: string; type: string; uid: number; gid: number; mode: number; size: number }[] {
  const out = [];
  for (let at = 0; at + TAR_BLOCK <= tar.length;) {
    const h = tar.subarray(at, at + TAR_BLOCK);
    if (h.every((b) => b === 0)) break;
    const field = (o: number, l: number) =>
      h
        .subarray(o, o + l)
        .toString('utf8')
        // No trailing `$`: dotAll's `.*` already matches to the string's end greedily, so the anchor added nothing
        // (verified byte-for-byte); dropping it removes the one way this could ever retry a start position
        // (sonarjs/super-linear-regex).
        .replace(/\0.*/s, '');
    const octal = (o: number, l: number) => parseInt(field(o, l).trim() || '0', 8);
    const prefix = field(345, 155);
    const name = (prefix === '' ? '' : `${prefix}/`) + field(0, 100);
    const size = octal(124, 12);
    out.push({ name, type: field(156, 1), uid: octal(108, 8), gid: octal(116, 8), mode: octal(100, 8), size });
    at += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return out;
}

describe('TarNormaliser: what a snapshot may hold', () => {
  it('accepts directories and regular files under the root, normalising owner and modes, and keeps every byte', async () => {
    const dir = await tree({ 'memory/u1/facts.json': '{"a":1}\n', 'memory/u2/session.json': 'x'.repeat(1500) });
    await chmod(join(dir, 'memory/u1/facts.json'), 0o4755); // setuid and exec: normalised to 0755, the setuid bit gone
    const { result, out } = await normalise(systemTar(dir, 'memory'), 'memory');
    expect(result).toEqual({
      ok: true,
      files: 2,
      bytes: 8 + 1500,
      entries: [
        { name: 'memory', type: 'directory' },
        { name: 'memory/u1', type: 'directory' },
        { name: 'memory/u1/facts.json', type: 'file', size: 8, sha256: sha('{"a":1}\n') },
        { name: 'memory/u2', type: 'directory' },
        { name: 'memory/u2/session.json', type: 'file', size: 1500, sha256: sha('x'.repeat(1500)) },
      ],
    });
    const h = headers(out);
    expect(h.map((e) => [e.name, e.type, e.uid, e.gid, e.mode.toString(8), e.size])).toEqual([
      ['memory/', '5', 1000, 1000, '755', 0],
      ['memory/u1/', '5', 1000, 1000, '755', 0],
      ['memory/u1/facts.json', '0', 1000, 1000, '755', 8],
      ['memory/u2/', '5', 1000, 1000, '755', 0],
      ['memory/u2/session.json', '0', 1000, 1000, '644', 1500],
    ]);
    // The output is itself a tar the system tar reads, with the same bytes.
    const back = await mkdtemp(join(tmpdir(), 'asha-tar-back-'));
    execFileSync('tar', ['-xf', '-', '-C', back], { input: out });
    expect(await readFile(join(back, 'memory/u2/session.json'), 'utf8')).toBe('x'.repeat(1500));
    expect(out.length % TAR_BLOCK).toBe(0);
    // It ends with the two zero blocks of an archive's end.
    expect(out.subarray(-2 * TAR_BLOCK).every((b) => b === 0)).toBe(true);
  });

  it('reads the same archive the same way whatever the chunking: one byte at a time and all at once', async () => {
    const dir = await tree({ 'workspace/a.md': 'hello', 'workspace/d/b.md': 'b'.repeat(513) });
    const archive = systemTar(dir, 'workspace');
    const one = await normalise(archive, 'workspace', undefined, 1);
    const all = await normalise(archive, 'workspace', undefined, archive.length);
    expect(one.result).toEqual(all.result);
    expect(one.out.equals(all.out)).toBe(true);
    expect(one.result.ok).toBe(true);
  });

  it('reads pax and GNU long names, and writes a long name with a ustar prefix, never truncated', async () => {
    const long = `workspace/${'d'.repeat(60)}/${'e'.repeat(60)}/file.md`;
    const dir = await tree({ [long]: 'deep' });
    for (const format of ['pax', 'gnutar'] as const) {
      const { result, out } = await normalise(systemTar(dir, 'workspace', format), 'workspace');
      expect(result.ok, format).toBe(true);
      if (!result.ok) continue;
      expect(result.entries.at(-1)).toEqual({ name: long, type: 'file', size: 4, sha256: sha('deep') });
      expect(present(headers(out).at(-1), 'headers(out).at(-1)').name).toBe(long);
      // The ustar name field holds at most 100 bytes: this one is split into prefix and name.
      expect(Buffer.byteLength(long)).toBeGreaterThan(100);
    }
  });

  it('refuses a name no ustar header can hold (a last part over 100 bytes) as invalid_entry, never truncating it', async () => {
    const long = `workspace/${'f'.repeat(120)}.md`;
    const dir = await tree({ [long]: 'x' });
    const { result } = await normalise(systemTar(dir, 'workspace', 'pax'), 'workspace');
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: long,
      detail: 'the name cannot be held by a ustar header (at most 155 bytes of directories and 100 of name)',
    });
  });

  it.each([
    [
      'a symbolic link',
      async (d: string) => symlink('a.json', join(d, 'memory', 'link')),
      'memory/link',
      'a symbolic link',
    ],
    [
      'a hard link',
      async (d: string) => link(join(d, 'memory', 'a.json'), join(d, 'memory', 'hard')),
      'memory/hard',
      'a hard link',
    ],
    [
      'a FIFO',
      (d: string) => {
        execFileSync('mkfifo', [join(d, 'memory', 'fifo')]);
        return Promise.resolve();
      },
      'memory/fifo',
      'a FIFO',
    ],
  ])('refuses %s as invalid_entry, naming it', async (_what, plant, name, kind) => {
    const dir = await tree({ 'memory/a.json': '{}' });
    await plant(dir);
    const { result } = await normalise(systemTar(dir, 'memory'), 'memory');
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: name,
      detail: `${kind} is not a directory or a regular file`,
    });
  });

  it('refuses a device, a .. component, an absolute name and an entry outside the root, each naming it', async () => {
    const make = (name: string, type: string): Buffer =>
      Buffer.concat([tarHeaderForTest(name, type, 0), Buffer.alloc(2 * TAR_BLOCK)]);
    expect((await normalise(make('memory/dev', '3'), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: 'memory/dev',
      detail: 'a character device is not a directory or a regular file',
    });
    expect((await normalise(make('memory/blk', '4'), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: 'memory/blk',
      detail: 'a block device is not a directory or a regular file',
    });
    expect((await normalise(make('memory/../etc/passwd', '0'), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: 'memory/../etc/passwd',
      detail: 'the name has a "..", "." or empty part',
    });
    expect((await normalise(make('/memory/x', '0'), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: '/memory/x',
      detail: 'the name is absolute',
    });
    expect((await normalise(make('workspace/x', '0'), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: 'workspace/x',
      detail: 'the name is not under memory/',
    });
    expect((await normalise(make('memoryx/y', '0'), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: 'memoryx/y',
      detail: 'the name is not under memory/',
    });
  });

  it('refuses a header whose checksum does not match, as invalid_entry', async () => {
    const h = tarHeaderForTest('memory/x', '0', 0);
    h[0] = 'n'.charCodeAt(0); // changed after its checksum was computed
    expect((await normalise(Buffer.concat([h, Buffer.alloc(2 * TAR_BLOCK)]), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: 'nemory/x',
      detail: 'its header checksum does not match',
    });
  });

  it('refuses an archive that ends inside an entry or before its end marker', async () => {
    const dir = await tree({ 'memory/a.json': 'x'.repeat(2000) });
    const archive = systemTar(dir, 'memory');
    // memory/ (1 block), a.json's header (1) and its 2,000 bytes (4 blocks), then the end marker.
    expect((await normalise(archive.subarray(0, 3 * TAR_BLOCK), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: 'memory/a.json',
      detail: 'the archive ends inside this entry',
    });
    expect((await normalise(archive.subarray(0, 6 * TAR_BLOCK), 'memory')).result).toEqual({
      ok: false,
      reason: 'invalid_entry',
      entry: "(the archive's end)",
      detail: 'the archive ends before its end marker',
    });
  });

  it('stops at the first entry over a bound, reading no further: over_bound for bytes, and for files', async () => {
    const dir = await tree({ 'memory/a': 'x'.repeat(600), 'memory/b': 'y'.repeat(600), 'memory/c': 'z' });
    const archive = systemTar(dir, 'memory');
    const bytes = await normalise(archive, 'memory', { maxFiles: 10, maxBytes: 1000, maxEntries: 10 }, TAR_BLOCK);
    expect(bytes.result).toEqual({
      ok: false,
      reason: 'over_bound',
      entry: 'memory/b',
      detail: 'memory is over its bound of 1000 bytes',
    });
    // Stopped at b's header, the fifth block (memory/, a's header, a's two blocks, b's header): none of b's data was fed.
    expect(bytes.fed).toBe(5);
    const files = await normalise(archive, 'memory', { maxFiles: 2, maxBytes: 10_000, maxEntries: 10 });
    expect(files.result).toEqual({
      ok: false,
      reason: 'over_bound',
      entry: 'memory/c',
      detail: 'memory is over its bound of 2 files',
    });
    // At the bounds exactly: accepted.
    expect((await normalise(archive, 'memory', { maxFiles: 3, maxBytes: 1201, maxEntries: 3 })).result.ok).toBe(true);
  });

  it('counts every entry but the root against maxEntries, directories included: a directory-only snapshot over it fails over_bound at the entry over it (R6; R1-SECURITY-003)', async () => {
    const archive = Buffer.concat([
      tarDirectory('memory', 0),
      ...['d1', 'd2', 'd3', 'd4', 'd5'].map((d) => tarDirectory(`memory/${d}`, 0)),
      Buffer.alloc(2 * TAR_BLOCK),
    ]);
    const over = await normalise(archive, 'memory', { maxFiles: 10, maxBytes: 1000, maxEntries: 3 }, TAR_BLOCK);
    expect(over.result).toEqual({
      ok: false,
      reason: 'over_bound',
      entry: 'memory/d4',
      detail: 'memory is over its bound of 3 entries',
    });
    // Stopped at d4's header, the fifth block: nothing after it was written (the root and d1–d3 only).
    expect([over.fed, over.out.length]).toEqual([5, 4 * TAR_BLOCK]);
    // A file counts too: two directories and a file over a bound of 2 fail at the file.
    const mixed = Buffer.concat([
      tarDirectory('memory', 0),
      tarDirectory('memory/a', 0),
      tarDirectory('memory/b', 0),
      tarFile('memory/b/f.json', Buffer.from('x'), 0),
      Buffer.alloc(2 * TAR_BLOCK),
    ]);
    expect((await normalise(mixed, 'memory', { maxFiles: 10, maxBytes: 1000, maxEntries: 2 })).result).toEqual({
      ok: false,
      reason: 'over_bound',
      entry: 'memory/b/f.json',
      detail: 'memory is over its bound of 2 entries',
    });
    // At the bound exactly, the root not counted: accepted.
    expect((await normalise(mixed, 'memory', { maxFiles: 10, maxBytes: 1000, maxEntries: 3 })).result.ok).toBe(true);
  });
});

describe('tar writing and reading back', () => {
  it('tarFile and tarDirectory write entries owned by 1000 that readStoredEntries lists with their sha256', async () => {
    const out = Buffer.concat([
      tarDirectory('workspace/docs', 0),
      tarFile('workspace/docs/a.md', Buffer.from('abc'), 0),
      Buffer.alloc(2 * TAR_BLOCK),
    ]);
    expect(headers(out).map((e) => [e.name, e.type, e.uid, e.gid, e.mode.toString(8)])).toEqual([
      ['workspace/docs/', '5', 1000, 1000, '755'],
      ['workspace/docs/a.md', '0', 1000, 1000, '644'],
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'asha-tar-stored-'));
    await writeFile(join(dir, 'w.tar'), out);
    expect(await readStoredEntries(join(dir, 'w.tar'), 'workspace')).toEqual([
      { name: 'workspace/docs', type: 'directory' },
      { name: 'workspace/docs/a.md', type: 'file', size: 3, sha256: sha('abc') },
    ]);
  });
});

/** A bare ustar header, its checksum computed — for entry types the system tar cannot be made to write here (devices). */
function tarHeaderForTest(name: string, type: string, size: number): Buffer {
  const h = Buffer.alloc(TAR_BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0001750\0', 108, 8, 'ascii');
  h.write('0001750\0', 116, 8, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

describe('long names and skipped entries (docs/plans/agent-files.md R3a, R15)', () => {
  it("with longNames 'pax', a name no ustar header holds is written with a pax header, and the system tar reads it back whole", async () => {
    const long = `channel/upload-0123456789abcdef/${'é'.repeat(127)}`;
    const dir = await tree({ [long]: 'attached' });
    const parts: Buffer[] = [];
    const n = new TarNormaliser({
      root: 'channel',
      maxFiles: 10,
      maxBytes: 1 << 20,
      maxEntries: 10,
      write: (b) => {
        parts.push(Buffer.from(b));
        return Promise.resolve();
      },
      longNames: 'pax',
    });
    expect(await n.push(systemTar(dir, 'channel', 'pax'))).toBeUndefined();
    // finish() is synchronous (NormaliseResult, not a Promise): no await needed.
    const result = n.finish();
    expect(result.ok && result.entries.at(-1)).toEqual({ name: long, type: 'file', size: 8, sha256: sha('attached') });
    const back = await mkdtemp(join(tmpdir(), 'asha-tar-back-'));
    execFileSync('tar', ['-xf', '-', '-C', back], { input: Buffer.concat(parts) });
    expect(await readFile(join(back, long), 'utf8')).toBe('attached');
    // And it reads back through the normaliser itself, as a restore's check does.
    const again = new TarNormaliser({
      root: 'channel',
      maxFiles: 10,
      maxBytes: 1 << 20,
      maxEntries: 10,
      write: () => Promise.resolve(),
      longNames: 'pax',
    });
    await again.push(Buffer.concat(parts));
    const reread = again.finish();
    expect(reread.ok && reread.entries.map((e) => e.name)).toEqual([
      'channel',
      'channel/upload-0123456789abcdef',
      long,
    ]);
  });

  it('tarEntryHeader writes a 255-byte name in an upload folder that the system tar extracts whole', async () => {
    const name = `channel/upload-0123456789abcdef/${'n'.repeat(250)}.txt`;
    const archive = Buffer.concat([
      tarEntryHeader('channel/upload-0123456789abcdef', 'directory', 0, 0),
      tarEntryHeader(name, 'file', 3, 0),
      Buffer.from('abc'),
      Buffer.alloc(padOf(3)),
      Buffer.alloc(1024),
    ]);
    const back = await mkdtemp(join(tmpdir(), 'asha-tar-back-'));
    execFileSync('tar', ['-xf', '-', '-C', back], { input: archive });
    expect(await readFile(join(back, name), 'utf8')).toBe('abc');
  });

  it('skip leaves the entries it names out of the normalised tar and out of the counts', async () => {
    const dir = await tree({
      'channel/keep.txt': 'k',
      'channel/upload-aaaaaaaaaaaaaaaa/drop.txt': 'drop',
      'channel/upload-bbbbbbbbbbbbbbbb/keep2.txt': 'k2',
    });
    const parts: Buffer[] = [];
    const skip = (name: string) =>
      name === 'channel/upload-aaaaaaaaaaaaaaaa' || name.startsWith('channel/upload-aaaaaaaaaaaaaaaa/');
    const n = new TarNormaliser({
      root: 'channel',
      maxFiles: 2,
      maxBytes: 3,
      maxEntries: 4,
      write: (b) => {
        parts.push(Buffer.from(b));
        return Promise.resolve();
      },
      skip,
    });
    expect(await n.push(systemTar(dir, 'channel'))).toBeUndefined();
    // finish() is synchronous (NormaliseResult, not a Promise): no await needed.
    const result = n.finish();
    expect(result).toEqual({
      ok: true,
      files: 2,
      bytes: 3,
      entries: [
        { name: 'channel', type: 'directory' },
        { name: 'channel/keep.txt', type: 'file', size: 1, sha256: sha('k') },
        { name: 'channel/upload-bbbbbbbbbbbbbbbb', type: 'directory' },
        { name: 'channel/upload-bbbbbbbbbbbbbbbb/keep2.txt', type: 'file', size: 2, sha256: sha('k2') },
      ],
    });
    expect(
      headers(Buffer.concat(parts))
        .map((h) => h.name)
        .join(' '),
    ).not.toContain('upload-aaaa');
  });
});
