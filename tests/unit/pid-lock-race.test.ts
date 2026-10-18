// Two and three takers clearing one stale lock at once (docs/plans/debt-paydown.md R19, A16; debt D29): an in-memory
// filesystem whose every operation waits for a scheduler, which interleaves the takers at every step — one preempted
// after each of its steps while another runs to its end, and with three, a second preempted at each step too — and in
// seeded random orders. Each schedule must end with exactly one taker holding the lock, its pid in the file, and every
// other refused.

import { beforeAll, describe, expect, it } from 'vitest';

import { LockHeld, acquirePidLock, type PidLockFs } from '../../src/daemon/process/pid-lock.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { RecordingLogger } from '../helpers/fakes.js';

const FILE = '/locks/daemon.lock';
/** The pid that left the stale lock, and one that left a stale clear-sentinel (died inside it). */
const DEAD = 999;
const DEAD_CLEARER = 998;

/** Files as the takers see them: a hard link copies a name to the same content, which no taker changes after writing. */
class World {
  readonly files = new Map<string, string>();
  time = 0;
  private readonly waiting = new Map<string, () => void>();

  fs(who: string): PidLockFs {
    const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    const eexist = (path: string) => Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
    return {
      writeNew: async (path, content) => {
        await this.step(who);
        if (this.files.has(path)) throw eexist(path);
        this.files.set(path, content);
      },
      link: async (existing, path) => {
        await this.step(who);
        if (!this.files.has(existing)) throw enoent(existing);
        if (this.files.has(path)) throw eexist(path);
        this.files.set(path, present(this.files.get(existing), `file at ${existing}`));
      },
      read: async (path) => {
        await this.step(who);
        if (!this.files.has(path)) throw enoent(path);
        return present(this.files.get(path), `file at ${path}`);
      },
      unlink: async (path) => {
        await this.step(who);
        if (!this.files.delete(path)) throw enoent(path);
      },
      rename: async (from, to) => {
        await this.step(who);
        if (!this.files.has(from)) throw enoent(from);
        this.files.set(to, present(this.files.get(from), `file at ${from}`));
        this.files.delete(from);
      },
      sleep: async (ms) => {
        await this.step(who);
        this.time += ms;
      },
      now: () => this.time,
    };
  }

  /** Every operation waits here until the scheduler lets this taker go one step. */
  private step(who: string): Promise<void> {
    return new Promise((resolve) => this.waiting.set(who, resolve));
  }

  isWaiting(who: string): boolean {
    return this.waiting.has(who);
  }

  go(who: string): void {
    const resolve = present(this.waiting.get(who), `a pending wait for ${who}`);
    this.waiting.delete(who);
    resolve();
  }
}

/** Lets every taker run until it waits at its next step or has finished. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Runs `count` takers (pids 101, 102, …) against `initial`, letting `choose` pick, at each point, which waiting taker
 * goes one step. Returns each taker's outcome and the lock file's content at the end.
 */
async function race(
  initial: Readonly<Record<string, string>>,
  count: number,
  choose: (waiting: readonly string[], step: number) => string,
) {
  const world = new World();
  for (const [path, content] of Object.entries(initial)) world.files.set(path, content);
  const pids = Array.from({ length: count }, (_, i) => 101 + i);
  const finished = new Set<string>();
  // Each pid's outcome: 'holds', 'refused' or `failed: ${message}`.
  const outcomes: Record<string, string> = {};
  const alive = (pid: number) => pids.includes(pid);
  const takers = pids.map((pid) =>
    acquirePidLock({ file: FILE, pid, isAlive: alive, logger: new RecordingLogger(), fs: world.fs(String(pid)) })
      .then(
        () => {
          outcomes[pid] = 'holds';
        },
        (error: unknown) => {
          outcomes[pid] = error instanceof LockHeld ? 'refused' : `failed: ${(error as Error).message}`;
        },
      )
      .finally(() => finished.add(String(pid))),
  );
  let step = 0;
  for (;;) {
    if (finished.size >= count) break;
    await settle();
    const waiting = pids.map(String).filter((who) => !finished.has(who) && world.isWaiting(who));
    if (waiting.length === 0) {
      step += 1;
      continue;
    }
    if (step > 20_000) throw new Error('a schedule ran past 20,000 steps');
    world.go(choose(waiting, step));
    step += 1;
  }
  await Promise.all(takers);
  return {
    outcomes,
    lock: world.files.get(FILE),
    leftover: [...world.files.keys()].filter((f) => f !== FILE).sort(byCodeUnit),
  };
}

/** A schedule: run `order[0]` for `steps[0]` steps (or to its end when undefined), then `order[1]`, …, then any. */
function plan(order: readonly string[], steps: readonly (number | undefined)[]) {
  let current = 0;
  let taken = 0;
  return (waiting: readonly string[]) => {
    while (current < order.length) {
      const who = present(order[current], `order entry ${String(current)}`);
      const limit = steps[current];
      if (waiting.includes(who) && (limit === undefined || taken < limit)) {
        taken += 1;
        return who;
      }
      if (!waiting.includes(who) || (limit !== undefined && taken >= limit)) {
        current += 1;
        taken = 0;
      }
    }
    return present(waiting[0], 'the first waiting taker');
  };
}

/** A seeded generator (mulberry32): the same orders on every run. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Exactly one taker holds the lock, its pid is in the file, and no file of theirs is left. Every other was refused, or —
 * when a schedule starved it while another, preempted, held the clear-sentinel past the 2,000 ms wait — failed saying so.
 */
function expectOneHolder(result: Awaited<ReturnType<typeof race>>, schedule: string): void {
  const holders = Object.entries(result.outcomes)
    .filter(([, o]) => o === 'holds')
    .map(([pid]) => pid);
  const starved = /^failed: \/locks\/daemon\.lock\.clear has been held by live process \d+ for 2000 ms$/;
  expect(
    {
      holders: holders.length,
      lock: result.lock === holders[0],
      others: Object.values(result.outcomes).filter((o) => o !== 'holds' && o !== 'refused' && !starved.test(o)),
      leftover: result.leftover,
    },
    schedule,
  ).toEqual({
    holders: 1,
    lock: true,
    others: [],
    leftover: [],
  });
}

/** How many steps a taker takes alone, through clearing a stale lock (counted below): each is a preemption point. */
let soloSteps = 0;
/** Preemption points past a taker's own steps (it may take more when it meets another): enough for a wait and a pass. */
const EXTRA_STEPS = 6;

const SCENARIOS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['a stale lock', { [FILE]: String(DEAD) }],
  ['a stale lock and a stale clear-sentinel', { [FILE]: String(DEAD), [`${FILE}.clear`]: String(DEAD_CLEARER) }],
];

describe('acquirePidLock under racing clearers (debt-paydown R19, A16; D29)', () => {
  let alone: Awaited<ReturnType<typeof race>>;
  beforeAll(async () => {
    let steps = 0;
    alone = await race({ [FILE]: String(DEAD) }, 1, (waiting) => {
      steps += 1;
      return present(waiting[0], 'the first waiting taker');
    });
    soloSteps = steps;
  });

  it('counts the steps one taker takes alone through clearing a stale lock: the preemption points', () => {
    expect(alone.outcomes).toEqual({ 101: 'holds' });
    expect(soloSteps).toBeGreaterThanOrEqual(8);
  });

  for (const [name, initial] of SCENARIOS) {
    it(`two clearers of ${name}: either one preempted after each of its steps while the other runs to its end`, async () => {
      for (const [first, second] of [
        ['101', '102'],
        ['102', '101'],
      ] as const) {
        for (let k = 0; k <= soloSteps + EXTRA_STEPS; k += 1) {
          expectOneHolder(
            await race(initial, 2, plan([first, second, first], [k, undefined, undefined])),
            `${name}: ${first} for ${String(k)} steps, ${second} to its end, then ${first}`,
          );
        }
      }
    });
  }

  it('three clearers of a stale lock: one preempted after each of its steps, a second after each of its, the third to its end, in every order', async () => {
    const orders = [
      ['101', '102', '103'],
      ['101', '103', '102'],
      ['102', '101', '103'],
      ['102', '103', '101'],
      ['103', '101', '102'],
      ['103', '102', '101'],
    ] as const;
    const scenario = present(SCENARIOS[0], 'scenario 0')[1];
    for (const [a, b, c] of orders) {
      for (let k = 0; k <= soloSteps + EXTRA_STEPS; k += 1) {
        for (let j = 0; j <= soloSteps + EXTRA_STEPS; j += 1) {
          for (const resume of [
            [a, b],
            [b, a],
          ] as const) {
            expectOneHolder(
              await race(scenario, 3, plan([a, b, c, ...resume], [k, j, undefined, undefined, undefined])),
              `${a} ${String(k)} steps, ${b} ${String(j)}, ${c} to its end, then ${resume.join(', ')}`,
            );
          }
        }
      }
    }
    // Its own bound: every pair of preemption points in six orders, two resumptions each — about 6 s alone (2026-10-03).
  }, 60_000);

  it('two and three clearers, in 300 seeded random orders each', async () => {
    const random = seeded(29);
    for (const [name, initial] of SCENARIOS) {
      for (const count of name === present(SCENARIOS[1], 'scenario 1')[0] ? [2] : [2, 3]) {
        for (let run = 0; run < 300; run += 1) {
          const picks: string[] = [];
          const result = await race(initial, count, (waiting) => {
            const who = present(waiting[Math.floor(random() * waiting.length)], 'the chosen taker');
            picks.push(who);
            return who;
          });
          expectOneHolder(result, `${name}, ${String(count)} clearers, order ${picks.join(' ')}`);
        }
      }
    }
  });

  // D29's residual, narrowed and still open (docs/plans/debt.md#d29): a clearer that died inside the sentinel, then
  // three clearers, two of which remove its sentinel at once. This test records one seeded order where two take the
  // lock, so the residual is reproducible; when D29 is paid it fails, and is replaced by the one-holder assertion.
  it("D29's residual, recorded until paid: with a dead clear-sentinel and three clearers, two hold the lock in one of 3,000 seeded orders", async () => {
    const random = seeded(7);
    let twoHolders = 0;
    for (let run = 0; run < 3_000 && twoHolders === 0; run += 1) {
      const result = await race(present(SCENARIOS[1], 'scenario 1')[1], 3, (waiting) =>
        present(waiting[Math.floor(random() * waiting.length)], 'the chosen taker'),
      );
      if (Object.values(result.outcomes).filter((o) => o === 'holds').length === 2) twoHolders += 1;
    }
    expect(twoHolders).toBe(1);
  }, 60_000);
});
