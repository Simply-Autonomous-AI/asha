// The filesystem as the state store uses it: the seam the crash-safety tests replace with a fault-injecting,
// call-recording double (docs/plans/agent-persistence.md A3). Every directory is made mode 0700 and every file 0600
// (R2); the pointer is replaced with writePrivateFile (write, fsync, rename).

import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';

import { writePrivateFile } from '../private-file/index.js';

/** A file being written: each chunk, then its fsync, then its close. */
export interface StateFile {
  write(chunk: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** One directory entry, typed without following links: a symbolic link is reported as such, never as its target. */
interface StateEntry {
  readonly name: string;
  readonly kind: 'directory' | 'file' | 'symlink' | 'other';
}

/**
 * The filesystem as the state store uses it: the seam the crash-safety tests replace with a fault-injecting,
 * call-recording double (tests/helpers/state-fakes.ts; agent-persistence A3).
 */
export interface StateFs {
  /** Creates one directory, mode 0700, failing (EEXIST) if anything is there: a generation is never written twice. */
  mkdirExclusive(path: string): Promise<void>;
  /** Creates a directory and its parents, each new one mode 0700. */
  mkdirp(path: string): Promise<void>;
  /** Opens a new file for writing, mode 0600, failing if it exists. */
  createFile(path: string): Promise<StateFile>;
  /** fsyncs a directory, so the entries made or removed in it survive a crash. */
  fsyncDir(path: string): Promise<void>;
  /** Replaces a file whole: written to a unique temporary beside it, fsynced, then renamed over it (writePrivateFile). */
  replaceFile(path: string, content: string): Promise<void>;
  /** A file's bytes, or undefined when there is none. */
  readFile(path: string): Promise<Buffer | undefined>;
  /** A directory's entries, not following links; undefined when there is none. */
  list(path: string): Promise<StateEntry[] | undefined>;
  /** A file's size, not following links. */
  size(path: string): Promise<number>;
  /** Removes a file or a directory tree; nothing there is not an error. */
  remove(path: string): Promise<void>;
}

/** What NodeStateFile needs of an open file: FileHandle's write at the current position, its fsync and its close. */
export interface WritableHandle {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ readonly bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A StateFile over an open file handle (exported for its unit test, which hands it a fake handle). Every chunk is
 * written whole: a short write — what libuv returns when write(2) fails after some bytes, the error dropped — is
 * continued, so the next call meets the error itself, and a write of nothing is refused, never taken for success.
 */
export class NodeStateFile implements StateFile {
  constructor(
    private readonly handle: WritableHandle,
    private readonly path: string,
  ) {}
  async write(chunk: Uint8Array): Promise<void> {
    for (let offset = 0; offset < chunk.byteLength;) {
      const { bytesWritten } = await this.handle.write(chunk, offset, chunk.byteLength - offset);
      if (bytesWritten <= 0)
        throw new Error(
          `${this.path}: a write of ${String(chunk.byteLength - offset)} bytes wrote nothing (a full or failing disk)`,
        );
      offset += bytesWritten;
    }
  }
  async sync(): Promise<void> {
    await this.handle.sync();
  }
  async close(): Promise<void> {
    await this.handle.close();
  }
}

/** The real filesystem. */
export const nodeStateFs: StateFs = {
  mkdirExclusive: async (path) => {
    await mkdir(path, { mode: 0o700 });
  },
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  createFile: async (path) =>
    new NodeStateFile(await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600), path),
  fsyncDir: async (path) => {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  replaceFile: (path, content) => writePrivateFile(path, content),
  readFile: async (path) => {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  list: async (path) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return entries.map((e) => ({
      name: e.name,
      kind: kindOf(e),
    }));
  },
  size: async (path) => (await lstat(path)).size,
  remove: (path) => rm(path, { recursive: true, force: true }),
};

function kindOf(e: Awaited<ReturnType<typeof readdir>>[number]): StateEntry['kind'] {
  if (e.isDirectory()) return 'directory';
  if (e.isFile()) return 'file';
  if (e.isSymbolicLink()) return 'symlink';
  return 'other';
}
