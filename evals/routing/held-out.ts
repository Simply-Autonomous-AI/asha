// The held-out routing cases (docs/plans/channel-instructions.md, R10): a
// guard on a change to the channel layer against a wording fitted to one
// case's message and roster. Run only with --held-out, so no variant is chosen
// by them (docs/plans/agent-calls.md, step 5).
//
// Shapes:
// - an agent's question, arriving as a call (its message carries `call`),
//   answered with reply, which goes to the asker (agent-question in cases.ts,
//   varied in wording, asker and roster);
// - an agent's task handed off with send_message, whose result goes to the
//   user with reply (the delegated cases), some written as questions;
// - the user asking this agent to ask or tell another agent something: a
//   hand-off, expected send_message to it (that agent answers the user);
// - the user asking this agent to find something out, or get something done,
//   and tell the user itself: expected consult (the answers come back to it),
//   at least two of them task-shaped (P18).
//
// Re-expressed 2026-09-27 by agent-calls R15 (no reply-to field; the tool is
// graded), and the hand-off and ask-for-yourself phrasings of its R14(d)
// added in the same commit — before the first commit that adds consult to the
// channel tools, so no wording of consult was chosen with them in view.

import { QUESTION, type RoutingCase } from './cases.js';

const TRANSLATOR = { recipe: 'translator', description: 'Translates text into French.' } as const;
const SCOUT = { recipe: 'scout', description: 'Looks things up on the web.' } as const;

export const HELD_OUT: readonly RoutingCase[] = [
  {
    id: 'held-question-what-can-you-do',
    checks: 'Asked what it can do by another agent, the agent answers that agent.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'hewo-2',
    to: 'hewo-1',
    call: QUESTION,
    text: 'What can you do?',
    expect: { tool: 'reply', to: ['hewo-2'] },
  },
  {
    id: 'held-question-other-asker',
    checks: 'The same question from an agent with another handle is answered to that agent.',
    handle: 'hewo-2',
    others: ['hewo-1'],
    from: 'hewo-1',
    to: 'hewo-2',
    call: QUESTION,
    text: 'What is your role?',
    expect: { tool: 'reply', to: ['hewo-1'] },
  },
  {
    id: 'held-question-kind-of-work',
    checks: 'With a larger roster, a question from an agent of another kind is answered to that agent.',
    handle: 'hewo-1',
    others: ['hewo-2', 'trans-1'],
    describe: { 'trans-1': TRANSLATOR },
    from: 'trans-1',
    to: 'hewo-1',
    call: QUESTION,
    text: 'What kind of work do you do?',
    expect: { tool: 'reply', to: ['trans-1'] },
  },
  {
    id: 'held-question-handle',
    checks: 'A question that is not about the role is answered to the agent that asked it.',
    handle: 'hewo-1',
    others: ['hewo-2', 'hewo-3'],
    from: 'hewo-3',
    to: 'hewo-1',
    call: QUESTION,
    text: 'What is your handle on this channel?',
    expect: { tool: 'reply', to: ['hewo-3'] },
  },
  {
    id: 'held-question-one-sentence',
    checks: 'With only an agent of another kind online, its question is answered to it.',
    handle: 'hewo-1',
    others: ['scout-1'],
    describe: { 'scout-1': SCOUT },
    from: 'scout-1',
    to: 'hewo-1',
    call: QUESTION,
    text: 'In one sentence, what is your role?',
    expect: { tool: 'reply', to: ['scout-1'] },
  },
  {
    id: 'held-question-translate-or-say',
    checks:
      'A question about what the agent can do, naming work outside its role, is answered to the asker, not passed.',
    handle: 'hewo-2',
    others: ['hewo-1', 'trans-1'],
    describe: { 'trans-1': TRANSLATOR },
    from: 'hewo-1',
    to: 'hewo-2',
    call: QUESTION,
    text: 'Can you translate text, or only say it?',
    expect: { tool: 'reply', to: ['hewo-1'] },
  },
  {
    id: 'held-task-good-evening',
    checks: 'Given a task by another agent, the agent says the words to the user.',
    handle: 'hewo-2',
    others: ['hewo-1'],
    from: 'hewo-1',
    to: 'hewo-2',
    text: 'Say: Good evening.',
    expect: { tool: 'reply', to: ['user'], text: /good evening/i },
  },
  {
    id: 'held-task-roster',
    checks: 'Given a task by an agent of another kind, the agent says the words to the user.',
    handle: 'hewo-1',
    others: ['hewo-2', 'trans-1'],
    describe: { 'trans-1': TRANSLATOR },
    from: 'trans-1',
    to: 'hewo-1',
    text: 'Please say: Thank you for waiting.',
    expect: { tool: 'reply', to: ['user'], text: /thank you for waiting/i },
  },
  {
    id: 'held-task-third-agent',
    checks: 'Given a task by one of two other agents, the agent does it for the user.',
    handle: 'hewo-3',
    others: ['hewo-1', 'hewo-2'],
    from: 'hewo-1',
    to: 'hewo-3',
    text: 'Please say Hello World.',
    expect: { tool: 'reply', to: ['user'], text: /hello,? world/i },
  },
  {
    id: 'held-ask-for-self',
    checks:
      'Asked by the user to check something with another agent and report back itself, the agent consults it, so the answer comes back to it.',
    handle: 'hewo-1',
    others: ['hewo-2', 'trans-1'],
    describe: { 'trans-1': TRANSLATOR },
    from: 'user',
    to: 'hewo-1',
    text: 'Check with trans-1 which languages it translates into, and then report back to me yourself.',
    expect: { tool: 'consult', to: ['trans-1'] },
  },
  {
    id: 'held-ask-for-user',
    checks:
      'Asked by the user to ask another agent something, the agent hands the question off, so that agent answers the user.',
    handle: 'hewo-1',
    others: ['hewo-2', 'trans-1'],
    describe: { 'trans-1': TRANSLATOR },
    from: 'user',
    to: 'hewo-1',
    text: 'Please ask trans-1 which languages it translates into.',
    expect: { tool: 'send_message', to: ['trans-1'] },
  },
  {
    id: 'held-delegate',
    checks:
      'Asked by the user to have another agent do something, the agent hands off the task, so that agent answers the user.',
    handle: 'hewo-1',
    others: ['hewo-2'],
    from: 'user',
    to: 'hewo-1',
    text: 'Please ask hewo-2 to say Good evening.',
    expect: { tool: 'send_message', to: ['hewo-2'], text: /^(please[,:]?\s+)?say\b.*good evening/i },
  },
  {
    id: 'held-task-question',
    checks:
      'Given a task written as a question by another agent, with the result for the user, the agent does it for the user.',
    handle: 'hewo-2',
    others: ['hewo-1'],
    from: 'hewo-1',
    to: 'hewo-2',
    text: 'Could you say Good night?',
    expect: { tool: 'reply', to: ['user'], text: /good night/i },
  },
  // Added 2026-09-27 (docs/plans/agent-calls.md R14(d)), before consult exists: more hand-offs, and asks for
  // the agent itself, varied in wording, verb, addressee and roster.
  {
    id: 'held-handoff-could-you-ask',
    checks: 'Asked by the user to ask another agent a question, in other words, the agent hands it off.',
    handle: 'hewo-1',
    others: ['hewo-2', 'trans-1'],
    describe: { 'trans-1': TRANSLATOR },
    from: 'user',
    to: 'hewo-1',
    text: 'Could you ask trans-1 whether it can translate into Spanish?',
    expect: { tool: 'send_message', to: ['trans-1'] },
  },
  {
    id: 'held-handoff-tell',
    checks: 'Told by the user to tell another agent to say something, the agent hands it the task as an instruction.',
    handle: 'hewo-1',
    others: ['hewo-2', 'hewo-3'],
    from: 'user',
    to: 'hewo-1',
    text: 'Tell hewo-3 to say Good afternoon.',
    expect: { tool: 'send_message', to: ['hewo-3'], text: /^(please[,:]?\s+)?say\b.*good afternoon/i },
  },
  {
    id: 'held-handoff-scout',
    checks: 'Asked by the user to ask an agent of another kind something, the agent hands the question off to it.',
    handle: 'hewo-1',
    others: ['scout-1'],
    describe: { 'scout-1': SCOUT },
    from: 'user',
    to: 'hewo-1',
    text: 'Ask scout-1 what the weather is like in Paris today.',
    expect: { tool: 'send_message', to: ['scout-1'] },
  },
  {
    id: 'held-self-let-me-know',
    checks: 'Asked by the user to ask another agent something and let the user know itself, the agent consults it.',
    handle: 'hewo-1',
    others: ['hewo-2', 'hewo-3'],
    from: 'user',
    to: 'hewo-1',
    text: 'Ask hewo-3 what its handle is, and let me know yourself what it says.',
    expect: { tool: 'consult', to: ['hewo-3'] },
  },
  {
    id: 'held-self-scout',
    checks:
      'Asked by the user to find out from an agent of another kind whether it can do something and report back itself, the agent consults it.',
    handle: 'hewo-1',
    others: ['hewo-2', 'scout-1'],
    describe: { 'scout-1': SCOUT },
    from: 'user',
    to: 'hewo-1',
    text: 'Find out from scout-1 whether it can look up train times, and report back to me yourself.',
    expect: { tool: 'consult', to: ['scout-1'] },
  },
  {
    id: 'held-self-task-have',
    checks:
      'Asked by the user to have another agent do a task and then say what it said (P18), the agent consults it with the task as an instruction.',
    handle: 'hewo-1',
    others: ['hewo-2', 'hewo-3'],
    from: 'user',
    to: 'hewo-1',
    text: 'Have hewo-3 say Good afternoon, and then you tell me what it said.',
    expect: { tool: 'consult', to: ['hewo-3'], text: /^(please[,:]?\s+)?say\b.*good afternoon/i },
  },
  {
    id: 'held-self-task-report',
    checks:
      'Asked by the user to get another agent to do a task and report its words back itself (P18), the agent consults it with the task.',
    handle: 'hewo-2',
    others: ['hewo-1'],
    from: 'user',
    to: 'hewo-2',
    text: 'Get hewo-1 to say Thank you, and report its words back to me yourself.',
    expect: { tool: 'consult', to: ['hewo-1'], text: /^(please[,:]?\s+)?say\b.*thank you/i },
  },
];
