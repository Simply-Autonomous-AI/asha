// The memory agent. On the channel it calls itself "memo". It is the channel
// layer of every agent (instructions, reply / send_message / pass) plus
// memory in four tiers, run as a small graph for each delivery
// (docs/architecture/memory.html):
//
//   identify → recall → assemble → decide → act → remember (async)
//
// identify: whose memory — the harness-set user on the message, on this
//   channel. Nothing else ever chooses the scope.
// recall: the read component of each tier (session window, and episodic,
//   semantic and procedural by meaning).
// assemble: the recalled memory into the agent's per-agent block, at the start
//   of the incoming message (never the system prompt, which every agent of the
//   recipe shares — docs/plans/prompt-prefix.md R7), and the session window as
//   real chat turns before the incoming message.
// decide / act: the shared channel layer.
// remember: the write component of each tier, queued after the agent has
//   answered and not awaited — never for a call's question or a gather,
//   whose words are an agent's (docs/plans/agent-calls.md R20) — the next message from the same user waits for it,
//   and so does the agent's exit on SIGTERM (it is registered as background work).

import {
  ASK_USER,
  CONSULT,
  PASS,
  REPLY,
  REPLY_WITH_FILES,
  SEND_MESSAGE,
  act,
  channelTurn,
  decide,
  turnPoster,
  type DeliveryHandler,
} from '../../../src/agent-sdk/index.js';
import type { ChatMessage, ChatRequest, ConversationMessage, ToolCall } from '../../../src/shared/protocol.js';
import type { AgentMemory, Scope, Turn } from './memory/index.js';
import { writerOf } from './memory/session.js';

/** The base name this agent joins the channel under; the channel numbers it (memo-1, …). */
export const NAME = 'memo';

/** 1,024 since agent calls (docs/plans/agent-calls.md R20; probe P2), as for hello-world. */
export const MAX_TOKENS = 1_024;
const MAX_ROUNDS = 3;
const MAX_CORRECTIONS = 2;

/** identify: the memory scope of a message. A conversation message always has a user; one without is refused. */
export function scopeOf(message: ConversationMessage): Scope {
  if (typeof message.user !== 'string' || message.user === '') {
    throw new Error(`message ${message.id} carries no user, so it has no memory scope`);
  }
  return { channel: message.channel, user: message.user };
}

/**
 * assemble: the session window as chat turns, after the system prompt and before the incoming message. The system
 * prompt is left as it is (prompt-prefix R7): the recalled `# Memory` section reaches the request only as
 * channelTurn's `memory`, in the agent's per-agent block. Each remembered turn is framed by who wrote it, `user`
 * being the scope's: "The user wrote:" for the user's own, "Agent <name>, for the user, wrote:" for a task another
 * agent passed on, as its episode reads (the owner, 2026-10-12, record memory-delegated-task-replay, option (a)).
 */
export function withMemory(request: ChatRequest, history: readonly Turn[], user: string): ChatRequest {
  const [system, ...rest] = request.messages;
  if (system === undefined || system.role !== 'system') throw new Error('a channel turn starts with its system prompt');
  const turns: ChatMessage[] = history.flatMap((turn): ChatMessage[] => [
    { role: 'user', content: `${writerOf(turn, user)} wrote:\n${turn.input}` },
    { role: 'assistant', content: turn.response },
  ]);
  return { ...request, messages: [system, ...turns, ...rest] };
}

/**
 * What the agent did with a message, as it will be remembered; null when it passed. A reply with files is remembered
 * with its text and the files' names (each the last part of its /channel path, the name the user receives it under), a
 * question to the user with the question asked (the owner, 2026-10-11, record memory-remember-files-and-questions,
 * option (a)); decide() has checked both calls' arguments.
 */
export function responseOf(calls: readonly ToolCall[]): string | null {
  const said = calls.flatMap((c) => {
    if (c.name === REPLY) return [String(c.arguments['text'])];
    if (c.name === REPLY_WITH_FILES) {
      const names = (c.arguments['files'] as readonly string[]).map((path) => path.slice(path.lastIndexOf('/') + 1));
      return [`${String(c.arguments['text'])}\n(gave the user files: ${names.join(', ')})`];
    }
    if (c.name === ASK_USER) return [`(asked the user: ${String(c.arguments['text'])})`];
    if (c.name === SEND_MESSAGE) return [`(asked ${String(c.arguments['to'])}: ${String(c.arguments['text'])})`];
    if (c.name === CONSULT) {
      const requests = c.arguments['requests'] as readonly { readonly to: unknown; readonly text: unknown }[];
      return requests.map((r) => `(consulted ${String(r.to)}: ${String(r.text)})`);
    }
    return [];
  });
  return said.length === 0 ? null : said.join('\n');
}

export interface MemoryAgentProps {
  readonly memory: AgentMemory;
  readonly clock: () => Date;
  readonly newId: () => string;
}

export function memoryAgent(props: MemoryAgentProps): DeliveryHandler {
  return async (delivery, context) => {
    const { message } = delivery;
    const scope = scopeOf(message);
    // A gather's text is the harness's count; what the turn is about is the message the call was made for (R20).
    const recall = await props.memory.recall(
      scope,
      message.call?.role === 'gather' ? message.call.context.text : message.text,
    );
    const roster = await context.roster();
    const others = roster.map((a) => a.handle);
    // Its role is its recipe's prompt, with its full-text documents (collaborating-agents R1, R2); its tools are the ones its recipe selects.
    const persona = {
      role: context.prompt,
      guidance: context.guidance,
      tools: context.tools.definitions,
      ...(context.nestedCalls ? { nestedCalls: true } : {}),
    };
    const request = withMemory(
      channelTurn({ handle: context.handle, others, persona, message, maxTokens: MAX_TOKENS, memory: recall.context }),
      recall.history,
      scope.user,
    );
    // One working status for the turn, whether reply_with_files (posted inside decide) or act() says it first.
    const poster = turnPoster(delivery, context);
    const calls = await decide({
      model: context.model,
      request,
      message,
      roster,
      maxRounds: MAX_ROUNDS,
      maxCorrections: MAX_CORRECTIONS,
      tools: context.tools,
      replyWithFiles: poster.replyWithFiles,
    });
    for (const call of calls.filter((c) => c.name === PASS)) console.log(`pass: ${String(call.arguments['reason'])}`);
    await act(calls, others, delivery, context, poster);
    const response = responseOf(calls);
    // A call's question and a gather are not remembered: their words are an agent's, not the user's (R20). The turn
    // that consulted is remembered.
    if (response !== null && message.call === undefined) {
      const turn: Turn = {
        id: props.newId(),
        ts: props.clock().toISOString(),
        conversation: message.conversation,
        from: message.from,
        input: message.text,
        response,
      };
      // Not awaited: extraction takes model calls, and the user already has the answer. Registered, so an
      // agent told to stop waits for the write to reach disk (serveAgent's drain) instead of losing it.
      context.background(
        'memory.remember',
        props.memory.remember(scope, turn).then(() => props.memory.settled(scope)),
      );
    }
  };
}
