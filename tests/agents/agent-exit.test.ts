// A failed agent leaves its channel within seconds (docs/plans/debt-paydown.md R17, A14; debt D25): the test-only
// scripted image images/suite-files, which makes no model call, throws from its handler on `fail <text>`; its main runs
// serveAgent through exitOnFailure, so the process exits 1 at once: its channel stream closes, which takes it off the
// channel ("channel stream closed"), and the container's exit follows, logged agent.exited_unexpectedly with code 1.
// (Amended at the build, 2026-10-03: R17 expected the leave's detail "container exited with code 1"; the first run
// showed the stream's close comes first, 12 ms after the post, and the exit 95 ms after that, as patterns-phase-3 R11
// made it.) The bound, 10,000 ms from the post: probe P8
// measured 172 ms from the handler's rejection to the exit, and the delivery and the daemon's exit handling add
// milliseconds; it is far below the recipe's messageTimeoutMs, past which D25's failure showed as a delivery timeout.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { daemonLog, waitFor } from './persistence-support.js';
import { agentSuite, containerOf, type AgentSuite } from './support.js';

const LAUNCH_MS = 900_000;
const TURN_MS = 120_000;
/** R17's bound from the post to both records. */
const LEFT_WITHIN_MS = 10_000;

let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('agent-exit', 'exit');
});

afterAll(async () => {
  await suite.finish();
}, 120_000);

describe('a failed agent exits (debt-paydown R17; D25)', () => {
  it('an agent whose handler throws exits 1 and leaves the channel within 10,000 ms of the post; the command exits 1', async (ctx) => {
    suite.begin(ctx, {
      id: 'fail',
      title: 'a scripted agent told to fail',
      agents: ['a-1', 'b-1'],
      expectation:
        'a-1, sent "fail on purpose", throws from its handler: within 10,000 ms of the post the daemon logs channel.left for it ("channel stream closed") and agent.exited_unexpectedly with code 1 for its container; the command exits 1.',
    });
    const launched = await suite.send(ctx, ['--launch', 'team=suite-files', 'channel=exit'], LAUNCH_MS);
    expect(launched.code, launched.stderr).toBe(0);
    const [a] = launched.stdout.trim().split('\n');
    expect(a).toMatch(/^a-\d+$/);
    const handle = present(a, "the launched agent's handle");
    const container = containerOf(suite.home, 'exit', handle);

    const posted = Date.now();
    const run = await suite.send(
      ctx,
      ['channel=exit', `to=${handle}`, 'user=alice', 'message=fail on purpose'],
      TURN_MS,
    );
    // The command returns once the agent has left; the container's exit is logged after (95 ms in the first run): read
    // the log once it holds the exit, at most until the bound.
    const since = () => daemonLog(suite.home).filter((r) => Date.parse(String(r['ts'])) >= posted);
    const records = await waitFor(
      since,
      (rs) => rs.some((r) => r['event'] === 'agent.exited_unexpectedly'),
      Math.max(0, posted + LEFT_WITHIN_MS - Date.now()),
      'agent.exited_unexpectedly',
    );
    const exited = records.filter((r) => r['event'] === 'agent.exited_unexpectedly' && r['container'] === container);
    const left = records.filter((r) => r['event'] === 'channel.left' && r['channel'] === 'exit' && r['handle'] === a);
    expect(
      exited.map((r) => [r['code'], Date.parse(String(r['ts'])) - posted <= LEFT_WITHIN_MS]),
      'agent.exited_unexpectedly for its container',
    ).toEqual([[1, true]]);
    expect(
      left.map((r) => [r['detail'], Date.parse(String(r['ts'])) - posted <= LEFT_WITHIN_MS]),
      'channel.left for it',
    ).toEqual([['channel stream closed', true]]);
    expect(run.code, run.stderr).toBe(1);
    const exitedRecord = present(exited[0], 'the agent.exited_unexpectedly record');
    const leftRecord = present(left[0], 'the channel.left record');
    suite.prove(ctx, [
      {
        claim: 'the container exited 1 within 10,000 ms of the post',
        evidence: `agent.exited_unexpectedly code 1 at ${String(exitedRecord['ts'])}, posted ${new Date(posted).toISOString()}`,
      },
      {
        claim: 'the agent left the channel, named left',
        evidence: `channel.left "${String(leftRecord['detail'])}" at ${String(leftRecord['ts'])}`,
      },
    ]);
  });
});
