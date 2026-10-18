// Which build of the harness is running. The daemon keeps running — and keeps
// its agents running — after the code is rebuilt, so the CLI compares its own
// build with the daemon's and says so when they differ (2026-09-26: a daemon
// started before a fix kept answering with the old behaviour, and nothing
// said so; the version, 0.1.0, was the same).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { byCodeUnit } from './order.js';

/**
 * A fingerprint of the compiled code: sha256 over every .js file under
 * `distDir`, each by its relative path and content, in sorted order. The first
 * 12 hex digits. Any rebuild that changes code changes it, committed or not.
 * `distDir/agent-packages/` is left out: the agent packages are not the daemon's
 * code, and every image staging reads them afresh (docs/plans/debt-paydown.md R10).
 */
export function buildFingerprint(distDir: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && dir === distDir && entry.name === 'agent-packages') continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
    }
  };
  walk(distDir);
  if (files.length === 0)
    throw new Error(
      `no compiled code under ${distDir}: this asha installation is incomplete; reinstall it (brew reinstall asha) or, in a checkout, run npm run build`,
    );
  const hash = createHash('sha256');
  for (const file of files.map((f) => relative(distDir, f)).sort(byCodeUnit)) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(distDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}
