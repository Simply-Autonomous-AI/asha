// P17 · Budgets and circuit breaker: the demo of docs/patterns/p17-budget.md on the real model
// (docs/plans/patterns-phase-3.md R2, R5). It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them — each with its budget on the command, posts= or tokens= — and asserts each scenario
// only through its checker (tests/agents/patterns/phase-3.ts), whose proof it records. Nothing is faked: the pair
// would message each other for ever, and the conversation's budget is what ends it.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P17_A, P17_B } from './patterns/phase-3.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p17-budget.md', REPO);
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p17-budget', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P17 · Budgets and circuit breaker — teams/budget/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, ['ping-1', 'pong-1']);
  });

  it('p17-a: the post budget of 8 ends the ping-pong at its ninth post', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p17-a',
      title: 'p17-a: the post budget of 8 ends the ping-pong at its ninth post',
      expectation:
        'ping-1 and pong-1 alternate ping and pong, eight internal messages; the ninth post is refused, and the stream ends with ✗ budget_exceeded (its budget of 8 agent posts); no agent post after it; one channel.conversation_ended and no other error record; exit 1.',
      agents: ['ping-1', 'pong-1'],
      claims: P17_A,
      members: { handles: ['ping-1', 'pong-1'], members: [] },
    });
  });

  it('p17-b: the token budget of 6000 ends it before the posts do', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p17-b',
      title: 'p17-b: the token budget of 6000 ends it before the posts do',
      expectation:
        'The same pair and message with a budget of 6,000 tokens: fewer than eight internal messages, then ✗ budget_exceeded (tokens used past 6,000); no agent post after it; one channel.conversation_ended and no other error record; exit 1.',
      agents: ['ping-1', 'pong-1'],
      claims: P17_B,
      members: { handles: ['ping-1', 'pong-1'], members: [] },
    });
  });
});
