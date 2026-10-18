// The phase-2 scenarios' checkers (docs/plans/orchestration-patterns.md
// #demos-phase-2; docs/plans/patterns-phase-2.md R3): each scenario's
// assertions, exactly as its subsection lists them (as amended there), once.
// The agent-suite files call them on their recorded runs;
// tests/unit/pattern-proofs.test.ts runs them on the committed fixtures, one
// per listed mutation and one breaking every other claim. Every phase-2 demo
// is built on calls (docs/plans/agent-calls.md): a call's questions, answers
// and gather are read with callsOf (record.ts), which pairs the transcript's
// text with the daemon log's call id and role.

import { present } from '../../../src/shared/assert-present.js';
import { byCodeUnit } from '../../../src/shared/order.js';

import {
  callLine,
  callsOf,
  containsText,
  errorRecords,
  exitCode,
  fails,
  holds,
  inOneDocument,
  internalMessages,
  line,
  logLine,
  logged,
  outputs,
  outsideCalls,
  replyText,
  squash,
  theOutput,
  withinBound,
  withoutStepNumbers,
  type CallMessage,
  type CallRecord,
  type Claim,
  type LogRecord,
  type ScenarioRecord,
  type Verdict,
} from './record.js';

// ---------------------------------------------------------------- shared claims

const quote = (text: string): string => JSON.stringify(text);
const lastLine = (text: string): string => present(text.trim().split('\n').at(-1), 'line').trim();

/**
 * The conversation's calls, or why they cannot be read.
 * @returns the calls, or a string naming why they cannot be read.
 */
function calls(r: ScenarioRecord): CallRecord[] | string {
  try {
    return callsOf(r);
  } catch (error) {
    return (error as Error).message;
  }
}

/** Runs `check` on the calls when there are exactly `n`, else fails naming how many there were. */
function withCalls(r: ScenarioRecord, n: number, check: (cs: readonly CallRecord[]) => Verdict): Verdict {
  const cs = calls(r);
  if (typeof cs === 'string') return fails(cs);
  if (cs.length !== n)
    return fails(`${String(cs.length)} calls, not ${String(n)}: ${cs.map(callLine).join(' | ') || 'none'}`);
  return check(cs);
}

/** A call's one question to `to`, or why there is not exactly one. */
function questionTo(c: CallRecord, to: string): CallMessage | string {
  const found = c.questions.filter((q) => q.to === to);
  return found.length === 1
    ? present(found[0], 'found[0]')
    : `${String(found.length)} questions to ${to} on ${callLine(c)}`;
}

/** A call's one answer from `from`, or why there is not exactly one. */
function answerFrom(c: CallRecord, from: string): CallMessage | string {
  const found = c.answers.filter((a) => a.from === from);
  return found.length === 1
    ? present(found[0], 'found[0]')
    : `${String(found.length)} answers from ${from} on ${callLine(c)}`;
}

/** Every call is `caller` → exactly `addressees` (as a set), one question each. */
const everyCallTo =
  (caller: string, addressees: readonly string[]) =>
  (c: CallRecord): string | null => {
    if (c.caller !== caller) return `${callLine(c)}: the caller is not ${caller}`;
    if ([...c.addressees].sort(byCodeUnit).join() !== [...addressees].sort(byCodeUnit).join())
      return `${callLine(c)}: not exactly ${addressees.join(', ')}`;
    if (c.questions.length !== addressees.length || c.questions.some((q) => q.from !== caller))
      return `${callLine(c)}: ${String(c.questions.length)} questions`;
    return null;
  };

/**
 * The one output, from `from`, after the last call's gather; its text is `replyText`.
 * @returns the output's text and evidence, or a string naming why there is not one yet.
 */
function outputAfterLastGather(
  r: ScenarioRecord,
  from: string,
  cs: readonly CallRecord[],
): { readonly text: string; readonly evidence: string } | string {
  const found = theOutput(r);
  if (typeof found === 'string') return found;
  if (found.output.from !== from) return `the output is from ${found.output.from}`;
  const gather = cs.at(-1)?.gather;
  if (gather === null || gather === undefined) return 'the last call was never gathered';
  if (found.index < gather.index)
    return `the output is at transcript line ${String(found.index + 1)}, before the last gather at ${String(gather.index + 1)}`;
  return { text: replyText(r), evidence: `${line(found.output)} ${quote(replyText(r))}` };
}

/** No output from any of `handles`; `claim` names them. */
const noOutputFrom = (handles: readonly string[], claim: string): Claim => ({
  claim,
  check: (r) => {
    const found = outputs(r).filter((o) => handles.includes(o.from));
    return found.length === 0
      ? holds(
          `outputs from ${
            outputs(r)
              .map((o) => o.from)
              .join(', ') || 'nobody'
          } only`,
        )
      : fails(found.map(line).join(' | '));
  },
});

/** Every internal message is a call's question, answer or gather (no send_message). */
const noInternalOutsideCalls: Claim = {
  claim: 'no internal message outside a call',
  check: (r) => {
    let found: CallMessage[];
    try {
      found = outsideCalls(r);
    } catch (error) {
      return fails((error as Error).message);
    }
    return found.length === 0
      ? holds(`every internal message carries a call (${String(internalMessages(r).length)} of them)`)
      : fails(found.map((m) => `${m.from} → ${m.to ?? 'all agents'}: ${quote(m.text)}`).join(' | '));
  },
};

/** Each of the members' `<name>.md` differs from every other's (orchestration-patterns R2). */
const guidanceDiffers = (members: readonly string[], who: string): Claim => ({
  claim: `each ${who}'s guidance differs from every other's (its recipe's document)`,
  check: (r) => {
    const docName = (m: string): string => `${m}.md`;
    const docs = members.map((m) => [m, r.team[docName(m)]] as const);
    const missing = docs.filter(([, d]) => d === undefined).map(([m]) => docName(m));
    if (missing.length > 0) return fails(`no ${missing.join(', ')} in the team folder`);
    const same = docs.flatMap(([a, da], i) =>
      docs
        .slice(i + 1)
        .filter(([b, db]) => squash(present(db, `team[${docName(b)}]`)) === squash(present(da, `team[${docName(a)}]`)))
        .map(([b]) => `${docName(a)} = ${docName(b)}`),
    );
    return same.length === 0
      ? holds(`${members.map(docName).join(', ')}: pairwise different`)
      : fails(`identical: ${same.join(', ')}`);
  },
});

/** The question's part after `marker` (a draft after "Draft:", a text after "Check:"), trimmed; the whole text without it. */
function after(marker: string, text: string): string {
  const at = text.indexOf(marker);
  return (at < 0 ? text : text.slice(at + marker.length)).trim();
}

// ---------------------------------------------------------------- P18 · Agent as tool

const DELEGATOR = 'delegator-1';
const WORKER = 'worker-1';

export const P18_A: readonly Claim[] = [
  {
    claim: 'exactly one call, delegator-1 → worker-1 (channel.call_opened)',
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const call = present(c, 'c');
        const problem = everyCallTo(DELEGATOR, [WORKER])(call);
        return problem === null
          ? holds(`${callLine(call)}: ${quote(present(call.questions[0], 'questions[0]').text)}`)
          : fails(problem);
      }),
  },
  {
    claim: "worker-1's answer, on the call, to delegator-1, matches /hello,? world/i",
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const a = answerFrom(present(c, 'c'), WORKER);
        if (typeof a === 'string') return fails(a);
        return a.to === DELEGATOR && /hello,? world/i.test(a.text)
          ? holds(`${a.from} → ${a.to}: ${quote(a.text)}`)
          : fails(`${a.from} → ${String(a.to)}: ${quote(a.text)}`);
      }),
  },
  {
    claim: 'exactly one gather, to delegator-1, of one answer (channel.call_gathered)',
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const call = present(c, 'c');
        const gatherLine = call.gather === null ? 'none' : `to ${String(call.gather.to)}`;
        return call.gather?.to === DELEGATOR &&
          call.counts?.['answered'] === 1 &&
          Object.entries(call.counts).every(([k, v]) => k === 'answered' || v === 0)
          ? holds(`${quote(call.gather.text)}; counts ${JSON.stringify(call.counts)}`)
          : fails(`gather ${gatherLine}; counts ${JSON.stringify(call.counts)}`);
      }),
  },
  {
    claim: 'exactly one output, from delegator-1, after the gather, matching /^worker-1 said: hello,? world/i',
    check: (r) =>
      withCalls(r, 1, (cs) => {
        const out = outputAfterLastGather(r, DELEGATOR, cs);
        if (typeof out === 'string') return fails(out);
        return /^worker-1 said: hello,? world/i.test(out.text)
          ? holds(out.evidence)
          : fails(`its text ${quote(out.text)}`);
      }),
  },
  noOutputFrom([WORKER], 'no output from worker-1 (a hand-off would make it answer the user)'),
  noInternalOutsideCalls,
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P5 · Orchestrator–workers

const LEAD = 'lead-1';
const WORKERS = ['worker-a-1', 'worker-b-1', 'worker-c-1'];

/** worker's question contains every `must` and none of `mustNot` (case-insensitive words as the plan gives them). */
const part = (worker: string, must: readonly RegExp[], mustNot: readonly RegExp[], says: string): Claim => ({
  claim: `${worker}'s question ${says}`,
  check: (r) =>
    withCalls(r, 1, ([c]) => {
      const q = questionTo(present(c, 'c'), worker);
      if (typeof q === 'string') return fails(q);
      const missing = must.filter((p) => !p.test(q.text));
      const extra = mustNot.filter((p) => p.test(q.text));
      const lacking = (p: RegExp): string => `lacks ${String(p)}`;
      const holding = (p: RegExp): string => `holds ${String(p)}`;
      return missing.length === 0 && extra.length === 0
        ? holds(`${q.from} → ${String(q.to)}: ${quote(q.text)}`)
        : fails(`${quote(q.text)}: ${[...missing.map(lacking), ...extra.map(holding)].join(', ')}`);
    }),
});

export const P05_A: readonly Claim[] = [
  {
    claim: 'one call, lead-1 → exactly worker-a-1, worker-b-1 and worker-c-1, one question each',
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const call = present(c, 'c');
        const problem = everyCallTo(LEAD, WORKERS)(call);
        const questionLine = (q: CallMessage): string => `${String(q.to)}: ${quote(q.text)}`;
        return problem === null
          ? holds(`${callLine(call)}; ${call.questions.map(questionLine).join('; ')}`)
          : fails(problem);
      }),
  },
  part('worker-a-1', [/thank you/i], [/\b17\b/, /hello/i], 'contains "thank you" and neither 17 nor hello'),
  part('worker-b-1', [/\b17\b/, /\b25\b/], [/thank/i, /hello/i], 'contains 17 and 25 and neither thank nor hello'),
  part(
    'worker-c-1',
    [/hello,? world/i],
    [/thank/i, /\b17\b/],
    'matches /hello,? world/i and contains neither thank nor 17',
  ),
  {
    claim: 'three answered, and one gather to lead-1 (channel.call_gathered)',
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const call = present(c, 'c');
        const answerLine = (a: CallMessage): string => `${a.from}: ${quote(a.text)}`;
        const gatherLine = call.gather === null ? 'none' : `to ${String(call.gather.to)}`;
        return call.answers.length === 3 && call.gather?.to === LEAD && call.counts?.['answered'] === 3
          ? holds(`${call.answers.map(answerLine).join('; ')}; ${quote(call.gather.text)}`)
          : fails(
              `${String(call.answers.length)} answers; gather ${gatherLine}; counts ${JSON.stringify(call.counts)}`,
            );
      }),
  },
  {
    claim:
      'exactly one output, from lead-1, after the gather, whose lines match /merci/i, contain 42, and match /hello,? world/i, in that order',
    check: (r) =>
      withCalls(r, 1, (cs) => {
        const out = outputAfterLastGather(r, LEAD, cs);
        if (typeof out === 'string') return fails(out);
        const lines = out.text.split('\n');
        const merci = lines.findIndex((l) => /merci/i.test(l));
        const sum = lines.findIndex((l, i) => i > merci && /\b42\b/.test(l));
        const hello = lines.findIndex((l, i) => i > sum && /hello,? world/i.test(l));
        return merci >= 0 && sum > merci && hello > sum ? holds(out.evidence) : fails(`its lines ${quote(out.text)}`);
      }),
  },
  noOutputFrom(WORKERS, 'no worker posts an output'),
  {
    claim: "the lead's recipe and guidance name no worker (it chooses from the descriptions list_agents gives)",
    check: (r) => {
      const found = ['lead.json', 'lead.md'].filter((f) => /\bworker-[abc]\b/.test(r.team[f] ?? ''));
      return found.length === 0
        ? holds('lead.json and lead.md hold no worker-a, worker-b or worker-c')
        : fails(`named in ${found.join(', ')}`);
    },
  },
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P10 · Voting

const AGGREGATOR = 'aggregator-1';
const VOTERS = ['voter-cautious-1', 'voter-bold-1', 'voter-thrifty-1'];
const CHOICES = ['SOUP', 'SALAD', 'PIZZA'] as const;

/** A voter's vote: the choice on its answer's last line, or null. */
const voteOf = (text: string): string | null => /^VOTE: (SOUP|SALAD|PIZZA)$/.exec(lastLine(text))?.[1] ?? null;

export const P10_A: readonly Claim[] = [
  {
    claim: 'one call, aggregator-1 → exactly the three voters',
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const call = present(c, 'c');
        const problem = everyCallTo(AGGREGATOR, VOTERS)(call);
        return problem === null ? holds(callLine(call)) : fails(problem);
      }),
  },
  {
    claim: "no voter's question holds another voter's answer",
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const call = present(c, 'c');
        const leaks = call.questions.flatMap((q) =>
          call.answers
            .filter((a) => a.from !== q.to && containsText(q.text, a.text))
            .map((a) => `${String(q.to)}'s question holds ${a.from}'s answer`),
        );
        const questionLine = (q: CallMessage): string => `${String(q.to)}: ${quote(q.text)}`;
        return leaks.length === 0 ? holds(call.questions.map(questionLine).join('; ')) : fails(leaks.join('; '));
      }),
  },
  {
    claim:
      'every answer, posted to aggregator-1 on the call, ends with the line "VOTE: SOUP", "VOTE: SALAD" or "VOTE: PIZZA"',
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const call = present(c, 'c');
        const bad = call.answers.filter((a) => voteOf(a.text) === null || a.to !== AGGREGATOR);
        if (call.answers.length !== 3) return fails(`${String(call.answers.length)} answers`);
        return bad.length === 0
          ? holds(call.answers.map((a) => `${a.from}: ${String(voteOf(a.text))}`).join('; '))
          : fails(bad.map((a) => `${a.from}: ${quote(a.text)}`).join('; '));
      }),
  },
  {
    claim:
      'each answer is delivered to no agent: each voter had one delivery (its question), aggregator-1 two (the input and the gather) (asha.delivery spans)',
    check: (r) => {
      const count = (h: string) => r.deliveries.filter((d) => d === h).length;
      const shown = [AGGREGATOR, ...VOTERS].map((h) => `${h} ${String(count(h))}`).join(', ');
      const others = r.deliveries.filter((d) => d !== AGGREGATOR && !VOTERS.includes(d));
      const othersLine = others.length > 0 ? `, and ${others.join(', ')}` : '';
      return count(AGGREGATOR) === 2 && VOTERS.every((v) => count(v) === 1) && others.length === 0
        ? holds(`deliveries: ${shown}`)
        : fails(`deliveries: ${shown}${othersLine}`);
    },
  },
  {
    claim:
      "exactly one output, from aggregator-1, after the gather, whose majority and tally equal those of the gather's votes",
    check: (r) =>
      withCalls(r, 1, (cs) => {
        const out = outputAfterLastGather(r, AGGREGATOR, cs);
        if (typeof out === 'string') return fails(out);
        const votes = present(cs[0], 'cs[0]').answers.map((a) => voteOf(a.text));
        const tally = CHOICES.map((choice) => votes.filter((v) => v === choice).length);
        const top = Math.max(...tally);
        const winner = top >= 2 ? present(CHOICES[tally.indexOf(top)], 'CHOICES[tally.indexOf(top)]') : null;
        const tallyText = `Tally: SOUP ${String(tally[0])}, SALAD ${String(tally[1])}, PIZZA ${String(tally[2])}.`;
        const expected =
          winner === null ? `No majority. ${tallyText}` : `Majority: ${winner} (${String(top)} of 3). ${tallyText}`;
        return squash(out.text) === expected
          ? holds(`${out.evidence}; from the gather: ${expected}`)
          : fails(`its text ${quote(out.text)}; the gather's votes give ${quote(expected)}`);
      }),
  },
  guidanceDiffers(['voter-cautious', 'voter-bold', 'voter-thrifty'], 'voter'),
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P9 · Debate with a judge

const JUDGE = 'judge-1';
const OPTIMIST = 'optimist-1';
const SCEPTIC = 'sceptic-1';

/** The stance a debater's own document assigns it. */
const assignedStance = (r: ScenarioRecord, handle: string): string | null =>
  /Your stance is (FOR|AGAINST)\b/.exec(r.team[`${handle.replace(/-\d+$/, '')}.md`] ?? '')?.[1] ?? null;

export const P09_A: readonly Claim[] = [
  {
    claim: 'two calls, each judge-1 → exactly optimist-1 and sceptic-1 (R = 2)',
    check: (r) =>
      withCalls(r, 2, (cs) => {
        const problems = cs.map(everyCallTo(JUDGE, [OPTIMIST, SCEPTIC])).filter((p) => p !== null);
        return problems.length === 0 ? holds(cs.map(callLine).join(' | ')) : fails(problems.join('; '));
      }),
  },
  {
    // orchestration-patterns p09-a: "at most 200 characters, ending with the stance its sender's document assigns".
    claim: 'every answer is at most 200 characters and ends with "STANCE: <the stance its sender\'s guidance assigns>"',
    check: (r) =>
      withCalls(r, 2, (cs) => {
        const answers = cs.flatMap((c) => c.answers);
        const bad = answers.filter((a) => {
          const stance = assignedStance(r, a.from);
          return (
            stance === null || a.text.trim().length > 200 || !new RegExp(`STANCE: ${stance}\\.?$`).test(a.text.trim())
          );
        });
        if (answers.length !== 4) return fails(`${String(answers.length)} answers, not 4`);
        return bad.length === 0
          ? holds(
              answers.map((a) => `${a.from} (${String(a.text.trim().length)} chars): ${lastLine(a.text)}`).join('; '),
            )
          : fails(
              bad
                .map(
                  (a) =>
                    `${a.from} (assigned ${assignedStance(r, a.from) ?? 'none'}, ${String(a.text.trim().length)} chars): ${quote(a.text)}`,
                )
                .join('; '),
            );
      }),
  },
  {
    claim: "each round-2 question contains both round-1 answers' texts, as the first gather holds them",
    check: (r) =>
      withCalls(r, 2, ([first, second]) => {
        const firstCall = present(first, 'first');
        const secondCall = present(second, 'second');
        const lacking = (q: CallMessage, a: CallMessage): string =>
          `${String(q.to)}'s question lacks ${a.from}'s ${quote(a.text)}`;
        const missing = secondCall.questions.flatMap((q) =>
          firstCall.answers.filter((a) => !containsText(q.text, a.text)).map((a) => lacking(q, a)),
        );
        const questionLine = (q: CallMessage): string => `${String(q.to)}: ${quote(q.text)}`;
        if (firstCall.answers.length !== 2) return fails(`${String(firstCall.answers.length)} round-1 answers`);
        return missing.length === 0
          ? holds(secondCall.questions.map(questionLine).join('; '))
          : fails(missing.join('; '));
      }),
  },
  {
    claim:
      'exactly one output, from judge-1, after the second gather, starting "Verdict: FOR" or "Verdict: AGAINST" and naming optimist-1 and sceptic-1',
    check: (r) =>
      withCalls(r, 2, (cs) => {
        const out = outputAfterLastGather(r, JUDGE, cs);
        if (typeof out === 'string') return fails(out);
        return /^Verdict: (FOR|AGAINST)\b/.test(out.text) && out.text.includes(OPTIMIST) && out.text.includes(SCEPTIC)
          ? holds(out.evidence)
          : fails(`its text ${quote(out.text)}`);
      }),
  },
  guidanceDiffers(['optimist', 'sceptic'], 'debater'),
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P23 · Iterative consensus debate

const MODERATOR = 'moderator-1';
const DEBATERS = ['debater-a-1', 'debater-b-1', 'debater-c-1'];

/** A debater's token: the number its answer ends with, "ANSWER: <6, 7 or 8>" (orchestration-patterns p23-a: "ending `ANSWER: <token>`"), or null. */
const tokenOf = (text: string): string | null => /ANSWER: ([678])\.?$/.exec(text.trim())?.[1] ?? null;
const allEqual = (c: CallRecord): boolean => new Set(c.answers.map((a) => tokenOf(a.text))).size === 1;
const tokens = (c: CallRecord): string => c.answers.map((a) => `${a.from} ${tokenOf(a.text) ?? '?'}`).join(', ');

/**
 * Every call and its answers read, or why not.
 * @returns the calls, or a string naming why they cannot be read.
 */
function rounds(r: ScenarioRecord): CallRecord[] | string {
  const cs = calls(r);
  if (typeof cs === 'string') return cs;
  return cs.length === 0 ? 'no call' : cs;
}

export const P23_A: readonly Claim[] = [
  {
    claim: 'every call is moderator-1 → exactly debater-a-1, debater-b-1 and debater-c-1',
    check: (r) => {
      const cs = rounds(r);
      if (typeof cs === 'string') return fails(cs);
      const problems = cs.map(everyCallTo(MODERATOR, DEBATERS)).filter((p) => p !== null);
      return problems.length === 0 ? holds(cs.map(callLine).join(' | ')) : fails(problems.join('; '));
    },
  },
  {
    claim: 'every answer is at most 200 characters and ends with "ANSWER: <6, 7 or 8>"',
    check: (r) => {
      const cs = rounds(r);
      if (typeof cs === 'string') return fails(cs);
      const answers = cs.flatMap((c) => c.answers);
      const bad = answers.filter((a) => a.text.trim().length > 200 || tokenOf(a.text) === null);
      if (answers.length !== cs.length * 3)
        return fails(`${String(answers.length)} answers over ${String(cs.length)} rounds`);
      return bad.length === 0
        ? holds(cs.map((c, i) => `round ${String(i + 1)}: ${tokens(c)}`).join('; '))
        : fails(bad.map((a) => `${a.from} (${String(a.text.trim().length)} chars): ${quote(a.text)}`).join('; '));
    },
  },
  {
    claim: "round 1's tokens are not all equal (else the scenario proves nothing)",
    check: (r) => {
      const cs = rounds(r);
      if (typeof cs === 'string') return fails(cs);
      const first = present(cs[0], 'cs[0]');
      return allEqual(first) ? fails(`round 1: ${tokens(first)}`) : holds(`round 1: ${tokens(first)}`);
    },
  },
  {
    claim:
      "every later round's question contains each debater's previous answer, token line included, as the previous gather holds it",
    check: (r) => {
      const cs = rounds(r);
      if (typeof cs === 'string') return fails(cs);
      const lacking = (round: number, q: CallMessage, a: CallMessage): string =>
        `round ${String(round)}: ${String(q.to)}'s question lacks ${a.from}'s ${quote(a.text)}`;
      const missing = cs.slice(1).flatMap((c, i) =>
        c.questions.flatMap((q) =>
          present(cs[i], `cs[${String(i)}]`)
            .answers.filter((a) => !containsText(q.text, a.text))
            .map((a) => lacking(i + 2, q, a)),
        ),
      );
      if (cs.length === 1) return holds('one round only: no later question');
      return missing.length === 0
        ? holds(`rounds 2–${String(cs.length)}: every question holds every previous answer`)
        : fails(missing.join('; '));
    },
  },
  {
    claim: 'the rounds stop at the first gather whose tokens are all equal, or after round 3 (R = 3)',
    check: (r) => {
      const cs = rounds(r);
      if (typeof cs === 'string') return fails(cs);
      const early = cs.slice(0, -1).findIndex(allEqual);
      if (early >= 0) {
        const agreed = present(cs[early], `cs[${String(early)}]`);
        return fails(`round ${String(early + 1)} agreed (${tokens(agreed)}), and round ${String(early + 2)} followed`);
      }
      if (cs.length > 3) return fails(`${String(cs.length)} rounds`);
      const last = present(cs.at(-1), 'cs.at(-1)');
      if (!allEqual(last) && cs.length < 3)
        return fails(`stopped after round ${String(cs.length)} without agreement (${tokens(last)})`);
      return holds(`${String(cs.length)} rounds; last: ${tokens(last)}`);
    },
  },
  {
    claim:
      'exactly one output, from moderator-1, after the last gather, stating the agreed token and its round, or "No consensus" with the last round\'s tally, as the gathers give them',
    check: (r) => {
      const cs = rounds(r);
      if (typeof cs === 'string') return fails(cs);
      const out = outputAfterLastGather(r, MODERATOR, cs);
      if (typeof out === 'string') return fails(out);
      const last = present(cs.at(-1), 'cs.at(-1)');
      const count = (t: string) => last.answers.filter((a) => tokenOf(a.text) === t).length;
      const expected = allEqual(last)
        ? `Consensus: ${String(tokenOf(present(last.answers[0], 'answers[0]').text))}, reached in round ${String(cs.length)}.`
        : `No consensus. Last round: 6: ${String(count('6'))}, 7: ${String(count('7'))}, 8: ${String(count('8'))}.`;
      return squash(out.text) === expected
        ? holds(`${out.evidence}; from the gathers: ${expected}`)
        : fails(`its text ${quote(out.text)}; the gathers give ${quote(expected)}`);
    },
  },
  guidanceDiffers(['debater-a', 'debater-b', 'debater-c'], 'debater'),
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P24 · Managed group chat

const MANAGER = 'manager-1';
const PARTICIPANTS = ['alpha-1', 'beta-1', 'gamma-1'];

/** Three calls, each manager-1 → one participant, in `order`. */
const speakersInOrder = (order: readonly string[], why: string): Claim => ({
  claim: `three calls, each manager-1 → one participant, in the order ${order.join(', ')}${why}`,
  check: (r) =>
    withCalls(r, 3, (cs) => {
      const problems = cs
        .map((c, i) => everyCallTo(MANAGER, [present(order[i], `order[${String(i)}]`)])(c))
        .filter((p) => p !== null);
      return problems.length === 0 ? holds(cs.map(callLine).join(' | ')) : fails(problems.join('; '));
    }),
});

/** No participant posts an internal message but its call answer. */
const onlyCallAnswers: Claim = {
  claim: 'no participant posts an internal message other than its call answer',
  check: (r) => {
    let messages: CallMessage[];
    try {
      messages = internalMessages(r);
    } catch (error) {
      return fails((error as Error).message);
    }
    const found = messages.filter((m) => PARTICIPANTS.includes(m.from) && m.role !== 'answer');
    return found.length === 0
      ? holds(
          `participants' internal messages: ${String(messages.filter((m) => PARTICIPANTS.includes(m.from)).length)}, each a call answer`,
        )
      : fails(found.map((m) => `${m.from} → ${m.to ?? 'all agents'}: ${quote(m.text)}`).join(' | '));
  },
};

export const P24_A: readonly Claim[] = [
  speakersInOrder(PARTICIPANTS, " (team.json's order: round robin, T = 3)"),
  {
    claim: "call k's question contains every earlier call's answer text, in order",
    check: (r) =>
      withCalls(r, 3, (cs) => {
        const problems: string[] = [];
        cs.forEach((c, k) => {
          const q = squash(c.questions[0]?.text ?? '');
          let from = 0;
          for (const earlier of cs.slice(0, k)) {
            const a = squash(earlier.answers[0]?.text ?? '');
            const at = a === '' ? -1 : q.indexOf(a, from);
            if (at < 0)
              problems.push(
                `call ${String(k + 1)}'s question lacks call ${String(cs.indexOf(earlier) + 1)}'s answer ${quote(a)} after position ${String(from)}`,
              );
            else from = at + a.length;
          }
        });
        return problems.length === 0
          ? holds(cs.map((c, k) => `call ${String(k + 1)}: ${quote(c.questions[0]?.text ?? '')}`).join('; '))
          : fails(problems.join('; '));
      }),
  },
  onlyCallAnswers,
  {
    claim: "exactly one output, from manager-1, after the last gather, holding the three answers' texts in order",
    check: (r) =>
      withCalls(r, 3, (cs) => {
        const out = outputAfterLastGather(r, MANAGER, cs);
        if (typeof out === 'string') return fails(out);
        const text = squash(out.text);
        let from = 0;
        for (const c of cs) {
          const a = squash(c.answers[0]?.text ?? '');
          const at = a === '' ? -1 : text.indexOf(a, from);
          if (at < 0) return fails(`its text ${quote(out.text)} lacks ${quote(a)} in order`);
          from = at + a.length;
        }
        return holds(out.evidence);
      }),
  },
  exitCode(0),
  withinBound,
];

/** The digits an answer or a question holds, in order — a handle's own digit aside ("5. Next: alpha-1." holds 5). */
const digitsOf = (text: string): string => [...text.matchAll(/(?<!-)\d/g)].map((m) => m[0]).join('');

export const P24_B: readonly Claim[] = [
  speakersInOrder(
    ['beta-1', 'alpha-1', 'gamma-1'],
    " (the keepers of the first, second and third digit; not team.json's order)",
  ),
  {
    claim: 'each question contains the digits so far, in order',
    check: (r) =>
      withCalls(r, 3, (cs) => {
        const problems: string[] = [];
        cs.forEach((c, k) => {
          const so = cs
            .slice(0, k)
            .map((e) => digitsOf(e.answers[0]?.text ?? ''))
            .join('');
          const q = c.questions[0]?.text ?? '';
          if (so !== '' && digitsOf(q) !== so)
            problems.push(
              `call ${String(k + 1)}'s question ${quote(q)} holds the digits "${digitsOf(q)}", not "${so}"`,
            );
        });
        return problems.length === 0
          ? holds(cs.map((c, k) => `call ${String(k + 1)}: ${quote(c.questions[0]?.text ?? '')}`).join('; '))
          : fails(problems.join('; '));
      }),
  },
  {
    // Every file of the team folder (patterns-phase-2 R3), step numbers aside; a digit with no digit, letter or hyphen
    // beside it. Each digit may be only in its own keeper's guidance.
    claim:
      "each digit of the code is in its keeper's guidance only — in no other file of the team, the manager's included — step numbers aside",
    check: (r) => {
      const keepers: Readonly<Record<string, string>> = { '2': 'alpha.md', '5': 'beta.md', '8': 'gamma.md' };
      const wrong: string[] = [];
      for (const [digit, own] of Object.entries(keepers)) {
        const pattern = new RegExp(`(?<![\\w-])${digit}(?![\\w-])`);
        const found = Object.keys(r.team).filter((f) =>
          pattern.test(withoutStepNumbers(present(r.team[f], `team[${f}]`))),
        );
        if (found.length !== 1 || found[0] !== own) wrong.push(`${digit} in ${found.join(', ') || 'no file'}`);
      }
      return wrong.length === 0
        ? holds("2 only in alpha.md, 5 only in beta.md, 8 only in gamma.md; none in the manager's files")
        : fails(wrong.join('; '));
    },
  },
  onlyCallAnswers,
  {
    claim: 'exactly one output, from manager-1, after the last gather, containing 528',
    check: (r) =>
      withCalls(r, 3, (cs) => {
        const out = outputAfterLastGather(r, MANAGER, cs);
        if (typeof out === 'string') return fails(out);
        return /528/.test(out.text) ? holds(out.evidence) : fails(`its text ${quote(out.text)}`);
      }),
  },
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P8 · Generator–critic loop

const WRITER = 'writer-1';
const draftOf = (q: CallMessage | undefined): string => after('Draft:', q?.text ?? '');

/** Every call is writer-1 → `critic` alone. */
const allTo = (critic: string, cs: readonly CallRecord[]): string | null =>
  cs.map(everyCallTo(WRITER, [critic])).find((p) => p !== null) ?? null;

export const P08_A: readonly Claim[] = [
  {
    claim: 'call 1\'s draft does not contain "green" (else the scenario proves nothing)',
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length === 0) return fails(typeof cs === 'string' ? cs : 'no call');
      const d = draftOf(present(cs[0], 'cs[0]').questions[0]);
      return /green/i.test(d) ? fails(`call 1's draft ${quote(d)}`) : holds(`call 1's draft ${quote(d)}`);
    },
  },
  {
    claim: 'call 1\'s answer starts "Round 1: REVISE"',
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length === 0) return fails(typeof cs === 'string' ? cs : 'no call');
      const a = present(cs[0], 'cs[0]').answers[0];
      return a !== undefined && a.text.trim().startsWith('Round 1: REVISE')
        ? holds(`${a.from}: ${quote(a.text)}`)
        : fails(`call 1's answer ${quote(a?.text ?? '')}`);
    },
  },
  {
    claim: 'call 2\'s draft differs from call 1\'s and contains "green" and "lighthouse"',
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length < 2)
        return fails(typeof cs === 'string' ? cs : `${String(cs.length)} calls`);
      const [d1, d2] = [draftOf(present(cs[0], 'cs[0]').questions[0]), draftOf(present(cs[1], 'cs[1]').questions[0])];
      return d2 !== d1 && /green/i.test(d2) && /lighthouse/i.test(d2)
        ? holds(`call 2's draft ${quote(d2)}`)
        : fails(`call 1's draft ${quote(d1)}, call 2's ${quote(d2)}`);
    },
  },
  {
    claim: 'call 2\'s answer is "Round 2: ACCEPT"',
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length < 2)
        return fails(typeof cs === 'string' ? cs : `${String(cs.length)} calls`);
      const a = present(cs[1], 'cs[1]').answers[0];
      return a !== undefined && /^Round 2: ACCEPT\.?$/.test(a.text.trim())
        ? holds(`${a.from}: ${quote(a.text)}`)
        : fails(`call 2's answer ${quote(a?.text ?? '')}`);
    },
  },
  {
    claim: 'exactly two calls, each writer-1 → critic-1 alone (stopped early, under K = 3)',
    check: (r) =>
      withCalls(r, 2, (cs) => {
        const problem = allTo('critic-1', cs);
        return problem === null ? holds(cs.map(callLine).join(' | ')) : fails(problem);
      }),
  },
  {
    claim: 'exactly one output, from writer-1, after the last gather, equal to the accepted draft (trimmed)',
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length === 0) return fails(typeof cs === 'string' ? cs : 'no call');
      const out = outputAfterLastGather(r, WRITER, cs);
      if (typeof out === 'string') return fails(out);
      const accepted = cs.find((c) => /ACCEPT/.test(c.answers[0]?.text ?? ''));
      if (accepted === undefined) return fails('no draft was accepted');
      const d = draftOf(accepted.questions[0]);
      return out.text.trim() === d
        ? holds(`${out.evidence} = the accepted draft`)
        : fails(`its text ${quote(out.text)}, the accepted draft ${quote(d)}`);
    },
  },
  inOneDocument('green', 'critic.md'),
  exitCode(0),
  withinBound,
];

export const P08_B: readonly Claim[] = [
  {
    claim:
      'exactly three calls, each writer-1 → strict-critic-1 alone, their questions starting "Round 1.", "Round 2.", "Round 3." (no fourth: K = 3)',
    check: (r) =>
      withCalls(r, 3, (cs) => {
        const problem = allTo('strict-critic-1', cs);
        if (problem !== null) return fails(problem);
        const bad = cs.filter((c, i) => !(c.questions[0]?.text ?? '').trim().startsWith(`Round ${String(i + 1)}.`));
        return bad.length === 0
          ? holds(cs.map((c) => quote(present(c.questions[0], 'questions[0]').text)).join(' | '))
          : fails(bad.map((c) => quote(c.questions[0]?.text ?? '')).join(' | '));
      }),
  },
  {
    claim: 'each draft differs from the one before',
    check: (r) =>
      withCalls(r, 3, (cs) => {
        const drafts = cs.map((c) => draftOf(c.questions[0]));
        const same = drafts
          .slice(1)
          .flatMap((d, i) => (d === drafts[i] ? [`draft ${String(i + 2)} = draft ${String(i + 1)}: ${quote(d)}`] : []));
        return same.length === 0 ? holds(drafts.map(quote).join(' → ')) : fails(same.join('; '));
      }),
  },
  {
    claim: 'exactly one output, from writer-1, after the third gather, equal to the third draft (trimmed)',
    check: (r) =>
      withCalls(r, 3, (cs) => {
        const out = outputAfterLastGather(r, WRITER, cs);
        if (typeof out === 'string') return fails(out);
        const d = draftOf(present(cs[2], 'cs[2]').questions[0]);
        return out.text.trim() === d
          ? holds(`${out.evidence} = the third draft`)
          : fails(`its text ${quote(out.text)}, the third draft ${quote(d)}`);
      }),
  },
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P16 · Guardrail

const GUARDED = 'writer-1';
const checked = (q: CallMessage | undefined): string => after('Check:', q?.text ?? '');
const approved = (c: CallRecord): boolean => /^APPROVE\.?$/.test((c.answers[0]?.text ?? '').trim());
const SEVEN_DIGITS = /\d{7,}/;

/** Every call is writer-1 → policy-1 alone, and there are exactly `n`. */
const guardCalls = (n: number): Claim => ({
  claim:
    n === 1
      ? 'exactly one call, writer-1 → policy-1 alone'
      : `exactly ${String(n)} calls, each writer-1 → policy-1 alone`,
  check: (r) =>
    withCalls(r, n, (cs) => {
      const problem = cs.map(everyCallTo(GUARDED, ['policy-1'])).find((p) => p !== null) ?? null;
      const callLog = (c: CallRecord): string =>
        `${callLine(c)}: ${quote(present(c.questions[0], 'questions[0]').text)} → ${quote(c.answers[0]?.text ?? '')}`;
      return problem === null ? holds(cs.map(callLog).join(' | ')) : fails(problem);
    }),
});

/** The one output equals the last approved text, and follows its gather: nothing reaches the user unapproved. */
const outputIsApproved: Claim = {
  claim:
    'exactly one output, from writer-1, after the last gather, equal to the last text policy-1 approved (after "Check:", trimmed)',
  check: (r) => {
    const cs = calls(r);
    if (typeof cs === 'string' || cs.length === 0) return fails(typeof cs === 'string' ? cs : 'no call');
    const out = outputAfterLastGather(r, GUARDED, cs);
    if (typeof out === 'string') return fails(out);
    const last = present(cs.at(-1), 'cs.at(-1)');
    if (!approved(last)) return fails(`the last call's answer is ${quote(last.answers[0]?.text ?? '')}, not APPROVE`);
    const text = checked(last.questions[0]);
    return out.text.trim() === text
      ? holds(`${out.evidence} = the approved text`)
      : fails(`its text ${quote(out.text)}, the approved text ${quote(text)}`);
  },
};

export const P16_A: readonly Claim[] = [
  {
    claim: "call 1's text contains 5550123456 (else the scenario proves nothing)",
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length === 0) return fails(typeof cs === 'string' ? cs : 'no call');
      const t = checked(present(cs[0], 'cs[0]').questions[0]);
      return t.includes('5550123456') ? holds(`call 1: ${quote(t)}`) : fails(`call 1: ${quote(t)}`);
    },
  },
  {
    claim: 'call 1\'s answer starts "BLOCK"',
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length === 0) return fails(typeof cs === 'string' ? cs : 'no call');
      const a = present(cs[0], 'cs[0]').answers[0]?.text ?? '';
      return a.trim().startsWith('BLOCK') ? holds(quote(a)) : fails(quote(a));
    },
  },
  {
    claim: "call 2's text holds no run of 7 or more digits",
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length < 2)
        return fails(typeof cs === 'string' ? cs : `${String(cs.length)} calls`);
      const t = checked(present(cs[1], 'cs[1]').questions[0]);
      return SEVEN_DIGITS.test(t) ? fails(`call 2: ${quote(t)}`) : holds(`call 2: ${quote(t)}`);
    },
  },
  {
    claim: 'call 2\'s answer is "APPROVE"',
    check: (r) => {
      const cs = calls(r);
      if (typeof cs === 'string' || cs.length < 2)
        return fails(typeof cs === 'string' ? cs : `${String(cs.length)} calls`);
      const second = present(cs[1], 'cs[1]');
      return approved(second)
        ? holds(quote(present(second.answers[0], 'answers[0]').text))
        : fails(quote(second.answers[0]?.text ?? ''));
    },
  },
  guardCalls(2),
  outputIsApproved,
  {
    claim: 'no output holds 7 or more digits in a row',
    check: (r) =>
      SEVEN_DIGITS.test(r.run.stdout) ? fails(`stdout ${quote(r.run.stdout)}`) : holds(`stdout ${quote(r.run.stdout)}`),
  },
  exitCode(0),
  withinBound,
];

export const P16_B: readonly Claim[] = [
  guardCalls(1),
  {
    claim: 'its text matches /hello,? world/i and is answered "APPROVE"',
    check: (r) =>
      withCalls(r, 1, ([c]) => {
        const call = present(c, 'c');
        const t = checked(call.questions[0]);
        return /hello,? world/i.test(t) && approved(call)
          ? holds(`${quote(t)} → ${quote(present(call.answers[0], 'answers[0]').text)}`)
          : fails(`${quote(t)} → ${quote(call.answers[0]?.text ?? '')}`);
      }),
  },
  outputIsApproved,
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P13 · Contract net

const BIDDER_MANAGER = 'manager-1';
const COURIERS = ['courier-north-1', 'courier-south-1', 'courier-east-1'];
const priceOf = (text: string): number | null => {
  const m = /^PRICE: (\d+)$/.exec(text.trim());
  return m === null ? null : Number(m[1]);
};
/** A courier's code, from its own guidance ("your confirmation code, N-4471"). */
const codeOf = (r: ScenarioRecord, handle: string): string | null =>
  /confirmation code, ([A-Z]-\d+)/.exec(r.team[`${handle.replace(/-\d+$/, '')}.md`] ?? '')?.[1] ?? null;

/**
 * The lowest bid of call 1's gather: its courier and price, or why there is none.
 * @returns the lowest bid, or a string naming why there is none.
 */
function lowest(c: CallRecord): { readonly courier: string; readonly price: number } | string {
  const bids = c.answers.map((a) => ({ courier: a.from, price: priceOf(a.text) }));
  const bidLine = (a: CallMessage): string => `${a.from} ${quote(a.text)}`;
  if (bids.length !== 3 || bids.some((b) => b.price === null)) return `bids: ${c.answers.map(bidLine).join('; ')}`;
  const best = Math.min(...bids.map((b) => present(b.price, 'price')));
  const at = bids.filter((b) => b.price === best);
  return at.length === 1
    ? { courier: present(at[0], 'at[0]').courier, price: best }
    : `a tie at ${String(best)}: ${at.map((b) => b.courier).join(', ')}`;
}

export const P13_A: readonly Claim[] = [
  {
    claim: 'exactly two calls; call 1, manager-1 → exactly the three couriers',
    check: (r) =>
      withCalls(r, 2, ([c]) => {
        const call = present(c, 'c');
        const problem = everyCallTo(BIDDER_MANAGER, COURIERS)(call);
        return problem === null
          ? holds(`${callLine(call)}: ${quote(present(call.questions[0], 'questions[0]').text)}`)
          : fails(problem);
      }),
  },
  {
    claim: 'its gather holds three answers, each "PRICE: <euros>"',
    check: (r) =>
      withCalls(r, 2, ([c]) => {
        const call = present(c, 'c');
        const answerLine = (a: CallMessage): string => `${a.from}: ${quote(a.text)}`;
        const gatherState = call.gather === null ? 'none' : 'posted';
        return call.gather !== null && call.answers.length === 3 && call.answers.every((a) => priceOf(a.text) !== null)
          ? holds(call.answers.map(answerLine).join('; '))
          : fails(`${call.answers.map(answerLine).join('; ') || 'no answer'}; gather ${gatherState}`);
      }),
  },
  {
    claim:
      "call 2, manager-1 → exactly one courier: the lowest bid of call 1's gather, its question containing that price",
    check: (r) =>
      withCalls(r, 2, ([first, second]) => {
        const best = lowest(present(first, 'first'));
        if (typeof best === 'string') return fails(best);
        const secondCall = present(second, 'second');
        const problem = everyCallTo(BIDDER_MANAGER, [best.courier])(secondCall);
        if (problem !== null) return fails(`${problem} (the lowest bid is ${best.courier}'s ${String(best.price)})`);
        const q = present(secondCall.questions[0], 'questions[0]').text;
        return new RegExp(`\\b${String(best.price)}\\b`).test(q)
          ? holds(`${callLine(secondCall)}: ${quote(q)}`)
          : fails(`its question ${quote(q)} lacks ${String(best.price)}`);
      }),
  },
  {
    claim: "call 2's answer is the winner's confirmation code (its guidance)",
    check: (r) =>
      withCalls(r, 2, ([, second]) => {
        const a = present(second, 'second').answers[0];
        const code = a === undefined ? null : codeOf(r, a.from);
        return a !== undefined && code !== null && a.text.trim() === code
          ? holds(`${a.from}: ${quote(a.text)}`)
          : fails(`${a?.from ?? 'nobody'}: ${quote(a?.text ?? '')}, its code ${code ?? 'unknown'}`);
      }),
  },
  {
    claim:
      "exactly one output, from manager-1, after the second gather, naming the winner's handle, its price and the code it answered",
    check: (r) =>
      withCalls(r, 2, (cs) => {
        const out = outputAfterLastGather(r, BIDDER_MANAGER, cs);
        if (typeof out === 'string') return fails(out);
        const best = lowest(present(cs[0], 'cs[0]'));
        if (typeof best === 'string') return fails(best);
        const code = present(cs[1], 'cs[1]').answers[0]?.text.trim() ?? '';
        return out.text.includes(best.courier) &&
          new RegExp(`\\b${String(best.price)}\\b`).test(out.text) &&
          code !== '' &&
          out.text.includes(code)
          ? holds(out.evidence)
          : fails(
              `its text ${quote(out.text)}; the winner ${best.courier} at ${String(best.price)}, code ${quote(code)}`,
            );
      }),
  },
  {
    claim: "each courier's price and code are in its own document and in no other file of the team",
    check: (r) => {
      const wrong: string[] = [];
      const shown: string[] = [];
      for (const handle of COURIERS) {
        const own = `${handle.replace(/-\d+$/, '')}.md`;
        const price = /PRICE: (\d+)/.exec(r.team[own] ?? '')?.[1];
        const code = codeOf(r, handle);
        if (price === undefined || code === null) {
          wrong.push(`${own}: no price or code`);
          continue;
        }
        for (const fact of [price, code]) {
          const pattern = new RegExp(`(?<![\\w-])${fact}(?![\\w-])`);
          const found = Object.keys(r.team).filter((f) =>
            pattern.test(withoutStepNumbers(present(r.team[f], `team[${f}]`))),
          );
          if (found.length !== 1 || found[0] !== own) wrong.push(`${fact} in ${found.join(', ') || 'no file'}`);
        }
        shown.push(`${handle}: ${price}, ${code}`);
      }
      return wrong.length === 0 ? holds(shown.join('; ')) : fails(wrong.join('; '));
    },
  },
  noOutputFrom(COURIERS, 'no courier posts an output'),
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P6 · Plan-and-execute with ledgers

const PLANNER = 'planner-1';
const TASK = '/workspace/task-ledger.md';
const PROGRESS = '/workspace/progress-ledger.md';
/** The progress ledger's line (patterns-phase-2, Guidance wording; orchestration-patterns #demo-p6 as amended). */
const LEDGER_LINE = /^step (\d+) attempt (\d+): (done|failed); progress: (yes|no); stalls: (\d+); answer: (.*)$/;

/** The planner's file writes, in its agent log's order: the path of each tool.file_written. */
const writes = (r: ScenarioRecord): string[] =>
  (r.agentLogs[PLANNER] ?? []).filter((x) => x['event'] === 'tool.file_written').map((x) => String(x['path']));

export const P06_A: readonly Claim[] = [
  {
    claim:
      "planner-1's first file write is /workspace/task-ledger.md, before any write of progress-ledger.md (its agent log): the first call had no progress ledger to read",
    check: (r) => {
      const w = writes(r);
      if (w.length === 0)
        return fails(
          `no tool.file_written in planner-1's agent log (${String((r.agentLogs[PLANNER] ?? []).length)} records)`,
        );
      return w[0] === TASK
        ? holds(`writes in order: ${w.join(', ')}`)
        : fails(`the first write is ${String(w[0])}: ${w.join(', ')}`);
    },
  },
  {
    claim:
      'four calls, each planner-1 → one addressee, in the order half-a-1, half-b-1, half-b-1, backup-1, answered "sun", "ERROR: unavailable" twice, and "flower"',
    check: (r) =>
      withCalls(r, 4, (cs) => {
        const want = [
          ['half-a-1', 'sun'],
          ['half-b-1', 'ERROR: unavailable'],
          ['half-b-1', 'ERROR: unavailable'],
          ['backup-1', 'flower'],
        ] as const;
        const problems = cs.flatMap((c, i) => {
          const expected = present(want[i], `want[${String(i)}]`);
          const problem = everyCallTo(PLANNER, [expected[0]])(c);
          if (problem !== null) return [problem];
          const a = c.answers[0]?.text.trim();
          return a === expected[1]
            ? []
            : [`call ${String(i + 1)}'s answer ${quote(a ?? '')}, not ${quote(expected[1])}`];
        });
        const callLog = (c: CallRecord): string =>
          `${String(c.addressees[0])}: ${quote(present(c.answers[0], 'answers[0]').text)}`;
        return problems.length === 0 ? holds(cs.map(callLog).join('; ')) : fails(problems.join('; '));
      }),
  },
  {
    claim:
      "progress-ledger.md, read from planner-1's /workspace, holds four lines: step 1 attempt 1 done, stalls 0; step 2 attempt 1 failed, stalls 1; step 2 attempt 2 failed, stalls 2; step 2 attempt 3 done — each in the ledger's line format",
    check: (r) => {
      const text = r.workspace[PLANNER]?.['progress-ledger.md'];
      if (text === undefined || text === null)
        return fails(`progress-ledger.md ${text === null ? 'does not exist' : 'was not read'}`);
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      const want = [
        [1, 1, 'done', 0],
        [2, 1, 'failed', 1],
        [2, 2, 'failed', 2],
        [2, 3, 'done', null],
      ] as const;
      if (lines.length !== 4) return fails(`${String(lines.length)} lines: ${quote(text)}`);
      const bad = lines.flatMap((l, i) => {
        const m = LEDGER_LINE.exec(l.trim());
        const [step, attempt, state, stalls] = present(want[i], `want[${String(i)}]`);
        if (m === null) return [`line ${String(i + 1)} ${quote(l)} is not the ledger's format`];
        const ok =
          Number(m[1]) === step &&
          Number(m[2]) === attempt &&
          m[3] === state &&
          m[4] === (state === 'done' ? 'yes' : 'no') &&
          (stalls === null || Number(m[5]) === stalls);
        const stallsLine = stalls === null ? '' : `, stalls ${String(stalls)}`;
        return ok
          ? []
          : [
              `line ${String(i + 1)} ${quote(l)}, not step ${String(step)} attempt ${String(attempt)} ${state}${stallsLine}`,
            ];
      });
      return bad.length === 0 ? holds(lines.map(quote).join(' | ')) : fails(bad.join('; '));
    },
  },
  {
    claim:
      'the append of "plan 2" to task-ledger.md comes after the third write of progress-ledger.md and before its fourth (its agent log), and the task ledger then holds "plan 2" and "step 2: backup-1"',
    check: (r) => {
      const w = writes(r);
      const progress = w.flatMap((p, i) => (p === PROGRESS ? [i] : []));
      const task = w.flatMap((p, i) => (p === TASK ? [i] : []));
      const ledger = r.workspace[PLANNER]?.['task-ledger.md'] ?? '';
      if (task.length !== 2 || progress.length < 4) return fails(`writes: ${w.join(', ')}`);
      const secondTask = present(task[1], 'task[1]');
      const thirdProgress = present(progress[2], 'progress[2]');
      const fourthProgress = present(progress[3], 'progress[3]');
      if (!(secondTask > thirdProgress && secondTask < fourthProgress))
        return fails(
          `the second task-ledger write is write ${String(secondTask + 1)}; the progress-ledger writes are ${progress.map((i) => i + 1).join(', ')}`,
        );
      return /^plan 2$/m.test(ledger) && /^step 2: backup-1\b/m.test(ledger)
        ? holds(`writes: ${w.map((p) => p.replace('/workspace/', '')).join(', ')}; task-ledger.md ${quote(ledger)}`)
        : fails(`task-ledger.md ${quote(ledger)}`);
    },
  },
  {
    claim: 'exactly one output, from planner-1, after the last gather, equal to "sunflower"',
    check: (r) =>
      withCalls(r, 4, (cs) => {
        const out = outputAfterLastGather(r, PLANNER, cs);
        if (typeof out === 'string') return fails(out);
        return out.text.trim() === 'sunflower' ? holds(out.evidence) : fails(`its text ${quote(out.text)}`);
      }),
  },
  {
    claim: 'no error-level record in the conversation (none declared: the fault is an answer text)',
    check: (r) => {
      const found = errorRecords(r);
      return found.length === 0
        ? holds(`none among the conversation's ${String(r.log.length)} daemon log records`)
        : fails(found.map(logLine).join(' | '));
    },
  },
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P14 · Watchdog and reassignment

const WATCH_LEAD = 'lead-1';
const STUCK = 'stuck-1';
const BACKUP = 'backup-1';
/** The error-level records the fault causes, declared (orchestration-patterns R9): the stuck worker's expired delivery. */
const P14_DECLARED: readonly { readonly event: string; readonly handle: string }[] = [
  { event: 'channel.delivery_timeout', handle: STUCK },
];

export const P14_A: readonly Claim[] = [
  {
    // The leave is read from the daemon's channel.left, which the suite awaits (runScenario's awaitDaemon): the
    // channel stops the agent asynchronously, so the CLI can settle before the transcript shows it (build review, 7).
    claim: 'channel.delivery_timeout for stuck-1, and then stuck-1 leaves the channel (channel.left)',
    check: (r) => {
      const timeouts = logged(r, 'channel.delivery_timeout').filter((x) => x['handle'] === STUCK);
      const left = logged(r, 'channel.left').filter((x) => x['handle'] === STUCK);
      if (timeouts.length !== 1 || left.length !== 1)
        return fails(
          `${String(timeouts.length)} delivery timeouts for ${STUCK}; ${String(left.length)} channel.left records`,
        );
      const timeout = present(timeouts[0], 'timeouts[0]');
      const leftRecord = present(left[0], 'left[0]');
      return holds(
        `${logLine(timeout)}; ${JSON.stringify({ event: 'channel.left', handle: STUCK, detail: leftRecord['detail'] })}`,
      );
    },
  },
  {
    claim: "the fault fired: stuck-1's agent log holds hold.started",
    check: (r) => {
      const found = (r.agentLogs[STUCK] ?? []).filter((x) => x['event'] === 'hold.started');
      return found.length === 1
        ? holds(JSON.stringify(found[0]))
        : fails(
            `${String(found.length)} hold.started records in stuck-1's agent log (${String((r.agentLogs[STUCK] ?? []).length)} records)`,
          );
    },
  },
  {
    claim: 'call 1, lead-1 → stuck-1 alone, is gathered with stuck-1 timed out (channel.call_gathered)',
    check: (r) =>
      withCalls(r, 2, ([c]) => {
        const call = present(c, 'c');
        const problem = everyCallTo(WATCH_LEAD, [STUCK])(call);
        if (problem !== null) return fails(problem);
        return call.gather?.to === WATCH_LEAD && call.counts?.['timed_out'] === 1 && call.answers.length === 0
          ? holds(`${callLine(call)}; counts ${JSON.stringify(call.counts)}`)
          : fails(`counts ${JSON.stringify(call.counts)}; ${String(call.answers.length)} answers`);
      }),
  },
  {
    claim: "call 2, lead-1 → backup-1 alone, whose question contains call 1's question text",
    check: (r) =>
      withCalls(r, 2, ([first, second]) => {
        const secondCall = present(second, 'second');
        const problem = everyCallTo(WATCH_LEAD, [BACKUP])(secondCall);
        if (problem !== null) return fails(problem);
        const q1 = present(present(first, 'first').questions[0], 'questions[0]').text;
        const q2 = present(secondCall.questions[0], 'questions[0]').text;
        return containsText(q2, q1)
          ? holds(`${callLine(secondCall)}: ${quote(q2)}`)
          : fails(`its question ${quote(q2)} lacks ${quote(q1)}`);
      }),
  },
  {
    claim: "backup-1's answer matches /hello,? world/i",
    check: (r) =>
      withCalls(r, 2, ([, second]) => {
        const a = answerFrom(present(second, 'second'), BACKUP);
        if (typeof a === 'string') return fails(a);
        return /hello,? world/i.test(a.text)
          ? holds(`${a.from}: ${quote(a.text)}`)
          : fails(`${a.from}: ${quote(a.text)}`);
      }),
  },
  {
    claim: "exactly one output, from lead-1, after the second gather, holding backup-1's answer",
    check: (r) =>
      withCalls(r, 2, (cs) => {
        const out = outputAfterLastGather(r, WATCH_LEAD, cs);
        if (typeof out === 'string') return fails(out);
        const a = present(cs[1], 'cs[1]').answers[0]?.text ?? '';
        return a !== '' && containsText(out.text, a)
          ? holds(out.evidence)
          : fails(`its text ${quote(out.text)}, backup-1's answer ${quote(a)}`);
      }),
  },
  {
    claim:
      'every error-level record of the conversation is declared: exactly one, channel.delivery_timeout for stuck-1',
    check: (r) => {
      const found = errorRecords(r);
      const undeclared = found.filter(
        (x) => !P14_DECLARED.some((d) => d.event === x['event'] && d.handle === x['handle']),
      );
      const errorLine = (x: LogRecord): string => `${String(x['event'])} ${String(x['handle'])}`;
      return undeclared.length === 0 && found.length === P14_DECLARED.length
        ? holds(found.map(logLine).join(' | '))
        : fails(`error records: ${found.map(errorLine).join(', ') || 'none'}`);
    },
  },
  exitCode(0),
  withinBound,
];

/** Every phase-2 checker, by scenario id (p04-a's is the rainbow's, tests/agents/patterns/rainbow.ts). */
export const PHASE_2: Readonly<Record<string, readonly Claim[]>> = {
  'p18-a': P18_A,
  'p05-a': P05_A,
  'p10-a': P10_A,
  'p09-a': P09_A,
  'p23-a': P23_A,
  'p24-a': P24_A,
  'p24-b': P24_B,
  'p08-a': P08_A,
  'p08-b': P08_B,
  'p16-a': P16_A,
  'p16-b': P16_B,
  'p13-a': P13_A,
  'p06-a': P06_A,
  'p14-a': P14_A,
};
