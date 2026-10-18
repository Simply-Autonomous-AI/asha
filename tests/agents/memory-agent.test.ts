// The memory agent: memo, with its four tiers, in its container, on the real
// chat and embedding models. Each scenario checks what the user sees and — by
// reading the agent's own memory files inside its container — what it stored,
// for whom. Two users, alice and bob, on one channel: nothing of alice's may
// ever reach bob (docs/architecture/memory.html).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeKey } from '../../images/memory/src/memory/index.js';
import { agentSuite, eventually, outputs, readMemory, type AgentSuite, type MemoryContents } from './support.js';

let suite: AgentSuite;
const CHANNEL = 'mem';
const ALICE = scopeKey({ channel: CHANNEL, user: 'alice' });
const BOB = scopeKey({ channel: CHANNEL, user: 'bob' });
const memory = (key: string): Promise<MemoryContents> => readMemory(suite.home, CHANNEL, 'memory', key);
/** Memory is written after the reply; wait (bounded) for it to show what a scenario expects. */
const settled = (key: string, done: (m: MemoryContents) => boolean) => eventually(() => memory(key), done, 90_000);

beforeAll(async () => {
  suite = await agentSuite('memory-agent', CHANNEL);
});

afterAll(async () => {
  await suite.finish();
});

describe('memory agent: memo-1 on channel "mem", users alice and bob', () => {
  it('launches the memory recipe, with its chat and embedding models', async (ctx) => {
    suite.begin(ctx, {
      id: 'launch',
      title: 'Launch the memory recipe',
      agents: [],
      expectation: 'memo-1 comes online; the embedding model is served alongside the chat model.',
    });
    const run = await suite.send(ctx, ['--launch', 'recipe=memory', `channel=${CHANNEL}`], 900_000);
    expect([run.code, run.stdout], run.stderr).toEqual([0, 'memo-1\n']);
    expect(run.stderr).toContain('model_server: qwen3-embedding-0.6b-q8_0 serving');
  });

  it('semantic: alice tells it facts, and they are extracted into her memory', async (ctx) => {
    suite.begin(ctx, {
      id: 'tell-facts',
      title: 'alice: "Hi! My name is Alice and my favourite colour is teal."',
      agents: ['memo-1'],
      expectation: 'memo-1 replies to alice; her semantic memory gains her name and her favourite colour.',
    });
    const run = await suite.send(
      ctx,
      [`channel=${CHANNEL}`, 'user=alice', 'message=Hi! My name is Alice and my favourite colour is teal.'],
      180_000,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events)).toEqual([{ from: 'memo-1', to: 'alice' }]);
    const m = await settled(
      ALICE,
      (x) => x.semantic.some((f) => /teal/i.test(f)) && x.semantic.some((f) => /alice/i.test(f)),
    );
    expect(m.semantic.join('\n')).toMatch(/teal/i);
    expect(m.semantic.join('\n')).toMatch(/alice/i);
    expect(m.session).toHaveLength(1);
    expect(m.episodic).toHaveLength(1);
  });

  it('recall: alice asks, and memo-1 answers from her memory', async (ctx) => {
    suite.begin(ctx, {
      id: 'recall',
      title: 'alice: "What is my favourite colour?"',
      agents: ['memo-1'],
      expectation: 'memo-1 answers teal.',
    });
    const run = await suite.send(
      ctx,
      [`channel=${CHANNEL}`, 'user=alice', 'message=What is my favourite colour?'],
      180_000,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/teal/i);
  });

  it("privacy: bob asks the same, and gets nothing of alice's; nothing of hers is in his memory", async (ctx) => {
    suite.begin(ctx, {
      id: 'privacy',
      title: 'bob: "What is my favourite colour?"',
      agents: ['memo-1'],
      expectation: "Nothing bob sees mentions teal or Alice; bob's memory holds nothing of alice's.",
    });
    const run = await suite.send(
      ctx,
      [`channel=${CHANNEL}`, 'user=bob', 'message=What is my favourite colour?'],
      180_000,
    );
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/teal|alice/i);
    const bob = await memory(BOB);
    expect(JSON.stringify(bob)).not.toMatch(/teal|alice/i);
  });

  it('procedural: a task done with a technique that worked is recorded as a reusable procedure', async (ctx) => {
    suite.begin(ctx, {
      id: 'procedure',
      title: 'alice: "What is a 15% tip on a $80 bill? Show how you worked it out."',
      agents: ['memo-1'],
      expectation:
        "memo-1 answers $12 with its working; alice's procedural memory gains a reusable percentage technique.",
    });
    const run = await suite.send(
      ctx,
      [`channel=${CHANNEL}`, 'user=alice', 'message=What is a 15% tip on a $80 bill? Show how you worked it out.'],
      180_000,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/\$?12/);
    const m = await settled(ALICE, (x) => x.procedural.length > 0);
    expect(m.procedural.join('\n')).toMatch(/percent|%/i);
    expect(m.procedural.join('\n')).toMatch(/multiply/i);
  });

  it('episodic and semantic past the window: after 8 more turns, the first turn has left the session, and her name is still recalled', async (ctx) => {
    suite.begin(ctx, {
      id: 'past-window',
      title: 'alice: 8 small requests, then "What is my name?"',
      agents: ['memo-1'],
      expectation:
        'Her first turn has slid out of the 8-turn session window, yet memo-1 answers Alice — from her semantic and episodic memory.',
    });
    for (let i = 1; i <= 8; i += 1) {
      const filler = await suite.send(
        ctx,
        [`channel=${CHANNEL}`, 'user=alice', `message=Please say: noted ${String(i)}.`],
        180_000,
      );
      expect(filler.code, filler.stderr).toBe(0);
    }
    const before = await settled(
      ALICE,
      (x) => x.session.length === 8 && !x.session.some((t) => /my name is alice/i.test(t)),
    );
    expect(before.session.some((t) => /my name is alice/i.test(t))).toBe(false);
    expect(before.episodic.some((t) => /my name is alice/i.test(t))).toBe(true);
    const run = await suite.send(ctx, [`channel=${CHANNEL}`, 'user=alice', 'message=What is my name?'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/alice/i);
  });

  it("identity through delegation: hewo-1 asks memo-1 for alice, and memo-1 answers from alice's memory — and not for bob", async (ctx) => {
    suite.begin(ctx, {
      id: 'delegated',
      title: 'alice, then bob, to hewo-1: "Please ask memo-1 what my favourite colour is."',
      agents: ['memo-1', 'hewo-1'],
      expectation: 'For alice, memo-1 (reached through hewo-1) answers teal; for bob, nothing mentions teal.',
    });
    // hewo-1 asks memo-1 on the user's behalf: the router, on Qwen3 8B (hello-router).
    const launch = await suite.send(ctx, ['--launch', 'recipe=hello-router', `channel=${CHANNEL}`], 300_000);
    expect([launch.code, launch.stdout]).toEqual([0, 'hewo-1\n']);
    const alice = await suite.send(
      ctx,
      [`channel=${CHANNEL}`, 'user=alice', 'to=hewo-1', 'message=Please ask memo-1 what my favourite colour is.'],
      180_000,
    );
    expect(alice.code, alice.stderr).toBe(0);
    expect(alice.events.filter((e) => e.type === 'internal' && e.from === 'hewo-1' && e.to === 'memo-1')).toHaveLength(
      1,
    );
    expect(outputs(alice.events).map((o) => o.from)).toContain('memo-1');
    expect(alice.stdout).toMatch(/teal/i);
    const bob = await suite.send(
      ctx,
      [`channel=${CHANNEL}`, 'user=bob', 'to=hewo-1', 'message=Please ask memo-1 what my favourite colour is.'],
      180_000,
    );
    expect(`${bob.stdout}\n${bob.stderr}`).not.toMatch(/teal|alice/i);
  });
});
