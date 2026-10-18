// The daemon's HTTP server on a loopback port with a real Channels and stand-ins for the supervisor's routes, so a
// route's validation and refusals can be asserted against the real wire contract and the real channel state
// (docs/plans/agent-files.md A4: a refused conversation leaves no user online).

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import type { AgentSupervisor } from '../../src/daemon/agents/index.js';
import { Channels } from '../../src/daemon/channel/index.js';
import { ChannelFileSpaces } from '../../src/daemon/files/index.js';
import { RefusalLog } from '../../src/daemon/refusal-log/index.js';
import { createDaemonServer, type DaemonServerProps } from '../../src/daemon/server.js';
import { DaemonTracer, type TraceFileWriter } from '../../src/daemon/traces/index.js';
import { PortalErrorLog, PortalFiles } from '../../src/daemon/portal/index.js';
import { portalStub } from './portal-folders.js';
import { FakeRuntime } from './daemon-fakes.js';
import { ManualSchedule, MemoryUserLedger, RecordingLogger } from './fakes.js';

const CREDENTIAL = 'c'.repeat(64);

export interface ServerHarness {
  readonly server: Server;
  readonly channels: Channels;
  /** The real file spaces over a fake Docker (`runtime`). */
  readonly files: ChannelFileSpaces;
  readonly runtime: FakeRuntime;
  readonly logger: RecordingLogger;
  readonly base: string;
  /** Requests and streams begun and ended, as the daemon's idle clock counts them (idle-shutdown R3). */
  readonly activity: { readonly begun: number; readonly ended: number };
  /** Sends a control request with the credential. */
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Starts the server with `supervisor` standing in for the agent supervisor (only the methods a test's routes call
 * need exist) and any other props a test overrides.
 */
export async function serverHarness(
  supervisor: Partial<AgentSupervisor>,
  overrides: Partial<DaemonServerProps> = {},
): Promise<ServerHarness> {
  const logger = new RecordingLogger();
  let n = 0;
  const tracer = new DaemonTracer({
    clock: () => new Date(),
    newSpanId: () => (++n).toString(16).padStart(16, '0'),
    record: () => undefined,
  });
  const channels = new Channels({
    logger,
    clock: () => new Date(),
    newId: () => `id${String(++n)}`,
    onDeliveryTimeout: () => undefined,
    maxAgentPostsPerConversation: 32,
    users: new MemoryUserLedger(),
    tracer,
  });
  let port = 0;
  /** Requests and streams begun and ended, as the daemon's idle clock counts them (idle-shutdown R3). */
  const activity = { begun: 0, ended: 0 };
  const runtime = new FakeRuntime();
  const files = new ChannelFileSpaces({
    runtime,
    logger,
    homeId: 'abcd1234',
    runId: '0123abcd',
    clock: () => new Date(),
    ownSecrets: () => [],
  });
  const server = createDaemonServer({
    supervisor: supervisor as AgentSupervisor,
    channels,
    files,
    logger,
    version: 't',
    build: 't',
    startedAt: new Date().toISOString(),
    pid: process.pid,
    heartbeatMs: 60_000,
    credential: CREDENTIAL,
    port: () => port,
    agentHostAddress: 'host.test',
    refusals: new RefusalLog({ logger, schedule: new ManualSchedule().schedule, windowMs: 1_000 }),
    traces: {} as TraceFileWriter,
    stopping: () => false,
    portal: await PortalFiles.load(await portalStub()),
    portalErrors: new PortalErrorLog({ logger, schedule: new ManualSchedule().schedule }),
    telemetry: () => {
      throw new Error('this harness serves no telemetry');
    },
    definitions: () => {
      throw new Error('this harness serves no definitions');
    },
    demos: () => {
      throw new Error('this harness serves no demos');
    },
    stopIdleModels: () => {
      throw new Error('this harness stops no model servers');
    },
    requestStop: () => {
      throw new Error('this harness has no stop trigger');
    },
    activity: () => {
      activity.begun += 1;
      return () => {
        activity.ended += 1;
      };
    },
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${String(port)}`;
  return {
    server,
    channels,
    files,
    runtime,
    logger,
    base,
    activity,
    request: (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${CREDENTIAL}`, ...(init.headers as Record<string, string> | undefined) },
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
