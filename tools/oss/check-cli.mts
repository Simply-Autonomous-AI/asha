// npm run oss:check -- <commit> (docs/plans/oss-release.md R16): the whole published-tree check (tools/oss/check.mts).
// Prints each step and the run folder; exits 1 when a step fails, 2 for a usage error.
//
// Runs with Node's TypeScript support and the resolve hook (package.json `oss:check`).

import { resolve } from 'node:path';

import { ossCheck } from './check.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');

function main(argv: readonly string[]): number {
  const [commit, ...rest] = argv;
  if (commit === undefined || rest.length > 0) {
    process.stderr.write('usage: npm run oss:check -- <commit>\n');
    return 2;
  }
  const { runDir, records } = ossCheck(REPO, commit, process.env);
  for (const r of records)
    (r.ok ? process.stdout : process.stderr).write(
      `${r.ok ? '✓' : '✗'} ${r.name} (${String(Math.round(r.ms / 1000))} s): ${r.detail}\n`,
    );
  process.stdout.write(`the run's folder: ${runDir} (its log: run.log)\n`);
  return records.every((r) => r.ok) && records.length > 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
