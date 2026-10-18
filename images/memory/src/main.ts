// Container entry point. Wiring only; the graph is in agent.ts and the tiers
// in memory/. Memory lives in this container's own filesystem at /memory
// (the owner's option A, docs/architecture/memory.html): it lasts as long as the container — unless its recipe
// persists it (docs/plans/agent-persistence.md), when the harness restores it before the agent starts and saves it
// after every acknowledged delivery. Run as `erase-user --channel <c> --user <u>`, it is instead the harness's
// one-shot per-user erase (R16): no channel, no model, no environment.

import { randomUUID } from 'node:crypto';

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
import { NAME, memoryAgent } from './agent.js';
import { AgentMemory, DEFAULT_POLICY, MemoryCache, MemoryStore, harnessEmbedder, scopeKey } from './memory/index.js';
import { runEraseMode, validateMemory } from './memory/persisted.js';

const MEMORY_ROOT = '/memory';

// Failures in memory are logged as one JSON line each, never swallowed. The scope is logged
// as its hash, never the raw user ID.
const logError = (event: string, fields: Record<string, unknown>, error: unknown): void => {
  console.error(
    JSON.stringify({ level: 'error', event, ...fields, error: error instanceof Error ? error.message : String(error) }),
  );
};

if (process.argv[2] === 'erase-user') {
  // The harness reads exactly one line on stdout; the exit code says how it went. Nothing below runs.
  process.exitCode = await runEraseMode(process.argv.slice(2), {
    root: MEMORY_ROOT,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} else {
  await runAgent();
}

async function runAgent(): Promise<void> {
  // A persisted /memory is checked whole before the agent joins (R12): a file it cannot read ends the launch, loudly.
  try {
    const { files, temporariesRemoved } = await validateMemory(MEMORY_ROOT);
    if (files > 0) console.log(`validated ${String(files)} memory files`);
    if (temporariesRemoved > 0)
      console.log(`removed ${String(temporariesRemoved)} half-written memory temporaries a checkpoint had caught`);
  } catch (error) {
    logError('memory.invalid_at_start', {}, error);
    process.exitCode = 1;
    return;
  }

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

  const memory = new AgentMemory({
    cache: new MemoryCache({
      store: new MemoryStore({
        root: MEMORY_ROOT,
        onDropped: (file, count) => {
          logError('memory.records_dropped', { file, count }, 'invalid records');
        },
        // A malformed tier file, which the store then overwrites with the tier's empty document: a major defect,
        // logged at error so the agent-side failure scan finds it (the owner, 2026-10-11, record
        // memory-unreadable-session-episodic). The file names the scope by its hash, never the raw user ID.
        onMalformed: (file, error) => {
          logError('memory.file_malformed', { file }, error);
        },
      }),
      clock: () => new Date(),
      onSaveFailed: (scope, tier, error) => {
        logError('memory.save_failed', { scope: scopeKey(scope), tier }, error);
      },
      maxDocs: 400,
    }),
    embedder: harnessEmbedder(client),
    model: client,
    clock: () => new Date(),
    policy: DEFAULT_POLICY,
    newId: randomUUID,
    onWriteFailed: (scope, error) => {
      logError('memory.write_failed', { scope: scopeKey(scope) }, error);
    },
  });

  console.log(`joining the channel as ${NAME}`);
  await exitOnFailure(
    async () => {
      await serveAgent({
        client,
        telemetry,
        name: NAME,
        handler: memoryAgent({ memory, clock: () => new Date(), newId: randomUUID }),
        process: nodeAgentProcess(process),
        // image.json is staged beside the compiled code; this image implements no tools of its own.
        imageTools: { manifest: await readImageManifest(new URL('../image.json', import.meta.url)), handlers: {} },
        workspace: '/workspace',
        // The channel's file space, mounted by the harness in every agent container (docs/plans/agent-files.md R4, R10).
        channelSpace: '/channel',
        log: new JsonLinesAgentLog({ write: (line) => process.stdout.write(line), clock: () => new Date() }),
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
}
