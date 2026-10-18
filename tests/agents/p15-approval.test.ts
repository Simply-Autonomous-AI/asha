// P15 · Human approval gate: the demo of docs/patterns/p15-approval.md on the real model (docs/plans/patterns-phase-3.md
// R2, R5). It runs the team's launch and each scenario's two commands exactly as the page's run-command block gives
// them — the second answering the first in its conversation, sent only after the first exits — and asserts each
// scenario only through its checker (tests/agents/patterns/phase-3.ts), whose proof it records. The gate is the agent's:
// the checker proves the clerk posted to the board only after the user's answer, and only on a yes.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P15_A, P15_B } from './patterns/phase-3.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p15-approval.md', REPO);
/** The scenario's members: the board's posts are clerk-1's own records, which carry no conversation. */
const MEMBERS = { handles: ['clerk-1'], members: [] };
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p15-approval', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P15 · Human approval gate — teams/approval/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, ['clerk-1']);
  });

  it('p15-a: the user approves, and only then is the announcement posted', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p15-a',
      title: 'p15-a: the user approves, and only then is the announcement posted',
      expectation:
        'Command 1: clerk-1 asks for approval, its question holding the announcement, with the waiting line; exit 0. Command 2 answers yes in the same conversation: one blackboard.posted, by clerk-1, after the answer and none before, the entry the announcement; then Posted.; exit 0; no error record.',
      agents: ['clerk-1'],
      claims: P15_A,
      members: MEMBERS,
    });
  });

  it('p15-b: the user declines, and nothing is posted', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p15-b',
      title: 'p15-b: the user declines, and nothing is posted',
      expectation:
        'As p15-a to the answer, which is no: no blackboard.posted at all; then Not posted.; exit 0; no error record.',
      agents: ['clerk-1'],
      claims: P15_B,
      members: MEMBERS,
    });
  });
});
