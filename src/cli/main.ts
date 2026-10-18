// `asha` entry point — Autonomous Simple Harness for Agents. Wiring only; the
// commands are in commands.ts. Invoked through the `asha` script.

import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';

import { productionDependencies, startDaemon } from '../daemon/compose.js';
import { writePrivateFile } from '../daemon/private-file/index.js';
import { JsonLinesLogger } from '../daemon/log.js';
import { isAlive } from '../daemon/process/index.js';
import { present } from '../shared/assert-present.js';
import { buildFingerprint } from '../shared/build.js';
import { ensureHome } from '../shared/paths.js';
import { runCli } from './commands.js';
import { DOWNLOAD_IDLE_MS, SERVER_STOP_MS, STREAM_IDLE_MS, UPLOAD_ANSWER_MS } from '../shared/timing.js';
import { readLines } from './interactive.js';
import { shutdownSignals } from './signals.js';

// This file runs as dist/src/cli/main.js; the repo root is three levels up.
const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), '..', '..', '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch: globalThis.fetch,
  root,
  version,
  build: buildFingerprint(join(root, 'dist')),
  pid: process.pid,
  startDaemon,
  createLogger: (paths) =>
    new JsonLinesLogger({
      file: join(paths.logsDir, 'daemon.jsonl'),
      echo: (line) => process.stderr.write(`${line}\n`),
      clock: () => new Date(),
    }),
  dependencies: productionDependencies,
  shutdownSignals: shutdownSignals(process),
  spawnServer: async (paths, env) => {
    // A new home is created 0700 before anything inside it (R2); an existing one keeps its mode.
    await ensureHome(paths);
    await mkdir(paths.logsDir, { recursive: true });
    const log = await open(paths.serverLog, 'a');
    try {
      const child = spawn(process.execPath, [self, '--server'], {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        // This command's environment, with the auto-start's idle bound (commands.ts autoStartEnv, idle-shutdown R3).
        env,
      });
      // Listen before any await: 'spawn' fires on the next turn of the loop.
      const started = new Promise<number>((resolvePid, reject) => {
        child.once('spawn', () => {
          resolvePid(present(child.pid, "the child process's pid, once it has spawned"));
        });
        child.once('error', reject);
      });
      child.unref();
      return await started;
    } finally {
      await log.close();
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  isAlive,
  processCommand: (pid) =>
    new Promise((resolveCommand, reject) => {
      // ps exits 1 and prints nothing for a pid no process holds; anything else is a failure (debt-paydown R15).
      execFile(
        'ps',
        ['-o', 'command=', '-p', String(pid)],
        { timeout: 2_000, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error === null) resolveCommand(stdout.trim());
          else if (error.code === 1 && stdout === '' && stderr === '') resolveCommand(null);
          else {
            const reason = error.killed ? 'timed out after 2000 ms' : `exit ${String(error.code)}`;
            reject(new Error(`ps -o command= -p ${String(pid)} failed: ${reason} ${stderr.trim()}`, { cause: error }));
          }
        },
      );
    }),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  // The bounds the portal's page shares (src/shared/timing.ts, docs/plans/portal.md R18): serverStopMs covers a
  // daemon's slowest clean stop; uploadAnswerMs and downloadIdleMs are docs/plans/agent-files.md R3a and R12a.
  timing: {
    serverStartMs: 20_000,
    serverStopMs: SERVER_STOP_MS,
    streamIdleMs: STREAM_IDLE_MS,
    pollMs: 200,
    uploadAnswerMs: UPLOAD_ANSWER_MS,
    downloadIdleMs: DOWNLOAD_IDLE_MS,
  },
  terminal: { stdout: process.stdout.isTTY, stderr: process.stderr.isTTY },
  // stdin is read only by --interactive, and only once it asks for lines. The terminal stays in its own
  // (canonical) mode: it edits the line, Ctrl-D ends input, and Ctrl-C reaches asha as SIGINT.
  input: {
    lines: { [Symbol.asyncIterator]: () => readLines(process.stdin)[Symbol.asyncIterator]() },
    isTerminal: isatty(0),
  },
  interrupt: () =>
    new Promise<void>((resolveInterrupt) =>
      process.once('SIGINT', () => {
        resolveInterrupt();
      }),
    ),
  loginName: () => userInfo().username,
  cwd: () => process.cwd(),
  homeDir: () => homedir(),
  // --portal (docs/plans/portal.md R1): the forwarding file, and macOS `open` found by PATH, given only its path.
  portal: {
    writeFile: writePrivateFile,
    open: (path) => {
      const child = spawn('open', [path], { stdio: 'ignore' });
      const exited = new Promise<number | NodeJS.Signals>((resolveExit, reject) => {
        child.once('error', reject);
        // Node gives exactly one of the two: the code of an exit, or the signal that ended the process.
        child.once('exit', (code, signal) => {
          resolveExit(code ?? present(signal, 'the signal, since exit gave no code'));
        });
      });
      return {
        exited,
        kill: () => {
          child.kill('SIGKILL');
        },
      };
    },
  },
});
process.exitCode = code;
