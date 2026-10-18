// P22 · Escalation to a human: the demo of docs/patterns/p22-escalation.md on the real model (docs/plans/patterns-phase-1.md
// R2; p22-b, the take-over, docs/plans/patterns-phase-3.md R28). It runs the team's launch and each scenario's commands
// exactly as the page's run-command block gives them — p22-b's second answering the first in its conversation — and
// asserts each scenario only through its checker (P22_A in tests/agents/patterns/phase-1.ts, P22_B in phase-3.ts),
// whose proof it records for the report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P22_A } from './patterns/phase-1.js';
import { P22_B } from './patterns/phase-3.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p22-escalation.md', REPO);
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p22-escalation', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P22 · Escalation to a human (the summary) — teams/escalation/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, ['helper-1']);
  });

  it("p22-a: a request half outside the helper's role", async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p22-a',
      title: "p22-a: a request half outside the helper's role",
      expectation:
        'helper-1 escalates once, "ESCALATE: done: …300…; left: …meeting room…", and posts nothing after it.',
      agents: ['helper-1'],
      claims: P22_A,
    });
  });

  it("p22-b: the user takes over: the answer, inside the helper's role, is passed on", async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p22-b',
      title: "p22-b: the user takes over: the answer, inside the helper's role, is passed on",
      expectation:
        'Command 1 as p22-a, the escalation an ask with its waiting line, exit 0; command 2 answers in the same conversation with a conversion inside its role, and helper-1 posts only "pass: …"; the harness answers that no agent could, naming helper-1 as passed; exit 1; no error record.',
      agents: ['helper-1'],
      claims: P22_B,
    });
  });
});
