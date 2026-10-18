// P8 · Generator–critic loop: the demo of docs/patterns/p08-critic-loop.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P08_A, P08_B } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p08-critic-loop.md', REPO);
const MEMBERS = ['writer-1', 'critic-1', 'strict-critic-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p08-critic-loop', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P8 · Generator–critic loop — teams/critic-loop/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p08-a: writer-1 revises until critic-1 accepts', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p08-a',
      title: 'p08-a: writer-1 revises until critic-1 accepts',
      expectation:
        "Call 1's draft lacks green and is sent back; call 2's names the green lighthouse and is accepted; exactly two calls; writer-1 replies with the accepted draft.",
      agents: MEMBERS,
      claims: P08_A,
    });
  });

  it('p08-b: the bound: strict-critic-1 never accepts', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p08-b',
      title: 'p08-b: the bound: strict-critic-1 never accepts',
      expectation:
        'Exactly three calls to strict-critic-1, rounds 1 to 3, each draft different; no fourth; writer-1 replies with the third draft.',
      agents: MEMBERS,
      claims: P08_B,
    });
  });
});
