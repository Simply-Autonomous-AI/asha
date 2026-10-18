// The real daemon on a loopback port, exercised over its real wire contract.
// Container runtime, model store and model server are fakes — but the fake
// container runs the real hello-world agent (SDK + handler) against the daemon
// over HTTP, and the "model server" is a real HTTP server speaking the
// OpenAI chat-completions shape, so every hop an agent's reply takes is real.

import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentTelemetry,
  HarnessClient,
  LIST_AGENTS_TOOL,
  PASS_TOOL,
  REPLY_TOOL,
  GUIDANCE_PRECEDENCE,
  channelInstructions,
  sendMessageTool,
  consultTool,
  serveAgent,
  type AgentProcess,
  type DeliveryHandler,
} from '../../src/agent-sdk/index.js';
import { EXIT, runCli, type CliContext } from '../../src/cli/commands.js';
import { readLines } from '../../src/cli/interactive.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon/compose.js';
import type { LifetimeOptions } from '../../src/daemon/lifetime.js';
import { LockHeld } from '../../src/daemon/process/pid-lock.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { harnessPaths, type HarnessPaths } from '../../src/shared/paths.js';
import type { ContainerSpec } from '../../src/daemon/container-runtime/index.js';
import { NAME, handleHelloWorld } from '../../images/hello-world/src/agent.js';
import {
  FIXTURE_CHAT_DEFAULTS,
  FIXTURE_RECIPE,
  FIXTURE_TOOL_CALL_START,
  FakeModelServer,
  FakeRuntime,
  FakeStore,
  REAL_STATE,
  TEST_LIFETIME,
  fixtureRoot,
} from '../helpers/daemon-fakes.js';
import { ManualSchedule, NOT_INTERACTIVE, NO_PORTAL, RecordingAgentLog, RecordingLogger } from '../helpers/fakes.js';
import { llamaChunks, scriptOf, sseText } from '../helpers/llama-stream.js';
import { SseDecoder } from '../../src/shared/sse.js';
import { Routes, type ChannelStopEvent, type ConversationEvent, type Delivery } from '../../src/shared/protocol.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { builtPortal } from '../helpers/portal-folders.js';

interface Harness {
  root: string;
  daemon: RunningDaemon;
  base: string;
  paths: HarnessPaths;
  runtime: FakeRuntime;
  modelServer: FakeModelServer;
  logger: RecordingLogger;
  /** The control credential, read from daemon.json as the CLI reads it. */
  credential: string;
  /** Ends refusal-logging windows when the test says. */
  clock: ManualSchedule;
  modelRequests: unknown[];
  /** The prompt-store requests (D44), `/tokenize` and `/completion`, kept apart from the chats and embeddings. */
  storeRequests: { readonly url: string; readonly body: unknown }[];
  agentsDone: Promise<unknown>[];
  /** Every line the in-process agents' telemetry wrote: an export failure each. */
  traceLines: string[];
  cli: (argv: string[], lines?: readonly string[]) => Promise<{ code: number; out: string; err: string }>;
}

interface FakeModelRequest {
  messages: { role: string; content: string; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
  tool_choice?: string;
}

/**
 * The conversation a request carries. When it requires a tool call, the harness sends the assistant
 * turn already opened with the model's tool-call marker; that prefill is checked and is not a turn.
 */
function conversation(request: FakeModelRequest): FakeModelRequest['messages'] {
  if (request.tool_choice !== 'required') return request.messages;
  expect(request.messages.at(-1)).toEqual({ role: 'assistant', content: FIXTURE_TOOL_CALL_START });
  return request.messages.slice(0, -1);
}

/**
 * A stand-in for the model that answers the way the channel instructions ask:
 * "ask hewo-2 to …" → a task for hewo-2; any request to say Hello World → the
 * answer, to the user; anything else → no call. It reads only the incoming
 * message, so the harness plumbing is what these tests exercise.
 */
function fakeModel(request: FakeModelRequest): unknown {
  const last = present(conversation(request).at(-1), 'conversation(request).at(-1)');
  const incoming = present(
    request.messages.find((m) => m.role === 'user'),
    "request.messages.find((m) => m.role === 'user')",
  ).content;
  // An answer for the user is a reply; anything else is a send_message.
  const call = (to: string, text: string) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      to === 'user'
        ? { type: 'function', id: 'c1', function: { name: 'reply', arguments: JSON.stringify({ text }) } }
        : { type: 'function', id: 'c1', function: { name: 'send_message', arguments: JSON.stringify({ to, text }) } },
    ],
  });
  // "the agent that translates": look the agents up first, then pick by description.
  if (/the agent that translates/i.test(incoming)) {
    if (last.role !== 'tool') {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', id: 'l1', function: { name: 'list_agents', arguments: '{}' } }],
      };
    }
    const roster = JSON.parse(last.content) as { handle: string; description: string }[];
    return call(
      present(
        roster.find((a) => /translat/i.test(a.description)),
        'the translating agent in the roster',
      ).handle,
      'Put Hello World into French.',
    );
  }
  // "wrong destination": first a message to an agent that isn't there; once the harness sends back the error, a reply.
  if (/wrong destination/i.test(incoming)) {
    return last.role === 'tool' && last.content.startsWith('error: ')
      ? call('user', 'Corrected.')
      : call('hewo-9', 'Hello?');
  }
  // An agent offered ask_user (patterns-phase-3 R23): "ask me first" → asks; the user's answer → a reply quoting it.
  const answered = /^The user answered what you asked them:\n(.*)\n/.exec(
    last.role === 'user' ? present(last.content.split('\n\n').at(-1), "last.content.split('\\n\\n').at(-1)") : '',
  );
  if (answered !== null) return call('user', `You said: ${present(answered[1], 'answered[1]')}`);
  if (/ask me first/i.test(incoming) && request.tools?.some((t) => t.function.name === 'ask_user')) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        { type: 'function', id: 'a1', function: { name: 'ask_user', arguments: JSON.stringify({ text: 'Shall I?' }) } },
      ],
    };
  }
  if (/ask hewo-2/i.test(incoming)) return call('hewo-2', 'Please say: Hello World.');
  if (/hello world/i.test(incoming)) return call('user', 'Hello World!');
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      { type: 'function', id: 'p1', function: { name: 'pass', arguments: JSON.stringify({ reason: 'not my role' }) } },
    ],
  };
}

let model: Server;
let modelRequests: unknown[];
let storeRequests: { readonly url: string; readonly body: unknown }[];
/** When a test sets it, how the fake model answers a chat instead of fakeModel: the SSE text, or 'hang' (headers, then nothing). */
let modelStream: ((request: FakeModelRequest) => string | readonly string[]) | undefined;

/** A fakeModel answer as llama-server streams it: its fragments, a usage chunk and [DONE]. */
function streamOf(message: unknown): string {
  return sseText(
    llamaChunks({
      ...scriptOf(message as Parameters<typeof scriptOf>[0]),
      usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
    }),
  );
}
let h: Harness;

/** In-process agents have no image tools, one writable workspace, no channel space, and a recorded log. */
const NO_IMAGE_TOOLS = {
  manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
  handlers: {},
} as const;
const WORKSPACE = await mkdtemp(join(tmpdir(), 'asha-int-workspace-'));
const agentLog = new RecordingAgentLog();

/** An in-process agent is never sent SIGTERM. */
const NO_SIGNALS: AgentProcess = { onTerminate: () => () => undefined, exit: () => undefined };

/** Runs the real agent SDK in-process against the daemon, as a container would: spans to its traces route. */
function runAgent(
  spec: ContainerSpec,
  handler: DeliveryHandler,
  done: Promise<unknown>[],
  traceLines: string[],
  name = NAME,
): void {
  const environment = {
    harnessUrl: present(spec.env['ASHA_URL'], "spec.env['ASHA_URL']"),
    agentToken: present(spec.env['ASHA_AGENT_TOKEN'], "spec.env['ASHA_AGENT_TOKEN']"),
  };
  const telemetry = AgentTelemetry.forHarness(environment, (line) => traceLines.push(line));
  const client = new HarnessClient({
    environment,
    chatTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    filesRequestTimeoutMs: 30_000,
    streamIdleTimeoutMs: 5_000,
    fetch: globalThis.fetch,
    telemetry,
  });
  // The in-process "container": ends when the daemon closes its stream.
  done.push(
    serveAgent({
      client,
      telemetry,
      name,
      handler,
      process: NO_SIGNALS,
      imageTools: NO_IMAGE_TOOLS,
      workspace: WORKSPACE,
      channelSpace: null,
      log: agentLog,
      drainMs: 5_000,
    }).catch((error: unknown) => error),
  );
}

/** What each started "container" does. Default: run the real hello-world agent. */
function agentRunner(handler: DeliveryHandler, done: Promise<unknown>[], traceLines: string[], name = NAME) {
  return (spec: ContainerSpec) => {
    runAgent(spec, handler, done, traceLines, name);
  };
}

async function start(existingHome?: string): Promise<Harness> {
  const root = await fixtureRoot();
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), 'asha-int-')));
  const paths = harnessPaths({ ASHA_HOME: home });
  const logger = new RecordingLogger();
  const runtime = new FakeRuntime('127.0.0.1');
  const modelServer = new FakeModelServer(`http://127.0.0.1:${String((model.address() as AddressInfo).port)}`);
  const agentsDone: Promise<unknown>[] = [];
  const traceLines: string[] = [];
  runtime.onStart = agentRunner(handleHelloWorld, agentsDone, traceLines);
  const clock = new ManualSchedule();
  const daemon = await startDaemon({
    paths,
    root,
    version: '0.0.0-test',
    build: 'test-build-1',
    pid: process.pid,
    logger,
    dependencies: { runtime, modelServer, store: new FakeStore(), ...REAL_STATE, fetch: globalThis.fetch },
    heartbeatMs: 1_000,
    chatTimeoutMs: 5_000,
    schedule: clock.schedule,
    lifetime: TEST_LIFETIME,
    portal: builtPortal(),
  });
  const credential = (JSON.parse(await readFile(paths.daemonFile, 'utf8')) as { credential: string }).credential;
  /** Runs the CLI against this daemon; `lines` are piped to --interactive through the real line reader. */
  const cli = async (argv: string[], lines?: readonly string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CliContext = {
      env: { ASHA_HOME: home },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      fetch: globalThis.fetch,
      root,
      version: '0.0.0-test',
      build: 'test-build-1',
      pid: process.pid,
      startDaemon,
      createLogger: () => logger,
      dependencies: () => {
        throw new Error('not used');
      },
      shutdownSignals: () => () => undefined,
      spawnServer: () => Promise.reject(new Error('the daemon is already running; the CLI must not spawn another')),
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
      // The CLI's default user (cli-interactive R16): a message without user= carries this login name.
      loginName: () => 'olga',
      // The folder asha runs in, and the home ~/ names: the test's own temporary home (agent-files R1, R12a).
      cwd: () => home,
      homeDir: () => home,
      ...(lines === undefined
        ? {}
        : {
            input: { lines: readLines(PassThrough.from(lines.map((line) => `${line}\n`).join(''))), isTerminal: false },
          }),
    };
    // These tests read what happened on the channel from the progress lines, which only --verbose prints.
    const code = await runCli(['--verbose', ...argv], ctx);
    return { code, out: out.join(''), err: err.join('') };
  };
  return {
    root,
    daemon,
    base: `http://127.0.0.1:${String(daemon.port)}`,
    paths,
    runtime,
    modelServer,
    logger,
    credential,
    clock,
    modelRequests,
    storeRequests,
    agentsDone,
    traceLines,
    cli,
  };
}

beforeEach(async () => {
  modelRequests = [];
  storeRequests = [];
  model = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const request = JSON.parse(body) as FakeModelRequest;
      // The prompt-store request (D44), answered as llama-server 0.5.0 answers it: a token id, then one token.
      if (req.url === '/tokenize' || req.url === '/completion') {
        storeRequests.push({ url: req.url, body: request });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/tokenize' ? { tokens: [13] } : { content: ' x' }));
        return;
      }
      modelRequests.push({ url: req.url, body: request });
      if (req.url === '/v1/embeddings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        // A vector per input, from its length, in reverse order with indexes: the gateway must order by index.
        const input = (request as unknown as { input: string[] }).input;
        const data = input.map((text, index) => ({ index, embedding: [text.length, 1, 0, index] })).reverse();
        res.end(JSON.stringify({ data }));
        return;
      }
      // A chat is streamed, as llama-server streams it (model-streaming R1); a test may script the stream itself.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const scripted = modelStream?.(request);
      if (scripted === 'hang') {
        res.flushHeaders();
        return;
      }
      if (Array.isArray(scripted)) {
        // Chunk by chunk, the event loop turning between them, as a server generating tokens writes them.
        void (async () => {
          for (const piece of scripted) {
            res.write(piece);
            await new Promise((resolve) => setImmediate(resolve));
          }
          res.end();
        })();
        return;
      }
      res.end(scripted ?? streamOf(fakeModel(request)));
    });
  });
  modelStream = undefined;
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  h = await start();
});

afterEach(async () => {
  await h.daemon.stop();
  await Promise.all(h.agentsDone);
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
});

const post = (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) =>
  fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });

/** The conversations the daemon started, in order (from its log). */
const conversations = (): string[] =>
  h.logger.entries.filter((e) => e.event === 'conversation.started').map((e) => String(e.fields['conversation']));

/** A traceparent header naming a caller's span in the conversation's trace. */
const inTrace = (conversation: string, spanId = 'c'.repeat(16)) => ({
  traceparent: `00-${traceIdFor(conversation)}-${spanId}-01`,
});

/** A control API call as the CLI makes it: with the credential from daemon.json. */
const control = (path: string, init: RequestInit = {}) =>
  fetch(`${h.base}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${h.credential}` },
  });

/**
 * A control-API conversation with no `user`, as a client other than the CLI sends it: the daemon issues the ID, and
 * this returns it from the stream's `posted` event, then hangs up (the stream stays open until the client does).
 */
async function issuedUser(message: string): Promise<string> {
  const controller = new AbortController();
  const response = await control(Routes.conversations, {
    method: 'POST',
    body: JSON.stringify({ channel: 'main', message }),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  try {
    for await (const event of controlEvents(response)) {
      if (event.type === 'posted') return (event as Extract<ConversationEvent, { type: 'posted' }>).message.user;
    }
    throw new Error('the conversation stream ended with no posted event');
  } finally {
    controller.abort();
  }
}

/** The events of a control-API stream, parsed as the CLI parses them: server-sent events (model-streaming R5). */
async function* controlEvents(response: Response): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  for await (const chunk of present<ReadableStream<Uint8Array>>(response.body, 'response body')) {
    for (const event of sse.push(decoder.decode(chunk, { stream: true })))
      yield event as { type: string; [key: string]: unknown };
  }
}

/**
 * A request with exactly the headers given — `host` included, or none at all
 * with `setHost: false` — which fetch cannot send.
 */
function raw(
  method: string,
  path: string,
  headers: Record<string, string>,
  options: { setHost?: boolean; body?: string } = {},
) {
  return new Promise<{ status: number; body: string }>((resolveRaw, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: h.daemon.port, method, path, headers, setHost: options.setHost ?? true },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          resolveRaw({ status: present(res.statusCode, 'res.statusCode'), body });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** The http.refused records, as [reason, api, method, path, count]. */
const refusals = () =>
  h.logger.entries
    .filter((e) => e.event === 'http.refused')
    .map((e) => {
      expect(e.level).toBe('warn');
      return [e.fields['reason'], e.fields['api'], e.fields['method'], e.fields['path'], e.fields['count']];
    });

/** Nothing any refused request could have caused: no launch, no conversation, no stream, no user. */
function expectNoAction() {
  expect(h.runtime.readyPorts).toEqual([]);
  expect(h.runtime.starts).toEqual([]);
  expect(h.modelServer.served).toEqual([]);
  expect(
    h.logger.events().filter((e) => e !== 'http.refused' && e !== 'daemon.started' && e !== 'lock.stale_cleared'),
  ).toEqual([]);
}

async function converse() {
  return h.cli(['recipe=greeter', 'message=Please say: Hello World.']);
}

describe('the daemon over HTTP', () => {
  it('GET /v1/health reports pid, version and online agents', async () => {
    const before = await (await control('/v1/health')).json();
    expect(before).toEqual({
      ok: true,
      pid: process.pid,
      version: '0.0.0-test',
      build: 'test-build-1',
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as string,
      agents: [],
    });

    await converse();
    const after = (await (await control('/v1/health')).json()) as { agents: { id: string }[] };
    expect(after.agents).toEqual([{ handle: 'hewo-1', channel: 'main', recipe: 'greeter', image: 'greeter-image' }]);
  });

  it('a conversation brings the agent online, routes its model call through the harness, and prints the reply', async () => {
    const result = await converse();

    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe('Hello World!\n');
    expect(result.err.split('\n')).toEqual([
      '› container_runtime: ready',
      '› model: tiny-model cached',
      '› model_server: tiny-model serving',
      '› image: asha-image-greeter-image built',
      '› hewo-1: Hi',
      '› olga → main: Please say: Hello World.',
      // The model's output as it streamed (model-streaming R7): the reply tool's arguments, in two fragments on one line.
      '› hewo-1 reply: {"text":"Hello World!"}',
      '› hewo-1: ok',
      '› output hewo-1 → olga:',
      '',
    ]);
    // The model server saw exactly one request, shaped by the catalogue.
    expect(h.modelRequests).toEqual([
      {
        url: '/v1/chat/completions',
        body: {
          ...FIXTURE_CHAT_DEFAULTS,
          ...FIXTURE_RECIPE.chat,
          model: 'tiny-model',
          messages: [
            { role: 'system', content: channelInstructions('hewo-1', [], FIXTURE_RECIPE.prompt) },
            { role: 'user', content: 'The user wrote:\nPlease say: Hello World.' },
            // A required tool call: the assistant turn is opened with the catalogue's tool-call marker.
            { role: 'assistant', content: FIXTURE_TOOL_CALL_START },
          ],
          // hello-world's MAX_TOKENS: 1,024 since agent-calls R20.
          max_tokens: 1_024,
          tools: [REPLY_TOOL, LIST_AGENTS_TOOL, PASS_TOOL],
          tool_choice: 'required',
          stream: true,
          stream_options: { include_usage: true },
          return_progress: true,
        },
      },
    ]);
    // After the recipe's first answered call, the server is asked once to store its idle slots' prompts (D44).
    await vi.waitFor(() => {
      expect(h.logger.events()).toContain('model.prompt_stored');
    });
    expect(h.storeRequests).toEqual([
      { url: '/tokenize', body: { content: '.' } },
      { url: '/completion', body: { prompt: [13], n_predict: 1 } },
    ]);
    expect(h.logger.events()).toEqual(expect.arrayContaining(['agent.online', 'conversation.started', 'model.chat']));
    expect(h.logger.events('error')).toEqual([]);
  });

  it('a second conversation reuses the online agent', async () => {
    await converse();
    const second = await converse();
    expect(second.code).toBe(EXIT.ok);
    expect(second.err).toContain('already online');
    expect(h.runtime.starts).toHaveLength(1);
    expect(h.modelRequests).toHaveLength(2);
    // One store request for the recipe on this server, not one per call.
    await vi.waitFor(() => {
      expect(h.logger.events()).toContain('model.prompt_stored');
    });
    expect(h.storeRequests.map((r) => r.url)).toEqual(['/tokenize', '/completion']);
  });

  it('GET /v1/channel streams every join and message to a watcher', async () => {
    const controller = new AbortController();
    const response = await control('/v1/channel?name=main', { signal: controller.signal });
    expect(response.status).toBe(200);
    const events: { type: string; [key: string]: unknown }[] = [];
    const reading = (async () => {
      try {
        for await (const event of controlEvents(response)) events.push(event);
      } catch (error) {
        // This test aborts the stream once it has seen enough; anything else is a failure.
        if (!controller.signal.aborted) throw error;
      }
    })();

    await converse();
    controller.abort();
    await reading;

    const conversation = present(
      h.logger.entries.find((e) => e.event === 'conversation.started'),
      'the conversation.started entry',
    ).fields['conversation'] as string;
    const call = events.find((e) => e.type === 'model_done')?.['call'];
    const shown = events.map((e) => {
      if (e.type === 'message') {
        return {
          type: 'message',
          from: (e['message'] as { from: string }).from,
          kind: (e['message'] as { kind: string }).kind,
          text: (e['message'] as { text: string }).text,
        };
      }
      // A model event names its conversation, from the call's trace, and its call, the asha.chat span (model-streaming R3, R4).
      if (e.type === 'model_delta' || e.type === 'model_done') {
        expect([e['conversation'], e['call']]).toEqual([conversation, call]);
        const rest = { ...e };
        delete rest['conversation'];
        delete rest['call'];
        return rest;
      }
      return e;
    });
    expect(call).toMatch(/^[0-9a-f]{16}$/);
    expect(shown).toEqual([
      { type: 'watching', channel: 'main', agents: [] },
      { type: 'agent_joined', agent: 'hewo-1' },
      { type: 'message', from: 'hewo-1', kind: 'status', text: 'Hi' },
      { type: 'message', from: 'olga', kind: 'input', text: 'Please say: Hello World.' },
      // The model's output as it streamed, the reply tool's arguments in two fragments, then the call's end.
      {
        type: 'model_delta',
        handle: 'hewo-1',
        seq: 0,
        part: 'tool_args',
        index: 0,
        name: 'reply',
        text: '{"text":"Hel',
      },
      {
        type: 'model_delta',
        handle: 'hewo-1',
        seq: 1,
        part: 'tool_args',
        index: 0,
        name: 'reply',
        text: 'lo World!"}',
      },
      { type: 'model_done', handle: 'hewo-1', outcome: 'ok' },
      { type: 'message', from: 'hewo-1', kind: 'status', text: 'ok' },
      { type: 'message', from: 'hewo-1', kind: 'output', text: 'Hello World!' },
    ]);
  });

  it('channel= keeps agents apart: the same recipe on another channel is a separate agent', async () => {
    const main = await converse();
    const lab = await h.cli(['recipe=greeter', 'channel=lab', 'message=Please say: Hello World.']);

    expect(main.code).toBe(EXIT.ok);
    expect(lab.code).toBe(EXIT.ok);
    expect(lab.err).toContain('› hewo-1: Hi');
    expect(h.runtime.starts).toHaveLength(2);
    const health = (await (await control('/v1/health')).json()) as { agents: unknown[] };
    expect(health.agents).toEqual([
      { handle: 'hewo-1', channel: 'lab', recipe: 'greeter', image: 'greeter-image' },
      { handle: 'hewo-1', channel: 'main', recipe: 'greeter', image: 'greeter-image' },
    ]);
  });

  it('to= addresses one agent, which is the only one that receives it and works on it', async () => {
    // Two agents on one channel: a second recipe running the same image joins as hewo-2.
    await writeFile(
      join(h.root, 'recipes', 'greeter-two.json'),
      JSON.stringify({ ...FIXTURE_RECIPE, id: 'greeter-two' }),
    );
    await converse();
    const second = await h.cli(['recipe=greeter-two', 'message=Please say: Hello World.']);
    expect(second.code).toBe(EXIT.ok);
    const before = h.modelRequests.length;

    const direct = await h.cli(['user=user-1', 'to=hewo-2', 'message=Please say: Hello World.']);

    expect(direct.code).toBe(EXIT.ok);
    expect(direct.out).toBe('Hello World!\n');
    expect(direct.err).toBe(
      '› user-1 → hewo-2 on main: Please say: Hello World.\n› hewo-2 reply: {"text":"Hello World!"}\n› hewo-2: ok\n› output hewo-2 → user-1:\n',
    );
    expect(h.modelRequests.length - before).toBe(1);
  });

  it('--launch starts a new instance each time and prints its handle', async () => {
    const first = await h.cli(['--launch', 'recipe=greeter']);
    const second = await h.cli(['--launch', 'recipe=greeter']);
    expect([first.code, first.out, second.code, second.out]).toEqual([EXIT.ok, 'hewo-1\n', EXIT.ok, 'hewo-2\n']);
    expect(second.err).toContain('› hewo-2: Hi');
    expect(h.runtime.starts).toHaveLength(2);
  });

  it('the two-agent hello world: hewo-1 passes the request to hewo-2, which answers the user', async () => {
    await h.cli(['--launch', 'recipe=greeter']);
    await h.cli(['--launch', 'recipe=greeter']);

    const result = await h.cli(['to=hewo-1', 'message=Please ask hewo-2 to say Hello World.']);

    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe('Hello World!\n');
    expect(result.err.split('\n')).toEqual([
      '› olga → hewo-1 on main: Please ask hewo-2 to say Hello World.',
      // Each agent's model output as it streamed (model-streaming R7): the tool's name, then its raw arguments.
      '› hewo-1 send_message: {"to":"hewo-2","text":"Please say: Hello World."}',
      '› hewo-1: ok',
      '› internal hewo-1 → hewo-2: Please say: Hello World.',
      '› hewo-2 reply: {"text":"Hello World!"}',
      '› hewo-2: ok',
      '› output hewo-2 → olga:',
      '',
    ]);
    // hewo-1 saw hewo-2 on its roster, so its request offered reply, and send_message with hewo-2 as a destination.
    const [toHewo1Maybe, toHewo2Maybe] = h.modelRequests as { body: FakeModelRequest & { tools: unknown[] } }[];
    const toHewo1 = present(toHewo1Maybe, 'toHewo1');
    const toHewo2 = present(toHewo2Maybe, 'toHewo2');
    expect(toHewo1.body.tools).toEqual([
      REPLY_TOOL,
      sendMessageTool(['hewo-1', 'hewo-2']),
      consultTool(['hewo-1', 'hewo-2']),
      LIST_AGENTS_TOOL,
      PASS_TOOL,
    ]);
    // hewo-2 is offered the same tools, byte for byte: nothing of either agent's own is in them (prompt-prefix R3, R8).
    expect(JSON.stringify(toHewo2.body.tools)).toBe(JSON.stringify(toHewo1.body.tools));
    expect(present(conversation(toHewo2.body).at(-1), 'conversation(toHewo2.body).at(-1)').content).toBe(
      'You are hewo-2, an agent in a chat shared by the user and other agents, with the role given above.\n\nAgent hewo-1 wrote to you:\nPlease say: Hello World.',
    );
  });

  it("a budget of 1 post: hewo-1's message to hewo-2 is the conversation's one agent post, hewo-2's reply is refused, and the CLI prints ✗ budget_exceeded and exits 1 (patterns-phase-3 R15, R16, R18, R19)", async () => {
    await h.cli(['--launch', 'recipe=greeter']);
    await h.cli(['--launch', 'recipe=greeter']);
    const before = conversations().length;

    const result = await h.cli(['to=hewo-1', 'posts=1', 'message=Please ask hewo-2 to say Hello World.']);

    const c = present(conversations()[before], 'conversations()[before]');
    expect(result.code).toBe(EXIT.failed);
    expect(result.out).toBe('');
    expect(result.err).toContain('› internal hewo-1 → hewo-2: Please say: Hello World.\n');
    expect(result.err).toContain(`✗ budget_exceeded: conversation ${c} reached its budget of 1 agent posts\n`);
    expect(result.err).not.toContain('› output');
    expect(h.logger.entries.filter((e) => e.level === 'error').map((e) => e.event)).toEqual([
      'channel.conversation_ended',
    ]);
    expect(
      present(
        h.logger.entries.find((e) => e.event === 'channel.conversation_ended'),
        'the channel.conversation_ended entry',
      ).fields,
    ).toMatchObject({
      channel: 'main',
      conversation: c,
      reason: 'budget_exceeded',
    });
    // hewo-2's turn ended normally on the refusal (R19): it stays online and answers the next message; it never left.
    const next = await h.cli(['to=hewo-2', 'message=Please say: Hello World.']);
    expect([next.code, next.out]).toEqual([EXIT.ok, 'Hello World!\n']);
    expect(h.logger.entries.filter((e) => e.event === 'channel.left')).toEqual([]);
  });

  it('list_agents: an agent looks up who is online by what they do, then delegates to the translator', async () => {
    await writeFile(
      join(h.root, 'recipes', 'translator.json'),
      JSON.stringify({ ...FIXTURE_RECIPE, id: 'translator', description: 'Translates text into French.' }),
    );
    await h.cli(['--launch', 'recipe=greeter']);
    await h.cli(['--launch', 'recipe=translator']);

    const result = await h.cli([
      'to=hewo-1',
      'message=Please ask the agent that translates to put Hello World into French.',
    ]);

    expect(result.code).toBe(EXIT.ok);
    expect(result.err).toContain('› internal hewo-1 → hewo-2: Put Hello World into French.');
    // hewo-1's second model call carried the roster, with each agent's recipe and description, as the list_agents result.
    const toolTurn = present(
      (h.modelRequests as { body: FakeModelRequest }[])
        .map((r) => present(conversation(r.body).at(-1), 'conversation(r.body).at(-1)'))
        .find((m) => m.role === 'tool'),
      'the tool turn among h.modelRequests',
    );
    expect(JSON.parse(toolTurn.content)).toEqual([
      { handle: 'hewo-2', recipe: 'translator', description: 'Translates text into French.' },
    ]);
  });

  it("GET /agent/v1/channel/agents lists the other agents on the caller's channel", async () => {
    await h.cli(['--launch', 'recipe=greeter']);
    await h.cli(['--launch', 'recipe=greeter']);
    const token = present(
      present(h.runtime.starts[0], 'h.runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
      "h.runtime.starts[0].env['ASHA_AGENT_TOKEN']",
    );
    const response = await fetch(`${h.base}/agent/v1/channel/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [{ handle: 'hewo-2', recipe: 'greeter', description: 'Greets whoever asks.' }],
    });
  });

  it('POST /v1/agents reports an unknown recipe as a typed error', async () => {
    const result = await h.cli(['--launch', 'recipe=nope']);
    expect(result.code).toBe(EXIT.failed);
    expect(result.err).toBe('✗ unknown_recipe: no recipe named "nope" (no recipes/nope.json)\n');
  });

  it('--interactive posts each line as one message from one user, through the real daemon, until /quit', async () => {
    const result = await h.cli(
      ['--interactive', 'user=alice', 'recipe=greeter'],
      ['Please say: Hello World.', '', 'Please say: Hello World.', '/quit', 'Please say: never sent.'],
    );
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe('Hello World!\nHello World!\n');
    expect(result.err.split('\n').filter((line) => line.includes('→'))).toEqual([
      '› alice → main: Please say: Hello World.',
      '› output hewo-1 → alice:',
      '› alice → main: Please say: Hello World.',
      '› output hewo-1 → alice:',
    ]);
    // One agent brought online by the first message's recipe= and reused by the second; two model calls; one user.
    expect(h.runtime.starts).toHaveLength(1);
    expect(h.modelRequests).toHaveLength(2);
    expect(h.logger.entries.filter((e) => e.event === 'channel.user_online').map((e) => e.fields['user'])).toEqual([
      'alice',
      'alice',
    ]);
  });

  it('user= names the asker, and the reply is addressed to them', async () => {
    await converse();
    const result = await h.cli(['user=alice', 'message=Please say: Hello World.']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.err).toContain('› alice → main: Please say: Hello World.');
    expect(result.err).toContain('› output hewo-1 → alice:');
  });

  // The daemon's contract is unchanged by the CLI's default (cli-interactive R16, A15 (b)): a control-API
  // conversation with no user is still issued user-<n>, and two at once get different IDs.
  it('two control-API users asking at once, with no user, are issued different IDs', async () => {
    await converse();
    const ids = await Promise.all([issuedUser('Please say: Hello World.'), issuedUser('Please say: Hello World.')]);
    // The CLI's message spoke as the login name, so no ID had been issued yet.
    expect(ids.sort()).toEqual(['user-1', 'user-2']);
  });

  it('the CLI speaks as the login name, not an issued ID (cli-interactive R16)', async () => {
    const result = await converse();
    expect(result.err).toContain('› olga → main: Please say: Hello World.');
    expect(h.logger.entries.filter((e) => e.event === 'channel.user_online').map((e) => e.fields['user'])).toEqual([
      'olga',
    ]);
  });

  it('to= a handle not on the channel fails with unknown_handle', async () => {
    await converse();
    const result = await h.cli(['to=ghost-1', 'message=hi']);
    expect(result.code).toBe(EXIT.failed);
    expect(result.err).toBe('✗ unknown_handle: no agent "ghost-1" on channel "main"\n');
  });

  it('refuses a malformed channel name with 400', async () => {
    const response = await control('/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ channel: 'Bad Name', message: 'hi' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.stringContaining('"Bad Name" is not a valid channel name') as string,
    });
  });

  it('an unknown recipe ends the conversation with a typed error', async () => {
    const result = await h.cli(['recipe=nope', 'message=hi']);
    expect(result.code).toBe(EXIT.failed);
    expect(result.err).toBe('✗ unknown_recipe: no recipe named "nope" (no recipes/nope.json)\n');
    expect(h.logger.events('error')).toEqual(['conversation.agent_unavailable']);
  });

  it('an agent that crashes on a message is reported as leaving, and the CLI fails', async () => {
    h.runtime.onStart = agentRunner(() => Promise.reject(new Error('boom')), h.agentsDone, h.traceLines);
    // Simulate the container exiting when its agent loop dies.
    const started = h.runtime.onStart;
    h.runtime.onStart = (spec) => {
      started(spec);
      const done = present(h.agentsDone.at(-1), 'h.agentsDone.at(-1)');
      void done.then(() => {
        h.runtime.exit(spec.name, 1);
      });
    };

    const result = await converse();

    expect(result.code).toBe(EXIT.failed);
    // The harness answers, saying the agent left before replying and why.
    expect(result.out).toMatch(
      /^No agent could answer this:\n- hewo-1 left the channel before replying \((container exited with code 1|channel stream closed)\)\n$/,
    );
    expect(result.err).not.toContain('✗');
  });

  it('an invalid destination goes back to the model with the valid ones; its corrected reply reaches the user', async () => {
    // Two agents, so send_message is offered (alone it is not, and a call to it would be refused as not offered).
    await h.cli(['--launch', 'recipe=greeter']);
    await h.cli(['--launch', 'recipe=greeter']);
    const result = await h.cli(['to=hewo-1', 'message=Use the wrong destination first.']);

    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe('Corrected.\n');
    // Two model calls for the one message; the second carried the error and the valid destinations.
    const bodies = h.modelRequests.map((r) => (r as { body: FakeModelRequest }).body);
    expect(bodies).toHaveLength(2);
    expect(conversation(present(bodies[1], 'bodies[1]')).at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'error: "hewo-9" is not a destination. The valid destinations are: all-agents, hewo-2.',
    });
    // Nothing from the invalid turn was posted: only the model's streamed output shows the draft decide() refused —
    // deltas carry drafts no message carries (model-streaming, decided with question 2's consequence).
    const deltaLine = /^› hewo-1 (send_message|reply): /;
    expect(
      result.err
        .split('\n')
        .filter((l) => !deltaLine.test(l))
        .join('\n'),
    ).not.toContain('hewo-9');
    expect(result.err.split('\n').filter((l) => deltaLine.test(l))).toEqual([
      '› hewo-1 send_message: {"to":"hewo-9","text":"Hello?"}',
      '› hewo-1 reply: {"text":"Corrected."}',
    ]);
  });

  it('an agent that passes says so, and the harness tells the user nobody could answer', async () => {
    const result = await h.cli(['recipe=greeter', 'message=Please translate this contract into French.']);

    expect(result.code).toBe(EXIT.failed);
    expect(result.out).toBe('No agent could answer this:\n- hewo-1 passed: not my role\n');
    expect(result.err).toContain(
      '› olga → main: Please translate this contract into French.\n› hewo-1 pass: {"reason":"not my role"}\n› hewo-1: pass: not my role\n› output asha → olga:\n',
    );
    expect(result.err).not.toContain('✗');
  });

  it.each([
    ['not JSON', 'nope', 400, 'body is not valid JSON'],
    ['an unknown field', { recipe: 'r', message: 'm', image: 'x' }, 400, 'unknown field(s): image'],
    ['an empty message', { channel: 'main', recipe: 'r', message: '' }, 400, 'message must be a non-empty string'],
    ['a missing channel', { recipe: 'r', message: 'm' }, 400, 'channel must be a non-empty string'],
    [
      'a user ID shaped like an agent handle',
      { user: 'hewo-3', channel: 'main', message: 'm' },
      400,
      expect.stringContaining('"hewo-3" cannot be a user ID'),
    ],
  ])('POST /v1/conversations rejects %s', async (_, body, status, error: unknown) => {
    const response = await control('/v1/conversations', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  // patterns-phase-3 R15: a budget is a closed object, at least one key, each a whole number in its range; else 400, nothing posted.
  it.each([
    ['posts 0', { posts: 0 }],
    ['posts 33', { posts: 33 }],
    ['tokens 0', { tokens: 0 }],
    ['tokens 1,000,001', { tokens: 1_000_001 }],
    ['a fraction', { posts: 1.5 }],
    ['a string', { posts: '8' }],
    ['an unknown key', { posts: 8, turns: 2 }],
    ['no key', {}],
    ['a number', 8],
  ])('POST /v1/conversations rejects a budget of %s with 400, posting nothing', async (_, budget) => {
    const response = await control('/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ channel: 'main', message: 'm', budget }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'budget is {"posts": <1–32>, "tokens": <1–1000000>}, each a whole number, at least one of them',
    });
    expect(conversations()).toEqual([]);
  });

  it('answers an unknown route, with the credential, with 404', async () => {
    const response = await control('/v1/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no route for GET /v1/nope' });
  });

  describe('the agent API', () => {
    it.each(['/agent/v1/channel/messages', '/agent/v1/channel/ack', '/agent/v1/model/chat', '/agent/v1/model/embed'])(
      'POST %s refuses a missing or unknown token with 401',
      async (route) => {
        expect((await post(route, {})).status).toBe(401);
        expect((await post(route, {}, 'not-a-token')).status).toBe(401);
      },
    );

    it('GET /agent/v1/channel refuses a missing token with 401', async () => {
      expect((await fetch(`${h.base}/agent/v1/channel`)).status).toBe(401);
    });

    describe('with a live agent token', () => {
      let token: string;
      beforeEach(async () => {
        await converse();
        token = present(
          present(h.runtime.starts[0], 'h.runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
          "h.runtime.starts[0].env['ASHA_AGENT_TOKEN']",
        );
      });

      it('POST /agent/v1/model/chat answers through the model server', async () => {
        const response = await post(
          '/agent/v1/model/chat',
          { messages: [{ role: 'user', content: 'Please say: Hello World.' }], maxTokens: 4 },
          token,
          inTrace(present(conversations()[0], 'conversations()[0]')),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          ok: true,
          text: '',
          toolCalls: [{ id: 'c1', name: 'reply', arguments: { text: 'Hello World!' } }],
        });
      });

      it('POST /agent/v1/model/embed refuses an agent whose recipe names no embedding model (400)', async () => {
        const response = await post(
          '/agent/v1/model/embed',
          { texts: ['hi'], purpose: 'query' },
          token,
          inTrace(present(conversations()[0], 'conversations()[0]')),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'recipe "greeter" names no embeddingModel' });
      });

      it('POST /agent/v1/model/embed rejects a malformed request with 400', async () => {
        for (const [body, error] of [
          [{ texts: [], purpose: 'query' }, 'texts must be 1..64 non-empty strings'],
          [{ texts: ['a'], purpose: 'guess' }, 'purpose must be "query" or "document"'],
          [{ texts: ['a'], purpose: 'query', model: 'x' }, 'unknown embed field(s): model'],
        ] as const) {
          const response = await post(
            '/agent/v1/model/embed',
            body,
            token,
            inTrace(present(conversations()[0], 'conversations()[0]')),
          );
          expect([response.status, await response.json()]).toEqual([400, { error }]);
        }
      });

      it('POST /agent/v1/model/chat rejects a malformed request with 400', async () => {
        const response = await post(
          '/agent/v1/model/chat',
          { messages: [] },
          token,
          inTrace(present(conversations()[0], 'conversations()[0]')),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'messages must be a non-empty array' });
      });

      it('POST /agent/v1/channel/messages rejects a bad kind (400) and an unknown conversation (409)', async () => {
        const badKind = await post(
          '/agent/v1/channel/messages',
          { conversation: 'c', kind: 'input', text: 't' },
          token,
        );
        expect(badKind.status).toBe(400);
        expect(await badKind.json()).toEqual({ error: 'kind must be "internal", "output" or "status"' });
        const unknown = await post(
          '/agent/v1/channel/messages',
          { conversation: 'nope', kind: 'output', text: 't' },
          token,
          inTrace('nope'),
        );
        expect(unknown.status).toBe(409);
        expect(await unknown.json()).toEqual({ error: 'unknown conversation nope' });
      });

      it('POST /agent/v1/channel/ack rejects a delivery the agent does not hold with 409', async () => {
        const response = await post('/agent/v1/channel/ack', { deliveryId: 'nope' }, token);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'hewo-1 holds no delivery nope' });
      });

      it('GET /agent/v1/channel refuses a second stream for the same agent with 400', async () => {
        const response = await fetch(`${h.base}/agent/v1/channel?name=hewo`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'hewo-1 already has a channel stream open' });
      });
    });
  });

  it('an agent whose recipe names an embedding model gets it served, and embeds through the harness', async () => {
    await h.cli(['--launch', 'recipe=rememberer']);
    expect(h.modelServer.served).toEqual(['tiny-model', 'tiny-embed']);
    const token = present(
      present(h.runtime.starts[0], 'h.runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
      "h.runtime.starts[0].env['ASHA_AGENT_TOKEN']",
    );
    // An embedding call belongs to a conversation delivered to the agent (otel-traces R2a).
    await h.cli(['message=Please say: Hello World.']);
    const trace = inTrace(present(conversations()[0], 'conversations()[0]'));

    const query = await post('/agent/v1/model/embed', { texts: ['colour', 'my name'], purpose: 'query' }, token, trace);
    expect(query.status).toBe(200);
    // The query template was applied ("Q: " + text), and vectors came back in input order.
    expect(await query.json()).toEqual({
      ok: true,
      vectors: [
        [9, 1, 0, 0],
        [10, 1, 0, 1],
      ],
    });
    const document = await post('/agent/v1/model/embed', { texts: ['colour'], purpose: 'document' }, token, trace);
    expect(await document.json()).toEqual({ ok: true, vectors: [[6, 1, 0, 0]] });

    const requests = h.modelRequests
      .filter((r) => (r as { url: string }).url === '/v1/embeddings')
      .map((r) => (r as { body: unknown }).body);
    expect(requests).toEqual([
      { model: 'tiny-embed', input: ['Q: colour', 'Q: my name'] },
      { model: 'tiny-embed', input: ['colour'] },
    ]);
    expect(h.logger.events()).toEqual(expect.arrayContaining(['model.embed']));
  });

  it('refuses a second daemon on the same home', async () => {
    await expect(
      startDaemon({
        paths: h.paths,
        root: '/unused',
        version: 'x',
        build: 'x',
        pid: process.pid,
        logger: new RecordingLogger(),
        dependencies: {
          runtime: new FakeRuntime(),
          modelServer: new FakeModelServer('x'),
          store: new FakeStore(),
          ...REAL_STATE,
          fetch,
        },
        heartbeatMs: 1_000,
        chatTimeoutMs: 1_000,
        schedule: new ManualSchedule().schedule,
        lifetime: TEST_LIFETIME,
        portal: builtPortal(),
      }),
    ).rejects.toThrow(LockHeld);
  });

  it('stop() stops agents and model servers, and releases the home', async () => {
    await converse();
    const container = present(h.runtime.starts[0], 'h.runtime.starts[0]').name;
    expect(JSON.parse(await readFile(h.paths.daemonFile, 'utf8'))).toEqual({
      pid: process.pid,
      port: h.daemon.port,
      credential: h.credential,
    });
    expect(h.credential).toMatch(/^[0-9a-f]{64}$/);

    await h.daemon.stop();

    expect(h.runtime.stops).toEqual([container]);
    // This home's isolation is reclaimed at start, and again at stop once every agent is gone; the channel's file
    // space is created between the runtime's readiness and the first agent's start (agent-files R10).
    const space = (c: string) => /^(createVolume|volumeLabel|createHolder|copyIn|copyOut) asha-/.test(c);
    expect(h.runtime.calls.filter((c) => !space(c))).toEqual([
      'reclaim',
      'pruneImages',
      `ensureReady ${String(h.daemon.port)}`,
      `start ${container}`,
      `stop ${container} drain 70`,
      'reclaim',
    ]);
    expect(h.runtime.calls.findIndex(space)).toBe(3);
    expect(h.runtime.calls.findLastIndex(space)).toBeLessThan(h.runtime.calls.indexOf(`start ${container}`));
    expect(h.modelServer.stopped).toBe(1);
    await expect(stat(h.paths.daemonFile)).rejects.toThrow('ENOENT');
    await expect(stat(h.paths.daemonLock)).rejects.toThrow('ENOENT');
    // A restart on the same home must succeed, and must not reissue a user ID (users.json): issued before, and after.
    h = { ...h, ...(await start(h.paths.home)) };
    expect(await issuedUser('Please say: Hello World.')).toBe('user-1');
    await h.daemon.stop();
    h = { ...h, ...(await start(h.paths.home)) };
    expect(await issuedUser('Please say: Hello World.')).toBe('user-2');
  });

  describe('the guard: Host, Origin, the control credential and agent tokens (control-api-auth)', () => {
    /** Every control route, from the contract, plus one no route serves: a new route is covered without editing this test. */
    const CONTROL = [...Object.values(Routes).filter((p) => p.startsWith('/v1/')), '/v1/x'];
    const methodOf = (path: string) =>
      path === Routes.conversations ||
      path === Routes.agents ||
      path === Routes.stateReset ||
      path === Routes.channelSpace ||
      path === Routes.channelFiles ||
      path === Routes.modulesEnable ||
      path === Routes.stop ||
      path === Routes.channelStop ||
      path === Routes.portalErrors
        ? 'POST'
        : 'GET';
    const BODY = JSON.stringify({ channel: 'main', recipe: 'greeter', message: 'Please say: Hello World.' });

    /**
     * One credential-refusal attempt against `path` with `method`: the request `what` describes, sent with `init`;
     * the [what, status] pair A1's test logs for it (extracted to keep that test's cognitive complexity in bounds —
     * same requests, same checks, same pushed tuple).
     */
    async function attemptCredential(
      path: string,
      method: string,
      body: string | undefined,
      what: string,
      init: RequestInit,
    ): Promise<[string, number]> {
      let url: string;
      if (what === 'right, in the query only') {
        url = `${h.base}${path}?credential=${h.credential}&name=main`;
      } else {
        const suffix = path === Routes.channel ? '?name=main' : '';
        url = `${h.base}${path}${suffix}`;
      }
      const response = await fetch(url, {
        method,
        ...init,
        ...(method === 'POST'
          ? {
              body:
                what === 'right, in the body only'
                  ? JSON.stringify({ ...JSON.parse(BODY), credential: h.credential })
                  : body,
            }
          : {}),
      });
      // A route that let the request through may be streaming: only a refusal's body is read.
      if (response.status !== 401) await response.body?.cancel();
      const error =
        response.status === 401
          ? (((await response.json()) as { error?: string }).error ?? '')
          : `HTTP ${String(response.status)}`;
      const refusedRight = response.headers.get('www-authenticate') === 'Bearer' && /control credential/.test(error);
      const suffix = refusedRight ? '' : ` (answered ${JSON.stringify(error)})`;
      return [`${method} ${path}: ${what}${suffix}`, response.status];
    }

    it('refuses every /v1/ route without the right credential, sent only as Authorization: Bearer, and takes no action (A1)', async () => {
      // The portal's three control routes (docs/plans/portal.md R6, R10, R14; its A7) are entries of Routes, so this covers
      // them, portal-scene-chat's two read routes (R13, R16), and portal-demo-stop's channel stop (R1).
      expect(CONTROL).toEqual([
        '/v1/health',
        '/v1/conversations',
        '/v1/channel',
        '/v1/channel/space',
        '/v1/channel/files',
        '/v1/approvals',
        '/v1/modules/enable',
        '/v1/agents',
        '/v1/state',
        '/v1/state/reset',
        '/v1/stop',
        '/v1/channel/stop',
        '/v1/portal/errors',
        '/v1/telemetry',
        '/v1/blackboard',
        '/v1/definitions',
        '/v1/demos',
        '/v1/x',
      ]);
      const wrongSameLength = h.credential.replace(/./, (c) => (c === 'a' ? 'b' : 'a'));
      const sent: [string, number][] = [];
      for (const path of CONTROL) {
        const method = methodOf(path);
        const body = method === 'POST' ? BODY : undefined;
        const attempts: [string, RequestInit][] = [
          ['none', {}],
          ['wrong, same length', { headers: { authorization: `Bearer ${wrongSameLength}` } }],
          ['wrong, other length', { headers: { authorization: `Bearer ${h.credential}x` } }],
          ['right, in the query only', {}],
          ['right, in a cookie only', { headers: { cookie: `credential=${h.credential}` } }],
          ['right, in the body only', {}],
          ['not a bearer', { headers: { authorization: `Basic ${h.credential}` } }],
        ];
        for (const [what, init] of attempts) {
          sent.push(await attemptCredential(path, method, body, what, init));
        }
      }
      // Each offender is named: the route, how the credential was sent, and what it answered.
      expect(sent.filter(([what, status]) => status !== 401 || what.includes('(answered'))).toEqual([]);
      expect(sent).toHaveLength(CONTROL.length * 7);
      expectNoAction();
      // With the credential the unknown route is a 404: the guard ran first, then routing.
      expect((await control('/v1/x')).status).toBe(404);
    });

    it('refuses an agent token on /v1/ and the control credential on /agent/ (A2)', async () => {
      await h.cli(['--launch', 'recipe=greeter']);
      const token = present(
        present(h.runtime.starts[0], 'h.runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
        "h.runtime.starts[0].env['ASHA_AGENT_TOKEN']",
      );
      const starts = h.runtime.starts.length;

      const asAgent = await fetch(`${h.base}/v1/conversations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: BODY,
      });
      const asCli = await fetch(`${h.base}/agent/v1/channel?name=x`, {
        headers: { authorization: `Bearer ${h.credential}` },
      });

      expect([asAgent.status, asCli.status]).toEqual([401, 401]);
      expect(h.runtime.starts).toHaveLength(starts);
      expect(refusals()).toEqual([
        ['credential_invalid', 'v1', 'POST', '/v1/conversations', 1],
        ['token_invalid', 'agent', 'GET', '/agent/v1/channel', 1],
      ]);
    });

    it('answers 403 to a foreign Host or Origin before looking at the credential, and takes no action (A7)', async () => {
      await h.cli(['--launch', 'recipe=greeter']);
      const token = present(
        present(h.runtime.starts[0], 'h.runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
        "h.runtime.starts[0].env['ASHA_AGENT_TOKEN']",
      );
      const portNumber = h.daemon.port;
      const port = String(portNumber);
      const other = String(portNumber === 65_535 ? portNumber - 1 : portNumber + 1);
      const cred = { authorization: `Bearer ${h.credential}` };
      const tok = { authorization: `Bearer ${token}` };
      const roster = Routes.agentRoster;
      const cases: [string, Promise<{ status: number }>, number][] = [
        ['health, Host 127.0.0.1:port', raw('GET', '/v1/health', { ...cred, host: `127.0.0.1:${port}` }), 200],
        ['health, Host localhost:port', raw('GET', '/v1/health', { ...cred, host: `localhost:${port}` }), 200],
        [
          'health, Host host.docker.internal:port',
          raw('GET', '/v1/health', { ...cred, host: `host.docker.internal:${port}` }),
          403,
        ],
        ['health, Host evil.example:port', raw('GET', '/v1/health', { ...cred, host: `evil.example:${port}` }), 403],
        ['health, Host 127.0.0.1:another port', raw('GET', '/v1/health', { ...cred, host: `127.0.0.1:${other}` }), 403],
        ['health, no Host', raw('GET', '/v1/health', cred, { setHost: false }), 403],
        [
          'health, Origin 127.0.0.1:port',
          raw('GET', '/v1/health', { ...cred, origin: `http://127.0.0.1:${port}` }),
          200,
        ],
        [
          'health, Origin localhost:port',
          raw('GET', '/v1/health', { ...cred, origin: `http://localhost:${port}` }),
          200,
        ],
        ['health, Origin evil.example', raw('GET', '/v1/health', { ...cred, origin: 'http://evil.example' }), 403],
        ['health, Origin null', raw('GET', '/v1/health', { ...cred, origin: 'null' }), 403],
        [
          'health, Origin another port',
          raw('GET', '/v1/health', { ...cred, origin: `http://127.0.0.1:${other}` }),
          403,
        ],
        ['roster, Host evil.example:port', raw('GET', roster, { ...tok, host: `evil.example:${port}` }), 403],
        ['roster, Origin evil.example', raw('GET', roster, { ...tok, origin: 'http://evil.example' }), 403],
        [
          'conversation, foreign Host',
          raw(
            'POST',
            '/v1/conversations',
            { ...cred, host: `evil.example:${port}`, 'content-type': 'application/json' },
            { body: BODY },
          ),
          403,
        ],
        [
          'no credential and a foreign Host: the Host is refused first',
          raw('GET', '/v1/health', { host: `evil.example:${port}` }),
          403,
        ],
      ];
      const results = await Promise.all(
        cases.map(async ([what, answer, expected]) => [what, (await answer).status, expected] as const),
      );
      expect(results.filter(([, status, expected]) => status !== expected)).toEqual([]);
      expect(h.runtime.starts).toHaveLength(1);
      expect(h.modelServer.served).toEqual(['tiny-model']);
      expect(h.logger.events()).not.toContain('conversation.started');
    });

    /**
     * One foreign-Host/Origin attempt against `path` with `method`, `body` and `headers`: the `answered` line A7's
     * second test logs for it (extracted to keep that test's cognitive complexity in bounds — same request, same
     * line).
     */
    async function attemptForeign(
      path: string,
      method: string,
      body: string | undefined,
      what: string,
      headers: Record<string, string>,
    ): Promise<string> {
      let query = '';
      if (path === Routes.channel) query = '?name=main';
      else if (path === Routes.telemetry) query = '?channel=main';
      const answer = await raw(method, `${path}${query}`, headers, body === undefined ? {} : { body });
      return `${method} ${path} ${what}: ${String(answer.status)}`;
    }

    it('answers 403 to a foreign Host and to a foreign Origin on every /v1/ route of the contract, the credential sent, and takes no action (A7; portal A7)', async () => {
      const port = String(h.daemon.port);
      const cred = { authorization: `Bearer ${h.credential}` };
      const answered: string[] = [];
      for (const path of CONTROL) {
        const method = methodOf(path);
        const body = method === 'POST' ? BODY : undefined;
        const json: Record<string, string> = method === 'POST' ? { 'content-type': 'application/json' } : {};
        const cases: [string, Record<string, string>][] = [
          ['foreign Host', { ...cred, ...json, host: `evil.example:${port}` }],
          ['foreign Origin', { ...cred, ...json, origin: 'http://evil.example' }],
        ];
        for (const [what, headers] of cases) {
          answered.push(await attemptForeign(path, method, body, what, headers));
        }
      }
      expect(answered.filter((line) => !line.endsWith(': 403'))).toEqual([]);
      expect(answered).toHaveLength(CONTROL.length * 2);
      // No stop requested or begun, no client error logged: nothing but the refusals.
      expectNoAction();
    });

    it("accepts the containers' name for the host on /agent/ only (A7)", async () => {
      // A runtime whose containers call the host host.docker.internal, as colima's do.
      await h.daemon.stop();
      await Promise.all(h.agentsDone);
      const home = h.paths.home;
      const root = await fixtureRoot();
      const runtime = new FakeRuntime('host.docker.internal');
      const logger = new RecordingLogger();
      h.daemon = await startDaemon({
        paths: harnessPaths({ ASHA_HOME: home }),
        root,
        version: 't',
        build: 't',
        pid: process.pid,
        logger,
        dependencies: { runtime, modelServer: h.modelServer, store: new FakeStore(), ...REAL_STATE, fetch },
        heartbeatMs: 1_000,
        chatTimeoutMs: 1_000,
        schedule: new ManualSchedule().schedule,
        lifetime: TEST_LIFETIME,
        portal: builtPortal(),
      });
      const port = String(h.daemon.port);
      const credential = (JSON.parse(await readFile(h.paths.daemonFile, 'utf8')) as { credential: string }).credential;
      h = { ...h, credential, base: `http://127.0.0.1:${port}` };
      // A container's token, as the supervisor holds it, without a container: the roster needs a connected agent.
      runtime.onStart = (spec) => {
        runAgent(
          { ...spec, env: { ...spec.env, ASHA_URL: `http://127.0.0.1:${port}` } },
          handleHelloWorld,
          h.agentsDone,
          h.traceLines,
        );
      };
      const launched = await h.cli(['--launch', 'recipe=greeter']);
      expect(launched.code).toBe(EXIT.ok);
      const token = present(
        present(runtime.starts[0], 'runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
        "runtime.starts[0].env['ASHA_AGENT_TOKEN']",
      );
      expect(present(runtime.starts[0], 'runtime.starts[0]').env['ASHA_URL']).toBe(
        `http://host.docker.internal:${port}`,
      );

      const roster = await raw('GET', Routes.agentRoster, {
        authorization: `Bearer ${token}`,
        host: `host.docker.internal:${port}`,
      });
      const health = await raw('GET', '/v1/health', {
        authorization: `Bearer ${credential}`,
        host: `host.docker.internal:${port}`,
      });

      expect([roster.status, health.status]).toEqual([200, 403]);
      expect(JSON.parse(roster.body)).toEqual({ agents: [] });
    });

    it('logs each refusal as http.refused at warn, bounded per reason and API per window, never with a secret (A9)', async () => {
      await h.cli(['--launch', 'recipe=greeter']);
      const token = present(
        present(h.runtime.starts[0], 'h.runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
        "h.runtime.starts[0].env['ASHA_AGENT_TOKEN']",
      );
      const port = String(h.daemon.port);
      h.logger.entries.length = 0;

      await fetch(`${h.base}/v1/health`);
      await fetch(`${h.base}/v1/health?credential=${h.credential}`);
      await fetch(`${h.base}/v1/channel?name=main`, { headers: { authorization: `Bearer ${token}` } });
      await fetch(`${h.base}/agent/v1/channel/agents`);
      await fetch(`${h.base}/agent/v1/channel/agents`, { headers: { authorization: `Bearer ${h.credential}` } });
      await raw('GET', '/v1/health', { host: `evil.example:${port}` });
      await raw('GET', '/', { origin: 'http://evil.example' });

      // One record at once for each distinct reason and API, with the first request's method and path.
      expect(refusals()).toEqual([
        ['credential_missing', 'v1', 'GET', '/v1/health', 1],
        ['credential_invalid', 'v1', 'GET', '/v1/channel', 1],
        ['token_missing', 'agent', 'GET', '/agent/v1/channel/agents', 1],
        ['token_invalid', 'agent', 'GET', '/agent/v1/channel/agents', 1],
        ['host_forbidden', 'v1', 'GET', '/v1/health', 1],
        ['origin_forbidden', 'other', 'GET', '/', 1],
      ]);
      // The second credential_missing (credential in the query) is counted, and logged when its window ends.
      h.clock.fire();
      expect(refusals().at(-1)).toEqual(['credential_missing', 'v1', 'GET', '/v1/health', 1]);
      expect(refusals()).toHaveLength(7);
      const logged = JSON.stringify(h.logger.entries);
      expect(logged).not.toContain(h.credential);
      expect(logged).not.toContain(token);

      // A burst of 100 in one window: the first at once, the other 99 as one record when the window ends.
      h.clock.fire();
      h.logger.entries.length = 0;
      await Promise.all(
        Array.from({ length: 100 }, () => fetch(`${h.base}/v1/agents`, { method: 'POST', body: '{}' })),
      );
      expect(refusals()).toEqual([['credential_missing', 'v1', 'POST', '/v1/agents', 1]]);
      h.clock.fire();
      expect(refusals()).toEqual([
        ['credential_missing', 'v1', 'POST', '/v1/agents', 1],
        ['credential_missing', 'v1', 'POST', '/v1/agents', 99],
      ]);
      // A quiet window closes the key: the next refusal is logged at once again.
      h.clock.fire();
      await fetch(`${h.base}/v1/agents`, { method: 'POST', body: '{}' });
      expect(refusals()).toHaveLength(3);
      expect(refusals().at(-1)).toEqual(['credential_missing', 'v1', 'POST', '/v1/agents', 1]);
      expect(h.runtime.starts).toHaveLength(1);
    });

    it('never logs the credential, or any part of it, even from a refused path that holds it (A9)', async () => {
      // No credential header, so refused; the path holds the credential across the 200-character cut, its first 10 characters before it.
      await fetch(`${h.base}/v1/${'a'.repeat(186)}${h.credential}`);
      await fetch(`${h.base}/agent/${h.credential}`);
      const logged = JSON.stringify(h.logger.entries.filter((e) => e.event === 'http.refused'));
      expect(
        refusals().map(([reason, , , path]) => [
          reason,
          String(path).length <= 200,
          String(path).includes('<credential>'),
        ]),
      ).toEqual([
        ['credential_missing', true, false],
        ['token_missing', true, true],
      ]);
      expect(logged).not.toContain(h.credential.slice(0, 10));
    });

    it('logs the refusals still counted when the daemon stops (A9)', async () => {
      for (let i = 0; i < 5; i += 1) await fetch(`${h.base}/v1/health`);
      expect(refusals()).toEqual([['credential_missing', 'v1', 'GET', '/v1/health', 1]]);

      await h.daemon.stop();

      expect(refusals()).toEqual([
        ['credential_missing', 'v1', 'GET', '/v1/health', 1],
        ['credential_missing', 'v1', 'GET', '/v1/health', 4],
      ]);
      expect(h.clock.pending()).toEqual([]);
      // afterEach stops it again: a second stop of a stopped daemon must be harmless here, so restart.
      h = { ...h, ...(await start(h.paths.home)) };
    });
  });

  describe('traces (docs/plans/otel-traces.md A2: R2a, R3, R4, R9, R12)', () => {
    const R4_KEYS = [
      'traceId',
      'spanId',
      'parentSpanId',
      'name',
      'kind',
      'channel',
      'handle',
      'start',
      'end',
      'status',
      'reason',
    ];
    let token: string;
    let conversation: string;

    /** Every trace file in the home's logs, by name, with its contents. */
    const traceFiles = async (): Promise<Record<string, string>> => {
      const names = (await readdir(h.paths.logsDir))
        .filter((n) => /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .sort(byCodeUnit);
      return Object.fromEntries(
        await Promise.all(names.map(async (n) => [n, await readFile(join(h.paths.logsDir, n), 'utf8')] as const)),
      );
    };
    const records = async (): Promise<Record<string, unknown>[]> =>
      Object.values(await traceFiles()).flatMap((text) =>
        text
          .trim()
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );

    const span = (over: Record<string, unknown> = {}) => ({
      traceId: traceIdFor(conversation),
      spanId: '1234567812345678',
      parentSpanId: '8765432187654321',
      name: 'chat',
      kind: 1,
      startTimeUnixNano: '1790540844043000000',
      endTimeUnixNano: '1790540844143000000',
      attributes: [],
      events: [],
      links: [],
      status: { code: 0 },
      ...over,
    });
    const otlp = (spans: unknown[], resourceAttributes: unknown[] = [], scope = 'asha-agent-sdk') => ({
      resourceSpans: [
        { resource: { attributes: resourceAttributes }, scopeSpans: [{ scope: { name: scope }, spans }] },
      ],
    });
    const traces = (body: unknown, auth?: string, contentType = 'application/json') =>
      fetch(`${h.base}${Routes.agentTraces}`, {
        method: 'POST',
        headers: { 'content-type': contentType, ...(auth === undefined ? {} : { authorization: `Bearer ${auth}` }) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    beforeEach(async () => {
      await converse();
      token = present(
        present(h.runtime.starts[0], 'h.runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
        "h.runtime.starts[0].env['ASHA_AGENT_TOKEN']",
      );
      conversation = present(conversations()[0], 'conversations()[0]');
    });

    it("records one conversation as one trace: conversation → delivery → the agent's delivery → chat → asha.chat, and its posts", async () => {
      const all = await records();
      expect(all.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(R4_KEYS))).toBe(true);
      expect(new Set(all.map((r) => r['traceId']))).toEqual(new Set([traceIdFor(conversation)]));
      const one = (name: string) => {
        const found = all.filter((r) => r['name'] === name);
        expect(found, name).toHaveLength(1);
        return present(found[0], 'found[0]');
      };
      const root = one('asha.conversation');
      const daemonDelivery = one('asha.delivery');
      const agentDelivery = one('delivery');
      const chat = one('chat');
      const gateway = one('asha.chat');
      expect([root['parentSpanId'], root['handle'], root['kind']]).toEqual([null, 'asha', 'conversation']);
      expect([daemonDelivery['parentSpanId'], daemonDelivery['handle']]).toEqual([root['spanId'], 'hewo-1']);
      expect(agentDelivery['parentSpanId']).toBe(daemonDelivery['spanId']);
      expect(chat['parentSpanId']).toBe(agentDelivery['spanId']);
      expect([gateway['parentSpanId'], gateway['kind']]).toEqual([chat['spanId'], 'model_call']);
      // Its "ok" status and its reply.
      expect(all.filter((r) => r['name'] === 'post').map((r) => r['parentSpanId'])).toEqual([
        agentDelivery['spanId'],
        agentDelivery['spanId'],
      ]);
      expect(new Set(all.map((r) => [r['status'], r['reason'], r['channel']].join()))).toEqual(new Set(['ok,,main']));
      expect(h.traceLines).toEqual([]);
    });

    it('(a) refuses spans without an agent token with 401, recording nothing', async () => {
      const before = await traceFiles();
      expect((await traces(otlp([span()]))).status).toBe(401);
      expect((await traces(otlp([span()]), h.credential)).status).toBe(401);
      expect(await traceFiles()).toEqual(before);
    });

    it("(b) records exactly R4's fields, handle and channel from the token, and nothing the request carried beside them", async () => {
      const canary = 'CANARY-7f3';
      const before = (await records()).length;
      const body = otlp(
        [
          span({
            attributes: [{ key: 'asha.text', value: { stringValue: canary } }],
            events: [{ name: canary, timeUnixNano: '1790540844043000000', attributes: [] }],
            links: [
              {
                traceId: traceIdFor(conversation),
                spanId: '1111111111111111',
                attributes: [{ key: 'k', value: { stringValue: canary } }],
              },
            ],
          }),
        ],
        [
          { key: 'asha.handle', value: { stringValue: 'forged-9' } },
          { key: 'service.name', value: { stringValue: canary } },
        ],
        canary,
      );
      const response = await traces(body, token);
      expect([response.status, await response.json()]).toEqual([200, {}]);
      const added = (await records()).slice(before);
      expect(added).toEqual([
        {
          traceId: traceIdFor(conversation),
          spanId: '1234567812345678',
          parentSpanId: '8765432187654321',
          name: 'chat',
          kind: 'model_call',
          channel: 'main',
          handle: 'hewo-1',
          start: '2026-09-27T20:27:24.043Z',
          end: '2026-09-27T20:27:24.143Z',
          status: 'ok',
          reason: null,
        },
      ]);
      const withCanary = Object.entries(await traceFiles()).filter(([, text]) => text.includes(canary));
      expect(withCanary).toEqual([]);
    });

    it('(c) drops a span of a trace not delivered to the agent, counting it', async () => {
      const before = await records();
      h.logger.entries.length = 0;
      const response = await traces(otlp([span({ traceId: traceIdFor('someone-elses') })]), token);
      expect([response.status, await response.json()]).toEqual([200, { partialSuccess: { rejectedSpans: 1 } }]);
      expect(await records()).toEqual(before);
      expect(h.logger.entries.filter((e) => e.event === 'traces.foreign_trace')).toEqual([
        { level: 'warn', event: 'traces.foreign_trace', fields: { handle: 'hewo-1', count: 1 } },
      ]);
    });

    it.each([
      ['a body that is not JSON', 'not json', 'application/json', 'body is not valid JSON'],
      [
        'protobuf',
        'x',
        'application/x-protobuf',
        'spans must be sent as OTLP/HTTP JSON (content-type: application/json)',
      ],
      ['no resourceSpans', { spans: [] }, 'application/json', 'resourceSpans must be an array'],
      ['a 30-character traceId', 'traceId', 'application/json', 'traceId must be 32 lowercase hex characters'],
      ['the name tool', 'tool', 'application/json', 'name must be one of delivery, chat, embed, post'],
      ['an error status with free text', 'status', 'application/json', "an error status's message must be one of"],
      ['a spanId twice', 'duplicate', 'application/json', 'spanId 1234567812345678 appears more than once'],
      ['a span that ends before it starts', 'backwards', 'application/json', 'a span cannot end before it starts'],
    ] as const)('(d) refuses %s with 400, recording nothing', async (_, kind, contentType, error) => {
      const before = await traceFiles();
      let body: unknown;
      if (kind === 'traceId') body = otlp([span({ traceId: traceIdFor(conversation).slice(2) })]);
      else if (kind === 'tool') body = otlp([span(), span({ name: 'tool' })]);
      else if (kind === 'status') body = otlp([span(), span({ status: { code: 2, message: 'CANARY-7f3' } })]);
      else if (kind === 'duplicate') body = otlp([span(), span({ name: 'post' })]);
      else if (kind === 'backwards')
        body = otlp([span({ startTimeUnixNano: '1790540844143000000', endTimeUnixNano: '1790540844043000000' })]);
      else body = kind;
      const response = await traces(body, token, contentType);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(error);
      expect(await traceFiles()).toEqual(before);
    });

    it('(e) refuses a chat, embed or conversation post without a traceparent in a delivered trace with 400, calling no model and posting nothing', async () => {
      const models = h.modelRequests.length;
      const posted = h.logger.events().filter((e) => e === 'channel.posted').length;
      const chat = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 4 };
      const foreign = { traceparent: `00-${traceIdFor('someone-elses')}-${'c'.repeat(16)}-01` };
      const answers = [
        await post(Routes.agentChat, chat, token),
        await post(Routes.agentChat, chat, token, foreign),
        await post(Routes.agentChat, chat, token, { traceparent: 'garbage' }),
        await post(Routes.agentEmbed, { texts: ['a'], purpose: 'query' }, token),
        await post(Routes.agentEmbed, { texts: ['a'], purpose: 'query' }, token, foreign),
        await post(Routes.agentMessages, { conversation, kind: 'output', text: 'x' }, token),
        await post(Routes.agentMessages, { conversation, kind: 'output', text: 'x' }, token, foreign),
      ];
      // Each refused for its traceparent, not for anything else about it (the greeter recipe names no embedding
      // model, but the embed is refused for its trace before the recipe is looked at).
      const malformed = "traceparent must be 00-<32 hex>-<16 hex>-01, naming the caller's span";
      const foreignTrace = `traceparent names trace ${traceIdFor('someone-elses')}, which is no conversation delivered to hewo-1`;
      const bodies = await Promise.all(
        answers.map(async (a) => [a.status, ((await a.json()) as { error: string }).error]),
      );
      expect(bodies).toEqual([
        [400, malformed],
        [400, foreignTrace],
        [400, malformed],
        [400, malformed],
        [400, foreignTrace],
        [400, malformed],
        [400, `traceparent must be in the conversation's trace, ${traceIdFor(conversation)}`],
      ]);
      expect(h.modelRequests).toHaveLength(models);
      expect(h.logger.events().filter((e) => e === 'channel.posted')).toHaveLength(posted);
    });

    it("(f) one agent flooding the traces route cannot starve another agent's or the daemon's records (completion review finding 1)", async () => {
      // A second agent, hewo-2, with a conversation of its own to send spans in.
      expect((await h.cli(['--launch', 'recipe=greeter'])).code).toBe(EXIT.ok);
      const flooder = present(
        present(h.runtime.starts[1], 'h.runtime.starts[1]').env['ASHA_AGENT_TOKEN'],
        "h.runtime.starts[1].env['ASHA_AGENT_TOKEN']",
      );
      expect((await h.cli(['to=hewo-2', 'message=Please say: Hello World.'])).code).toBe(EXIT.ok);
      const itsTrace = traceIdFor(present(conversations().at(-1), 'conversations().at(-1)'));
      // 3,000 spans (about 830 KB of records) a request, under the 1 MiB body limit: hewo-2's 4 MiB a day is
      // spent by the sixth request, and every later one is refused, counted, and logged once.
      let n = 0;
      const flood = () =>
        otlp(
          Array.from({ length: 3_000 }, () =>
            span({ traceId: itsTrace, spanId: (++n).toString(16).padStart(16, '0') }),
          ),
        );
      const answers: unknown[] = [];
      for (let i = 0; i < 8; i++) {
        const response = await traces(flood(), flooder);
        expect(response.status).toBe(200);
        answers.push(await response.json());
      }
      expect(answers.slice(-2)).toEqual([0, 1].map(() => ({ partialSuccess: { rejectedSpans: 3_000 } })));
      expect(h.logger.entries.filter((e) => e.event === 'traces.agent_over_budget')).toEqual([
        {
          level: 'warn',
          event: 'traces.agent_over_budget',
          fields: {
            date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
            agent: 'main/hewo-2',
            budgetBytes: 4 * 1024 * 1024,
          },
        },
      ]);

      // hewo-1's next conversation is recorded whole: the daemon's spans and hewo-1's own.
      expect((await h.cli(['to=hewo-1', 'message=Please say: Hello World.'])).code).toBe(EXIT.ok);
      const next = traceIdFor(present(conversations().at(-1), 'conversations().at(-1)'));
      const recorded = (await records()).filter((r) => r['traceId'] === next);
      expect([...new Set(recorded.map((r) => `${String(r['handle'])} ${String(r['name'])}`))].sort(byCodeUnit)).toEqual(
        [
          'asha asha.conversation',
          'hewo-1 asha.chat',
          'hewo-1 asha.delivery',
          'hewo-1 chat',
          'hewo-1 delivery',
          'hewo-1 post',
        ],
      );
    });
  });

  it('FIXTURE_RECIPE is what the fixture root serves', () => {
    expect(FIXTURE_RECIPE.id).toBe('greeter');
  });
});

describe('agent tools and models (docs/plans/agent-tools.md)', () => {
  const tool = (name: string) => ({
    type: 'function',
    function: { name, description: 'x', parameters: { type: 'object', properties: {} } },
  });
  const token = (i: number) =>
    present(
      present(h.runtime.starts[i], `h.runtime.starts[${String(i)}]`).env['ASHA_AGENT_TOKEN'],
      `h.runtime.starts[${String(i)}].env['ASHA_AGENT_TOKEN']`,
    );
  const board = (t: string | undefined, query = '') =>
    fetch(`${h.base}${Routes.agentBlackboard}${query}`, {
      headers: t === undefined ? {} : { authorization: `Bearer ${t}` },
    });
  const say = (t: string | undefined, body: unknown) => post(Routes.agentBlackboard, body, t);
  const read = async (t: string, query = '') =>
    (await (await board(t, query)).json()) as {
      entries: { id: number; author: string; ts: string; text: string }[];
      more: boolean;
    };
  const posted = () => h.logger.entries.filter((e) => e.event === 'blackboard.posted');

  it('refuses with 400 naming the tool, and no model call, a chat offering a tool the agent was not given (R1, A15)', async () => {
    await converse();
    const [conversation] = conversations();
    const before = h.modelRequests.length;

    const response = await post(
      Routes.agentChat,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 4, tools: [tool('reply'), tool('write_file')] },
      token(0),
      inTrace(present(conversation, 'conversation')),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'tools "write_file" are not among hewo-1\'s channel, selected, granted and answer tools',
    });
    expect(h.modelRequests).toHaveLength(before);
  });

  it('sends the selected tools in the welcome event, and nothing of them in the environment (R1)', async () => {
    await writeFile(
      join(h.root, 'recipes', 'tooled.json'),
      JSON.stringify({ ...FIXTURE_RECIPE, id: 'tooled', tools: ['read_file', 'blackboard_post'] }),
    );
    const controller = new AbortController();
    let welcome: unknown;
    // This "container" reads its stream's first line itself, then announces itself as the SDK does.
    h.runtime.onStart = (spec) => {
      void (async () => {
        const agentToken = present(spec.env['ASHA_AGENT_TOKEN'], "spec.env['ASHA_AGENT_TOKEN']");
        const stream = await fetch(`${h.base}${Routes.agentChannel}?name=probe`, {
          headers: { authorization: `Bearer ${agentToken}` },
          signal: controller.signal,
        });
        const { value } = await present<ReadableStream<Uint8Array>>(stream.body, 'stream.body').getReader().read();
        welcome = JSON.parse(present(new TextDecoder().decode(value).split('\n')[0], 'the welcome line'));
        await post(Routes.agentMessages, { kind: 'status', text: 'Hi' }, agentToken);
      })();
    };
    try {
      expect((await h.cli(['--launch', 'recipe=tooled'])).code).toBe(EXIT.ok);
      // No module granted: the welcome's modules is [] (extension-modules R10, R38).
      expect(welcome).toEqual({
        type: 'welcome',
        handle: 'probe-1',
        channel: 'main',
        tools: ['read_file', 'blackboard_post'],
        prompt: FIXTURE_RECIPE.prompt,
        guidance: [],
        modules: [],
      });
      expect(Object.keys(present(h.runtime.starts[0], 'h.runtime.starts[0]').env).sort(byCodeUnit)).toEqual([
        'ASHA_AGENT_TOKEN',
        'ASHA_URL',
      ]);
    } finally {
      controller.abort();
    }
  });

  it('keeps one blackboard per channel: authors from the tokens, reads after since, refusals as the wire contract says, nothing stored on any refusal (R10, A8)', async () => {
    for (const channel of ['lab', 'lab', 'other'])
      expect((await h.cli(['--launch', 'recipe=greeter', `channel=${channel}`])).code).toBe(EXIT.ok);
    const [lab1, lab2, other] = [token(0), token(1), token(2)];

    const first = await say(lab1, { text: 'first' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      entry: { id: 1, author: 'hewo-1', ts: expect.any(String) as string, text: 'first', session: 1 },
    });
    // A body naming its own author is not {text: string}: refused, and nothing stored — the author only ever comes from the token.
    const forged = await say(lab2, { text: 'from the supervisor', author: 'supervisor-1' });
    expect([forged.status, await forged.json()]).toEqual([400, { error: 'invalid_arguments' }]);
    expect((await say(lab2, { text: 'second' })).status).toBe(200);

    expect((await read(lab1)).entries.map((e) => [e.id, e.author, e.text])).toEqual([
      [1, 'hewo-1', 'first'],
      [2, 'hewo-2', 'second'],
    ]);
    expect(await read(lab2, '?since=1')).toEqual({
      entries: [{ id: 2, author: 'hewo-2', ts: expect.any(String) as string, text: 'second', session: 1 }],
      more: false,
    });
    expect(await read(other)).toEqual({ entries: [], more: false });

    const refusals = [
      await say(lab1, { text: 'x'.repeat(9 * 1024) }),
      await say(lab1, { text: '' }),
      await say(lab1, { text: '  \n ' }),
      await say(lab1, { text: 7 }),
      await say(lab1, 'not an object'),
      await board(lab1, '?since=abc'),
    ];
    expect(await Promise.all(refusals.map(async (r) => [r.status, await r.json()]))).toEqual([
      [413, { error: 'entry_too_large' }],
      [400, { error: 'invalid_arguments' }],
      [400, { error: 'invalid_arguments' }],
      [400, { error: 'invalid_arguments' }],
      [400, { error: 'invalid_arguments' }],
      [400, { error: 'invalid_arguments' }],
    ]);
    const unauthenticated = await say(undefined, { text: 'anonymous' });
    expect(unauthenticated.status).toBe(401);
    expect((await read(lab1)).entries).toHaveLength(2);

    // Each stored entry is logged at info, never with its text.
    expect(posted().map((e) => [e.level, e.fields])).toEqual([
      ['info', { channel: 'lab', author: 'hewo-1', id: 1, size: 5 }],
      ['info', { channel: 'lab', author: 'hewo-2', id: 2, size: 6 }],
    ]);

    // In the SDK the three refusals are tool-result data, not thrown errors.
    const client = new HarnessClient({
      environment: { harnessUrl: h.base, agentToken: lab1 },
      chatTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      filesRequestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 5_000,
      fetch: globalThis.fetch,
      telemetry: AgentTelemetry.forHarness({ harnessUrl: h.base, agentToken: lab1 }, () => undefined),
    });
    const signal = new AbortController().signal;
    expect(await client.blackboardPost('x'.repeat(9 * 1024), signal)).toEqual({ ok: false, reason: 'entry_too_large' });
    expect(await client.blackboardPost(' ', signal)).toEqual({ ok: false, reason: 'invalid_arguments' });
  });

  it('holds at most 256 entries: the 257th is 409 blackboard_full; a read of 256 entries of 8,000 bytes returns one entry, within 8 KiB of JSON, and more (R10, A8)', async () => {
    expect((await h.cli(['--launch', 'recipe=greeter', 'channel=full'])).code).toBe(EXIT.ok);
    const t = token(0);
    // 8,192 bytes of text no longer fit one read's 8 KiB of JSON with the entry's framing (review finding 4): refused.
    const tooLarge = await say(t, { text: 'x'.repeat(8192) });
    expect([tooLarge.status, await tooLarge.json()]).toEqual([413, { error: 'entry_too_large' }]);
    for (let i = 0; i < 256; i++) expect((await say(t, { text: String(i % 10).repeat(8000) })).status).toBe(200);
    const full = await say(t, { text: 'one more' });
    expect([full.status, await full.json()]).toEqual([409, { error: 'blackboard_full' }]);
    const client = new HarnessClient({
      environment: { harnessUrl: h.base, agentToken: t },
      chatTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      filesRequestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 5_000,
      fetch: globalThis.fetch,
      telemetry: AgentTelemetry.forHarness({ harnessUrl: h.base, agentToken: t }, () => undefined),
    });
    expect(await client.blackboardPost('again', new AbortController().signal)).toEqual({
      ok: false,
      reason: 'blackboard_full',
    });

    const raw = await (await board(t)).text();
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8192);
    const page = JSON.parse(raw) as { entries: { id: number; text: string }[]; more: boolean };
    expect([page.entries.map((e) => e.id), page.more]).toEqual([[1], true]);
    expect(present(page.entries[0], 'page.entries[0]').text).toHaveLength(8000);
    const last = await read(t, '?since=255');
    expect([last.entries.map((e) => e.id), last.more]).toEqual([[256], false]);
    expect(posted()).toHaveLength(256);
  });

  describe("the control API's read of a channel's board (docs/plans/patterns-phase-4.md R1, R2, A2)", () => {
    type Read = { entries: { id: number; author: string; ts: string; text: string; session: number }[]; more: boolean };
    const view = (query: string) => control(`${Routes.blackboard}${query}`);
    const viewed = async (query: string) => {
      const r = await view(query);
      return [r.status, await r.json()] as const;
    };

    it("answers one channel's entries alone, in order, after since, from the board the agents post to, and logs nothing for a read", async () => {
      for (const channel of ['main', 'lab'])
        expect((await h.cli(['--launch', 'recipe=greeter', `channel=${channel}`])).code).toBe(EXIT.ok);
      const [main, lab] = [token(0), token(1)];
      for (const text of ['one', 'two']) expect((await say(main, { text })).status).toBe(200);
      expect((await say(lab, { text: 'lab only' })).status).toBe(200);
      const entry = (id: number, author: string, text: string) => ({
        id,
        author,
        ts: expect.any(String) as string,
        text,
        session: 1,
      });
      const logged = h.logger.entries.length;

      expect(await viewed('?channel=main')).toEqual([
        200,
        { entries: [entry(1, 'hewo-1', 'one'), entry(2, 'hewo-1', 'two')], more: false },
      ]);
      expect(await viewed('?channel=lab')).toEqual([200, { entries: [entry(1, 'hewo-1', 'lab only')], more: false }]);
      expect(await viewed('?channel=main&since=0')).toEqual([
        200,
        { entries: [entry(1, 'hewo-1', 'one'), entry(2, 'hewo-1', 'two')], more: false },
      ]);
      expect(await viewed('?channel=main&since=1')).toEqual([
        200,
        { entries: [entry(2, 'hewo-1', 'two')], more: false },
      ]);
      expect(await viewed('?channel=main&since=2')).toEqual([200, { entries: [], more: false }]);
      expect(await viewed('?channel=main&since=999999999')).toEqual([200, { entries: [], more: false }]);
      // A read changes nothing: the route again, and an agent's read after it, give the same entries.
      const again = (await viewed('?channel=main'))[1] as Read;
      expect((await read(main)).entries).toEqual(again.entries);
      expect(again.entries.map((e) => e.text)).toEqual(['one', 'two']);
      expect(posted()).toHaveLength(3);
      // Seven reads by the route and one by an agent log nothing at all (R1; the completion review's finding 3).
      expect(h.logger.entries.slice(logged).map((e) => e.event)).toEqual([]);
    });

    it('pages 256 entries at most 8,192 bytes of JSON at a time, more until the last page', async () => {
      expect((await h.cli(['--launch', 'recipe=greeter', 'channel=full'])).code).toBe(EXIT.ok);
      const t = token(0);
      for (let i = 0; i < 256; i++) expect((await say(t, { text: String(i % 10).repeat(4000) })).status).toBe(200);
      const ids: number[] = [];
      let since = 0;
      for (let page = 0; page < 300; page++) {
        const r = await view(`?channel=full&since=${String(since)}`);
        const raw = await r.text();
        expect([r.status, Buffer.byteLength(raw) <= 8192]).toEqual([200, true]);
        const body = JSON.parse(raw) as Read;
        ids.push(...body.entries.map((e) => e.id));
        if (!body.more) break;
        since = present(body.entries.at(-1), 'body.entries.at(-1)').id;
      }
      expect(ids).toEqual(Array.from({ length: 256 }, (_, i) => i + 1));
    });

    it('answers an empty board for a channel with an agent and no post, 404 for a channel this daemon does not have, creating none', async () => {
      expect((await h.cli(['--launch', 'recipe=greeter', 'channel=quiet'])).code).toBe(EXIT.ok);
      expect(await viewed('?channel=quiet')).toEqual([200, { entries: [], more: false }]);
      expect(await viewed('?channel=nowhere')).toEqual([
        404,
        { error: 'no channel nowhere on this daemon', reason: 'unknown_channel' },
      ]);
      // Had the first read made the channel, this one would answer 200 with an empty board.
      expect(await viewed('?channel=nowhere&since=3')).toEqual([
        404,
        { error: 'no channel nowhere on this daemon', reason: 'unknown_channel' },
      ]);
    });

    it("refuses a missing or invalid channel or since with 400 invalid_arguments naming the parameter, and an agent's token with 401", async () => {
      expect((await h.cli(['--launch', 'recipe=greeter'])).code).toBe(EXIT.ok);
      const channelDetail = 'channel must be a channel name (/^[a-z][a-z0-9-]{0,31}$/)';
      const sinceDetail = 'since must be a whole number from 0 to 999999999';
      const cases: [string, unknown][] = [
        ['', { error: 'invalid_arguments', detail: channelDetail }],
        ['?channel=Bad', { error: 'invalid_arguments', detail: channelDetail }],
        ['?since=1', { error: 'invalid_arguments', detail: channelDetail }],
        ...['-1', '01', '1.5', 'x', '1000000000', ''].map((v): [string, unknown] => [
          `?channel=main&since=${v}`,
          { error: 'invalid_arguments', detail: sinceDetail },
        ]),
      ];
      const answers = await Promise.all(cases.map(async ([q]) => [q, ...(await viewed(q))]));
      expect(answers).toEqual(cases.map(([q, body]) => [q, 400, body]));
      const asAgent = await fetch(`${h.base}${Routes.blackboard}?channel=main`, {
        headers: { authorization: `Bearer ${token(0)}` },
      });
      expect([asAgent.status, await asAgent.json()]).toEqual([401, { error: 'invalid control credential' }]);
    });
  });

  it("serves two agents on one channel, on two models, each from its own model's server with its own alias (R7, A6)", async () => {
    const second: unknown[] = [];
    const secondStores: string[] = [];
    const other = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const request = JSON.parse(body) as FakeModelRequest;
        if (req.url === '/tokenize' || req.url === '/completion') {
          secondStores.push(req.url);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(req.url === '/tokenize' ? { tokens: [13] } : { content: ' x' }));
          return;
        }
        second.push(request);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(streamOf(fakeModel(request)));
      });
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    try {
      h.modelServer.urlFor['other-model'] = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}`;
      const entry = JSON.parse(
        await readFile(join(h.root, 'catalogue', `${FIXTURE_RECIPE.model}.json`), 'utf8'),
      ) as Record<string, unknown>;
      await writeFile(
        join(h.root, 'catalogue', 'other-model.json'),
        JSON.stringify({ ...entry, id: 'other-model', revision: 'c'.repeat(40) }),
      );
      await writeFile(
        join(h.root, 'recipes', 'other.json'),
        JSON.stringify({ ...FIXTURE_RECIPE, id: 'other', model: 'other-model' }),
      );

      expect((await h.cli(['recipe=greeter', 'to=hewo-1', 'message=Please say: Hello World.'])).code).toBe(EXIT.ok);
      expect((await h.cli(['recipe=other', 'to=hewo-2', 'message=Please say: Hello World.'])).code).toBe(EXIT.ok);

      const firstModels = (h.modelRequests as { body: { model: string } }[]).map((r) => r.body.model);
      const secondModels = (second as { model: string }[]).map((r) => r.model);
      expect(firstModels.length).toBeGreaterThan(0);
      expect(secondModels.length).toBeGreaterThan(0);
      expect(new Set(firstModels)).toEqual(new Set([FIXTURE_RECIPE.model]));
      expect(new Set(secondModels)).toEqual(new Set(['other-model']));
      const chats = h.logger.entries
        .filter((e) => e.event === 'model.chat')
        .map((e) => [e.fields['handle'], e.fields['model']]);
      expect(new Set(chats.map((c) => JSON.stringify(c)))).toEqual(
        new Set([JSON.stringify(['hewo-1', FIXTURE_RECIPE.model]), JSON.stringify(['hewo-2', 'other-model'])]),
      );
      // Each model's server is asked once to store its prompts (D44): the store request goes to the server that answered.
      await vi.waitFor(() => {
        expect(h.logger.entries.filter((e) => e.event === 'model.prompt_stored').map((e) => e.fields['model'])).toEqual(
          [FIXTURE_RECIPE.model, 'other-model'],
        );
      });
      expect(h.storeRequests.map((r) => r.url)).toEqual(['/tokenize', '/completion']);
      expect(secondStores).toEqual(['/tokenize', '/completion']);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });
});

describe('agent calls over the agent API (docs/plans/agent-calls.md A3: R2, R5, R6, R7)', () => {
  /** An agent that only reads its stream and records its deliveries; the test posts for it with its token. */
  interface RawAgent {
    readonly token: string;
    readonly deliveries: Delivery[];
    /** Resolves with the delivery that satisfies `match`, arrived or yet to arrive. */
    delivery(match: (d: Delivery) => boolean): Promise<Delivery>;
  }
  const raws: RawAgent[] = [];
  const failures: unknown[] = [];
  const controller = new AbortController();

  beforeEach(() => {
    raws.length = 0;
    failures.length = 0;
    h.runtime.onStart = (spec) => {
      const token = present(spec.env['ASHA_AGENT_TOKEN'], "spec.env['ASHA_AGENT_TOKEN']");
      const deliveries: Delivery[] = [];
      const waiters: { match: (d: Delivery) => boolean; resolve: (d: Delivery) => void }[] = [];
      raws.push({
        token,
        deliveries,
        delivery: (match) => {
          const found = deliveries.find(match);
          return found !== undefined
            ? Promise.resolve(found)
            : new Promise((resolve) => waiters.push({ match, resolve }));
        },
      });
      void (async () => {
        const stream = await fetch(`${h.base}${Routes.agentChannel}?name=hewo`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const reader = present<ReadableStream<Uint8Array>>(stream.body, 'stream.body').getReader();
        await post(Routes.agentMessages, { kind: 'status', text: 'Hi' }, token);
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
          for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
            const event = JSON.parse(buffered.slice(0, nl)) as { type: string; delivery?: Delivery };
            buffered = buffered.slice(nl + 1);
            if (event.type !== 'delivery') continue;
            const delivery = present(event.delivery, 'event.delivery');
            deliveries.push(delivery);
            for (const w of waiters.filter((x) => x.match(delivery))) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(delivery);
            }
          }
        }
      })().catch((error: unknown) => {
        // Only the test's own abort, or the daemon closing the stream at the end, ends a reader.
        if (!(error instanceof Error && (error.name === 'AbortError' || error.message === 'terminated')))
          failures.push(error);
      });
    };
  });

  afterEach(() => {
    expect(failures).toEqual([]);
  });

  /** Starts a conversation for one agent on the control API and returns its id, keeping its stream open. */
  async function startConversation(
    channel: string,
    to: string,
    message: string,
  ): Promise<{ conversation: string; events: ConversationEvent[] }> {
    const response = await control(Routes.conversations, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, to, message }),
      signal: controller.signal,
    });
    // The stream stays open (the controller hangs it up at the test's end): stop reading at the posted event.
    const reader = present<ReadableStream<Uint8Array>>(response.body, 'response.body').getReader();
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    const events: ConversationEvent[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the conversation stream ended before its posted event');
      for (const raw of sse.push(decoder.decode(value, { stream: true }))) {
        const event = raw as ConversationEvent;
        events.push(event);
        if (event.type === 'posted') return { conversation: event.message.conversation, events };
      }
    }
  }

  it('routes answers only from the holder of a question, once, and refuses every other shape and holder, recording nothing', async () => {
    for (const channel of ['lab', 'lab', 'lab', 'other'])
      expect((await h.cli(['--launch', 'recipe=greeter', `channel=${channel}`])).code).toBe(EXIT.ok);
    const [aMaybe, bMaybe, cMaybe, dMaybe] = raws;
    const a = present(aMaybe, 'a');
    const b = present(bMaybe, 'b');
    const c = present(cMaybe, 'c');
    const d = present(dMaybe, 'd');
    const { conversation } = await startConversation(
      'lab',
      'hewo-1',
      'Find out from hewo-2 and hewo-3, and tell me yourself.',
    );
    const held = await a.delivery((x) => x.message.conversation === conversation);
    const trace = inTrace(conversation);
    const json = async (r: Response) => [r.status, await r.json()] as const;
    const recorded = () =>
      h.logger.entries.filter((e) => e.event === 'channel.call_outcome' || e.event === 'channel.posted').length;

    // A consult without a traceparent: 400, nothing posted.
    const before = recorded();
    expect(
      await json(
        await post(Routes.agentCalls, { delivery: held.deliveryId, requests: [{ to: 'hewo-2', text: 'x' }] }, a.token),
      ),
    ).toEqual([400, { error: "traceparent must be 00-<32 hex>-<16 hex>-01, naming the caller's span" }]);
    expect(recorded()).toBe(before);

    const consulted = await post(
      Routes.agentCalls,
      {
        delivery: held.deliveryId,
        requests: [
          { to: 'hewo-2', text: 'Your role?' },
          { to: 'hewo-3', text: 'Yours?' },
        ],
      },
      a.token,
      trace,
    );
    expect(consulted.status).toBe(200);
    const { call, messages } = (await consulted.json()) as { call: string; messages: string[] };
    expect(messages).toHaveLength(2);
    const qB = await b.delivery((x) => x.message.call?.role === 'question');
    const qC = await c.delivery((x) => x.message.call?.role === 'question');
    expect([qB.message.id, qC.message.id]).toEqual(messages);
    expect(qB.message).toMatchObject({
      conversation,
      from: 'hewo-1',
      to: 'hewo-2',
      kind: 'internal',
      text: 'Your role?',
      call: { id: call, role: 'question' },
    });

    // B answers with its own delivery: recorded answered, posted internal B→A marked as the call's answer.
    const answered = await post(
      Routes.agentCallAnswer,
      { delivery: qB.deliveryId, text: 'I say things.' },
      b.token,
      trace,
    );
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { message: unknown }).message).toMatchObject({
      conversation,
      from: 'hewo-2',
      to: 'hewo-1',
      kind: 'internal',
      text: 'I say things.',
      call: { id: call, role: 'answer', outcome: 'answered' },
    });

    const refusedBefore = recorded();
    // C names B's delivery; D (another channel) names C's delivery; D guesses a call id.
    expect(
      await json(await post(Routes.agentCallAnswer, { delivery: qB.deliveryId, text: 'mine' }, c.token, trace)),
    ).toEqual([
      409,
      { error: `not_holding_delivery: hewo-3 holds no delivery ${qB.deliveryId}`, reason: 'not_holding_delivery' },
    ]);
    expect(
      await json(await post(Routes.agentCallAnswer, { delivery: qC.deliveryId, text: 'mine' }, d.token, trace)),
    ).toEqual([
      409,
      { error: `not_holding_delivery: hewo-1 holds no delivery ${qC.deliveryId}`, reason: 'not_holding_delivery' },
    ]);
    expect(
      await json(await post(Routes.agentCallAnswer, { delivery: qC.deliveryId, call, text: 'mine' }, d.token, trace)),
    ).toEqual([400, { error: 'unknown field(s): call' }]);
    // A's own delivery is not a call question.
    expect(
      (await json(await post(Routes.agentCallAnswer, { delivery: held.deliveryId, text: 'x' }, a.token, trace)))[1],
    ).toMatchObject({ reason: 'not_a_call' });
    // Malformed answer bodies: 400.
    for (const [body, error] of [
      [{ delivery: qB.deliveryId, text: 'x', to: 'user-1' }, 'unknown field(s): to'],
      [{ delivery: qB.deliveryId, text: 'x', call }, 'unknown field(s): call'],
      [{ delivery: qB.deliveryId, text: 'x', pass: 'y' }, 'an answer carries exactly one of text and pass'],
      [{ delivery: qB.deliveryId }, 'an answer carries exactly one of text and pass'],
    ] as const) {
      expect(await json(await post(Routes.agentCallAnswer, body, b.token, trace))).toEqual([400, { error }]);
    }
    expect(
      await json(
        await post(Routes.agentCallAnswer, { delivery: qB.deliveryId, text: 'a'.repeat(1_001) }, b.token, trace),
      ),
    ).toEqual([
      409,
      { error: 'answer_too_large: the answer is 1001 characters; at most 1000', reason: 'answer_too_large' },
    ]);
    // R6: B holds only its question in the conversation, so its output and internal posts are refused; its status is not.
    for (const body of [
      { conversation, kind: 'output', text: 'Hi user' },
      { conversation, kind: 'internal', text: 'Hi A', to: 'hewo-1' },
    ]) {
      expect(await json(await post(Routes.agentMessages, body, b.token, trace))).toEqual([
        409,
        {
          error: `call_answer_only: hewo-2 holds only call questions in conversation ${conversation}: it answers through the answer route`,
          reason: 'call_answer_only',
        },
      ]);
    }
    expect(
      await json(await post(Routes.agentMessages, { conversation, kind: 'internal', text: 'x', call }, b.token, trace)),
    ).toEqual([400, { error: 'unknown field(s): call' }]);
    expect(recorded(), 'no refusal recorded or posted anything').toBe(refusedBefore);
    expect(
      (await post(Routes.agentMessages, { conversation, kind: 'status', text: 'ok' }, b.token, trace)).status,
    ).toBe(200);

    // C passes: its status is posted by the daemon; C's second answer is call_closed.
    const passed = await post(Routes.agentCallAnswer, { delivery: qC.deliveryId, pass: 'not my role' }, c.token, trace);
    expect(passed.status).toBe(200);
    expect(((await passed.json()) as { message: unknown }).message).toMatchObject({
      conversation,
      from: 'hewo-3',
      kind: 'status',
      text: 'pass: not my role',
    });
    expect(
      await json(await post(Routes.agentCallAnswer, { delivery: qC.deliveryId, text: 'after all' }, c.token, trace)),
    ).toEqual([
      409,
      { error: `call_closed: call ${call} has hewo-3's outcome already, or is closed`, reason: 'call_closed' },
    ]);

    // Every addressee has an outcome: A gets exactly one gather.
    const gather = await a.delivery((x) => x.message.call?.role === 'gather');
    expect(gather.message).toMatchObject({
      from: 'asha',
      to: 'hewo-1',
      kind: 'internal',
      text: "Answers to hewo-1's call: 1 answered, 1 passed.",
      call: {
        id: call,
        role: 'gather',
        answers: [
          { from: 'hewo-2', outcome: 'answered', text: 'I say things.' },
          { from: 'hewo-3', outcome: 'passed', reason: 'not my role' },
        ],
      },
    });
    expect(a.deliveries.filter((x) => x.message.call !== undefined)).toEqual([gather]);
    controller.abort();
  });
});

describe('an agent launching from its grant (docs/plans/patterns-phase-3.md A13: R29, R30, R32)', () => {
  /** An agent that only reads its stream and records its deliveries; the test posts for it with its token. */
  interface RawAgent {
    readonly token: string;
    readonly container: string;
    /** Its welcome event, once read. */
    welcome: Record<string, unknown> | undefined;
    delivery(match: (d: Delivery) => boolean): Promise<Delivery>;
  }
  const raws: RawAgent[] = [];
  const failures: unknown[] = [];
  let controller = new AbortController();
  /** Containers whose names hold this never connect: a launch that does not come online. */
  let silent: string | undefined;
  /** When set, a container whose name holds `-helper-` connects only once this settles: a launch held before online. */
  let helperHeld: Promise<void> | undefined;

  /**
   * One parsed event line from a raw agent's stream: records its welcome, or a delivery and wakes any waiter
   * matching it (extracted to keep the reader loop's cognitive complexity in bounds — same recording, same
   * wake-ups).
   */
  function handleRawEvent(
    event: { type: string; delivery?: Delivery },
    raw: RawAgent,
    deliveries: Delivery[],
    waiters: { match: (d: Delivery) => boolean; resolve: (d: Delivery) => void }[],
  ): void {
    if (event.type === 'welcome') raw.welcome = event;
    if (event.type !== 'delivery') return;
    const delivery = present(event.delivery, 'event.delivery');
    deliveries.push(delivery);
    for (const w of waiters.filter((x) => x.match(delivery))) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(delivery);
    }
  }

  beforeEach(async () => {
    raws.length = 0;
    failures.length = 0;
    silent = undefined;
    helperHeld = undefined;
    controller = new AbortController();
    h.runtime.onStart = (spec) => {
      if (silent !== undefined && spec.name.includes(silent)) return;
      const token = present(spec.env['ASHA_AGENT_TOKEN'], "spec.env['ASHA_AGENT_TOKEN']");
      const deliveries: Delivery[] = [];
      const waiters: { match: (d: Delivery) => boolean; resolve: (d: Delivery) => void }[] = [];
      const raw: RawAgent = {
        token,
        container: spec.name,
        welcome: undefined,
        delivery: (match) => {
          const found = deliveries.find(match);
          return found !== undefined
            ? Promise.resolve(found)
            : new Promise((resolve) => waiters.push({ match, resolve }));
        },
      };
      raws.push(raw);
      void (async () => {
        if (helperHeld !== undefined && spec.name.includes('-helper-')) await helperHeld;
        const stream = await fetch(`${h.base}${Routes.agentChannel}?name=hewo`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const reader = present<ReadableStream<Uint8Array>>(stream.body, 'stream.body').getReader();
        await post(Routes.agentMessages, { kind: 'status', text: 'Hi' }, token);
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
          for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
            const event = JSON.parse(buffered.slice(0, nl)) as { type: string; delivery?: Delivery };
            buffered = buffered.slice(nl + 1);
            handleRawEvent(event, raw, deliveries, waiters);
          }
        }
      })().catch((error: unknown) => {
        if (!(error instanceof Error && (error.name === 'AbortError' || error.message === 'terminated')))
          failures.push(error);
      });
    };
    const dir = join(h.root, 'teams', 'spawn');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'team.json'),
      JSON.stringify({ id: 'spawn', description: 'Spawns.', members: [{ name: 'lead', recipe: 'lead.json' }] }),
    );
    await writeFile(
      join(dir, 'lead.json'),
      JSON.stringify({
        ...FIXTURE_RECIPE,
        id: 'lead',
        description: 'Leads.',
        launch: { recipes: ['helper'], maxPerConversation: 1 },
        nestedCalls: true,
      }),
    );
    await writeFile(
      join(dir, 'helper.json'),
      JSON.stringify({ ...FIXTURE_RECIPE, id: 'helper', description: 'Helps.', startupTimeoutMs: 1_000 }),
    );
  });

  afterEach(() => {
    controller.abort();
    expect(failures).toEqual([]);
  });

  /** The lead online, holding a delivery of a new conversation: its token, the delivery and the conversation. */
  async function leadHolding(text: string): Promise<{ lead: RawAgent; held: Delivery; conversation: string }> {
    if (raws.length === 0) expect((await h.cli(['--launch', 'team=spawn'])).code).toBe(EXIT.ok);
    const lead = present(raws[0], 'raws[0]');
    const response = await control(Routes.conversations, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'main', to: 'lead-1', message: text }),
      signal: controller.signal,
    });
    void present<ReadableStream<Uint8Array>>(response.body, 'response.body').getReader().read();
    const held = await lead.delivery((d) => d.message.text === text);
    return { lead, held, conversation: held.message.conversation };
  }
  const launch = (token: string, body: unknown, signal?: AbortSignal) =>
    fetch(`${h.base}${Routes.agentLaunch}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  const json = async (r: Response) => [r.status, await r.json()] as const;
  const stopping = () =>
    h.logger.entries.filter((e) => e.event === 'agent.stopping').map((e) => [e.fields['handle'], e.fields['reason']]);

  it("answers {handle} once the launched agent is online, under the launcher's team with the recipe id as its base name; refuses another recipe, another delivery, and the launch past the cap; stops it (drain) when the conversation settles", async () => {
    const { lead, held, conversation } = await leadHolding('Bring a helper.');
    const welcomeLaunch = h.logger.entries.find((e) => e.event === 'agent.starting' && e.fields['member'] === 'lead');
    expect(welcomeLaunch).toBeDefined();

    expect(await json(await launch(lead.token, { delivery: held.deliveryId, recipe: 'helper' }))).toEqual([
      200,
      { handle: 'helper-1' },
    ]);
    expect(h.logger.entries.filter((e) => e.event === 'agent.launched').map((e) => e.fields)).toEqual([
      { by: 'lead-1', handle: 'helper-1', recipe: 'helper', conversation, team: 'spawn' },
    ]);
    expect(
      present(
        h.logger.entries.find((e) => e.event === 'agent.starting' && e.fields['member'] === 'helper'),
        'the agent.starting entry for helper',
      ).fields,
    ).toMatchObject({ channel: 'main', recipe: 'helper', member: 'helper' });
    expect((await h.cli(['--status'])).out).toContain('  helper-1  channel=main recipe=helper image=greeter-image');
    // The welcome carries the grant and nestedCalls for the recipe that names them, and neither for another (A14).
    await vi.waitFor(() => {
      expect(raws[1]?.welcome).toBeDefined();
    });
    const leadWelcome = present(lead.welcome, 'lead.welcome');
    expect([leadWelcome['launch'], leadWelcome['nestedCalls']]).toEqual([
      { recipes: ['helper'], maxPerConversation: 1 },
      true,
    ]);
    const helperWelcome = present(raws[1], 'raws[1]').welcome;
    expect(helperWelcome).not.toHaveProperty('launch');
    expect(helperWelcome).not.toHaveProperty('nestedCalls');

    expect(await json(await launch(lead.token, { delivery: held.deliveryId, recipe: 'nobody' }))).toEqual([
      409,
      { error: "not_granted: recipe lead's launch grant names helper, not nobody", reason: 'not_granted' },
    ]);
    expect(await json(await launch(lead.token, { delivery: 'd-none', recipe: 'helper' }))).toEqual([
      409,
      { error: 'not_holding_delivery: lead-1 holds no delivery d-none', reason: 'not_holding_delivery' },
    ]);
    expect(await json(await launch(lead.token, { delivery: held.deliveryId, recipe: 'helper' }))).toEqual([
      409,
      {
        error: `launch_cap: lead-1 has launched 1 of its 1 agents for conversation ${conversation}`,
        reason: 'launch_cap',
      },
    ]);
    expect(h.logger.entries.filter((e) => e.event === 'agent.launched')).toHaveLength(1);
    // The helper's own deliveries never include the launcher's: it was launched, not told.
    expect(stopping()).toEqual([]);

    // The lead replies and acks: the conversation settles, and the helper is stopped with its reason.
    await post(
      Routes.agentMessages,
      { conversation, kind: 'output', text: 'Done.' },
      lead.token,
      inTrace(conversation),
    );
    await post(Routes.agentAck, { deliveryId: held.deliveryId }, lead.token);
    await vi.waitFor(() => {
      expect(stopping()).toEqual([['helper-1', `the conversation ${conversation} it was launched for settled`]]);
    });
    expect(h.runtime.stopRecords.filter((r) => r.name.includes('-helper-')).map((r) => r.mode)).toEqual(['drain']);
  });

  it('stops the launched agent (drain) when its launcher leaves first', async () => {
    const { lead, held } = await leadHolding('Bring a helper, then go.');
    expect(await json(await launch(lead.token, { delivery: held.deliveryId, recipe: 'helper' }))).toEqual([
      200,
      { handle: 'helper-1' },
    ]);
    h.runtime.exit(lead.container, 1);
    await vi.waitFor(() => {
      expect(stopping()).toEqual([['helper-1', 'its launcher lead-1 left the channel']]);
    });
  });

  it('is launch_failed when the launched agent does not come online, and the cap is given back', async () => {
    silent = '-helper-';
    const { lead, held } = await leadHolding('Bring a helper that never comes.');
    const [status, body] = (await json(
      await launch(lead.token, { delivery: held.deliveryId, recipe: 'helper' }),
    )) as readonly [number, { reason: string; error: string }];
    expect([status, body.reason]).toEqual([409, 'launch_failed']);
    expect(body.error).toMatch(
      /^launch_failed: agent asha-main-helper-[0-9a-f]{6} did not come online: not online within 1000 ms$/,
    );
    expect(h.logger.entries.filter((e) => e.event === 'agent.launch_failed').map((e) => [e.level, e.fields])).toEqual([
      [
        'error',
        {
          by: 'lead-1',
          recipe: 'helper',
          conversation: held.message.conversation,
          reason: 'AgentStartFailed',
          error: expect.any(Error) as Error,
        },
      ],
    ]);
    // Given back: the next launch for the conversation is tried, not refused launch_cap.
    const [again] = await json(await launch(lead.token, { delivery: held.deliveryId, recipe: 'helper' }));
    expect(again).toBe(409);
    expect(h.logger.entries.filter((e) => e.event === 'agent.launch_failed')).toHaveLength(2);
  });

  it('stops the launched agent at once when its conversation settled while it came online (R32)', async () => {
    let release!: () => void;
    helperHeld = new Promise<void>((resolve) => (release = resolve));
    const { lead, held, conversation } = await leadHolding('Bring a helper; I will not wait.');
    const answer = launch(lead.token, { delivery: held.deliveryId, recipe: 'helper' });
    await vi.waitFor(() => {
      expect(h.logger.entries.some((e) => e.event === 'agent.starting' && e.fields['member'] === 'helper')).toBe(true);
    });
    // The lead replies and acks before the helper is online: the conversation settles first.
    await post(
      Routes.agentMessages,
      { conversation, kind: 'output', text: 'Done without it.' },
      lead.token,
      inTrace(conversation),
    );
    await post(Routes.agentAck, { deliveryId: held.deliveryId }, lead.token);
    release();
    expect(await json(await answer)).toEqual([200, { handle: 'helper-1' }]);
    await vi.waitFor(() => {
      expect(stopping()).toEqual([['helper-1', `the conversation ${conversation} it was launched for settled`]]);
    });
  });

  it('kills a launch whose request closed before it was online, and logs agent.launch_abandoned', async () => {
    silent = '-helper-';
    const { lead, held, conversation } = await leadHolding('Bring a helper, but do not wait.');
    const hangUp = new AbortController();
    const sent = launch(lead.token, { delivery: held.deliveryId, recipe: 'helper' }, hangUp.signal).catch(
      (e: unknown) => e,
    );
    await vi.waitFor(() => {
      expect(h.logger.entries.some((e) => e.event === 'agent.starting' && e.fields['member'] === 'helper')).toBe(true);
    });
    hangUp.abort();
    expect(await sent).toBeInstanceOf(Error);
    await vi.waitFor(() => {
      expect(h.logger.entries.filter((e) => e.event === 'agent.launch_abandoned').map((e) => e.fields)).toEqual([
        {
          by: 'lead-1',
          recipe: 'helper',
          conversation,
          container: expect.stringMatching(/^asha-main-helper-/) as string,
        },
      ]);
    });
    expect(stopping()).toEqual([[null, 'its launch was abandoned']]);
    expect(h.runtime.stopRecords.filter((r) => r.name.includes('-helper-')).map((r) => r.mode)).toEqual(['kill']);
    expect(h.logger.entries.filter((e) => e.event === 'agent.launched')).toEqual([]);
  });
});

describe('teams and recipe documents through the CLI and the daemon (docs/plans/collaborating-agents.md A1, A9: R1, R2, R5, R11)', () => {
  const FILE_TOOLS = ['list_files', 'read_file', 'write_file', 'append_file'];
  /** teams/crew/ in the fixture root: a supervisor with a full-text workflow, and a helper. */
  async function crew(
    members = [
      { name: 'supervisor', recipe: 'boss.json' },
      { name: 'helper', recipe: 'helper.json' },
    ],
  ) {
    const dir = join(h.root, 'teams', 'crew');
    await mkdir(join(dir, 'flows'), { recursive: true });
    await writeFile(join(dir, 'team.json'), JSON.stringify({ id: 'crew', description: 'A crew.', members }));
    await writeFile(
      join(dir, 'boss.json'),
      JSON.stringify({
        ...FIXTURE_RECIPE,
        id: 'boss',
        description: 'Leads.',
        prompt: 'you lead the crew.',
        tools: FILE_TOOLS,
        documents: [{ path: 'flows/lead.md', fullText: true }],
      }),
    );
    await writeFile(join(dir, 'flows', 'lead.md'), '1. Say what you are asked to say.\n');
    await writeFile(
      join(dir, 'helper.json'),
      JSON.stringify({ ...FIXTURE_RECIPE, id: 'helper', description: 'Helps.', prompt: 'you help the crew.' }),
    );
    return dir;
  }

  it('launches every member on one channel, each under its team name though its image asks for hewo, and --status lists them (A9)', async () => {
    await crew();
    const launched = await h.cli(['--launch', 'team=crew']);
    expect([launched.code, launched.out], launched.err).toEqual([EXIT.ok, 'supervisor-1\nhelper-1\n']);
    expect(launched.err.split('\n').filter((l) => l.startsWith('› member') || l.endsWith(': Hi'))).toEqual([
      '› member supervisor (recipe boss)',
      '› supervisor-1: Hi',
      '› member helper (recipe helper)',
      '› helper-1: Hi',
    ]);
    const status = await h.cli(['--status']);
    expect(status.out.split('\n').filter((l) => l.startsWith('  '))).toEqual([
      '  helper-1  channel=main recipe=helper image=greeter-image',
      '  supervisor-1  channel=main recipe=boss image=greeter-image',
    ]);
    // The document went into the supervisor's container, at its path under /workspace; the helper's got none.
    expect(h.runtime.starts.map((s) => s.files.map((f) => [f.path, Buffer.from(f.content).toString('utf8')]))).toEqual([
      [['flows/lead.md', '1. Say what you are asked to say.\n']],
      [],
    ]);
  });

  it('a message to a topic reaches the members subscribed to it, each replying; an unknown topic is ✗ unknown_topic, nothing posted; topic= with to= is a usage error, and the route answers it 400 (patterns-phase-3 R20–R22, A11)', async () => {
    await crew([
      { name: 'supervisor', recipe: 'boss.json', topics: ['weather'] },
      { name: 'helper', recipe: 'helper.json', topics: ['sports', 'weather'] },
    ] as never);
    expect((await h.cli(['--launch', 'team=crew'])).code).toBe(EXIT.ok);
    const before = h.modelRequests.length;

    // The fake model says Hello World! to a request to say it, and passes anything else.
    const sports = await h.cli(['topic=sports', 'user=alice', 'message=Please say: Hello World.']);

    expect([sports.code, sports.out]).toEqual([EXIT.ok, 'Hello World!\n']);
    expect(sports.err).toContain('› alice → main: Please say: Hello World.\n');
    expect(sports.err).toContain('› output helper-1 → alice:\n');
    expect(sports.err).not.toContain('supervisor-1');
    // Delivered to helper-1 alone: one model request, the helper's, the message framed as one to everyone.
    expect(h.modelRequests.length - before).toBe(1);
    const posted = present(
      h.logger.entries.filter((e) => e.event === 'channel.posted' && e.fields['kind'] === 'input').at(-1),
      'the last channel.posted input entry',
    );
    expect(posted.fields).toMatchObject({ to: null, topic: 'sports' });

    const weather = await h.cli(['topic=weather', 'user=alice', 'message=Please say: Hello World.']);
    expect(weather.code).toBe(EXIT.ok);
    expect(weather.out).toBe('Hello World!\nHello World!\n');

    const unknown = await h.cli(['topic=finance', 'user=alice', 'message=Shares fell.']);
    expect([unknown.code, unknown.out]).toEqual([EXIT.failed, '']);
    expect(unknown.err).toBe('✗ unknown_topic: no agent on channel "main" subscribes to topic "finance"\n');
    expect(h.logger.entries.filter((e) => e.event === 'channel.posted' && e.fields['topic'] === 'finance')).toEqual([]);
    expect(h.logger.events('error')).toEqual([]);

    const both = await h.cli(['topic=sports', 'to=helper-1', 'user=alice', 'message=x']);
    expect([both.code, both.err.split('\n')[0]]).toEqual([
      EXIT.usage,
      'topic= and to= cannot be given together: a message goes to a topic or to one agent',
    ]);
    const route = await control(Routes.conversations, {
      method: 'POST',
      body: JSON.stringify({ channel: 'main', message: 'x', topic: 'sports', to: 'helper-1' }),
    });
    expect([route.status, await route.json()]).toEqual([
      400,
      { error: 'a message goes to a topic or to one agent (to), not both' },
    ]);
    const badName = await control(Routes.conversations, {
      method: 'POST',
      body: JSON.stringify({ channel: 'main', message: 'x', topic: 'Sports!' }),
    });
    expect([badName.status, await badName.json()]).toEqual([
      400,
      { error: 'topic must be a topic name (/^[a-z][a-z0-9-]{0,31}$/)' },
    ]);
  });

  it("an agent's ask prints the waiting line; that command, the answer, reaches the agent framed with its question and ends with its reply; a second answer, another user's, or a body with another key is refused (patterns-phase-3 R23–R27, A12)", async () => {
    const dir = join(h.root, 'teams', 'desk');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'team.json'),
      JSON.stringify({ id: 'desk', description: 'A desk.', members: [{ name: 'clerk', recipe: 'clerk.json' }] }),
    );
    await writeFile(
      join(dir, 'clerk.json'),
      JSON.stringify({
        ...FIXTURE_RECIPE,
        id: 'clerk',
        description: 'Asks first.',
        prompt: 'you ask before you act.',
        tools: ['ask_user'],
      }),
    );
    expect((await h.cli(['--launch', 'team=desk'])).code).toBe(EXIT.ok);

    const asked = await h.cli(['to=clerk-1', 'user=alice', 'message=Ask me first.']);
    expect([asked.code, asked.out]).toEqual([EXIT.ok, 'Shall I?\n']);
    const waiting = /^\? clerk-1 is waiting for your answer: asha user=alice conversation=(\S+) message="…"$/m.exec(
      asked.err,
    );
    expect(waiting, asked.err).not.toBeNull();
    const id = present(present(waiting, 'waiting')[1], 'waiting[1]');
    const posted = present(
      h.logger.entries.find((e) => e.event === 'channel.posted' && e.fields['asks'] === true),
      'the channel.posted entry whose asks is true',
    );
    expect(posted.fields).toMatchObject({ conversation: id, from: 'clerk-1', to: 'alice', kind: 'output', asks: true });

    // Another user's answer is refused, nothing posted; the wait stays.
    const bob = await h.cli(['user=bob', `conversation=${id}`, 'message=yes']);
    expect([bob.code, bob.out, bob.err]).toEqual([
      EXIT.failed,
      '',
      `✗ not_awaiting: conversation ${id} waits for alice's answer, not bob's\n`,
    ]);

    const before = h.modelRequests.length;
    const answer = await h.cli(['user=alice', `conversation=${id}`, 'message=yes']);
    expect([answer.code, answer.out]).toEqual([EXIT.ok, 'You said: yes\n']);
    expect(answer.err).not.toContain('waiting for your answer');
    // Delivered to clerk-1 alone, framed from answers: the answer, then the question.
    expect(h.modelRequests.length - before).toBe(1);
    const framed = present(
      conversation((h.modelRequests.at(-1) as { body: FakeModelRequest }).body).at(-1),
      'conversation(h.modelRequests.at(-1).body).at(-1)',
    ).content;
    expect(framed.endsWith('The user answered what you asked them:\nyes\nWhat you asked them:\nShall I?')).toBe(true);
    const input = present(
      h.logger.entries.filter((e) => e.event === 'channel.posted' && e.fields['kind'] === 'input').at(-1),
      'the last channel.posted input entry',
    );
    expect(input.fields).toMatchObject({
      conversation: id,
      from: 'alice',
      to: 'clerk-1',
      answers: posted.fields['id'],
    });

    // At most once per ask.
    const again = await h.cli(['user=alice', `conversation=${id}`, 'message=yes']);
    expect([again.code, again.err]).toEqual([
      EXIT.failed,
      `✗ not_awaiting: conversation ${id} is not waiting for an answer\n`,
    ]);
    expect(
      h.logger.entries.filter((e) => e.event === 'conversation.refused' && e.fields['reason'] === 'not_awaiting'),
    ).toHaveLength(2);
    expect(h.logger.events('error')).toEqual([]);

    const mixed = await h.cli(['user=alice', `conversation=${id}`, 'to=clerk-1', 'message=yes']);
    expect([mixed.code, mixed.err.split('\n')[0]]).toEqual([
      EXIT.usage,
      'conversation= answers what an agent asked: it takes only channel=, user= and message=, not to=',
    ]);
    for (const [body, error] of [
      [
        { channel: 'main', user: 'alice', conversation: id, message: 'yes', to: 'clerk-1' },
        'an answer (conversation) carries channel, user and message, and no other key: not to',
      ],
      [
        { channel: 'main', user: 'alice', conversation: id, message: 'yes', recipe: 'clerk' },
        'an answer (conversation) carries channel, user and message, and no other key: not recipe',
      ],
      [
        { channel: 'main', user: 'alice', conversation: id, message: 'yes', topic: 'news' },
        'an answer (conversation) carries channel, user and message, and no other key: not topic',
      ],
      [
        { channel: 'main', user: 'alice', conversation: id, message: 'yes', attachments: 'u1' },
        'an answer (conversation) carries channel, user and message, and no other key: not attachments',
      ],
      [
        { channel: 'main', user: 'alice', conversation: id, message: 'yes', budget: { posts: 2 } },
        'an answer (conversation) carries channel, user and message, and no other key: not budget',
      ],
      [
        { channel: 'main', conversation: id, message: 'yes' },
        'an answer (conversation) carries channel, user and message, and no other key',
      ],
    ] as const) {
      const route = await control(Routes.conversations, { method: 'POST', body: JSON.stringify(body) });
      expect([route.status, await route.json()]).toEqual([400, { error }]);
    }
  });

  it("each member's model request carries its own recipe's prompt, then its full-text document, in the system message (A1)", async () => {
    await crew();
    expect((await h.cli(['--launch', 'team=crew'])).code).toBe(EXIT.ok);
    const before = h.modelRequests.length;
    expect((await h.cli(['to=supervisor-1', 'message=Please say: Hello World.'])).code).toBe(EXIT.ok);
    expect((await h.cli(['to=helper-1', 'message=Please say: Hello World.'])).code).toBe(EXIT.ok);
    const systems = (
      h.modelRequests.slice(before) as { body: { messages: { role: string; content: string }[] } }[]
    ).map((r) => present(r.body.messages[0], 'r.body.messages[0]'));
    expect(systems).toHaveLength(2);
    expect(systems[0]).toEqual({
      role: 'system',
      content: `${channelInstructions('supervisor-1', ['helper-1'], 'you lead the crew.')}\n\n${GUIDANCE_PRECEDENCE}\n\nYour guidance, from flows/lead.md in your workspace:\n1. Say what you are asked to say.\n`,
    });
    expect(systems[1]).toEqual({
      role: 'system',
      content: channelInstructions('helper-1', ['supervisor-1'], 'you help the crew.'),
    });
  });

  it('a member whose recipe file is missing fails the launch naming it, and no container runs (R5, R11)', async () => {
    await crew([
      { name: 'supervisor', recipe: 'boss.json' },
      { name: 'ghost', recipe: 'ghost.json' },
    ]);
    const failed = await h.cli(['--launch', 'team=crew']);
    expect([failed.code, failed.out]).toEqual([EXIT.failed, '']);
    expect(failed.err).toBe(
      `✗ internal: ${join(h.root, 'teams', 'crew', 'team.json')}: member "ghost": recipe "ghost.json" does not exist in the team's folder\n`,
    );
    expect(h.runtime.starts).toEqual([]);
  });

  it('an unknown team is unknown_team; a launch naming both or neither of recipe= and team= is a usage error', async () => {
    const unknown = await h.cli(['--launch', 'team=nobody']);
    expect([unknown.code, unknown.err]).toEqual([
      EXIT.failed,
      '✗ unknown_team: no team named "nobody" (no teams/nobody/team.json)\n',
    ]);
    for (const argv of [
      ['--launch', 'team=crew', 'recipe=greeter'],
      ['--launch', 'channel=main'],
    ]) {
      const usage = await h.cli(argv);
      expect(usage.code, argv.join(' ')).toBe(EXIT.usage);
      expect(usage.err, argv.join(' ')).toMatch(
        /^--launch takes recipe=<recipe> or team=<team>, and optionally channel=<name>\n/,
      );
    }
    // The route refuses both, and neither, itself.
    for (const body of [{ channel: 'main', recipe: 'greeter', team: 'crew' }, { channel: 'main' }]) {
      const response = await control(Routes.agents, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: 'a launch names exactly one of recipe and team' });
    }
    expect(h.runtime.starts).toEqual([]);
  });
});

describe('streamed model output over SSE (docs/plans/model-streaming.md A3: R3, R4, R5; A4: R6)', () => {
  const USAGE = { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } };

  /** A control route's raw response text, read for `ms`, then hung up; and its headers. */
  async function rawFor(
    path: string,
    init: RequestInit,
    ms: number,
  ): Promise<{ status: number; type: string | null; cache: string | null; text: string }> {
    const controller = new AbortController();
    const response = await control(path, { ...init, signal: controller.signal });
    const decoder = new TextDecoder();
    let text = '';
    const timer = setTimeout(() => {
      controller.abort();
    }, ms);
    try {
      for await (const chunk of present<ReadableStream<Uint8Array>>(response.body, 'response.body'))
        text += decoder.decode(chunk, { stream: true });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      cache: response.headers.get('cache-control'),
      text,
    };
  }

  /** What every control stream's text must be: event and data lines, blank lines and heartbeat comments, never an id: line. */
  function expectSseShape(text: string): void {
    const lines = text.split('\n');
    const odd = lines.filter(
      (l) => l !== '' && l !== ': heartbeat' && !l.startsWith('event: ') && !l.startsWith('data: '),
    );
    expect(odd, 'lines that are not SSE event, data, blank or heartbeat').toEqual([]);
    expect(lines.filter((l) => l.startsWith('id:'))).toEqual([]);
    expect(text).not.toContain('event: heartbeat');
    expect(text).not.toContain('"type":"heartbeat"');
  }

  it("a conversation answers text/event-stream: the call's deltas with seq 0, 1 and its span id, model_done ok, then the reply; a heartbeat comment when idle", async () => {
    const posted = await rawFor(
      Routes.conversations,
      {
        method: 'POST',
        body: JSON.stringify({ channel: 'main', recipe: 'greeter', message: 'Please say: Hello World.' }),
      },
      1_500,
    );
    expect([posted.status, posted.type, posted.cache]).toEqual([200, 'text/event-stream', 'no-store']);
    expectSseShape(posted.text);
    // Idle past heartbeatMs (1,000 ms here) once the reply is in: the heartbeat is a comment.
    expect(posted.text).toContain('\n: heartbeat\n\n');
    const events = new SseDecoder().push(posted.text) as { type: string; [key: string]: unknown }[];
    const call = events.find((e) => e.type === 'model_done')?.['call'] as string;
    const conversation = present(
      events.find((e) => e.type === 'posted'),
      'the posted event',
    )['message'] as { conversation: string };
    const tail = events.slice(events.findIndex((e) => e.type === 'model_delta'));
    expect(tail.slice(0, 4)).toEqual([
      {
        type: 'model_delta',
        handle: 'hewo-1',
        conversation: conversation.conversation,
        call,
        seq: 0,
        part: 'tool_args',
        index: 0,
        name: 'reply',
        text: '{"text":"Hel',
      },
      {
        type: 'model_delta',
        handle: 'hewo-1',
        conversation: conversation.conversation,
        call,
        seq: 1,
        part: 'tool_args',
        index: 0,
        name: 'reply',
        text: 'lo World!"}',
      },
      { type: 'model_done', handle: 'hewo-1', conversation: conversation.conversation, call, outcome: 'ok' },
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ kind: 'status', text: 'ok' }) as { kind: string; text: string },
      }),
    ]);
    expect(
      tail.find((e) => e.type === 'message' && (e['message'] as { kind: string }).kind === 'output'),
    ).toBeDefined();
    // The call is the asha.chat span of the call that streamed.
    expect(call).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a recipe's launch, a team's launch and a channel watch answer text/event-stream in the same shape", async () => {
    const launch = await rawFor(
      Routes.agents,
      { method: 'POST', body: JSON.stringify({ channel: 'lab', recipe: 'greeter' }) },
      5_000,
    );
    expect([launch.status, launch.type, launch.cache]).toEqual([200, 'text/event-stream', 'no-store']);
    expectSseShape(launch.text);
    expect((new SseDecoder().push(launch.text) as { type: string }[]).map((e) => e.type).at(-1)).toBe('launched');

    const dir = join(h.root, 'teams', 'duo');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'team.json'),
      JSON.stringify({ id: 'duo', description: 'Two.', members: [{ name: 'one', recipe: 'one.json' }] }),
    );
    await writeFile(join(dir, 'one.json'), JSON.stringify({ ...FIXTURE_RECIPE, id: 'one', description: 'One.' }));
    const team = await rawFor(
      Routes.agents,
      { method: 'POST', body: JSON.stringify({ channel: 'lab', team: 'duo' }) },
      5_000,
    );
    expect([team.status, team.type, team.cache]).toEqual([200, 'text/event-stream', 'no-store']);
    expectSseShape(team.text);
    expect((new SseDecoder().push(team.text) as { type: string }[]).map((e) => e.type).at(-1)).toBe('team_launched');

    const watch = await rawFor(`${Routes.channel}?name=lab`, {}, 1_500);
    expect([watch.status, watch.type, watch.cache]).toEqual([200, 'text/event-stream', 'no-store']);
    expectSseShape(watch.text);
    expect(watch.text).toContain('\n: heartbeat\n\n');
    expect(present((new SseDecoder().push(watch.text) as { type: string }[])[0], "SseDecoder's first event").type).toBe(
      'watching',
    );
  });

  it('a failed call still publishes model_done with its reason, and the conversation ends', async () => {
    // A stream with no usage chunk: bad_response (R2b).
    modelStream = () =>
      sseText(
        llamaChunks({
          ...scriptOf({ tool_calls: [{ id: 'c1', function: { name: 'reply', arguments: '{"text":"x"}' } }] }),
          usage: null,
        }),
      );
    const bad = await rawFor(
      Routes.conversations,
      {
        method: 'POST',
        body: JSON.stringify({ channel: 'main', recipe: 'greeter', message: 'Please say: Hello World.' }),
      },
      3_000,
    );
    const events = new SseDecoder().push(bad.text) as { type: string; [key: string]: unknown }[];
    const done = events.filter((e) => e.type === 'model_done');
    expect(done.map((e) => e['outcome'])).toEqual(['bad_response']);
    expect(events.indexOf(present(done[0], 'done[0]'))).toBeGreaterThan(
      events.findIndex((e) => e.type === 'model_delta'),
    );
    expect(h.logger.events('error')).toContain('model.chat_failed');
  });

  it("a call after its delivery is acked is served and streamed; when its agent hangs up first it ends timeout, and the model server's request is aborted", async () => {
    await converse();
    const token = present(
      present(h.runtime.starts[0], 'h.runtime.starts[0]').env['ASHA_AGENT_TOKEN'],
      "h.runtime.starts[0].env['ASHA_AGENT_TOKEN']",
    );
    const trace = inTrace(present(conversations()[0], 'conversations()[0]'));
    const watchController = new AbortController();
    const watched: { type: string; [key: string]: unknown }[] = [];
    const watching = (async () => {
      try {
        for await (const event of controlEvents(
          await control(`${Routes.channel}?name=main`, { signal: watchController.signal }),
        ))
          watched.push(event);
      } catch (error) {
        if (!watchController.signal.aborted) throw error;
      }
    })();
    await vi.waitFor(() => {
      expect(watched.map((e) => e.type)).toContain('watching');
    });
    // In the conversation delivered earlier and acked (as the memory agent's extraction): served and streamed (R3).
    const served = await post(
      Routes.agentChat,
      { messages: [{ role: 'user', content: 'Please say: Hello World.' }], maxTokens: 8 },
      token,
      trace,
    );
    expect(served.status).toBe(200);
    await vi.waitFor(() => {
      expect(watched.filter((e) => e.type === 'model_done').map((e) => e['outcome'])).toEqual(['ok']);
    });
    expect(watched.filter((e) => e.type === 'model_delta').map((e) => e['conversation'])).toEqual([
      conversations()[0],
      conversations()[0],
    ]);

    // The model answers its headers and nothing more; the agent's request is closed, as its own bound would close it.
    modelStream = () => 'hang';
    let socketClosed!: () => void;
    const modelAborted = new Promise<void>((resolve) => (socketClosed = resolve));
    model.on('request', (req: import('node:http').IncomingMessage) => req.socket.once('close', socketClosed));
    const requests = h.modelRequests.length;
    const hangUp = new AbortController();
    const hanging = fetch(`${h.base}${Routes.agentChat}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...trace },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Please say: Hello World.' }], maxTokens: 8 }),
      signal: hangUp.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(h.modelRequests).toHaveLength(requests + 1);
    });
    hangUp.abort();
    await hanging;
    await modelAborted;
    await vi.waitFor(() => {
      expect(watched.filter((e) => e.type === 'model_done').map((e) => e['outcome'])).toEqual(['ok', 'timeout']);
    });
    const failed = h.logger.entries.filter((e) => e.event === 'model.chat_failed');
    expect(failed.map((e) => String(e.fields['error']))).toEqual([
      "Error: timeout: the agent's request closed before the answer",
    ]);
    watchController.abort();
    await watching;
  }, 15_000);

  it('a reader that stops reading past 1 MiB gets one error slow_reader after its buffered data, and its stream alone ends (A4)', async () => {
    // Over 8 MiB of thinking: more than the sockets hold, so the unread output passes 1 MiB in the daemon.
    const FRAGMENTS = 8_000;
    // Written chunk by chunk: a reader that keeps reading keeps up, and only the one that stopped falls behind.
    modelStream = (request) =>
      llamaChunks({
        ...scriptOf(fakeModel(request) as Parameters<typeof scriptOf>[0]),
        reasoning: Array.from({ length: FRAGMENTS }, () => 'x'.repeat(1024)),
        usage: USAGE,
      }).map((c) => sseText([c]));
    // A watcher that reads everything.
    const watchController = new AbortController();
    const watchResponse = await control(`${Routes.channel}?name=main`, { signal: watchController.signal });
    const watched: { type: string; [key: string]: unknown }[] = [];
    const watching = (async () => {
      try {
        for await (const event of controlEvents(watchResponse)) watched.push(event);
      } catch (error) {
        if (!watchController.signal.aborted) throw error;
      }
    })();
    // A conversation reader that stops reading as soon as the response starts.
    let paused!: import('node:http').IncomingMessage;
    const started = new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: h.daemon.port,
          method: 'POST',
          path: Routes.conversations,
          headers: { authorization: `Bearer ${h.credential}`, 'content-type': 'application/json' },
        },
        (res) => {
          res.pause();
          paused = res;
          resolve();
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ channel: 'main', recipe: 'greeter', message: 'Please say: Hello World.' }));
    });
    await started;
    await vi.waitFor(
      () => {
        expect(h.logger.events()).toContain('model.chat');
      },
      { timeout: 30_000 },
    );
    await vi.waitFor(
      () => {
        expect(h.logger.events('error')).toEqual(['stream.slow_reader']);
      },
      { timeout: 30_000 },
    );
    // The call completed, and the watcher received every delta.
    await vi.waitFor(
      () => {
        expect(watched.filter((e) => e.type === 'model_done')).toHaveLength(1);
      },
      { timeout: 30_000 },
    );
    expect(watched.filter((e) => e.type === 'model_delta')).toHaveLength(FRAGMENTS + 2);
    expect(
      present(
        watched.find((e) => e.type === 'model_done'),
        'the model_done event',
      )['outcome'],
    ).toBe('ok');
    // The stopped reader resumes: its buffered data, then the one error event, then the end of its stream.
    let text = '';
    paused.setEncoding('utf8');
    paused.on('data', (chunk: string) => (text += chunk));
    const ended = new Promise<void>((resolve) => paused.on('end', resolve));
    paused.resume();
    await ended;
    const events = new SseDecoder().push(text) as { type: string; [key: string]: unknown }[];
    expect(events.at(-1)).toEqual({
      type: 'error',
      reason: 'slow_reader',
      detail: 'the stream fell more than 1048576 bytes behind its reader, and was ended',
    });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'model_delta').length).toBeGreaterThan(0);
    // One error-level record, and the one stream it names.
    const slow = h.logger.entries.filter((e) => e.level === 'error');
    expect(slow.map((e) => [e.event, e.fields['route'], e.fields['channel']])).toEqual([
      ['stream.slow_reader', Routes.conversations, 'main'],
    ]);
    expect(present(slow[0], 'slow[0]').fields['unwrittenBytes']).toBeGreaterThan(1024 * 1024);
    watchController.abort();
    await watching;
  }, 60_000);
});

describe("one channel's stop over HTTP (docs/plans/portal-demo-stop.md A1: R1; A2: R2; A3: R3)", () => {
  /** POST /v1/channel/stop as the CLI sends it, with the credential. */
  const stopChannel = (channel: string, init: RequestInit = {}) =>
    control(Routes.channelStop, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, source: 'cli' }),
      ...init,
    });
  const eventsOf = (text: string) => new SseDecoder().push(text) as ChannelStopEvent[];
  /** The handle `--launch` printed. */
  const launch = async (recipe: string, channel: string): Promise<string> => {
    const launched = await h.cli(['--launch', `recipe=${recipe}`, `channel=${channel}`]);
    expect(launched.code).toBe(EXIT.ok);
    return launched.out.trim();
  };

  it("stops only the channel's agent, then the server only it needed, streaming each; the other channel answers and its watch stays open; a later launch serves the model again", async () => {
    const demo = await launch('rememberer', 'demo-1');
    const other = await launch('greeter', 'other');
    const watchController = new AbortController();
    const watch = await control(`${Routes.channel}?name=other`, { signal: watchController.signal });
    expect(watch.status).toBe(200);
    const watchReader = present<ReadableStream<Uint8Array>>(watch.body, 'watch.body').getReader();
    expect(h.modelServer.live).toEqual(new Set(['tiny-model', 'tiny-embed']));

    const response = await stopChannel('demo-1');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(eventsOf(await response.text())).toEqual([
      { type: 'stopping', channel: 'demo-1', handles: [demo] },
      { type: 'agent_stopped', handle: demo },
      { type: 'model_server_stopped', model: 'tiny-embed' },
      { type: 'stopped', channel: 'demo-1', handles: [demo], modelServers: ['tiny-embed'] },
    ]);
    // The chat model is still needed on the other channel: only the embedding server stopped (R3).
    expect(h.modelServer.stoppedIdle).toEqual([['tiny-embed']]);
    expect(
      h.logger.entries
        .filter((e) => e.event === 'agent.channel_stopped')
        .map((e) => [e.fields['channel'], e.fields['handles'], e.fields['source']]),
    ).toEqual([['demo-1', [demo], 'cli']]);
    expect(h.runtime.calls).toContain(
      `removeVolume ${present(
        h.runtime.calls.find((c) => c.startsWith('removeVolume') && c.endsWith('-demo-1')),
        'the removeVolume call for demo-1',
      ).slice('removeVolume '.length)}`,
    );
    expect(h.runtime.calls.some((c) => c.startsWith('removeVolume') && c.endsWith('-other'))).toBe(false);
    expect(h.logger.events('error')).toEqual([]);

    // The other channel's agent answers, and its watch, opened before the stop, shows the answer.
    const answered = await h.cli([`to=${other}`, 'channel=other', 'message=Please say: Hello World.']);
    expect([answered.code, answered.out]).toEqual([EXIT.ok, 'Hello World!\n']);
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('Hello World!')) {
      const { value, done } = await watchReader.read();
      if (done) throw new Error("the other channel's watch ended");
      seen += decoder.decode(value, { stream: true });
    }
    watchController.abort();

    // A later launch that needs the stopped model starts its server again, as a first launch does (R3).
    const servedBefore = h.modelServer.served.filter((m) => m === 'tiny-embed').length;
    await launch('rememberer', 'demo-2');
    expect(h.modelServer.served.filter((m) => m === 'tiny-embed')).toHaveLength(servedBefore + 1);
    expect(h.modelServer.live.has('tiny-embed')).toBe(true);
  });

  it('sends a heartbeat comment while the stop is held, then ends with stopped', async () => {
    const demo = await launch('greeter', 'demo-1');
    const exit = h.runtime.onStop;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.runtime.onStop = async (name, mode) => {
      await held;
      await exit(name, mode);
    };

    const response = await stopChannel('demo-1');
    const reader = present<ReadableStream<Uint8Array>>(response.body, 'response.body').getReader();
    const decoder = new TextDecoder();
    let text = '';
    // Read until the heartbeat (every heartbeatMs, 1,000 ms here) arrives while the agent is still stopping.
    while (!text.includes(': heartbeat\n\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before a heartbeat: ${text}`);
      text += decoder.decode(value, { stream: true });
    }
    expect(eventsOf(text)).toEqual([{ type: 'stopping', channel: 'demo-1', handles: [demo] }]);
    release();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    // Its chat model was needed by no other agent: its server stops too (R3).
    expect(eventsOf(text).map((e) => e.type)).toEqual(['stopping', 'agent_stopped', 'model_server_stopped', 'stopped']);
  });

  it('refuses, stopping nothing: 404 for a channel with no agent, 403 for a foreign Origin, 401 without the credential, 400 for a bad body, 503 while the daemon stops', async () => {
    await launch('greeter', 'demo-1');
    const body = JSON.stringify({ channel: 'demo-1', source: 'cli' });

    const unknown = await stopChannel('quiet');
    expect([unknown.status, await unknown.json()]).toEqual([
      404,
      { error: 'no agent is on channel "quiet"', reason: 'unknown_channel' },
    ]);
    const foreign = await raw(
      'POST',
      Routes.channelStop,
      { authorization: `Bearer ${h.credential}`, origin: 'http://evil.example', 'content-type': 'application/json' },
      { body },
    );
    expect(foreign.status).toBe(403);
    const anonymous = await fetch(`${h.base}${Routes.channelStop}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(anonymous.status).toBe(401);
    const bad = await control(Routes.channelStop, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'demo-1', source: 'web' }),
    });
    expect(bad.status).toBe(400);
    expect(h.runtime.stops).toEqual([]);
    expect(h.logger.events()).not.toContain('agent.channel_stopped');

    // While the daemon stops (held at its agent's stop), the route answers 503 and starts no channel stop.
    const exit = h.runtime.onStop;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.runtime.onStop = async (name, mode) => {
      await held;
      await exit(name, mode);
    };
    const daemonStop = h.daemon.stop();
    await vi.waitFor(() => {
      expect(h.runtime.stops).toHaveLength(1);
    });
    const during = await stopChannel('demo-1');
    expect([during.status, await during.json()]).toEqual([
      503,
      { error: 'the daemon is stopping', reason: 'stopping' },
    ]);
    release();
    await daemonStop;
    expect(h.logger.events()).not.toContain('agent.channel_stopped');
    expect(h.logger.events()).not.toContain('agent.channel_stop_failed');
  });

  it('asha --stop channel= against the real daemon: its lines and exit 0; again, the no-agent line and exit 1', async () => {
    const demo = await launch('rememberer', 'demo-1');
    await launch('greeter', 'other');

    const first = await h.cli(['--stop', 'channel=demo-1']);
    expect([first.code, first.out]).toEqual([EXIT.ok, `stopped ${demo}\nstopped the model server for tiny-embed\n`]);
    expect(first.err).toBe(`› stopping ${demo} on channel demo-1\n`);

    const again = await h.cli(['--stop', 'channel=demo-1']);
    expect([again.code, again.out, again.err]).toEqual([EXIT.failed, '', '✗ no agent is on channel "demo-1"\n']);
  });
});

describe("the daemon's lifetime, wired (docs/plans/idle-shutdown.md R1, R3, R6; A3, A6)", () => {
  /** A daemon of its own home with `lifetime`, its schedule the test's to fire. */
  async function lone(lifetime: LifetimeOptions) {
    const home = await mkdtemp(join(tmpdir(), 'asha-int-life-'));
    const paths = harnessPaths({ ASHA_HOME: home });
    const logger = new RecordingLogger();
    const schedule = new ManualSchedule();
    const modelServer = new FakeModelServer('x');
    const daemon = await startDaemon({
      paths,
      root: await fixtureRoot(),
      version: '0.0.0-test',
      build: 'test-build-1',
      pid: process.pid,
      logger,
      dependencies: { runtime: new FakeRuntime(), modelServer, store: new FakeStore(), ...REAL_STATE, fetch },
      heartbeatMs: 1_000,
      chatTimeoutMs: 1_000,
      schedule: schedule.schedule,
      lifetime,
      portal: builtPortal(),
    });
    const credential = (JSON.parse(await readFile(paths.daemonFile, 'utf8')) as { credential: string }).credential;
    const health = () =>
      fetch(`http://127.0.0.1:${String(daemon.port)}${Routes.health}`, {
        headers: { authorization: `Bearer ${credential}` },
      }).then((r) => r.text());
    const stopsRequested = () => logger.entries.filter((e) => e.event === 'daemon.stop_requested').map((e) => e.fields);
    return { daemon, logger, schedule, modelServer, health, stopsRequested };
  }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('arms its checks once it has started; idle past its bound it stops itself through the one trigger, every check cleared', async () => {
    const d = await lone({ modelIdleMs: 900_000, idleExitMs: 50 });
    expect(d.schedule.pending().sort((a, b) => a - b)).toEqual([50, 60_000]);
    // A request keeps it: the idle clock restarts when the request ends (the server counts it).
    await pause(60);
    await d.health();
    d.schedule.fire();
    expect(d.stopsRequested()).toEqual([]);
    await pause(60);
    d.schedule.fire();
    await d.daemon.stopped;
    const [requested] = d.stopsRequested();
    expect(requested).toMatchObject({ source: 'idle' });
    expect(present(requested, 'the stop request')['idleMs']).toBeGreaterThanOrEqual(50);
    // The model check ran twice, with its bound; nothing is left to fire.
    expect(d.modelServer.unloadCalls).toEqual([900_000, 900_000]);
    expect(d.schedule.pending()).toEqual([]);
    expect(d.logger.events()).toContain('daemon.stopped');
  });

  it('stops itself with source parent_exited once the process it exits with has ended', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('true');
    const pid = present(child.pid, "true's pid");
    await new Promise((resolve) => child.once('exit', resolve));
    const d = await lone({ modelIdleMs: 900_000, exitWithPid: pid });
    d.schedule.fire();
    await d.daemon.stopped;
    expect(d.stopsRequested()).toEqual([{ source: 'parent_exited', pid }]);
  });

  it('without an idle bound or a process to exit with, arms the model check alone, and a stop clears it', async () => {
    const d = await lone({ modelIdleMs: 900_000 });
    expect(d.schedule.pending()).toEqual([60_000]);
    await d.daemon.stop();
    expect(d.schedule.pending()).toEqual([]);
    expect(d.stopsRequested()).toEqual([{ source: 'call' }]);
  });
});
