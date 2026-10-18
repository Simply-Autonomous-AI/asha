// Each online agent's telemetry for the portal (docs/plans/portal.md R10; A11): counted from the daemon's own spans as
// the trace file writes them — through the real tracer, writer and tap, the file system injected — never an agent's,
// never a dropped record; dropped when the agent leaves; sorted by handle; no file read.

import { describe, expect, it } from 'vitest';

import { Telemetry, recordAndCount } from '../../src/daemon/telemetry/index.js';
import { DaemonTracer, TraceFileWriter, type TraceFiles } from '../../src/daemon/traces/index.js';
import { present } from '../../src/shared/assert-present.js';
import type { WatchEvent } from '../../src/shared/protocol.js';
import { RecordingLogger } from '../helpers/fakes.js';

/** A file system that records each call; `full` makes the next appends fail as a full disk does. */
function files() {
  const calls: string[] = [];
  const state = { full: false };
  const fs: TraceFiles = {
    append: (file) => {
      calls.push(`append ${present(file.split('/').at(-1), "file.split('/').at(-1)")}`);
      if (state.full) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
    size: (file) => {
      calls.push(`size ${present(file.split('/').at(-1), "file.split('/').at(-1)")}`);
      return 0;
    },
    list: () => {
      calls.push('list');
      return [];
    },
    remove: (file) => {
      calls.push(`remove ${file}`);
    },
  };
  return { fs, calls, state };
}

function setup() {
  const clock = { now: Date.parse('2026-10-02T12:00:00.000Z') };
  const { fs, calls, state } = files();
  const logger = new RecordingLogger();
  const writer = new TraceFileWriter({
    dir: '/logs',
    clock: () => new Date(clock.now),
    logger,
    files: fs,
    capBytes: 1_000_000,
    daemonReserveBytes: 100_000,
    agentDailyBytes: 100_000,
  });
  writer.start();
  const members = new Map<string, Set<string>>();
  const watchers = new Map<string, (event: WatchEvent) => void>();
  const telemetry = new Telemetry({
    isMember: (channel, handle) => members.get(channel)?.has(handle) === true,
    watchChannel: (channel, watcher) => {
      if (watchers.has(channel)) throw new Error(`watched ${channel} twice`);
      watchers.set(channel, watcher);
    },
  });
  let n = 0;
  const tracer = new DaemonTracer({
    clock: () => new Date(clock.now),
    newSpanId: () => (++n).toString(16).padStart(16, '0'),
    record: recordAndCount(writer, telemetry),
  });
  const join = (channel: string, handle: string) => {
    if (!members.has(channel)) members.set(channel, new Set());
    present(members.get(channel), 'members.get(channel)').add(handle);
  };
  const leave = (channel: string, handle: string) => {
    present(members.get(channel), 'members.get(channel)').delete(handle);
    watchers.get(channel)?.({ type: 'agent_left', agent: handle, detail: 'stopped' });
  };
  /** A daemon span of `ms`, ended as `outcome`. */
  const span = (
    name: 'asha.delivery' | 'asha.chat' | 'asha.embed' | 'asha.call',
    handle: string,
    ms: number,
    outcome: { status: 'ok' } | { status: 'error'; reason: 'timeout' | 'agent_left' } = { status: 'ok' },
    channel = 'lab',
  ) => {
    const open = tracer.start({ name, traceId: 'a'.repeat(32), parentSpanId: 'b'.repeat(16), channel, handle });
    clock.now += ms;
    open.end(outcome);
  };
  const agents = (...handles: string[]) =>
    handles.map((handle) => ({ handle, recipe: 'hello-world', team: null, model: 'tiny-model' }));
  return { telemetry, writer, calls, state, join, leave, span, agents, clock };
}

describe('telemetry per agent (R10, A11)', () => {
  it("counts each agent's deliveries and model calls, and its last model call's duration, from the daemon's spans", () => {
    const t = setup();
    t.join('lab', 'hewo-1');
    t.span('asha.delivery', 'hewo-1', 900);
    t.span('asha.chat', 'hewo-1', 412);
    t.span('asha.embed', 'hewo-1', 35);
    t.span('asha.call', 'hewo-1', 10);
    expect(
      t.telemetry.answer('lab', t.agents('hewo-1'), [
        { channel: 'lab', handle: 'hewo-1' },
        { channel: 'other', handle: 'hewo-1' },
      ]),
    ).toEqual({
      channel: 'lab',
      agents: [
        {
          handle: 'hewo-1',
          recipe: 'hello-world',
          team: null,
          model: 'tiny-model',
          deliveries: 1,
          modelCalls: 2,
          lastModelCallMs: 35,
          modelCallsInFlight: 1,
          lastError: null,
        },
      ],
    });
  });

  it("carries each agent's team, or null for a recipe launched alone (portal-scene-chat R7, A7)", () => {
    const t = setup();
    t.join('lab', 'lead-1');
    t.join('lab', 'hewo-1');
    const online = [
      { handle: 'lead-1', recipe: 'lead', team: 'crew', model: 'tiny-model' },
      { handle: 'hewo-1', recipe: 'hello-world', team: null, model: 'tiny-model' },
    ];
    expect(t.telemetry.answer('lab', online, []).agents.map((a) => [a.handle, a.recipe, a.team])).toEqual([
      ['hewo-1', 'hello-world', null],
      ['lead-1', 'lead', 'crew'],
    ]);
  });

  it('a dropped write is not counted', () => {
    const t = setup();
    t.join('lab', 'hewo-1');
    t.span('asha.chat', 'hewo-1', 100);
    t.state.full = true;
    t.span('asha.chat', 'hewo-1', 200);
    t.span('asha.delivery', 'hewo-1', 300);
    expect(t.telemetry.answer('lab', t.agents('hewo-1'), []).agents[0]).toMatchObject({
      deliveries: 0,
      modelCalls: 1,
      lastModelCallMs: 100,
    });
  });

  it("counts no agent's own spans: only the daemon's are recorded through the tap", () => {
    const t = setup();
    t.join('lab', 'hewo-1');
    // An agent's spans reach the writer through the traces route, never the daemon tracer's tap.
    t.writer.write(
      [
        {
          traceId: 'a'.repeat(32),
          spanId: 'c'.repeat(16),
          parentSpanId: null,
          name: 'chat',
          kind: 'model_call',
          channel: 'lab',
          handle: 'hewo-1',
          start: '2026-10-02T12:00:00.000Z',
          end: '2026-10-02T12:00:01.000Z',
          status: 'ok',
          reason: null,
        },
      ],
      { agent: 'lab/hewo-1' },
    );
    // And the module itself ignores one handed to it.
    t.telemetry.record({
      traceId: 'a'.repeat(32),
      spanId: 'd'.repeat(16),
      parentSpanId: null,
      name: 'delivery',
      kind: 'delivery',
      channel: 'lab',
      handle: 'hewo-1',
      start: '2026-10-02T12:00:00.000Z',
      end: '2026-10-02T12:00:01.000Z',
      status: 'ok',
      reason: null,
    });
    expect(t.telemetry.answer('lab', t.agents('hewo-1'), []).agents[0]).toMatchObject({ deliveries: 0, modelCalls: 0 });
    expect(t.telemetry.size()).toBe(0);
  });

  it('keeps the most recent error span, its reason and when it ended', () => {
    const t = setup();
    t.join('lab', 'hewo-1');
    t.span('asha.chat', 'hewo-1', 100, { status: 'error', reason: 'timeout' });
    t.span('asha.delivery', 'hewo-1', 50);
    expect(present(t.telemetry.answer('lab', t.agents('hewo-1'), []).agents[0], 'agents[0]').lastError).toEqual({
      span: 'asha.chat',
      reason: 'timeout',
      at: '2026-10-02T12:00:00.100Z',
    });
  });

  it('drops an agent that leaves, and counts a later one of the channel afresh', () => {
    const t = setup();
    t.join('lab', 'hewo-1');
    t.join('lab', 'hewo-2');
    t.span('asha.delivery', 'hewo-1', 1);
    t.span('asha.delivery', 'hewo-2', 1);
    expect(t.telemetry.size()).toBe(2);
    t.leave('lab', 'hewo-1');
    expect(t.telemetry.size()).toBe(1);
    // A span ended for an agent no longer online (its pending delivery, as it left) is not counted.
    t.span('asha.delivery', 'hewo-1', 1);
    expect(t.telemetry.size()).toBe(1);
    expect(t.telemetry.answer('lab', t.agents('hewo-2'), []).agents.map((a) => [a.handle, a.deliveries])).toEqual([
      ['hewo-2', 1],
    ]);
  });

  it('sorts the entries by handle, three agents joining in reverse order, and reads no file', () => {
    const t = setup();
    for (const h of ['hewo-3', 'hewo-2', 'hewo-1']) {
      t.join('lab', h);
      t.span('asha.delivery', h, 1);
    }
    expect(t.telemetry.answer('lab', t.agents('hewo-3', 'hewo-2', 'hewo-1'), []).agents.map((a) => a.handle)).toEqual([
      'hewo-1',
      'hewo-2',
      'hewo-3',
    ]);
    // The writer's own calls only: its start's listing, a size, the appends. Nothing reads a file back.
    expect(new Set(t.calls.map((c) => c.split(' ')[0]))).toEqual(new Set(['list', 'size', 'append']));
  });
});
