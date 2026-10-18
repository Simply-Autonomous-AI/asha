// agent-files A9, end to end on the real model: an interactive session attaches a file by a path in its line, the
// hello-world agent reads it from the channel's file space with its file tools, and returns a file of its own with
// reply_with_files, which the CLI saves. A fresh harness home, the daemon started by the CLI, real colima, the pinned
// model on llama-server, the hello-world image and the test-only recipe recipes/suite-files-hello.json (the four file
// tools and reply_with_files; never shipped, tools/release/pack.mts).
//
// The three lines, each written once the previous conversation has closed (the daemon's conversation.closed):
//   1. the control: a bare name, which never attaches (R1 rule 6), so nothing printed before line 2 holds the code;
//   2. ./notes.txt attaches it, and the agent's one reply holds the code;
//   3. it attaches again, into a folder of its own, and the agent sends back a new file holding the code.
// The code is 8 hex characters drawn for the run, held only by the fixture file. Line 1 is this criterion's own proof
// that it can fail: its check is line 2's, and it must find no code. Premise: P7's turns re-probed at 7b1f581
// (evals/probes/agent-files-2026-09-30/p7/p7-turn-2.out.txt), each 3/3.
//
// Time: three turns in series, at most 11 model calls each (MAX_TOOL_ROUNDS 6 + MAX_ROUNDS 3 − 1 + MAX_CORRECTIONS 2
// + 1), so at most 33; about 1.1 s a call on this machine, plus the daemon's start and the launch, within the 300 s
// each line is given here and the 1,200 s test bound (vitest.eval.config.mts).

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const ASHA = join(REPO, 'asha');
const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;
const CHANNEL = 'files';
const LINE_MS = 300_000;

let home: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

/** The daemon log's records, in order; none yet when it does not exist. */
async function logRecords(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(home, 'logs', 'daemon.jsonl'), 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  });
  return text
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** How many conversations on the channel have closed. */
async function closed(): Promise<number> {
  return (await logRecords()).filter((r) => r['event'] === 'conversation.closed' && r['channel'] === CHANNEL).length;
}

/** Polls every 200 ms until `n` conversations have closed, at most LINE_MS; throws naming the line past it. */
async function untilClosed(n: number, line: number): Promise<void> {
  const deadline = Date.now() + LINE_MS;
  while ((await closed()) < n) {
    if (Date.now() > deadline)
      throw new Error(`line ${String(line)}'s conversation did not close within ${String(LINE_MS)} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function docker(args: readonly string[]): Promise<string> {
  return new Promise((resolveOut, reject) =>
    execFile(
      'docker',
      [...args],
      { env: { ...process.env, DOCKER_HOST }, timeout: 30_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`docker ${args.join(' ')}: ${stderr || error.message}`));
        else resolveOut(stdout);
      },
    ),
  );
}

function asha(args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) =>
    execFile(ASHA, [...args], { env, cwd, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        const rejection: Error = error;
        reject(rejection);
      } else resolveRun({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    }),
  );
}

beforeAll(async () => {
  home = join(await mkdtemp(join(tmpdir(), 'asha-eval-files-')), 'home');
  cwd = await mkdtemp(join(tmpdir(), 'asha-eval-files-work-'));
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

describe('files through an interactive session, on the real model (agent-files A9)', () => {
  it('a bare name attaches nothing; ./notes.txt attaches, is read and answered; a file sent back is saved', async () => {
    const secret = randomBytes(4).toString('hex');
    await writeFile(
      join(cwd, 'notes.txt'),
      `Gym locker\nOpened 2026-09-12\nThe locker code is ${secret}\nBring a padlock\n`,
    );

    // stdout and stderr in one pipe, so what the CLI printed is in the order it printed it.
    const child = spawn(
      '/bin/sh',
      ['-c', `exec '${ASHA}' --verbose --interactive user=alice recipe=suite-files-hello channel=${CHANNEL} 2>&1`],
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    let out = '';
    let code: number | null;
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    const exited = new Promise<number | null>((resolveExit) => child.once('close', resolveExit));
    const killer = setTimeout(() => child.kill('SIGKILL'), 3 * LINE_MS + 120_000);

    try {
      child.stdin.write('What is the locker code in notes.txt?\n');
      await untilClosed(1, 1);
      // The control: the bare name attached nothing, so the file is not in the space.
      const connected = (await logRecords())
        .filter((r) => r['event'] === 'agent.connected' && r['channel'] === CHANNEL)
        .at(-1);
      expect(connected).toBeDefined();
      expect(
        await docker([
          'exec',
          String(present(connected, 'connected')['container']),
          'find',
          '/channel',
          '-name',
          'notes.txt',
        ]),
      ).toBe('');

      child.stdin.write('What is the locker code in ./notes.txt?\n');
      await untilClosed(2, 2);
      child.stdin.write('Put the locker code from ./notes.txt in a new file and send me that file.\n');
      await untilClosed(3, 3);
      child.stdin.end();
      code = await exited;
    } finally {
      clearTimeout(killer);
      // A failed wait leaves the session running: end it, so nothing outlives the test.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    // The two attachments, each into a folder of its own; the bare name made none.
    const attached = [
      ...out.matchAll(
        /^(?:› )?attached \.\/notes\.txt as (\/channel\/upload-[0-9a-f]{16}\/notes\.txt) \(\d+ bytes\)$/gm,
      ),
    ];
    expect(attached.map((m) => m[1])).toHaveLength(2);
    const firstAttached = present(attached[0], 'attached[0]');
    const secondAttached = present(attached[1], 'attached[1]');
    expect(firstAttached[1]).not.toBe(secondAttached[1]);

    // Line 1: nothing printed before line 2 was sent holds the code.
    const line1 = out.slice(0, firstAttached.index);
    expect(line1).toContain('notes.txt');
    expect(line1).not.toContain(secret);

    // No failure was printed. The session exits 1 exactly when line 1, the control, ended in the harness's no-answer
    // reply (its agent passed, finding no such file), which is a failed message by the CLI's exit codes; else 0.
    expect(out.split('\n').filter((l) => l.startsWith('✗'))).toEqual([]);
    expect(code, `the session printed:\n${out}`).toBe(line1.includes('› output asha → alice:') ? 1 : 0);

    // Line 2: one reply, and it holds the code.
    const line2 = out.slice(firstAttached.index, secondAttached.index);
    const replies = [...line2.matchAll(/^› output (\S+) → alice:$/gm)];
    expect(replies).toHaveLength(1);
    expect(line2.slice(present(replies[0], 'replies[0]').index)).toContain(secret);

    // Line 3: one file saved under asha-files/<channel>/, holding the code, with its file: line.
    const line3 = out.slice(secondAttached.index);
    const files = [...line3.matchAll(/^file: (asha-files\/files\/[^ ]+) \((\d+) bytes, sha256 ([0-9a-f]{64})\)$/gm)];
    expect(files).toHaveLength(1);
    const file = present(files[0], 'files[0]');
    const saved = await readdir(join(cwd, 'asha-files', CHANNEL));
    expect(saved).toHaveLength(1);
    expect(file[1]).toBe(`asha-files/${CHANNEL}/${present(saved[0], 'saved[0]')}`);
    expect(await readFile(join(cwd, present(file[1], 'files[0][1]')), 'utf8')).toContain(secret);
  });
});
