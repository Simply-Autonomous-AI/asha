// The coverage table of docs/testing/index.md#patterns (docs/plans/orchestration-patterns.md R15), row by row: each
// pattern, the scenario ids its row lists, and its status cell. Read by pattern-coverage.test.ts and by the plan's own
// check of the scenario ids, pattern-coverage-plan.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { present } from '../../src/shared/assert-present.js';

import { ROOT } from './pattern-spec.js';

export interface CoverageRow {
  readonly pattern: string;
  readonly scenarios: readonly string[];
  readonly status: string;
}

/** The coverage table of docs/testing/index.md#patterns, row by row. */
export function coverageTable(markdown = readFileSync(join(ROOT, 'docs/testing/index.md'), 'utf8')): CoverageRow[] {
  const start = markdown.indexOf('{#patterns}');
  const end = markdown.indexOf('\n## ', start);
  return [...markdown.slice(start, end).matchAll(/^\| (P\d+) \| .*? \| .*? \| (.*?) \| .* \| (.*?) \|$/gm)].map(
    (m) => ({
      pattern: present(m[1], 'capture group 1 (pattern)'),
      scenarios: [...present(m[2], 'capture group 2 (scenarios)').matchAll(/p\d{2}-[a-z]/g)].map((s) => s[0]),
      status: present(m[3], 'capture group 3 (status)'),
    }),
  );
}
