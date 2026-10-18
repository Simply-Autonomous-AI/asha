// Multiple agents: two hello-world agents, hewo-1 and hewo-2, on one channel,
// each in its own container, each answering through the real model. The
// scenarios check who answers, that answers reach the user, and that work
// handed from one agent to another comes back to the user.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentSuite,
  cacheHits,
  firstChatCalls,
  modelCalls,
  outputs,
  toAll,
  type AgentSuite,
  type ModelCallRecord,
} from './support.js';

let suite: AgentSuite;
// Every message names its invented user (cli-interactive R16: the suite's send refuses one without user=).
const USER = 'mia';
/** One first call's cached/prompt tokens, as "<handle> <cached>/<prompt>" — the annotation's per-agent detail. */
const cacheLine = (c: ModelCallRecord) => `${c.handle} ${String(c.cachedTokens)}/${String(c.promptTokens)}`;

beforeAll(async () => {
  suite = await agentSuite('multi-agent', 'duo');
});

afterAll(async () => {
  await suite.finish();
});

describe('multiple agents: hewo-1 and hewo-2 on channel "duo"', () => {
  it('launches two hello-world-image agents, the router and a responder, numbered by the channel', async (ctx) => {
    suite.begin(ctx, {
      id: 'launch',
      title: 'Launch hello-router, then suite-multi-agent-responder, on one channel',
      agents: [],
      expectation: 'The channel names them hewo-1 and hewo-2.',
    });
    // hewo-1 hands the work on (the delegation below), so it is the router, on Qwen3 8B; hewo-2 answers, on Pico-V2,
    // from this suite's own responder recipe: hello-world's prompt with a one-shot example of answering the user a task
    // another agent hands it (the owner, 2026-10-15), kept out of hello-world itself, whose prompt the routing gate measures.
    const first = await suite.send(ctx, ['--launch', 'recipe=hello-router', 'channel=duo'], 600_000);
    const second = await suite.send(ctx, ['--launch', 'recipe=suite-multi-agent-responder', 'channel=duo'], 300_000);
    expect([first.code, first.stdout, second.code, second.stdout]).toEqual([0, 'hewo-1\n', 0, 'hewo-2\n']);
  });

  it('hands work from one agent to the other, and the other answers the user', async (ctx) => {
    suite.begin(ctx, {
      id: 'delegation',
      title: 'Addressed to hewo-1: "Please ask hewo-2 to say Hello World."',
      agents: ['hewo-1', 'hewo-2'],
      expectation:
        'hewo-1 sends hewo-2 the task as an instruction ("Say Hello World"), not just the words; hewo-2 replies "Hello World" to the user.',
    });
    const run = await suite.send(
      ctx,
      ['user=mia', 'to=hewo-1', 'channel=duo', 'message=Please ask hewo-2 to say Hello World.'],
      180_000,
    );
    expect(run.code, run.stderr).toBe(0);
    // An instruction, not just the words: "Hello World" alone only works because hewo-2 repeats what it is given.
    expect(run.events.filter((e) => e.type === 'internal')).toEqual([
      {
        type: 'internal',
        from: 'hewo-1',
        to: 'hewo-2',
        text: expect.stringMatching(/^(please[,:]?\s+)?say\b.*hello,? world/i) as string,
      },
    ]);
    expect(outputs(run.events)).toEqual([{ from: 'hewo-2', to: USER }]);
    expect(run.stdout).toMatch(/^hello,? world\.?\n$/i);
  });

  it('answers a greeting to everyone with replies to the user, not posts to the channel', async (ctx) => {
    suite.begin(ctx, {
      id: 'greeting',
      title: 'A greeting to everyone: "Hi"',
      agents: ['hewo-1', 'hewo-2'],
      expectation: 'At least one agent replies to the user; no agent posts to the channel.',
    });
    const run = await suite.send(ctx, ['user=mia', 'channel=duo', 'message=Hi'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    // D44: the two agents' first calls for "Hi" run at once, and both take their prompt from the server's prompt
    // cache — the second from the host prompt store, filled after the recipe's first answered call (delegation's).
    // Without it the second computed its whole prompt (cachedTokens 0) and both calls took over 5 s.
    const firsts = firstChatCalls(modelCalls(suite.home), 'duo', ['hewo-1', 'hewo-2'], run.startedAt);
    await ctx.annotate(
      `greeting ${String(run.ms)} ms; first calls cached/prompt tokens: ${firsts.map(cacheLine).join(', ')}`,
    );
    expect(
      firsts.map((c) => c.handle),
      'both agents made a model call for the greeting',
    ).toEqual(['hewo-1', 'hewo-2']);
    expect(
      cacheHits(firsts).map((c) => c.handle),
      'first calls served 90 % or more from the prompt cache',
    ).toEqual(['hewo-1', 'hewo-2']);
    expect(outputs(run.events).length).toBeGreaterThan(0);
    for (const o of outputs(run.events)) expect(o.to).toEqual(USER);
    expect(toAll(run.events)).toEqual([]);
  });

  it('only the addressed agent answers a greeting sent to it', async (ctx) => {
    suite.begin(ctx, {
      id: 'greeting-addressed',
      title: 'A greeting addressed to hewo-2: "Hi"',
      agents: ['hewo-1', 'hewo-2'],
      expectation: 'hewo-2 alone works on it and replies to the user.',
    });
    const run = await suite.send(ctx, ['user=mia', 'channel=duo', 'to=hewo-2', 'message=Hi'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events)).toEqual([{ from: 'hewo-2', to: USER }]);
    expect(run.events.filter((e) => e.type === 'status' && e.from === 'hewo-1')).toEqual([]);
    expect(toAll(run.events)).toEqual([]);
  });

  it('answers a request to everyone with Hello World to the user', async (ctx) => {
    suite.begin(ctx, {
      id: 'hello-world-all',
      title: 'A request to everyone: "Please say: Hello World."',
      agents: ['hewo-1', 'hewo-2'],
      expectation: 'At least one agent replies Hello World to the user; no agent posts to the channel.',
    });
    const run = await suite.send(ctx, ['user=mia', 'channel=duo', 'message=Please say: Hello World.'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events).length).toBeGreaterThan(0);
    for (const line of run.stdout.trim().split('\n')) expect(line).toMatch(/hello,? world/i);
    expect(toAll(run.events)).toEqual([]);
  });

  it('answers a question addressed to it with a reply to the user', async (ctx) => {
    suite.begin(ctx, {
      id: 'question-addressed',
      title: 'A question addressed to hewo-1: "What can you do?"',
      agents: ['hewo-1', 'hewo-2'],
      expectation: 'hewo-1 replies to the user; nothing is posted to the channel.',
    });
    const run = await suite.send(ctx, ['user=mia', 'channel=duo', 'to=hewo-1', 'message=What can you do?'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events)).toEqual([{ from: 'hewo-1', to: USER }]);
    expect(toAll(run.events)).toEqual([]);
  });

  it('neither agent takes on work outside its role; both say pass, and the harness tells the user why', async (ctx) => {
    suite.begin(ctx, {
      id: 'off-role',
      title: 'Work outside both roles, to everyone: "Please translate this contract into French."',
      agents: ['hewo-1', 'hewo-2'],
      expectation:
        'Both say "pass: <reason>"; the harness replies that no agent could answer, listing both; the command exits 1; nothing is claimed, handed off or posted to the channel.',
    });
    const run = await suite.send(
      ctx,
      ['user=mia', 'channel=duo', 'message=Please translate this contract into French.'],
      180_000,
    );
    expect(run.events.filter((e) => e.type === 'internal')).toEqual([]);
    for (const agent of ['hewo-1', 'hewo-2']) {
      expect(
        run.events.filter((e) => e.type === 'status' && e.from === agent && e.text.startsWith('pass')),
      ).toHaveLength(1);
    }
    expect(outputs(run.events)).toEqual([{ from: 'asha', to: USER }]);
    expect(run.stdout).toMatch(/^No agent could answer this:\n- hewo-1 passed(: .+)?\n- hewo-2 passed(: .+)?\n$/);
    expect(run.code).toBe(1);
    // The harness's reply is the explanation; exit 1 marks the failure, with no extra ✗ line.
    expect(run.stderr).not.toContain('✗');
  });
});
