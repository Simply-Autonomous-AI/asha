// An exclusive lock file holding its owner's pid. Used for the daemon (one per
// harness home) and the model cache (one writer). A lock whose owner is dead is
// cleared and retaken — a crash must not wedge the harness.

import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, unlink } from 'node:fs/promises';

import type { Logger } from '../log.js';

/** A live process holds the lock. */
export class LockHeld extends Error {
  constructor(
    readonly file: string,
    readonly holderPid: number,
  ) {
    super(`${file} is held by live process ${holderPid.toString()}`);
    this.name = 'LockHeld';
  }
}

/** The filesystem the lock is taken through: nodePidLockFs, or a test's, which can interleave several takers. */
export interface PidLockFs {
  /** Creates a new file holding `content`, failing EEXIST if the path exists (open 'wx'). */
  writeNew(path: string, content: string): Promise<void>;
  /** Hard-links `existing` at `path`, failing EEXIST if the path exists. */
  link(existing: string, path: string): Promise<void>;
  read(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  /** Renames `from` to `to`, failing ENOENT when `from` is gone. */
  rename(from: string, to: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** The clock the waits are bounded by. */
  now(): number;
}

const nodePidLockFs: PidLockFs = {
  writeNew: async (path, content) => {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  },
  link: (existing, path) => link(existing, path),
  read: (path) => readFile(path, 'utf8'),
  unlink: (path) => unlink(path),
  rename: (from, to) => rename(from, to),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface PidLockProps {
  readonly file: string;
  readonly pid: number;
  /** Whether a pid is a live process — injected so the stale path is testable. */
  readonly isAlive: (pid: number) => boolean;
  readonly logger: Logger;
  /** The filesystem: nodePidLockFs unless a test interleaves takers (debt-paydown R19). */
  readonly fs?: PidLockFs;
}

/** How often a taker looks again while another live taker holds the clear-sentinel, and for how long at most. */
const SENTINEL_POLL_MS = 10;
const SENTINEL_WAIT_MS = 2_000;
/** Passes through the take-or-clear loop before a taker gives up: each pass either takes, refuses, or clears. */
const MAX_PASSES = 8;

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/**
 * Takes the lock, or throws LockHeld. Returns its release function, which
 * removes the lock only while it still holds our pid.
 *
 * The pid is written to a file of our own first and hard-linked to the lock
 * path, which fails with EEXIST if it exists: the lock appears with its pid
 * already in it, so no other taker can read it empty and take it for stale.
 * A stale lock is cleared only while holding the clear-sentinel `<file>.clear`
 * (debt-paydown R19, D29): inside it, the lock is removed only if it still holds
 * the dead pid read, so two clearers can no longer both remove a lock and both
 * take it. Left open (D29, narrowed): a clearer that dies inside the sentinel,
 * followed by two others removing that sentinel at once.
 */
export async function acquirePidLock(props: PidLockProps): Promise<() => Promise<void>> {
  const fs = props.fs ?? nodePidLockFs;
  const own = `${props.file}.${props.pid.toString()}.${randomBytes(4).toString('hex')}`;
  await fs.writeNew(own, String(props.pid));
  try {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      try {
        await fs.link(own, props.file);
        return () => releasePidLock(fs, props.file, props.pid);
      } catch (error) {
        if (errnoOf(error) !== 'EEXIST') throw error;
      }
      let content: string;
      try {
        content = await fs.read(props.file);
      } catch (error) {
        // Removed by its holder or a clearer since our link failed: try again.
        if (errnoOf(error) === 'ENOENT') continue;
        throw error;
      }
      const holder = Number.parseInt(content, 10);
      if (Number.isInteger(holder) && props.isAlive(holder)) throw new LockHeld(props.file, holder);
      // Left by a process that died holding it (or, unreadable, by one that died writing it the old way): recoverable by design.
      props.logger.warn('lock.stale_cleared', { file: props.file, holder });
      await clearStale({ ...props, fs }, own, content);
    }
    throw new Error(
      `could not take ${props.file} after ${MAX_PASSES.toString()} passes; other processes are racing for it`,
    );
  } finally {
    await fs.unlink(own);
  }
}

/**
 * Removes the stale lock that held `content`, holding the clear-sentinel `<file>.clear` while it does: the sentinel
 * is linked into place from our own pid file, so it is never seen empty. A sentinel whose holder is dead is removed
 * by renaming it to a name of our own and checking that what was renamed holds that dead pid; a live one renamed in
 * the meantime is put back. A live holder is waited for, polling, up to SENTINEL_WAIT_MS.
 */
async function clearStale(
  props: PidLockProps & { readonly fs: PidLockFs },
  own: string,
  content: string,
): Promise<void> {
  const { fs, file } = props;
  const sentinel = `${file}.clear`;
  await acquireSentinel(props, own, sentinel);
  try {
    // Inside the sentinel: the lock is removed only while it still holds the dead pid read.
    let now: string | undefined;
    try {
      now = await fs.read(file);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
    }
    if (now === content) await fs.unlink(file);
  } finally {
    await releaseSentinel(props, sentinel);
  }
}

/**
 * Links `own` at `sentinel`, taking over the clear-sentinel; or, while it is held by another taker, waits for a
 * live holder or moves a dead one's sentinel aside and checks it, as clearStale's doc comment describes. Extracted
 * from clearStale to keep its cognitive complexity within bound — the loop body is unchanged.
 */
async function acquireSentinel(
  props: PidLockProps & { readonly fs: PidLockFs },
  own: string,
  sentinel: string,
): Promise<void> {
  const { fs } = props;
  const deadline = fs.now() + SENTINEL_WAIT_MS;
  for (;;) {
    if (await tryLinkSentinel(fs, own, sentinel)) return;
    const holding = await readSentinelHolder(fs, sentinel);
    if (holding === undefined) continue;
    const clearer = Number.parseInt(holding, 10);
    if (Number.isInteger(clearer) && props.isAlive(clearer)) {
      if (fs.now() >= deadline)
        throw new Error(
          `${sentinel} has been held by live process ${clearer.toString()} for ${SENTINEL_WAIT_MS.toString()} ms`,
        );
      await fs.sleep(SENTINEL_POLL_MS);
      continue;
    }
    await moveAsideDeadSentinel(fs, props.pid, sentinel, holding);
  }
}

/** Links `own` at `sentinel`: true once it is ours, false on EEXIST (another taker holds it), else throws. */
async function tryLinkSentinel(fs: PidLockFs, own: string, sentinel: string): Promise<boolean> {
  try {
    await fs.link(own, sentinel);
    return true;
  } catch (error) {
    if (errnoOf(error) !== 'EEXIST') throw error;
    return false;
  }
}

/** The sentinel's current holder, or undefined if it was removed since the link failed (acquireSentinel retries). */
async function readSentinelHolder(fs: PidLockFs, sentinel: string): Promise<string | undefined> {
  try {
    return await fs.read(sentinel);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Its holder died inside it: the sentinel is moved aside under a name of our own and checked. If the rename finds
 * it already gone (another clearer removed it), acquireSentinel's loop just retries. If what moved was not what we
 * read — a live clearer's sentinel, taken in the meantime — it is put back unless another has been linked since.
 */
async function moveAsideDeadSentinel(fs: PidLockFs, pid: number, sentinel: string, holding: string): Promise<void> {
  const aside = `${sentinel}.${pid.toString()}.${randomBytes(4).toString('hex')}`;
  try {
    await fs.rename(sentinel, aside);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return;
    throw error;
  }
  const moved = await fs.read(aside);
  if (moved !== holding) {
    try {
      await fs.link(aside, sentinel);
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST') throw error;
    }
  }
  await fs.unlink(aside);
}

/**
 * Removes our sentinel. Another taker may have it moved aside for a moment, believing its holder dead, and put it back
 * once it saw ours (clearStale): so a sentinel gone is looked for again, polling, before it is left.
 */
async function releaseSentinel(props: PidLockProps & { readonly fs: PidLockFs }, sentinel: string): Promise<void> {
  const deadline = props.fs.now() + SENTINEL_WAIT_MS;
  for (;;) {
    try {
      if ((await props.fs.read(sentinel)) === String(props.pid)) await props.fs.unlink(sentinel);
      return;
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
    }
    if (props.fs.now() >= deadline) return;
    await props.fs.sleep(SENTINEL_POLL_MS);
  }
}

/** Removes the lock if it still holds `pid`; one another process holds now is left alone, and that is an error. */
async function releasePidLock(fs: PidLockFs, file: string, pid: number): Promise<void> {
  const content = await fs.read(file);
  if (content !== String(pid))
    throw new Error(
      `${file} holds ${JSON.stringify(content)}, not our pid ${pid.toString()}: another process took it; left in place`,
    );
  await fs.unlink(file);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM: the process exists but belongs to another user.
    if (code === 'EPERM') return true;
    throw error;
  }
}
