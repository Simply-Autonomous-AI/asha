// The project files a public repository carries (docs/plans/oss-release.md R22–R24, R26, R27, R29, R38; A18, A20–A22):
// CONTRIBUTING.md with the contributor licence agreement's sentence, verbatim, and no link to CLA.md before gate G3;
// SECURITY.md's one channel and policy; the Code of Conduct as the Contributor Covenant 2.1 fetched, but its contact;
// the issue and pull-request templates; CLA.md absent until G3 records it; the CI workflow's every required property,
// each break named; package.json's fields; and THIRD_PARTY_LICENSES.md's packages and models against the lockfile and
// the catalogue.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { statusRows } from '../../tools/oss/pre-push.mjs';
import { INSTALL_STEP } from '../helpers/browser.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const PLAN = join(ROOT, 'docs', 'plans', 'oss-release.md');
/** Gate G3's row, when the plans are here (the internal repository); a published clone has none to read. */
const g3 = (): string[] | undefined =>
  existsSync(PLAN) ? statusRows(readFileSync(PLAN, 'utf8')).find((r) => r[0] === 'gate G3') : undefined;

/** R22's sentence, verbatim. */
const CLA_SENTENCE =
  'Code, tests and documentation from outside SimplyAutonomous.AI, LLC are merged only after their author has signed the contributor licence agreement, which grants SimplyAutonomous.AI, LLC the right to license the contribution, commercially included.';
/** The Contributor Covenant 2.1 as fetched on 2026-10-16 from its site's Markdown, its sha256 (5,480 bytes). */
const COVENANT_SOURCE = 'https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md';
const COVENANT_SHA256 = '977d781349351fd7c1f076e4c7dc7de2a05b40e12c773542c3815dd4ce7f37ba';

describe('the files a public repository carries (oss-release R22–R24, R38; A18)', () => {
  it('has each of them', () => {
    const files = [
      'CONTRIBUTING.md',
      'SECURITY.md',
      'CODE_OF_CONDUCT.md',
      'THIRD_PARTY_LICENSES.md',
      'TERMS.md',
      'PRIVACY.md',
      '.github/ISSUE_TEMPLATE/bug_report.md',
      '.github/ISSUE_TEMPLATE/feature_request.md',
      '.github/pull_request_template.md',
      '.github/workflows/check.yml',
    ];
    expect(files.filter((f) => !existsSync(join(ROOT, f)))).toEqual([]);
  });

  it("CONTRIBUTING.md holds the agreement's sentence verbatim in its section, and links CLA.md only from gate G3 on", () => {
    const text = read('CONTRIBUTING.md');
    const start = text.indexOf('\n## The contributor licence agreement\n');
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('\n## ', start + 1);
    const section = end === -1 ? text.slice(start) : text.slice(start, end);
    expect(section).toContain(CLA_SENTENCE);
    const recorded = g3() !== undefined || existsSync(join(ROOT, 'CLA.md'));
    expect(section.includes('](./CLA.md)') || section.includes('](CLA.md)')).toBe(recorded);
    for (const what of [
      'npm run docs',
      'npm run check',
      'gitleaks',
      'npm run decisions',
      'No key, credential or personal data',
    ])
      expect(text, what).toContain(what);
  });

  it('CLA.md is absent before gate G3 is recorded, and from it on has the sha256 its row records (R38)', () => {
    if (g3() === undefined && existsSync(PLAN)) expect(existsSync(join(ROOT, 'CLA.md'))).toBe(false);
    const row = g3();
    if (row !== undefined)
      expect(row.join(' ')).toContain(
        createHash('sha256')
          .update(readFileSync(join(ROOT, 'CLA.md')))
          .digest('hex'),
      );
    expect(existsSync(PLAN) || existsSync(join(ROOT, 'CLA.md')) === read('CONTRIBUTING.md').includes('CLA.md')).toBe(
      true,
    );
  });

  it('SECURITY.md gives one channel and "the latest release only", and neither GitHub\'s private reporting nor a time to answer', () => {
    const text = read('SECURITY.md');
    expect(text).toContain('**admin@SimplyAutonomous.AI**');
    expect(text).toContain('Please do not open a public issue');
    expect(text).toContain('The latest release only.');
    expect(text.toLowerCase()).not.toContain('private vulnerability reporting');
    expect(text).not.toMatch(/\b\d+\s*(?:hours?|days?|weeks?|business days)\b/i);
    for (const guard of ['`127.0.0.1`', 'needs a credential', "reach no port of your Mac but the daemon's"])
      expect(text, guard).toContain(guard);
  });

  it('CODE_OF_CONDUCT.md is the Contributor Covenant 2.1 as fetched, but for its contact, admin@SimplyAutonomous.AI', () => {
    const text = read('CODE_OF_CONDUCT.md');
    expect(text.split('admin@SimplyAutonomous.AI')).toHaveLength(2);
    const fetched = text.replace('admin@SimplyAutonomous.AI', '[INSERT CONTACT METHOD]');
    expect([COVENANT_SOURCE, createHash('sha256').update(fetched).digest('hex')]).toEqual([
      COVENANT_SOURCE,
      COVENANT_SHA256,
    ]);
  });

  it('the bug template asks for the status, the Mac and the commands, and warns about keys; the pull-request template is the definition of done', () => {
    const bug = read('.github/ISSUE_TEMPLATE/bug_report.md');
    for (const what of ['asha --status', 'macOS version', 'Chip', 'The commands you ran', 'Never paste a key'])
      expect(bug, what).toContain(what);
    const pr = read('.github/pull_request_template.md');
    expect(pr).toContain('- [ ] I have signed the contributor licence agreement (CONTRIBUTING.md).');
    for (const what of ['Tests', 'npm run docs', 'npm run check']) expect(pr, what).toContain(what);
    expect(pr.toLowerCase()).not.toMatch(/signed-off-by|sign-off|\bdco\b/);
  });
});

/** Each property R26 requires that `workflow` lacks, named. */
function workflowProblems(workflow: string): string[] {
  const problems: string[] = [];
  if (!/^on:\n {2}push:\n {2}pull_request:$/m.test(workflow)) problems.push('not on push and pull_request');
  if (!/^permissions:\n {2}contents: read$/m.test(workflow)) problems.push('no permissions: contents: read');
  const jobs = [...workflow.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n?)*)/gm)].filter((m) =>
    (m[2] ?? '').includes('runs-on:'),
  );
  if (jobs.length === 0) problems.push('no job');
  for (const job of jobs) {
    const body = job[2] ?? '';
    if (!body.includes('if: ${{ !github.event.repository.private }}'))
      problems.push(`${String(job[1])}: runs in a private repository`);
    if (!/runs-on: macos-15$/m.test(body)) problems.push(`${String(job[1])}: not on macos-15`);
  }
  for (const m of workflow.matchAll(/uses: ([^\s@]+)@(\S+)/g))
    if (!/^[0-9a-f]{40}$/.test(m[2] ?? ''))
      problems.push(`${String(m[1])} pinned by ${String(m[2])}, not a full commit sha`);
  for (const step of [
    'npm ci',
    'brew install gitleaks',
    'npm run typecheck',
    'npm test',
    INSTALL_STEP,
    'npm run test:integration',
    'npm run scan:secrets',
  ])
    if (!workflow.includes(`- run: ${step}\n`)) problems.push(`no step: ${step}`);
  return problems;
}

describe('the CI workflow (oss-release R26, A20)', () => {
  const workflow = read('.github/workflows/check.yml');

  it('has every property R26 requires', () => {
    expect(workflowProblems(workflow)).toEqual([]);
  });

  it("names each break: the private guard, the permissions, an action pinned by a tag, gitleaks' install", () => {
    expect(workflowProblems(workflow.replace('    if: ${{ !github.event.repository.private }}\n', ''))).toEqual([
      'check: runs in a private repository',
    ]);
    expect(workflowProblems(workflow.replace('permissions:\n  contents: read\n', ''))).toEqual([
      'no permissions: contents: read',
    ]);
    expect(workflowProblems(workflow.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v7'))).toEqual([
      'actions/checkout pinned by v7, not a full commit sha',
    ]);
    expect(workflowProblems(workflow.replace('      - run: brew install gitleaks\n', ''))).toEqual([
      'no step: brew install gitleaks',
    ]);
  });

  it('installs the browsers the browser tests check for, as README.md and CONTRIBUTING.md tell a contributor to', () => {
    // v0.2.2's CI ran `npx playwright install chromium`: the latest playwright's full Chromium, not playwright-core's
    // pinned headless shell and Firefox, so every browser test failed (2026-10-18).
    expect(workflowProblems(workflow.replace(INSTALL_STEP, 'npx playwright install chromium'))).toEqual([
      `no step: ${INSTALL_STEP}`,
    ]);
    for (const file of ['README.md', 'CONTRIBUTING.md']) {
      const text = read(file).replace(/\n\s*/g, ' ');
      expect(text, file).toContain(`(\`${INSTALL_STEP}\`)`);
      expect(text, file).not.toMatch(/npx playwright install/);
    }
  });
});

describe('package.json (oss-release R27, A21)', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
  const gate = (name: string): string[] | undefined =>
    existsSync(PLAN) ? statusRows(readFileSync(PLAN, 'utf8')).find((r) => r[0] === name) : undefined;

  it('is named asha, private, under LICENSE, by the company, with a description and keywords', () => {
    expect([pkg['name'], pkg['private'], pkg['license']]).toEqual(['asha', true, 'SEE LICENSE IN LICENSE']);
    if (gate('gate G1') === undefined)
      expect(pkg['author']).toBe('SimplyAutonomous.AI, LLC <admin@simplyautonomous.ai>');
    expect(typeof pkg['description']).toBe('string');
    expect(pkg['keywords']).toEqual(expect.arrayContaining(['agents', 'multi-agent']));
  });

  it('carries no repository, homepage or bugs until gate G2 records the organization', () => {
    if (gate('gate G2') === undefined && existsSync(PLAN))
      expect(['repository', 'homepage', 'bugs'].filter((k) => k in pkg)).toEqual([]);
  });
});

describe('THIRD_PARTY_LICENSES.md (oss-release R29, A22)', () => {
  const text = read('THIRD_PARTY_LICENSES.md');
  const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<string, { version?: string; license?: string; dev?: boolean }>;
  };
  const rowsOf = (heading: string): string[][] => {
    const start = text.indexOf(`\n## ${heading}\n`);
    const end = text.indexOf('\n## ', start + 1);
    return text
      .slice(start, end)
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('|---'))
      .slice(1)
      .map((l) => l.slice(2, -2).split(' | '));
  };

  it('lists every production package of the lockfile with its version and licence, and no other', () => {
    const want = Object.entries(lock.packages)
      .filter(([path, p]) => path !== '' && p.dev !== true)
      .map(([path, p]) => [`\`${path.replace(/^node_modules\//, '')}\``, String(p.version), String(p.license)])
      .sort((a, b) => byCodeUnit(String(a[0]), String(b[0])));
    expect(rowsOf('Packages asha runs with').sort((a, b) => byCodeUnit(String(a[0]), String(b[0])))).toEqual(want);
  });

  it('counts every development package under its licence', () => {
    const counts = new Map<string, number>();
    for (const [path, p] of Object.entries(lock.packages))
      if (path !== '' && p.dev === true)
        counts.set(p.license ?? 'none declared', (counts.get(p.license ?? 'none declared') ?? 0) + 1);
    expect(
      new Map(
        rowsOf('Packages used only to build and test').map((r) => [
          present(r[0], 'licence'),
          Number(/^(\d+):/.exec(r[1] ?? '')?.[1]),
        ]),
      ),
    ).toEqual(counts);
  });

  it("lists every catalogue model with its repository, revision, licence and the licence file's address", () => {
    const catalogue = readdirSync(join(ROOT, 'catalogue'))
      .filter((f) => f.endsWith('.json'))
      .sort(byCodeUnit)
      .map(
        (f) =>
          JSON.parse(read(join('catalogue', f))) as {
            id: string;
            repo: string;
            revision: string;
            license: { id: string; source: string };
          },
      );
    expect(catalogue.length).toBeGreaterThan(5);
    expect(rowsOf('Models').map((r) => r.slice(0, 5))).toEqual(
      catalogue.map((c) => [
        `\`${c.id}\``,
        `\`${c.repo}\``,
        `\`${c.revision}\``,
        c.license.id,
        `<${c.license.source}>`,
      ]),
    );
  });
});
