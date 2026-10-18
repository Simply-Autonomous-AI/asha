// Container entry point. Wiring only; the behaviour is in agent.ts.

import {
  AgentTelemetry,
  exitOnFailure,
  HarnessClient,
  JsonLinesAgentLog,
  nodeAgentProcess,
  readAgentEnvironment,
  readImageManifest,
  REPLY_WITH_FILES_TIMEOUT_MS,
  serveAgent,
} from '../../../src/agent-sdk/index.js';
import { AGENT_CHAT_TIMEOUT_MS, AGENT_DRAIN_MS } from '../../../src/shared/protocol.js';
import { NAME, handleHelloWorld } from './agent.js';
import { HOLD, holdHandler } from './hold.js';

const environment = readAgentEnvironment(process.env);
// Spans to the harness; an export failure is one JSON line on stdout, in the agent's log.
const telemetry = AgentTelemetry.forHarness(environment, (line) => process.stdout.write(`${line}\n`));
const client = new HarnessClient({
  environment,
  chatTimeoutMs: AGENT_CHAT_TIMEOUT_MS,
  requestTimeoutMs: 10_000,
  // An output with files waits on the daemon's copies: 30 s, not 10 (docs/plans/agent-files.md R12).
  filesRequestTimeoutMs: REPLY_WITH_FILES_TIMEOUT_MS,
  streamIdleTimeoutMs: 45_000,
  fetch: globalThis.fetch,
  telemetry,
});

// One log for the SDK and the image's own tool, which announces itself in it (hold.started).
const log = new JsonLinesAgentLog({ write: (line) => process.stdout.write(line), clock: () => new Date() });

console.log(`joining the channel as ${NAME}`);
await exitOnFailure(
  async () => {
    await serveAgent({
      client,
      telemetry,
      name: NAME,
      handler: handleHelloWorld,
      process: nodeAgentProcess(process),
      // image.json is staged beside the compiled code. Its one tool, hold, is offered only to a recipe that selects it
      // (docs/plans/patterns-phase-2.md R7).
      imageTools: {
        manifest: await readImageManifest(new URL('../image.json', import.meta.url)),
        handlers: { [HOLD]: holdHandler(log) },
      },
      workspace: '/workspace',
      // The channel's file space, mounted by the harness in every agent container (docs/plans/agent-files.md R4, R10).
      channelSpace: '/channel',
      log,
      // On SIGTERM, the bound on finishing started work; shorter than the harness's stop grace.
      drainMs: AGENT_DRAIN_MS,
      onJoined: ({ handle, channel }) => {
        console.log(`joined channel "${channel}" as ${handle}`);
      },
    });
    console.log('the harness closed the channel; exiting');
  },
  nodeAgentProcess(process),
  // Captured in the agent's log, then exit 1 at once (exitOnFailure); serveAgent has flushed the spans.
  (error) => {
    console.error('failed', error);
  },
);
