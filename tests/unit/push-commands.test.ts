// Nothing shipped publishes (docs/plans/oss-release.md R36, A27): no shipped source, script, package.json script or
// workflow runs `git push`, `gh release`, `gh repo`, `npm publish` or `brew tap` — as a command string, or as the
// argument array of an execFile or spawn — so only the owner's manual procedure, from the export repository, ever
// publishes (R33). Named by file and line. The tests are not read: theirs push only to the local bare repositories
// they make (oss-export.test.ts).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readManifest, shipped } from '../../tools/oss/manifest.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
/** The code folders read, and the files of them that are code; the launcher and the workflows besides. */
const FOLDERS = ['src/', 'tools/', 'evals/', 'modules/', 'images/', 'harness-images/', 'portal/', 'decider/'];
const isCode = (f: string): boolean =>
  f === 'asha' ||
  (f.startsWith('.github/workflows/') && /\.ya?ml$/.test(f)) ||
  (FOLDERS.some((d) => f.startsWith(d)) && /\.(?:m?[jt]s|cjs|py|sh)$/.test(f));

/** Each form of a publishing command: as text a shell runs, and as a program with its argument array. */
const COMMANDS: readonly RegExp[] = [
  /\bgit\s+push\b/,
  /\bgh\s+(?:release|repo)\b/,
  /\bnpm\s+publish\b/,
  /\bbrew\s+tap\b/,
  /['"`]git['"`]\s*,\s*\[[^\]]*?['"`]push['"`]/,
  /['"`]gh['"`]\s*,\s*\[\s*['"`](?:release|repo)['"`]/,
  /['"`]npm['"`]\s*,\s*\[\s*['"`]publish['"`]/,
  /['"`]brew['"`]\s*,\s*\[\s*['"`]tap/,
];

/** `file:line` for each line of `text` that runs a publishing command. */
function publishing(file: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) => (COMMANDS.some((c) => c.test(line)) ? [`${file}:${String(i + 1)}`] : []));
}

describe('nothing shipped publishes (oss-release R36, A27)', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
  const code = shipped(readManifest(ROOT), tracked).filter(isCode);

  it('reads the shipped code and scripts', () => {
    expect(code).toEqual(
      expect.arrayContaining(['asha', 'tools/release/pack.mts', 'tools/oss/export.mts', 'src/cli/commands.ts']),
    );
    expect(code.length).toBeGreaterThan(150);
  });

  it("finds no push or publish command in them, nor in package.json's scripts", () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect([
      ...code.flatMap((f) => publishing(f, readFileSync(join(ROOT, f), 'utf8'))),
      ...Object.entries(scripts).flatMap(([name, line]) => publishing(`package.json scripts.${name}`, line)),
    ]).toEqual([]);
  });

  it('names a planted command by file and line, as a string and as an argument array', () => {
    const planted = [
      "execFile('git', ['push', 'origin', 'main']);",
      "spawnSync('git', ['-C', dir, 'push']);",
      'run: gh release create v1',
      "execFileSync('npm', ['publish']);",
      'sh -c "brew tap someone/tap"',
      "spawn('gh', ['repo', 'create']);",
      "execFile('git', ['status']); // a pushover",
    ].join('\n');
    expect(publishing('tools/x.mts', planted)).toEqual([
      'tools/x.mts:1',
      'tools/x.mts:2',
      'tools/x.mts:3',
      'tools/x.mts:4',
      'tools/x.mts:5',
      'tools/x.mts:6',
    ]);
  });
});
