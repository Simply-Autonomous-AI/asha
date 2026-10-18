// A persisted agent's record of accepted, unsaved deliveries (docs/plans/agent-persistence.md R9 (a)): pending.json
// in its identity's directory, mode 0600. One entry per delivery the channel has accepted for the agent whose
// checkpoint is not yet promoted, in delivery order; a delivery is made only once its entry is written and synced.
// The fields are an allow-list — `user` and `text` only for a user's input, which the re-send needs — and nothing
// else is ever written to it. Writes are whole-file replacements (writePrivateFile) followed by an fsync of the
// directory, one at a time in the order the changes were made; an empty record is removed.

import { join } from 'node:path';

import { present } from '../../shared/assert-present.js';
import type { StateFs } from './fs.js';

/** Bounds of one record (R9 (a)): 32 deliveries, and 4 MiB of JSON (four at the daemon's 1 MiB body limit). */
export const PENDING_MAX_ENTRIES = 32;
/** The record's byte bound (R9 (a)): 4 MiB of JSON, as written. */
export const PENDING_MAX_BYTES = 4 * 1024 * 1024;

/** What an entry's delivery was (R9 (a)): exactly one of these; only an `input` is ever re-sent (R9 (d)). */
const PENDING_KINDS = ['input', 'internal', 'call_question', 'call_gather'] as const;
/** One of PENDING_KINDS. */
export type PendingKind = (typeof PENDING_KINDS)[number];

/** One accepted, unsaved delivery. */
export interface PendingEntry {
  readonly messageId: string;
  readonly conversation: string;
  readonly deliveryId: string;
  /** The start time of the daemon run that accepted it, ISO 8601: only an earlier run's entries are re-sent (R9 (c)). */
  readonly daemonStartedAt: string;
  /** The generation promoted when it was accepted (0 for none). */
  readonly afterGeneration: number;
  /** 1 once it has been re-sent: never re-sent twice (R9 (e)). */
  readonly attempts: number;
  /** When it was accepted, ISO 8601: the resuming launch prints it (R9 (h)). */
  readonly savedAt: string;
  readonly kind: PendingKind;
  /** A user's input only: whose, and what — the re-send needs both. */
  readonly user?: string;
  readonly text?: string;
  /**
   * A user's input only: the handle it was addressed to, or null for every agent — a handle, not user data — so the
   * re-send is framed as the original was (R9 (e); added to the allow-list by the coding agent, 2026-09-29).
   */
  readonly to?: string | null;
  /**
   * A user's input only: its conversation was unfinished when the checkpoint after its delivery was promoted, so it
   * stays until the conversation is finished, and is re-sent at the next run if the daemon stops first
   * (docs/plans/patterns-phase-5.md R1–R3). Only ever `true`; absent otherwise.
   */
  readonly kept?: true;
}

const FIELDS = [
  'messageId',
  'conversation',
  'deliveryId',
  'daemonStartedAt',
  'afterGeneration',
  'attempts',
  'savedAt',
  'kind',
  'user',
  'text',
  'to',
  'kept',
];

/** pending.json does not read as a record: the store is corrupt, and nothing is guessed from it. */
export class PendingRecordInvalid extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file} is not a record of unsaved deliveries: ${detail}; remove it with asha --reset-state`);
    this.name = 'PendingRecordInvalid';
  }
}

/** Where a PendingRecord lives: the state filesystem and the identity's directory. */
export interface PendingRecordProps {
  readonly fs: StateFs;
  /** The identity's directory, which holds pending.json. */
  readonly dir: string;
}

/** Whether a write reached the disk: a failure is the caller's degraded mode to report (R9 (a): journal_failed). */
export type PendingWrite = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/**
 * One persisted agent's pending.json in memory (R9 (a)): its entries in delivery order, every change written whole
 * (writePrivateFile, then the directory fsynced), in order, one write at a time.
 */
export class PendingRecord {
  private list: PendingEntry[];
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly props: PendingRecordProps,
    entries: PendingEntry[],
  ) {
    this.list = entries;
  }

  /** The record's file: `pending.json` in the identity's directory. */
  get file(): string {
    return join(this.props.dir, 'pending.json');
  }

  /** The record as saved, or an empty one when there is none. An unreadable one throws PendingRecordInvalid. */
  static async load(props: PendingRecordProps): Promise<PendingRecord> {
    const file = join(props.dir, 'pending.json');
    const raw = await props.fs.readFile(file);
    return new PendingRecord(props, raw === undefined ? [] : parsePending(raw.toString('utf8'), file));
  }

  /** Its entries as they now stand, in delivery order. */
  get entries(): readonly PendingEntry[] {
    return this.list;
  }

  /** Its size as written, in bytes. */
  get bytes(): number {
    return bytesOf(this.list);
  }

  /** Undefined when one more entry fits both bounds; else the size the record would reach. */
  wouldOverflow(entry: PendingEntry): { readonly entries: number; readonly bytes: number } | undefined {
    const next = [...this.list, entry];
    const bytes = bytesOf(next);
    return next.length > PENDING_MAX_ENTRIES || bytes > PENDING_MAX_BYTES ? { entries: next.length, bytes } : undefined;
  }

  /** Appends an entry; resolves once the record holding it is written and its directory synced. */
  add(entry: PendingEntry): Promise<PendingWrite> {
    this.list = [...this.list, entry];
    return this.save();
  }

  /** Replaces the entry with `deliveryId` (a re-send's attempts and new deliveryId, R9 (e)). */
  replace(deliveryId: string, next: PendingEntry): Promise<PendingWrite> {
    const at = this.list.findIndex((e) => e.deliveryId === deliveryId);
    if (at < 0) throw new Error(`pending record ${this.file} holds no delivery ${deliveryId}`);
    this.list = this.list.map((e, i) => (i === at ? next : e));
    return this.save();
  }

  /**
   * Removes every entry `drop` selects — asked once per entry, in order, so it may log what it drops — returning
   * them; writes only when something was removed.
   */
  remove(drop: (entry: PendingEntry, index: number) => boolean): {
    readonly removed: readonly PendingEntry[];
    readonly written: Promise<PendingWrite>;
  } {
    const removed: PendingEntry[] = [];
    const kept: PendingEntry[] = [];
    this.list.forEach((entry, i) => (drop(entry, i) ? removed : kept).push(entry));
    if (removed.length === 0) return { removed, written: Promise.resolve({ ok: true }) };
    this.list = kept;
    return { removed, written: this.save() };
  }

  /**
   * Removes the entry with `deliveryId` and every entry before it (R9 (b)) but the kept ones, and marks `kept` the
   * entries `keep` names among them (patterns-phase-5 R1, R2), in one write; nothing when it holds no such entry.
   * Returns the entries removed and those newly marked.
   */
  clearThrough(
    deliveryId: string,
    keep: ReadonlySet<string> = new Set(),
  ): {
    readonly removed: readonly PendingEntry[];
    readonly marked: readonly PendingEntry[];
    readonly written: Promise<PendingWrite>;
  } {
    const at = this.list.findIndex((e) => e.deliveryId === deliveryId);
    const removed: PendingEntry[] = [];
    const marked: PendingEntry[] = [];
    const next: PendingEntry[] = [];
    this.list.forEach((entry, i) => {
      if (i > at || entry.kept === true) next.push(entry);
      else if (keep.has(entry.deliveryId) && entry.kind === 'input') {
        const kept: PendingEntry = { ...entry, kept: true };
        marked.push(kept);
        next.push(kept);
      } else removed.push(entry);
    });
    if (removed.length === 0 && marked.length === 0) return { removed, marked, written: Promise.resolve({ ok: true }) };
    this.list = next;
    return { removed, marked, written: this.save() };
  }

  /** Resolves once every write queued so far has finished. */
  settled(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** Writes the record as it is when the write runs — the latest state — one write at a time. */
  private save(): Promise<PendingWrite> {
    const write = this.chain.then(async (): Promise<PendingWrite> => {
      try {
        if (this.list.length === 0) await this.props.fs.remove(this.file);
        else await this.props.fs.replaceFile(this.file, `${JSON.stringify({ entries: this.list })}\n`);
        await this.props.fs.fsyncDir(this.props.dir);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    });
    this.chain = write;
    return write;
  }
}

function bytesOf(entries: readonly PendingEntry[]): number {
  return Buffer.byteLength(`${JSON.stringify({ entries })}\n`, 'utf8');
}

/** Parses a record: `{entries}`, each entry exactly the allow-listed fields, `user` and `text` only on an input. */
export function parsePending(text: string, file: string): PendingEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // The parse error's name only: its message would quote the file, which holds users' text (R15's privacy rule).
    throw new PendingRecordInvalid(file, `not JSON (${(error as Error).name})`);
  }
  const o = raw as { entries?: unknown } | null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).join() !== 'entries')
    throw new PendingRecordInvalid(file, 'expected exactly {"entries": [...]}');
  const entries = present(o, 'parsed record').entries;
  if (!Array.isArray(entries)) throw new PendingRecordInvalid(file, 'expected exactly {"entries": [...]}');
  return entries.map((value: unknown, i) => validatePendingEntry(value, i, file));
}

/**
 * One entry of a parsed record, checked against the allow-list: moved out of parsePending's `.map` to keep its
 * cognitive complexity within bound (the checks themselves are unchanged).
 */
function validatePendingEntry(value: unknown, i: number, file: string): PendingEntry {
  const e = value as Record<string, unknown> | null;
  const at = `entries[${i.toString()}]`;
  if (typeof e !== 'object' || e === null || Array.isArray(e))
    throw new PendingRecordInvalid(file, `${at} is not an object`);
  const extra = Object.keys(e).filter((k) => !FIELDS.includes(k));
  if (extra.length > 0)
    throw new PendingRecordInvalid(file, `${at} has fields outside the record's allow-list: ${extra.join(', ')}`);
  checkRequiredFields(e, at, file);
  if (!(PENDING_KINDS as readonly unknown[]).includes(e['kind']))
    throw new PendingRecordInvalid(file, `${at}.kind must be one of ${PENDING_KINDS.join(', ')}`);
  checkInputOnlyFields(e, at, file, e['kind'] === 'input');
  return e as unknown as PendingEntry;
}

/** The fields every entry has regardless of kind: non-empty strings, and whole, non-negative numbers. */
function checkRequiredFields(e: Record<string, unknown>, at: string, file: string): void {
  for (const key of ['messageId', 'conversation', 'deliveryId', 'daemonStartedAt', 'savedAt']) {
    if (typeof e[key] !== 'string' || e[key] === '')
      throw new PendingRecordInvalid(file, `${at}.${key} must be a non-empty string`);
  }
  for (const key of ['afterGeneration', 'attempts']) {
    if (typeof e[key] !== 'number' || !Number.isInteger(e[key]) || e[key] < 0)
      throw new PendingRecordInvalid(file, `${at}.${key} must be a whole number`);
  }
}

/** The fields recorded only for a user's input (`user`, `text`, `to`, `kept`): present only when `input` is true. */
function checkInputOnlyFields(e: Record<string, unknown>, at: string, file: string, input: boolean): void {
  for (const key of ['user', 'text']) {
    if (input && typeof e[key] !== 'string')
      throw new PendingRecordInvalid(file, `${at}.${key} must be a string on an input`);
    if (!input && key in e) throw new PendingRecordInvalid(file, `${at}.${key} is recorded only for an input`);
  }
  if (input && e['to'] !== null && typeof e['to'] !== 'string')
    throw new PendingRecordInvalid(file, `${at}.to must be a handle or null on an input`);
  if (!input && 'to' in e) throw new PendingRecordInvalid(file, `${at}.to is recorded only for an input`);
  if ('kept' in e && (e['kept'] !== true || !input))
    throw new PendingRecordInvalid(file, `${at}.kept is recorded only as true, and only on an input`);
}
