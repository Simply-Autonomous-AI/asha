// With modules unused, nothing changes (docs/plans/extension-modules.md R38; A38 (a)): the calls a daemon with no
// ASHA_HOME/modules/ makes for a start, a hello-world launch and one message — the container runtime's, the model
// server's, and every model request byte for byte — equal those recorded by the same steps at the plan's base commit
// (tests/fixtures/modules/r38-base-calls.json, its provenance in that folder's README).

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { recordUnusedPath } from '../helpers/unused-path.js';

it('makes exactly the calls the base commit made: no engine check, egress rule, network or module container; model requests byte for byte', async () => {
  const base = JSON.parse(
    await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'modules', 'r38-base-calls.json'),
      'utf8',
    ),
  ) as unknown;
  const now = await recordUnusedPath();
  expect(now).toEqual(base);
  expect(now.reply).toBe('hewo-1\nHello World!\n');
  expect(now.runtimeCalls.filter((c) => /engineVersion|Network|EgressRules|runAttached|plugin/.test(c))).toEqual([]);
});
