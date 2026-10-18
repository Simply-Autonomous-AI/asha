// The memory image's side of persistence (docs/plans/agent-persistence.md R12, R15, R16; A10, A15, A16): its
// erase mode deletes exactly one user's scope folder, parsing no memory file, and prints exactly one line; its
// persisted /memory is validated at start; a MemoryStore.write that fails rejects with its own error (or, when it
// cannot remove its temporary either, with MemoryWriteCleanupFailed carrying both) and leaves only what that
// validation passes; and a memory file that is not JSON is reported by where it breaks, never by quoting it.

import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// readdir calls through to the real one, and records every folder the code under test lists: the tests' own listings
// use the real one (tree), so the spy holds only the code's. Node's readdir lists a folder in name order on this Mac
// (seen 2026-10-10), so one test hands validateMemory its listings out of order: only that shows validateMemory sorts
// them itself. rm calls through to the real one too, recording what the code deletes (the tests' own removals use the
// real one), so a test can make one deletion fail. readFile calls through as well, recording every file the code
// reads (the tests' own reads use the real one): an erase that reads no file parses none, by any route — parseDoc,
// MemoryStore.read or JSON.parse. rename calls through too, recording what each MemoryStore.write renames and what
// that settled with, so a test can name the rename's own error as the very one a write's error carries — and that the
// erase and validateMemory rename nothing. writeFile calls through as well, recording every temporary the code writes
// and with what text (the tests' own files are written with the real one, put), so a test can make the write of a
// temporary fail, every MemoryStore.write test names each file it wrote and the text, and every erase and
// validateMemory test shows they write nothing: R16 has the erase delete one scope folder and "change nothing else",
// and validation at start (R12) validates, removing only a write's temporary (docs/architecture/memory.md#persisted).
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

// MemoryStore.write names its temporary by the time and four random bytes (store.ts). randomBytes is strict: it gives
// only the bytes a test hands it, and fails any call a test did not arrange, so a temporary's name is a literal.
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: vi.fn(() => {
      throw new Error('randomBytes was called by a test that did not arrange it');
    }),
  };
});

vi.mock('../../../images/memory/src/memory/store.js', async (original) => {
  const actual = await original<typeof import('../../../images/memory/src/memory/store.js')>();
  return { ...actual, parseDoc: vi.fn(actual.parseDoc) };
});

import { randomBytes } from 'node:crypto';

import {
  eraseUser,
  parseEraseArgs,
  runEraseMode,
  validateMemory,
} from '../../../images/memory/src/memory/persisted.js';
import {
  MemoryFileInvalid,
  MemoryStore,
  MemoryWriteCleanupFailed,
  jsonErrorPosition,
  parseDoc,
} from '../../../images/memory/src/memory/store.js';
import type { TierDoc } from '../../../images/memory/src/memory/types.js';
import { present } from '../../../src/shared/assert-present.js';
import { byCodeUnit } from '../../../src/shared/order.js';
import { userIdProblem } from '../../../src/shared/protocol.js';

// sha256("<channel>/<user>"), first 16 hex digits (docs/architecture/memory.md#where), computed with
// `printf 'lab/ivy' | shasum -a 256` rather than by the code under test: the erase deletes the folder by this name.
const IVY = '6f529f82f0b84bb3'; // lab/ivy
const JACK = '0ef25b05ba5defbe'; // lab/jack — sorts before IVY

const doc = (tier: string, records: unknown[] = []) =>
  JSON.stringify(
    tier === 'session'
      ? { schemaVersion: 1, tier, updatedAt: 't', turns: records }
      : { schemaVersion: 1, tier, updatedAt: 't', records },
  );
/** `doc`'s JSON, parsed and typed as the tier document it is — for a `MemoryStore.write` argument. */
const parsedDoc = (text: string): TierDoc => JSON.parse(text) as TierDoc;
/** A document cut off before its end: Node 22.13.1's JSON.parse names position 36, the text's length. */
const CUT_SHORT = '{"schemaVersion":1,"tier":"episodic"';
/** A file that is not JSON: another user's, in memoryRoot. */
const CORRUPT = '{"from":"zora","x":}';

// The erase counts bytes, and the daemon checks them against the tar sizes of the files removed (R16;
// src/daemon/agents/index.ts, subsetProblem), so the files it erases hold users' own words, as real memory does:
// JSON.stringify writes them unescaped, in UTF-8 (MemoryStore.write). "é" is two bytes, "—" three and "🙂" four, two
// UTF-16 code units, so each such file's bytes are not its length in characters, and an erase that counted characters
// would report another number. Every byte count in the erase tests was taken outside the code, with
// `printf '%s' '<the text>' | wc -c`.
/** Ivy's facts: 149 bytes, 144 UTF-16 code units. */
const IVY_FACTS =
  '{"schemaVersion":1,"tier":"semantic","updatedAt":"t","records":[{"id":"r1","ts":"t","text":"The user drinks café au lait — 🙂","embedding":[]}]}';
/** A file of ivy's that is not JSON (a comma before its end), in her words: 25 bytes, 20 UTF-16 code units. */
const NOT_JSON_WORDS = '{"text":"thé — 🙂",}';

/** memoryRoot's whole tree, as tree() reports it. Ivy's two documents are 149 + 63 = 212 bytes (doc('session'): 63). */
const MEMORY_ROOT = {
  [IVY]: 'folder',
  [`${IVY}/semantic.json`]: IVY_FACTS,
  [`${IVY}/session.json`]: doc('session'),
  [JACK]: 'folder',
  [`${JACK}/semantic.json`]: CORRUPT,
};
/** memoryRoot's tree once ivy's scope folder is gone: everything else exactly as it was. */
const JACK_ONLY = { [JACK]: 'folder', [`${JACK}/semantic.json`]: CORRUPT };

/** readdir's options in validateMemory's every listing. */
const WITH_TYPES = { withFileTypes: true };

/** The ivy erase's argv, exactly as the daemon passes it (R16). */
const ERASE_IVY = ['erase-user', '--channel', 'lab', '--user', 'ivy'];

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.mocked(readdir).mockReset();
  vi.mocked(readFile).mockReset();
  vi.mocked(rename).mockReset();
  vi.mocked(rm).mockReset();
  vi.mocked(writeFile).mockReset();
  vi.mocked(randomBytes).mockReset();
  vi.mocked(parseDoc).mockReset();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => real.rm(root, { recursive: true })));
});

/** A new temporary folder, removed after the test. */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asha-memroot-'));
  roots.push(root);
  return root;
}

/** A /memory holding ivy's two documents and, beside them, another user's corrupt file. */
async function memoryRoot(): Promise<string> {
  const root = await tempRoot();
  await mkdir(join(root, IVY));
  await mkdir(join(root, JACK));
  await put(join(root, IVY, 'semantic.json'), IVY_FACTS);
  await put(join(root, IVY, 'session.json'), doc('session'));
  // Another user's file, corrupt: the erase must neither parse it nor need it (R16), and never lists its folder.
  await put(join(root, JACK, 'semantic.json'), CORRUPT);
  return root;
}

/**
 * Everything under `root`, by its path relative to `root`: a folder as "folder", a link as "link to <its target>", a
 * file as its text. Listed and read with the real readdir and readFile, so the spies record only what the code under
 * test lists and reads.
 */
async function tree(root: string): Promise<Record<string, string>> {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const entries: Record<string, string> = {};
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const name of await real.readdir(folder)) {
      const path = join(folder, name);
      const key = `${prefix}${name}`;
      const entry = await lstat(path);
      if (entry.isDirectory()) {
        entries[key] = 'folder';
        await walk(path, `${key}/`);
      } else if (entry.isSymbolicLink()) entries[key] = `link to ${await readlink(path)}`;
      else if (entry.isFile()) entries[key] = await real.readFile(path, 'utf8');
      else throw new Error(`tree: ${path} is neither a folder, a link nor a file`);
    }
  };
  await walk(root, '');
  return entries;
}

/** A file's text, read with the real readFile, so the spy records only what the code under test reads. */
async function contents(path: string): Promise<string> {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return real.readFile(path, 'utf8');
}

/** Writes a test's own file with the real writeFile, so the spy records only what the code under test writes. */
async function put(path: string, text: string): Promise<void> {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await real.writeFile(path, text);
}

/** A clock for MemoryStore.write's temporaries: Date alone is faked, at a time of the file's own temporaries. */
const WRITE_MS = 1727600000000;
function pinClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WRITE_MS);
}

/** Recorded calls ordered by their first argument: for a listing whose order is not part of the contract. */
const byPath = (calls: readonly (readonly unknown[])[]) =>
  [...calls].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));

/** What a promise rejected with; undefined when it resolved. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/** What a function threw; undefined when it returned. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * A MemoryFileInvalid whole: its class, every field callers read, its cause, and the names of all its own properties.
 * A not-JSON file is reported by where it breaks, never by its message, which quotes the input (R15). The memory
 * image's error line carries only the message (logError in images/memory/src/main.ts), but any caller that describes
 * the cause chain (src/agent-sdk/log.ts) would show a cause, so a cause, or any field beside these, would show here.
 */
function invalid(error: unknown): { name: string; message: string; file: string; cause: unknown; own: string[] } {
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

/**
 * The MemoryFileInvalid naming `file` for `reason`, as docs/architecture/memory.md#persisted words it: no cause, and no
 * own property but its stack and these three.
 */
const refused = (file: string, reason: string) => ({
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

/** An erase run's io, its stdout and stderr each recorded. */
function io(root: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { root, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } };
}

describe('the erase mode (R16; A16)', () => {
  it("deletes exactly the user's scope folder, prints the one line with its files and bytes, exits 0 — with no ASHA_URL — and parses no memory file", async () => {
    // The daemon runs the erase with no ASHA_URL and no token (docs/architecture/memory.md#persisted): arranged here,
    // whatever the machine running the test has exported.
    vi.stubEnv('ASHA_URL', undefined);
    vi.stubEnv('ASHA_AGENT_TOKEN', undefined);
    const root = await memoryRoot();
    const run = io(root);
    expect(await runEraseMode(ERASE_IVY, run.io)).toBe(0);
    // Both files, every byte: 149 and 63 (in characters, 144 and 63).
    expect(run.out).toEqual(['{"erased":{"files":2,"bytes":212}}\n']);
    expect(run.err).toEqual([]);
    // It lists the scope folder only, never another user's, and deletes it whole, once.
    expect(vi.mocked(readdir).mock.calls).toEqual([[join(root, IVY)]]);
    expect(vi.mocked(rm).mock.calls).toEqual([[join(root, IVY), { recursive: true }]]);
    expect(await tree(root)).toEqual(JACK_ONLY);
    // The parseDoc spy sees only a call of the module's export; MemoryStore.read's parse and JSON.parse are not seen by
    // it. It reads no file at all, so it parses none by any route.
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('erases a user whose own documents are not JSON — what validateMemory refuses at start, so the erase is its remedy — parsing neither', async () => {
    // R16: in erase mode the image MUST NOT parse any memory file. Neither of ivy's documents here parses, so an erase
    // that parsed one — through parseDoc, MemoryStore.read or JSON.parse itself — would fail it: exit 1, nothing deleted.
    const root = await memoryRoot();
    await put(join(root, IVY, 'semantic.json'), CUT_SHORT);
    await put(join(root, IVY, 'session.json'), NOT_JSON_WORDS);
    expect(() => {
      JSON.parse(CUT_SHORT);
    }).toThrow(SyntaxError);
    expect(() => {
      JSON.parse(NOT_JSON_WORDS);
    }).toThrow(SyntaxError);
    expect(await tree(root)).toEqual({
      ...MEMORY_ROOT,
      [`${IVY}/semantic.json`]: CUT_SHORT,
      [`${IVY}/session.json`]: NOT_JSON_WORDS,
    });
    const run = io(root);
    expect(await runEraseMode(ERASE_IVY, run.io)).toBe(0);
    // Both files, every byte: 36 and 25 (in characters, 36 and 20).
    expect(run.out).toEqual(['{"erased":{"files":2,"bytes":61}}\n']);
    expect(run.err).toEqual([]);
    expect(vi.mocked(readdir).mock.calls).toEqual([[join(root, IVY)]]);
    expect(vi.mocked(rm).mock.calls).toEqual([[join(root, IVY), { recursive: true }]]);
    expect(await tree(root)).toEqual(JACK_ONLY);
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('deletes a link in the scope folder without following it: what it points to stays, and only regular files are counted', async () => {
    const root = await memoryRoot();
    await symlink(join(root, JACK, 'semantic.json'), join(root, IVY, 'episodic.json'));
    const run = io(root);
    expect(await runEraseMode(ERASE_IVY, run.io)).toBe(0);
    // Ivy's two documents, every byte: 149 and 63. The link and jack's 20 bytes it points to are not counted.
    expect(run.out).toEqual(['{"erased":{"files":2,"bytes":212}}\n']);
    expect(run.err).toEqual([]);
    expect(vi.mocked(readdir).mock.calls).toEqual([[join(root, IVY)]]);
    expect(vi.mocked(rm).mock.calls).toEqual([[join(root, IVY), { recursive: true }]]);
    expect(await tree(root)).toEqual(JACK_ONLY);
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('counts every regular file at any depth of the scope folder, an empty one too, and deletes them all with it', async () => {
    // The daemon accepts the erase only if the files and bytes it reports are every regular file removed, at any depth,
    // an empty one included (R16; src/daemon/agents/index.ts, subsetProblem, counts each file entry whatever its size).
    // Here a folder where a document belongs — one validateMemory refuses at start, so erasing that user is its remedy —
    // holding a file, a file two folders down, an empty folder, and an empty file: a write's temporary a checkpoint
    // caught before its first byte.
    const root = await memoryRoot();
    await mkdir(join(root, IVY, 'episodic.json'));
    await put(join(root, IVY, 'episodic.json', 'x'), 'ü');
    await mkdir(join(root, IVY, 'a', 'b'), { recursive: true });
    await put(join(root, IVY, 'a', 'b', 'y'), '🙂');
    await mkdir(join(root, IVY, 'empty'));
    await put(join(root, IVY, 'session.json.tmp-1727600000001-ffffffff'), '');
    expect(await tree(root)).toEqual({
      ...MEMORY_ROOT,
      [`${IVY}/a`]: 'folder',
      [`${IVY}/a/b`]: 'folder',
      [`${IVY}/a/b/y`]: '🙂',
      [`${IVY}/empty`]: 'folder',
      [`${IVY}/episodic.json`]: 'folder',
      [`${IVY}/episodic.json/x`]: 'ü',
      [`${IVY}/session.json.tmp-1727600000001-ffffffff`]: '',
    });
    const run = io(root);
    expect(await runEraseMode(ERASE_IVY, run.io)).toBe(0);
    // Every file, every byte: 149, 63, 2, 4 and 0 (in UTF-16 code units, 144, 63, 1, 2 and 0).
    expect(run.out).toEqual(['{"erased":{"files":5,"bytes":218}}\n']);
    expect(run.err).toEqual([]);
    expect(vi.mocked(rm).mock.calls).toEqual([[join(root, IVY), { recursive: true }]]);
    // Every folder in the scope folder listed once, and no other user's. The order a folder lists in is not part of the
    // contract, so the calls are compared by path.
    expect(byPath(vi.mocked(readdir).mock.calls)).toEqual([
      [join(root, IVY)],
      [join(root, IVY, 'a')],
      [join(root, IVY, 'a', 'b')],
      [join(root, IVY, 'empty')],
      [join(root, IVY, 'episodic.json')],
    ]);
    expect(await tree(root)).toEqual(JACK_ONLY);
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('prints 0 and 0 for a user with no scope folder at all, and deletes nothing', async () => {
    const root = await memoryRoot();
    const run = io(root);
    expect(await runEraseMode(['erase-user', '--channel', 'lab', '--user', 'nobody'], run.io)).toBe(0);
    expect(run.out).toEqual(['{"erased":{"files":0,"bytes":0}}\n']);
    expect(run.err).toEqual([]);
    expect(await eraseUser(root, { channel: 'other', user: 'ivy' })).toEqual({ files: 0, bytes: 0 });
    expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect(await tree(root)).toEqual(MEMORY_ROOT);
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  // R16's 0 and 0, "when it held nothing of that user", is also a scope folder that is there but holds no regular file
  // (docs/plans/agent-persistence.md). A scope's first write that fails leaves its folder so, empty (below, "a scope's
  // first write that fails …"), and validation at start passes it, so a checkpoint can save it; a folder holding only a
  // link or an empty folder is one validation refuses, so erasing that user is its remedy. Either way the erase finds
  // the folder, counts no file in it, and deletes it whole: exit 0, never a failure, and never the folder left behind.
  // Jack's scope folder beside it holds his corrupt file, which nothing lists, reads or removes; the link points to it.
  it.each([
    {
      what: 'empty, as a failed first write leaves it',
      arrange: (root: string) => Promise.resolve({ inside: {}, listed: [[join(root, IVY)]] }),
    },
    {
      what: 'only an empty folder and a link',
      arrange: async (root: string) => {
        await mkdir(join(root, IVY, 'empty'));
        await symlink(join(root, JACK, 'semantic.json'), join(root, IVY, 'episodic.json'));
        return {
          inside: {
            [`${IVY}/empty`]: 'folder',
            [`${IVY}/episodic.json`]: `link to ${join(root, JACK, 'semantic.json')}`,
          },
          listed: [[join(root, IVY)], [join(root, IVY, 'empty')]],
        };
      },
    },
  ])(
    'prints 0 and 0 for a user whose scope folder is there but holds no regular file ($what), exits 0, and deletes that folder whole',
    async ({ arrange }) => {
      const root = await tempRoot();
      await mkdir(join(root, IVY));
      await mkdir(join(root, JACK));
      await put(join(root, JACK, 'semantic.json'), CORRUPT);
      const { inside, listed } = await arrange(root);
      expect(await tree(root)).toEqual({ [IVY]: 'folder', ...inside, ...JACK_ONLY });
      const run = io(root);
      expect(await runEraseMode(ERASE_IVY, run.io)).toBe(0);
      expect(run.out).toEqual(['{"erased":{"files":0,"bytes":0}}\n']);
      expect(run.err).toEqual([]);
      // It lists ivy's scope folder and every folder in it, never another user's (compared by path: the order a folder
      // lists in is not part of the contract), and deletes the scope folder whole, once.
      expect(byPath(vi.mocked(readdir).mock.calls)).toEqual(listed);
      expect(vi.mocked(rm).mock.calls).toEqual([[join(root, IVY), { recursive: true }]]);
      // Ivy's scope folder is gone; jack's, and the file the link pointed to, exactly as they were.
      expect(await tree(root)).toEqual(JACK_ONLY);
      expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    },
  );

  // The erase takes every channel and user the daemon passes it (R16). A channel name is 1 to 32 characters: a
  // lower-case letter, then lower-case letters, digits or hyphens (NAME_PATTERN in src/shared/protocol.ts, which
  // selectorProblem in src/daemon/state/store.ts applies to channel=). The user is the typed user ID, passed unchanged
  // (src/daemon/agents/index.ts) once it passes the user-ID rule as typed (userIdProblem with isDefault false:
  // src/cli/state.ts, src/daemon/server.ts) — the issued form user-<n> included: "A typed `user-3` is allowed"
  // (src/shared/protocol.ts). Refused, that user's memory could never be erased. Each scope key was computed outside the
  // code, with `printf '<channel>/<user>' | shasum -a 256 | cut -c1-16`; each length with `printf '%s' '<name>' | wc -c`.
  it.each([
    {
      what: 'digits and hyphens (team-2, user-3)',
      channel: 'team-2',
      user: 'user-3',
      lengths: [6, 6],
      key: 'd7ffb68bb9cc1c05',
    },
    {
      what: 'each at the 32-character limit',
      channel: 'abcdefghij-0123456789-klmnopqrst',
      user: 'ivy-0123456789-abcdefghij-klmnop',
      lengths: [32, 32],
      key: 'a8ef7605f4598795',
    },
  ])(
    'erases the scope folder of a channel and user with $what: exit 0, the one line, and no other folder touched',
    async ({ channel, user, lengths, key }) => {
      expect([channel.length, user.length]).toEqual(lengths);
      // A user the daemon passes: the user-ID rule, as a typed ID, finds nothing wrong with it.
      expect(userIdProblem(user, { isDefault: false })).toBeUndefined();
      const argv = ['erase-user', '--channel', channel, '--user', user];
      expect(parseEraseArgs(argv)).toEqual({ channel, user });
      const root = await memoryRoot();
      await mkdir(join(root, key));
      await put(join(root, key, 'session.json'), doc('session'));
      expect(await tree(root)).toEqual({ ...MEMORY_ROOT, [key]: 'folder', [`${key}/session.json`]: doc('session') });
      const run = io(root);
      expect(await runEraseMode(argv, run.io)).toBe(0);
      // Its one document, every byte: 63.
      expect(run.out).toEqual(['{"erased":{"files":1,"bytes":63}}\n']);
      expect(run.err).toEqual([]);
      expect(vi.mocked(readdir).mock.calls).toEqual([[join(root, key)]]);
      expect(vi.mocked(rm).mock.calls).toEqual([[join(root, key), { recursive: true }]]);
      // Ivy's and jack's scope folders exactly as they were.
      expect(await tree(root)).toEqual(MEMORY_ROOT);
      expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    },
  );

  it.each([
    [['erase-user'], 'usage: erase-user --channel <channel> --user <user>'],
    [['erase-user', '--user', 'ivy', '--channel', 'lab'], 'usage: erase-user --channel <channel> --user <user>'],
    // Every word there is right, but one too few or one too many: only the length check refuses these. One short, the
    // user would be undefined, which NAME_PATTERN, testing it as the text "undefined", would let through.
    [['erase-user', '--channel', 'lab', '--user'], 'usage: erase-user --channel <channel> --user <user>'],
    [
      ['erase-user', '--channel', 'lab', '--user', 'ivy', '--all'],
      'usage: erase-user --channel <channel> --user <user>',
    ],
    // Every word right but the first: only its check refuses this.
    [['erase', '--channel', 'lab', '--user', 'ivy'], 'usage: erase-user --channel <channel> --user <user>'],
    // Every word right but the second: only its check refuses these.
    [['erase-user', '--chanel', 'lab', '--user', 'ivy'], 'usage: erase-user --channel <channel> --user <user>'],
    [['erase-user', '--user', 'lab', '--user', 'ivy'], 'usage: erase-user --channel <channel> --user <user>'],
    // Every word right but the fourth: only its check refuses these.
    [['erase-user', '--channel', 'lab', '--usr', 'ivy'], 'usage: erase-user --channel <channel> --user <user>'],
    [['erase-user', '--channel', 'lab', '--channel', 'ivy'], 'usage: erase-user --channel <channel> --user <user>'],
    [['erase-user', '--channel', '../x', '--user', 'ivy'], 'the channel is not a channel name'],
    [['erase-user', '--channel', 'lab', '--user', 'Ivy'], 'the user is not a user ID'],
    // Just past each bound of a channel name and a user ID (NAME_PATTERN, above): 33 characters (each the 32-character
    // name accepted above with one more letter), a first character that is a digit or a hyphen, and nothing at all.
    [
      ['erase-user', '--channel', 'abcdefghij-0123456789-klmnopqrstu', '--user', 'ivy'],
      'the channel is not a channel name',
    ],
    [['erase-user', '--channel', '2team', '--user', 'ivy'], 'the channel is not a channel name'],
    [['erase-user', '--channel', '-team', '--user', 'ivy'], 'the channel is not a channel name'],
    [['erase-user', '--channel', '', '--user', 'ivy'], 'the channel is not a channel name'],
    [['erase-user', '--channel', 'lab', '--user', 'ivy-0123456789-abcdefghij-klmnopq'], 'the user is not a user ID'],
    [['erase-user', '--channel', 'lab', '--user', '3ivy'], 'the user is not a user ID'],
    [['erase-user', '--channel', 'lab', '--user', '-ivy'], 'the user is not a user ID'],
    [['erase-user', '--channel', 'lab', '--user', ''], 'the user is not a user ID'],
  ])(
    'refuses arguments %j: exit 2, the reason on stderr as one JSON line, nothing on stdout, nothing deleted',
    async (argv, reason) => {
      expect(parseEraseArgs(argv)).toBe(reason);
      const root = await memoryRoot();
      const run = io(root);
      expect(await runEraseMode(argv, run.io)).toBe(2);
      expect(run.out).toEqual([]);
      expect(run.err).toEqual([`{"level":"error","event":"memory.erase_failed","error":"${reason}"}\n`]);
      expect(vi.mocked(readdir)).not.toHaveBeenCalled();
      expect(vi.mocked(rm)).not.toHaveBeenCalled();
      expect(await tree(root)).toEqual(MEMORY_ROOT);
      expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    },
  );

  it('exits 1 on any other failure, its reason on stderr as one JSON line naming the scope by its key and never the user, nothing on stdout', async () => {
    // A /memory that is a file, not a folder: looking for the scope folder in it fails ENOTDIR, which is not "nothing there".
    const root = join(await tempRoot(), 'memory');
    await put(root, 'not a folder');
    const reason = `ENOTDIR: not a directory, lstat '${join(root, IVY)}'`;
    expect(fsError(await rejection(eraseUser(root, { channel: 'lab', user: 'ivy' })))).toEqual({
      message: reason,
      code: 'ENOTDIR',
      syscall: 'lstat',
    });
    const run = io(root);
    expect(await runEraseMode(ERASE_IVY, run.io)).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      `{"level":"error","event":"memory.erase_failed","scope":"${IVY}","error":${JSON.stringify(reason)}}\n`,
    ]);
    expect(await contents(root)).toBe('not a folder');
    expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('exits 1 when deleting the scope folder fails, after counting it: the reason on stderr naming the scope by its key, nothing on stdout', async () => {
    // R16: on any failure the erase exits non-zero with the reason on stderr; a failed deletion is one, so an erase
    // never reports as erased what is still there. The error is shaped as Node's when a folder cannot be removed.
    const root = await memoryRoot();
    const reason = `EACCES: permission denied, rmdir '${join(root, IVY)}'`;
    const denied = Object.assign(new Error(reason), { code: 'EACCES', syscall: 'rmdir' });
    vi.mocked(rm).mockRejectedValueOnce(denied).mockRejectedValueOnce(denied);
    // eraseUser rejects with the deletion's own error, neither wrapped nor replaced.
    expect(await rejection(eraseUser(root, { channel: 'lab', user: 'ivy' }))).toBe(denied);
    const run = io(root);
    expect(await runEraseMode(ERASE_IVY, run.io)).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      `{"level":"error","event":"memory.erase_failed","scope":"${IVY}","error":${JSON.stringify(reason)}}\n`,
    ]);
    // Each erase counted ivy's scope folder, then tried once to delete it whole; nothing was deleted.
    expect(vi.mocked(readdir).mock.calls).toEqual([[join(root, IVY)], [join(root, IVY)]]);
    expect(vi.mocked(rm).mock.calls).toEqual([
      [join(root, IVY), { recursive: true }],
      [join(root, IVY), { recursive: true }],
    ]);
    expect(await tree(root)).toEqual(MEMORY_ROOT);
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  // R16 allows 0 and 0 only "when it held nothing of that user": a scope folder that is absent, or that is there but
  // holds no regular file (above, the two "prints 0 and 0" tests). Once the folder is found, an ENOENT from inside it is
  // a failure like any other, never "nothing there" (persisted.ts; PRINCIPLES §12: a catch must not turn one error into
  // a benign one). Reported as 0 and 0, the daemon would tell the user it held no memory of them while all of it stayed
  // (src/daemon/agents/index.ts, no_memory).
  // Each listing error is shaped as Node's; the last case's ENOENT is the real lstat's, for a name a listing gives that
  // is not there (as a name decoded lossily would be).
  it.each([
    {
      where: "the scope folder's own listing",
      arrange: (root: string, actual: typeof import('node:fs/promises')) => {
        const folder = join(root, IVY);
        const reason = `ENOENT: no such file or directory, scandir '${folder}'`;
        const missing = Object.assign(new Error(reason), {
          errno: -2,
          code: 'ENOENT',
          syscall: 'scandir',
          path: folder,
        });
        vi.mocked(readdir).mockImplementation((async (path: string) =>
          path === folder ? Promise.reject(missing) : actual.readdir(path)) as never);
        return Promise.resolve({ reason, syscall: 'scandir', listed: [[folder]], before: MEMORY_ROOT });
      },
    },
    {
      where: 'the listing of a folder in it',
      arrange: async (root: string, actual: typeof import('node:fs/promises')) => {
        const folder = join(root, IVY, 'a');
        await mkdir(folder);
        await put(join(folder, 'y'), '🙂');
        const reason = `ENOENT: no such file or directory, scandir '${folder}'`;
        const missing = Object.assign(new Error(reason), {
          errno: -2,
          code: 'ENOENT',
          syscall: 'scandir',
          path: folder,
        });
        vi.mocked(readdir).mockImplementation((async (path: string) =>
          path === folder ? Promise.reject(missing) : actual.readdir(path)) as never);
        return {
          reason,
          syscall: 'scandir',
          listed: [[join(root, IVY)], [folder]],
          before: { ...MEMORY_ROOT, [`${IVY}/a`]: 'folder', [`${IVY}/a/y`]: '🙂' },
        };
      },
    },
    {
      where: 'an entry its listing names that is not there',
      arrange: (root: string, actual: typeof import('node:fs/promises')) => {
        const folder = join(root, IVY);
        vi.mocked(readdir).mockImplementation((async (path: string) =>
          path === folder ? [...(await actual.readdir(path)), 'gone.json'] : actual.readdir(path)) as never);
        return Promise.resolve({
          reason: `ENOENT: no such file or directory, lstat '${join(folder, 'gone.json')}'`,
          syscall: 'lstat',
          listed: [[folder]],
          before: MEMORY_ROOT,
        });
      },
    },
  ])(
    'exits 1 on an ENOENT from inside the scope folder it found ($where), never 0 and 0: the reason on stderr naming the scope by its key, nothing deleted',
    async ({ arrange }) => {
      const root = await memoryRoot();
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const { reason, syscall, listed, before } = await arrange(root, actual);
      expect(await tree(root)).toEqual(before);
      const run = io(root);
      expect(await runEraseMode(ERASE_IVY, run.io)).toBe(1);
      expect(run.out).toEqual([]);
      expect(run.err).toEqual([
        `{"level":"error","event":"memory.erase_failed","scope":"${IVY}","error":${JSON.stringify(reason)}}\n`,
      ]);
      // eraseUser rejects with that error: a plain Error with its own message, code and syscall, not wrapped in another.
      expect(fsError(await rejection(eraseUser(root, { channel: 'lab', user: 'ivy' })))).toEqual({
        message: reason,
        code: 'ENOENT',
        syscall,
      });
      // Each erase listed only ivy's scope folder and what is in it, and deleted nothing.
      expect(vi.mocked(readdir).mock.calls).toEqual([...listed, ...listed]);
      expect(vi.mocked(rm)).not.toHaveBeenCalled();
      expect(await tree(root)).toEqual(before);
      expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a value that is not an Error', 'closed', 'closed'],
    ['an Error', new Error('write EPIPE'), 'write EPIPE'],
  ])(
    'exits 1 when printing its one line fails, whatever that throws (%s): the reason on stderr naming the scope by its key',
    async (_what, thrown: unknown, reason) => {
      const root = await memoryRoot();
      const stdout = vi.fn((): void => {
        throw thrown;
      });
      const stderr = vi.fn((): void => undefined);
      expect(await runEraseMode(ERASE_IVY, { root, stdout, stderr })).toBe(1);
      // The line was offered once, and its failure is the one reason given. Ivy's two documents, every byte: 149 and 63.
      expect(stdout.mock.calls).toEqual([['{"erased":{"files":2,"bytes":212}}\n']]);
      expect(stderr.mock.calls).toEqual([
        [`{"level":"error","event":"memory.erase_failed","scope":"${IVY}","error":"${reason}"}\n`],
      ]);
      // The line is printed after the scope folder is deleted, so it is gone. The erase runs over a copy of the saved
      // /memory, and on a non-zero exit the daemon keeps the previous generation byte-identical (R16).
      expect(vi.mocked(readdir).mock.calls).toEqual([[join(root, IVY)]]);
      expect(vi.mocked(rm).mock.calls).toEqual([[join(root, IVY), { recursive: true }]]);
      expect(await tree(root)).toEqual(JACK_ONLY);
      expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    },
  );
});

describe('a persisted /memory at start (R12; A10)', () => {
  it('validates every document in every scope folder, each parsed as its tier; an empty or absent /memory is valid', async () => {
    const root = await tempRoot();
    expect(await validateMemory(root)).toEqual({ files: 0, temporariesRemoved: 0 });
    expect(await validateMemory(join(root, 'absent'))).toEqual({ files: 0, temporariesRemoved: 0 });
    await mkdir(join(root, IVY));
    await mkdir(join(root, JACK));
    await put(join(root, IVY, 'semantic.json'), doc('semantic'));
    await put(join(root, IVY, 'session.json'), doc('session'));
    await put(join(root, JACK, 'episodic.json'), doc('episodic'));
    await put(join(root, JACK, 'procedural.json'), doc('procedural'));
    expect(await validateMemory(root)).toEqual({ files: 4, temporariesRemoved: 0 });
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, 'absent'), WITH_TYPES],
      [root, WITH_TYPES],
      [join(root, JACK), WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    expect(vi.mocked(readFile).mock.calls).toEqual([
      [join(root, JACK, 'episodic.json'), 'utf8'],
      [join(root, JACK, 'procedural.json'), 'utf8'],
      [join(root, IVY, 'semantic.json'), 'utf8'],
      [join(root, IVY, 'session.json'), 'utf8'],
    ]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([
      ['episodic', doc('episodic'), join(root, JACK, 'episodic.json'), expect.any(Function)],
      ['procedural', doc('procedural'), join(root, JACK, 'procedural.json'), expect.any(Function)],
      ['semantic', doc('semantic'), join(root, IVY, 'semantic.json'), expect.any(Function)],
      ['session', doc('session'), join(root, IVY, 'session.json'), expect.any(Function)],
    ]);
    // Validated, every document is left as it was, and nothing is deleted or written.
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(await tree(root)).toEqual({
      [IVY]: 'folder',
      [`${IVY}/semantic.json`]: doc('semantic'),
      [`${IVY}/session.json`]: doc('session'),
      [JACK]: 'folder',
      [`${JACK}/episodic.json`]: doc('episodic'),
      [`${JACK}/procedural.json`]: doc('procedural'),
    });
  });

  it('passes a document with a bad record, dropped as reading drops it, and leaves the file as it was', async () => {
    const root = await tempRoot();
    const file = join(root, IVY, 'semantic.json');
    const text = JSON.stringify({ schemaVersion: 1, tier: 'semantic', updatedAt: 't', records: [{ id: 'r1' }] });
    await mkdir(join(root, IVY));
    await put(file, text);
    expect(await validateMemory(root)).toEqual({ files: 1, temporariesRemoved: 0 });
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    expect(vi.mocked(readFile).mock.calls).toEqual([[file, 'utf8']]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([['semantic', text, file, expect.any(Function)]]);
    expect(vi.mocked(parseDoc).mock.results).toEqual([
      { type: 'return', value: { schemaVersion: 1, tier: 'semantic', updatedAt: 't', records: [] } },
    ]);
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(await contents(file)).toBe(text);
  });

  it.each([
    { entry: 'notes', what: 'a folder', reason: 'its name is not 16 hex digits' },
    { entry: '6f529f82f0b84bb', what: 'a folder', reason: 'its name is 15 hex digits' },
    { entry: '6f529f82f0b84bb3a', what: 'a folder', reason: 'its name is 17 hex digits' },
    { entry: '6F529F82F0B84BB3', what: 'a folder', reason: 'its name is upper-case hex' },
    { entry: '6f529f82f0b84bbg', what: 'a folder', reason: 'its name holds a letter that is not hex' },
    { entry: IVY, what: 'a file', reason: 'it is not a folder' },
    // A link is refused as what it is, never followed (persisted.ts: "/memory holds only scope folders"), even one named
    // as a scope folder and pointing to one that holds a valid document.
    { entry: IVY, what: 'a link to a scope folder', reason: 'it is a link, not a folder' },
  ])(
    'refuses $entry, $what in /memory where only scope folders belong ($reason), and leaves it there',
    async ({ entry, what }) => {
      const root = await tempRoot();
      // What a link points to, outside /memory: a scope folder holding a valid document. Nothing reaches it.
      const outside = await tempRoot();
      const target = join(outside, IVY);
      await mkdir(target);
      await put(join(target, 'semantic.json'), doc('semantic'));
      if (what === 'a folder') await mkdir(join(root, entry));
      else if (what === 'a file') await put(join(root, entry), doc('semantic'));
      else await symlink(target, join(root, entry));
      expect(invalid(await rejection(validateMemory(root)))).toEqual(
        refused(join(root, entry), 'not a memory scope folder'),
      );
      // Refused before it is listed or read.
      expect(vi.mocked(readdir).mock.calls).toEqual([[root, WITH_TYPES]]);
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(rm)).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
      const leftAsIt = (): string => {
        if (what === 'a folder') return 'folder';
        if (what === 'a file') return doc('semantic');
        return `link to ${target}`;
      };
      expect(await tree(root)).toEqual({ [entry]: leftAsIt() });
      expect(await tree(outside)).toEqual({ [IVY]: 'folder', [`${IVY}/semantic.json`]: doc('semantic') });
      expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      kind: 'file',
      entry: 'episodic.json',
      content: CUT_SHORT,
      reason: 'not JSON (SyntaxError at position 36)',
      parsedAs: 'episodic',
    },
    {
      kind: 'file',
      entry: 'episodic.json',
      content: doc('semantic'),
      reason: 'expected schemaVersion 1 and tier "episodic"',
      parsedAs: 'episodic',
    },
    { kind: 'file', entry: 'notes.txt', content: 'x', reason: 'not a memory document', parsedAs: undefined },
    {
      kind: 'file',
      entry: 'notes.json',
      content: doc('semantic'),
      reason: 'not a memory document',
      parsedAs: undefined,
    },
    { kind: 'file', entry: 'semantic.json.tmp-x', content: '{', reason: 'not a memory document', parsedAs: undefined },
    {
      kind: 'file',
      entry: 'notes.json.tmp-1727600000000-0a1b2c3d',
      content: '{',
      reason: 'not a memory document',
      parsedAs: undefined,
    },
    {
      kind: 'folder',
      entry: 'semantic.json',
      content: undefined,
      reason: 'not a memory document',
      parsedAs: undefined,
    },
    {
      kind: 'folder',
      entry: 'semantic.json.tmp-1727600000000-0a1b2c3d',
      content: undefined,
      reason: 'not a memory document',
      parsedAs: undefined,
    },
    // A link is refused as what it is, never followed (persisted.ts: each scope folder holds "only `<tier>.json`
    // documents"): one named as a tier's document, pointing to a valid one, and one named as a tier's temporary.
    { kind: 'link', entry: 'semantic.json', content: undefined, reason: 'not a memory document', parsedAs: undefined },
    {
      kind: 'link',
      entry: 'semantic.json.tmp-1727600000000-0a1b2c3d',
      content: undefined,
      reason: 'not a memory document',
      parsedAs: undefined,
    },
  ])(
    'refuses the $kind $entry in a scope folder, naming it: $reason',
    async ({ kind, entry, content, reason, parsedAs }) => {
      const root = await tempRoot();
      const path = join(root, IVY, entry);
      // What a link points to, outside /memory: a valid document. Nothing reads or removes it.
      const outside = await tempRoot();
      const target = join(outside, 'semantic.json');
      await put(target, doc('semantic'));
      await mkdir(join(root, IVY));
      if (kind === 'folder') await mkdir(path);
      else if (kind === 'link') await symlink(target, path);
      else await put(path, present(content, 'content'));
      expect(invalid(await rejection(validateMemory(root)))).toEqual(refused(path, reason));
      expect(vi.mocked(readdir).mock.calls).toEqual([
        [root, WITH_TYPES],
        [join(root, IVY), WITH_TYPES],
      ]);
      // Refused, never removed: only a file named as a tier's temporary is a write caught half done.
      expect(vi.mocked(rm)).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
      const leftAsIt = (): string | undefined => {
        if (kind === 'folder') return 'folder';
        if (kind === 'link') return `link to ${target}`;
        return content;
      };
      expect(await tree(root)).toEqual({
        [IVY]: 'folder',
        [`${IVY}/${entry}`]: leftAsIt(),
      });
      expect(await tree(outside)).toEqual({ 'semantic.json': doc('semantic') });
      // Only a tier's document is read, to be parsed as that tier; any other name is refused by its name alone.
      expect(vi.mocked(readFile).mock.calls).toEqual(parsedAs === undefined ? [] : [[path, 'utf8']]);
      expect(vi.mocked(parseDoc).mock.calls).toEqual(
        parsedAs === undefined ? [] : [[parsedAs, content, path, expect.any(Function)]],
      );
    },
  );

  // MemoryStore.write's temporary is `<tier>.json.tmp-<ms>-<8 lower-case hex>` (store.ts). A name that is one but for a
  // single part is a stray file like any other: refused, never removed (docs/architecture/memory.md#persisted: "any
  // other stray name is still refused").
  it.each([
    { part: 'something after the hex', entry: 'semantic.json.tmp-1727600000000-0a1b2c3d.bak' },
    { part: 'something before the tier', entry: 'xsemantic.json.tmp-1727600000000-0a1b2c3d' },
    { part: 'no time', entry: 'semantic.json.tmp--0a1b2c3d' },
    // The time is milliseconds, digits only: a letter in it is not a time.
    { part: 'a letter in the time', entry: 'semantic.json.tmp-17276a0000000-0a1b2c3d' },
    { part: '7 hex digits', entry: 'semantic.json.tmp-1727600000000-0a1b2c3' },
    { part: '9 hex digits', entry: 'semantic.json.tmp-1727600000000-0a1b2c3d9' },
    { part: 'upper-case hex', entry: 'semantic.json.tmp-1727600000000-0A1B2C3D' },
    // A lower-case letter past "f": eight characters, but not eight hex digits.
    { part: 'a letter that is not hex', entry: 'semantic.json.tmp-1727600000000-0a1b2c3g' },
    { part: 'a letter for the dot before "json"', entry: 'semanticxjson.tmp-1727600000000-0a1b2c3d' },
    { part: 'a letter for the dot before "tmp"', entry: 'semantic.jsonxtmp-1727600000000-0a1b2c3d' },
  ])(
    "refuses a file named as a tier's temporary but for $part, naming it, and leaves it there: $entry",
    async ({ entry }) => {
      const root = await tempRoot();
      const path = join(root, IVY, entry);
      await mkdir(join(root, IVY));
      await put(path, '{');
      expect(invalid(await rejection(validateMemory(root)))).toEqual(refused(path, 'not a memory document'));
      expect(vi.mocked(readdir).mock.calls).toEqual([
        [root, WITH_TYPES],
        [join(root, IVY), WITH_TYPES],
      ]);
      expect(vi.mocked(rm)).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
      expect(await tree(root)).toEqual({ [IVY]: 'folder', [`${IVY}/${entry}`]: '{' });
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    },
  );

  it('refuses a document that is not JSON nested deeper than a call stack goes, naming it and where it breaks, never with a stack overflow', async () => {
    // R12 (docs/plans/agent-persistence.md): the start fails naming the first invalid file. JSON.parse refuses a million
    // "[" with a SyntaxError, "Unexpected end of JSON input" (Node 22.13.1, read 2026-10-10), so the text ends too soon
    // and the position is its length. invalid() requires a MemoryFileInvalid, so a RangeError fails it.
    const root = await tempRoot();
    const file = join(root, IVY, 'semantic.json');
    const text = '['.repeat(1_000_000);
    await mkdir(join(root, IVY));
    await put(file, text);
    expect(invalid(await rejection(validateMemory(root)))).toEqual(
      refused(file, 'not JSON (SyntaxError at position 1000000)'),
    );
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    expect(vi.mocked(readFile).mock.calls).toEqual([[file, 'utf8']]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([['semantic', text, file, expect.any(Function)]]);
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(await tree(root)).toEqual({ [IVY]: 'folder', [`${IVY}/semantic.json`]: text });
  });

  it('names the first invalid file by name — first scope folder, then first file in it — whatever order /memory is listed in', async () => {
    const root = await tempRoot();
    await mkdir(join(root, JACK));
    await mkdir(join(root, IVY));
    const first = join(root, JACK, 'episodic.json');
    await put(first, CUT_SHORT);
    await put(join(root, JACK, 'session.json'), doc('semantic'));
    await put(join(root, IVY, 'notes.txt'), 'x');
    // Every listing handed over in descending name order, the reverse of the order validateMemory must check in.
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readdir).mockImplementation((async (path: string, options: { withFileTypes: true }) =>
      (await actual.readdir(path, options)).sort((a, b) => (a.name < b.name ? 1 : -1))) as never);
    expect((await readdir(root, { withFileTypes: true })).map((e) => e.name)).toEqual([IVY, JACK]);
    expect((await readdir(join(root, JACK), { withFileTypes: true })).map((e) => e.name)).toEqual([
      'session.json',
      'episodic.json',
    ]);
    vi.mocked(readdir).mockClear();
    expect(invalid(await rejection(validateMemory(root)))).toEqual(
      refused(first, 'not JSON (SyntaxError at position 36)'),
    );
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, { withFileTypes: true }],
      [join(root, JACK), { withFileTypes: true }],
    ]);
    expect(vi.mocked(readFile).mock.calls).toEqual([[first, 'utf8']]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([['episodic', CUT_SHORT, first, expect.any(Function)]]);
    // Refused, every file stays as it was: the one refused, the two after it that were never reached, and nothing deleted
    // or written.
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(await tree(root)).toEqual({
      [IVY]: 'folder',
      [`${IVY}/notes.txt`]: 'x',
      [JACK]: 'folder',
      [`${JACK}/episodic.json`]: CUT_SHORT,
      [`${JACK}/session.json`]: doc('semantic'),
    });
  });

  it('rejects with the listing error itself when /memory cannot be listed for any reason but its absence (a /memory that is a file)', async () => {
    const root = join(await tempRoot(), 'memory');
    await put(root, 'not a folder');
    const error = await rejection(validateMemory(root));
    expect(fsError(error)).toEqual({
      message: `ENOTDIR: not a directory, scandir '${root}'`,
      code: 'ENOTDIR',
      syscall: 'scandir',
    });
    expect(vi.mocked(readdir).mock.calls).toEqual([[root, WITH_TYPES]]);
    // The very error the listing rejected with, neither wrapped nor replaced.
    const listing = vi.mocked(readdir).mock.settledResults;
    expect(listing.map((result) => result.type)).toEqual(['rejected']);
    expect(present(listing[0], 'listing[0]').value).toBe(error);
    expect(await contents(root)).toBe('not a folder');
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
  });

  // R12 (docs/plans/agent-persistence.md): every persisted file is validated at start, or the launch fails, loudly
  // (images/memory/src/main.ts: "a file it cannot read ends the launch, loudly"). So a step inside a scope folder that
  // fails — listing the folder, removing a temporary in it, reading a document in it — rejects with that very error,
  // unchanged: never a folder passed over, a temporary counted as removed that is still there, or the counts so far
  // (PRINCIPLES §12: a catch must not turn one error into a benign one). /memory holds jack's scope folder, met first,
  // holding a document, a temporary and a document, met in that order; then ivy's. Each step fails in jack's, so what
  // comes before it is done and nothing after it is reached: not the rest of jack's folder, and not ivy's. Each error is
  // shaped as Node 22.13.1's own for that call (seen 2026-10-10): a plain Error with its errno, code, syscall and path;
  // rm without force fails at its lstat for a path that is not there (a temporary gone already), and at its unlink in a
  // folder it may not write.
  it.each([
    {
      fails: 'listing',
      what: "listing jack's scope folder",
      code: 'ENOENT',
      errno: -2,
      syscall: 'scandir',
      why: 'no such file or directory',
    },
    {
      fails: 'listing',
      what: "listing jack's scope folder",
      code: 'EACCES',
      errno: -13,
      syscall: 'scandir',
      why: 'permission denied',
    },
    {
      fails: 'removal',
      what: "removing jack's temporary",
      code: 'ENOENT',
      errno: -2,
      syscall: 'lstat',
      why: 'no such file or directory',
    },
    {
      fails: 'removal',
      what: "removing jack's temporary",
      code: 'EACCES',
      errno: -13,
      syscall: 'unlink',
      why: 'permission denied',
    },
    {
      fails: 'read',
      what: "reading jack's second document",
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      why: 'no such file or directory',
    },
    {
      fails: 'read',
      what: "reading jack's second document",
      code: 'EACCES',
      errno: -13,
      syscall: 'open',
      why: 'permission denied',
    },
  ] as const)(
    'rejects with the error itself when a step inside a scope folder fails ($what, $code): nothing after it is reached, and nothing is swallowed',
    async ({ fails, code, errno, syscall, why }) => {
      const root = await tempRoot();
      const jack = join(root, JACK);
      const episodic = join(jack, 'episodic.json');
      const temporary = join(jack, 'procedural.json.tmp-1727600000001-ffffffff');
      const semantic = join(jack, 'semantic.json');
      await mkdir(jack);
      await mkdir(join(root, IVY));
      await put(episodic, doc('episodic'));
      await put(temporary, '{"schemaVer');
      await put(semantic, doc('semantic'));
      await put(join(root, IVY, 'session.json'), doc('session'));
      const before = {
        [IVY]: 'folder',
        [`${IVY}/session.json`]: doc('session'),
        [JACK]: 'folder',
        [`${JACK}/episodic.json`]: doc('episodic'),
        [`${JACK}/procedural.json.tmp-1727600000001-ffffffff`]: '{"schemaVer',
        [`${JACK}/semantic.json`]: doc('semantic'),
      };
      expect(await tree(root)).toEqual(before);
      // The failing call's path, and Node's error for it; the double fails that call alone, and every other passes through.
      const path = { listing: jack, removal: temporary, read: semantic }[fails];
      const failure = Object.assign(new Error(`${code}: ${why}, ${syscall} '${path}'`), { errno, code, syscall, path });
      const made = {
        prototype: Object.getPrototypeOf(failure) as object | null,
        message: failure.message,
        own: Object.getOwnPropertyNames(failure).sort(byCodeUnit),
        fields: Object.assign({}, failure),
      };
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      if (fails === 'listing')
        vi.mocked(readdir).mockImplementation((async (p: string, options: { withFileTypes: true }) =>
          p === jack ? Promise.reject(failure) : actual.readdir(p, options)) as never);
      else if (fails === 'removal') vi.mocked(rm).mockRejectedValueOnce(failure);
      else
        vi.mocked(readFile).mockImplementation((async (p: string, options: 'utf8') =>
          p === semantic ? Promise.reject(failure) : actual.readFile(p, options)) as never);
      const error = await rejection(validateMemory(root));
      // The very error the step failed with, neither wrapped nor replaced, and not changed: its class and every field as made.
      expect(error).toBe(failure);
      expect({
        prototype: Object.getPrototypeOf(failure) as object | null,
        message: failure.message,
        own: Object.getOwnPropertyNames(failure).sort(byCodeUnit),
        fields: Object.assign({}, failure),
      }).toEqual(made);
      // What came before the failing step was done; nothing after it was. Ivy's scope folder is never listed.
      const reached = {
        listing: { read: [], parsed: [], removed: [], left: before },
        removal: {
          read: [[episodic, 'utf8']],
          parsed: [['episodic', doc('episodic'), episodic, expect.any(Function)]],
          removed: [[temporary]],
          // The removal failed, so the temporary is still there: the double rejected it without removing anything.
          left: before,
        },
        read: {
          read: [
            [episodic, 'utf8'],
            [semantic, 'utf8'],
          ],
          parsed: [['episodic', doc('episodic'), episodic, expect.any(Function)]],
          removed: [[temporary]],
          left: {
            [IVY]: 'folder',
            [`${IVY}/session.json`]: doc('session'),
            [JACK]: 'folder',
            [`${JACK}/episodic.json`]: doc('episodic'),
            [`${JACK}/semantic.json`]: doc('semantic'),
          },
        },
      }[fails];
      expect(vi.mocked(readdir).mock.calls).toEqual([
        [root, WITH_TYPES],
        [jack, WITH_TYPES],
      ]);
      expect(vi.mocked(readFile).mock.calls).toEqual(reached.read);
      expect(vi.mocked(parseDoc).mock.calls).toEqual(reached.parsed);
      expect(vi.mocked(rm).mock.calls).toEqual(reached.removed);
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
      expect(await tree(root)).toEqual(reached.left);
    },
  );

  it("removes each write's temporary a checkpoint caught half done, counting it and parsing none (the completion review, finding 4)", async () => {
    const root = await tempRoot();
    await mkdir(join(root, IVY));
    await mkdir(join(root, JACK));
    await put(join(root, IVY, 'semantic.json'), doc('semantic'));
    // One of each tier's, whatever it holds: half a document, nothing, a whole one not yet renamed.
    await put(join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), '{"schemaVer');
    await put(join(root, IVY, 'procedural.json.tmp-1727600000002-89abcdef'), `${doc('procedural')}\n`);
    await put(join(root, JACK, 'session.json.tmp-1727600000001-ffffffff'), '');
    await put(
      join(root, JACK, 'episodic.json.tmp-1727600000003-00000000'),
      '{"schemaVersion":1,"tier":"episodic","upd',
    );
    expect(await validateMemory(root)).toEqual({ files: 1, temporariesRemoved: 4 });
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, JACK), WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    // Each temporary removed by name, once, as it is met — first scope folder, then first file in it — and plainly: a
    // forced removal would hide a temporary that was not there (PRINCIPLES §12).
    expect(vi.mocked(rm).mock.calls).toEqual([
      [join(root, JACK, 'episodic.json.tmp-1727600000003-00000000')],
      [join(root, JACK, 'session.json.tmp-1727600000001-ffffffff')],
      [join(root, IVY, 'procedural.json.tmp-1727600000002-89abcdef')],
      [join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d')],
    ]);
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(await tree(root)).toEqual({ [IVY]: 'folder', [`${IVY}/semantic.json`]: doc('semantic'), [JACK]: 'folder' });
    expect(vi.mocked(readFile).mock.calls).toEqual([[join(root, IVY, 'semantic.json'), 'utf8']]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([
      ['semantic', doc('semantic'), join(root, IVY, 'semantic.json'), expect.any(Function)],
    ]);
  });
});

// MemoryStore.write's failure paths are tested here, beside validation at start, because their contract is validation's
// (store.ts: a failed write removes its temporary "so a folder holds only documents — which a persisted /memory's
// validation at start requires (R12)"; docs/architecture/memory.md#persisted).
describe('MemoryStore.write when it fails (store.ts; R12): what it rejects with, the temporary it removes, and what it leaves for validation at start', () => {
  it('a write that fails after writing its temporary removes it, so the folder it leaves still validates', async () => {
    const root = await tempRoot();
    const onDropped = vi.fn();
    const onMalformed = vi.fn();
    const store = new MemoryStore({ root, onDropped, onMalformed });
    const scope = { channel: 'lab', user: 'ivy' };
    // Each write's temporary is named by the pinned time and the bytes handed to randomBytes, so its name is a literal.
    pinClock();
    vi.mocked(randomBytes)
      .mockReturnValueOnce(Buffer.from('0a1b2c3d', 'hex') as never)
      .mockReturnValueOnce(Buffer.from('89abcdef', 'hex') as never);
    await store.write(scope, parsedDoc(doc('semantic')));
    // A folder where procedural.json belongs: the temporary is written, and renaming it over the document fails.
    const target = join(root, IVY, 'procedural.json');
    const temporary = join(root, IVY, 'procedural.json.tmp-1727600000000-89abcdef');
    await mkdir(target);
    const error = await rejection(store.write(scope, parsedDoc(doc('procedural'))));
    expect(fsError(error)).toEqual({
      message: `EISDIR: illegal operation on a directory, rename '${temporary}' -> '${target}'`,
      code: 'EISDIR',
      syscall: 'rename',
    });
    // Each write renamed its temporary over its document, once: the first's rename succeeded, the second's failed.
    const renames = [
      [join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), join(root, IVY, 'semantic.json')],
      [temporary, target],
    ];
    expect(vi.mocked(rename).mock.calls).toEqual(renames);
    const renamed = vi.mocked(rename).mock.settledResults;
    expect(renamed.map((result) => result.type)).toEqual(['fulfilled', 'rejected']);
    // The write rejects with its rename's own error, unchanged (store.ts: "rejects with its own error, unchanged").
    expect(error).toBe(present(renamed[1], 'renamed[1]').value);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[4], [4]]);
    // Each write wrote its temporary once, with its document's text and a newline, and both succeeded: the failed write's
    // temporary held its whole document when its rename failed.
    const writes = [
      [join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), `${doc('semantic')}\n`],
      [temporary, `${doc('procedural')}\n`],
    ];
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(writeFile).mock.settledResults).toEqual([
      { type: 'fulfilled', value: undefined },
      { type: 'fulfilled', value: undefined },
    ]);
    // The failed write removed its own temporary, once; the first write, which succeeded, removed nothing.
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    expect(await tree(root)).toEqual({
      [IVY]: 'folder',
      [`${IVY}/procedural.json`]: 'folder',
      [`${IVY}/semantic.json`]: `${doc('semantic')}\n`,
    });
    // Its cause removed (by the real rm: the spy records only the code's), the folder the failed write left validates:
    // one document, and no temporary to remove.
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await real.rm(target, { recursive: true });
    expect(await validateMemory(root)).toEqual({ files: 1, temporariesRemoved: 0 });
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    expect(vi.mocked(readFile).mock.calls).toEqual([[join(root, IVY, 'semantic.json'), 'utf8']]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([
      ['semantic', `${doc('semantic')}\n`, join(root, IVY, 'semantic.json'), expect.any(Function)],
    ]);
    // Validation found no temporary, so it removed nothing: the write's own removal is the only one.
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    // And it wrote and renamed nothing: the two writes' own calls are the only ones.
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(rename).mock.calls).toEqual(renames);
    expect(await tree(root)).toEqual({ [IVY]: 'folder', [`${IVY}/semantic.json`]: `${doc('semantic')}\n` });
    expect(onDropped).not.toHaveBeenCalled();
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it("a scope's first write that fails after writing its temporary removes it, so the empty scope folder it leaves still validates", async () => {
    // MemoryStore.write makes the scope folder before it writes (store.ts), so a scope's first write that fails leaves
    // that folder, holding nothing once the temporary is removed. A checkpoint can save it, and validation at start
    // must pass it: a scope folder holding only documents, here none (persisted.ts, validateMemory).
    const root = await tempRoot();
    const onDropped = vi.fn();
    const onMalformed = vi.fn();
    const store = new MemoryStore({ root, onDropped, onMalformed });
    pinClock();
    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from('89abcdef', 'hex') as never);
    const target = join(root, IVY, 'procedural.json');
    const temporary = join(root, IVY, 'procedural.json.tmp-1727600000000-89abcdef');
    // Renaming the temporary fails for want of room for the new name: rename(2)'s ENOSPC on macOS, "The directory in
    // which the entry for the new name is being placed cannot be extended because there is no space left" (man 2
    // rename, read 2026-10-11). Shaped as Node 22.13.1's own rename error (seen 2026-10-11): a plain Error with its
    // errno, code, syscall, path and dest. The double records the folder as the rename finds it, then fails.
    const full = Object.assign(new Error(`ENOSPC: no space left on device, rename '${temporary}' -> '${target}'`), {
      errno: -28,
      code: 'ENOSPC',
      syscall: 'rename',
      path: temporary,
      dest: target,
    });
    let atRename: Record<string, string> | undefined;
    vi.mocked(rename).mockImplementationOnce(async () => {
      atRename = await tree(root);
      throw full;
    });
    expect(await tree(root)).toEqual({});
    const error = await rejection(store.write({ channel: 'lab', user: 'ivy' }, parsedDoc(doc('procedural'))));
    // The write rejects with its rename's own error, unchanged, after making the scope folder and writing the temporary.
    expect(error).toBe(full);
    expect(atRename).toEqual({
      [IVY]: 'folder',
      [`${IVY}/procedural.json.tmp-1727600000000-89abcdef`]: `${doc('procedural')}\n`,
    });
    expect(vi.mocked(rename).mock.calls).toEqual([[temporary, target]]);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[4]]);
    // It wrote its temporary once, with its document's text and a newline, and that succeeded: only the rename failed.
    const writes = [[temporary, `${doc('procedural')}\n`]];
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(writeFile).mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }]);
    // It removed its own temporary, once, so the scope folder it made holds nothing.
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    expect(await tree(root)).toEqual({ [IVY]: 'folder' });
    // At the next start, that folder validates: no document, and no temporary to remove.
    expect(await validateMemory(root)).toEqual({ files: 0, temporariesRemoved: 0 });
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
    // Validation wrote, removed and renamed nothing: the write's own calls are the only ones, and the folder stays.
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    expect(vi.mocked(rename).mock.calls).toEqual([[temporary, target]]);
    expect(await tree(root)).toEqual({ [IVY]: 'folder' });
    expect(onDropped).not.toHaveBeenCalled();
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it("a write that cannot create its temporary rejects with writeFile's own error, not MemoryWriteCleanupFailed: its removal finds nothing to remove, and the folder, as it was, still validates", async () => {
    const root = await tempRoot();
    const onDropped = vi.fn();
    const onMalformed = vi.fn();
    const store = new MemoryStore({ root, onDropped, onMalformed });
    const scope = { channel: 'lab', user: 'ivy' };
    pinClock();
    vi.mocked(randomBytes)
      .mockReturnValueOnce(Buffer.from('0a1b2c3d', 'hex') as never)
      .mockReturnValueOnce(Buffer.from('89abcdef', 'hex') as never);
    await store.write(scope, parsedDoc(doc('semantic')));
    const temporary = join(root, IVY, 'procedural.json.tmp-1727600000000-89abcdef');
    // writeFile cannot create the temporary. Shaped as Node 22.13.1's own error for that (seen 2026-10-11, writeFile into
    // a folder of mode 0555): a plain Error with its errno, code, syscall open and path; and it makes no file.
    const denied = Object.assign(new Error(`EACCES: permission denied, open '${temporary}'`), {
      errno: -13,
      code: 'EACCES',
      syscall: 'open',
      path: temporary,
    });
    vi.mocked(writeFile).mockRejectedValueOnce(denied);
    const kept = { [IVY]: 'folder', [`${IVY}/semantic.json`]: `${doc('semantic')}\n` };
    expect(await tree(root)).toEqual(kept);
    const error = await rejection(store.write(scope, parsedDoc(doc('procedural'))));
    // The write rejects with writeFile's own error, unchanged: the very one, so no MemoryWriteCleanupFailed.
    expect(error).toBe(denied);
    // Each write wrote its temporary once, with its document's text and a newline; the first succeeded, the second failed.
    const writes = [
      [join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), `${doc('semantic')}\n`],
      [temporary, `${doc('procedural')}\n`],
    ];
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(writeFile).mock.settledResults.map((result) => result.type)).toEqual(['fulfilled', 'rejected']);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[4], [4]]);
    // No temporary was written, so none was renamed: the first write's rename is the only one.
    const renames = [[join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), join(root, IVY, 'semantic.json')]];
    expect(vi.mocked(rename).mock.calls).toEqual(renames);
    // The failed write tried once to remove its temporary, with force, which forgives a path that is not there: so the
    // removal succeeded, and the write's own error is what it rejected with.
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    expect(vi.mocked(rm).mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }]);
    // The folder is as it was: the first write's document, and no procedural document or temporary beside it.
    expect(await tree(root)).toEqual(kept);
    // At the next start, it validates: one document, and no temporary to remove.
    expect(await validateMemory(root)).toEqual({ files: 1, temporariesRemoved: 0 });
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    expect(vi.mocked(readFile).mock.calls).toEqual([[join(root, IVY, 'semantic.json'), 'utf8']]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([
      ['semantic', `${doc('semantic')}\n`, join(root, IVY, 'semantic.json'), expect.any(Function)],
    ]);
    // Validation wrote, renamed and removed nothing: the writes' own calls are the only ones, and the folder stays.
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(rename).mock.calls).toEqual(renames);
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    expect(await tree(root)).toEqual(kept);
    expect(onDropped).not.toHaveBeenCalled();
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it('a write that fills the disk partway through its temporary removes the part it wrote, keeps the document it was to replace whole, and leaves a folder that validates', async () => {
    const root = await tempRoot();
    const onDropped = vi.fn();
    const onMalformed = vi.fn();
    const store = new MemoryStore({ root, onDropped, onMalformed });
    const scope = { channel: 'lab', user: 'ivy' };
    pinClock();
    vi.mocked(randomBytes)
      .mockReturnValueOnce(Buffer.from('0a1b2c3d', 'hex') as never)
      .mockReturnValueOnce(Buffer.from('89abcdef', 'hex') as never);
    await store.write(scope, parsedDoc(doc('procedural')));
    const target = join(root, IVY, 'procedural.json');
    const temporary = join(root, IVY, 'procedural.json.tmp-1727600000000-89abcdef');
    // The procedural document again, now holding a record: what the failed write was to put in place of the first.
    const replacement =
      '{"schemaVersion":1,"tier":"procedural","updatedAt":"t","records":[{"id":"p1","ts":"t","text":"Book the lab on Fridays","embedding":[0.5,0.25]}]}';
    // The disk fills partway through the temporary. Node 22.13.1's own writeFile does this (seen 2026-10-11: 4 MiB
    // written to a 1 MB disk image): it leaves the part it wrote, there its first 512 KiB, and rejects with a plain Error
    // with errno -28, code ENOSPC and syscall write, and no path. The double writes a part with the real writeFile,
    // records the folder as the failure leaves it, then fails the same way.
    const part = '{"schemaVersion":1,"tier":"procedural","updatedAt":"t","records":[{"id":"p1"';
    const full = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      errno: -28,
      code: 'ENOSPC',
      syscall: 'write',
    });
    let atFailure: Record<string, string> | undefined;
    vi.mocked(writeFile).mockImplementationOnce(async () => {
      await put(temporary, part);
      atFailure = await tree(root);
      throw full;
    });
    const error = await rejection(store.write(scope, parsedDoc(replacement)));
    // The write rejects with writeFile's own error, unchanged: the very one, so no MemoryWriteCleanupFailed.
    expect(error).toBe(full);
    // When writeFile failed, the part it wrote lay beside the document, which was still whole.
    expect(atFailure).toEqual({
      [IVY]: 'folder',
      [`${IVY}/procedural.json`]: `${doc('procedural')}\n`,
      [`${IVY}/procedural.json.tmp-1727600000000-89abcdef`]: part,
    });
    // Each write wrote its temporary once, with its document's text and a newline; the first succeeded, the second failed.
    const writes = [
      [join(root, IVY, 'procedural.json.tmp-1727600000000-0a1b2c3d'), `${doc('procedural')}\n`],
      [temporary, `${replacement}\n`],
    ];
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(writeFile).mock.settledResults.map((result) => result.type)).toEqual(['fulfilled', 'rejected']);
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[4], [4]]);
    // The part was never renamed over the document: the first write's rename is the only one.
    const renames = [[join(root, IVY, 'procedural.json.tmp-1727600000000-0a1b2c3d'), target]];
    expect(vi.mocked(rename).mock.calls).toEqual(renames);
    // The failed write removed the part it wrote, once.
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    expect(vi.mocked(rm).mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }]);
    // So the folder holds the document the write was to replace, whole, and nothing else.
    const kept = { [IVY]: 'folder', [`${IVY}/procedural.json`]: `${doc('procedural')}\n` };
    expect(await tree(root)).toEqual(kept);
    // At the next start, it validates: one document, and no temporary to remove.
    expect(await validateMemory(root)).toEqual({ files: 1, temporariesRemoved: 0 });
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    expect(vi.mocked(readFile).mock.calls).toEqual([[target, 'utf8']]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([
      ['procedural', `${doc('procedural')}\n`, target, expect.any(Function)],
    ]);
    // Validation wrote, renamed and removed nothing: the writes' own calls are the only ones, and the folder stays.
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(rename).mock.calls).toEqual(renames);
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    expect(await tree(root)).toEqual(kept);
    expect(onDropped).not.toHaveBeenCalled();
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it("a write that fails and cannot remove its temporary either rejects with MemoryWriteCleanupFailed, losing neither error, and the next start's validation removes the temporary it left", async () => {
    const root = await tempRoot();
    const onDropped = vi.fn();
    const onMalformed = vi.fn();
    const store = new MemoryStore({ root, onDropped, onMalformed });
    const scope = { channel: 'lab', user: 'ivy' };
    pinClock();
    vi.mocked(randomBytes)
      .mockReturnValueOnce(Buffer.from('0a1b2c3d', 'hex') as never)
      .mockReturnValueOnce(Buffer.from('89abcdef', 'hex') as never);
    await store.write(scope, parsedDoc(doc('semantic')));
    // A folder where procedural.json belongs: the temporary is written, and renaming it over the document fails.
    const target = join(root, IVY, 'procedural.json');
    const temporary = join(root, IVY, 'procedural.json.tmp-1727600000000-89abcdef');
    await mkdir(target);
    // And removing the temporary fails too. Shaped as Node's own error for it: rm with force, on a file in a folder it may
    // not write, rejects with a plain Error, EACCES, syscall unlink (Node 22.13.1, seen 2026-10-10) — force forgives
    // only a path that is not there.
    const denied = Object.assign(new Error(`EACCES: permission denied, unlink '${temporary}'`), {
      errno: -13,
      code: 'EACCES',
      syscall: 'unlink',
      path: temporary,
    });
    vi.mocked(rm).mockRejectedValueOnce(denied);
    const error = await rejection(store.write(scope, parsedDoc(doc('procedural'))));
    // The error whole: its name; its message, naming the file and the removal's failure by its code and syscall alone;
    // and no own property but these, its cause and the removal's error (PRINCIPLES §12: neither failure is lost).
    const e = error as MemoryWriteCleanupFailed;
    expect({ name: e.name, message: e.message, own: Object.getOwnPropertyNames(e).sort(byCodeUnit) }).toEqual({
      name: 'MemoryWriteCleanupFailed',
      message: `memory file ${target} was not saved: EISDIR (rename), and removing its temporary failed too: EACCES (unlink)`,
      own: ['cause', 'cleanup', 'message', 'name', 'stack'],
    });
    expect(Object.getPrototypeOf(error)).toBe(MemoryWriteCleanupFailed.prototype);
    // The removal's error is kept as the very one rm rejected with.
    expect(e.cleanup).toBe(denied);
    // The cause is the write's own error: the very one its rename rejected with, Node's EISDIR.
    const renames = [
      [join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), join(root, IVY, 'semantic.json')],
      [temporary, target],
    ];
    expect(vi.mocked(rename).mock.calls).toEqual(renames);
    const renamed = vi.mocked(rename).mock.settledResults;
    expect(renamed.map((result) => result.type)).toEqual(['fulfilled', 'rejected']);
    expect(e.cause).toBe(present(renamed[1], 'renamed[1]').value);
    expect(fsError(e.cause)).toEqual({
      message: `EISDIR: illegal operation on a directory, rename '${temporary}' -> '${target}'`,
      code: 'EISDIR',
      syscall: 'rename',
    });
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[4], [4]]);
    // Each write wrote its temporary once, with its document's text and a newline, and both succeeded: the failed write's
    // temporary held its whole document when its rename failed.
    const writes = [
      [join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), `${doc('semantic')}\n`],
      [temporary, `${doc('procedural')}\n`],
    ];
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(writeFile).mock.settledResults).toEqual([
      { type: 'fulfilled', value: undefined },
      { type: 'fulfilled', value: undefined },
    ]);
    // The failed write tried once to remove its own temporary; the first write, which succeeded, removed nothing.
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }]]);
    // So the temporary stays, whole, beside the folder that stopped its rename.
    expect(await tree(root)).toEqual({
      [IVY]: 'folder',
      [`${IVY}/procedural.json`]: 'folder',
      [`${IVY}/procedural.json.tmp-1727600000000-89abcdef`]: `${doc('procedural')}\n`,
      [`${IVY}/semantic.json`]: `${doc('semantic')}\n`,
    });
    // The folder put right (by the real rm: the spy records only the code's), the next start's validation removes the
    // temporary the write left — plainly, by name — and passes: one document.
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await real.rm(target, { recursive: true });
    expect(await validateMemory(root)).toEqual({ files: 1, temporariesRemoved: 1 });
    expect(vi.mocked(readdir).mock.calls).toEqual([
      [root, WITH_TYPES],
      [join(root, IVY), WITH_TYPES],
    ]);
    expect(vi.mocked(rm).mock.calls).toEqual([[temporary, { force: true }], [temporary]]);
    expect(vi.mocked(readFile).mock.calls).toEqual([[join(root, IVY, 'semantic.json'), 'utf8']]);
    expect(vi.mocked(parseDoc).mock.calls).toEqual([
      ['semantic', `${doc('semantic')}\n`, join(root, IVY, 'semantic.json'), expect.any(Function)],
    ]);
    expect(await tree(root)).toEqual({ [IVY]: 'folder', [`${IVY}/semantic.json`]: `${doc('semantic')}\n` });
    // Validation wrote and renamed nothing: the two writes' own calls are the only ones.
    expect(vi.mocked(writeFile).mock.calls).toEqual(writes);
    expect(vi.mocked(rename).mock.calls).toEqual(renames);
    expect(onDropped).not.toHaveBeenCalled();
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it("a write of a document JSON cannot write, in a scope folder that exists, rejects with JSON's own error before it names a temporary, and changes nothing", async () => {
    const root = await tempRoot();
    const onDropped = vi.fn();
    const onMalformed = vi.fn();
    const store = new MemoryStore({ root, onDropped, onMalformed });
    const scope = { channel: 'lab', user: 'ivy' };
    pinClock();
    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from('0a1b2c3d', 'hex') as never);
    await store.write(scope, parsedDoc(doc('semantic')));
    // A document JSON cannot write: JSON.stringify throws before a temporary is named, so nothing is written or removed.
    const cyclic: Record<string, unknown> = { schemaVersion: 1, tier: 'procedural', updatedAt: 't', records: [] };
    cyclic['self'] = cyclic;
    const error = await rejection(store.write(scope, cyclic as never));
    // JSON.stringify's own error for this document — not the code under test, and its whole message is V8's, so it is
    // taken from V8 rather than written out — is what the write rejects with: the same class, message and cause.
    const own = thrown(() => JSON.stringify(cyclic));
    expect(Object.getPrototypeOf(own)).toBe(TypeError.prototype);
    expect((own as Error).message.split('\n')[0]).toBe('Converting circular structure to JSON');
    expect(Object.getPrototypeOf(error)).toBe(TypeError.prototype);
    expect({ message: (error as Error).message, cause: (error as Error).cause }).toEqual({
      message: (own as Error).message,
      cause: undefined,
    });
    // Only the first write named a temporary; the failed one named none and so had none to write, rename or remove.
    expect(vi.mocked(randomBytes).mock.calls).toEqual([[4]]);
    expect(vi.mocked(writeFile).mock.calls).toEqual([
      [join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), `${doc('semantic')}\n`],
    ]);
    expect(vi.mocked(writeFile).mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }]);
    expect(vi.mocked(rename).mock.calls).toEqual([
      [join(root, IVY, 'semantic.json.tmp-1727600000000-0a1b2c3d'), join(root, IVY, 'semantic.json')],
    ]);
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect(await tree(root)).toEqual({ [IVY]: 'folder', [`${IVY}/semantic.json`]: `${doc('semantic')}\n` });
    expect(onDropped).not.toHaveBeenCalled();
    expect(onMalformed).not.toHaveBeenCalled();
    expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
  });

  it("a write of a document JSON cannot write, in a scope with no folder yet, rejects with JSON's own error before it names a temporary, and leaves only the empty scope folder it made first", async () => {
    // MemoryStore.write makes the scope folder before it turns the document into text (store.ts), so in a new scope the
    // same failure leaves that folder, empty: what a scope's first failed write leaves, which validation at start passes
    // (above). No temporary is named, so randomBytes, strict, is not arranged, and the clock is not read.
    const root = await tempRoot();
    const onDropped = vi.fn();
    const onMalformed = vi.fn();
    const store = new MemoryStore({ root, onDropped, onMalformed });
    const cyclic: Record<string, unknown> = { schemaVersion: 1, tier: 'procedural', updatedAt: 't', records: [] };
    cyclic['self'] = cyclic;
    expect(await tree(root)).toEqual({});
    const error = await rejection(store.write({ channel: 'lab', user: 'ivy' }, cyclic as never));
    // JSON.stringify's own error for this document, taken from V8 as in the test above, is what the write rejects with.
    const own = thrown(() => JSON.stringify(cyclic));
    expect(Object.getPrototypeOf(own)).toBe(TypeError.prototype);
    expect((own as Error).message.split('\n')[0]).toBe('Converting circular structure to JSON');
    expect(Object.getPrototypeOf(error)).toBe(TypeError.prototype);
    expect({ message: (error as Error).message, cause: (error as Error).cause }).toEqual({
      message: (own as Error).message,
      cause: undefined,
    });
    // It named no temporary, so it wrote, renamed and removed none.
    expect(vi.mocked(randomBytes)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    // What it leaves is ivy's scope folder, empty, and nothing else.
    expect(await tree(root)).toEqual({ [IVY]: 'folder' });
    expect(onDropped).not.toHaveBeenCalled();
    expect(onMalformed).not.toHaveBeenCalled();
    expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(parseDoc)).not.toHaveBeenCalled();
  });
});

describe("a memory file that is not JSON is reported by position, never quoted (R15's privacy; A15)", () => {
  it('names the file and SyntaxError at position <n>, and no byte of the file', () => {
    const text = '{"from":"zora","x":}';
    const error = thrown(() => parseDoc('semantic', text, '/memory/abc/semantic.json', () => undefined));
    expect(invalid(error)).toEqual(refused('/memory/abc/semantic.json', 'not JSON (SyntaxError at position 19)'));
    expect((error as Error).message).not.toContain('zora');
  });

  // Where Node 22.13.1's JSON.parse names a position for the same text, it is this one (read 2026-10-10). For the
  // texts it names none ({"a":}, "", [1,], {"a":tru}), the position follows from the definition (store.ts): the
  // first character that cannot continue a JSON value, or the text's length when it ends too soon.
  it.each([
    ['{"a":}', 5],
    ['{"a":1', 6],
    ['', 0],
    ['[1,]', 3],
    ['{"a":tru}', 8],
    ['{"a":"b\\q"}', 8],
    ['{"a":1} x', 8],
    ['{"a":01}', 6],
    ['{"a":"\\u12"}', 10],
    ['{"a":"b\tc"}', 7],
    ['{"a":-}', 6],
  ])('finds where %j breaks: %i', (text, position) => {
    expect(() => {
      JSON.parse(text);
    }).toThrow(SyntaxError);
    expect(jsonErrorPosition(text)).toBe(position);
  });
});
