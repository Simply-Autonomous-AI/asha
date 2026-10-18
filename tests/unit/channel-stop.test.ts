// One channel's stop (docs/plans/portal-demo-stop.md R2, R3): AgentSupervisor.stopChannel on the persistence harness —
// a real supervisor, FakeRuntime containers that connect and announce themselves, the real channel file spaces over
// the fake runtime, and FakeModelServer. Every case launches onto two channels and checks the other is left alone.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelStopFailed } from '../../src/daemon/agents/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { FIXTURE_RECIPE } from '../helpers/daemon-fakes.js';
import { harness, persistenceRoot } from '../helpers/persistence.js';

/** A restartable recipe (patterns-phase-3 R12): one restart within a minute. */
const PHOENIX = { ...FIXTURE_RECIPE, id: 'phoenix', restart: { max: 3, withinMs: 60_000 } };

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentSupervisor.stopChannel', () => {
  it('stops every agent on the channel and none on another, tells each handle as it goes, logs agent.channel_stopped, and leaves the other channel answering', async () => {
    const h = await harness({ base: 'greeter' });
    const demo = await h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    const other = await h.supervisor.launchNew('greeter', h.channels.get('other'), h.sink);
    const told: string[] = [];

    const handles = await h.supervisor.stopChannel('p05-1', 'portal', (handle) => told.push(handle));

    expect(handles).toEqual([demo.handle]);
    expect(told).toEqual([demo.handle]);
    expect(h.runtime.stopRecords.map((r) => [r.name, r.mode, r.graceS])).toEqual([[demo.container, 'drain', 70]]);
    expect(h.supervisor.hasAgentsOn('p05-1')).toBe(false);
    expect(h.supervisor.hasAgentsOn('other')).toBe(true);
    expect(h.supervisor.list().map((a) => [a.channel, a.handle])).toEqual([['other', other.handle]]);
    const logged = h.logger.entries.filter((e) => e.event === 'agent.channel_stopped');
    expect(logged).toHaveLength(1);
    expect(present(logged[0], 'logged[0]').fields).toMatchObject({
      channel: 'p05-1',
      handles: [demo.handle],
      source: 'portal',
    });
    expect(h.logger.events('error')).toEqual([]);
  });

  it("removes the channel's file space and keeps another channel's", async () => {
    const h = await harness({ base: 'greeter' });
    await h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    await h.supervisor.launchNew('greeter', h.channels.get('other'), h.sink);
    expect([h.files.exists('p05-1'), h.files.exists('other')]).toEqual([true, true]);

    await h.supervisor.stopChannel('p05-1', 'cli', () => undefined);

    expect([h.files.exists('p05-1'), h.files.exists('other')]).toEqual([false, true]);
    expect(h.runtime.calls.filter((c) => c.startsWith('removeContainer') || c.startsWith('removeVolume'))).toEqual([
      'removeContainer asha-abcd1234-0123abcd-p05-1-files',
      'removeVolume asha-abcd1234-0123abcd-p05-1',
    ]);
    expect(h.logger.events()).toContain('files.space_removed');
  });

  it('counts the models every agent needs, by channel: one stopped channel frees only what no other agent uses', async () => {
    const h = await harness({ base: 'greeter' });
    await h.supervisor.launchNew('greeter', h.channels.get('a'), h.sink);
    await h.supervisor.launchNew('rememberer', h.channels.get('b'), h.sink);
    expect([...h.supervisor.modelsInUse()].sort(byCodeUnit)).toEqual(['tiny-embed', 'tiny-model']);

    await h.supervisor.stopChannel('b', 'cli', () => undefined);
    expect([...h.supervisor.modelsInUse()]).toEqual(['tiny-model']);
    await h.supervisor.stopChannel('a', 'cli', () => undefined);
    expect([...h.supervisor.modelsInUse()]).toEqual([]);
  });

  it('counts a launch in progress as needing its models before it has a record, and as on its channel', async () => {
    const h = await harness({ base: 'greeter' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.runtime.onEnsureReady = () => held;

    const launching = h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    await vi.waitFor(() => {
      expect(h.supervisor.hasAgentsOn('p05-1')).toBe(true);
    });
    expect([...h.supervisor.modelsInUse()]).toEqual(['tiny-model']);
    release();
    await launching;
  });

  it('refuses a launch onto the channel while it stops, and lets one in once it has stopped', async () => {
    const h = await harness({ base: 'greeter' });
    await h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    let exit!: () => void;
    h.runtime.onStop = (name) =>
      new Promise<void>((resolve) => {
        exit = () => {
          h.runtime.exit(name, 143);
          resolve();
        };
      });

    const stopping = h.supervisor.stopChannel('p05-1', 'portal', () => undefined);
    await vi.waitFor(() => {
      expect(h.runtime.stops).toHaveLength(1);
    });
    await expect(h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink)).rejects.toThrow(
      'did not come online: channel p05-1 is stopping',
    );
    exit();
    await stopping;

    h.runtime.onStop = (name) => {
      h.runtime.exit(name, 143);
      return Promise.resolve();
    };
    await expect(h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink)).resolves.toMatchObject({
      channel: 'p05-1',
    });
  });

  it('joins a second stop of the same channel to the first, telling it the handles already stopped and then the rest', async () => {
    const h = await harness({ base: 'greeter' });
    const quick = await h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    const slow = await h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    let exitSlow!: () => void;
    h.runtime.onStop = async (name) => {
      if (name === slow.container) await new Promise<void>((resolve) => (exitSlow = resolve));
      h.runtime.exit(name, 143);
    };
    const toldFirst: string[] = [];
    const toldSecond: string[] = [];

    const first = h.supervisor.stopChannel('p05-1', 'portal', (handle) => toldFirst.push(handle));
    await vi.waitFor(() => {
      expect(toldFirst).toEqual([quick.handle]);
    });
    const second = h.supervisor.stopChannel('p05-1', 'cli', (handle) => toldSecond.push(handle));
    expect(toldSecond).toEqual([quick.handle]);
    exitSlow();

    await expect(first).resolves.toEqual([quick.handle, slow.handle]);
    await expect(second).resolves.toEqual([quick.handle, slow.handle]);
    expect(toldFirst).toEqual([quick.handle, slow.handle]);
    expect(toldSecond).toEqual([quick.handle, slow.handle]);
    expect(h.runtime.stops).toEqual([quick.container, slow.container]);
    expect(h.logger.events().filter((e) => e === 'agent.channel_stopped')).toHaveLength(1);
  });

  it('waits for a launch in progress on the channel, refuses its record, and leaves no agent, container or space behind', async () => {
    const h = await harness({ base: 'greeter' });
    const online = await h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    let release!: () => void;
    h.runtime.onEnsureReady = () => new Promise<void>((resolve) => (release = resolve));
    const launching = h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    const refused = expect(launching).rejects.toThrow('channel p05-1 is stopping');
    await vi.waitFor(() => {
      expect(h.runtime.calls.filter((c) => c.startsWith('ensureReady'))).toHaveLength(2);
    });
    let done = false;

    const stopping = h.supervisor.stopChannel('p05-1', 'portal', () => undefined);
    void stopping.then(() => (done = true));
    await vi.waitFor(() => {
      expect(h.runtime.stops).toEqual([online.container]);
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    release();

    await refused;
    await expect(stopping).resolves.toEqual([online.handle]);
    expect(h.supervisor.hasAgentsOn('p05-1')).toBe(false);
    expect(h.files.exists('p05-1')).toBe(false);
    expect(h.runtime.starts.map((s) => s.name)).toEqual([online.container]);
  });

  it('refuses once the daemon is stopping: its stop stops every channel', async () => {
    const h = await harness({ base: 'greeter' });
    await h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    await h.supervisor.stopAll('daemon stopping');

    await expect(h.supervisor.stopChannel('p05-1', 'portal', () => undefined)).rejects.toThrow(ChannelStopFailed);
  });

  it('ends a restart in progress on the channel: its start is refused, the stop waits for it, and nothing is brought back', async () => {
    const root = await persistenceRoot({ 'recipes/phoenix.json': JSON.stringify(PHOENIX) });
    const h = await harness({ root, base: 'phoenix' });
    const agent = await h.supervisor.launchNew('phoenix', h.channels.get('p05-1'), h.sink);
    let release!: () => void;
    h.runtime.onEnsureReady = () => new Promise<void>((resolve) => (release = resolve));
    // It crashes on its own: its restart begins, and is held in its start.
    h.runtime.exit(agent.container, 1);
    await vi.waitFor(() => {
      expect(h.runtime.calls.filter((c) => c.startsWith('ensureReady'))).toHaveLength(2);
    });
    expect(h.supervisor.hasAgentsOn('p05-1')).toBe(true);

    const stopping = h.supervisor.stopChannel('p05-1', 'portal', () => undefined);
    release();
    await expect(stopping).resolves.toEqual([]);

    expect(h.logger.events()).toContain('agent.restarting');
    expect(h.logger.events()).not.toContain('agent.restarted');
    expect(h.runtime.starts.map((s) => s.name)).toEqual([agent.container]);
    expect(h.supervisor.hasAgentsOn('p05-1')).toBe(false);
  });

  it('checkpoints a persisted agent before its container is drained', async () => {
    const h = await harness({ base: 'keep' });
    await h.supervisor.launchNew('keeper', h.channels.get('p05-1'), h.sink);

    await h.supervisor.stopChannel('p05-1', 'portal', () => undefined);

    const events = h.logger.events();
    expect(events).toContain('state.promoted');
    expect(events.indexOf('state.promoted')).toBeLessThan(events.indexOf('agent.channel_stopped'));
    expect(h.runtime.stopRecords.map((r) => r.mode)).toEqual(['drain']);
  });

  it("fails naming an agent whose exit is never seen, abandons its calls, and leaves the channel's space for the reclaim", async () => {
    const h = await harness({ base: 'greeter' });
    const demo = await h.supervisor.launchNew('greeter', h.channels.get('p05-1'), h.sink);
    // The stop is sent, but the container never exits.
    h.runtime.onStop = () => Promise.resolve(undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const stopping = h.supervisor.stopChannel('p05-1', 'portal', () => undefined);
    const outcome = expect(stopping).rejects.toThrow(
      `the stop of channel p05-1 failed: ${demo.handle} still running after the stop`,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;

    expect(h.logger.events('error')).toEqual(
      expect.arrayContaining(['agent.stop_failed', 'agent.channel_stop_failed']),
    );
    expect(h.files.exists('p05-1')).toBe(true);
  });
});
