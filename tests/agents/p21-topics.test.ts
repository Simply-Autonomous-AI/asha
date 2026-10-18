// P21 · Publish / subscribe: the demo of docs/patterns/p21-topics.md on the real model (docs/plans/patterns-phase-3.md
// R2, R5). It runs the team's launch and each scenario's message exactly as the page's run-command block gives them —
// each to a topic, topic= — and asserts each scenario only through its checker (tests/agents/patterns/phase-3.ts),
// whose proof it records. The routing is the harness's: the members' subscriptions are their team.json topics.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P21_A, P21_B } from './patterns/phase-3.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p21-topics.md', REPO);
const DESKS = ['weather-desk-1', 'sports-desk-1', 'front-page-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p21-topics', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P21 · Publish / subscribe — teams/topics/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, DESKS);
  });

  it('p21-a: a weather message reaches the weather desk and the front page only', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p21-a',
      title: 'p21-a: a weather message reaches the weather desk and the front page only',
      expectation:
        'Posted to topic weather: delivered to exactly weather-desk-1 and front-page-1, each replying "<its handle> noted:" and the message; sports-desk-1 receives and posts nothing; no error record; exit 0.',
      agents: DESKS,
      claims: P21_A,
      members: { handles: DESKS, members: [] },
    });
  });

  it('p21-b: a sports message reaches the sports desk and the front page only', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p21-b',
      title: 'p21-b: a sports message reaches the sports desk and the front page only',
      expectation:
        'Posted to topic sports: delivered to exactly sports-desk-1 and front-page-1, each replying "<its handle> noted:" and the message; weather-desk-1 receives and posts nothing; no error record; exit 0.',
      agents: DESKS,
      claims: P21_B,
      members: { handles: DESKS, members: [] },
    });
  });
});
