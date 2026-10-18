// P24 · Managed group chat: the demo of docs/patterns/p24-group-chat.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P24_A, P24_B } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p24-group-chat.md', REPO);
const MEMBERS = ['manager-1', 'alpha-1', 'beta-1', 'gamma-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p24-group-chat', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P24 · Managed group chat — teams/group-chat/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p24-a: round robin: manager-1 asks alpha-1, beta-1, gamma-1 in turn', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p24-a',
      title: 'p24-a: round robin: manager-1 asks alpha-1, beta-1, gamma-1 in turn',
      expectation:
        "Three calls, one participant each, in team.json's order; each question carries every earlier line; manager-1 replies with the three lines in order.",
      agents: MEMBERS,
      claims: P24_A,
    });
  });

  it('p24-b: selector: manager-1 asks the keeper of each digit in turn', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p24-b',
      title: 'p24-b: selector: manager-1 asks the keeper of each digit in turn',
      expectation:
        "Three calls, one participant each, in the order beta-1, alpha-1, gamma-1; each question carries the digits so far; no digit is in the manager's files; manager-1 replies 528.",
      agents: MEMBERS,
      claims: P24_B,
    });
  });
});
