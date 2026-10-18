// The Hello World agent. On the channel it calls itself "hewo". Everything it
// knows about working on the channel — the shared instructions, the reply and
// send_message tools, and the common tools its recipe selects — comes from the
// SDK, and its role from its recipe's prompt, which the welcome event carries
// (docs/plans/collaborating-agents.md R1): this image carries no role of its
// own, so one image serves every recipe that names it. For each message it receives, it asks the
// model (through the harness) — which may first look up the online agents with
// list_agents, or use its tools — and carries out the model's calls: a reply
// to the user, a send_message with a task for another agent or a question to
// the channel, or a consult whose answers come back to it — first saying "ok"
// in the conversation; or, asked in a call, its answer or pass to the caller.
// A pass says why. It implements one tool of
// its own, hold (image.json, src/hold.ts), which only a recipe built to stall
// selects (docs/plans/patterns-phase-2.md R7).

import {
  PASS,
  act,
  channelTurn,
  decide,
  turnPoster,
  type AgentPersona,
  type DeliveryHandler,
} from '../../../src/agent-sdk/index.js';
import type { ChatRequest, ConversationMessage } from '../../../src/shared/protocol.js';

/** The base name this agent joins the channel under; the channel numbers it (hewo-1, hewo-2, …). */
export const NAME = 'hewo';

/**
 * Bound on generated tokens per model call. 1,024 since agent calls (docs/plans/agent-calls.md R20): a nine-request
 * consult took 180–196 tokens and nine parallel send_message calls 271, against the former 256 (probe P2). A bound,
 * not a target: at temperature 0 it changes no output that completed within the old bound.
 */
export const MAX_TOKENS = 1_024;

/** Bound on list_agents rounds in one turn. */
export const MAX_ROUNDS = 3;

/** Bound on invalid replies or messages sent back to the model to fix, per message. */
export const MAX_CORRECTIONS = 2;

/**
 * The model request for one message, with the persona its recipe gives it: the prompt as its role and the tools it
 * selects. The routing eval runs exactly this, with the persona read from recipes/hello-world.json.
 */
export function helloWorldTurn(
  message: ConversationMessage,
  handle: string,
  others: readonly string[],
  persona: AgentPersona,
): ChatRequest {
  // hello-world recalls nothing: its per-agent block is the identity line and the message.
  return channelTurn({ handle, others, persona, message, maxTokens: MAX_TOKENS, memory: '' });
}

export const handleHelloWorld: DeliveryHandler = async (delivery, context) => {
  const { message } = delivery;
  const roster = await context.roster();
  let others = roster.map((a) => a.handle);
  // One working status for the turn, whether reply_with_files (posted inside decide) or act() says it first.
  const poster = turnPoster(delivery, context);
  const persona = {
    role: context.prompt,
    guidance: context.guidance,
    tools: context.tools.definitions,
    ...(context.nestedCalls ? { nestedCalls: true } : {}),
  };
  const calls = await decide({
    model: context.model,
    request: helloWorldTurn(message, context.handle, others, persona),
    message,
    roster,
    maxRounds: MAX_ROUNDS,
    maxCorrections: MAX_CORRECTIONS,
    tools: context.tools,
    replyWithFiles: poster.replyWithFiles,
    // A launch grant (docs/plans/patterns-phase-3.md R30, R31): the turn rebuilt for the roster with the new agent on it.
    launchAgent: (recipe) => context.launchAgent(delivery.deliveryId, recipe),
    readRoster: () => context.roster(),
    rebuild: (now) =>
      helloWorldTurn(
        message,
        context.handle,
        now.map((a) => a.handle),
        persona,
      ),
    onRoster: (now) => {
      others = now.map((a) => a.handle);
    },
  });
  for (const call of calls.filter((c) => c.name === PASS)) console.log(`pass: ${String(call.arguments['reason'])}`);
  await act(calls, others, delivery, context, poster);
};
