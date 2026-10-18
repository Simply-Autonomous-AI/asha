// Attaching the user's files to a message (docs/plans/agent-files.md R1, R2, R13): which words of an interactive
// line name a file to attach, and how the CLI reads a file it attaches. The daemon never opens a host path a user
// names (R3): the CLI reads the bytes and sends them.

import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { present } from '../shared/assert-present.js';
import { deniedBy } from '../shared/credentials.js';
import { MAX_ATTACHMENT_BYTES, MAX_FILES_PER_MESSAGE, fileNameProblem } from '../shared/files.js';

/** Characters rule 4 tries off the end of a word, and off its start. */
const TRAILING = `.,;:!?)]}'"`;
const LEADING = `([{'"`;

/**
 * Splits an interactive line into words by R1's tokenizer, and nothing else (rules 1–3): words are separated by
 * unescaped spaces and tabs; a backslash makes the next character literal and is removed (one at the end of the line
 * is literal); a single or double quote is a quote only when it begins a word and a matching quote later ends a word
 * — followed by a space, a tab, the end of the line, or a character of rule 4's trailing set — and the quoted
 * characters are then literal, spaces included, the quotes removed. Any other quote is a literal character.
 */
export function lineWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  const end = (): void => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  // A while loop, its index advanced explicitly on every path (never a for loop's own counter, reassigned in the
  // body too): a quote's close and an escape both jump the index by more than one character.
  let i = 0;
  while (i < line.length) {
    const c = present(line[i], 'a character within bounds');
    if (c === ' ' || c === '\t') {
      end();
      i += 1;
      continue;
    }
    if (c === '\\') {
      started = true;
      if (i + 1 < line.length) {
        word += present(line[i + 1], 'a character within bounds');
        i += 2;
      } else {
        word += c;
        i += 1;
      }
      continue;
    }
    if ((c === "'" || c === '"') && !started) {
      const close = closingQuote(line, i);
      if (close !== undefined) {
        started = true;
        word += line.slice(i + 1, close);
        i = close + 1;
        continue;
      }
    }
    started = true;
    word += c;
    i += 1;
  }
  end();
  return words;
}

/** Where the quote opening at `at` closes: the first matching quote followed by a word's end; undefined if none. */
function closingQuote(line: string, at: number): number | undefined {
  const quote = present(line[at], 'a character within bounds');
  for (let j = at + 1; j < line.length; j += 1) {
    if (line[j] !== quote) continue;
    const next = line[j + 1];
    if (next === undefined || next === ' ' || next === '\t' || TRAILING.includes(next)) return j;
  }
  return undefined;
}

/** Rule 6: a word is a candidate only if it contains `/` or starts with `~/` (judged before rule 4's trimming). */
export function isCandidate(word: string): boolean {
  return word.includes('/') || word.startsWith('~/');
}

/** The forms rule 4 tries, in order: the word as it is, then with its trailing and leading characters removed. */
export function triedForms(word: string): string[] {
  let trimmed = word;
  while (trimmed !== '' && TRAILING.includes(present(trimmed.at(-1), 'a character of a non-empty string')))
    trimmed = trimmed.slice(0, -1);
  while (trimmed !== '' && LEADING.includes(present(trimmed[0], 'a character of a non-empty string')))
    trimmed = trimmed.slice(1);
  return trimmed === word || trimmed === '' ? [word] : [word, trimmed];
}

/** Rule 5: a leading `~/` is the user's home folder; `~user`, `$VAR` and glob characters stay literal. */
export function expandHome(path: string, home: string): string {
  return path.startsWith('~/') ? `${home}/${path.slice(2)}` : path;
}

/** Where the CLI runs, for relative paths and `~/`, and the home whose files are refused (R2). */
export interface PathContext {
  readonly cwd: string;
  readonly home: string;
  readonly ashaHome: string;
}

/** What one word of a line names (rules 4–7). */
type NamedFile =
  /** Not a candidate, or naming nothing or a directory: the word stays text, and nothing is said. */
  | { readonly kind: 'text' }
  /** An existing file that is not a regular file: stays text, and `⚠ not attached` says why (R2). */
  | { readonly kind: 'other'; readonly shown: string; readonly rule: string }
  /** A regular file: attached once it reads as attachable (R2). `shown` is the word as tried. */
  | { readonly kind: 'file'; readonly shown: string; readonly path: string };

/** What a candidate word names, trying rule 4's forms in order. */
async function namedFile(word: string, context: PathContext): Promise<NamedFile> {
  if (!isCandidate(word)) return { kind: 'text' };
  for (const tried of triedForms(word)) {
    const path = resolve(context.cwd, expandHome(tried, context.home));
    let stats: Stats;
    try {
      stats = await stat(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG' || code === 'ELOOP') continue;
      if (code === 'EACCES' || code === 'EPERM')
        return { kind: 'other', shown: tried, rule: `cannot be read (${code})` };
      throw error;
    }
    if (stats.isDirectory()) continue;
    if (!stats.isFile()) return { kind: 'other', shown: tried, rule: 'not a regular file' };
    return { kind: 'file', shown: tried, path };
  }
  return { kind: 'text' };
}

/** A file read as R2 says, held open by its descriptor until it is sent. */
export interface OpenAttachment {
  /** What the user named it as, for every line printed about it. */
  readonly shown: string;
  /** Its resolved path: a file attaches once however many words name it. */
  readonly resolved: string;
  /** Its base name, NFC (R13). */
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  /** Its bytes from offset 0, through the same descriptor that was hashed. */
  bytes(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

export type AttachmentRead =
  { readonly ok: true; readonly file: OpenAttachment } | { readonly ok: false; readonly rule: string };

const CHUNK = 1 << 20;

/**
 * Reads a file to attach by R2's sequence: resolve it (every link); check the resolved path against the credential
 * deny list; open it read-only with O_NONBLOCK (a FIFO never blocks); fstat the descriptor — a regular file with the
 * resolved path's device and inode, and a link count of 1; hash at most 25,000,001 bytes read from it. The same
 * descriptor then sends its bytes from offset 0 (`bytes`), so no file is held in memory whole; the daemon's sha256
 * check refuses a file that changed in between. A refusal is `{ok: false, rule}`, the descriptor closed.
 */
/** The ashaHome real path, or its path as given when it is not made yet: nothing to protect, but still refused by name. */
async function resolveAshaHome(ashaHome: string): Promise<string> {
  try {
    return await realpath(ashaHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(ashaHome);
  }
}

/**
 * Hashes up to `limit + 1` bytes of `handle` from offset 0, chunked: the sha256 and the bytes actually read, which
 * exceeds `limit` only enough to signal the file is too large, without hashing the rest of it.
 */
async function hashUpTo(
  handle: FileHandle,
  limit: number,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(CHUNK);
  let size = 0;
  for (;;) {
    const want = Math.min(CHUNK, limit + 1 - size);
    if (want === 0) break;
    const { bytesRead } = await handle.read(buffer, 0, want, size);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    size += bytesRead;
  }
  return { size, sha256: hash.digest('hex') };
}

export async function readAttachment(path: string, shown: string, context: PathContext): Promise<AttachmentRead> {
  const name = basename(path).normalize('NFC');
  const nameProblem = fileNameProblem(name, { returned: false });
  if (nameProblem !== undefined) return { ok: false, rule: nameProblem };
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    return { ok: false, rule: refusalOf(error) };
  }
  // A home not made yet holds nothing to protect; its path as given is still refused.
  const ashaHome = await resolveAshaHome(context.ashaHome);
  const denied = deniedBy(resolved, { ashaHome });
  if (denied !== undefined) return { ok: false, rule: `on the credential deny list (${denied})` };
  let named: Stats;
  try {
    named = await stat(resolved);
  } catch (error) {
    return { ok: false, rule: refusalOf(error) };
  }
  if (named.isDirectory()) return { ok: false, rule: 'a directory, not a file' };
  if (!named.isFile()) return { ok: false, rule: 'not a regular file' };
  let handle: FileHandle;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return { ok: false, rule: refusalOf(error) };
  }
  let kept = false;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, rule: 'not a regular file' };
    if (stats.dev !== named.dev || stats.ino !== named.ino)
      return { ok: false, rule: 'changed while it was being opened' };
    if (stats.nlink !== 1) return { ok: false, rule: 'has more than one name (a hard link)' };
    if (stats.size > MAX_ATTACHMENT_BYTES)
      return { ok: false, rule: `over ${MAX_ATTACHMENT_BYTES.toLocaleString('en-US')} bytes` };
    const { size, sha256 } = await hashUpTo(handle, MAX_ATTACHMENT_BYTES);
    if (size > MAX_ATTACHMENT_BYTES)
      return { ok: false, rule: `over ${MAX_ATTACHMENT_BYTES.toLocaleString('en-US')} bytes` };
    kept = true;
    return {
      ok: true,
      file: {
        shown,
        resolved,
        name,
        size,
        sha256,
        bytes: () => sendFrom(handle, size),
        close: () => handle.close(),
      },
    };
  } finally {
    if (!kept) await handle.close();
  }
}

/** `size` bytes from offset 0 of an open file, in chunks; a file that ended early ends early (the daemon refuses it). */
async function* sendFrom(handle: FileHandle, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < size;) {
    const buffer = Buffer.alloc(Math.min(CHUNK, size - at));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, at);
    if (bytesRead === 0) return;
    yield buffer.subarray(0, bytesRead);
    at += bytesRead;
  }
}

/** The rule an expected file-system error stands for; anything else is a defect and throws. */
function refusalOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'no such file';
  if (code === 'EACCES' || code === 'EPERM') return `cannot be read (${code})`;
  if (code === 'ENXIO' || code === 'EOPNOTSUPP' || code === 'ENODEV') return 'not a regular file';
  if (code === 'ELOOP') return 'a link that does not resolve';
  throw error;
}

/** One file to attach, or the ⚠ said about a word that will not attach (R2), in the line's order. */
export type LineAttachment =
  | { readonly kind: 'attach'; readonly file: OpenAttachment }
  | { readonly kind: 'warn'; readonly shown: string; readonly rule: string };

/**
 * The files an interactive line attaches (R1 rules 4–7, R2): every candidate naming a regular file that reads as
 * attachable, once by its resolved path, at most 10; and a warning for each word that names a file it will not attach.
 */
export async function lineAttachments(line: string, context: PathContext): Promise<LineAttachment[]> {
  const out: LineAttachment[] = [];
  const attached = new Set<string>();
  for (const word of lineWords(line)) {
    const named = await namedFile(word, context);
    if (named.kind === 'text') continue;
    if (named.kind === 'other') {
      out.push({ kind: 'warn', shown: named.shown, rule: named.rule });
      continue;
    }
    // Once by its resolved path: a second word naming it is text, said nothing about.
    let resolved: string;
    try {
      resolved = await realpath(named.path);
    } catch (error) {
      out.push({ kind: 'warn', shown: named.shown, rule: refusalOf(error) });
      continue;
    }
    if (attached.has(resolved)) continue;
    if (attached.size >= MAX_FILES_PER_MESSAGE) {
      out.push({ kind: 'warn', shown: named.shown, rule: `more than ${String(MAX_FILES_PER_MESSAGE)} files` });
      continue;
    }
    const read = await readAttachment(named.path, named.shown, context);
    if (!read.ok) {
      out.push({ kind: 'warn', shown: named.shown, rule: read.rule });
      continue;
    }
    attached.add(resolved);
    out.push({ kind: 'attach', file: read.file });
  }
  return out;
}
