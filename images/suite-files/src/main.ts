// TEST-ONLY IMAGE — never shipped: `images/suite-*` and `dist/images/suite-*` are left out of every release
// (tools/release/pack.mts, NOT_SHIPPED and the dist clean-up; guarded by tests/unit/release.test.ts).
//
// The agent suite's scripted agent for files (docs/plans/agent-files.md A3, A6, A11, A12): no model call. Each message
// is one command, run with the SDK's own file tools and its reply_with_files, and answered with one reply:
//   write <path> <text…>   write_file, the result as JSON
//   read <path>            read_file, the result as JSON
//   attachments            the message's `attachments`, as JSON (R9)
//   return <path…>         reply_with_files naming the paths: "returned", or "refused file_refused" (R12)
//   fail <text…>           throws new Error(<text…>) from the handler: the agent fails, and exits 1 (debt-paydown R17, D25)
//   wait <n>               waits n seconds (an integer 1 to 30), then replies "waited <n>"; anything else is answered
//                          "refused wait <arg>" (debt-paydown R17: a turn in progress while the daemon stops, A13)
//   anything else          "noted"
// It runs the real agent SDK in the real container: /channel is the harness's volume, checked at its start (R10).

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
  TurnBudget,
  type DeliveryHandler,
} from '../../../src/agent-sdk/index.js';
import { AGENT_CHAT_TIMEOUT_MS, AGENT_DRAIN_MS } from '../../../src/shared/protocol.js';

const handler: DeliveryHandler = async (delivery, context) => {
  const { message } = delivery;
  const conversation = message.conversation;
  const [command, ...rest] = message.text.trim().split(/\s+/);
  const reply = (text: string) => context.post({ conversation, kind: 'output', text });
  const tool = (name: string, args: Record<string, unknown>) =>
    context.tools.run({ id: name, name, arguments: args }, new TurnBudget());
  if (command === 'write') {
    await reply(await tool('write_file', { path: rest[0], content: rest.slice(1).join(' ') }));
    return;
  }
  if (command === 'read') {
    await reply(await tool('read_file', { path: rest[0] }));
    return;
  }
  if (command === 'attachments') {
    await reply(JSON.stringify(message.attachments ?? []));
    return;
  }
  if (command === 'return') {
    const result = await context.replyWithFiles({ conversation, text: 'returned', files: rest });
    if (!result.ok) await reply(`refused ${result.reason}`);
    return;
  }
  if (command === 'fail') throw new Error(rest.join(' '));
  if (command === 'wait') {
    const arg = rest.join(' ');
    if (!/^([1-9]|[12]\d|30)$/.test(arg)) {
      await reply(`refused wait ${arg}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Number(arg) * 1_000));
    await reply(`waited ${arg}`);
    return;
  }
  await reply('noted');
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
      name: 'scribe',
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
