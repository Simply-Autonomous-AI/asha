// The daemon's stop order (the stop-time race: docs/plans/enterprise-targets.md, F2).
// An agent's work in flight when the daemon stops — here a background model call
// after its reply, as the memory image's remember makes — must complete: the
// daemon stops its agents first, while it still answers them and the model
// servers still run, and stops the model servers only once every agent has exited.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentTelemetry,
  HarnessClient,
  TRACE_LIMITS,
  serveAgent,
  type AgentProcess,
} from '../../src/agent-sdk/index.js';
import { startDaemon } from '../../src/daemon/compose.js';
import { present } from '../../src/shared/assert-present.js';
import { harnessPaths } from '../../src/shared/paths.js';
import {
  AGENT_CHAT_TIMEOUT_MS,
  AGENT_DRAIN_MS,
  AGENT_STOP_GRACE_MS,
  Routes,
  type ChatResponse,
} from '../../src/shared/protocol.js';
import {
  FakeModelServer,
  FakeRuntime,
  FakeStore,
  REAL_STATE,
  TEST_LIFETIME,
  fixtureRoot,
} from '../helpers/daemon-fakes.js';
import { ManualSchedule, RecordingAgentLog, RecordingLogger } from '../helpers/fakes.js';
import { llamaChunks, sseText } from '../helpers/llama-stream.js';
import { portalStub } from '../helpers/portal-folders.js';

/** What happened, in order, across the daemon, the agent and the model server. */
const order: string[] = [];

class OrderedModelServer extends FakeModelServer {
  override async stopAll(): Promise<void> {
    order.push('model servers stopped');
    await super.stopAll();
  }
}

let model: Server | undefined;

afterEach(async () => {
  order.length = 0;
  const server = model;
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  model = undefined;
});

/** A daemon with one in-process agent that has replied and has a background model call held at the model. */
async function replied(drainMs: number) {
  // The model: the reply turn answers at once; the background call is held until the test releases it.
  let releaseBackground!: () => void;
  const backgroundHeld = new Promise<void>((r) => (releaseBackground = r));
  let backgroundAsked!: () => void;
  const asked = new Promise<void>((r) => (backgroundAsked = r));
  model = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const background = body.includes('remember this');
      void (async () => {
        if (background) {
          order.push('model call begun');
          backgroundAsked();
          await backgroundHeld;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseText(llamaChunks({ content: [background ? 'remembered' : 'hi'] })));
      })();
    });
  });
  const server = model;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const home = await mkdtemp(join(tmpdir(), 'asha-stop-'));
  const logger = new RecordingLogger();
  const runtime = new FakeRuntime('127.0.0.1');
  const agentLog = new RecordingAgentLog();
  const agentLogInfo = agentLog.info.bind(agentLog);
  agentLog.info = (event, fields) => {
    agentLogInfo(event, fields);
    if (event === 'agent.draining') order.push('agent draining');
  };
  const terminators = new Map<string, () => void>();
  const agentRuns: Promise<unknown>[] = [];
  let background: Promise<ChatResponse> | undefined;
  // The "container": the real agent SDK in-process. SIGTERM (runtime.stop) reaches serveAgent's listener; its exit is the container's.
  runtime.onStart = (spec) => {
    const environment = {
      harnessUrl: present(spec.env['ASHA_URL'], 'ASHA_URL'),
      agentToken: present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN'),
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
    const proc: AgentProcess = {
      onTerminate: (listener) => {
        terminators.set(spec.name, listener);
        return () => undefined;
      },
      exit: (code) => {
        order.push(`container exited ${String(code)}`);
        runtime.exit(spec.name, code);
      },
    };
    // After its exit (a real process's end) the daemon closes the stream, which this in-process agent sees as an error.
    agentRuns.push(
      serveAgent({
        client,
        telemetry,
        name: 'greeter',
        process: proc,
        imageTools: {
          manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
          handlers: {},
        },
        workspace: home,
        channelSpace: null,
        log: agentLog,
        drainMs,
        handler: async (delivery, context) => {
          await context.post({ conversation: delivery.message.conversation, kind: 'output', text: 'Hello World.' });
          background = context.model.chat({ messages: [{ role: 'user', content: 'remember this' }], maxTokens: 8 });
          context.background('memory.remember', background);
        },
      }).then(
        () => 'returned',
        (error: unknown) => (order.includes('container exited 143') ? 'stream closed after exit' : error),
      ),
    );
  };
  runtime.onStop = (name) => {
    order.push('SIGTERM');
    present(terminators.get(name), `a terminator for ${name}`)();
    return Promise.resolve();
  };
  const modelServer = new OrderedModelServer(`http://127.0.0.1:${String((model.address() as AddressInfo).port)}`);
  const paths = harnessPaths({ ASHA_HOME: home });
  const daemon = await startDaemon({
    paths,
    root: await fixtureRoot(),
    version: 't',
    build: 't',
    pid: process.pid,
    logger,
    dependencies: { runtime, modelServer, store: new FakeStore(), ...REAL_STATE, fetch: globalThis.fetch },
    heartbeatMs: 1_000,
    chatTimeoutMs: 5_000,
    schedule: new ManualSchedule().schedule,
    lifetime: TEST_LIFETIME,
    portal: await portalStub(),
  });
  const { credential } = JSON.parse(await readFile(paths.daemonFile, 'utf8')) as { credential: string };

  const hangUp = new AbortController();
  const answer = await fetch(`http://127.0.0.1:${String(daemon.port)}${Routes.conversations}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ channel: 'main', recipe: 'greeter', message: 'Please say: Hello World.' }),
    signal: hangUp.signal,
  });
  expect(answer.status).toBe(200);
  // The conversation streams until the caller hangs up: read until the agent has acked (working is empty again).
  let seen = '';
  const decoder = new TextDecoder();
  for await (const chunk of answer.body as AsyncIterable<Uint8Array>) {
    seen += decoder.decode(chunk, { stream: true });
    if (seen.includes('Hello World.') && /"type":"status","conversation":"[^"]+","working":\[\]/.test(seen)) break;
  }
  // Hang up as the CLI does, and see the daemon log it before the stop begins: the record's place in the log is then
  // fixed, not wherever the socket happened to close (conversation.closed, written since 2026-09-30).
  hangUp.abort();
  await vi.waitFor(
    () => {
      expect(logger.events()).toContain('conversation.closed');
    },
    { timeout: 2_000, interval: 10 },
  );
  // The reply is out and acked, and the background model call is in flight when the daemon is told to stop.
  await asked;

  return {
    daemon,
    credential,
    logger,
    agentLog,
    modelServer,
    agentRuns,
    releaseBackground,
    background: () => background,
  };
}

describe('the daemon stop order', () => {
  it("bounds an agent's drain to cover one whole model call and its span flush, inside its container's stop grace", () => {
    expect([AGENT_CHAT_TIMEOUT_MS, AGENT_DRAIN_MS, AGENT_STOP_GRACE_MS]).toEqual([60_000, 65_000, 70_000]);
    // A call begun just before SIGTERM can finish at its own bound, and its span be flushed.
    expect(AGENT_DRAIN_MS).toBeGreaterThanOrEqual(AGENT_CHAT_TIMEOUT_MS + TRACE_LIMITS.flushTimeoutMs);
    // The agent exits by itself, having logged what it left, before it is killed.
    expect(AGENT_DRAIN_MS).toBeLessThan(AGENT_STOP_GRACE_MS);
  });

  it("stops model servers only after every agent has exited, serves an agent's in-flight model call to completion meanwhile, and starts nothing new", async () => {
    const { daemon, credential, logger, agentLog, modelServer, agentRuns, releaseBackground, background } =
      await replied(5_000);

    const stopped = daemon.stop();
    await vi.waitFor(() => {
      expect(order).toContain('agent draining');
    });
    // Draining: the agent still has its model server, and nothing new starts — the control API answers 503.
    expect(modelServer.stopped).toBe(0);
    const late = await fetch(`http://127.0.0.1:${String(daemon.port)}${Routes.conversations}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({ channel: 'main', message: 'Please say: Hello World.' }),
    });
    expect(late.status).toBe(503);
    expect(await late.json()).toEqual({ error: 'the daemon is stopping', reason: 'stopping' });
    // The board's read too (docs/plans/patterns-phase-4.md R2): answered 503 before its handler.
    const board = await fetch(`http://127.0.0.1:${String(daemon.port)}${Routes.blackboard}?channel=main`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect([board.status, await board.json()]).toEqual([503, { error: 'the daemon is stopping', reason: 'stopping' }]);
    releaseBackground();
    await stopped;

    expect(await background()).toEqual({ ok: true, text: 'remembered', toolCalls: [] });
    expect(order).toEqual([
      'model call begun',
      'SIGTERM',
      'agent draining',
      'container exited 143',
      'model servers stopped',
    ]);
    expect(modelServer.stopped).toBe(1);
    expect(await Promise.all(agentRuns)).toEqual(['stream closed after exit']);
    expect(logger.entries.filter((e) => e.level === 'error')).toEqual([]);
    expect(agentLog.entries.filter((e) => e.level === 'error')).toEqual([]);
    const events = logger.events();
    expect(events.slice(events.indexOf('daemon.stopping'))).toEqual([
      'daemon.stopping',
      'agent.stopping',
      'model.chat',
      'channel.left',
      'agent.exited',
      'daemon.stopped',
    ]);
  });

  it('when the drain bound passes first, the agent names the lost work at error, and the daemon abandons its call (warn) before it stops the model servers', async () => {
    const { daemon, logger, agentLog, modelServer, releaseBackground, background } = await replied(100);

    await daemon.stop();
    releaseBackground();

    // The agent's own record of what it left undone.
    expect(agentLog.entries.filter((e) => e.level === 'error').map((e) => [e.event, e.fields['unfinished']])).toEqual([
      ['agent.drain_incomplete', ['memory.remember']],
    ]);
    expect(order).toEqual([
      'model call begun',
      'SIGTERM',
      'agent draining',
      'container exited 143',
      'model servers stopped',
    ]);
    expect(modelServer.stopped).toBe(1);
    // The daemon's call for it ended when the agent exited, named as abandoned — not a model failure after the stop.
    expect(logger.entries.filter((e) => e.level === 'error')).toEqual([]);
    const events = logger.events();
    expect(events.slice(events.indexOf('daemon.stopping'))).toEqual([
      'daemon.stopping',
      'agent.stopping',
      'channel.left',
      'agent.exited',
      'model.call_abandoned',
      'daemon.stopped',
    ]);
    expect(
      present(
        logger.entries.find((e) => e.event === 'model.call_abandoned'),
        'the model.call_abandoned entry',
      ).fields,
    ).toMatchObject({
      call: 'chat',
      detail: 'abandoned: the calling agent exited',
    });
    // What the agent's own call got back, had it still been there to read it.
    expect((await present(background(), 'the background call')).ok).toBe(false);
  });
});
