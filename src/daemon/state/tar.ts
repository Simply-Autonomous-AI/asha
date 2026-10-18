// The state store's tar reader and writer (docs/plans/agent-persistence.md R11). A snapshot of an agent's /memory or
// /workspace arrives from `docker cp <container>:/<asset> -` as a tar stream; TarNormaliser reads it as it streams,
// accepts only directories and regular files under the asset's root with no `..`, `.` or empty part and no absolute
// name, counts the asset's bounds (R6) entry by entry and stops at the first one over, and writes out a normalised
// tar — every entry owned by uid and gid 1000, directories 0755, files 0644 or 0755, no setuid, setgid or sticky bit,
// names over 100 bytes in a ustar prefix — which is what the store keeps. The daemon never extracts agent-written
// content onto the host. Written here rather than with a dependency (PRINCIPLES §7), like the documents' archive.

import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { present } from '../../shared/assert-present.js';

/** A tar block: every header and every entry's padded data is a whole number of them. */
export const TAR_BLOCK = 512;

/** Who owns every restored entry: the user every agent image runs as (debt D34 records the assumption). */
export const STATE_OWNER = { uid: 1000, gid: 1000 } as const;

/** One entry of a normalised tar: a directory, or a file with its size and sha256. Names carry no trailing `/`. */
export type TarEntry =
  | { readonly name: string; readonly type: 'directory' }
  | { readonly name: string; readonly type: 'file'; readonly size: number; readonly sha256: string };

/** Why a normalised read stopped: an entry it refuses (`invalid_entry`, R11) or one past a bound (`over_bound`, R6). */
export type NormaliseFailure = {
  readonly ok: false;
  readonly reason: 'invalid_entry' | 'over_bound';
  readonly entry: string;
  readonly detail: string;
};
/** A whole archive read and written normalised — its files, their bytes and its entries — or why it stopped. */
export type NormaliseResult =
  | { readonly ok: true; readonly files: number; readonly bytes: number; readonly entries: readonly TarEntry[] }
  | NormaliseFailure;

/** What a TarNormaliser reads for: the asset's root and bounds, where the normalised tar goes, and how long names are kept. */
export interface TarNormaliserProps {
  /** The asset's top directory in the copy (`memory`, `workspace`, `channel`): every name must be it or under it. */
  readonly root: string;
  /** Most regular files the asset may hold (R6). */
  readonly maxFiles: number;
  /** Most bytes its regular files may hold together (R6). */
  readonly maxBytes: number;
  /**
   * Most entries it may hold, the root excluded: every directory and regular file counts (R6: entries counted as
   * they stream; agent-files R11), so a snapshot of empty directories is bounded too.
   */
  readonly maxEntries: number;
  /** Receives the normalised tar, in order; awaited, so a slow disk slows the reading. */
  readonly write: (chunk: Uint8Array) => Promise<void>;
  /**
   * A name no ustar header can hold: refused as invalid_entry (the default, agent-persistence R11), or written with
   * a pax extended header naming it (the channel file space's snapshot, agent-files R15: an attachment's name may
   * be 255 bytes, in its upload's folder).
   */
  readonly longNames?: 'refuse' | 'pax';
  /** Entries left out of the normalised tar — read past, neither written nor counted (agent-files R15's unused uploads). */
  readonly skip?: (name: string) => boolean;
}

const KINDS: Readonly<Record<string, string>> = {
  '1': 'a hard link',
  '2': 'a symbolic link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a FIFO',
  '7': 'a contiguous file',
};

/** What an entry's type is, in words (for a refusal), or undefined for a directory or a regular file. */
function entryKind(type: string): string | undefined {
  if (type === '0' || type === '\0' || type === '5') return undefined;
  return KINDS[type] ?? `entry type ${JSON.stringify(type)}`;
}

/** One entry's header, extended headers (pax `path` and `size`, GNU long names) applied. `name` keeps any trailing `/`. */
export interface TarHeader {
  readonly name: string;
  /** The ustar type flag: '0' or '\0' a regular file, '5' a directory, '1' a hard link, '2' a symbolic link, …. */
  readonly type: string;
  readonly size: number;
  readonly mode: number;
  readonly mtime: number;
}

/** A tar that is not well formed: the entry it was at, and what is wrong. */
export interface TarFormatFailure {
  readonly entry: string;
  readonly detail: string;
}

/** What a TarParser hands its reader. Each may stop the parse by returning a failure (or, for data, throwing). */
export interface TarReader {
  /** An entry's header. Its data, if any, follows in `data` calls, then `entryEnd`. */
  entry(header: TarHeader): Promise<TarFormatFailure | undefined>;
  data(chunk: Buffer): Promise<void>;
  entryEnd(): Promise<TarFormatFailure | undefined>;
  /** The archive's end marker. */
  end(): Promise<void>;
}

/** Bytes of the current entry's data still to pass through, then its padding (TarParser's `data`). */
type EntryData = { left: number; pad: number };
/** An extended header's body being collected: a pax record set (`x`, `g`) or a GNU long name (`L`, `K`). */
type ExtendedHeaderState = { kind: 'x' | 'g' | 'L' | 'K'; left: number; pad: number; parts: Buffer[] };
/** One step of TarParser.push()'s loop: more input needed, handled and ready to loop again, or a failure. */
type ParseStep = 'need-more' | 'continue' | TarFormatFailure;

/**
 * The tar format, read as it streams: 512-byte blocks, checksums, octal fields, pax record sets and GNU long names
 * applied to the entry they precede, each entry's data passed through and its padding skipped, the end marker and
 * the zeros after it. What an entry may be is the reader's to decide (TarNormaliser's rules, or a measurement's).
 */
export class TarParser {
  private buffered = Buffer.alloc(0);
  private data: EntryData | undefined;
  private extended: ExtendedHeaderState | undefined;
  /** The name a pax `path` or GNU `L` gives the next entry. */
  private nextName: string | undefined;
  private nextSize: number | undefined;
  private lastName = '';
  private ended = false;
  private failed: TarFormatFailure | undefined;

  constructor(private readonly reader: TarReader) {}

  /** The entry the parse was at: what a failure names. */
  get current(): string {
    return this.lastName;
  }

  async push(chunk: Uint8Array): Promise<TarFormatFailure | undefined> {
    if (this.failed !== undefined) return this.failed;
    this.buffered = this.buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk]);
    for (;;) {
      const step = await this.step();
      if (step === 'continue') continue;
      if (step === 'need-more') return undefined;
      return this.fail(step);
    }
  }

  /** One step of push()'s loop, in whichever state it is in. Extracted from push() to keep its complexity in bound. */
  private step(): Promise<ParseStep> {
    if (this.data !== undefined) return this.stepData(this.data);
    if (this.extended !== undefined) {
      const extended = this.extended;
      const need = extended.left + extended.pad;
      if (this.buffered.length < need) return Promise.resolve<ParseStep>('need-more');
      return Promise.resolve<ParseStep>(this.consumeExtended(extended) ?? 'continue');
    }
    return this.stepHeader();
  }

  /** Consumes a complete extended header's body, once step() has found enough of it buffered. */
  private consumeExtended(extended: ExtendedHeaderState): TarFormatFailure | undefined {
    extended.parts.push(this.buffered.subarray(0, extended.left));
    this.buffered = this.buffered.subarray(extended.left + extended.pad);
    const failure = this.applyExtended(extended.kind, Buffer.concat(extended.parts));
    this.extended = undefined;
    return failure;
  }

  /**
   * One step while an entry's data (and its padding) is being read: a chunk passed through, then, once it is all
   * through, the entry's end. `data` is the same object as `this.data`, so mutating its `left` here is exactly what
   * push() did inline before this was extracted out of it.
   */
  private async stepData(data: EntryData): Promise<ParseStep> {
    if (this.buffered.length === 0) return 'need-more';
    const take = Math.min(data.left, this.buffered.length);
    if (take > 0) {
      const part = this.buffered.subarray(0, take);
      this.buffered = this.buffered.subarray(take);
      data.left -= take;
      await this.reader.data(part);
    }
    if (data.left > 0) return 'need-more';
    if (this.buffered.length < data.pad) return 'need-more';
    this.buffered = this.buffered.subarray(data.pad);
    this.data = undefined;
    const failure = await this.reader.entryEnd();
    return failure ?? 'continue';
  }

  /** One step while a new 512-byte header block is expected. Extracted as stepData is. */
  private async stepHeader(): Promise<ParseStep> {
    if (this.buffered.length < TAR_BLOCK) return 'need-more';
    const header = this.buffered.subarray(0, TAR_BLOCK);
    this.buffered = this.buffered.subarray(TAR_BLOCK);
    if (this.ended) {
      // After the end marker, the record's padding: zeros only.
      if (!header.every((b) => b === 0)) return { entry: "(the archive's end)", detail: 'data follows the end marker' };
      return 'continue';
    }
    if (header.every((b) => b === 0)) {
      this.ended = true;
      await this.reader.end();
      return 'continue';
    }
    const failure = await this.header(header);
    return failure ?? 'continue';
  }

  /** Once the whole stream has been pushed: the archive must have ended with its end marker. */
  finish(): TarFormatFailure | undefined {
    if (this.failed !== undefined) return this.failed;
    if (this.data !== undefined)
      return this.fail({ entry: this.lastName, detail: 'the archive ends inside this entry' });
    if (this.extended !== undefined)
      return this.fail({ entry: this.lastName, detail: 'the archive ends inside an extended header' });
    if (!this.ended)
      return this.fail({ entry: "(the archive's end)", detail: 'the archive ends before its end marker' });
    if (this.buffered.length > 0 && !this.buffered.every((b) => b === 0))
      return this.fail({ entry: "(the archive's end)", detail: 'data follows the end marker' });
    return undefined;
  }

  private fail(failure: TarFormatFailure): TarFormatFailure {
    this.failed = failure;
    return failure;
  }

  private async header(h: Buffer): Promise<TarFormatFailure | undefined> {
    const ustar = h.subarray(257, 262).toString('latin1') === 'ustar';
    const prefix = ustar ? cString(h, 345, 155) : '';
    const headerName = (prefix === '' ? '' : `${prefix}/`) + cString(h, 0, 100);
    const name = this.nextName ?? headerName;
    this.lastName = name;
    if (!checksumMatches(h)) return { entry: name, detail: 'its header checksum does not match' };
    const type = h.subarray(156, 157).toString('latin1');
    const size = this.nextSize ?? octal(h, 124, 12);
    if (size === undefined) return { entry: name, detail: 'its size field is not an octal number' };
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      // A pax record set or a GNU long name: its body is read, and applies to the entry that follows (or, `g`, to all).
      if (size > 1024 * 1024) return { entry: name, detail: 'an extended header over 1 MiB' };
      this.extended = { kind: type, left: size, pad: padOf(size), parts: [] };
      return undefined;
    }
    this.nextName = undefined;
    this.nextSize = undefined;
    const failure = await this.reader.entry({
      name,
      type,
      size,
      mode: octal(h, 100, 8) ?? 0,
      mtime: octal(h, 136, 12) ?? 0,
    });
    if (failure !== undefined) return failure;
    this.data = { left: size, pad: padOf(size) };
    if (size === 0) {
      this.data = undefined;
      return this.reader.entryEnd();
    }
    return undefined;
  }

  /** Applies a pax record set or a GNU long name to the next entry. */
  private applyExtended(kind: 'x' | 'g' | 'L' | 'K', body: Buffer): TarFormatFailure | undefined {
    if (kind === 'L') {
      this.nextName = cString(body, 0, body.length);
      return undefined;
    }
    // A GNU long link name belongs to a link entry, which a reader refuses or counts when it comes.
    if (kind === 'K') return undefined;
    const records = paxRecords(body);
    if (records === undefined) return { entry: this.lastName, detail: 'a malformed pax extended header' };
    if (kind === 'g') {
      // Global records would change every later entry; none a snapshot needs, so a global path or size is refused.
      if (records.has('path') || records.has('size'))
        return { entry: this.lastName, detail: 'a global pax header naming a path or size' };
      return undefined;
    }
    const path = records.get('path');
    if (path !== undefined) this.nextName = path;
    const size = records.get('size');
    if (size !== undefined) {
      if (!/^\d{1,15}$/.test(size))
        return { entry: this.nextName ?? this.lastName, detail: 'a pax size that is not a number' };
      this.nextSize = Number(size);
    }
    return undefined;
  }
}

/**
 * Reads a tar stream pushed chunk by chunk and writes its normalised form. `push` returns a failure as soon as one
 * is certain — the caller then stops reading (and stops the copy) — and `finish` checks the archive ended properly.
 * After a failure nothing more is written.
 */
export class TarNormaliser implements TarReader {
  private readonly parser = new TarParser(this);
  /** The regular file whose data is passing through. */
  private file: { name: string; hash: Hash; size: number; pad: number } | undefined;
  /** The entry being read past (props.skip): its data is not written. */
  private skipping = false;
  private failed: NormaliseFailure | undefined;
  private files = 0;
  private bytes = 0;
  /** Entries counted against maxEntries: every directory and file written but the root. */
  private counted = 0;
  private readonly entries: TarEntry[] = [];

  constructor(private readonly props: TarNormaliserProps) {}

  /** A directory entry: no data, counted against maxEntries unless it is the root, written normalised. */
  private async directory(
    clean: string,
    size: number,
    mtime: number,
    pax: boolean,
  ): Promise<(TarFormatFailure & { reason?: NormaliseFailure['reason'] }) | undefined> {
    if (size !== 0) return { entry: clean, detail: 'a directory entry with data' };
    const over = this.overEntries(clean);
    if (over !== undefined) return over;
    const out = headerFor(clean, 'directory', 0, mtime, pax);
    if (out === undefined) return { entry: clean, detail: USTAR_NAME_LIMIT };
    await this.props.write(out);
    if (clean !== this.props.root) this.counted += 1;
    this.entries.push({ name: clean, type: 'directory' });
    return undefined;
  }

  /** The over_bound failure for a regular file `clean` of `size` bytes: past the entries, files or bytes bound. */
  private overFileBounds(clean: string, size: number): (TarFormatFailure & { reason: 'over_bound' }) | undefined {
    const over = this.overEntries(clean);
    if (over !== undefined) return over;
    if (this.files + 1 > this.props.maxFiles)
      return {
        entry: clean,
        reason: 'over_bound',
        detail: `${this.props.root} is over its bound of ${this.props.maxFiles.toString()} files`,
      };
    if (this.bytes + size > this.props.maxBytes)
      return {
        entry: clean,
        reason: 'over_bound',
        detail: `${this.props.root} is over its bound of ${this.props.maxBytes.toString()} bytes`,
      };
    return undefined;
  }

  /** The over_bound failure for `entry` when one more entry would pass maxEntries; the root is never counted. */
  private overEntries(entry: string): (TarFormatFailure & { reason: 'over_bound' }) | undefined {
    if (entry === this.props.root || this.counted + 1 <= this.props.maxEntries) return undefined;
    return {
      entry,
      reason: 'over_bound',
      detail: `${this.props.root} is over its bound of ${this.props.maxEntries.toString()} entries`,
    };
  }

  async push(chunk: Uint8Array): Promise<NormaliseFailure | undefined> {
    if (this.failed !== undefined) return this.failed;
    const failure = await this.parser.push(chunk);
    return failure === undefined ? undefined : this.fail(failure);
  }

  /** The result once the whole stream has been pushed: the archive must have ended with its end marker. */
  finish(): NormaliseResult {
    if (this.failed !== undefined) return this.failed;
    const failure = this.parser.finish();
    if (failure !== undefined) return this.fail(failure);
    return { ok: true, files: this.files, bytes: this.bytes, entries: [...this.entries] };
  }

  private fail(failure: TarFormatFailure & { readonly reason?: NormaliseFailure['reason'] }): NormaliseFailure {
    this.failed ??= {
      ok: false,
      reason: failure.reason ?? 'invalid_entry',
      entry: failure.entry,
      detail: failure.detail,
    };
    return this.failed;
  }

  async entry(header: TarHeader): Promise<(TarFormatFailure & { reason?: NormaliseFailure['reason'] }) | undefined> {
    const { name, type, size, mode, mtime } = header;
    const kind = entryKind(type);
    if (kind !== undefined) return { entry: name, detail: `${kind} is not a directory or a regular file` };
    const problem = nameProblem(name, this.props.root);
    if (problem !== undefined) return { entry: name, detail: problem };
    const clean = name.replace(/\/$/, '');
    if (this.props.skip?.(clean) === true) {
      this.skipping = true;
      return undefined;
    }
    const pax = this.props.longNames === 'pax';
    if (type === '5') return this.directory(clean, size, mtime, pax);
    if (name.endsWith('/')) return { entry: name, detail: 'a regular file whose name ends in /' };
    const over = this.overFileBounds(clean, size);
    if (over !== undefined) return over;
    const out = headerFor(clean, (mode & 0o111) !== 0 ? 'executable' : 'file', size, mtime, pax);
    if (out === undefined) return { entry: clean, detail: USTAR_NAME_LIMIT };
    await this.props.write(out);
    this.counted += 1;
    this.files += 1;
    this.bytes += size;
    this.file = { name: clean, hash: createHash('sha256'), size, pad: padOf(size) };
    return undefined;
  }

  async data(chunk: Buffer): Promise<void> {
    if (this.skipping || this.file === undefined) return;
    this.file.hash.update(chunk);
    await this.props.write(chunk);
  }

  async entryEnd(): Promise<undefined> {
    if (this.skipping) {
      this.skipping = false;
      return undefined;
    }
    const file = this.file;
    if (file === undefined) return undefined;
    this.file = undefined;
    if (file.pad > 0) await this.props.write(Buffer.alloc(file.pad));
    this.entries.push({ name: file.name, type: 'file', size: file.size, sha256: file.hash.digest('hex') });
    return undefined;
  }

  async end(): Promise<void> {
    await this.props.write(Buffer.alloc(2 * TAR_BLOCK));
  }
}

const USTAR_NAME_LIMIT = 'the name cannot be held by a ustar header (at most 155 bytes of directories and 100 of name)';

/** What is wrong with an entry's name under `root`, or undefined. */
function nameProblem(name: string, root: string): string | undefined {
  if (name.startsWith('/')) return 'the name is absolute';
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'the name has a "..", "." or empty part';
  if (parts[0] !== root) return `the name is not under ${root}/`;
  return undefined;
}

/** The string in a NUL-terminated field. */
function cString(b: Buffer, offset: number, length: number): string {
  const field = b.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

/** `text` with every trailing NUL or space removed (replaces a `/[\0 ]+$/` trim: the same chars, without its backtracking). */
function trimTrailingNulsAndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\0' || text[end - 1] === ' ')) end -= 1;
  return text.slice(0, end);
}

/** An octal numeric field (spaces and NULs around it allowed); undefined for anything else, base-256 included. */
function octal(b: Buffer, offset: number, length: number): number | undefined {
  const text = trimTrailingNulsAndSpaces(b.subarray(offset, offset + length).toString('latin1')).replace(/^ +/, '');
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) return undefined;
  return parseInt(text, 8);
}

function checksumMatches(h: Buffer): boolean {
  const recorded = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : present(h[i], 'header byte');
  return recorded === sum;
}

/** `<length> <key>=<value>\n` records; undefined if any is malformed. */
function paxRecords(body: Buffer): Map<string, string> | undefined {
  const records = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) return undefined;
    const length = Number(body.subarray(at, space).toString('latin1'));
    if (!Number.isInteger(length) || length <= 0 || at + length > body.length) return undefined;
    const record = body.subarray(space + 1, at + length).toString('utf8');
    if (!record.endsWith('\n')) return undefined;
    const eq = record.indexOf('=');
    if (eq <= 0) return undefined;
    records.set(record.slice(0, eq), record.slice(eq + 1, -1));
    at += length;
  }
  return records;
}

/**
 * A normalised ustar header: owner 1000, mode 0755 (a directory or an executable) or 0644, `mtime` in seconds.
 * A directory's name gets its trailing `/`. A name over 100 bytes is split into a prefix of at most 155 bytes and
 * a name of at most 100 at a `/`; when it cannot be, undefined — or, with `pax`, a pax extended header naming it
 * followed by the header with a placeholder name. Never truncated.
 */
function headerFor(
  name: string,
  kind: 'directory' | 'file' | 'executable',
  size: number,
  mtime: number,
  pax = false,
): Buffer | undefined {
  const full = kind === 'directory' ? `${name}/` : name;
  let prefix = '';
  let rest = full;
  if (Buffer.byteLength(full) > 100) {
    const split = splitUstar(full);
    if (split === undefined) {
      if (!pax) return undefined;
      const record = paxRecord('path', full);
      const extended = ustarHeader(`PaxHeaders/${placeholder(full)}`, '', 'x', 0o644, record.byteLength, mtime);
      return Buffer.concat([
        extended,
        record,
        Buffer.alloc(padOf(record.byteLength)),
        ustarHeader(
          placeholder(full),
          '',
          kind === 'directory' ? '5' : '0',
          kind === 'file' ? 0o644 : 0o755,
          size,
          mtime,
        ),
      ]);
    }
    [prefix, rest] = split;
  }
  return ustarHeader(rest, prefix, kind === 'directory' ? '5' : '0', kind === 'file' ? 0o644 : 0o755, size, mtime);
}

/** One pax record, `<length> <key>=<value>\n`, its length counting itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length.toString()}${body}`, 'utf8');
}

/** A ustar-safe stand-in for a name a pax header carries: its last characters, whole, at most 100 bytes (ASCII-safe readers show it). */
function placeholder(full: string): string {
  const chars = Array.from(present(full.replace(/\/$/, '').split('/').at(-1), 'last path segment'));
  while (Buffer.byteLength(chars.join('')) > 99) chars.shift();
  return chars.join('') + (full.endsWith('/') ? '/' : '');
}

/** One 512-byte ustar header, owner 1000, checksum computed. */
function ustarHeader(name: string, prefix: string, type: string, mode: number, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(TAR_BLOCK);
  const num = (value: number, offset: number, length: number): void => {
    h.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  };
  h.write(name, 0, 100, 'utf8');
  num(mode, 100, 8);
  num(STATE_OWNER.uid, 108, 8);
  num(STATE_OWNER.gid, 116, 8);
  num(size, 124, 12);
  num(Math.max(0, Math.min(mtime, 0o77777777777)), 136, 12);
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/**
 * A normalised header for a directory or a regular file (owner 1000, 0755 or 0644), a pax extended header first
 * when its name cannot be held by ustar: the channel file space's archives (agent-files R3a), whose names may be 255
 * bytes in an upload's folder. The file's data and padding (`padOf`) follow it.
 */
export function tarEntryHeader(name: string, kind: 'directory' | 'file', size: number, mtime: number): Buffer {
  return present(headerFor(name, kind, size, mtime, true), 'pax tar header');
}

/** The zero bytes after `size` bytes of data, to the block. */
export const padOf = (size: number): number => (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;

/** Splits a name at the last `/` that leaves a prefix of at most 155 bytes and a name of at most 100. */
function splitUstar(full: string): [string, string] | undefined {
  // A directory's trailing / stays with its name: the split is at a / before it.
  for (let i = full.length - 2; i > 0; i -= 1) {
    if (full[i] !== '/') continue;
    const prefix = full.slice(0, i);
    const rest = full.slice(i + 1);
    if (Buffer.byteLength(rest) > 100) return undefined;
    if (Buffer.byteLength(prefix) <= 155) return [prefix, rest];
  }
  return undefined;
}

/** A normalised directory entry (owner 1000, 0755), for the documents R13 adds to a restored /workspace. */
export function tarDirectory(name: string, mtime: number): Buffer {
  const h = headerFor(name, 'directory', 0, mtime);
  if (h === undefined) throw new Error(`tarDirectory: "${name}" cannot be held by a ustar header`);
  return h;
}

/** A normalised regular file entry (owner 1000, 0644) with its data, padded to the block. */
export function tarFile(name: string, content: Uint8Array, mtime: number): Buffer {
  const h = headerFor(name, 'file', content.byteLength, mtime);
  if (h === undefined) throw new Error(`tarFile: "${name}" cannot be held by a ustar header`);
  return Buffer.concat([h, Buffer.from(content), Buffer.alloc(padOf(content.byteLength))]);
}

/**
 * The entries of a tar the store wrote, read back from its file (for R13's missing documents and R16's subset
 * check): each file's size and sha256. A stored tar that does not read as one is a corrupt store and throws.
 */
export async function readStoredEntries(file: string, root: string): Promise<TarEntry[]> {
  const normaliser = new TarNormaliser({
    root,
    maxFiles: Number.MAX_SAFE_INTEGER,
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxEntries: Number.MAX_SAFE_INTEGER,
    write: () => Promise.resolve(),
  });
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  try {
    for await (const chunk of stream) {
      const failure = await normaliser.push(chunk as Buffer);
      if (failure !== undefined)
        throw new Error(`stored tar ${file} does not read back: ${failure.entry}: ${failure.detail}`);
    }
  } finally {
    stream.destroy();
  }
  const result = normaliser.finish();
  if (!result.ok) throw new Error(`stored tar ${file} does not read back: ${result.entry}: ${result.detail}`);
  return [...result.entries];
}
