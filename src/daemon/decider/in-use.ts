// The decision model's in-use files (docs/plans/decider-tool.md R6, R7a): `<models>/.decider-in-use/<daemon pid>`, held by
// a daemon from its first agent selecting `decide` until its last is gone, holding `<decider pid> <socket path>` once the
// decision model is spawned. `asha --remove-decider` refuses while one names a live daemon (R15b). A daemon killed with
// SIGKILL leaves its file — and its decider, a child that outlives its parent (debt-paydown's probe P4) — behind; the
// sweep here, at every daemon start and in the removal, stops such a decider and removes the file and its socket folder.

import { join } from 'node:path';

import { present } from '../../shared/assert-present.js';
import type { Logger } from '../log.js';
import type { CommandRunner } from '../process/index.js';

/** The folder of in-use files, in the model cache shared by every home that uses it. */
export const IN_USE_DIR = '.decider-in-use';

/** Bound on `ps` reading one process's command (R7a). */
const PS_TIMEOUT_MS = 2_000;
/** An orphan's SIGTERM grace, and how long the sweep waits after SIGKILL before it logs a survivor (R7a). */
const ORPHAN_TERM_MS = 3_000;
const ORPHAN_KILL_MS = 1_000;
const ORPHAN_POLL_MS = 100;

/** The one socket path a decider is ever given (R4): `/tmp/asha-<uid>/decider-<12 hex>/decider.sock`. */
export function socketPathPattern(uid: number): RegExp {
  return new RegExp(`^/tmp/asha-${String(uid)}/decider-[0-9a-f]{12}/decider\\.sock$`);
}

/** The filesystem calls the sweep makes. */
export interface InUseFs {
  /** The folder's entries; [] when it does not exist. */
  list(dir: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  /** Removes a file; gone already is fine. */
  removeFile(path: string): Promise<void>;
  /** Removes a folder and what it holds; gone already is fine. */
  removeDir(path: string): Promise<void>;
}

export interface OrphanSweepProps {
  readonly modelsDir: string;
  /** This user's uid: the only socket folders the sweep removes are under `/tmp/asha-<uid>/`. */
  readonly uid: number;
  readonly runner: CommandRunner;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly isAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly fs: InUseFs;
  readonly logger: Logger;
}

/**
 * Handles every in-use file naming a process that is not alive (R7a), all at once: a decider pid it holds that is alive,
 * whose command holds both `decider/launch.py` and the file's socket path, is sent SIGTERM, then SIGKILL 3,000 ms later
 * if still alive (`decider.orphan_stopped`, info, or `decider.orphan_survived`, error, if alive 1,000 ms after the
 * SIGKILL); one whose command does not hold both is never signalled (`decider.orphan_skipped`, warn). Then the file is
 * removed, and its socket folder with it. A `ps` that fails throws: the caller's start or removal fails. Resolves with
 * the pids of the live daemons whose files were left alone.
 */
export async function sweepDeciderOrphans(props: OrphanSweepProps): Promise<number[]> {
  const dir = join(props.modelsDir, IN_USE_DIR);
  const live: number[] = [];
  const dead: number[] = [];
  for (const name of await props.fs.list(dir)) {
    // Only the files a daemon writes: its pid as decimal digits. Anything else is not this sweep's.
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    if (props.isAlive(pid)) live.push(pid);
    else dead.push(pid);
  }
  await Promise.all(dead.map((pid) => handleDeadFile(props, join(dir, String(pid)))));
  return live;
}

/** One dead daemon's file: its decider stopped when it is still the one the file names, then the file and its socket folder removed. */
async function handleDeadFile(props: OrphanSweepProps, file: string): Promise<void> {
  const content = (await props.fs.readText(file)).trim();
  const fields = /^([1-9]\d*) (\S+)$/.exec(content);
  // Empty: the daemon never spawned its decider (R6's file before the first spawn). Anything else malformed names nothing to stop.
  if (fields === null) {
    if (content !== '') props.logger.warn('decider.orphan_skipped', { pid: null, file });
  } else {
    const [, pidField, socketField] = fields;
    const pid = Number(present(pidField, "the in-use file's decider pid field"));
    const socket = present(socketField, "the in-use file's decider socket field");
    if (props.isAlive(pid)) await stopOrphan(props, pid, socket);
    if (socketPathPattern(props.uid).test(socket)) await props.fs.removeDir(socket.slice(0, socket.lastIndexOf('/')));
  }
  await props.fs.removeFile(file);
}

async function stopOrphan(props: OrphanSweepProps, pid: number, socket: string): Promise<void> {
  const listed = await props.runner.run('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
    timeoutMs: PS_TIMEOUT_MS,
  });
  // ps exits 1, printing nothing, for a pid no process holds: it ended between the check and the listing.
  if (listed.code === 1 && listed.stdout.trim() === '') return;
  if (listed.code !== 0)
    throw new Error(`ps -ww -o command= -p ${String(pid)} exited ${String(listed.code)}: ${listed.stderr.trim()}`);
  const command = listed.stdout.trim();
  if (!command.includes('decider/launch.py') || !command.includes(socket)) {
    // A reused pid, or not a decider of this file: never signalled.
    props.logger.warn('decider.orphan_skipped', { pid });
    return;
  }
  const endedWithin = async (ms: number): Promise<boolean> => {
    const until = props.now() + ms;
    while (props.now() < until) {
      if (!props.isAlive(pid)) return true;
      await props.sleep(ORPHAN_POLL_MS);
    }
    return !props.isAlive(pid);
  };
  const send = (signal: NodeJS.Signals): boolean => {
    try {
      props.signal(pid, signal);
      return true;
    } catch (error) {
      // Gone already: it ended on its own.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!send('SIGTERM') || (await endedWithin(ORPHAN_TERM_MS))) {
    props.logger.info('decider.orphan_stopped', { pid });
    return;
  }
  if (!send('SIGKILL') || (await endedWithin(ORPHAN_KILL_MS))) {
    props.logger.info('decider.orphan_stopped', { pid });
    return;
  }
  props.logger.error('decider.orphan_survived', {
    pid,
    error: new Error(`the decider pid ${String(pid)} is still alive 1,000 ms after SIGKILL`),
  });
}
