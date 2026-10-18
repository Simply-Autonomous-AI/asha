// P4 · Fan-out / fan-in: the demo of docs/patterns/p04-fan-out.md on the real model
// (docs/plans/patterns-phase-2.md R2, R8; the rainbow team of
// docs/plans/collaborating-agents.md R7, R9, R13, A6, moved here from
// tests/agents/rainbow.test.ts). It runs the team's launch and p04-a's message
// exactly as the page's run-command block gives them, and asserts the scenario
// only through its checker (tests/agents/patterns/rainbow.ts), whose proof —
// with the order of the nine questions and the arrival order of the answers —
// it records for the report. Each member's largest delivery time, read from the
// conversation's asha.delivery spans, is recorded beside it: collaborating-agents
// R13's measure, from which the recipes' delivery bound was set. Nothing is faked.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readRunBlock, scenarioCommand } from '../../evals/patterns/run-block.js';
import { RAINBOW_FACTS, RAINBOW_SUPERVISOR_HANDLE, factHandle } from '../../evals/routing/rainbow.js';
import { LAUNCH_TIMEOUT_MS, MESSAGE_TIMEOUT_MS } from './patterns/demo.js';
import { P04_A, RAINBOW_MESSAGE_TIMEOUT_MS } from './patterns/rainbow.js';
import { runClaims } from './patterns/record.js';
import { REPO, agentSuite, conversationDeliveries, conversationLog, teamFiles, type AgentSuite } from './support.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';

const block = readRunBlock('docs/patterns/p04-fan-out.md', REPO);
const CHANNEL = 'main';
const MEMBERS = [RAINBOW_SUPERVISOR_HANDLE, ...RAINBOW_FACTS.map(([colour]) => factHandle(colour))];
let suite: AgentSuite;
/** One member's largest delivery time, as "<handle> <ms> ms" — collaborating-agents R13's measure, per member. */
const timeLine = ([handle, ms]: readonly [string, number]) => `${handle} ${String(ms)} ms`;

beforeAll(async () => {
  suite = await agentSuite('p04-fan-out', CHANNEL);
});

afterAll(async () => {
  await suite.finish();
});

describe('P4 · Fan-out / fan-in — teams/rainbow/', () => {
  it('launches the ten members, and --status lists them on one channel', async (context) => {
    suite.begin(context, {
      id: 'launch',
      title: `./asha ${block.launch.join(' ')}`,
      agents: [],
      expectation: `Every member comes online on channel ${CHANNEL}: ${MEMBERS.join(', ')}; --status lists the ten there.`,
    });
    const run = await suite.send(context, block.launch, LAUNCH_TIMEOUT_MS);
    expect([run.code, run.stdout], run.stderr).toEqual([0, MEMBERS.map((m) => `${m}\n`).join('')]);
    const status = await suite.asha(['--status'], 30_000);
    expect(
      status.stdout
        .split('\n')
        .filter((l) => l.includes(`channel=${CHANNEL} `))
        .map((l) => present(l.trim().split(/\s+/)[0], "a status line's first field"))
        .sort(byCodeUnit),
    ).toEqual([...MEMBERS].sort(byCodeUnit));
  });

  it('p04-a: supervisor-1 consults the nine at once, gets one gather, and replies 4, 7, 1, 9, 3, 6, 2', async (context) => {
    suite.begin(context, {
      id: 'p04-a',
      title: 'p04-a: supervisor-1 consults the nine at once and orders their numbers',
      agents: MEMBERS,
      expectation:
        "One call from supervisor-1 whose nine questions go to the nine fact members, all posted before any answer; an answer from each, on the call, with its number and colour; exactly one gather to supervisor-1 of nine answered; then exactly one output, from supervisor-1, after the gather, with 4, 7, 1, 9, 3, 6, 2 in that order and neither 5 nor 8; no fact member outputs; each fact in one member's documents; every recipe's messageTimeoutMs R13's; within the page's bound.",
    });
    const run = await suite.send(context, scenarioCommand(block, 'p04-a'), MESSAGE_TIMEOUT_MS);
    const { conversation, log } = conversationLog(suite.home, CHANNEL, run.startedAt);
    const deliveries = conversationDeliveries(suite.home, conversation);
    const record = { args: run.args, code: run.code, stdout: run.stdout, events: run.events, ms: run.ms };
    const result = runClaims(
      {
        scenario: 'p04-a',
        run: record,
        runs: [record],
        conversation,
        log,
        team: teamFiles(block.team),
        boundMs: block.boundMs,
        deliveries: deliveries.map((d) => d.handle),
        agentLogs: {},
        workspace: {},
      },
      P04_A,
    );
    // collaborating-agents R13's measure, recorded with the proof (not a claim: the recipes' value is the checker's).
    const times = new Map<string, number>();
    for (const d of deliveries)
      times.set(d.handle, Math.max(times.get(d.handle) ?? 0, Date.parse(d.end) - Date.parse(d.start)));
    const largest = Math.max(...times.values());
    const measured = {
      claim: `collaborating-agents R13's measure: each member's largest delivery time (asha.delivery spans); the recipes set ${String(RAINBOW_MESSAGE_TIMEOUT_MS)} ms`,
      evidence: `${[...times].map(timeLine).join('; ')}; largest ${String(largest)} ms, × 2 = ${String(largest * 2)} ms, rounded up to a whole second ${String(Math.ceil((largest * 2) / 1000) * 1000)} ms`,
    };
    suite.prove(context, [...result.proof, measured]);
    expect(result.failures, run.stderr).toEqual([]);
  });
});
