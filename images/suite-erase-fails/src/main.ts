// TEST-ONLY IMAGE — never shipped: `images/suite-*` and `dist/images/suite-*` are left out of every release
// (tools/release/pack.mts, NOT_SHIPPED and the dist clean-up; guarded by tests/unit/release.test.ts).
//
// The agent suite's image for agent-persistence A17's failure case: an image that declares it can erase a user
// (image.json: eraseUser true) and then fails at it — `erase-user` exits 1 — so the real one-shot container's
// failure path is run where it will run (PRINCIPLES §14): the saved generation byte-identical, the container gone.
// Launched as an agent it answers every message with one fixed line and no model call, so a delivery is
// acknowledged and its (empty) /memory checkpointed; the team is teams/suite-erase-fails/.

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
  type DeliveryHandler,
} from '../../../src/agent-sdk/index.js';
import { AGENT_CHAT_TIMEOUT_MS, AGENT_DRAIN_MS } from '../../../src/shared/protocol.js';

/** The fixed reply: the test reads it to know the turn ran and was acknowledged. */
const REPLY = 'noted';

if (process.argv[2] === 'erase-user') {
  // On purpose, and with nothing about the user in it: the harness keeps this stderr in the one-shot's log only.
  console.error('suite-erase-fails: erase-user fails on purpose (agent-persistence A17)');
  process.exitCode = 1;
} else {
  const handler: DeliveryHandler = async (delivery, context) => {
    await context.post({ conversation: delivery.message.conversation, kind: 'output', text: REPLY });
  };
  const environment = readAgentEnvironment(process.env);
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
  await exitOnFailure(
    async () => {
      await serveAgent({
        client,
        telemetry,
        name: 'doomed',
        handler,
        process: nodeAgentProcess(process),
        imageTools: { manifest: await readImageManifest(new URL('../image.json', import.meta.url)), handlers: {} },
        workspace: '/workspace',
        // The channel's file space, mounted by the harness in every agent container (docs/plans/agent-files.md R4, R10).
        channelSpace: '/channel',
        log: new JsonLinesAgentLog({ write: (line) => process.stdout.write(line), clock: () => new Date() }),
        drainMs: AGENT_DRAIN_MS,
      });
    },
    nodeAgentProcess(process),
    // Captured in the agent's log, then exit 1 at once (exitOnFailure); serveAgent has flushed the spans.
    (error) => {
      console.error('failed', error);
    },
  );
}
