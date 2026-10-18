// P18 · Agent as tool (call and return): the demo of docs/patterns/p18-agent-tool.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P18_A } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p18-agent-tool.md', REPO);
const MEMBERS = ['delegator-1', 'worker-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p18-agent-tool', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P18 · Agent as tool (call and return) — teams/agent-tool/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p18-a: delegator-1 consults worker-1 and answers the user itself', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p18-a',
      title: 'p18-a: delegator-1 consults worker-1 and answers the user itself',
      expectation:
        'One call, delegator-1 → worker-1; worker-1 answers Hello World to delegator-1 only; one gather; then delegator-1 replies "worker-1 said: Hello World"; worker-1 posts no output.',
      agents: MEMBERS,
      claims: P18_A,
    });
  });
});
