// npm run oss:scan-markers -- <dir> (docs/plans/oss-release.md R9): the marker scan of one folder or repository, its
// markers read from the file ASHA_OSS_MARKERS names (tools/oss/markers.mts). Prints each match by kind and location,
// never a value; exits 1 on a match or a refusal, 2 for a usage error.
//
// Runs with Node's TypeScript support and the resolve hook (package.json `oss:scan-markers`).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { MarkerScanRefused, matchLine, readMarkers, scanMarkers } from './markers.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');

function main(argv: readonly string[]): number {
  const [dir, ...rest] = argv;
  if (dir === undefined || rest.length > 0 || !existsSync(dir)) {
    process.stderr.write('usage: npm run oss:scan-markers -- <dir>   (an existing folder or repository)\n');
    return 2;
  }
  try {
    const markers = readMarkers(process.env, [REPO, dir]);
    const found = scanMarkers(markers, dir);
    process.stdout.write(`markers: ${String(found.length)} match(es) in ${resolve(dir)}\n`);
    for (const m of found) process.stderr.write(`✗ ${matchLine(m)}\n`);
    return found.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof MarkerScanRefused)) throw error;
    process.stderr.write(`✗ ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
