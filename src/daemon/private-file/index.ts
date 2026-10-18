// Writing a secret to a file only this user can read (PRINCIPLES §13: a name
// nobody else holds, promoted on success). The content is written in full to
// a new file opened `wx` with mode 0600 under a unique name beside the target,
// then renamed over the target — so neither a stale file's mode (a file left
// by a killed daemon may be 0644) nor a half-written file is ever seen.

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * A failed write whose temporary could not be removed either: the write's own error is its `cause`, the removal's
 * is `cleanup`, so neither replaces the other (PRINCIPLES §11).
 */
export class TemporaryNotRemoved extends Error {
  constructor(
    readonly temp: string,
    readonly cleanup: unknown,
    options: { readonly cause: unknown },
  ) {
    // Node's fs rejects with Errors only: both are read as such.
    super(
      `${(options.cause as Error).message}; and the temporary ${temp} could not be removed: ${(cleanup as Error).message}`,
      options,
    );
    this.name = 'TemporaryNotRemoved';
  }
}

/**
 * Writes `content` to `target` as a new 0600 file: in full to a unique temporary beside it (opened `wx`), fsynced,
 * then renamed over it. A failure removes the temporary and rethrows the failure itself, or, when the removal fails
 * too, TemporaryNotRemoved carrying both.
 */
export async function writePrivateFile(target: string, content: string): Promise<void> {
  const temp = join(
    dirname(target),
    `.${basename(target)}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    // The temporary file must not outlive a failed write; the original error is what the caller sees — as the cause
    // of TemporaryNotRemoved when the removal fails too.
    try {
      await rm(temp, { force: true });
    } catch (cleanup) {
      throw new TemporaryNotRemoved(temp, cleanup, { cause: error });
    }
    throw error;
  }
}

/**
 * writePrivateFile, synchronously: for a write that nothing may interleave with, such as the stop's daemon.json, which
 * must say `stopping` before the control API answers 503 within the same turn of the event loop (debt-paydown R14).
 */
export function writePrivateFileSync(target: string, content: string): void {
  const temp = join(
    dirname(target),
    `.${basename(target)}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch (cleanup) {
      throw new TemporaryNotRemoved(temp, cleanup, { cause: error });
    }
    throw error;
  }
}
