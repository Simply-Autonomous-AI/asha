// The async write components that need judgement: after the agent has
// answered, the chat model reads the turn and saves (a) facts about the user
// worth keeping for weeks, including their preferences — the semantic tier —
// and (b) procedures: a reusable technique that proved effective for getting
// a task done, recorded so it can be used again — the procedural tier (the
// owner's definition, 2026-09-26: not "how to work with this user"). Each is a forced tool call,
// so the output is structured. The model is shown what is already known and
// asked not to repeat it, so paraphrases of a known fact do not pile up
// (docs/architecture/memory.html).

import type { ModelClient } from '../../../../src/agent-sdk/index.js';
import type { ChatRequest, ToolDefinition } from '../../../../src/shared/protocol.js';
import { writerOf } from './session.js';
import type { Turn } from './types.js';

/** The model call for an extraction failed; carries the harness's reason. */
export class ExtractionFailed extends Error {
  constructor(what: string, detail: string) {
    super(`${what} extraction failed: ${detail}`);
    this.name = 'ExtractionFailed';
  }
}

const listTool = (name: string, description: string, item: string, max: number): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string', description: item }, maxItems: max } },
      required: ['items'],
    },
  },
});

export const SAVE_FACTS = listTool(
  'save_facts',
  'Save new facts about the user. Save an empty list when there is nothing new worth keeping.',
  'One fact about the user, as a short sentence in the third person ("The user ...").',
  3,
);

export const SAVE_PROCEDURES = listTool(
  'save_procedures',
  'Save reusable procedures: techniques that proved effective for accomplishing a task. Save an empty list when there is none.',
  'One procedure, as "To <accomplish what>: <the steps or technique that worked>".',
  2,
);

const FACTS_SYSTEM = [
  'You maintain the long-term memory of an assistant about one user.',
  'From the exchange below, extract facts about the user that stay true and useful for weeks: who they are, what they have, what they like or prefer (including how they want answers given), their plans and their situation.',
  'A fact is NOT a log of what happened in this exchange, not a greeting, and not something the assistant said about itself.',
  'Ask of each candidate: would this still be true and useful weeks from now? If not, leave it out.',
  'Never repeat or paraphrase a fact that is already known. Save at most 3. When nothing qualifies, save an empty list.',
].join('\n');

const PROCEDURES_SYSTEM = [
  'You maintain the procedural memory of an assistant: reusable techniques for getting things done.',
  'Read the exchange below. If the assistant accomplished a task in it with a technique that worked and that would be useful again for similar tasks, record that technique as a procedure.',
  'Write each as "To <accomplish what>: <the steps or technique that worked>", general enough to reuse, with the specifics of this one exchange left out.',
  'A procedure is NOT a fact or a preference about the user, NOT a summary of the exchange, and NOT a guess: record only what demonstrably worked. Most exchanges have none.',
  'Never repeat or paraphrase a procedure that is already known. Save at most 2. When nothing qualifies, save an empty list.',
].join('\n');

/** The turn as extraction reads it, its input framed by who wrote it (writerOf), so an agent's words are never shown as the user's. */
function exchange(turn: Turn, user: string): string {
  return `${writerOf(turn, user)} wrote: ${turn.input}\nThe assistant answered: ${turn.response}`;
}

/** `known`, one per line, bulleted; `(nothing yet)` when there is none. */
function knownList(known: readonly string[]): string {
  if (known.length === 0) return '(nothing yet)';
  return known.map((k) => `- ${k}`).join('\n');
}

async function extract(
  model: ModelClient,
  what: string,
  system: string,
  tool: ToolDefinition,
  known: readonly string[],
  turn: Turn,
  user: string,
  max: number,
): Promise<string[]> {
  const request: ChatRequest = {
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Already known (do NOT repeat or paraphrase these):\n${knownList(known)}\n\nThe exchange:\n${exchange(turn, user)}`,
      },
    ],
    maxTokens: 300,
    tools: [tool],
    requireToolCall: true,
  };
  const response = await model.chat(request);
  if (!response.ok) throw new ExtractionFailed(what, `${response.reason}: ${response.detail}`);
  const call = response.toolCalls.find((c) => c.name === tool.function.name);
  if (call === undefined) throw new ExtractionFailed(what, `the model did not call ${tool.function.name}`);
  const items = call.arguments['items'];
  if (!Array.isArray(items)) throw new ExtractionFailed(what, `${tool.function.name} without an items list`);
  // An item that is not text breaks the tool's own schema: a malformed reply like the others, so none of it is kept
  // (the owner, 2026-10-11, record memory-extract-non-string-items). It is named by its position and type, never its
  // content: it is model-written memory about a user, and the message is logged at error level (PRINCIPLES §12).
  const notText = items.findIndex((i) => typeof i !== 'string');
  if (notText !== -1)
    throw new ExtractionFailed(
      what,
      `${tool.function.name} with an item that is not text: item ${String(notText + 1)} is ${jsonType(items[notText])}`,
    );
  return (items as string[])
    .map((i) => i.trim())
    .filter((i) => i !== '')
    .slice(0, max);
}

/** The JSON type of a parsed tool-call value that is not a string, as a message names it: 'a number', 'null', 'an object'. */
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** Facts about the user from one turn remembered in their scope; `user` is the scope's, against which writerOf names the turn's writer. */
export function extractFacts(
  model: ModelClient,
  known: readonly string[],
  turn: Turn,
  user: string,
): Promise<string[]> {
  return extract(model, 'fact', FACTS_SYSTEM, SAVE_FACTS, known, turn, user, 3);
}

/** Procedures from one turn remembered in a user's scope; `user` is the scope's, against which writerOf names the turn's writer. */
export function extractProcedures(
  model: ModelClient,
  known: readonly string[],
  turn: Turn,
  user: string,
): Promise<string[]> {
  return extract(model, 'procedure', PROCEDURES_SYSTEM, SAVE_PROCEDURES, known, turn, user, 2);
}
