// npm run scan:secrets (docs/plans/oss-release.md R5): gitleaks over a temporary copy of exactly the tracked files,
// with its default rules and nothing that could switch one off (tools/oss/secrets.mts). Prints the gitleaks version it
// ran and each finding's file, line and rule, never its value; exits 1 on a finding or a refusal, naming it.
//
// Runs with Node's TypeScript support and the resolve hook (package.json `scan:secrets`).

import { resolve } from 'node:path';

import { SecretScanRefused, findingLine, gitleaksVersion, scanTracked } from './secrets.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');

function main(): number {
  try {
    const version = gitleaksVersion();
    const found = scanTracked(REPO);
    process.stdout.write(`gitleaks ${version}: ${String(found.length)} finding(s) in the tracked files\n`);
    for (const f of found) process.stderr.write(`✗ ${findingLine(f)}\n`);
    return found.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof SecretScanRefused)) throw error;
    process.stderr.write(`✗ ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main();
