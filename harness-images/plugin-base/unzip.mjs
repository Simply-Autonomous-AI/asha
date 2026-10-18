// Unpacks a ZIP archive (a command plugin's release, docs/plans/extension-modules.md R28) in the plugin base image,
// which has no unzip and whose build reaches no network: `node unzip.mjs <archive.zip> <into-dir>`. Stored and
// deflated entries; each file's Unix mode (so an installer stays executable); symbolic links as links. The unpack fails,
// naming the entry, at an entry whose name is absolute or climbs out with `..`, a link whose target is absolute or
// resolves outside <into-dir>, and an entry that would be written through a link an earlier entry made — or replace
// one: nothing outside <into-dir> is written (the entries before the refused one stay written inside it).

import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** The end-of-central-directory record's offset: its signature, searched from the end past a comment of at most 64 KiB. */
function findEocd(zip, archivePath) {
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error(`${archivePath}: not a ZIP archive (no end-of-central-directory record)`);
}

/** One central directory entry at `at`: its fields, and `next`, the offset of the entry after it. */
function readCentralEntry(zip, at, archivePath, n) {
  if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`${archivePath}: central directory entry ${n} is malformed`);
  const method = zip.readUInt16LE(at + 10);
  const compressed = zip.readUInt32LE(at + 20);
  const nameLength = zip.readUInt16LE(at + 28);
  const extraLength = zip.readUInt16LE(at + 30);
  const commentLength = zip.readUInt16LE(at + 32);
  const external = zip.readUInt32LE(at + 38);
  const local = zip.readUInt32LE(at + 42);
  const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
  const next = at + 46 + nameLength + extraLength + commentLength;
  return { method, compressed, external, local, name, next };
}

/** Throws when `name` would be written outside `into`: absolute, holding `..`, or a backslash. */
function assertSafeName(archivePath, name, into) {
  if (isAbsolute(name) || normalize(name).split(sep).includes('..') || name.includes('\\'))
    throw new Error(`${archivePath}: entry "${name}" would be written outside ${into}`);
}

/** Whether `path` is `root` or under it, as resolved paths (no link followed). */
function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/**
 * Throws when writing `name` would pass through, or replace, a symbolic link already under `into` — one an earlier
 * entry made: mkdir and writeFile follow links, so a link then a file beneath it, or of its name, would write wherever
 * the link points.
 */
function assertNoLinkOnPath(archivePath, name, into) {
  let path = into;
  for (const part of normalize(name).split(sep)) {
    if (part === '' || part === '.') continue;
    path = join(path, part);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error(`${archivePath}: entry "${name}" would be written through the link "${relative(into, path)}"`);
  }
}

/** Throws when a link entry's target is absolute or resolves outside `into`. */
function assertLinkInside(archivePath, name, linkTarget, target, into) {
  if (isAbsolute(linkTarget) || !isInside(into, join(dirname(target), linkTarget)))
    throw new Error(`${archivePath}: entry "${name}" is a link to ${linkTarget}, outside ${into}`);
}

/** `raw`, decompressed by `method`: stored (0) as is, deflated (8) inflated; any other method is not read. */
function decompressEntry(method, raw, archivePath, name) {
  if (method === 0) return raw;
  if (method === 8) return inflateRawSync(raw);
  throw new Error(
    `${archivePath}: entry "${name}" uses compression method ${method}, which this unpacker does not read`,
  );
}

/** The entry's data at its local header `local`, decompressed. */
function readEntryData(zip, local, compressed, method, archivePath, name) {
  if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`${archivePath}: local header of "${name}" is malformed`);
  const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const raw = zip.subarray(dataAt, dataAt + compressed);
  return decompressEntry(method, raw, archivePath, name);
}

/**
 * Writes one file entry's content to `target`, as a symbolic link (Unix mode 0o120000) — refused when it points
 * outside `into` — or a regular file with its mode.
 */
function writeEntryFile(target, mode, content, archivePath, name, into) {
  mkdirSync(dirname(target), { recursive: true });
  if ((mode & 0o170000) === 0o120000) {
    const linkTarget = content.toString('utf8');
    assertLinkInside(archivePath, name, linkTarget, target, into);
    symlinkSync(linkTarget, target);
    return;
  }
  writeFileSync(target, content);
  if ((mode & 0o777) !== 0) chmodSync(target, mode & 0o777);
}

export function unzip(archivePath, into) {
  const zip = readFileSync(archivePath);
  const eocd = findEocd(zip, archivePath);
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (entries === 0xffff || at === 0xffffffff)
    throw new Error(`${archivePath}: a ZIP64 archive, which this unpacker does not read`);
  let written = 0;
  for (let n = 0; n < entries; n += 1) {
    const entry = readCentralEntry(zip, at, archivePath, n);
    at = entry.next;
    assertSafeName(archivePath, entry.name, into);
    assertNoLinkOnPath(archivePath, entry.name, into);
    const target = join(into, entry.name);
    const mode = (entry.external >>> 16) & 0o177777;
    if (entry.name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const content = readEntryData(zip, entry.local, entry.compressed, entry.method, archivePath, entry.name);
    writeEntryFile(target, mode, content, archivePath, entry.name, into);
    written += 1;
  }
  return written;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(sep).pop() ?? '\0')) {
  const [archivePath, into] = process.argv.slice(2);
  if (archivePath === undefined || into === undefined)
    throw new Error('usage: node unzip.mjs <archive.zip> <into-dir>');
  process.stdout.write(`unzipped ${unzip(archivePath, into)} files into ${into}\n`);
}
