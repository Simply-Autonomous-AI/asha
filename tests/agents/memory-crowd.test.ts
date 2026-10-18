// A crowd: ten memory agents on one channel. alice tells one of them
// something; then she asks everyone. The one who was told must answer, and
// no other agent may claim to know — each agent's memory is its own
// (it lives in that agent's container, docs/architecture/memory.html).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeKey } from '../../images/memory/src/memory/index.js';
import {
  agentSuite,
  cacheHits,
  containerOf,
  eventually,
  firstChatCalls,
  modelCalls,
  outputs,
  readContainerMemory,
  type AgentSuite,
  type ModelCallRecord,
} from './support.js';

let suite: AgentSuite;
const CHANNEL = 'crowd';
const AGENTS = Array.from({ length: 10 }, (_, i) => `memo-${String(i + 1)}`);
const TOLD = 'memo-4';
const ALICE = scopeKey({ channel: CHANNEL, user: 'alice' });
const memoryOf = (handle: string) => readContainerMemory(containerOf(suite.home, CHANNEL, handle), ALICE);
/** One first call's cached/prompt tokens, as "<handle> <cached>/<prompt>" — the annotation's per-agent detail. */
const cacheLine = (c: ModelCallRecord) => `${c.handle} ${String(c.cachedTokens)}/${String(c.promptTokens)}`;

beforeAll(async () => {
  suite = await agentSuite('memory-crowd', CHANNEL);
});

afterAll(async () => {
  await suite.finish();
});

describe('a crowd of ten memory agents on channel "crowd"', () => {
  it('launches ten memory agents, memo-1 to memo-10', async (ctx) => {
    suite.begin(ctx, {
      id: 'launch',
      title: 'Launch the memory recipe ten times on one channel',
      agents: [],
      expectation: 'The channel names them memo-1 to memo-10.',
    });
    const handles: string[] = [];
    for (let i = 0; i < AGENTS.length; i += 1) {
      const run = await suite.send(
        ctx,
        ['--launch', 'recipe=memory', `channel=${CHANNEL}`],
        i === 0 ? 900_000 : 300_000,
      );
      expect(run.code, run.stderr).toBe(0);
      handles.push(run.stdout.trim());
    }
    expect(handles).toEqual(AGENTS);
  });

  it(`alice tells only ${TOLD}; only ${TOLD} remembers it`, async (ctx) => {
    suite.begin(ctx, {
      id: 'tell-one',
      title: `alice → ${TOLD}: "My favourite colour is teal."`,
      agents: AGENTS,
      expectation: `${TOLD} alone receives and acknowledges it; its memory holds teal for alice; the other nine agents' memories hold nothing for her.`,
    });
    const run = await suite.send(
      ctx,
      [`channel=${CHANNEL}`, 'user=alice', `to=${TOLD}`, 'message=My favourite colour is teal.'],
      180_000,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events)).toEqual([{ from: TOLD, to: 'alice' }]);
    const told = await eventually(
      () => memoryOf(TOLD),
      (m) => m.semantic.some((f) => /teal/i.test(f)),
      90_000,
    );
    expect(told.semantic.join('\n')).toMatch(/teal/i);
    for (const other of AGENTS.filter((a) => a !== TOLD)) {
      expect(JSON.stringify(await memoryOf(other)), other).not.toMatch(/teal/i);
    }
  });

  it(`alice asks everyone; ${TOLD}, who knows, answers teal, and the nine who don't know stay silent`, async (ctx) => {
    suite.begin(ctx, {
      id: 'ask-all',
      title: 'alice → everyone: "What is my favourite colour?"',
      agents: AGENTS,
      expectation: `${TOLD} alone answers: teal. The other nine don't know, so each passes and says nothing to alice (the owner's rule, 2026-09-26).`,
    });
    const run = await suite.send(
      ctx,
      [`channel=${CHANNEL}`, 'user=alice', 'message=What is my favourite colour?'],
      600_000,
    );
    expect(run.code, run.stderr).toBe(0);
    // prompt-prefix R13: the ten agents share one prompt prefix, so the model server's prompt cache serves most of
    // each turn after the first few; at least 6 of the 10 first calls take 90 % or more of their prompt from it.
    const firsts = firstChatCalls(modelCalls(suite.home), CHANNEL, AGENTS, run.startedAt);
    const hits = cacheHits(firsts);
    await ctx.annotate(
      `ask-all ${String(run.ms)} ms; first calls cached/prompt tokens: ${firsts.map(cacheLine).join(', ')}`,
    );
    expect(
      firsts.map((c) => c.handle),
      'every agent made a model call for the message',
    ).toEqual(AGENTS);
    expect(
      hits.length,
      `prompt-cache hits among the ten first calls: ${hits.map((c) => c.handle).join(', ')}`,
    ).toBeGreaterThanOrEqual(6);
    // Exactly one reply, from the agent that knows.
    expect(outputs(run.events)).toEqual([{ from: TOLD, to: 'alice' }]);
    expect(run.stdout).toMatch(/teal/i);
    // Every other agent decided not to answer, and said so on the channel.
    for (const other of AGENTS.filter((a) => a !== TOLD)) {
      expect(
        run.events.filter((e) => e.type === 'status' && e.from === other && e.text.startsWith('pass')),
        other,
      ).toHaveLength(1);
    }
  });
});
