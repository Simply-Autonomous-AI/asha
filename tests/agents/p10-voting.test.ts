// P10 · Voting / ensemble: the demo of docs/patterns/p10-voting.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P10_A } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p10-voting.md', REPO);
const MEMBERS = ['aggregator-1', 'voter-cautious-1', 'voter-bold-1', 'voter-thrifty-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p10-voting', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P10 · Voting / ensemble — teams/vote/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p10-a: aggregator-1 reports the majority of three independent votes', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p10-a',
      title: 'p10-a: aggregator-1 reports the majority of three independent votes',
      expectation:
        "One call to the three voters, none seeing another's answer; each answer ends with its VOTE line and reaches no agent; aggregator-1's majority and tally equal those the gather's votes give; the voters' guidance differs.",
      agents: MEMBERS,
      claims: P10_A,
    });
  });
});
