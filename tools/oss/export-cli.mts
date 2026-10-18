// npm run oss:export -- <commit> <out> [--co-author "Name <email>"]… (docs/plans/oss-release.md R1–R3, R39): exports
// one internal commit into the export repository (tools/oss/export.mts). Prints the release's commit and tag; exits 1
// on a refusal, naming it, and 2 for a usage error.
//
// Runs with Node's TypeScript support and the resolve hook (package.json `oss:export`).

import { resolve } from 'node:path';

import { ExportRefused, exportRelease } from './export.mjs';
import { ManifestInvalid } from './manifest.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');

/** Whether `who` is `Name <email>`: a name, a space, and an address with an @ and no space, in angle brackets. */
function isIdentity(who: string): boolean {
  const open = who.lastIndexOf(' <');
  const email = who.slice(open + 2, -1);
  return (
    open > 0 && who.endsWith('>') && email.includes('@') && !/[\s<>]/.test(email) && !/[<>]/.test(who.slice(0, open))
  );
}

function main(argv: readonly string[]): number {
  const positional: string[] = [];
  const coAuthors: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--co-author') {
      const who = argv[i + 1];
      if (who === undefined || !isIdentity(who)) {
        process.stderr.write('✗ --co-author takes "Name <email>"\n');
        return 2;
      }
      coAuthors.push(who);
      i += 1;
    } else positional.push(arg);
  }
  const [commit, out] = positional;
  if (commit === undefined || out === undefined || positional.length !== 2) {
    process.stderr.write('usage: npm run oss:export -- <commit> <out> [--co-author "Name <email>"]…\n');
    return 2;
  }
  try {
    const done = exportRelease({ repo: REPO, commit, out, coAuthors, env: process.env });
    process.stdout.write(
      `${done.first ? 'created' : 'updated'} ${resolve(out)}: ${done.commit.slice(0, 12)} ${done.tag}, ${String(done.files)} files, from ${done.internal.slice(0, 12)}\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof ExportRefused) && !(error instanceof ManifestInvalid)) throw error;
    process.stderr.write(`✗ ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
