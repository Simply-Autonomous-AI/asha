// Agent persistence over the daemon's real HTTP server (docs/plans/agent-persistence.md R2, R5, R9 (a), (i), R15,
// R16; A2, A4, A8 tests 8 and 11, A15, A16): a persisted agent's launch following its re-sent conversations on the
// launch stream; a user's message to a full record refused by the stream's error event; the state routes; and a
// user's ID and text in no warn or error record, and in none of R9's events, through the failure paths. The agents
// are the real agent SDK in-process, as the integration suite runs them; FakeRuntime stands in for docker.

import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentTelemetry,
  HarnessClient,
  TRACE_LIMITS,
  serveAgent,
  type AgentProcess,
  type DeliveryHandler,
} from '../../src/agent-sdk/index.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon/compose.js';
import { serializeError } from '../../src/daemon/log.js';
import { StateInsideGitTree } from '../../src/daemon/state/index.js';
import type { ContainerSpec } from '../../src/daemon/container-runtime/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { harnessPaths, type HarnessPaths } from '../../src/shared/paths.js';
import { Routes, type ConversationEvent, type LaunchEvent, type StateEraseEvent } from '../../src/shared/protocol.js';
import { SseDecoder } from '../../src/shared/sse.js';
import { FakeModelServer, FakeRuntime, FakeStore, REAL_STATE, TEST_LIFETIME } from '../helpers/daemon-fakes.js';
import { ManualSchedule, RecordingAgentLog, RecordingLogger } from '../helpers/fakes.js';
import { persistenceRoot, until } from '../helpers/persistence.js';
import { builtPortal } from '../helpers/portal-folders.js';

const NO_SIGNALS: AgentProcess = { onTerminate: () => () => undefined, exit: () => undefined };
const MANIFEST = { tools: [], answerTools: [], keepsMemory: true, eraseUser: true, stateSchema: 1 } as const;

interface Daemon {
  readonly daemon: RunningDaemon;
  readonly base: string;
  readonly credential: string;
  readonly paths: HarnessPaths;
  readonly logger: RecordingLogger;
  readonly runtime: FakeRuntime;
  readonly root: string;
  /** Each in-process agent's run. */
  readonly agents: Promise<unknown>[];
}

const running: Daemon[] = [];
/** Releases every turn `hanging` holds, so a persisted agent acks and the daemon's stop does not wait its 65 s. */
const holds: (() => void)[] = [];
/**
 * Set as the test ends: from then on `hanging` answers at once. A persisted agent released from its held turn acks
 * and is handed the next queued delivery; had that one hung too, the stop would wait out its 65 s ack bound (a race
 * the gate at 6933f15 lost, past the 10 s hook bound).
 */
let ending = false;
afterEach(async () => {
  ending = true;
  for (const release of holds.splice(0)) release();
  for (const d of running.splice(0)) await d.daemon.stop();
  ending = false;
});

/** A turn that does not finish until the test ends: its delivery stays in hand, unacknowledged. */
const hanging: DeliveryHandler = () =>
  ending ? Promise.resolve() : new Promise<void>((resolve) => holds.push(resolve));

/**
 * A user's message over the conversation route, read until `done` holds for an event — the route's stream stays open
 * until its client hangs up, as the CLI does once its conversation settles — then hung up.
 */
async function converse(
  d: Daemon,
  body: unknown,
  done: (e: ConversationEvent) => boolean,
): Promise<ConversationEvent[]> {
  const abort = new AbortController();
  const response = await control(d, Routes.conversations, body, abort.signal);
  const sse = new SseDecoder();
  const decoder = new TextDecoder();
  const seen: ConversationEvent[] = [];
  try {
    for await (const chunk of present<ReadableStream<Uint8Array>>(response.body, 'response body')) {
      for (const e of sse.push(decoder.decode(chunk, { stream: true })) as ConversationEvent[]) {
        seen.push(e);
        if (done(e)) return seen;
      }
    }
    return seen;
  } finally {
    abort.abort();
  }
}
const replied = (e: ConversationEvent) => e.type === 'message' && e.message.kind === 'output';

/**
 * A daemon on `home` whose "containers" run the real SDK in-process with `handler`, joining as `keep`. `insideGitTree`
 * answers the R2 check; `seen` records every path it was asked about.
 */
async function daemon(props: {
  home?: string;
  root?: string;
  handler: DeliveryHandler;
  insideGitTree?: (path: string) => Promise<boolean>;
}): Promise<Daemon> {
  const root = props.root ?? (await persistenceRoot());
  const home = props.home ?? (await mkdtemp(join(tmpdir(), 'asha-int-p-')));
  const paths = harnessPaths({ ASHA_HOME: home });
  const logger = new RecordingLogger();
  const runtime = new FakeRuntime('127.0.0.1');
  const agents: Promise<unknown>[] = [];
  const workspace = await mkdtemp(join(tmpdir(), 'asha-int-p-ws-'));
  runtime.onStart = (spec: ContainerSpec) => {
    const environment = {
      harnessUrl: present(spec.env['ASHA_URL'], "spec.env['ASHA_URL']"),
      agentToken: present(spec.env['ASHA_AGENT_TOKEN'], "spec.env['ASHA_AGENT_TOKEN']"),
    };
    const telemetry = new AgentTelemetry({
      exporter: new InMemorySpanExporter(),
      writeLine: () => undefined,
      maxQueueSize: TRACE_LIMITS.maxQueueSize,
      maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
    });
    const client = new HarnessClient({
      environment,
      chatTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      filesRequestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 5_000,
      fetch: globalThis.fetch,
      telemetry,
    });
    agents.push(
      serveAgent({
        client,
        telemetry,
        name: 'keep',
        handler: props.handler,
        process: NO_SIGNALS,
        imageTools: { manifest: MANIFEST, handlers: {} },
        workspace,
        channelSpace: null,
        log: new RecordingAgentLog(),
        drainMs: 5_000,
      }).catch((e: unknown) => e),
    );
  };
  const started = await startDaemon({
    paths,
    root,
    version: 't',
    build: 'test-build-1',
    pid: process.pid,
    logger,
    dependencies: {
      runtime,
      modelServer: new FakeModelServer('http://127.0.0.1:9'),
      store: new FakeStore(),
      ...REAL_STATE,
      ...(props.insideGitTree === undefined ? {} : { insideGitTree: props.insideGitTree }),
      fetch: globalThis.fetch,
    },
    heartbeatMs: 50,
    chatTimeoutMs: 5_000,
    schedule: new ManualSchedule().schedule,
    lifetime: TEST_LIFETIME,
    portal: builtPortal(),
  });
  const credential = (JSON.parse(await readFile(paths.daemonFile, 'utf8')) as { credential: string }).credential;
  const d = {
    daemon: started,
    base: `http://127.0.0.1:${String(started.port)}`,
    credential,
    paths,
    logger,
    runtime,
    root,
    agents,
  };
  running.push(d);
  return d;
}

/** A control request; `events` reads an SSE answer to its end. */
async function control(d: Daemon, route: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${d.base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${d.credential}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function events(response: Response): Promise<{ events: unknown[]; heartbeats: number }> {
  const sse = new SseDecoder();
  const decoder = new TextDecoder();
  const out: unknown[] = [];
  let heartbeats = 0;
  for await (const chunk of present<ReadableStream<Uint8Array>>(response.body, 'response body')) {
    const text = decoder.decode(chunk, { stream: true });
    heartbeats += text.split(': heartbeat').length - 1;
    out.push(...sse.push(text));
  }
  return { events: out, heartbeats };
}

/** Replies `done: <text>` to the user, then returns: the SDK acks. */
const replies: DeliveryHandler = async (delivery, context) => {
  await context.post({
    conversation: delivery.message.conversation,
    kind: 'output',
    text: `done: ${delivery.message.text}`,
  });
};

/** Plants an earlier run's unsaved input for the keeper (alone on main), as a crash leaves it. */
async function plantedResend(
  home: string,
  text: string,
  user = 'ivy',
  identity: readonly [string, string] = ['-', 'keeper'],
): Promise<void> {
  const dir = join(home, 'state', 'agents', 'main', ...identity);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, 'pending.json'),
    JSON.stringify({
      entries: [
        {
          messageId: 'orig1',
          conversation: 'conv1',
          deliveryId: 'd1',
          daemonStartedAt: '2026-09-28T00:00:00.000Z',
          afterGeneration: 0,
          attempts: 0,
          savedAt: '2026-09-28T09:00:00.000Z',
          kind: 'input',
          user,
          text,
          to: null,
        },
      ],
    }),
    { mode: 0o600 },
  );
}

describe('the launch route following re-sent conversations (R9 (i); A8 test 11)', () => {
  it("with followResent: launched, then resending and the conversation's events in order, heartbeats, and settled; the stream ends there", async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-int-p-'));
    await plantedResend(home, 'do task 3');
    const d = await daemon({ home, handler: replies });
    const { events: seen, heartbeats } = (await events(
      await control(d, Routes.agents, { channel: 'main', recipe: 'keeper', followResent: true }),
    )) as { events: LaunchEvent[]; heartbeats: number };
    const types = seen.map((e) => e.type).filter((t) => t !== 'phase');
    expect(types.slice(0, 3)).toEqual(['announced', 'launched', 'resending']);
    expect(types.at(-1)).toBe('settled');
    const resending = seen.find((e) => e.type === 'resending') as Extract<LaunchEvent, { type: 'resending' }>;
    expect(resending.savedAt).toBe('2026-09-28T09:00:00.000Z');
    const reply = seen.find((e) => e.type === 'message' && e.message.kind === 'output') as Extract<
      LaunchEvent,
      { type: 'message' }
    >;
    expect(reply.message).toMatchObject({ conversation: resending.conversation, text: 'done: do task 3', to: 'ivy' });
    expect(seen.at(-1)).toEqual({ type: 'settled', conversation: resending.conversation });
    expect(heartbeats).toBeGreaterThanOrEqual(0);
  });

  it('without followResent — an older CLI — the stream ends at launched, and the re-sent reply still reaches the channel', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-int-p-'));
    await plantedResend(home, 'do task 3');
    const d = await daemon({ home, handler: replies });
    const { events: seen } = (await events(await control(d, Routes.agents, { channel: 'main', recipe: 'keeper' }))) as {
      events: LaunchEvent[];
      heartbeats: number;
    };
    expect(present(seen.at(-1), 'seen.at(-1)').type).toBe('launched');
    await until(() => {
      expect(
        d.logger.entries.some(
          (e) => e.event === 'channel.posted' && e.fields['kind'] === 'output' && e.fields['to'] === 'ivy',
        ),
      ).toBe(true);
    });
  });

  it("a team launch with followResent follows its members' re-sends: team_launched, then resending, the reply and settled (p20-b's first run found it ending at team_launched)", async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-int-p-'));
    await plantedResend(home, 'do task 3', 'ivy', ['pair', 'ann']);
    const d = await daemon({ home, handler: replies });
    const { events: seen } = (await events(
      await control(d, Routes.agents, { channel: 'main', team: 'pair', followResent: true }),
    )) as { events: LaunchEvent[]; heartbeats: number };
    const types = seen
      .map((e) => e.type)
      .filter((t) => t !== 'phase' && t !== 'member' && t !== 'announced' && t !== 'launched');
    expect(types[0]).toBe('team_launched');
    expect(types[1]).toBe('resending');
    expect(types.at(-1)).toBe('settled');
    const resending = seen.find((e) => e.type === 'resending') as Extract<LaunchEvent, { type: 'resending' }>;
    expect(seen.find((e) => e.type === 'message' && e.message.kind === 'output')).toMatchObject({
      message: { conversation: resending.conversation, text: 'done: do task 3', to: 'ivy' },
    });
    expect(seen.at(-1)).toEqual({ type: 'settled', conversation: resending.conversation });
  });

  it('refuses followResent other than true, 400', async () => {
    const d = await daemon({ handler: replies });
    const response = await control(d, Routes.agents, { channel: 'main', recipe: 'keeper', followResent: false });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'followResent must be true when given' });
  });

  it('the CLI prints the handle, one resuming line and the reply, exit 0', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-int-p-'));
    await plantedResend(home, 'do task 3');
    const d = await daemon({ home, handler: replies });
    const { runCli } = await import('../../src/cli/commands.js');
    const { NOT_INTERACTIVE, NO_PORTAL } = await import('../helpers/fakes.js');
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['--launch', 'recipe=keeper'], {
      env: { ASHA_HOME: home },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      fetch: globalThis.fetch,
      root: d.root,
      version: 't',
      build: 'test-build-1',
      pid: process.pid,
      startDaemon,
      createLogger: () => d.logger,
      dependencies: () => {
        throw new Error('not used');
      },
      shutdownSignals: () => () => undefined,
      spawnServer: () => Promise.reject(new Error('not used')),
      kill: () => undefined,
      isAlive: () => true,
      sleep: () => Promise.resolve(),
      // No process holds any pid a test names: a stopping lookup finds no asha daemon (debt-paydown R15).
      processCommand: () => Promise.resolve(null),
      timing: {
        serverStartMs: 1_000,
        serverStopMs: 1_000,
        streamIdleMs: 5_000,
        pollMs: 10,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
      ...NOT_INTERACTIVE,
      ...NO_PORTAL,
      loginName: () => 'olga',
      // The folder asha runs in, and the home ~/ names: the test's own temporary home (agent-files R1, R12a).
      cwd: () => home,
      homeDir: () => home,
    });
    expect(code).toBe(0);
    expect(out).toEqual(['keep-1\n', 'done: do task 3\n']);
    expect(err).toEqual(['› resuming your message from 2026-09-28T09:00:00.000Z\n']);
  });
});

describe("a user's message to a persisted agent whose record is full (R9 (a); A8 test 8)", () => {
  it("is refused by the message stream's error event, pending_full, nothing posted", async () => {
    // The agent never finishes its first delivery: every later one waits in its record.
    const d = await daemon({ handler: hanging });
    const launched = (await events(await control(d, Routes.agents, { channel: 'main', recipe: 'keeper' }))) as {
      events: LaunchEvent[];
      heartbeats: number;
    };
    expect(present(launched.events.at(-1), 'launched.events.at(-1)').type).toBe('launched');
    const aborts: AbortController[] = [];
    for (let i = 0; i < 32; i += 1) {
      const abort = new AbortController();
      aborts.push(abort);
      const r = await control(
        d,
        Routes.conversations,
        { user: 'ivy', channel: 'main', message: `m${String(i)}` },
        abort.signal,
      );
      expect(r.status).toBe(200);
    }
    await until(() => {
      expect(d.logger.entries.filter((e) => e.event === 'channel.posted' && e.fields['kind'] === 'input')).toHaveLength(
        32,
      );
    });
    const posted = d.logger.events().filter((e) => e === 'channel.posted').length;
    const refused = (await events(
      await control(d, Routes.conversations, { user: 'ivy', channel: 'main', message: 'one too many' }),
    )) as { events: ConversationEvent[]; heartbeats: number };
    expect(refused.events).toEqual([
      {
        type: 'error',
        reason: 'pending_full',
        detail: "agent main/-/keeper's record of unsaved deliveries is full: at most 32 entries and 4194304 bytes",
      },
    ]);
    expect(d.logger.events().filter((e) => e === 'channel.posted')).toHaveLength(posted);
    expect(d.logger.events('error')).toEqual([]);
    for (const a of aborts) a.abort();
  });
});

describe('the state routes (R5, R16; A4, A16)', () => {
  it('lists as JSON; refuses a reset naming an online identity, 409 online, removing nothing; resets once it is gone', async () => {
    const d = await daemon({ handler: replies });
    await events(await control(d, Routes.agents, { channel: 'main', recipe: 'keeper' }));
    // One checkpoint: a delivery and its ack.
    await converse(d, { user: 'ivy', channel: 'main', message: 'hello' }, replied);
    await until(async () => {
      expect(((await (await control(d, Routes.state)).json()) as { assets: unknown[] }).assets.length).toBeGreaterThan(
        0,
      );
    });
    const listed = (await (await control(d, Routes.state)).json()) as {
      assets: { identity: string; asset: string }[];
      totalBytes: number;
    };
    expect(listed.assets.map((a) => `${a.identity} ${a.asset}`)).toEqual([
      'main/-/keeper memory',
      'main/-/keeper workspace',
    ]);
    const refused = await control(d, Routes.stateReset, { channel: 'main', name: 'keeper' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'main/-/keeper is online; stop it first (asha --stop)',
      reason: 'online',
    });
    const erase = await control(d, Routes.stateReset, { channel: 'main', name: 'keeper', user: 'ivy' });
    expect(erase.status).toBe(409);
    expect(await erase.json()).toEqual({
      error: 'main/-/keeper is online; stop it first (asha --stop)',
      reason: 'online',
    });
    // Its container exits: offline, the reset succeeds.
    d.runtime.exit(present(d.runtime.starts[0], 'd.runtime.starts[0]').name, 0);
    await until(async () => {
      expect((await control(d, Routes.stateReset, { channel: 'main', name: 'keeper' })).status).toBe(200);
    });
    expect(((await (await control(d, Routes.state)).json()) as { assets: unknown[] }).assets).toEqual([]);
  });

  it.each([
    [{ channel: '../x' }, 'channel=../x is not a valid channel name'],
    [{ channel: 'main', team: 'x' }, 'team= needs name='],
    [{ all: true, user: 'ivy' }, 'user= needs channel=: a user ID names a person only on one channel'],
    [{ all: false }, 'all must be true when given'],
    [
      { channel: 'main', user: 'Ivy' },
      'a user ID is 1 to 32 characters: a lowercase letter, then lowercase letters, digits or hyphens',
    ],
    [{ channel: 'main', extra: 1 }, 'unknown field(s): extra'],
  ])('refuses %j, 400, before any path is formed', async (body, error) => {
    const d = await daemon({ handler: replies });
    const r = await control(d, Routes.stateReset, body);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error });
  });

  it('answers an erase as a stream of its events with heartbeats, and nothing_matches with 409', async () => {
    const d = await daemon({ handler: replies });
    const none = await control(d, Routes.stateReset, { channel: 'main', user: 'ivy' });
    expect([none.status, await none.json()]).toEqual([
      409,
      { error: 'nothing saved matches channel=main', reason: 'nothing_matches' },
    ]);
    await events(await control(d, Routes.agents, { channel: 'main', recipe: 'keeper' }));
    await converse(d, { user: 'ivy', channel: 'main', message: 'hello' }, replied);
    await until(async () => {
      expect(((await (await control(d, Routes.state)).json()) as { assets: unknown[] }).assets).toHaveLength(2);
    });
    d.runtime.exit(present(d.runtime.starts[0], 'd.runtime.starts[0]').name, 0);
    // A slow one-shot: heartbeats keep the stream alive while it works.
    d.runtime.onOneShot = async (_s, memory) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        run: { kind: 'exited', code: 0, stdout: '{"erased":{"files":0,"bytes":0}}\n', overflow: false },
        memoryAfter: memory,
      };
    };
    // Its container exits on its own: offline.
    await until(() => {
      expect(d.logger.events('error')).toContain('agent.exited_unexpectedly');
    });
    const erase = await control(d, Routes.stateReset, { channel: 'main', name: 'keeper', user: 'ivy' });
    expect([erase.status, erase.headers.get('content-type')]).toEqual([200, 'text/event-stream']);
    const { events: seen, heartbeats } = (await events(erase)) as { events: StateEraseEvent[]; heartbeats: number };
    expect(heartbeats).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual({ type: 'erase_done' });
  });
});

describe("no user ID and no user's text in a failure event, or in R9's events (R9 (h), R15; A15)", () => {
  it("zora drives the channel's failure paths — a delivery timeout, an agent that exits mid-delivery, an unknown to= — and no warn or error record holds zora", async () => {
    const d = await daemon({ handler: hanging });
    await events(await control(d, Routes.agents, { channel: 'main', recipe: 'greeter' }));
    const unknown = await converse(
      d,
      { user: 'zora', channel: 'main', to: 'nobody-1', message: 'zora asks nobody' },
      (e) => e.type === 'error',
    );
    expect(unknown.at(-1)).toMatchObject({ type: 'error', reason: 'unknown_handle' });
    // A delivery the agent never finishes: its 2 s bound expires; then an agent that exits holding one.
    const abort = new AbortController();
    await control(d, Routes.conversations, { user: 'zora', channel: 'main', message: 'zora waits' }, abort.signal);
    await until(() => {
      expect(d.logger.events('error')).toContain('channel.delivery_timeout');
    }, 10_000);
    await events(await control(d, Routes.agents, { channel: 'main', recipe: 'greeter' }));
    const again = new AbortController();
    await control(d, Routes.conversations, { user: 'zora', channel: 'main', message: 'zora again' }, again.signal);
    // The unknown to= was refused before posting: two inputs posted.
    await until(() => {
      expect(d.logger.entries.filter((e) => e.event === 'channel.posted' && e.fields['kind'] === 'input')).toHaveLength(
        2,
      );
    });
    d.runtime.exit(present(d.runtime.starts.at(-1), 'd.runtime.starts.at(-1)').name, 1);
    await until(() => {
      expect(d.logger.events('error')).toContain('agent.exited_unexpectedly');
    });
    abort.abort();
    again.abort();
    const failures = d.logger.entries.filter((e) => e.level !== 'info');
    expect(failures.length).toBeGreaterThan(0);
    for (const e of failures)
      expect(
        JSON.stringify({
          event: e.event,
          fields: e.fields,
          error: String((e.fields['error'] as Error | undefined)?.message),
        }),
        e.event,
      ).not.toContain('zora');
  }, 20_000);

  /** Makes every container whose name matches `which` print zora's line and exit 1 before coming online. */
  function dying(d: Daemon, which: RegExp): void {
    const start = d.runtime.onStart;
    d.runtime.onStart = (spec: ContainerSpec) => {
      if (!which.test(spec.name)) {
        start(spec);
        return;
      }
      queueMicrotask(() => {
        (async () => {
          await appendFile(spec.logFile, 'pass: zora asked\n');
          d.runtime.exit(spec.name, 1);
        })().catch(() => undefined);
      });
    };
  }

  /** The error records: none holds zora, and each names the container's log file. */
  function noZora(d: Daemon, events: readonly string[]): void {
    const records = d.logger.entries.filter((e) => events.includes(e.event));
    expect(records.map((e) => e.event).sort(byCodeUnit)).toEqual([...events].sort(byCodeUnit));
    for (const e of d.logger.entries.filter((x) => x.level !== 'info')) {
      // As the daemon's log line holds it: the error serialized by the logger's serializeError (name, message, stack, cause).
      const text = JSON.stringify({
        ...e.fields,
        ...(e.fields['error'] === undefined ? {} : { error: serializeError(e.fields['error']) }),
      });
      expect(text, e.event).not.toContain('zora');
    }
    for (const e of records) expect((e.fields['error'] as Error).message, e.event).toMatch(/its log: \S+\.log/);
  }

  it("a recipe's launch whose container prints zora's line and exits: launch.failed names the log, holds no zora; the stream's detail carries the tail", async () => {
    const d = await daemon({ handler: replies });
    dying(d, /-hewo-|-greeter-/);
    const { events: seen } = (await events(
      await control(d, Routes.agents, { channel: 'main', recipe: 'greeter' }),
    )) as { events: LaunchEvent[]; heartbeats: number };
    expect(seen.at(-1)).toMatchObject({
      type: 'error',
      reason: 'agent_start',
      detail: expect.stringContaining('pass: zora asked') as string,
    });
    noZora(d, ['agent.exited_unexpectedly', 'launch.failed']);
  });

  it("a message with recipe= whose agent exits before coming online: conversation.agent_unavailable holds no zora; the stream's detail carries the tail", async () => {
    const d = await daemon({ handler: replies });
    dying(d, /./);
    const seen = await converse(
      d,
      { user: 'ivy', channel: 'main', recipe: 'greeter', message: 'hello' },
      (e) => e.type === 'error',
    );
    expect(seen.at(-1)).toMatchObject({
      type: 'error',
      reason: 'agent_start',
      detail: expect.stringContaining('pass: zora asked') as string,
    });
    noZora(d, ['agent.exited_unexpectedly', 'conversation.agent_unavailable']);
  });

  it("a team's launch whose second member exits: team.launch_failed and launch.failed hold no zora; the stream's detail carries the tail", async () => {
    const d = await daemon({ handler: replies });
    dying(d, /-bea-/);
    const { events: seen } = (await events(await control(d, Routes.agents, { channel: 'main', team: 'pair' }))) as {
      events: LaunchEvent[];
      heartbeats: number;
    };
    expect(seen.at(-1)).toMatchObject({
      type: 'error',
      reason: 'agent_start',
      detail: expect.stringContaining('pass: zora asked') as string,
    });
    noZora(d, ['agent.exited_unexpectedly', 'team.launch_failed', 'launch.failed']);
  });

  it("a message of zora's re-sent after a restart: neither zora nor its text in any of R9's records", async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-int-p-'));
    await plantedResend(home, 'secret plan of zora', 'zora');
    const d = await daemon({ home, handler: replies });
    await events(await control(d, Routes.agents, { channel: 'main', recipe: 'keeper', followResent: true }));
    const r9 = d.logger.entries.filter((e) => /^state\.(pending_|redeliver)/.test(e.event));
    expect(r9.map((e) => e.event)).toEqual(['state.pending_found', 'state.redelivered']);
    for (const e of r9) expect(JSON.stringify(e.fields)).not.toMatch(/zora|secret plan/);
  });
});

describe("the git-tree check at the daemon's start (R2; A2)", () => {
  it('with no persist used and no state/, a daemon in a git tree starts, launches, answers — and the check never runs', async () => {
    const seen: string[] = [];
    const d = await daemon({ handler: replies, insideGitTree: (path) => Promise.resolve((seen.push(path), true)) });
    await events(await control(d, Routes.agents, { channel: 'main', recipe: 'greeter' }));
    const answered = await converse(d, { user: 'ivy', channel: 'main', message: 'hello' }, replied);
    expect(answered.find(replied)).toMatchObject({ message: { text: 'done: hello', to: 'ivy' } });
    expect(seen).toEqual([]);
  });

  it('refuses a persisted launch in a git tree, state_inside_git_tree, naming the directory; and a start once state/ exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-int-p-'));
    const d = await daemon({ home, handler: replies, insideGitTree: () => Promise.resolve(true) });
    const launched = (await events(await control(d, Routes.agents, { channel: 'main', recipe: 'keeper' }))) as {
      events: LaunchEvent[];
      heartbeats: number;
    };
    expect(launched.events.at(-1)).toEqual({
      type: 'error',
      reason: 'state_inside_git_tree',
      detail: new StateInsideGitTree(join(home, 'state')).message,
    });
    await d.daemon.stop();
    running.splice(0);
    await mkdir(join(home, 'state'), { recursive: true });
    await expect(daemon({ home, handler: replies, insideGitTree: () => Promise.resolve(true) })).rejects.toThrow(
      new StateInsideGitTree(join(home, 'state')),
    );
  });

  it('logs state.pending_orphaned at start for a record whose recipe no longer persists anything', async () => {
    const root = await persistenceRoot();
    const home = await mkdtemp(join(tmpdir(), 'asha-int-p-'));
    await plantedResend(home, 'x');
    const recipe = JSON.parse(await readFile(join(root, 'recipes', 'keeper.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(root, 'recipes', 'keeper.json'), JSON.stringify({ ...recipe, persist: [] }));
    const d = await daemon({ root, home, handler: replies });
    expect(
      d.logger.entries.filter((e) => e.event === 'state.pending_orphaned').map((e) => [e.level, e.fields]),
    ).toEqual([['warn', { identity: 'main/-/keeper' }]]);
  });

  it('removes a stray temporary under state/ at start, state.orphan_removed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-int-p-'));
    await plantedResend(home, 'x');
    await writeFile(
      join(home, 'state', 'agents', 'main', '-', 'keeper', '.current.json.4242.00ff00ff00ff00ff.tmp'),
      '{',
    );
    const d = await daemon({ home, handler: replies });
    expect(d.logger.entries.filter((e) => e.event === 'state.orphan_removed').map((e) => e.fields)).toEqual([
      { kind: 'agent', identity: 'main/-/keeper', file: '.current.json.4242.00ff00ff00ff00ff.tmp' },
    ]);
  });
});

// Keeps the erase event type in use for the stream test's readers.
export type { StateEraseEvent };
