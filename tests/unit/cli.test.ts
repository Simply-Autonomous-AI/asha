import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConversationTracker,
  DeltaPrinter,
  EXIT,
  LifetimeEnvInvalid,
  PORTAL_OPEN_MS,
  USAGE,
  autoStartEnv,
  formatWatchEvent,
  lifetimeFrom,
  parseConversationArgs,
  parseDaemonFile,
  parseInteractiveArgs,
  runCli,
  scrubControl,
  type CliContext,
} from '../../src/cli/commands.js';
import type { StartDaemonProps } from '../../src/daemon/compose.js';
import { PROMPT, readLines } from '../../src/cli/interactive.js';
import {
  AGENT_FAILURE_STATUS,
  Routes,
  USER_ID_REASONS,
  isHarnessStatus,
  launchFailedStatus,
  launchingStatus,
  resentStatus,
  restartFailedStatus,
  restartingStatus,
  restartLimitStatus,
} from '../../src/shared/protocol.js';
import type {
  ConversationEvent,
  ConversationMessage,
  ConversationRequest,
  LaunchEvent,
  PresenceMessage,
  WatchEvent,
} from '../../src/shared/protocol.js';
import type { ShutdownSignal } from '../../src/cli/signals.js';
import { writePrivateFile } from '../../src/daemon/private-file/index.js';
import { present } from '../../src/shared/assert-present.js';
import { FakeFetch, NOT_INTERACTIVE, NO_PORTAL, json } from '../helpers/fakes.js';
import { SSE_HEARTBEAT, sseEvent } from '../../src/shared/sse.js';

const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: 'm1',
  channel: 'main',
  conversation: 'm1',
  user: 'user-1',
  from: 'user-1',
  to: null,
  kind: 'input',
  text: 'hi',
  at: '2026-09-26T00:00:00.000Z',
  ...over,
});

const presence = (from: string, text: string, over: Partial<PresenceMessage> = {}): PresenceMessage => ({
  id: 'p1',
  channel: 'main',
  conversation: null,
  from,
  to: null,
  kind: 'status',
  text,
  at: '2026-09-26T00:00:00.000Z',
  ...over,
});

/** A daemon of this CLI's own build. */
const SAME_BUILD = { sameBuild: true, deltas: null } as const;

/** How the daemon writes an event on a control stream (model-streaming R5): the old `heartbeat` event is the comment. */
function wire(event: unknown): string {
  return (event as { type?: unknown }).type === 'heartbeat' ? SSE_HEARTBEAT : sseEvent(event as { type: string });
}

/** A 200 event stream, as every streaming control route answers. */
const SSE_OK = { status: 200, headers: { 'content-type': 'text/event-stream' } } as const;

function output() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
    progress: (t: string) => err.push(t),
  };
}

async function context(over: Partial<CliContext> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'asha-cli-'));
  const io = output();
  const spawned: string[] = [];
  const killed: [number, string][] = [];
  const ctx: CliContext = {
    env: { ASHA_HOME: home },
    stdout: io.stdout,
    stderr: io.stderr,
    fetch: new FakeFetch(() => {
      throw new TypeError('connect ECONNREFUSED');
    }).fetch,
    root: '/repo',
    version: '9.9.9',
    build: 'cli-build-01',
    pid: 111,
    startDaemon: () => Promise.reject(new Error('startDaemon not expected')),
    createLogger: () => {
      throw new Error('createLogger not expected');
    },
    dependencies: () => {
      throw new Error('dependencies not expected');
    },
    shutdownSignals: () => () => undefined,
    spawnServer: (paths) => {
      spawned.push(paths.home);
      return Promise.resolve(222);
    },
    kill: (pid, signal) => killed.push([pid, signal]),
    isAlive: () => true,
    sleep: () => Promise.resolve(),
    // No process holds any pid a test names: a stopping lookup finds no asha daemon (debt-paydown R15).
    processCommand: () => Promise.resolve(null),
    timing: {
      serverStartMs: 200,
      serverStopMs: 200,
      streamIdleMs: 200,
      pollMs: 1,
      uploadAnswerMs: 260_000,
      downloadIdleMs: 30_000,
    },
    ...NOT_INTERACTIVE,
    ...NO_PORTAL,
    // A login name the conversion leaves unchanged: no ID line (cli-interactive R16).
    loginName: () => 'olga',
    // The folder asha runs in, and the home ~/ names: the test's temporary home (agent-files R1, R12a).
    cwd: () => home,
    homeDir: () => home,
    ...over,
  };
  return { ctx, home, io, spawned, killed };
}

/** Input lines for --interactive, keeping CliInput's contract (return() ends a pending read); records every read. */
function fromLines(lines: readonly string[]) {
  let index = 0;
  const record = { reads: 0, returned: false };
  const iterable = {
    record,
    [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
      next: () => {
        record.reads += 1;
        if (record.returned || index >= lines.length) return Promise.resolve({ done: true, value: undefined });
        const i = index;
        index += 1;
        return Promise.resolve({ done: false, value: present(lines[i], `lines[${String(i)}]`) });
      },
      return: () => {
        record.returned = true;
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };
  return iterable;
}

/** The control credential the test daemon.json carries. */
const CREDENTIAL = 'c'.repeat(64);

async function writeDaemonFile(
  home: string,
  port: number,
  content: unknown = { pid: 222, port, credential: CREDENTIAL },
) {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'daemon.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

/** The Authorization header a recorded request carried, or null. */
const authorization = (request: { init: RequestInit | undefined }) =>
  new Headers(request.init?.headers).get('authorization');

/** A recorded request's body text, as fetch's `init.body` always carries it in these tests: JSON, as a string. */
function bodyOf(request: { init: RequestInit | undefined }): string {
  return present(request.init, 'request.init').body as string;
}

/** The last of `requests`, which must exist. */
function lastRequest<T extends { url: string }>(requests: readonly T[]): T {
  return present(requests.at(-1), 'requests.at(-1)');
}

/** A 200 stream that sends one line, then fails as fetch does when the daemon's socket closes mid-body. */
function cutStream(line: string): Response {
  const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(line));
        } else controller.error(new TypeError('terminated', { cause: socketError }));
      },
    }),
    SSE_OK,
  );
}

/** A fake daemon's conversation stream, as server-sent events (model-streaming R5). */
function ndjson(events: ConversationEvent[]): Response {
  return new Response(events.map((e) => wire(e)).join(''), SSE_OK);
}

/** A daemon of the same build as the test CLI context (build 'cli-build-01'). */
const health = {
  ok: true,
  pid: 222,
  version: '9.9.9',
  build: 'cli-build-01',
  startedAt: '2026-09-27T01:47:24.000Z',
  agents: [{ handle: 'hewo-1', channel: 'main', recipe: 'hello-world', image: 'hello-world' }],
};

describe('parseConversationArgs', () => {
  it('reads recipe= and message= on the default channel, keeping = and spaces inside the message', () => {
    expect(parseConversationArgs(['recipe=hello-world', 'message=a = b, c'])).toEqual({
      channel: 'main',
      recipe: 'hello-world',
      message: 'a = b, c',
    });
  });

  it('reads user= when given', () => {
    expect(parseConversationArgs(['user=alice', 'message=x'])).toEqual({
      user: 'alice',
      channel: 'main',
      message: 'x',
    });
  });

  it('reads channel= and to=, and needs no recipe', () => {
    expect(parseConversationArgs(['to=hewo-1', 'channel=lab', 'message=x'])).toEqual({
      channel: 'lab',
      to: 'hewo-1',
      message: 'x',
    });
    expect(parseConversationArgs(['message=x'])).toEqual({ channel: 'main', message: 'x' });
  });

  it.each([
    [[], 'nothing to do'],
    [['recipe=r'], 'missing message='],
    [['to=', 'message=m'], 'to= is empty'],
    [['recipe=r', 'recipe=s', 'message=m'], 'recipe= given twice'],
    [['recipe=', 'message=m'], 'recipe= is empty'],
    [['image=x', 'recipe=r', 'message=m'], 'unrecognized argument: image=x'],
    [['--serve'], 'unrecognized argument: --serve'],
    [['=x'], 'unrecognized argument: =x'],
  ])('rejects %j', (argv, error) => {
    expect(parseConversationArgs(argv)).toBe(error);
  });
});

describe("a message's budget: posts= and tokens= (patterns-phase-3 R15, A10)", () => {
  it("reads posts= and tokens= into the request's budget, each at its extremes", () => {
    expect(parseConversationArgs(['to=ping-1', 'posts=8', 'message=Start.'])).toEqual({
      channel: 'main',
      to: 'ping-1',
      message: 'Start.',
      budget: { posts: 8 },
    });
    expect(parseConversationArgs(['tokens=6000', 'message=x'])).toEqual({
      channel: 'main',
      message: 'x',
      budget: { tokens: 6000 },
    });
    expect(parseConversationArgs(['posts=1', 'tokens=1', 'message=x'])).toEqual({
      channel: 'main',
      message: 'x',
      budget: { posts: 1, tokens: 1 },
    });
    expect(parseConversationArgs(['posts=32', 'tokens=1000000', 'message=x'])).toEqual({
      channel: 'main',
      message: 'x',
      budget: { posts: 32, tokens: 1_000_000 },
    });
    expect(parseConversationArgs(['message=x'])).toEqual({ channel: 'main', message: 'x' });
  });

  it.each([
    [['posts=0', 'message=x'], 'posts= is a whole number from 1 to 32, not 0'],
    [['posts=33', 'message=x'], 'posts= is a whole number from 1 to 32, not 33'],
    [['tokens=0', 'message=x'], 'tokens= is a whole number from 1 to 1,000,000, not 0'],
    [['tokens=1000001', 'message=x'], 'tokens= is a whole number from 1 to 1,000,000, not 1000001'],
    [['posts=1.5', 'message=x'], 'posts= is a whole number from 1 to 32, not 1.5'],
    [['posts=08', 'message=x'], 'posts= is a whole number from 1 to 32, not 08'],
    [['tokens=6e3', 'message=x'], 'tokens= is a whole number from 1 to 1,000,000, not 6e3'],
    [['posts=8', 'posts=9', 'message=x'], 'posts= given twice'],
  ])('refuses %j', (argv, error) => {
    expect(parseConversationArgs(argv)).toBe(error);
  });

  it('a refused budget is a usage error, exit 2, contacting no daemon', async () => {
    const f = new FakeFetch(() => {
      throw new Error('fetch not expected');
    });
    const { ctx, io } = await context({ fetch: f.fetch });
    expect(await runCli(['user=alice', 'posts=0', 'message=x'], ctx)).toBe(EXIT.usage);
    expect(io.err).toEqual([`posts= is a whole number from 1 to 32, not 0\n\n${USAGE}`]);
    expect(f.requests).toEqual([]);
  });

  it.each([
    [
      ['--interactive', 'posts=8'],
      `--interactive takes no posts=: a budget is one message's (asha posts=<n> message=…)`,
    ],
    [
      ['--interactive', 'tokens=6000'],
      `--interactive takes no tokens=: a budget is one message's (asha tokens=<n> message=…)`,
    ],
    [
      ['--launch', 'team=budget', 'posts=8'],
      '--launch takes recipe=<recipe> or team=<team>, and optionally channel=<name>',
    ],
  ])('%j is a usage error, exit 2', async (argv, error) => {
    const f = new FakeFetch(() => {
      throw new Error('fetch not expected');
    });
    const { ctx, io } = await context({ fetch: f.fetch });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(io.err).toEqual([`${error}\n\n${USAGE}`]);
    expect(f.requests).toEqual([]);
  });
});

describe('ConversationTracker', () => {
  it('settles with success once a reply arrived and nobody is working', () => {
    const io = output();
    const t = new ConversationTracker(io, SAME_BUILD);
    expect(t.handle({ type: 'phase', phase: 'agent', detail: 'hewo-1 online' })).toBeUndefined();
    expect(
      t.handle({ type: 'posted', message: msg({ text: 'Please say: Hello World.' }), working: ['hewo-1'] }),
    ).toBeUndefined();
    const reply = msg({ id: 'm2', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hello World!' });
    expect(t.handle({ type: 'message', message: reply, working: ['hewo-1'] })).toBeUndefined();
    expect(t.handle({ type: 'status', conversation: 'c1', working: [] })).toBe(EXIT.ok);

    expect(io.out).toEqual(['Hello World!\n']);
    expect(io.err).toEqual([
      '› agent: hewo-1 online\n',
      '› user-1 → main: Please say: Hello World.\n',
      '› output hewo-1 → user-1:\n',
    ]);
  });

  it("prints an agent's announcement and its status messages as the agent speaking", () => {
    const io = output();
    const t = new ConversationTracker(io, SAME_BUILD);
    const online = presence('hewo-1', 'Hi');
    expect(t.handle({ type: 'announced', message: online })).toBeUndefined();
    t.handle({ type: 'posted', message: msg({}), working: ['hewo-1'] });
    expect(
      t.handle({
        type: 'message',
        message: msg({ id: 'm2', from: 'hewo-1', kind: 'status', text: 'ok' }),
        working: ['hewo-1'],
      }),
    ).toBeUndefined();
    expect(io.err).toEqual(['› hewo-1: Hi\n', '› user-1 → main: hi\n', '› hewo-1: ok\n']);
    expect(io.out).toEqual([]);
  });

  it('shows an addressed input with its recipient', () => {
    const io = output();
    new ConversationTracker(io, SAME_BUILD).handle({
      type: 'posted',
      message: msg({ to: 'hewo-2', text: 'a\nb' }),
      working: ['hewo-2'],
    });
    expect(io.err).toEqual(['› user-1 → hewo-2 on main: a\n    b\n']);
  });

  it("prints the harness's no-reply answer like a reply, but it is not one: the command fails", () => {
    const io = output();
    const t = new ConversationTracker(io, SAME_BUILD);
    t.handle({ type: 'posted', message: msg({ text: 'translate this' }), working: ['hewo-1'] });
    t.handle({
      type: 'message',
      message: msg({ id: 'm2', from: 'hewo-1', kind: 'status', text: 'pass: not my role' }),
      working: ['hewo-1'],
    });
    const answer = msg({
      id: 'm3',
      from: 'asha',
      to: 'user-1',
      kind: 'output',
      text: 'No agent could answer this:\n- hewo-1 passed: not my role',
    });
    expect(t.handle({ type: 'message', message: answer, working: [] })).toBe(EXIT.failed);

    expect(io.out).toEqual(['No agent could answer this:\n- hewo-1 passed: not my role\n']);
    expect(io.err).toEqual([
      '› user-1 → main: translate this\n',
      '› hewo-1: pass: not my role\n',
      '› output asha → user-1:\n',
    ]);
  });

  it('waits while any agent still works, even after a reply', () => {
    const t = new ConversationTracker(output(), SAME_BUILD);
    t.handle({ type: 'posted', message: msg({}), working: ['a', 'b'] });
    t.handle({ type: 'message', message: msg({ id: 'm2', from: 'a', kind: 'output' }), working: ['a', 'b'] });
    expect(t.handle({ type: 'status', conversation: 'c1', working: ['b'] })).toBeUndefined();
    expect(t.handle({ type: 'status', conversation: 'c1', working: [] })).toBe(EXIT.ok);
  });

  it('prints internal messages as progress, not as replies', () => {
    const io = output();
    const t = new ConversationTracker(io, SAME_BUILD);
    t.handle({ type: 'posted', message: msg({}), working: ['a'] });
    t.handle({
      type: 'message',
      message: msg({ id: 'm2', from: 'a', kind: 'internal', text: 'b, take half' }),
      working: ['a', 'b'],
    });
    expect(io.out).toEqual([]);
    expect(io.err.at(-1)).toBe('› internal a → all agents: b, take half\n');
    t.handle({
      type: 'message',
      message: msg({ id: 'm3', from: 'a', to: 'b', kind: 'internal', text: 'only you' }),
      working: ['b'],
    });
    expect(io.err.at(-1)).toBe('› internal a → b: only you\n');
  });

  // A conversation that ends with no reply at all has three causes the stream can tell apart. Before 2026-09-27
  // every one was reported as "the daemon is likely an older build" — including a message sent after the
  // channel's only agent had crashed, the commonest of the three.
  it("blames the daemon's build for a conversation that ends with no reply at all only when the daemon runs another build", () => {
    const io = output();
    const t = new ConversationTracker(io, { sameBuild: false, deltas: null });
    t.handle({ type: 'posted', message: msg({}), working: ['a'] });
    expect(t.handle({ type: 'status', conversation: 'c1', working: [] })).toBe(EXIT.failed);
    expect(io.err.at(-1)).toBe(
      "✗ the conversation ended with no reply at all, not even the harness's: the daemon runs a different build than this asha (see asha --status)\n",
    );
  });

  it('calls a conversation that ends with no reply at all from a daemon of this build a daemon defect', () => {
    const io = output();
    const t = new ConversationTracker(io, SAME_BUILD);
    t.handle({ type: 'posted', message: msg({}), working: ['a'] });
    expect(t.handle({ type: 'status', conversation: 'c1', working: [] })).toBe(EXIT.failed);
    expect(io.err.at(-1)).toBe(
      "✗ the conversation ended with no reply at all, not even the harness's: a defect in the daemon; see its log\n",
    );
  });

  it('names the agent that left, and why, when the conversation ends with no reply after it left', () => {
    const io = output();
    const t = new ConversationTracker(io, { sameBuild: false, deltas: null });
    t.handle({ type: 'posted', message: msg({}), working: ['a', 'b'] });
    t.handle({
      type: 'agent_left',
      conversation: 'c1',
      agent: 'a',
      detail: 'container exited with code 1',
      working: ['b'],
    });
    expect(t.handle({ type: 'agent_left', conversation: 'c1', agent: 'b', detail: 'stopped', working: [] })).toBe(
      EXIT.failed,
    );
    expect(io.err.at(-1)).toBe(
      "✗ the conversation ended with no reply at all, not even the harness's: a left the channel (container exited with code 1); b left the channel (stopped); the daemon runs a different build than this asha (see asha --status)\n",
    );
  });

  // The owner's decision, 2026-09-26 (docs/architecture/channel.md#no-reply): the harness's reply is printed as a
  // reply and the command exits 1 with no extra ✗ line. That holds for a message no agent received, too.
  it("waits for the harness's reply when no agent received the message, prints it, and exits 1 with no ✗ line", () => {
    const io = output();
    const t = new ConversationTracker(io, { sameBuild: false, deltas: null });
    expect(t.handle({ type: 'posted', message: msg({ channel: 'solo' }), working: [] })).toBeUndefined();
    const answer = msg({
      id: 'm2',
      channel: 'solo',
      from: 'asha',
      to: 'user-1',
      kind: 'output',
      text: 'No agent on channel "solo" received this, so nobody could answer it.',
    });
    expect(t.handle({ type: 'message', message: answer, working: [] })).toBe(EXIT.failed);
    expect(io.out).toEqual(['No agent on channel "solo" received this, so nobody could answer it.\n']);
    expect(io.err).toEqual(['› user-1 → solo: hi\n', '› output asha → user-1:\n']);
  });

  it('reports an agent leaving and settles on the working set it carries', () => {
    const io = output();
    const t = new ConversationTracker(io, SAME_BUILD);
    t.handle({ type: 'posted', message: msg({}), working: ['a'] });
    expect(
      t.handle({
        type: 'agent_left',
        conversation: 'c1',
        agent: 'a',
        detail: 'container exited with code 1',
        working: [],
      }),
    ).toBe(EXIT.failed);
    expect(io.err).toContain('› a left the channel: container exited with code 1\n');
  });

  it('fails on an error event', () => {
    const io = output();
    expect(
      new ConversationTracker(io, SAME_BUILD).handle({
        type: 'error',
        reason: 'unknown_recipe',
        detail: 'no recipe named "x"',
      }),
    ).toBe(EXIT.failed);
    expect(io.err).toEqual(['✗ unknown_recipe: no recipe named "x"\n']);
  });
});

describe('formatWatchEvent', () => {
  it('prints a message with its UTC time, sender, kind and conversation, indenting extra lines', () => {
    const m = msg({
      id: 'm2',
      conversation: '2e3673d76fd7f3a2',
      from: 'hewo-1',
      to: 'user-1',
      kind: 'output',
      text: 'line one\nline two',
      at: '2026-09-26T23:30:01.123Z',
    });
    expect(formatWatchEvent({ type: 'message', message: m })).toBe(
      '23:30:01Z [2e3673d7] output hewo-1 → user-1: line one\n    line two\n',
    );
  });
  it('prints status messages, with dashes for a status that belongs to no conversation', () => {
    const working = msg({
      conversation: '2e3673d76fd7f3a2',
      from: 'hewo-1',
      kind: 'status',
      text: 'ok',
      at: '2026-09-26T23:30:01.123Z',
    });
    expect(formatWatchEvent({ type: 'message', message: working })).toBe('23:30:01Z [2e3673d7] status hewo-1: ok\n');
    const online = presence('hewo-2', 'Hi', { at: '2026-09-26T23:30:01.123Z' });
    expect(formatWatchEvent({ type: 'message', message: online })).toBe('23:30:01Z [--------] status hewo-2: Hi\n');
  });

  it("prints the harness's failure status for an agent as its status, and the launcher's (demo-scene-refresh R7, R14)", () => {
    const failed = presence('worker-1', AGENT_FAILURE_STATUS, { at: '2026-10-16T12:00:01.123Z', failure: true });
    expect(formatWatchEvent({ type: 'message', message: failed })).toBe(
      '12:00:01Z [--------] status worker-1: system failure — offline\n',
    );
    const launching = presence('lead-1', launchingStatus('helper'), { at: '2026-10-16T12:00:02.000Z' });
    expect(formatWatchEvent({ type: 'message', message: launching })).toBe(
      '12:00:02Z [--------] status lead-1: launching a new helper agent\n',
    );
    expect(launchFailedStatus('helper', 'launch_failed')).toBe('could not launch a helper agent: launch_failed');
  });

  it("reserves every status the harness's builders make, and no status an agent's SDK posts (the code review's round 2)", () => {
    for (const text of [
      AGENT_FAILURE_STATUS,
      launchingStatus('helper'),
      launchFailedStatus('helper', 'abandoned'),
      restartingStatus(1, 2, 60_000),
      restartFailedStatus(2, 'it did not come online in time'),
      restartLimitStatus(2, 60_000),
      resentStatus(1),
      resentStatus(3),
    ])
      expect(isHarnessStatus(text), text).toBe(true);
    for (const text of ['Hi', 'ok', 'pass: not my role', 'consult refused: post_budget', 'restarted it myself'])
      expect(isHarnessStatus(text), text).toBe(false);
    expect([restartingStatus(1, 2, 60_000), resentStatus(1), resentStatus(3)]).toEqual([
      'restarting (1 of 2 within 60 s)',
      'sent again the message it held',
      'sent again the 3 messages it held',
    ]);
  });

  it('shows who an addressed message went to', () => {
    const m = msg({ to: 'hewo-1', at: '2026-09-26T23:30:01.123Z' });
    expect(formatWatchEvent({ type: 'message', message: m })).toBe('23:30:01Z [m1] input user-1 → hewo-1: hi\n');
    const broadcast = msg({ from: 'hewo-1', kind: 'internal', at: '2026-09-26T23:30:01.123Z' });
    expect(formatWatchEvent({ type: 'message', message: broadcast })).toBe(
      '23:30:01Z [m1] internal hewo-1 → all agents: hi\n',
    );
  });
  it("prints joins and leaves, and nothing on stdout for a model's output (model-streaming R7)", () => {
    expect(formatWatchEvent({ type: 'agent_joined', agent: 'a' })).toBe('+ a joined the channel\n');
    expect(formatWatchEvent({ type: 'agent_left', agent: 'a', detail: 'bye' })).toBe('- a left the channel: bye\n');
    expect(
      formatWatchEvent({
        type: 'model_delta',
        handle: 'hewo-1',
        conversation: 'c1',
        call: 's1',
        seq: 0,
        part: 'text',
        text: 'x',
      }),
    ).toBeUndefined();
    expect(
      formatWatchEvent({ type: 'model_done', handle: 'hewo-1', conversation: 'c1', call: 's1', outcome: 'ok' }),
    ).toBeUndefined();
  });
});

describe('runCli --watch', () => {
  it('prints channel events until Ctrl-C, then exits 0', async () => {
    let interrupt: ((signal: ShutdownSignal) => void) | undefined;
    const f = new FakeFetch((url, init) => {
      if (url.endsWith('/v1/health')) return json(200, health);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(wire({ type: 'watching', channel: 'lab', agents: ['hewo-1'] })));
          controller.enqueue(enc.encode(wire({ type: 'heartbeat' })));
          controller.enqueue(enc.encode(wire({ type: 'agent_joined', agent: 'a' })));
          controller.enqueue(enc.encode(wire({ type: 'message', message: msg({ at: '2026-09-26T01:02:03.000Z' }) })));
          init?.signal?.addEventListener('abort', () => {
            controller.error(present(init.signal, 'init.signal').reason);
          });
          setTimeout(() => {
            interrupt?.('SIGINT');
          }, 20);
        },
      });
      return new Response(body, SSE_OK);
    });
    const { ctx, home, io } = await context({
      fetch: f.fetch,
      shutdownSignals: (listener) => {
        interrupt = listener;
        return () => undefined;
      },
      timing: {
        serverStartMs: 100,
        serverStopMs: 100,
        streamIdleMs: 5_000,
        pollMs: 1,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
    });
    await writeDaemonFile(home, 5555);

    expect(await runCli(['--watch', 'channel=lab', '--verbose'], ctx)).toBe(EXIT.ok);

    expect(f.requests.map((r) => r.url)).toEqual([
      'http://127.0.0.1:5555/v1/health',
      'http://127.0.0.1:5555/v1/channel?name=lab',
    ]);
    expect(io.out).toEqual(['+ a joined the channel\n', '01:02:03Z [m1] input user-1 → all agents: hi\n']);
    expect(io.err).toEqual(['› watching channel "lab" (agents: hewo-1); Ctrl-C to stop\n']);
  });

  it('rejects anything but channel= after --watch', async () => {
    const { ctx, io } = await context();
    expect(await runCli(['--watch', 'recipe=x'], ctx)).toBe(EXIT.usage);
    expect(io.err[0]).toMatch(/^--watch takes only channel=<name>/);
  });

  it('fails when the daemon closes the channel stream', async () => {
    const f = new FakeFetch((url) => (url.endsWith('/v1/health') ? json(200, health) : new Response('', SSE_OK)));
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--watch'], ctx)).toBe(EXIT.failed);
    expect(io.err.at(-1)).toBe('✗ the daemon closed the channel stream\n');
  });

  // Completion review of control-api-auth: a daemon stopped mid-watch crashed the CLI with a TypeError stack.
  it.each([
    [
      ['--watch'],
      wire({ type: 'watching', channel: 'main', agents: [] }),
      '✗ the daemon closed the channel stream (other side closed)\n',
    ],
    [
      ['message=hi'],
      wire({ type: 'heartbeat' }),
      '✗ the daemon closed the conversation before it settled; see its log (other side closed)\n',
    ],
    [
      ['--launch', 'recipe=r'],
      wire({ type: 'heartbeat' }),
      '✗ the daemon closed the launch before it finished; see its log (other side closed)\n',
    ],
  ])('%j reports a stream the daemon cut mid-body, exit 1, with no stack', async (argv, line, message) => {
    const f = new FakeFetch((url) => (url.endsWith('/v1/health') ? json(200, health) : cutStream(line)));
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(argv, ctx)).toBe(EXIT.failed);
    expect(io.err.at(-1)).toBe(message);
  });

  it('starts the daemon when none answers', async () => {
    const { ctx, spawned } = await context({ isAlive: () => false });
    expect(await runCli(['--watch'], ctx)).toBe(EXIT.failed);
    expect(spawned).toHaveLength(1);
  });
});

describe('quiet by default; --verbose for progress (R10–R13)', () => {
  const conversationStream = (events: unknown[]) => new Response(events.map((e) => wire(e)).join(''), SSE_OK);

  it('prints only the reply, nothing on stderr, and still exits 0', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : conversationStream([
            { type: 'phase', phase: 'image', detail: 'asha-image-hello-world current' },
            { type: 'posted', message: msg({}), working: ['hewo-1'] },
            {
              type: 'message',
              message: msg({ id: 'm2', from: 'hewo-1', kind: 'status', text: 'ok' }),
              working: ['hewo-1'],
            },
            {
              type: 'message',
              message: msg({ id: 'm3', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hello World.' }),
              working: ['hewo-1'],
            },
            { type: 'status', conversation: 'c1', working: [] },
          ]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);

    expect(await runCli(['recipe=hello-world', 'message=Please say: Hello World.'], ctx)).toBe(EXIT.ok);

    expect(io.out).toEqual(['Hello World.\n']);
    expect(io.err).toEqual([]);
    expect(JSON.parse(bodyOf(lastRequest(f.requests)))).toEqual({
      user: 'olga',
      channel: 'main',
      recipe: 'hello-world',
      message: 'Please say: Hello World.',
    });
  });

  it('--verbose adds the progress on stderr, is not part of the request, and changes nothing on stdout', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : conversationStream([
            { type: 'posted', message: msg({ text: 'Please say: Hello World.' }), working: ['hewo-1'] },
            {
              type: 'message',
              message: msg({ id: 'm3', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hello World.' }),
              working: [],
            },
          ]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['message=Please say: Hello World.', '--verbose'], ctx)).toBe(EXIT.ok);
    expect(io.out).toEqual(['Hello World.\n']);
    expect(io.err).toEqual(['› user-1 → main: Please say: Hello World.\n', '› output hewo-1 → user-1:\n']);
    expect(JSON.parse(bodyOf(lastRequest(f.requests)))).toEqual({
      user: 'olga',
      channel: 'main',
      message: 'Please say: Hello World.',
    });
  });

  it('still reports a failure on stderr, with a non-zero exit', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : conversationStream([{ type: 'error', reason: 'unknown_recipe', detail: 'no recipe named "x"' }]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['recipe=x', 'message=m'], ctx)).toBe(EXIT.failed);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual(['✗ unknown_recipe: no recipe named "x"\n']);
  });

  it('with --launch prints only the new handle', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : conversationStream([
            { type: 'phase', phase: 'image', detail: 'x' },
            { type: 'announced', message: presence('hewo-2', 'Hi') },
            {
              type: 'launched',
              agent: { handle: 'hewo-2', channel: 'main', recipe: 'hello-world', image: 'hello-world' },
            },
          ]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--launch', 'recipe=hello-world'], ctx)).toBe(EXIT.ok);
    expect(io.out).toEqual(['hewo-2\n']);
    expect(io.err).toEqual([]);
  });

  // The owner's answer to question 2 (record auto-start-announcement): only with --verbose.
  it('announces starting the daemon only with --verbose', async () => {
    const quiet = await context({ isAlive: () => false });
    expect(await runCli(['message=m'], quiet.ctx)).toBe(EXIT.failed);
    expect(quiet.spawned).toHaveLength(1);
    expect(quiet.io.err).toEqual([
      `✗ the daemon exited during startup; see ${join(quiet.home, 'logs', 'server.log')}\n`,
    ]);

    const verbose = await context({ isAlive: () => false });
    expect(await runCli(['--verbose', 'message=m'], verbose.ctx)).toBe(EXIT.failed);
    expect(verbose.io.err).toEqual([
      `› started the asha daemon (pid 222); log: ${join(verbose.home, 'logs', 'server.log')}\n`,
      `✗ the daemon exited during startup; see ${join(verbose.home, 'logs', 'server.log')}\n`,
    ]);
  });

  // A9: --quiet is refused wherever it appears, before any daemon is found or started.
  it.each([
    [['--quiet', 'message=x']],
    [['--interactive', '--quiet']],
    [['--server', '--quiet']],
    [['message=x', '--verbose', '--quiet']],
  ])('%j is a usage error naming the change, and touches nothing', async (argv) => {
    const f = new FakeFetch(() => {
      throw new Error('fetch not expected');
    });
    let started = 0;
    const { ctx, io, spawned } = await context({
      fetch: f.fetch,
      startDaemon: () => {
        started += 1;
        return Promise.reject(new Error('startDaemon not expected'));
      },
    });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(io.err).toEqual([`--quiet is gone: asha is quiet by default; add --verbose for progress\n\n${USAGE}`]);
    expect(io.out).toEqual([]);
    expect([f.requests, spawned, started]).toEqual([[], [], 0]);
  });

  it.each([[['--status', '--verbose']], [['--verbose', '--status']]])('%j runs --status', async (argv) => {
    const f = new FakeFetch(() => json(200, health));
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(argv, ctx)).toBe(EXIT.ok);
    expect(io.out[0]).toBe(
      'running: pid 222, port 5555, version 9.9.9, build cli-build-01, started 2026-09-27T01:47:24.000Z\n',
    );
  });

  it.each([[[]], [['--verbose']]])('exit codes are the same with and without --verbose: %j', async (flags) => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : conversationStream([{ type: 'error', reason: 'unknown_recipe', detail: 'no recipe named "x"' }]),
    );
    const { ctx, home } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli([...flags, 'recipe=x', 'message=m'], ctx)).toBe(EXIT.failed);
    expect(await runCli([...flags, 'recipe=x'], ctx)).toBe(EXIT.usage);
    expect(await runCli([...flags, 'recipe=x', 'message=m', 'bogus'], ctx)).toBe(EXIT.usage);
  });

  /**
   * A8: every command, run without and with --verbose, against a daemon of another build that the command first
   * has to start (the commands that start one) or that is already running (--status, --stop).
   */
  describe('every command, without and with --verbose (A8)', () => {
    const other = { ...health, build: 'old-build-00' };
    const STALE = `⚠ the running daemon (pid 222, started 2026-09-27T01:47:24.000Z) runs a different build (old-build-00) than this asha (cli-build-01), and so do its agents. Run asha --stop to use this build.\n`;

    /** A daemon of another build answering every route, started by the command unless `running`. */
    async function run(argv: readonly string[], running: boolean, lines: readonly string[] = []) {
      let started = running;
      const f = new FakeFetch((url) => {
        if (!started) throw new TypeError('connect ECONNREFUSED');
        if (url.endsWith('/v1/health')) return json(200, other);
        if (url.endsWith('/v1/conversations')) {
          return ndjson([
            { type: 'phase', phase: 'agent', detail: 'hewo-1 online' },
            { type: 'announced', message: presence('hewo-1', 'Hi') },
            { type: 'posted', message: msg({ from: 'bob', user: 'bob' }), working: ['hewo-1'] },
            {
              type: 'message',
              message: msg({ id: 'm2', from: 'hewo-1', kind: 'status', text: 'ok' }),
              working: ['hewo-1'],
            },
            {
              type: 'message',
              message: msg({ id: 'm3', from: 'hewo-1', to: 'hewo-2', kind: 'internal', text: 'Say: hi' }),
              working: ['hewo-1'],
            },
            { type: 'agent_left', conversation: 'c1', agent: 'hewo-2', detail: 'stopped', working: ['hewo-1'] },
            {
              type: 'message',
              message: msg({ id: 'm4', from: 'hewo-1', to: 'bob', kind: 'output', text: 'Hello World.' }),
              working: [],
            },
          ]);
        }
        if (url.endsWith('/v1/agents')) {
          const events: LaunchEvent[] = [
            { type: 'phase', phase: 'image', detail: 'x' },
            { type: 'announced', message: presence('hewo-2', 'Hi') },
            {
              type: 'launched',
              agent: { handle: 'hewo-2', channel: 'main', recipe: 'hello-world', image: 'hello-world' },
            },
          ];
          return new Response(events.map((e) => wire(e)).join(''), SSE_OK);
        }
        const watched: WatchEvent[] = [
          { type: 'watching', channel: 'main', agents: [] },
          { type: 'agent_joined', agent: 'hewo-1' },
        ];
        return new Response(watched.map((e) => wire(e)).join(''), SSE_OK);
      });
      let alive = 2;
      const loggers: string[] = [];
      const t = await context({
        fetch: f.fetch,
        spawnServer: async (paths) => {
          await writeDaemonFile(paths.home, 5555);
          started = true;
          return 222;
        },
        isAlive: () => (argv.includes('--stop') ? (alive -= 1) > 0 : true),
        createLogger: (paths) => {
          loggers.push(paths.home);
          return { info: () => undefined, warn: () => undefined, error: () => undefined };
        },
        dependencies: () => ({}) as never,
        // A daemon whose stop trigger settles `stopped` at once (docs/plans/portal.md R14: --server awaits it).
        startDaemon: () => {
          let settle!: () => void;
          const stopped = new Promise<void>((resolve) => (settle = resolve));
          return Promise.resolve({
            port: 7777,
            requestStop: () => {
              settle();
            },
            stopped,
            stop: () => Promise.resolve(),
          });
        },
        // Only --server waits for a signal; --watch ends when the fake closes its stream.
        shutdownSignals: (listener) => {
          if (argv.includes('--server'))
            setTimeout(() => {
              listener('SIGTERM');
            }, 0);
          return () => undefined;
        },
        input: { lines: fromLines(lines), isTerminal: false },
      });
      if (running) await writeDaemonFile(t.home, 5555);
      const code = await runCli(argv, t.ctx);
      return { code, out: t.io.out.join(''), err: t.io.err, home: t.home, loggers };
    }

    const commands: [string, readonly string[], boolean, readonly string[]][] = [
      ['a message', ['message=hi'], false, []],
      ['--launch', ['--launch', 'recipe=hello-world'], false, []],
      ['--watch', ['--watch'], false, []],
      ['--status', ['--status'], true, []],
      ['--stop', ['--stop'], true, []],
      ['--server', ['--server'], false, []],
      ['--help', ['--help'], false, []],
      ['an interactive session', ['--interactive', 'user=bob'], false, ['hi', 'hi again']],
    ];

    it.each(commands)(
      '%s: stderr holds no › line without --verbose, the same stdout with it',
      async (_, argv, running, lines) => {
        const quiet = await run(argv, running, lines);
        const verbose = await run([...argv, '--verbose'], running, lines);

        // Without --verbose, stderr is only the classes R10 and R11 list: here the ⚠ and ✗ lines.
        expect(
          quiet.err.filter((line) => line.startsWith('›')),
          'progress printed without --verbose',
        ).toEqual([]);
        expect(
          quiet.err.filter((line) => !line.startsWith('⚠') && !line.startsWith('✗')),
          'stderr beyond ⚠ and ✗',
        ).toEqual([]);
        expect(verbose.code).toBe(quiet.code);
        expect(verbose.out).toBe(quiet.out.replace(quiet.home, verbose.home));
        // With it, the ⚠ and ✗ lines are unchanged and in the same order; progress is added around them.
        expect(verbose.err.filter((line) => line.startsWith('⚠') || line.startsWith('✗'))).toEqual(quiet.err);
      },
    );

    it.each(commands.filter(([name]) => !['--help', '--server', '--status', '--stop'].includes(name)))(
      '%s: with --verbose, progress follows the announced start of the daemon',
      async (_, argv, running, lines) => {
        const verbose = await run([...argv, '--verbose'], running, lines);
        const progress = verbose.err.filter((line) => line.startsWith('›'));
        expect(progress[0]).toBe(
          `› started the asha daemon (pid 222); log: ${join(verbose.home, 'logs', 'server.log')}\n`,
        );
        expect(progress.length).toBeGreaterThan(1);
      },
    );

    it('each command that finds the daemon warns once about the other build, with or without --verbose', async () => {
      for (const [, argv, running, lines] of commands.filter(
        ([name]) => !['--help', '--server', '--stop'].includes(name),
      )) {
        for (const flags of [[], ['--verbose']]) {
          const result = await run([...argv, ...flags], running, lines);
          expect(
            result.err.filter((line) => line === STALE),
            `${argv.join(' ')} ${flags.join(' ')}`,
          ).toHaveLength(1);
        }
      }
    });

    it('a single message and a session print exactly the replies and the warning, without --verbose', async () => {
      const single = await run(['message=hi'], false);
      expect([single.code, single.out, single.err]).toEqual([EXIT.ok, 'Hello World.\n', [STALE]]);
      const watch = await run(['--watch'], false);
      expect([watch.code, watch.out, watch.err]).toEqual([
        EXIT.failed,
        '+ hewo-1 joined the channel\n',
        [STALE, '✗ the daemon closed the channel stream\n'],
      ]);
      const session = await run(['--interactive', 'user=bob'], false, ['hi', 'hi again']);
      expect([session.code, session.out, session.err]).toEqual([EXIT.ok, 'Hello World.\nHello World.\n', [STALE]]);
    });

    it('--server prints its line on stdout and creates its logger the same way with and without --verbose', async () => {
      const quiet = await run(['--server'], false);
      const verbose = await run(['--server', '--verbose'], false);
      expect([quiet.code, quiet.out, quiet.err]).toEqual([
        EXIT.ok,
        `asha 9.9.9 serving on 127.0.0.1:7777 (pid 111); home ${quiet.home}\n`,
        [],
      ]);
      expect([verbose.code, verbose.out.replace(verbose.home, quiet.home), verbose.err]).toEqual([
        quiet.code,
        quiet.out,
        quiet.err,
      ]);
      // The log echo is the logger's (main.ts): created once, for its home, either way.
      expect([quiet.loggers, verbose.loggers]).toEqual([[quiet.home], [verbose.home]]);
    });

    /**
     * A8's re-sent-message run (R11; agent-persistence R9 (h), (i)): a `--launch` that the command's own daemon —
     * started by the command, of this CLI's build, since only such a daemon is asked to follow — answers with one
     * `resending` shows `› resuming your message from <savedAt>` and no other › line without --verbose; with it, the
     * progress too; stdout and the exit code are the same in both runs.
     */
    it('--launch with one re-sent message: only the resuming line without --verbose, the progress too with it, the same stdout', async () => {
      const SAVED_AT = '2026-09-28T10:00:00.000Z';
      async function relaunch(flags: readonly string[]) {
        let started = false;
        const f = new FakeFetch((url) => {
          if (!started) throw new TypeError('connect ECONNREFUSED');
          if (url.endsWith('/v1/health')) return json(200, health);
          if (!url.endsWith('/v1/agents')) throw new Error(`unexpected request to ${url}`);
          const events: LaunchEvent[] = [
            { type: 'phase', phase: 'image', detail: 'x' },
            {
              type: 'announced',
              message: presence('keep-1', 'Hi'),
              resumed: { savedAt: '2026-09-28T09:59:00.000Z', previousHandle: 'keep-1' },
            },
            { type: 'launched', agent: { handle: 'keep-1', channel: 'main', recipe: 'keeper', image: 'keeper' } },
            { type: 'resending', conversation: 'c1', savedAt: SAVED_AT },
            {
              type: 'message',
              message: msg({
                id: 'm2',
                conversation: 'c1',
                user: 'bob',
                from: 'keep-1',
                to: 'keep-2',
                kind: 'internal',
                text: 'Say: hi',
              }),
              working: ['keep-1'],
            },
            { type: 'agent_left', conversation: 'c1', agent: 'keep-2', detail: 'stopped', working: ['keep-1'] },
            {
              type: 'message',
              message: msg({
                id: 'm3',
                conversation: 'c1',
                user: 'bob',
                from: 'keep-1',
                to: 'bob',
                kind: 'output',
                text: 'Done: task 3.',
              }),
              working: [],
            },
            { type: 'status', conversation: 'c1', working: [] },
            { type: 'settled', conversation: 'c1' },
          ];
          return new Response(events.map((e) => wire(e)).join(''), SSE_OK);
        });
        const t = await context({
          fetch: f.fetch,
          spawnServer: async (paths) => {
            await writeDaemonFile(paths.home, 5555);
            started = true;
            return 222;
          },
        });
        const code = await runCli(['--launch', 'recipe=keeper', ...flags], t.ctx);
        const launchBody = JSON.parse(
          bodyOf(
            present(
              f.requests.find((r) => r.url.endsWith('/v1/agents')),
              "f.requests.find('/v1/agents')",
            ),
          ),
        ) as unknown;
        return { code, out: t.io.out.join(''), err: t.io.err, home: t.home, launchBody };
      }
      const RESUMING = `› resuming your message from ${SAVED_AT}\n`;

      const quiet = await relaunch([]);
      const verbose = await relaunch(['--verbose']);
      // Both asked the daemon to follow the re-sent conversations, so both read the resending event.
      expect([quiet.launchBody, verbose.launchBody]).toEqual([
        { recipe: 'keeper', channel: 'main', followResent: true },
        { recipe: 'keeper', channel: 'main', followResent: true },
      ]);
      expect(
        quiet.err.filter((line) => line.startsWith('›') && line !== RESUMING),
        'progress printed without --verbose',
      ).toEqual([]);
      expect(quiet.err, 'stderr without --verbose').toEqual([RESUMING]);
      expect([quiet.code, quiet.out]).toEqual([EXIT.ok, 'keep-1\nDone: task 3.\n']);
      expect([verbose.code, verbose.out]).toEqual([quiet.code, quiet.out]);
      // With it, the progress around the one always-shown line, which is printed once, in its place.
      expect(verbose.err).toEqual([
        `› started the asha daemon (pid 222); log: ${join(verbose.home, 'logs', 'server.log')}\n`,
        '› image: x\n',
        '› keep-1: Hi\n',
        '› keep-1 resumed from state saved 2026-09-28T09:59:00.000Z\n',
        RESUMING,
        '› internal keep-1 → keep-2: Say: hi\n',
        '› keep-2 left the channel: stopped\n',
        '› output keep-1 → bob:\n',
      ]);
    });
  });
});

describe('control characters on a terminal (R14, A13)', () => {
  const HOSTILE = 'a\x1b]52;c;aGk=\x07b\x9bc\rd\ne\tf';
  const SCRUBBED = 'a�]52;c;aGk=�b�c�d\ne\tf';
  // Written as a character set, not a regular expression: a raw ESC, BEL, 0x9b or CR anywhere is the terminal escape
  // the scrubber must have removed (sonarjs/no-control-regex: a regex naming these would itself be flagged).
  const UNSCRUBBED = ['\x1b', '\x07', '\x9b', '\r'];

  it('scrubControl replaces every C0 and C1 control character and DEL, but not line feed and tab', () => {
    const codes = Array.from({ length: 0xa1 }, (_, i) => i);
    const scrubbed = Array.from(scrubControl(String.fromCharCode(...codes)));
    const replaced = codes.filter((_code, i) => scrubbed[i] === '�');
    const control = codes.filter(
      (code) => (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) && code !== 0x0a && code !== 0x09,
    );
    expect(replaced).toEqual(control);
    expect(codes.filter((code, i) => scrubbed[i] === String.fromCharCode(code))).toEqual(
      codes.filter((code) => !control.includes(code)),
    );
    expect(scrubControl(HOSTILE)).toBe(SCRUBBED);
  });

  async function reply(terminal: { stdout: boolean; stderr: boolean }) {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : ndjson([
            { type: 'posted', message: msg({}), working: ['hewo-1'] },
            {
              type: 'message',
              message: msg({ id: 'm2', from: 'hewo-1', to: 'hewo-2', kind: 'internal', text: HOSTILE }),
              working: ['hewo-1'],
            },
            {
              type: 'message',
              message: msg({ id: 'm3', from: 'hewo-1', to: 'user-1', kind: 'output', text: HOSTILE }),
              working: [],
            },
          ]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch, terminal });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--verbose', 'message=hi'], ctx)).toBe(EXIT.ok);
    return { out: io.out.join(''), err: io.err.join('') };
  }

  it('a reply on a terminal stdout and an internal message on a terminal stderr are scrubbed', async () => {
    const { out, err } = await reply({ stdout: true, stderr: true });
    expect(out).toBe(`${SCRUBBED}\n`);
    expect(err).toContain(`› internal hewo-1 → hewo-2: ${SCRUBBED.replace('\n', '\n    ')}\n`);
    for (const bad of UNSCRUBBED) expect(err).not.toContain(bad);
  });

  it('piped output is byte for byte', async () => {
    const { out, err } = await reply({ stdout: false, stderr: false });
    expect(out).toBe(`${HOSTILE}\n`);
    expect(err).toContain(`› internal hewo-1 → hewo-2: ${HOSTILE.replace('\n', '\n    ')}\n`);
  });

  it('each stream is judged on its own', async () => {
    const { out, err } = await reply({ stdout: false, stderr: true });
    expect(out).toBe(`${HOSTILE}\n`);
    for (const bad of UNSCRUBBED) expect(err).not.toContain(bad);
  });
});

describe('runCli --launch', () => {
  const launchStream = (events: unknown[]) => new Response(events.map((e) => wire(e)).join(''), SSE_OK);

  it('starts an agent, shows its phases, and prints its handle on stdout', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : launchStream([
            { type: 'phase', phase: 'image', detail: 'asha-image-hello-world current' },
            { type: 'announced', message: presence('hewo-2', 'Hi', { channel: 'lab' }) },
            {
              type: 'launched',
              agent: { handle: 'hewo-2', channel: 'lab', recipe: 'hello-world', image: 'hello-world' },
            },
          ]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);

    expect(await runCli(['--launch', 'recipe=hello-world', 'channel=lab', '--verbose'], ctx)).toBe(EXIT.ok);

    const launch = present(
      f.requests.find((r) => r.url.endsWith('/v1/agents')),
      "f.requests.find('/v1/agents')",
    );
    expect(JSON.parse(bodyOf(launch))).toEqual({
      recipe: 'hello-world',
      channel: 'lab',
      followResent: true,
    });
    expect(io.out).toEqual(['hewo-2\n']);
    expect(io.err).toEqual(['› image: asha-image-hello-world current\n', '› hewo-2: Hi\n']);
  });

  it('uses channel main by default and fails on an error event', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : launchStream([{ type: 'error', reason: 'unknown_recipe', detail: 'no recipe named "x"' }]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--launch', 'recipe=x'], ctx)).toBe(EXIT.failed);
    expect(JSON.parse(bodyOf(lastRequest(f.requests)))).toEqual({
      recipe: 'x',
      channel: 'main',
      followResent: true,
    });
    expect(io.err).toEqual(['✗ unknown_recipe: no recipe named "x"\n']);
  });

  it.each([
    [['--launch']],
    [['--launch', 'channel=lab']],
    [['--launch', 'recipe=x', 'to=y']],
    [['--launch', 'recipe=x', 'team=t']],
  ])('rejects %j as usage', async (argv) => {
    const { ctx, io } = await context();
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(io.err[0]).toMatch(/^--launch takes recipe=<recipe> or team=<team>, and optionally channel=<name>\n/);
  });

  const agent = (handle: string, recipe: string) => ({ handle, channel: 'main', recipe, image: 'hello-world' });

  it.each([[[] as string[]], [['--verbose']]])(
    "launches a team: posts {team, channel}, prints each member's handle as it comes online, and exits 0 on team_launched; progress only with --verbose (collaborating-agents R5): %j",
    async (flags) => {
      const f = new FakeFetch((url) =>
        url.endsWith('/v1/health')
          ? json(200, health)
          : launchStream([
              { type: 'member', name: 'lead', recipe: 'lead' },
              { type: 'phase', phase: 'image', detail: 'asha-image-hello-world current' },
              { type: 'announced', message: presence('lead-1', 'Hi') },
              { type: 'launched', agent: agent('lead-1', 'lead') },
              { type: 'member', name: 'greeter', recipe: 'greeter' },
              { type: 'announced', message: presence('greeter-1', 'Hi') },
              { type: 'launched', agent: agent('greeter-1', 'greeter') },
              {
                type: 'team_launched',
                team: 'delegation',
                agents: [agent('lead-1', 'lead'), agent('greeter-1', 'greeter')],
              },
            ]),
      );
      const { ctx, home, io } = await context({ fetch: f.fetch });
      await writeDaemonFile(home, 5555);
      expect(await runCli(['--launch', 'team=delegation', ...flags], ctx)).toBe(EXIT.ok);
      const teamLaunch = present(
        f.requests.find((r) => r.url.endsWith('/v1/agents')),
        "f.requests.find('/v1/agents')",
      );
      expect(JSON.parse(bodyOf(teamLaunch))).toEqual({
        team: 'delegation',
        channel: 'main',
        followResent: true,
      });
      expect(io.out).toEqual(['lead-1\n', 'greeter-1\n']);
      expect(io.err).toEqual(
        flags.length === 0
          ? []
          : [
              '› member lead (recipe lead)\n',
              '› image: asha-image-hello-world current\n',
              '› lead-1: Hi\n',
              '› member greeter (recipe greeter)\n',
              '› greeter-1: Hi\n',
            ],
      );
    },
  );

  it("a team's launch that ends before team_launched fails, having printed the members that came online", async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : launchStream([
            { type: 'member', name: 'lead', recipe: 'lead' },
            { type: 'launched', agent: agent('lead-1', 'lead') },
          ]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--launch', 'team=delegation'], ctx)).toBe(EXIT.failed);
    expect(io.out).toEqual(['lead-1\n']);
    expect(io.err.at(-1)).toBe('✗ the daemon closed the launch before it finished; see its log\n');
  });

  it("a team's error names the member, and exits 1", async () => {
    const detail =
      'team delegation: member "greeter" did not start: agent asha-main-greeter-abc123 did not come online: not online within 60000 ms';
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : launchStream([
            { type: 'member', name: 'lead', recipe: 'lead' },
            { type: 'launched', agent: agent('lead-1', 'lead') },
            { type: 'error', reason: 'agent_start', detail },
          ]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--launch', 'team=delegation'], ctx)).toBe(EXIT.failed);
    expect(io.err.at(-1)).toBe(`✗ agent_start: ${detail}\n`);
  });

  it.each([
    ['member', { type: 'member', name: 'lead', recipe: 'lead' }],
    ['team_launched', { type: 'team_launched', team: 't', agents: [] }],
  ])("a recipe's launch that streams a team's %s event is a defect, and throws", async (_, event) => {
    const f = new FakeFetch((url) => (url.endsWith('/v1/health') ? json(200, health) : launchStream([event])));
    const { ctx, home } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    await expect(runCli(['--launch', 'recipe=hello-world'], ctx)).rejects.toThrow(
      `a recipe's launch streamed a team's event: ${JSON.stringify(event)}`,
    );
  });
});

describe('runCli', () => {
  it('prints usage for --help and exits 0', async () => {
    const { ctx, io } = await context();
    expect(await runCli(['--help'], ctx)).toBe(EXIT.ok);
    expect(io.out).toEqual([USAGE]);
  });

  it('prints the problem and usage for bad arguments, exiting 2', async () => {
    const { ctx, io } = await context();
    expect(await runCli(['recipe=x'], ctx)).toBe(EXIT.usage);
    expect(io.err).toEqual([`missing message=\n\n${USAGE}`]);
  });

  it('--status reports "not running" without starting anything', async () => {
    const { ctx, io, spawned } = await context();
    expect(await runCli(['--status'], ctx)).toBe(EXIT.failed);
    expect(io.out).toEqual(['not running\n']);
    expect(spawned).toEqual([]);
  });

  it('--status lists the daemon and its agents', async () => {
    const f = new FakeFetch(() => json(200, health));
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--status'], ctx)).toBe(EXIT.ok);
    expect(f.requests.map((r) => r.url)).toEqual(['http://127.0.0.1:5555/v1/health']);
    expect(io.out).toEqual([
      'running: pid 222, port 5555, version 9.9.9, build cli-build-01, started 2026-09-27T01:47:24.000Z\n',
      '  hewo-1  channel=main recipe=hello-world image=hello-world\n',
    ]);
  });

  it('warns, on stderr and without --verbose, when the running daemon is from another build', async () => {
    const old = { ...health, build: 'old-build-00' };
    const stream = [
      { type: 'posted', message: msg({}), working: ['hewo-1'] },
      {
        type: 'message',
        message: msg({ id: 'm3', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hello World.' }),
        working: [],
      },
    ];
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health') ? json(200, old) : new Response(stream.map((e) => wire(e)).join(''), SSE_OK),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);

    expect(await runCli(['message=hi'], ctx)).toBe(EXIT.ok);

    expect(io.out).toEqual(['Hello World.\n']);
    expect(io.err).toEqual([
      '⚠ the running daemon (pid 222, started 2026-09-27T01:47:24.000Z) runs a different build (old-build-00) than this asha (cli-build-01), and so do its agents. Run asha --stop to use this build.\n',
    ]);
  });

  it.each([
    ['another build', 'old-build-00', 'the daemon runs a different build than this asha (see asha --status)'],
    ['this build', 'cli-build-01', 'a defect in the daemon; see its log'],
  ])('judges a conversation with no reply at all by the build the daemon reports: %s', async (_, build, cause) => {
    const stream = [
      { type: 'posted', message: msg({}), working: ['hewo-1'] },
      { type: 'status', conversation: 'c1', working: [] },
    ];
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, { ...health, build })
        : new Response(stream.map((e) => wire(e)).join(''), SSE_OK),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);

    expect(await runCli(['message=hi'], ctx)).toBe(EXIT.failed);
    expect(io.err.at(-1)).toBe(`✗ the conversation ended with no reply at all, not even the harness's: ${cause}\n`);
  });

  it('warns about a daemon from before builds were tracked, which reports no build', async () => {
    const older: Partial<typeof health> = { ...health };
    delete older.build;
    delete older.startedAt;
    const f = new FakeFetch(() => json(200, older));
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--status'], ctx)).toBe(EXIT.ok);
    expect(io.err).toEqual([
      '⚠ the running daemon (pid 222, started at an unknown time) runs a different build (unknown, from before builds were tracked) than this asha (cli-build-01), and so do its agents. Run asha --stop to use this build.\n',
    ]);
  });

  it('--status shows the other build and warns', async () => {
    const f = new FakeFetch(() => json(200, { ...health, build: 'old-build-00' }));
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--status'], ctx)).toBe(EXIT.ok);
    expect(io.out[0]).toBe(
      'running: pid 222, port 5555, version 9.9.9, build old-build-00, started 2026-09-27T01:47:24.000Z\n',
    );
    expect(io.err).toEqual([
      expect.stringMatching(
        /^⚠ the running daemon .* runs a different build \(old-build-00\) than this asha \(cli-build-01\), and so do its agents\. Run asha --stop to use this build\.\n$/,
      ),
    ]);
  });

  it('--stop does not warn about an old daemon: stopping it is the fix', async () => {
    const f = new FakeFetch(() => json(200, { ...health, build: 'old-build-00' }));
    let alive = 2;
    const { ctx, home, io } = await context({ fetch: f.fetch, isAlive: () => (alive -= 1) > 0 });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--stop'], ctx)).toBe(EXIT.ok);
    expect(io.err).toEqual([]);
  });

  it('--stop sends SIGTERM and waits for the daemon to exit', async () => {
    const f = new FakeFetch(() => json(200, health));
    let alive = 3;
    const { ctx, home, io, killed } = await context({ fetch: f.fetch, isAlive: () => (alive -= 1) > 0 });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--stop'], ctx)).toBe(EXIT.ok);
    expect(killed).toEqual([[222, 'SIGTERM']]);
    expect(io.out).toEqual(['stopped (pid 222)\n']);
  });

  it('--stop fails if the daemon outlives its bound', async () => {
    const f = new FakeFetch(() => json(200, health));
    const { ctx, home, io } = await context({
      fetch: f.fetch,
      timing: {
        serverStartMs: 10,
        serverStopMs: 20,
        streamIdleMs: 10,
        pollMs: 1,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
    });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--stop'], ctx)).toBe(EXIT.failed);
    expect(io.err).toEqual(['✗ daemon pid 222 is still running 20 ms after SIGTERM\n']);
  });

  describe('--stop channel=<name> (docs/plans/portal-demo-stop.md R4)', () => {
    const stopStream = (events: unknown[]) => new Response(events.map(wire).join(''), SSE_OK);
    const answering = (stop: () => Response) =>
      new FakeFetch((url) => (url.endsWith(Routes.health) ? json(200, health) : stop()));
    const STOPPED = [
      { type: 'stopping', channel: 'p05-1', handles: ['lead-1', 'worker-a-1'] },
      { type: 'agent_stopped', handle: 'lead-1' },
      { type: 'agent_stopped', handle: 'worker-a-1' },
      { type: 'model_server_stopped', model: 'tiny-model' },
      { type: 'stopped', channel: 'p05-1', handles: ['lead-1', 'worker-a-1'], modelServers: ['tiny-model'] },
    ];

    it('prints each agent and each model server stopped and exits 0; sends the channel and source cli with the credential; sends no signal', async () => {
      const f = answering(() => stopStream(STOPPED));
      const { ctx, home, io, killed, spawned } = await context({ fetch: f.fetch });
      await writeDaemonFile(home, 5555);

      expect(await runCli(['--stop', 'channel=p05-1'], ctx)).toBe(EXIT.ok);

      expect(io.out).toEqual(['stopped lead-1\n', 'stopped worker-a-1\n', 'stopped the model server for tiny-model\n']);
      expect(io.err).toEqual([]);
      const stop = f.requests.filter((r) => r.url.endsWith(Routes.channelStop));
      expect(stop).toHaveLength(1);
      const stopReq = present(stop[0], 'stop[0]');
      expect(stopReq.init?.method).toBe('POST');
      expect(JSON.parse(bodyOf(stopReq))).toEqual({ channel: 'p05-1', source: 'cli' });
      expect(authorization(stopReq)).toBe(`Bearer ${CREDENTIAL}`);
      expect(killed).toEqual([]);
      expect(spawned).toEqual([]);
    });

    it('with --verbose, says which agents it is stopping first', async () => {
      const { ctx, home, io } = await context({ fetch: answering(() => stopStream(STOPPED)).fetch });
      await writeDaemonFile(home, 5555);

      expect(await runCli(['--verbose', '--stop', 'channel=p05-1'], ctx)).toBe(EXIT.ok);

      expect(io.err).toEqual(['› stopping lead-1, worker-a-1 on channel p05-1\n']);
    });

    it('a channel with no agent: its line, exit 1', async () => {
      const { ctx, home, io } = await context({
        fetch: answering(() => json(404, { error: 'no agent is on channel "quiet"', reason: 'unknown_channel' })).fetch,
      });
      await writeDaemonFile(home, 5555);

      expect(await runCli(['--stop', 'channel=quiet'], ctx)).toBe(EXIT.failed);

      expect(io.out).toEqual([]);
      expect(io.err).toEqual(['✗ no agent is on channel "quiet"\n']);
    });

    it('no daemon running: its line, exit 1, and none is started', async () => {
      const { ctx, io, spawned } = await context();

      expect(await runCli(['--stop', 'channel=p05-1'], ctx)).toBe(EXIT.failed);

      expect(io.err).toEqual(['✗ no daemon is running\n']);
      expect(spawned).toEqual([]);
    });

    it("a failed stop: the error's detail, exit 1, after the agents it did stop", async () => {
      const failed = [
        STOPPED[0],
        STOPPED[1],
        {
          type: 'error',
          reason: 'channel_stop_failed',
          detail: 'the stop of channel p05-1 failed: worker-a-1 still running after the stop',
        },
      ];
      const { ctx, home, io } = await context({ fetch: answering(() => stopStream(failed)).fetch });
      await writeDaemonFile(home, 5555);

      expect(await runCli(['--stop', 'channel=p05-1'], ctx)).toBe(EXIT.failed);

      expect(io.out).toEqual(['stopped lead-1\n']);
      expect(io.err).toEqual(['✗ the stop of channel p05-1 failed: worker-a-1 still running after the stop\n']);
    });

    it('a stream that ends before stopped: the closed line, exit 1', async () => {
      const { ctx, home, io } = await context({ fetch: answering(() => stopStream(STOPPED.slice(0, 2))).fetch });
      await writeDaemonFile(home, 5555);

      expect(await runCli(['--stop', 'channel=p05-1'], ctx)).toBe(EXIT.failed);

      expect(io.err).toEqual(['✗ the daemon closed the stop of channel p05-1 before it was done\n']);
    });

    it('a stream the daemon cuts mid-body: its line, exit 1, with no stack', async () => {
      const { ctx, home, io } = await context({ fetch: answering(() => cutStream(wire(STOPPED[0]))).fetch });
      await writeDaemonFile(home, 5555);

      expect(await runCli(['--stop', 'channel=p05-1'], ctx)).toBe(EXIT.failed);

      expect(io.err).toEqual([
        '✗ the daemon closed the stop of channel p05-1 before it was done (other side closed)\n',
      ]);
    });

    it('a stream silent past its bound: the silence line, exit 1', async () => {
      const silent = new FakeFetch((url, init) => {
        if (url.endsWith(Routes.health)) return json(200, health);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              controller.error(present(init.signal, 'init.signal').reason);
            });
          },
        });
        return new Response(body, SSE_OK);
      });
      const { ctx, home, io } = await context({
        fetch: silent.fetch,
        timing: {
          serverStartMs: 20,
          serverStopMs: 20,
          streamIdleMs: 30,
          pollMs: 1,
          uploadAnswerMs: 260_000,
          downloadIdleMs: 30_000,
        },
      });
      await writeDaemonFile(home, 5555);

      expect(await runCli(['--stop', 'channel=p05-1'], ctx)).toBe(EXIT.failed);

      expect(io.err).toEqual(['✗ no word from the daemon for 30 ms; see its log\n']);
    });

    it.each([
      [['--stop', 'channel=']],
      [['--stop', 'channel=Bad Name']],
      [['--stop', 'name=p05-1']],
      [['--stop', 'p05-1']],
    ])('%j is a usage error, exit 2, contacting no daemon', async (argv) => {
      const f = answering(() => stopStream(STOPPED));
      const { ctx, io } = await context({ fetch: f.fetch });

      expect(await runCli(argv, ctx)).toBe(EXIT.usage);

      expect(io.err[0]).toMatch(/^--stop takes nothing, or channel=<name>/);
      expect(f.requests).toEqual([]);
    });
  });

  it('starts the daemon when none answers, then holds the conversation until it settles', async () => {
    let started = false;
    const f = new FakeFetch((url) => {
      if (!started) throw new TypeError('connect ECONNREFUSED');
      if (url.endsWith('/v1/health')) return json(200, health);
      return ndjson([
        { type: 'phase', phase: 'agent', detail: 'hewo-1 online' },
        { type: 'posted', message: msg({ text: 'Please say: Hello World.' }), working: ['hewo-1'] },
        {
          type: 'message',
          message: msg({ id: 'm2', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hello World!' }),
          working: ['hewo-1'],
        },
        { type: 'status', conversation: 'c1', working: [] },
      ]);
    });
    const t = await context({
      fetch: f.fetch,
      spawnServer: async (paths) => {
        await writeDaemonFile(paths.home, 6000);
        started = true;
        return 222;
      },
    });

    const code = await runCli(['--verbose', 'recipe=hello-world', 'message=Please say: Hello World.'], t.ctx);

    expect(code).toBe(EXIT.ok);
    expect(t.io.out).toEqual(['Hello World!\n']);
    expect(t.io.err[0]).toBe(`› started the asha daemon (pid 222); log: ${join(t.home, 'logs', 'server.log')}\n`);
    const conversation = present(
      f.requests.find((r) => r.url.endsWith('/v1/conversations')),
      "f.requests.find('/v1/conversations')",
    );
    expect(conversation.url).toBe('http://127.0.0.1:6000/v1/conversations');
    expect(JSON.parse(bodyOf(conversation))).toEqual({
      user: 'olga',
      channel: 'main',
      recipe: 'hello-world',
      message: 'Please say: Hello World.',
    });
  });

  it("notes a dead daemon's file once, however many times the start polls it (found by agent-persistence's p20-b)", async () => {
    // The file of a SIGKILLed daemon names a port nobody answers; the new daemon rewrites it on its fourth poll.
    let polls = 0;
    const f = new FakeFetch((url) => {
      if (url.startsWith('http://127.0.0.1:5000/')) throw new TypeError('fetch failed');
      if (url.endsWith('/v1/health')) return json(200, health);
      // The launch itself is refused: this test is about finding the daemon, which comes first.
      return json(500, { error: 'not this test' });
    });
    const t = await context({
      fetch: f.fetch,
      sleep: async () => {
        polls += 1;
        if (polls === 4) await writeDaemonFile(t.home, 6000);
      },
      spawnServer: () => Promise.resolve(222),
    });
    await writeDaemonFile(t.home, 5000);
    expect(await runCli(['--launch', 'recipe=r'], t.ctx)).toBe(EXIT.failed);
    expect(t.io.err.filter((l) => l.includes('which did not answer'))).toEqual([
      '(daemon file names port 5000, which did not answer: fetch failed)\n',
    ]);
    expect(polls).toBeGreaterThanOrEqual(4);
  });

  it('fails when a started daemon dies during startup', async () => {
    const { ctx, io } = await context({ isAlive: () => false });
    expect(await runCli(['recipe=r', 'message=m'], ctx)).toBe(EXIT.failed);
    expect(io.err.at(-1)).toMatch(/^✗ the daemon exited during startup; see .*server\.log\n$/);
  });

  it('fails when a started daemon never answers within its bound', async () => {
    const { ctx, io } = await context({
      timing: {
        serverStartMs: 20,
        serverStopMs: 20,
        streamIdleMs: 20,
        pollMs: 1,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
    });
    expect(await runCli(['recipe=r', 'message=m'], ctx)).toBe(EXIT.failed);
    expect(io.err.at(-1)).toMatch(/^✗ the daemon did not answer within 20 ms; see .*server\.log\n$/);
  });

  it('fails when the conversation stream goes silent past its bound', async () => {
    const f = new FakeFetch((url, init) => {
      if (url.endsWith('/v1/health')) return json(200, health);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(present(init.signal, 'init.signal').reason);
          });
        },
      });
      return new Response(body, SSE_OK);
    });
    const { ctx, home, io } = await context({
      fetch: f.fetch,
      timing: {
        serverStartMs: 20,
        serverStopMs: 20,
        streamIdleMs: 30,
        pollMs: 1,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
    });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['recipe=r', 'message=m'], ctx)).toBe(EXIT.failed);
    expect(io.err.at(-1)).toBe('✗ no word from the daemon for 30 ms; see its log\n');
  });

  it('fails when the daemon closes the stream before the conversation settles', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health') ? json(200, health) : ndjson([{ type: 'posted', message: msg({}), working: ['a'] }]),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['recipe=r', 'message=m'], ctx)).toBe(EXIT.failed);
    expect(io.err.at(-1)).toBe('✗ the daemon closed the conversation before it settled; see its log\n');
  });
});

describe('runCli and the control credential (R4, A12)', () => {
  /** A daemon that answers every route: health, a settled conversation, a launch, a watch that ends. */
  const daemon = () =>
    new FakeFetch((url) => {
      if (url.endsWith('/v1/health')) return json(200, health);
      if (url.endsWith('/v1/conversations')) {
        return ndjson([
          { type: 'posted', message: msg({}), working: ['hewo-1'] },
          {
            type: 'message',
            message: msg({ id: 'm2', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hi.' }),
            working: [],
          },
        ]);
      }
      if (url.endsWith('/v1/agents')) {
        const launched: LaunchEvent = {
          type: 'launched',
          agent: { handle: 'hewo-2', channel: 'main', recipe: 'hello-world', image: 'hello-world' },
        };
        return new Response(wire(launched), SSE_OK);
      }
      const watching: WatchEvent = { type: 'watching', channel: 'main', agents: [] };
      return new Response(wire(watching), SSE_OK);
    });

  it.each([
    [['message=hi'], ['/v1/health', '/v1/conversations']],
    [
      ['--launch', 'recipe=hello-world'],
      ['/v1/health', '/v1/agents'],
    ],
    [['--watch'], ['/v1/health', '/v1/channel?name=main']],
    [['--status'], ['/v1/health']],
    [['--stop'], ['/v1/health']],
  ])('%j sends the credential from daemon.json on every request', async (argv, paths) => {
    const f = daemon();
    let alive = 2;
    const { ctx, home, spawned } = await context({ fetch: f.fetch, isAlive: () => (alive -= 1) > 0 });
    await writeDaemonFile(home, 5555);

    await runCli(argv, ctx);

    expect(f.requests.map((r) => r.url)).toEqual(paths.map((p) => `http://127.0.0.1:5555${p}`));
    expect(f.requests.map(authorization)).toEqual(paths.map(() => `Bearer ${CREDENTIAL}`));
    expect(spawned).toEqual([]);
  });

  it.each([[['message=hi']], [['--status']], [['--stop']], [['--launch', 'recipe=r']], [['--watch']]])(
    '%j reports a 401 naming daemon.json, fails, and never starts a second daemon',
    async (argv) => {
      const f = new FakeFetch(() => json(401, { error: 'invalid control credential' }));
      const { ctx, home, io, spawned, killed } = await context({ fetch: f.fetch });
      await writeDaemonFile(home, 5555);

      expect(await runCli(argv, ctx)).toBe(EXIT.failed);

      expect(io.err).toEqual([
        `✗ the daemon on port 5555 refused the credential in ${join(home, 'daemon.json')} (HTTP 401), so that file is not this daemon's. ` +
          'If no asha daemon is running for this home, remove the file.\n',
      ]);
      expect(io.out).toEqual([]);
      expect(f.requests.map((r) => r.url)).toEqual(['http://127.0.0.1:5555/v1/health']);
      expect(spawned).toEqual([]);
      expect(killed).toEqual([]);
    },
  );

  // Completion review F1: the file's daemon crashed and another server that answers 401 took its port.
  it('treats a daemon file whose pid is dead as stale when its port answers 401: --status says not running', async () => {
    const f = new FakeFetch(() => json(401, { error: 'invalid control credential' }));
    const { ctx, home, io, spawned, killed } = await context({ fetch: f.fetch, isAlive: () => false });
    await writeDaemonFile(home, 5555);

    expect(await runCli(['--status'], ctx)).toBe(EXIT.failed);

    expect(io.err).toEqual([
      '(daemon file names pid 222, which is not running; port 5555 now belongs to another server)\n',
    ]);
    expect(io.out).toEqual(['not running\n']);
    expect(f.requests.map((r) => r.url)).toEqual(['http://127.0.0.1:5555/v1/health']);
    expect(spawned).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("starts a new daemon for a message when the dead daemon's port answers 401", async () => {
    const f = new FakeFetch(() => json(401, { error: 'invalid control credential' }));
    const { ctx, home, io, spawned } = await context({ fetch: f.fetch, isAlive: () => false });
    await writeDaemonFile(home, 5555);

    await runCli(['message=hi'], ctx);

    expect(io.err[0]).toBe(
      '(daemon file names pid 222, which is not running; port 5555 now belongs to another server)\n',
    );
    expect(spawned).toHaveLength(1);
  });

  it('a daemon from before credentials: a message fails saying so and that asha --stop replaces it', async () => {
    const f = new FakeFetch(() => json(200, health));
    const { ctx, home, io, spawned } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555, { pid: 222, port: 5555 });

    expect(await runCli(['message=hi'], ctx)).toBe(EXIT.failed);

    expect(io.err).toEqual([
      '✗ the running daemon (pid 222, port 5555) predates credentials: it serves its API to any local process. Run asha --stop to replace it with this build.\n',
    ]);
    // The old daemon's health was asked without a credential, and nothing else was sent to it.
    expect(f.requests.map((r) => [r.url, authorization(r)])).toEqual([['http://127.0.0.1:5555/v1/health', null]]);
    expect(spawned).toEqual([]);
  });

  it('a daemon from before credentials: --stop stops it as before', async () => {
    const f = new FakeFetch(() => json(200, health));
    let alive = 2;
    const { ctx, home, io, killed } = await context({ fetch: f.fetch, isAlive: () => (alive -= 1) > 0 });
    await writeDaemonFile(home, 5555, { pid: 222, port: 5555 });

    expect(await runCli(['--stop'], ctx)).toBe(EXIT.ok);

    expect(killed).toEqual([[222, 'SIGTERM']]);
    expect(io.out).toEqual(['stopped (pid 222)\n']);
    expect(io.err).toEqual([]);
    expect(f.requests.map(authorization)).toEqual([null]);
  });

  it('a daemon file from before credentials whose daemon is gone is not running, as before', async () => {
    const { ctx, home, io } = await context();
    await writeDaemonFile(home, 5555, { pid: 222, port: 5555 });
    expect(await runCli(['--status'], ctx)).toBe(EXIT.failed);
    expect(io.out).toEqual(['not running\n']);
  });

  it.each([
    ['not json', 'it is not JSON'],
    [{ pid: 'x', port: 1, credential: CREDENTIAL }, 'pid is not a process id ("x")'],
    [{ pid: 222, credential: CREDENTIAL }, 'port is not a TCP port (missing)'],
    [{ pid: 222, port: 70_000, credential: CREDENTIAL }, 'port is not a TCP port (70000)'],
    [{ pid: 222, port: 5555, credential: 7 }, 'credential is not a non-empty string of printable characters'],
    [{ pid: 222, port: 5555, credential: '' }, 'credential is not a non-empty string of printable characters'],
    [[1, 2], 'it is not a JSON object'],
  ])('a daemon.json of %j fails naming the file and what is wrong, and starts nothing', async (content, problem) => {
    const f = daemon();
    const { ctx, home, io, spawned } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555, content);

    for (const argv of [['message=hi'], ['--status'], ['--stop']]) {
      io.err.length = 0;
      expect(await runCli(argv, ctx)).toBe(EXIT.failed);
      expect(io.err).toEqual([
        `✗ ${join(home, 'daemon.json')} cannot be read as a daemon file: ${problem}. If no asha daemon is running for this home, remove it.\n`,
      ]);
    }
    expect(f.requests).toEqual([]);
    expect(spawned).toEqual([]);
    expect(io.out).toEqual([]);
  });

  it('a daemon the CLI started is found through the daemon.json it writes, and its credential is sent', async () => {
    let started = false;
    const f = new FakeFetch((url) => {
      if (!started) throw new TypeError('connect ECONNREFUSED');
      if (url.endsWith('/v1/health')) return json(200, health);
      return ndjson([
        { type: 'posted', message: msg({}), working: ['hewo-1'] },
        {
          type: 'message',
          message: msg({ id: 'm2', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hi.' }),
          working: [],
        },
      ]);
    });
    const t = await context({
      fetch: f.fetch,
      spawnServer: async (paths) => {
        await writeDaemonFile(paths.home, 6000, { pid: 222, port: 6000, credential: 'started-credential' });
        started = true;
        return 222;
      },
    });
    expect(await runCli(['message=hi'], t.ctx)).toBe(EXIT.ok);
    expect(f.requests.filter((r) => r.url.startsWith('http://127.0.0.1:6000')).map(authorization)).toEqual([
      'Bearer started-credential',
      'Bearer started-credential',
    ]);
  });

  it('a 401 while waiting for a daemon it started fails at once instead of waiting out the bound', async () => {
    let started = false;
    const f = new FakeFetch(() => {
      if (!started) throw new TypeError('connect ECONNREFUSED');
      return json(401, { error: 'invalid control credential' });
    });
    const t = await context({
      fetch: f.fetch,
      spawnServer: async (paths) => {
        await writeDaemonFile(paths.home, 6000);
        started = true;
        return 222;
      },
    });
    expect(await runCli(['message=hi'], t.ctx)).toBe(EXIT.failed);
    expect(t.io.err.at(-1)).toContain('refused the credential in');
    expect(f.requests.filter((r) => r.url.startsWith('http://127.0.0.1:6000'))).toHaveLength(1);
  });
});

describe('--interactive (docs/plans/cli-interactive.md R1–R9)', () => {
  const socketCut = () =>
    new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

  /** What each message's conversation answers: the reply text, a failure, or a stream the test holds open. */
  type Answer = string | Response | ((init: RequestInit | undefined) => Response | Promise<Response>);

  /** A conversation stream for a request, echoing its user and text, whose reply is `text` from hewo-1. */
  function answered(body: ConversationRequest, text: string): Response {
    const user = body.user ?? 'user-9';
    return ndjson([
      {
        type: 'posted',
        message: msg({ user, from: user, text: body.message, to: body.to ?? null }),
        working: ['hewo-1'],
      },
      {
        type: 'message',
        message: msg({ id: 'm2', user, from: 'hewo-1', kind: 'status', text: 'ok' }),
        working: ['hewo-1'],
      },
      {
        type: 'message',
        message: msg({ id: 'm3', user, from: 'hewo-1', to: user, kind: 'output', text }),
        working: [],
      },
    ]);
  }

  /**
   * A daemon on port 5555 (and 6000, once daemon.json names it) of this CLI's build, unless `builds` says otherwise.
   * Each message is answered by the next of `answers`, or echoed back when they run out.
   */
  function daemon(
    answers: Answer[] = [],
    builds: Record<number, string> = {},
    channel?: (init: RequestInit | undefined) => Response,
  ) {
    const posted: {
      body: ConversationRequest;
      url: string;
      authorization: string | null;
      signal: AbortSignal | null | undefined;
    }[] = [];
    const f = new FakeFetch(async (url, init) => {
      const port = Number(new URL(url).port);
      if (url.endsWith('/v1/health')) return json(200, { ...health, build: builds[port] ?? health.build });
      if (url.endsWith('/v1/conversations')) {
        const body = JSON.parse(present(init, 'init').body as string) as ConversationRequest;
        posted.push({
          body,
          url,
          authorization: new Headers(init?.headers).get('authorization'),
          signal: init?.signal,
        });
        const answer = answers.shift() ?? `echo: ${body.message}`;
        if (typeof answer === 'string') return answered(body, answer);
        if (answer instanceof Response) return answer;
        return answer(init);
      }
      if (url.includes('/v1/channel') && channel !== undefined) return channel(init);
      throw new Error(`unexpected request ${url}`);
    });
    return { f, posted, messages: () => posted.map((p) => p.body.message) };
  }

  /** A stream the test ends: its body stays open until `end()`, and errors when the request is aborted. */
  function held() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | null | undefined;
    const response = (init: RequestInit | undefined, first: readonly (ConversationEvent | WatchEvent)[] = []) => {
      signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          for (const event of first) c.enqueue(new TextEncoder().encode(wire(event)));
          init?.signal?.addEventListener('abort', () => {
            c.error(present(init.signal, 'init.signal').reason);
          });
        },
      });
      return new Response(body, SSE_OK);
    };
    return {
      response,
      push: (events: readonly unknown[]) => {
        for (const event of events) controller.enqueue(new TextEncoder().encode(wire(event)));
      },
      end: () => {
        controller.close();
      },
      cut: () => {
        controller.error(socketCut());
      },
      signal: () => signal,
    };
  }

  /**
   * Waits (bounded) until `check` holds: the session runs on the event loop beside the test. Bounded by time, not by
   * event-loop turns: the session reads the daemon file with real I/O, which completes off the loop, so under a loaded
   * machine a thousand turns can pass before it does (a count of turns failed the full suite on 2026-09-29).
   */
  async function until(check: () => boolean, what: string) {
    const deadline = Date.now() + 5_000;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    if (!check()) throw new Error(`never happened within 5 s: ${what}`);
  }

  /** Lines where a function runs (and is awaited) before the next line is read: the test acting at the prompt. */
  function scripted(steps: readonly (string | (() => Promise<void> | void))[], log?: string[]) {
    const record = { reads: 0, returned: false };
    let index = 0;
    return {
      record,
      [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
        next: async () => {
          record.reads += 1;
          log?.push('read');
          while (index < steps.length && typeof steps[index] === 'function')
            await (steps[index++] as () => Promise<void>)();
          if (record.returned || index >= steps.length) return { done: true, value: undefined };
          return { done: false, value: steps[index++] as string };
        },
        return: () => {
          record.returned = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
  }

  /** Streams here stay open while the test acts; the idle bound is far past anything a test waits. */
  const TIMING = {
    serverStartMs: 200,
    serverStopMs: 200,
    streamIdleMs: 60_000,
    pollMs: 1,
    uploadAnswerMs: 260_000,
    downloadIdleMs: 30_000,
  };

  async function session(
    argv: readonly string[],
    lines: AsyncIterable<string>,
    over: Partial<CliContext> = {},
    port = 5555,
  ) {
    const t = await context({ input: { lines, isTerminal: false }, timing: TIMING, ...over });
    await writeDaemonFile(t.home, port);
    const code = await runCli(['--interactive', ...argv], t.ctx);
    return { code, out: t.io.out, err: t.io.err, home: t.home, ctx: t.ctx };
  }

  describe('arguments (R1, A1)', () => {
    it.each([
      [['--interactive', 'message=x'], '--interactive takes no message=: type each message after it starts'],
      [['--interactive', '--launch', 'recipe=r'], '--interactive cannot be combined with --launch'],
      [['--watch', '--interactive'], '--interactive cannot be combined with --watch'],
      [['--interactive', '--status'], '--interactive cannot be combined with --status'],
      [['--interactive', '--stop'], '--interactive cannot be combined with --stop'],
      [['--interactive', '--server'], '--interactive cannot be combined with --server'],
      [['--interactive', '--help'], '--interactive cannot be combined with --help'],
      [['--interactive', 'user=bob', 'user=eve'], 'user= given twice'],
      [['--interactive', 'to='], 'to= is empty'],
      [['--interactive', 'hello'], 'unrecognized argument: hello'],
    ])('%j is a usage error naming the conflict, reading and sending nothing', async (argv, problem) => {
      const f = new FakeFetch(() => {
        throw new Error('fetch not expected');
      });
      // NOT_INTERACTIVE's input fails the test if it is read.
      const { ctx, io, spawned } = await context({ fetch: f.fetch });
      expect(await runCli(argv, ctx)).toBe(EXIT.usage);
      expect(io.err).toEqual([`${problem}\n\n${USAGE}`]);
      expect([io.out, f.requests, spawned]).toEqual([[], [], []]);
    });

    it('parseInteractiveArgs reads the session, defaulting the channel', () => {
      expect(parseInteractiveArgs(['user=bob', 'recipe=hello-world', 'to=hewo-1', 'channel=lab'])).toEqual({
        user: 'bob',
        recipe: 'hello-world',
        to: 'hewo-1',
        channel: 'lab',
      });
      expect(parseInteractiveArgs([])).toEqual({ channel: 'main' });
    });

    it('sends recipe= with every message, so each may bring the agent online, and never launches one', async () => {
      const d = daemon();
      const s = await session(['user=bob', 'recipe=hello-world'], fromLines(['one', 'two']), { fetch: d.f.fetch });
      expect(s.code).toBe(EXIT.ok);
      expect(d.posted.map((p) => p.body)).toEqual([
        { user: 'bob', channel: 'main', recipe: 'hello-world', message: 'one' },
        { user: 'bob', channel: 'main', recipe: 'hello-world', message: 'two' },
      ]);
      expect(d.f.requests.filter((r) => r.url.includes('/v1/agents'))).toEqual([]);
    });

    it('to= and channel= go with every message', async () => {
      const d = daemon();
      await session(['user=bob', 'to=hewo-2', 'channel=lab'], fromLines(['one']), { fetch: d.f.fetch });
      expect(d.posted.map((p) => p.body)).toEqual([{ user: 'bob', channel: 'lab', to: 'hewo-2', message: 'one' }]);
    });

    // R16 (A15 (d), A2): without user=, the session speaks as the converted login name.
    it('without user= speaks as the login name, every message, reading loginName once', async () => {
      const d = daemon();
      let reads = 0;
      const s = await session([], fromLines(['one', 'two']), {
        fetch: d.f.fetch,
        loginName: () => {
          reads += 1;
          return 'olga';
        },
      });
      expect(s.code).toBe(EXIT.ok);
      expect(d.posted.map((p) => p.body.user)).toEqual(['olga', 'olga']);
      expect([reads, s.err]).toEqual([1, []]);
    });

    it('a login name the conversion changes is announced once, before the first prompt, with and without --verbose', async () => {
      for (const flags of [[], ['--verbose']]) {
        const d = daemon();
        const log: string[] = [];
        const lines = scripted(['one', 'two'], log);
        const t = await context({
          fetch: d.f.fetch,
          input: { lines, isTerminal: true },
          loginName: () => 'Olga',
          stderr: (text) => log.push(text),
        });
        await writeDaemonFile(t.home, 5555);
        expect(await runCli(['--interactive', ...flags], t.ctx)).toBe(EXIT.ok);
        expect(d.posted.map((p) => p.body.user)).toEqual(['olga', 'olga']);
        const line = '› your login name "Olga" is sent as user ID "olga"\n';
        expect(log.filter((l) => l === line)).toHaveLength(1);
        expect(log.indexOf(line)).toBe(0);
        expect(log[1]).toBe(PROMPT);
      }
    });

    // Review finding 5: pinned to the converted name, not a literal that happens to equal it.
    it('a session speaks as the converted login name on every message: John.Smith as john-smith', async () => {
      const d = daemon();
      const s = await session([], fromLines(['one', 'two']), { fetch: d.f.fetch, loginName: () => 'John.Smith' });
      expect(s.code).toBe(EXIT.ok);
      expect(d.posted.map((p) => p.body.user)).toEqual(['john-smith', 'john-smith']);
      expect(s.err).toEqual(['› your login name "John.Smith" is sent as user ID "john-smith"\n']);
    });

    it('a first message that fails before it is posted leaves the next still as the login name', async () => {
      const d = daemon([ndjson([{ type: 'error', reason: 'unknown_recipe', detail: 'no recipe named "x"' }])]);
      const s = await session([], fromLines(['one', 'two']), { fetch: d.f.fetch });
      expect(d.posted.map((p) => p.body.user)).toEqual(['olga', 'olga']);
      expect(s.code).toBe(EXIT.failed);
    });

    it('a login name that still breaks the rule ends the session before the prompt, reading and sending nothing', async () => {
      const f = new FakeFetch(() => {
        throw new Error('fetch not expected');
      });
      const { ctx, io, spawned } = await context({
        fetch: f.fetch,
        loginName: () => '_admin',
        input: { ...NOT_INTERACTIVE.input, isTerminal: true },
      });
      expect(await runCli(['--interactive', 'recipe=hello-world'], ctx)).toBe(EXIT.failed);
      expect(io.err).toEqual([
        '✗ your login name "_admin" converts to "-admin", which cannot be a user ID: a user ID is 1 to 32 characters: a lowercase letter, then lowercase letters, digits or hyphens; type user=<id> to choose one\n',
      ]);
      expect([io.out, f.requests, spawned]).toEqual([[], [], []]);
    });

    it('with user= the login name is never read', async () => {
      const d = daemon();
      const s = await session(['user=bob'], fromLines(['one']), {
        fetch: d.f.fetch,
        loginName: () => {
          throw new Error('loginName not expected');
        },
      });
      expect([s.code, d.posted.map((p) => p.body.user)]).toEqual([EXIT.ok, ['bob']]);
    });
  });

  describe('lines and the user (R2, R3, R8, A2)', () => {
    it('posts each non-blank line as typed, key=value and all, as one user', async () => {
      const d = daemon();
      const s = await session(['user=bob'], fromLines(['hello', '', '   \t', 'a key=v', '  padded  ']), {
        fetch: d.f.fetch,
      });
      expect(s.code).toBe(EXIT.ok);
      expect(d.posted.map((p) => p.body)).toEqual([
        { user: 'bob', channel: 'main', message: 'hello' },
        { user: 'bob', channel: 'main', message: 'a key=v' },
        { user: 'bob', channel: 'main', message: '  padded  ' },
      ]);
      expect(s.out).toEqual(['echo: hello\n', 'echo: a key=v\n', 'echo:   padded  \n']);
    });

    it('names the user on each posted line only with --verbose', async () => {
      const quiet = await session(['user=bob'], fromLines(['hello', 'again']), { fetch: daemon().f.fetch });
      expect(quiet.err.filter((line) => line.includes('bob'))).toEqual([]);
      const verbose = await session(['user=bob', '--verbose'], fromLines(['hello', 'again']), {
        fetch: daemon().f.fetch,
      });
      expect(verbose.err.filter((line) => line.includes('bob →'))).toEqual([
        '› bob → main: hello\n',
        '› bob → main: again\n',
      ]);
    });

    it('a message that fails before it is posted, or is refused, is reported; the session goes on as the same user and exits 1', async () => {
      const d = daemon([
        ndjson([{ type: 'error', reason: 'unknown_recipe', detail: 'no recipe named "x"' }]),
        json(400, { error: 'request body over 1048576 bytes' }),
      ]);
      const s = await session(['user=bob'], fromLines(['first', 'x'.repeat(1_100_000), 'third']), { fetch: d.f.fetch });
      expect(s.code).toBe(EXIT.failed);
      expect(d.posted.map((p) => [p.body.user, p.body.message.length])).toEqual([
        ['bob', 5],
        ['bob', 1_100_000],
        ['bob', 5],
      ]);
      expect(s.err).toEqual([
        '✗ unknown_recipe: no recipe named "x"\n',
        '✗ the daemon rejected the message: HTTP 400: {"error":"request body over 1048576 bytes"}\n',
      ]);
      expect(s.out).toEqual(['echo: third\n']);
    });

    it('readLines keeps a character split across two chunks whole, and drops each line ending', async () => {
      const bytes = Buffer.from('héllo wörld 👋\r\nsecond\nlast without newline');
      const input = new PassThrough();
      const d = daemon();
      const running = session(['user=bob'], readLines(input), { fetch: d.f.fetch });
      // é is 2 bytes at offset 1; 👋 is 4 bytes: split both.
      const wave = bytes.indexOf(Buffer.from('👋'));
      for (const [from, to] of [
        [0, 2],
        [2, wave + 2],
        [wave + 2, bytes.length],
      ] as const)
        input.write(bytes.subarray(from, to));
      input.end();
      expect((await running).code).toBe(EXIT.ok);
      expect(d.messages()).toEqual(['héllo wörld 👋', 'second', 'last without newline']);
    });
  });

  // Review finding 3: the reader's bound on lines held unread, and its error path.
  describe('readLines', () => {
    it('pauses its input at 64 unread lines and resumes once the session has read them down to 32', async () => {
      const input = new PassThrough();
      const lines = readLines(input)[Symbol.asyncIterator]();
      input.write(Array.from({ length: 70 }, (_, i) => `line ${String(i)}\n`).join(''));
      await until(() => input.isPaused(), 'the input paused');
      const read: string[] = [];
      for (let i = 0; i < 37; i += 1) {
        read.push((await lines.next()).value as string);
        // Paused while more than 32 lines are held.
        if (i < 37) expect(input.isPaused(), `after ${String(i + 1)} reads`).toBe(true);
      }
      read.push((await lines.next()).value as string);
      expect(input.isPaused()).toBe(false);
      expect(read).toEqual(Array.from({ length: 38 }, (_, i) => `line ${String(i)}`));
      if (lines.return === undefined)
        throw new Error("lines.return is missing (received undefined); the caller's invariant does not hold");
      await lines.return();
      expect(input.destroyed).toBe(true);
    });

    it("rejects a pending read with the input's error", async () => {
      const input = new PassThrough();
      const lines = readLines(input)[Symbol.asyncIterator]();
      const pending = lines.next();
      input.destroy(new Error('read EIO'));
      await expect(pending).rejects.toThrow('read EIO');
    });

    // Review finding 5: the input failing is an expected external failure, reported, not a stack.
    it('a session whose input fails reports it and exits 1', async () => {
      const input = new PassThrough();
      const d = daemon();
      const running = session(['user=bob'], readLines(input), { fetch: d.f.fetch });
      input.write('hello\n');
      await until(() => d.posted.length === 1, 'the first message');
      await new Promise((resolve) => setImmediate(resolve));
      input.destroy(new Error('read EIO'));
      const s = await running;
      expect(s.code).toBe(EXIT.failed);
      expect(s.out).toEqual(['echo: hello\n']);
      expect(s.err).toEqual(['✗ reading your input failed: read EIO\n']);
    });
  });

  describe('one message at a time, each finding the daemon (R4, R11, A3)', () => {
    it('prints the replies in order, and posts a line typed early only after the message before it settles', async () => {
      const first = held();
      const order: string[] = [];
      const d = daemon([
        (init) =>
          first.response(init, [{ type: 'posted', message: msg({ user: 'bob', from: 'bob' }), working: ['hewo-1'] }]),
        'two',
      ]);
      const input = new PassThrough();
      const wrapped = new FakeFetch((url, init) => {
        if (url.endsWith('/v1/conversations'))
          order.push(`post ${(JSON.parse(present(init, 'init').body as string) as ConversationRequest).message}`);
        return d.f.fetch(url, init);
      });
      const running = session(['user=bob'], readLines(input), { fetch: wrapped.fetch });
      input.write('one\ntwo\n');
      await until(() => d.posted.length === 1, 'the first message posted');
      // Both lines are typed; the second waits while the first is worked on.
      await new Promise((resolve) => setImmediate(resolve));
      expect(d.posted).toHaveLength(1);
      order.push('first settles');
      first.push([
        {
          type: 'message',
          message: msg({ id: 'm3', user: 'bob', from: 'hewo-1', to: 'bob', kind: 'output', text: 'one' }),
          working: [],
        },
      ]);
      first.end();
      await until(() => d.posted.length === 2, 'the second message posted');
      input.end();
      const s = await running;
      expect(s.code).toBe(EXIT.ok);
      expect(order).toEqual(['post one', 'first settles', 'post two']);
      expect(s.out).toEqual(['one\n', 'two\n']);
    });

    it('reads daemon.json for every message: a restarted daemon on a new port with a new credential is used', async () => {
      const d = daemon();
      let home = '';
      const lines = scripted([
        'one',
        async () => writeDaemonFile(home, 6000, { pid: 333, port: 6000, credential: 'second-credential' }),
        'two',
      ]);
      const t = await context({ fetch: d.f.fetch, input: { lines, isTerminal: false }, timing: TIMING });
      home = t.home;
      await writeDaemonFile(home, 5555);
      expect(await runCli(['--interactive', 'user=bob'], t.ctx)).toBe(EXIT.ok);
      expect(d.posted.map((p) => [p.url, p.authorization])).toEqual([
        ['http://127.0.0.1:5555/v1/conversations', `Bearer ${CREDENTIAL}`],
        ['http://127.0.0.1:6000/v1/conversations', 'Bearer second-credential'],
      ]);
    });

    it('warns about a daemon of another build once per build in a session, and again for a third build', async () => {
      const d = daemon([], { 5555: 'old-build-a', 6000: 'old-build-b' });
      let home = '';
      const lines = scripted(['one', 'two', async () => writeDaemonFile(home, 6000), 'three']);
      const t = await context({ fetch: d.f.fetch, input: { lines, isTerminal: false }, timing: TIMING });
      home = t.home;
      await writeDaemonFile(home, 5555);
      expect(await runCli(['--interactive', 'user=bob'], t.ctx)).toBe(EXIT.ok);
      // Exact literal text around the captured build (commands.ts's one template for this warning), not `.*`, so the
      // regex cannot backtrack super-linearly (sonarjs/super-linear-regex).
      const BUILD_WARNING =
        /^⚠ the running daemon \([^)]*\) runs a different build \(([^)]*)\) than this asha \([^)]*\), and so do its agents\. Run asha --stop to use this build\.\n$/;
      expect(t.io.err.map((line) => line.replace(BUILD_WARNING, '⚠ $1'))).toEqual(['⚠ old-build-a', '⚠ old-build-b']);
      expect(d.messages()).toEqual(['one', 'two', 'three']);
    });
  });

  describe('commands and the end of a session (R5, A4, A10)', () => {
    it('/quit ends the session with 0, sending nothing', async () => {
      const d = daemon();
      const s = await session(['user=bob'], fromLines(['/quit']), { fetch: d.f.fetch });
      expect([s.code, d.posted, s.out, s.err]).toEqual([EXIT.ok, [], [], []]);
    });

    it('lines after /quit are neither read nor posted', async () => {
      const d = daemon();
      const lines = fromLines(['a', '/quit', 'b']);
      const s = await session(['user=bob'], lines, { fetch: d.f.fetch });
      expect(s.code).toBe(EXIT.ok);
      expect(d.messages()).toEqual(['a']);
      expect(lines.record).toEqual({ reads: 2, returned: true });
    });

    it('the end of input ends the session once every queued line was posted and settled, in order', async () => {
      const first = held();
      const d = daemon([
        (init) =>
          first.response(init, [{ type: 'posted', message: msg({ user: 'bob', from: 'bob' }), working: ['hewo-1'] }]),
      ]);
      const input = new PassThrough();
      const running = session(['user=bob'], readLines(input), { fetch: d.f.fetch });
      input.end('one\ntwo\nthree\n');
      await until(() => d.posted.length === 1, 'the first message posted');
      first.push([
        {
          type: 'message',
          message: msg({ id: 'm3', user: 'bob', from: 'hewo-1', to: 'bob', kind: 'output', text: 'one' }),
          working: [],
        },
      ]);
      first.end();
      const s = await running;
      expect(s.code).toBe(EXIT.ok);
      expect(d.messages()).toEqual(['one', 'two', 'three']);
      expect(s.out).toEqual(['one\n', 'echo: two\n', 'echo: three\n']);
    });

    it.each([
      [['/help'], 'unknown command /help; type /quit to leave\n'],
      [['/watch'], 'unknown command /watch; type /quit to leave\n'],
      [['/quit now'], 'unknown command /quit; type /quit to leave\n'],
      [['  /Nosuchword  '], 'unknown command /Nosuchword; type /quit to leave\n'],
    ])('%j is an unknown command: printed, not posted, and the session exits 1', async (lines, line) => {
      const d = daemon();
      const s = await session(['user=bob'], fromLines(lines), { fetch: d.f.fetch });
      expect([s.code, d.posted, s.out, s.err]).toEqual([EXIT.failed, [], [], [line]]);
    });

    it('a failed message followed by /quit exits 1', async () => {
      const d = daemon([ndjson([{ type: 'error', reason: 'unknown_handle', detail: 'no agent "x"' }])]);
      const s = await session(['user=bob'], fromLines(['hi', '/quit']), { fetch: d.f.fetch });
      expect(s.code).toBe(EXIT.failed);
    });

    it('a line that starts with an existing path is a message; /nosuchword is a command', async () => {
      const d = daemon();
      const s = await session(
        ['user=bob'],
        fromLines(['/tmp', '/Users', '/Users/me/report.pdf please', '/nosuchword']),
        { fetch: d.f.fetch },
      );
      expect(d.messages()).toEqual(['/tmp', '/Users', '/Users/me/report.pdf please']);
      expect(s.err).toEqual(['unknown command /nosuchword; type /quit to leave\n']);
      expect(s.code).toBe(EXIT.failed);
    });
  });

  describe('the prompt and Ctrl-C (R6, R7, A5)', () => {
    it('shows "asha> " on stderr before each line is read from a terminal', async () => {
      const log: string[] = [];
      const lines = scripted(['one', '/quit'], log);
      const t = await context({
        fetch: daemon().f.fetch,
        input: { lines, isTerminal: true },
        stderr: (text) => log.push(text),
      });
      await writeDaemonFile(t.home, 5555);
      expect(await runCli(['--interactive', 'user=bob'], t.ctx)).toBe(EXIT.ok);
      expect(log).toEqual([PROMPT, 'read', PROMPT, 'read']);
    });

    it('shows no prompt when input is piped', async () => {
      const s = await session(['user=bob'], fromLines(['one', 'two']), { fetch: daemon().f.fetch });
      expect(s.err).toEqual([]);
      expect(s.out).toEqual(['echo: one\n', 'echo: two\n']);
    });

    it('Ctrl-C while a message is in flight exits 130 at once, hangs up its request, and posts nothing queued', async () => {
      const inflight = held();
      let interrupt!: () => void;
      const d = daemon([
        (init) => {
          setImmediate(() => {
            interrupt();
          });
          return inflight.response(init, [
            { type: 'posted', message: msg({ user: 'bob', from: 'bob' }), working: ['hewo-1'] },
          ]);
        },
      ]);
      const lines = fromLines(['a', 'b']);
      const s = await session(['user=bob'], lines, {
        fetch: d.f.fetch,
        interrupt: () => new Promise<void>((resolve) => (interrupt = resolve)),
      });
      expect(s.code).toBe(EXIT.interrupted);
      expect(inflight.signal()?.aborted).toBe(true);
      expect(d.messages()).toEqual(['a']);
      expect(lines.record).toEqual({ reads: 1, returned: true });
      expect([s.out, s.err]).toEqual([[], []]);
    });

    it('Ctrl-C at the prompt exits 130 and closes the input', async () => {
      const input = new PassThrough();
      let interrupt: (() => void) | undefined;
      const running = session(['user=bob'], readLines(input), {
        fetch: daemon().f.fetch,
        interrupt: () => new Promise<void>((resolve) => (interrupt = resolve)),
      });
      await until(() => interrupt !== undefined, 'the session to start');
      await new Promise((resolve) => setImmediate(resolve));
      present(interrupt, 'interrupt')();
      const s = await running;
      expect(s.code).toBe(EXIT.interrupted);
      expect(input.destroyed).toBe(true);
    });

    // Review finding 13: the terminal shows `asha> ^C`; what follows starts on a line of its own.
    it('Ctrl-C at a terminal prompt ends the prompt line', async () => {
      const input = new PassThrough();
      let interrupt!: () => void;
      const t = await context({
        fetch: daemon().f.fetch,
        input: { lines: readLines(input), isTerminal: true },
        interrupt: () => new Promise<void>((resolve) => (interrupt = resolve)),
      });
      await writeDaemonFile(t.home, 5555);
      const running = runCli(['--interactive', 'user=bob'], t.ctx);
      await until(() => t.io.err.length === 1, 'the prompt');
      interrupt();
      expect(await running).toBe(EXIT.interrupted);
      expect(t.io.err).toEqual([PROMPT, '\n']);
    });

    // Completion review, finding 4: /watch on waits for the daemon to watch the channel; Ctrl-C must end that wait.
    it('Ctrl-C while /watch on waits for the channel exits 130 at once and hangs up the view', async () => {
      const channel = held();
      let interrupt!: () => void;
      const f = new FakeFetch((url, init) => {
        if (url.endsWith('/v1/health')) return json(200, health);
        // The daemon never says it watches the channel; Ctrl-C arrives while the session waits for it.
        setImmediate(() => {
          interrupt();
        });
        return channel.response(init);
      });
      const lines = fromLines(['/watch on', 'never sent']);
      const s = await session(['user=bob'], lines, {
        fetch: f.fetch,
        interrupt: () => new Promise<void>((resolve) => (interrupt = resolve)),
      });
      expect(s.code).toBe(EXIT.interrupted);
      expect(channel.signal()?.aborted).toBe(true);
      expect(lines.record).toEqual({ reads: 1, returned: true });
      expect(f.requests.filter((r) => r.url.endsWith('/v1/conversations'))).toEqual([]);
    });

    it('Ctrl-C while the daemon is being started stops waiting for it at once', async () => {
      let interrupt!: () => void;
      const f = new FakeFetch(() => {
        throw new TypeError('connect ECONNREFUSED');
      });
      const t = await context({
        fetch: f.fetch,
        input: { lines: fromLines(['a']), isTerminal: false },
        interrupt: () => new Promise<void>((resolve) => (interrupt = resolve)),
        // The daemon never answers; the first poll is where Ctrl-C arrives.
        sleep: () => {
          interrupt();
          return Promise.resolve();
        },
        timing: {
          serverStartMs: 60_000,
          serverStopMs: 200,
          streamIdleMs: 200,
          pollMs: 1,
          uploadAnswerMs: 260_000,
          downloadIdleMs: 30_000,
        },
      });
      expect(await runCli(['--interactive', 'user=bob'], t.ctx)).toBe(EXIT.interrupted);
      expect(t.spawned).toHaveLength(1);
      expect([t.io.out, t.io.err]).toEqual([[], []]);
    });
  });

  describe('/watch on and /watch off (R9, A7)', () => {
    it('switches between the replies and the whole channel, and survives a cut channel stream', async () => {
      const channels: ReturnType<typeof held>[] = [];
      const say = (text: string, body: ConversationRequest): Response =>
        ndjson([
          {
            type: 'posted',
            message: msg({ user: 'bob', from: 'bob', text: body.message, to: 'hewo-1' }),
            working: ['hewo-1'],
          },
          {
            type: 'message',
            message: msg({ id: 'm2', user: 'bob', from: 'hewo-1', to: 'hewo-2', kind: 'internal', text: 'Say: hi' }),
            working: ['hewo-2'],
          },
          {
            type: 'message',
            message: msg({ id: 'm3', user: 'bob', from: 'hewo-2', to: 'bob', kind: 'output', text }),
            working: [],
          },
        ]);
      const at = '2026-09-28T10:00:00.000Z';
      const watched = {
        input: msg({
          id: 'w1',
          conversation: 'c0000001aaaa',
          user: 'bob',
          from: 'bob',
          to: 'hewo-1',
          text: 'Please ask hewo-2 to say hi',
          at,
        }),
        internal: msg({
          id: 'w2',
          conversation: 'c0000001aaaa',
          user: 'bob',
          from: 'hewo-1',
          to: 'hewo-2',
          kind: 'internal',
          text: 'Say: hi',
          at,
        }),
        reply: msg({
          id: 'w3',
          conversation: 'c0000001aaaa',
          user: 'bob',
          from: 'hewo-2',
          to: 'bob',
          kind: 'output',
          text: 'hi',
          at,
        }),
        other: msg({ id: 'w4', conversation: 'c0000002bbbb', user: 'carol', from: 'carol', text: 'anyone there?', at }),
      };
      let conversations = 0;
      const f = new FakeFetch((url, init) => {
        if (url.endsWith('/v1/health')) return json(200, health);
        if (url.includes('/v1/channel')) {
          const channel = held();
          channels.push(channel);
          return channel.response(init, [{ type: 'watching', channel: 'main', agents: ['hewo-1', 'hewo-2'] }]);
        }
        conversations += 1;
        const body = JSON.parse(present(init, 'init').body as string) as ConversationRequest;
        // The second message is sent with the channel view on: the channel carries it too.
        if (conversations === 2)
          present(channels[0], 'channels[0]').push(
            [watched.input, watched.internal, watched.reply].map((message) => ({ type: 'message', message })),
          );
        return say('hi', body);
      });
      let out: string[] = [];
      let err: string[] = [];
      const printed = (line: string) => out.includes(line);
      const lines = scripted([
        'Please ask hewo-2 to say hi',
        '/watch on',
        'Please ask hewo-2 to say hi',
        async () => {
          await until(() => printed('10:00:00Z [c0000001] output hewo-2 → bob: hi\n'), 'the reply on the channel view');
          // Another user speaks while the prompt waits.
          present(channels[0], 'channels[0]').push([{ type: 'message', message: watched.other }]);
          await until(
            () => printed('10:00:00Z [c0000002] input carol → all agents: anyone there?\n'),
            "carol's message on the channel view",
          );
        },
        '/watch on',
        '/watch off',
        '/watch off',
        'Please ask hewo-2 to say hi',
        '/watch sideways',
        '/watch on',
        async () => {
          await until(() => channels.length === 2, 'the second channel stream');
          present(channels[1], 'channels[1]').cut();
          await until(() => err.some((line) => line.startsWith('✗')), 'the cut reported');
        },
        'Please ask hewo-2 to say hi',
      ]);
      const t = await context({ fetch: f.fetch, input: { lines, isTerminal: false }, timing: TIMING });
      out = t.io.out;
      err = t.io.err;
      await writeDaemonFile(t.home, 5555);

      expect(await runCli(['--interactive', 'user=bob'], t.ctx)).toBe(EXIT.failed);

      expect(out).toEqual([
        'hi\n',
        '10:00:00Z [c0000001] input bob → hewo-1: Please ask hewo-2 to say hi\n',
        '10:00:00Z [c0000001] internal hewo-1 → hewo-2: Say: hi\n',
        '» reply from hewo-2:\n',
        '10:00:00Z [c0000001] output hewo-2 → bob: hi\n',
        '10:00:00Z [c0000002] input carol → all agents: anyone there?\n',
        'hi\n',
        'hi\n',
      ]);
      expect(err).toEqual([
        'watching the channel\n',
        'watching the channel\n',
        'replies only\n',
        'replies only\n',
        'unknown command /watch; type /quit to leave\n',
        'watching the channel\n',
        '✗ the daemon closed the channel stream (other side closed)\n',
      ]);
      // Only the four messages were posted; the first channel stream was hung up by /watch off.
      expect(f.requests.filter((r) => r.url.endsWith('/v1/conversations'))).toHaveLength(4);
      expect(channels.map((c) => c.signal()?.aborted)).toEqual([true, false]);
    });

    // Else a message right after /watch on could reach the channel before the view is subscribed, and its reply,
    // which the conversation then does not print, would be printed nowhere.
    it('/watch on returns only once the daemon says the channel is watched', async () => {
      const order: string[] = [];
      let channel!: ReturnType<typeof held>;
      const f = new FakeFetch((url, init) => {
        if (url.endsWith('/v1/health')) return json(200, health);
        if (url.includes('/v1/channel')) {
          channel = held();
          const response = channel.response(init);
          // The daemon is slow to say so: a thousand turns of the event loop, or until a message arrives first.
          void (async () => {
            for (let i = 0; i < 1_000 && !order.includes('message posted'); i += 1)
              await new Promise((resolve) => setImmediate(resolve));
            order.push('channel watched');
            channel.push([{ type: 'watching', channel: 'main', agents: [] }]);
          })();
          return response;
        }
        order.push('message posted');
        // As the daemon does, the channel carries the reply too.
        channel.push([
          { type: 'message', message: msg({ id: 'w1', from: 'hewo-1', to: 'bob', kind: 'output', text: 'hi' }) },
        ]);
        return answered(JSON.parse(present(init, 'init').body as string) as ConversationRequest, 'hi');
      });
      const s = await session(['user=bob'], fromLines(['/watch on', 'hello']), { fetch: f.fetch });
      expect(s.code).toBe(EXIT.ok);
      expect(order).toEqual(['channel watched', 'message posted']);
    });

    // The two streams are separate connections: the conversation can settle before the channel view has printed
    // its reply, and at the end of input the session would otherwise leave with the reply printed nowhere.
    it('with the view on, a message is done only once the view has printed its replies', async () => {
      const channel = held();
      const reply = msg({
        id: 'w3',
        conversation: 'c0000001aaaa',
        user: 'bob',
        from: 'hewo-1',
        to: 'bob',
        kind: 'output',
        text: 'late hi',
        at: '2026-09-28T10:00:00.000Z',
      });
      const d = daemon(
        [
          () => {
            void (async () => {
              for (let i = 0; i < 1_000; i += 1) await new Promise((resolve) => setImmediate(resolve));
              channel.push([{ type: 'message', message: reply }]);
            })();
            return answered({ user: 'bob', channel: 'main', message: 'hello' }, 'late hi');
          },
        ],
        {},
        (init) => channel.response(init, [{ type: 'watching', channel: 'main', agents: ['hewo-1'] }]),
      );
      const s = await session(['user=bob'], fromLines(['/watch on', 'hello']), { fetch: d.f.fetch });
      expect(s.code).toBe(EXIT.ok);
      expect(s.out).toEqual(['» reply from hewo-1:\n', '10:00:00Z [c0000001] output hewo-1 → bob: late hi\n']);
    });

    // Review finding 1: a healthy view (heartbeats) that never carries the reply must not hold the session forever.
    it('a reply the view never shows is printed from the conversation after the stream-silence bound, with a warning', async () => {
      const channel = held();
      // The heartbeats run exactly while the view's stream is open: from its response until its request is
      // aborted. Started before the response, a beat found no stream to write to (an unhandled TypeError that
      // failed `npm test` under load, the completion reviews of 2026-09-29).
      let beat: ReturnType<typeof setInterval> | undefined;
      const d = daemon([], {}, (init) => {
        const view = channel.response(init, [{ type: 'watching', channel: 'main', agents: ['hewo-1'] }]);
        clearInterval(beat);
        beat = setInterval(() => {
          channel.push([{ type: 'heartbeat' }]);
        }, 5);
        init?.signal?.addEventListener('abort', () => {
          clearInterval(beat);
        });
        return view;
      });
      try {
        const s = await session(['user=bob'], fromLines(['/watch on', 'hello']), {
          fetch: d.f.fetch,
          timing: { ...TIMING, streamIdleMs: 100 },
        });
        expect(s.code).toBe(EXIT.ok);
        expect(s.out).toEqual(['echo: hello\n']);
        expect(s.err).toEqual([
          'watching the channel\n',
          '⚠ the channel view did not show this reply within 100 ms; printed from the conversation:\n',
        ]);
      } finally {
        clearInterval(beat);
      }
    });

    // Review finding 2: a view cut while a message is in flight must not lose that message's reply.
    it('a view cut while a message is in flight: its reply is printed from the conversation, and the cut is a failure', async () => {
      const channel = held();
      const d = daemon(
        [
          () => {
            channel.cut();
            return answered({ user: 'bob', channel: 'main', message: 'hello' }, 'the reply');
          },
        ],
        {},
        (init) => channel.response(init, [{ type: 'watching', channel: 'main', agents: ['hewo-1'] }]),
      );
      const s = await session(['user=bob'], fromLines(['/watch on', 'hello']), { fetch: d.f.fetch });
      expect(s.code).toBe(EXIT.failed);
      expect(s.out).toEqual(['the reply\n']);
      expect(s.err).toEqual(['watching the channel\n', '✗ the daemon closed the channel stream (other side closed)\n']);
    });

    // Review finding 10: replies to this user from elsewhere must not satisfy a later message's wait.
    it("a reply to the same user from another conversation, shown earlier, does not stand in for this message's reply", async () => {
      const channel = held();
      const at = '2026-09-28T10:00:00.000Z';
      const early = msg({
        id: 'x1',
        conversation: 'c0000009zzzz',
        from: 'hewo-1',
        to: 'bob',
        kind: 'output',
        text: 'echo: hello',
        at,
      });
      const late = msg({
        id: 'x2',
        conversation: 'c0000001aaaa',
        from: 'hewo-1',
        to: 'bob',
        kind: 'output',
        text: 'echo: hello',
        at,
      });
      let out: string[] = [];
      const d = daemon(
        [
          () => {
            void (async () => {
              for (let i = 0; i < 1_000; i += 1) await new Promise((resolve) => setImmediate(resolve));
              channel.push([{ type: 'message', message: late }]);
            })();
            return answered({ user: 'bob', channel: 'main', message: 'hello' }, 'echo: hello');
          },
        ],
        {},
        (init) => channel.response(init, [{ type: 'watching', channel: 'main', agents: ['hewo-1'] }]),
      );
      const lines = scripted([
        '/watch on',
        async () => {
          channel.push([{ type: 'message', message: early }]);
          await until(() => out.length === 2, 'the earlier reply shown');
        },
        'hello',
      ]);
      const t = await context({ fetch: d.f.fetch, input: { lines, isTerminal: false }, timing: TIMING });
      out = t.io.out;
      await writeDaemonFile(t.home, 5555);
      expect(await runCli(['--interactive', 'user=bob'], t.ctx)).toBe(EXIT.ok);
      // The session waited for this message's own copy: both are printed, the later one last.
      expect(out.filter((line) => line.startsWith('10:00:00Z'))).toEqual([
        '10:00:00Z [c0000009] output hewo-1 → bob: echo: hello\n',
        '10:00:00Z [c0000001] output hewo-1 → bob: echo: hello\n',
      ]);
    });

    it('a channel stream cut with nothing else wrong still fails the session, and does not reconnect', async () => {
      const channel = held();
      const d = daemon([], {}, (init) => channel.response(init, [{ type: 'watching', channel: 'main', agents: [] }]));
      let err: string[] = [];
      const lines = scripted([
        '/watch on',
        async () => {
          await until(() => d.f.requests.some((r) => r.url.includes('/v1/channel')), 'the channel stream');
          channel.cut();
          await until(() => err.length === 2, 'the cut reported');
        },
        'hi',
      ]);
      const t = await context({ fetch: d.f.fetch, input: { lines, isTerminal: false }, timing: TIMING });
      err = t.io.err;
      await writeDaemonFile(t.home, 5555);
      expect(await runCli(['--interactive', 'user=bob'], t.ctx)).toBe(EXIT.failed);
      expect(err).toEqual(['watching the channel\n', '✗ the daemon closed the channel stream (other side closed)\n']);
      // The view is off: the reply comes from the conversation, and no second channel stream was opened.
      expect(t.io.out).toEqual(['echo: hi\n']);
      expect(d.f.requests.filter((r) => r.url.includes('/v1/channel'))).toHaveLength(1);
    });

    // model-streaming R7, amendment 3: the conversation and the view both carry the deltas; only the view prints them.
    it('with --verbose and /watch on, each model delta is printed once, by the view; with the view off, by the conversation', async () => {
      const delta = (text: string, seq: number) => ({
        type: 'model_delta',
        handle: 'hewo-1',
        conversation: 'c0000001aaaa',
        call: 's1',
        seq,
        part: 'tool_args',
        index: 0,
        name: 'reply',
        text,
      });
      const DELTAS = [
        delta('{"text":', 0),
        delta('"hi"}', 1),
        { type: 'model_done', handle: 'hewo-1', conversation: 'c0000001aaaa', call: 's1', outcome: 'ok' },
      ];
      const at = '2026-09-28T10:00:00.000Z';
      const reply = msg({
        id: 'w3',
        conversation: 'c0000001aaaa',
        user: 'bob',
        from: 'hewo-1',
        to: 'bob',
        kind: 'output',
        text: 'hi',
        at,
      });
      let channel: ReturnType<typeof held> | undefined;
      let conversations = 0;
      const f = new FakeFetch((url, init) => {
        if (url.endsWith('/v1/health')) return json(200, health);
        if (url.includes('/v1/channel')) {
          channel = held();
          return channel.response(init, [{ type: 'watching', channel: 'main', agents: ['hewo-1'] }]);
        }
        conversations += 1;
        const body = JSON.parse(present(init, 'init').body as string) as ConversationRequest;
        // With the view on (the first message), the channel carries the deltas and the reply too.
        if (conversations === 1) present(channel, 'channel').push([...DELTAS, { type: 'message', message: reply }]);
        return ndjson([
          { type: 'posted', message: msg({ user: 'bob', from: 'bob', text: body.message }), working: ['hewo-1'] },
          ...(DELTAS as ConversationEvent[]),
          {
            type: 'message',
            message: msg({ id: 'm3', user: 'bob', from: 'hewo-1', to: 'bob', kind: 'output', text: 'hi' }),
            working: [],
          },
        ]);
      });
      let out: string[] = [];
      const lines = scripted([
        '/watch on',
        'hello',
        async () => until(() => out.length >= 2, 'the reply on the view'),
        '/watch off',
        'hello',
      ]);
      const t = await context({ fetch: f.fetch, input: { lines, isTerminal: false }, timing: TIMING });
      out = t.io.out;
      await writeDaemonFile(t.home, 5555);
      expect(await runCli(['--interactive', 'user=bob', '--verbose'], t.ctx)).toBe(EXIT.ok);
      const err = t.io.err.join('').split('\n');
      const deltaLines = err.filter((l) => l.startsWith('› hewo-1 reply: '));
      // Each fragment exactly once: while the view was on (printed by the view), and after /watch off (printed by the
      // conversation). A line the session prints between two fragments ends the delta line, and the next fragment
      // opens a new one under its header: nothing is ever printed inside a delta line.
      expect(deltaLines.map((l) => l.slice('› hewo-1 reply: '.length)).join('')).toBe('{"text":"hi"}{"text":"hi"}');
      expect(deltaLines.every((l) => !l.slice(1).includes('›'))).toBe(true);
      expect(err.filter((l) => l.includes('› bob → main: hello'))).toEqual([
        '› bob → main: hello',
        '› bob → main: hello',
      ]);
      expect(t.io.out).toEqual(['» reply from hewo-1:\n', '10:00:00Z [c0000001] output hewo-1 → bob: hi\n', 'hi\n']);
    });

    it('with --verbose, /watch on shows the channel it watches as progress', async () => {
      const channel = held();
      const f = new FakeFetch((url, init) => {
        if (url.endsWith('/v1/health')) return json(200, health);
        return channel.response(init, [{ type: 'watching', channel: 'lab', agents: [] }]);
      });
      let err: string[] = [];
      const lines = scripted(['/watch on', async () => until(() => err.length === 2, 'the watch banner')]);
      const t = await context({ fetch: f.fetch, input: { lines, isTerminal: false }, timing: TIMING });
      err = t.io.err;
      await writeDaemonFile(t.home, 5555);
      expect(await runCli(['--interactive', 'user=bob', 'channel=lab', '--verbose'], t.ctx)).toBe(EXIT.ok);
      expect(err).toEqual(['watching the channel\n', '› watching channel "lab" (no agents yet)\n']);
      expect(channel.signal()?.aborted).toBe(true);
    });
  });
});

describe('the login name as the default user ID (R16, A15)', () => {
  const FULL = (name: string, converted: string, reason: string) =>
    `✗ your login name "${name}" converts to "${converted}", which cannot be a user ID: ${reason}; type user=<id> to choose one\n`;

  /** A message sent with `argv` and an injected `loginName`; the order of what happened, and what was sent. */
  async function send(argv: readonly string[], loginName: () => string) {
    const order: string[] = [];
    const f = new FakeFetch((url, init) => {
      if (url.endsWith('/v1/health')) return json(200, health);
      order.push('conversation request');
      const body = JSON.parse(present(init, 'init').body as string) as ConversationRequest;
      const user = present(body.user, 'body.user');
      return ndjson([
        { type: 'posted', message: msg({ user, from: user }), working: ['hewo-1'] },
        {
          type: 'message',
          message: msg({ id: 'm2', from: 'hewo-1', to: user, kind: 'output', text: 'hi' }),
          working: [],
        },
      ]);
    });
    const t = await context({ fetch: f.fetch, loginName, stderr: (text) => order.push(text) });
    await writeDaemonFile(t.home, 5555);
    const code = await runCli(argv, t.ctx);
    const bodies = f.requests
      .filter((r) => r.url.endsWith('/v1/conversations'))
      .map((r) => JSON.parse(bodyOf(r)) as ConversationRequest);
    return { code, order, bodies, spawned: t.spawned, requests: f.requests };
  }

  it.each([
    ['olga', 'olga'],
    ['John.Smith', 'john-smith'],
    ['Olga', 'olga'],
    ['olga.k', 'olga-k'],
    ['o_k', 'o-k'],
  ])('a message without user= carries the login name %j as %j', async (name, id) => {
    const { code, bodies } = await send(['message=hi'], () => name);
    expect(code).toBe(EXIT.ok);
    expect(bodies).toEqual([{ user: id, channel: 'main', message: 'hi' }]);
  });

  it('parseConversationArgs stays pure: no user unless typed', () => {
    expect(parseConversationArgs(['message=x'])).toEqual({ channel: 'main', message: 'x' });
  });

  it('a changed name prints the ID line once, before the request, with and without --verbose', async () => {
    for (const flags of [[], ['--verbose']]) {
      const { order } = await send([...flags, 'message=hi'], () => 'John.Smith');
      const line = '› your login name "John.Smith" is sent as user ID "john-smith"\n';
      expect(
        order.filter((l) => l === line),
        flags.join(' '),
      ).toHaveLength(1);
      expect(order.indexOf(line)).toBeLessThan(order.indexOf('conversation request'));
    }
  });

  it('an unchanged name, and a typed user=, print no ID line; a typed user= never reads the login name', async () => {
    for (const flags of [[], ['--verbose']]) {
      const unchanged = await send([...flags, 'message=hi'], () => 'olga');
      expect(unchanged.order.filter((l) => l.includes('your login name'))).toEqual([]);
      const typed = await send([...flags, 'user=bob', 'message=hi'], () => {
        throw new Error('loginName not expected');
      });
      expect(typed.bodies.map((b) => b.user)).toEqual(['bob']);
      expect(typed.order.filter((l) => l.includes('your login name'))).toEqual([]);
    }
  });

  it.each([
    ['_admin', '-admin', USER_ID_REASONS.pattern],
    ['Émile', 'Émile', USER_ID_REASONS.pattern],
    ['a'.repeat(33), 'a'.repeat(33), USER_ID_REASONS.pattern],
    ['user-3', 'user-3', USER_ID_REASONS.issued],
    ['User.3', 'user-3', USER_ID_REASONS.issued],
    ['bob-2', 'bob-2', USER_ID_REASONS.number],
    ['j_smith_2', 'j-smith-2', USER_ID_REASONS.number],
    ['asha', 'asha', USER_ID_REASONS.harness],
    ['Asha', 'asha', USER_ID_REASONS.harness],
  ])(
    'a login name %j (→ %j) that still breaks the rule exits 1, sending and starting nothing',
    async (name, converted, reason) => {
      const { code, order, requests, spawned } = await send(['message=hi'], () => name);
      expect(code).toBe(EXIT.failed);
      expect(order).toEqual([FULL(name, converted, reason)]);
      expect([requests, spawned]).toEqual([[], []]);
    },
  );

  it('the reasons are written out in full', () => {
    expect(FULL('User.3', 'user-3', USER_ID_REASONS.issued)).toBe(
      '✗ your login name "User.3" converts to "user-3", which cannot be a user ID: user-<n> is the form the harness issues; type user=<id> to choose one\n',
    );
    expect(FULL('bob-2', 'bob-2', USER_ID_REASONS.number)).toBe(
      '✗ your login name "bob-2" converts to "bob-2", which cannot be a user ID: only an issued ID (user-<n>) may end in -<number>; type user=<id> to choose one\n',
    );
    expect(FULL('Asha', 'asha', USER_ID_REASONS.harness)).toBe(
      '✗ your login name "Asha" converts to "asha", which cannot be a user ID: "asha" is the harness\'s own name; type user=<id> to choose one\n',
    );
  });

  it('a login name that cannot be read exits 1 naming the error', async () => {
    const { code, order, requests, spawned } = await send(['message=hi'], () => {
      throw new Error('boom');
    });
    expect(code).toBe(EXIT.failed);
    expect(order).toEqual(['✗ cannot read your login name: boom; type user=<id> to choose one\n']);
    expect([requests, spawned]).toEqual([[], []]);
  });

  // A15 (a): a typed user= is the daemon's to check.
  it("a typed user=Bob is sent unchecked, and the daemon's 400 fails the command", async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : json(400, { error: `"Bob" cannot be a user ID: ${USER_ID_REASONS.pattern}` }),
    );
    const t = await context({
      fetch: f.fetch,
      loginName: () => {
        throw new Error('loginName not expected');
      },
    });
    await writeDaemonFile(t.home, 5555);
    expect(await runCli(['user=Bob', 'message=hi'], t.ctx)).toBe(EXIT.failed);
    expect(JSON.parse(bodyOf(lastRequest(f.requests)))).toEqual({
      user: 'Bob',
      channel: 'main',
      message: 'hi',
    });
    expect(t.io.err).toEqual([
      `✗ the daemon rejected the message: HTTP 400: {"error":"\\"Bob\\" cannot be a user ID: ${USER_ID_REASONS.pattern}"}\n`,
    ]);
  });

  // A8's login-name run: the two commands that send a message show the ID line and no other › line without --verbose.
  it.each([[['message=hi']], [['--interactive']]])(
    '%j with a login name the conversion changes shows only the ID line',
    async (argv) => {
      const f = new FakeFetch((url) =>
        url.endsWith('/v1/health')
          ? json(200, health)
          : ndjson([
              { type: 'phase', phase: 'agent', detail: 'hewo-1 online' },
              { type: 'posted', message: msg({ user: 'olga', from: 'olga' }), working: ['hewo-1'] },
              {
                type: 'message',
                message: msg({ id: 'm2', from: 'hewo-1', to: 'olga', kind: 'output', text: 'hi' }),
                working: [],
              },
            ]),
      );
      const t = await context({
        fetch: f.fetch,
        loginName: () => 'Olga',
        input: { lines: fromLines(['hello']), isTerminal: false },
      });
      await writeDaemonFile(t.home, 5555);
      expect(await runCli(argv, t.ctx)).toBe(EXIT.ok);
      expect(t.io.err).toEqual(['› your login name "Olga" is sent as user ID "olga"\n']);
      expect(t.io.out).toEqual(['hi\n']);
    },
  );
});

describe('model deltas on stderr with --verbose; stdout unchanged (model-streaming R7, A5)', () => {
  const delta = (seq: number, text: string, over: Record<string, unknown> = {}) =>
    ({
      type: 'model_delta',
      handle: 'hewo-1',
      conversation: 'm1',
      call: 'span-a',
      seq,
      part: 'thinking',
      text,
      ...over,
    }) as ConversationEvent;
  const reply = (seq: number, text: string, call = 'span-a') =>
    delta(seq, text, { part: 'tool_args', index: 0, name: 'reply', call });
  const done = (call = 'span-a') =>
    ({ type: 'model_done', handle: 'hewo-1', conversation: 'm1', call, outcome: 'ok' }) as ConversationEvent;
  /** One call: two fragments of thinking, then the reply tool's arguments in two fragments. */
  const CALL: ConversationEvent[] = [
    delta(0, 'The user'),
    delta(1, ' wants a greeting.'),
    reply(2, '{"text":"Hello'),
    reply(3, ' World."}'),
    done(),
  ];
  const conversation = (deltas: readonly ConversationEvent[]): ConversationEvent[] => [
    { type: 'posted', message: msg({ text: 'Please say: Hello World.' }), working: ['hewo-1'] },
    ...deltas,
    {
      type: 'message',
      message: msg({ id: 'm3', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hello World.' }),
      working: ['hewo-1'],
    },
    { type: 'status', conversation: 'c1', working: [] },
  ];

  async function converse(argv: readonly string[], events: readonly ConversationEvent[]) {
    const f = new FakeFetch((url) => (url.endsWith('/v1/health') ? json(200, health) : ndjson([...events])));
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    const code = await runCli([...argv, 'message=Please say: Hello World.'], ctx);
    return { code, out: io.out, err: io.err };
  }

  it('prints a › line naming the handle and thinking, then one naming the handle and reply, each followed by its fragments', async () => {
    const run = await converse(['--verbose'], conversation(CALL));
    expect(run.code).toBe(EXIT.ok);
    expect(run.err).toEqual([
      '› user-1 → main: Please say: Hello World.\n',
      '› hewo-1 thinking: ',
      'The user',
      ' wants a greeting.',
      '\n',
      '› hewo-1 reply: ',
      '{"text":"Hello',
      ' World."}',
      '\n',
      '› output hewo-1 → user-1:\n',
    ]);
    expect(run.out).toEqual(['Hello World.\n']);
  });

  it('prints no delta without --verbose, and stdout is byte-identical to --verbose and to a stream with no deltas', async () => {
    const quiet = await converse([], conversation(CALL));
    const verbose = await converse(['--verbose'], conversation(CALL));
    const none = await converse([], conversation([]));
    expect(quiet.err).toEqual([]);
    expect(quiet.out.join('')).toBe('Hello World.\n');
    expect(verbose.out.join('')).toBe(quiet.out.join(''));
    expect(none.out.join('')).toBe(quiet.out.join(''));
    expect([quiet.code, verbose.code, none.code]).toEqual([EXIT.ok, EXIT.ok, EXIT.ok]);
  });

  it('starts a new line when the call changes, and ends an open line before any other line is printed', async () => {
    const run = await converse(
      ['--verbose'],
      conversation([
        reply(0, '{"text":"a', 'span-a'),
        reply(0, '{"text":"b', 'span-b'),
        reply(1, '"}', 'span-a'),
        // A message while a delta line is open: the line is ended first.
        {
          type: 'message',
          message: msg({ id: 'm2', from: 'hewo-1', kind: 'status', text: 'ok' }),
          working: ['hewo-1'],
        },
        done('span-b'),
        done('span-a'),
      ]),
    );
    expect(run.err).toEqual([
      '› user-1 → main: Please say: Hello World.\n',
      '› hewo-1 reply: ',
      '{"text":"a',
      '\n',
      '› hewo-1 reply: ',
      '{"text":"b',
      '\n',
      '› hewo-1 reply: ',
      '"}',
      '\n',
      '› hewo-1: ok\n',
      '› output hewo-1 → user-1:\n',
    ]);
  });

  it('--watch prints the deltas of every call on stderr with --verbose, and the same stdout as with none', async () => {
    const watchRun = async (argv: readonly string[], deltas: readonly ConversationEvent[]) => {
      let interrupt: ((signal: ShutdownSignal) => void) | undefined;
      const f = new FakeFetch((url, init) => {
        if (url.endsWith('/v1/health')) return json(200, health);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(wire({ type: 'watching', channel: 'main', agents: ['hewo-1'] })));
            for (const event of deltas) controller.enqueue(enc.encode(wire(event)));
            controller.enqueue(
              enc.encode(
                wire({
                  type: 'message',
                  message: msg({
                    from: 'hewo-1',
                    to: 'user-1',
                    kind: 'output',
                    text: 'Hello World.',
                    at: '2026-09-26T01:02:03.000Z',
                  }),
                }),
              ),
            );
            init?.signal?.addEventListener('abort', () => {
              controller.error(present(init.signal, 'init.signal').reason);
            });
            setTimeout(() => {
              interrupt?.('SIGINT');
            }, 20);
          },
        });
        return new Response(body, SSE_OK);
      });
      const { ctx, home, io } = await context({
        fetch: f.fetch,
        shutdownSignals: (listener) => {
          interrupt = listener;
          return () => undefined;
        },
      });
      await writeDaemonFile(home, 5555);
      const code = await runCli(['--watch', ...argv], ctx);
      return { code, out: io.out, err: io.err };
    };
    const verbose = await watchRun(['--verbose'], CALL);
    const quiet = await watchRun([], CALL);
    const none = await watchRun([], []);
    expect(verbose.err).toEqual([
      '› watching channel "main" (agents: hewo-1); Ctrl-C to stop\n',
      '› hewo-1 thinking: ',
      'The user',
      ' wants a greeting.',
      '\n',
      '› hewo-1 reply: ',
      '{"text":"Hello',
      ' World."}',
      '\n',
    ]);
    expect(quiet.err).toEqual([]);
    expect(verbose.out).toEqual(['01:02:03Z [m1] output hewo-1 → user-1: Hello World.\n']);
    expect(quiet.out).toEqual(verbose.out);
    expect(none.out).toEqual(verbose.out);
    expect([verbose.code, quiet.code, none.code]).toEqual([EXIT.ok, EXIT.ok, EXIT.ok]);
  });

  it("--watch ends with exit 1 on the daemon's error event, printing it (slow_reader, R6)", async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health)
        : new Response(
            [
              wire({ type: 'watching', channel: 'main', agents: [] }),
              wire({ type: 'error', reason: 'slow_reader', detail: 'the stream fell behind' }),
            ].join(''),
            SSE_OK,
          ),
    );
    const { ctx, home, io } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    expect(await runCli(['--watch'], ctx)).toBe(EXIT.failed);
    expect(io.err).toEqual(['✗ slow_reader: the stream fell behind\n']);
    expect(io.out).toEqual([]);
  });

  it.each([
    [['message=hi'], 'message'],
    [['--launch', 'recipe=r'], 'launch'],
    [['--watch'], 'watch'],
  ])(
    '%j fails loudly on a daemon that streams NDJSON (an older build), naming the type and asha --stop',
    async (argv, what) => {
      const f = new FakeFetch((url) =>
        url.endsWith('/v1/health')
          ? json(200, health)
          : new Response(`${JSON.stringify({ type: 'heartbeat' })}\n`, {
              status: 200,
              headers: { 'content-type': 'application/x-ndjson' },
            }),
      );
      const { ctx, home, io } = await context({ fetch: f.fetch });
      await writeDaemonFile(home, 5555);
      expect(await runCli(argv, ctx)).toBe(EXIT.failed);
      expect(io.err).toEqual([
        `✗ the daemon answered the ${what} with application/x-ndjson, not text/event-stream: it runs a different build than this asha. Run asha --stop to use this build.\n`,
      ]);
    },
  );

  it("throws, naming the line, on a stream that is not the daemon's event format (a defect, not data)", async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health') ? json(200, health) : new Response('{"type":"posted"}\n', SSE_OK),
    );
    const { ctx, home } = await context({ fetch: f.fetch });
    await writeDaemonFile(home, 5555);
    await expect(runCli(['message=hi'], ctx)).rejects.toThrow(
      'an unexpected line in the daemon\'s event stream: {"type":"posted"}',
    );
  });
});

describe('DeltaPrinter (model-streaming R7)', () => {
  it("opens a line per call and part, ends it on the call's model_done, and not on another call's", () => {
    const written: string[] = [];
    const printer = new DeltaPrinter((t) => written.push(t));
    const base = { type: 'model_delta', handle: 'memo-1', conversation: 'c', seq: 0 } as const;
    printer.delta({ ...base, call: 'a', part: 'text', text: 'x' });
    printer.delta({ ...base, call: 'a', part: 'text', text: 'y' });
    printer.done({ type: 'model_done', handle: 'memo-1', conversation: 'c', call: 'b', outcome: 'timeout' });
    printer.delta({ ...base, call: 'a', part: 'tool_args', index: 0, name: 'remember', text: '{' });
    printer.delta({ ...base, call: 'a', part: 'tool_args', index: 1, name: 'remember', text: '[' });
    // Its own call's model_done ends the line, with nothing else printed after it.
    printer.done({ type: 'model_done', handle: 'memo-1', conversation: 'c', call: 'a', outcome: 'ok' });
    expect(written).toEqual([
      '› memo-1 text: ',
      'x',
      'y',
      '\n',
      '› memo-1 remember: ',
      '{',
      '\n',
      '› memo-1 remember: ',
      '[',
      '\n',
    ]);
    printer.end();
    expect(written).toHaveLength(10);
  });

  it('around() ends an open line before anything else is written, on any of the three streams', () => {
    const written: string[] = [];
    const printer = new DeltaPrinter((t) => written.push(`err:${t}`));
    const ctx = printer.around({
      stdout: (t) => written.push(`out:${t}`),
      stderr: (t) => written.push(`err:${t}`),
      progress: (t) => written.push(`err:${t}`),
    });
    printer.delta({
      type: 'model_delta',
      handle: 'h-1',
      conversation: 'c',
      call: 'a',
      seq: 0,
      part: 'thinking',
      text: 'hm',
    });
    ctx.stdout('reply\n');
    ctx.stderr('✗ x\n');
    expect(written).toEqual(['err:› h-1 thinking: ', 'err:hm', 'err:\n', 'out:reply\n', 'err:✗ x\n']);
  });
});

describe('asha --portal (docs/plans/portal.md R1, A1)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A daemon on port 5555 answering health — started by the command unless `running` — the forwarding file written
   * by the real writePrivateFile, and an opener whose exit the test scripts.
   */
  async function portal(
    argv: readonly string[],
    options: {
      running?: boolean;
      login?: string;
      open?: () => Promise<number | NodeJS.Signals>;
      spawnFails?: boolean;
    } = {},
  ) {
    let started = options.running === true;
    const f = new FakeFetch((url) => {
      if (!started) throw new TypeError('connect ECONNREFUSED');
      if (url.endsWith('/v1/health')) return json(200, health);
      throw new Error(`--portal requested ${url}`);
    });
    const opened: string[][] = [];
    const killed: string[] = [];
    const written: string[] = [];
    const spawned: string[] = [];
    const t = await context({
      fetch: f.fetch,
      loginName: () => options.login ?? 'olga',
      spawnServer: async (paths) => {
        spawned.push(paths.home);
        await writeDaemonFile(paths.home, 5555);
        started = true;
        return 222;
      },
      portal: {
        writeFile: async (path, content) => {
          written.push(path);
          await writePrivateFile(path, content);
        },
        open: (...args) => {
          opened.push(args);
          if (options.spawnFails === true) throw Object.assign(new Error('spawn open ENOENT'), { code: 'ENOENT' });
          return { exited: options.open?.() ?? Promise.resolve(0), kill: () => killed.push(args[0]) };
        },
      },
    });
    if (options.running === true) await writeDaemonFile(t.home, 5555);
    const run = runCli(argv, t.ctx);
    return { run, t, opened, killed, written, spawned, requests: f.requests };
  }

  const file = (home: string) => join(home, 'portal.html');
  const page = (user: string) =>
    `<!doctype html>\n<meta charset="utf-8">\n<title>asha portal</title>\n<script>location.replace("http://127.0.0.1:5555/#c=${CREDENTIAL}&u=${user}");</script>\n`;

  it('with no daemon answering: starts one, writes the 0600 forwarding file, opens it once, prints the address only', async () => {
    const { run, t, opened, written, spawned } = await portal(['--portal']);
    expect(await run).toBe(EXIT.ok);
    expect(spawned).toEqual([t.home]);
    expect(written).toEqual([file(t.home)]);
    expect(await readFile(file(t.home), 'utf8')).toBe(page('olga'));
    expect(((await stat(file(t.home))).mode & 0o777).toString(8)).toBe('600');
    expect(opened).toEqual([[file(t.home)]]);
    expect(t.io.out).toEqual(['portal: http://127.0.0.1:5555/\n']);
    expect(t.io.err).toEqual([]);
  });

  it('with one running, twice: starts none, and the second file replaces the first', async () => {
    const first = await portal(['--portal'], { running: true });
    expect(await first.run).toBe(EXIT.ok);
    const second = await portal(['--portal', 'user=bob'], { running: true });
    // The same home: the second run's context writes into its own home, so run it again in the first's.
    expect(await second.run).toBe(EXIT.ok);
    expect([first.spawned, second.spawned]).toEqual([[], []]);
    const again = await runCli(['--portal', 'user=bob'], { ...first.t.ctx });
    expect(again).toBe(EXIT.ok);
    expect(await readFile(file(first.t.home), 'utf8')).toBe(page('bob'));
    expect(first.opened).toEqual([[file(first.t.home)], [file(first.t.home)]]);
  });

  it('--portal user= naming no valid user ID is a usage error, exit 2, writing nothing and opening nothing', async () => {
    const { run, t, opened, written } = await portal(['--portal', 'user=Bob Smith'], { running: true });
    expect(await run).toBe(EXIT.usage);
    expect(t.io.err.join('')).toBe(`✗ ${USER_ID_REASONS.pattern}\n`);
    expect([opened, written, t.io.out]).toEqual([[], [], []]);
  });

  it('--portal user=bob puts bob in the fragment', async () => {
    const { run, t } = await portal(['--portal', 'user=bob'], { running: true });
    expect(await run).toBe(EXIT.ok);
    expect(await readFile(file(t.home), 'utf8')).toBe(page('bob'));
  });

  it('--portal channel=x is a usage error, exit 2, writing nothing and opening nothing', async () => {
    const { run, t, opened, written } = await portal(['--portal', 'channel=x'], { running: true });
    expect(await run).toBe(EXIT.usage);
    expect(t.io.err.join('')).toBe(`--portal takes only user=<id>\n\n${USAGE}`);
    expect([opened, written, t.io.out]).toEqual([[], [], []]);
  });

  it('a login name that cannot be a user ID: its ✗ line and exit 1, writing nothing; with user=bob, exit 0', async () => {
    const bad = await portal(['--portal'], { running: true, login: '_admin' });
    expect(await bad.run).toBe(EXIT.failed);
    expect(bad.t.io.err.join('')).toBe(
      '✗ your login name "_admin" converts to "-admin", which cannot be a user ID: a user ID is 1 to 32 characters: a lowercase letter, then lowercase letters, digits or hyphens; type user=<id> to choose one\n',
    );
    expect([bad.opened, bad.written, bad.requests]).toEqual([[], [], []]);
    const named = await portal(['--portal', 'user=bob'], { running: true, login: '_admin' });
    expect(await named.run).toBe(EXIT.ok);
  });

  it('an opener that exits 1, and one that cannot be spawned: the ✗ line naming the file, exit 1', async () => {
    const failed = await portal(['--portal'], { running: true, open: () => Promise.resolve(1) });
    expect(await failed.run).toBe(EXIT.failed);
    expect(failed.t.io.err).toEqual([
      `✗ could not open a browser (open exited 1); open ${file(failed.t.home)} in one\n`,
    ]);
    expect(failed.t.io.out).toEqual([]);
    const missing = await portal(['--portal'], { running: true, spawnFails: true });
    expect(await missing.run).toBe(EXIT.failed);
    expect(missing.t.io.err).toEqual([
      `✗ could not open a browser (open could not be started: spawn open ENOENT); open ${file(missing.t.home)} in one\n`,
    ]);
  });

  it('an opener that never exits is killed at 10,000 ms (manual clock), and the ✗ line says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hung = await portal(['--portal'], { running: true, open: () => new Promise(() => undefined) });
    let settled = false;
    void hung.run.then(() => (settled = true));
    while (hung.opened.length === 0) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PORTAL_OPEN_MS - 1);
    expect([settled, hung.killed]).toEqual([false, []]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await hung.run).toBe(EXIT.failed);
    expect(hung.killed).toEqual([file(hung.t.home)]);
    expect(hung.t.io.err).toEqual([
      `✗ could not open a browser (open did not exit within 10000 ms, and was killed); open ${file(hung.t.home)} in one\n`,
    ]);
  });

  it('puts the credential in no output and no argument of the opener', async () => {
    const { run, t, opened } = await portal(['--portal'], { running: true });
    expect(await run).toBe(EXIT.ok);
    expect(JSON.stringify([t.io.out, t.io.err, opened])).not.toContain(CREDENTIAL);
  });
});

describe('a stopping daemon (docs/plans/debt-paydown.md R15, R16, A12; D21)', () => {
  const DAEMON = '/Users/u/.nvm/versions/node/v22.13.1/bin/node /repo/dist/src/cli/main.js --server';
  const STOPPING = { pid: 222, port: 5555, credential: CREDENTIAL, stopping: true };
  const WARN = '⚠ the asha daemon (pid 222) is stopping; waiting for it to stop\n';
  /** A pid that lives for `polls` liveness checks, then is gone; or forever. */
  const livesFor = (polls: number) => {
    let checks = 0;
    return (pid: number) => pid === 222 && (checks += 1) <= polls;
  };

  it('parseDaemonFile accepts stopping: true and refuses any other value of it', () => {
    expect(parseDaemonFile(JSON.stringify(STOPPING))).toEqual(STOPPING);
    expect(parseDaemonFile(JSON.stringify({ pid: 222, port: 5555, credential: CREDENTIAL }))).toEqual({
      pid: 222,
      port: 5555,
      credential: CREDENTIAL,
    });
    for (const value of ['yes', false, 1])
      expect(parseDaemonFile(JSON.stringify({ ...STOPPING, stopping: value }))).toBe(
        `stopping is not true (${JSON.stringify(value)})`,
      );
  });

  it('--status prints stopping (pid) and exits 1 for a live asha daemon whose file says stopping, asking it nothing', async () => {
    const f = new FakeFetch(() => json(200, health));
    const asked: number[] = [];
    const { ctx, home, io } = await context({
      fetch: f.fetch,
      processCommand: (pid) => {
        asked.push(pid);
        return Promise.resolve(DAEMON);
      },
    });
    await writeDaemonFile(home, 5555, STOPPING);
    expect(await runCli(['--status'], ctx)).toBe(EXIT.failed);
    expect([io.out, io.err, f.requests, asked]).toEqual([['stopping (pid 222)\n'], [], [], [222]]);
  });

  it('--status finds it stopping by a 503 with reason stopping, and not by a 503 without one', async () => {
    for (const [body, out] of [
      [{ error: 'the daemon is stopping', reason: 'stopping' }, 'stopping (pid 222)\n'],
      [{ error: 'the daemon is stopping' }, 'not running\n'],
    ] as const) {
      const { ctx, home, io } = await context({
        fetch: new FakeFetch(() => json(503, body)).fetch,
        processCommand: () => Promise.resolve(DAEMON),
      });
      await writeDaemonFile(home, 5555);
      expect(await runCli(['--status'], ctx)).toBe(EXIT.failed);
      expect(io.out).toEqual([out]);
    }
  });

  it('a file saying stopping whose pid is dead, or is not an asha daemon, is absent: not running', async () => {
    for (const over of [
      { isAlive: () => false, processCommand: () => Promise.resolve(DAEMON) },
      { isAlive: () => true, processCommand: () => Promise.resolve('/usr/bin/vim notes.txt') },
      { isAlive: () => true, processCommand: () => Promise.resolve(null) },
    ]) {
      const { ctx, home, io } = await context(over);
      await writeDaemonFile(home, 5555, STOPPING);
      expect(await runCli(['--status'], ctx)).toBe(EXIT.failed);
      expect(io.out).toEqual(['not running\n']);
    }
  });

  it('--stop sends a stopping daemon no signal, waits for its pid, and prints stopped (pid)', async () => {
    const { ctx, home, io, killed } = await context({
      isAlive: livesFor(3),
      processCommand: () => Promise.resolve(DAEMON),
    });
    await writeDaemonFile(home, 5555, STOPPING);
    expect(await runCli(['--stop'], ctx)).toBe(EXIT.ok);
    expect([io.out, io.err, killed]).toEqual([['stopped (pid 222)\n'], [], []]);
  });

  it('--stop gives up after serverStopMs with the still-running line, exit 1, still sending no signal', async () => {
    const { ctx, home, io, killed } = await context({
      isAlive: () => true,
      processCommand: () => Promise.resolve(DAEMON),
    });
    await writeDaemonFile(home, 5555, STOPPING);
    const started = Date.now();
    expect(await runCli(['--stop'], ctx)).toBe(EXIT.failed);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect([io.out, io.err, killed]).toEqual([
      [],
      ['✗ daemon pid 222 is still running 200 ms after this --stop began waiting for its stop\n'],
      [],
    ]);
  });

  it('a message command says the daemon is stopping (without --verbose), waits, then starts one as if none ran', async () => {
    const { ctx, home, io, spawned } = await context({
      isAlive: livesFor(2),
      processCommand: () => Promise.resolve(DAEMON),
    });
    await writeDaemonFile(home, 5555, STOPPING);
    // The new daemon never answers here: the start's own bound ends the command, after the spawn.
    expect(await runCli(['message=hi'], ctx)).toBe(EXIT.failed);
    expect(io.err[0]).toBe(WARN);
    expect(spawned).toEqual([home]);
  });

  it('past serverStopMs every other command fails naming the log and the file, starting nothing', async () => {
    for (const argv of [
      ['message=hi'],
      ['--launch', 'recipe=r'],
      ['--watch'],
      ['--list-state'],
      ['--reset-state', 'channel=c', 'name=r'],
      ['--approve', 'id=0123456789abcdef', '--yes'],
      ['--enable-module', 'id=m', 'conversation=1', 'day=1', 'month=1'],
      ['--uninstall-module', 'id=m', '--yes'],
    ]) {
      const { ctx, home, io, spawned } = await context({
        isAlive: () => true,
        processCommand: () => Promise.resolve(DAEMON),
      });
      await writeDaemonFile(home, 5555, STOPPING);
      expect(await runCli(argv, ctx), argv.join(' ')).toBe(EXIT.failed);
      expect(io.err, argv.join(' ')).toEqual([
        WARN,
        `✗ the asha daemon (pid 222) was still stopping after 200 ms; see ${join(home, 'logs', 'daemon.jsonl')}, and if no asha daemon runs for this home, remove ${join(home, 'daemon.json')}\n`,
      ]);
      expect(spawned, argv.join(' ')).toEqual([]);
    }
  });

  it("a start's poll treats a stopping daemon as not yet up, and returns the daemon that then answers", async () => {
    let polls = 0;
    const f = new FakeFetch(() => json(200, { ...health, pid: 333 }));
    const { ctx, home, io, spawned } = await context({
      fetch: f.fetch,
      isAlive: (pid) => pid === 222 || pid === 333,
      processCommand: () => Promise.resolve(DAEMON),
      spawnServer: async (paths) => {
        spawned.push(paths.home);
        // The file a stopping daemon of this home still holds, then the new daemon's after a few polls.
        await writeDaemonFile(paths.home, 5555, STOPPING);
        return 333;
      },
      sleep: async () => {
        polls += 1;
        if (polls === 3) await writeDaemonFile(home, 6666, { pid: 333, port: 6666, credential: CREDENTIAL });
      },
      timing: {
        serverStartMs: 5_000,
        serverStopMs: 200,
        streamIdleMs: 200,
        pollMs: 1,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
    });
    expect(await runCli(['--status'], ctx)).toBe(EXIT.failed);
    // --status starts nothing; a message command starts one and waits through the stopping file.
    const code = await runCli(['--launch', 'recipe=r'], ctx);
    expect(spawned).toEqual([home]);
    expect(polls).toBeGreaterThanOrEqual(3);
    // It reached the new daemon: its health, then the launch (which this fake answers as JSON, so the launch fails).
    expect(code).toBe(EXIT.failed);
    expect(f.requests.map((r) => r.url)).toEqual([
      'http://127.0.0.1:6666/v1/health',
      'http://127.0.0.1:6666/v1/agents',
    ]);
    expect(io.err.filter((l) => /did not answer within|exited during startup/.test(l))).toEqual([]);
  });
});

describe("the daemon's lifetime from its environment (docs/plans/idle-shutdown.md R3, R4, R6; A4, A6)", () => {
  it('the auto-start gives the daemon it spawns ASHA_IDLE_EXIT_MS=1800000 with the rest of its environment', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const { ctx, home } = await context({
      isAlive: () => false,
      spawnServer: (_paths, env) => {
        envs.push(env);
        return Promise.resolve(222);
      },
    });
    expect(await runCli(['--watch'], ctx)).toBe(EXIT.failed);
    expect(envs).toEqual([{ ASHA_HOME: home, ASHA_IDLE_EXIT_MS: '1800000' }]);
  });

  it('passes on an ASHA_IDLE_EXIT_MS already set, even one the daemon will refuse, for it to judge', () => {
    expect(autoStartEnv({ ASHA_HOME: '/h' })).toEqual({ ASHA_HOME: '/h', ASHA_IDLE_EXIT_MS: '1800000' });
    expect(autoStartEnv({ ASHA_IDLE_EXIT_MS: '60000' })).toEqual({ ASHA_IDLE_EXIT_MS: '60000' });
    expect(autoStartEnv({ ASHA_IDLE_EXIT_MS: 'soon' })).toEqual({ ASHA_IDLE_EXIT_MS: 'soon' });
  });

  /** `asha --server` under `env`: its exit code, stderr, and the lifetime it gave startDaemon, if it got that far. */
  async function serve(env: NodeJS.ProcessEnv) {
    const lifetimes: StartDaemonProps['lifetime'][] = [];
    const loggers: string[] = [];
    const t = await context({
      createLogger: (paths) => {
        loggers.push(paths.home);
        return { info: () => undefined, warn: () => undefined, error: () => undefined };
      },
      dependencies: () => ({}) as never,
      startDaemon: (props) => {
        lifetimes.push(props.lifetime);
        let settle!: () => void;
        const stopped = new Promise<void>((resolve) => (settle = resolve));
        return Promise.resolve({
          port: 7777,
          requestStop: () => {
            settle();
          },
          stopped,
          stop: () => Promise.resolve(),
        });
      },
      shutdownSignals: (listener) => {
        setTimeout(() => {
          listener('SIGTERM');
        }, 0);
        return () => undefined;
      },
    });
    const code = await runCli(['--server'], { ...t.ctx, env: { ...t.ctx.env, ...env } });
    return { code, err: t.io.err, lifetimes, loggers };
  }

  it('without the variables --server never stops for idleness, and unloads models after 15 idle minutes (R4)', async () => {
    const run = await serve({});
    expect([run.code, run.err, run.lifetimes]).toEqual([EXIT.ok, [], [{ modelIdleMs: 900_000 }]]);
  });

  it('--server takes each variable it is given', async () => {
    const run = await serve({
      ASHA_IDLE_EXIT_MS: '600000',
      ASHA_MODEL_IDLE_MS: '86400000',
      ASHA_EXIT_WITH_PID: String(process.pid),
    });
    expect([run.code, run.err, run.lifetimes]).toEqual([
      EXIT.ok,
      [],
      [{ idleExitMs: 600_000, modelIdleMs: 86_400_000, exitWithPid: process.pid }],
    ]);
  });

  it.each([
    [{ ASHA_IDLE_EXIT_MS: '' }, 'ASHA_IDLE_EXIT_MS="" is not a positive whole number'],
    [{ ASHA_IDLE_EXIT_MS: '0' }, 'ASHA_IDLE_EXIT_MS="0" is not a positive whole number'],
    [{ ASHA_IDLE_EXIT_MS: '-5' }, 'ASHA_IDLE_EXIT_MS="-5" is not a positive whole number'],
    [{ ASHA_IDLE_EXIT_MS: '1e3' }, 'ASHA_IDLE_EXIT_MS="1e3" is not a positive whole number'],
    [{ ASHA_IDLE_EXIT_MS: ' 60000' }, 'ASHA_IDLE_EXIT_MS=" 60000" is not a positive whole number'],
    [{ ASHA_IDLE_EXIT_MS: '0600' }, 'ASHA_IDLE_EXIT_MS="0600" is not a positive whole number'],
    [{ ASHA_MODEL_IDLE_MS: 'soon' }, 'ASHA_MODEL_IDLE_MS="soon" is not a positive whole number'],
    [{ ASHA_EXIT_WITH_PID: '12.5' }, 'ASHA_EXIT_WITH_PID="12.5" is not a positive whole number'],
    // pid 1 is launchd's, another user's: not a process of this user (EPERM).
    [{ ASHA_EXIT_WITH_PID: '1' }, 'ASHA_EXIT_WITH_PID=1 names no running process of this user'],
  ])('--server refuses %j before anything starts, naming it, and exits 1', async (env, message) => {
    const run = await serve(env);
    expect([run.code, run.err, run.lifetimes, run.loggers]).toEqual([EXIT.failed, [`✗ ${message}\n`], [], []]);
  });

  it('lifetimeFrom refuses a pid no process holds (ESRCH)', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('true');
    const pid = present(child.pid, "true's pid");
    await new Promise((resolve) => child.once('exit', resolve));
    expect(() => lifetimeFrom({ ASHA_EXIT_WITH_PID: String(pid) }, () => false)).toThrow(
      new LifetimeEnvInvalid(`ASHA_EXIT_WITH_PID=${String(pid)} names no running process of this user`),
    );
  });
});
