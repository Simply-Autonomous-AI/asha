// P7 · Hierarchical teams: the demo of docs/patterns/p07-hierarchy.md on the real model (docs/plans/patterns-phase-3.md R2,
// R5). It runs the team's launch and the scenario's message exactly as the page's run-command block gives them, and
// asserts the scenario only through its checker (tests/agents/patterns/phase-3.ts), whose proof it records: top-1's call
// to the two leads, each lead's own call to its workers recorded as a child of it, and the answers coming back up.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P07_A } from './patterns/phase-3.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p07-hierarchy.md', REPO);
const MEMBERS = ['top-1', 'lead-warm-1', 'lead-cool-1', 'red-1', 'orange-1', 'blue-1', 'violet-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p07-hierarchy', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P7 · Hierarchical teams — teams/hierarchy/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p07-a: top-1 asks the leads, each lead asks its workers', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p07-a',
      title: 'p07-a: top-1 asks the leads, each lead asks its workers',
      expectation:
        "top-1's one call to the two leads; each lead's own call to its two workers, a child of top-1's, opened after top-1's question and gathered before the lead answers; lead-warm-1 answers 4, 7 and lead-cool-1 3, 2; one gather to top-1 with two answered; one output from top-1, warm 4, 7 and cool 3, 2; no error record; exit 0.",
      agents: MEMBERS,
      claims: P07_A,
    });
  });
});
