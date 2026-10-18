// P3 · Sequential pipeline: the demo of docs/patterns/p03-pipeline.md on the real model (docs/plans/patterns-phase-1.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-1.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P03_A } from './patterns/phase-1.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p03-pipeline.md', REPO);
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p03-pipeline', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P3 · Sequential pipeline — teams/pipeline/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, ['stage-a-1', 'stage-b-1', 'stage-c-1']);
  });

  it('p03-a: the colour list through three stages', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p03-a',
      title: 'p03-a: the colour list through three stages',
      expectation:
        'stage-a-1 → stage-b-1 "list: red", stage-b-1 → stage-c-1 "list: red, orange", then stage-c-1 replies "list: red, orange, yellow", in that order.',
      agents: ['stage-a-1', 'stage-b-1', 'stage-c-1'],
      claims: P03_A,
    });
  });
});
