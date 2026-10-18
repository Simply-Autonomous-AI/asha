// P23 · Iterative consensus debate: the demo of docs/patterns/p23-consensus.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P23_A } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p23-consensus.md', REPO);
const MEMBERS = ['moderator-1', 'debater-a-1', 'debater-b-1', 'debater-c-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p23-consensus', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P23 · Iterative consensus debate — teams/consensus/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p23-a: moderator-1 runs rounds until the debaters agree', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p23-a',
      title: 'p23-a: moderator-1 runs rounds until the debaters agree',
      expectation:
        "Round 1's answers differ; each later round quotes every previous answer; the rounds stop at the first agreement or after round 3; the output states the agreed number and its round, or no consensus with the last tally, as the gathers give them.",
      agents: MEMBERS,
      claims: P23_A,
    });
  });
});
