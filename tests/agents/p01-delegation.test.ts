// P1 · Delegation (hand-off): the demo of docs/patterns/p01-delegation.md on the real model (docs/plans/patterns-phase-1.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-1.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P01_A } from './patterns/phase-1.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p01-delegation.md', REPO);
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p01-delegation', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P1 · Delegation (hand-off) — teams/delegation/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, ['lead-1', 'greeter-1']);
  });

  it('p01-a: lead-1 hands "say Hello World" to greeter-1', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p01-a',
      title: 'p01-a: lead-1 hands "say Hello World" to greeter-1',
      expectation:
        'lead-1 sends greeter-1 an instruction to say Hello World; greeter-1, not lead-1, replies "Hello World" to the user; no call is opened.',
      agents: ['lead-1', 'greeter-1'],
      claims: P01_A,
    });
  });
});
