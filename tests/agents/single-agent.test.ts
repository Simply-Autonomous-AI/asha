// Single agent: one hello-world agent, alone on its channel, in its container,
// answering through the real model. Each scenario is a message a user might
// send and what the user must see. The failure these were written against
// (2026-09-26): "Hi" to everyone was answered on the channel, so the user got
// no reply.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentSuite, outputs, toAll, type AgentSuite } from './support.js';

let suite: AgentSuite;
// Every message names its invented user (cli-interactive R16: the suite's send refuses one without user=).
const USER = 'sam';

beforeAll(async () => {
  suite = await agentSuite('single-agent', 'solo');
});

afterAll(async () => {
  await suite.finish();
});

describe('single agent: hewo-1 alone on channel "solo"', () => {
  it('brings hello-world online and says Hello World to the user', async (ctx) => {
    suite.begin(ctx, {
      id: 'hello-world',
      title: 'A request to everyone to say Hello World',
      agents: [],
      expectation: 'hewo-1 comes online and replies "Hello World." to the user; nothing is posted to the channel.',
    });
    const run = await suite.send(
      ctx,
      ['user=sam', 'recipe=hello-world', 'channel=solo', 'message=Please say: Hello World.'],
      600_000,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain('› hewo-1: Hi');
    expect(outputs(run.events)).toEqual([{ from: 'hewo-1', to: 'sam' }]);
    expect(run.stdout).toBe('Hello World.\n');
    expect(toAll(run.events)).toEqual([]);
  });

  it('answers a greeting to everyone with a reply to the user, not a post to the channel', async (ctx) => {
    suite.begin(ctx, {
      id: 'greeting',
      title: 'A greeting to everyone: "Hi"',
      agents: ['hewo-1'],
      expectation: 'hewo-1 replies to the user; nothing is posted to the channel.',
    });
    const run = await suite.send(ctx, ['user=sam', 'channel=solo', 'message=Hi'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events)).toEqual([{ from: 'hewo-1', to: 'sam' }]);
    expect(run.stdout.trim()).not.toBe('');
    expect(toAll(run.events)).toEqual([]);
  });

  it('answers a greeting addressed to it with a reply to the user', async (ctx) => {
    suite.begin(ctx, {
      id: 'greeting-addressed',
      title: 'A greeting addressed to hewo-1: "Hi"',
      agents: ['hewo-1'],
      expectation: 'hewo-1 replies to the user; nothing is posted to the channel.',
    });
    const run = await suite.send(ctx, ['user=sam', 'channel=solo', 'to=hewo-1', 'message=Hi'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events)).toEqual([{ from: 'hewo-1', to: 'sam' }]);
    expect(run.stdout.trim()).not.toBe('');
    expect(toAll(run.events)).toEqual([]);
  });

  it('answers a question about itself with a reply to the user', async (ctx) => {
    suite.begin(ctx, {
      id: 'question',
      title: 'A question to everyone: "What can you do?"',
      agents: ['hewo-1'],
      expectation: 'hewo-1 replies to the user; nothing is posted to the channel.',
    });
    const run = await suite.send(ctx, ['user=sam', 'channel=solo', 'message=What can you do?'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events)).toEqual([{ from: 'hewo-1', to: 'sam' }]);
    expect(run.stdout.trim()).not.toBe('');
    expect(toAll(run.events)).toEqual([]);
  });

  it('says other words it is asked to say', async (ctx) => {
    suite.begin(ctx, {
      id: 'other-words',
      title: 'A request to say something else: "Please say: Good morning."',
      agents: ['hewo-1'],
      expectation: 'hewo-1 replies with "Good morning" to the user.',
    });
    const run = await suite.send(ctx, ['user=sam', 'channel=solo', 'message=Please say: Good morning.'], 180_000);
    expect(run.code, run.stderr).toBe(0);
    expect(outputs(run.events)).toEqual([{ from: 'hewo-1', to: 'sam' }]);
    expect(run.stdout).toMatch(/good morning/i);
    expect(toAll(run.events)).toEqual([]);
  });

  it('does not take on work outside its role; it says pass, and the harness tells the user why nobody answered', async (ctx) => {
    suite.begin(ctx, {
      id: 'off-role',
      title: 'Work outside its role: "Please translate this contract into French."',
      agents: ['hewo-1'],
      expectation:
        'hewo-1 says "pass: <reason>"; the harness replies that no agent could answer, with that reason; the command exits 1; nothing is posted to the channel.',
    });
    const run = await suite.send(
      ctx,
      ['user=sam', 'channel=solo', 'message=Please translate this contract into French.'],
      180_000,
    );
    expect(toAll(run.events)).toEqual([]);
    expect(
      run.events.filter((e) => e.type === 'status' && e.from === 'hewo-1' && e.text.startsWith('pass')),
    ).toHaveLength(1);
    expect(outputs(run.events)).toEqual([{ from: 'asha', to: USER }]);
    expect(run.stdout).toMatch(/^No agent could answer this:\n- hewo-1 passed(: .+)?\n$/);
    expect(run.code).toBe(1);
    // The harness's reply is the explanation; exit 1 marks the failure, with no extra ✗ line.
    expect(run.stderr).not.toContain('✗');
  });
});
