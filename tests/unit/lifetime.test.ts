// The daemon's lifetime watch (docs/plans/idle-shutdown.md R1, R3, R6; A1, A3, A6) on a manual schedule and a clock the
// test moves: the model check, the idle stop — one fixture per clause of R3 — and the watched process.

import { describe, expect, it } from 'vitest';

import {
  DaemonLifetime,
  LIFETIME_CHECK_MS,
  PARENT_WATCH_MS,
  processRunning,
  type LifetimeOptions,
  type LifetimeStop,
} from '../../src/daemon/lifetime.js';
import { ManualSchedule, RecordingLogger } from '../helpers/fakes.js';

const MODEL_IDLE_MS = 900_000;

/** A watch over `options`, its clock at 1,000,000, nothing busy, every unload resolving at once. */
function watch(options: Partial<LifetimeOptions> = {}) {
  const schedule = new ManualSchedule();
  const clock = { now: 1_000_000 };
  const state = { busy: false, running: true };
  const unloads: number[] = [];
  const stops: LifetimeStop[] = [];
  const logger = new RecordingLogger();
  let unload: (idleMs: number) => Promise<string[]> = (idleMs) => {
    unloads.push(idleMs);
    return Promise.resolve([]);
  };
  const lifetime = new DaemonLifetime({
    options: { modelIdleMs: MODEL_IDLE_MS, ...options },
    schedule: schedule.schedule,
    now: () => clock.now,
    busy: () => state.busy,
    unloadIdle: (idleMs) => unload(idleMs),
    running: () => state.running,
    requestStop: (stop) => stops.push(stop),
    logger,
  });
  return {
    lifetime,
    schedule,
    clock,
    state,
    unloads,
    stops,
    logger,
    setUnload(f: (idleMs: number) => Promise<string[]>) {
      unload = f;
    },
    /** Moves the clock by `ms`, then runs every check due. */
    tick(ms: number) {
      clock.now += ms;
      schedule.fire();
    },
  };
}

describe('the model check (idle-shutdown R1)', () => {
  it('runs every LIFETIME_CHECK_MS with the model idle bound, from start() on', async () => {
    const w = watch();
    expect(w.schedule.pending()).toEqual([]);
    w.lifetime.start();
    expect(w.schedule.pending()).toEqual([LIFETIME_CHECK_MS]);
    w.tick(LIFETIME_CHECK_MS);
    // The first unload settles before the next check: one still running is never started again.
    await new Promise((resolve) => setImmediate(resolve));
    w.tick(LIFETIME_CHECK_MS);
    expect(w.unloads).toEqual([MODEL_IDLE_MS, MODEL_IDLE_MS]);
    expect(w.schedule.pending()).toEqual([LIFETIME_CHECK_MS]);
  });

  it('checks a bound shorter than LIFETIME_CHECK_MS as often as it is long', () => {
    const w = watch({ modelIdleMs: 5_000 });
    w.lifetime.start();
    expect(w.schedule.pending()).toEqual([5_000]);
  });

  it('starts no second unload while one is still running, and logs one that fails', async () => {
    const w = watch();
    let finish!: (error: Error) => void;
    w.setUnload((idleMs) => {
      w.unloads.push(idleMs);
      return new Promise<string[]>((_resolve, reject) => {
        finish = reject;
      });
    });
    w.lifetime.start();
    w.tick(LIFETIME_CHECK_MS);
    w.tick(LIFETIME_CHECK_MS);
    expect(w.unloads).toEqual([MODEL_IDLE_MS]);
    const failure = new Error('kill EPERM');
    finish(failure);
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.logger.entries).toEqual([
      { level: 'error', event: 'model_server.unload_failed', fields: { idleMs: MODEL_IDLE_MS, error: failure } },
    ]);
    w.tick(LIFETIME_CHECK_MS);
    expect(w.unloads).toEqual([MODEL_IDLE_MS, MODEL_IDLE_MS]);
  });
});

describe('the idle stop (idle-shutdown R3, R4)', () => {
  const IDLE = 120_000;

  it('without an idle bound arms no idle check: a daemon the user started never stops for idleness (R4)', () => {
    const w = watch();
    w.lifetime.start();
    for (let i = 0; i < 100; i += 1) w.tick(LIFETIME_CHECK_MS);
    expect(w.stops).toEqual([]);
    expect(w.schedule.pending()).toEqual([LIFETIME_CHECK_MS]);
  });

  it('with nothing to do, stops at the first check at or past the bound, naming the idle time, and checks no more', () => {
    const w = watch({ idleExitMs: IDLE });
    w.lifetime.start();
    expect(w.schedule.pending()).toEqual([LIFETIME_CHECK_MS, LIFETIME_CHECK_MS]);
    w.tick(LIFETIME_CHECK_MS);
    expect(w.stops).toEqual([]);
    w.tick(LIFETIME_CHECK_MS - 1);
    expect(w.stops).toEqual([]);
    w.tick(1);
    expect(w.stops).toEqual([{ source: 'idle', idleMs: IDLE + 1 - 1 }]);
    // Every check cleared: the stop is under way.
    expect(w.schedule.pending()).toEqual([]);
  });

  it('never stops while a request or stream is open, however long; the bound counts from when it ends', () => {
    const w = watch({ idleExitMs: IDLE });
    w.lifetime.start();
    const end = w.lifetime.begin();
    for (let i = 0; i < 10; i += 1) w.tick(LIFETIME_CHECK_MS);
    expect(w.stops).toEqual([]);
    end();
    end(); // a second end changes nothing
    w.tick(LIFETIME_CHECK_MS);
    w.tick(LIFETIME_CHECK_MS - 1);
    expect(w.stops).toEqual([]);
    w.tick(1);
    expect(w.stops).toEqual([{ source: 'idle', idleMs: IDLE }]);
  });

  it('a request that begins and ends between two checks restarts the clock (a portal polling every second keeps it alive)', () => {
    const w = watch({ idleExitMs: IDLE });
    w.lifetime.start();
    w.tick(LIFETIME_CHECK_MS);
    w.clock.now += LIFETIME_CHECK_MS - 1;
    w.lifetime.begin()();
    w.tick(1);
    expect(w.stops).toEqual([]);
    w.tick(LIFETIME_CHECK_MS);
    expect(w.stops).toEqual([]);
    w.tick(LIFETIME_CHECK_MS);
    expect(w.stops).toEqual([{ source: 'idle', idleMs: 2 * LIFETIME_CHECK_MS + 1 }]);
  });

  it('never stops while the agents have work, and the bound counts from the last check that found them busy', () => {
    const w = watch({ idleExitMs: IDLE });
    w.lifetime.start();
    w.state.busy = true;
    for (let i = 0; i < 10; i += 1) w.tick(LIFETIME_CHECK_MS);
    expect(w.stops).toEqual([]);
    w.state.busy = false;
    w.tick(LIFETIME_CHECK_MS);
    expect(w.stops).toEqual([]);
    w.tick(LIFETIME_CHECK_MS);
    expect(w.stops).toEqual([{ source: 'idle', idleMs: IDLE }]);
  });

  it('checks a bound shorter than LIFETIME_CHECK_MS as often as it is long', () => {
    const w = watch({ idleExitMs: 3_000 });
    w.lifetime.start();
    expect(w.schedule.pending()).toEqual([LIFETIME_CHECK_MS, 3_000]);
    w.tick(3_000);
    expect(w.stops).toEqual([{ source: 'idle', idleMs: 3_000 }]);
  });

  it('end() clears every check, whoever began the stop; start() twice throws', () => {
    const w = watch({ idleExitMs: IDLE, exitWithPid: 4242 });
    w.lifetime.start();
    expect(w.schedule.pending()).toHaveLength(3);
    w.lifetime.end();
    expect(w.schedule.pending()).toEqual([]);
    w.state.running = false;
    w.tick(10 * IDLE);
    expect([w.stops, w.unloads]).toEqual([[], []]);
    expect(() => {
      w.lifetime.start();
    }).toThrow('the daemon lifetime was started twice');
  });
});

describe('the watched process (idle-shutdown R6)', () => {
  it('stops with source parent_exited at the first check after the process has ended, and checks no more', () => {
    const w = watch({ exitWithPid: 4242 });
    w.lifetime.start();
    expect(w.schedule.pending()).toEqual([LIFETIME_CHECK_MS, PARENT_WATCH_MS]);
    w.tick(PARENT_WATCH_MS);
    expect(w.stops).toEqual([]);
    w.state.running = false;
    w.tick(PARENT_WATCH_MS);
    expect(w.stops).toEqual([{ source: 'parent_exited', pid: 4242 }]);
    expect(w.schedule.pending()).toEqual([]);
  });

  it('processRunning: true for a live process of this user, false for no process (ESRCH)', async () => {
    expect(processRunning(process.pid)).toBe(true);
    const { spawn } = await import('node:child_process');
    const child = spawn('true');
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.once('exit', resolve));
    expect(processRunning(pid)).toBe(false);
  });

  it("processRunning: false for a pid that is another user's (EPERM) — launchd's, pid 1", () => {
    expect(processRunning(1)).toBe(false);
  });
});
