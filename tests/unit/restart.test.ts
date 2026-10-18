// A crash reported as a crash, and the supervisor's restart (docs/plans/patterns-phase-3.md R10–R14; A8, A9), with
// FakeRuntime and a fake clock: an agent whose recipe names `restart` that exits on its own while online is restarted
// under its handle, its held deliveries re-sent carrying `restarted`, at most `max` times in `withinMs` and each
// delivery at most `max` times, then `agent.restart_limit` and its conversations ended `restart_limit`; a stream that
// closes with no stop begun waits RESTART_EXIT_WAIT_MS for the exit before anything is stopped (D56).

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSupervisor, TeamLaunchFailed } from '../../src/daemon/agents/index.js';
import { Channels } from '../../src/daemon/channel/index.js';
import { ChannelFileSpaces } from '../../src/daemon/files/index.js';
import { DefinitionError, Definitions, parseRecipe } from '../../src/daemon/definitions/index.js';
import { StateStore, nodeStateFs } from '../../src/daemon/state/index.js';
import { DaemonTracer } from '../../src/daemon/traces/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import {
  AGENT_FAILURE_STATUS,
  RESTART_EXIT_WAIT_MS,
  type ConversationEvent,
  type Delivery,
} from '../../src/shared/protocol.js';
import { FIXTURE_RECIPE, FakeModelServer, FakeRuntime, FakeStore, fixtureRoot } from '../helpers/daemon-fakes.js';
import { MemoryUserLedger, RecordingLogger } from '../helpers/fakes.js';
import { testModules } from '../helpers/modules.js';

const RESTART = { max: 2, withinMs: 60_000 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** One turn of the loop: microtasks and zero-delay fake timers, then a real setImmediate, after the turn's I/O callbacks. */
async function turn(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Lets the work started so far run, the fake clock unmoved: for 30 ms of real time, enough for a launch's file I/O
 * (image staging), which the fake clock does not drive. Used where nothing is awaited; a restart is awaited by
 * restarted().
 */
async function settle(): Promise<void> {
  const end = performance.now() + 30;
  while (performance.now() < end) await turn();
}

/**
 * Drives the loop until `done` holds, at most 4 s of real time: what it waits for is real file I/O, which a busy machine
 * slows. 4 s, under vitest's 5 s test timeout, so a wait that is never met fails naming what it waited for.
 */
async function until(done: () => boolean, what: string): Promise<void> {
  const end = performance.now() + 4_000;
  while (!done()) {
    if (performance.now() > end) throw new Error(`${what} did not happen within 4 s`);
    await turn();
  }
}

/** Drives the loop until every restart going on has ended (supervisor.restartsSettled), at most 4 s of real time, as `until`. */
async function restarted(t: { readonly supervisor: AgentSupervisor }): Promise<void> {
  // An exit's handler, which begins the restart, runs once its promise's microtasks have.
  await settle();
  let done = false as boolean;
  void t.supervisor.restartsSettled().then(() => (done = true));
  const end = performance.now() + 4_000;
  while (!done) {
    if (performance.now() > end) throw new Error('the restarts going on did not end within 4 s');
    await turn();
  }
}
/** Moves the fake clock to `at` ms. */
const to = (at: number) => vi.advanceTimersByTimeAsync(at - Date.now());

async function setup(recipe: Record<string, unknown> = { ...FIXTURE_RECIPE, restart: RESTART }) {
  const root = await fixtureRoot(recipe as typeof FIXTURE_RECIPE);
  const home = await mkdtemp(join(tmpdir(), 'asha-home-'));
  const logger = new RecordingLogger();
  const runtime = new FakeRuntime();
  let n = 0;
  let spanIds = 0;
  const tracer = new DaemonTracer({
    clock: () => new Date(Date.now()),
    newSpanId: () => (++spanIds).toString(16).padStart(16, '0'),
    record: () => undefined,
  });
  const channels = new Channels({
    logger,
    clock: () => new Date(Date.now()),
    newId: () => `m${String(++n)}`,
    onDeliveryTimeout: () => undefined,
    maxAgentPostsPerConversation: 32,
    users: new MemoryUserLedger(),
    tracer,
  });
  const main = channels.get('main');
  const files = new ChannelFileSpaces({
    runtime,
    logger,
    homeId: 'abcd1234',
    runId: '0123abcd',
    clock: () => new Date(Date.now()),
    ownSecrets: () => [],
  });
  const supervisor = new AgentSupervisor({
    definitions: new Definitions(root),
    store: new FakeStore(),
    modelServer: new FakeModelServer('http://127.0.0.1:9999'),
    runtime,
    logger,
    fetch: () => Promise.reject(new Error('no model call in these tests')),
    root,
    stagingDir: join(home, 'staging'),
    agentLogsDir: join(home, 'logs', 'agents'),
    daemonPort: () => 4321,
    chatTimeoutMs: 1_000,
    tracer,
    clock: () => new Date(Date.now()),
    state: new StateStore({
      dir: join(home, 'state'),
      fs: nodeStateFs,
      logger,
      clock: () => new Date(Date.now()),
      insideGitTree: () => Promise.resolve(false),
    }),
    daemonStartedAt: '1970-01-01T00:00:00.000Z',
    files,
    modules: testModules({ runtime, files, home, logger, root, installed: new Map() }),
    userHome: home,
    ashaHome: home,
  });
  /** Deliveries each container's agent was sent, by container. */
  const inbox = new Map<string, Delivery[]>();
  /**
   * How each started container behaves: connect and announce (the default), exit at once, be lost, connect and never
   * announce (`mute`), or nothing.
   */
  const behave: ('online' | 'exit' | 'lost' | 'mute' | 'silent')[] = [];
  runtime.onStart = (spec) => {
    queueMicrotask(() => {
      const how = behave.shift() ?? 'online';
      if (how === 'exit') {
        runtime.exit(spec.name, 1);
        return;
      }
      if (how === 'lost') {
        runtime.lose(spec.name, new Error('docker start was killed'));
        return;
      }
      if (how === 'silent') return;
      if (how === 'mute') {
        connect(spec.name);
        return;
      }
      online(spec.name);
    });
  };
  const tokenOf = (container: string) =>
    present(
      present(
        runtime.starts.find((s) => s.name === container),
        `runtime.starts: no start named ${container}`,
      ).env['ASHA_AGENT_TOKEN'],
      `${container}: no ASHA_AGENT_TOKEN env var`,
    );
  const connect = (container: string) =>
    supervisor.connect(tokenOf(container), 'work', (d) => inbox.set(container, [...(inbox.get(container) ?? []), d]));
  const online = (container: string) => {
    connect(container);
    supervisor.post(tokenOf(container), { kind: 'status', text: 'Hi' });
  };
  const quiet = { phase: () => undefined, announced: () => undefined, resent: () => undefined };
  const user = main.claimUser('alice');
  const events: ConversationEvent[] = [];
  /** The user's message to work-1, watched; returns its conversation. */
  const ask = (text = 'Please say: Hello World.') => {
    const input = main.postToConversation({ from: user.id, kind: 'input', text, to: 'work-1' });
    main.watch(input.conversation, (e) => events.push(e));
    return input.conversation;
  };
  const container = (i: number) => present(runtime.starts[i], `runtime.starts[${String(i)}]`).name;
  const at = (event: string) => logger.entries.filter((e) => e.event === event);
  return {
    root,
    logger,
    runtime,
    main,
    supervisor,
    inbox,
    behave,
    online,
    connect,
    quiet,
    ask,
    container,
    at,
    events,
    tokenOf,
  };
}

type T = Awaited<ReturnType<typeof setup>>;

/** Launches the recipe's agent, online as work-1. */
async function launched(t: T): Promise<string> {
  const agent = await t.supervisor.launchNew('greeter', t.main, t.quiet);
  expect(agent.handle).toBe('work-1');
  return agent.container;
}

/**
 * The container exits on its own with `code`, its stream closed first as a killed container's is (probe K); then any
 * restart it began is driven to its end — unless the restart's container is scripted silent, when it waits on the clock.
 */
async function crash(t: T, container: string, code = 137, wait = true): Promise<void> {
  const started = t.runtime.starts.length;
  t.supervisor.disconnect(t.tokenOf(container));
  await settle();
  t.runtime.exit(container, code);
  await settle();
  if (wait) await restarted(t);
  // A silent restart's container has started, and waits on the clock.
  else await until(() => t.runtime.starts.length > started, "the restart's container start");
}

describe('a crash is reported as a crash (R11, A9; D56)', () => {
  it('a stream closed with no stop begun, then the exit at 1,999 ms: agent.exited_unexpectedly, no agent.stop_killed, no stop', async () => {
    const t = await setup({ ...FIXTURE_RECIPE });
    const c = await launched(t);
    t.supervisor.disconnect(t.tokenOf(c));
    // It leaves at once, as before (it has no restart).
    expect(t.main.isMember('work-1')).toBe(false);
    await to(1_999);
    t.runtime.exit(c, 137);
    await settle();
    expect(t.logger.events('error')).toEqual(['agent.exited_unexpectedly']);
    expect(present(t.at('agent.exited_unexpectedly')[0], "t.at('agent.exited_unexpectedly')[0]").fields).toMatchObject({
      handle: 'work-1',
      container: c,
      code: 137,
    });
    expect(t.at('agent.stop_killed')).toEqual([]);
    expect(t.runtime.stopRecords).toEqual([]);
    await to(10_000);
    expect(t.runtime.stopRecords).toEqual([]);
  });

  it("no exit by 2,001 ms: today's drain stop, given its grace", async () => {
    const t = await setup({ ...FIXTURE_RECIPE });
    const c = await launched(t);
    t.supervisor.disconnect(t.tokenOf(c));
    await to(RESTART_EXIT_WAIT_MS - 1);
    expect(t.runtime.stopRecords).toEqual([]);
    await to(2_001);
    expect(t.runtime.stopRecords.map((s) => [s.name, s.mode, s.graceS, s.at])).toEqual([
      [c, 'drain', 70, RESTART_EXIT_WAIT_MS],
    ]);
    expect(t.at('agent.stopping').map((e) => e.fields['reason'])).toEqual(['channel stream closed']);
    // FakeRuntime's drained container exits 143: the daemon's stop, logged at info.
    expect(t.logger.events('error')).toEqual([]);
    expect(t.at('agent.exited').map((e) => e.fields['code'])).toEqual([143]);
  });

  it('a stream closed after a stop the daemon began: the stop goes on, no wait and no second stop', async () => {
    const t = await setup({ ...FIXTURE_RECIPE, restart: RESTART });
    const c = await launched(t);
    let exit!: () => void;
    t.runtime.onStop = (name) =>
      new Promise<void>((resolve) => {
        exit = () => {
          t.runtime.exit(name, 137);
          resolve();
        };
      });
    const stopping = t.supervisor.stopHandle('main', 'work-1', 'held a delivery past its bound');
    await settle();
    t.supervisor.disconnect(t.tokenOf(c));
    expect(t.main.isMember('work-1')).toBe(false);
    exit();
    await stopping;
    await to(10_000);
    expect(t.runtime.stopRecords.map((s) => [s.name, s.mode])).toEqual([[c, 'kill']]);
    expect(t.at('agent.exited').map((e) => e.fields['code'])).toEqual([137]);
    expect(t.logger.events('error')).toEqual([]);
    // The daemon's stop is never a crash: nothing restarts.
    expect(t.at('agent.restarting')).toEqual([]);
    expect(t.runtime.starts).toHaveLength(1);
  });
});

/** The channel's statuses and leaves as its watchers see them: `<from>: <text>` (`!` when marked failure), `-<agent>`. */
function watchLines(t: T): string[] {
  const lines: string[] = [];
  t.main.watchAll((e) => {
    if (e.type === 'message' && e.message.kind === 'status')
      lines.push(
        `${e.message.from}: ${e.message.text}${e.message.conversation === null && e.message.failure === true ? ' !' : ''}`,
      );
    if (e.type === 'agent_left') lines.push(`-${e.agent}`);
  });
  return lines;
}

describe("a failure, said as the agent's status (docs/plans/demo-scene-refresh.md R6, A3)", () => {
  it('an online agent with no restart: its failure status once, then its leave; the watchers alone hear it', async () => {
    const t = await setup({ ...FIXTURE_RECIPE });
    const c = await launched(t);
    const lines = watchLines(t);
    t.ask();
    const before = t.events.length;
    t.supervisor.disconnect(t.tokenOf(c));
    t.supervisor.disconnect(t.tokenOf(c));
    t.runtime.exit(c, 137);
    await settle();
    expect(lines).toEqual([`work-1: ${AGENT_FAILURE_STATUS} !`, '-work-1']);
    // Never a conversation's: its watcher hears the leave's consequences only.
    expect(t.events.slice(before).filter((e) => e.type === 'message' && e.message.kind === 'status')).toEqual([]);
  });

  it("an online agent that restarts: its failure status, then the restarted agent's greeting", async () => {
    const t = await setup();
    const c = await launched(t);
    const lines = watchLines(t);
    await crash(t, c);
    expect(lines).toEqual([
      `work-1: ${AGENT_FAILURE_STATUS} !`,
      'work-1: restarting (1 of 2 within 60 s) !',
      'work-1: Hi',
    ]);
  });

  it('a restart that brings it back with the message it held: the restarting line, its greeting, then the re-send (R16)', async () => {
    const t = await setup();
    const c = await launched(t);
    const lines = watchLines(t);
    t.ask();
    await crash(t, c);
    expect(lines).toEqual([
      `work-1: ${AGENT_FAILURE_STATUS} !`,
      'work-1: restarting (1 of 2 within 60 s) !',
      'work-1: Hi',
      'work-1: sent again the message it held',
    ]);
  });

  it('a restart begun after the window counts from 1 again, as the limit counts: never "3 of 2" (R16)', async () => {
    const t = await setup();
    const c = await launched(t);
    t.ask();
    await crash(t, c);
    await to(Date.now() + 61_000);
    const lines = watchLines(t);
    t.ask();
    t.behave.push('exit', 'exit');
    await crash(t, t.container(1));
    expect(lines).toEqual([
      `work-1: ${AGENT_FAILURE_STATUS} !`,
      'work-1: restarting (1 of 2 within 60 s) !',
      'work-1: restart 1 failed: its container exited before coming online !',
      'work-1: restarting (2 of 2 within 60 s) !',
      'work-1: restart 2 failed: its container exited before coming online !',
      'work-1: restart limit reached (2 within 60 s): removed !',
      '-work-1',
    ]);
  });

  it('restarts that exit before coming online, then the limit: each said, the agent down throughout, then its leave (R16)', async () => {
    const t = await setup();
    const c = await launched(t);
    const lines = watchLines(t);
    t.ask();
    t.behave.push('exit', 'exit');
    await crash(t, c);
    expect(lines).toEqual([
      `work-1: ${AGENT_FAILURE_STATUS} !`,
      'work-1: restarting (1 of 2 within 60 s) !',
      'work-1: restart 1 failed: its container exited before coming online !',
      'work-1: restarting (2 of 2 within 60 s) !',
      'work-1: restart 2 failed: its container exited before coming online !',
      'work-1: restart limit reached (2 within 60 s): removed !',
      '-work-1',
    ]);
  });

  it("a restart's failure is said by its kind: an exit, the startup bound, a lost container, or no start at all (R16; the code review's round 3)", async () => {
    const said = async (prepare: (t: T) => void, wait = true): Promise<string> => {
      const t = await setup();
      const c = await launched(t);
      const lines = watchLines(t);
      prepare(t);
      await crash(t, c, 137, wait);
      if (!wait) {
        await to(FIXTURE_RECIPE.startupTimeoutMs);
        await until(() => t.at('agent.restart_failed').length === 1, "the restart's failure");
      }
      await t.supervisor.stopAll('test done');
      return present(
        lines.find((l) => l.startsWith('work-1: restart 1 failed: ')),
        'the first restart failure line',
      );
    };
    expect(await said((t) => t.behave.push('exit'))).toBe(
      'work-1: restart 1 failed: its container exited before coming online !',
    );
    expect(await said((t) => t.behave.push('silent'), false)).toBe(
      'work-1: restart 1 failed: it did not come online in time !',
    );
    expect(await said((t) => t.behave.push('lost'))).toBe(
      'work-1: restart 1 failed: its container failed before coming online !',
    );
    expect(
      await said((t) => {
        t.runtime.onEnsureReady = () => Promise.reject(new Error('colima did not start'));
      }),
    ).toBe('work-1: restart 1 failed: it could not be started !');
  });

  it("a restart's container that connects and never greets fails as the startup bound, and the next restart is tried (R16; the code review's R4-DESIGN-001)", async () => {
    const t = await setup();
    const c = await launched(t);
    const lines = watchLines(t);
    t.behave.push('mute', 'online');
    // A container stopped closes its stream a little after the stop begins and before it exits, as a killed container's
    // does (probe K): the restart's member must outlive the close.
    t.runtime.onStop = async (name, mode) => {
      await settle();
      t.supervisor.disconnect(t.tokenOf(name));
      await settle();
      t.runtime.exit(name, mode === 'drain' ? 143 : 137);
    };
    await crash(t, c, 137, false);
    await to(Date.now() + FIXTURE_RECIPE.startupTimeoutMs + 1_000);
    await restarted(t);
    expect(lines).toEqual([
      `work-1: ${AGENT_FAILURE_STATUS} !`,
      'work-1: restarting (1 of 2 within 60 s) !',
      'work-1: restart 1 failed: it did not come online in time !',
      'work-1: restarting (2 of 2 within 60 s) !',
      'work-1: Hi',
    ]);
    expect(t.at('agent.restart_failed').map((e) => e.fields['reason'])).toEqual(['not online within 2000 ms']);
    expect(t.main.isMember('work-1')).toBe(true);
  });

  it("a stop the daemon began says none: a watchdog's kill, then the stream closing", async () => {
    const t = await setup();
    const c = await launched(t);
    const lines = watchLines(t);
    const stopping = t.supervisor.stopHandle('main', 'work-1', 'held a delivery past its bound');
    t.supervisor.disconnect(t.tokenOf(c));
    await stopping;
    expect(lines).toEqual(['-work-1']);
  });

  it("a channel's stop says none (A3; the code review's round 2)", async () => {
    const t = await setup();
    const c = await launched(t);
    const lines = watchLines(t);
    const stopping = t.supervisor.stopChannel('main', 'cli', () => undefined);
    t.supervisor.disconnect(t.tokenOf(c));
    await stopping;
    expect(lines).toEqual(['-work-1']);
  });

  it('the daemon stopping says none', async () => {
    const t = await setup();
    const c = await launched(t);
    const lines = watchLines(t);
    const stopping = t.supervisor.stopAll('daemon stopping');
    t.supervisor.disconnect(t.tokenOf(c));
    await stopping;
    expect(lines).toEqual(['-work-1']);
  });

  it('an agent never online says none: its stream closes before its greeting', async () => {
    const t = await setup({ ...FIXTURE_RECIPE });
    t.behave.push('silent');
    const launching = t.supervisor.launchNew('greeter', t.main, t.quiet).catch((error: unknown) => error);
    await until(() => t.runtime.starts.length === 1, 'the container start');
    const c = t.container(0);
    t.connect(c);
    const lines = watchLines(t);
    t.supervisor.disconnect(t.tokenOf(c));
    t.runtime.exit(c, 1);
    await settle();
    expect(lines).toEqual(['-work-1']);
    expect(await launching).toBeInstanceOf(Error);
  });
});

describe("a failure seen first as the exit (docs/plans/demo-scene-refresh.md R6; the code review's R1-DESIGN-001)", () => {
  it('an online agent with no restart whose exit comes before its stream closes: its failure status once, then its leave', async () => {
    const t = await setup({ ...FIXTURE_RECIPE });
    const c = await launched(t);
    const lines = watchLines(t);
    t.runtime.exit(c, 137);
    await settle();
    t.supervisor.disconnect(t.tokenOf(c));
    await settle();
    expect(lines).toEqual([`work-1: ${AGENT_FAILURE_STATUS} !`, '-work-1']);
  });

  it("an online agent whose container is lost — its docker start killed — says its failure, then leaves (the code review's round 2)", async () => {
    const t = await setup({ ...FIXTURE_RECIPE });
    const c = await launched(t);
    const lines = watchLines(t);
    t.runtime.lose(c, new Error('docker start worker was killed by SIGKILL'));
    await settle();
    expect(lines).toEqual([`work-1: ${AGENT_FAILURE_STATUS} !`, '-work-1']);
  });

  it('a stop the daemon began says none when its exit comes first', async () => {
    const t = await setup({ ...FIXTURE_RECIPE });
    await launched(t);
    const lines = watchLines(t);
    await t.supervisor.stopHandle('main', 'work-1', 'test done');
    await settle();
    expect(lines).toEqual(['-work-1']);
  });
});

describe('a restart (R12, A8)', () => {
  it('restarts an unexpected exit under its handle, re-sending its held delivery with restarted and its bound started afresh', async () => {
    const t = await setup();
    const c0 = await launched(t);
    const conversation = t.ask();
    await settle();
    const first = present(present(t.inbox.get(c0), 't.inbox.get(c0)')[0], 't.inbox.get(c0)[0]');
    expect(first.message.restarted).toBeUndefined();
    await to(1_500);
    await crash(t, c0);
    // Suspended, not removed: still on the channel, still working on the conversation.
    expect(t.main.handles()).toEqual(['work-1']);
    expect(t.main.working(conversation)).toEqual(['work-1']);
    await settle();
    expect(t.runtime.starts).toHaveLength(2);
    const c1 = t.container(1);
    expect(t.main.handles()).toEqual(['work-1']);
    const resent = present(t.inbox.get(c1), 't.inbox.get(c1)');
    expect(resent).toEqual([{ ...first, message: { ...first.message, restarted: { attempt: 1 } } }]);
    expect(
      t.logger.entries.filter((e) => e.event.startsWith('agent.restart')).map((e) => [e.level, e.event, e.fields]),
    ).toEqual([
      ['warn', 'agent.restarting', { handle: 'work-1', attempt: 1, max: 2, withinMs: 60_000, code: 137 }],
      ['info', 'agent.restarted', { handle: 'work-1', attempt: 1, ms: 0 }],
    ]);
    expect(t.logger.events('error')).toEqual(['agent.exited_unexpectedly']);
    // Its bound started at the re-send (1.5 s), not at the first delivery: it expires at 1.5 s + 2,000 ms, not at 2,000 ms.
    await to(FIXTURE_RECIPE.messageTimeoutMs);
    expect(t.at('channel.delivery_timeout')).toEqual([]);
    await to(1_500 + FIXTURE_RECIPE.messageTimeoutMs - 1);
    expect(t.at('channel.delivery_timeout')).toEqual([]);
    await to(1_500 + FIXTURE_RECIPE.messageTimeoutMs);
    expect(t.at('channel.delivery_timeout').map((e) => e.fields['handle'])).toEqual(['work-1']);
    // Never a join: no second number was given.
    expect(t.at('channel.joined').map((e) => e.fields['handle'])).toEqual(['work-1']);
    expect(t.at('channel.rejoined').map((e) => e.fields['handle'])).toEqual(['work-1']);
  });

  it('an exit without the stream closing first is restarted too', async () => {
    const t = await setup();
    const c0 = await launched(t);
    t.runtime.exit(c0, 1);
    await restarted(t);
    expect(t.runtime.starts).toHaveLength(2);
    expect(t.main.handles()).toEqual(['work-1']);
    expect(present(t.at('agent.restarting')[0], "t.at('agent.restarting')[0]").fields).toEqual({
      handle: 'work-1',
      attempt: 1,
      max: 2,
      withinMs: 60_000,
      code: 1,
    });
  });

  it('holds a delivery posted while it is suspended, counts it as working, and re-sends it with the held one, in posting order', async () => {
    const t = await setup();
    const c0 = await launched(t);
    const one = t.ask('first');
    await settle();
    t.behave.push('silent');
    await crash(t, c0, 137, false);
    const c1 = t.container(1);
    const two = t.ask('second');
    await settle();
    expect(t.inbox.get(c1)).toBeUndefined();
    expect(t.main.working(two)).toEqual(['work-1']);
    // Its conversation does not conclude while it is held: no harness reply.
    expect(t.events.some((e) => e.type === 'message' && e.message.from === 'asha' && e.message.kind === 'output')).toBe(
      false,
    );
    t.online(c1);
    await restarted(t);
    expect(
      present(t.inbox.get(c1), 't.inbox.get(c1)').map((d) => [
        d.message.conversation,
        d.message.text,
        d.message.restarted,
      ]),
    ).toEqual([
      [one, 'first', { attempt: 1 }],
      [two, 'second', { attempt: 1 }],
    ]);
  });

  it('with max 2 and withinMs 60,000, exits at 0, 1 and 2 s give two restarts, then agent.restart_limit, the conversation ended restart_limit naming the handle, and the member gone', async () => {
    const t = await setup();
    let c = await launched(t);
    const conversation = t.ask();
    await settle();
    await crash(t, c);
    c = t.container(1);
    await to(1_000);
    await crash(t, c);
    c = t.container(2);
    await to(2_000);
    await crash(t, c);
    expect(t.runtime.starts).toHaveLength(3);
    expect(t.at('agent.restarting').map((e) => e.fields['attempt'])).toEqual([1, 2]);
    expect(
      t
        .at('agent.restart_limit')
        .map((e) => [
          e.level,
          Object.keys(e.fields).sort(byCodeUnit),
          e.fields['handle'],
          e.fields['restarts'],
          e.fields['withinMs'],
          e.fields['resent'],
        ]),
    ).toEqual([['error', ['error', 'handle', 'resent', 'restarts', 'withinMs'], 'work-1', 2, 60_000, null]]);
    expect(t.events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', reason: 'restart_limit', detail: 'work-1 exited 3 times within 60 s; not restarted' },
    ]);
    expect(t.at('channel.conversation_ended').map((e) => [e.fields['conversation'], e.fields['reason']])).toEqual([
      [conversation, 'restart_limit'],
    ]);
    expect(t.main.handles()).toEqual([]);
    expect(t.at('channel.left').map((e) => [e.fields['handle'], e.fields['detail']])).toEqual([
      ['work-1', 'restart limit reached'],
    ]);
    // Ended, and settled with no harness reply once nobody works on it.
    expect(t.main.working(conversation)).toEqual([]);
    expect(t.main.isSettled(conversation)).toBe(true);
    expect(t.events.some((e) => e.type === 'message' && e.message.from === 'asha' && e.message.kind === 'output')).toBe(
      false,
    );
    expect(t.logger.events('error')).toEqual([
      'agent.exited_unexpectedly',
      'agent.exited_unexpectedly',
      'agent.exited_unexpectedly',
      'agent.restart_limit',
      'channel.conversation_ended',
    ]);
  });

  it('with nothing held, the third exit within the window is the limit too, and no conversation is ended', async () => {
    const t = await setup();
    let c = await launched(t);
    await crash(t, c);
    c = t.container(1);
    await to(1_000);
    await crash(t, c);
    c = t.container(2);
    await to(2_000);
    await crash(t, c);
    expect(t.at('agent.restart_limit')).toHaveLength(1);
    expect(t.at('channel.conversation_ended')).toEqual([]);
    expect(t.main.handles()).toEqual([]);
  });

  it('an exit at 60,001 ms after the first restart counts afresh: one restart in the window, so it restarts again', async () => {
    const t = await setup();
    let c = await launched(t);
    await crash(t, c);
    c = t.container(1);
    await to(1_000);
    await crash(t, c);
    c = t.container(2);
    await to(60_001);
    await crash(t, c);
    expect(t.at('agent.restart_limit')).toEqual([]);
    expect(t.at('agent.restarting').map((e) => e.fields['attempt'])).toEqual([1, 2, 3]);
    expect(t.runtime.starts).toHaveLength(4);
    expect(t.main.handles()).toEqual(['work-1']);
  });

  it('a restart begun exactly withinMs ago no longer counts', async () => {
    const t = await setup();
    let c = await launched(t);
    await crash(t, c);
    c = t.container(1);
    await to(1_000);
    await crash(t, c);
    c = t.container(2);
    await to(60_000);
    await crash(t, c);
    expect(t.at('agent.restart_limit')).toEqual([]);
    expect(t.runtime.starts).toHaveLength(4);
  });

  it('with max 1, the second exit is the limit', async () => {
    const t = await setup({ ...FIXTURE_RECIPE, restart: { max: 1, withinMs: 60_000 } });
    let c = await launched(t);
    await crash(t, c);
    c = t.container(1);
    await to(30_000);
    await crash(t, c);
    expect(t.at('agent.restarting')).toHaveLength(1);
    expect(t.at('agent.restart_limit').map((e) => e.fields['restarts'])).toEqual([1]);
    expect(t.runtime.starts).toHaveLength(2);
  });

  it('three exits 31 s apart, each holding the same delivery: two restarts, then the limit (each delivery re-sent at most max times)', async () => {
    // A bound long enough that the delivery is still held at the third exit, 62 s on.
    const t = await setup({ ...FIXTURE_RECIPE, messageTimeoutMs: 120_000, restart: RESTART });
    let c = await launched(t);
    const lines = watchLines(t);
    const conversation = t.ask();
    await settle();
    await crash(t, c);
    c = t.container(1);
    await to(31_000);
    await crash(t, c);
    c = t.container(2);
    await to(62_000);
    await crash(t, c);
    // At 62 s only the restart begun at 31 s is in the window: the re-send cap, not the window, is the limit.
    expect(t.at('agent.restarting').map((e) => e.fields['attempt'])).toEqual([1, 2]);
    expect(t.at('agent.restart_limit').map((e) => [e.fields['restarts'], e.fields['resent']])).toEqual([[1, 2]]);
    expect(t.at('channel.conversation_ended').map((e) => e.fields['conversation'])).toEqual([conversation]);
    expect(t.runtime.starts).toHaveLength(3);
    // The chat says which limit it was (the code review's round 3): not the window's count, 1, under max 2.
    expect(lines.filter((l) => l.startsWith('work-1: restart limit'))).toEqual([
      'work-1: restart limit reached (the message it held sent again 2 times): removed !',
    ]);
  });

  it('a restart whose container exits before it is online counts as an exit: agent.exited_unexpectedly, then the next attempt', async () => {
    const t = await setup();
    const c = await launched(t);
    t.behave.push('exit');
    await crash(t, c);
    await settle();
    expect(t.runtime.starts).toHaveLength(3);
    expect(t.at('agent.restarting').map((e) => [e.fields['attempt'], e.fields['code']])).toEqual([
      [1, 137],
      [2, 1],
    ]);
    expect(t.at('agent.restarted').map((e) => e.fields['attempt'])).toEqual([2]);
    expect(t.logger.events('error')).toEqual(['agent.exited_unexpectedly', 'agent.exited_unexpectedly']);
    // The restart's container exited before it connected: still named as the handle it was to rejoin.
    expect(
      t.at('agent.exited_unexpectedly').map((e) => [e.fields['handle'], e.fields['container'], e.fields['code']]),
    ).toEqual([
      ['work-1', c, 137],
      ['work-1', t.container(1), 1],
    ]);
    expect(t.at('agent.restart_failed')).toEqual([]);
    expect(t.main.handles()).toEqual(['work-1']);
  });

  it('a restart not online within startupTimeoutMs logs agent.restart_failed, is killed, and counts as an exit', async () => {
    const t = await setup();
    const c = await launched(t);
    t.behave.push('silent', 'silent');
    await crash(t, c, 137, false);
    await to(FIXTURE_RECIPE.startupTimeoutMs);
    // The second attempt begins at once: its container started, its own startup bound running from then.
    await until(
      () => t.at('agent.restart_failed').length === 1 && t.runtime.starts.length === 3,
      "the first restart's failure and the second attempt's start",
    );
    expect(
      t
        .at('agent.restart_failed')
        .map((e) => [
          e.level,
          Object.keys(e.fields).sort(byCodeUnit),
          e.fields['handle'],
          e.fields['attempt'],
          e.fields['reason'],
        ]),
    ).toEqual([
      [
        'error',
        ['attempt', 'error', 'handle', 'reason'],
        'work-1',
        1,
        `not online within ${String(FIXTURE_RECIPE.startupTimeoutMs)} ms`,
      ],
    ]);
    expect(t.runtime.stopRecords.map((s) => [s.name, s.mode])).toEqual([[t.container(1), 'kill']]);
    // Its kill is the daemon's: logged at info, and it counts as the agent's second exit within the window.
    await to(Date.now() + FIXTURE_RECIPE.startupTimeoutMs);
    await restarted(t);
    expect(t.at('agent.restart_failed').map((e) => e.fields['attempt'])).toEqual([1, 2]);
    expect(t.at('agent.restart_limit')).toHaveLength(1);
    expect(t.main.handles()).toEqual([]);
  });

  it('every new record carries exactly its fields, and none a user', async () => {
    const t = await setup();
    const c = await launched(t);
    t.ask();
    await settle();
    await crash(t, c);
    const fields = (event: string) => t.at(event).map((e) => Object.keys(e.fields).sort(byCodeUnit));
    expect(fields('agent.restarting')).toEqual([['attempt', 'code', 'handle', 'max', 'withinMs']]);
    expect(fields('agent.restarted')).toEqual([['attempt', 'handle', 'ms']]);
    expect(JSON.stringify(t.logger.entries.filter((e) => e.event.startsWith('agent.restart')))).not.toContain('alice');
  });
});

describe('what never restarts, and the stop (R10, R14, A8)', () => {
  it('a recipe without restart is never restarted: it leaves when it crashes', async () => {
    const t = await setup({ ...FIXTURE_RECIPE });
    const c = await launched(t);
    await crash(t, c);
    await to(10_000);
    expect(t.runtime.starts).toHaveLength(1);
    expect(t.main.handles()).toEqual([]);
    expect(t.at('agent.restarting')).toEqual([]);
  });

  it("stopHandle (a delivery bound's kill) and stopAll never restart", async () => {
    const t = await setup();
    await launched(t);
    await t.supervisor.stopHandle('main', 'work-1', 'held a delivery past its bound');
    await settle();
    expect(t.runtime.starts).toHaveLength(1);
    const u = await setup();
    await launched(u);
    await u.supervisor.stopAll('daemon stopping');
    await settle();
    expect(u.runtime.starts).toHaveLength(1);
    expect([...t.at('agent.restarting'), ...u.at('agent.restarting')]).toEqual([]);
  });

  it("a team's rollback never restarts the members it stops", async () => {
    const t = await setup();
    await writeFile(join(t.root, 'recipes', 'nope.json'), '{}');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(t.root, 'teams', 'pair'), { recursive: true }));
    await writeFile(
      join(t.root, 'teams', 'pair', 'team.json'),
      JSON.stringify({
        id: 'pair',
        description: 'x',
        members: [
          { name: 'work', recipe: 'work.json' },
          { name: 'late', recipe: 'late.json' },
        ],
      }),
    );
    await writeFile(
      join(t.root, 'teams', 'pair', 'work.json'),
      JSON.stringify({ ...FIXTURE_RECIPE, id: 'work', restart: RESTART }),
    );
    await writeFile(
      join(t.root, 'teams', 'pair', 'late.json'),
      JSON.stringify({ ...FIXTURE_RECIPE, id: 'late', restart: RESTART }),
    );
    t.behave.push('online', 'exit');
    const sink = { ...t.quiet, member: () => undefined, launched: () => undefined, teamLaunched: () => undefined };
    await expect(t.supervisor.launchTeam('pair', t.main, sink)).rejects.toThrow(TeamLaunchFailed);
    await settle();
    expect(t.runtime.starts).toHaveLength(2);
    // The second member, exited before it was online, is killed by its start; the first by the rollback.
    expect(t.runtime.stopRecords.map((s) => s.name).sort(byCodeUnit)).toEqual(
      [t.container(0), t.container(1)].sort(byCodeUnit),
    );
    expect(t.at('agent.restarting')).toEqual([]);
  });

  it('a daemon that is stopping begins no restart, and its suspended member is removed', async () => {
    const t = await setup();
    const c = await launched(t);
    t.supervisor.disconnect(t.tokenOf(c));
    await settle();
    expect(t.main.isSuspended('work-1')).toBe(true);
    const stopping = t.supervisor.stopAll('daemon stopping');
    await settle();
    await stopping;
    expect(t.runtime.starts).toHaveLength(1);
    expect(t.main.handles()).toEqual([]);
    expect(t.at('agent.restarting')).toEqual([]);
  });

  it("stopAll during a restart stops the restart's container and removes its suspended member", async () => {
    const t = await setup();
    const c = await launched(t);
    t.behave.push('silent');
    await crash(t, c, 137, false);
    const c1 = t.container(1);
    t.connect(c1);
    expect(t.main.handles()).toEqual(['work-1']);
    await t.supervisor.stopAll('daemon stopping');
    await settle();
    expect(t.runtime.stopRecords.map((s) => [s.name, s.mode])).toEqual([[c1, 'drain']]);
    expect(t.main.handles()).toEqual([]);
    expect(t.runtime.starts).toHaveLength(2);
  });

  it('a second stop of an agent being restarted joins the first', async () => {
    const t = await setup();
    const c = await launched(t);
    t.behave.push('silent');
    await crash(t, c, 137, false);
    const c1 = t.container(1);
    t.connect(c1);
    let exit!: () => void;
    t.runtime.onStop = (name) =>
      new Promise<void>((resolve) => {
        exit = () => {
          t.runtime.exit(name, 137);
          resolve();
        };
      });
    const first = t.supervisor.stopHandle('main', 'work-1', 'held a delivery past its bound');
    const second = t.supervisor.stopAll('daemon stopping');
    await settle();
    exit();
    await Promise.all([first, second]);
    expect(t.runtime.stopRecords.map((s) => [s.name, s.mode])).toEqual([[c1, 'kill']]);
  });
});

describe("a recipe's restart (R10, A8)", () => {
  const file = '/r/recipes/w.json';
  const base = { ...FIXTURE_RECIPE, id: 'w' };
  it.each([[{ max: 1, withinMs: 1_000 }], [{ max: 5, withinMs: 3_600_000 }], [{ max: 2, withinMs: 60_000 }]])(
    'accepts %j',
    (restart) => {
      expect(parseRecipe({ ...base, restart }, file).restart).toEqual(restart);
    },
  );

  it('absent: no restart', () => {
    expect(parseRecipe(base, file).restart).toBeUndefined();
  });

  it.each([
    ['max 0', { max: 0, withinMs: 60_000 }],
    ['max 6', { max: 6, withinMs: 60_000 }],
    ['withinMs 999', { max: 2, withinMs: 999 }],
    ['withinMs 3,600,001', { max: 2, withinMs: 3_600_001 }],
    ['a fraction', { max: 1.5, withinMs: 60_000 }],
    ['another key', { max: 2, withinMs: 60_000, backoff: 1 }],
    ['a missing key', { max: 2 }],
    ['a number', 2],
    ['a string max', { max: '2', withinMs: 60_000 }],
  ])('refuses %s, naming the file and the rule', (_, restart) => {
    expect(() => parseRecipe({ ...base, restart }, file)).toThrow(DefinitionError);
    expect(() => parseRecipe({ ...base, restart }, file)).toThrow(
      `${file}: restart must be {"max": <1–5>, "withinMs": <1000–3600000>}, each a whole number`,
    );
  });

  it('refuses restart beside persist', () => {
    expect(() => parseRecipe({ ...base, restart: RESTART, persist: ['workspace'] }, file)).toThrow(
      `${file}: restart cannot be named beside persist`,
    );
    expect(parseRecipe({ ...base, restart: RESTART, persist: [] }, file).restart).toEqual(RESTART);
  });
});
