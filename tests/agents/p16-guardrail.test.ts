// P16 · Guardrail / policy check: the demo of docs/patterns/p16-guardrail.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P16_A, P16_B } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p16-guardrail.md', REPO);
const MEMBERS = ['writer-1', 'policy-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p16-guardrail', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P16 · Guardrail / policy check — teams/guardrail/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p16-a: a draft with a phone number is blocked, then a revised one approved', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p16-a',
      title: 'p16-a: a draft with a phone number is blocked, then a revised one approved',
      expectation:
        'Call 1 holds the number and is blocked; call 2 holds no run of 7 digits and is approved; writer-1 replies with exactly the approved text.',
      agents: MEMBERS,
      claims: P16_A,
    });
  });

  it('p16-b: a harmless reply is approved at once', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p16-b',
      title: 'p16-b: a harmless reply is approved at once',
      expectation: 'One call, "Hello World", approved; writer-1 replies with exactly it.',
      agents: MEMBERS,
      claims: P16_B,
    });
  });
});
