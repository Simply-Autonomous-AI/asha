// The watch a model server runs under (docs/plans/idle-shutdown.md R5, A5), with real processes: a stand-in daemon (a
// node process holding the watch's standard input, as the daemon does) and stand-in servers (`sh`), so what is checked
// is the shell's behaviour on this Mac, not a fake's.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SpawnProcessLauncher,
  WATCH_KILL_AFTER_S,
  WATCH_PID_LINE,
  WATCH_SCRIPT,
  WATCH_SHELL,
} from '../../src/daemon/process/launcher.js';
import { present } from '../../src/shared/assert-present.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until `check` holds, at most `ms`; true if it held. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

/** The stand-in server: prints its own pid, then sleeps in that same process. */
const SERVER = ['sh', '-c', 'echo "$$"; exec sleep 300'] as const;
/** A stand-in server that takes no notice of SIGTERM, saying `term` each time one comes: only SIGKILL ends it. */
const STUBBORN = ['sh', '-c', 'trap "echo term" TERM; echo "$$"; while :; do sleep 0.1; done'] as const;

/** Every pid and process group a test started, killed with SIGKILL afterwards whatever the test left. */
const pids: number[] = [];
const groups: number[] = [];
afterEach(() => {
  const kill = (target: number): void => {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // already ended
    }
  };
  for (const group of groups.splice(0)) kill(-group);
  for (const pid of pids.splice(0)) kill(pid);
});

/** Every line `child` writes to stdout and stderr, as they come. */
function lines(child: ChildProcess): string[] {
  const seen: string[] = [];
  for (const stream of [child.stdout, child.stderr])
    if (stream !== null) createInterface({ input: stream }).on('line', (line) => seen.push(line));
  return seen;
}

/** The pid the watch's first stderr line names, and the stand-in server's own first line (its pid), once both are seen. */
async function serverPid(seen: readonly string[]): Promise<number> {
  expect(await within(5_000, () => seen.some((l) => WATCH_PID_LINE.test(l)) && seen.some((l) => /^\d+$/.test(l)))).toBe(
    true,
  );
  const named = Number(
    present(
      WATCH_PID_LINE.exec(
        present(
          seen.find((l) => WATCH_PID_LINE.test(l)),
          'pid line',
        ),
      )?.[1],
      'pid',
    ),
  );
  // The pid the watch names is the server's own, as the server prints it.
  expect(
    Number(
      present(
        seen.find((l) => /^\d+$/.test(l)),
        "the server's pid line",
      ),
    ),
  ).toBe(named);
  pids.push(named);
  return named;
}

/** The watch over `server`, started as the launcher starts it: its own process group, standard input a pipe held here. */
function watch(
  server: readonly string[],
  script = WATCH_SCRIPT,
): { readonly watcher: ChildProcess; readonly seen: string[] } {
  const watcher = spawn(WATCH_SHELL, ['-c', script, 'asha-watch', ...server], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  groups.push(present(watcher.pid, "the watch's pid"));
  return { watcher, seen: lines(watcher) };
}

const exitOf = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', resolve);
  });

describe('the watch a model server runs under (idle-shutdown R5)', { timeout: 20_000 }, () => {
  it('ends the server at once when its daemon is killed with SIGKILL, and exits itself', async () => {
    // The stand-in daemon: a node process that starts the watch as the launcher does and is then killed outright.
    const daemon = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const [shell, script, ...server] = process.argv.slice(1);
         const w = spawn(shell, ['-c', script, 'asha-watch', ...server], { stdio: ['pipe', 'inherit', 'inherit'], detached: true });
         console.log('watch ' + w.pid);
         setInterval(() => undefined, 1000);`,
        WATCH_SHELL,
        WATCH_SCRIPT,
        ...SERVER,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    pids.push(present(daemon.pid, "the stand-in daemon's pid"));
    const seen = lines(daemon);
    const server = await serverPid(seen);
    const watcher = Number(
      present(
        /^watch (\d+)$/.exec(
          present(
            seen.find((l) => l.startsWith('watch ')),
            'watch line',
          ),
        )?.[1],
        'watch pid',
      ),
    );
    groups.push(watcher);
    expect(alive(server)).toBe(true);
    daemon.kill('SIGKILL');
    // SIGTERM is passed on as soon as the pipe ends, and `sleep` takes it: well inside the plan's bound.
    expect(await within(2_000, () => !alive(server))).toBe(true);
    expect(await within(2_000, () => !alive(watcher))).toBe(true);
  });

  it('ends the server when the pipe to its daemon closes, exiting with the status SIGTERM gave it (128 + 15)', async () => {
    const { watcher, seen } = watch(SERVER);
    const server = await serverPid(seen);
    present(watcher.stdin, "the watch's stdin").destroy();
    expect(await exitOf(watcher)).toBe(143);
    expect(alive(server)).toBe(false);
  });

  it('leaves the server alone while its daemon holds the pipe', async () => {
    const { seen } = watch(SERVER);
    const server = await serverPid(seen);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(alive(server)).toBe(true);
  });

  it('passes a stop on as one SIGTERM however many come, and sends SIGKILL 8 s later to a server that ignores it', async () => {
    const { watcher, seen } = watch(STUBBORN);
    const server = await serverPid(seen);
    const started = Date.now();
    watcher.kill('SIGTERM');
    watcher.kill('SIGHUP');
    watcher.kill('SIGINT');
    // The server is SIGKILLed (128 + 9) by the watch's own timer.
    expect(await exitOf(watcher)).toBe(137);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(WATCH_KILL_AFTER_S * 1_000 - 100);
    expect(took).toBeLessThan(WATCH_KILL_AFTER_S * 1_000 + 2_000);
    expect(alive(server)).toBe(false);
    expect(seen.filter((l) => l === 'term')).toEqual(['term']);
  });

  it('survives a burst of 30 stop signals, 16 watches at once: each passes one SIGTERM on and exits 143, its server gone', async () => {
    // Under /bin/sh — bash 3.2 on macOS — such a burst crashed 9 of 240 watches on a loaded Mac (SIGSEGV, mostly) before
    // they passed the stop on, and hung 6 more (evals/probes/watch-shell-2026-10-16/).
    const watches = Array.from({ length: 16 }, () => watch(SERVER));
    const servers = await Promise.all(watches.map(({ seen }) => serverPid(seen)));
    const exits = watches.map(({ watcher }) => {
      const exited = new Promise<string>((resolve) => {
        watcher.once('exit', (code, signal) => {
          resolve(`${String(code)} ${String(signal)}`);
        });
      });
      for (let i = 0; i < 10; i += 1) for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) watcher.kill(s);
      return exited;
    });
    expect(await Promise.all(exits)).toEqual(Array.from({ length: 16 }, () => '143 null'));
    expect(await within(2_000, () => servers.every((pid) => !alive(pid)))).toBe(true);
  });

  it('never starts the command when a stop comes before it has started: exits 143, naming no pid', async () => {
    // The same script with a second's pause after its trap is set and before the command starts: the window widened.
    const script = WATCH_SCRIPT.replace('exec 3<&0 </dev/null', 'sleep 1\nexec 3<&0 </dev/null');
    expect(script).not.toBe(WATCH_SCRIPT);
    const { watcher, seen } = watch(SERVER, script);
    await new Promise((resolve) => setTimeout(resolve, 300));
    watcher.kill('SIGTERM');
    expect(await exitOf(watcher)).toBe(143);
    // Neither the watch's pid line nor the server's own: nothing was started.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toEqual([]);
  });

  it('refuses to start unless it leads its own process group, starting nothing', async () => {
    // Not detached: it shares this test runner's group, which its helpers' clean-up would signal.
    const watcher = spawn(WATCH_SHELL, ['-c', WATCH_SCRIPT, 'asha-watch', ...SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    pids.push(present(watcher.pid, "the watch's pid"));
    const seen = lines(watcher);
    expect(await exitOf(watcher)).toBe(125);
    await within(1_000, () => seen.length > 0);
    expect(seen).toEqual([
      expect.stringMatching(/^asha-watch: refused: pid \d+ does not lead its process group \(pgid \d+\)$/),
    ]);
  });
});

describe('SpawnProcessLauncher with dieWithParent (idle-shutdown R5)', { timeout: 20_000 }, () => {
  /** Launches `server` under the watch; resolves with the launched process, the server's pid and every line seen. */
  async function launched(server: readonly string[] = SERVER) {
    const seen: string[] = [];
    const process_ = new SpawnProcessLauncher().launch(present(server[0], 'command'), server.slice(1), {
      env: {},
      logFile: null,
      dieWithParent: true,
      onLine: (line) => seen.push(line),
    });
    groups.push(present(process_.pid, "the watch's pid"));
    return { process: process_, server: await serverPid(seen), seen };
  }

  it('SIGTERM goes to the watch alone, which passes it on: the watch exits with the status it gave the server', async () => {
    const { process: watched, server } = await launched();
    // Two SIGTERMs close together are one to a shell's trap, so a server's count of them cannot show a second: the
    // launcher's own signals are watched instead — never the group (a negative pid) for SIGTERM. That the watch passes
    // on exactly one, and SIGKILLs a server that ignores it, is the raw watch's test above.
    const kill = vi.spyOn(process, 'kill');
    try {
      watched.kill('SIGTERM');
      expect(kill.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
    // The server (`sleep`) ended by the SIGTERM the watch passed on: 128 + 15.
    expect((await watched.exited).code).toBe(143);
    expect(alive(server)).toBe(false);
  });

  it('SIGKILL ends the server too, not the watch alone: the launcher signals the process group', async () => {
    const { process: watched, server } = await launched();
    const kill = vi.spyOn(process, 'kill');
    try {
      watched.kill('SIGKILL');
      expect(kill.mock.calls).toEqual([[-present(watched.pid, "the watch's pid"), 'SIGKILL']]);
    } finally {
      kill.mockRestore();
    }
    expect((await watched.exited).signal).toBe('SIGKILL');
    expect(await within(2_000, () => !alive(server))).toBe(true);
  });
});
