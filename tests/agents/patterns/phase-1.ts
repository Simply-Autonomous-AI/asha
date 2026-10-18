// The phase-1 scenarios' checkers (docs/plans/orchestration-patterns.md
// #demos-phase-1; docs/plans/patterns-phase-1.md R3): each scenario's
// assertions, exactly as its subsection lists them, once. The agent-suite files
// call them on their recorded runs; tests/unit/pattern-proofs.test.ts runs them
// on the committed fixtures, one per listed mutation.

import { present } from '../../../src/shared/assert-present.js';

import {
  exitCode,
  fails,
  holds,
  inOneDocument,
  internals,
  line,
  logLine,
  noCall,
  noInternal,
  onePass,
  oneOutputFrom,
  outputs,
  postedLog,
  replyText,
  statuses,
  withinBound,
  type Claim,
} from './record.js';

// ---------------------------------------------------------------- P1 · Delegation

export const P01_A: readonly Claim[] = [
  {
    claim: 'exactly one internal message, lead-1 → greeter-1, an instruction to say Hello World',
    check: (r) => {
      const found = internals(r);
      if (found.length !== 1) return fails(`${String(found.length)} internal messages: ${found.map(line).join(' | ')}`);
      const i = present(found[0], 'found[0]');
      if (i.from !== 'lead-1' || i.to !== 'greeter-1') return fails(`it is ${line(i)}`);
      return /^(please[,:]?\s+)?say\b.*hello,? world/i.test(i.text)
        ? holds(line(i))
        : fails(`its text ${JSON.stringify(i.text)} is not an instruction to say Hello World`);
    },
  },
  {
    // Exactly as #demos quotes it: stdout, final newline included.
    claim: 'exactly one output, from greeter-1, stdout matching /^hello,? world\\.?\\n$/i',
    check: (r) => {
      const found = outputs(r);
      if (found.length !== 1) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      const out = present(found[0], 'found[0]');
      if (out.from !== 'greeter-1') return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      return /^hello,? world\.?\n$/i.test(r.run.stdout)
        ? holds(`${line(out)} ${JSON.stringify(r.run.stdout)}`)
        : fails(`stdout ${JSON.stringify(r.run.stdout)} does not match`);
    },
  },
  {
    claim: 'no output from lead-1',
    check: (r) =>
      outputs(r).some((o) => o.from === 'lead-1')
        ? fails('lead-1 posted an output')
        : holds(
            `outputs only from ${
              outputs(r)
                .map((o) => o.from)
                .join(', ') || 'nobody'
            }`,
          ),
  },
  noCall,
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P12 · Group chat, self-selection

export const P12_A: readonly Claim[] = [
  oneOutputFrom('translator-1', /bonjour/i),
  onePass('greeter-1'),
  noInternal,
  exitCode(0),
  withinBound,
];

export const P12_B: readonly Claim[] = [
  oneOutputFrom('greeter-1', /^hello,? world\.?$/i),
  onePass('translator-1'),
  noInternal,
  exitCode(0),
  withinBound,
];

export const P12_C: readonly Claim[] = [
  onePass('greeter-1'),
  onePass('translator-1'),
  {
    claim: 'the harness\'s output "No agent could answer this:" lists both members, and no member posts an output',
    check: (r) => {
      const found = outputs(r);
      if (found.length !== 1) return fails(`outputs from ${found.map((o) => o.from).join(', ') || 'nobody'}`);
      const out = present(found[0], 'found[0]');
      if (out.from !== 'asha') return fails(`outputs from ${found.map((o) => o.from).join(', ') || 'nobody'}`);
      const text = replyText(r);
      return text.startsWith('No agent could answer this:\n') &&
        /^- greeter-1 passed/m.test(text) &&
        /^- translator-1 passed/m.test(text)
        ? holds(`${line(out)} ${JSON.stringify(text)}`)
        : fails(`its text ${JSON.stringify(text)}`);
    },
  },
  exitCode(1),
  noInternal,
  withinBound,
];

// ---------------------------------------------------------------- P2 · Router

const DESKS = ['desk-a-1', 'desk-b-1', 'desk-c-1'] as const;

function routed(
  desk: (typeof DESKS)[number],
  request: (text: string) => boolean,
  requestSays: string,
  answer: RegExp,
): readonly Claim[] {
  const others = DESKS.filter((d) => d !== desk);
  return [
    {
      claim: `exactly one internal message, router-1 → ${desk}, ${requestSays}`,
      check: (r) => {
        const found = internals(r);
        if (found.length !== 1)
          return fails(`${String(found.length)} internal messages: ${found.map(line).join(' | ')}`);
        const i = present(found[0], 'found[0]');
        if (i.from !== 'router-1' || i.to !== desk) return fails(`it is ${line(i)}: the task went to the wrong agent`);
        return request(i.text) ? holds(line(i)) : fails(`its text ${JSON.stringify(i.text)} does not hold that`);
      },
    },
    oneOutputFrom(desk, answer),
    {
      claim: `no message of the conversation is from or to ${others.join(' or ')} (channel.posted)`,
      check: (r) => {
        const touching = postedLog(r).filter(
          (x) => others.includes(x['from'] as never) || others.includes(x['to'] as never),
        );
        return touching.length === 0
          ? holds(`${String(postedLog(r).length)} channel.posted records, none from or to ${others.join(', ')}`)
          : fails(touching.map(logLine).join(' | '));
      },
    },
    {
      claim: "the router's recipe and guidance name no other member",
      check: (r) => {
        const named = ['router.json', 'router.md']
          .filter((f) => /desk-[abc]/.test(r.team[f] ?? ''))
          .concat(['router.json', 'router.md'].filter((f) => r.team[f] === undefined).map((f) => `${f} missing`));
        return named.length === 0
          ? holds('router.json and router.md hold no "desk-a", "desk-b" or "desk-c"')
          : fails(`found in ${named.join(', ')}`);
      },
    },
    withinBound,
  ];
}

// patterns-phase-1 R3 sets what "as p02-a" means for p02-b and p02-c.
export const P02_A = routed('desk-a-1', (t) => t.includes('thank you'), 'containing "thank you"', /merci/i);
export const P02_B = routed('desk-b-1', (t) => /\b17\b/.test(t) && /\b25\b/.test(t), 'containing 17 and 25', /\b42\b/);
export const P02_C = routed(
  'desk-c-1',
  (t) => /hello,? world/i.test(t),
  'asking for Hello World',
  /^hello,? world\.?$/i,
);

// ---------------------------------------------------------------- P3 · Sequential pipeline

export const P03_A: readonly Claim[] = [
  {
    claim: 'stage-a-1 → stage-b-1 first, carrying red and neither orange nor yellow',
    check: (r) => {
      const first = internals(r)[0];
      if (first === undefined) return fails('no internal message');
      if (first.from !== 'stage-a-1' || first.to !== 'stage-b-1')
        return fails(`the first internal message is ${line(first)}`);
      return /\bred\b/i.test(first.text) && !/orange|yellow/i.test(first.text)
        ? holds(line(first))
        : fails(`its text ${JSON.stringify(first.text)}`);
    },
  },
  {
    claim: 'then stage-b-1 → stage-c-1, carrying "red, orange" and not yellow',
    check: (r) => {
      const second = internals(r)[1];
      if (second === undefined) return fails('no second internal message');
      if (second.from !== 'stage-b-1' || second.to !== 'stage-c-1')
        return fails(`the second internal message is ${line(second)}`);
      return /red, orange/i.test(second.text) && !/yellow/i.test(second.text)
        ? holds(line(second))
        : fails(`its text ${JSON.stringify(second.text)}`);
    },
  },
  {
    claim: 'then exactly one output, from stage-c-1, carrying "red, orange, yellow", after both internal messages',
    check: (r) => {
      const found = outputs(r);
      if (found.length !== 1) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      const out = present(found[0], 'found[0]');
      if (out.from !== 'stage-c-1') return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      const at = r.run.events.indexOf(out);
      const before = r.run.events.slice(0, at).filter((e) => e.type === 'internal').length;
      if (before !== 2) return fails(`${String(before)} internal messages before it`);
      return /red, orange, yellow/i.test(replyText(r))
        ? holds(`${line(out)} ${JSON.stringify(replyText(r))}`)
        : fails(`its text ${JSON.stringify(replyText(r))}`);
    },
  },
  {
    claim: 'no other internal message or output',
    check: (r) => {
      const extra = [...internals(r).slice(2), ...outputs(r).filter((o) => o.from !== 'stage-c-1')];
      return extra.length === 0
        ? holds('two internal messages and one output in all')
        : fails(extra.map(line).join(' | '));
    },
  },
  noCall,
  inOneDocument('red', 'stage-a.md'),
  inOneDocument('orange', 'stage-b.md'),
  inOneDocument('yellow', 'stage-c.md'),
  withinBound,
];

// ---------------------------------------------------------------- P22 · Escalation (the summary)

export const P22_A: readonly Claim[] = [
  {
    claim: 'exactly one output, from helper-1, starting "ESCALATE:"',
    check: (r) => {
      const found = outputs(r);
      if (found.length !== 1) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      const out = present(found[0], 'found[0]');
      if (out.from !== 'helper-1') return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      return replyText(r).startsWith('ESCALATE:')
        ? holds(`${line(out)} ${JSON.stringify(replyText(r))}`)
        : fails(`its text ${JSON.stringify(replyText(r))}`);
    },
  },
  {
    claim: 'its "done:" part holds 300',
    check: (r) => {
      const done = /done:(.*?)(;\s*left:|$)/is.exec(replyText(r))?.[1];
      return done !== undefined && /\b300\b/.test(done)
        ? holds(`done:${done}`)
        : fails(`done part: ${JSON.stringify(done ?? null)}`);
    },
  },
  {
    claim: 'its "left:" part names the meeting room',
    check: (r) => {
      const left = /left:(.*)$/is.exec(replyText(r))?.[1];
      return left !== undefined && /meeting room/i.test(left)
        ? holds(`left:${left.trimEnd()}`)
        : fails(`left part: ${JSON.stringify(left ?? null)}`);
    },
  },
  {
    claim: 'helper-1 posts nothing in the conversation after it',
    check: (r) => {
      const posts = postedLog(r).filter((x) => x['from'] === 'helper-1');
      // After its first output, the escalation: nothing more from helper-1 in the conversation.
      const escalation = posts.map((x) => x['kind']).indexOf('output');
      if (escalation === -1) return fails('no output from helper-1 in the daemon log');
      const after = posts.slice(escalation + 1);
      const at = r.run.events.findIndex((e) => e.type === 'output' && e.from === 'helper-1');
      const laterStatus = at === -1 ? [] : statuses(r, 'helper-1').filter((e) => r.run.events.indexOf(e) > at);
      return after.length === 0 && laterStatus.length === 0
        ? holds(`its output is helper-1's last channel.posted record (${String(posts.length)} in all)`)
        : fails([...after.map(logLine), ...laterStatus.map(line)].join(' | '));
    },
  },
  exitCode(0),
  withinBound,
];

/** Every phase-1 scenario's checker, by id. */
export const PHASE_1: Readonly<Record<string, readonly Claim[]>> = {
  'p01-a': P01_A,
  'p02-a': P02_A,
  'p02-b': P02_B,
  'p02-c': P02_C,
  'p03-a': P03_A,
  'p12-a': P12_A,
  'p12-b': P12_B,
  'p12-c': P12_C,
  'p22-a': P22_A,
};
