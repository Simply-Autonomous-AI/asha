// Every test run's temporary files in one folder of its own, removed when the run ends. Tests make their homes, fixture
// roots and work folders with mkdtemp(join(tmpdir(), …)) and, by design, rarely remove them: 844,000 of them, 214 GB,
// had piled up in this Mac's temporary folder by 2026-10-15. Each vitest config's first global setup points TMPDIR —
// which os.tmpdir() reads on every call, in vitest's own process and in every worker it starts after — at a folder made
// for the run, and its teardown removes that folder. A run killed before its teardown leaves its folder; the next run's
// setup removes every run folder whose vitest process has ended.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** A run folder's name: this prefix, the pid of the vitest process that made it, a dash, and mkdtemp's six characters. */
export const RUN_TEMP_PREFIX = 'asha-run-';
const RUN_TEMP_NAME = /^asha-run-(\d+)-[A-Za-z0-9]{6}$/;

export interface RunTempProps {
  /** The temporary folder the run folders are made in: os.tmpdir() before the run points TMPDIR anywhere. */
  readonly base: string;
  /** The vitest process's pid, named in its folder's name. */
  readonly pid: number;
  /** Whether a run's vitest process still runs. */
  readonly isAlive: (pid: number) => boolean;
  /** The environment whose TMPDIR the run's processes read: process.env. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Removes the run folders under `base` whose vitest process has ended, makes this run's, and points TMPDIR at it.
 * Returns the teardown, which puts TMPDIR back and removes the folder with everything in it. Returns the folder too.
 */
export function runTempSetup(props: RunTempProps): { readonly dir: string; readonly teardown: () => void } {
  for (const name of readdirSync(props.base)) {
    const match = RUN_TEMP_NAME.exec(name);
    if (match?.[1] !== undefined && !props.isAlive(Number(match[1])))
      rmSync(join(props.base, name), { recursive: true, force: true });
  }
  const dir = mkdtempSync(join(props.base, `${RUN_TEMP_PREFIX}${String(props.pid)}-`));
  const before = props.env['TMPDIR'];
  props.env['TMPDIR'] = dir;
  return {
    dir,
    teardown: () => {
      if (before === undefined) Reflect.deleteProperty(props.env, 'TMPDIR');
      else props.env['TMPDIR'] = before;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
