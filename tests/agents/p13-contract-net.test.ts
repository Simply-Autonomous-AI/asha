// P13 · Contract net (bidding): the demo of docs/patterns/p13-contract-net.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P13_A } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p13-contract-net.md', REPO);
const MEMBERS = ['manager-1', 'courier-north-1', 'courier-south-1', 'courier-east-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p13-contract-net', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P13 · Contract net (bidding) — teams/contract-net/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p13-a: manager-1 awards the parcel to the lowest bidder', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p13-a',
      title: 'p13-a: manager-1 awards the parcel to the lowest bidder',
      expectation:
        "Call 1 to the three couriers gathers three PRICE answers; call 2 goes to the lowest bidder alone, with its price; its answer is its code; manager-1's reply names the winner, the price and the code.",
      agents: MEMBERS,
      claims: P13_A,
    });
  });
});
