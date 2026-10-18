// The machine-wide agent-suite lock (AGENTS.md §3, "one full gate at a time").
// The agent suite and the eval time real launches and model calls against the
// owner's bounds; another agent's unit, integration or docs run saturating the
// CPU alongside them pushed image staging, as an investigation reported (records not in the repo),
// from a 129 ms median to 356 ms (p90
// 982 ms) against a 250 ms bound (docs/testing/index.md, the 01f037a failure).
// So the agent-suite and eval configs take this lock for their whole run, and
// the unit and integration configs refuse to start while a live process holds
// it. The gate's own sequence (unit → integration → agents → eval) never
// overlaps: each step ends before the next starts, and each timed step
// releases the lock at its teardown.
//
// The path is fixed, not read from TMPDIR or os.tmpdir(): the contention is the
// machine's, and TMPDIR differs between processes of one user (a sandboxed
// shell, a test that sets it), which would give each its own "machine-wide"
// lock. /tmp is one directory for every process on macOS (/private/tmp) and
// Linux. It assumes one user runs the suites: /tmp is sticky, so a stale lock
// another user left cannot be removed, and taking it fails loudly (EPERM).

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger, LogFields } from '../../src/daemon/log.js';
import { LockHeld, acquirePidLock } from '../../src/daemon/process/pid-lock.js';
import { byNumber } from '../../src/shared/order.js';

export const AGENT_SUITE_LOCK = '/tmp/asha-agent-suite.lock';

/** An agent suite or eval (a live process) holds the lock. */
export class AgentSuiteRunning extends Error {
  constructor(
    readonly file: string,
    readonly holderPid: number,
    what: string,
  ) {
    super(
      `${what}: an agent suite or eval is running on this machine (pid ${String(holderPid)} holds ${file}); ` +
        'only one runs at a time, and a unit or integration run beside it breaks its timing bounds (AGENTS.md §3). Wait for it to finish.',
    );
    this.name = 'AgentSuiteRunning';
  }
}

export interface SuiteLockProps {
  readonly file: string;
  readonly isAlive: (pid: number) => boolean;
}

/** Test-infrastructure records, one JSON line on stderr each (the daemon's facade writes a home's log, which a suite has not got here). */
export const stderrLogger: Logger = {
  info: (event: string, fields: LogFields = {}) => {
    console.error(JSON.stringify({ level: 'info', event, ...fields }));
  },
  warn: (event: string, fields: LogFields = {}) => {
    console.error(JSON.stringify({ level: 'warn', event, ...fields }));
  },
  error: (event: string, fields: LogFields & { readonly error: unknown }) => {
    console.error(JSON.stringify({ level: 'error', event, ...fields, error: String(fields.error) }));
  },
};

/**
 * Takes the lock for `pid`, reclaiming one a dead process left; throws
 * AgentSuiteRunning naming the holder when a live one holds it. Returns the release.
 */
export async function takeAgentSuiteLock(
  props: SuiteLockProps & { readonly pid: number; readonly logger: Logger },
): Promise<() => Promise<void>> {
  try {
    return await acquirePidLock(props);
  } catch (error) {
    if (error instanceof LockHeld)
      throw new AgentSuiteRunning(error.file, error.holderPid, 'cannot start this agent suite or eval');
    throw error;
  }
}

/**
 * Throws AgentSuiteRunning when a live process holds the lock. A missing lock,
 * or one whose pid is dead or unreadable (left by a killed run; acquirePidLock
 * links the lock into place with its pid already written, so a live taker's
 * lock is never read empty), lets the run start.
 */
export async function refuseWhileAgentSuiteRuns(props: SuiteLockProps & { readonly what: string }): Promise<void> {
  let content: string;
  try {
    content = await readFile(props.file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const holder = Number.parseInt(content, 10);
  if (Number.isInteger(holder) && props.isAlive(holder)) throw new AgentSuiteRunning(props.file, holder, props.what);
}

// The other direction (docs/plans/debt-paydown.md R20, debt D29 narrowed): a unit or integration run registers itself
// before it checks the lock, and an agent suite or eval that has taken the lock waits for every registered run still
// alive. Registering first closes the window where a unit run checked, found no lock, and an agent suite then took it
// and started beside it.

/** One file per unit or integration run, named by its pid: a fixed path, as AGENT_SUITE_LOCK is. */
export const LIGHT_RUNS_DIR = '/tmp/asha-light-runs';
/** How often a waiting agent suite looks again, and how long it waits at most (the plan's decided item 10). */
const LIGHT_RUN_POLL_MS = 1_000;
const LIGHT_RUN_WAIT_MS = 300_000;

/** The files a registration is made of: the real filesystem, or a test's. */
export interface LightRunFs {
  mkdir(dir: string): Promise<void>;
  /** Creates the file, failing EEXIST if it exists (open 'wx'). */
  createNew(path: string, content: string): Promise<void>;
  /** Removes the file; one already gone is not a failure. */
  remove(path: string): Promise<void>;
  list(dir: string): Promise<string[]>;
}

export const nodeLightRunFs: LightRunFs = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  createNew: (path, content) => writeFile(path, content, { flag: 'wx' }),
  remove: (path) => rm(path, { force: true }),
  list: (dir) => readdir(dir),
};

/**
 * Registers this run as `<dir>/<pid>`, then runs the refusal check; a refused run removes its registration and
 * throws. Returns the teardown, which removes it.
 */
export async function registerLightRun(props: {
  readonly dir: string;
  readonly pid: number;
  readonly fs: LightRunFs;
  readonly refuse: () => Promise<void>;
}): Promise<() => Promise<void>> {
  const file = join(props.dir, String(props.pid));
  await props.fs.mkdir(props.dir);
  try {
    await props.fs.createNew(file, `${String(props.pid)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A killed run's registration under the pid this run now holds: that run is dead, so it is replaced.
    await props.fs.remove(file);
    await props.fs.createNew(file, `${String(props.pid)}\n`);
  }
  try {
    await props.refuse();
  } catch (error) {
    await props.fs.remove(file);
    throw error;
  }
  return () => props.fs.remove(file);
}

/** Registered runs alive past the wait: the agent suite must not start beside them. */
export class LightRunsStillRunning extends Error {
  constructor(
    readonly pids: readonly number[],
    ms: number,
  ) {
    super(
      `unit or integration runs still running after ${String(ms)} ms (pids ${pids.join(', ')}): an agent suite or eval does not start beside them (AGENTS.md §3)`,
    );
    this.name = 'LightRunsStillRunning';
  }
}

export interface WaitForLightRunsProps {
  readonly dir: string;
  readonly fs: LightRunFs;
  readonly isAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Where the one line naming the runs waited for goes. */
  readonly stderr: (text: string) => void;
  readonly logger: Logger;
}

/** The directory's registrations, or undefined when it does not exist (no run has registered yet). */
async function listRegistrations(fs: LightRunFs, dir: string): Promise<string[] | undefined> {
  try {
    return await fs.list(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Of `names` (one directory listing), the pids of the ones still alive; a stale one (its process dead) is removed
 * and logged suite.stale_registration_cleared. Extracted out of `waitForLightRuns` for its cognitive complexity.
 */
async function liveRegisteredPids(props: WaitForLightRunsProps, names: readonly string[]): Promise<number[]> {
  const live: number[] = [];
  for (const name of names) {
    const pid = Number(name);
    // Only `<pid>` files are registrations; anything else in the folder is not this harness's and is left alone.
    if (!/^[1-9]\d*$/.test(name)) continue;
    if (props.isAlive(pid)) live.push(pid);
    else {
      await props.fs.remove(join(props.dir, name));
      props.logger.warn('suite.stale_registration_cleared', { pid });
    }
  }
  return live;
}

/**
 * Waits while any registered run is alive, polling every LIGHT_RUN_POLL_MS; a registration whose pid is dead is
 * removed and logged suite.stale_registration_cleared. Says once on stderr which pids it waits for. Past
 * LIGHT_RUN_WAIT_MS it throws LightRunsStillRunning naming the live pids.
 */
export async function waitForLightRuns(props: WaitForLightRunsProps): Promise<void> {
  const deadline = props.now() + LIGHT_RUN_WAIT_MS;
  let said = false;
  for (;;) {
    const names = await listRegistrations(props.fs, props.dir);
    if (names === undefined) return;
    const live = await liveRegisteredPids(props, names);
    if (live.length === 0) return;
    if (props.now() >= deadline) throw new LightRunsStillRunning(live.toSorted(byNumber), LIGHT_RUN_WAIT_MS);
    if (!said) {
      props.stderr(
        `waiting for unit or integration runs to finish (pids ${live.toSorted(byNumber).join(', ')}) before this agent suite or eval starts\n`,
      );
      said = true;
    }
    await props.sleep(LIGHT_RUN_POLL_MS);
  }
}

/** The agent-suite and eval configs' setup: the lock, then the wait for registered runs; the lock released if the wait fails. */
export async function agentSuiteSetup(
  props: { readonly lockFile: string; readonly pid: number } & WaitForLightRunsProps,
): Promise<() => Promise<void>> {
  const release = await takeAgentSuiteLock({
    file: props.lockFile,
    pid: props.pid,
    isAlive: props.isAlive,
    logger: props.logger,
  });
  try {
    await waitForLightRuns(props);
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
