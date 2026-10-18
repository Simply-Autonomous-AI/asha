// P9 · Debate with a judge: the demo of docs/patterns/p09-debate.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P09_A } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p09-debate.md', REPO);
const MEMBERS = ['judge-1', 'optimist-1', 'sceptic-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p09-debate', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P9 · Debate with a judge — teams/debate/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p09-a: judge-1 runs two rounds and gives a verdict', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p09-a',
      title: 'p09-a: judge-1 runs two rounds and gives a verdict',
      expectation:
        "Two calls to both debaters; every answer at most 200 characters, ending with its assigned stance; round 2's questions quote both round-1 answers; then a verdict, FOR or AGAINST, naming both debaters.",
      agents: MEMBERS,
      claims: P09_A,
    });
  });
});
