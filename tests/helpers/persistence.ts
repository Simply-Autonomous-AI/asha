// A supervisor with persisted agents, for the model-free tests of docs/plans/agent-persistence.md: a fixture repo
// holding a recipe that persists memory and /workspace on an image declaring keepsMemory, eraseUser and a state
// schema, and teams persisting their board; FakeRuntime as the containers, each "agent" driven by the test through
// the supervisor's agent API; and the real state store, on a real or an in-memory filesystem. A "restart" is a new
// supervisor and channels on the same store, with a later daemonStartedAt.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelFileSpaces } from '../../src/daemon/files/index.js';
import { AgentSupervisor, type OnlineAgent, type OnlineSink, type TeamSink } from '../../src/daemon/agents/index.js';
import { Channels, type Channel } from '../../src/daemon/channel/index.js';
import { Definitions } from '../../src/daemon/definitions/index.js';
import {
  StateStore,
  TAR_BLOCK,
  nodeStateFs,
  tarDirectory,
  tarFile,
  type StateFs,
} from '../../src/daemon/state/index.js';
import { DaemonTracer } from '../../src/daemon/traces/index.js';
import { present } from '../../src/shared/assert-present.js';
import type {
  ChannelMessage,
  ConversationEvent,
  ConversationMessage,
  Delivery,
  OnlinePhase,
  ResumedFrom,
} from '../../src/shared/protocol.js';
import { FIXTURE_RECIPE, FakeModelServer, FakeRuntime, FakeStore, fixtureRoot } from './daemon-fakes.js';
import { FakeFetch, MemoryUserLedger, RecordingLogger } from './fakes.js';
import { testModules } from './modules.js';

/** The image a persisted memory recipe needs (R1, R12). */
export const KEEPER_MANIFEST = { tools: [], keepsMemory: true, eraseUser: true, stateSchema: 1 };
/**
 * A recipe persisting both of an agent's assets, launched alone: its identity is `<channel>/-/keeper`. Its delivery
 * bound is 120 s, as recipes/memory.json's: longer than R10's 65 s ack wait, so a stop's wait is never cut short by it.
 */
export const KEEPER = {
  ...FIXTURE_RECIPE,
  id: 'keeper',
  image: 'keeper-image',
  description: 'Keeps things.',
  persist: ['memory', 'workspace'],
  messageTimeoutMs: 120_000,
};

/** A snapshot tar of one asset, as docker cp gives it: its directory, then each file. */
export function assetTar(root: 'memory' | 'workspace', files: Record<string, string>): Buffer {
  const parts = [tarDirectory(root, 1)];
  const dirs = new Set<string>();
  for (const [name, content] of Object.entries(files)) {
    const segments = name.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      const dir = `${root}/${segments.slice(0, i).join('/')}`;
      if (!dirs.has(dir)) {
        dirs.add(dir);
        parts.push(tarDirectory(dir, 1));
      }
    }
    parts.push(tarFile(`${root}/${name}`, Buffer.from(content), 1));
  }
  parts.push(Buffer.alloc(2 * TAR_BLOCK));
  return Buffer.concat(parts);
}

/** A fixture repo root with the greeter recipe, the keeper recipe and image, and teams: `pair` (two keepers, persisting the board) and `plain`. */
export async function persistenceRoot(extra: Record<string, string> = {}): Promise<string> {
  const root = await fixtureRoot();
  const member = (id: string, persist: string[]) => JSON.stringify({ ...KEEPER, id, persist });
  const files: Record<string, string> = {
    'images/keeper-image/Dockerfile': 'FROM scratch\n',
    'images/keeper-image/image.json': JSON.stringify(KEEPER_MANIFEST),
    'dist/images/keeper-image/src/main.js': '// agent\n',
    'recipes/keeper.json': JSON.stringify(KEEPER),
    'teams/pair/team.json': JSON.stringify({
      id: 'pair',
      description: 'Two keepers.',
      persist: ['board'],
      members: [
        { name: 'ann', recipe: 'ann.json' },
        { name: 'bea', recipe: 'bea.json' },
      ],
    }),
    'teams/pair/ann.json': member('ann', ['memory', 'workspace']),
    'teams/pair/bea.json': member('bea', ['workspace']),
    'teams/solo/team.json': JSON.stringify({
      id: 'solo',
      description: 'One keeper.',
      persist: ['board'],
      members: [{ name: 'kim', recipe: 'kim.json' }],
    }),
    'teams/solo/kim.json': member('kim', ['memory', 'workspace']),
    'teams/plain/team.json': JSON.stringify({
      id: 'plain',
      description: 'Nothing kept.',
      members: [{ name: 'pat', recipe: 'pat.json' }],
    }),
    'teams/plain/pat.json': JSON.stringify({ ...FIXTURE_RECIPE, id: 'pat' }),
    // A persisted member beside one that persists nothing, on a channel whose board is kept (A8a case 7).
    'teams/mixed/team.json': JSON.stringify({
      id: 'mixed',
      description: 'One keeper, one not.',
      persist: ['board'],
      members: [
        { name: 'lee', recipe: 'lee.json' },
        { name: 'pat', recipe: 'pat.json' },
      ],
    }),
    'teams/mixed/lee.json': member('lee', ['memory', 'workspace']),
    // pat's deliveries are left unacknowledged across a test's own steps, so its bound is one no test reaches, as the
    // keeper's is: with FIXTURE_RECIPE's 2 s, a test slowed past 2 s by a loaded Mac saw pat stopped and its
    // conversation settled under it (the code review's round 3 on demo-scene-refresh, R3-RELIABILITY-001).
    'teams/mixed/pat.json': JSON.stringify({ ...FIXTURE_RECIPE, id: 'pat', messageTimeoutMs: KEEPER.messageTimeoutMs }),
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

export interface Harness {
  readonly root: string;
  readonly home: string;
  readonly logger: RecordingLogger;
  readonly runtime: FakeRuntime;
  readonly state: StateStore;
  readonly supervisor: AgentSupervisor;
  /** The channel file spaces over the fake runtime (docs/plans/agent-files.md). */
  readonly files: ChannelFileSpaces;
  readonly channels: Channels;
  readonly main: Channel;
  /** Each container's deliveries, by container name. */
  readonly inbox: Map<string, Delivery[]>;
  /** Each container's token, by name. */
  readonly tokens: Map<string, string>;
  /** Every sink report: phases, announcements (with resumed), resent conversations. */
  readonly reports: string[];
  readonly sink: OnlineSink;
  readonly teamSink: TeamSink;
  /** Events of every conversation watched with watch(). */
  readonly events: ConversationEvent[];
  watch(conversation: string): void;
  /** The container of the n-th start. */
  container(i?: number): string;
  /** Acks the delivery `delivery` as the agent in `container` does. */
  ack(container: string, delivery: Delivery): void;
  /** A user's input, from an online user, on `channel` (main by default). */
  input(text: string, user?: string, to?: string): ConversationMessage;
}

export interface HarnessOptions {
  readonly root?: string;
  readonly home?: string;
  readonly fs?: StateFs;
  readonly daemonStartedAt?: string;
  /** The runtime (a restart keeps the fake's contents in a test that wants it). */
  readonly runtime?: FakeRuntime;
  readonly clock?: () => Date;
  /** The base name each container connects under: the recipe's image asks for it. */
  readonly base?: string;
  /** Connect and announce each container as it starts (default true). */
  readonly autoConnect?: boolean;
  /** The file spaces' run id (a restart draws another, as the daemon does). */
  readonly runId?: string;
  /** The prefix of every id the channels mint (`id` by default): a restart's harness gives another, so two runs' ids differ, as the daemon's random ones do. */
  readonly idPrefix?: string;
}

/** A supervisor with persisted agents; see the file's comment. */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.root ?? (await persistenceRoot());
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'asha-persist-')));
  const logger = new RecordingLogger();
  const runtime = options.runtime ?? new FakeRuntime();
  const clock = options.clock ?? (() => new Date());
  let n = 0;
  const tracer = new DaemonTracer({
    clock,
    newSpanId: () => (++n).toString(16).padStart(16, '0'),
    record: () => undefined,
  });
  const state = new StateStore({
    dir: join(home, 'state'),
    fs: options.fs ?? nodeStateFs,
    logger,
    clock,
    insideGitTree: () => Promise.resolve(false),
  });
  const files = new ChannelFileSpaces({
    runtime,
    logger,
    homeId: 'abcd1234',
    runId: options.runId ?? '0123abcd',
    clock,
    ownSecrets: () => [],
  });
  // Built before `channels` (which only needs it inside a callback fired well after this function returns) so it
  // can be a `const`, never reassigned, rather than a `let` declared ahead of its one assignment.
  const supervisor = new AgentSupervisor({
    definitions: new Definitions(root),
    store: new FakeStore(),
    modelServer: new FakeModelServer('http://127.0.0.1:9'),
    runtime,
    logger,
    fetch: new FakeFetch(() => new Response('{}')).fetch,
    root,
    stagingDir: join(home, 'staging'),
    agentLogsDir: join(home, 'logs', 'agents'),
    daemonPort: () => 4321,
    chatTimeoutMs: 1_000,
    tracer,
    clock,
    state,
    daemonStartedAt: options.daemonStartedAt ?? new Date().toISOString(),
    files,
    modules: testModules({ runtime, files, home, logger }),
    userHome: home,
    ashaHome: home,
  });
  let ids = 0;
  const channels = new Channels({
    logger,
    clock,
    newId: () => `${options.idPrefix ?? 'id'}${(++ids).toString().padStart(4, '0')}`,
    onDeliveryTimeout: (channel, handle) =>
      void supervisor.stopHandle(channel, handle, 'held a delivery past its bound'),
    maxAgentPostsPerConversation: 32,
    users: new MemoryUserLedger(),
    tracer,
  });
  const inbox = new Map<string, Delivery[]>();
  const tokens = new Map<string, string>();
  const reports: string[] = [];
  const events: ConversationEvent[] = [];
  if (options.autoConnect !== false) {
    runtime.onStart = (spec) => {
      queueMicrotask(() => {
        const token = present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var');
        tokens.set(spec.name, token);
        inbox.set(spec.name, []);
        supervisor.connect(token, options.base ?? 'keep', (d) =>
          present(inbox.get(spec.name), `the inbox entry for ${spec.name}`).push(d),
        );
        supervisor.post(token, { kind: 'status', text: 'Hi' });
      });
    };
  }
  const main = channels.get('main');
  const sink: OnlineSink = {
    phase: (phase: OnlinePhase, detail: string) => reports.push(`phase ${phase} ${detail}`),
    announced: (message: ChannelMessage, resumed?: ResumedFrom) => {
      const resumedPart = resumed === undefined ? '' : ` resumed ${resumed.savedAt} ${resumed.previousHandle}`;
      reports.push(`announced ${message.from}${resumedPart}`);
    },
    resent: (conversation: string, savedAt: string) => reports.push(`resent ${conversation} ${savedAt}`),
  };
  const teamSink: TeamSink = {
    ...sink,
    member: (name: string, recipe: string) => reports.push(`member ${name} ${recipe}`),
    launched: (agent: OnlineAgent) => reports.push(`launched ${agent.handle}`),
    teamLaunched: (agents: readonly OnlineAgent[]) =>
      reports.push(`team launched ${agents.map((a) => a.handle).join(' ')}`),
  };
  return {
    root,
    home,
    logger,
    runtime,
    state,
    supervisor,
    files,
    channels,
    main,
    inbox,
    tokens,
    reports,
    sink,
    teamSink,
    events,
    watch: (conversation) => {
      main.watch(conversation, (e) => events.push(e));
    },
    container: (i = 0) => present(runtime.starts[i], `runtime.starts[${String(i)}]`).name,
    ack: (container, delivery) => {
      supervisor.ack(present(tokens.get(container), `the token for ${container}`), delivery.deliveryId);
    },
    input: (text, user = 'ivy', to) => {
      const claimed = main.claimUser(user);
      return main.postToConversation({ from: claimed.id, kind: 'input', text, ...(to === undefined ? {} : { to }) });
    },
  };
}

/**
 * Waits, in event-loop turns, until `check` passes, and fails with its last error after `ms` of real time: the
 * bound on a positive expectation over a real filesystem's writes, whatever the machine's load (setImmediate and
 * performance.now, which the fake-timer tests leave real).
 */
export async function until(check: () => void | Promise<void>, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (performance.now() > end) throw error;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Lets the work in flight finish: a real filesystem's writes and fsyncs, a fake agent's connect. Waits `ms` of real
 * time in event-loop turns, so what a test then asserts has not happened had every chance to. It proves nothing
 * positive: a test first waits with until() for a state that makes the absence certain (a held copy, a record
 * written), then settles.
 */
export async function settle(ms = 60): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) await new Promise((resolve) => setImmediate(resolve));
}
