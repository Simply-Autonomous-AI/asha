// `POST /v1/channel/stop` on the real server (docs/plans/portal-demo-stop.md R1, R6): its refusals, and its stream of
// ChannelStopEvent, with a stand-in for the supervisor's channel stop and for the idle model servers' stop.

import { afterEach, describe, expect, it } from 'vitest';

import { ChannelStopFailed, type AgentSupervisor } from '../../src/daemon/agents/index.js';
import { present } from '../../src/shared/assert-present.js';
import { Routes, type ChannelStopEvent } from '../../src/shared/protocol.js';
import { serverHarness, type ServerHarness } from '../helpers/server-harness.js';

let h: ServerHarness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** The `data:` of each SSE event in a body, in order. */
function eventsOf(text: string): ChannelStopEvent[] {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice('data: '.length)) as ChannelStopEvent);
}

/** A supervisor stand-in with two agents on `p05-1`, recording each stopChannel call. */
function supervisor(
  stop: AgentSupervisor['stopChannel'] = (_name, _source, stopped) => {
    stopped('lead-1');
    stopped('worker-a-1');
    return Promise.resolve(['lead-1', 'worker-a-1']);
  },
) {
  const calls: [string, string][] = [];
  const stand: Partial<AgentSupervisor> = {
    hasAgentsOn: (channel: string) => channel === 'p05-1',
    agentsOn: (channel: string) => (channel === 'p05-1' ? ['lead-1', 'worker-a-1'] : []),
    stopChannel: (name, source, stopped) => {
      calls.push([name, source]);
      return stop(name, source, stopped);
    },
  };
  return { stand, calls };
}

const post = (body: unknown) =>
  present(h, 'h').request(Routes.channelStop, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /v1/channel/stop', () => {
  it('streams stopping, each agent stopped, each idle model server stopped, then stopped', async () => {
    const { stand, calls } = supervisor();
    h = await serverHarness(stand, { stopIdleModels: () => Promise.resolve(['tiny-model']) });

    const response = await post({ channel: 'p05-1', source: 'portal' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(eventsOf(await response.text())).toEqual([
      { type: 'stopping', channel: 'p05-1', handles: ['lead-1', 'worker-a-1'] },
      { type: 'agent_stopped', handle: 'lead-1' },
      { type: 'agent_stopped', handle: 'worker-a-1' },
      { type: 'model_server_stopped', model: 'tiny-model' },
      { type: 'stopped', channel: 'p05-1', handles: ['lead-1', 'worker-a-1'], modelServers: ['tiny-model'] },
    ]);
    expect(calls).toEqual([['p05-1', 'portal']]);
  });

  it('answers 404 unknown_channel for a channel with no agent, stopping nothing', async () => {
    const { stand, calls } = supervisor();
    h = await serverHarness(stand, { stopIdleModels: () => Promise.resolve([]) });

    const response = await post({ channel: 'quiet', source: 'cli' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no agent is on channel "quiet"', reason: 'unknown_channel' });
    expect(calls).toEqual([]);
  });

  it.each([
    [{ source: 'portal' }, /channel/],
    [{ channel: 'Not A Name', source: 'portal' }, /channel must be a channel name/],
    [{ channel: 'p05-1' }, /source must be portal or cli/],
    [{ channel: 'p05-1', source: 'web' }, /source must be portal or cli/],
    [{ channel: 'p05-1', source: 'cli', extra: 1 }, /extra/],
  ])('refuses %j with 400, stopping nothing', async (body, error) => {
    const { stand, calls } = supervisor();
    h = await serverHarness(stand, { stopIdleModels: () => Promise.resolve([]) });

    const response = await post(body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(error);
    expect(calls).toEqual([]);
  });

  it('refuses a request without the credential with 401, stopping nothing', async () => {
    const { stand, calls } = supervisor();
    h = await serverHarness(stand, { stopIdleModels: () => Promise.resolve([]) });

    const response = await fetch(`${h.base}${Routes.channelStop}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'p05-1', source: 'cli' }),
    });

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers 503 stopping while the daemon stops', async () => {
    const { stand, calls } = supervisor();
    h = await serverHarness(stand, { stopIdleModels: () => Promise.resolve([]), stopping: () => true });

    const response = await post({ channel: 'p05-1', source: 'cli' });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'the daemon is stopping', reason: 'stopping' });
    expect(calls).toEqual([]);
  });

  it("ends with one error event when the channel's stop fails, and stops no model server", async () => {
    let idleStops = 0;
    const { stand } = supervisor(() =>
      Promise.reject(new ChannelStopFailed('p05-1', 'lead-1 still running after the stop')),
    );
    h = await serverHarness(stand, {
      stopIdleModels: () => {
        idleStops += 1;
        return Promise.resolve([]);
      },
    });

    const events = eventsOf(await (await post({ channel: 'p05-1', source: 'portal' })).text());

    expect(events).toEqual([
      { type: 'stopping', channel: 'p05-1', handles: ['lead-1', 'worker-a-1'] },
      {
        type: 'error',
        reason: 'channel_stop_failed',
        detail: 'the stop of channel p05-1 failed: lead-1 still running after the stop',
      },
    ]);
    expect(idleStops).toBe(0);
  });

  it("ends with one error event, logged, when the idle model servers' stop fails after the agents stopped", async () => {
    const { stand } = supervisor();
    h = await serverHarness(stand, {
      stopIdleModels: () => Promise.reject(new Error('llama-server would not stop')),
    });

    const events = eventsOf(await (await post({ channel: 'p05-1', source: 'cli' })).text());

    expect(events.map((e) => e.type)).toEqual(['stopping', 'agent_stopped', 'agent_stopped', 'error']);
    expect(events.at(-1)).toEqual({
      type: 'error',
      reason: 'channel_stop_failed',
      detail: "its agents stopped, but the idle model servers' stop failed: llama-server would not stop",
    });
    expect(h.logger.entries.filter((e) => e.event === 'model_server.stop_idle_failed').map((e) => e.level)).toEqual([
      'error',
    ]);
  });
});
