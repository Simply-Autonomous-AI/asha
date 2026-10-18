// Dynamic spawning (docs/plans/patterns-phase-3.md R29–R31, A13): a recipe's launch grant, checked where its team's
// folder is known — each id a channel base name and a recipe file of the folder, whose recipe names none of persist,
// restart, launch, modules, roots and embeddingModel, on the granting recipe's image and model, starting within
// 30,000 ms — and refused anywhere else; the SDK's launch_agent: offered after the selected tools as the grant gives
// it, bounded at 35,000 ms, every refusal data for the model, and the turn's next request rebuilt for the new roster;
// and the agent route's wire contract on the real server.

import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NAME, handleHelloWorld, helloWorldTurn } from '../../images/hello-world/src/agent.js';
import {
  AgentTelemetry,
  COMMON_TOOL_DEFINITIONS,
  HarnessClient,
  HarnessRequestError,
  TRACE_LIMITS,
  decide,
  launchAgentTool,
  serveAgent,
  type AgentProcess,
  type BlackboardClient,
  type ChannelClient,
  type LaunchResult,
  type ModelClient,
  type ToolOutcomeLike,
} from '../../src/agent-sdk/index.js';
import type { LaunchOutcome } from '../../src/daemon/agents/index.js';
import { Definitions, TeamDefinitionError, DefinitionError, loadTeam } from '../../src/daemon/definitions/index.js';
import {
  LAUNCH_AGENT_TIMEOUT_MS,
  Routes,
  type AgentInfo,
  type AgentLaunchRequest,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ConversationMessage,
  type Delivery,
  type ModuleToolOffer,
  type PostRequest,
} from '../../src/shared/protocol.js';
import { present } from '../../src/shared/assert-present.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { FakeFetch, RecordingAgentLog } from '../helpers/fakes.js';
import { HELLO_WORLD_PERSONA } from '../helpers/recipes.js';
import { serverHarness } from '../helpers/server-harness.js';

const RECIPE = {
  image: 'hello-world',
  description: 'x',
  prompt: 'x',
  model: 'qwen3-8b-q4_k_m',
  startupTimeoutMs: 60_000,
  messageTimeoutMs: 60_000,
  chat: {},
  tools: [] as string[],
};

/** teams/spawn/ in a fresh root: `lead` granting `launch`, and each file of `files` (`<id>.json` → its recipe, or raw text). */
async function team(
  launch: unknown,
  files: Record<string, unknown> = { 'helper.json': { ...RECIPE, id: 'helper', startupTimeoutMs: 30_000 } },
) {
  const root = await mkdtemp(join(tmpdir(), 'asha-launch-'));
  const dir = join(root, 'teams', 'spawn');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'team.json'),
    JSON.stringify({ id: 'spawn', description: 'x', members: [{ name: 'lead', recipe: 'lead.json' }] }),
  );
  await writeFile(join(dir, 'lead.json'), JSON.stringify({ ...RECIPE, id: 'lead', launch }));
  for (const [name, recipe] of Object.entries(files))
    await writeFile(join(dir, name), typeof recipe === 'string' ? recipe : JSON.stringify(recipe));
  return { root, teams: join(root, 'teams'), file: join(dir, 'team.json'), dir };
}

describe("a recipe's launch grant (R29)", () => {
  it.each([[{ recipes: ['helper'], maxPerConversation: 1 }], [{ recipes: ['helper'], maxPerConversation: 3 }]])(
    'loads %j: the member carries the grant and the checked recipe',
    async (launch) => {
      const t = await team(launch);
      const loaded = await loadTeam(t.teams, 'spawn');
      expect(present(loaded.members[0], 'the first member').recipe.launch).toEqual(launch);
      expect(present(loaded.members[0], 'the first member').launchable.map((l) => [l.recipe.id, l.recipeFile])).toEqual(
        [['helper', join(t.dir, 'helper.json')]],
      );
    },
  );

  it('loads a grant of three recipes, each its own file', async () => {
    const files = Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [`${id}.json`, { ...RECIPE, id, startupTimeoutMs: 1_000 }]),
    );
    const t = await team({ recipes: ['a', 'b', 'c'], maxPerConversation: 2 }, files);
    expect(
      present((await loadTeam(t.teams, 'spawn')).members[0], 'the first member').launchable.map((l) => l.recipe.id),
    ).toEqual(['a', 'b', 'c']);
  });

  const SHAPE = 'launch must be {"recipes": [<1–3 distinct recipe ids>], "maxPerConversation": <1–3>}';
  it.each([
    ['recipes of 0 ids', { recipes: [], maxPerConversation: 1 }],
    ['recipes of 4 ids', { recipes: ['a', 'b', 'c', 'd'], maxPerConversation: 1 }],
    ['maxPerConversation 0', { recipes: ['helper'], maxPerConversation: 0 }],
    ['maxPerConversation 4', { recipes: ['helper'], maxPerConversation: 4 }],
    ['an id named twice', { recipes: ['helper', 'helper'], maxPerConversation: 1 }],
    ['another key', { recipes: ['helper'], maxPerConversation: 1, also: true }],
    ['../x', { recipes: ['../x'], maxPerConversation: 1 }],
    ['/abs', { recipes: ['/abs'], maxPerConversation: 1 }],
    ['not an object', ['helper']],
  ])('refuses %s at load, naming the member and the rule', async (_, launch) => {
    const t = await team(launch);
    const error = await loadTeam(t.teams, 'spawn').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as Error).message).toBe(`${t.file}: member "lead": recipe "lead.json": ${SHAPE}`);
  });

  const launched = (over: Record<string, unknown>) => ({
    'helper.json': { ...RECIPE, id: 'helper', startupTimeoutMs: 30_000, ...over },
  });
  it.each([
    [
      'an id that is no base name',
      { recipes: ['helper.v2'], maxPerConversation: 1 },
      { 'helper.v2.json': { ...RECIPE, id: 'helper.v2' } },
      `launch names "helper.v2": it becomes the launched agent's base name, and "helper.v2" is not a usable agent name (/^[a-z][a-z0-9-]{0,31}$/, not "user")`,
    ],
    [
      'a missing file',
      { recipes: ['nobody'], maxPerConversation: 1 },
      {},
      `launch names "nobody": no nobody.json in the team's folder`,
    ],
    ['a recipe with persist', undefined, launched({ persist: ['workspace'] }), 'it names persist'],
    ['a recipe with restart', undefined, launched({ restart: { max: 1, withinMs: 1_000 } }), 'it names restart'],
    [
      'a recipe with launch',
      undefined,
      launched({ launch: { recipes: ['helper'], maxPerConversation: 1 } }),
      'it names launch',
    ],
    ['a recipe with modules', undefined, launched({ modules: ['tav/search'] }), 'it names modules'],
    [
      'a recipe with roots',
      undefined,
      launched({ roots: [{ name: 'r', path: '/tmp', mode: 'read' }] }),
      'it names roots',
    ],
    ['a recipe with an embedding model', undefined, launched({ embeddingModel: 'e5' }), 'it names embeddingModel'],
    [
      'another image',
      undefined,
      launched({ image: 'memory' }),
      `runs on the granting recipe's image "hello-world" and model "qwen3-8b-q4_k_m", not "memory" and "qwen3-8b-q4_k_m"`,
    ],
    [
      'another model',
      undefined,
      launched({ model: 'other' }),
      `runs on the granting recipe's image "hello-world" and model "qwen3-8b-q4_k_m", not "hello-world" and "other"`,
    ],
    [
      'a startupTimeoutMs of 30,001',
      undefined,
      launched({ startupTimeoutMs: 30_001 }),
      "a launched recipe's startupTimeoutMs is at most 30000, not 30001",
    ],
    [
      'an id other than its file name',
      undefined,
      { 'helper.json': { ...RECIPE, id: 'other' } },
      'its id is "other", not its file name',
    ],
  ])('refuses %s, naming the member, the id and the rule', async (_, launch, files, rule) => {
    const t = await team(launch ?? { recipes: ['helper'], maxPerConversation: 1 }, files);
    const error = await loadTeam(t.teams, 'spawn').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as Error).message).toContain(`${t.file}: member "lead": launch names "`);
    expect((error as Error).message).toContain(rule);
  });

  it("refuses a launched recipe linked from outside the team's folder", async () => {
    const t = await team({ recipes: ['helper'], maxPerConversation: 1 }, {});
    const outside = join(t.root, 'elsewhere.json');
    await writeFile(outside, JSON.stringify({ ...RECIPE, id: 'helper', startupTimeoutMs: 1_000 }));
    await symlink(outside, join(t.dir, 'helper.json'));
    const error = await loadTeam(t.teams, 'spawn').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as Error).message).toMatch(
      /launch names "helper": helper\.json resolves to .*elsewhere\.json, outside the team's folder$/,
    );
  });

  it('accepts a startupTimeoutMs of 30,000', async () => {
    const t = await team({ recipes: ['helper'], maxPerConversation: 1 }, launched({ startupTimeoutMs: 30_000 }));
    expect(present((await loadTeam(t.teams, 'spawn')).members[0], 'the first member').launchable).toHaveLength(1);
  });

  it('refuses a recipe outside a team folder that names launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asha-launch-'));
    await mkdir(join(root, 'recipes'));
    await writeFile(
      join(root, 'recipes', 'solo.json'),
      JSON.stringify({ ...RECIPE, id: 'solo', launch: { recipes: ['helper'], maxPerConversation: 1 } }),
    );
    const error = await new Definitions(root).recipe('solo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DefinitionError);
    expect((error as Error).message).toBe(
      `${join(root, 'recipes', 'solo.json')}: launch is granted only to a recipe in a team's folder (teams/<team>/), whose recipe files it names`,
    );
  });
});

// ---------------------------------------------------------------- the SDK

const message = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  channel: 'main',
  conversation: 'm1',
  user: 'alice',
  from: 'alice',
  to: 'lead-1',
  kind: 'input',
  text: 'Bring in a helper and tell me its word.',
  at: '2026-10-02T00:00:00.000Z',
  ...over,
});
const call = (name: string, args: Record<string, unknown>, id = `call-${name}`) => ({ id, name, arguments: args });
const persona = { ...HELLO_WORLD_PERSONA, tools: [COMMON_TOOL_DEFINITIONS.read_file, launchAgentTool(['helper'])] };
const HELPER: AgentInfo = { handle: 'helper-1', recipe: 'helper', description: 'Holds a word.' };

/** A model answering each request with the next scripted calls (the last repeats), recording what it was sent. */
function model(...answers: ReturnType<typeof call>[][]) {
  const sent: ChatRequest[] = [];
  return {
    sent,
    client: {
      chat: (request: ChatRequest): Promise<ChatResponse> => {
        sent.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
        const toolCalls =
          answers.length > 1 ? present(answers.shift(), 'the next answer') : present(answers[0], 'the one answer');
        return Promise.resolve({ ok: true, text: '', toolCalls });
      },
    },
  };
}

describe('launch_agent in a turn (R30, R31)', () => {
  it("is offered after the selected tools, its recipe an enum of the grant, in the probes' words", () => {
    expect(launchAgentTool(['helper', 'checker'])).toEqual({
      type: 'function',
      function: {
        name: 'launch_agent',
        description:
          "Bring a new agent onto the channel, from a recipe in your team's folder. Returns its handle, which you can then consult.",
        parameters: {
          type: 'object',
          properties: { recipe: { type: 'string', enum: ['helper', 'checker'], description: 'The recipe to launch' } },
          required: ['recipe'],
        },
      },
    });
    expect(
      present(helloWorldTurn(message(), 'lead-1', [], persona).tools, 'the turn request tools').map(
        (t) => t.function.name,
      ),
    ).toEqual(['reply', 'list_agents', 'pass', 'read_file', 'launch_agent']);
  });

  it("after a launch that returns a handle, rebuilds the next request for the new roster, the turn's earlier messages after it", async () => {
    const m = model(
      [call('launch_agent', { recipe: 'helper' })],
      [call('consult', { requests: [{ to: 'helper-1', text: 'What is your word?' }] })],
    );
    const launches: string[] = [];
    const rosters: (readonly AgentInfo[])[] = [];
    const readRoster = vi.fn(() => Promise.resolve([HELPER]));
    const first = helloWorldTurn(message(), 'lead-1', [], persona);
    const calls = await decide({
      model: m.client,
      request: first,
      message: message(),
      roster: [],
      maxRounds: 3,
      maxCorrections: 2,
      launchAgent: (recipe): Promise<LaunchResult> => {
        launches.push(recipe);
        return Promise.resolve({ handle: 'helper-1' });
      },
      readRoster,
      rebuild: (roster) =>
        helloWorldTurn(
          message(),
          'lead-1',
          roster.map((a) => a.handle),
          persona,
        ),
      onRoster: (roster) => rosters.push(roster),
    });
    expect(launches).toEqual(['helper']);
    expect(readRoster).toHaveBeenCalledTimes(1);
    expect(rosters).toEqual([[HELPER]]);
    const rebuilt = helloWorldTurn(message(), 'lead-1', ['helper-1'], persona);
    expect(m.sent).toHaveLength(2);
    expect(m.sent[0]).toEqual(first);
    expect(m.sent[1]).toEqual({
      ...rebuilt,
      messages: [
        ...rebuilt.messages,
        { role: 'assistant', content: '', toolCalls: [call('launch_agent', { recipe: 'helper' })] },
        { role: 'tool', toolCallId: 'call-launch_agent', content: '{"handle":"helper-1"}' },
      ],
    });
    // consult is offered now, naming the new handle: the call is the turn's final one.
    const second = present(m.sent[1], 'the second sent request');
    expect(present(second.tools, "the second request's tools").map((t) => t.function.name)).toContain('consult');
    expect(calls).toEqual([call('consult', { requests: [{ to: 'helper-1', text: 'What is your word?' }] })]);
  });

  it("a launch refused is the model's data, and the turn is not rebuilt", async () => {
    const m = model(
      [call('launch_agent', { recipe: 'helper' })],
      [call('reply', { text: 'I could not bring one in.' })],
    );
    const readRoster = vi.fn(() => Promise.resolve([HELPER]));
    const first = helloWorldTurn(message(), 'lead-1', [], persona);
    await decide({
      model: m.client,
      request: first,
      message: message(),
      roster: [],
      maxRounds: 3,
      maxCorrections: 2,
      launchAgent: () => Promise.resolve({ error: 'launch_cap' }),
      readRoster,
      rebuild: () => first,
    });
    expect(readRoster).not.toHaveBeenCalled();
    const second = present(m.sent[1], 'the second sent request');
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'call-launch_agent',
      content: '{"error":"launch_cap"}',
    });
  });

  it('a turn offering launch_agent without the means to launch and rebuild is a defect, said before any model call', async () => {
    const m = model([call('reply', { text: 'x' })]);
    await expect(
      decide({
        model: m.client,
        request: helloWorldTurn(message(), 'lead-1', [], persona),
        message: message(),
        roster: [],
        maxRounds: 3,
        maxCorrections: 2,
      }),
    ).rejects.toThrow(
      "decide() was offered launch_agent with no way to launch and rebuild the turn: a defect in the agent's handler",
    );
    expect(m.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------- the client

const telemetry = () =>
  new AgentTelemetry({
    exporter: new InMemorySpanExporter(),
    writeLine: () => undefined,
    maxQueueSize: TRACE_LIMITS.maxQueueSize,
    maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
  });
const delivery = (m: ConversationMessage): Delivery => ({
  deliveryId: 'd1',
  message: m,
  traceparent: `00-${traceIdFor(m.conversation)}-${'a'.repeat(16)}-01`,
});
const REQUEST: AgentLaunchRequest = { delivery: 'd1', recipe: 'helper' };

function client(fetchImpl: FakeFetch) {
  const t = telemetry();
  const c = new HarnessClient({
    environment: { harnessUrl: 'http://host.test:1', agentToken: 't' },
    chatTimeoutMs: 1_000,
    requestTimeoutMs: 100,
    filesRequestTimeoutMs: 400,
    streamIdleTimeoutMs: 1_000,
    fetch: fetchImpl.fetch,
    telemetry: t,
  });
  /** Runs `f` inside a delivery's turn, as the SDK's calls are made, and gives back what it returned. */
  const inTurn = async <T>(f: () => Promise<T>): Promise<T> => {
    let out!: T;
    await t.inDelivery(delivery(message()), async () => {
      out = await f();
    });
    return out;
  };
  return { c, inTurn };
}

describe("the SDK's launch request (R30)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts {delivery, recipe} to the launch route and gives the model the handle', async () => {
    const fake = new FakeFetch(() => new Response('{"handle":"helper-1"}', { status: 200 }));
    const { c, inTurn } = client(fake);
    expect(await inTurn(() => c.launchAgent(REQUEST))).toEqual({ handle: 'helper-1' });
    expect(fake.requests.map((r) => [new URL(r.url).pathname, r.init?.method])).toEqual([[Routes.agentLaunch, 'POST']]);
    expect(fake.bodies()).toEqual([REQUEST]);
  });

  it.each(['not_holding_delivery', 'not_granted', 'launch_cap', 'launch_failed'])(
    'a 409 %s is {"error": reason}',
    async (reason) => {
      const { c, inTurn } = client(
        new FakeFetch(() => new Response(JSON.stringify({ error: `${reason}: x`, reason }), { status: 409 })),
      );
      expect(await inTurn(() => c.launchAgent(REQUEST))).toEqual({ error: reason });
    },
  );

  it('a 503 is {"error": "stopping"}', async () => {
    const { c, inTurn } = client(
      new FakeFetch(() => new Response('{"error":"the daemon is stopping","reason":"stopping"}', { status: 503 })),
    );
    expect(await inTurn(() => c.launchAgent(REQUEST))).toEqual({ error: 'stopping' });
  });

  it.each([
    [400, '{"error":"unknown field(s): x"}'],
    [401, '{"error":"token_invalid"}'],
    [409, '{"error":"x","reason":"something_else"}'],
  ])('a %i is a defect: HarnessRequestError', async (status, body) => {
    const { c, inTurn } = client(new FakeFetch(() => new Response(body, { status })));
    const error = await inTurn(() => c.launchAgent(REQUEST)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HarnessRequestError);
    expect((error as HarnessRequestError).status).toBe(status);
  });

  it(`a route that never answers is {"error": "timeout"} at ${String(LAUNCH_AGENT_TIMEOUT_MS)} ms, not before`, async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fake = new FakeFetch(
      (_, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            // The signal fired, so it (and its reason, an Error by the fetch/abort contract) is present.
            reject(present(init.signal, 'the fetch abort signal').reason as Error);
          });
        }),
    );
    const { c, inTurn } = client(fake);
    let result: LaunchResult | undefined;
    void inTurn(() => c.launchAgent(REQUEST)).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(LAUNCH_AGENT_TIMEOUT_MS - 1);
    expect([aborted, result]).toEqual([false, undefined]);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    await vi.waitFor(() => {
      expect(result).toEqual({ error: 'timeout' });
    });
    expect(LAUNCH_AGENT_TIMEOUT_MS).toBe(35_000);
  });
});

describe('a welcome with a launch grant (R29)', () => {
  /** A scripted harness client whose welcome carries `launch`; the model replies at once. */
  class Client implements ModelClient, ChannelClient, BlackboardClient {
    readonly requestTimeoutMs = 1_000;
    readonly modules: ModuleToolOffer[] = [];
    readonly offered: string[][] = [];
    readonly sent: ChatMessage[][] = [];
    constructor(private readonly launch: { recipes: string[]; maxPerConversation: number } | undefined) {}
    moduleCall(): Promise<ToolOutcomeLike> {
      return Promise.reject(new Error('unused'));
    }
    open() {
      const d = delivery(message());
      // A one-shot AsyncIterable, hand-rolled rather than an async generator: no `await` is needed to yield its
      // single delivery, so none of its methods are declared `async` (@typescript-eslint/require-await).
      function deliveries(): AsyncIterable<Delivery> {
        let done = false;
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<Delivery>> {
                if (done) return Promise.resolve({ done: true, value: undefined });
                done = true;
                return Promise.resolve({ done: false, value: d });
              },
            };
          },
        };
      }
      return Promise.resolve({
        handle: 'lead-1',
        channel: 'main',
        tools: ['read_file'],
        prompt: 'x',
        guidance: [],
        modules: this.modules,
        ...(this.launch === undefined ? {} : { launch: this.launch }),
        deliveries: deliveries(),
      });
    }
    post(request: PostRequest) {
      return Promise.resolve(message({ kind: request.kind, text: request.text }));
    }
    postFiles(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    async ack() {}
    consult(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    answerCall(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    roster(): Promise<AgentInfo[]> {
      return Promise.resolve([]);
    }
    launchAgent(): Promise<LaunchResult> {
      return Promise.resolve({ error: 'unused' });
    }
    blackboardRead(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    blackboardPost(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    chat(request: ChatRequest): Promise<ChatResponse> {
      this.offered.push((request.tools ?? []).map((t) => t.function.name));
      return Promise.resolve({ ok: true, text: '', toolCalls: [call('reply', { text: 'x' })] });
    }
  }
  const NO_SIGNALS: AgentProcess = { onTerminate: () => () => undefined, exit: () => undefined };
  const serve = (c: Client) =>
    serveAgent({
      client: c,
      telemetry: telemetry(),
      name: NAME,
      handler: handleHelloWorld,
      process: NO_SIGNALS,
      imageTools: {
        manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
        handlers: {},
      },
      workspace: tmpdir(),
      channelSpace: null,
      log: new RecordingAgentLog(),
      drainMs: 1_000,
    });

  it("offers launch_agent after the selected tools, its enum the grant's ids; without one, nothing of it", async () => {
    const granted = new Client({ recipes: ['helper'], maxPerConversation: 1 });
    await serve(granted);
    expect(granted.offered[0]).toEqual(['reply', 'list_agents', 'pass', 'read_file', 'launch_agent']);
    const plain = new Client(undefined);
    await serve(plain);
    expect(plain.offered[0]).toEqual(['reply', 'list_agents', 'pass', 'read_file']);
  });
});

// ---------------------------------------------------------------- the route

describe('the launch route on the real server (R30)', () => {
  const TOKEN = 'a'.repeat(64);
  async function route(
    launchFor: (token: string, request: AgentLaunchRequest, abandon: AbortSignal) => Promise<LaunchOutcome>,
    stopping = false,
  ) {
    const calls: { token: string; request: AgentLaunchRequest; abandon: AbortSignal }[] = [];
    const h = await serverHarness(
      {
        isAgentToken: (token: string) => token === TOKEN,
        launchFor: async (token: string, request: AgentLaunchRequest, abandon: AbortSignal) => {
          calls.push({ token, request, abandon });
          return launchFor(token, request, abandon);
        },
      },
      { stopping: () => stopping },
    );
    const send = (body: unknown, token: string | null = TOKEN, signal?: AbortSignal) =>
      fetch(`${h.base}${Routes.agentLaunch}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    return { h, calls, send };
  }

  it('answers 200 {handle} once the launch is online, the request passed as sent', async () => {
    const { h, calls, send } = await route(() => Promise.resolve({ ok: true, handle: 'helper-1' }));
    const response = await send(REQUEST);
    expect([response.status, await response.json()]).toEqual([200, { handle: 'helper-1' }]);
    expect(calls.map((c) => [c.token, c.request, c.abandon.aborted])).toEqual([[TOKEN, REQUEST, false]]);
    await h.close();
  });

  it.each(['not_holding_delivery', 'not_granted', 'launch_cap', 'launch_failed'] as const)(
    'answers 409 %s with its detail',
    async (reason) => {
      const { h, send } = await route(() => Promise.resolve({ ok: false, reason, detail: 'why' }));
      const response = await send(REQUEST);
      expect([response.status, await response.json()]).toEqual([409, { error: `${reason}: why`, reason }]);
      await h.close();
    },
  );

  it('answers 400 for another body, calling nothing', async () => {
    const { h, calls, send } = await route(() => Promise.resolve({ ok: true, handle: 'x' }));
    for (const [body, error] of [
      [{ delivery: 'd1' }, 'recipe must be a non-empty string'],
      [{ delivery: 'd1', recipe: 'helper', extra: 1 }, 'unknown field(s): extra'],
      [{ recipe: 'helper' }, 'delivery must be a non-empty string'],
    ] as const) {
      const response = await send(body);
      expect([response.status, await response.json()]).toEqual([400, { error }]);
    }
    expect(calls).toEqual([]);
    await h.close();
  });

  it('answers 401 without a token, and with another one, calling nothing', async () => {
    const { h, calls, send } = await route(() => Promise.resolve({ ok: true, handle: 'x' }));
    expect((await send(REQUEST, null)).status).toBe(401);
    expect((await send(REQUEST, 'b'.repeat(64))).status).toBe(401);
    expect(calls).toEqual([]);
    await h.close();
  });

  it('answers 503 stopping while the daemon stops, calling nothing; and when the launch finds it stopping', async () => {
    const stopped = await route(() => Promise.resolve({ ok: true, handle: 'x' }), true);
    const response = await stopped.send(REQUEST);
    expect([response.status, await response.json()]).toEqual([
      503,
      { error: 'the daemon is stopping', reason: 'stopping' },
    ]);
    expect(stopped.calls).toEqual([]);
    await stopped.h.close();
    const during = await route(() =>
      Promise.resolve({ ok: false, reason: 'stopping', detail: 'the daemon is stopping' }),
    );
    const late = await during.send(REQUEST);
    expect([late.status, await late.json()]).toEqual([503, { error: 'the daemon is stopping', reason: 'stopping' }]);
    await during.h.close();
  });

  it('aborts the launch when its request closes first', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { h, calls, send } = await route(async (_t, _r, abandon) => {
      await new Promise<void>((resolve) => {
        abandon.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      release();
      return { ok: false, reason: 'abandoned', detail: 'x' };
    });
    const hangUp = new AbortController();
    const sent = send(REQUEST, TOKEN, hangUp.signal).catch((e: unknown) => e);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    hangUp.abort();
    await held;
    expect(present(calls[0], 'the first call').abandon.aborted).toBe(true);
    expect(await sent).toBeInstanceOf(Error);
    await h.close();
  });
});
