// The routing cases: one incoming channel message put to one hello-world
// agent, and the exact action the channel instructions call for. An action is
// a call of one tool: reply (to the user, or — in a call turn — to the caller),
// send_message (to "all-agents" or an agent), or consult (one action per
// request, in order); pass means the agent should decide not to act.
//
// Re-expressed 2026-09-27 (docs/plans/agent-calls.md R15): no reply-to field. Every
// expectation names one tool and its destinations, and grade() checks the
// tool, so a consult cannot pass a hand-off case nor a send_message an
// ask-for-yourself case. An agent's question arrives as a call (its message
// carries `call`), answered with reply, which goes to the asker (R14).

import type { AgentPersona } from '../../src/agent-sdk/index.js';
import type { ApprovedCall, CallMark, ConversationMessage } from '../../src/shared/protocol.js';
import { APPROVED_CASES } from './approved.js';

type Expectation =
  /** An explicit pass, and no action. */
  | { readonly tool: 'pass' }
  | {
      readonly tool: 'reply' | 'send_message' | 'consult';
      /** Each action's destination, in order: "user" for a reply to the user; a consult has one per request. */
      readonly to: readonly string[];
      /** Every action's text must match this, when given. */
      readonly text?: RegExp;
      /** No action's text may match this, when given (debt-paydown R8: an approved result's injected text). */
      readonly notText?: RegExp;
    };

export interface RoutingCase {
  readonly id: string;
  /** What the case checks, in a sentence. */
  readonly checks: string;
  readonly handle: string;
  readonly others: readonly string[];
  /** Descriptions for agents in `others` that are not hello-world instances (list_agents shows them). */
  readonly describe?: Readonly<Record<string, { readonly recipe: string; readonly description: string }>>;
  readonly from: string;
  /** The recipient: an agent handle, or null for everyone on the channel. */
  readonly to: string | null;
  readonly text: string;
  /** The channel's call mark, on a call's question or a gather (R14). */
  readonly call?: CallMark;
  /** asha's message after an approved call carries it (extension-modules R12 (d); debt-paydown R8). */
  readonly approved?: ApprovedCall;
  /** The agent's persona for this case, in place of the hello-world recipe's (debt-paydown R8: P7's payments agent). */
  readonly persona?: AgentPersona;
  readonly expect: Expectation;
}

const HELLO = /hello,? world/i;
/**
 * A hand-off must be an instruction the other agent can act on — "Say Hello
 * World", "Please say: Hello World." — not just the words or the result
 * ("Hello World"), which only works when the receiver happens to repeat what
 * it is given. Seen through ./asha on 2026-09-26, after the reply split.
 */
const SAY_TASK = /^(please[,:]?\s+)?say\b.*hello,? world/i;
const TRANSLATE_TASK = /^(please[,:]?\s+)?(translate|put)\b.*hello,? world/i;
/** The memory recipe's description, as list_agents shows it (recipes/memory.json). */
const MEMORY = {
  recipe: 'memory',
  description:
    'A personal assistant that remembers each user: facts and preferences they share, earlier conversations, and techniques that worked for their tasks.',
} as const;
/** The mark of a call's question; the id is the channel's, and never read by the agent. */
export const QUESTION: CallMark = { id: 'call-1', role: 'question' };

/** Every request of a relay gather: `Say: <word>` to each agent in turn, each answered with its word. */
function relay(context: string, words: readonly (readonly [string, string])[]): CallMark {
  return {
    id: 'call-1',
    role: 'gather',
    context: { from: 'user-1', text: context },
    requests: words.map(([to, word]) => ({ to, text: `Say: ${word}` })),
    answers: words.map(([from, word]) => ({ from, outcome: 'answered', text: word })),
  };
}

const THREE: readonly (readonly [string, string])[] = [
  ['hewo-2', 'amber'],
  ['hewo-3', 'silver'],
  ['hewo-4', 'crimson'],
];
const NINE: readonly (readonly [string, string])[] = [
  ['hewo-2', 'violet'],
  ['hewo-3', 'green'],
  ['hewo-4', 'pink'],
  ['hewo-5', 'red'],
  ['hewo-6', 'indigo'],
  ['hewo-7', 'brown'],
  ['hewo-8', 'orange'],
  ['hewo-9', 'blue'],
  ['hewo-10', 'yellow'],
];
/** The words, in order, anywhere in one reply. */
function inOrder(words: readonly (readonly [string, string])[]): RegExp {
  return new RegExp(words.map(([, w]) => `\\b${w}\\b`).join('[\\s\\S]*'), 'i');
}

const ROUTING_CASES: readonly RoutingCase[] = [
  {
    id: 'solo-answer',
    checks: 'Alone on the channel, a user request to everyone is answered to the user.',
    handle: 'hewo-1',
    others: [],
    from: 'user',
    to: null,
    text: 'Please say: Hello World.',
    expect: { tool: 'reply', to: ['user'], text: HELLO },
  },
  {
    id: 'solo-addressed',
    checks: 'Alone on the channel, a user request addressed to the agent is answered to the user.',
    handle: 'hewo-1',
    others: [],
    from: 'user',
    to: 'hewo-1',
    text: 'Please say: Hello World.',
    expect: { tool: 'reply', to: ['user'], text: HELLO },
  },
  {
    id: 'addressed-answer',
    checks: 'A user request addressed to the agent is answered to the user.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: 'hewo-1',
    text: 'Please say: Hello World.',
    expect: { tool: 'reply', to: ['user'], text: HELLO },
  },
  {
    id: 'broadcast-answer',
    checks: 'With another agent present, a user request to everyone is still answered to the user, not the channel.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: null,
    text: 'Please say: Hello World.',
    expect: { tool: 'reply', to: ['user'], text: HELLO },
  },
  {
    id: 'delegate',
    checks:
      'Asked by the user to have hewo-2 do it, the agent sends hewo-2 the task, as an instruction, instead of doing it.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: 'hewo-1',
    text: 'Please ask hewo-2 to say Hello World.',
    expect: { tool: 'send_message', to: ['hewo-2'], text: SAY_TASK },
  },
  {
    id: 'delegated',
    checks: 'Given a task by another agent, the agent does it and sends the result to the user.',
    handle: 'hewo-2',
    others: ['hewo-1'],
    from: 'hewo-1',
    to: 'hewo-2',
    text: 'Say Hello World.',
    expect: { tool: 'reply', to: ['user'], text: HELLO },
  },
  {
    id: 'delegated-bare',
    checks:
      'Given only the words to say by another agent (as a small model delegates), the agent says them to the user.',
    handle: 'hewo-2',
    others: ['hewo-1'],
    from: 'hewo-1',
    to: 'hewo-2',
    text: 'Hello World',
    expect: { tool: 'reply', to: ['user'], text: HELLO },
  },
  {
    id: 'delegate-by-role',
    checks:
      'Asked to use "the agent that translates", the agent finds it by what it does (list_agents) and sends it the task.',
    handle: 'hewo-1',
    others: ['hewo-2', 'trans-1'],
    from: 'user',
    to: 'hewo-1',
    describe: { 'trans-1': { recipe: 'translator', description: 'Translates text into French.' } },
    text: 'Please ask the agent that translates to put Hello World into French.',
    expect: { tool: 'send_message', to: ['trans-1'], text: TRANSLATE_TASK },
  },
  {
    id: 'claim',
    checks: 'When an agent asks everyone who can take a task it can do, the agent tells the asker it will take it.',
    handle: 'hewo-2',
    others: ['hewo-1'],
    from: 'hewo-1',
    to: null,
    text: 'Which agent can say Hello World for the user?',
    expect: { tool: 'send_message', to: ['hewo-1'] },
  },
  {
    id: 'ignore-agent-request',
    checks: "An agent's request to everyone that the role does not cover gets no action.",
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'hewo-2',
    to: null,
    text: 'Can anyone translate this contract into French?',
    expect: { tool: 'pass' },
  },
  {
    id: 'ignore-user-request',
    checks: 'A user request to everyone that the role does not cover gets no action.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: null,
    text: 'Please translate this contract into French.',
    expect: { tool: 'pass' },
  },
  // Messages that are not the agent's task. The failure these guard against
  // (seen through ./asha on 2026-09-26): a user "Hi" to everyone was answered
  // with "Hi" posted to the channel, so the user never saw a reply.
  {
    id: 'solo-greeting',
    checks: 'Alone on the channel, a user greeting to everyone is answered to the user, not posted to the channel.',
    handle: 'hewo-1',
    others: [],
    from: 'user',
    to: null,
    text: 'Hi',
    expect: { tool: 'reply', to: ['user'] },
  },
  {
    id: 'solo-greeting-addressed',
    checks: 'Alone on the channel, a user greeting addressed to the agent is answered to the user.',
    handle: 'hewo-1',
    others: [],
    from: 'user',
    to: 'hewo-1',
    text: 'Hi',
    expect: { tool: 'reply', to: ['user'] },
  },
  {
    id: 'solo-question',
    checks: 'Alone on the channel, a user question to everyone about the agent is answered to the user.',
    handle: 'hewo-1',
    others: [],
    from: 'user',
    to: null,
    text: 'What can you do?',
    expect: { tool: 'reply', to: ['user'] },
  },
  {
    id: 'solo-other-words',
    checks:
      'Alone on the channel, a request to say words other than Hello World is answered to the user with those words.',
    handle: 'hewo-1',
    others: [],
    from: 'user',
    to: null,
    text: 'Please say: Good morning.',
    expect: { tool: 'reply', to: ['user'], text: /good morning/i },
  },
  {
    id: 'multi-greeting',
    checks:
      'With another agent on the channel, a user greeting to everyone is answered to the user, not posted to the channel.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: null,
    text: 'Hi',
    expect: { tool: 'reply', to: ['user'] },
  },
  {
    id: 'multi-greeting-addressed',
    checks: 'With another agent on the channel, a user greeting addressed to the agent is answered to the user.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: 'hewo-1',
    text: 'Hi',
    expect: { tool: 'reply', to: ['user'] },
  },
  {
    id: 'multi-question',
    checks: 'With another agent on the channel, a user question addressed to the agent is answered to the user.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: 'hewo-1',
    text: 'What can you do?',
    expect: { tool: 'reply', to: ['user'] },
  },
  {
    id: 'agent-question',
    checks: 'Asked a question directly by another agent, the agent answers that agent, not the user or the channel.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'hewo-2',
    to: 'hewo-1',
    call: QUESTION,
    text: 'What is your role?',
    expect: { tool: 'reply', to: ['hewo-2'] },
  },
  // Added 2026-09-27 (docs/plans/channel-instructions.md R14, re-expressed by agent-calls R15): the sender's
  // choice between a hand-off and a call, and a task written as a question — the shape that broke variant 6.
  {
    id: 'ask-for-self',
    checks:
      'Asked by the user to find something out from another agent and tell the user itself, the agent consults it, so the answer comes back to it.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: 'hewo-1',
    text: 'Find out from hewo-2 what its role is, then tell me yourself.',
    expect: { tool: 'consult', to: ['hewo-2'] },
  },
  {
    id: 'ask-for-user',
    checks:
      'Asked by the user to ask another agent something, the agent hands the question off with send_message, so that agent answers the user.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: 'hewo-1',
    text: 'Please ask hewo-2 what its role is.',
    expect: { tool: 'send_message', to: ['hewo-2'] },
  },
  {
    id: 'delegated-question',
    checks:
      'Given a task written as a question by another agent, with the result for the user, the agent does it for the user.',
    handle: 'hewo-2',
    others: ['hewo-1'],
    from: 'hewo-1',
    to: 'hewo-2',
    text: 'Can you say Hello World?',
    expect: { tool: 'reply', to: ['user'], text: HELLO },
  },
  // Added 2026-09-27 (docs/plans/agent-calls.md R14): the caller's choice, the callee's call turn, and the gather.
  {
    id: 'ask-memo-for-user',
    checks:
      'Asked by the user to ask the memory agent about the user, the agent hands the question off, so the memory agent answers the user.',
    handle: 'hewo-1',
    others: ['memo-1'],
    describe: { 'memo-1': MEMORY },
    from: 'user',
    to: 'hewo-1',
    text: 'Please ask memo-1 what my favourite colour is.',
    expect: { tool: 'send_message', to: ['memo-1'] },
  },
  {
    id: 'ask-two-for-self',
    checks:
      'Asked by the user to find something out from two agents and tell the user itself, the agent consults both in one call, in the order named.',
    handle: 'hewo-1',
    others: ['hewo-2', 'hewo-3'],
    from: 'user',
    to: 'hewo-1',
    text: 'Find out from hewo-2 and hewo-3 what their roles are, then tell me yourself.',
    expect: { tool: 'consult', to: ['hewo-2', 'hewo-3'] },
  },
  {
    id: 'call-and-return',
    checks:
      'Asked by the user to get another agent to do a task and report the result itself (P18), the agent consults it with the task as an instruction.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: 'hewo-1',
    text: 'Get hewo-2 to say Hello World, then tell me yourself what it said.',
    expect: { tool: 'consult', to: ['hewo-2'], text: SAY_TASK },
  },
  {
    id: 'call-outside-role',
    checks: 'Asked in a call for work outside its role, the agent passes.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'hewo-2',
    to: 'hewo-1',
    call: QUESTION,
    text: 'Could you translate this paragraph into German for me?',
    expect: { tool: 'pass' },
  },
  {
    id: 'gather-three',
    checks:
      "Given the gather of three answers to the user's request, the agent replies to the user with every answer, in order.",
    handle: 'hewo-1',
    others: ['hewo-2', 'hewo-3', 'hewo-4'],
    from: 'asha',
    to: 'hewo-1',
    call: relay(
      'Have hewo-2, hewo-3 and hewo-4 each say one word back to you, and then tell me the three words in that order: amber, silver, crimson.',
      THREE,
    ),
    text: "Answers to hewo-1's call: 3 answered.",
    expect: { tool: 'reply', to: ['user'], text: inOrder(THREE) },
  },
  {
    id: 'gather-nine',
    checks:
      "Given the gather of nine answers to the user's request, the agent replies to the user with every answer, in order.",
    handle: 'hewo-1',
    others: NINE.map(([h]) => h),
    from: 'asha',
    to: 'hewo-1',
    call: relay(
      'Get each of these agents to say one word back to you, then tell me yourself the words in the order you asked: ' +
        NINE.map(([h, w]) => `${h}: ${w}`).join(', ') +
        '.',
      NINE,
    ),
    text: "Answers to hewo-1's call: 9 answered.",
    expect: { tool: 'reply', to: ['user'], text: inOrder(NINE) },
  },
];

/** Every routing case: the channel's routing cases, then the approved-result cases (approved.ts; debt-paydown R8). */
export const CASES: readonly RoutingCase[] = [...ROUTING_CASES, ...APPROVED_CASES];

export function caseMessage(c: RoutingCase): ConversationMessage {
  return {
    id: 'case',
    channel: 'main',
    conversation: 'case',
    // The conversation's user; a delegated message still carries the user who started it.
    user: 'user-1',
    from: c.from,
    to: c.to,
    kind: c.from === 'user' ? 'input' : 'internal',
    ...(c.call === undefined ? {} : { call: c.call }),
    ...(c.approved === undefined ? {} : { approved: c.approved }),
    text: c.text,
    at: '2026-09-26T00:00:00.000Z',
  };
}
