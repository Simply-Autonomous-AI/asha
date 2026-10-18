// The eval: the real thing, end to end, through ./asha — a fresh harness
// home, the daemon started automatically, real colima, the pinned model on
// llama-server, the real agent image, and the real reply.
//
// The model cache is shared with the owner's (ASHA_MODELS_DIR) so a run does
// not re-download 640 MB; everything else is fresh per run.
//
// On the replies: the hello-world recipe decodes greedily (`chat.temperature:
// 0`) on Qwen3-8B, so each reply is deterministic for a given model file,
// prompt and llama.cpp build. Measured through ./asha on 2026-09-26: a single
// agent answers "Hello World." and the two-agent chain yields "Say Hello
// World" → "Hello World", identically on every run. After the reply split
// (c017fa0) hewo-1 handed over just "Hello World"; that was a regression, not
// a new expectation — the hand-off must be an instruction (evals/routing
// case "delegate"). Since 6776e24, which shows the model an example of the
// form, it is "Say: Hello World" → "Hello World", measured through ./asha. Re-measured 2026-09-27 on
// llama.cpp 0.5.0 with the tool-call prefill (6b1570b): the same replies. The eval asserts the exact
// replies; if an upgrade changes them this fails loudly — re-verify and update
// the expectation, never loosen it (§8). evals/routing records why this model.

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { loginNameToUserId } from '../../src/shared/protocol.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const { version: VERSION } = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { version: string };
const ASHA = join(REPO, 'asha');

// A message without user= carries this machine's login name, converted (cli-interactive R16), computed here in the
// test's own process; a changed name is announced on stderr once per command or session. Nothing written is committed.
const LOGIN_NAME = userInfo().username;
const ME = loginNameToUserId(LOGIN_NAME);
const ME_LINE = ME === LOGIN_NAME ? '' : `› your login name "${LOGIN_NAME}" is sent as user ID "${ME}"\n`;
const ME_RE = ME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let home: string;
let env: NodeJS.ProcessEnv;
/** The control credential and the model server key, read from their files while the daemon ran (A15). */
let secrets: { credential: string; key: string } | undefined;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function asha(args: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    execFile(ASHA, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error && error.killed) {
        reject(
          new Error(`asha ${args.join(' ')} exceeded ${String(timeoutMs)} ms\nstdout: ${stdout}\nstderr: ${stderr}`),
        );
        return;
      }
      if (error && typeof error.code !== 'number') {
        const rejection: Error = error;
        reject(rejection);
        return;
      }
      resolveRun({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

/** Runs ./asha with `input` piped to its stdin; a hung run is killed and fails (PRINCIPLES §14.5). */
function ashaWithInput(args: string[], input: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(ASHA, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`asha ${args.join(' ')} exceeded ${String(timeoutMs)} ms\nstdout: ${stdout}\nstderr: ${stderr}`),
      );
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === null) reject(new Error(`asha ${args.join(' ')} was killed\nstderr: ${stderr}`));
      else resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function docker(args: string[]): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile(
      'docker',
      args,
      { env: { ...process.env, DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock` }, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`docker ${args.join(' ')}: ${stderr}`));
        else resolveOut(stdout);
      },
    );
  });
}

interface LogRecord {
  readonly level: string;
  readonly event: string;
  readonly [key: string]: unknown;
}

async function logRecords(): Promise<LogRecord[]> {
  const text = await readFile(join(home, 'logs', 'daemon.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LogRecord);
}

beforeAll(async () => {
  // A home that does not exist yet, so the CLI's own start creates it (control-api-auth R2; review F2).
  home = join(await mkdtemp(join(tmpdir(), 'asha-eval-')), 'home');
  env = {
    ...process.env,
    ...TEST_DAEMON_ENV,
    ASHA_HOME: home,
    ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] || join(homedir(), '.simplyautonomous', 'harness', 'models'),
  };
});

afterAll(async () => {
  // Always leave nothing running, even when a test failed.
  await asha(['--stop'], 100_000);
});

describe('asha, end to end', () => {
  it('starts the daemon itself, brings hello-world online, and prints the model reply', async () => {
    const run = await asha(['--verbose', 'recipe=hello-world', 'message=Please say: Hello World.'], 600_000);

    expect(run.stderr).toContain('› started the asha daemon');
    expect(run.stderr).toContain('› hewo-1: Hi');
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('Hello World.\n');
    // A15: the posted line names the converted login name.
    expect(run.stderr).toContain(`› ${ME} → main: Please say: Hello World.\n`);
  });

  it('the CLI created the home 0700, and the daemon wrote daemon.json and model-server.key 0600', async () => {
    const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8);
    expect(await mode(home)).toBe('700');
    expect(await mode(join(home, 'daemon.json'))).toBe('600');
    expect(await mode(join(home, 'model-server.key'))).toBe('600');
  });

  it('the reply came through the harness: one model.chat per conversation, by the agent', async () => {
    const records = await logRecords();
    const online = records.filter((r) => r.event === 'agent.online');
    expect(online.map((r) => [r['handle'], r['channel']])).toEqual([['hewo-1', 'main']]);
    const chats = records.filter((r) => r.event === 'model.chat');
    // The model hello-world's recipe names, read from it: the recipe is the whole agent.
    const recipe = JSON.parse(await readFile(join(REPO, 'recipes', 'hello-world.json'), 'utf8')) as { model: string };
    expect(chats.map((r) => [r['handle'], r['channel'], r['model']])).toEqual([['hewo-1', 'main', recipe.model]]);
  });

  it('a second message reuses the online agent', async () => {
    const run = await asha(['--verbose', 'recipe=hello-world', 'message=Please say: Hello World.'], 120_000);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('started the asha daemon');
    expect(run.stderr).toContain('› agent: hewo-1 already online on main');
    expect(run.stdout).toBe('Hello World.\n');
  });

  it('--watch prints the conversation as it happens, and exits 0 on Ctrl-C', async () => {
    const watcher = spawn(ASHA, ['--watch', '--verbose'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    watcher.stdout.on('data', (c: Buffer) => (out += c.toString()));
    watcher.stderr.on('data', (c: Buffer) => (err += c.toString()));
    const exited = new Promise<number | null>((resolveExit) =>
      watcher.once('close', (code) => {
        resolveExit(code);
      }),
    );
    const deadline = Date.now() + 30_000;
    while (!err.includes('› watching channel "main"') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(err).toContain('› watching channel "main" (agents: hewo-1); Ctrl-C to stop');

    const run = await asha(['recipe=hello-world', 'message=Please say: Hello World.'], 120_000);
    expect(run.code, run.stderr).toBe(0);
    while (!out.includes('Hello World.') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    watcher.kill('SIGINT');

    expect(await exited).toBe(0);
    expect(out).toMatch(
      new RegExp(
        `^\\d{2}:\\d{2}:\\d{2}Z \\[[0-9a-f]{8}\\] input ${ME_RE} → all agents: Please say: Hello World\\.$`,
        'm',
      ),
    );
    expect(out).toMatch(
      new RegExp(`^\\d{2}:\\d{2}:\\d{2}Z \\[[0-9a-f]{8}\\] output hewo-1 → ${ME_RE}: Hello World\\.$`, 'm'),
    );
  });

  it('to= addresses the agent by its handle', async () => {
    // user=user-1: a typed ID, allowed although the harness issues this form (the first message spoke as the login
    // name). Corrected 2026-09-29: this said "the same user as the first message", true only while the CLI's
    // default was an issued ID.
    const run = await asha(['--verbose', 'user=user-1', 'to=hewo-1', 'message=Please say: Hello World.'], 120_000);
    expect(run.code, run.stderr).toBe(0);
    // With --verbose the model's output streams on stderr too (model-streaming R7): one line of the reply tool's
    // arguments, before the status; every other line is as it was.
    const lines = run.stderr.split('\n');
    expect(lines.filter((l) => !l.startsWith('› hewo-1 reply: ')).join('\n')).toBe(
      '› user-1 → hewo-1 on main: Please say: Hello World.\n› hewo-1: ok\n› output hewo-1 → user-1:\n',
    );
    expect(lines.filter((l) => l.startsWith('› hewo-1 reply: '))).toEqual([
      expect.stringMatching(/^› hewo-1 reply: \{.*"Hello World\."\s*\}$/),
    ]);
    expect(run.stdout).toBe('Hello World.\n');
  });

  it("streams the model's output on stderr with --verbose, before the reply; stdout alone is exactly the reply (model-streaming A8)", async () => {
    const run = await asha(['--verbose', 'user=user-1', 'to=hewo-1', 'message=Please say: Hello World.'], 120_000);
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stderr.split('\n');
    const delta = lines.findIndex((l) => /^› hewo-1 (reply|thinking|text): /.test(l));
    expect(delta, run.stderr).toBeGreaterThanOrEqual(0);
    expect(delta).toBeLessThan(lines.indexOf('› output hewo-1 → user-1:'));
    // Without --verbose: no delta, and stdout is exactly the reply and a newline.
    const quiet = await asha(['user=user-1', 'to=hewo-1', 'message=Please say: Hello World.'], 120_000);
    expect([quiet.code, quiet.stdout, quiet.stderr]).toEqual([0, 'Hello World.\n', '']);
    // The daemon logged the call's stream figures (R8).
    const chat = present(
      (await logRecords()).filter((r) => r.event === 'model.chat').at(-1),
      'the latest model.chat log record',
    );
    expect([
      typeof chat['ttfcMs'],
      typeof chat['chunks'],
      typeof chat['promptTokens'],
      typeof chat['completionTokens'],
    ]).toEqual(['number', 'number', 'number', 'number']);
  });

  it('channel= brings a separate agent online on another channel', async () => {
    const run = await asha(
      ['--verbose', 'recipe=hello-world', 'channel=lab', 'message=Please say: Hello World.'],
      120_000,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain('› hewo-1: Hi');
    expect(run.stdout).toBe('Hello World.\n');
  });

  it('the two-agent hello world: hewo-1 has hewo-2 say it, and hewo-2 answers the user', async () => {
    // The hello-world image in its two roles, as the multi-agent suite launches them (the owner, 2026-10-15): the agent
    // that routes on Qwen3 8B (hello-router: hello-world's prompt), the one that answers on Pico-V2 from the responder
    // recipe, whose one-shot example of answering a task another agent hands it is kept out of hello-world itself.
    const first = await asha(['--launch', 'recipe=hello-router', 'channel=duo'], 300_000);
    const second = await asha(['--launch', 'recipe=suite-multi-agent-responder', 'channel=duo'], 300_000);
    expect([first.code, first.stdout, second.code, second.stdout]).toEqual([0, 'hewo-1\n', 0, 'hewo-2\n']);

    const run = await asha(
      ['--verbose', 'to=hewo-1', 'channel=duo', 'message=Please ask hewo-2 to say Hello World.'],
      180_000,
    );

    expect(run.code, run.stderr).toBe(0);
    // With --verbose each model call's output streams on stderr too (model-streaming R7): one delta line per call,
    // named for its agent and tool, before that agent's status. The rest is exactly as before.
    const delta = /^› hewo-[12] (send_message|reply|consult|thinking|text): /;
    const lines = run.stderr.split('\n');
    expect(lines.filter((l) => delta.test(l)).map((l) => l.slice(0, l.indexOf(':', 2)))).toEqual([
      '› hewo-1 send_message',
      '› hewo-2 reply',
    ]);
    expect(lines.filter((l) => !delta.test(l)).join('\n')).toBe(
      ME_LINE +
        `› ${ME} → hewo-1 on duo: Please ask hewo-2 to say Hello World.\n` +
        '› hewo-1: ok\n' +
        '› internal hewo-1 → hewo-2: Say: Hello World\n' +
        '› hewo-2: ok\n' +
        `› output hewo-2 → ${ME}:\n`,
    );
    expect(run.stdout).toBe('Hello World\n');
  });

  it('without --verbose, prints only the reply, for a single agent and for the two-agent hand-off', async () => {
    const single = await asha(['message=Please say: Hello World.'], 120_000);
    expect([single.code, single.stdout, single.stderr]).toEqual([0, 'Hello World.\n', ME_LINE]);
    const duo = await asha(['to=hewo-1', 'channel=duo', 'message=Please ask hewo-2 to say Hello World.'], 180_000);
    expect([duo.code, duo.stdout, duo.stderr]).toEqual([0, 'Hello World\n', ME_LINE]);
  });

  // cli-interactive A6: no user=, so the session speaks as the converted login name; stderr holds nothing but the
  // ID line R11 always prints when the conversion changed the name.
  it('--interactive: two piped lines are two replies from the real model, as one user, and nothing else on stderr (A6)', async () => {
    const before = (await logRecords()).filter((r) => r.event === 'channel.user_online').length;
    const run = await ashaWithInput(
      ['--interactive', 'recipe=hello-world'],
      'Please say: Hello World.\nPlease say: Hello World.\n',
      240_000,
    );
    expect([run.code, run.stdout, run.stderr]).toEqual([0, 'Hello World.\nHello World.\n', ME_LINE]);
    const users = (await logRecords())
      .filter((r) => r.event === 'channel.user_online')
      .slice(before)
      .map((r) => r['user']);
    expect(users).toEqual([ME, ME]);
  });

  // cli-interactive A12.
  it('--interactive with /watch on prints the channel view, each reply to the user marked, once (A12)', async () => {
    const run = await ashaWithInput(
      ['--interactive', 'recipe=hello-world'],
      '/watch on\nPlease say: Hello World.\n',
      240_000,
    );
    expect([run.code, run.stderr]).toEqual([0, `${ME_LINE}watching the channel\n`]);
    const lines = run.stdout.split('\n');
    const marker = lines.indexOf('» reply from hewo-1:');
    expect(lines.filter((line) => line === '» reply from hewo-1:')).toHaveLength(1);
    expect(lines[marker + 1]).toMatch(
      new RegExp(`^\\d{2}:\\d{2}:\\d{2}Z \\[[0-9a-f]{8}\\] output hewo-1 → ${ME_RE}: Hello World\\.$`),
    );
    // The reply once: through the view, never also as the conversation's bare text.
    expect(lines.filter((line) => line.endsWith(`output hewo-1 → ${ME}: Hello World.`))).toHaveLength(1);
    expect(lines).not.toContain('Hello World.');
    expect(lines.filter((line) => line.endsWith(` input ${ME} → all agents: Please say: Hello World.`))).toHaveLength(
      1,
    );
  });

  // cli-interactive A11. script(1) gives the session a terminal. On this Mac (2026-09-28) it refuses a stdin or
  // stdout that is a socket ("tcgetattr/ioctl: Operation not supported on socket"), which Node's stdio pipes and a
  // mkfifo FIFO both are, so `cat` on each side turns them into anonymous pipes.
  it('--interactive under a terminal: the prompt, Ctrl-C exits 130, and the terminal keeps its mode (A11)', async () => {
    const inner = `'${ASHA}' --interactive user=evan; echo "exit=$?"; stty -a`;
    const child = spawn(
      '/bin/sh',
      ['-c', `cat | script -q /dev/null /bin/sh -c '${inner.replaceAll("'", "'\\''")}' | cat`],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const closed = new Promise<number | null>((resolveClose) => child.once('close', resolveClose));
    const deadline = Date.now() + 30_000;
    while (!out.includes('asha> ') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(out).toContain('asha> ');
    child.stdin.write('\x03');
    // Two sequential checks, not one combined regex: `exit=\d+` followed anywhere later by `icanon` (the same
    // condition as `/exit=\d+[\s\S]*icanon/.test(out)`, verified byte for byte), without the super-linear
    // backtracking of a `\d+` and a `[\s\S]*` whose character classes overlap (sonarjs/super-linear-regex).
    const sawExitThenIcanon = (text: string): boolean => {
      const match = /exit=\d+/.exec(text);
      return match !== null && text.includes('icanon', match.index + match[0].length);
    };
    while (!sawExitThenIcanon(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    child.stdin.end();
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    expect(await closed).toBe(0);
    clearTimeout(killer);
    expect(out).toMatch(/exit=130/);
    expect(out).toMatch(/(^|\s)icanon(\s|$)/m);
    expect(out).toMatch(/(^|\s)echo(\s|$)/m);
  });

  it('--status lists every running agent', async () => {
    const run = await asha(['--status'], 30_000);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(
      new RegExp(
        `^running: pid \\d+, port \\d+, version ${VERSION.replaceAll('.', '\\.')}, build [0-9a-f]{12}, started \\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z\\n` +
          [
            'duo hewo-1 hello-router',
            'duo hewo-2 suite-multi-agent-responder',
            'lab hewo-1 hello-world',
            'main hewo-1 hello-world',
          ]
            .map((a) => {
              const [channel, handle, recipe] = a.split(' ');
              return `  ${present(handle, 'status line handle')}  channel=${present(channel, 'status line channel')} recipe=${present(recipe, 'status line recipe')} image=hello-world\\n`;
            })
            .join('') +
          '$',
      ),
    );
  });

  it('credential canary: neither secret is in the arguments of the daemon or any llama-server it started (A15)', async () => {
    const { pid, credential } = JSON.parse(await readFile(join(home, 'daemon.json'), 'utf8')) as {
      pid: number;
      credential: string;
    };
    const key = (await readFile(join(home, 'model-server.key'), 'utf8')).trim();
    expect(credential).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    secrets = { credential, key };
    const listing = await new Promise<string>((resolveOut, reject) =>
      execFile('ps', ['-Ao', 'pid=,ppid=,args='], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error) {
          const rejection: Error = error;
          reject(rejection);
        } else resolveOut(stdout);
      }),
    );
    const processes = listing
      .trim()
      .split('\n')
      .map((line) => {
        // Read by explicit index through `present`, never by destructuring the match array (whose index 0 is the
        // full match, not group 1): the header (pid, ppid and the separating whitespace) is matched on its own, with
        // no trailing `(.*)`, so there is no overlap between adjacent quantifiers for `sonarjs/super-linear-regex`
        // to flag; `args` is everything after the header, verified byte for byte equivalent to the old `(.*)$`
        // group (the old `\s+` before it was already greedy, so it always consumed every separating space itself).
        const header = present(/^\s*(\d+)\s+(\d+)\s+/.exec(line), `ps line ${JSON.stringify(line)} did not match`);
        return {
          pid: Number(present(header[1], 'ps line pid')),
          ppid: Number(present(header[2], 'ps line ppid')),
          args: line.slice(header[0].length),
        };
      });
    const daemon = processes.filter((p) => p.pid === pid);
    // Every process under the daemon, however deep: each llama-server runs under a watch, the daemon's child, so the
    // servers are its grandchildren (idle-shutdown R5).
    const under = new Set([pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of processes)
        if (under.has(p.ppid) && !under.has(p.pid)) {
          under.add(p.pid);
          grew = true;
        }
    }
    const descendants = processes.filter((p) => p.pid !== pid && under.has(p.pid));
    // A llama-server is a process whose command's first word is one, not a watch naming it in its arguments.
    const servers = descendants.filter((p) => /^\S*\/?llama-server /.test(p.args));
    expect(daemon).toHaveLength(1);
    expect(servers.length).toBeGreaterThanOrEqual(1);
    expect(servers.every((p) => under.has(p.ppid) && p.ppid !== pid)).toBe(true);
    const holding = [...daemon, ...descendants]
      .filter((p) => p.args.includes(credential) || p.args.includes(key))
      .map((p) => `pid ${String(p.pid)}: ${p.args}`);
    expect(holding).toEqual([]);
    // It is passed as a file, by name.
    expect(servers.every((p) => p.args.includes(`--api-key-file ${join(home, 'model-server.key')}`))).toBe(true);
  });

  it('--stop stops the daemon and removes every agent container, leaving no errors logged', async () => {
    const run = await asha(['--stop'], 100_000);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^stopped \(pid \d+\)\n$/);

    // Scoped to this daemon's agents: another harness home may be running too.
    const containers = (await logRecords())
      .filter((r) => r.event === 'agent.starting')
      .map((r) => String(r['container']));
    expect(containers.length).toBeGreaterThan(0);
    const remaining = (await docker(['ps', '--all', '--format', '{{.Names}}']))
      .split('\n')
      .filter((n) => containers.includes(n));
    expect(remaining).toEqual([]);
    const status = await asha(['--status'], 30_000);
    expect(status.stdout).toBe('not running\n');

    const problems = (await logRecords()).filter((r) => r.level !== 'info');
    expect(problems).toEqual([]);

    // A15: no log the harness wrote holds either secret; the secrets were read while it ran.
    expect(secrets).toBeDefined();
    const { credential, key } = present(secrets, 'secrets');
    const logs = (await readdir(join(home, 'logs'), { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const holding: string[] = [];
    for (const file of logs) {
      const text = await readFile(file, 'utf8');
      if (text.includes(credential)) holding.push(`${file}: the credential`);
      if (text.includes(key)) holding.push(`${file}: the model server key`);
    }
    expect(holding).toEqual([]);
    // Both secret files are gone with the daemon.
    expect((await readdir(home)).filter((f) => f === 'daemon.json' || f === 'model-server.key')).toEqual([]);
  });
});
