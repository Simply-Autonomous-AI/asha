// P6 · Plan-and-execute with ledgers: the demo of docs/patterns/p06-plan-execute.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.
// Its team gets this one scenario only: the checker reads whole agent logs (support.ts, agentLog).

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P06_A } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p06-plan-execute.md', REPO);
const MEMBERS = ['planner-1', 'half-a-1', 'half-b-1', 'backup-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p06-plan-execute', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P6 · Plan-and-execute with ledgers — teams/plan-execute/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p06-a: planner-1 keeps its ledgers and re-plans the stalled step', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p06-a',
      title: 'p06-a: planner-1 keeps its ledgers and re-plans the stalled step',
      expectation:
        'The task ledger written first; four calls — half-a-1, half-b-1 twice (failing), backup-1; the progress ledger holds the four attempts with their stall counts; plan 2 appended between the third and fourth progress writes; planner-1 replies sunflower; no error record.',
      agents: MEMBERS,
      claims: P06_A,
      agentLogs: ['planner-1'],
      workspace: { 'planner-1': ['progress-ledger.md', 'task-ledger.md'] },
    });
  });
});
