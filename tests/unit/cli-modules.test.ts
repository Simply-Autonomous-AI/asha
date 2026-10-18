// The module commands (docs/plans/extension-modules.md R4, R7, R24, R36; A4, A31, A36): install and uninstall only
// while no daemon of the home answers, holding daemon.lock, with the summary and the confirmation; the image built
// at install; `--set-secret` from standard input alone, into a 0600 file in a 0700 directory, never over HTTP, under
// secrets.lock.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DAEMON_RUNNING } from '../../src/cli/modules.js';
import { EXIT, runCli, type CliContext } from '../../src/cli/commands.js';
import { acquirePidLock, LockHeld } from '../../src/daemon/process/pid-lock.js';
import { present } from '../../src/shared/assert-present.js';
import { FakeRuntime } from '../helpers/daemon-fakes.js';
import { FakeFetch, NOT_INTERACTIVE, NO_PORTAL, RecordingLogger, json } from '../helpers/fakes.js';
import { cloudToolManifest, fixtureSecret, toolModuleManifest, writeModuleDir } from '../helpers/modules.js';

const CREDENTIAL = 'c'.repeat(64);
const health = {
  ok: true,
  pid: 222,
  version: '9.9.9',
  build: 'cli-build-01',
  startedAt: '2026-10-01T00:00:00.000Z',
  agents: [],
};
const LOCK = '{"lockfileVersion":3,"packages":{"":{}}}\n';
const ENTRY = 'export async function call() { return { ok: true, result: 1 }; }\n';

/** A repo root with what a module image is staged from: the module base's Dockerfile and the compiled runtime. */
async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asha-root-'));
  await mkdir(join(root, 'harness-images', 'module-base'), { recursive: true });
  await writeFile(join(root, 'harness-images', 'module-base', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(root, 'dist', 'src', 'module-runtime'), { recursive: true });
  await writeFile(join(root, 'dist', 'src', 'module-runtime', 'main.js'), '// runtime\n');
  return root;
}

type ContextOverride = Partial<CliContext> & { lines?: string[]; inputTerminal?: boolean; daemonAnswers?: boolean };

/** `over` minus its three test-only fields, for the final `...rest` spread onto `ctx`. */
function withoutTestFields(over: ContextOverride): Partial<CliContext> {
  const rest: ContextOverride = { ...over };
  delete rest.lines;
  delete rest.inputTerminal;
  delete rest.daemonAnswers;
  return rest;
}

async function context(over: ContextOverride = {}) {
  const home = await mkdtemp(join(tmpdir(), 'asha-cli-m-'));
  const out: string[] = [];
  const err: string[] = [];
  const logger = new RecordingLogger();
  const runtime = new FakeRuntime();
  const fetches = new FakeFetch((url) => {
    if (over.daemonAnswers === true && url.endsWith('/v1/health')) return json(200, health);
    throw new TypeError('connect ECONNREFUSED');
  });
  const lines = over.lines ?? [];
  const rest = withoutTestFields(over);
  const ctx: CliContext = {
    env: { ASHA_HOME: home },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    fetch: fetches.fetch,
    root: await fixtureRoot(),
    version: '9.9.9',
    build: 'cli-build-01',
    pid: 111,
    startDaemon: () => Promise.reject(new Error('startDaemon not expected')),
    createLogger: () => logger,
    dependencies: () => ({ runtime }) as unknown as ReturnType<CliContext['dependencies']>,
    shutdownSignals: () => () => undefined,
    spawnServer: () => Promise.reject(new Error('spawnServer not expected')),
    kill: () => undefined,
    isAlive: (pid) => pid === 4242,
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
    cwd: () => home,
    homeDir: () => home,
    ...rest,
  };
  if (over.daemonAnswers === true) {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'daemon.json'), JSON.stringify({ pid: 222, port: 5555, credential: CREDENTIAL }));
  }
  return { ctx, home, out, err, logger, runtime, fetches };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('--install-module (R4, R36; A4, A36)', () => {
  it('with a daemon answering, exits 1 with the "stop it first" line and writes nothing', async () => {
    const { ctx, home, err } = await context({ daemonAnswers: true });
    const source = await writeModuleDir(toolModuleManifest(), { 'index.mjs': ENTRY, 'package-lock.json': LOCK });
    expect(await runCli(['--install-module', `path=${source}`, '--yes'], ctx)).toBe(EXIT.failed);
    expect(err).toEqual([DAEMON_RUNNING]);
    expect(await exists(join(home, 'modules'))).toBe(false);
  });

  it('with none answering, holds daemon.lock, prints the summary, asks on a terminal, installs on "yes" and builds its image', async () => {
    let lockHeld = false;
    const { ctx, home, out, err, runtime } = await context({ inputTerminal: true, lines: ['yes'] });
    const source = await writeModuleDir(toolModuleManifest(), { 'index.mjs': ENTRY, 'package-lock.json': LOCK });
    const original = ctx.input.lines;
    const probing: CliContext = {
      ...ctx,
      input: {
        isTerminal: true,
        lines: {
          [Symbol.asyncIterator]: () => {
            // At the confirmation, the daemon's lock is held: a daemon starting now fails LockHeld.
            return {
              next: async () => {
                try {
                  await acquirePidLock({
                    file: join(home, 'daemon.lock'),
                    pid: 999,
                    isAlive: (p) => p === 111,
                    logger: new RecordingLogger(),
                  });
                } catch (error) {
                  lockHeld = error instanceof LockHeld && error.holderPid === 111;
                }
                return original[Symbol.asyncIterator]().next();
              },
            };
          },
        },
      },
    };
    expect(await runCli(['--install-module', `path=${source}`], probing)).toBe(EXIT.ok);
    expect(lockHeld).toBe(true);
    expect(out[0]).toContain('module fixture_tool 1.0.0 (ToolModule)');
    expect(out.at(-1)).toBe('installed fixture_tool 1.0.0\n');
    expect(err).toEqual(['Install this module? Type yes to install: ']);
    expect(await exists(join(home, 'modules', 'fixture_tool', 'module.json'))).toBe(true);
    expect(await exists(join(home, 'daemon.lock'))).toBe(false);
    expect(runtime.images.map((i) => i.repository)).toEqual(['asha-harness-module-base', 'asha-module-fixture_tool']);
  });

  it('a typed answer other than "yes" installs nothing', async () => {
    for (const answer of ['y', 'YES', '']) {
      const { ctx, home, err } = await context({ inputTerminal: true, lines: [answer] });
      const source = await writeModuleDir(toolModuleManifest(), { 'index.mjs': ENTRY, 'package-lock.json': LOCK });
      expect(await runCli(['--install-module', `path=${source}`], ctx)).toBe(EXIT.failed);
      expect(err.at(-1)).toBe('✗ module fixture_tool was not installed: not confirmed\n');
      expect(await exists(join(home, 'modules', 'fixture_tool'))).toBe(false);
    }
  });

  it('with no terminal and no --yes, refuses and writes nothing', async () => {
    const { ctx, home, err } = await context();
    const source = await writeModuleDir(toolModuleManifest(), { 'index.mjs': ENTRY, 'package-lock.json': LOCK });
    expect(await runCli(['--install-module', `path=${source}`], ctx)).toBe(EXIT.failed);
    expect(err).toEqual([
      '✗ not at a terminal: add --yes to confirm\n',
      '✗ module fixture_tool was not installed: not confirmed\n',
    ]);
    expect(await exists(join(home, 'modules', 'fixture_tool'))).toBe(false);
  });

  it('with daemon.lock held by a live process, exits 1 naming its pid and writes nothing', async () => {
    const { ctx, home, err } = await context();
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'daemon.lock'), '4242');
    const source = await writeModuleDir(toolModuleManifest(), { 'index.mjs': ENTRY, 'package-lock.json': LOCK });
    expect(await runCli(['--install-module', `path=${source}`, '--yes'], ctx)).toBe(EXIT.failed);
    expect(err[0]).toContain('is held by live process 4242');
    expect(await exists(join(home, 'modules'))).toBe(false);
  });
});

describe('--uninstall-module (R4, R36; A4, A36)', () => {
  it('with a daemon answering, exits 1 with the "stop it first" line and removes nothing', async () => {
    const { ctx, home, err } = await context({ daemonAnswers: true });
    await mkdir(join(home, 'modules', 'fixture_tool'), { recursive: true });
    expect(await runCli(['--uninstall-module', 'id=fixture_tool', '--yes'], ctx)).toBe(EXIT.failed);
    expect(err).toEqual([DAEMON_RUNNING]);
    expect(await exists(join(home, 'modules', 'fixture_tool'))).toBe(true);
  });

  it('with none answering, prints the summary, and removes the module directory and its secrets', async () => {
    const { ctx, home, out } = await context();
    const install = await context();
    // Installed into this home, and a secret set, by the commands themselves.
    const source = await writeModuleDir(cloudToolManifest(), { 'index.mjs': ENTRY, 'package-lock.json': LOCK });
    expect(
      await runCli(['--install-module', `path=${source}`, '--yes'], { ...install.ctx, env: { ASHA_HOME: home } }),
    ).toBe(EXIT.ok);
    const secret = await context({ lines: [fixtureSecret('SEARCH_KEY')] });
    expect(
      await runCli(['--set-secret', 'module=fixture_search', 'name=SEARCH_KEY'], {
        ...secret.ctx,
        env: { ASHA_HOME: home },
      }),
    ).toBe(EXIT.ok);
    expect(await exists(join(home, 'secrets', 'fixture_search.json'))).toBe(true);
    expect(await runCli(['--uninstall-module', 'id=fixture_search', '--yes'], ctx)).toBe(EXIT.ok);
    expect(out.join('')).toContain('its stored secrets, removed with it: SEARCH_KEY');
    expect(out.at(-1)).toBe('uninstalled fixture_search\n');
    expect(await exists(join(home, 'modules', 'fixture_search'))).toBe(false);
    expect(await exists(join(home, 'secrets', 'fixture_search.json'))).toBe(false);
  });

  it('refuses a module that is not installed', async () => {
    const { ctx, err } = await context();
    expect(await runCli(['--uninstall-module', 'id=nothing_here', '--yes'], ctx)).toBe(EXIT.failed);
    expect(err).toEqual(['✗ no module nothing_here is installed\n']);
  });
});

describe('--set-secret (R7, R24, R36; A31, A36)', () => {
  async function installed(home: string): Promise<void> {
    const install = await context();
    const source = await writeModuleDir(cloudToolManifest(), { 'index.mjs': ENTRY, 'package-lock.json': LOCK });
    expect(
      await runCli(['--install-module', `path=${source}`, '--yes'], { ...install.ctx, env: { ASHA_HOME: home } }),
    ).toBe(EXIT.ok);
  }

  it('refuses a value given as an argument, as a usage error', async () => {
    const { ctx, err } = await context();
    expect(
      await runCli(['--set-secret', 'module=fixture_search', 'name=SEARCH_KEY', `value=${fixtureSecret('X')}`], ctx),
    ).toBe(EXIT.usage);
    expect(err[0]).toContain('a secret is never given as an argument');
    expect(err.join('')).not.toContain(fixtureSecret('X'));
  });

  it('stores the value from standard input, printing only its name and length: the file 0600, its directory 0700, no HTTP request', async () => {
    const value = fixtureSecret('SEARCH_KEY');
    const { ctx, home, out, fetches } = await context({ lines: [value] });
    await installed(home);
    const before = fetches.requests.length;
    expect(await runCli(['--set-secret', 'module=fixture_search', 'name=SEARCH_KEY'], ctx)).toBe(EXIT.ok);
    expect(out).toEqual([`stored fixture_search/SEARCH_KEY (${String(value.length)} characters)\n`]);
    expect(fetches.requests).toHaveLength(before);
    expect(JSON.parse(await readFile(join(home, 'secrets', 'fixture_search.json'), 'utf8'))).toEqual({
      SEARCH_KEY: value,
    });
    expect((await stat(join(home, 'secrets', 'fixture_search.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, 'secrets'))).mode & 0o777).toBe(0o700);
  });

  it('refuses at a terminal, where the value would be shown as typed', async () => {
    const { ctx, home, err } = await context({ inputTerminal: true, lines: ['x'] });
    await installed(home);
    expect(await runCli(['--set-secret', 'module=fixture_search', 'name=SEARCH_KEY'], ctx)).toBe(EXIT.failed);
    expect(err[0]).toContain('pipe it in');
  });

  for (const [name, plant] of [
    ['a .git directory above ASHA_HOME', (parent: string) => mkdir(join(parent, '.git'))],
    [
      'a .git file above ASHA_HOME (a worktree)',
      (parent: string) => writeFile(join(parent, '.git'), 'gitdir: /elsewhere\n'),
    ],
    [
      'ASHA_HOME itself holding .git',
      (_parent: string, home: string) => mkdir(join(home, '.git'), { recursive: true }),
    ],
  ] as const) {
    it(`refuses with ${name}, naming the rule, writing nothing`, async () => {
      const parent = await mkdtemp(join(tmpdir(), 'asha-git-'));
      const home = join(parent, 'home');
      await mkdir(home);
      const install = await context();
      const source = await writeModuleDir(cloudToolManifest(), { 'index.mjs': ENTRY, 'package-lock.json': LOCK });
      expect(
        await runCli(['--install-module', `path=${source}`, '--yes'], { ...install.ctx, env: { ASHA_HOME: home } }),
      ).toBe(EXIT.ok);
      await plant(parent, home);
      const { ctx, err } = await context({ lines: [fixtureSecret('SEARCH_KEY')] });
      expect(
        await runCli(['--set-secret', 'module=fixture_search', 'name=SEARCH_KEY'], {
          ...ctx,
          env: { ASHA_HOME: home },
        }),
      ).toBe(EXIT.failed);
      expect(err[0]).toContain('is inside a git working tree');
      expect(await exists(join(home, 'secrets', 'fixture_search.json'))).toBe(false);
    });
  }

  it('while another holds secrets.lock, exits 1 naming the holder and writes nothing; run again, it succeeds', async () => {
    const { ctx, home, err } = await context({ lines: [fixtureSecret('SEARCH_KEY')] });
    await installed(home);
    await mkdir(join(home, 'secrets'), { recursive: true, mode: 0o700 });
    await writeFile(join(home, 'secrets', 'secrets.lock'), '4242');
    expect(await runCli(['--set-secret', 'module=fixture_search', 'name=SEARCH_KEY'], ctx)).toBe(EXIT.failed);
    expect(err[0]).toContain('secrets.lock is held by live process 4242');
    expect(await exists(join(home, 'secrets', 'fixture_search.json'))).toBe(false);
    const { rm } = await import('node:fs/promises');
    await rm(join(home, 'secrets', 'secrets.lock'));
    const again = await context({ lines: [fixtureSecret('SEARCH_KEY')] });
    expect(
      await runCli(['--set-secret', 'module=fixture_search', 'name=SEARCH_KEY'], {
        ...again.ctx,
        env: { ASHA_HOME: home },
      }),
    ).toBe(EXIT.ok);
  });

  it('refuses a name the module does not declare, and a module not installed', async () => {
    const { ctx, home, err } = await context({ lines: ['v'] });
    await installed(home);
    expect(await runCli(['--set-secret', 'module=fixture_search', 'name=OTHER_KEY'], ctx)).toBe(EXIT.failed);
    expect(err[0]).toBe('✗ module fixture_search declares no secret OTHER_KEY; it declares SEARCH_KEY\n');
    const second = await context({ lines: ['v'] });
    expect(await runCli(['--set-secret', 'module=absent', 'name=X'], second.ctx)).toBe(EXIT.failed);
    expect(second.err[0]).toBe('✗ no module absent is installed\n');
  });
});

// ---- --approve (R12 (b)–(e); A12) and --enable-module (R18b, R36; A36), against a fake daemon ----

import { requestSha256 } from '../../src/daemon/modules/approvals.js';
import { canonicalJson } from '../../src/shared/jcs.js';
import { sseEvent, SSE_HEARTBEAT } from '../../src/shared/sse.js';
import { vi } from 'vitest';

const APPROVAL_ID = '0123456789abcdef';
/** The arguments' RFC 8785 string, as the daemon holds it: JSON escapes the C0 controls; every other hidden character is raw. */
const HOSTILE = canonicalJson({ note: '\u001b[2J\u009b\u202e\u200b\u00ad\u2028\u{e0041}\ufe0f\u3164é' });
const pending = (over: Record<string, unknown> = {}) => {
  const base = {
    id: APPROVAL_ID,
    agent: 'payer-1',
    channel: 'main',
    user: 'olga',
    module: 'ledger',
    tool: 'transfer',
    arguments: HOSTILE,
    conversation: 'c'.repeat(32),
    at: '2026-10-01T12:00:00.000Z',
    expiresAt: '2026-10-01T12:10:00.000Z',
    timeoutMs: 30_000,
    ...over,
  };
  return { ...base, sha256: requestSha256(base) };
};
const approvedMessage = (outcome: unknown) => ({
  id: 'a1',
  channel: 'main',
  conversation: 'd'.repeat(32),
  user: 'olga',
  from: 'asha',
  to: 'payer-1',
  kind: 'internal',
  text: 'asha made the approved call ledger/transfer (approval 0123456789abcdef): ok',
  at: '2026-10-01T12:01:00.000Z',
  approved: { approval: APPROVAL_ID, module: 'ledger', tool: 'transfer', arguments: HOSTILE, outcome },
});

/** A fake daemon's approval routes: the GET's answer, and the POST's answer — a status, or an event stream the test feeds. */
function approvalDaemon(get: () => Response, post: () => Response | 'stream') {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const posts: unknown[] = [];
  const fetches = new FakeFetch((url, init) => {
    if (url.endsWith('/v1/health')) return json(200, health);
    if (url.endsWith(`/v1/approvals/${APPROVAL_ID}`) && (init?.method ?? 'GET') === 'GET') return get();
    if (url.endsWith(`/v1/approvals/${APPROVAL_ID}`) && init?.method === 'POST') {
      posts.push(JSON.parse(init.body as string));
      const answer = post();
      if (answer !== 'stream') return answer;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          init.signal?.addEventListener('abort', () => {
            c.error(present(init.signal, 'init.signal').reason);
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new TypeError(`unexpected ${url}`);
  });
  const send = (text: string) => {
    controller.enqueue(new TextEncoder().encode(text));
  };
  return {
    fetches,
    posts,
    send,
    end: () => {
      controller.close();
    },
  };
}

describe('--approve (R12 (b)–(e), A12)', () => {
  it('prints the request with every hidden character escaped, its own sha256, posts that sha256, then the ✓ line and the reply', async () => {
    const d = approvalDaemon(
      () => json(200, pending()),
      () => 'stream',
    );
    const { ctx, err, out } = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
    const running = runCli(['--approve', `id=${APPROVAL_ID}`, '--yes'], ctx);
    await vi.waitFor(() => {
      expect(d.posts).toHaveLength(1);
    });
    d.send(
      sseEvent({
        type: 'posted',
        message: approvedMessage({ ok: true, result: { tx: 'tx-9', memo: '\u202e' } }),
        working: ['payer-1'],
      } as never),
    );
    d.send(
      sseEvent({
        type: 'message',
        message: {
          ...approvedMessage({ ok: true, result: {} }),
          id: 'r1',
          from: 'payer-1',
          to: 'olga',
          kind: 'output',
          text: 'Done: tx-9.',
          approved: undefined,
        },
        working: [],
      } as never),
    );
    expect(await running).toBe(EXIT.ok);
    const shown = err.join('');
    expect(shown).toContain(
      '  arguments:    {"note":"\\u001b[2J\\u009b\\u202e\\u200b\\u00ad\\u2028\\u{e0041}\\ufe0f\\u3164é"}',
    );
    for (const raw of ['\u001b', '\u009b', '\u202e', '\u200b', '\u00ad', '\u2028', '\u{e0041}', '\ufe0f', '\u3164'])
      expect(shown.includes(raw)).toBe(false);
    expect(shown).toContain(`  sha256:       ${pending().sha256}`);
    expect(shown).toContain('  agent:        payer-1\n  channel:      main\n');
    expect(shown).toContain('  call:         ledger/transfer\n');
    expect(d.posts).toEqual([{ sha256: pending().sha256 }]);
    expect(shown).toContain(
      '✓ approval 0123456789abcdef: asha made the call ledger/transfer: ok\n{"tx":"tx-9","memo":"\\u202e"}\n',
    );
    expect(out.join('')).toBe('Done: tx-9.\n');
  });

  it('refuses unknown, expired and agent_gone ids, exit 1, posting nothing', async () => {
    for (const reason of ['unknown', 'expired', 'agent_gone']) {
      const d = approvalDaemon(
        () => json(404, { error: `approval ${APPROVAL_ID}: ${reason}`, reason }),
        () => json(500, {}),
      );
      const { ctx, err } = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
      expect(await runCli(['--approve', `id=${APPROVAL_ID}`, '--yes'], ctx)).toBe(EXIT.failed);
      expect(err.join('')).toBe(`✗ approval ${APPROVAL_ID}: ${reason}\n`);
      expect(d.posts).toEqual([]);
    }
  });

  it("refuses when the daemon's sha256 differs from the one it computes from what it printed, sending no POST", async () => {
    const d = approvalDaemon(
      () => json(200, { ...pending(), sha256: 'f'.repeat(64) }),
      () => json(500, {}),
    );
    const { ctx, err } = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
    expect(await runCli(['--approve', `id=${APPROVAL_ID}`, '--yes'], ctx)).toBe(EXIT.failed);
    expect(err.join('')).toContain(`✗ approval ${APPROVAL_ID}: the request's sha256 does not match what was shown\n`);
    expect(d.posts).toEqual([]);
  });

  it('refuses arguments that are not their own canonical string — a duplicate key, a space — whose sha256 the daemon could match, sending no POST (B-34)', async () => {
    for (const args of ['{"to":"olga","to":"mallory"}', '{"amount": 1}', '{"b":1,"a":2}']) {
      const request = { ...pending(), arguments: args };
      const d = approvalDaemon(
        () => json(200, { ...request, sha256: requestSha256(request) }),
        () => json(500, {}),
      );
      const { ctx, err } = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
      expect(await runCli(['--approve', `id=${APPROVAL_ID}`, '--yes'], ctx)).toBe(EXIT.failed);
      expect(err.join('')).toContain(`✗ approval ${APPROVAL_ID}: the request's arguments are not RFC 8785 JSON\n`);
      expect(d.posts).toEqual([]);
    }
  });

  it('on a terminal approves only on the exact answer yes', async () => {
    for (const typed of ['y', 'YES', '']) {
      const d = approvalDaemon(
        () => json(200, pending()),
        () => json(500, {}),
      );
      const { ctx, err } = await context({
        daemonAnswers: true,
        fetch: d.fetches.fetch,
        inputTerminal: true,
        lines: [typed],
      });
      expect(await runCli(['--approve', `id=${APPROVAL_ID}`], ctx)).toBe(EXIT.failed);
      expect(err.join('')).toContain(
        `Approve this call? Type yes to approve: ✗ approval ${APPROVAL_ID}: not approved\n`,
      );
      expect(d.posts).toEqual([]);
    }
    const d = approvalDaemon(
      () => json(200, pending()),
      () => json(409, { error: 'x', reason: 'mismatch' }),
    );
    const { ctx, err } = await context({
      daemonAnswers: true,
      fetch: d.fetches.fetch,
      inputTerminal: true,
      lines: ['yes'],
    });
    expect(await runCli(['--approve', `id=${APPROVAL_ID}`], ctx)).toBe(EXIT.failed);
    expect(d.posts).toHaveLength(1);
    expect(err.join('')).toContain(`✗ approval ${APPROVAL_ID}: mismatch\n`);
  });

  it('off a terminal without --yes, refuses; a stopping daemon is named', async () => {
    const d = approvalDaemon(
      () => json(200, pending()),
      () => json(503, { error: 'stopping' }),
    );
    const { ctx, err } = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
    expect(await runCli(['--approve', `id=${APPROVAL_ID}`], ctx)).toBe(EXIT.failed);
    expect(err.join('')).toContain(
      `✗ approval ${APPROVAL_ID}: not approved: not at a terminal, and --yes was not given\n`,
    );
    const again = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
    expect(await runCli(['--approve', `id=${APPROVAL_ID}`, '--yes'], again.ctx)).toBe(EXIT.failed);
    expect(again.err.join('')).toContain(`✗ approval ${APPROVAL_ID}: the daemon is stopping\n`);
  });

  it('exits 1 with the ✗ line for unknown_outcome, and the "ran and exited" line for a plugin\'s exit 255', async () => {
    for (const [outcome, line] of [
      [
        { ok: false, reason: 'unknown_outcome' },
        `✗ approval ${APPROVAL_ID}: asha's call ledger/transfer failed: unknown_outcome\n`,
      ],
      [
        { ok: true, result: { exit_code: 255, stdout: '', stderr: 'AccessDenied' } },
        `✗ approval ${APPROVAL_ID}: asha's call ledger/transfer ran and exited 255\n{"exit_code":255,"stdout":"","stderr":"AccessDenied"}\n`,
      ],
    ] as const) {
      const d = approvalDaemon(
        () => json(200, pending()),
        () => 'stream',
      );
      const { ctx, err } = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
      const running = runCli(['--approve', `id=${APPROVAL_ID}`, '--yes'], ctx);
      await vi.waitFor(() => {
        expect(d.posts).toHaveLength(1);
      });
      d.send(sseEvent({ type: 'posted', message: approvedMessage(outcome), working: ['payer-1'] } as never));
      d.send(
        sseEvent({
          type: 'message',
          message: {
            ...approvedMessage(outcome),
            id: 'r1',
            from: 'payer-1',
            to: 'olga',
            kind: 'output',
            text: 'It may not have worked.',
            approved: undefined,
          },
          working: [],
        } as never),
      );
      expect(await running).toBe(EXIT.failed);
      expect(err.join('')).toContain(line);
    }
  });

  it('names the stream error when the agent has gone (unknown_handle)', async () => {
    const d = approvalDaemon(
      () => json(200, pending()),
      () => 'stream',
    );
    const { ctx, err } = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
    const running = runCli(['--approve', `id=${APPROVAL_ID}`, '--yes'], ctx);
    await vi.waitFor(() => {
      expect(d.posts).toHaveLength(1);
    });
    d.send(
      sseEvent({
        type: 'error',
        reason: 'unknown_handle',
        detail:
          "payer-1 could not be given the result of approval 0123456789abcdef (it has left); the call's outcome: ok",
      } as never),
    );
    expect(await running).toBe(EXIT.failed);
    expect(err.join('')).toContain(
      "✗ unknown_handle: payer-1 could not be given the result of approval 0123456789abcdef (it has left); the call's outcome: ok\n",
    );
  });

  it("gives up at the request's timeoutMs + 10,000 ms when only heartbeats come (injected clock)", async () => {
    const d = approvalDaemon(
      () => json(200, pending({ timeoutMs: 1 })),
      () => 'stream',
    );
    const { ctx, err } = await context({ daemonAnswers: true, fetch: d.fetches.fetch });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const running = runCli(['--approve', `id=${APPROVAL_ID}`, '--yes'], ctx);
      // vi.waitFor would advance the faked clock; only the event loop turns here, the clock standing still.
      for (let turn = 0; turn < 1_000 && d.posts.length === 0; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      expect(d.posts).toHaveLength(1);
      for (let i = 0; i < 10; i += 1) {
        d.send(SSE_HEARTBEAT);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(err.join('')).not.toContain('no outcome');
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toBe(EXIT.failed);
      expect(err.join('')).toContain(
        `✗ approval ${APPROVAL_ID}: no outcome within 10001 ms; the call may still complete: see the audit\n`,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('--enable-module (R18b, R36; A36)', () => {
  it('with a daemon answering, sends the caps to it and writes nothing itself; prints each 409 reason, exit 1', async () => {
    const sent: unknown[] = [];
    let answer: Response = json(200, { ok: true });
    const fetches = new FakeFetch((url, init) => {
      if (url.endsWith('/v1/health')) return json(200, health);
      if (url.endsWith('/v1/modules/enable')) {
        sent.push(JSON.parse(init?.body as string));
        return answer;
      }
      throw new TypeError(`unexpected ${url}`);
    });
    const { ctx, home } = await context({ daemonAnswers: true, fetch: fetches.fetch });
    expect(await runCli(['--enable-module', 'id=tavily', 'conversation=0.1', 'day=1', 'month=10'], ctx)).toBe(EXIT.ok);
    expect(sent).toEqual([{ id: 'tavily', conversation: 0.1, day: 1, month: 10 }]);
    expect(await exists(join(home, 'metering.json'))).toBe(false);
    for (const reason of ['not_installed', 'not_metered', 'over_cap']) {
      answer = json(409, { error: `refused: ${reason}`, reason });
      const again = await context({ daemonAnswers: true, fetch: fetches.fetch });
      expect(await runCli(['--enable-module', 'id=tavily', 'conversation=0.1', 'day=1', 'month=10'], again.ctx)).toBe(
        EXIT.failed,
      );
      expect(again.err.join('')).toContain(reason);
    }
  });

  it('with none answering, holds daemon.lock and writes metering.json; refuses over the approved cap', async () => {
    const { ctx, home } = await context();
    const dir = await writeModuleDir(
      cloudToolManifest({
        id: 'fixture_search',
        cost: {
          model: 'metered',
          perCall: { unit: 'credit', units: 1, unitUsd: 0.008, url: 'https://x.example/p', read: '2026-09-27' },
          approved: { by: 'the owner', date: '2026-09-27', capUsd: 25 },
        },
      }),
      { 'index.mjs': ENTRY, 'package-lock.json': LOCK },
      join(home, 'modules'),
    );
    expect(dir).toBe(join(home, 'modules', 'fixture_search'));
    expect(await runCli(['--enable-module', 'id=fixture_search', 'conversation=26', 'day=1', 'month=10'], ctx)).toBe(
      EXIT.failed,
    );
    expect(await exists(join(home, 'metering.json'))).toBe(false);
    expect(await runCli(['--enable-module', 'id=fixture_search', 'conversation=0.1', 'day=1', 'month=10'], ctx)).toBe(
      EXIT.ok,
    );
    const written = JSON.parse(await readFile(join(home, 'metering.json'), 'utf8')) as {
      modules: Record<string, { caps: unknown }>;
    };
    expect(present(written.modules['fixture_search'], "written.modules['fixture_search']").caps).toEqual({
      conversation: 0.1,
      day: 1,
      month: 10,
    });
    expect((await stat(join(home, 'metering.json'))).mode & 0o777).toBe(0o600);
  });

  it('with none answering, holds daemon.lock while it writes: a daemon start meanwhile fails LockHeld naming this command (A36)', async () => {
    const { ctx, home } = await context();
    await writeModuleDir(
      cloudToolManifest({
        id: 'fixture_search',
        cost: {
          model: 'metered',
          perCall: { unit: 'credit', units: 1, unitUsd: 0.008, url: 'https://x.example/p', read: '2026-09-27' },
          approved: { by: 'the owner', date: '2026-09-27', capUsd: 25 },
        },
      }),
      { 'index.mjs': ENTRY, 'package-lock.json': LOCK },
      join(home, 'modules'),
    );
    // The daemon's own start takes daemon.lock with acquirePidLock and the real isAlive (startDaemon in compose.ts).
    // It runs in a child process while this command is blocked inside its write (after metering.json, before the
    // release), so the lock's state it meets is exactly the one the command holds.
    const pidLock = join(import.meta.dirname, '../../src/daemon/process/pid-lock.ts');
    const daemonStart = `import { acquirePidLock, isAlive } from ${JSON.stringify(pathToFileURL(pidLock).href)};
try { await acquirePidLock({ file: ${JSON.stringify(join(home, 'daemon.lock'))}, pid: process.pid, isAlive, logger: { info() {}, warn() {}, error() {} } }); console.log('taken'); }
catch (error) { console.log(error.name + ' ' + error.holderPid); }`;
    let probe = '';
    let meteringAtProbe = false;
    const live: CliContext = {
      ...ctx,
      pid: process.pid,
      isAlive: (pid) => pid === process.pid,
      stdout: (text) => {
        meteringAtProbe = existsSync(join(home, 'metering.json'));
        const child = spawnSync(
          process.execPath,
          [
            '--experimental-transform-types',
            '--disable-warning=ExperimentalWarning',
            '--input-type=module',
            '-e',
            daemonStart,
          ],
          { encoding: 'utf8', timeout: 20_000 },
        );
        // A child that failed shows how, never an empty result.
        probe =
          child.status === 0 ? child.stdout.trim() : `exit ${String(child.status)}: ${child.stderr.slice(0, 500)}`;
        ctx.stdout(text);
      },
    };
    expect(await runCli(['--enable-module', 'id=fixture_search', 'conversation=0.1', 'day=1', 'month=10'], live)).toBe(
      EXIT.ok,
    );
    expect({ probe, meteringAtProbe }).toEqual({ probe: `LockHeld ${String(process.pid)}`, meteringAtProbe: true });
    // Released after: the next start takes it.
    expect(await exists(join(home, 'daemon.lock'))).toBe(false);
  });

  it('with daemon.lock held by a live process, exits 1 naming its pid and writes nothing', async () => {
    const { ctx, home, err } = await context();
    await writeFile(join(home, 'daemon.lock'), '4242\n');
    expect(await runCli(['--enable-module', 'id=fixture_search', 'conversation=0.1', 'day=1', 'month=10'], ctx)).toBe(
      EXIT.failed,
    );
    expect(err.join('')).toContain('4242');
    expect(await exists(join(home, 'metering.json'))).toBe(false);
  });
});

describe('--enable-module needs all three caps (R18b; A18)', () => {
  it('refuses an opt-in missing a cap, or one that is not a number of USD, as a usage error, writing nothing', async () => {
    for (const argv of [
      ['--enable-module', 'id=fixture_search', 'conversation=0.1', 'day=1'],
      ['--enable-module', 'id=fixture_search', 'day=1', 'month=10'],
      ['--enable-module', 'id=fixture_search', 'conversation=lots', 'day=1', 'month=10'],
    ]) {
      const { ctx, home } = await context();
      expect(await runCli(argv, ctx)).toBe(EXIT.usage);
      expect(await exists(join(home, 'metering.json'))).toBe(false);
    }
  });
});
