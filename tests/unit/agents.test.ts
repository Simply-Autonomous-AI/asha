import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentRequestInvalid,
  AgentStartFailed,
  AgentSupervisor,
  TeamLaunchFailed,
  classify,
  parseChatRequest,
  parseEmbedRequest,
  MAX_EMBED_TEXTS,
  NoAgentToRead,
  MemoryEgressForbidden,
  exposesFiles,
} from '../../src/daemon/agents/index.js';
import { ChannelNameInvalid, Channels, UnknownHandle } from '../../src/daemon/channel/index.js';
import { ChannelFileSpaces } from '../../src/daemon/files/index.js';
import {
  ContainerIsolationFailed,
  ContainerRuntimeError,
  ImageBuildFailed,
  ImageGone,
} from '../../src/daemon/container-runtime/index.js';
import {
  DefinitionError,
  Definitions,
  DocumentMissing,
  DocumentsNeedFileTools,
  TeamDefinitionError,
  ToolSelectionInvalid,
  UnknownImage,
  UnknownRecipe,
  UnknownTeam,
} from '../../src/daemon/definitions/index.js';
import {
  MAX_PENDING_APPROVALS,
  requestSha256,
  type Caps,
  type InstalledModule,
} from '../../src/daemon/modules/index.js';
import { PrerequisiteMissing, ToolInstallFailed } from '../../src/daemon/host-tools/index.js';
import { ImageSourceMissing } from '../../src/daemon/images/index.js';
import { ABANDONED, CHAT_QUEUE_BOUND_MS, REQUEST_CLOSED } from '../../src/daemon/model-gateway/index.js';
import { ModelServerFailed } from '../../src/daemon/model-server/index.js';
import { ModelDigestMismatch, ModelFetchFailed } from '../../src/daemon/model-store/index.js';
import { LockHeld } from '../../src/daemon/process/pid-lock.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import {
  type ChannelMessage,
  type Delivery,
  type OnlinePhase,
  type TraceParent,
  type WatchEvent,
  AGENT_FAILURE_STATUS,
} from '../../src/shared/protocol.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import type { ChannelPointer } from '../../src/daemon/state/index.js';
import { DaemonTracer, type TraceRecord } from '../../src/daemon/traces/index.js';
import { StateStore, nodeStateFs } from '../../src/daemon/state/index.js';
import {
  FIXTURE_CHAT_DEFAULTS,
  FIXTURE_RECIPE,
  FakeModelServer,
  FakeRuntime,
  FakeStore,
  fixtureRoot,
  type FakeAttached,
} from '../helpers/daemon-fakes.js';
import { FakeFetch, MemoryUserLedger, RecordingLogger, hangUntilAborted, json } from '../helpers/fakes.js';
import { sseResponse } from '../helpers/llama-stream.js';
import { until } from '../helpers/persistence.js';
import {
  cloudToolManifest,
  installedModule,
  PLUGIN_DOCKERFILE,
  pluginManifest,
  providerManifest,
  sha256,
  storeSecrets,
  testModules,
  toolModuleManifest,
} from '../helpers/modules.js';

/**
 * A model server: `chat` answers the chat route; the prompt-store requests (D44) are answered as llama-server 0.5.0
 * answers them — `/tokenize` with a token id, `/completion` with its one token.
 */
function llamaServer(chat: (url: string, init: RequestInit | undefined) => Promise<Response> | Response): FakeFetch {
  return new FakeFetch((url, init) => {
    if (url.endsWith('/tokenize')) return json(200, { tokens: [13] });
    if (url.endsWith('/completion')) return json(200, { content: ' x' });
    return chat(url, init);
  });
}

/**
 * Lets the prompt-store request, which the chat does not wait for, run to its end against a fake server: every fake
 * answers at once, so 50 turns of the event loop are more than it takes (it finishes in under ten).
 */
async function storeSettled(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The agent's request to the daemon, still open: nobody hangs up (model-streaming R2). */
const OPEN = new AbortController().signal;

/** The fields of the one logged entry for `event`, asserted present. */
function entryFields(logger: RecordingLogger, event: string) {
  return present(
    logger.entries.find((e) => e.event === event),
    `log entry ${event}`,
  ).fields;
}

async function setup(
  recipe: typeof FIXTURE_RECIPE & { modules?: string[] } = FIXTURE_RECIPE,
  manifest: unknown = { tools: [] },
  options: { readonly installed?: ReadonlyMap<string, InstalledModule>; readonly home?: string } = {},
) {
  const root = await fixtureRoot(recipe, manifest);
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'asha-home-')));
  const logger = new RecordingLogger();
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const modelServer = new FakeModelServer('http://127.0.0.1:9999');
  const modelFetch = llamaServer(() =>
    sseResponse({
      content: ['hel', 'lo'],
      usage: { prompt_tokens: 1893, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1790 } },
    }),
  );
  let n = 0;
  const spans: TraceRecord[] = [];
  let spanIds = 0;
  const tracer = new DaemonTracer({
    clock: () => new Date('2026-09-26T00:00:00Z'),
    newSpanId: () => (++spanIds).toString(16).padStart(16, '0'),
    record: (r) => spans.push(r),
  });
  const channels = new Channels({
    logger,
    clock: () => new Date('2026-09-26T00:00:00Z'),
    newId: () => `m${String(++n)}`,
    onDeliveryTimeout: () => undefined,
    maxAgentPostsPerConversation: 32,
    users: new MemoryUserLedger(),
    tracer,
  });
  const main = channels.get('main');
  main.claimUser();
  const files = new ChannelFileSpaces({
    runtime,
    logger,
    homeId: 'abcd1234',
    runId: '0123abcd',
    clock: () => new Date('2026-09-26T00:00:00Z'),
    ownSecrets: () => [],
  });
  const supervisor = new AgentSupervisor({
    definitions: new Definitions(root),
    store,
    modelServer,
    runtime,
    logger,
    fetch: modelFetch.fetch,
    root,
    stagingDir: join(home, 'staging'),
    agentLogsDir: join(home, 'logs', 'agents'),
    daemonPort: () => 4321,
    chatTimeoutMs: 1_000,
    tracer,
    clock: () => new Date('2026-09-26T00:00:00Z'),
    state: new StateStore({
      dir: join(home, 'state'),
      fs: nodeStateFs,
      logger,
      clock: () => new Date('2026-09-26T00:00:00Z'),
      insideGitTree: () => Promise.resolve(false),
    }),
    daemonStartedAt: '2026-09-26T00:00:00.000Z',
    files,
    modules: testModules({ runtime, files, home, logger, root, installed: options.installed ?? new Map() }),
    userHome: home,
    ashaHome: home,
  });
  const phases: [OnlinePhase, string][] = [];
  const announcements: ChannelMessage[] = [];
  const sink = {
    phase: (phase: OnlinePhase, detail: string) => phases.push([phase, detail]),
    announced: (message: ChannelMessage) => announcements.push(message),
    resent: () => undefined,
  };
  const quiet = { phase: () => undefined, announced: () => undefined, resent: () => undefined };
  const inbox: Delivery[] = [];
  /** Scripts each "container" to connect as `base` and announce itself as soon as it starts, as the SDK does. */
  const connectOnStart = (base = 'greet') => {
    runtime.onStart = (spec) => {
      queueMicrotask(() => {
        const token = present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var');
        supervisor.connect(token, base, (d) => inbox.push(d));
        supervisor.post(token, { kind: 'status', text: 'Hi' });
      });
    };
  };
  const token = (i = 0) => {
    const start = present(runtime.starts[i], 'runtime.starts[i]');
    return present(start.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var');
  };
  /** A user message delivered to the agents on main; returns the agent's (chat) span in its trace, as its traceparent would name it. */
  const delivered = (): TraceParent => {
    const input = main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });
    return { traceId: traceIdFor(input.conversation), spanId: 'c'.repeat(16) };
  };
  return {
    root,
    home,
    logger,
    runtime,
    store,
    modelServer,
    modelFetch,
    channels,
    main,
    supervisor,
    phases,
    announcements,
    sink,
    quiet,
    inbox,
    connectOnStart,
    token,
    delivered,
    spans,
  };
}

describe('AgentSupervisor.ensureOnline', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });

  it('runs every phase in order and resolves once the agent has joined and announced itself', async () => {
    t.connectOnStart();

    const agent = await t.supervisor.ensureOnline('greeter', t.main, t.sink);

    expect(agent.handle).toBe('greet-1');
    expect(agent.channel).toBe('main');
    expect(t.phases).toEqual([
      ['container_runtime', 'ready'],
      ['model', 'tiny-model cached'],
      ['model_server', 'tiny-model serving'],
      ['image', 'asha-image-greeter-image built'],
    ]);
    expect(t.announcements).toEqual([
      {
        id: expect.any(String) as string,
        channel: 'main',
        conversation: null,
        from: 'greet-1',
        to: null,
        kind: 'status',
        text: 'Hi',
        at: '2026-09-26T00:00:00.000Z',
      },
    ]);
    expect(t.store.ensured).toEqual(['tiny-model']);
    expect(t.modelServer.served).toEqual(['tiny-model']);
    expect(t.runtime.images.map((i) => i.repository)).toEqual(['asha-image-greeter-image']);
    expect(t.runtime.starts).toHaveLength(1);
    const spec = present(t.runtime.starts[0], 't.runtime.starts[0]');
    expect(spec.name).toMatch(/^asha-main-greeter-[0-9a-f]{6}$/);
    expect(agent.container).toBe(spec.name);
    // The container runs the exact tag ensureImage made sure of: the repository and the source digest (D23).
    const image0 = present(t.runtime.images[0], 't.runtime.images[0]');
    expect(spec.image).toBe(`asha-image-greeter-image:${image0.sourceDigest.slice('sha256:'.length)}`);
    expect(spec.image).toMatch(/^asha-image-greeter-image:[0-9a-f]{64}$/);
    expect(spec.logFile).toBe(join(t.home, 'logs', 'agents', `${spec.name}.log`));
    expect(Object.keys(spec.env).sort(byCodeUnit)).toEqual(['ASHA_AGENT_TOKEN', 'ASHA_URL']);
    expect(spec.env['ASHA_URL']).toBe('http://host.test:4321');
    expect(spec.env['ASHA_AGENT_TOKEN']).toMatch(/^[0-9a-f]{64}$/);
    expect(t.supervisor.isAgentToken(t.token())).toBe(true);
    expect(t.supervisor.list()).toEqual([
      { handle: 'greet-1', channel: 'main', recipe: 'greeter', image: 'greeter-image' },
    ]);
    expect(t.main.handles()).toEqual(['greet-1']);
    expect(
      t.logger.entries
        .filter((e) => e.event === 'image.staged')
        .map((e) => [e.level, Object.keys(e.fields), e.fields['image'], typeof e.fields['ms']]),
    ).toEqual([['info', ['image', 'ms', 'loadavg'], 'greeter-image', 'number']]);
    // The host's load when it staged: os.loadavg()'s three averages, so a slow staging can be attributed.
    const staged = entryFields(t.logger, 'image.staged')['loadavg'];
    expect(staged).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect((staged as number[]).every((n) => Number.isFinite(n) && n >= 0)).toBe(true);
    expect(entryFields(t.logger, 'agent.starting')).toEqual({
      channel: 'main',
      recipe: 'greeter',
      image: 'greeter-image',
      tag: spec.image,
      container: spec.name,
      member: null,
      documents: [],
    });
    expect(entryFields(t.logger, 'agent.connected')).toEqual({
      handle: 'greet-1',
      asked: 'greet',
      channel: 'main',
      container: spec.name,
      logFile: spec.logFile,
    });
  });

  it('reuses the agent already online for the recipe on that channel', async () => {
    t.connectOnStart();
    const first = await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    t.phases.length = 0;

    const second = await t.supervisor.ensureOnline('greeter', t.main, t.sink);

    expect(second).toEqual(first);
    expect(t.phases).toEqual([['agent', 'greet-1 already online on main']]);
    expect(t.runtime.starts).toHaveLength(1);
    expect(t.runtime.readyCalls).toBe(1);
  });

  it('brings a separate agent online for the same recipe on another channel', async () => {
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const lab = await t.supervisor.ensureOnline('greeter', t.channels.get('lab'), t.sink);

    expect(lab.handle).toBe('greet-1');
    expect(lab.channel).toBe('lab');
    expect(t.runtime.starts.map((s) => s.name)).toEqual([
      expect.stringMatching(/^asha-main-greeter-/),
      expect.stringMatching(/^asha-lab-greeter-/),
    ]);
    expect(t.supervisor.list().map((a) => `${a.channel}/${a.handle}`)).toEqual(['lab/greet-1', 'main/greet-1']);
  });

  it('shares one launch between concurrent requests for the same recipe and channel', async () => {
    t.connectOnStart();
    const [a, b] = await Promise.all([
      t.supervisor.ensureOnline('greeter', t.main, t.sink),
      t.supervisor.ensureOnline('greeter', t.main, t.quiet),
    ]);
    expect(b).toEqual(a);
    expect(t.runtime.starts).toHaveLength(1);
  });

  it("says a log it cannot read in the tail's place, and logs agent.log_read_failed (the code review's round 4, R4-DESIGN-007)", async () => {
    t.runtime.onStart = (spec) => {
      queueMicrotask(() => {
        t.runtime.exit(spec.name, 1);
      });
    };
    const error = await t.supervisor.ensureOnline('greeter', t.main, t.sink).catch((e: unknown) => e);
    const logFile = present(t.runtime.starts[0], 't.runtime.starts[0]').logFile;
    expect((error as AgentStartFailed).tail).toBe(
      `(could not read ${logFile}: ENOENT: no such file or directory, open '${logFile}')`,
    );
    const read = t.logger.entries.filter((e) => e.event === 'agent.log_read_failed');
    expect(read.map((e) => [e.level, e.fields['logFile'], String(e.fields['error'])])).toEqual([
      ['warn', logFile, `Error: ENOENT: no such file or directory, open '${logFile}'`],
    ]);
  });

  it('fails naming the log file when the container exits before connecting; the tail rides on the error for the launching command alone (agent-persistence R15)', async () => {
    t.runtime.onStart = (spec) => {
      queueMicrotask(() => {
        void (async () => {
          await appendFile(spec.logFile, 'pass: zora asked\n');
          t.runtime.exit(spec.name, 1);
        })();
      });
    };

    const error = await t.supervisor.ensureOnline('greeter', t.main, t.sink).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentStartFailed);
    const start0 = present(t.runtime.starts[0], 't.runtime.starts[0]');
    const logFile = start0.logFile;
    expect((error as Error).message).toBe(
      `agent ${start0.name} did not come online: container exited with code 1 before coming online; its log: ${logFile}`,
    );
    // The tail is the launching command's to show (its ✗ line), in a field of its own: no log event embeds it.
    expect((error as AgentStartFailed).tail).toBe('pass: zora asked');
    expect(classify(error)).toBe('agent_start');
    expect(t.supervisor.list()).toEqual([]);
    expect(t.logger.events('error')).toEqual(['agent.exited_unexpectedly']);
    const exitedFields = entryFields(t.logger, 'agent.exited_unexpectedly');
    expect(exitedFields['handle']).toBeNull();
    expect(exitedFields['container']).toBe(start0.name);
    expect(exitedFields).toMatchObject({ code: 1, logFile });
    expect((exitedFields['error'] as Error).message).toBe(`container exited with code 1; its log: ${logFile}`);
    expect(JSON.stringify(t.logger.entries)).not.toContain('zora');
  });

  it('stops a container that does not connect within the recipe bound', async () => {
    const quick = await setup({ ...FIXTURE_RECIPE, startupTimeoutMs: 50 });

    const error = await quick.supervisor.ensureOnline('greeter', quick.main, quick.sink).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentStartFailed);
    expect((error as Error).message).toContain('not online within 50 ms');
    expect(quick.runtime.stops).toEqual([present(quick.runtime.starts[0], 'quick.runtime.starts[0]').name]);
  });

  it('confines the container to the daemon port before starting it: ensureReady gets that port (R10)', async () => {
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    expect(t.runtime.readyPorts).toEqual([4321]);
    expect(t.runtime.starts).toHaveLength(1);
  });

  it('a launch whose image was pruned between ensureImage and its create fails once, naming ImageGone, and never retries: one ensureImage, one start (debt-paydown-2 R5, A4)', async () => {
    t.connectOnStart();
    const tag = `asha-image-greeter:${'a'.repeat(64)}`;
    t.runtime.failStartWith = new ImageGone(tag);

    const error = await t.supervisor.ensureOnline('greeter', t.main, t.sink).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentStartFailed);
    expect((error as Error).message).toContain(
      `container failed: image ${tag} was removed while this launch was starting (an image prune of another asha server); launch again to rebuild it`,
    );
    expect(t.runtime.images).toHaveLength(1);
    expect(t.runtime.starts).toHaveLength(1);
    expect(t.supervisor.list()).toEqual([]);
  });

  it('fails the launch and starts no container when the runtime cannot confine it (A13)', async () => {
    t.connectOnStart();
    t.runtime.readyError = new ContainerIsolationFailed('rule install', 'iptables-restore: line 2 failed');

    const error = await t.supervisor.ensureOnline('greeter', t.main, t.sink).catch((e: unknown) => e);

    expect(error).toBe(t.runtime.readyError);
    expect(classify(error)).toBe('container_runtime');
    expect(t.runtime.readyPorts).toEqual([4321]);
    expect(t.runtime.starts).toEqual([]);
    expect(t.runtime.images).toEqual([]);
    expect(t.modelServer.served).toEqual([]);
    expect(t.phases).toEqual([]);
    expect(t.supervisor.list()).toEqual([]);
  });

  it('delivers the tools its recipe selects with the agent, for its welcome event (agent-tools R1, A1)', async () => {
    const two = [
      {
        name: 'count_words',
        description: 'Counts words.',
        parameters: { type: 'object', properties: {} },
        class: 'files',
        timeoutMs: 50,
      },
      {
        name: 'summarise',
        description: 'Summarises.',
        parameters: { type: 'object', properties: {} },
        class: 'files',
        timeoutMs: 50,
      },
    ];
    const u = await setup({ ...FIXTURE_RECIPE, tools: ['count_words', 'read_file'] }, { tools: two });
    let connected: unknown;
    u.runtime.onStart = (spec) => {
      queueMicrotask(() => {
        const token = present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var');
        connected = u.supervisor.connect(token, 'greet', () => undefined);
        u.supervisor.post(token, { kind: 'status', text: 'Hi' });
      });
    };

    const agent = await u.supervisor.ensureOnline('greeter', u.main, u.sink);

    expect(agent.tools).toEqual(['count_words', 'read_file']);
    expect((connected as { tools: string[] }).tools).toEqual(['count_words', 'read_file']);
    // The selection travels in the welcome, never the environment (enterprise-targets R12).
    expect(Object.keys(present(u.runtime.starts[0], 'u.runtime.starts[0]').env).sort(byCodeUnit)).toEqual([
      'ASHA_AGENT_TOKEN',
      'ASHA_URL',
    ]);
  });

  it.each([
    [
      'an unknown tool',
      ['read_file', 'nope'],
      [],
      'unknown_tool',
      'selects tool "nope", which neither image "greeter-image" (images/greeter-image/image.json), the common tools, the selectable channel tools nor the decide tool declare',
    ],
    [
      'an image tool named like a common tool',
      ['read_file'],
      [
        {
          name: 'read_file',
          description: 'x',
          parameters: { type: 'object', properties: {} },
          class: 'files',
          timeoutMs: 50,
        },
      ],
      'name_conflict',
      'tool "read_file" is declared by both the common tools (the agent SDK) and image "greeter-image" (images/greeter-image/image.json)',
    ],
    [
      'a command tool',
      ['run'],
      [
        {
          name: 'run',
          description: 'x',
          parameters: { type: 'object', properties: {} },
          class: 'command',
          timeoutMs: 50,
        },
      ],
      'class_forbidden',
      'selects tool "run", which image "greeter-image" (images/greeter-image/image.json) declares with class "command": a tool that runs a command or reaches a network is never an image tool; make it a harness plugin module (docs/plans/extension-modules.md R28–R33) and grant it',
    ],
    [
      'a network tool',
      ['fetch_url'],
      [
        {
          name: 'fetch_url',
          description: 'x',
          parameters: { type: 'object', properties: {} },
          class: 'network',
          timeoutMs: 50,
        },
      ],
      'class_forbidden',
      'selects tool "fetch_url", which image "greeter-image" (images/greeter-image/image.json) declares with class "network": a tool that runs a command or reaches a network is never an image tool; make it a harness plugin module (docs/plans/extension-modules.md R28–R33) and grant it',
    ],
    [
      'twelve tools',
      [
        'list_files',
        'read_file',
        'write_file',
        'append_file',
        'blackboard_read',
        'blackboard_post',
        't1',
        't2',
        't3',
        't4',
        't5',
        't6',
      ],
      ['t1', 't2', 't3', 't4', 't5', 't6'].map((name) => ({
        name,
        description: 'x',
        parameters: { type: 'object', properties: {} },
        class: 'files',
        timeoutMs: 50,
      })),
      'too_many_tools',
      'selects 12 tools and grants 0 module tools: 12, over the limit of 11 (16 per model request, less 5 reserved for the 5 channel tools)',
    ],
  ])(
    'refuses %s in the recipe before anything starts: no runtime, model, image or container (A1, A2, A12)',
    async (_, tools, manifestTools, problem, detail) => {
      const u = await setup({ ...FIXTURE_RECIPE, tools }, { tools: manifestTools });
      u.connectOnStart();

      const error = await u.supervisor.ensureOnline('greeter', u.main, u.sink).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ToolSelectionInvalid);
      expect((error as ToolSelectionInvalid).problem).toBe(problem);
      expect((error as Error).message).toBe(`recipes/greeter.json: ${detail}`);
      expect(u.runtime.calls).toEqual([]);
      expect(u.runtime.images).toEqual([]);
      expect(u.store.ensured).toEqual([]);
      expect(u.modelServer.served).toEqual([]);
      expect(u.phases).toEqual([]);
    },
  );

  it('reports an unknown recipe without touching the runtime', async () => {
    const error = await t.supervisor.ensureOnline('nope', t.main, t.sink).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownRecipe);
    expect(t.runtime.readyCalls).toBe(0);
  });
});

describe('AgentSupervisor lifecycle', () => {
  it('takes an agent off the channel when its stream closes, and stops its container once no exit has come within RESTART_EXIT_WAIT_MS (patterns-phase-3 R11)', async () => {
    const t = await setup();
    t.connectOnStart();
    const agent = await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const token = t.token();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      t.supervisor.disconnect(token);
      await vi.advanceTimersByTimeAsync(0);
      // Off the channel at once, as before; its container is not stopped before the wait for its exit has passed.
      expect(t.main.isMember(agent.handle)).toBe(false);
      expect(t.runtime.stops).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(t.main.isMember(agent.handle)).toBe(false);
    expect(t.runtime.stops).toEqual([agent.container]);
    // It is ending already: it gets its grace to finish.
    expect(t.runtime.stopModes).toEqual(['drain']);
    expect(t.supervisor.list()).toEqual([]);
    expect(t.supervisor.isAgentToken(token)).toBe(false);
    expect(t.logger.events('error')).toEqual([]);
  });

  it('does not count a connected agent as online until it announces itself, and refuses other posts until then', async () => {
    const t = await setup();
    let token = '';
    let connected!: () => void;
    const joined = new Promise<void>((resolve) => (connected = resolve));
    t.runtime.onStart = (spec) => {
      queueMicrotask(() => {
        token = present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var');
        t.supervisor.connect(token, 'greet', () => undefined);
        connected();
      });
    };
    const pending = t.supervisor.ensureOnline('greeter', t.main, t.sink);
    await joined;

    expect(t.supervisor.list()).toEqual([]);
    expect(() => t.supervisor.post(token, { conversation: 'c', kind: 'output', text: 'x' })).toThrow(
      'announce yourself with a status message before posting',
    );
    t.supervisor.post(token, { kind: 'status', text: 'Hi' });
    await expect(pending).resolves.toMatchObject({ handle: 'greet-1' });
    expect(t.supervisor.list()).toEqual([
      { handle: 'greet-1', channel: 'main', recipe: 'greeter', image: 'greeter-image' },
    ]);
  });

  it('refuses a second channel stream for the same agent, and channel use before connecting', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    expect(() => t.supervisor.connect(t.token(), 'greet', () => undefined)).toThrow(
      'greet-1 already has a channel stream open',
    );
    expect(() => t.supervisor.post('not-a-token', { conversation: 'c', kind: 'output', text: 'x' })).toThrow(
      AgentRequestInvalid,
    );
  });

  it("posts and acks on the agent's own channel under its handle", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const user = t.main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });

    const reply = t.supervisor.post(
      t.token(),
      { conversation: user.conversation, kind: 'output', text: 'hello' },
      'd'.repeat(16),
    );
    t.supervisor.ack(t.token(), present(t.inbox[0], 't.inbox[0]').deliveryId);

    expect(reply).toMatchObject({ channel: 'main', from: 'greet-1', to: 'user-1', kind: 'output', text: 'hello' });
    expect(t.main.working(user.conversation)).toEqual([]);
  });

  it('stopHandle stops the agent with that handle on that channel only', async () => {
    const t = await setup();
    t.connectOnStart();
    const main = await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    await t.supervisor.ensureOnline('greeter', t.channels.get('lab'), t.sink);

    await t.supervisor.stopHandle('main', 'greet-1', 'held a delivery past its bound');

    expect(t.runtime.stops).toEqual([main.container]);
    // A delivery-timeout offender is killed at once: the work a drain would wait for is what overran.
    expect(t.runtime.stopModes).toEqual(['kill']);
    expect(t.logger.entries.filter((e) => e.event === 'agent.exited').map((e) => e.fields['code'])).toEqual([137]);
    expect(t.logger.events('error')).toEqual([]);
    expect(t.supervisor.list().map((a) => `${a.channel}/${a.handle}`)).toEqual(['lab/greet-1']);
  });

  it('stopAll drains every running agent, then launches nothing more', async () => {
    const t = await setup();
    t.connectOnStart();
    const agent = await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    await t.supervisor.stopAll('daemon stopping');
    expect(t.runtime.stops).toEqual([agent.container]);
    expect(t.runtime.stopModes).toEqual(['drain']);

    // A launch reaching the container step after the stop began starts no container.
    await expect(t.supervisor.launchNew('greeter', t.main, t.quiet)).rejects.toThrow(
      `did not come online: the daemon is stopping`,
    );
    expect(t.runtime.starts).toHaveLength(1);
    expect(t.supervisor.list()).toEqual([]);
  });

  it('logs at error an agent killed at the end of its stop grace, naming its grace and its log file, never quoting it: it neither finished nor reported its work', async () => {
    const t = await setup();
    t.connectOnStart();
    const agent = await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    await appendFile(agent.logFile, 'pass: zora asked\n');
    t.runtime.onStop = (name) => {
      t.runtime.exit(name, 137);
      return Promise.resolve();
    };

    await t.supervisor.stopAll('daemon stopping');

    const killed = t.logger.entries.filter((e) => e.level === 'error');
    expect(killed.map((e) => [e.event, e.fields['container'], e.fields['code']])).toEqual([
      ['agent.stop_killed', agent.container, 137],
    ]);
    const killed0 = present(killed[0], 'killed[0]');
    expect((killed0.fields['error'] as Error).message).toBe(
      `killed 70 s after SIGTERM, before it exited by itself; its log: ${agent.logFile}`,
    );
    expect(killed0.fields['logFile']).toBe(agent.logFile);
    expect(JSON.stringify(t.logger.entries)).not.toContain('zora');
  });

  it('forwards a chat to the model endpoint with the merged sampling settings and logs it', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);

    const response = await t.supervisor.chat(
      t.token(),
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
      t.delivered(),
      OPEN,
    );
    await storeSettled();

    expect(response).toEqual({ ok: true, text: 'hello', toolCalls: [] });
    // The chat, then — the recipe's first answered call on this server — the prompt-store request (D44).
    expect(t.modelFetch.requests.map((r) => r.url)).toEqual([
      'http://127.0.0.1:9999/v1/chat/completions',
      'http://127.0.0.1:9999/tokenize',
      'http://127.0.0.1:9999/completion',
    ]);
    expect(t.modelFetch.bodies()).toEqual([
      // The recipe's temperature 0 wins over the catalogue's 0.5; the rest of the catalogue defaults stay.
      {
        temperature: 0,
        chat_template_kwargs: FIXTURE_CHAT_DEFAULTS.chat_template_kwargs,
        model: 'tiny-model',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        stream: true,
        stream_options: { include_usage: true },
        return_progress: true,
      },
      { content: '.' },
      { prompt: [13], n_predict: 1 },
    ]);
    // One model.chat per successful call, carrying the server's prompt token counts (prompt-prefix R10, A6) and the
    // stream's own figures (model-streaming R8): the opening, two content, the finish and the usage chunk.
    const chats = t.logger.entries.filter((e) => e.event === 'model.chat');
    expect(chats.map((e) => ({ ...e.fields, ms: typeof e.fields['ms'], ttfcMs: typeof e.fields['ttfcMs'] }))).toEqual([
      {
        handle: 'greet-1',
        channel: 'main',
        model: 'tiny-model',
        ms: 'number',
        ttfcMs: 'number',
        chunks: 5,
        promptTokens: 1893,
        completionTokens: 2,
        cachedTokens: 1790,
        toolCalls: [],
      },
    ]);
    // The counts stay in the daemon: the agent's ChatResponse carries neither.
    expect(Object.keys(response)).toEqual(['ok', 'text', 'toolCalls']);
  });

  it('fails a 2xx chat without the prompt token counts as bad_response, logged as a failure, not model.chat (prompt-prefix R10)', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const unpinned = new FakeFetch(() =>
      sseResponse({ content: ['hello'], usage: { prompt_tokens: 12, completion_tokens: 1 } }),
    );
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = unpinned.fetch;

    const response = await t.supervisor.chat(
      t.token(),
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
      t.delivered(),
      OPEN,
    );

    expect(response).toEqual({
      ok: false,
      reason: 'bad_response',
      detail: 'usage.prompt_tokens_details.cached_tokens is not a non-negative integer: null',
    });
    expect(t.logger.events('error')).toEqual(['model.chat_failed']);
    expect(t.logger.entries.filter((e) => e.event === 'model.chat')).toEqual([]);
  });

  it("refuses, with no model call, a chat offering a tool outside the agent's channel, selected and granted tools (agent-tools R1)", async () => {
    const t = await setup({ ...FIXTURE_RECIPE, tools: ['read_file'] });
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const tool = (name: string) => ({
      type: 'function',
      function: { name, description: 'x', parameters: { type: 'object', properties: {} } },
    });

    const error = await t.supervisor
      .chat(
        t.token(),
        {
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 8,
          tools: [tool('reply'), tool('read_file'), tool('write_file')],
        },
        t.delivered(),
        OPEN,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentRequestInvalid);
    expect((error as Error).message).toBe(
      'tools "write_file" are not among greet-1\'s channel, selected, granted and answer tools',
    );
    expect(t.modelFetch.requests).toEqual([]);
    // Its own selection and the channel tools are served (the chat, then the recipe's one prompt-store request).
    await t.supervisor.chat(
      t.token(),
      {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 8,
        tools: [tool('reply'), tool('pass'), tool('read_file')],
      },
      t.delivered(),
      OPEN,
    );
    await storeSettled();
    expect(t.modelFetch.requests.map((r) => r.url)).toEqual([
      'http://127.0.0.1:9999/v1/chat/completions',
      'http://127.0.0.1:9999/tokenize',
      'http://127.0.0.1:9999/completion',
    ]);
  });

  it('names in model.chat the tools the model called, in order, and never their arguments (agent-tools A10)', async () => {
    const t = await setup({ ...FIXTURE_RECIPE, tools: ['read_file', 'write_file'] });
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const call = (id: string, name: string, args: string) => ({
      id,
      name,
      fragments: [args.slice(0, 10), args.slice(10)],
    });
    const withCalls = llamaServer(() =>
      sseResponse({
        toolCalls: [
          call('w', 'write_file', '{"path":"notes.txt","content":"secret line"}'),
          call('r', 'read_file', '{"path":"notes.txt"}'),
        ],
        usage: { prompt_tokens: 1865, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } },
      }),
    );
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = withCalls.fetch;
    const tool = (name: string) => ({
      type: 'function',
      function: { name, description: 'x', parameters: { type: 'object', properties: {} } },
    });

    const response = await t.supervisor.chat(
      t.token(),
      {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 8,
        tools: [tool('reply'), tool('read_file'), tool('write_file')],
      },
      t.delivered(),
      OPEN,
    );

    expect(response.ok && response.toolCalls.map((c) => c.name)).toEqual(['write_file', 'read_file']);
    const chats = t.logger.entries.filter((e) => e.event === 'model.chat');
    expect(chats.map((e) => ({ ...e.fields, ms: typeof e.fields['ms'], ttfcMs: typeof e.fields['ttfcMs'] }))).toEqual([
      {
        handle: 'greet-1',
        channel: 'main',
        model: 'tiny-model',
        ms: 'number',
        ttfcMs: 'number',
        chunks: 7,
        promptTokens: 1865,
        completionTokens: 30,
        cachedTokens: 0,
        toolCalls: ['write_file', 'read_file'],
      },
    ]);
    expect(JSON.stringify(chats)).not.toContain('secret line');
  });

  it("admits an image's answer tools only from that image's agents (the memory image's extraction calls)", async () => {
    const t = await setup(FIXTURE_RECIPE, { tools: [], answerTools: ['save_facts'] });
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const save = {
      type: 'function',
      function: { name: 'save_facts', description: 'x', parameters: { type: 'object', properties: {} } },
    };
    await t.supervisor.chat(
      t.token(),
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, tools: [save], requireToolCall: true },
      t.delivered(),
      OPEN,
    );
    await storeSettled();
    expect(t.modelFetch.requests.map((r) => r.url)).toEqual([
      'http://127.0.0.1:9999/v1/chat/completions',
      'http://127.0.0.1:9999/tokenize',
      'http://127.0.0.1:9999/completion',
    ]);

    const u = await setup();
    u.connectOnStart();
    await u.supervisor.ensureOnline('greeter', u.main, u.sink);
    await expect(
      u.supervisor.chat(
        u.token(),
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, tools: [save] },
        u.delivered(),
        OPEN,
      ),
    ).rejects.toThrow('tools "save_facts" are not among');
    expect(u.modelFetch.requests).toEqual([]);
  });

  it('logs a failed model call as an error and returns the failure as data', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const failing = new FakeFetch(() => json(503, { error: 'loading' }));
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = failing.fetch;

    const response = await t.supervisor.chat(
      t.token(),
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
      t.delivered(),
      OPEN,
    );

    expect(response).toEqual({ ok: false, reason: 'upstream_error', detail: 'HTTP 503: {"error":"loading"}' });
    expect(t.logger.events('error')).toEqual(['model.chat_failed']);
  });
});

describe('AgentSupervisor model-call spans (docs/plans/otel-traces.md R2a, R5, A8)', () => {
  const CHAT = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 };
  const modelCalls = (spans: readonly TraceRecord[]) => spans.filter((r) => r.kind === 'model_call');

  it("ends asha.chat ok as a child of the agent's chat span, handle and channel from the token", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const parent = t.delivered();
    await t.supervisor.chat(t.token(), CHAT, parent, OPEN);
    expect(modelCalls(t.spans)).toEqual([
      {
        traceId: parent.traceId,
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/) as string,
        parentSpanId: parent.spanId,
        name: 'asha.chat',
        kind: 'model_call',
        channel: 'main',
        handle: 'greet-1',
        start: '2026-09-26T00:00:00.000Z',
        end: '2026-09-26T00:00:00.000Z',
        status: 'ok',
        reason: null,
      },
    ]);
    expect(t.supervisor.modelCallsInFlight()).toEqual([]);
  });

  it('ends asha.chat error with the failure reason: timeout', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    // A model server that never answers, and an agent whose request closes: its bound passed (model-streaming R2).
    const hanging = new FakeFetch((_url, init) => hangUntilAborted(init));
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = hanging.fetch;
    const closed = new AbortController();
    const pending = t.supervisor.chat(t.token(), CHAT, t.delivered(), closed.signal);
    closed.abort();
    const response = await pending;
    expect(response).toMatchObject({ ok: false, reason: 'timeout' });
    expect(modelCalls(t.spans).map((r) => [r.name, r.status, r.reason])).toEqual([['asha.chat', 'error', 'timeout']]);
  });

  it('holds a model call in flight until the gateway answers', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    let answer!: (r: Response) => void;
    const held = new FakeFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = held.fetch;
    const parent = t.delivered();
    const call = t.supervisor.chat(t.token(), CHAT, parent, OPEN);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.supervisor.modelCallsInFlight().map((s) => [s.name, s.traceId, s.handle, s.channel])).toEqual([
      ['asha.chat', parent.traceId, 'greet-1', 'main'],
    ]);
    // A read-only view: a reader cannot end the span (PRINCIPLES §10).
    expect(Object.keys(present(t.supervisor.modelCallsInFlight()[0], 'modelCallsInFlight()[0]'))).toEqual([
      'name',
      'traceId',
      'spanId',
      'channel',
      'handle',
      'start',
    ]);
    expect(modelCalls(t.spans)).toEqual([]);
    answer(sseResponse({ content: ['hello'] }));
    await call;
    expect(t.supervisor.modelCallsInFlight()).toEqual([]);
    expect(modelCalls(t.spans)).toHaveLength(1);
  });

  it('refuses a chat or embed whose trace is no conversation delivered to the agent, and never calls the model', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('rememberer', t.main, t.sink);
    const foreign = { traceId: traceIdFor('not-delivered'), spanId: 'c'.repeat(16) };
    await expect(t.supervisor.chat(t.token(), CHAT, foreign, OPEN)).rejects.toThrow(
      `traceparent names trace ${foreign.traceId}, which is no conversation delivered to greet-1`,
    );
    await expect(t.supervisor.embed(t.token(), { texts: ['a'], purpose: 'query' }, foreign)).rejects.toThrow(
      AgentRequestInvalid,
    );
    // The trace is checked first: a malformed body in a foreign trace is refused for its trace.
    await expect(t.supervisor.chat(t.token(), { messages: [] }, foreign, OPEN)).rejects.toThrow(
      `traceparent names trace ${foreign.traceId}`,
    );
    await expect(t.supervisor.embed(t.token(), { texts: [], purpose: 'guess' }, foreign)).rejects.toThrow(
      `traceparent names trace ${foreign.traceId}`,
    );
    expect(t.modelFetch.requests).toEqual([]);
    expect(modelCalls(t.spans)).toEqual([]);
  });

  it("logs a failed embedding call as model.embed_failed with its reason, and returns the failure as data (the code review's round 4, R4-COVERAGE-001)", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('rememberer', t.main, t.sink);
    const failing = new FakeFetch(() => json(500, { error: 'out of memory' }));
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = failing.fetch;
    const response = await t.supervisor.embed(t.token(), { texts: ['a'], purpose: 'query' }, t.delivered());
    expect(response).toEqual({ ok: false, reason: 'upstream_error', detail: 'HTTP 500: {"error":"out of memory"}' });
    const logged = t.logger.entries.filter((e) => e.event === 'model.embed_failed');
    expect(logged.map((e) => [e.level, e.fields['handle'], e.fields['texts'], e.fields['reason']])).toEqual([
      ['error', 'greet-1', 1, 'upstream_error'],
    ]);
    expect(String(logged[0]?.fields['error'])).toBe('Error: upstream_error: HTTP 500: {"error":"out of memory"}');
  });

  it("logs an embedding call whose agent's container exited during it as model.call_abandoned, never model.embed_failed (the code review's round 4, R4-COVERAGE-001)", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('rememberer', t.main, t.sink);
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = new FakeFetch((_url, init) =>
      hangUntilAborted(init),
    ).fetch;
    const pending = t.supervisor.embed(t.token(), { texts: ['a'], purpose: 'query' }, t.delivered());
    await new Promise((resolve) => setImmediate(resolve));
    t.runtime.exit(present(t.runtime.starts[0], 't.runtime.starts[0]').name, 137);
    expect(await pending).toEqual({ ok: false, reason: 'unavailable', detail: 'abandoned: the calling agent exited' });
    expect(t.logger.entries.filter((e) => e.event === 'model.embed_failed')).toEqual([]);
    expect(
      t.logger.entries
        .filter((e) => e.event === 'model.call_abandoned')
        .map((e) => [e.level, e.fields['call'], e.fields['detail']]),
    ).toEqual([['warn', 'embed', 'abandoned: the calling agent exited']]);
  });

  it('ends asha.embed ok for an embedding call in a delivered conversation', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('rememberer', t.main, t.sink);
    const vectors = new FakeFetch(() => json(200, { data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = vectors.fetch;
    const parent = t.delivered();
    expect(await t.supervisor.embed(t.token(), { texts: ['a'], purpose: 'document' }, parent)).toEqual({
      ok: true,
      vectors: [[1, 0, 0, 0]],
    });
    expect(modelCalls(t.spans).map((r) => [r.name, r.traceId, r.parentSpanId, r.status])).toEqual([
      ['asha.embed', parent.traceId, parent.spanId, 'ok'],
    ]);
  });

  it('says whose spans a token sends, and which traces it may send: those of the conversations delivered to it', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    expect(t.supervisor.traceScope(t.token())).toEqual({ handle: 'greet-1', channel: 'main', traces: new Set() });
    const parent = t.delivered();
    expect(t.supervisor.traceScope(t.token())).toEqual({
      handle: 'greet-1',
      channel: 'main',
      traces: new Set([parent.traceId]),
    });
    expect(() => t.supervisor.traceScope('not-a-token')).toThrow(AgentRequestInvalid);
  });
});

describe("a chat model server stores a recipe's prompt after its first answered call (D44, prompt-prefix amendment 2)", () => {
  const CHAT_URL = 'http://127.0.0.1:9999/v1/chat/completions';
  const TOKENIZE_URL = 'http://127.0.0.1:9999/tokenize';
  const STORE_URL = 'http://127.0.0.1:9999/completion';
  const ask = (t: Awaited<ReturnType<typeof setup>>, i = 0) =>
    t.supervisor.chat(t.token(i), { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }, t.delivered(), OPEN);
  const stored = (t: Awaited<ReturnType<typeof setup>>) =>
    t.logger.entries.filter((e) => e.event.startsWith('model.prompt_store'));

  it('sends one store request per server and recipe, after the first answered call, and logs it', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);

    await ask(t);
    await storeSettled();
    await ask(t);
    await storeSettled();

    expect(t.modelFetch.requests.map((r) => r.url)).toEqual([CHAT_URL, TOKENIZE_URL, STORE_URL, CHAT_URL]);
    expect(t.modelFetch.bodies().slice(1, 3)).toEqual([{ content: '.' }, { prompt: [13], n_predict: 1 }]);
    expect(present(t.modelFetch.requests[2], 'requests[2]').init?.headers).toEqual(
      present(t.modelFetch.requests[0], 'requests[0]').init?.headers,
    );
    expect(stored(t).map((e) => ({ level: e.level, event: e.event, ...e.fields, ms: typeof e.fields['ms'] }))).toEqual([
      { level: 'info', event: 'model.prompt_stored', model: 'tiny-model', recipe: 'greeter', ms: 'number' },
    ]);
    expect(t.logger.events('error')).toEqual([]);
  });

  it("stores again for another recipe's first answered call on the same server, and for no failed call", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    await t.supervisor.ensureOnline('rememberer', t.main, t.sink);
    const failing = new FakeFetch(() => json(503, { error: 'loading' }));
    const props = (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props;
    props.fetch = failing.fetch;

    expect(await ask(t, 1)).toEqual({ ok: false, reason: 'upstream_error', detail: 'HTTP 503: {"error":"loading"}' });
    expect(failing.requests.map((r) => r.url)).toEqual([CHAT_URL]);
    props.fetch = t.modelFetch.fetch;
    await ask(t, 0);
    await storeSettled();
    await ask(t, 1);
    await storeSettled();
    await ask(t, 1);
    await storeSettled();

    expect(t.modelFetch.requests.map((r) => r.url)).toEqual([
      CHAT_URL,
      TOKENIZE_URL,
      STORE_URL,
      CHAT_URL,
      TOKENIZE_URL,
      STORE_URL,
      CHAT_URL,
    ]);
    expect(stored(t).map((e) => [e.event, e.fields['recipe']])).toEqual([
      ['model.prompt_stored', 'greeter'],
      ['model.prompt_stored', 'rememberer'],
    ]);
  });

  it('logs a failed store at error, leaves the reply as it was, and does not retry it', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const chat = new FakeFetch((url) => {
      if (url.endsWith('/tokenize')) return json(200, { tokens: [13] });
      if (url.endsWith('/completion')) return new Response('slots busy', { status: 503 });
      return sseResponse({
        content: ['hello'],
        usage: { prompt_tokens: 12, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
      });
    });
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = chat.fetch;

    expect(await ask(t)).toEqual({ ok: true, text: 'hello', toolCalls: [] });
    await storeSettled();
    expect(await ask(t)).toEqual({ ok: true, text: 'hello', toolCalls: [] });
    await storeSettled();

    expect(chat.requests.map((r) => r.url)).toEqual([CHAT_URL, TOKENIZE_URL, STORE_URL, CHAT_URL]);
    const failures = stored(t);
    expect(
      failures.map((e) => [
        e.level,
        e.event,
        e.fields['model'],
        e.fields['recipe'],
        e.fields['reason'],
        typeof e.fields['ms'],
      ]),
    ).toEqual([['error', 'model.prompt_store_failed', 'tiny-model', 'greeter', 'upstream_error', 'number']]);
    expect((present(failures[0], 'failures[0]').fields['error'] as Error).message).toBe(
      'upstream_error: /completion: HTTP 503: slots busy',
    );
    expect(t.logger.events('error')).toEqual(['model.prompt_store_failed']);
  });

  it('abandons a store request still waiting when the stop begins, logs it as a warning, and stopAll resolves once it has ended', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    let aborted = 0;
    const held = new FakeFetch((url, init) => {
      if (url.endsWith('/tokenize')) return json(200, { tokens: [13] });
      if (!url.endsWith('/completion'))
        return sseResponse({
          content: ['hello'],
          usage: { prompt_tokens: 12, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
        });
      return new Promise<Response>((_resolve, reject) => {
        present(present(init, 'init').signal, 'init.signal').addEventListener('abort', () => {
          aborted += 1;
          // The connection ends a turn of the event loop after the abort, as a socket's does: stopAll must wait for it.
          setImmediate(() => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });
    });
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = held.fetch;
    await ask(t);
    while (held.requests.length < 3) await new Promise((resolve) => setImmediate(resolve));
    expect(aborted).toBe(0);

    await t.supervisor.stopAll('daemon stopping');

    expect(aborted).toBe(1);
    expect(held.requests.map((r) => r.url)).toEqual([CHAT_URL, TOKENIZE_URL, STORE_URL]);
    expect(stored(t).map((e) => [e.level, e.event, e.fields['recipe'], typeof e.fields['ms']])).toEqual([
      ['warn', 'model.prompt_store_abandoned', 'greeter', 'number'],
    ]);
    expect(t.logger.events('error')).toEqual([]);
  });
});

describe('a model unloaded idle is started again by the next call that needs it (idle-shutdown R1, R2)', () => {
  const CHAT_URL = 'http://127.0.0.1:9999/v1/chat/completions';
  const TOKENIZE_URL = 'http://127.0.0.1:9999/tokenize';
  const STORE_URL = 'http://127.0.0.1:9999/completion';
  const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 8 };
  type T = Awaited<ReturnType<typeof setup>>;
  const ask = (t: T) => t.supervisor.chat(t.token(), REQUEST, t.delivered(), OPEN);
  const stored = (t: T) => t.logger.entries.filter((e) => e.event.startsWith('model.prompt_store'));
  const setFetch = (t: T, fetch: typeof globalThis.fetch) => {
    (t.supervisor as unknown as { props: { fetch: typeof globalThis.fetch } }).props.fetch = fetch;
  };
  async function online() {
    const t = await setup();
    t.connectOnStart();
    const agent = await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    return { t, agent };
  }
  async function unload(t: T) {
    t.modelServer.unloadNext = ['tiny-model'];
    expect(await t.modelServer.unloadIdle(900_000)).toEqual(['tiny-model']);
  }

  it('a chat call after an unload starts the model again and is answered; the new server gets a prompt store of its own', async () => {
    const { t } = await online();
    expect(await ask(t)).toEqual({ ok: true, text: 'hello', toolCalls: [] });
    await storeSettled();
    await unload(t);

    expect(await ask(t)).toEqual({ ok: true, text: 'hello', toolCalls: [] });
    await storeSettled();

    // Started for the launch, then again by the call after the unload: server 1, then server 2.
    expect(t.modelServer.served).toEqual(['tiny-model', 'tiny-model']);
    expect(t.modelServer.holds).toEqual([
      ['tiny-model', 1],
      ['tiny-model', 2],
    ]);
    expect(t.modelServer.held).toBe(0);
    expect(t.modelFetch.requests.map((r) => r.url)).toEqual([
      CHAT_URL,
      TOKENIZE_URL,
      STORE_URL,
      CHAT_URL,
      TOKENIZE_URL,
      STORE_URL,
    ]);
    expect(stored(t).map((e) => e.event)).toEqual(['model.prompt_stored', 'model.prompt_stored']);
  });

  it("skips the prompt store, starting no server, when the server the call reached is no longer the model's", async () => {
    const { t } = await online();
    // By the time the store runs, the model has another server: the one the call reached is gone.
    setFetch(
      t,
      new FakeFetch(async (url, init) => {
        const response = await t.modelFetch.fetch(url, init);
        t.modelServer.servers.set('tiny-model', 7);
        return response;
      }).fetch,
    );

    expect(await ask(t)).toEqual({ ok: true, text: 'hello', toolCalls: [] });
    await storeSettled();

    expect(t.modelFetch.requests.map((r) => r.url)).toEqual([CHAT_URL]);
    expect(t.modelServer.holds).toEqual([['tiny-model', 1]]);
    expect(t.modelServer.served).toEqual(['tiny-model']);
    expect(t.modelServer.held).toBe(0);
    expect(stored(t).map((e) => [e.level, e.event, e.fields['recipe'], typeof e.fields['ms']])).toEqual([
      ['info', 'model.prompt_store_skipped', 'greeter', 'number'],
    ]);
  });

  it('answers a call whose model cannot be started again as unavailable, logged, holding nothing', async () => {
    const { t } = await online();
    await unload(t);
    t.modelServer.startFailure = new ModelServerFailed('tiny-model', 'not healthy within 120000 ms');

    expect(await ask(t)).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'serving tiny-model failed: not healthy within 120000 ms',
    });

    expect(t.modelServer.held).toBe(0);
    expect(t.modelFetch.requests).toEqual([]);
    expect(t.logger.events('error')).toEqual(['model.chat_failed']);
    expect(entryFields(t.logger, 'model.chat_failed')).toMatchObject({
      reason: 'unavailable',
      ttfcMs: null,
      chunks: 0,
      promptTokens: null,
    });
  });

  it("releases a call's lease whatever ends it: a failed answer, a closed request, the agent's exit", async () => {
    const { t, agent } = await online();
    setFetch(t, new FakeFetch(() => json(503, { error: 'loading' })).fetch);
    expect(await ask(t)).toMatchObject({ ok: false, reason: 'upstream_error' });
    expect(t.modelServer.held).toBe(0);

    setFetch(t, new FakeFetch((_url, init) => hangUntilAborted(init)).fetch);
    const closed = new AbortController();
    const closing = t.supervisor.chat(t.token(), REQUEST, t.delivered(), closed.signal);
    await vi.waitFor(() => {
      expect(t.modelServer.held).toBe(1);
    });
    closed.abort();
    expect(await closing).toMatchObject({ ok: false, reason: 'timeout' });
    expect(t.modelServer.held).toBe(0);

    const exiting = t.supervisor.chat(t.token(), REQUEST, t.delivered(), OPEN);
    await vi.waitFor(() => {
      expect(t.modelServer.held).toBe(1);
    });
    t.runtime.exit(agent.container, 1);
    expect(await exiting).toMatchObject({ ok: false });
    expect(t.modelServer.held).toBe(0);
  });

  /** A start the test lets finish (or fail) when it chooses: the model's server is starting until then. */
  function gate(t: T) {
    let open!: () => void;
    t.modelServer.startGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return open;
  }

  describe('the wait for a model that must start is part of the call, and bounded with it', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives up at the queue bound, naming it; the lease that comes later is released at once', async () => {
      const { t } = await online();
      await unload(t);
      const open = gate(t);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let settled = false;
      const pending = ask(t).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(CHAT_QUEUE_BOUND_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({
        ok: false,
        reason: 'timeout',
        detail: "its model's server did not start within the queue bound of 55000 ms",
      });
      expect(t.modelFetch.requests).toEqual([]);
      expect(entryFields(t.logger, 'model.chat_failed')).toMatchObject({ reason: 'timeout', chunks: 0 });
      // The start finishes after: its lease is taken and released, never held by nobody.
      open();
      await vi.waitFor(() => {
        expect(t.modelServer.served).toEqual(['tiny-model', 'tiny-model']);
      });
      expect(t.modelServer.held).toBe(0);
    });

    it("stops waiting when the agent's request closes, or the agent exits, each as a call that reached its model would", async () => {
      const { t, agent } = await online();
      await unload(t);
      const open = gate(t);
      const closed = new AbortController();
      const closing = t.supervisor.chat(t.token(), REQUEST, t.delivered(), closed.signal);
      await vi.waitFor(() => {
        expect(t.modelServer.leased).toEqual(['tiny-model']);
      });
      closed.abort();
      expect(await closing).toEqual({ ok: false, reason: 'timeout', detail: REQUEST_CLOSED });

      const exiting = ask(t);
      await vi.waitFor(() => {
        expect(t.modelServer.leased).toEqual(['tiny-model', 'tiny-model']);
      });
      t.runtime.exit(agent.container, 1);
      expect(await exiting).toEqual({ ok: false, reason: 'unavailable', detail: ABANDONED });

      expect(t.modelFetch.requests).toEqual([]);
      open();
      await vi.waitFor(() => {
        expect(t.modelServer.served).toEqual(['tiny-model', 'tiny-model']);
      });
      expect(t.modelServer.held).toBe(0);
    });

    it('logs a start that fails after its call gave up on it, model.start_failed', async () => {
      const { t } = await online();
      await unload(t);
      const open = gate(t);
      const closed = new AbortController();
      const closing = t.supervisor.chat(t.token(), REQUEST, t.delivered(), closed.signal);
      await vi.waitFor(() => {
        expect(t.modelServer.leased).toEqual(['tiny-model']);
      });
      closed.abort();
      expect(await closing).toEqual({ ok: false, reason: 'timeout', detail: REQUEST_CLOSED });
      const failure = new ModelServerFailed('tiny-model', 'not healthy within 120000 ms');
      t.modelServer.startFailure = failure;
      open();
      await vi.waitFor(() => {
        expect(t.logger.events('error')).toContain('model.start_failed');
      });
      expect(entryFields(t.logger, 'model.start_failed')).toEqual({ model: 'tiny-model', error: failure });
      expect(t.modelServer.held).toBe(0);
    });
  });
});

describe('parseChatRequest', () => {
  it('accepts assistant tool calls and tool results', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'l1', name: 'list_agents', arguments: {} }] },
      { role: 'tool', toolCallId: 'l1', content: '[]' },
    ];
    expect(parseChatRequest({ messages, maxTokens: 1 })).toEqual({ messages, maxTokens: 1 });
  });

  it('accepts well-formed tools', () => {
    const tools = [
      { type: 'function', function: { name: 'send_message', description: 'd', parameters: { type: 'object' } } },
    ];
    expect(parseChatRequest({ messages: [{ role: 'user', content: 'x' }], maxTokens: 1, tools })).toEqual({
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 1,
      tools,
    });
  });

  it('accepts a well-formed request', () => {
    expect(parseChatRequest({ messages: [{ role: 'system', content: 's' }], maxTokens: 4096 })).toEqual({
      messages: [{ role: 'system', content: 's' }],
      maxTokens: 4096,
    });
  });

  it('accepts a trailing assistant turn when no call is required', () => {
    const messages = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'partial' },
    ];
    expect(parseChatRequest({ messages, maxTokens: 1 })).toEqual({ messages, maxTokens: 1 });
  });

  it.each([
    ['a non-object', null, 'chat body must be an object'],
    [
      'an unknown field',
      { messages: [{ role: 'user', content: 'x' }], maxTokens: 1, temperature: 2 },
      'unknown chat field(s): temperature',
    ],
    ['no messages', { messages: [], maxTokens: 1 }, 'messages must be a non-empty array'],
    [
      'a bad role',
      { messages: [{ role: 'robot', content: 'x' }], maxTokens: 1 },
      'messages[0] must have role system, user, assistant or tool',
    ],
    [
      'non-string content',
      { messages: [{ role: 'user', content: 1 }], maxTokens: 1 },
      'messages[0] must have string content',
    ],
    [
      'a tool result with no call id',
      { messages: [{ role: 'tool', content: 'x' }], maxTokens: 1 },
      'messages[0] a tool message needs its toolCallId',
    ],
    [
      'requireToolCall without tools',
      { messages: [{ role: 'user', content: 'x' }], maxTokens: 1, requireToolCall: true },
      'requireToolCall needs tools',
    ],
    [
      'requireToolCall after a trailing assistant turn',
      {
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'partial' },
        ],
        maxTokens: 1,
        requireToolCall: true,
        tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }],
      },
      'requireToolCall needs messages that do not end with an assistant turn',
    ],
    [
      'a non-boolean requireToolCall',
      { messages: [{ role: 'user', content: 'x' }], maxTokens: 1, requireToolCall: 'yes' },
      'requireToolCall must be true or false',
    ],
    [
      'a malformed assistant tool call',
      { messages: [{ role: 'assistant', content: '', toolCalls: [{ name: 'f' }] }], maxTokens: 1 },
      'toolCalls entries must be',
    ],
    [
      'maxTokens over the cap',
      { messages: [{ role: 'user', content: 'x' }], maxTokens: 4097 },
      'maxTokens must be an integer in 1..4096',
    ],
    ['a missing maxTokens', { messages: [{ role: 'user', content: 'x' }] }, 'maxTokens must be an integer'],
    [
      'tools that are not an array',
      { messages: [{ role: 'user', content: 'x' }], maxTokens: 1, tools: {} },
      'tools must be an array of 1..16',
    ],
    [
      'an empty tools array',
      { messages: [{ role: 'user', content: 'x' }], maxTokens: 1, tools: [] },
      'tools must be an array of 1..16',
    ],
    [
      'a tool without parameters',
      {
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 1,
        tools: [{ type: 'function', function: { name: 'f', description: 'd' } }],
      },
      'tools[0] must be',
    ],
    [
      'a tool with a bad name',
      {
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 1,
        tools: [{ type: 'function', function: { name: 'a b', description: 'd', parameters: {} } }],
      },
      'tools[0] must be',
    ],
  ])('rejects %s', (_, body, message) => {
    expect(() => parseChatRequest(body)).toThrow(AgentRequestInvalid);
    expect(() => parseChatRequest(body)).toThrow(message);
  });
});

describe('classify', () => {
  it.each([
    [new UnknownRecipe('r'), 'unknown_recipe'],
    [new UnknownImage('i'), 'unknown_image'],
    [new PrerequisiteMissing('Homebrew', 'install it'), 'prerequisite'],
    [new ToolInstallFailed('colima', 'out'), 'prerequisite'],
    [new ContainerRuntimeError('x'), 'container_runtime'],
    [new ContainerIsolationFailed('rule install', 'x'), 'container_runtime'],
    [new ModelFetchFailed('u', 'network', 'x'), 'model_fetch'],
    [new ModelDigestMismatch('p', 'a', 'b'), 'model_fetch'],
    [new LockHeld('/l', 1), 'model_fetch'],
    [new ModelServerFailed('m', 'x'), 'model_server'],
    [new ImageBuildFailed('t', 'x'), 'image_build'],
    [new ImageSourceMissing('/p'), 'image_build'],
    [new AgentStartFailed('a', 'x'), 'agent_start'],
    [new UnknownHandle('main', 'ghost-1'), 'unknown_handle'],
    [new ChannelNameInvalid('Bad'), 'bad_request'],
    [new DefinitionError('f', 'x'), 'internal'],
    [new UnknownTeam('t'), 'unknown_team'],
    [new TeamDefinitionError('f', 'm', 'x'), 'internal'],
    // A team's failure is its member's: the reason is the cause's.
    [new TeamLaunchFailed('t', 'm', new AgentStartFailed('a', 'x')), 'agent_start'],
    [new TeamLaunchFailed('t', 'm', new UnknownImage('i')), 'unknown_image'],
    [new TypeError('boom'), 'internal'],
  ])('maps %s to %s', (error, reason) => {
    expect(classify(error)).toBe(reason);
  });
});

const FILE_TOOLS = ['list_files', 'read_file', 'write_file', 'append_file'];

describe("a recipe's documents at launch (collaborating-agents R2, R3; A1)", () => {
  it("places every document in the container's /workspace at its path, and hands the full-text ones to the agent in its welcome", async () => {
    const t = await setup({
      ...FIXTURE_RECIPE,
      tools: FILE_TOOLS,
      documents: [
        { path: 'greeting.md', fullText: true },
        { path: 'more/notes.md', fullText: false },
      ],
    } as typeof FIXTURE_RECIPE);
    await mkdir(join(t.root, 'recipes', 'more'), { recursive: true });
    await writeFile(join(t.root, 'recipes', 'greeting.md'), '1. Greet.\n');
    await writeFile(join(t.root, 'recipes', 'more', 'notes.md'), 'notes\n');
    t.connectOnStart();
    const agent = await t.supervisor.launchNew('greeter', t.main, t.quiet);
    expect(t.runtime.starts).toHaveLength(1);
    expect(present(t.runtime.starts[0], 't.runtime.starts[0]').files).toEqual([
      { path: 'greeting.md', content: Buffer.from('1. Greet.\n') },
      { path: 'more/notes.md', content: Buffer.from('notes\n') },
    ]);
    expect(agent.guidance).toEqual([{ path: 'greeting.md', text: '1. Greet.\n' }]);
    expect(entryFields(t.logger, 'agent.starting')['documents']).toEqual(['greeting.md', 'more/notes.md']);
  });

  it('a recipe with no documents starts its container with no files', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    expect(present(t.runtime.starts[0], 't.runtime.starts[0]').files).toEqual([]);
  });

  it('a missing document fails the launch naming it, before the runtime is touched or any container runs', async () => {
    const t = await setup({
      ...FIXTURE_RECIPE,
      tools: FILE_TOOLS,
      documents: [{ path: 'gone.md', fullText: true }],
    } as typeof FIXTURE_RECIPE);
    const error = await t.supervisor.launchNew('greeter', t.main, t.quiet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentMissing);
    expect((error as Error).message).toBe(
      `${join(t.root, 'recipes', 'greeter.json')}: document "gone.md" does not exist in the recipe's folder`,
    );
    expect(t.runtime.calls).toEqual([]);
  });

  it('documents without the four file tools fail the launch naming the recipe, before any container runs', async () => {
    const t = await setup({
      ...FIXTURE_RECIPE,
      tools: ['read_file'],
      documents: [{ path: 'greeting.md', fullText: true }],
    } as typeof FIXTURE_RECIPE);
    const error = await t.supervisor.launchNew('greeter', t.main, t.quiet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentsNeedFileTools);
    expect((error as Error).message).toContain(
      'recipe greeter names documents, so it must select the four file tools; it does not select list_files, write_file, append_file',
    );
    expect(t.runtime.calls).toEqual([]);
  });
});

describe('launching a team (collaborating-agents R5, R11; A9)', () => {
  const member = (id: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...FIXTURE_RECIPE, id, description: `The ${id}.`, prompt: `you are the ${id}.`, ...over });
  async function teamSetup(members: readonly { name: string; recipe: string }[], files: Record<string, string>) {
    const t = await setup();
    const dir = join(t.root, 'teams', 'crew');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'team.json'), JSON.stringify({ id: 'crew', description: 'A crew.', members }));
    for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
    const events: string[] = [];
    const sink = {
      member: (name: string, recipe: string) => events.push(`member ${name} ${recipe}`),
      phase: () => undefined,
      announced: (m: ChannelMessage) => events.push(`announced ${m.from}`),
      launched: (a: { handle: string }) => events.push(`launched ${a.handle}`),
      teamLaunched: () => events.push('team launched'),
      resent: () => undefined,
    };
    return { ...t, dir, events, sink };
  }

  it("launches every member on one channel in team.json's order, each joining under its own name whatever its image asks for", async () => {
    const t = await teamSetup(
      [
        { name: 'supervisor', recipe: 'boss.json' },
        { name: 'fact-red', recipe: 'fact.json' },
        { name: 'fact-blue', recipe: 'fact.json' },
      ],
      { 'boss.json': member('boss'), 'fact.json': member('fact') },
    );
    // Every "container" asks to join as greet: the team file's names win (R11).
    t.connectOnStart('greet');
    const agents = await t.supervisor.launchTeam('crew', t.main, t.sink);
    expect(agents.map((a) => [a.handle, a.recipe.id, a.channel])).toEqual([
      ['supervisor-1', 'boss', 'main'],
      ['fact-red-1', 'fact', 'main'],
      ['fact-blue-1', 'fact', 'main'],
    ]);
    expect(t.events).toEqual([
      'member supervisor boss',
      'announced supervisor-1',
      'launched supervisor-1',
      'member fact-red fact',
      'announced fact-red-1',
      'launched fact-red-1',
      'member fact-blue fact',
      'announced fact-blue-1',
      'launched fact-blue-1',
      'team launched',
    ]);
    expect(t.supervisor.list().map((a) => a.handle)).toEqual(['fact-blue-1', 'fact-red-1', 'supervisor-1']);
    expect(
      t.logger.entries.filter((e) => e.event === 'agent.connected').map((e) => [e.fields['handle'], e.fields['asked']]),
    ).toEqual([
      ['supervisor-1', 'greet'],
      ['fact-red-1', 'greet'],
      ['fact-blue-1', 'greet'],
    ]);
    expect(entryFields(t.logger, 'team.launched')).toEqual({
      team: 'crew',
      channel: 'main',
      handles: ['supervisor-1', 'fact-red-1', 'fact-blue-1'],
    });
    // Each member's container got its own recipe's prompt through its welcome: its recipe.
    expect(agents.map((a) => a.recipe.prompt)).toEqual(['you are the boss.', 'you are the fact.', 'you are the fact.']);
  });

  it('a team.json that breaks a rule fails naming the file, the member and the rule, and no container runs', async () => {
    const t = await teamSetup([{ name: 'user', recipe: 'boss.json' }], { 'boss.json': member('boss') });
    const error = await t.supervisor.launchTeam('crew', t.main, t.sink).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as Error).message).toBe(
      `${join(t.dir, 'team.json')}: member "user": name must not be "user" or "asha"`,
    );
    expect(t.runtime.calls).toEqual([]);
  });

  it("a later member's missing document fails the whole team before any container runs, naming the member", async () => {
    const t = await teamSetup(
      [
        { name: 'supervisor', recipe: 'boss.json' },
        { name: 'helper', recipe: 'helper.json' },
      ],
      {
        'boss.json': member('boss'),
        'helper.json': member('helper', { tools: FILE_TOOLS, documents: [{ path: 'gone.md', fullText: true }] }),
      },
    );
    const error = await t.supervisor.launchTeam('crew', t.main, t.sink).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamLaunchFailed);
    expect((error as TeamLaunchFailed).cause).toBeInstanceOf(DocumentMissing);
    expect((error as Error).message).toBe(
      `team crew: member "helper" did not start: ${join(t.dir, 'helper.json')}: document "gone.md" does not exist in the recipe's folder`,
    );
    expect(t.runtime.calls).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('a member that does not come online stops the members already started, and the failure names it', async () => {
    const t = await teamSetup(
      [
        { name: 'first', recipe: 'boss.json' },
        { name: 'second', recipe: 'boss.json' },
      ],
      { 'boss.json': member('boss') },
    );
    let n = 0;
    t.runtime.onStart = (spec) => {
      queueMicrotask(() => {
        n += 1;
        if (n === 2) {
          t.runtime.exit(spec.name, 1);
          return;
        }
        const token = present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var');
        t.supervisor.connect(token, 'greet', () => undefined);
        t.supervisor.post(token, { kind: 'status', text: 'Hi' });
      });
    };
    const error = await t.supervisor.launchTeam('crew', t.main, t.sink).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamLaunchFailed);
    expect((error as Error).message).toMatch(
      /^team crew: member "second" did not start: agent asha-main-boss-[0-9a-f]{6} did not come online: container exited with code 1 before coming online/,
    );
    expect(classify(error)).toBe('agent_start');
    // The second, which never came online, was killed; then the first, already online, was stopped with its grace:
    // the team is on the channel whole or not at all.
    expect(t.runtime.stops).toEqual([
      present(t.runtime.starts[1], 't.runtime.starts[1]').name,
      present(t.runtime.starts[0], 't.runtime.starts[0]').name,
    ]);
    expect(t.runtime.stopModes).toEqual(['kill', 'drain']);
    expect(t.supervisor.list()).toEqual([]);
    expect(entryFields(t.logger, 'team.launch_failed')).toMatchObject({
      team: 'crew',
      channel: 'main',
      member: 'second',
      stopping: ['first-1'],
    });
  });

  it('a rollback that cannot stop a member names it in the failure, still online (review finding 16)', async () => {
    const t = await teamSetup(
      [
        { name: 'first', recipe: 'boss.json' },
        { name: 'second', recipe: 'boss.json' },
      ],
      { 'boss.json': member('boss') },
    );
    let n = 0;
    t.runtime.onStart = (spec) => {
      queueMicrotask(() => {
        n += 1;
        if (n === 2) {
          t.runtime.exit(spec.name, 1);
          return;
        }
        const token = present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var');
        t.supervisor.connect(token, 'greet', () => undefined);
        t.supervisor.post(token, { kind: 'status', text: 'Hi' });
      });
    };
    const first = () => present(t.runtime.starts[0], 't.runtime.starts[0]').name;
    t.runtime.onStop = (name, mode) => {
      if (name === first()) return Promise.reject(new Error('docker stop failed: permission denied'));
      t.runtime.exit(name, mode === 'drain' ? 143 : 137);
      return Promise.resolve();
    };
    const error = await t.supervisor.launchTeam('crew', t.main, t.sink).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamLaunchFailed);
    expect((error as TeamLaunchFailed).stillOnline).toEqual(['first-1']);
    expect((error as Error).message).toMatch(/; and the rollback could not stop first-1, still online$/);
    expect(t.logger.entries.filter((e) => e.event === 'agent.stop_failed').map((e) => e.fields['container'])).toEqual([
      first(),
    ]);
  });

  it('an unknown team: UnknownTeam, and nothing runs', async () => {
    const t = await setup();
    const sink = {
      member: () => undefined,
      phase: () => undefined,
      announced: () => undefined,
      launched: () => undefined,
      teamLaunched: () => undefined,
      resent: () => undefined,
    };
    await expect(t.supervisor.launchTeam('nobody', t.main, sink)).rejects.toThrow(new UnknownTeam('nobody'));
    expect(t.runtime.calls).toEqual([]);
  });
});

describe('AgentSupervisor.launchFor: an agent launches a recipe its grant names (patterns-phase-3 R29, R30, R32)', () => {
  const GRANT = { recipes: ['helper'], maxPerConversation: 1 };
  const member = (id: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...FIXTURE_RECIPE, id, description: `The ${id}.`, prompt: `you are the ${id}.`, ...over });

  /** The crew team: `boss`, granting `launch`, and `helper`, the recipe it may launch. */
  async function crewSetup(
    launch: { recipes: string[]; maxPerConversation: number } = GRANT,
    bossOver: Record<string, unknown> = {},
  ) {
    const t = await setup();
    const dir = join(t.root, 'teams', 'crew');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'team.json'),
      JSON.stringify({ id: 'crew', description: 'A crew.', members: [{ name: 'boss', recipe: 'boss.json' }] }),
    );
    await writeFile(join(dir, 'boss.json'), member('boss', { launch, ...bossOver }));
    await writeFile(join(dir, 'helper.json'), member('helper'));
    const sink = {
      member: () => undefined,
      phase: () => undefined,
      announced: () => undefined,
      launched: () => undefined,
      teamLaunched: () => undefined,
      resent: () => undefined,
    };
    t.connectOnStart('greet');
    await t.supervisor.launchTeam('crew', t.main, sink);
    const bossToken = t.token(0);
    /** A fresh delivery to the boss, held (never acked): its conversation and the delivery's id. */
    const hold = (): { readonly conversation: string; readonly delivery: string } => {
      const input = t.main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });
      return { conversation: input.conversation, delivery: present(t.inbox.at(-1), 't.inbox.at(-1)').deliveryId };
    };
    return { ...t, bossToken, hold };
  }

  it('stopping: refused once the daemon has begun to close, before its delivery is even checked', async () => {
    const t = await crewSetup();
    const { delivery } = t.hold();
    const stopping = t.supervisor.stopAll('daemon stopping');
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    expect(outcome).toEqual({ ok: false, reason: 'stopping', detail: 'the daemon is stopping' });
    await stopping;
  });

  it('not_holding_delivery: a delivery id it does not hold', async () => {
    const t = await crewSetup();
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery: 'no-such-delivery', recipe: 'helper' }, OPEN);
    expect(outcome).toEqual({
      ok: false,
      reason: 'not_holding_delivery',
      detail: 'boss-1 holds no delivery no-such-delivery',
    });
  });

  it("not_granted: the launcher's recipe grants no launch at all", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    t.main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });
    const delivery = present(t.inbox.at(-1), 't.inbox.at(-1)').deliveryId;
    const outcome = await t.supervisor.launchFor(t.token(), { delivery, recipe: 'helper' }, OPEN);
    expect(outcome).toEqual({ ok: false, reason: 'not_granted', detail: 'recipe greeter grants no launch' });
  });

  it('not_granted: a recipe its grant does not name, though its recipe holds a launch grant', async () => {
    const t = await crewSetup();
    const { delivery } = t.hold();
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'other' }, OPEN);
    expect(outcome).toEqual({
      ok: false,
      reason: 'not_granted',
      detail: "recipe boss's launch grant names helper, not other",
    });
  });

  it("launch_cap: a second launch for the same conversation once the grant's maxPerConversation is reached", async () => {
    const t = await crewSetup({ recipes: ['helper'], maxPerConversation: 1 });
    const { conversation, delivery } = t.hold();
    const first = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    expect(first).toEqual({ ok: true, handle: 'helper-1' });
    const second = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    expect(second).toEqual({
      ok: false,
      reason: 'launch_cap',
      detail: `boss-1 has launched 1 of its 1 agents for conversation ${conversation}`,
    });
  });

  it('launch_failed: a start failure is classified and logged with its cause', async () => {
    const t = await crewSetup();
    const { delivery } = t.hold();
    const tag = `asha-image-helper:${'a'.repeat(64)}`;
    t.runtime.failStartWith = new ImageGone(tag);
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    const container = present(t.runtime.starts.at(-1), 't.runtime.starts.at(-1)').name;
    expect(outcome).toEqual({
      ok: false,
      reason: 'launch_failed',
      detail: `agent ${container} did not come online: container failed: image ${tag} was removed while this launch was starting (an image prune of another asha server); launch again to rebuild it`,
    });
    expect(entryFields(t.logger, 'agent.launch_failed')).toMatchObject({
      by: 'boss-1',
      recipe: 'helper',
      reason: 'AgentStartFailed',
    });
  });

  it('abandoned: the caller stopped waiting before the launched agent ever came online', async () => {
    const t = await crewSetup();
    const { delivery } = t.hold();
    // The helper's container never connects: it never comes online.
    t.runtime.onStart = () => undefined;
    const controller = new AbortController();
    const pending = t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, controller.signal);
    controller.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toBe('abandoned');
    expect(outcome.detail).toMatch(
      /^agent asha-main-helper-[0-9a-f]{6}'s launch was abandoned: the agent that asked for it stopped waiting$/,
    );
    expect(t.runtime.stopModes.at(-1)).toBe('kill');
    expect(entryFields(t.logger, 'agent.launch_abandoned')).toMatchObject({ by: 'boss-1', recipe: 'helper' });
  });

  it('abandoned: the caller stopped waiting exactly as the launched agent came online (R30)', async () => {
    const t = await crewSetup();
    const { delivery } = t.hold();
    t.connectOnStart('help');
    const controller = new AbortController();
    // awaitOnline's race, already won by the agent coming online, logs agent.online synchronously with no await
    // after it; aborting from inside that very log call lands the abort after that race, before launchFor's own
    // abandon.aborted check just below it — the narrow window lines 924-934 cover.
    const originalInfo = t.logger.info.bind(t.logger);
    t.logger.info = (event, fields) => {
      originalInfo(event, fields);
      if (event === 'agent.online') controller.abort();
    };
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, controller.signal);
    const container = present(
      t.logger.entries.filter((e) => e.event === 'agent.online').at(-1),
      "the helper's agent.online log entry",
    ).fields['container'];
    expect(outcome).toEqual({
      ok: false,
      reason: 'abandoned',
      detail: `agent ${String(container)}'s launch was abandoned`,
    });
    expect(t.runtime.stopModes.at(-1)).toBe('kill');
  });

  /** The channel's statuses, joins and leaves as its watchers see them: `<from>: <text>`, `+<agent>`, `-<agent>`. */
  const watchLines = (channel: { watchAll: (w: (e: WatchEvent) => void) => () => void }): string[] => {
    const lines: string[] = [];
    channel.watchAll((e) => {
      if (e.type === 'message' && e.message.kind === 'status') lines.push(`${e.message.from}: ${e.message.text}`);
      if (e.type === 'agent_joined') lines.push(`+${e.agent}`);
      if (e.type === 'agent_left') lines.push(`-${e.agent}`);
    });
    return lines;
  };

  it("a granted launch: the launcher's status, before the new agent joins and greets (demo-scene-refresh R14, A10)", async () => {
    const t = await crewSetup();
    const lines = watchLines(t.main);
    const { delivery } = t.hold();
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    expect(outcome).toEqual({ ok: true, handle: 'helper-1' });
    expect(lines).toEqual(['boss-1: launching a new helper agent', '+helper-1', 'helper-1: Hi']);
  });

  it('a launch refused — not granted, or past its cap — says nothing (R14, A10)', async () => {
    const t = await crewSetup({ recipes: ['helper'], maxPerConversation: 1 });
    const { delivery } = t.hold();
    expect((await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN)).ok).toBe(true);
    const lines = watchLines(t.main);
    expect((await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'other' }, OPEN)).ok).toBe(false);
    expect((await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN)).ok).toBe(false);
    expect(lines).toEqual([]);
  });

  it("a launch that fails to start: the launcher's second status names its reason (R14, A10)", async () => {
    const t = await crewSetup();
    const lines = watchLines(t.main);
    const { delivery } = t.hold();
    t.runtime.failStartWith = new ImageGone(`asha-image-helper:${'a'.repeat(64)}`);
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    expect(outcome.ok).toBe(false);
    expect(lines).toEqual([
      'boss-1: launching a new helper agent',
      'boss-1: could not launch a helper agent: launch_failed',
    ]);
  });

  it("a launch that fails while its launcher is down for its restart says nothing more: its failure's mark stays (R14; R1-DESIGN-002)", async () => {
    const t = await crewSetup(GRANT, { restart: { max: 2, withinMs: 60_000 } });
    const lines = watchLines(t.main);
    const { delivery } = t.hold();
    // The helper's container never connects.
    t.runtime.onStart = () => undefined;
    const controller = new AbortController();
    const pending = t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, controller.signal);
    t.supervisor.disconnect(t.bossToken);
    expect(t.main.isSuspended('boss-1')).toBe(true);
    controller.abort();
    expect((await pending).ok).toBe(false);
    expect(lines).toEqual(['boss-1: launching a new helper agent', `boss-1: ${AGENT_FAILURE_STATUS}`]);
    await t.supervisor.stopAll('test done');
  });

  it("a launcher down for its restart, or on a channel stopping, launches nothing and says nothing (the code review's round 2)", async () => {
    const t = await crewSetup(GRANT, { restart: { max: 2, withinMs: 60_000 } });
    const lines = watchLines(t.main);
    const { delivery } = t.hold();
    t.supervisor.disconnect(t.bossToken);
    expect(await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN)).toEqual({
      ok: false,
      reason: 'stopping',
      detail: 'boss-1 is down for its restart',
    });
    expect(lines).toEqual([`boss-1: ${AGENT_FAILURE_STATUS}`]);
    expect(t.runtime.starts).toHaveLength(1);
    await t.supervisor.stopAll('test done');

    const u = await crewSetup();
    const quiet = watchLines(u.main);
    const held = u.hold();
    const stopping = u.supervisor.stopChannel('main', 'cli', () => undefined);
    expect(await u.supervisor.launchFor(u.bossToken, { delivery: held.delivery, recipe: 'helper' }, OPEN)).toEqual({
      ok: false,
      reason: 'stopping',
      detail: 'channel main is stopping',
    });
    expect(quiet.filter((l) => l.startsWith('boss-1: launching'))).toEqual([]);
    await stopping;
  });

  it("a launch its channel's stop interrupts is `stopping`, logged as no failure and said by no line, as the daemon's stop (R14; the code review's round 3)", async () => {
    const t = await crewSetup();
    const lines = watchLines(t.main);
    const { delivery } = t.hold();
    // The helper's container starts and never connects; the channel's stop begins while its launch waits.
    t.runtime.onStart = () => undefined;
    const pending = t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    await until(() => {
      expect(t.runtime.starts).toHaveLength(2);
    });
    const stopping = t.supervisor.stopChannel('main', 'cli', () => undefined);
    expect(await pending).toEqual({ ok: false, reason: 'stopping', detail: 'channel main is stopping' });
    expect(t.logger.entries.filter((e) => e.event === 'agent.launch_failed')).toEqual([]);
    expect(lines.filter((l) => l.startsWith('boss-1: '))).toEqual(['boss-1: launching a new helper agent']);
    await stopping;
  });

  it('an agent may not post a status only the harness posts (R6, R14, R16; R1-SECURITY-001)', async () => {
    const t = await crewSetup();
    for (const text of [
      AGENT_FAILURE_STATUS,
      'launching a new helper agent',
      'could not launch a helper agent: abandoned',
      'restarting (1 of 2 within 60 s)',
      'restart 1 failed: its container exited before coming online',
      'restart limit reached (2 within 60 s): removed',
      'restart 1 failed: it could not be started',
      'restart limit reached (the message it held sent again 2 times): removed',
      'sent again the message it held',
    ])
      expect(() => t.supervisor.post(t.bossToken, { kind: 'status', text }), text).toThrow(AgentRequestInvalid);
    expect(t.supervisor.post(t.bossToken, { kind: 'status', text: 'Hi again' }).text).toBe('Hi again');
  });

  it('a launch that fails after its launcher left says nothing more: the launcher is not there to say it (R14, A10)', async () => {
    const t = await crewSetup();
    const lines = watchLines(t.main);
    const { delivery } = t.hold();
    // The helper's container never connects.
    t.runtime.onStart = () => undefined;
    const controller = new AbortController();
    const pending = t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, controller.signal);
    await t.supervisor.stopHandle('main', 'boss-1', 'test done');
    controller.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(lines).toEqual(['boss-1: launching a new helper agent', '-boss-1']);
  });

  it("a launch abandoned as its agent came online: the launcher's second status, after the agent's leave (R14, A10)", async () => {
    const t = await crewSetup();
    const lines = watchLines(t.main);
    const { delivery } = t.hold();
    t.connectOnStart('help');
    const controller = new AbortController();
    const originalInfo = t.logger.info.bind(t.logger);
    t.logger.info = (event, fields) => {
      originalInfo(event, fields);
      if (event === 'agent.online') controller.abort();
    };
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, controller.signal);
    expect(outcome.ok).toBe(false);
    expect(lines).toEqual([
      'boss-1: launching a new helper agent',
      '+helper-1',
      'helper-1: Hi',
      '-helper-1',
      'boss-1: could not launch a helper agent: abandoned',
    ]);
  });

  it("ok: the launched agent joins under the launchable recipe's id, and is stopped once its launcher leaves the channel (R32)", async () => {
    const t = await crewSetup();
    const { conversation, delivery } = t.hold();
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    expect(outcome).toEqual({ ok: true, handle: 'helper-1' });
    expect(entryFields(t.logger, 'agent.launched')).toEqual({
      by: 'boss-1',
      handle: 'helper-1',
      recipe: 'helper',
      conversation,
      team: 'crew',
    });
    await t.supervisor.stopHandle('main', 'boss-1', 'test done');
    await until(() => {
      expect(t.logger.entries.some((e) => e.event === 'agent.exited' && e.fields['handle'] === 'helper-1')).toBe(true);
    });
  });

  it('ok: the launched agent is stopped once the conversation it was launched for settles, even with its launcher still on the channel (R32)', async () => {
    const t = await crewSetup();
    const { conversation, delivery } = t.hold();
    const outcome = await t.supervisor.launchFor(t.bossToken, { delivery, recipe: 'helper' }, OPEN);
    expect(outcome).toEqual({ ok: true, handle: 'helper-1' });
    t.supervisor.post(t.bossToken, { conversation, kind: 'output', text: 'done' }, 'c'.repeat(16));
    t.supervisor.ack(t.bossToken, delivery);
    expect(t.main.isSettled(conversation)).toBe(true);
    await until(() => {
      expect(t.logger.entries.some((e) => e.event === 'agent.exited' && e.fields['handle'] === 'helper-1')).toBe(true);
    });
    // Boss itself is untouched: only the agent its grant launched was stopped.
    expect(t.supervisor.list().map((a) => a.handle)).toEqual(['boss-1']);
  });
});

describe('the module call pipeline: moduleCall, approvals, metering and enableModule (extension-modules R8, R12, R18b, R36)', () => {
  /** An online agent granted no module, holding a delivery for moduleCall's trace. */
  async function plainSetup() {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    return { ...t, parent: t.delivered() };
  }

  /** A greeter granted `fixture_tool/lookup` (free unless `manifestExtra` says otherwise), its module container captured. */
  async function toolSetup(manifestExtra: Record<string, unknown> = {}) {
    const home = await mkdtemp(join(tmpdir(), 'asha-modulecall-'));
    const local = await installedModule(home, toolModuleManifest(manifestExtra));
    const t = await setup(
      { ...FIXTURE_RECIPE, messageTimeoutMs: 130_000, modules: ['fixture_tool/lookup'] },
      { tools: [] },
      { installed: new Map([['fixture_tool', local]]), home },
    );
    let container: FakeAttached | undefined;
    t.runtime.onAttached = (c) => {
      if (c.spec.labels['asha.role'] !== 'egress-proxy') container = c;
    };
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    return { ...t, home, container: () => present(container, 'the module container'), parent: t.delivered() };
  }

  /** A greeter granted `fixture_cli/get_state`, a command (plugin) tool rather than a ToolModule's own tool. */
  async function pluginSetup() {
    const home = await mkdtemp(join(tmpdir(), 'asha-moduleplugin-'));
    const archive = 'a fixture cli archive\n';
    const local = await installedModule(
      home,
      pluginManifest({
        executable: {
          ...(pluginManifest()['executable'] as object),
          archives: {
            aarch64: { url: 'https://example.test/cli-aarch64.tar', sha256: sha256(archive), file: 'cli-aarch64.tar' },
          },
        },
      }),
      { Dockerfile: PLUGIN_DOCKERFILE },
    );
    await writeFile(join(local.dir, 'cli-aarch64.tar'), archive);
    await writeFile(
      join(local.dir, '.asha-install.json'),
      JSON.stringify({ architecture: 'aarch64', archive: { file: 'cli-aarch64.tar', sha256: sha256(archive) } }),
    );
    await storeSecrets(home, 'fixture_cli', ['PIPELINE_KEY']);
    const t = await setup(
      { ...FIXTURE_RECIPE, messageTimeoutMs: 160_000, modules: ['fixture_cli/get_state', 'fixture_cli/retry_stage'] },
      { tools: [] },
      { installed: new Map([['fixture_cli', local]]), home },
    );
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    return {
      ...t,
      home,
      plugin: () => present(t.runtime.plugins.at(-1), 'the plugin container'),
      parent: t.delivered(),
    };
  }

  /** `fixture_tool/lookup` classed consequential, so a call is held for approval rather than sent (R12). */
  const CONSEQUENTIAL = {
    hosts: ['api.fixture.example'],
    tools: [
      {
        name: 'lookup',
        description: 'Look a word up.',
        classes: ['consequential', 'egress'],
        timeoutMs: 5_000,
        parameters: {
          type: 'object',
          properties: { word: { type: 'string', description: 'The word' } },
          required: ['word'],
        },
      },
    ],
  };

  it('400 bad_request: a malformed body or arguments, before any grant is looked at', async () => {
    const t = await plainSetup();
    for (const [body, error] of [
      [null, 'the body is not a JSON object {tool, arguments}'],
      [[], 'the body is not a JSON object {tool, arguments}'],
      [{ tool: 'fixture_tool__lookup', arguments: { word: 'x' }, extra: 1 }, 'unknown field(s): extra'],
      [{ tool: 123, arguments: {} }, 'the body is {tool: <wire name>, arguments: {…}}'],
      [{ tool: 'fixture_tool__lookup', arguments: [] }, 'the body is {tool: <wire name>, arguments: {…}}'],
    ] as const) {
      const response = await t.supervisor.moduleCall(t.token(), body, t.parent);
      expect(response).toEqual({ status: 400, body: { error, reason: 'bad_request' } });
    }
  });

  it('403 module_forbidden: a tool the recipe does not grant, logged', async () => {
    const t = await plainSetup();
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: { word: 'x' } },
      t.parent,
    );
    expect(response).toEqual({
      status: 403,
      body: { error: 'fixture_tool__lookup is not a tool recipe greeter grants', reason: 'module_forbidden' },
    });
    expect(entryFields(t.logger, 'module.failed')).toMatchObject({
      agent: 'greet-1',
      channel: 'main',
      tool: 'fixture_tool__lookup',
      reason: 'module_forbidden',
    });
  });

  it('a schema-refused call: 400 naming the tool and the problem, never reaching the module', async () => {
    const t = await toolSetup();
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: {} },
      t.parent,
    );
    expect(response).toEqual({
      status: 400,
      body: { error: 'fixture_tool__lookup: missing required argument "word"', reason: 'bad_request' },
    });
    expect(t.container().requests()).toEqual([]);
  });

  it('a granted free tool call runs on its module container and its result reaches the agent, logged module.call', async () => {
    const t = await toolSetup();
    const promise = t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: { word: 'harbor' } },
      t.parent,
    );
    await until(() => {
      expect(t.container().requests()).toHaveLength(1);
    });
    const request = present(t.container().requests()[0], "the module's request");
    expect(request['arguments']).toEqual({ word: 'harbor' });
    t.container().respond({ id: request['id'], ok: true, result: 'a harbor town' });
    expect(await promise).toEqual({ status: 200, body: { ok: true, result: 'a harbor town' } });
    expect(entryFields(t.logger, 'module.call')).toMatchObject({
      agent: 'greet-1',
      module: 'fixture_tool',
      tool: 'lookup',
      outcome: 'ok',
    });
  });

  it("a module's own {ok: false} answer reaches the agent as data, logged module.failed", async () => {
    const t = await toolSetup();
    const promise = t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: { word: 'nowhere' } },
      t.parent,
    );
    await until(() => {
      expect(t.container().requests()).toHaveLength(1);
    });
    const request = present(t.container().requests()[0], "the module's request");
    t.container().respond({ id: request['id'], ok: false, reason: 'not_found', detail: 'no such word' });
    expect(await promise).toEqual({ status: 200, body: { ok: false, reason: 'not_found', detail: 'no such word' } });
    expect(entryFields(t.logger, 'module.failed')).toMatchObject({
      agent: 'greet-1',
      module: 'fixture_tool',
      tool: 'lookup',
      reason: 'not_found',
    });
  });

  it('a granted command (plugin) tool dispatches through plugins.call, not host.call, and its exit reaches the agent', async () => {
    const t = await pluginSetup();
    t.runtime.onPlugin = (p) => {
      p.run = () =>
        Promise.resolve({
          kind: 'exited',
          code: 0,
          stdout: Buffer.from('running\n'),
          stderr: Buffer.alloc(0),
          stdoutBytes: 8,
          stderrBytes: 0,
        });
    };
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_cli__get_state', arguments: { name: 'alpha' } },
      t.parent,
    );
    expect(response).toEqual({
      status: 200,
      body: { ok: true, result: { exit_code: 0, stdout: 'running\n', stderr: '' } },
    });
    expect([t.plugin().spec.entrypoint, t.plugin().spec.args]).toEqual([
      'fixture-cli',
      ['pipeline', 'get-state', '--region', 'us-east-1', '--name', 'alpha'],
    ]);
    expect(entryFields(t.logger, 'plugin.call')).toMatchObject({
      agent: 'greet-1',
      plugin: 'fixture_cli',
      command: 'get_state',
      outcome: 'ok',
    });
  });

  it('a command (plugin) tool refused by argument validation never creates a container (R31)', async () => {
    const t = await pluginSetup();
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_cli__retry_stage', arguments: { name: 'alpha', stage: 'not-a-stage' } },
      t.parent,
    );
    expect(response).toEqual({
      status: 400,
      body: { error: 'fixture_cli__retry_stage: argument stage must be one of build, deploy', reason: 'bad_request' },
    });
    expect(t.runtime.plugins).toEqual([]);
  });

  it('a consequential call is held for approval: approval_required, a channel notice, GET reads it back by id', async () => {
    const t = await toolSetup(CONSEQUENTIAL);
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: { word: 'dock' } },
      t.parent,
    );
    expect(response.status).toBe(200);
    if (response.status !== 200 || response.body.ok) throw new Error('expected a held approval');
    expect(response.body.reason).toBe('approval_required');
    expect(response.body.detail).toMatch(/^approval [0-9a-f]{16}$/);
    const id = response.body.detail.slice('approval '.length);
    const read = t.supervisor.readApproval(id);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected ok');
    expect(read.request).toMatchObject({
      id,
      agent: 'greet-1',
      channel: 'main',
      module: 'fixture_tool',
      tool: 'lookup',
    });
    expect(read.request.sha256).toBe(
      requestSha256({
        agent: 'greet-1',
        conversation: read.request.conversation,
        module: 'fixture_tool',
        tool: 'lookup',
        arguments: read.request.arguments,
      }),
    );
    expect(t.supervisor.readApproval('0000000000000000')).toEqual({ ok: false, reason: 'unknown' });
    expect(t.container().requests()).toEqual([]);
  });

  it('approval_required: once MAX_PENDING_APPROVALS are pending, one more is refused, nothing recorded or sent (R12 (a))', async () => {
    const t = await toolSetup(CONSEQUENTIAL);
    for (let i = 0; i < MAX_PENDING_APPROVALS; i += 1) {
      const response = await t.supervisor.moduleCall(
        t.token(),
        { tool: 'fixture_tool__lookup', arguments: { word: `w${String(i)}` } },
        t.parent,
      );
      expect(response.status).toBe(200);
    }
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: { word: 'one-too-many' } },
      t.parent,
    );
    expect(response).toEqual({
      status: 200,
      body: { ok: false, reason: 'approval_required', detail: 'too many pending approvals' },
    });
    expect(entryFields(t.logger, 'module.failed')).toMatchObject({
      agent: 'greet-1',
      module: 'fixture_tool',
      tool: 'lookup',
      reason: 'approval_required',
    });
    expect(t.container().requests()).toEqual([]);
  });

  it('approve: an unknown id is refused, nothing performed', async () => {
    const t = await plainSetup();
    expect(t.supervisor.approve('0000000000000000')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('approve: perform makes exactly the approved call once, and deliver posts its outcome (R12 (b)–(e))', async () => {
    const t = await toolSetup(CONSEQUENTIAL);
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: { word: 'dock' } },
      t.parent,
    );
    if (response.status !== 200 || response.body.ok) throw new Error('expected a held approval');
    const id = response.body.detail.slice('approval '.length);
    const approved = t.supervisor.approve(id);
    if (!approved.ok) throw new Error('expected ok');
    const performing = approved.perform();
    await until(() => {
      expect(t.container().requests()).toHaveLength(1);
    });
    const request = present(t.container().requests()[0], "the module's request");
    t.container().respond({ id: request['id'], ok: true, result: 'a dock town' });
    const outcome = await performing;
    expect(outcome).toEqual({ ok: true, result: 'a dock town' });
    const delivered = approved.deliver(outcome);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) throw new Error('expected ok');
    expect(delivered.message).toMatchObject({
      kind: 'internal',
      to: 'greet-1',
      text: `asha made the approved call fixture_tool/lookup (approval ${id}): ok`,
      approved: { approval: id, module: 'fixture_tool', tool: 'lookup', outcome: { ok: true, result: 'a dock town' } },
    });
    // Taken at once, before it was performed: a second approval of the same id finds it unknown.
    expect(t.supervisor.approve(id)).toEqual({ ok: false, reason: 'unknown' });
    expect(entryFields(t.logger, 'module.approved')).toMatchObject({
      agent: 'greet-1',
      module: 'fixture_tool',
      tool: 'lookup',
      approval: id,
    });
  });

  it('perform: module_unavailable once the agent has left before the approved call is performed', async () => {
    const t = await toolSetup(CONSEQUENTIAL);
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: { word: 'dock' } },
      t.parent,
    );
    if (response.status !== 200 || response.body.ok) throw new Error('expected a held approval');
    const id = response.body.detail.slice('approval '.length);
    await t.supervisor.stopHandle('main', 'greet-1', 'gone before approve');
    const approved = t.supervisor.approve(id);
    if (!approved.ok) throw new Error('expected ok');
    expect(await approved.perform()).toEqual({ ok: false, reason: 'module_unavailable' });
    expect(t.container().requests()).toEqual([]);
  });

  it('deliver: unknown_handle once the agent has left before the outcome is given to it, logged module.approval_undelivered', async () => {
    const t = await toolSetup(CONSEQUENTIAL);
    const response = await t.supervisor.moduleCall(
      t.token(),
      { tool: 'fixture_tool__lookup', arguments: { word: 'dock' } },
      t.parent,
    );
    if (response.status !== 200 || response.body.ok) throw new Error('expected a held approval');
    const id = response.body.detail.slice('approval '.length);
    const approved = t.supervisor.approve(id);
    if (!approved.ok) throw new Error('expected ok');
    const performing = approved.perform();
    await until(() => {
      expect(t.container().requests()).toHaveLength(1);
    });
    const request = present(t.container().requests()[0], "the module's request");
    t.container().respond({ id: request['id'], ok: true, result: 'a dock town' });
    const outcome = await performing;
    await t.supervisor.stopHandle('main', 'greet-1', 'gone before delivery');
    const delivered = approved.deliver(outcome);
    expect(delivered).toEqual({
      ok: false,
      reason: 'unknown_handle',
      detail: `greet-1 could not be given the result of approval ${id} (it has left); the call's outcome: ok`,
    });
    expect(entryFields(t.logger, 'module.approval_undelivered')).toEqual({
      agent: 'greet-1',
      channel: 'main',
      module: 'fixture_tool',
      tool: 'lookup',
      approval: id,
      sha256: approved.request.sha256,
      outcome: 'ok',
      reason: 'agent_gone',
    });
  });

  describe('enableModule (R18b, R36)', () => {
    const CAPPED = {
      cost: {
        model: 'metered',
        perCall: { unit: 'credit', units: 1, unitUsd: 0.01, url: 'https://x.example/p', read: '2026-10-01' },
        approved: { by: 'the owner', date: '2026-10-01', capUsd: 5 },
      },
    };

    it('ok: enables a metered module at caps within its approved capUsd, logged and reflected by spend()', async () => {
      const home = await mkdtemp(join(tmpdir(), 'asha-enable-'));
      const local = await installedModule(home, toolModuleManifest(CAPPED));
      const t = await setup(FIXTURE_RECIPE, { tools: [] }, { installed: new Map([['fixture_tool', local]]), home });
      const outcome = await t.supervisor.enableModule('fixture_tool', { conversation: 1, day: 5, month: 5 });
      expect(outcome).toEqual({ ok: true });
      expect(entryFields(t.logger, 'module.enabled')).toEqual({
        module: 'fixture_tool',
        caps: { conversation: 1, day: 5, month: 5 },
      });
      expect(t.supervisor.spend()).toEqual([{ module: 'fixture_tool', day: 0, dayCap: 5, month: 0, monthCap: 5 }]);
    });

    it('not_installed: no such module', async () => {
      const t = await setup();
      const outcome = await t.supervisor.enableModule('nope', { conversation: 1, day: 1, month: 1 });
      expect(outcome).toEqual({ ok: false, reason: 'not_installed', detail: 'no such module is installed' });
    });

    it('not_metered: a free module has nothing to enable', async () => {
      const home = await mkdtemp(join(tmpdir(), 'asha-enable-'));
      const local = await installedModule(home, toolModuleManifest());
      const t = await setup(FIXTURE_RECIPE, { tools: [] }, { installed: new Map([['fixture_tool', local]]), home });
      const outcome = await t.supervisor.enableModule('fixture_tool', { conversation: 1, day: 1, month: 1 });
      expect(outcome).toEqual({
        ok: false,
        reason: 'not_metered',
        detail: "module fixture_tool's cost model is free: there is nothing to enable",
      });
    });

    it('over_cap: a cap above the approved capUsd is refused, naming it', async () => {
      const home = await mkdtemp(join(tmpdir(), 'asha-enable-'));
      const local = await installedModule(home, toolModuleManifest(CAPPED));
      const t = await setup(FIXTURE_RECIPE, { tools: [] }, { installed: new Map([['fixture_tool', local]]), home });
      const outcome = await t.supervisor.enableModule('fixture_tool', { conversation: 10, day: 5, month: 5 });
      expect(outcome).toEqual({
        ok: false,
        reason: 'over_cap',
        detail: "conversation=10 over module fixture_tool's approved cap of 5 USD",
      });
    });
  });

  describe('metering a granted tool call (R18b, R36)', () => {
    async function meteredSetup(caps: Caps) {
      const home = await mkdtemp(join(tmpdir(), 'asha-metered-'));
      const manifest = toolModuleManifest({
        cost: {
          model: 'metered',
          perCall: { unit: 'credit', units: 1, unitUsd: 0.01, url: 'https://x.example/p', read: '2026-10-01' },
          approved: { by: 'the owner', date: '2026-10-01', capUsd: 5 },
        },
      });
      const local = await installedModule(home, manifest);
      const t = await setup(
        { ...FIXTURE_RECIPE, messageTimeoutMs: 130_000, modules: ['fixture_tool/lookup'] },
        { tools: [] },
        { installed: new Map([['fixture_tool', local]]), home },
      );
      const enabled = await t.supervisor.enableModule('fixture_tool', caps);
      let container: FakeAttached | undefined;
      t.runtime.onAttached = (c) => {
        if (c.spec.labels['asha.role'] !== 'egress-proxy') container = c;
      };
      t.connectOnStart();
      await t.supervisor.launchNew('greeter', t.main, t.quiet);
      return { ...t, enabled, container: () => present(container, 'the module container'), parent: t.delivered() };
    }

    it('budget_exceeded: reserved and refused before the module is ever called', async () => {
      const t = await meteredSetup({ conversation: 0, day: 5, month: 5 });
      expect(t.enabled).toEqual({ ok: true });
      const response = await t.supervisor.moduleCall(
        t.token(),
        { tool: 'fixture_tool__lookup', arguments: { word: 'x' } },
        t.parent,
      );
      expect(response).toEqual({
        status: 200,
        body: { ok: false, reason: 'budget_exceeded', detail: 'the conversation cap of 0 USD would be passed' },
      });
      expect(t.container().requests()).toEqual([]);
    });

    it('a metered call settles to the vendor-reported usage, spend() updated', async () => {
      const t = await meteredSetup({ conversation: 1, day: 5, month: 5 });
      const promise = t.supervisor.moduleCall(
        t.token(),
        { tool: 'fixture_tool__lookup', arguments: { word: 'x' } },
        t.parent,
      );
      await until(() => {
        expect(t.container().requests()).toHaveLength(1);
      });
      const request = present(t.container().requests()[0], "the module's request");
      t.container().respond({ id: request['id'], ok: true, result: 'x', usage: { units: 2 } });
      expect(await promise).toEqual({ status: 200, body: { ok: true, result: 'x' } });
      expect(t.supervisor.spend()).toEqual([
        { module: 'fixture_tool', day: 0.02, dayCap: 5, month: 0.02, monthCap: 5 },
      ]);
    });

    it('a metered call reporting no usage is charged its whole reservation, logged module.failed no_usage', async () => {
      const t = await meteredSetup({ conversation: 1, day: 5, month: 5 });
      const promise = t.supervisor.moduleCall(
        t.token(),
        { tool: 'fixture_tool__lookup', arguments: { word: 'x' } },
        t.parent,
      );
      await until(() => {
        expect(t.container().requests()).toHaveLength(1);
      });
      const request = present(t.container().requests()[0], "the module's request");
      t.container().respond({ id: request['id'], ok: true, result: 'x' });
      expect(await promise).toEqual({ status: 200, body: { ok: true, result: 'x' } });
      expect(t.supervisor.spend()).toEqual([
        { module: 'fixture_tool', day: 0.01, dayCap: 5, month: 0.01, monthCap: 5 },
      ]);
      expect(entryFields(t.logger, 'module.failed')).toMatchObject({
        agent: 'greet-1',
        module: 'fixture_tool',
        tool: 'lookup',
        reason: 'no_usage',
      });
    });
  });

  describe("approvedSettled: the stop's bounded wait for approved calls in flight (R12 (e))", () => {
    it('nothing pending: resolves at once, nothing logged', async () => {
      const t = await plainSetup();
      await t.supervisor.approvedSettled(10);
      expect(t.logger.entries.filter((e) => e.event === 'module.audit_unsettled')).toEqual([]);
    });

    it('a call still in flight past the bound is logged module.audit_unsettled, once', async () => {
      const t = await toolSetup(CONSEQUENTIAL);
      const response = await t.supervisor.moduleCall(
        t.token(),
        { tool: 'fixture_tool__lookup', arguments: { word: 'dock' } },
        t.parent,
      );
      if (response.status !== 200 || response.body.ok) throw new Error('expected a held approval');
      const id = response.body.detail.slice('approval '.length);
      const approved = t.supervisor.approve(id);
      if (!approved.ok) throw new Error('expected ok');
      const performing = approved.perform();
      await until(() => {
        expect(t.container().requests()).toHaveLength(1);
      });
      await t.supervisor.approvedSettled(10);
      expect(entryFields(t.logger, 'module.audit_unsettled')).toMatchObject({ calls: 1 });
      // Cleaned up so nothing is left in flight once the test ends.
      const request = present(t.container().requests()[0], "the module's request");
      t.container().respond({ id: request['id'], ok: true, result: 'a dock town' });
      await performing;
    });
  });
});

describe('a chat streams its output to the conversation and the channel (model-streaming R3, R4, R8; A3, A6)', () => {
  const CHAT = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 };
  /** A distinctive string no log record may carry (R8). */
  const SECRET = 'zebra-quartz-7731';

  /** An agent online on main, the model streaming `script`, and every event its conversation's and the channel's watchers get. */
  async function streaming(script: Parameters<typeof sseResponse>[0]) {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = llamaServer(() =>
      sseResponse(script),
    ).fetch;
    const input = t.main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });
    const conversation: unknown[] = [];
    const channel: unknown[] = [];
    t.main.watch(input.conversation, (e) => conversation.push(e));
    t.main.watchAll((e) => channel.push(e));
    const parent = { traceId: traceIdFor(input.conversation), spanId: 'c'.repeat(16) };
    return { t, input, parent, conversation, channel };
  }

  it('publishes each piece as model_delta, seq from 0 and the asha.chat span id as call, then one model_done ok, to both', async () => {
    const s = await streaming({
      reasoning: ['Hm'],
      toolCalls: [{ id: 'c1', name: 'reply', fragments: ['{"text":', `"${SECRET}"}`] }],
    });
    const response = await s.t.supervisor.chat(s.t.token(), CHAT, s.parent, OPEN);
    expect(response).toEqual({
      ok: true,
      text: '',
      toolCalls: [{ id: 'c1', name: 'reply', arguments: { text: SECRET } }],
    });
    const call = present(
      s.t.spans.find((r) => r.name === 'asha.chat'),
      "span named 'asha.chat'",
    ).spanId;
    const base = { type: 'model_delta', handle: 'greet-1', conversation: s.input.conversation, call };
    const expected = [
      { ...base, seq: 0, part: 'thinking', text: 'Hm' },
      { ...base, seq: 1, part: 'tool_args', index: 0, name: 'reply', text: '{"text":' },
      { ...base, seq: 2, part: 'tool_args', index: 0, name: 'reply', text: `"${SECRET}"}` },
      { type: 'model_done', handle: 'greet-1', conversation: s.input.conversation, call, outcome: 'ok' },
    ];
    expect(s.conversation).toEqual(expected);
    expect(s.channel).toEqual(expected);
    // R8: no log record carries the model's output.
    expect(JSON.stringify(s.t.logger.entries)).not.toContain(SECRET);
    expect(s.t.logger.events('info')).toContain('model.chat');
  });

  it('serves and streams a call in a conversation delivered earlier, after its delivery is acked (the memory extraction)', async () => {
    const s = await streaming({ content: ['noted'] });
    const [delivery] = s.t.inbox;
    s.t.supervisor.ack(s.t.token(), present(delivery, 's.t.inbox[0]').deliveryId);
    const response = await s.t.supervisor.chat(s.t.token(), CHAT, s.parent, OPEN);
    expect(response).toEqual({ ok: true, text: 'noted', toolCalls: [] });
    // The ack left nobody working, so the harness answered the user first; then the extraction's output streams.
    expect(s.channel.map((e) => (e as { type: string }).type)).toEqual(['message', 'model_delta', 'model_done']);
    expect(s.conversation.map((e) => (e as { type: string }).type)).toEqual([
      'message',
      'status',
      'model_delta',
      'model_done',
    ]);
  });

  it("publishes nothing for a call refused before the model: a foreign trace, or a tool outside the agent's own", async () => {
    const s = await streaming({ content: ['x'] });
    const foreign = { traceId: traceIdFor('not-delivered'), spanId: 'c'.repeat(16) };
    await expect(s.t.supervisor.chat(s.t.token(), CHAT, foreign, OPEN)).rejects.toThrow(AgentRequestInvalid);
    const outside = {
      ...CHAT,
      tools: [{ type: 'function', function: { name: 'write_file', description: 'x', parameters: { type: 'object' } } }],
    };
    await expect(s.t.supervisor.chat(s.t.token(), outside, s.parent, OPEN)).rejects.toThrow(AgentRequestInvalid);
    expect(s.conversation).toEqual([]);
    expect(s.channel).toEqual([]);
  });

  it('publishes model_done with the failure reason after the deltas of a failed call, and logs the stream figures it reached', async () => {
    const s = await streaming({ content: [SECRET], usage: null });
    const response = await s.t.supervisor.chat(s.t.token(), CHAT, s.parent, OPEN);
    expect(response).toEqual({ ok: false, reason: 'bad_response', detail: 'the stream has no usage chunk' });
    expect(s.channel.map((e) => [(e as { type: string }).type, (e as { outcome?: string }).outcome])).toEqual([
      ['model_delta', undefined],
      ['model_done', 'bad_response'],
    ]);
    const failed = s.t.logger.entries.filter((e) => e.event === 'model.chat_failed');
    expect(
      failed.map((e) => ({
        ...e.fields,
        ms: typeof e.fields['ms'],
        ttfcMs: typeof e.fields['ttfcMs'],
        error: String(e.fields['error']),
      })),
    ).toEqual([
      {
        handle: 'greet-1',
        channel: 'main',
        model: 'tiny-model',
        ms: 'number',
        ttfcMs: 'number',
        chunks: 3,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        reason: 'bad_response',
        error: 'Error: bad_response: the stream has no usage chunk',
      },
    ]);
    expect(JSON.stringify(s.t.logger.entries)).not.toContain(SECRET);
  });

  it('logs model.chat_failed with null figures for a call whose agent hung up before any chunk, and publishes model_done timeout', async () => {
    const s = await streaming({ content: ['x'] });
    (s.t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = new FakeFetch((_url, init) =>
      hangUntilAborted(init),
    ).fetch;
    const closed = new AbortController();
    const pending = s.t.supervisor.chat(s.t.token(), CHAT, s.parent, closed.signal);
    closed.abort();
    expect(await pending).toEqual({
      ok: false,
      reason: 'timeout',
      detail: "the agent's request closed before the answer",
    });
    expect(s.t.logger.events('error')).toEqual(['model.chat_failed']);
    expect(entryFields(s.t.logger, 'model.chat_failed')).toMatchObject({
      ttfcMs: null,
      chunks: 0,
      promptTokens: null,
      completionTokens: null,
      reason: 'timeout',
    });
    expect(s.channel.map((e) => (e as { outcome?: string }).outcome)).toEqual(['timeout']);
  });

  it('logs a call whose request closed while the daemon stops its agent as abandoned, before the exit is seen (amendment 2)', async () => {
    const s = await streaming({ content: ['x'] });
    (s.t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = new FakeFetch((_url, init) =>
      hangUntilAborted(init),
    ).fetch;
    // The container is told to stop and has not exited yet.
    s.t.runtime.onStop = () => new Promise<void>(() => undefined);
    const closed = new AbortController();
    const pending = s.t.supervisor.chat(s.t.token(), CHAT, s.parent, closed.signal);
    void s.t.supervisor.stopHandle('main', 'greet-1', 'test stop');
    closed.abort();
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout' });
    expect(s.t.logger.events('error')).toEqual([]);
    expect(
      s.t.logger.entries.filter((e) => e.event === 'model.call_abandoned').map((e) => [e.level, e.fields['detail']]),
    ).toEqual([['warn', "the agent's request closed before the answer"]]);
  });
});

describe('the channel file space of a launch (docs/plans/agent-files.md R4, R10; A3)', () => {
  it("is created before the channel's first agent starts, from that agent's exact image tag, and mounted on every agent of the channel and on no other", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    await t.supervisor.launchNew('greeter', t.channels.get('other'), t.quiet);
    const start0 = present(t.runtime.starts[0], 't.runtime.starts[0]');
    const tag = start0.image;
    const volume = 'asha-abcd1234-0123abcd-main';
    // The space's steps come before the first start, and only once for the channel.
    const firstStart = t.runtime.calls.indexOf(`start ${start0.name}`);
    expect(t.runtime.calls.indexOf(`createHolder ${volume}-files ${tag} ${volume}`)).toBeLessThan(firstStart);
    expect(t.runtime.calls.filter((c) => c.startsWith('createVolume'))).toEqual([
      `createVolume ${volume}`,
      'createVolume asha-abcd1234-0123abcd-other',
    ]);
    expect(t.runtime.starts.map((s) => s.channelVolume)).toEqual([volume, volume, 'asha-abcd1234-0123abcd-other']);
    expect(t.logger.entries.filter((e) => e.event === 'files.space_created').map((e) => e.fields)).toEqual([
      { channel: 'main', volume },
      { channel: 'other', volume: 'asha-abcd1234-0123abcd-other' },
    ]);
  });

  it('a space that cannot be created fails the launch loudly, naming the space, and starts no container', async () => {
    const t = await setup();
    t.runtime.failSpace.volumeCreate = new Error('docker volume create failed:\ndisk full');
    const error = await t.supervisor.launchNew('greeter', t.main, t.quiet).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'the file space of channel main could not be created (volume): docker volume create failed:\ndisk full',
    );
    expect(classify(error)).toBe('container_runtime');
    expect(t.runtime.starts).toEqual([]);
  });
});

describe('AgentSupervisor.prepareSpace (agent-files R3a, R7)', () => {
  it('a channel with no agent online and no recipe: NoAgentToRead, creating nothing', async () => {
    const t = await setup();
    const error = await t.supervisor.prepareSpace(t.main, undefined, t.quiet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoAgentToRead);
    expect(classify(error)).toBe('bad_request');
    expect(t.runtime.calls).toEqual([]);
  });

  it("with a recipe and no space: the runtime made ready and the recipe's image ensured, each a phase, then the space created and measured; cloudAgents empty while nothing is cloud-granted", async () => {
    const t = await setup();
    const phases: [string, string][] = [];
    const ready = await t.supervisor.prepareSpace(t.main, 'greeter', { phase: (p, d) => phases.push([p, d]) });
    expect(ready).toEqual({ bytes: 0, entries: 0, cloudAgents: [] });
    expect(phases).toEqual([
      ['container_runtime', 'ready'],
      ['image', 'asha-image-greeter-image built'],
    ]);
    expect(t.runtime.calls.filter((c) => c.startsWith('createVolume'))).toEqual([
      'createVolume asha-abcd1234-0123abcd-main',
    ]);
    // No model and no agent: a space needs only an image.
    expect(t.store.ensured).toEqual([]);
    expect(t.runtime.starts).toEqual([]);
  });

  it('with an agent online and a space: measured only, no phase', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    present(t.runtime.volumes.get('asha-abcd1234-0123abcd-main'), "volume 'asha-abcd1234-0123abcd-main'").entries.set(
      'notes.txt',
      { type: 'file', content: Buffer.from('12345'), owner: '1000:1000', mode: 0o644 },
    );
    t.runtime.calls.length = 0;
    const phases: unknown[] = [];
    expect(await t.supervisor.prepareSpace(t.main, undefined, { phase: (p, d) => phases.push([p, d]) })).toEqual({
      bytes: 5,
      entries: 1,
      cloudAgents: [],
    });
    expect(phases).toEqual([]);
    expect(t.runtime.calls).toEqual(['copyOut asha-abcd1234-0123abcd-main-files /channel']);
  });

  it('a cloud-granted launch onto a space holding a file is launched and announced with exposesFiles; onto an empty one without; and prepareSpace names it among cloudAgents (R7; completion review, finding 5)', async () => {
    // A cloud module granted (extension-modules R25): a module that lists a host, its secret set.
    const home = await mkdtemp(join(tmpdir(), 'asha-cloud-'));
    const search = await installedModule(home, cloudToolManifest());
    await storeSecrets(home, 'fixture_search', ['SEARCH_KEY']);
    const t = await setup(
      { ...FIXTURE_RECIPE, messageTimeoutMs: 130_000, modules: ['fixture_search/search'] },
      { tools: [] },
      { installed: new Map([['fixture_search', search]]), home },
    );
    t.connectOnStart();
    const announced: unknown[] = [];
    const sink = {
      phase: () => undefined,
      announced: (_m: unknown, _r: unknown, exposes?: true) => announced.push(exposes),
      resent: () => undefined,
    };
    const first = await t.supervisor.launchNew('greeter', t.main, sink);
    expect(first.exposesFiles).toBeUndefined();
    present(t.runtime.volumes.get('asha-abcd1234-0123abcd-main'), "volume 'asha-abcd1234-0123abcd-main'").entries.set(
      'notes.txt',
      { type: 'file', content: Buffer.from('n'), owner: '1000:1000', mode: 0o644 },
    );
    const second = await t.supervisor.launchNew('greeter', t.main, sink);
    expect(second.exposesFiles).toBe(true);
    expect(announced).toEqual([undefined, true]);
    expect([...(await t.supervisor.prepareSpace(t.main, undefined, t.quiet)).cloudAgents].sort(byCodeUnit)).toEqual(
      [first.handle, second.handle].sort(byCodeUnit),
    );
  });

  it('an output with files from an agent whose recipe does not select reply_with_files is refused, copying nothing; one that selects it is posted with the file (R12; completion review, finding 11)', async () => {
    for (const [tools, expected] of [
      [[] as string[], 'refused'],
      [['reply_with_files'], 'posted'],
    ] as const) {
      const t = await setup({ ...FIXTURE_RECIPE, tools: [...tools] });
      t.connectOnStart();
      await t.supervisor.launchNew('greeter', t.main, t.quiet);
      present(t.runtime.volumes.get('asha-abcd1234-0123abcd-main'), "volume 'asha-abcd1234-0123abcd-main'").entries.set(
        'out.txt',
        { type: 'file', content: Buffer.from('o'), owner: '1000:1000', mode: 0o644 },
      );
      const input = t.main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });
      t.runtime.calls.length = 0;
      const answer = await t.supervisor.postWithFiles(
        t.token(),
        { conversation: input.conversation, text: 'here', files: ['/channel/out.txt'] },
        'c'.repeat(16),
      );
      if (expected === 'refused') {
        expect(answer).toEqual({
          ok: false,
          file: '/channel/out.txt',
          rule: 'recipe greeter does not select reply_with_files',
        });
        expect(t.runtime.calls).toEqual([]);
        expect(t.logger.entries.filter((e) => e.event === 'files.refused').map((e) => e.fields['reason'])).toEqual([
          'file_refused',
        ]);
      } else {
        expect(answer).toMatchObject({
          ok: true,
          message: { kind: 'output', text: 'here', files: [{ name: 'out.txt', size: 1 }] },
        });
      }
    }
  });

  it('an ask from an agent whose recipe does not select ask_user is refused, nothing posted; one that selects it is posted carrying asks (patterns-phase-3 R23, R24)', async () => {
    for (const [tools, expected] of [
      [[] as string[], 'refused'],
      [['ask_user'], 'posted'],
    ] as const) {
      const t = await setup({ ...FIXTURE_RECIPE, tools: [...tools] });
      t.connectOnStart();
      const launched = await t.supervisor.launchNew('greeter', t.main, t.quiet);
      const input = t.main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });
      const posted = () => t.logger.entries.filter((e) => e.event === 'channel.posted').length;
      const before = posted();
      const ask = () =>
        t.supervisor.post(
          t.token(),
          { conversation: input.conversation, kind: 'output', text: 'Shall I?', asks: true },
          'c'.repeat(16),
        );
      if (expected === 'refused') {
        expect(ask).toThrow(AgentRequestInvalid);
        expect(ask).toThrow('recipe greeter does not select ask_user');
        expect(posted()).toBe(before);
        expect(t.main.waitingOn(input.conversation)).toBeUndefined();
      } else {
        expect(ask()).toMatchObject({ kind: 'output', from: launched.handle, text: 'Shall I?', asks: true });
        expect(t.main.waitingOn(input.conversation)).toMatchObject({ agent: launched.handle, text: 'Shall I?' });
      }
    }
  });

  it('onto a channel whose saved state is memory-tainted: a recipe granting only a host-less module is not cloud-granted — it launches, without exposesFiles beside a file; a hosted-model recipe is, and is refused memory_egress_forbidden and named in cloudAgents (extension-modules R25; A22)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-taint-'));
    const local = await installedModule(home, toolModuleManifest());
    const provider = await installedModule(home, providerManifest({ id: 'free_provider', cost: { model: 'free' } }));
    await storeSecrets(home, 'free_provider', ['VENDOR_KEY']);
    // The channel's saved state, written while an agent that keeps memory was online (agent-persistence R7).
    const state = new StateStore({
      dir: join(home, 'state'),
      fs: nodeStateFs,
      logger: new RecordingLogger(),
      clock: () => new Date('2026-09-26T00:00:00Z'),
      insideGitTree: () => Promise.resolve(false),
    });
    const board = await state.begin(state.channelDir('main'));
    await board.writeJson('board', { session: 1, entries: [] }, 0);
    await board.promote<ChannelPointer>(
      { kind: 'channel', team: 'duo', lastDelivery: null, memoryTainted: true },
      'main',
    );
    const t = await setup(
      { ...FIXTURE_RECIPE, messageTimeoutMs: 130_000, modules: ['fixture_tool/lookup'] },
      { tools: [] },
      {
        installed: new Map([
          ['fixture_tool', local],
          ['free_provider', provider],
        ]),
        home,
      },
    );
    await writeFile(
      join(t.root, 'recipes', 'hosted.json'),
      JSON.stringify({ ...FIXTURE_RECIPE, id: 'hosted', model: 'free_provider/small' }),
    );
    t.connectOnStart();
    const first = await t.supervisor.launchNew('greeter', t.main, t.quiet);
    present(t.runtime.volumes.get('asha-abcd1234-0123abcd-main'), "volume 'asha-abcd1234-0123abcd-main'").entries.set(
      'notes.txt',
      { type: 'file', content: Buffer.from('n'), owner: '1000:1000', mode: 0o644 },
    );
    const second = await t.supervisor.launchNew('greeter', t.main, t.quiet);
    expect([first.exposesFiles, second.exposesFiles]).toEqual([undefined, undefined]);
    // The hosted model's recipe is cloud-granted: named among cloudAgents before its launch, then refused.
    expect((await t.supervisor.prepareSpace(t.main, 'hosted', t.quiet)).cloudAgents).toEqual(['hosted']);
    const starts = t.runtime.starts.length;
    const refused = await t.supervisor.launchNew('hosted', t.main, t.quiet).catch((e: unknown) => e);
    expect(refused).toEqual(new MemoryEgressForbidden('main'));
    expect(t.runtime.starts).toHaveLength(starts);
  });

  it.each(['stopHandle', 'disconnect'] as const)(
    "releases a module container once when its channel's last granting agent leaves by %s; a second stop of that agent releases nothing more (extension-modules R34; A32)",
    async (way) => {
      const home = await mkdtemp(join(tmpdir(), 'asha-release-'));
      const local = await installedModule(home, toolModuleManifest());
      const t = await setup(
        { ...FIXTURE_RECIPE, messageTimeoutMs: 130_000, modules: ['fixture_tool/lookup'] },
        { tools: [] },
        { installed: new Map([['fixture_tool', local]]), home },
      );
      t.connectOnStart();
      const a = await t.supervisor.launchNew('greeter', t.main, t.quiet);
      const b = await t.supervisor.launchNew('greeter', t.main, t.quiet);
      const removed = () => t.runtime.calls.filter((c) => c.startsWith('removeAttached asha-mod-fixture_tool-'));
      const networks = () => t.runtime.calls.filter((c) => c.startsWith('removeNetwork asha-m-'));
      const leave = async (handle: string, i: number) => {
        if (way === 'stopHandle') await t.supervisor.stopHandle('main', handle, 'held a delivery past its bound');
        else {
          // The container is stopped once RESTART_EXIT_WAIT_MS has passed with no exit: on a fake clock, not 2 s of real
          // time each (two waited 4 s of the test's 5 s bound, and a loaded full run passed it, 2026-10-03).
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          try {
            t.supervisor.disconnect(t.token(i));
            await vi.advanceTimersByTimeAsync(2_000);
          } finally {
            vi.useRealTimers();
          }
        }
        const container = present(t.runtime.starts[i], 't.runtime.starts[i]').name;
        await until(() => {
          expect(
            t.logger.entries.some((e) => /^agent\.(exited|stop)/.test(e.event) && e.fields['container'] === container),
          ).toBe(true);
        });
        await new Promise((resolve) => setImmediate(resolve));
      };
      await leave(a.handle, 0);
      expect([removed(), networks()]).toEqual([[], []]);
      await leave(b.handle, 1);
      await until(() => {
        expect(removed()).toHaveLength(1);
      });
      expect(networks()).toHaveLength(1);
      // A second stop of an agent already gone releases nothing more.
      if (way === 'stopHandle') await t.supervisor.stopHandle('main', b.handle, 'again');
      else t.supervisor.disconnect(t.token(1));
      await new Promise((resolve) => setImmediate(resolve));
      expect([removed(), networks()].map((l) => l.length)).toEqual([1, 1]);
      expect(
        t.logger.entries
          .filter((e) => e.event === 'module.released')
          .map((e) => [e.fields['module'], e.fields['channel']]),
      ).toEqual([['fixture_tool', 'main']]);
    },
  );

  it('exposesFiles (R7) holds exactly when an agent is cloud-granted and the space holds an entry', () => {
    expect([exposesFiles(true, 1), exposesFiles(true, 0), exposesFiles(false, 5), exposesFiles(false, 0)]).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("a conversation's tokens budget (patterns-phase-3 R17, A10)", () => {
  /** A user's message with a tokens budget, delivered to the agents on main; the agent's chat span in its trace. */
  const budgeted = (
    t: Awaited<ReturnType<typeof setup>>,
    tokens: number,
  ): { readonly parent: TraceParent; readonly conversation: string } => {
    const input = t.main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi', budget: { tokens } });
    t.main.watch(input.conversation, (e) => events.push(e));
    return {
      parent: { traceId: traceIdFor(input.conversation), spanId: 'c'.repeat(16) },
      conversation: input.conversation,
    };
  };
  let events: { type: string; reason?: string; detail?: string }[] = [];
  beforeEach(() => {
    events = [];
  });

  it("tokens 1: the first call's usage — its prompt and completion tokens — ends the conversation budget_exceeded, and its result is still returned", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const { parent, conversation } = budgeted(t, 1);

    const response = await t.supervisor.chat(
      t.token(),
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
      parent,
      OPEN,
    );

    expect(response).toEqual({ ok: true, text: 'hello', toolCalls: [] });
    expect(t.main.isEnded(conversation)).toBe(true);
    // 1,893 prompt and 2 completion tokens (the fake's usage), against a budget of 1.
    expect(events.filter((e) => e.type === 'error')).toEqual([
      {
        type: 'error',
        reason: 'budget_exceeded',
        detail: `conversation ${conversation} used 1895 tokens of its budget of 1`,
      },
    ]);
    expect(t.logger.events('error')).toEqual(['channel.conversation_ended']);
  });

  it('a budget the call does not pass leaves the conversation open; the next call that passes it ends it', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const { parent, conversation } = budgeted(t, 3_000);

    await t.supervisor.chat(t.token(), { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }, parent, OPEN);
    expect(t.main.isEnded(conversation)).toBe(false);
    await t.supervisor.chat(t.token(), { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }, parent, OPEN);
    expect(t.main.isEnded(conversation)).toBe(true);
    expect(events.filter((e) => e.type === 'error').map((e) => e.detail)).toEqual([
      `conversation ${conversation} used 3790 tokens of its budget of 3000`,
    ]);
  });

  it('a call whose usage chunk never came adds 0', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const { parent, conversation } = budgeted(t, 1);
    const noUsage = new FakeFetch(() => sseResponse({ content: ['hello'], usage: null }));
    (t.supervisor as unknown as { props: { fetch: typeof fetch } }).props.fetch = noUsage.fetch;

    const spend = vi.spyOn(t.main, 'spend');

    const response = await t.supervisor.chat(
      t.token(),
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
      parent,
      OPEN,
    );

    expect(response.ok).toBe(false);
    // Spent, and spent as 0: neither left out nor NaN.
    expect(spend.mock.calls).toEqual([[conversation, 0]]);
    expect(t.main.isEnded(conversation)).toBe(false);
  });

  it('a conversation with no tokens budget is never ended by its calls', async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.ensureOnline('greeter', t.main, t.sink);
    const parent = t.delivered();
    for (let i = 0; i < 3; i += 1)
      await t.supervisor.chat(t.token(), { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }, parent, OPEN);
    expect(t.logger.events('error')).toEqual([]);
  });
});

describe("the supervisor's queries of who is on a channel (the code review's round 4, R4-COVERAGE-001)", () => {
  it("roster: the caller's channel's other online agents, by handle, with their recipe and its description; refused before it connects", async () => {
    const t = await setup();
    t.connectOnStart();
    for (let i = 0; i < 3; i += 1) await t.supervisor.launchNew('greeter', t.main, t.quiet);
    await t.supervisor.launchNew('greeter', t.channels.get('other'), t.quiet);
    const entry = (handle: string) => ({ handle, recipe: 'greeter', description: FIXTURE_RECIPE.description });
    expect(t.supervisor.roster(t.token(1))).toEqual([entry('greet-1'), entry('greet-3')]);
    expect(t.supervisor.roster(t.token(0))).toEqual([entry('greet-2'), entry('greet-3')]);
    expect(t.supervisor.roster(t.token(3))).toEqual([]);
    t.runtime.onStart = () => undefined;
    const launching = t.supervisor.launchNew('greeter', t.main, t.quiet).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(t.runtime.starts).toHaveLength(5);
    });
    expect(() => t.supervisor.roster(t.token(4))).toThrow(
      new AgentRequestInvalid('connect to the channel before using it'),
    );
    await t.supervisor.stopAll('test done');
    await launching;
  });

  it("telemetryAgents, agentsOn and hasAgentsOn: a channel's agents, each with its recipe, team and model", async () => {
    const t = await setup();
    expect([t.supervisor.agentsOn('main'), t.supervisor.hasAgentsOn('main')]).toEqual([[], false]);
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    expect(t.supervisor.telemetryAgents(t.main)).toEqual([
      { handle: 'greet-1', recipe: 'greeter', team: null, model: 'tiny-model' },
      { handle: 'greet-2', recipe: 'greeter', team: null, model: 'tiny-model' },
    ]);
    expect(t.supervisor.telemetryAgents(t.channels.get('other'))).toEqual([]);
    expect([
      t.supervisor.agentsOn('main'),
      t.supervisor.hasAgentsOn('main'),
      t.supervisor.hasAgentsOn('other'),
    ]).toEqual([['greet-1', 'greet-2'], true, false]);
  });

  it('busy: false with no agent, true while one is on, false again once every agent is stopped (idle-shutdown R3)', async () => {
    const t = await setup();
    expect(t.supervisor.busy()).toBe(false);
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    expect(t.supervisor.busy()).toBe(true);
    await t.supervisor.stopAll('test done');
    expect(t.supervisor.busy()).toBe(false);
  });

  it("heldConversation: the conversation of a delivery the agent holds; another's delivery refused; refused before it announces", async () => {
    const t = await setup();
    t.connectOnStart();
    await t.supervisor.launchNew('greeter', t.main, t.quiet);
    const input = t.main.postToConversation({ from: 'user-1', kind: 'input', text: 'hi' });
    const held = present(t.inbox[0], 'the delivery');
    expect(t.supervisor.heldConversation(t.token(), held.deliveryId)).toBe(input.conversation);
    expect(() => t.supervisor.heldConversation(t.token(), 'no-such-delivery')).toThrow(
      'greet-1 holds no delivery no-such-delivery',
    );
    // A container that connects and never announces.
    t.runtime.onStart = (spec) => {
      queueMicrotask(() => {
        t.supervisor.connect(present(spec.env['ASHA_AGENT_TOKEN'], 'its token'), 'greet', () => undefined);
      });
    };
    const launching = t.supervisor.launchNew('greeter', t.main, t.quiet).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(t.main.isMember('greet-2')).toBe(true);
    });
    expect(() => t.supervisor.heldConversation(t.token(1), held.deliveryId)).toThrow(
      new AgentRequestInvalid('announce yourself with a status message first'),
    );
    await t.supervisor.stopAll('test done');
    await launching;
  });
});

describe('an embedding request, checked (parseEmbedRequest)', () => {
  it('is its texts and purpose; anything else is refused, naming what is wrong', () => {
    expect(parseEmbedRequest({ texts: ['a', 'b'], purpose: 'query' })).toEqual({ texts: ['a', 'b'], purpose: 'query' });
    expect(parseEmbedRequest({ texts: ['a'], purpose: 'document' })).toEqual({ texts: ['a'], purpose: 'document' });
    const refused = (body: unknown): string => {
      try {
        parseEmbedRequest(body);
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRequestInvalid);
        return (error as Error).message;
      }
      throw new Error(`accepted ${JSON.stringify(body)}`);
    };
    const texts = `texts must be 1..${String(MAX_EMBED_TEXTS)} non-empty strings`;
    expect([
      refused(null),
      refused('a'),
      refused({ texts: ['a'], purpose: 'query', model: 'x', other: 1 }),
      refused({ texts: 'a', purpose: 'query' }),
      refused({ texts: [], purpose: 'query' }),
      refused({ texts: Array.from({ length: MAX_EMBED_TEXTS + 1 }, () => 'a'), purpose: 'query' }),
      refused({ texts: ['a', ''], purpose: 'query' }),
      refused({ texts: ['a', 1], purpose: 'query' }),
      refused({ texts: ['a'] }),
      refused({ texts: ['a'], purpose: 'search' }),
    ]).toEqual([
      'embed body must be an object',
      'embed body must be an object',
      'unknown embed field(s): model, other',
      texts,
      texts,
      texts,
      texts,
      texts,
      'purpose must be "query" or "document"',
      'purpose must be "query" or "document"',
    ]);
    expect(
      parseEmbedRequest({ texts: Array.from({ length: MAX_EMBED_TEXTS }, () => 'a'), purpose: 'query' }).texts,
    ).toHaveLength(MAX_EMBED_TEXTS);
  });
});
