// P14 · Watchdog and reassignment: the demo of docs/patterns/p14-watchdog.md on the real model (docs/plans/patterns-phase-2.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-2.ts), whose proof it records for the
// report. Nothing is faked.
// Its team gets this one scenario only: the checker reads whole agent logs (support.ts, agentLog).

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P14_A } from './patterns/phase-2.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p14-watchdog.md', REPO);
const MEMBERS = ['lead-1', 'stuck-1', 'backup-1'];
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p14-watchdog', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P14 · Watchdog and reassignment — teams/watchdog/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, MEMBERS);
  });

  it('p14-a: stuck-1 times out and lead-1 gives the task to backup-1', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p14-a',
      title: 'p14-a: stuck-1 times out and lead-1 gives the task to backup-1',
      expectation:
        'stuck-1 calls hold (hold.started) and its delivery expires (channel.delivery_timeout, its one declared error record); it leaves; the call is gathered timed out; lead-1 asks backup-1 the same text and replies with its answer.',
      agents: MEMBERS,
      claims: P14_A,
      agentLogs: ['stuck-1'],
      awaitDaemon: [{ event: 'channel.left', handle: 'stuck-1' }],
    });
  });
});
