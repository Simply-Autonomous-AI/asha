// The first request of every turn the gate's model-facing checks put to a model (docs/plans/agent-files.md A13):
// every routing case, held-out case and rainbow case as the routing eval builds it (evals/routing/run.ts), and every
// message the eval tests send (tests/eval/hello-world.eval.test.ts), built by the hello-world agent's own
// helloWorldTurn with its recipe's persona. Its fingerprint — per request, the messages' sha256 and each tool's — is
// compared with the one recorded at the plan's base commit, so a change to what a model sees for any of them fails.
// This file imports only what exists at that base commit, so the fixture can be made there with it.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { helloWorldTurn } from '../../images/hello-world/src/agent.js';
import { Definitions } from '../../src/daemon/definitions/index.js';
import type { ChatRequest, ConversationMessage } from '../../src/shared/protocol.js';
import { CASES, caseMessage } from '../../evals/routing/cases.js';
import { HELD_OUT } from '../../evals/routing/held-out.js';
import { recipePersona, teamMemberPersona } from '../../evals/routing/persona.js';
import { RAINBOW_CASES, RAINBOW_SUPERVISOR, RAINBOW_TEAM } from '../../evals/routing/rainbow.js';

/** One request's fingerprint: its messages, each tool by name, and everything else. */
export interface RequestPrint {
  readonly messages: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly toolOrder: readonly string[];
  readonly rest: string;
}

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function printOf(request: ChatRequest): RequestPrint {
  const { messages, tools, ...rest } = request;
  return {
    messages: sha(messages),
    tools: Object.fromEntries((tools ?? []).map((t) => [t.function.name, sha(t)])),
    toolOrder: (tools ?? []).map((t) => t.function.name),
    rest: sha(rest),
  };
}

/** A user's message as the eval tests send it. */
function evalMessage(text: string, to: string | null): ConversationMessage {
  return {
    id: 'm1',
    channel: 'main',
    conversation: 'm1',
    user: 'user-1',
    from: 'user-1',
    to,
    kind: 'input',
    text,
    at: '2026-09-30T00:00:00.000Z',
  };
}

/** The eval tests' messages: their text, addressee, and the receiving agent with the others on its channel. */
const EVAL_TURNS: readonly {
  readonly id: string;
  readonly text: string;
  readonly to: string | null;
  readonly handle: string;
  readonly others: readonly string[];
}[] = [
  { id: 'eval-say', text: 'Please say: Hello World.', to: null, handle: 'hewo-1', others: [] },
  { id: 'eval-say-to', text: 'Please say: Hello World.', to: 'hewo-1', handle: 'hewo-1', others: [] },
  {
    id: 'eval-ask-other',
    text: 'Please ask hewo-2 to say Hello World.',
    to: 'hewo-1',
    handle: 'hewo-1',
    others: ['hewo-2'],
  },
];

/** Every request of the corpus, by id. `root` is the repo root (recipes/, teams/). */
async function requestCorpus(root: string): Promise<Record<string, ChatRequest>> {
  const definitions = new Definitions(resolve(root));
  const helloWorld = recipePersona(await definitions.recipe('hello-world'));
  const { persona: rainbow } = await teamMemberPersona(await definitions.team(RAINBOW_TEAM), RAINBOW_SUPERVISOR);
  const out: Record<string, ChatRequest> = {};
  for (const c of CASES) out[`routing/${c.id}`] = helloWorldTurn(caseMessage(c), c.handle, c.others, helloWorld);
  for (const c of HELD_OUT) out[`held-out/${c.id}`] = helloWorldTurn(caseMessage(c), c.handle, c.others, helloWorld);
  for (const c of RAINBOW_CASES) out[`rainbow/${c.id}`] = helloWorldTurn(caseMessage(c), c.handle, c.others, rainbow);
  for (const t of EVAL_TURNS) out[t.id] = helloWorldTurn(evalMessage(t.text, t.to), t.handle, t.others, helloWorld);
  return out;
}

/** The corpus's fingerprints, by id. */
export async function corpusPrints(root: string): Promise<Record<string, RequestPrint>> {
  return Object.fromEntries(Object.entries(await requestCorpus(root)).map(([id, request]) => [id, printOf(request)]));
}
