// The memory image's side of agent persistence (docs/plans/agent-persistence.md R12, R16). At start, before it
// joins the channel, every file under /memory — restored from saved state, or empty — is validated, and the agent
// exits non-zero naming the first invalid one. And the erase mode, `erase-user --channel <c> --user <u>`, run once
// by the harness over a copy of the saved /memory with no network and no channel: it deletes that user's scope
// folder without parsing any memory file, and prints exactly one line counting what it deleted.

import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { present } from '../../../../src/shared/assert-present.js';
import { NAME_PATTERN } from '../../../../src/shared/protocol.js';
import { MemoryFileInvalid, parseDoc, scopeKey } from './store.js';
import { TIERS, type Tier } from './types.js';

/** One scope folder's files, validated (validateMemory's inner loop): counts, or the first invalid file, thrown. */
async function validateScopeFiles(
  path: string,
): Promise<{ readonly files: number; readonly temporariesRemoved: number }> {
  let files = 0;
  let temporariesRemoved = 0;
  for (const entry of (await readdir(path, { withFileTypes: true })).toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = join(path, entry.name);
    if (entry.isFile() && TEMPORARY.test(entry.name)) {
      await rm(file);
      temporariesRemoved += 1;
      continue;
    }
    const tier = entry.name.endsWith('.json') ? (entry.name.slice(0, -'.json'.length) as Tier) : undefined;
    if (!entry.isFile() || tier === undefined || !TIERS.includes(tier))
      throw new MemoryFileInvalid(file, 'not a memory document');
    // A dropped record is tolerated as reading tolerates it; a file that is not a document is not.
    parseDoc(tier, await readFile(file, 'utf8'), file, () => undefined);
    files += 1;
  }
  return { files, temporariesRemoved };
}

/**
 * Validates every persisted file (R12): /memory holds only scope folders (16 hex digits), each holding only
 * `<tier>.json` documents, each parsing as its tier. The first invalid file throws MemoryFileInvalid naming it.
 * An empty or absent root is valid. A write's temporary (`<tier>.json.tmp-<ms>-<hex>`, MemoryStore.write) is a write a
 * checkpoint's copy caught half done — its document is the one beside it — so it is removed and counted, not refused.
 */
export async function validateMemory(
  root: string,
): Promise<{ readonly files: number; readonly temporariesRemoved: number }> {
  let files = 0;
  let temporariesRemoved = 0;
  let scopes;
  try {
    scopes = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files, temporariesRemoved };
    throw error;
  }
  for (const scope of scopes.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(root, scope.name);
    if (!scope.isDirectory() || !/^[0-9a-f]{16}$/.test(scope.name))
      throw new MemoryFileInvalid(path, 'not a memory scope folder');
    const counted = await validateScopeFiles(path);
    files += counted.files;
    temporariesRemoved += counted.temporariesRemoved;
  }
  return { files, temporariesRemoved };
}

/** MemoryStore.write's temporary beside a tier's document. */
const TEMPORARY = new RegExp(`^(${TIERS.join('|')})\\.json\\.tmp-[0-9]+-[0-9a-f]{8}$`);

/**
 * The erase mode's arguments: exactly `erase-user --channel <c> --user <u>`.
 * @returns `{channel, user}` when they parse; otherwise a description of what is wrong.
 */
export function parseEraseArgs(argv: readonly string[]): { readonly channel: string; readonly user: string } | string {
  if (argv.length !== 5 || argv[0] !== 'erase-user' || argv[1] !== '--channel' || argv[3] !== '--user')
    return 'usage: erase-user --channel <channel> --user <user>';
  const channel = present(argv[2], 'argv[2]');
  const user = present(argv[4], 'argv[4]');
  if (!NAME_PATTERN.test(channel)) return 'the channel is not a channel name';
  if (!NAME_PATTERN.test(user)) return 'the user is not a user ID';
  return { channel, user };
}

/**
 * Erases one user's memory on one channel (R16): the scope folder `scopeKey({channel, user})` and everything in it,
 * counting the regular files and their bytes as it goes, parsing none. Nothing to erase is not an error: an absent
 * scope folder gives 0 and 0, and so does one that holds no regular file, which is then deleted. Only the folder's own
 * absence is taken as nothing there; once it is found, any failure counting or deleting it — an ENOENT from inside it
 * too — rejects (PRINCIPLES §12).
 */
export async function eraseUser(
  root: string,
  scope: { readonly channel: string; readonly user: string },
): Promise<{ readonly files: number; readonly bytes: number }> {
  const dir = join(root, scopeKey(scope));
  let found: Stats;
  try {
    found = await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0 };
    throw error;
  }
  let files = 0;
  let bytes = 0;
  const count = async (path: string, entry: Stats): Promise<void> => {
    if (entry.isDirectory()) {
      for (const name of await readdir(path)) await count(join(path, name), await lstat(join(path, name)));
    } else if (entry.isFile()) {
      files += 1;
      bytes += entry.size;
    }
  };
  await count(dir, found);
  await rm(dir, { recursive: true });
  return { files, bytes };
}

/** The one line the erase mode prints on success (R16). */
function erasedLine(result: { readonly files: number; readonly bytes: number }): string {
  return `${JSON.stringify({ erased: { files: result.files, bytes: result.bytes } })}\n`;
}

/**
 * The erase mode, whole (R16): its arguments checked, the user's scope folder erased, exactly one line on stdout,
 * and the exit code — 0 on success, 2 for arguments it does not take, 1 for any other failure, whose reason goes
 * to stderr, as one JSON line naming the scope by its key, never the user. It reads no environment and needs no
 * channel or model.
 */
export async function runEraseMode(
  argv: readonly string[],
  io: { readonly root: string; readonly stdout: (text: string) => void; readonly stderr: (text: string) => void },
): Promise<number> {
  const args = parseEraseArgs(argv);
  if (typeof args === 'string') {
    io.stderr(`${JSON.stringify({ level: 'error', event: 'memory.erase_failed', error: args })}\n`);
    return 2;
  }
  try {
    io.stdout(erasedLine(await eraseUser(io.root, args)));
    return 0;
  } catch (error) {
    io.stderr(
      `${JSON.stringify({ level: 'error', event: 'memory.erase_failed', scope: scopeKey(args), error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    return 1;
  }
}
