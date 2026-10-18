// Every pattern scenario's proof can fail without a model
// (docs/plans/orchestration-patterns.md R13, A10; docs/plans/patterns-phase-1.md
// R3, A3): each checker runs on its committed fixtures — the passing
// conversation, which must give no failure, and one per mutation its scenario
// lists, each of which must fail naming the claim it breaks. The fixtures are
// printed by the CLI's own tracker and read back by the agent suite's parser
// (tests/agents/patterns/fixture.ts), as a real run is. The rainbow's p04-a
// (docs/plans/collaborating-agents.md A6) is here too: its checker is
// tests/agents/patterns/rainbow.ts, and its bound P4's page's
// (docs/plans/patterns-phase-2.md R8). Phase 2's checkers are
// tests/agents/patterns/phase-2.ts (patterns-phase-2 R3, A3), phase 3's
// tests/agents/patterns/phase-3.ts, as each is built (patterns-phase-3 R3, A3).
// That the checkers cover exactly the plan's scenarios is pattern-proofs-plan.test.ts's, which stays with the plans
// in the internal repository (docs/plans/oss-release.md R2, R12).

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { recordOf, type Fixture } from '../agents/patterns/fixture.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { PHASE_1 } from '../agents/patterns/phase-1.js';
import { PHASE_2 } from '../agents/patterns/phase-2.js';
import { PHASE_3 } from '../agents/patterns/phase-3.js';
import { PHASE_4 } from '../agents/patterns/phase-4.js';
import { P04_A } from '../agents/patterns/rainbow.js';
import { runClaims } from '../agents/patterns/record.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURES = join(ROOT, 'tests', 'agents', 'patterns', 'fixtures');
/** Every checker, by scenario id: phase 1's, the rainbow's p04-a, phase 2's, phase 3's and phase 4's (patterns-phase-4 R7, A3). */
const CHECKERS = { ...PHASE_1, 'p04-a': P04_A, ...PHASE_2, ...PHASE_3, ...PHASE_4 };
/** The records of a fixture, under its pattern page's bound. */
const recordFor = (fixture: Fixture) => recordOf(fixture, ROOT);

/** Every scenario's fixtures, by scenario id. */
const fixtures = new Map(
  readdirSync(FIXTURES)
    .sort(byCodeUnit)
    .map((scenario) => [
      scenario,
      readdirSync(join(FIXTURES, scenario))
        .filter((f) => f.endsWith('.json'))
        .sort(byCodeUnit)
        .map((f) => ({
          file: `${scenario}/${f}`,
          fixture: JSON.parse(readFileSync(join(FIXTURES, scenario, f), 'utf8')) as Fixture,
        })),
    ]),
);

describe('the pattern checkers on their fixtures (orchestration-patterns A10; patterns-phase-1 A3; collaborating-agents A6)', () => {
  it('has fixtures for every checker, and a checker for every folder of fixtures', () => {
    expect(Object.keys(CHECKERS)).toHaveLength(37);
    expect([...fixtures.keys()]).toEqual(Object.keys(CHECKERS).sort(byCodeUnit));
  });

  for (const [scenario, list] of fixtures) {
    const claims = CHECKERS[scenario as keyof typeof CHECKERS];

    it(`${scenario}: its passing fixture gives no failure, and a proof item for every claim`, () => {
      const pass = list.find((f) => f.fixture.breaks === null);
      expect(pass, `${scenario} has no passing fixture`).toBeDefined();
      const result = runClaims(recordFor(present(pass, 'pass').fixture), claims);
      expect(result.failures).toEqual([]);
      expect(result.proof.map((p) => p.claim)).toEqual(claims.map((c) => c.claim));
      for (const p of result.proof) expect(p.evidence, p.claim).not.toBe('');
    });

    it.each(list.filter((f) => f.fixture.breaks !== null).map((f) => [f.file, f.fixture] as const))(
      `${scenario}: %s fails naming the claim it breaks`,
      (_, fixture) => {
        const breaks = present(fixture.breaks, 'fixture.breaks');
        expect(
          claims.map((c) => c.claim),
          `${breaks} is not a claim of ${scenario}`,
        ).toContain(breaks);
        const result = runClaims(recordFor(fixture), claims);
        expect(
          result.failures.filter((f) => f.startsWith(`${breaks}: `)),
          `failures: ${JSON.stringify(result.failures)}`,
        ).toHaveLength(1);
      },
    );
  }

  it("a fixture's record holds a board only when the fixture gives one: every scenario but P11's reads none (patterns-phase-4 R7)", () => {
    const withBoard = [...fixtures.values()]
      .flat()
      .filter(({ fixture }) => 'board' in recordFor(fixture))
      .map(({ file }) => file.split('/')[0]);
    expect([...new Set(withBoard)]).toEqual(['p11-a', 'p11-b']);
    for (const { file, fixture } of [...fixtures.values()].flat())
      expect('board' in recordFor(fixture), file).toBe(fixture.board !== undefined);
  });

  it('every claim of every checker is broken by at least one fixture, so each is seen to fail (PRINCIPLES §3; review finding 6)', () => {
    const unbroken = [...fixtures].flatMap(([scenario, list]) =>
      CHECKERS[scenario as keyof typeof CHECKERS]
        .filter((c) => !list.some((f) => f.fixture.breaks === c.claim))
        .map((c) => `${scenario}: ${c.claim}`),
    );
    expect(unbroken).toEqual([]);
  });
});
