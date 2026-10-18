// The four file tools (docs/plans/agent-tools.md R9): list_files, read_file,
// write_file and append_file, acting only inside two roots — /workspace, the
// agent's own directory, and /channel, the file space the channel's agents
// share (docs/plans/agent-files.md R4, R5: a Docker volume mounted in every
// agent container of the channel; `channelSpace: null`, in tests only, makes
// every /channel path `no_channel_space`).
//
// Confinement. A path is resolved lexically against its root; one that leaves
// it, or names anything outside both roots, is refused before anything is
// touched. Every component is then checked with lstat, and a symbolic link
// anywhere — pointing inside a root or not — is refused. Files are opened with
// O_NOFOLLOW | O_NONBLOCK, so the last component is never followed and a FIFO
// never blocks, and the opened descriptor must be a regular file. Because
// other agents and plugin containers write /channel concurrently, a directory
// could be swapped for a link between the check and the open: after opening,
// the path is walked again and must still hold no link and lead to the very
// file that was opened (same device and inode), else nothing is read or
// written. (The plan named /proc/self/fd/<fd> for this check; that is Linux
// only, and the unit tests run on macOS, so the identity check is used on
// both — it closes the same race, and the tests prove it.)
//
// Writes, appends and new directories are made only from inside the directory the walk checked (debt D20, paid by
// docs/plans/agent-files.md R5): one synchronous step changes the process's working directory to it, proves with
// stat('.') that it is the very directory the walk checked (same device and inode), and only then creates, writes or
// renames by a name relative to it — the equivalent of openat and renameat, which Node does not expose, and on every
// platform (macOS has no path through a directory's descriptor). A folder on the path swapped for a link before the
// step lands it elsewhere, which the identity check refuses before anything is made; a swap after it cannot move what
// is made, which is anchored to the directory's inode, inside its root. The step is synchronous end to end and puts
// the working directory back before it returns, so no other code of the agent ever runs with it changed; every path
// the agent's process uses is absolute (the roots are), so nothing in flight resolves against it either. A write goes
// to a new temp file renamed over the target, so no reader sees a partial file; when the second step (the rename)
// finds the directory moved, the complete temp file stays where it was made, inside the root.
//
// Expected failures are data (R4). Every handler runs behind one boundary,
// `asToolFailure`, which maps the errno codes a model-chosen path can meet —
// a name too long, a file it may not open — to reasons; anything else is a
// defect and fails the turn. Each call honours its abort signal before every
// step that changes a file, so a call past its 10 s bound stops before its
// next change; a single write already under way completes (a known bound,
// finding 12).

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync as rmFileSync,
  writeSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { present } from '../shared/assert-present.js';
import { SPACE_MAX_BYTES, SPACE_MAX_ENTRIES } from '../shared/files.js';
import { byKey } from '../shared/order.js';
import {
  WORKSPACE_MAX_BYTES,
  WORKSPACE_MAX_FILES,
  parseToolParameters,
  type ToolFailureReason,
} from '../shared/tools.js';
import type { AgentLog } from './log.js';
import {
  COMMON_TOOL_DEFINITIONS,
  failed,
  ok,
  resultBytes,
  type ToolImplementation,
  type ToolOutcome,
} from './tools.js';

/** Bound on one file-tool call (R5). */
const FILE_TOOL_TIMEOUT_MS = 10_000;
/** The most one read or listing returns (R9). */
const MAX_READ_BYTES = 8 * 1024;
/** The largest file a write or an append may leave (R9). */
const MAX_FILE_BYTES = 256 * 1024;

interface SpaceBounds {
  /** The most it may hold of what `counts` names. */
  readonly maxFiles: number;
  readonly maxBytes: number;
  /**
   * What counts toward `maxFiles`: regular files only (/workspace), or every entry — file, directory, link or other
   * — so no agent can exhaust the VM's inodes with directories (/channel, agent-files R11).
   */
  readonly counts: 'files' | 'entries';
  /** The reason a write past either bound returns. */
  readonly full: ToolFailureReason;
}

/** /workspace: 256 files and 16 MiB, the recipe's documents included (R9). */
const WORKSPACE_BOUNDS: SpaceBounds = {
  maxFiles: WORKSPACE_MAX_FILES,
  maxBytes: WORKSPACE_MAX_BYTES,
  counts: 'files',
  full: 'workspace_full',
};
/** /channel: docs/plans/agent-files.md R11's 1,000 entries and 256,000,000 bytes (SPACE_MAX_ENTRIES, SPACE_MAX_BYTES). */
const CHANNEL_BOUNDS: SpaceBounds = {
  maxFiles: SPACE_MAX_ENTRIES,
  maxBytes: SPACE_MAX_BYTES,
  counts: 'entries',
  full: 'space_full',
};

const WORKSPACE_PATH = '/workspace';
const CHANNEL_PATH = '/channel';

export interface FileToolsProps {
  /** The directory /workspace names: `/workspace` itself in a container, a temporary directory in tests. */
  readonly workspace: string;
  /** The directory /channel names, or null while no channel space is mounted (every /channel path is no_channel_space). */
  readonly channelSpace: string | null;
  /** The agent's handle, for the audit record. */
  readonly handle: string;
  readonly log: AgentLog;
  /**
   * Test seams only (A13): `beforeOpen` runs after a path's components are checked and before the file or
   * directory is opened, `afterOpen` right after the open and before the second walk, so a test can swap a
   * directory for a link in the first window and back in the second. Production passes neither.
   */
  readonly beforeOpen?: (realPath: string) => Promise<void>;
  readonly afterOpen?: (realPath: string) => Promise<void>;
  /** Test seam only (agent-files A7): runs after write_file's temp file is complete and before its rename. */
  readonly beforeRename?: (realPath: string) => Promise<void>;
  /** Test seam only (agent-files A7): runs after a missing folder's parent is checked and before the folder is made. */
  readonly beforeMkdir?: (realPath: string) => Promise<void>;
}

type Root = { readonly name: string; readonly dir: string; readonly bounds: SpaceBounds };
type Resolved = { readonly root: Root; readonly parts: readonly string[]; readonly virtual: string };
type Failure = { readonly ok: false; readonly reason: ToolFailureReason };
type Walked = { readonly ok: true; readonly path: string; readonly final: Stats | null };
type FileEntry = { readonly name: string; readonly type: 'file' | 'dir' | 'link' | 'other'; readonly size: number };

const fail = (reason: ToolFailureReason): Failure => ({ ok: false, reason });

/** A listed entry's kind, named without a nested ternary. */
function direntType(dirent: Dirent): FileEntry['type'] {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isSymbolicLink()) return 'link';
  return 'other';
}

/**
 * A fresh read of `signal.aborted`, through a function call TypeScript cannot narrow across: a second direct read
 * in the same scope is otherwise seen as always `false`, carrying forward the negative branch of an earlier check,
 * even though an `await` between the two lets the signal actually abort in between.
 */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** The four file tools, keyed by name. */
export function fileTools(props: FileToolsProps): Map<string, ToolImplementation> {
  const files = new FileTools(props);
  const make = (
    name: 'list_files' | 'read_file' | 'write_file' | 'append_file',
    run: ToolImplementation['run'],
  ): [string, ToolImplementation] => [
    name,
    {
      definition: COMMON_TOOL_DEFINITIONS[name],
      parameters: parseToolParameters(COMMON_TOOL_DEFINITIONS[name].function.parameters),
      timeoutMs: FILE_TOOL_TIMEOUT_MS,
      run,
    },
  ];
  return new Map([
    make('list_files', (a) => asToolFailure(() => files.list(String(a['path']), a['after'] as string | undefined))),
    make('read_file', (a) =>
      asToolFailure(() =>
        files.read(
          String(a['path']),
          (a['offset'] as number | undefined) ?? 0,
          (a['length'] as number | undefined) ?? MAX_READ_BYTES,
        ),
      ),
    ),
    make('write_file', (a, signal) =>
      asToolFailure(() => files.write(String(a['path']), String(a['content']), signal)),
    ),
    make('append_file', (a, signal) =>
      asToolFailure(() => files.append(String(a['path']), String(a['content']), signal)),
    ),
  ]);
}

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/**
 * The errno codes a model-chosen path or a file's own state can produce, and the reason each is. Narrowed on
 * the code, never on the kind of error: anything else rethrows and fails the turn (PRINCIPLES §11).
 */
export const EXPECTED_ERRNO: Readonly<Record<string, ToolFailureReason>> = {
  ENAMETOOLONG: 'invalid_arguments', // a name over 255 bytes or a path over the system's limit
  EACCES: 'not_permitted', // a file or directory the agent's user may not open (mode 000, another owner)
  EPERM: 'not_permitted',
  EROFS: 'not_permitted',
  ENOENT: 'not_found', // removed between the walk and the open
  ENOTDIR: 'not_found',
  EISDIR: 'not_a_file',
  ENXIO: 'not_a_file', // a FIFO or socket opened for writing with nobody on the other end
  ELOOP: 'path_outside_workspace', // O_NOFOLLOW met a link as the last component
  EMLINK: 'path_outside_workspace', // (the same, on BSD-derived systems)
};

/** A regular file's size, or undefined if it was removed since the listing; anything else rethrows. */
async function fileSize(dir: string, name: string): Promise<number | undefined> {
  try {
    return (await lstat(join(dir, name))).size;
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** The one boundary of every file tool: an expected errno becomes its reason; everything else is rethrown. */
export async function asToolFailure(run: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await run();
  } catch (error) {
    const reason = EXPECTED_ERRNO[errno(error) ?? ''];
    if (reason === undefined) throw error;
    return failed(reason);
  }
}

class FileTools {
  constructor(private readonly props: FileToolsProps) {}

  async list(path: string, after: string | undefined): Promise<ToolOutcome> {
    const resolved = this.resolve(path);
    if ('reason' in resolved) return failed(resolved.reason);
    const walked = await walk(resolved);
    if (!walked.ok) return failed(walked.reason);
    if (walked.final === null) return failed('not_found');
    if (!walked.final.isDirectory()) return failed('not_a_file');
    await this.props.beforeOpen?.(walked.path);
    const handle = await open(walked.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await this.props.afterOpen?.(walked.path);
      // The directory opened must be the one the path names now: no link on the way, same device and inode.
      const again = await walk(resolved);
      if (!again.ok || again.final === null || !sameFile(again.final, await handle.stat()))
        return failed('path_outside_workspace');
      // On Linux, where agents run, the directory is read through its descriptor, so what is listed is what was
      // checked. Elsewhere (the unit tests' macOS) there is no such path; it is read by name, once more checked.
      const dir = process.platform === 'linux' ? `/proc/self/fd/${String(handle.fd)}` : walked.path;
      const names = (await readdir(dir, { withFileTypes: true })).sort(byKey('name'));
      const { entries, nextAfter } = await this.listEntries(dir, names, after);
      return ok(nextAfter === undefined ? { entries } : { entries, next_after: nextAfter });
    } finally {
      await handle.close();
    }
  }

  /** The page of entries after `after`, within one result's byte bound; `nextAfter` names where to resume. */
  private async listEntries(
    dir: string,
    names: readonly Dirent[],
    after: string | undefined,
  ): Promise<{ readonly entries: FileEntry[]; readonly nextAfter: string | undefined }> {
    const entries: FileEntry[] = [];
    let nextAfter: string | undefined;
    for (const dirent of names) {
      if (after !== undefined && dirent.name <= after) continue;
      const type = direntType(dirent);
      const size = type === 'file' ? await fileSize(dir, dirent.name) : 0;
      if (size === undefined) continue; // removed since the listing: it is not there to list
      const entry: FileEntry = { name: dirent.name, type, size };
      // The listing's JSON, with a next_after naming its last entry, must fit one result.
      if (resultBytes({ entries: [...entries, entry], next_after: entry.name }) > MAX_READ_BYTES) {
        nextAfter = entries.at(-1)?.name;
        break;
      }
      entries.push(entry);
    }
    return { entries, nextAfter };
  }

  async read(path: string, offset: number, length: number): Promise<ToolOutcome> {
    const resolved = this.resolve(path);
    if ('reason' in resolved) return failed(resolved.reason);
    const opened = await this.openChecked(resolved, constants.O_RDONLY);
    if (!opened.ok) return failed(opened.reason);
    const { handle, stats } = opened;
    try {
      const want = Math.min(length, MAX_READ_BYTES);
      const buffer = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buffer, 0, want, offset);
      const cut = utf8Boundary(buffer.subarray(0, bytesRead));
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, cut));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return failed('not_text');
      }
      // The result's JSON must fit one result: escapes (a NUL is six bytes) can make it larger than the bytes read,
      // so the content is cut, at a character, to the longest prefix whose result fits.
      const result = (text: string) => {
        const next = offset + Buffer.byteLength(text, 'utf8');
        return next < stats.size
          ? { content: text, size: stats.size, next_offset: next }
          : { content: text, size: stats.size };
      };
      if (resultBytes(result(content)) <= MAX_READ_BYTES) return ok(result(content));
      const chars = Array.from(content);
      let low = 0;
      let high = chars.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (resultBytes(result(chars.slice(0, mid).join(''))) <= MAX_READ_BYTES) low = mid;
        else high = mid - 1;
      }
      return ok(result(chars.slice(0, low).join('')));
    } finally {
      await handle.close();
    }
  }

  async write(path: string, content: string, signal: AbortSignal): Promise<ToolOutcome> {
    const resolved = this.resolve(path);
    if ('reason' in resolved) return failed(resolved.reason);
    if (resolved.parts.length === 0) return failed('not_a_file');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_FILE_BYTES) return failed('file_too_large');
    const before = await walk(resolved);
    if (!before.ok && before.reason !== 'not_found') return failed(before.reason);
    const existing = before.ok ? before.final : null;
    if (existing !== null && !existing.isFile()) return failed('not_a_file');
    const full = await this.overBound(resolved, existing, bytes.byteLength - (existing?.size ?? 0));
    if (full !== undefined) return failed(full);

    const name = present(resolved.parts.at(-1), "the resolved path's last component");
    if (signal.aborted) return failed('timeout');
    const dir = await makeDirectories(resolved, this.props.beforeMkdir);
    if (!dir.ok) return failed(dir.reason);
    await this.props.beforeOpen?.(join(dir.path, name));
    // A fixed-length temp name, whatever the target's: a name the model chose at the 255-byte limit stays legal.
    const temp = `.asha-${randomBytes(6).toString('hex')}.tmp`;
    if (aborted(signal)) return failed('timeout');
    // Made, written and closed from inside the checked directory: nothing can land outside it (D20).
    const made = inDirectory(dir.path, dir.stats, () => {
      const fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        writeAll(fd, bytes);
      } finally {
        closeSync(fd);
      }
      return true;
    });
    if (made === undefined) return failed('path_outside_workspace');
    await this.props.afterOpen?.(join(dir.path, temp));
    await this.props.beforeRename?.(join(dir.path, name));
    // Renamed into place from inside the same directory, proven again: the rename cannot follow a link either.
    const renamed = inDirectory(dir.path, dir.stats, () => {
      if (signal.aborted) {
        unlinkIfPresent(temp);
        return 'timeout' as const;
      }
      renameSync(temp, name);
      return 'renamed' as const;
    });
    if (renamed === undefined) return failed('path_outside_workspace');
    if (renamed === 'timeout') return failed('timeout');
    return this.written(resolved);
  }

  async append(path: string, content: string, signal: AbortSignal): Promise<ToolOutcome> {
    const resolved = this.resolve(path);
    if ('reason' in resolved) return failed(resolved.reason);
    if (resolved.parts.length === 0) return failed('not_a_file');
    const bytes = Buffer.from(content, 'utf8');
    const before = await walk(resolved);
    if (!before.ok && before.reason !== 'not_found') return failed(before.reason);
    const existing = before.ok ? before.final : null;
    if (existing !== null && !existing.isFile()) return failed('not_a_file');
    if ((existing?.size ?? 0) + bytes.byteLength > MAX_FILE_BYTES) return failed('file_too_large');
    const full = await this.overBound(resolved, existing, bytes.byteLength);
    if (full !== undefined) return failed(full);

    const name = present(resolved.parts.at(-1), "the resolved path's last component");
    if (signal.aborted) return failed('timeout');
    const dir = await makeDirectories(resolved, this.props.beforeMkdir);
    if (!dir.ok) return failed(dir.reason);
    await this.props.beforeOpen?.(join(dir.path, name));
    // An open with O_CREAT changes the file system: past the call's bound, it is not made.
    if (aborted(signal)) return failed('timeout');
    // Opened (made, if missing), checked and appended to from inside the checked directory (D20).
    const appended = inDirectory(dir.path, dir.stats, (): ToolFailureReason | 'appended' => {
      const fd = openSync(
        name,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o644,
      );
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile()) return 'not_a_file';
        if (stats.size + bytes.byteLength > MAX_FILE_BYTES) return 'file_too_large';
        writeAll(fd, bytes);
        return 'appended';
      } finally {
        closeSync(fd);
      }
    });
    if (appended === undefined) return failed('path_outside_workspace');
    if (appended !== 'appended') return failed(appended);
    return this.written(resolved);
  }

  /**
   * Whether a write or an append of `addedBytes` (net) would take the root past its bound: in /channel every entry
   * counts, the missing folders the write would make included (agent-files R11); in /workspace regular files only.
   */
  private async overBound(
    resolved: Resolved,
    existing: Stats | null,
    addedBytes: number,
  ): Promise<ToolFailureReason | undefined> {
    const { bounds } = resolved.root;
    const usage = await spaceUsage(resolved.root.dir);
    const missingFolders = bounds.counts === 'entries' ? await missingDirectories(resolved) : 0;
    const added = existing !== null ? 0 : 1 + missingFolders;
    const count = (bounds.counts === 'entries' ? usage.entries : usage.files) + added;
    return count > bounds.maxFiles || usage.bytes + addedBytes > bounds.maxBytes ? bounds.full : undefined;
  }

  /** The audit record of a successful write or append (R9), size and SHA-256 read back from the file. */
  private async written(resolved: Resolved): Promise<ToolOutcome> {
    const opened = await this.openChecked(resolved, constants.O_RDONLY);
    if (!opened.ok) return failed(opened.reason);
    let content: Buffer;
    try {
      content = await opened.handle.readFile();
    } finally {
      await opened.handle.close();
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    this.props.log.info('tool.file_written', {
      handle: this.props.handle,
      path: resolved.virtual,
      size: content.byteLength,
      sha256,
    });
    return ok({ path: resolved.virtual, size: content.byteLength });
  }

  /** Opens a file with O_NOFOLLOW | O_NONBLOCK after checking its path, and proves it is the file the path names. */
  private async openChecked(
    resolved: Resolved,
    flags: number,
  ): Promise<Failure | { ok: true; handle: FileHandle; stats: Stats }> {
    if (resolved.parts.length === 0) return fail('not_a_file');
    if ((flags & constants.O_CREAT) !== 0)
      throw new Error('openChecked never creates: a file is made only from inside its checked directory (D20)');
    const walked = await walk(resolved);
    if (!walked.ok) return walked;
    if (walked.final === null) return fail('not_found');
    if (!walked.final.isFile()) return fail('not_a_file');
    await this.props.beforeOpen?.(walked.path);
    const handle = await open(walked.path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
    try {
      await this.props.afterOpen?.(walked.path);
      const stats = await handle.stat();
      if (!stats.isFile()) {
        await handle.close();
        return fail('not_a_file');
      }
      const again = await walk(resolved);
      if (!again.ok || again.final === null || !sameFile(again.final, stats)) {
        await handle.close();
        return fail('path_outside_workspace');
      }
      return { ok: true, handle, stats };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /** A tool's path, resolved lexically to its root and the components below it. */
  private resolve(path: string): Resolved | Failure {
    if (path.includes('\0')) return fail('invalid_arguments');
    const located = locateRoot(path);
    if (!located.ok) return located;
    const parts = normalizeParts(located.rest);
    if (parts === undefined) return fail('path_outside_workspace');
    if (located.rootName === CHANNEL_PATH && this.props.channelSpace === null) return fail('no_channel_space');
    return { root: this.rootFor(located.rootName), parts, virtual: [located.rootName, ...parts].join('/') };
  }

  /** The root a resolved path's name is, built from the agent's own props. */
  private rootFor(rootName: string): Root {
    return rootName === WORKSPACE_PATH
      ? { name: WORKSPACE_PATH, dir: this.props.workspace, bounds: WORKSPACE_BOUNDS }
      : { name: CHANNEL_PATH, dir: present(this.props.channelSpace, 'channel space'), bounds: CHANNEL_BOUNDS };
  }
}

/** The path's root (`/workspace` by default, else `/workspace` or `/channel` named explicitly) and what follows it. */
function locateRoot(path: string): { readonly ok: true; readonly rootName: string; readonly rest: string } | Failure {
  if (!path.startsWith('/')) return { ok: true, rootName: WORKSPACE_PATH, rest: path };
  const root = [WORKSPACE_PATH, CHANNEL_PATH].find((r) => path === r || path.startsWith(`${r}/`));
  if (root === undefined) return fail('path_outside_workspace');
  return { ok: true, rootName: root, rest: path.slice(root.length) };
}

/** `rest`'s segments, with `.` dropped and `..` popping a segment; undefined if `..` would leave the root. */
function normalizeParts(rest: string): string[] | undefined {
  const parts: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts;
}

/** One component of a walk: its stats (null only for a missing last component), or why the walk stops. */
async function walkStep(
  current: string,
  last: boolean,
): Promise<Failure | { readonly ok: true; readonly stats: Stats | null }> {
  try {
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) return fail('path_outside_workspace');
    if (!last && !stats.isDirectory()) return fail('not_found');
    return { ok: true, stats };
  } catch (error) {
    if (errno(error) === 'ENOTDIR') return fail('not_found');
    if (errno(error) !== 'ENOENT') throw error;
    return last ? { ok: true, stats: null } : fail('not_found');
  }
}

/**
 * Walks the components below the root with lstat. A link anywhere is path_outside_workspace; a missing or
 * non-directory component on the way is not_found, and a missing last component is `final: null`.
 */
async function walk(resolved: Resolved): Promise<Failure | Walked> {
  let current = resolved.root.dir;
  let stats: Stats | null = await lstat(current);
  for (const [i, part] of resolved.parts.entries()) {
    const last = i === resolved.parts.length - 1;
    current = join(current, part);
    const step = await walkStep(current, last);
    if (!step.ok) return step;
    stats = step.stats;
  }
  return { ok: true, path: current, final: stats };
}

/**
 * The directory a file of `resolved` goes in: every folder on the path checked with lstat (a link is
 * path_outside_workspace, a file not_found), and each missing one made from inside its checked parent (D20), so no
 * folder is ever made through a link. Returns the directory's path and its stats, for inDirectory's identity check.
 */
/** `current`'s stats if it exists, undefined if it does not; a non-missing lstat error (ENOTDIR) is a failure. */
async function statOrMissing(
  current: string,
): Promise<Failure | { readonly ok: true; readonly stats: Stats | undefined }> {
  try {
    return { ok: true, stats: await lstat(current) };
  } catch (error) {
    if (errno(error) === 'ENOTDIR') return fail('not_found');
    if (errno(error) !== 'ENOENT') throw error;
    return { ok: true, stats: undefined };
  }
}

/** Makes `part` from inside its checked `parent`, tolerating a concurrent creator (EEXIST); its stats once made. */
function createDirectory(part: string, parent: { readonly path: string; readonly stats: Stats }): Stats | undefined {
  return inDirectory(parent.path, parent.stats, () => {
    try {
      mkdirSync(part);
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
    }
    return lstatSync(part);
  });
}

/** `part`, found or made, below `current`'s checked `parent`; a link or a non-directory found there is a failure. */
async function ensureDirectory(
  parent: { readonly path: string; readonly stats: Stats },
  current: string,
  part: string,
  beforeMkdir: ((path: string) => Promise<void>) | undefined,
): Promise<Failure | { readonly ok: true; readonly stats: Stats }> {
  const found = await statOrMissing(current);
  if (!found.ok) return found;
  let stats = found.stats;
  if (stats === undefined) {
    await beforeMkdir?.(current);
    const made = createDirectory(part, parent);
    if (made === undefined) return fail('path_outside_workspace');
    stats = made;
  }
  if (stats.isSymbolicLink()) return fail('path_outside_workspace');
  if (!stats.isDirectory()) return fail('not_found');
  return { ok: true, stats };
}

async function makeDirectories(
  resolved: Resolved,
  beforeMkdir: ((path: string) => Promise<void>) | undefined,
): Promise<Failure | { readonly ok: true; readonly path: string; readonly stats: Stats }> {
  let current = resolved.root.dir;
  let stats = await lstat(current);
  if (!stats.isDirectory()) return fail('not_found');
  for (const part of resolved.parts.slice(0, -1)) {
    const parent = { path: current, stats };
    current = join(current, part);
    const ensured = await ensureDirectory(parent, current, part, beforeMkdir);
    if (!ensured.ok) return ensured;
    stats = ensured.stats;
  }
  return { ok: true, path: current, stats };
}

/** How many folders on the path to a file of `resolved` are missing: the ones a write would make. */
async function missingDirectories(resolved: Resolved): Promise<number> {
  const folders = resolved.parts.slice(0, -1);
  let current = resolved.root.dir;
  for (const [i, part] of folders.entries()) {
    current = join(current, part);
    try {
      await lstat(current);
    } catch (error) {
      if (errno(error) !== 'ENOENT' && errno(error) !== 'ENOTDIR') throw error;
      return folders.length - i;
    }
  }
  return 0;
}

/**
 * Runs `work` from inside `dir` — the process's working directory set to it — once stat('.') shows it is the
 * directory the walk checked (`expected`: same device and inode); undefined, having run nothing, when it is not (a
 * folder on the path was swapped for a link). `work` must be synchronous: the working directory is put back before
 * this returns, so no other code runs while it is changed (D20; the module's header says why this is safe).
 */
function inDirectory<T>(dir: string, expected: Stats, work: () => T): T | undefined {
  const back = process.cwd();
  try {
    process.chdir(dir);
  } catch (error) {
    // The checked directory is no longer at its path (moved away, or its path now runs through a link to nothing).
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errno(error) ?? '')) return undefined;
    throw error;
  }
  try {
    if (!sameFile(statSync('.'), expected)) return undefined;
    return work();
  } finally {
    process.chdir(back);
  }
}

/** Writes every byte to `fd`, looping over short writes. */
function writeAll(fd: number, bytes: Buffer): void {
  for (let at = 0; at < bytes.byteLength;) at += writeSync(fd, bytes, at, bytes.byteLength - at);
}

/** Removes `name` in the working directory, if it is there. */
function unlinkIfPresent(name: string): void {
  try {
    rmFileSync(name);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Under a root, not following links: its regular files, every entry below it (any kind), and the regular files' bytes. */
async function spaceUsage(dir: string): Promise<{ files: number; entries: number; bytes: number }> {
  let files = 0;
  let entries = 0;
  let bytes = 0;
  const visit = async (path: string): Promise<void> => {
    let listed;
    try {
      listed = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') return; // removed or replaced while counting
      throw error;
    }
    for (const entry of listed) {
      entries += 1;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        try {
          const stats = await lstat(full);
          files += 1;
          bytes += stats.size;
        } catch (error) {
          if (errno(error) !== 'ENOENT') throw error; // removed while counting: not there to count
        }
      }
    }
  };
  await visit(dir);
  return { files, entries, bytes };
}

/** How many bytes, lead byte included, the UTF-8 character starting with `lead` needs. */
function utf8SequenceLength(lead: number): number {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

/** The length of the longest prefix of `bytes` that does not end inside a UTF-8 character. */
export function utf8Boundary(bytes: Uint8Array): number {
  let end = bytes.length;
  // Step back over at most three continuation bytes to the lead byte of the last character.
  let back = 0;
  while (back < 3 && end - back - 1 >= 0 && (present(bytes[end - back - 1], 'a byte within bounds') & 0xc0) === 0x80)
    back += 1;
  const leadIndex = end - back - 1;
  if (leadIndex < 0) return end;
  const lead = present(bytes[leadIndex], 'a byte within bounds');
  const need = utf8SequenceLength(lead);
  // A complete last character (or a lone continuation run, which decoding rejects as not_text) is kept.
  if (back + 1 < need) end = leadIndex;
  return end;
}
