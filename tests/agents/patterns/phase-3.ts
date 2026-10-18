// The phase-3 scenarios' checkers (docs/plans/patterns-phase-3.md R3): each scenario's assertions, as
// orchestration-patterns' #demos-phase-3 lists them (amended by patterns-phase-3, R38), and its bound, read only from
// the run's exit codes, stdout and transcript, the daemon log's records of its conversation and of its members' own
// (`agent.*`, `channel.rejoined`, `channel.left`, which carry no conversation), its deliveries, and the team folder.
// Each is run by its demo's agent-suite file on its recorded run, and by tests/unit/pattern-proofs.test.ts on its
// fixtures, one per listed mutation, each failing naming the claim it breaks.

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
  line,
  logLine,
  logged,
  oneOutputFrom,
  outputs,
  postedLog,
  replyText,
  withinBound,
  withoutStepNumbers,
  type CallRecord,
  type Claim,
  type LogRecord,
  type ScenarioRecord,
} from './record.js';

/** The log's records of one event for one handle, in order. */
const of = (r: ScenarioRecord, event: string, handle: string): LogRecord[] =>
  logged(r, event).filter((x) => x['handle'] === handle);
/** A record's position in the log. */
const at = (r: ScenarioRecord, x: LogRecord): number => r.log.indexOf(x);
/** One error-level record, short, as evidence: its event, and its handle when it has one. */
const errorLine = (x: LogRecord): string => {
  const handle = x['handle'] === undefined ? '' : ` ${x['handle'] as string}`;
  return `${String(x['event'])}${handle}`;
};

/** The error-level records, short, as evidence. */
const errorsLine = (r: ScenarioRecord): string => errorRecords(r).map(errorLine).join(', ') || 'none';

/** Exactly these error-level records, by event and count, and no other (patterns-phase-3 R3: the fault's records declared). */
const declaredErrors = (claim: string, want: Readonly<Record<string, number>>): Claim => ({
  claim,
  check: (r) => {
    const found = errorRecords(r);
    const counts: Record<string, number> = {};
    for (const x of found) counts[String(x['event'])] = (counts[String(x['event'])] ?? 0) + 1;
    const same =
      Object.keys(want).length === Object.keys(counts).length &&
      Object.entries(want).every(([event, n]) => counts[event] === n);
    return same ? holds(errorsLine(r)) : fails(`found ${errorsLine(r)}`);
  },
});

// ---------------------------------------------------------------- P25 · Supervisor restart

/** The restart's own bound on `agent.restarted`'s ms (R3): over twelve times probe L's slowest warm launch, 406 ms. */
const RESTART_MS_BOUND = 5_000;

export const P25_A: readonly Claim[] = [
  {
    claim: 'the fault fired: worker-1 exited unexpectedly once (agent.exited_unexpectedly)',
    check: (r) => {
      const found = of(r, 'agent.exited_unexpectedly', 'worker-1');
      if (found.length !== 1) return fails(`${String(found.length)} agent.exited_unexpectedly for worker-1`);
      const exited = present(found[0], 'found[0]');
      return holds(`${logLine(exited)} code ${String(exited['code'])}`);
    },
  },
  {
    claim: `worker-1 is restarted once: agent.restarting, then agent.restarted within ${String(RESTART_MS_BOUND)} ms of its exit`,
    check: (r) => {
      const restarting = of(r, 'agent.restarting', 'worker-1');
      const restarted = of(r, 'agent.restarted', 'worker-1');
      if (restarting.length !== 1 || restarted.length !== 1)
        return fails(
          `${String(restarting.length)} agent.restarting, ${String(restarted.length)} agent.restarted for worker-1`,
        );
      const firstRestarting = present(restarting[0], 'restarting[0]');
      const firstRestarted = present(restarted[0], 'restarted[0]');
      if (at(r, firstRestarted) < at(r, firstRestarting)) return fails('agent.restarted before agent.restarting');
      const ms = Number(firstRestarted['ms']);
      return ms <= RESTART_MS_BOUND
        ? holds(`attempt ${String(firstRestarted['attempt'])}, ${String(ms)} ms from the exit`)
        : fails(`agent.restarted at ${String(ms)} ms, over ${String(RESTART_MS_BOUND)} ms`);
    },
  },
  {
    claim:
      'worker-1 is online again under the same handle: it rejoins (channel.rejoined), and no other worker handle joins',
    check: (r) => {
      const rejoined = of(r, 'channel.rejoined', 'worker-1');
      const joined = logged(r, 'channel.joined').filter((x) => String(x['handle']).startsWith('worker-'));
      if (rejoined.length !== 1 || joined.length !== 0)
        return fails(
          `${String(rejoined.length)} channel.rejoined for worker-1; joined: ${joined.map((x) => String(x['handle'])).join(', ') || 'none'}`,
        );
      return holds(logLine(present(rejoined[0], 'rejoined[0]')));
    },
  },
  {
    claim: "the restart comes before the reply: agent.restarted is logged before worker-1's output",
    check: (r) => {
      const restarted = of(r, 'agent.restarted', 'worker-1')[0];
      const output = postedLog(r).find((x) => x['kind'] === 'output' && x['from'] === 'worker-1');
      if (restarted === undefined || output === undefined)
        return fails(
          `${restarted === undefined ? 'no agent.restarted' : 'restarted'}; ${output === undefined ? 'no output from worker-1' : 'an output'}`,
        );
      return at(r, restarted) < at(r, output)
        ? holds(`agent.restarted at log record ${String(at(r, restarted))}, the output at ${String(at(r, output))}`)
        : fails('the output is logged before agent.restarted');
    },
  },
  {
    claim: 'exactly one output, from worker-1, matching /^hello,? world\\.?$/i',
    check: (r) => {
      const found = outputs(r);
      if (found.length !== 1) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      const out = present(found[0], 'found[0]');
      if (out.from !== 'worker-1') return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      return /^hello,? world\.?$/i.test(replyText(r).trim())
        ? holds(`${line(out)} ${JSON.stringify(replyText(r))}`)
        : fails(`its text ${JSON.stringify(replyText(r))}`);
    },
  },
  declaredErrors('every error-level record is declared: exactly one, agent.exited_unexpectedly for worker-1', {
    'agent.exited_unexpectedly': 1,
  }),
  exitCode(0),
  withinBound,
];

export const P25_B: readonly Claim[] = [
  {
    claim: 'the fault fired three times: worker-1 exited unexpectedly three times (agent.exited_unexpectedly)',
    check: (r) => {
      const found = of(r, 'agent.exited_unexpectedly', 'worker-1');
      return found.length === 3
        ? holds(found.map((x) => `code ${String(x['code'])}`).join(', '))
        : fails(`${String(found.length)} agent.exited_unexpectedly for worker-1`);
    },
  },
  {
    claim: 'exactly two restarts begin (agent.restarting attempts), and none comes online (no agent.restarted)',
    check: (r) => {
      const restarting = of(r, 'agent.restarting', 'worker-1');
      const restarted = of(r, 'agent.restarted', 'worker-1');
      if (restarting.length !== 2 || restarted.length !== 0)
        return fails(`${String(restarting.length)} agent.restarting, ${String(restarted.length)} agent.restarted`);
      const first = present(restarting[0], 'restarting[0]');
      return holds(
        `attempts ${restarting.map((x) => String(x['attempt'])).join(', ')}, each max ${String(first['max'])} within ${String(first['withinMs'])} ms`,
      );
    },
  },
  {
    claim: 'then the limit: agent.restart_limit for worker-1, after the restarts, and no further start of worker',
    check: (r) => {
      const limit = of(r, 'agent.restart_limit', 'worker-1');
      if (limit.length !== 1) return fails(`${String(limit.length)} agent.restart_limit for worker-1`);
      const limitRecord = present(limit[0], 'limit[0]');
      const restarting = of(r, 'agent.restarting', 'worker-1');
      if (restarting.some((x) => at(r, x) > at(r, limitRecord)))
        return fails('an agent.restarting after agent.restart_limit');
      const later = logged(r, 'agent.starting').filter(
        (x) => x['member'] === 'worker' && at(r, x) > at(r, limitRecord),
      );
      return later.length === 0
        ? holds(
            `${logLine(limitRecord)}: ${String(limitRecord['restarts'])} restarts within ${String(limitRecord['withinMs'])} ms; no agent.starting of worker after it`,
          )
        : fails(`${String(later.length)} agent.starting of worker after the limit`);
    },
  },
  {
    claim: 'the conversation ends with the error event restart_limit naming worker-1 (channel.conversation_ended)',
    check: (r) => {
      const failure = r.run.events.filter((e) => e.type === 'failure');
      const ended = logged(r, 'channel.conversation_ended');
      const notEnded = `channel.conversation_ended: ${ended.map((x) => String(x['reason'])).join(', ') || 'none'}`;
      if (ended.length !== 1) return fails(notEnded);
      const endedRecord = present(ended[0], 'ended[0]');
      if (endedRecord['reason'] !== 'restart_limit') return fails(notEnded);
      const named = failure.find((e) => 'text' in e && /^restart_limit: worker-1 /.test(e.text));
      return named !== undefined
        ? holds(line(named))
        : fails(`the stream's failure lines: ${failure.map(line).join(' | ') || 'none'}`);
    },
  },
  {
    claim: 'worker-1 leaves the channel: channel.left with detail "restart limit reached"',
    check: (r) => {
      const left = of(r, 'channel.left', 'worker-1');
      const notLeft = `channel.left for worker-1: ${left.map((x) => String(x['detail'])).join(', ') || 'none'}`;
      if (left.length !== 1) return fails(notLeft);
      const leftRecord = present(left[0], 'left[0]');
      return leftRecord['detail'] === 'restart limit reached' ? holds(logLine(leftRecord)) : fails(notLeft);
    },
  },
  {
    claim: 'no output',
    check: (r) => {
      const found = outputs(r);
      return found.length === 0 ? holds('no "› output" line in the transcript') : fails(found.map(line).join(' | '));
    },
  },
  declaredErrors(
    'every error-level record is declared: three agent.exited_unexpectedly, one agent.restart_limit, one channel.conversation_ended',
    {
      'agent.exited_unexpectedly': 3,
      'agent.restart_limit': 1,
      'channel.conversation_ended': 1,
    },
  ),
  exitCode(1),
  withinBound,
];

// ---------------------------------------------------------------- P17 · Budgets and circuit breaker

/** The internal messages of the transcript: each `› internal <from> → <to>: <text>`. */
const internalLines = (r: ScenarioRecord) =>
  r.run.events.filter((e): e is Extract<typeof e, { type: 'internal' }> => e.type === 'internal');

/** ping-1 and pong-1 alternate, each sending its own word to the other: the first from ping-1. Undefined when they do, else why not. */
function alternation(r: ScenarioRecord): string | undefined {
  const found = internalLines(r);
  for (const [i, m] of found.entries()) {
    const [from, to, word] = i % 2 === 0 ? ['ping-1', 'pong-1', 'ping'] : ['pong-1', 'ping-1', 'pong'];
    if (m.from !== from || m.to !== to || m.text.trim().replace(/\.$/, '').toLowerCase() !== word)
      return `message ${String(i + 1)} is ${line(m)}, not ${from} → ${to}: ${word}`;
  }
  return undefined;
}

/** The stream ends with the error event budget_exceeded, its detail matching `detail` (channel.conversation_ended, one). */
const endedBudget = (claim: string, detail: RegExp): Claim => ({
  claim,
  check: (r) => {
    const ended = logged(r, 'channel.conversation_ended');
    const notEnded = `channel.conversation_ended: ${ended.map((x) => String(x['reason'])).join(', ') || 'none'}`;
    if (ended.length !== 1) return fails(notEnded);
    const endedRecord = present(ended[0], 'ended[0]');
    if (endedRecord['reason'] !== 'budget_exceeded') return fails(notEnded);
    const failures = r.run.events.filter((e) => e.type === 'failure');
    const last = r.run.events.at(-1);
    if (last === undefined || last.type !== 'failure')
      return fails(`the stream's last line is ${last === undefined ? 'nothing' : line(last)}, not its error`);
    return /^budget_exceeded: /.test(last.text) && detail.test(last.text)
      ? holds(`${line(last)} (${String(failures.length)} ✗ line)`)
      : fails(`its error line: ${line(last)}`);
  },
});

/** No agent post — a message or a status — in the conversation after the harness ended it. */
const nothingAfterTheEnd: Claim = {
  claim:
    'no agent posts in the conversation after it ends: no channel.posted or channel.status of an agent after channel.conversation_ended',
  check: (r) => {
    const ended = logged(r, 'channel.conversation_ended')[0];
    if (ended === undefined) return fails('no channel.conversation_ended');
    const after = r.log
      .slice(at(r, ended) + 1)
      .filter((x) => (x['event'] === 'channel.posted' || x['event'] === 'channel.status') && x['from'] !== 'asha');
    return after.length === 0
      ? holds(
          `channel.conversation_ended is log record ${String(at(r, ended))}; no agent's channel.posted or channel.status after it`,
        )
      : fails(after.map(logLine).join(' | '));
  },
};

export const P17_A: readonly Claim[] = [
  {
    claim:
      'the agents alternate ping-1 → pong-1 "ping", pong-1 → ping-1 "pong", eight internal messages: the budget\'s eight posts',
    check: (r) => {
      const why = alternation(r);
      const n = internalLines(r).length;
      if (why !== undefined) return fails(why);
      return n === 8 ? holds(internalLines(r).map(line).join(' | ')) : fails(`${String(n)} internal messages`);
    },
  },
  endedBudget(
    'the ninth post is refused: the stream ends with ✗ budget_exceeded, the conversation reached its budget of 8 agent posts (channel.conversation_ended)',
    /reached its budget of 8 agent posts$/,
  ),
  nothingAfterTheEnd,
  {
    claim: 'no output',
    check: (r) =>
      outputs(r).length === 0 ? holds('no "› output" line in the transcript') : fails(outputs(r).map(line).join(' | ')),
  },
  declaredErrors('every error-level record is declared: exactly one, channel.conversation_ended', {
    'channel.conversation_ended': 1,
  }),
  exitCode(1),
  withinBound,
];

export const P17_B: readonly Claim[] = [
  {
    claim:
      'the agents alternate ping and pong, fewer than eight internal messages: the token budget ends it before the posts',
    check: (r) => {
      const why = alternation(r);
      const n = internalLines(r).length;
      if (why !== undefined) return fails(why);
      return n >= 1 && n < 8
        ? holds(`${String(n)}: ${internalLines(r).map(line).join(' | ')}`)
        : fails(`${String(n)} internal messages`);
    },
  },
  endedBudget(
    'the token budget ends it: the stream ends with ✗ budget_exceeded, the conversation used its tokens past its budget of 6000 (channel.conversation_ended)',
    /used \d+ tokens of its budget of 6000$/,
  ),
  nothingAfterTheEnd,
  {
    claim: 'no output',
    check: (r) =>
      outputs(r).length === 0 ? holds('no "› output" line in the transcript') : fails(outputs(r).map(line).join(' | ')),
  },
  declaredErrors('every error-level record is declared: exactly one, channel.conversation_ended', {
    'channel.conversation_ended': 1,
  }),
  exitCode(1),
  withinBound,
];

// ---------------------------------------------------------------- P21 · Publish / subscribe

/** A topic scenario's claims: the input posted to `topic`, delivered to exactly `subscribers` and nobody else, each replying `<handle> noted: <message>`. */
function topicClaims(topic: string, text: string, subscribers: readonly [string, string], other: string): Claim[] {
  return [
    {
      claim: `the message is posted to topic ${topic}, to everyone (channel.posted with topic ${topic} and to null)`,
      check: (r) => {
        const input = postedLog(r).filter((x) => x['kind'] === 'input');
        const topicLine = (x: LogRecord): string => `${logLine(x)} topic ${String(x['topic'])}`;
        const notPosted = `the input's records: ${input.map(topicLine).join(' | ') || 'none'}`;
        if (input.length !== 1) return fails(notPosted);
        const inputRecord = present(input[0], 'input[0]');
        if (inputRecord['topic'] !== topic || inputRecord['to'] !== null) return fails(notPosted);
        return holds(topicLine(inputRecord));
      },
    },
    {
      claim: `it is delivered to exactly ${subscribers.join(' and ')} (the conversation's asha.delivery spans)`,
      check: (r) => {
        const got = [...r.deliveries].sort(byCodeUnit);
        return JSON.stringify(got) === JSON.stringify([...subscribers].sort(byCodeUnit))
          ? holds(`deliveries: ${r.deliveries.join(', ')}`)
          : fails(`deliveries: ${r.deliveries.join(', ') || 'none'}`);
      },
    },
    {
      claim: `${other} receives nothing and posts nothing in the conversation`,
      check: (r) => {
        const posts = r.log.filter(
          (x) => (x['event'] === 'channel.posted' || x['event'] === 'channel.status') && x['from'] === other,
        );
        return !r.deliveries.includes(other) && posts.length === 0
          ? holds(
              `no delivery to ${other}, and none of its posts among the conversation's ${String(r.log.length)} records`,
            )
          : fails(
              `${String(r.deliveries.filter((h) => h === other).length)} deliveries to it; posts: ${posts.map(logLine).join(' | ') || 'none'}`,
            );
      },
    },
    {
      claim: `two outputs, one from each of ${subscribers.join(' and ')}, each "<its handle> noted:" and the message`,
      check: (r) => {
        const found = outputs(r);
        const texts = r.run.stdout.replace(/\n$/, '').split('\n');
        if (
          found.length !== 2 ||
          JSON.stringify(found.map((o) => o.from).sort()) !== JSON.stringify([...subscribers].sort())
        )
          return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
        const bad = found.filter(
          (o, i) => !(texts[i] ?? '').startsWith(`${o.from} noted:`) || !containsText(texts[i] ?? '', text),
        );
        return bad.length === 0
          ? holds(found.map((o, i) => `${line(o)} ${JSON.stringify(texts[i])}`).join(' | '))
          : fails(`replies: ${JSON.stringify(texts)}`);
      },
    },
    declaredErrors('no error-level record', {}),
    exitCode(0),
    withinBound,
  ];
}

export const P21_A: readonly Claim[] = topicClaims(
  'weather',
  'Rain expected tomorrow.',
  ['weather-desk-1', 'front-page-1'],
  'sports-desk-1',
);
export const P21_B: readonly Claim[] = topicClaims(
  'sports',
  'The home team won.',
  ['sports-desk-1', 'front-page-1'],
  'weather-desk-1',
);

// ---------------------------------------------------------------- asking the user: P22's take-over and P15

/** A later command's run (patterns-phase-3 R9): the scenario's second command is its answer. */
const answerRun = (r: ScenarioRecord) => r.runs[1];

/**
 * The one ask in the conversation: its channel.posted record (an output carrying asks), or why not.
 * @returns the ask's record, or a string naming why there is not exactly one.
 */
function theAsk(r: ScenarioRecord, from: string): LogRecord | string {
  const asks = postedLog(r).filter((x) => x['asks'] === true);
  const notAsked = `asks: ${asks.map(logLine).join(' | ') || 'none'}`;
  if (asks.length !== 1) return notAsked;
  const ask = present(asks[0], 'asks[0]');
  if (ask['from'] !== from || ask['kind'] !== 'output') return notAsked;
  return ask;
}

/**
 * The answer's channel.posted record: an input from the user to `to`, answering the ask — or why not.
 * @returns the answer's record, or a string naming why there is not exactly one.
 */
function theAnswer(r: ScenarioRecord, to: string): LogRecord | string {
  const ask = theAsk(r, to);
  if (typeof ask === 'string') return ask;
  const answers = postedLog(r).filter((x) => x['kind'] === 'input' && x['answers'] !== undefined);
  const answerLine = (x: LogRecord): string => `${logLine(x)} answers ${String(x['answers'])}`;
  const notAnswered = `answers: ${answers.map(answerLine).join(' | ') || 'none'}`;
  if (answers.length !== 1) return notAnswered;
  const answer = present(answers[0], 'answers[0]');
  if (answer['answers'] !== ask['id'] || answer['to'] !== to || answer['from'] !== 'alice') return notAnswered;
  return answer;
}

/** The first command asked: its output is the ask (channel.posted with asks), and it printed the waiting line for it. */
const askedAndWaiting = (from: string): Claim => ({
  claim: `${from}'s output is an ask (channel.posted with asks), and command 1 printed "? ${from} is waiting for your answer: …"`,
  check: (r) => {
    const ask = theAsk(r, from);
    if (typeof ask === 'string') return fails(ask);
    const waiting = r.run.events.filter(
      (e) =>
        e.type === 'progress' &&
        e.text.startsWith(`? ${from} is waiting for your answer: asha user=alice conversation=`),
    );
    return waiting.length === 1
      ? holds(`${logLine(ask)} asks; ${JSON.stringify((waiting[0] as { text: string }).text)}`)
      : fails(`${String(waiting.length)} waiting lines for ${from} in command 1's transcript`);
  },
});

/** One conversation throughout: the second command's input is posted in it, to the asker, answering its ask. */
const answeredInTheConversation = (to: string): Claim => ({
  claim: `command 2's message is posted in the same conversation, to ${to}, answering its ask (channel.posted with answers)`,
  check: (r) => {
    const answer = theAnswer(r, to);
    if (typeof answer === 'string') return fails(answer);
    return answerRun(r) === undefined
      ? fails('no second command')
      : holds(
          `${logLine(answer)} in conversation ${String(answer['conversation'])}, answers ${String(answer['answers'])}`,
        );
  },
});

/** Every channel record from `from` after the answer's. */
const afterTheAnswer = (r: ScenarioRecord, from: string, answer: LogRecord): LogRecord[] =>
  r.log.filter(
    (x) =>
      at(r, x) > at(r, answer) &&
      (x['event'] === 'channel.posted' || x['event'] === 'channel.status') &&
      x['from'] === from,
  );

const COMMAND_2_EXIT = (code: number): Claim => ({
  claim: `command 2 exits ${String(code)}`,
  check: (r) => {
    const run = answerRun(r);
    if (run === undefined) return fails('no second command');
    return run.code === code ? holds(`exit ${String(run.code)}`) : fails(`exit ${String(run.code)}`);
  },
});

/** p22-a's claims on command 1, its escalation now an ask (R28: "p22-a's assertions MUST hold unchanged"). */
const P22_COMMAND_1: readonly Claim[] = [
  {
    claim: 'command 1: exactly one output, from helper-1, starting "ESCALATE:"',
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
    claim: 'its "done:" part holds 300 and its "left:" part names the meeting room',
    check: (r) => {
      const done = /done:(.*?)(;\s*left:|$)/is.exec(replyText(r))?.[1];
      const left = /left:(.*)$/is.exec(replyText(r))?.[1];
      return done !== undefined && /\b300\b/.test(done) && left !== undefined && /meeting room/i.test(left)
        ? holds(`done:${done}; left:${left.trimEnd()}`)
        : fails(`done ${JSON.stringify(done ?? null)}, left ${JSON.stringify(left ?? null)}`);
    },
  },
  askedAndWaiting('helper-1'),
  exitCode(0),
];

export const P22_B: readonly Claim[] = [
  ...P22_COMMAND_1,
  answeredInTheConversation('helper-1'),
  {
    claim: 'after the answer, helper-1 posts only "pass: …" in the conversation, though the conversion is in its role',
    check: (r) => {
      const answer = theAnswer(r, 'helper-1');
      if (typeof answer === 'string') return fails(answer);
      const after = afterTheAnswer(r, 'helper-1', answer);
      const passed = after.filter((x) => x['event'] === 'channel.status' && String(x['text']).startsWith('pass: '));
      const afterLine = (x: LogRecord): string => {
        const kind = x['kind'] === undefined || x['kind'] === null ? '' : (x['kind'] as string);
        return `${String(x['event'])} ${kind} ${JSON.stringify(x['text'] ?? '')}`;
      };
      return after.length > 0 && passed.length === after.length
        ? holds(after.map((x) => `${String(x['event'])} ${JSON.stringify(x['text'])}`).join(' | '))
        : fails(`helper-1 after the answer: ${after.map(afterLine).join(' | ') || 'nothing'}`);
    },
  },
  {
    claim: "command 2 prints no output from helper-1, only the harness's no-reply output naming helper-1 as passed",
    check: (r) => {
      const run = answerRun(r);
      if (run === undefined) return fails('no second command');
      const found = run.events.filter((e) => e.type === 'output');
      const text = run.stdout.replace(/\n$/, '');
      if (
        found.length !== 1 ||
        (found[0] as { from: string }).from !== 'asha' ||
        !/^No agent could answer this:\n- helper-1 passed: /.test(text)
      )
        return fails(`outputs: ${found.map(line).join(' | ') || 'none'}; stdout ${JSON.stringify(text)}`);
      return holds(`${line(present(found[0], 'found[0]'))} ${JSON.stringify(text)}`);
    },
  },
  COMMAND_2_EXIT(1),
  declaredErrors('no error-level record', {}),
  withinBound,
];

// ---------------------------------------------------------------- P15 · Human approval gate

/** The announcement, normalized as R3 says: trimmed, and one trailing full stop removed. */
const ANNOUNCEMENT = 'Office closed Friday';
const normalized = (text: string): string => text.trim().replace(/\.$/, '');

/** clerk-1's blackboard_post calls in a run, as --verbose prints the model's tool call (`clerk-1 blackboard_post: {…}`). */
function boardCalls(run: ScenarioRecord['run']): (Readonly<Record<string, unknown>> | string)[] {
  return run.events
    .filter(
      (e): e is Extract<typeof e, { type: 'progress' }> =>
        e.type === 'progress' && e.text.startsWith('clerk-1 blackboard_post: '),
    )
    .map(
      /** @returns the call's text as JSON, or the raw text when it did not parse. */
      (e) => {
        const json = e.text.slice('clerk-1 blackboard_post: '.length);
        try {
          return JSON.parse(json) as Readonly<Record<string, unknown>>;
        } catch {
          // Not JSON as printed: the line itself is the evidence, and the claim fails on it.
          return json;
        }
      },
    );
}

/** Command 1: the approval request, an ask, containing the announcement; the waiting line; exit 0. */
const P15_COMMAND_1: readonly Claim[] = [
  {
    claim: `command 1's one output is clerk-1's approval request, containing "${ANNOUNCEMENT}"`,
    check: (r) => {
      const found = outputs(r);
      if (found.length !== 1) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      const out = present(found[0], 'found[0]');
      if (out.from !== 'clerk-1') return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      return containsText(replyText(r), ANNOUNCEMENT)
        ? holds(`${line(out)} ${JSON.stringify(replyText(r))}`)
        : fails(`its text ${JSON.stringify(replyText(r))}`);
    },
  },
  askedAndWaiting('clerk-1'),
  exitCode(0),
  answeredInTheConversation('clerk-1'),
];

/** The last output of command 2: `text`, from clerk-1. */
const lastOutput = (text: string): Claim => ({
  claim: `command 2's last output is clerk-1's "${text}"`,
  check: (r) => {
    const run = answerRun(r);
    if (run === undefined) return fails('no second command');
    const found = run.events.filter((e) => e.type === 'output');
    const last = run.stdout.replace(/\n$/, '').split('\n').at(-1) ?? '';
    return found.length > 0 && (found.at(-1) as { from: string }).from === 'clerk-1' && last.trim() === text
      ? holds(`${line(present(found.at(-1), 'found.at(-1)'))} ${JSON.stringify(last)}`)
      : fails(`outputs: ${found.map(line).join(' | ') || 'none'}; stdout ${JSON.stringify(run.stdout)}`);
  },
});

export const P15_A: readonly Claim[] = [
  ...P15_COMMAND_1,
  {
    claim: "no blackboard.posted before the user's answer is posted",
    check: (r) => {
      const answer = theAnswer(r, 'clerk-1');
      if (typeof answer === 'string') return fails(answer);
      const postedBy = (x: LogRecord): string => `blackboard.posted by ${String(x['author'])}`;
      const before = logged(r, 'blackboard.posted').filter((x) => at(r, x) < at(r, answer));
      return before.length === 0
        ? holds(
            `the answer ${logLine(answer)} precedes every blackboard.posted (${String(logged(r, 'blackboard.posted').length)} in all)`,
          )
        : fails(`before the answer: ${before.map(postedBy).join(' | ')}`);
    },
  },
  {
    claim: `exactly one blackboard.posted after it, by clerk-1, whose entry is "${ANNOUNCEMENT}"`,
    check: (r) => {
      const answer = theAnswer(r, 'clerk-1');
      const run = answerRun(r);
      if (typeof answer === 'string') return fails(answer);
      if (run === undefined) return fails('no second command');
      const postedBy = (x: LogRecord): string => `blackboard.posted by ${String(x['author'])}`;
      const after = logged(r, 'blackboard.posted').filter((x) => at(r, x) > at(r, answer));
      const calls = boardCalls(run);
      const notPosted = `after the answer: ${after.map(postedBy).join(' | ') || 'none'}`;
      if (after.length !== 1) return fails(notPosted);
      const posted = present(after[0], 'after[0]');
      if (posted['author'] !== 'clerk-1') return fails(notPosted);
      const text = calls.length === 1 && typeof calls[0] === 'object' ? calls[0]['text'] : undefined;
      // The entry is the call's text: the record's size is its UTF-8 length.
      return typeof text === 'string' &&
        normalized(text) === ANNOUNCEMENT &&
        posted['size'] === Buffer.byteLength(text, 'utf8')
        ? holds(`blackboard.posted by clerk-1, size ${String(posted['size'])}; its call ${JSON.stringify(calls[0])}`)
        : fails(`blackboard_post calls: ${JSON.stringify(calls)}; record size ${String(posted['size'])}`);
    },
  },
  lastOutput('Posted.'),
  COMMAND_2_EXIT(0),
  declaredErrors('no error-level record', {}),
  withinBound,
];

export const P15_B: readonly Claim[] = [
  ...P15_COMMAND_1,
  {
    claim: 'no blackboard.posted at all',
    check: (r) => {
      const found = logged(r, 'blackboard.posted');
      return found.length === 0
        ? holds(`no blackboard.posted among the scenario's ${String(r.log.length)} records`)
        : fails(found.map((x) => `blackboard.posted by ${String(x['author'])}`).join(' | '));
    },
  },
  lastOutput('Not posted.'),
  COMMAND_2_EXIT(0),
  declaredErrors('no error-level record', {}),
  withinBound,
];

// ---------------------------------------------------------------- P19 · Dynamic spawning

export const P19_A: readonly Claim[] = [
  {
    claim: 'helper-1 joins the channel after the input and before the call (channel.joined), lead-1 alone before it',
    check: (r) => {
      const joined = logged(r, 'channel.joined').filter((x) => x['handle'] === 'helper-1');
      const input = postedLog(r).find((x) => x['kind'] === 'input');
      const opened = logged(r, 'channel.call_opened')[0];
      if (joined.length !== 1 || input === undefined || opened === undefined)
        return fails(
          `${String(joined.length)} channel.joined for helper-1; input ${input === undefined ? 'missing' : 'logged'}; call_opened ${opened === undefined ? 'missing' : 'logged'}`,
        );
      const join = present(joined[0], 'joined[0]');
      return at(r, input) < at(r, join) && at(r, join) < at(r, opened)
        ? holds(
            `channel.joined helper-1 at record ${String(at(r, join))}, after the input (${String(at(r, input))}) and before the call (${String(at(r, opened))})`,
          )
        : fails(
            `channel.joined at ${String(at(r, join))}, the input at ${String(at(r, input))}, the call at ${String(at(r, opened))}`,
          );
    },
  },
  {
    claim: 'exactly one launch: lead-1 launched helper-1 from the recipe helper (agent.launched)',
    check: (r) => {
      const found = logged(r, 'agent.launched');
      const launchLine = (x: LogRecord): string =>
        `${String(x['by'])} → ${String(x['handle'])} (${String(x['recipe'])})`;
      const notLaunched = `agent.launched: ${found.map(launchLine).join(' | ') || 'none'}`;
      if (found.length !== 1) return fails(notLaunched);
      const launch = present(found[0], 'found[0]');
      if (launch['by'] !== 'lead-1' || launch['handle'] !== 'helper-1' || launch['recipe'] !== 'helper')
        return fails(notLaunched);
      return holds(
        `agent.launched by ${launch['by']}: ${launch['handle']} from ${launch['recipe']}, team ${String(launch['team'])}`,
      );
    },
  },
  {
    claim: 'one call, lead-1 → helper-1, answered "marigold", and gathered to lead-1',
    check: (r) => {
      const calls = callsOf(r);
      if (calls.length !== 1) return fails(`${String(calls.length)} calls`);
      const c = present(calls[0], 'calls[0]');
      const firstAnswer = c.answers[0];
      const answered =
        c.answers.length === 1 &&
        firstAnswer !== undefined &&
        firstAnswer.from === 'helper-1' &&
        /^marigold\.?$/i.test(firstAnswer.text.trim());
      const gatherLine = c.gather === null ? 'none' : `to ${c.gather.to ?? 'all'}`;
      return c.caller === 'lead-1' &&
        JSON.stringify(c.addressees) === '["helper-1"]' &&
        answered &&
        c.gather !== null &&
        c.gather.to === 'lead-1'
        ? holds(`${callLine(c)}; answer ${JSON.stringify(present(firstAnswer, 'answers[0]').text)}; gathered`)
        : fails(
            `${callLine(c)}; answers ${JSON.stringify(c.answers.map((a) => [a.from, a.text]))}; gather ${gatherLine}`,
          );
    },
  },
  oneOutputFrom('lead-1', /marigold/i),
  {
    claim: 'helper-1 is stopped (drain) once the conversation settles, the reason naming it',
    check: (r) => {
      const stops = logged(r, 'agent.stopping').filter((x) => x['handle'] === 'helper-1');
      const stopLine = (x: LogRecord): string => `${String(x['mode'])} ${String(x['reason'])}`;
      const notStopped = `agent.stopping for helper-1: ${stops.map(stopLine).join(' | ') || 'none'}`;
      if (stops.length !== 1) return fails(notStopped);
      const stop = present(stops[0], 'stops[0]');
      if (
        stop['mode'] !== 'drain' ||
        String(stop['reason']) !== `the conversation ${r.conversation} it was launched for settled`
      )
        return fails(notStopped);
      return holds(`agent.stopping helper-1 drain: ${String(stop['reason'])}`);
    },
  },
  declaredErrors('no error-level record', {}),
  exitCode(0),
  withinBound,
];

// ---------------------------------------------------------------- P7 · Hierarchical teams

const LEADS = { 'lead-warm-1': ['red-1', 'orange-1'], 'lead-cool-1': ['blue-1', 'violet-1'] } as const;

/**
 * The conversation's calls with each one's parent from its channel.call_opened, or why they cannot be read.
 * @returns the top call, each lead's call and the parent map, or a string naming why they cannot be read.
 */
function hierarchy(r: ScenarioRecord):
  | {
      readonly top: CallRecord;
      readonly children: Readonly<Record<string, CallRecord>>;
      readonly parents: ReadonlyMap<string, unknown>;
    }
  | string {
  let calls: CallRecord[];
  try {
    calls = callsOf(r);
  } catch (error) {
    return (error as Error).message;
  }
  const parents = new Map(logged(r, 'channel.call_opened').map((x) => [String(x['call']), x['parent']]));
  const tops = calls.filter((c) => c.caller === 'top-1');
  if (tops.length !== 1) return `${String(tops.length)} calls by top-1`;
  const children: Record<string, CallRecord> = {};
  for (const lead of Object.keys(LEADS)) {
    const theirs = calls.filter((c) => c.caller === lead);
    if (theirs.length !== 1) return `${String(theirs.length)} calls by ${lead}`;
    children[lead] = present(theirs[0], 'theirs[0]');
  }
  return { top: present(tops[0], 'tops[0]'), children, parents };
}

/** Is `n` in `text` with no digit, letter or hyphen beside it, in the order given? */
const inOrder = (text: string, numbers: readonly string[]): boolean =>
  new RegExp(numbers.map((n) => `(?<![\\w-])${n}(?![\\w-])`).join('[\\s\\S]*')).test(text);

export const P07_A: readonly Claim[] = [
  {
    claim: "top-1's one call goes to exactly the two leads, and to no worker",
    check: (r) => {
      const h = hierarchy(r);
      if (typeof h === 'string') return fails(h);
      return JSON.stringify([...h.top.addressees].sort(byCodeUnit)) === JSON.stringify(['lead-cool-1', 'lead-warm-1'])
        ? holds(callLine(h.top))
        : fails(callLine(h.top));
    },
  },
  {
    claim:
      "each lead opens its own call to exactly its two workers, after top-1's question and before answering it, recorded as a child of top-1's call",
    check: (r) => {
      const h = hierarchy(r);
      if (typeof h === 'string') return fails(h);
      const wrong: string[] = [];
      for (const [lead, workers] of Object.entries(LEADS)) {
        const child = present(h.children[lead], `children[${lead}]`);
        if (JSON.stringify([...child.addressees].sort(byCodeUnit)) !== JSON.stringify([...workers].sort(byCodeUnit)))
          wrong.push(callLine(child));
        if (h.parents.get(child.id) !== h.top.id)
          wrong.push(`${child.id}'s parent is ${String(h.parents.get(child.id))}, not ${h.top.id}`);
        const asked = h.top.questions.find((q) => q.to === lead);
        const answered = h.top.answers.find((a) => a.from === lead);
        const first = child.questions[0];
        if (asked === undefined || first === undefined || first.index < asked.index)
          wrong.push(`${lead}'s call before top-1's question to it`);
        if (answered !== undefined && (child.gather === null || answered.index < child.gather.index))
          wrong.push(`${lead} answered top-1 before its call gathered`);
      }
      return wrong.length === 0
        ? holds(
            Object.values(h.children)
              .map((c) => `${callLine(c)} (parent ${h.top.id})`)
              .join('; '),
          )
        : fails(wrong.join('; '));
    },
  },
  {
    claim: "lead-warm-1's answer holds 4 then 7, lead-cool-1's 3 then 2",
    check: (r) => {
      const h = hierarchy(r);
      if (typeof h === 'string') return fails(h);
      const warm = h.top.answers.find((a) => a.from === 'lead-warm-1')?.text ?? '';
      const cool = h.top.answers.find((a) => a.from === 'lead-cool-1')?.text ?? '';
      const ok =
        inOrder(warm, ['4', '7']) &&
        inOrder(cool, ['3', '2']) &&
        !/(?<![\w-])[47](?![\w-])/.test(cool) &&
        !/(?<![\w-])[32](?![\w-])/.test(warm);
      return ok
        ? holds(`lead-warm-1 ${JSON.stringify(warm)}; lead-cool-1 ${JSON.stringify(cool)}`)
        : fails(`lead-warm-1 ${JSON.stringify(warm)}; lead-cool-1 ${JSON.stringify(cool)}`);
    },
  },
  {
    claim: 'one gather to top-1, with two answered',
    check: (r) => {
      const h = hierarchy(r);
      if (typeof h === 'string') return fails(h);
      const gatherLine = h.top.gather === null ? 'none' : `to ${String(h.top.gather.to)}`;
      return h.top.gather !== null && h.top.gather.to === 'top-1' && h.top.counts?.['answered'] === 2
        ? holds(`gather of ${h.top.id}: ${JSON.stringify(h.top.counts)}`)
        : fails(`gather ${gatherLine}; counts ${JSON.stringify(h.top.counts)}`);
    },
  },
  {
    claim: 'exactly one output, from top-1: warm then 4, 7, and cool then 3, 2',
    check: (r) => {
      const found = outputs(r);
      const text = replyText(r);
      const notFound = `outputs: ${found.map((o) => o.from).join(', ') || 'none'}; ${JSON.stringify(text)}`;
      if (found.length !== 1) return fails(notFound);
      const out = present(found[0], 'found[0]');
      return out.from === 'top-1' && /warm\D*4\D*7[\s\S]*cool\D*3\D*2/i.test(text)
        ? holds(`${line(out)} ${JSON.stringify(text)}`)
        : fails(notFound);
    },
  },
  {
    // Every file of the team folder (patterns-phase-2 R3), step numbers aside; a number with no digit, letter or hyphen beside it.
    claim: "each number is in its worker's files only — 4 red, 7 orange, 3 blue, 2 violet — step numbers aside",
    check: (r) => {
      const owners: Readonly<Record<string, string>> = { '4': 'red', '7': 'orange', '3': 'blue', '2': 'violet' };
      const wrong: string[] = [];
      for (const [n, worker] of Object.entries(owners)) {
        const pattern = new RegExp(`(?<![\\w-])${n}(?![\\w-])`);
        const found = Object.keys(r.team).filter((f) =>
          pattern.test(withoutStepNumbers(present(r.team[f], `team[${f}]`))),
        );
        if (found.length === 0 || found.some((f) => !f.startsWith(`${worker}.`)))
          wrong.push(`${n} in ${found.join(', ') || 'no file'}`);
      }
      return wrong.length === 0
        ? holds('4 only in red.*, 7 only in orange.*, 3 only in blue.*, 2 only in violet.*')
        : fails(wrong.join('; '));
    },
  },
  declaredErrors('no error-level record', {}),
  exitCode(0),
  withinBound,
];

/** Every phase-3 scenario's checker, by id, as each is built (the plan's steps 4–9). */
export const PHASE_3: Readonly<Record<string, readonly Claim[]>> = {
  'p25-a': P25_A,
  'p25-b': P25_B,
  'p17-a': P17_A,
  'p17-b': P17_B,
  'p21-a': P21_A,
  'p21-b': P21_B,
  'p22-b': P22_B,
  'p15-a': P15_A,
  'p15-b': P15_B,
  'p19-a': P19_A,
  'p07-a': P07_A,
};
