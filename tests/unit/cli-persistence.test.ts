// The CLI's side of agent persistence (docs/plans/agent-persistence.md R5, R8, R9 (h), (i), R16; A4, A7, A8 test 11,
// A16): the resuming `--launch` — `followResent` to a daemon of its own build, one `› resuming your message from
// <savedAt>` per re-sent message, always, the replies on stdout, reading to the stream's end, bounded by its
// inactivity bound — `--list-state` and `--reset-state`, through the daemon or, with none, on the files under the
// daemon's own lock, and the per-user erase's streamed lines.

import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT, runCli, type CliContext } from '../../src/cli/commands.js';
import { acquirePidLock, LockHeld } from '../../src/daemon/process/pid-lock.js';
import { ASSET_BOUNDS, StateStore, nodeStateFs } from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type { ConversationMessage, PresenceMessage, StateListResponse } from '../../src/shared/protocol.js';
import { SSE_HEARTBEAT, sseEvent } from '../../src/shared/sse.js';
import { FakeFetch, NOT_INTERACTIVE, NO_PORTAL, RecordingLogger, json } from '../helpers/fakes.js';
import { assetTar } from '../helpers/persistence.js';

const CREDENTIAL = 'c'.repeat(64);
const SSE_OK = { status: 200, headers: { 'content-type': 'text/event-stream' } } as const;
const health = (build = 'cli-build-01') => ({
  ok: true,
  pid: 222,
  version: '9.9.9',
  build,
  startedAt: '2026-09-29T00:00:00.000Z',
  agents: [],
});
const stream = (events: unknown[]) => new Response(events.map((e) => sseEvent(e as { type: string })).join(''), SSE_OK);

const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: 'r1',
  channel: 'main',
  conversation: 'c1',
  user: 'ivy',
  from: 'keep-1',
  to: 'ivy',
  kind: 'output',
  text: 'done',
  at: '2026-09-29T00:00:00.000Z',
  ...over,
});
const hi = (from: string): PresenceMessage => ({
  id: 'p1',
  channel: 'main',
  conversation: null,
  from,
  to: null,
  kind: 'status',
  text: 'Hi',
  at: '2026-09-29T00:00:00.000Z',
});
const agent = { handle: 'keep-1', channel: 'main', recipe: 'keeper', image: 'keeper-image' };

type ContextOverride = Partial<CliContext> & { lines?: string[]; inputTerminal?: boolean };

/** `over` minus its two test-only fields, for the final `...rest` spread onto `ctx`. */
function withoutTestFields(over: ContextOverride): Partial<CliContext> {
  const rest: ContextOverride = { ...over };
  delete rest.lines;
  delete rest.inputTerminal;
  return rest;
}

async function context(over: ContextOverride = {}) {
  const home = await mkdtemp(join(tmpdir(), 'asha-cli-p-'));
  const out: string[] = [];
  const err: string[] = [];
  const logger = new RecordingLogger();
  const lines = over.lines ?? [];
  const rest = withoutTestFields(over);
  const ctx: CliContext = {
    env: { ASHA_HOME: home },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    fetch: new FakeFetch(() => {
      throw new TypeError('connect ECONNREFUSED');
    }).fetch,
    root: '/repo',
    version: '9.9.9',
    build: 'cli-build-01',
    pid: 111,
    startDaemon: () => Promise.reject(new Error('startDaemon not expected')),
    createLogger: () => logger,
    dependencies: () => {
      throw new Error('dependencies not expected');
    },
    shutdownSignals: () => () => undefined,
    spawnServer: () => Promise.reject(new Error('spawnServer not expected')),
    kill: () => undefined,
    isAlive: () => false,
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
    input: {
      lines: { [Symbol.asyncIterator]: () => lines[Symbol.iterator]() as unknown as AsyncIterator<string> },
      isTerminal: over.inputTerminal === true,
    },
    loginName: () => 'olga',
    // The folder asha runs in, and the home ~/ names: the test's temporary home (agent-files R1, R12a).
    cwd: () => home,
    homeDir: () => home,
    ...rest,
  };
  return { ctx, home, out, err, logger };
}

async function daemonFile(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'daemon.json'), JSON.stringify({ pid: 222, port: 5555, credential: CREDENTIAL }));
}

/** A fake daemon answering health with `build`, and the launch route with `launch`. */
function daemon(launch: () => Response, build?: string): FakeFetch {
  return new FakeFetch((url) => (url.endsWith('/v1/health') ? json(200, health(build)) : launch()));
}

describe('the resuming --launch (R9 (h), (i); A8 test 11, A7)', () => {
  it.each([[[] as string[]], [['--verbose']]])(
    "asks to follow, prints the handle, one resuming line, the reply, and exits 0 at the stream's end: %j",
    async (flags) => {
      const f = daemon(() =>
        stream([
          { type: 'launched', agent },
          { type: 'resending', conversation: 'c1', savedAt: '2026-09-28T10:00:00.000Z' },
          { type: 'message', message: msg({}), working: ['keep-1'] },
          { type: 'status', conversation: 'c1', working: [] },
          { type: 'settled', conversation: 'c1' },
        ]),
      );
      const { ctx, home, out, err } = await context({ fetch: f.fetch });
      await daemonFile(home);
      expect(await runCli(['--launch', 'recipe=keeper', ...flags], ctx)).toBe(EXIT.ok);
      const req = present(
        f.requests.find((r) => r.url.endsWith('/v1/agents')),
        "f.requests.find('/v1/agents')",
      );
      expect(JSON.parse(present(req.init, 'req.init').body as string)).toEqual({
        recipe: 'keeper',
        channel: 'main',
        followResent: true,
      });
      expect(out).toEqual(['keep-1\n', 'done\n']);
      expect(err.filter((l) => l.startsWith('› resuming'))).toEqual([
        '› resuming your message from 2026-09-28T10:00:00.000Z\n',
      ]);
      if (flags.length === 0) expect(err).toEqual(['› resuming your message from 2026-09-28T10:00:00.000Z\n']);
    },
  );

  it("prints the harness's reply when the re-sent conversation ended without an agent's, and exits 0 (the launch's exit is today's)", async () => {
    const f = daemon(() =>
      stream([
        { type: 'launched', agent },
        { type: 'resending', conversation: 'c1', savedAt: 't' },
        { type: 'message', message: msg({ from: 'asha', text: 'No agent could answer this.' }), working: [] },
        { type: 'settled', conversation: 'c1' },
      ]),
    );
    const { ctx, home, out } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--launch', 'recipe=keeper'], ctx)).toBe(EXIT.ok);
    expect(out).toEqual(['keep-1\n', 'No agent could answer this.\n']);
  });

  it("another conversation's status and agent_left end nothing and print no reply", async () => {
    const f = daemon(() =>
      stream([
        { type: 'launched', agent },
        { type: 'resending', conversation: 'c1', savedAt: 't' },
        { type: 'status', conversation: 'c2', working: [] },
        { type: 'agent_left', conversation: 'c2', agent: 'x-1', detail: 'gone', working: [] },
        { type: 'message', message: msg({}), working: [] },
        { type: 'settled', conversation: 'c1' },
      ]),
    );
    const { ctx, home, out } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--launch', 'recipe=keeper'], ctx)).toBe(EXIT.ok);
    expect(out).toEqual(['keep-1\n', 'done\n']);
  });

  it('fails when the stream goes silent after resending for its inactivity bound, and when it is cut', async () => {
    const silent = new FakeFetch((url, init) => {
      if (url.endsWith('/v1/health')) return json(200, health());
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                sseEvent({ type: 'launched', agent } as { type: string }) +
                  sseEvent({ type: 'resending', conversation: 'c1', savedAt: 't' } as { type: string }),
              ),
            );
            init?.signal?.addEventListener('abort', () => {
              controller.error(present(init.signal, 'init.signal').reason);
            });
          },
        }),
        SSE_OK,
      );
    });
    const a = await context({
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
    await daemonFile(a.home);
    expect(await runCli(['--launch', 'recipe=keeper'], a.ctx)).toBe(EXIT.failed);
    expect(a.err.at(-1)).toBe('✗ no word from the daemon for 30 ms; see its log\n');
    const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    let sent = false;
    const cut = daemon(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(
                  new TextEncoder().encode(
                    sseEvent({ type: 'launched', agent } as { type: string }) +
                      sseEvent({ type: 'resending', conversation: 'c1', savedAt: 't' } as { type: string }),
                  ),
                );
              } else controller.error(new TypeError('terminated', { cause: socketError }));
            },
          }),
          SSE_OK,
        ),
    );
    const b = await context({ fetch: cut.fetch });
    await daemonFile(b.home);
    expect(await runCli(['--launch', 'recipe=keeper'], b.ctx)).toBe(EXIT.failed);
    expect(b.err.at(-1)).toBe('✗ the daemon closed the launch before it finished; see its log (other side closed)\n');
  });

  // cli-interactive A8's other-build side: even a stream that goes on past launched with a resending event (which an
  // older daemon never sends, not being asked) is not read past launched, so no resuming line, with or without --verbose.
  it.each([[[] as string[]], [['--verbose']]])(
    'asks a daemon of another build nothing new, and returns at launched as ever, printing no resuming line: %j',
    async (flags) => {
      const f = daemon(
        () =>
          stream([
            { type: 'launched', agent },
            { type: 'resending', conversation: 'c1', savedAt: '2026-09-28T10:00:00.000Z' },
            { type: 'message', message: msg({}), working: [] },
            { type: 'settled', conversation: 'c1' },
          ]),
        'other-build',
      );
      const { ctx, home, out, err } = await context({ fetch: f.fetch });
      await daemonFile(home);
      expect(await runCli(['--launch', 'recipe=keeper', ...flags], ctx)).toBe(EXIT.ok);
      const req = present(
        f.requests.find((r) => r.url.endsWith('/v1/agents')),
        "f.requests.find('/v1/agents')",
      );
      expect(JSON.parse(present(req.init, 'req.init').body as string)).toEqual({
        recipe: 'keeper',
        channel: 'main',
      });
      expect(out).toEqual(['keep-1\n']);
      expect(err.filter((l) => l.startsWith('› resuming'))).toEqual([]);
      // Without --verbose, only the stale-build warning.
      if (flags.length === 0) expect(err.map((l) => l.slice(0, 2))).toEqual(['⚠ ']);
    },
  );

  it("handles every new launch event without reaching its exhaustive default; the models' output on stderr only with --verbose", async () => {
    const events = [
      { type: 'launched', agent },
      { type: 'resending', conversation: 'c1', savedAt: 't' },
      {
        type: 'model_delta',
        handle: 'keep-1',
        conversation: 'c1',
        call: 'k1',
        seq: 0,
        part: 'text',
        text: 'thinking out loud',
      },
      { type: 'model_done', handle: 'keep-1', conversation: 'c1', call: 'k1', outcome: 'ok' },
      { type: 'status', conversation: 'c1', working: ['keep-1'] },
      { type: 'agent_left', conversation: 'c1', agent: 'x-1', detail: 'gone', working: ['keep-1'] },
      { type: 'message', message: msg({}), working: [] },
      { type: 'settled', conversation: 'c1' },
    ];
    for (const verbose of [false, true]) {
      const f = daemon(() => stream(events));
      const { ctx, home, err } = await context({ fetch: f.fetch });
      await daemonFile(home);
      expect(await runCli(['--launch', 'recipe=keeper', ...(verbose ? ['--verbose'] : [])], ctx)).toBe(EXIT.ok);
      expect(err.join('').includes('thinking out loud')).toBe(verbose);
    }
  });

  it('ends on an error after launched — slow_reader — with its ✗ line, exit 1', async () => {
    const f = daemon(() =>
      stream([
        { type: 'launched', agent },
        { type: 'resending', conversation: 'c1', savedAt: 't' },
        { type: 'error', reason: 'slow_reader', detail: 'the stream fell behind' },
      ]),
    );
    const { ctx, home, err } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--launch', 'recipe=keeper'], ctx)).toBe(EXIT.failed);
    expect(err.at(-1)).toBe('✗ slow_reader: the stream fell behind\n');
  });

  it('two re-sent conversations: two resuming lines, each with its time, in order; both replies; exit 0 — and 32', async () => {
    for (const n of [2, 32]) {
      const events: unknown[] = [{ type: 'launched', agent }];
      for (let i = 1; i <= n; i += 1)
        events.push({ type: 'resending', conversation: `c${String(i)}`, savedAt: `t${String(i)}` });
      for (let i = 1; i <= n; i += 1)
        events.push(
          { type: 'message', message: msg({ conversation: `c${String(i)}`, text: `reply ${String(i)}` }), working: [] },
          { type: 'settled', conversation: `c${String(i)}` },
        );
      const f = daemon(() => stream(events));
      const { ctx, home, out, err } = await context({ fetch: f.fetch });
      await daemonFile(home);
      expect(await runCli(['--launch', 'recipe=keeper'], ctx)).toBe(EXIT.ok);
      expect(err).toEqual(Array.from({ length: n }, (_, i) => `› resuming your message from t${String(i + 1)}\n`));
      expect(out).toEqual(['keep-1\n', ...Array.from({ length: n }, (_, i) => `reply ${String(i + 1)}\n`)]);
    }
  });

  it("a team's launch follows too: its body, each handle, then the re-sent reply after team_launched; with nothing re-sent it ends after team_launched, exit 0", async () => {
    const summary = (h: string) => ({ ...agent, handle: h });
    const f = daemon(() =>
      stream([
        { type: 'member', name: 'ann', recipe: 'ann' },
        { type: 'launched', agent: summary('ann-1') },
        { type: 'team_launched', team: 'pair', agents: [summary('ann-1')] },
        { type: 'resending', conversation: 'c1', savedAt: 't1' },
        { type: 'message', message: msg({}), working: [] },
        { type: 'settled', conversation: 'c1' },
      ]),
    );
    const { ctx, home, out, err } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--launch', 'team=pair'], ctx)).toBe(EXIT.ok);
    const req = present(
      f.requests.find((r) => r.url.endsWith('/v1/agents')),
      "f.requests.find('/v1/agents')",
    );
    expect(JSON.parse(present(req.init, 'req.init').body as string)).toEqual({
      team: 'pair',
      channel: 'main',
      followResent: true,
    });
    expect(out).toEqual(['ann-1\n', 'done\n']);
    expect(err).toEqual(['› resuming your message from t1\n']);
    const g = daemon(() =>
      stream([
        { type: 'member', name: 'ann', recipe: 'ann' },
        { type: 'launched', agent: summary('ann-1') },
        { type: 'team_launched', team: 'pair', agents: [summary('ann-1')] },
      ]),
    );
    const b = await context({ fetch: g.fetch });
    await daemonFile(b.home);
    expect(await runCli(['--launch', 'team=pair'], b.ctx)).toBe(EXIT.ok);
    expect(b.err).toEqual([]);
  });

  it("prints '› <handle> resumed from state saved <savedAt>' only with --verbose (R8)", async () => {
    for (const verbose of [false, true]) {
      const f = daemon(() =>
        stream([
          {
            type: 'announced',
            message: hi('keep-1'),
            resumed: { savedAt: '2026-09-22T00:00:00.000Z', previousHandle: 'keep-1' },
          },
          { type: 'launched', agent },
        ]),
      );
      const { ctx, home, err } = await context({ fetch: f.fetch });
      await daemonFile(home);
      expect(await runCli(['--launch', 'recipe=keeper', ...(verbose ? ['--verbose'] : [])], ctx)).toBe(EXIT.ok);
      expect(err.includes('› keep-1 resumed from state saved 2026-09-22T00:00:00.000Z\n')).toBe(verbose);
    }
  });

  it('a message command prints a harness ⚠ notice on stderr always, prints no resuming line, and settles on its own conversation (R6, R9 (h))', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health())
        : stream([
            {
              type: 'posted',
              message: msg({ id: 'c9', conversation: 'c9', from: 'ivy', to: null, kind: 'input', text: 'hi' }),
              working: ['keep-1'],
            },
            { type: 'message', message: msg({ conversation: 'c9', text: 'hello' }), working: ['keep-1'] },
            {
              type: 'message',
              message: {
                ...msg({ conversation: 'c9', from: 'asha', kind: 'status', to: null }),
                text: "⚠ keep-1's state is not being saved (over_bound); what it does from now on is lost when it stops",
              },
              working: ['keep-1'],
            },
            { type: 'status', conversation: 'c9', working: [] },
          ]),
    );
    const { ctx, home, out, err } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['user=ivy', 'message=hi'], ctx)).toBe(EXIT.ok);
    expect(out).toEqual(['hello\n']);
    expect(err).toEqual([
      "⚠ keep-1's state is not being saved (over_bound); what it does from now on is lost when it stops\n",
    ]);
  });
});

/** A home with saved state: the keeper's memory and workspace, a pending record, and a channel's board. */
async function savedHome(home: string): Promise<StateStore> {
  const state = new StateStore({
    dir: join(home, 'state'),
    fs: nodeStateFs,
    logger: new RecordingLogger(),
    clock: () => new Date('2026-09-29T10:00:00.000Z'),
    insideGitTree: () => Promise.resolve(false),
  });
  const feed = (tar: Buffer) => async (push: (c: Uint8Array) => Promise<unknown>) => {
    await push(tar);
  };
  const gen = await state.begin(state.agentDir({ channel: 'main', team: null, name: 'keeper' }));
  await gen.writeTar('memory', ASSET_BOUNDS.memory, feed(assetTar('memory', { 'a/f.json': 'x' })));
  await gen.promote(
    {
      kind: 'agent',
      recipe: 'keeper',
      image: 'keeper-image',
      source: 's',
      schema: '1',
      lastDelivery: null,
      handle: 'keep-1',
    } as never,
    'main/-/keeper',
  );
  const board = await state.begin(state.channelDir('main'));
  await board.writeJson('board', { session: 1, entries: [] }, 0);
  await board.promote({ kind: 'channel', team: 'solo', lastDelivery: null, memoryTainted: false } as never, 'main');
  return state;
}

describe('--list-state and --reset-state (R5; A4)', () => {
  const listed: StateListResponse = {
    assets: [
      {
        kind: 'agent',
        identity: 'main/-/keeper',
        asset: 'memory',
        bytes: 2048,
        savedAt: '2026-09-29T10:00:00.000Z',
        full: true,
        tainted: false,
      },
      {
        kind: 'channel',
        identity: 'main',
        asset: 'board',
        bytes: 40,
        savedAt: '2026-09-29T10:00:00.000Z',
        full: false,
        tainted: true,
      },
    ],
    pending: [{ identity: 'main/-/keeper', bytes: 300, savedAt: '2026-09-29T09:00:00.000Z' }],
    totalBytes: 2388,
  };

  it('lists through a running daemon, exactly', async () => {
    const f = new FakeFetch((url) => (url.endsWith('/v1/health') ? json(200, health()) : json(200, listed)));
    const { ctx, home, out } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--list-state'], ctx)).toBe(EXIT.ok);
    expect(present(f.requests.at(-1), 'f.requests.at(-1)').url).toBe('http://127.0.0.1:5555/v1/state');
    expect(out).toEqual([
      'agent main/-/keeper memory 2048 2026-09-29T10:00:00.000Z full\n',
      'channel main board 40 2026-09-29T10:00:00.000Z tainted\n',
      'agent main/-/keeper pending 300 2026-09-29T09:00:00.000Z\n',
      'total 2388 in 3 assets\n',
    ]);
  });

  it('says nothing saved, exit 0 — with no daemon and no home, creating nothing', async () => {
    const { ctx, home, out } = await context();
    expect(await runCli(['--list-state'], ctx)).toBe(EXIT.ok);
    expect(out).toEqual(['nothing saved\n']);
    await expect(access(home)).resolves.toBeUndefined();
    expect(await readdir(home)).toEqual([]);
  });

  it('with no daemon, lists the files themselves under daemon.lock, taken and released', async () => {
    const { ctx, home, out, logger } = await context();
    await savedHome(home);
    expect(await runCli(['--list-state'], ctx)).toBe(EXIT.ok);
    const totalWords = present(out.at(-1), 'out.at(-1)').split(' ');
    expect(out.map((l) => l.split(' ').slice(0, 3).join(' '))).toEqual([
      'agent main/-/keeper memory',
      'channel main board',
      'total ' + present(totalWords[1], "out.at(-1)'s second word") + ' in',
    ]);
    await expect(access(join(home, 'daemon.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(logger.entries.filter((e) => e.level !== 'info')).toEqual([]);
  });

  it('refuses, removing nothing, when a live process holds daemon.lock and no daemon answers', async () => {
    const { ctx, home, err } = await context({ isAlive: () => true });
    await savedHome(home);
    await writeFile(join(home, 'daemon.lock'), '4242');
    expect(await runCli(['--reset-state', 'channel=main', 'name=keeper'], ctx)).toBe(EXIT.failed);
    expect(err).toEqual([`✗ ${join(home, 'daemon.lock')} is held by live process 4242\n`]);
    expect((await readdir(join(home, 'state', 'agents', 'main', '-'))).sort(byCodeUnit)).toEqual(['keeper']);
  });

  it('while the CLI holds daemon.lock (waiting for its confirmation), a daemon start is refused LockHeld', async () => {
    let answer!: (line: string) => void;
    const typed = new Promise<string>((r) => (answer = r));
    const { ctx, home, out } = await context({ inputTerminal: true });
    const lines = {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: await typed }) }),
    };
    (ctx as { input: unknown }).input = { lines, isTerminal: true };
    await savedHome(home);
    const running = runCli(['--reset-state', 'all'], ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      acquirePidLock({
        file: join(home, 'daemon.lock'),
        pid: 999,
        isAlive: (pid) => pid === 111,
        logger: new RecordingLogger(),
      }),
    ).rejects.toThrow(LockHeld);
    answer('reset');
    expect(await running).toBe(EXIT.ok);
    expect(out.filter((l) => l.startsWith('removed'))).toEqual([
      expect.stringMatching(/^removed agent main\/-\/keeper memory \(\d+ bytes\)\n$/),
      expect.stringMatching(/^removed channel main board \(\d+ bytes\)\n$/),
    ]);
  });

  it('on a terminal, anything but the word reset cancels, removing nothing; off one, --yes is required', async () => {
    for (const [terminal, args, lines] of [
      [true, ['--reset-state', 'channel=main'], ['no']],
      [false, ['--reset-state', 'channel=main'], []],
    ] as const) {
      const { ctx, home, out, err } = await context({ inputTerminal: terminal, lines: [...lines] });
      await savedHome(home);
      expect(await runCli([...args], ctx)).toBe(EXIT.failed);
      expect(out.filter((l) => l.startsWith('removed'))).toEqual([]);
      expect(err.at(-1)).toBe('✗ reset cancelled\n');
      expect(out.at(-1)).toMatch(/^total \d+ in 2 assets\n$/);
    }
    const { ctx, home, out } = await context({});
    await savedHome(home);
    expect(await runCli(['--reset-state', 'channel=main', '--yes'], ctx)).toBe(EXIT.ok);
    expect(out.filter((l) => l.startsWith('removed'))).toHaveLength(2);
  });

  it('through a daemon: one agent with no confirmation, its removals printed; online and nothing_matches refused, exit 1', async () => {
    const answers = [
      json(200, {
        removed: [
          { kind: 'agent', identity: 'main/-/keeper', asset: 'memory', bytes: 2048 },
          { kind: 'agent', identity: 'main/-/keeper', asset: 'pending', bytes: 300 },
        ],
      }),
      json(409, { error: 'main/-/keeper is online; stop it first (asha --stop)', reason: 'online' }),
      json(409, { error: 'nothing saved matches channel=main name=nobody', reason: 'nothing_matches' }),
    ];
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health') ? json(200, health()) : present(answers.shift(), 'answers.shift()'),
    );
    const { ctx, home, out, err } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--reset-state', 'channel=main', 'name=keeper'], ctx)).toBe(EXIT.ok);
    const last = present(f.requests.at(-1), 'f.requests.at(-1)');
    expect(JSON.parse(present(last.init, 'last.init').body as string)).toEqual({ channel: 'main', name: 'keeper' });
    expect(out).toEqual([
      'removed agent main/-/keeper memory (2048 bytes)\n',
      'removed agent main/-/keeper pending (300 bytes)\n',
    ]);
    expect(await runCli(['--reset-state', 'channel=main', 'name=keeper'], ctx)).toBe(EXIT.failed);
    expect(await runCli(['--reset-state', 'channel=main', 'name=nobody'], ctx)).toBe(EXIT.failed);
    expect(err).toEqual([
      '✗ main/-/keeper is online; stop it first (asha --stop)\n',
      '✗ nothing saved matches channel=main name=nobody\n',
    ]);
  });

  it.each([
    [['channel=../x'], 'channel=../x is not a valid channel name'],
    [['channel=main', 'name=a/b'], 'name=a/b is not a valid agent name'],
    [['channel=main', 'name=a', 'team=.x'], 'team=.x is not a valid team name'],
    [[`channel=${'c'.repeat(33)}`], `channel=${'c'.repeat(33)} is not a valid channel name`],
  ])(
    'refuses %j with exit 2, before any daemon or file is touched, creating and removing nothing',
    async (selector, problem) => {
      for (const online of [false, true]) {
        const f = new FakeFetch(() => {
          throw new Error('no request expected');
        });
        const { ctx, home, err } = await context({ fetch: f.fetch });
        if (online) await daemonFile(home);
        await savedHome(home);
        const before = JSON.stringify(await readdir(home, { recursive: true }));
        expect(await runCli(['--reset-state', ...selector], ctx)).toBe(EXIT.usage);
        expect(err).toEqual([`✗ ${problem}\n`]);
        expect(f.requests).toEqual([]);
        expect(JSON.stringify(await readdir(home, { recursive: true }))).toBe(before);
      }
    },
  );
});

describe('--reset-state … user=<id> (R16; A16)', () => {
  const erase = (events: unknown[]) =>
    new FakeFetch((url) => {
      if (url.endsWith('/v1/health')) return json(200, health());
      if (url.endsWith('/v1/state'))
        return json(200, {
          assets: [
            {
              kind: 'agent',
              identity: 'main/-/keeper',
              asset: 'memory',
              bytes: 10,
              savedAt: 't',
              full: false,
              tainted: false,
            },
          ],
          pending: [],
          totalBytes: 10,
        });
      return stream(events);
    });

  it("prints each identity's line, the pending line, the kept lines, and exits 0 when every identity succeeded", async () => {
    const f = erase([
      { type: 'erased', identity: 'main/-/keeper', files: 2, bytes: 25, pendingMessages: 1 },
      { type: 'kept', kind: 'agent', identity: 'main/-/keeper', asset: 'workspace' },
      { type: 'erase_done' },
    ]);
    const { ctx, home, out, err } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--reset-state', 'channel=main', 'name=keeper', 'user=ivy'], ctx)).toBe(EXIT.ok);
    const last = present(f.requests.at(-1), 'f.requests.at(-1)');
    expect(JSON.parse(present(last.init, 'last.init').body as string)).toEqual({
      channel: 'main',
      name: 'keeper',
      user: 'ivy',
    });
    expect(out).toEqual([
      'erased user ivy from agent main/-/keeper memory (2 files, 25 bytes)\n',
      'erased user ivy from agent main/-/keeper pending (1 messages)\n',
      'kept agent main/-/keeper workspace: shared by every user of the channel, not erased\n',
    ]);
    expect(err).toEqual([]);
  });

  it('prints no memory and a failure line with the pending messages already removed, goes on, and exits 1', async () => {
    const f = erase([
      { type: 'no_memory', identity: 'main/-/a', pendingMessages: 0 },
      { type: 'erase_failed', identity: 'main/-/b', reason: 'erase_not_subset', pendingMessages: 2 },
      { type: 'kept', kind: 'channel', identity: 'main', asset: 'board' },
      { type: 'erase_done' },
    ]);
    const { ctx, home, out, err } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--reset-state', 'channel=main', 'user=ivy', '--yes'], ctx)).toBe(EXIT.failed);
    expect(out).toEqual([
      'agent main/-/keeper memory 10 t\n',
      'total 10 in 1 assets\n',
      'no memory of user ivy in agent main/-/a\n',
      'erased user ivy from agent main/-/b pending (2 messages)\n',
      'kept channel main board: shared by every user of the channel, not erased\n',
    ]);
    expect(err).toEqual(['✗ could not erase user ivy from agent main/-/b: erase_not_subset\n']);
  });

  it.each([
    [['all', 'user=ivy'], 'user= needs channel=: a user ID names a person only on one channel'],
    [
      ['channel=main', 'user=Ivy'],
      'a user ID is 1 to 32 characters: a lowercase letter, then lowercase letters, digits or hyphens',
    ],
    [['channel=main', 'user=asha'], '"asha" is the harness\'s own name'],
  ])('refuses %j with exit 2', async (args, reason) => {
    const { ctx, err } = await context();
    expect(await runCli(['--reset-state', ...args], ctx)).toBe(EXIT.usage);
    expect(err).toEqual([`✗ ${reason}\n`]);
  });

  it('an online identity is refused, exit 1, nothing erased', async () => {
    const f = new FakeFetch((url) =>
      url.endsWith('/v1/health')
        ? json(200, health())
        : json(409, { error: 'main/-/keeper is online; stop it first (asha --stop)', reason: 'online' }),
    );
    const { ctx, home, err } = await context({ fetch: f.fetch });
    await daemonFile(home);
    expect(await runCli(['--reset-state', 'channel=main', 'name=keeper', 'user=ivy'], ctx)).toBe(EXIT.failed);
    expect(err).toEqual(['✗ main/-/keeper is online; stop it first (asha --stop)\n']);
  });

  it('stays attached while heartbeats come — longer than its inactivity bound — and gives up when they stop', async () => {
    const beating = new FakeFetch((url) => {
      if (url.endsWith('/v1/health')) return json(200, health());
      let n = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            n += 1;
            controller.enqueue(new TextEncoder().encode(n < 10 ? SSE_HEARTBEAT : sseEvent({ type: 'erase_done' })));
            if (n >= 10) controller.close();
          },
        }),
        SSE_OK,
      );
    });
    const a = await context({
      fetch: beating.fetch,
      timing: {
        serverStartMs: 20,
        serverStopMs: 20,
        streamIdleMs: 60,
        pollMs: 1,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
    });
    await daemonFile(a.home);
    expect(await runCli(['--reset-state', 'channel=main', 'name=keeper', 'user=ivy'], a.ctx)).toBe(EXIT.ok);
    const silent = new FakeFetch((url, init) => {
      if (url.endsWith('/v1/health')) return json(200, health());
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) =>
            init?.signal?.addEventListener('abort', () => {
              c.error(present(init.signal, 'init.signal').reason);
            }),
        }),
        SSE_OK,
      );
    });
    const b = await context({
      fetch: silent.fetch,
      timing: {
        serverStartMs: 20,
        serverStopMs: 20,
        streamIdleMs: 60,
        pollMs: 1,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
    });
    await daemonFile(b.home);
    expect(await runCli(['--reset-state', 'channel=main', 'name=keeper', 'user=ivy'], b.ctx)).toBe(EXIT.failed);
    expect(b.err.at(-1)).toBe('✗ no word from the daemon for 60 ms; see its log\n');
    await readFile(join(b.home, 'daemon.json'));
  });
});
