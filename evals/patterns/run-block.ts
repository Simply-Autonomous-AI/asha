// A pattern page's run-command block, read from its file (docs/plans/orchestration-patterns.md R3, A1). The parser and
// everything it defines live in src/shared/run-block.ts (moved there by docs/plans/portal-scene-chat.md R16, so the
// daemon's demo route reads a page with the same code); this module adds the file read and re-exports the rest, so
// the agent suite's and the unit tests' imports are unchanged.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRunBlock, type RunBlock } from '../../src/shared/run-block.js';

export * from '../../src/shared/run-block.js';

/** The page's one run-command block, parsed. `page` is relative to the repo root, `root`. */
export function readRunBlock(page: string, root: string): RunBlock {
  return parseRunBlock(page, readFileSync(join(root, page), 'utf8'));
}
