// The agent test report's pattern sections (docs/plans/orchestration-patterns.md
// R10, A6): each renders the pattern's anchor, name, links to its page and its
// team folder, each scenario's proof as a checklist of claim and evidence, every
// repeat that ran with its ms, commit and tree, and its gate line; a scenario
// with no proof, or a file that has not run, says so rather than show nothing.

import { describe, expect, it } from 'vitest';

import {
  isSuiteResultsFile,
  patternSection,
  repeatOrder,
  selectionLine,
  withoutMachinePaths,
  type ResultFile,
} from '../../evals/patterns/report-sections.js';
import type { SelectionRecord } from '../../evals/patterns/selection.js';

const result = (file: string, over: Partial<ResultFile> = {}): ResultFile => ({
  file,
  commit: 'abcdef1234567890',
  dirty: false,
  startedAt: '2026-09-29T00:00:00.000Z',
  finishedAt: '2026-09-29T00:01:00.000Z',
  scenarios: [
    {
      scenario: { id: 'launch', title: 'launch' },
      runs: [{ args: ['--launch', 'team=delegation'], ms: 2000 }],
      state: 'pass',
      errors: [],
    },
    {
      scenario: { id: 'p01-a', title: 'lead-1 hands the task on' },
      runs: [{ args: ['to=lead-1'], ms: 6518 }],
      state: 'pass',
      errors: [],
      proof: [
        {
          claim: 'exactly one internal message, lead-1 → greeter-1',
          evidence: '› internal lead-1 → greeter-1: Say: Hello World',
        },
        { claim: 'the command exits 0', evidence: 'exit 0' },
      ],
    },
  ],
  ...over,
});
const props = {
  prefix: 'p01',
  name: 'P1 · Delegation (hand-off)',
  page: 'patterns/p01-delegation.md',
  team: 'delegation',
  scenarios: ['p01-a'],
  selection: '3 repeats: no selection',
};

describe("the report's pattern sections (orchestration-patterns R10, A6)", () => {
  it('renders the anchor, the name, the links, the proof as a checklist, each repeat and the gate line', () => {
    const html = patternSection({ ...props, results: [result('p01-delegation.json')] });
    expect(html).toContain('<section id="pattern-p01" class="pattern">');
    expect(html).toContain('<h2>P1 · Delegation (hand-off)</h2>');
    expect(html).toContain('<a href="../patterns/p01-delegation.html">patterns/p01-delegation.html</a>');
    expect(html).toContain('<a href="../../teams/delegation/team.json">teams/delegation/</a>');
    expect(html).toContain('Gate: 3 repeats: no selection');
    expect(html).toContain(
      '<span class="check">✓</span> <b>exactly one internal message, lead-1 → greeter-1</b><br><code>› internal lead-1 → greeter-1: Say: Hello World</code>',
    );
    expect(html).toContain('<span class="check">✓</span> <b>the command exits 0</b><br><code>exit 0</code>');
    expect(html).toContain(
      '<tr><td><code>p01-delegation.json</code></td><td><code>abcdef1</code></td><td>clean</td><td>6,518</td></tr>',
    );
  });

  it('shows a scenario with no proof as such, a failed one with its errors, a dirty tree, and each repeat in order', () => {
    const noProof = result('p01-delegation.r1.json', { dirty: true });
    const scenarios = noProof.scenarios.map((s) =>
      s.scenario.id === 'p01-a' ? { ...s, proof: undefined, state: 'fail' as const, errors: ['exit 1'] } : s,
    );
    const html = patternSection({ ...props, results: [result('p01-delegation.r2.json'), { ...noProof, scenarios }] });
    expect(html).toContain('<li class="proof-missing"><em>no proof recorded</em></li>');
    expect(html).toContain('<pre class="proof-errors">exit 1</pre>');
    expect(html).toContain('<td><span class="warn">dirty</span></td>');
    expect(html.indexOf('p01-delegation.r2.json')).toBeLessThan(html.indexOf('p01-delegation.r1.json'));
  });

  it('a demo whose file has not run shows that, and each scenario not run yet', () => {
    const html = patternSection({ ...props, results: [] });
    expect(html).toContain('Its agent-suite file has not run yet: no results file.');
    expect(html).toContain('<span class="sid">p01-a</span> <em>not run yet</em>');
  });

  it('escapes what a model wrote', () => {
    const r = result('p01-delegation.json');
    const scenarios = r.scenarios.map((s) =>
      s.proof ? { ...s, proof: [{ claim: 'c', evidence: '<script>alert(1)</script>' }] } : s,
    );
    expect(patternSection({ ...props, results: [{ ...r, scenarios }] })).toContain(
      '<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>',
    );
  });

  it("orders a suite's results files: the single run, then .r1 to .r3; other suites' files are not its", () => {
    expect(
      repeatOrder(
        [
          'p01-delegation.r3.json',
          'multi-agent.json',
          'p01-delegation.json',
          'p01-delegation.r1.json',
          'p01-delegation-x.json',
        ],
        'p01-delegation',
      ),
    ).toEqual(['p01-delegation.json', 'p01-delegation.r1.json', 'p01-delegation.r3.json']);
  });
});

describe('the gate line from the selection (demo-selector R12, A6)', () => {
  const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
  const selection: SelectionRecord = {
    commit: COMMIT,
    mode: 'check',
    base: '1'.repeat(40),
    baseReason: 'last green gate',
    baseDetail: null,
    changed: ['teams/delegation/lead.md'],
    demos: [
      {
        pattern: 'P1',
        suite: 'tests/agents/p01-delegation.test.ts',
        repeats: 3,
        reason: 'own: teams/delegation/lead.md',
      },
      { pattern: 'P2', suite: 'tests/agents/p02-router.test.ts', repeats: 1, reason: 'untouched' },
    ],
  };

  it("shows each listed demo's selection at the results' commit, and says when a demo is not in it", () => {
    expect(selectionLine(selection, COMMIT, 'tests/agents/p01-delegation.test.ts')).toBe(
      'selected 3 repeats: own: teams/delegation/lead.md',
    );
    expect(selectionLine(selection, COMMIT, 'tests/agents/p02-router.test.ts')).toBe('selected 1 repeat: untouched');
    expect(selectionLine(selection, COMMIT, 'tests/agents/p09-debate.test.ts')).toBe('not in the selection');
    const html = patternSection({
      ...props,
      results: [result('p01-delegation.json', { commit: COMMIT })],
      selection: selectionLine(selection, COMMIT, 'tests/agents/p01-delegation.test.ts'),
    });
    expect(html).toContain('Gate: selected 3 repeats: own: teams/delegation/lead.md');
  });

  it('shows no selection when the file is absent, from another commit, or the demo has not run', () => {
    expect(selectionLine(null, COMMIT, 'tests/agents/p01-delegation.test.ts')).toBe('3 repeats: no selection');
    expect(selectionLine(selection, '9'.repeat(40), 'tests/agents/p01-delegation.test.ts')).toBe(
      '3 repeats: no selection',
    );
    expect(selectionLine(selection, undefined, 'tests/agents/p01-delegation.test.ts')).toBe('3 repeats: no selection');
  });

  it("reads as a suite's results neither the selection, the gate record, nor a temporary file", () => {
    expect(
      [
        'teams.json',
        'p01-delegation.r2.json',
        'selection.json',
        'gate.json',
        '.selection-1-abcdef012345.json',
        'notes.txt',
      ].filter(isSuiteResultsFile),
    ).toEqual(['teams.json', 'p01-delegation.r2.json']);
  });
});

describe("the report names no machine's temporary folder (oss-release R11)", () => {
  it('writes each macOS temporary folder as $TMPDIR/, and leaves every other path as it was', () => {
    const line = (path: string): string =>
      `<span>started the asha daemon (pid 26130); log: ${path}asha-run-1-ab/logs/server.log</span>`;
    expect(withoutMachinePaths(line('/var/folders/xy/abc123/T/'))).toBe(line('$TMPDIR/'));
    expect(withoutMachinePaths(line('/private/var/folders/xy/abc123/T/'))).toBe(line('$TMPDIR/'));
    expect(withoutMachinePaths(`${line('/var/folders/xy/a/T/')}${line('/var/folders/zz/b/T/')}`)).toBe(
      `${line('$TMPDIR/')}${line('$TMPDIR/')}`,
    );
    for (const kept of ['/tmp/', '/var/folders/xy/', '/var/folders/xy/abc123/C/', '$TMPDIR/'])
      expect(withoutMachinePaths(line(kept)), kept).toBe(line(kept));
  });
});
