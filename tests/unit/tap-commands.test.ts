// No published page gives a Homebrew tap command (docs/plans/oss-release.md R31, A24; debt D12): no tap is published,
// every tap name is unheld until the owner holds one, and on a Mac without the maintainers' local tap such a command
// would install whatever holds that name on GitHub. Every Markdown file the export ships (tools/oss/manifest.json; in a
// published clone, every tracked one) is read, and a `brew install <account>/tap/<formula>`, `brew tap` or
// `brew tap-new` fails, named by file and line. The maintainers' procedure is in the internal brew-install plan.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readManifest, shipped } from '../../tools/oss/manifest.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const TAP_COMMAND = /\bbrew (?:install [^\s/`'"]+\/tap\/[^\s`'"]+|tap(?:-new)?\b)/g;

/** `file:line: command` for each tap command in `text`, the content of `file`. */
function tapCommands(file: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) => [...line.matchAll(TAP_COMMAND)].map((m) => `${file}:${String(i + 1)}: ${m[0]}`));
}

describe('no published page gives a tap command (oss-release R31, A24)', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
  const pages = shipped(readManifest(ROOT), tracked);

  it('reads every shipped Markdown file: the README, the root files, the guidance and docs/ but the plans', () => {
    expect(pages).toEqual(
      expect.arrayContaining([
        'README.md',
        'AGENTS.md',
        'rules/project.md',
        'docs/deployments/index.md',
        'docs/cli/guide.md',
      ]),
    );
    expect(pages.filter((f) => f.startsWith('docs/plans/'))).toEqual([]);
  });

  it('finds no brew install <account>/tap/<formula>, brew tap or brew tap-new in any of them', () => {
    expect(pages.flatMap((f) => tapCommands(f, readFileSync(join(ROOT, f), 'utf8')))).toEqual([]);
  });

  it('names a planted install from a tap and a planted tap-new by file and line, and leaves other brew commands alone', () => {
    const planted = [
      'brew install llama.cpp colima docker',
      '$ brew install someone/tap/asha',
      'run `brew tap-new x/y` first, then brew tap x/y',
      'brew trust --tap x/y; brew untap x/y',
    ].join('\n');
    expect(tapCommands('docs/x.md', planted)).toEqual([
      'docs/x.md:2: brew install someone/tap/asha',
      'docs/x.md:3: brew tap-new',
      'docs/x.md:3: brew tap',
    ]);
  });
});
