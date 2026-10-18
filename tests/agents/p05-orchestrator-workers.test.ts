// P5 · Orchestrator–workers: the demo of docs/patterns/p05-orchestrator-workers.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P05_A } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p05-orchestrator-workers.md', REPO);
const MEMBERS = ['lead-1', 'worker-a-1', 'worker-b-1', 'worker-c-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p05-orchestrator-workers', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P5 · Orchestrator–workers — teams/orchestrator/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p05-a: lead-1 gives each worker only its part', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p05-a',
      title: 'p05-a: lead-1 gives each worker only its part',
      expectation:
        'One call with a part per worker, chosen from their descriptions: the translation to worker-a-1, the sum to worker-b-1, the say to worker-c-1; three answers, one gather; then lead-1 replies Merci, 42 and Hello World, one per line, in that order.',
      agents: MEMBERS,
      claims: P05_A,
    });
  });
});
