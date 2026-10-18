// The CLI's side of files for agents (docs/plans/agent-files.md R1, R2, R3a, R7, R8, R12a, R13; A1, A2, A5, A6, A10),
// against a fake daemon that serves the space stream, reads the upload's streamed body, answers the conversation and
// serves returned files — recording, in one order, what the CLI asked and what it printed.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT, USAGE, runCli, type CliContext } from '../../src/cli/commands.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type {
  ConversationEvent,
  ConversationMessage,
  LaunchEvent,
  ReturnedFile,
  SpaceEvent,
  UploadResponse,
  WatchEvent,
} from '../../src/shared/protocol.js';
import { SSE_HEARTBEAT, sseEvent } from '../../src/shared/sse.js';
import { FakeFetch, NOT_INTERACTIVE, NO_PORTAL, json } from '../helpers/fakes.js';
import { listenAt } from '../helpers/unix-socket.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** `input` as `fetch` would log it: the URL string itself, never a default `Object#toString`. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// A garbage collection on demand, for the memory measure (A2): exposed for this file only, at run time.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;
const CREDENTIAL = 'c'.repeat(64);
const SSE_OK = { status: 200, headers: { 'content-type': 'text/event-stream' } } as const;
const sse = (events: readonly unknown[]) =>
  new Response(events.map((e) => sseEvent(e as { type: string })).join(''), SSE_OK);
const health = {
  ok: true,
  pid: 222,
  version: '9.9.9',
  build: 'cli-build-01',
  startedAt: '2026-09-30T00:00:00.000Z',
  agents: [],
};

const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: 'm1',
  channel: 'lab',
  conversation: 'm1',
  user: 'olga',
  from: 'olga',
  to: null,
  kind: 'input',
  text: 'hi',
  at: '2026-09-30T00:00:00.000Z',
  ...over,
});

/** A fake daemon: every route the CLI's file flows call, and the order of requests and prints. */
class FakeDaemon {
  readonly order: string[] = [];
  readonly uploads: { manifest: { name: string; size: number; sha256: string }[]; bytes: Buffer; query: string }[] = [];
  readonly conversations: Record<string, unknown>[] = [];
  readonly spaceRequests: unknown[] = [];
  /** What the space route streams. */
  space: SpaceEvent[] = [{ type: 'space_ready', channel: 'lab', bytes: 0, entries: 0, cloudAgents: [] }];
  /** How the upload is answered; by default 200 with each file in one folder. */
  uploadAnswer: (manifest: { name: string; size: number; sha256: string }[]) => Response | Promise<Response> = (
    manifest,
  ) =>
    json(200, {
      upload: 'u'.repeat(32),
      files: manifest.map((f) => ({ ...f, path: `/channel/upload-0123456789abcdef/${f.name}` })),
    } satisfies UploadResponse);
  /** The reply's files, and how each is served. */
  returned: ReturnedFile[] = [];
  readonly served = new Map<string, () => Response>();
  /** Samples of process.memoryUsage().arrayBuffers while an upload's body is read. */
  readonly memory: number[] = [];
  /** Extra events of a launch. */
  launch: LaunchEvent[] = [];
  watch: WatchEvent[] = [];
  /** Open watch streams: a posted conversation's reply reaches them too, after the post, as the channel's watchers. */
  private readonly watchers: ReadableStreamDefaultController<Uint8Array>[] = [];

  readonly fetch = new FakeFetch(async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/v1/health') return json(200, health);
    this.order.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/channel/space') return this.handleSpace(init);
    if (u.pathname === '/v1/channel/files' && init?.method === 'POST') return this.handleUpload(u, init);
    if (u.pathname.startsWith('/v1/channel/files/')) return this.serveRequestedFile(u, init);
    if (u.pathname === '/v1/conversations') return this.handleConversation(init);
    if (u.pathname === '/v1/agents') return sse(this.launch);
    if (u.pathname === '/v1/channel') return this.handleWatch(init);
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${u.pathname}`);
  });

  private handleSpace(init: RequestInit | undefined): Response {
    this.spaceRequests.push(JSON.parse(present(init, 'init').body as string));
    return sse(this.space);
  }

  private async handleUpload(u: URL, init: RequestInit): Promise<Response> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of init.body as ReadableStream<Uint8Array>) {
      // What the CLI holds, not what it has let go and the collector has not reclaimed yet: collected, then sampled.
      collect();
      this.memory.push(process.memoryUsage().arrayBuffers);
      // Kept only up to 1 MiB, the rest counted: a 20 MB body is never held here either.
      if (size < 1 << 20) parts.push(Buffer.from(chunk));
      size += chunk.byteLength;
    }
    const all = Buffer.concat(parts);
    const newline = all.indexOf(0x0a);
    const manifest = JSON.parse(all.subarray(0, newline).toString()) as {
      name: string;
      size: number;
      sha256: string;
    }[];
    this.uploads.push({ manifest, bytes: all.subarray(newline + 1), query: u.search });
    return this.uploadAnswer(manifest);
  }

  private serveRequestedFile(u: URL, init: RequestInit | undefined): Response {
    const id = present(u.pathname.split('/').at(-1), "u.pathname.split('/').at(-1)");
    const serve = this.served.get(id);
    if (serve === undefined) return json(404, { error: 'no such file', reason: 'not_found' });
    return abortable(serve(), init?.signal ?? undefined);
  }

  private handleConversation(init: RequestInit | undefined): Response {
    const body = JSON.parse(present(init, 'init').body as string) as Record<string, unknown>;
    this.conversations.push(body);
    const posted = msg({ text: String(body['message']), user: String(body['user']), from: String(body['user']) });
    const reply = msg({
      id: 'm2',
      from: 'hewo-1',
      to: String(body['user']),
      kind: 'output',
      text: 'Here you are.',
      ...(this.returned.length === 0 ? {} : { files: this.returned }),
    });
    const events: ConversationEvent[] = [
      { type: 'posted', message: posted, working: ['hewo-1'] },
      { type: 'message', message: reply, working: [] },
    ];
    const view: WatchEvent = { type: 'message', message: reply };
    for (const w of this.watchers)
      setTimeout(() => {
        w.enqueue(new TextEncoder().encode(sseEvent(view)));
      }, 5);
    return sse(events);
  }

  // A watch stays open until the watcher hangs up (its Ctrl-C aborts the request).
  private handleWatch(init: RequestInit | undefined): Response {
    const events = this.watch;
    return new Response(
      new ReadableStream({
        start: (c) => {
          c.enqueue(new TextEncoder().encode([...events.map((e) => sseEvent(e)), SSE_HEARTBEAT].join('')));
          this.watchers.push(c);
          init?.signal?.addEventListener('abort', () => {
            c.error(present(init.signal, 'init.signal').reason);
          });
        },
      }),
      SSE_OK,
    );
  }
}

/** A response whose body errors when the request's signal aborts, as fetch's does. */
function abortable(response: Response, signal: AbortSignal | undefined): Response {
  if (response.body === null || signal === undefined) return response;
  // Node's global fetch types leave `Response.body` unparameterised (`ReadableStream<any>`); every chunk this
  // reader ever sees in fact comes through as Uint8Array, so the cast below is accurate, not a type-level lie.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
  aborted.catch(() => undefined);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await Promise.race([reader.read(), aborted]);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/** A file the fake daemon serves as an agent's returned file. */
function serveFile(d: FakeDaemon, name: string, content: Buffer, over: Partial<ReturnedFile> = {}): ReturnedFile {
  const file = {
    id: sha(name + String(content.length)).slice(0, 32),
    name,
    size: content.length,
    sha256: sha(content),
    ...over,
  };
  d.returned.push(file);
  d.served.set(
    file.id,
    () => new Response(content, { status: 200, headers: { 'content-length': String(content.length) } }),
  );
  return file;
}

async function setup(over: Partial<CliContext> = {}, lines?: readonly string[]) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'asha-cli-files-')));
  const home = join(base, 'asha-home');
  const userHome = join(base, 'user');
  const cwd = join(base, 'work');
  for (const d of [home, userHome, cwd]) await mkdir(d, { recursive: true });
  await writeFile(join(home, 'daemon.json'), JSON.stringify({ pid: 222, port: 4321, credential: CREDENTIAL }));
  const d = new FakeDaemon();
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: { ASHA_HOME: home },
    stdout: (t) => out.push(t),
    stderr: (t) => {
      err.push(t);
      d.order.push(`stderr ${t.trim()}`);
    },
    fetch: d.fetch.fetch,
    root: '/repo',
    version: '9.9.9',
    build: 'cli-build-01',
    pid: 111,
    startDaemon: () => Promise.reject(new Error('not expected')),
    createLogger: () => {
      throw new Error('not expected');
    },
    dependencies: () => {
      throw new Error('not expected');
    },
    shutdownSignals: () => () => undefined,
    spawnServer: () => Promise.reject(new Error('no daemon is started here')),
    kill: () => undefined,
    isAlive: () => true,
    sleep: () => Promise.resolve(),
    // No process holds any pid a test names: a stopping lookup finds no asha daemon (debt-paydown R15).
    processCommand: () => Promise.resolve(null),
    timing: {
      serverStartMs: 200,
      serverStopMs: 200,
      streamIdleMs: 5_000,
      pollMs: 1,
      uploadAnswerMs: 260_000,
      downloadIdleMs: 30_000,
    },
    ...NOT_INTERACTIVE,
    ...NO_PORTAL,
    ...(lines === undefined ? {} : { input: { lines: fromLines(lines), isTerminal: false } }),
    loginName: () => 'olga',
    cwd: () => cwd,
    homeDir: () => userHome,
    ...over,
  };
  return { ctx, d, out, err, cwd, userHome, home };
}

function fromLines(lines: readonly string[]): AsyncIterable<string> {
  let i = 0;
  let done = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (done || i >= lines.length) return Promise.resolve({ done: true as const, value: undefined });
        const index = i;
        i += 1;
        return Promise.resolve({ done: false as const, value: present(lines[index], `lines[${String(index)}]`) });
      },
      return: () => {
        done = true;
        return Promise.resolve({ done: true as const, value: undefined });
      },
    }),
  };
}

describe('file= on a single message (R1, A1)', () => {
  it('repeats: two files attach in one upload, posted with the upload id; file=~/x expands to the home folder', async () => {
    const t = await setup();
    await writeFile(join(t.cwd, 'a.txt'), 'A');
    await writeFile(join(t.userHome, 'x'), 'XX');
    expect(await runCli(['channel=lab', 'file=a.txt', 'file=~/x', 'message=two files'], t.ctx)).toBe(EXIT.ok);
    expect(t.d.uploads).toHaveLength(1);
    const upload = present(t.d.uploads[0], 't.d.uploads[0]');
    expect(upload.manifest).toEqual([
      { name: 'a.txt', size: 1, sha256: sha('A') },
      { name: 'x', size: 2, sha256: sha('XX') },
    ]);
    expect(upload.bytes.toString()).toBe('AXX');
    expect(upload.query).toBe('?channel=lab&user=olga');
    expect(t.d.conversations).toEqual([
      { user: 'olga', channel: 'lab', message: 'two files', attachments: 'u'.repeat(32) },
    ]);
    expect(t.d.order).toEqual(['POST /v1/channel/space', 'POST /v1/channel/files', 'POST /v1/conversations']);
  });

  it('file= with --interactive is a usage error: ✗ and USAGE, exit 2', async () => {
    const t = await setup();
    expect(await runCli(['--interactive', 'file=a.txt'], t.ctx)).toBe(EXIT.usage);
    expect(t.err.join('')).toBe(
      `✗ file= is for a single message: in --interactive, a path in a line attaches its file\n\n${USAGE}`,
    );
  });

  it('in a session, /quit is a command and /watch on <path> attaches nothing: commands are decided first', async () => {
    const t0 = await setup();
    await writeFile(join(t0.cwd, 'a.txt'), 'A');
    const t = await setup({ cwd: () => t0.cwd }, [`/watch on ${join(t0.cwd, 'a.txt')}`, '/quit', 'never read']);
    expect(await runCli(['--interactive', 'channel=lab'], t.ctx)).toBe(EXIT.failed);
    expect(t.err).toEqual(['unknown command /watch; type /quit to leave\n']);
    expect(t.d.order.filter((o) => !o.startsWith('stderr'))).toEqual([]);
  });

  it("a single command's message=/tmp/a.txt attaches nothing: the path rule is a line's", async () => {
    const t = await setup();
    await writeFile(join(t.cwd, 'a.txt'), 'A');
    expect(await runCli(['channel=lab', `message=${join(t.cwd, 'a.txt')}`], t.ctx)).toBe(EXIT.ok);
    expect(t.d.order).toEqual(['POST /v1/conversations']);
    expect(t.d.conversations[0]).not.toHaveProperty('attachments');
  });
});

describe('what cannot attach (R2, R11; A2)', () => {
  async function refusals(t: Awaited<ReturnType<typeof setup>>) {
    const fifo = join(t.cwd, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const socketPath = join(t.cwd, 's.sock');
    const server = createServer();
    await listenAt(server, socketPath);
    await mkdir(join(t.userHome, '.ssh'));
    await writeFile(join(t.userHome, '.ssh', 'id_ed25519'), 'secret');
    await writeFile(join(t.cwd, '.ENV'), 'secret');
    await writeFile(join(t.cwd, 'big.bin'), Buffer.alloc(25_000_001));
    await mkdir(join(t.cwd, 'dir'));
    return {
      close: () => server.close(),
      paths: [
        ['./missing.txt', 'no such file'],
        ['./dir', 'a directory, not a file'],
        ['./fifo', 'not a regular file'],
        ['./s.sock', 'not a regular file'],
        ['~/.ssh/id_ed25519', 'on the credential deny list (a path component .ssh)'],
        ['./.ENV', 'on the credential deny list (a file named .env)'],
        ['./big.bin', 'over 25,000,000 bytes'],
      ] as const,
    };
  }

  it('each file= refuses the whole message, ✗ <path>: <rule>, exit 1, nothing sent', async () => {
    const t = await setup();
    const r = await refusals(t);
    try {
      for (const [path, rule] of r.paths) {
        t.err.length = 0;
        expect(await runCli(['channel=lab', `file=${path}`, 'message=x'], t.ctx), path).toBe(EXIT.failed);
        expect(t.err, path).toEqual([`✗ ${path}: ${rule}\n`]);
      }
      expect(t.d.order.filter((o) => !o.startsWith('stderr'))).toEqual([]);
    } finally {
      r.close();
    }
  });

  it('the same paths as words of an interactive line: ⚠ not attached each, the line posted as typed with no attachment', async () => {
    const t0 = await setup();
    const r = await refusals(t0);
    // A missing path or a folder is a word like any other in a line (rule 7): no warning for those two.
    const named = r.paths.filter(([p]) => !['./missing.txt', './dir'].includes(p));
    const line = `look at ./missing.txt ./dir ${named.map(([p]) => p).join(' ')} please`;
    const run = await setup({ cwd: () => t0.cwd, homeDir: () => t0.userHome }, [line]);
    try {
      expect(await runCli(['--interactive', 'channel=lab'], run.ctx)).toBe(EXIT.ok);
      expect(run.err).toEqual(named.map(([p, rule]) => `⚠ not attached ${p}: ${rule}\n`));
      expect(run.d.conversations).toEqual([{ user: 'olga', channel: 'lab', message: line }]);
      expect(run.d.order.filter((o) => !o.startsWith('stderr'))).toEqual(['POST /v1/conversations']);
    } finally {
      r.close();
    }
  });

  it("a file that would take the space past 1,000 entries by space_ready's usage: file= refused; a line's word not attached, the line posted", async () => {
    const t = await setup();
    await writeFile(join(t.cwd, 'a.txt'), 'A');
    t.d.space = [{ type: 'space_ready', channel: 'lab', bytes: 0, entries: 999, cloudAgents: [] }];
    expect(await runCli(['channel=lab', 'file=./a.txt', 'message=x'], t.ctx)).toBe(EXIT.failed);
    expect(t.err).toEqual(["✗ ./a.txt: channel lab's file space would hold more than 1,000 entries\n"]);
    expect(t.d.order.filter((o) => !o.startsWith('stderr'))).toEqual(['POST /v1/channel/space']);

    const i = await setup({ cwd: () => t.cwd }, ['see ./a.txt']);
    i.d.space = t.d.space;
    expect(await runCli(['--interactive', 'channel=lab'], i.ctx)).toBe(EXIT.ok);
    expect(i.err).toEqual(["⚠ not attached ./a.txt: channel lab's file space would hold more than 1,000 entries\n"]);
    expect(i.d.conversations).toEqual([{ user: 'olga', channel: 'lab', message: 'see ./a.txt' }]);
  });

  it.each([
    [413, 'space_entries', 'the space would hold 1001 entries, over its bound of 1000'],
    [429, 'too_many_uploads', 'channel lab holds 100 uploads no message has used'],
  ])(
    'the daemon answering the upload %i: ✗ upload to channel lab: <status> <rule>; nothing posted; a session reads on',
    async (status, reason, error) => {
      const t = await setup();
      await writeFile(join(t.cwd, 'a.txt'), 'A');
      t.d.uploadAnswer = () => json(status, { error, reason });
      expect(await runCli(['channel=lab', 'file=./a.txt', 'message=x'], t.ctx)).toBe(EXIT.failed);
      expect(t.err).toEqual([`✗ upload to channel lab: ${String(status)} ${reason}: ${error}\n`]);
      expect(t.d.conversations).toEqual([]);

      const i = await setup({ cwd: () => t.cwd }, ['see ./a.txt', 'and then hello']);
      i.d.uploadAnswer = t.d.uploadAnswer;
      expect(await runCli(['--interactive', 'channel=lab'], i.ctx)).toBe(EXIT.failed);
      expect(i.err).toEqual([`✗ upload to channel lab: ${String(status)} ${reason}: ${error}\n`]);
      expect(i.d.conversations).toEqual([{ user: 'olga', channel: 'lab', message: 'and then hello' }]);
    },
  );

  it('the upload carries its bound: no answer within it, ✗ upload to channel lab: no answer in <bound>, exit 1, nothing posted', async () => {
    const t = await setup();
    await writeFile(join(t.cwd, 'a.txt'), 'A');
    const ctx: CliContext = {
      ...t.ctx,
      timing: { ...t.ctx.timing, uploadAnswerMs: 100 },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        // The fake daemon never answers the upload: only the CLI's own bound ends it, by aborting the request.
        if (requestUrl(input).includes('/v1/channel/files') && init?.method === 'POST') {
          return new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => {
              reject(present(init.signal, 'init.signal').reason as Error);
            }),
          );
        }
        return t.d.fetch.fetch(input, init);
      },
    };
    // The bounds the real CLI runs with (completion review, finding 7: this asserted the test's own context): the
    // constants, and main.ts passing them — it runs on import, so its source is read.
    const { UPLOAD_ANSWER_MS, DOWNLOAD_IDLE_MS } = await import('../../src/cli/files.js');
    expect([UPLOAD_ANSWER_MS, DOWNLOAD_IDLE_MS]).toEqual([260_000, 30_000]);
    // main.ts passes both constants (completion review, finding 7); Prettier's 120 columns put them on two lines,
    // so the source-text assertion follows the same formatting and still asserts both.
    expect(await readFile(new URL('../../src/cli/main.ts', import.meta.url), 'utf8')).toContain(
      'uploadAnswerMs: UPLOAD_ANSWER_MS,\n    downloadIdleMs: DOWNLOAD_IDLE_MS',
    );
    expect(await runCli(['channel=lab', 'file=./a.txt', 'message=x'], ctx)).toBe(EXIT.failed);
    expect(t.err).toEqual(['✗ upload to channel lab: no answer in 0.1 s\n']);
    expect(t.d.conversations).toEqual([]);
  });

  it("a file of 20,000,000 bytes is uploaded with the CLI's added memory below 20,000,000 bytes", async () => {
    const t = await setup();
    await writeFile(join(t.cwd, 'big.bin'), Buffer.alloc(20_000_000, 7));
    collect();
    const before = process.memoryUsage().arrayBuffers;
    expect(await runCli(['channel=lab', 'file=./big.bin', 'message=x'], t.ctx)).toBe(EXIT.ok);
    expect(present(t.d.uploads[0], 't.d.uploads[0]').manifest).toEqual([
      { name: 'big.bin', size: 20_000_000, sha256: sha(Buffer.alloc(20_000_000, 7)) },
    ]);
    const peak = Math.max(...t.d.memory) - before;
    expect(t.d.memory.length).toBeGreaterThan(10);
    expect(peak).toBeLessThan(20_000_000);
  });
});

describe('the attached line and the cloud warning (R7, R8; A5, A10)', () => {
  it('the attached line only with --verbose; the line sent exactly as typed, with the file attached (A10)', async () => {
    for (const verbose of [true, false]) {
      const t0 = await setup();
      await writeFile(join(t0.cwd, 'fixture.txt'), 'fixture');
      const line = `${join(t0.cwd, 'fixture.txt')} what is this?`;
      const t = await setup({ cwd: () => t0.cwd }, [line]);
      expect(await runCli(['--interactive', 'channel=lab', ...(verbose ? ['--verbose'] : [])], t.ctx)).toBe(EXIT.ok);
      expect(t.d.conversations).toEqual([{ user: 'olga', channel: 'lab', message: line, attachments: 'u'.repeat(32) }]);
      const attached = t.err.filter((l) => l.startsWith('attached '));
      expect(attached).toEqual(
        verbose
          ? [`attached ${join(t0.cwd, 'fixture.txt')} as /channel/upload-0123456789abcdef/fixture.txt (7 bytes)\n`]
          : [],
      );
      if (!verbose) expect(t.err).toEqual([]);
    }
  });

  it('⚠ for each cloud-granted agent space_ready names, before the upload request', async () => {
    const t = await setup();
    await writeFile(join(t.cwd, 'a.txt'), 'A');
    t.d.space = [
      { type: 'space_ready', channel: 'lab', bytes: 0, entries: 0, cloudAgents: ['cloudy-1', 'web-researcher'] },
    ];
    expect(await runCli(['channel=lab', 'recipe=web-researcher', 'file=./a.txt', 'message=x'], t.ctx)).toBe(EXIT.ok);
    expect(t.d.order).toEqual([
      'POST /v1/channel/space',
      'stderr ⚠ cloudy-1 is cloud-granted: files on channel lab may leave this machine',
      'stderr ⚠ web-researcher is cloud-granted: files on channel lab may leave this machine',
      'POST /v1/channel/files',
      'POST /v1/conversations',
    ]);
    expect(t.d.spaceRequests).toEqual([{ channel: 'lab', recipe: 'web-researcher' }]);
  });

  it('a launch streaming launched with exposesFiles prints the warning; without it, nothing', async () => {
    const t = await setup();
    t.d.launch = [
      {
        type: 'launched',
        agent: { handle: 'cloudy-1', channel: 'lab', recipe: 'cloudy', image: 'x' },
        exposesFiles: true,
      },
    ];
    expect(await runCli(['--launch', 'recipe=cloudy', 'channel=lab'], t.ctx)).toBe(EXIT.ok);
    expect(t.err).toEqual(['⚠ cloudy-1 is cloud-granted: files on channel lab may leave this machine\n']);
    const u = await setup();
    u.d.launch = [{ type: 'launched', agent: { handle: 'hewo-1', channel: 'lab', recipe: 'hello-world', image: 'x' } }];
    expect(await runCli(['--launch', 'recipe=hello-world', 'channel=lab'], u.ctx)).toBe(EXIT.ok);
    expect(u.err).toEqual([]);
  });

  it('the space route ending in error: ✗, nothing uploaded, nothing posted', async () => {
    const t = await setup();
    await writeFile(join(t.cwd, 'a.txt'), 'A');
    t.d.space = [{ type: 'error', reason: 'bad_request', detail: 'no agent on channel lab to read the file' }];
    expect(await runCli(['channel=lab', 'file=./a.txt', 'message=x'], t.ctx)).toBe(EXIT.failed);
    expect(t.err).toEqual(['✗ bad_request: no agent on channel lab to read the file\n']);
    expect(t.d.order.filter((o) => !o.startsWith('stderr'))).toEqual(['POST /v1/channel/space']);
  });
});

describe('returned files saved (R12a, R13; A6)', () => {
  const mode = async (p: string) => ((await stat(p)).mode & 0o777).toString(8);

  it('saved as asha-files/<channel>/<name>, 0644, byte-identical, its file: line after the reply; a second is -2; a link at the name is never written through', async () => {
    const t = await setup();
    const content = Buffer.from('the result\n');
    serveFile(t.d, 'out.txt', content);
    expect(await runCli(['channel=lab', 'message=go'], t.ctx)).toBe(EXIT.ok);
    expect(t.out).toEqual(['Here you are.\n', `file: asha-files/lab/out.txt (11 bytes, sha256 ${sha(content)})\n`]);
    const saved = join(t.cwd, 'asha-files', 'lab', 'out.txt');
    expect(await readFile(saved)).toEqual(content);
    expect(await mode(saved)).toBe('644');
    expect(await readdir(join(t.cwd, 'asha-files', 'lab'))).toEqual(['out.txt']);

    t.out.length = 0;
    expect(await runCli(['channel=lab', 'message=again'], t.ctx)).toBe(EXIT.ok);
    expect(t.out.at(-1)).toBe(`file: asha-files/lab/out-2.txt (11 bytes, sha256 ${sha(content)})\n`);

    // A link already at the next name: the file is saved as -3, and the link's target is untouched.
    const target = join(t.userHome, 'target.txt');
    await writeFile(target, 'keep me');
    await symlink(target, join(t.cwd, 'asha-files', 'lab', 'out-3.txt'));
    t.out.length = 0;
    expect(await runCli(['channel=lab', 'message=third'], t.ctx)).toBe(EXIT.ok);
    expect(t.out.at(-1)).toBe(`file: asha-files/lab/out-4.txt (11 bytes, sha256 ${sha(content)})\n`);
    expect(await readFile(target, 'utf8')).toBe('keep me');
    expect((await readdir(join(t.cwd, 'asha-files', 'lab'))).sort(byCodeUnit)).toEqual([
      'out-2.txt',
      'out-3.txt',
      'out-4.txt',
      'out.txt',
    ]);
  });

  it('a returned name of 255 bytes saves, and so does a second of that name, trimmed to fit its -2 (completion review, findings 3 and 12)', async () => {
    const t = await setup();
    const long = `${'n'.repeat(251)}.txt`;
    const content = Buffer.from('long\n');
    serveFile(t.d, long, content);
    expect(await runCli(['channel=lab', 'message=go'], t.ctx)).toBe(EXIT.ok);
    expect(t.err).toEqual([]);
    expect(await readFile(join(t.cwd, 'asha-files', 'lab', long))).toEqual(content);
    t.out.length = 0;
    expect(await runCli(['channel=lab', 'message=again'], t.ctx)).toBe(EXIT.ok);
    const second = `${'n'.repeat(249)}-2.txt`;
    expect(Buffer.byteLength(second)).toBe(255);
    expect(t.out.at(-1)).toBe(`file: asha-files/lab/${second} (5 bytes, sha256 ${sha(content)})\n`);
    expect((await readdir(join(t.cwd, 'asha-files', 'lab'))).sort(byCodeUnit)).toEqual([second, long].sort(byCodeUnit));
  });

  it('a save folder that is a link, and a name the daemon sends as ../x or .x: refused, nothing written', async () => {
    const t = await setup();
    await symlink(t.userHome, join(t.cwd, 'asha-files'));
    serveFile(t.d, 'out.txt', Buffer.from('x'));
    expect(await runCli(['channel=lab', 'message=go'], t.ctx)).toBe(EXIT.failed);
    expect(t.err).toEqual([
      `✗ file out.txt: ${join(t.cwd, 'asha-files')} exists and is not a folder (a link or a file): files are never saved through it\n`,
    ]);
    expect(await readdir(t.userHome)).toEqual([]);

    for (const name of ['../x', '.x']) {
      const u = await setup();
      serveFile(u.d, name, Buffer.from('x'));
      expect(await runCli(['channel=lab', 'message=go'], u.ctx)).toBe(EXIT.failed);
      expect(u.err[0]).toMatch(new RegExp(`^✗ file ${name.replace('.', '\\.')}: `));
      await expect(lstat(join(u.cwd, 'asha-files'))).rejects.toThrow('ENOENT');
    }
  });

  it('a download that ends short, and one that stalls past its bound: ✗, exit 1, no partial file left', async () => {
    const t = await setup();
    const file = serveFile(t.d, 'out.txt', Buffer.from('0123456789'));
    // Five bytes, then the connection is cut (a stream errored in the same pull drops what it queued: two pulls).
    let pulls = 0;
    t.d.served.set(
      file.id,
      () =>
        new Response(
          new ReadableStream({
            pull: (c) => {
              if (pulls++ === 0) c.enqueue(new TextEncoder().encode('01234'));
              else c.error(new TypeError('terminated'));
            },
          }),
          { status: 200 },
        ),
    );
    expect(await runCli(['channel=lab', 'message=go'], t.ctx)).toBe(EXIT.failed);
    expect(t.err).toEqual(['✗ file out.txt: the download was cut short after 5 of 10 bytes (terminated)\n']);
    expect(await readdir(join(t.cwd, 'asha-files', 'lab'))).toEqual([]);

    const s = await setup({
      timing: {
        serverStartMs: 200,
        serverStopMs: 200,
        streamIdleMs: 5_000,
        pollMs: 1,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 100,
      },
    });
    const stalled = serveFile(s.d, 'out.txt', Buffer.from('0123456789'));
    s.d.served.set(
      stalled.id,
      () =>
        new Response(
          new ReadableStream({
            start: (c) => {
              c.enqueue(new TextEncoder().encode('012'));
            },
          }),
          { status: 200 },
        ),
    );
    expect(await runCli(['channel=lab', 'message=go'], s.ctx)).toBe(EXIT.failed);
    expect(s.err).toEqual(['✗ file out.txt: no bytes for 0.1 s\n']);
    expect(await readdir(join(s.cwd, 'asha-files', 'lab'))).toEqual([]);
  });

  it("bytes that differ from the reply's sha256: ✗ naming both, no file saved", async () => {
    const t = await setup();
    serveFile(t.d, 'out.txt', Buffer.from('0123456789'), { sha256: 'f'.repeat(64) });
    expect(await runCli(['channel=lab', 'message=go'], t.ctx)).toBe(EXIT.failed);
    expect(t.err).toEqual([
      `✗ file out.txt: its sha256 is ${sha('0123456789')}, not the ${'f'.repeat(64)} the reply named\n`,
    ]);
    expect(await readdir(join(t.cwd, 'asha-files', 'lab'))).toEqual([]);
  });

  it("a session with /watch on saves its own conversation's file, printing file: after the view has printed the reply", async () => {
    const t = await setup({}, ['/watch on', 'go']);
    t.d.watch = [{ type: 'watching', channel: 'lab', agents: ['hewo-1'] }];
    const file = serveFile(t.d, 'out.txt', Buffer.from('abc'));
    expect(await runCli(['--interactive', 'channel=lab'], t.ctx)).toBe(EXIT.ok);
    expect(t.out.join('')).toBe(
      `» reply from hewo-1:\n00:00:00Z [m1] output hewo-1 → olga: Here you are.\n  file out.txt (3 bytes, sha256 ${file.sha256})\nfile: asha-files/lab/out.txt (3 bytes, sha256 ${file.sha256})\n`,
    );
    expect(await readFile(join(t.cwd, 'asha-files', 'lab', 'out.txt'), 'utf8')).toBe('abc');
  });

  it("--watch prints each returned file's name, size and sha256, and saves nothing", async () => {
    const t = await setup({
      shutdownSignals: (handler) => (
        setTimeout(() => {
          handler('SIGINT');
        }, 50),
        () => undefined
      ),
    });
    const file: ReturnedFile = { id: 'a'.repeat(32), name: 'out.txt', size: 3, sha256: sha('abc') };
    t.d.watch = [
      { type: 'watching', channel: 'lab', agents: ['hewo-1'] },
      {
        type: 'message',
        message: msg({ id: 'm2', from: 'hewo-1', to: 'olga', kind: 'output', text: 'Here.', files: [file] }),
      },
    ];
    expect(await runCli(['--watch', 'channel=lab'], t.ctx)).toBe(EXIT.ok);
    expect(t.out.join('')).toBe(
      `00:00:00Z [m1] output hewo-1 → olga: Here.\n  file out.txt (3 bytes, sha256 ${sha('abc')})\n`,
    );
    await expect(lstat(join(t.cwd, 'asha-files'))).rejects.toThrow('ENOENT');
  });
});
