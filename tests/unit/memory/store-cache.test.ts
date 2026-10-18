// The memory files and the cache in front of them (docs/architecture/memory.md#where, #tiers): a scope's folder
// name, one JSON document per (scope, tier) read back exactly, or reported loudly and overwritten with the tier's
// empty document when it is not a document of its tier, where a file that is not JSON breaks, and the cache — a
// change shown at once and saved in the background, one file's saves one after another, a failed save reported, and
// the least recently used documents with no save pending dropped past the bound.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryCache, MemoryFileInvalid, MemoryStore, scopeKey } from '../../../images/memory/src/memory/index.js';
import { jsonErrorPosition, parseDoc } from '../../../images/memory/src/memory/store.js';
import type { Memory, Scope, SearchableDoc, SessionDoc, Tier, Turn } from '../../../images/memory/src/memory/types.js';
import { present } from '../../../src/shared/assert-present.js';
import { byCodeUnit } from '../../../src/shared/order.js';

const NOW = '2026-09-26T12:00:00.000Z';
const EARLIER = '2026-09-25T08:30:00.000Z';
const ALICE: Scope = { channel: 'main', user: 'alice' };
const BOB: Scope = { channel: 'main', user: 'bob' };
// sha256("<channel>/<user>"), first 16 hex digits (docs/architecture/memory.md#where), computed with
// `printf 'main/alice' | shasum -a 256` rather than by the code under test: a persisted /memory is restored into the
// next image under these names, and an erase deletes the folder by this name.
const ALICE_KEY = '94f4f131f1cc0de5';
const BOB_KEY = 'e60ea66fdde6b98f';
const LAB_ALICE_KEY = '31f48efb808e88a2';

const TURN: Turn = { id: 't1', ts: NOW, conversation: 'c', from: 'alice', input: 'hi', response: 'hello' };
const record = (id: string, text = id): Memory => ({ id, ts: NOW, text, embedding: [1, 0] });
const semantic = (records: readonly Memory[], updatedAt = NOW): SearchableDoc => ({
  schemaVersion: 1,
  tier: 'semantic',
  updatedAt,
  records,
});
const session = (turns: readonly Turn[], updatedAt = NOW): SessionDoc => ({
  schemaVersion: 1,
  tier: 'session',
  updatedAt,
  turns,
});
/** A change that adds one record to a searchable document. */
const add =
  (id: string) =>
  (d: SearchableDoc): SearchableDoc => ({ ...d, records: [...d.records, record(id)] });
const EMPTY_EPISODIC: SearchableDoc = { schemaVersion: 1, tier: 'episodic', updatedAt: NOW, records: [] };
const EISDIR = { message: 'EISDIR: illegal operation on a directory, read', code: 'EISDIR', syscall: 'read' };
/**
 * A tier's empty document as MemoryStore.write leaves it on disk, written while the clock read NOW: its JSON, then a
 * newline. Written out by hand, in the field order the session document's bytes are pinned in below ("keeps each user
 * in their own folder").
 */
const EMPTY_BYTES: Readonly<Record<string, string>> = {
  semantic: '{"schemaVersion":1,"tier":"semantic","updatedAt":"2026-09-26T12:00:00.000Z","records":[]}\n',
  session: '{"schemaVersion":1,"tier":"session","updatedAt":"2026-09-26T12:00:00.000Z","turns":[]}\n',
};

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

/** A store on a new temporary root, removed after the test; every onDropped and onMalformed report is recorded. */
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'asha-mem-'));
  roots.push(root);
  const dropped: [string, number][] = [];
  const malformed: [string, unknown][] = [];
  return {
    root,
    dropped,
    malformed,
    store: new MemoryStore({
      root,
      onDropped: (file, count) => dropped.push([file, count]),
      onMalformed: (file, error) => malformed.push([file, error]),
    }),
  };
}

/**
 * Spies on a store's write, calling through, and records how many malformed reports had been made as each write
 * started. A malformed file is reported first, so the report is never lost, then overwritten (store.ts, MemoryStore.read;
 * docs/architecture/memory.md#tiers, Files): one report made before the overwrite began shows that order, and none
 * would show the reverse.
 */
function writesAfterReports(s: MemoryStore, malformed: readonly unknown[]) {
  const save = s.write.bind(s);
  const reportsAtWrite: number[] = [];
  const write = vi.spyOn(s, 'write').mockImplementation(async (scope, doc) => {
    reportsAtWrite.push(malformed.length);
    await save(scope, doc);
  });
  return { write, reportsAtWrite };
}

/** Writes a file into a scope folder by hand, as a restored /memory would hold it; returns its path. */
async function put(root: string, key: string, name: string, content: string): Promise<string> {
  await mkdir(join(root, key), { recursive: true });
  const file = join(root, key, name);
  await writeFile(file, content);
  return file;
}

const onDisk = async (root: string, key: string, tier: Tier): Promise<unknown> =>
  JSON.parse(await readFile(join(root, key, `${tier}.json`), 'utf8'));

/** What a call threw; undefined when it returned. */
function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** What a promise rejected with; undefined when it resolved. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/**
 * A MemoryFileInvalid whole: the fields callers read, its cause, and the names of all its own properties. A not-JSON
 * file is reported by where it breaks, never by its message, which quotes the input (docs/plans/agent-persistence.md
 * R15): the error's log line carries its cause (src/agent-sdk/log.ts), so a cause, or any field beside these, would
 * show here.
 */
function invalidFile(error: unknown): { name: string; message: string; file: string; cause: unknown; own: string[] } {
  expect(error).toBeInstanceOf(MemoryFileInvalid);
  const e = error as MemoryFileInvalid;
  return {
    name: e.name,
    message: e.message,
    file: e.file,
    cause: e.cause,
    own: Object.getOwnPropertyNames(e).sort(byCodeUnit),
  };
}

/** The MemoryFileInvalid naming `file` for `reason`: no cause, and no own property but its stack and these three. */
const refusedFile = (file: string, reason: string) => ({
  name: 'MemoryFileInvalid',
  message: `memory file ${file} is not a memory document: ${reason}`,
  file,
  cause: undefined,
  own: ['file', 'message', 'name', 'stack'],
});

/** A file-system error's class and the fields callers read. */
function fsError(error: unknown): {
  message: string | undefined;
  code: string | undefined;
  syscall: string | undefined;
} {
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  const e = error as NodeJS.ErrnoException;
  return { message: e.message, code: e.code, syscall: e.syscall };
}

/** A save the test lets finish when it chooses. */
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('scopeKey', () => {
  it('is the first 16 hex digits of sha256("<channel>/<user>"), so another user or another channel is another folder', () => {
    expect(scopeKey(ALICE)).toBe(ALICE_KEY);
    expect(scopeKey(BOB)).toBe(BOB_KEY);
    expect(scopeKey({ channel: 'lab', user: 'alice' })).toBe(LAB_ALICE_KEY);
  });

  it.each([
    [{ channel: '', user: 'alice' }, 'memory scope needs a channel and a user: {"channel":"","user":"alice"}'],
    [{ channel: 'main', user: '' }, 'memory scope needs a channel and a user: {"channel":"main","user":""}'],
    [{ channel: '', user: '' }, 'memory scope needs a channel and a user: {"channel":"","user":""}'],
  ])('refuses a scope without a channel or a user: %j', (scope, message) => {
    const error = thrown(() => scopeKey(scope));
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect((error as Error).message).toBe(message);
  });
});

describe('MemoryStore', () => {
  it('reads an empty document before anything is written, and exactly what it wrote after', async () => {
    const { root, dropped, malformed, store: s } = await store();
    expect(await s.read(ALICE, 'semantic', NOW)).toEqual(semantic([]));
    expect(await s.read(ALICE, 'session', NOW)).toEqual(session([]));
    expect(await readdir(root)).toEqual([]);
    const facts = semantic([record('f1', 'The user likes teal.')], EARLIER);
    const turns = session([TURN], EARLIER);
    await s.write(ALICE, facts);
    await s.write(ALICE, turns);
    expect(await s.read(ALICE, 'semantic', NOW)).toEqual(facts);
    expect(await s.read(ALICE, 'session', NOW)).toEqual(turns);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('keeps each user in their own folder, named by the scope hash, holding only the documents', async () => {
    const { root, dropped, malformed, store: s } = await store();
    await s.write(ALICE, session([]));
    await s.write(BOB, semantic([record('b')]));
    expect((await readdir(root)).sort(byCodeUnit)).toEqual([ALICE_KEY, BOB_KEY]);
    expect(await readdir(join(root, ALICE_KEY))).toEqual(['session.json']);
    expect(await readdir(join(root, BOB_KEY))).toEqual(['semantic.json']);
    expect(await readFile(join(root, ALICE_KEY, 'session.json'), 'utf8')).toBe(
      '{"schemaVersion":1,"tier":"session","updatedAt":"2026-09-26T12:00:00.000Z","turns":[]}\n',
    );
    expect(s.file(BOB, 'semantic')).toBe(join(root, BOB_KEY, 'semantic.json'));
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('drops the bad records and reports how many, but keeps the good ones', async () => {
    const { root, dropped, malformed, store: s } = await store();
    const good = record('ok', 't');
    const file = await put(
      root,
      ALICE_KEY,
      'semantic.json',
      JSON.stringify({
        ...semantic([], EARLIER),
        records: [good, { id: 'bad' }, { ...good, id: 'nan', embedding: [1, 'x'] }, null],
      }),
    );
    expect(await s.read(ALICE, 'semantic', NOW)).toEqual(semantic([good], EARLIER));
    expect(dropped).toEqual([[file, 3]]);
    expect(malformed).toEqual([]);
  });

  it("drops the session's bad turns and reports how many, but keeps the good ones", async () => {
    const { root, dropped, malformed, store: s } = await store();
    const file = await put(
      root,
      ALICE_KEY,
      'session.json',
      JSON.stringify({ ...session([], EARLIER), turns: [TURN, { ...TURN, id: 't2', response: 7 }, 'a turn', null] }),
    );
    expect(await s.read(ALICE, 'session', NOW)).toEqual(session([TURN], EARLIER));
    expect(dropped).toEqual([[file, 3]]);
    expect(malformed).toEqual([]);
  });

  // A record is kept only when every field the type gives is there with its type (types.ts: Memory's id, ts and text are
  // text, its embedding a list of numbers): one field wrong drops it alone, counted (store.ts parseDoc: "each one that
  // fails validation is dropped and reported"), and the good records on either side are kept, in order.
  it.each<[string, Record<string, unknown>]>([
    ['id', { ...record('bad'), id: 1 }],
    ['ts', { ...record('bad'), ts: null }],
    ['text', { ...record('bad'), text: 7 }],
    ['embedding', { ...record('bad'), embedding: 'x' }],
  ])(
    'drops a record whose %s is of the wrong type, reports it, and keeps the good records on either side',
    async (_field, bad) => {
      const { root, dropped, malformed, store: s } = await store();
      const first = record('ok1', 't');
      const last = record('ok2', 'u');
      const file = await put(
        root,
        ALICE_KEY,
        'semantic.json',
        JSON.stringify({ ...semantic([], EARLIER), records: [first, bad, last] }),
      );
      expect(await s.read(ALICE, 'semantic', NOW)).toEqual(semantic([first, last], EARLIER));
      expect(dropped).toEqual([[file, 1]]);
      expect(malformed).toEqual([]);
    },
  );

  // The same for a session turn (types.ts: every field of Turn is text).
  it.each(['id', 'ts', 'conversation', 'from', 'input', 'response'])(
    'drops a session turn whose %s is not text, reports it, and keeps the good turns on either side',
    async (field) => {
      const { root, dropped, malformed, store: s } = await store();
      const last: Turn = { ...TURN, id: 't3' };
      const file = await put(
        root,
        ALICE_KEY,
        'session.json',
        JSON.stringify({ ...session([], EARLIER), turns: [TURN, { ...TURN, id: 't2', [field]: 7 }, last] }),
      );
      expect(await s.read(ALICE, 'session', NOW)).toEqual(session([TURN, last], EARLIER));
      expect(dropped).toEqual([[file, 1]]);
      expect(malformed).toEqual([]);
    },
  );

  // The owner's answer of 2026-10-11, record memory-unreadable-session-episodic: a malformed memory file — one parseDoc
  // refuses as MemoryFileInvalid — is a major defect, reported loudly (onMalformed; the image logs it at error as
  // memory.file_malformed), and the store heals itself: it overwrites the file with the tier's empty document, through
  // its own atomic write, and reads that. The report comes first, so it is never lost.
  it.each<[Tier, string, string]>([
    [
      'semantic',
      JSON.stringify({ schemaVersion: 1, tier: 'episodic', updatedAt: NOW, records: [] }),
      'expected schemaVersion 1 and tier "semantic"',
    ],
    [
      'semantic',
      JSON.stringify({ schemaVersion: 2, tier: 'semantic', updatedAt: NOW, records: [] }),
      'expected schemaVersion 1 and tier "semantic"',
    ],
    // Its schemaVersion and tier right, its updatedAt missing or not text: the reason names that field, not the two it has.
    ['semantic', JSON.stringify({ schemaVersion: 1, tier: 'semantic', records: [] }), 'no updatedAt string'],
    ['session', JSON.stringify({ schemaVersion: 1, tier: 'session', updatedAt: 7, turns: [] }), 'no updatedAt string'],
    ['session', 'null', 'expected schemaVersion 1 and tier "session"'],
    ['session', '5', 'expected schemaVersion 1 and tier "session"'],
    ['semantic', JSON.stringify({ schemaVersion: 1, tier: 'semantic', updatedAt: NOW }), 'no records array'],
    ['session', JSON.stringify({ schemaVersion: 1, tier: 'session', updatedAt: NOW, turns: {} }), 'no turns array'],
    ['semantic', '{nope', 'not JSON (SyntaxError at position 1)'],
    ['semantic', '{"records":[-]}', 'not JSON (SyntaxError at position 13)'],
    // A user's ID in the file: Node 22.13.1's own message for it quotes the input, "zora" included (R15).
    ['session', '{"from":"zora","x":}', 'not JSON (SyntaxError at position 19)'],
  ])(
    'reports a %s file that is not a document of its tier, naming the file, then overwrites it with the empty document and reads that: %s',
    async (tier, content, reason) => {
      const { root, dropped, malformed, store: s } = await store();
      const { write, reportsAtWrite } = writesAfterReports(s, malformed);
      const file = await put(root, ALICE_KEY, `${tier}.json`, content);
      const empty = tier === 'session' ? session([]) : semantic([]);
      expect(await s.read(ALICE, tier, NOW)).toEqual(empty);
      // One report, of the error whole: its message names the file and the reason, and it carries no cause and no other
      // field, so no byte of the file reaches the error or its log line.
      expect(malformed.map(([f, e]) => [f, invalidFile(e)])).toEqual([[file, refusedFile(file, reason)]]);
      // Overwritten once, through the store's own write, which began with that report already made: the file is now
      // exactly the empty document, with no temporary left beside it.
      expect(write.mock.calls).toEqual([[ALICE, empty]]);
      expect(reportsAtWrite).toEqual([1]);
      expect(await readFile(file, 'utf8')).toBe(EMPTY_BYTES[tier]);
      expect(await readdir(join(root, ALICE_KEY))).toEqual([`${tier}.json`]);
      // Healed: read again, the file is that document, with no new report and no new write.
      expect(await s.read(ALICE, tier, NOW)).toEqual(empty);
      expect(malformed).toHaveLength(1);
      expect(write.mock.calls).toEqual([[ALICE, empty]]);
      expect(reportsAtWrite).toEqual([1]);
      expect(dropped).toEqual([]);
    },
  );

  it('reports, then overwrites, a file that is not JSON nested deeper than a call stack goes, never failing with a stack overflow', async () => {
    // R12 (docs/plans/agent-persistence.md) and docs/architecture/memory.md#persisted: an invalid file is refused as
    // MemoryFileInvalid naming it — here reported, then overwritten. A hundred thousand levels is deeper than a call
    // stack goes: a plain recursion that deep overflows Node 22.13.1's default stack (RangeError, read 2026-10-10).
    // JSON.parse refuses a hundred thousand "[" with a SyntaxError, "Unexpected end of JSON input" (Node 22.13.1, read
    // 2026-10-10), so the text ends too soon and the position is its length, 100,000 characters.
    const { root, dropped, malformed, store: s } = await store();
    const { write, reportsAtWrite } = writesAfterReports(s, malformed);
    const file = await put(root, ALICE_KEY, 'semantic.json', '['.repeat(100_000));
    expect(await s.read(ALICE, 'semantic', NOW)).toEqual(semantic([]));
    expect(malformed.map(([f, e]) => [f, invalidFile(e)])).toEqual([
      [file, refusedFile(file, 'not JSON (SyntaxError at position 100000)')],
    ]);
    // Overwritten once, through the store's own write, which began with that report already made.
    expect(write.mock.calls).toEqual([[ALICE, semantic([])]]);
    expect(reportsAtWrite).toEqual([1]);
    expect(await readFile(file, 'utf8')).toBe(EMPTY_BYTES['semantic']);
    expect(await readdir(join(root, ALICE_KEY))).toEqual(['semantic.json']);
    expect(dropped).toEqual([]);
  });

  it("rejects with the overwrite's own error when the empty document cannot be written, after reporting the file, and leaves the file as it was", async () => {
    const { root, dropped, malformed, store: s } = await store();
    const NOT_A_DOCUMENT = '{"schemaVersion":2}';
    const file = await put(root, ALICE_KEY, 'semantic.json', NOT_A_DOCUMENT);
    const diskFull = new Error('disk full');
    // How many reports had been made when the overwrite was tried: the report comes first, so it is never lost.
    let reportedBefore: number | undefined;
    const write = vi.spyOn(s, 'write').mockImplementationOnce(() => {
      reportedBefore = malformed.length;
      return Promise.reject(diskFull);
    });
    expect(await rejection(s.read(ALICE, 'semantic', NOW))).toBe(diskFull);
    expect(reportedBefore).toBe(1);
    expect(malformed.map(([f, e]) => [f, invalidFile(e)])).toEqual([
      [file, refusedFile(file, 'expected schemaVersion 1 and tier "semantic"')],
    ]);
    expect(write.mock.calls).toEqual([[ALICE, semantic([])]]);
    expect(await readFile(file, 'utf8')).toBe(NOT_A_DOCUMENT);
    expect(await readdir(join(root, ALICE_KEY))).toEqual(['semantic.json']);
    expect(dropped).toEqual([]);
  });

  it('passes on any other error from parsing a file unchanged, with no report and no overwrite: here the one onDropped throws', async () => {
    // Only MemoryFileInvalid is a malformed file. Anything else parseDoc throws — here the error onDropped throws when
    // the file has a bad record to report — is not, and reaches the caller as it was thrown.
    const { root } = await store();
    const failure = new Error('the drop report failed');
    const onDropped = vi.fn<(file: string, count: number) => void>(() => {
      throw failure;
    });
    const onMalformed = vi.fn();
    const s = new MemoryStore({ root, onDropped, onMalformed });
    const write = vi.spyOn(s, 'write');
    const content = JSON.stringify({ ...semantic([], EARLIER), records: [record('ok'), { id: 'bad' }] });
    const file = await put(root, ALICE_KEY, 'semantic.json', content);
    expect(await rejection(s.read(ALICE, 'semantic', NOW))).toBe(failure);
    // Called once, naming the file and its one bad record, and what that one call threw is what the read rejected with.
    expect(onDropped.mock.calls).toEqual([[file, 1]]);
    expect(onDropped.mock.results).toEqual([{ type: 'throw', value: failure }]);
    expect(onMalformed).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(content);
    expect(await readdir(join(root, ALICE_KEY))).toEqual(['semantic.json']);
  });

  it("fails with the read's own error on a file that exists but cannot be read, never as an empty document", async () => {
    const { root, dropped, malformed, store: s } = await store();
    await mkdir(join(root, ALICE_KEY, 'semantic.json'), { recursive: true });
    expect(fsError(await rejection(s.read(ALICE, 'semantic', NOW)))).toEqual(EISDIR);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });
});

describe('parseDoc', () => {
  it('passes on an error from the JSON parser that is not a SyntaxError unchanged, never as "not JSON"', () => {
    const failure = new RangeError('Invalid string length');
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw failure;
    });
    const dropped = vi.fn();
    const error = thrown(() => parseDoc('semantic', '{}', '/memory/k/semantic.json', dropped));
    // The parser was given the text parseDoc was handed, once.
    expect(parse.mock.calls).toEqual([['{}']]);
    expect(error).toBe(failure);
    expect(dropped).not.toHaveBeenCalled();
  });
});

describe('jsonErrorPosition', () => {
  // The offset of the first character that cannot continue a JSON value, or the text's length when it ends too soon
  // (store.ts). Each is also the position Node 22.13.1's JSON.parse names for the same text where its message names
  // one (read 2026-10-10); those it does not name ([fals], [nul], ["A",], "\) follow from the definition.
  it.each([
    ['{"a', 3],
    ['"a\nb"', 2],
    ['"\\u00G1"', 5],
    ['"\\u00', 5],
    ['"\\', 2],
    ['["\\u0041",]', 10],
    ['{"a":"b\\n",}', 11],
    ['{"a"1}', 4],
    ['{} x', 3],
    ['[] x', 3],
    ['[1] x', 4],
    ['[1 2]', 3],
    ['[fals]', 5],
    ['[nul]', 4],
    ['[-]', 2],
    ['-', 1],
    ['[1.]', 3],
    ['1.', 2],
    ['[1e+]', 4],
    ['[1e]', 3],
    ['{"a":-0.5e-3,}', 13],
    ['[true,false,null}', 16],
    ['{"a":null 1}', 10],
  ])('finds where %j breaks: %i', (text, position) => {
    expect(() => {
      JSON.parse(text);
    }).toThrow(SyntaxError);
    expect(jsonErrorPosition(text)).toBe(position);
  });

  // Nested deeper than a call stack goes: a hundred thousand levels each (a plain recursion that deep overflows Node
  // 22.13.1's default stack, read 2026-10-10). JSON.parse refuses every depth with a SyntaxError, so this must answer
  // for each of them too. The first two end too soon ("Unexpected end of JSON input", Node 22.13.1, read 2026-10-10),
  // so the position is the text's length: 100,000 "[" of one character, and 100,000 '{"a":' of five; for the last two
  // Node 22.13.1 names 200001 and 800000 (read 2026-10-10).
  it.each([
    ['a hundred thousand "["', 100_000, '['.repeat(100_000)],
    ['a hundred thousand \'{"a":\'', 500_000, '{"a":'.repeat(100_000)],
    ['a hundred thousand "[" all closed, then " x"', 200_001, `${'['.repeat(100_000)}${']'.repeat(100_000)} x`],
    [
      'a hundred thousand \'[{"a":\', the outermost closed by "}" where "]" belongs',
      800_000,
      `${'[{"a":'.repeat(100_000)}1${'}]'.repeat(99_999)}}}`,
    ],
  ])('finds where %s breaks, nested deeper than a call stack goes: %i', (_label, position, text) => {
    expect(() => {
      JSON.parse(text);
    }).toThrow(SyntaxError);
    expect(jsonErrorPosition(text)).toBe(position);
  });
});

describe('MemoryCache', () => {
  /** A cache over a real store on a temporary root: the store's read and write are spied (calling through), every failed save recorded. */
  async function cache(props: { readonly maxDocs?: number; readonly clock?: () => Date } = {}) {
    const { root, dropped, malformed, store: s } = await store();
    const save = s.write.bind(s);
    const read = vi.spyOn(s, 'read');
    const write = vi.spyOn(s, 'write');
    const failures: [Scope, Tier, unknown][] = [];
    const c = new MemoryCache({
      store: s,
      clock: props.clock ?? (() => new Date(NOW)),
      onSaveFailed: (scope, tier, error) => failures.push([scope, tier, error]),
      maxDocs: props.maxDocs ?? 100,
    });
    return { root, dropped, malformed, read, write, save, failures, cache: c };
  }

  it('shows a change at once, stamped by its clock, and it is on disk once the scope has settled', async () => {
    let now = EARLIER;
    const {
      root,
      dropped,
      malformed,
      read,
      write,
      save,
      failures,
      cache: c,
    } = await cache({ clock: () => new Date(now) });
    const gate = held();
    write.mockImplementationOnce(async (scope, doc) => {
      await gate.promise;
      await save(scope, doc);
    });
    expect(await c.get<SessionDoc>(ALICE, 'session')).toEqual(session([], EARLIER));
    now = NOW;
    const changed = session([TURN]);
    expect(await c.update<SessionDoc>(ALICE, 'session', (d) => ({ ...d, turns: [...d.turns, TURN] }))).toEqual(changed);
    expect(await c.get<SessionDoc>(ALICE, 'session')).toEqual(changed);
    expect(await readdir(root)).toEqual([]);
    const settled = c.settled(ALICE);
    gate.release();
    await settled;
    expect(await onDisk(root, ALICE_KEY, 'session')).toEqual(changed);
    expect(read.mock.calls).toEqual([[ALICE, 'session', EARLIER]]);
    expect(write.mock.calls).toEqual([[ALICE, changed]]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("saves one file's changes one after another, in order, so the last change is what is on disk", async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache();
    const gate = held();
    const events: string[] = [];
    write.mockImplementation(async (scope, doc) => {
      const ids = (doc as SearchableDoc).records.map((r) => r.id).join('');
      events.push(`start ${ids}`);
      if (events.length === 1) await gate.promise;
      await save(scope, doc);
      events.push(`end ${ids}`);
    });
    // The first change's save starts and is held; two more changes arrive while it runs.
    expect(await c.update<SearchableDoc>(ALICE, 'semantic', add('a'))).toEqual(semantic([record('a')]));
    const later = [
      c.update<SearchableDoc>(ALICE, 'semantic', add('b')),
      c.update<SearchableDoc>(ALICE, 'semantic', add('c')),
    ];
    const settled = c.settled(ALICE);
    gate.release();
    await settled;
    const last = semantic([record('a'), record('b'), record('c')]);
    expect(await Promise.all(later)).toEqual([semantic([record('a'), record('b')]), last]);
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(last);
    // Checked after that get, so they show it saved nothing either. A save writes the whole document as it is when that
    // save runs (cache.ts: "writes the whole document again").
    expect(events).toEqual(['start a', 'end a', 'start abc', 'end abc', 'start abc', 'end abc']);
    expect(write.mock.calls).toEqual([
      [ALICE, semantic([record('a')])],
      [ALICE, last],
      [ALICE, last],
    ]);
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(last);
    expect(read.mock.calls).toEqual([[ALICE, 'semantic', NOW]]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('reports a failed save with its scope and tier, keeps the change, and the next save writes the whole document', async () => {
    const { root, dropped, malformed, read, write, failures, cache: c } = await cache();
    const diskFull = new Error('disk full');
    write.mockRejectedValueOnce(diskFull);
    const one = semantic([record('x')]);
    expect(
      await c.update<SearchableDoc>(ALICE, 'semantic', (d) => ({ ...d, records: [...d.records, record('x')] })),
    ).toEqual(one);
    await c.settled(ALICE);
    expect(failures).toEqual([[ALICE, 'semantic', diskFull]]);
    expect(present(failures[0], 'failures[0]')[2]).toBe(diskFull);
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(one);
    expect(await readdir(root)).toEqual([]);
    const both = semantic([record('x'), record('y')]);
    expect(
      await c.update<SearchableDoc>(ALICE, 'semantic', (d) => ({ ...d, records: [...d.records, record('y')] })),
    ).toEqual(both);
    await c.settled(ALICE);
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(both);
    expect(write.mock.calls).toEqual([
      [ALICE, one],
      [ALICE, both],
    ]);
    expect(failures).toEqual([[ALICE, 'semantic', diskFull]]);
    expect(read.mock.calls).toEqual([[ALICE, 'semantic', NOW]]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  // The owner's answer of 2026-10-11, record memory-cache-failed-save, option (a) "Keep it until a later save
  // succeeds": a document whose last save failed stays cached, exempt from the bound, so a change reported as unsaved is
  // never dropped afterwards; once a later save of it succeeds, the bound applies to it again.
  it('keeps a document whose last save failed past its bound, through a second failed save, until a later save writes it whole; then drops it', async () => {
    const { root, dropped, malformed, read, write, failures, cache: c } = await cache({ maxDocs: 1 });
    const diskFull = new Error('disk full');
    const stillFull = new Error('disk still full');
    write.mockRejectedValueOnce(diskFull).mockRejectedValueOnce(stillFull);
    const x = semantic([record('x')]);
    expect(await c.update<SearchableDoc>(ALICE, 'semantic', add('x'))).toEqual(x);
    await c.settled(ALICE);
    expect(failures).toEqual([[ALICE, 'semantic', diskFull]]);
    // A second document passes the bound of one. Alice's has no save pending, but its last save failed, so it stays;
    // Bob's, with nothing unsaved, is the one dropped.
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(semantic([]));
    // Alice's change is served from the cache, never read again from disk, which holds nothing of it.
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(x);
    expect(await readdir(root)).toEqual([]);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    // Its next save fails too: it is still held, and Bob's document, loaded again, is dropped again.
    const xy = semantic([record('x'), record('y')]);
    expect(await c.update<SearchableDoc>(ALICE, 'semantic', add('y'))).toEqual(xy);
    await c.settled(ALICE);
    expect(failures).toEqual([
      [ALICE, 'semantic', diskFull],
      [ALICE, 'semantic', stillFull],
    ]);
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(semantic([]));
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(xy);
    expect(await readdir(root)).toEqual([]);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    // A later save succeeds, and writes the whole document: every change the failed saves did not.
    const xyz = semantic([record('x'), record('y'), record('z')]);
    expect(await c.update<SearchableDoc>(ALICE, 'semantic', add('z'))).toEqual(xyz);
    await c.settled(ALICE);
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(xyz);
    // Saved, it is dropped like any other when a document passes the bound, and read back from disk when next used.
    expect(await c.get<SearchableDoc>(BOB, 'episodic')).toEqual(EMPTY_EPISODIC);
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(xyz);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'episodic', NOW],
      [ALICE, 'semantic', NOW],
    ]);
    expect(write.mock.calls).toEqual([
      [ALICE, x],
      [ALICE, xy],
      [ALICE, xyz],
    ]);
    // Each failure reported once, with the error the store threw.
    expect(failures).toEqual([
      [ALICE, 'semantic', diskFull],
      [ALICE, 'semantic', stillFull],
    ]);
    expect(failures.map(([, , error]) => error)).toStrictEqual([diskFull, stillFull]);
    expect(present(failures[0], 'failures[0]')[2]).toBe(diskFull);
    expect(present(failures[1], 'failures[1]')[2]).toBe(stillFull);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("never mixes users: one user's change is not in another user's document or file", async () => {
    const { root, dropped, malformed, read, write, failures, cache: c } = await cache();
    const alice = semantic([record('a', 'alice fact')]);
    const bob = semantic([record('b', 'bob fact')]);
    expect(
      await Promise.all([
        c.update<SearchableDoc>(ALICE, 'semantic', (d) => ({
          ...d,
          records: [...d.records, record('a', 'alice fact')],
        })),
        c.update<SearchableDoc>(BOB, 'semantic', (d) => ({ ...d, records: [...d.records, record('b', 'bob fact')] })),
      ]),
    ).toEqual([alice, bob]);
    await Promise.all([c.settled(ALICE), c.settled(BOB)]);
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(alice);
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(bob);
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(alice);
    expect(await onDisk(root, BOB_KEY, 'semantic')).toEqual(bob);
    // The two users' loads and saves run side by side, so the order between them is not part of the contract.
    const byUser = <C extends readonly [Scope, ...unknown[]]>(calls: C[]): C[] =>
      [...calls].sort((p, q) => p[0].user.localeCompare(q[0].user));
    expect(byUser(read.mock.calls)).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    expect(byUser(write.mock.calls)).toEqual([
      [ALICE, alice],
      [BOB, bob],
    ]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('drops the least recently used document past its bound, and reads it from disk again when next used', async () => {
    const { root, dropped, malformed, read, write, failures, cache: c } = await cache({ maxDocs: 2 });
    const doc = (text: string): SearchableDoc => semantic([record('m', text)], EARLIER);
    await put(root, ALICE_KEY, 'semantic.json', JSON.stringify(doc('alice v1')));
    await put(root, BOB_KEY, 'semantic.json', JSON.stringify(doc('bob v1')));
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(doc('alice v1'));
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(doc('bob v1'));
    // Alice's document was loaded first but is now the more recently used; a third document passes the bound.
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(doc('alice v1'));
    expect(await c.get<SearchableDoc>(BOB, 'episodic')).toEqual(EMPTY_EPISODIC);
    // Both files change behind the cache: only the dropped document is read again.
    await put(root, ALICE_KEY, 'semantic.json', JSON.stringify(doc('alice v2')));
    await put(root, BOB_KEY, 'semantic.json', JSON.stringify(doc('bob v2')));
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(doc('alice v1'));
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(doc('bob v2'));
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'episodic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    expect(write).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('keeps a document whose save is pending past its bound, and drops it once the save is done', async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache({ maxDocs: 1 });
    const gate = held();
    write.mockImplementationOnce(async (scope, doc) => {
      await gate.promise;
      await save(scope, doc);
    });
    const remembered = semantic([record('r', 'remember this')]);
    expect(
      await c.update<SearchableDoc>(ALICE, 'semantic', (d) => ({
        ...d,
        records: [...d.records, record('r', 'remember this')],
      })),
    ).toEqual(remembered);
    // A second document passes the bound of one. Alice's is the least recently used, but its save is held, so it stays.
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(semantic([]));
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(remembered);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    const settled = c.settled(ALICE);
    gate.release();
    await settled;
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(remembered);
    // Saved, it is dropped like any other when a document passes the bound, and read back from disk.
    expect(await c.get<SearchableDoc>(BOB, 'episodic')).toEqual(EMPTY_EPISODIC);
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(remembered);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'episodic', NOW],
      [ALICE, 'semantic', NOW],
    ]);
    expect(write.mock.calls).toEqual([[ALICE, remembered]]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('drops the least recently used document with no save pending, past one whose save is pending, when a load passes the bound', async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache({ maxDocs: 2 });
    const gate = held();
    write.mockImplementationOnce(async (scope, doc) => {
      await gate.promise;
      await save(scope, doc);
    });
    const remembered = semantic([record('r')]);
    expect(await c.update<SearchableDoc>(ALICE, 'semantic', add('r'))).toEqual(remembered);
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(semantic([]));
    // A third document passes the bound of two. Alice's is the least recently used, but its save is held, so it stays;
    // Bob's semantic document comes next and has no save pending, so it is the one dropped (cache.ts: "the least
    // recently used ones with no save pending are dropped past it").
    expect(await c.get<SearchableDoc>(BOB, 'episodic')).toEqual(EMPTY_EPISODIC);
    // Bob's semantic file changes behind the cache. Alice's save is still held: nothing of hers is on disk yet.
    const changed = semantic([record('b', 'bob v2')], EARLIER);
    await put(root, BOB_KEY, 'semantic.json', JSON.stringify(changed));
    expect(await readdir(root)).toEqual([BOB_KEY]);
    // The two documents kept are served from the cache, and only the dropped one is read again, showing the change.
    expect(await c.get<SearchableDoc>(BOB, 'episodic')).toEqual(EMPTY_EPISODIC);
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(remembered);
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(changed);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'episodic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    const settled = c.settled(ALICE);
    gate.release();
    await settled;
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(remembered);
    // Waiting for the save read nothing more.
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'episodic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    expect(write.mock.calls).toEqual([[ALICE, remembered]]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  // cache.ts: a change is applied to the cached copy, one file's saves run one after another, and settled() waits for
  // every save queued for the scope. A document an update is changing is therefore never dropped, whatever the bound.
  // The cache holds more than its bound only while saves are pending or failing (docs/architecture/memory.md#tiers,
  // Cache): once they are done, the next load drops every document it may, back to the bound, not just one.
  it('keeps a document an update loads past its bound, every other one having a save pending: its changes stay on one copy, its saves in one line, and settled waits for them; once both are saved, the next load drops both, back to its bound', async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache({ maxDocs: 1 });
    const aliceGate = held();
    const bobGate = held();
    const events: string[] = [];
    write
      .mockImplementationOnce(async (scope, doc) => {
        await aliceGate.promise;
        await save(scope, doc);
      })
      .mockImplementationOnce(async (scope, doc) => {
        events.push('first save of bob starts');
        await bobGate.promise;
        await save(scope, doc);
        events.push('first save of bob done');
      })
      .mockImplementationOnce(async (scope, doc) => {
        await save(scope, doc);
        events.push('second save of bob done');
      });
    const remembered = semantic([record('r')]);
    expect(await c.update<SearchableDoc>(ALICE, 'semantic', add('r'))).toEqual(remembered);
    // Alice's save is held, so the bound of one is full with a save pending when Bob's document loads for an update.
    const first = semantic([record('b1')]);
    expect(await c.update<SearchableDoc>(BOB, 'semantic', add('b1'))).toEqual(first);
    // The next change builds on the cached copy, not on the file, whose first save is still held.
    const both = semantic([record('b1'), record('b2')]);
    expect(await c.update<SearchableDoc>(BOB, 'semantic', add('b2'))).toEqual(both);
    // Past its bound of one, the cache holds both documents, each with a save pending, and serves each without a read:
    // the bound drops only documents with no save pending (cache.ts), so it is not a hard maximum.
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(remembered);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    const bobSettled = c.settled(BOB).then(() => events.push('bob settled'));
    bobGate.release();
    await bobSettled;
    expect(events).toEqual([
      'first save of bob starts',
      'first save of bob done',
      'second save of bob done',
      'bob settled',
    ]);
    expect(await onDisk(root, BOB_KEY, 'semantic')).toEqual(both);
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(both);
    const aliceSettled = c.settled(ALICE);
    aliceGate.release();
    await aliceSettled;
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(remembered);
    // Bob's document was read once; each save wrote the whole document as it was when that save ran.
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
    ]);
    expect(write.mock.calls).toEqual([
      [ALICE, remembered],
      [BOB, first],
      [BOB, both],
    ]);
    // Both saves are done, and the cache still holds both documents against its bound of one, Bob's the more recently
    // used. A third document's load passes the bound by two, and drops both, Alice's and then Bob's: so Bob's, used
    // next, is read from disk again (were only one dropped, it would be Alice's, and Bob's would be served with no
    // read), and then Alice's, which is read again too.
    expect(await c.get<SearchableDoc>(BOB, 'episodic')).toEqual(EMPTY_EPISODIC);
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(both);
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(remembered);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'episodic', NOW],
      [BOB, 'semantic', NOW],
      [ALICE, 'semantic', NOW],
    ]);
    expect(write.mock.calls).toEqual([
      [ALICE, remembered],
      [BOB, first],
      [BOB, both],
    ]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('keeps a cached document an update has found but not yet changed when another load passes the bound in between', async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache({ maxDocs: 2 });
    const aliceGate = held();
    const bobGate = held();
    write
      .mockImplementationOnce(async (scope, doc) => {
        await aliceGate.promise;
        await save(scope, doc);
      })
      .mockImplementationOnce(async (scope, doc) => {
        await bobGate.promise;
        await save(scope, doc);
      });
    const remembered = semantic([record('r')]);
    expect(await c.update<SearchableDoc>(ALICE, 'semantic', add('r'))).toEqual(remembered);
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(semantic([]));
    // Two documents are cached, Alice's with its save held. Bob's episodic document is read at once (no disk), so its
    // load ends after the update below has found Bob's cached semantic document and before it has changed it; that
    // load passes the bound of two.
    read.mockResolvedValueOnce(EMPTY_EPISODIC);
    const episodic = c.get<SearchableDoc>(BOB, 'episodic');
    // The order rests on microtasks, so it is observed rather than assumed. A reaction added now to the promise the read
    // returned — the one the load is awaiting — runs after the load's own: once it has run, the load has ended and passed
    // the bound. Were the read to take a tick more, the change would run first, with a save pending, and this test would
    // no longer test its case; `endedWhenChanged` then fails it.
    const readOfEpisodic = present(read.mock.results.at(-1), 'read.mock.results.at(-1)');
    expect(readOfEpisodic.type).toBe('return');
    let ended = false;
    const loadEnded = (readOfEpisodic.value as Promise<unknown>).then(() => {
      ended = true;
    });
    let endedWhenChanged: boolean | undefined;
    const first = semantic([record('b')]);
    const change = c.update<SearchableDoc>(BOB, 'semantic', (d) => {
      endedWhenChanged = ended;
      return add('b')(d);
    });
    // The update has found Bob's semantic document in the cache (no read for it) while the episodic load is still going.
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'episodic', NOW],
    ]);
    expect(ended).toBe(false);
    expect(await Promise.all([episodic, change, loadEnded])).toEqual([EMPTY_EPISODIC, first, undefined]);
    // And the load had ended, past the bound, before the update changed the document.
    expect(endedWhenChanged).toBe(true);
    // The next change builds on the cached copy, not on the file, whose save is still held.
    const both = semantic([record('b'), record('c')]);
    expect(await c.update<SearchableDoc>(BOB, 'semantic', add('c'))).toEqual(both);
    const bobSettled = c.settled(BOB);
    bobGate.release();
    await bobSettled;
    expect(await onDisk(root, BOB_KEY, 'semantic')).toEqual(both);
    expect(await c.get<SearchableDoc>(BOB, 'semantic')).toEqual(both);
    const aliceSettled = c.settled(ALICE);
    aliceGate.release();
    await aliceSettled;
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(remembered);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [BOB, 'semantic', NOW],
      [BOB, 'episodic', NOW],
    ]);
    expect(write.mock.calls).toEqual([
      [ALICE, remembered],
      [BOB, first],
      [BOB, both],
    ]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('shares one load among uses of a document that start while it loads: one read, one copy, one line of saves', async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache();
    // Each save records when it starts and ends, and the first is held until the test lets it go: a second save that
    // did not wait in line behind the first would start while the first is held.
    const gate = held();
    const events: string[] = [];
    write.mockImplementation(async (scope, doc) => {
      const ids = (doc as SearchableDoc).records.map((r) => r.id).join('');
      events.push(`start ${ids}`);
      if (events.length === 1) await gate.promise;
      await save(scope, doc);
      events.push(`end ${ids}`);
    });
    // Nothing is cached: the second update starts before the document has loaded, so it waits on the first one's load.
    // Its change records how many saves had started when it ran.
    const a = semantic([record('a')]);
    const ab = semantic([record('a'), record('b')]);
    let savesStartedAtSecondChange: number | undefined;
    const second = (d: SearchableDoc): SearchableDoc => {
      savesStartedAtSecondChange = write.mock.calls.length;
      return add('b')(d);
    };
    expect(
      await Promise.all([
        c.update<SearchableDoc>(ALICE, 'semantic', add('a')),
        c.update<SearchableDoc>(ALICE, 'semantic', second),
      ]),
    ).toEqual([a, ab]);
    const settled = c.settled(ALICE);
    gate.release();
    await settled;
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(ab);
    // One read, and one copy: the second change was made to the document the first had changed, and the get above was
    // served from that copy, reading nothing (checked after it, as the saves below are).
    expect(read.mock.calls).toEqual([[ALICE, 'semantic', NOW]]);
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(ab);
    // One line of two saves: the second started only once the first had ended, and wrote ab. A save writes the whole
    // document as it is when that save runs (cache.ts), so the first wrote a if it started before the second change
    // landed, and ab if after. Which comes first rests on microtasks and no document fixes it, so either is right; what
    // is fixed is that each save wrote the copy as it then was.
    expect([
      {
        savesStartedAtSecondChange: 1,
        events: ['start a', 'end a', 'start ab', 'end ab'],
        saves: [
          [ALICE, a],
          [ALICE, ab],
        ],
      },
      {
        savesStartedAtSecondChange: 0,
        events: ['start ab', 'end ab', 'start ab', 'end ab'],
        saves: [
          [ALICE, ab],
          [ALICE, ab],
        ],
      },
    ]).toContainEqual({ savesStartedAtSecondChange, events, saves: write.mock.calls });
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  // cache.ts: an update is registered "before any await, so settled() called right after this also waits for it", and
  // settled() waits first for "every update still loading or changing its document (it will queue a save), then every
  // queued save". While the document loads it is not cached yet, so only that registration ties settled() to the save.
  it('waits, in a settled() called while an update is still loading its document, for that update and then its save', async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache();
    const gate = held();
    const events: string[] = [];
    write.mockImplementationOnce(async (scope, doc) => {
      events.push('save starts');
      await gate.promise;
      await save(scope, doc);
      events.push('save done');
    });
    const a = semantic([record('a')]);
    // Nothing is cached, and nothing is awaited between the two calls, so settled() is called while the update's load
    // has begun (its read was called) and cannot yet have ended.
    const change = c.update<SearchableDoc>(ALICE, 'semantic', add('a'));
    expect(read.mock.calls).toEqual([[ALICE, 'semantic', NOW]]);
    const settled = c.settled(ALICE).then(() => events.push('settled'));
    expect(await change).toEqual(a);
    // The update has loaded and changed the document, and its save has started and is held. Reading the folder takes a
    // turn of the event loop, so every reaction already due has run by the time it returns: settled() has not resolved.
    expect(await readdir(root)).toEqual([]);
    expect(events).toEqual(['save starts']);
    gate.release();
    await settled;
    expect(events).toEqual(['save starts', 'save done', 'settled']);
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(a);
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(a);
    expect(read.mock.calls).toEqual([[ALICE, 'semantic', NOW]]);
    expect(write.mock.calls).toEqual([[ALICE, a]]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  // cache.ts: settled() "Resolves once every save queued so far for this scope has finished (or failed and been
  // reported)", and one called right after an update "also waits for it". An update that fails before it queues a save
  // (its load fails, or its change throws) rejects to its own caller, which reports it (AgentMemory.write ->
  // onWriteFailed); it queued no save, so onSaveFailed hears nothing of it. A settled() called while such an update is in
  // flight still resolves, never rejecting with that update's error, and only once the scope's other work is done: here
  // an update of the session, in flight beside it, whose save is held until the test lets it go.
  it("resolves, never rejects, in a settled() called while an update whose load will fail is in flight, and only once the scope's other save is done: the update alone rejects, with the read's own error, and nothing is saved for it or reported as a failed save", async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache();
    // The semantic file is a directory, so its read fails with EISDIR (as in "fails a get or an update of a document
    // that cannot be read", below).
    await mkdir(join(root, ALICE_KEY, 'semantic.json'), { recursive: true });
    const gate = held();
    const events: string[] = [];
    write.mockImplementationOnce(async (scope, doc) => {
      events.push('save starts');
      await gate.promise;
      await save(scope, doc);
      events.push('save done');
    });
    const change = vi.fn(add('a'));
    // Nothing is cached and nothing is awaited between these calls, so settled() is called while both updates are
    // loading their documents (both reads were called) and neither can yet have ended.
    const failing = c.update<SearchableDoc>(ALICE, 'semantic', change);
    const other = c.update<SessionDoc>(ALICE, 'session', (d) => ({ ...d, turns: [...d.turns, TURN] }));
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [ALICE, 'session', NOW],
    ]);
    // Records settled() resolving, or rejecting and with what.
    const settled = c.settled(ALICE).then(
      () => {
        events.push('settled');
      },
      (error: unknown) => {
        events.push('settled rejected');
        return error;
      },
    );
    expect(fsError(await rejection(failing))).toEqual(EISDIR);
    expect(await other).toEqual(session([TURN]));
    // Both updates have ended, and the session's save has started and is held. Reading the folder takes a turn of the
    // event loop, so every reaction already due has run by the time it returns: settled() has neither resolved nor
    // rejected, and the session is not on disk yet.
    expect(await readdir(join(root, ALICE_KEY))).toEqual(['semantic.json']);
    expect(events).toEqual(['save starts']);
    gate.release();
    // It resolved (undefined), not rejected with the update's error, and only once the session's save was done.
    expect(await settled).toBeUndefined();
    expect(events).toEqual(['save starts', 'save done', 'settled']);
    expect(await onDisk(root, ALICE_KEY, 'session')).toEqual(session([TURN]));
    expect(change).not.toHaveBeenCalled();
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [ALICE, 'session', NOW],
    ]);
    expect(write.mock.calls).toEqual([[ALICE, session([TURN])]]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("resolves, never rejects, in a settled() called while an update whose change will throw is in flight, and only once the scope's other save is done: the update alone rejects, with the change's own error, and its document stays as it was, cached and on disk", async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache();
    const before = semantic([record('x')], EARLIER);
    await put(root, ALICE_KEY, 'semantic.json', JSON.stringify(before));
    const gate = held();
    const events: string[] = [];
    write.mockImplementationOnce(async (scope, doc) => {
      events.push('save starts');
      await gate.promise;
      await save(scope, doc);
      events.push('save done');
    });
    const refused = new Error('the change refused the document');
    const change = vi.fn((): SearchableDoc => {
      throw refused;
    });
    // Nothing is cached and nothing is awaited between these calls, so settled() is called while both updates are
    // loading their documents (both reads were called): the change has not run yet.
    const failing = c.update<SearchableDoc>(ALICE, 'semantic', change);
    const other = c.update<SessionDoc>(ALICE, 'session', (d) => ({ ...d, turns: [...d.turns, TURN] }));
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [ALICE, 'session', NOW],
    ]);
    expect(change).not.toHaveBeenCalled();
    // Records settled() resolving, or rejecting and with what.
    const settled = c.settled(ALICE).then(
      () => {
        events.push('settled');
      },
      (error: unknown) => {
        events.push('settled rejected');
        return error;
      },
    );
    expect(await rejection(failing)).toBe(refused);
    expect(await other).toEqual(session([TURN]));
    // Both updates have ended, and the session's save has started and is held. Reading the folder takes a turn of the
    // event loop, so every reaction already due has run by the time it returns: settled() has neither resolved nor
    // rejected, and the session is not on disk yet.
    expect(await readdir(join(root, ALICE_KEY))).toEqual(['semantic.json']);
    expect(events).toEqual(['save starts']);
    gate.release();
    // It resolved (undefined), not rejected with the change's error, and only once the session's save was done.
    expect(await settled).toBeUndefined();
    expect(events).toEqual(['save starts', 'save done', 'settled']);
    expect(await onDisk(root, ALICE_KEY, 'session')).toEqual(session([TURN]));
    // The change was given the document as loaded, once, and threw: the cached copy is that document, unchanged and not
    // restamped, served with no further read, and its file is as it was.
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(before);
    expect(change.mock.calls).toEqual([[before]]);
    expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(before);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [ALICE, 'session', NOW],
    ]);
    expect(write.mock.calls).toEqual([[ALICE, session([TURN])]]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });

  // The store heals a malformed file (record memory-unreadable-session-episodic, above), so a get of one is the tier's
  // empty document, reported once and cached like any other.
  it.each<[string, string]>([
    ['{nope', 'not JSON (SyntaxError at position 1)'],
    [
      JSON.stringify({ schemaVersion: 2, tier: 'semantic', updatedAt: NOW, records: [] }),
      'expected schemaVersion 1 and tier "semantic"',
    ],
  ])(
    'gets the empty document for a file that is not a document of its tier, %j: reported once, overwritten, and cached',
    async (content, reason) => {
      const { root, dropped, malformed, read, write, failures, cache: c } = await cache();
      const file = await put(root, ALICE_KEY, 'semantic.json', content);
      expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(semantic([]));
      expect(malformed.map(([f, e]) => [f, invalidFile(e)])).toEqual([[file, refusedFile(file, reason)]]);
      expect(await readFile(file, 'utf8')).toBe(EMPTY_BYTES['semantic']);
      expect(await readdir(join(root, ALICE_KEY))).toEqual(['semantic.json']);
      // Cached: a second get is served without a read, and an update builds on it and saves it.
      expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(semantic([]));
      expect(await c.update<SearchableDoc>(ALICE, 'semantic', add('a'))).toEqual(semantic([record('a')]));
      await c.settled(ALICE);
      expect(await onDisk(root, ALICE_KEY, 'semantic')).toEqual(semantic([record('a')]));
      expect(read.mock.calls).toEqual([[ALICE, 'semantic', NOW]]);
      // The store's write ran twice: the overwrite, from inside the read, then the update's save.
      expect(write.mock.calls).toEqual([
        [ALICE, semantic([])],
        [ALICE, semantic([record('a')])],
      ]);
      expect(malformed).toHaveLength(1);
      expect(failures).toEqual([]);
      expect(dropped).toEqual([]);
    },
  );

  it("fails a get with the overwrite's own error when a malformed file cannot be overwritten, after reporting it; caches nothing, so the next get heals it", async () => {
    const { root, dropped, malformed, read, write, save, failures, cache: c } = await cache();
    const NOT_A_DOCUMENT = '{"schemaVersion":2}';
    const file = await put(root, ALICE_KEY, 'semantic.json', NOT_A_DOCUMENT);
    const diskFull = new Error('disk full');
    // How many reports had been made as each overwrite began: the report comes first, so it is never lost.
    const reportsAtWrite: number[] = [];
    write
      .mockImplementationOnce(() => {
        reportsAtWrite.push(malformed.length);
        return Promise.reject(diskFull);
      })
      .mockImplementationOnce(async (scope, doc) => {
        reportsAtWrite.push(malformed.length);
        await save(scope, doc);
      });
    expect(await rejection(c.get<SearchableDoc>(ALICE, 'semantic'))).toBe(diskFull);
    const report = [file, refusedFile(file, 'expected schemaVersion 1 and tier "semantic"')];
    expect(malformed.map(([f, e]) => [f, invalidFile(e)])).toEqual([report]);
    expect(reportsAtWrite).toEqual([1]);
    expect(await readFile(file, 'utf8')).toBe(NOT_A_DOCUMENT);
    // Nothing was cached: the next get reads the file again, reports it again, and this time overwrites it.
    expect(await c.get<SearchableDoc>(ALICE, 'semantic')).toEqual(semantic([]));
    expect(malformed.map(([f, e]) => [f, invalidFile(e)])).toEqual([report, report]);
    expect(reportsAtWrite).toEqual([1, 2]);
    expect(await readFile(file, 'utf8')).toBe(EMPTY_BYTES['semantic']);
    expect(await readdir(join(root, ALICE_KEY))).toEqual(['semantic.json']);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [ALICE, 'semantic', NOW],
    ]);
    expect(write.mock.calls).toEqual([
      [ALICE, semantic([])],
      [ALICE, semantic([])],
    ]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('fails a get or an update of a document that cannot be read, and never caches it as empty', async () => {
    const { root, dropped, malformed, read, write, failures, cache: c } = await cache();
    await mkdir(join(root, ALICE_KEY, 'semantic.json'), { recursive: true });
    const change = vi.fn((d: SearchableDoc) => d);
    expect(fsError(await rejection(c.get<SearchableDoc>(ALICE, 'semantic')))).toEqual(EISDIR);
    expect(fsError(await rejection(c.update<SearchableDoc>(ALICE, 'semantic', change)))).toEqual(EISDIR);
    await c.settled(ALICE);
    expect(read.mock.calls).toEqual([
      [ALICE, 'semantic', NOW],
      [ALICE, 'semantic', NOW],
    ]);
    expect(change).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(malformed).toEqual([]);
  });
});
