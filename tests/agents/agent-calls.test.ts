// Agent calls (docs/plans/agent-calls.md R13, R17; A8, A9): an agent consults
// others through the harness and gets every answer back in one gather, then
// tells the user itself. Real agents in their containers, on the real model:
// hewo-1 and hewo-2 (hello-world) with memo-1 (memory) on channel "calls", and
// ten hello-world agents on channel "relay".
//
// The plan's third scenario, call and return (P18: "Get hewo-2 to say Hello
// World, then tell me yourself what it said."), is not here: on the pinned
// model the caller hands that task off instead of consulting (routing case
// call-and-return 0/3 under every wording tried), and the owner's answer of
// 2026-09-28 leaves it out of the tests as a limit of this model (debt D30,
// docs/plans/debt.md#d30; docs/plans/agent-calls.md#answered).
//
// What the transcript does not show — which call an answer belongs to, and the
// order of a call's addressees — is read from the daemon's log (channel.posted
// carries each call message's call id and role; channel.call_opened its
// addressees in request order).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeKey } from '../../images/memory/src/memory/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { agentSuite, eventually, outputs, readMemory, type AgentSuite, type TranscriptEvent } from './support.js';

let suite: AgentSuite;
const CALLS = 'calls';
const RELAY = 'relay';
/** R13: each single-call scenario, from sending the user's message to the command's exit. */
const SINGLE_CALL_MS = 15_000;
/**
 * R13's bound B for the fan-out: 1.5 × the slowest of three calibration runs of this file at fadd68c (clean,
 * 2026-09-29: 25,098, 25,150 and 25,230 ms), rounded up to the next 1,000 ms — 37,845 → 38,000 ms. Records:
 * evals/probes/agent-calls-2026-09-29/calibration/.
 */
const FAN_OUT_MS = 38_000;
const WORDS = ['violet', 'green', 'pink', 'red', 'indigo', 'brown', 'orange', 'blue', 'yellow'] as const;
const RELAY_MESSAGE =
  'Get each of these agents to say one word back to you, then tell me yourself the words in the order you asked: ' +
  WORDS.map((w, i) => `hewo-${String(i + 2)}: ${w}`).join(', ') +
  '.';

beforeAll(async () => {
  suite = await agentSuite('agent-calls', CALLS);
});

afterAll(async () => {
  await suite.finish();
});

/** The daemon log's records of this suite so far. */
function daemonLog(): Record<string, unknown>[] {
  return readFileSync(join(suite.home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The call messages the daemon posted in one conversation, by role: [from, to, call id]. */
function callMessages(conversation: string, role: 'question' | 'answer' | 'gather'): [string, string, string][] {
  return daemonLog()
    .filter((r) => r['event'] === 'channel.posted' && r['conversation'] === conversation && r['role'] === role)
    .map((r) => [String(r['from']), String(r['to']), String(r['call'])]);
}

/** The conversation of the run just made: the last one the daemon started on the channel. */
function lastConversation(channel: string): string {
  const started = daemonLog().filter((r) => r['event'] === 'conversation.started' && r['channel'] === channel);
  return String(present(started.at(-1), `the last "conversation.started" record on ${channel}`)['conversation']);
}

const internals = (events: readonly TranscriptEvent[]) =>
  events.filter((e): e is Extract<TranscriptEvent, { type: 'internal' }> => e.type === 'internal');

describe('agent calls: consult, answers, one gather, and the caller tells the user', () => {
  it('launches memo-1, hewo-1 and hewo-2 on channel "calls"', async (ctx) => {
    suite.begin(ctx, {
      id: 'launch',
      title: 'Launch memory, then hello-world twice, on "calls"',
      agents: [],
      expectation: 'memo-1, hewo-1 and hewo-2 come online.',
    });
    const memo = await suite.send(ctx, ['--launch', 'recipe=memory', `channel=${CALLS}`], 900_000);
    const first = await suite.send(ctx, ['--launch', 'recipe=hello-world', `channel=${CALLS}`], 300_000);
    const second = await suite.send(ctx, ['--launch', 'recipe=hello-world', `channel=${CALLS}`], 300_000);
    expect([memo.stdout, first.stdout, second.stdout]).toEqual(['memo-1\n', 'hewo-1\n', 'hewo-2\n']);
  });

  it("identity through a call: hewo-1 consults memo-1 for alice, and tells her teal itself — and nothing of alice's reaches bob", async (ctx) => {
    suite.begin(ctx, {
      id: 'identity-call',
      title: 'alice, then bob, to hewo-1: "Find out from memo-1 what my favourite colour is, and tell me yourself."',
      agents: ['memo-1', 'hewo-1', 'hewo-2'],
      expectation:
        'For alice: one question hewo-1→memo-1, one answer memo-1→hewo-1, one gather to hewo-1, then one output from hewo-1 saying teal; memo-1 outputs nothing. For bob: nothing mentions teal or alice. Each run within 15 s.',
    });
    const told = await suite.send(
      ctx,
      [`channel=${CALLS}`, 'user=alice', 'to=memo-1', 'message=Hi! My name is Alice and my favourite colour is teal.'],
      180_000,
    );
    expect(told.code, told.stderr).toBe(0);
    await eventually(
      () => readMemory(suite.home, CALLS, 'memory', scopeKey({ channel: CALLS, user: 'alice' })),
      (m) => m.semantic.some((f) => /teal/i.test(f)),
      90_000,
    );

    const alice = await suite.send(
      ctx,
      [
        `channel=${CALLS}`,
        'user=alice',
        'to=hewo-1',
        'message=Find out from memo-1 what my favourite colour is, and tell me yourself.',
      ],
      180_000,
    );
    expect(alice.code, alice.stderr).toBe(0);
    const conversation = lastConversation(CALLS);
    const questions = callMessages(conversation, 'question');
    expect(questions.map(([from, to]) => [from, to])).toEqual([['hewo-1', 'memo-1']]);
    const call = present(questions[0], 'the first "question" call message')[2];
    expect(callMessages(conversation, 'answer')).toEqual([['memo-1', 'hewo-1', call]]);
    expect(callMessages(conversation, 'gather')).toEqual([['asha', 'hewo-1', call]]);
    expect(outputs(alice.events).map((o) => o.from)).toEqual(['hewo-1']);
    expect(alice.stdout).toMatch(/teal/i);
    expect(alice.ms, 'R13: within 15,000 ms').toBeLessThanOrEqual(SINGLE_CALL_MS);

    const bob = await suite.send(
      ctx,
      [
        `channel=${CALLS}`,
        'user=bob',
        'to=hewo-1',
        'message=Find out from memo-1 what my favourite colour is, and tell me yourself.',
      ],
      180_000,
    );
    expect(bob.code, bob.stderr).toBe(0);
    expect(`${bob.stdout}\n${bob.stderr}`).not.toMatch(/teal|alice/i);
    expect(outputs(bob.events).map((o) => o.from)).not.toContain('memo-1');
    expect(bob.ms, 'R13: within 15,000 ms').toBeLessThanOrEqual(SINGLE_CALL_MS);
  });

  it('launches ten hello-world-image agents on channel "relay": the router and nine responders', async (ctx) => {
    suite.begin(ctx, {
      id: 'launch-relay',
      title: 'Launch hello-router, then hello-world nine times, on "relay"',
      agents: [],
      expectation: 'hewo-1 … hewo-10 come online on "relay", and --status lists the ten.',
    });
    for (let i = 1; i <= 10; i += 1) {
      // hewo-1 consults the other nine (the fan-out relay below): the router, on Qwen3 8B; the nine answer, on Pico-V2.
      const recipe = i === 1 ? 'hello-router' : 'hello-world';
      const run = await suite.send(ctx, ['--launch', `recipe=${recipe}`, `channel=${RELAY}`], 300_000);
      expect([run.code, run.stdout], run.stderr).toEqual([0, `hewo-${String(i)}\n`]);
    }
    const status = await suite.asha(['--status'], 30_000);
    expect(
      status.stdout
        .split('\n')
        .filter((l) => l.includes(`channel=${RELAY} `))
        .map((l) => l.trim().split(/\s+/)[0]),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `hewo-${String(i + 1)}`).sort(byCodeUnit));
  });

  it('fan-out relay: hewo-1 consults nine agents at once, gets one gather, and tells the user the nine words in order', async (ctx) => {
    suite.begin(ctx, {
      id: 'fan-out-relay',
      title: 'alice to hewo-1 on "relay": get each of hewo-2 … hewo-10 to say one word back, then say them in order',
      agents: Array.from({ length: 10 }, (_, i) => `hewo-${String(i + 1)}`),
      expectation:
        'Nine questions from hewo-1, all posted before any answer; nine answers to hewo-1 on the one call, each with its word; exactly one gather to hewo-1 of nine answered; then one output, from hewo-1, with the nine words in order; no other agent outputs; within B, 38,000 ms (R13).',
    });
    const run = await suite.send(
      ctx,
      [`channel=${RELAY}`, 'user=alice', 'to=hewo-1', `message=${RELAY_MESSAGE}`],
      300_000,
    );
    expect(run.code, run.stderr).toBe(0);
    const conversation = lastConversation(RELAY);
    const opened = daemonLog().filter(
      (r) => r['event'] === 'channel.call_opened' && r['conversation'] === conversation,
    );
    expect(
      opened.map((r) => r['addressees']),
      'one call, its addressees in the order asked',
    ).toEqual([WORDS.map((_, i) => `hewo-${String(i + 2)}`)]);
    const call = String(present(opened[0], 'the first "channel.call_opened" record')['call']);
    const questions = callMessages(conversation, 'question');
    expect(questions).toEqual(WORDS.map((_, i) => ['hewo-1', `hewo-${String(i + 2)}`, call]));
    // Every question is posted before any answer.
    const lines = internals(run.events);
    const lastQuestion = lines.findLastIndex((e) => e.from === 'hewo-1');
    const firstAnswer = lines.findIndex((e) => e.to === 'hewo-1' && e.from !== 'asha');
    expect(lastQuestion).toBeLessThan(firstAnswer);
    // Nine answers on the one call, each carrying its sender's word.
    expect(
      callMessages(conversation, 'answer')
        .map(([from, to, id]) => [from, to, id])
        .sort((a, b) => byCodeUnit(a.join(','), b.join(','))),
    ).toEqual(
      WORDS.map((_, i) => [`hewo-${String(i + 2)}`, 'hewo-1', call]).sort((a, b) =>
        byCodeUnit(a.join(','), b.join(',')),
      ),
    );
    for (const [i, word] of WORDS.entries()) {
      expect(lines.filter((e) => e.from === `hewo-${String(i + 2)}` && e.to === 'hewo-1').map((e) => e.text)).toEqual([
        expect.stringMatching(new RegExp(`\\b${word}\\b`, 'i')),
      ]);
    }
    // Exactly one gather, of nine answered (its entries are in request order by construction: tests/unit/channel-calls.test.ts, A4).
    expect(callMessages(conversation, 'gather')).toEqual([['asha', 'hewo-1', call]]);
    expect(lines.filter((e) => e.from === 'asha').map((e) => e.text)).toEqual([
      "Answers to hewo-1's call: 9 answered.",
    ]);
    expect(outputs(run.events).map((o) => o.from)).toEqual(['hewo-1']);
    expect(run.stdout).toMatch(new RegExp(WORDS.map((w) => `\\b${w}\\b`).join('[\\s\\S]*'), 'i'));
    expect(run.ms, `R13: within B, ${String(FAN_OUT_MS)} ms`).toBeLessThanOrEqual(FAN_OUT_MS);
  });
});
