// The steps of extension-modules A38 (a), R38 (docs/plans/extension-modules.md): a daemon start with no
// ASHA_HOME/modules/, a hello-world launch and one message, recorded as the calls the daemon made — the container
// runtime's (the fake's call list, the images it ensured, the containers it started), the model server's, and every
// model request byte for byte — with each run-specific value (the home's id, ports, tokens, temporary paths)
// replaced by a name. This file uses only what the plan's base commit (9cd9ac9) already had, so the same steps, copied
// there, recorded tests/fixtures/modules/r38-base-calls.json; the test at HEAD compares its own recording with it.

import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentTelemetry, HarnessClient, serveAgent } from '../../src/agent-sdk/index.js';
import { runCli, type CliContext } from '../../src/cli/commands.js';
import { startDaemon } from '../../src/daemon/compose.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { harnessPaths } from '../../src/shared/paths.js';
import { NAME, handleHelloWorld } from '../../images/hello-world/src/agent.js';
import { FakeModelServer, FakeRuntime, FakeStore, REAL_STATE, TEST_LIFETIME, fixtureRoot } from './daemon-fakes.js';
import { ManualSchedule, NOT_INTERACTIVE, NO_PORTAL, RecordingAgentLog, RecordingLogger } from './fakes.js';
import { llamaChunks, scriptOf, sseText } from './llama-stream.js';
import { builtPortal } from './portal-folders.js';

export interface UnusedPathRecord {
  readonly runtimeCalls: readonly string[];
  readonly images: readonly string[];
  readonly starts: readonly { readonly image: string; readonly env: Readonly<Record<string, string>> }[];
  readonly served: readonly string[];
  readonly modelRequests: readonly { readonly url: string; readonly body: string }[];
  readonly reply: string;
}

export async function recordUnusedPath(): Promise<UnusedPathRecord> {
  const modelRequests: { url: string; body: string }[] = [];
  const model = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      modelRequests.push({ url: present(req.url, 'req.url'), body });
      if (req.url === '/tokenize' || req.url === '/completion') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/tokenize' ? { tokens: [13] } : { content: ' x' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const message = {
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', id: 'r1', function: { name: 'reply', arguments: '{"text":"Hello World!"}' } }],
      };
      res.end(
        sseText(
          llamaChunks({
            ...scriptOf(message),
            usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
          }),
        ),
      );
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const modelPort = (model.address() as AddressInfo).port;
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), 'asha-r38-'));
  const paths = harnessPaths({ ASHA_HOME: home });
  const logger = new RecordingLogger();
  const runtime = new FakeRuntime('127.0.0.1');
  const modelServer = new FakeModelServer(`http://127.0.0.1:${String(modelPort)}`);
  const done: Promise<unknown>[] = [];
  runtime.onStart = (spec) => {
    const environment = {
      harnessUrl: present(spec.env['ASHA_URL'], 'ASHA_URL env var'),
      agentToken: present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var'),
    };
    const telemetry = AgentTelemetry.forHarness(environment, () => undefined);
    const client = new HarnessClient({
      environment,
      chatTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      filesRequestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 5_000,
      fetch: globalThis.fetch,
      telemetry,
    });
    const imageTools = {
      manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
      handlers: {},
    } as const;
    done.push(
      serveAgent({
        client,
        telemetry,
        name: NAME,
        handler: handleHelloWorld,
        process: { onTerminate: () => () => undefined, exit: () => undefined },
        imageTools,
        workspace: home,
        channelSpace: null,
        log: new RecordingAgentLog(),
        drainMs: 5_000,
      }).catch((e: unknown) => e),
    );
  };
  const daemon = await startDaemon({
    paths,
    root,
    version: '0.0.0-test',
    build: 'test-build-1',
    pid: process.pid,
    logger,
    dependencies: { runtime, modelServer, store: new FakeStore(), ...REAL_STATE, fetch: globalThis.fetch },
    heartbeatMs: 1_000,
    chatTimeoutMs: 5_000,
    schedule: new ManualSchedule().schedule,
    lifetime: TEST_LIFETIME,
    portal: builtPortal(),
  });
  const out: string[] = [];
  const ctx: CliContext = {
    env: { ASHA_HOME: home },
    stdout: (t) => out.push(t),
    stderr: () => undefined,
    fetch: globalThis.fetch,
    root,
    version: '0.0.0-test',
    build: 'test-build-1',
    pid: process.pid,
    startDaemon,
    createLogger: () => logger,
    dependencies: () => {
      throw new Error('not used');
    },
    shutdownSignals: () => () => undefined,
    spawnServer: () => Promise.reject(new Error('not used')),
    kill: () => undefined,
    isAlive: () => true,
    sleep: () => Promise.resolve(undefined),
    // No process holds any pid a test names: a stopping lookup finds no asha daemon (debt-paydown R15).
    processCommand: () => Promise.resolve(null),
    timing: {
      serverStartMs: 1_000,
      serverStopMs: 1_000,
      streamIdleMs: 5_000,
      pollMs: 10,
      uploadAnswerMs: 260_000,
      downloadIdleMs: 30_000,
    },
    ...NOT_INTERACTIVE,
    ...NO_PORTAL,
    loginName: () => 'olga',
    cwd: () => home,
    homeDir: () => home,
  };
  await runCli(['--launch', 'recipe=greeter'], ctx);
  await runCli(['to=hewo-1', 'message=Please say: Hello World.'], ctx);
  await daemon.stop();
  await Promise.all(done);
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  const name = (text: string): string =>
    text
      .split(paths.homeId)
      .join('<homeId>')
      .split(home)
      .join('<home>')
      .split(root)
      .join('<root>')
      .split(String(daemon.port))
      .join('<daemon-port>')
      .replace(/"[0-9a-f]{32}"/g, '"<id>"')
      .replace(/asha-<homeId>-[0-9a-f]{8}-/g, 'asha-<homeId>-<run>-')
      .replace(/(asha-[a-z0-9]+-[a-z0-9-]+?-)[0-9a-f]{6}\b/g, '$1<suffix>')
      .replace(/conversation":"[^"]+"/g, 'conversation":"<conversation>"');
  return {
    runtimeCalls: runtime.calls.map(name),
    images: runtime.images.map((i) => name(i.repository)),
    starts: runtime.starts.map((s) => ({
      image: name(s.image),
      env: Object.fromEntries(
        Object.keys(s.env)
          .sort(byCodeUnit)
          .map((k) => [k, k === 'ASHA_AGENT_TOKEN' ? '<token>' : name(present(s.env[k], `s.env[${k}]`))]),
      ),
    })),
    served: [...modelServer.served],
    modelRequests: modelRequests.map((r) => ({ url: r.url, body: name(r.body) })),
    reply: out.join(''),
  };
}
