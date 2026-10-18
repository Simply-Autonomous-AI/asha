// The stop point on `main` (docs/plans/patterns-phase-3.md R5, A20): a suite file listed in
// tests/agents/patterns/building.json is left out of the agent suite, unless ASHA_RECORDED_RUN names it. Proven on
// the real config file with vitest's own file listing, in a scratch folder holding a byte-identical copy of the config
// and of its helper, two trivial suite files, and a no-op in place of the machine-wide agent-suite lock.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILDING, RECORDED_RUN_ENV, buildingExcluded, readBuilding } from '../agents/patterns/building.js';
import { readManifest } from '../../evals/patterns/manifest.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { ROOT } from '../helpers/pattern-spec.js';

/** A scratch root with the agent config, its helper and two suites; building.json listing `listed`. */
function scratch(listed: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'asha-building-'));
  mkdirSync(join(root, 'tests/agents/patterns'), { recursive: true });
  mkdirSync(join(root, 'tests/helpers'), { recursive: true });
  copyFileSync(join(ROOT, 'vitest.agents.config.mts'), join(root, 'vitest.agents.config.mts'));
  copyFileSync(join(ROOT, 'tests/agents/patterns/building.ts'), join(root, 'tests/agents/patterns/building.ts'));
  // The machine-wide lock is the real config's concern, not this test's: a no-op at the path the config names.
  writeFileSync(
    join(root, 'tests/helpers/take-agent-suite-lock.global.ts'),
    'export default async function setup(): Promise<() => Promise<void>> {\n  return async () => undefined;\n}\n',
  );
  for (const file of ['tests/agents/p99-demo.test.ts', 'tests/agents/other.test.ts'])
    writeFileSync(join(root, file), "import { it } from 'vitest';\nit('x', () => undefined);\n");
  writeFileSync(join(root, BUILDING), `${JSON.stringify(listed)}\n`);
  // An ES module folder, as the repo is: the config's helper is ESM.
  writeFileSync(join(root, 'package.json'), '{"type": "module"}\n');
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
  return root;
}

/** The suite files vitest lists under the agent config in `root`, with `env` added. */
function listed(root: string, env: Readonly<Record<string, string>>): string[] {
  const out = execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'list', '--config', 'vitest.agents.config.mts', '--filesOnly'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, [RECORDED_RUN_ENV]: '', ...env },
      timeout: 60_000,
    },
  );
  return out
    .split('\n')
    .filter((l) => l.endsWith('.test.ts'))
    .sort(byCodeUnit);
}

describe('building.json: an unbuilt demo is left out of the agent suite (patterns-phase-3 R5, A20)', () => {
  it('leaves a listed file out of the agent suite, and lets it in when ASHA_RECORDED_RUN names it', () => {
    const root = scratch(['tests/agents/p99-demo.test.ts']);
    expect(listed(root, {})).toEqual(['tests/agents/other.test.ts']);
    expect(listed(root, { [RECORDED_RUN_ENV]: 'tests/agents/p99-demo.test.ts' })).toEqual([
      'tests/agents/other.test.ts',
      'tests/agents/p99-demo.test.ts',
    ]);
    // Another file named lets the listed one through no more.
    expect(listed(root, { [RECORDED_RUN_ENV]: 'tests/agents/other.test.ts' })).toEqual(['tests/agents/other.test.ts']);
  }, 120_000);

  it('runs every file when nothing is listed', () => {
    expect(listed(scratch([]), {})).toEqual(['tests/agents/other.test.ts', 'tests/agents/p99-demo.test.ts']);
  }, 60_000);

  it("excludes each listed file but the recorded run's", () => {
    expect(buildingExcluded(['tests/agents/p25-restart.test.ts', 'tests/agents/p17-budget.test.ts'], {})).toEqual([
      'tests/agents/p25-restart.test.ts',
      'tests/agents/p17-budget.test.ts',
    ]);
    expect(
      buildingExcluded(['tests/agents/p25-restart.test.ts', 'tests/agents/p17-budget.test.ts'], {
        [RECORDED_RUN_ENV]: 'tests/agents/p17-budget.test.ts',
      }),
    ).toEqual(['tests/agents/p25-restart.test.ts']);
  });

  it.each([
    ['not a list', '{}', 'must be a JSON list'],
    ['not a pattern suite', '["tests/agents/teams.test.ts"]', 'entry 0 must be a pattern suite file'],
    ['a path outside tests/agents', '["../x/p01-a.test.ts"]', 'entry 0 must be a pattern suite file'],
    [
      'a file listed twice',
      '["tests/agents/p01-delegation.test.ts", "tests/agents/p01-delegation.test.ts"]',
      'is listed twice',
    ],
    ['a file that does not exist', '["tests/agents/p99-nothing.test.ts"]', 'does not exist'],
    ['not JSON', '[', 'not a readable JSON file'],
  ])('refuses %s, naming the file', (_, text, message) => {
    const root = mkdtempSync(join(tmpdir(), 'asha-building-'));
    mkdirSync(join(root, 'tests/agents/patterns'), { recursive: true });
    writeFileSync(join(root, 'tests/agents/p01-delegation.test.ts'), '');
    writeFileSync(join(root, BUILDING), text);
    expect(() => readBuilding(root)).toThrow(BUILDING);
    expect(() => readBuilding(root)).toThrow(message);
  });

  it('lists no built demo: a file leaves the list in the commit that adds its manifest entry', () => {
    const built = readManifest(ROOT).map((d) => d.suite);
    expect(readBuilding(ROOT).filter((file) => built.includes(file))).toEqual([]);
    expect(JSON.parse(readFileSync(join(ROOT, BUILDING), 'utf8'))).toEqual(readBuilding(ROOT));
  });
});
