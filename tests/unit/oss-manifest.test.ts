// The public export's manifest (docs/plans/oss-release.md R2, A2): every tracked path is in exactly one of its lists
// by its longest matching entry; the records the owner keeps private are excluded; every path R2 names is shipped;
// and a manifest that breaks either rule is named by the check, path by path.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ManifestInvalid,
  classify,
  parseManifest,
  readManifest,
  shipped,
  unclassified,
  type Manifest,
} from '../../tools/oss/manifest.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const TRACKED = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f !== '');

/** Kept private (R2): the four always excluded, question 4's, and each test whose only subject is one of them. */
const EXCLUDED = [
  'evals/probes/',
  'evals/routing/results/',
  'decisions/queue.json',
  'tools/release/evidence/',
  'docs/plans/',
  'tools/decision-queue/',
  'tests/agents/results/',
  'tests/unit/decision-queue.test.ts',
  'tests/integration/decision-queue-page.test.ts',
  'tests/unit/agent-results-users.test.ts',
];

/** A tracked path of each kind R2 ships, so the check of each is not vacuous. */
const SHIPPED = [
  'src/cli/commands.ts',
  'catalogue/qwen3-8b-q4_k_m.json',
  'recipes/hello-world.json',
  'portal/index.html',
  'teams/delegation/team.json',
  'images/memory/Dockerfile',
  'harness-images/egress-proxy/Dockerfile',
  'modules/tavily/module.json',
  'evals/patterns/selection.ts',
  'evals/routing/run.ts',
  'evals/report.ts',
  'tools/docs/render.mts',
  'tools/release/pack.mts',
  'tools/oss/manifest.json',
  'tests/unit/docs.test.ts',
  'tests/integration/portal-chat.test.ts',
  'tests/helpers/suite-lock.ts',
  'tests/agents/egress.test.ts',
  'tests/eval/hello-world.eval.test.ts',
  'tests/live/modules.test.ts',
  'tests/screenshots/portal.screenshots.ts',
  'tests/fixtures/modules/README.md',
  'docs/index.md',
  'LICENSE',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'PRINCIPLES.md',
  'principles/05-evidence.md',
  'rules/README.md',
  'sdlc/README.md',
  '.gitignore',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.mts',
  'asha',
];

/** Files R2 ships once they are written (R22–R24, R29), untracked until then. */
const SHIPPED_ONCE_WRITTEN = [
  'THIRD_PARTY_LICENSES.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  '.github/workflows/check.yml',
];

/** Each way `manifest` breaks R2 over `tracked`, as `<path>: <why>`. */
function manifestProblems(manifest: Manifest, tracked: readonly string[]): string[] {
  const covered = (prefix: string): string[] =>
    tracked.filter((p) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix));
  return [
    ...unclassified(manifest, tracked).map((p) => `${p}: in neither list`),
    ...EXCLUDED.flatMap((e) =>
      covered(e)
        .filter((p) => classify(manifest, p) !== 'exclude')
        .map((p) => `${p}: shipped, but R2 keeps it private`),
    ),
    ...[...SHIPPED, ...SHIPPED_ONCE_WRITTEN]
      .filter((p) => classify(manifest, p) !== 'ship')
      .map((p) => `${p}: not shipped, but R2 ships it`),
  ];
}

describe("the export's manifest (oss-release R2, A2)", () => {
  const manifest = readManifest(ROOT);

  it('classifies every tracked path, keeps the private records out and ships what R2 names', () => {
    for (const p of SHIPPED) expect(TRACKED, p).toContain(p);
    // The internal repository holds every private record; a published clone (no plans) holds none of them.
    const internal = existsSync(join(ROOT, 'docs', 'plans'));
    for (const e of EXCLUDED)
      expect(
        TRACKED.some((p) => (e.endsWith('/') ? p.startsWith(e) : p === e)),
        e,
      ).toBe(internal);
    expect(manifestProblems(manifest, TRACKED)).toEqual([]);
    expect(shipped(manifest, TRACKED).length).toBeGreaterThan(1000);
  });

  it('ships CLA.md, TERMS.md and PRIVACY.md, written from gate G3 on (R38)', () => {
    expect(['CLA.md', 'TERMS.md', 'PRIVACY.md'].map((f) => classify(manifest, f))).toEqual(['ship', 'ship', 'ship']);
  });

  it('names an always-excluded path moved to ship, and an evals/patterns/ file left out of ship', () => {
    const probesShipped: Manifest = { ...manifest, exclude: manifest.exclude.filter((e) => e !== 'evals/probes/') };
    expect(manifestProblems(probesShipped, TRACKED).filter((p) => p.startsWith('evals/probes/'))).toHaveLength(
      TRACKED.filter((p) => p.startsWith('evals/probes/')).length,
    );
    const patternsOut: Manifest = {
      ship: [...manifest.ship.filter((e) => e !== 'evals/'), 'evals/routing/', 'evals/report.ts'],
      exclude: manifest.exclude,
    };
    expect(manifestProblems(patternsOut, TRACKED)).toEqual(
      expect.arrayContaining(['evals/patterns/selection.ts: in neither list']),
    );
  });

  it('decides a path by its longest matching entry, a folder by its trailing /', () => {
    const m: Manifest = { ship: ['docs/', 'a.md', 'x/'], exclude: ['docs/plans/', 'docs/b.md', 'x'] };
    expect(classify(m, 'docs/index.md')).toBe('ship');
    expect(classify(m, 'docs/plans/index.md')).toBe('exclude');
    expect(classify(m, 'docs/b.md')).toBe('exclude');
    expect(classify(m, 'a.md')).toBe('ship');
    expect(classify(m, 'a.md.bak')).toBeUndefined();
    expect(classify(m, 'x')).toBe('exclude');
    expect(classify(m, 'x/y')).toBe('ship');
    expect(unclassified(m, ['docs/index.md', 'b.md', 'docsx/c'])).toEqual(['b.md', 'docsx/c']);
  });

  it('refuses a manifest whose lists overlap, repeat, or hold anything but plain relative paths', () => {
    const refused = (ship: unknown, exclude: unknown = []): string => {
      try {
        parseManifest(JSON.stringify({ ship, exclude }));
      } catch (e) {
        expect(e).toBeInstanceOf(ManifestInvalid);
        return (e as Error).message;
      }
      throw new Error('accepted');
    };
    expect(refused(['src/'], ['src/'])).toBe('the manifest lists "src/" in both');
    expect(refused(['src/', 'src/'])).toBe('the manifest\'s "ship" lists "src/" twice');
    expect(refused(['src/*'])).toBe(
      'the manifest\'s "ship" entry "src/*" holds a pattern character (entries are paths, not globs)',
    );
    expect(refused(['/src/'])).toBe('the manifest\'s "ship" entry "/src/" starts with /');
    expect(refused(['src/../x'])).toBe('the manifest\'s "ship" entry "src/../x" has an empty, . or .. segment');
    expect(refused(['a//b'])).toBe('the manifest\'s "ship" entry "a//b" has an empty, . or .. segment');
    expect(refused([''])).toBe('the manifest\'s "ship" entry "" is empty');
    expect(refused('src/')).toBe('the manifest\'s "ship" is not a list of strings');
    expect(refused(['a'], [1])).toBe('the manifest\'s "exclude" is not a list of strings');
    expect(() => parseManifest('[]')).toThrow('the manifest\'s "ship" is not a list of strings');
    expect(() => parseManifest('null')).toThrow('the manifest is not a JSON object');
  });
});
