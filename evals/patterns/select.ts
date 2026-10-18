// `npm run demos:select` (docs/plans/demo-selector.md R10): the gate step, after
// its build and before the agent suite, that writes
// tests/agents/results/selection.json. `node dist/evals/patterns/select.js`
// selects against the last green gate; `--full` selects every demo three times.
// It prints one line per demo and exits 0, or prints one JSON error line to
// stderr, writes nothing, and exits 1.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExecCommandRunner, type CommandRunner } from '../../src/daemon/process/index.js';
import { harnessPaths } from '../../src/shared/paths.js';
import type { Demo } from './manifest.js';
import { SELECTION, environmentFingerprint, nodeFileOps, select, type FileOps, type Fingerprint } from './selection.js';

export interface MainProps {
  readonly argv: readonly string[];
  readonly root: string;
  readonly runner: CommandRunner;
  readonly fingerprint: (demos: readonly Demo[]) => Promise<Fingerprint>;
  readonly files: FileOps;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** Runs the step; returns the exit code. */
export async function main(props: MainProps): Promise<number> {
  try {
    if (props.argv.length > 1 || (props.argv.length === 1 && props.argv[0] !== '--full')) {
      throw new Error(`usage: demos:select [--full]; got ${JSON.stringify(props.argv)}`);
    }
    const record = await select({
      root: props.root,
      mode: props.argv[0] === '--full' ? 'full' : 'check',
      runner: props.runner,
      fingerprint: props.fingerprint,
      files: props.files,
    });
    for (const demo of record.demos)
      props.stdout(
        `${demo.pattern} ${demo.suite}: ${String(demo.repeats)} repeat${demo.repeats === 1 ? '' : 's'} (${demo.reason})`,
      );
    props.stdout(`wrote ${SELECTION}`);
    return 0;
  } catch (error) {
    props.stderr(JSON.stringify({ level: 'error', event: 'demos.select_failed', error: (error as Error).message }));
    return 1;
  }
}

// Run as the entry point: compared by real path, so a symlinked checkout still runs the step rather than exiting 0
// having done nothing (the completion review, finding 3).
if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
  const root = resolve(import.meta.dirname, '..', '..', '..');
  const runner = new ExecCommandRunner();
  const modelsDir = harnessPaths({ ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] }).modelsDir;
  process.exitCode = await main({
    argv: process.argv.slice(2),
    root,
    runner,
    fingerprint: (demos) => environmentFingerprint({ runner, root, modelsDir, demos }),
    files: nodeFileOps,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}
