// The repository stands alone, because it is published on its own (the owner, 2026-10-12: "I don't want any guidance
// there syncing anything or referring to paths outside that repo"; record harness-foreign-records; debt D9). No agent
// guidance names a path on this machine, another repository, an ssh remote or a private address, or the other project, and every
// relative link in it resolves inside the repository; no source, test, tool or root config resolves a path above the
// repository's root by one of these forms: more `..` from the file's own folder than the root is deep (counting the
// extra folder of `dist/` for compiled code), `..` from the root, the root's parent, a `../` run ending at another
// repository's name, or the working folder joined to one. A path built some other way is not caught; the review loops
// are the check for that.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';

const ROOT = realpathSync(join(import.meta.dirname, '..', '..'));
const tracked = (...paths: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');

/** Every file an agent reads to learn how to work here. */
const GUIDANCE = tracked(
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'PRINCIPLES.md',
  'LICENSE',
  'principles',
  'rules',
  'sdlc',
).filter((f) => !f.endsWith('.png') && !f.endsWith('.html'));

/** What guidance may not name, each with the reason a reader is given. */
const OUTSIDE: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\/Users\/[^\s/`'")]+/, what: 'a path on this machine' },
  // The one home path guidance needs is colima's own socket (rules/containers.md).
  { pattern: /(?:~|\$HOME)\/(?!\.colima\/)[\w.-]/, what: 'a path in a home folder' },
  {
    pattern: /\.\.\/(?:web|setup|sdlc|harness)\b|\bSimplyAutonomous\.ai\.\w+|\bsibling repo/i,
    what: 'another repository',
  },
  {
    pattern: /ssh:\/\/|\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}\b/,
    what: 'an ssh remote or a private address',
  },
];

/** The other project's name as the sha256 of its ten lower-case letters, so no shipped file spells it (oss-release R25a). */
const OTHER_PROJECT = '0c5d4083a166fc1b95e0c7f2966de91643327c04c0366e2d9b991c3c769504bf';
/** Whether a line names the other project, in any case, spacing or punctuation. */
function namesOtherProject(line: string): boolean {
  const letters = line.toLowerCase().replace(/[^a-z]/g, '');
  for (let i = 0; i + 10 <= letters.length; i++) {
    if (
      createHash('sha256')
        .update(letters.slice(i, i + 10))
        .digest('hex') === OTHER_PROJECT
    )
      return true;
  }
  return false;
}

/** Every source, test, tool and root config that could read a path. */
const CODE = [
  ...tracked('src', 'tests', 'tools', 'evals', 'images', 'harness-images', 'modules', 'portal', 'decider').filter(
    (f) => /\.(?:m?[jt]s|cjs|tsx?|py)$/.test(f) && !f.startsWith('evals/probes/'),
  ),
  ...tracked('*.mts', 'asha').filter((f) => !f.includes('/')),
];

/** How a line of `file` reaches above the repository root, or undefined when it does not, by the forms the header names. */
function above(file: string, line: string): string | undefined {
  // Code the build compiles runs from dist/, one folder deeper (tsconfig.build.json's include).
  const built = /^(?:src\/|images\/[^/]+\/src\/|evals\/)/.test(file);
  const depth = (dirname(file) === '.' ? 0 : dirname(file).split('/').length) + (built ? 1 : 0);
  if (/\b(?:ROOT|REPO|repoRoot|root)\s*,\s*['"]\.\.['"]/.test(line)) return "'..' past the root";
  if (/\bdirname\(\s*(?:ROOT|REPO|repoRoot)\s*\)/.test(line)) return "the root's parent";
  if (/\bprocess\.cwd\(\)\s*,\s*['"](?:web|setup|sdlc|harness)\b/.test(line))
    return "the working folder joined to another repository's name";
  for (const m of line.matchAll(/(?:import\.meta\.dirname|__dirname)((?:\s*,\s*['"]\.\.['"])+)/g)) {
    const group = present(m[1], 'import.meta.dirname/__dirname match capture group 1');
    const dotDotCount = (group.match(/\.\./g) ?? []).length;
    if (dotDotCount > depth) return `${String(dotDotCount)} '..' from a file ${String(depth)} deep`;
  }
  for (const m of line.matchAll(/['"`]((?:\.\.\/)+)(?:web|setup|sdlc|harness)\b/g)) {
    const group = present(m[1], "'../' run match capture group 1");
    const dotSlashCount = group.length / 3;
    if (dotSlashCount > depth)
      return `${String(dotSlashCount)} '../' to another repository from a file ${String(depth)} deep`;
  }
  return undefined;
}

describe('the repository stands alone', () => {
  it('covers the guidance and the code', () => {
    expect(GUIDANCE).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'CLAUDE.md',
        'PRINCIPLES.md',
        'LICENSE',
        'principles/05-evidence.md',
        'rules/README.md',
        'sdlc/README.md',
      ]),
    );
    expect(CODE).toEqual(
      expect.arrayContaining(['asha', 'vitest.config.mts', 'decider/launch.py', 'tests/unit/docs.test.ts']),
    );
    expect(namesOtherProject(['Oculus', '-', 'Mind'].join(''))).toBe(true);
    expect(namesOtherProject('a mind to read')).toBe(false);
  });

  it('no agent guidance names a path outside the repository, another repository, an ssh remote or a private address, or the other project', () => {
    const found = GUIDANCE.flatMap((f) =>
      readFileSync(join(ROOT, f), 'utf8')
        .split('\n')
        .flatMap((line, i) => [
          ...OUTSIDE.filter((o) => o.pattern.test(line)).map(
            (o) => `${f}:${String(i + 1)}: ${o.what}: ${present(o.pattern.exec(line), 'o.pattern.exec(line)')[0]}`,
          ),
          ...(namesOtherProject(line) ? [`${f}:${String(i + 1)}: the other project`] : []),
        ]),
    );
    expect(found).toEqual([]);
  });

  it('every relative link in the agent guidance resolves to a file inside the repository', () => {
    const broken: string[] = [];
    for (const f of GUIDANCE.filter((x) => x.endsWith('.md'))) {
      for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
        const url = present(m[1], 'link match capture group 1');
        if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#')) continue;
        const target = resolve(
          ROOT,
          dirname(f),
          decodeURIComponent(present(url.split('#', 1)[0], "url.split('#', 1)[0]")),
        );
        if (target !== ROOT && !target.startsWith(ROOT + sep)) broken.push(`${f}: ${url} leaves the repository`);
        else if (!existsSync(target)) broken.push(`${f}: ${url} (no such file)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('no source, test, tool or root config resolves a path above the repository root', () => {
    const found = CODE.flatMap((f) =>
      readFileSync(join(ROOT, f), 'utf8')
        .split('\n')
        .flatMap((line, i) => {
          const how = above(f, line);
          return how === undefined ? [] : [`${f}:${String(i + 1)}: ${how}: ${line.trim()}`];
        }),
    );
    expect(found).toEqual([]);
  });
});
