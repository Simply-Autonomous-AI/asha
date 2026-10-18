// The pattern demos' coverage is kept current (docs/plans/orchestration-patterns.md
// R11(a), R15, A12): the Testing page's table has one row per catalogue pattern,
// P1–P26; every demo the manifest lists is built there; and the manifest itself
// is a closed list, each pattern once, its page, suite and team present. That
// each row's scenario ids are those the plan's #demos subsection lists is
// pattern-coverage-plan.test.ts's, which stays with the plans in the internal
// repository (docs/plans/oss-release.md R2, R12).

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ManifestInvalid,
  parseManifest,
  patternPrefix,
  readManifest,
  type Demo,
} from '../../evals/patterns/manifest.js';
import { readRunBlock } from '../../evals/patterns/run-block.js';
import { present } from '../../src/shared/assert-present.js';
import { coverageTable, type CoverageRow } from '../helpers/coverage-table.js';
import { ROOT } from '../helpers/pattern-spec.js';

/** Every difference between the coverage table and the manifest, naming the pattern. */
function coverageProblems(rows: readonly CoverageRow[], manifestPatterns: readonly string[]): string[] {
  const problems: string[] = [];
  const ids = Array.from({ length: 26 }, (_, i) => `P${String(i + 1)}`);
  const listed = rows.map((r) => r.pattern);
  for (const id of ids)
    if (listed.filter((p) => p === id).length !== 1)
      problems.push(`${id}: ${String(listed.filter((p) => p === id).length)} rows in the coverage table, not 1`);
  for (const pattern of manifestPatterns) {
    const row = rows.find((r) => r.pattern === pattern);
    if (row === undefined || !/\bbuilt\b/.test(row.status))
      problems.push(`${pattern}: listed in the manifest, and not built in the coverage table`);
  }
  // The other half (demo-selector R13; orchestration-patterns A8 case 13: "a built pattern's page with no manifest
  // entry"): a built demo missing from the manifest would have its own changes read as shared, and nothing would list
  // it for the gate's selection. A built scenario with no pattern page (P20's p20-b, agent-persistence's) is no demo.
  const pages = readdirSync(join(ROOT, 'docs', 'patterns'));
  for (const row of rows) {
    const hasPage = pages.some((f) => f.startsWith(`${patternPrefix(row.pattern)}-`) && f.endsWith('.md'));
    if (/\bbuilt\b/.test(row.status) && hasPage && !manifestPatterns.includes(row.pattern))
      problems.push(`${row.pattern}: built in the coverage table, with a page, and not listed in the manifest`);
  }
  return problems;
}

describe('the coverage table (orchestration-patterns R15, A12)', () => {
  it('has one row per catalogue pattern, and every manifest demo built', () => {
    expect(
      coverageProblems(
        coverageTable(),
        readManifest(ROOT).map((d) => d.pattern),
      ),
    ).toEqual([]);
  });

  it('fails naming the pattern: a row removed, a manifest demo not built, a built demo not in the manifest', () => {
    const rows = coverageTable();
    const manifest = readManifest(ROOT).map((d) => d.pattern);
    // A pattern not yet built (P7 was until it was built, 2026-10-02): its row's removal is the one problem.
    expect(
      coverageProblems(
        rows.filter((r) => r.pattern !== 'P26'),
        manifest,
      ),
    ).toEqual(['P26: 0 rows in the coverage table, not 1']);
    const p1Planned = rows.map((r) =>
      r.pattern === 'P1'
        ? { ...r, status: '<a class="badge planned" href="../plans/patterns-phase-1.md">planned</a>' }
        : r,
    );
    expect(coverageProblems(p1Planned, manifest)).toEqual([
      'P1: listed in the manifest, and not built in the coverage table',
    ]);
    expect(
      coverageProblems(
        rows,
        manifest.filter((p) => p !== 'P3'),
      ),
    ).toEqual(['P3: built in the coverage table, with a page, and not listed in the manifest']);
  });
});

describe('the demo manifest (orchestration-patterns R11(a))', () => {
  it("is committed, and lists exactly the built demos: phase 1's five, then phase 2's twelve, then phase 3's in their build orders (patterns-phase-1 R5; patterns-phase-2 R5, R13; patterns-phase-3 R5; demo-selector)", () => {
    expect(readManifest(ROOT)).toEqual([
      {
        pattern: 'P1',
        team: 'delegation',
        page: 'docs/patterns/p01-delegation.md',
        suite: 'tests/agents/p01-delegation.test.ts',
      },
      { pattern: 'P2', team: 'router', page: 'docs/patterns/p02-router.md', suite: 'tests/agents/p02-router.test.ts' },
      {
        pattern: 'P3',
        team: 'pipeline',
        page: 'docs/patterns/p03-pipeline.md',
        suite: 'tests/agents/p03-pipeline.test.ts',
      },
      {
        pattern: 'P12',
        team: 'self-select',
        page: 'docs/patterns/p12-self-selection.md',
        suite: 'tests/agents/p12-self-selection.test.ts',
      },
      {
        pattern: 'P22',
        team: 'escalation',
        page: 'docs/patterns/p22-escalation.md',
        suite: 'tests/agents/p22-escalation.test.ts',
      },
      {
        pattern: 'P18',
        team: 'agent-tool',
        page: 'docs/patterns/p18-agent-tool.md',
        suite: 'tests/agents/p18-agent-tool.test.ts',
      },
      {
        pattern: 'P4',
        team: 'rainbow',
        page: 'docs/patterns/p04-fan-out.md',
        suite: 'tests/agents/p04-fan-out.test.ts',
      },
      {
        pattern: 'P5',
        team: 'orchestrator',
        page: 'docs/patterns/p05-orchestrator-workers.md',
        suite: 'tests/agents/p05-orchestrator-workers.test.ts',
      },
      { pattern: 'P10', team: 'vote', page: 'docs/patterns/p10-voting.md', suite: 'tests/agents/p10-voting.test.ts' },
      // Joined once the demo selector was built (docs/plans/demo-selector.md), in patterns-phase-2's build order.
      { pattern: 'P9', team: 'debate', page: 'docs/patterns/p09-debate.md', suite: 'tests/agents/p09-debate.test.ts' },
      {
        pattern: 'P23',
        team: 'consensus',
        page: 'docs/patterns/p23-consensus.md',
        suite: 'tests/agents/p23-consensus.test.ts',
      },
      {
        pattern: 'P24',
        team: 'group-chat',
        page: 'docs/patterns/p24-group-chat.md',
        suite: 'tests/agents/p24-group-chat.test.ts',
      },
      {
        pattern: 'P8',
        team: 'critic-loop',
        page: 'docs/patterns/p08-critic-loop.md',
        suite: 'tests/agents/p08-critic-loop.test.ts',
      },
      {
        pattern: 'P16',
        team: 'guardrail',
        page: 'docs/patterns/p16-guardrail.md',
        suite: 'tests/agents/p16-guardrail.test.ts',
      },
      {
        pattern: 'P13',
        team: 'contract-net',
        page: 'docs/patterns/p13-contract-net.md',
        suite: 'tests/agents/p13-contract-net.test.ts',
      },
      {
        pattern: 'P6',
        team: 'plan-execute',
        page: 'docs/patterns/p06-plan-execute.md',
        suite: 'tests/agents/p06-plan-execute.test.ts',
      },
      {
        pattern: 'P14',
        team: 'watchdog',
        page: 'docs/patterns/p14-watchdog.md',
        suite: 'tests/agents/p14-watchdog.test.ts',
      },
      // patterns-phase-3's, each once its three recorded runs and one under its bound passed (R5), in its build order.
      {
        pattern: 'P25',
        team: 'restart',
        page: 'docs/patterns/p25-restart.md',
        suite: 'tests/agents/p25-restart.test.ts',
      },
      { pattern: 'P17', team: 'budget', page: 'docs/patterns/p17-budget.md', suite: 'tests/agents/p17-budget.test.ts' },
      { pattern: 'P21', team: 'topics', page: 'docs/patterns/p21-topics.md', suite: 'tests/agents/p21-topics.test.ts' },
      {
        pattern: 'P15',
        team: 'approval',
        page: 'docs/patterns/p15-approval.md',
        suite: 'tests/agents/p15-approval.test.ts',
      },
      {
        pattern: 'P19',
        team: 'spawner',
        page: 'docs/patterns/p19-spawning.md',
        suite: 'tests/agents/p19-spawning.test.ts',
      },
      {
        pattern: 'P7',
        team: 'hierarchy',
        page: 'docs/patterns/p07-hierarchy.md',
        suite: 'tests/agents/p07-hierarchy.test.ts',
      },
      // patterns-phase-4's, once its three recorded runs and one under its bound passed (R9).
      {
        pattern: 'P11',
        team: 'blackboard',
        page: 'docs/patterns/p11-blackboard.md',
        suite: 'tests/agents/p11-blackboard.test.ts',
      },
      // patterns-phase-5's, once its three recorded runs and one under its bound passed (R15).
      { pattern: 'P20', team: 'resume', page: 'docs/patterns/p20-resume.md', suite: 'tests/agents/p20-resume.test.ts' },
    ]);
  });

  /** A repo with P1's page, suite and team, for the manifest's path checks. */
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), 'asha-manifest-'));
    for (const [path, text] of Object.entries({
      'docs/patterns/p01-delegation.md': '# P1\n',
      'tests/agents/p01-delegation.test.ts': '',
      'teams/delegation/team.json': '{}',
    })) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  const P1 = {
    pattern: 'P1',
    team: 'delegation',
    page: 'docs/patterns/p01-delegation.md',
    suite: 'tests/agents/p01-delegation.test.ts',
  };

  it('reads a valid entry', () => {
    expect(parseManifest(JSON.stringify([P1]), repo())).toEqual([P1]);
  });

  it.each([
    ['not a list', { demos: [] }, 'must be a JSON list of demos'],
    ['an extra field', [{ ...P1, name: 'x' }], 'entry 0: unknown field name'],
    [
      'a missing field',
      [{ pattern: 'P1', team: 'delegation', page: P1.page }],
      'entry 0: suite must be a non-empty string',
    ],
    ['a pattern that is no catalogue id', [{ ...P1, pattern: 'P27' }], 'entry 0: "P27" is not a catalogue id P1–P26'],
    ['one pattern twice', [P1, P1], 'P1 is listed twice'],
    [
      'a page not named after the pattern',
      [{ ...P1, page: 'docs/patterns/p02-delegation.md' }],
      'P1: page must be docs/patterns/p01-<slug>.md',
    ],
    [
      'a suite not named after the page',
      [{ ...P1, suite: 'tests/agents/delegation.test.ts' }],
      "P1: suite must be tests/agents/<the page's name>.test.ts",
    ],
    ['a team that does not exist', [{ ...P1, team: 'nobody' }], 'P1: teams/nobody/team.json does not exist'],
  ])('refuses %s, naming it', (_, value, message) => {
    expect(() => parseManifest(JSON.stringify(value), repo())).toThrow(ManifestInvalid);
    expect(() => parseManifest(JSON.stringify(value), repo())).toThrow(`tests/agents/patterns/demos.json: ${message}`);
  });

  /** Each demo whose manifest team is not the team its page's run block launches. */
  const teamMismatches = (demos: readonly Demo[]): string[] =>
    demos.flatMap((d) => {
      const launched = readRunBlock(d.page, ROOT).team;
      return launched === d.team
        ? []
        : [`${d.pattern}: the manifest names team ${d.team}, and ${d.page} launches ${launched}`];
    });

  it('names, for each demo, the team its page launches (demo-selector R1; the code review of 2026-09-29, finding 3)', () => {
    const demos = readManifest(ROOT);
    expect(teamMismatches(demos)).toEqual([]);
    const p1 = present(
      demos.find((d) => d.pattern === 'P1'),
      'the P1 demo',
    );
    expect(teamMismatches([{ ...p1, team: 'router' }])).toEqual([
      'P1: the manifest names team router, and docs/patterns/p01-delegation.md launches delegation',
    ]);
  });

  /** Each manifest demo whose page does not say built, or still carries a planned badge. */
  const pageStatusProblems = (demos: readonly Demo[], read: (page: string) => string): string[] =>
    demos.flatMap((d) => {
      const text = read(d.page);
      if (text.includes('badge planned'))
        return [`${d.pattern}: listed in the manifest, and ${d.page} still carries a planned badge`];
      return text.includes('<span class="badge built">built</span>')
        ? []
        : [`${d.pattern}: listed in the manifest, and ${d.page} does not say built`];
    });

  it("has every manifest demo's page say built, with no planned badge (demo-selector's completion review, finding 1)", () => {
    const demos = readManifest(ROOT);
    const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
    expect(pageStatusProblems(demos, read)).toEqual([]);
    const p9 = present(
      demos.find((d) => d.pattern === 'P9'),
      'the P9 demo',
    );
    expect(
      pageStatusProblems(
        [p9],
        () => '<span>status: <a class="badge planned" href="../plans/patterns-phase-2.md">planned</a></span>',
      ),
    ).toEqual(['P9: listed in the manifest, and docs/patterns/p09-debate.md still carries a planned badge']);
    expect(pageStatusProblems([p9], () => '# P9\n')).toEqual([
      'P9: listed in the manifest, and docs/patterns/p09-debate.md does not say built',
    ]);
  });

  it('maps a catalogue id to its prefix', () => {
    expect(['P1', 'P9', 'P12', 'P26'].map(patternPrefix)).toEqual(['p01', 'p09', 'p12', 'p26']);
    expect(() => patternPrefix('P0')).toThrow();
  });
});
