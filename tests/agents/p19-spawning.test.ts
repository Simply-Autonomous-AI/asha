// P19 · Dynamic spawning: the demo of docs/patterns/p19-spawning.md on the real model (docs/plans/patterns-phase-3.md R2,
// R5). It runs the team's launch and the scenario's message exactly as the page's run-command block gives them, and
// asserts the scenario only through its checker (tests/agents/patterns/phase-3.ts), whose proof it records. Only lead-1
// is launched with the team; helper-1 joins when lead-1 launches it, and the checker reads its join, its launch and its
// stop from the daemon log — the stop awaited, since it follows the conversation's settling.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P19_A } from './patterns/phase-3.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p19-spawning.md', REPO);
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p19-spawning', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P19 · Dynamic spawning — teams/spawner/', () => {
  it('launches the team: lead-1 alone', async (context) => {
    await launchTeam(suite, context, block, ['lead-1']);
  });

  it('p19-a: lead-1 launches helper-1 and consults it', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p19-a',
      title: 'p19-a: lead-1 launches helper-1 and consults it',
      expectation:
        'helper-1 joins after the input and before the call, launched once by lead-1 from the recipe helper; one call lead-1 → helper-1 answered marigold and gathered; one output from lead-1 holding marigold; helper-1 stopped (drain) once the conversation settles; no error record; exit 0.',
      agents: ['lead-1', 'helper-1'],
      claims: P19_A,
      members: { handles: ['lead-1', 'helper-1'], members: ['helper'] },
      awaitDaemon: [{ event: 'agent.stopping', handle: 'helper-1' }],
    });
  });
});
