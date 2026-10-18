// P11 · Blackboard: the demo of docs/patterns/p11-blackboard.md on the real model (docs/plans/patterns-phase-4.md R6,
// R9). It runs the team's launch and each scenario's command exactly as the page's run-command block gives them, p11-a
// before p11-b, reads each scenario's board entries through the control API (GET /v1/blackboard: the entries after the
// last one before its command), and asserts each scenario only through its checker (tests/agents/patterns/phase-4.ts),
// whose proof it records. The proof that work travels only through the board: no message holds an item or a fact, each
// is in one member's files only, and yet the replies hold them all.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P11_A, P11_B } from './patterns/phase-4.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p11-blackboard.md', REPO);
const MEMBERS = [
  'editor-1',
  'contrib-a-1',
  'contrib-b-1',
  'contrib-c-1',
  'planner-1',
  'note-day-1',
  'note-room-1',
  'note-time-1',
];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p11-blackboard', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P11 · Blackboard — teams/blackboard/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p11-a: the shopping list, assembled from the items each contributor posts to the board', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p11-a',
      title: 'p11-a: the shopping list, assembled from the items each contributor posts to the board',
      expectation:
        "editor-1 consults contrib-a-1, contrib-b-1 and contrib-c-1 in one call; each posts its item (item: saffron, item: quince jam, item: rye flour) to the board before the gather and answers with no item; editor-1 reads the board after the gather and replies with the items in the board's order; each item in one member's files only; exit 0; no error record.",
      agents: MEMBERS,
      claims: P11_A,
      // The contributors' blackboard.posted records carry no conversation.
      members: { handles: ['contrib-a-1', 'contrib-b-1', 'contrib-c-1'], members: [] },
      board: true,
    });
  });

  it('p11-b: the meeting notice, each member reading the board and extending what an earlier one posted', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p11-b',
      title: 'p11-b: the meeting notice, each member reading the board and extending what an earlier one posted',
      expectation:
        'planner-1 consults note-day-1, then note-room-1, then note-time-1, one call each; note-day-1 posts notice: meeting on Thursday; note-room-1 and note-time-1 each read the board and post the last notice extended with their fact (Juniper, 14:30); no message holds a fact; planner-1 reads the board and replies with the three facts; exit 0; no error record.',
      agents: MEMBERS,
      claims: P11_B,
      members: { handles: ['note-day-1', 'note-room-1', 'note-time-1'], members: [] },
      board: true,
    });
  });
});
