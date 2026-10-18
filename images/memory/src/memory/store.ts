// Memory on disk: one JSON file per (scope, tier) under the memory root, in a
// folder named by a hash of the scope so raw user IDs are not in paths.
// Writes go to a temporary file and are renamed over the target, so a reader
// never sees half a file. Only this process
// writes these files — memory lives in the agent's own container (the
// owner's option A) — so there is no cross-process merge to do.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { present } from '../../../../src/shared/assert-present.js';
import type { Memory, Scope, SearchableDoc, SessionDoc, Tier, TierDoc, Turn } from './types.js';

/** The folder name for a scope: sha256 of "<channel>/<user>", first 16 hex digits. */
export function scopeKey(scope: Scope): string {
  if (scope.channel === '' || scope.user === '')
    throw new Error(`memory scope needs a channel and a user: ${JSON.stringify(scope)}`);
  return createHash('sha256').update(`${scope.channel}/${scope.user}`).digest('hex').slice(0, 16);
}

function emptyDoc(tier: Tier, now: string): TierDoc {
  return tier === 'session'
    ? { schemaVersion: 1, tier, updatedAt: now, turns: [] }
    : { schemaVersion: 1, tier, updatedAt: now, records: [] };
}

const isString = (v: unknown): v is string => typeof v === 'string';

function validTurn(v: unknown): v is Turn {
  const t = v as Record<string, unknown>;
  return (
    typeof v === 'object' &&
    v !== null &&
    [t['id'], t['ts'], t['conversation'], t['from'], t['input'], t['response']].every(isString)
  );
}

function validMemory(v: unknown): v is Memory {
  const m = v as Record<string, unknown>;
  return (
    typeof v === 'object' &&
    v !== null &&
    isString(m['id']) &&
    isString(m['ts']) &&
    isString(m['text']) &&
    Array.isArray(m['embedding']) &&
    (m['embedding'] as unknown[]).every((x) => typeof x === 'number')
  );
}

/** Thrown for a file that isn't a memory document at all; a bad record inside a good file is dropped instead. */
export class MemoryFileInvalid extends Error {
  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(`memory file ${file} is not a memory document: ${reason}`);
    this.name = 'MemoryFileInvalid';
  }
}

/**
 * Thrown by MemoryStore.write when the write failed and removing its temporary failed too: the write's own error is
 * the cause, and the removal's is `cleanup`, so neither is lost (PRINCIPLES §12). The message names the file and both
 * failures, each by its code and syscall alone: the memory image's error line carries an error's message, not its
 * cause (logError in images/memory/src/main.ts), so the message is what an operator sees of either.
 */
export class MemoryWriteCleanupFailed extends Error {
  constructor(
    file: string,
    cause: NodeJS.ErrnoException,
    readonly cleanup: NodeJS.ErrnoException,
  ) {
    super(
      `memory file ${file} was not saved: ${String(cause.code)} (${String(cause.syscall)}), and removing its temporary failed too: ${String(cleanup.code)} (${String(cleanup.syscall)})`,
      { cause },
    );
    this.name = 'MemoryWriteCleanupFailed';
  }
}

/**
 * Parses a tier document. Tolerant of bad records — each one that fails
 * validation is dropped and reported through `dropped` — but not of a file
 * that is not a document of this tier, which fails loudly.
 */
export function parseDoc(tier: Tier, text: string, file: string, dropped: (count: number) => void): TierDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // The parse error's name and where, never its message: Node's quotes the input, which holds users' IDs and words
    // (docs/plans/agent-persistence.md R15). The position is found here, since Node 22's message may not carry one.
    if (!(error instanceof SyntaxError)) throw error;
    throw new MemoryFileInvalid(file, `not JSON (SyntaxError at position ${String(jsonErrorPosition(text))})`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || o['schemaVersion'] !== 1 || o['tier'] !== tier) {
    throw new MemoryFileInvalid(file, `expected schemaVersion 1 and tier "${tier}"`);
  }
  if (!isString(o['updatedAt'])) throw new MemoryFileInvalid(file, 'no updatedAt string');
  const list = tier === 'session' ? o['turns'] : o['records'];
  if (!Array.isArray(list)) throw new MemoryFileInvalid(file, `no ${tier === 'session' ? 'turns' : 'records'} array`);
  if (tier === 'session') {
    const turns = list.filter(validTurn);
    if (turns.length < list.length) dropped(list.length - turns.length);
    return { schemaVersion: 1, tier, updatedAt: o['updatedAt'], turns } satisfies SessionDoc;
  }
  const records = list.filter(validMemory);
  if (records.length < list.length) dropped(list.length - records.length);
  return { schemaVersion: 1, tier, updatedAt: o['updatedAt'], records } satisfies SearchableDoc;
}

export interface MemoryStoreProps {
  /** Where memory lives: /memory in the agent's container. */
  readonly root: string;
  /** Records how many bad records a file had; they were dropped, and this says so. */
  readonly onDropped: (file: string, count: number) => void;
  /**
   * A file that is not a document of its tier (parseDoc refused it, MemoryFileInvalid) was found by a read: a major
   * defect, reported here before the store overwrites the file with the tier's empty document (MemoryStore.read).
   */
  readonly onMalformed: (file: string, error: MemoryFileInvalid) => void;
}

/**
 * The memory files of every scope. A malformed file — one parseDoc refuses as MemoryFileInvalid — heals itself when it
 * is read: it is reported through onMalformed, then overwritten with its tier's empty document (the owner, 2026-10-11,
 * record memory-unreadable-session-episodic: a malformed tier file is a major defect, logged loudly for the failure scan,
 * and the agent loop self-heals by overwriting it). A file that cannot be read at all is not malformed: its read fails.
 */
export class MemoryStore {
  constructor(private readonly props: MemoryStoreProps) {}

  file(scope: Scope, tier: Tier): string {
    return join(this.props.root, scopeKey(scope), `${tier}.json`);
  }

  /**
   * The tier's document; an empty one, not written, when nothing has been written yet. A read error (EACCES, EISDIR,
   * EIO, …) rejects with that error. A file parseDoc refuses as MemoryFileInvalid is reported through onMalformed
   * first, so the report is never lost, then overwritten with the tier's empty document through write(), atomically,
   * and that document is returned; if the overwrite fails, the read rejects with the write's error. Anything else
   * parseDoc throws is passed on unchanged (record memory-unreadable-session-episodic). parseDoc itself still refuses
   * such a file: validateMemory, at start, refuses a malformed restored file (agent-persistence R12).
   */
  async read(scope: Scope, tier: Tier, now: string): Promise<TierDoc> {
    const file = this.file(scope, tier);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDoc(tier, now);
      throw error;
    }
    try {
      return parseDoc(tier, text, file, (count) => {
        this.props.onDropped(file, count);
      });
    } catch (error) {
      if (!(error instanceof MemoryFileInvalid)) throw error;
      this.props.onMalformed(file, error);
      const empty = emptyDoc(tier, now);
      await this.write(scope, empty);
      return empty;
    }
  }

  /**
   * Writes the whole document: to a temporary file, then renamed over the target. A failed write removes its
   * temporary, so a folder holds only documents — which a persisted /memory's validation at start requires (R12) — and
   * rejects with its own error, unchanged. When removing the temporary fails too, it rejects instead with
   * MemoryWriteCleanupFailed, whose cause is the write's own error and whose `cleanup` is the removal's. The temporary
   * it leaves is one that validation removes, when this /memory is persisted and the agent next starts.
   */
  async write(scope: Scope, doc: TierDoc): Promise<void> {
    const file = this.file(scope, doc.tier);
    await mkdir(join(this.props.root, scopeKey(scope)), { recursive: true });
    const text = `${JSON.stringify(doc)}\n`;
    const tmp = `${file}.tmp-${String(Date.now())}-${randomBytes(4).toString('hex')}`;
    try {
      await writeFile(tmp, text);
      await rename(tmp, file);
    } catch (error) {
      // Given a path, writeFile, rename and rm reject only with Node's file-system error, code and syscall set. force
      // forgives a path that is not there, and nothing else: a removal can still fail (EACCES, EPERM, EBUSY).
      await rm(tmp, { force: true }).catch((cleanup: unknown) => {
        throw new MemoryWriteCleanupFailed(file, error as NodeJS.ErrnoException, cleanup as NodeJS.ErrnoException);
      });
      throw error;
    }
  }
}

/**
 * Where `text` stops being JSON: the offset of the first character that cannot continue a JSON value, or the
 * text's length when it ends too soon. Only called on text JSON.parse refused; its answer names the place, and no
 * byte of the text, in a failure event. JSON.parse refuses a value nested to any depth with a SyntaxError, so this
 * answers for any depth too: it keeps the objects and arrays still open in a list rather than on the call stack.
 */
export function jsonErrorPosition(text: string): number {
  let at = 0;
  // Each reader below moves `at` past what it accepts, and returns false with `at` on the first character it cannot.
  const ws = (): void => {
    while (at < text.length && ' \t\n\r'.includes(present(text[at], `text[${String(at)}]`))) at += 1;
  };
  const literal = (word: string): boolean => {
    for (const c of word) {
      if (text[at] !== c) return false;
      at += 1;
    }
    return true;
  };
  // `at` is on the 'u' of a \u escape: its 4 hex digits, or where the first non-hex character is.
  const unicodeEscape = (): boolean => {
    for (let i = 1; i <= 4; i += 1)
      if (!/[0-9a-fA-F]/.test(text[at + i] ?? '')) {
        at += i;
        return false;
      }
    at += 5;
    return true;
  };
  // `at` is on the backslash of a string escape: its one character (\u's four hex digits included), or false.
  const escape = (): boolean => {
    at += 1;
    const e = text[at];
    if (e === 'u') return unicodeEscape();
    if (e === undefined || !'"\\/bfnrt'.includes(e)) return false;
    at += 1;
    return true;
  };
  const string = (): boolean => {
    at += 1;
    for (;;) {
      if (at >= text.length) return false;
      const c = present(text[at], `text[${String(at)}]`);
      if (c === '"') {
        at += 1;
        return true;
      }
      if (c < ' ') return false;
      if (c === '\\') {
        if (!escape()) return false;
      } else at += 1;
    }
  };
  const digit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  const digits = (): boolean => {
    if (!digit(text[at])) return false;
    while (digit(text[at])) at += 1;
    return true;
  };
  // Character by character, so a number cut short ("-", "1.", "1e+") breaks where its missing digit belongs.
  const number = (): boolean => {
    if (text[at] === '-') at += 1;
    if (text[at] === '0') at += 1;
    else if (!digits()) return false;
    if (text[at] === '.') {
      at += 1;
      if (!digits()) return false;
    }
    if (text[at] === 'e' || text[at] === 'E') {
      at += 1;
      if (text[at] === '+' || text[at] === '-') at += 1;
      if (!digits()) return false;
    }
    return true;
  };
  const scalar = (c: string | undefined): boolean => {
    if (c === '"') return string();
    if (c === 't') return literal('true');
    if (c === 'f') return literal('false');
    if (c === 'n') return literal('null');
    if (c === '-' || digit(c)) return number();
    return false;
  };
  // An object member's name and its colon; its value comes next.
  const name = (): boolean => {
    ws();
    if (text[at] !== '"' || !string()) return false;
    ws();
    if (text[at] !== ':') return false;
    at += 1;
    return true;
  };
  /**
   * `c` ('{' or '[') is open at `at`.
   * @returns 'open' when it is pushed onto `open` with its first member or element next; 'closed' when nothing is
   * inside it; false when it is an object whose first member has no name.
   */
  const openBracket = (c: '{' | '[', open: ('}' | ']')[]): 'open' | 'closed' | false => {
    const close = c === '{' ? '}' : ']';
    at += 1;
    ws();
    if (text[at] !== close) {
      if (c === '{' && !name()) return false;
      open.push(close);
      return 'open';
    }
    at += 1;
    return 'closed';
  };
  /**
   * A value ended at `at`.
   * @returns 'done' once it closes each object or array it completes, with nothing left open; 'next' when it goes
   * on to the innermost one's next member or element; false when the text is malformed here.
   */
  const closeOut = (open: ('}' | ']')[]): 'done' | 'next' | false => {
    for (;;) {
      const close = open.at(-1);
      if (close === undefined) return 'done';
      ws();
      if (text[at] === close) {
        at += 1;
        open.pop();
        continue;
      }
      if (text[at] === ',') {
        at += 1;
        if (close === '}' && !name()) return false;
        return 'next';
      }
      return false;
    }
  };
  // One whole value. `open` holds the closer each object or array still open is owed, innermost last.
  const value = (): boolean => {
    const open: ('}' | ']')[] = [];
    for (;;) {
      // A value starts here: a scalar, an empty object or array, or one whose first value comes next.
      ws();
      const c = text[at];
      if (c === '{' || c === '[') {
        const opened = openBracket(c, open);
        if (opened === false) return false;
        if (opened === 'open') continue;
      } else if (!scalar(c)) return false;
      const closed = closeOut(open);
      if (closed === false) return false;
      if (closed === 'next') continue;
      return true;
    }
  };
  // Valid up to here, and something follows: where it does.
  if (value()) ws();
  return at;
}
