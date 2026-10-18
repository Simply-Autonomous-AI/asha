// The daemon's stop signals (src/cli/signals.ts; debt D21, fixed 2026-09-27):
// every SIGINT, SIGTERM and SIGHUP reaches asha while its handlers are
// installed — a second signal during a stop is logged and ignored, never
// Node's default (which ends the process at once, logging nothing) — and
// SIGHUP stops the daemon like SIGTERM. Since docs/plans/portal.md R14 every
// signal goes to the daemon's one stop trigger, which the portal's stop route
// calls too.

import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT, runCli, type CliContext } from '../../src/cli/commands.js';
import { AGENT_CHAT_TIMEOUT_MS } from '../../src/shared/protocol.js';
import { SHUTDOWN_SIGNALS, shutdownSignals, type ShutdownSignal } from '../../src/cli/signals.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon/compose.js';
import { FakeModelServer, FakeRuntime, FakeStore, REAL_STATE, fixtureRoot } from '../helpers/daemon-fakes.js';
import { NOT_INTERACTIVE, NO_PORTAL, RecordingLogger } from '../helpers/fakes.js';

describe('shutdownSignals', () => {
  it('delivers every SIGINT, SIGTERM and SIGHUP, the second as well as the first, until unsubscribed', () => {
    const source = new EventEmitter();
    const seen: ShutdownSignal[] = [];
    const unsubscribe = shutdownSignals(source)((signal) => seen.push(signal));

    source.emit('SIGTERM');
    source.emit('SIGTERM');
    source.emit('SIGINT');
    source.emit('SIGHUP');

    expect(seen).toEqual(['SIGTERM', 'SIGTERM', 'SIGINT', 'SIGHUP']);
    // A handler per signal stays installed, so no signal falls through to Node's default action.
    expect(SHUTDOWN_SIGNALS.map((s) => source.listenerCount(s))).toEqual([1, 1, 1]);
    unsubscribe();
    expect(SHUTDOWN_SIGNALS.map((s) => source.listenerCount(s))).toEqual([0, 0, 0]);
  });
});

describe('asha --server and its stop signals', () => {
  let model: Server;
  beforeEach(async () => {
    model = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    await new Promise((resolve) => model.close(resolve));
  });

  /** runCli --server with a real in-process daemon (fake runtime, store and model server) and signals from `source`. */
  async function serve(source: EventEmitter) {
    const home = await mkdtemp(join(tmpdir(), 'asha-signals-'));
    const logger = new RecordingLogger();
    const started: number[] = [];
    let running: RunningDaemon | undefined;
    const ctx: CliContext = {
      env: { ASHA_HOME: home },
      stdout: () => undefined,
      stderr: () => undefined,
      fetch: globalThis.fetch,
      root: await fixtureRoot(),
      version: '0.0.0-test',
      build: 'test-build-1',
      pid: process.pid,
      startDaemon: async (props) => {
        started.push(props.chatTimeoutMs);
        running = await startDaemon(props);
        return running;
      },
      createLogger: () => logger,
      dependencies: () => ({
        runtime: new FakeRuntime('127.0.0.1'),
        modelServer: new FakeModelServer(`http://127.0.0.1:${String((model.address() as AddressInfo).port)}`),
        store: new FakeStore(),
        ...REAL_STATE,
        fetch: globalThis.fetch,
      }),
      shutdownSignals: shutdownSignals(source),
      spawnServer: () => Promise.reject(new Error('not used')),
      kill: () => undefined,
      isAlive: () => true,
      sleep: () => Promise.resolve(undefined),
      // No process holds any pid a test names: a stopping lookup finds no asha daemon (debt-paydown R15).
      processCommand: () => Promise.resolve(null),
      timing: {
        serverStartMs: 1_000,
        serverStopMs: 1_000,
        streamIdleMs: 1_000,
        pollMs: 10,
        uploadAnswerMs: 260_000,
        downloadIdleMs: 30_000,
      },
      ...NOT_INTERACTIVE,
      ...NO_PORTAL,
      loginName: () => {
        throw new Error('--server reads no login name');
      },
      cwd: () => {
        throw new Error('--server reads no working folder');
      },
      homeDir: () => {
        throw new Error('--server reads no home folder');
      },
    };
    const exited = runCli(['--server'], ctx);
    // Serving once daemon.started is logged.
    while (!logger.events().includes('daemon.started')) await new Promise((resolve) => setImmediate(resolve));
    return {
      exited,
      logger,
      chatTimeouts: () => started,
      daemon: (): RunningDaemon => {
        if (running === undefined) throw new Error('--server has not started its daemon');
        return running;
      },
    };
  }

  const signals = (logger: RecordingLogger) =>
    logger.entries.filter((e) => e.event === 'daemon.stop_requested').map((e) => [e.level, e.fields]);
  /** How many times the daemon's stop ran: stopDaemon logs daemon.stopping once each run (docs/plans/portal.md R14). */
  const stopRuns = (logger: RecordingLogger) => logger.events().filter((e) => e === 'daemon.stopping').length;

  it('SIGTERM then SIGTERM again during the stop: one stop, through to daemon.stopped, the second signal logged and ignored', async () => {
    const source = new EventEmitter();
    const { exited, logger } = await serve(source);

    source.emit('SIGTERM');
    source.emit('SIGTERM');

    expect(await exited).toBe(EXIT.ok);
    expect(stopRuns(logger)).toBe(1);
    expect(signals(logger)).toEqual([
      ['info', { source: 'signal', signal: 'SIGTERM' }],
      ['info', { source: 'signal', signal: 'SIGTERM', ignored: true }],
    ]);
    expect(logger.events().filter((e) => e === 'daemon.stopped')).toHaveLength(1);
    // Still installed: a signal after the stop is handled, not Node's default.
    expect(SHUTDOWN_SIGNALS.map((s) => source.listenerCount(s))).toEqual([1, 1, 1]);
  });

  it('starts the daemon with the one chat bound the agents and the agent suite read, AGENT_CHAT_TIMEOUT_MS (prompt-prefix R14)', async () => {
    const source = new EventEmitter();
    const { exited, chatTimeouts } = await serve(source);
    source.emit('SIGTERM');
    expect(await exited).toBe(EXIT.ok);
    expect(chatTimeouts()).toEqual([AGENT_CHAT_TIMEOUT_MS]);
  });

  it('SIGHUP stops the daemon cleanly, as SIGTERM does', async () => {
    const source = new EventEmitter();
    const { exited, logger } = await serve(source);

    source.emit('SIGHUP');

    expect(await exited).toBe(EXIT.ok);
    expect(stopRuns(logger)).toBe(1);
    expect(signals(logger)).toEqual([['info', { source: 'signal', signal: 'SIGHUP' }]]);
    expect(logger.events().filter((e) => e === 'daemon.stopped')).toHaveLength(1);
  });

  it('a stop the portal began ends --server with exit 0, and a signal during it is logged and ignored (docs/plans/portal.md R14)', async () => {
    const source = new EventEmitter();
    const { exited, logger, daemon } = await serve(source);

    daemon().requestStop({ source: 'portal' });
    source.emit('SIGTERM');

    expect(await exited).toBe(EXIT.ok);
    expect(stopRuns(logger)).toBe(1);
    expect(signals(logger)).toEqual([
      ['info', { source: 'portal' }],
      ['info', { source: 'signal', signal: 'SIGTERM', ignored: true }],
    ]);
    expect(logger.events().filter((e) => e === 'daemon.stopped')).toHaveLength(1);
  });
});
