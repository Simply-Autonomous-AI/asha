// The phase-4 scenarios' checkers (docs/plans/patterns-phase-4.md R7): P11's p11-a and p11-b, each claim as the plan's
// Scenarios lists it, read only from the run's exit code, stdout and transcript (the --verbose tool-call lines among
// them), the daemon log's records of the conversation and its members' blackboard.posted records, the scenario's board
// entries read through GET /v1/blackboard, and the team folder. Each is run by tests/agents/p11-blackboard.test.ts on
// its recorded run, and by tests/unit/pattern-proofs.test.ts on its fixtures, one per listed mutation, each failing
// naming the claim it breaks.

import { present } from '../../../src/shared/assert-present.js';
import { byCodeUnit } from '../../../src/shared/order.js';
import type { BlackboardEntry } from '../../../src/shared/protocol.js';
import {
  callLine,
  callsOf,
  errorRecords,
  exitCode,
  fails,
  holds,
  internalMessages,
  line,
  replyText,
  squash,
  theOutput,
  withinBound,
  type CallMessage,
  type CallRecord,
  type Claim,
  type ScenarioRecord,
} from './record.js';

// ---------------------------------------------------------------- reading the records

/** A fact or item in a text: matched only where no letter, digit or hyphen is beside it (R7); items case-insensitively. */
function holdsFact(text: string, fact: string, caseless: boolean): boolean {
  const escaped = fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, caseless ? 'i' : '').test(text);
}

/** The scenario's board entries in id order; a record that read none fails the claim reading it. */
function boardOf(r: ScenarioRecord): readonly BlackboardEntry[] {
  if (r.board === undefined) throw new Error('the record holds no board: the scenario did not read it');
  return [...r.board].sort((a, b) => a.id - b.id);
}

/** An entry, short, as evidence. */
const entryLine = (e: BlackboardEntry): string => `#${String(e.id)} ${e.author}: ${JSON.stringify(e.text)}`;

/** A fact or a member's name, quoted — its own template, so quoting one inside another's "${…}" never nests them. */
const quoted = (s: string): string => `"${s}"`;

/** An internal message, short, as evidence: `from → to: "text"`. */
const carriedLine = (m: CallMessage): string => `${m.from} → ${m.to ?? 'all agents'}: ${JSON.stringify(m.text)}`;

/** An internal message outside a call, short, as evidence: `from → to (role)`. */
const strayLine = (m: CallMessage): string => `${m.from} → ${m.to ?? 'all agents'} (${m.role ?? 'no call'})`;

/** A call's question, short, as evidence: `to: "text"`. */
const questionLine = (q: CallMessage): string => `${String(q.to)}: ${JSON.stringify(q.text)}`;

/** The positions, in the transcript, of `handle`'s `tool` calls as --verbose prints them (`<handle> <tool>: {…}`). */
function toolLines(r: ScenarioRecord, handle: string, tool: string): number[] {
  const prefix = `${handle} ${tool}: `;
  return r.run.events.flatMap((e, i) => (e.type === 'progress' && e.text.startsWith(prefix) ? [i] : []));
}

/** The log position of a call's message with `role` (its channel.posted record). */
function rolePosted(r: ScenarioRecord, call: string, role: 'question' | 'gather'): number {
  return r.log.findIndex((x) => x['event'] === 'channel.posted' && x['call'] === call && x['role'] === role);
}

/** The log positions of `author`'s blackboard.posted records. */
const boardPosts = (r: ScenarioRecord, author: string): number[] =>
  r.log.flatMap((x, i) => (x['event'] === 'blackboard.posted' && x['author'] === author ? [i] : []));

/** `handle`'s first board post, short, as evidence: `handle at <position>`. */
const boardPostLine = (r: ScenarioRecord, handle: string): string => `${handle} at ${String(boardPosts(r, handle)[0])}`;

/** `handle`'s board posts, short, as evidence: `handle at [<positions>]`. */
const boardPostsLine = (r: ScenarioRecord, handle: string): string =>
  `${handle} at [${boardPosts(r, handle).join(', ')}]`;

/**
 * Each fact in the files of exactly one member — its recipe `<member>.json` and its document `<member>.md` — and in no
 * other file of the team folder (R7: every text an agent is given).
 */
function factsInOneMember(facts: readonly (readonly [fact: string, member: string])[], caseless: boolean): Claim {
  return {
    claim: `each of ${facts.map(([f]) => quoted(f)).join(', ')} appears in the files of exactly one member, and in no other file of the team folder`,
    check: (r) => {
      const wrong: string[] = [];
      const shown: string[] = [];
      for (const [fact, member] of facts) {
        const found = Object.keys(r.team)
          .sort(byCodeUnit)
          .filter((path) => holdsFact(present(r.team[path], `team[${path}]`), fact, caseless));
        const own = [`${member}.json`, `${member}.md`];
        const outside = found.filter((p) => !own.includes(p));
        if (outside.length > 0 || found.length === 0) wrong.push(`"${fact}" in ${found.join(', ') || 'no file'}`);
        else shown.push(`"${fact}": ${found.join(', ')}`);
      }
      return wrong.length === 0 ? holds(shown.join('; ')) : fails(wrong.join('; '));
    },
  };
}

/** No internal message holds any of `facts`, and every internal message is a call's question, its answer or its gather. */
function nothingCarried(facts: readonly string[], caseless: boolean, lead: string): Claim {
  return {
    claim: `no internal message of the conversation holds ${facts.map((f) => quoted(f)).join(', ')}, and every internal message is a call's question from ${lead}, an answer to ${lead}, or a gather: no member messages another`,
    check: (r) => {
      const messages = internalMessages(r);
      const carrying = messages.filter((m) => facts.some((f) => holdsFact(m.text, f, caseless)));
      const stray = messages.filter(
        (m) =>
          !(
            (m.role === 'question' && m.from === lead) ||
            (m.role === 'answer' && m.to === lead) ||
            (m.role === 'gather' && m.to === lead)
          ),
      );
      if (carrying.length > 0) return fails(`carried: ${carrying.map(carriedLine).join(' | ')}`);
      if (stray.length > 0) return fails(`outside a call: ${stray.map(strayLine).join(' | ')}`);
      return holds(
        `${String(messages.length)} internal messages, each a question, an answer or a gather, none holding a fact`,
      );
    },
  };
}

/** No error-level record in the conversation's or the members' records. */
const noErrorRecord: Claim = {
  claim: 'no error-level record',
  check: (r) => {
    const found = errorRecords(r);
    return found.length === 0
      ? holds(`none among the scenario's ${String(r.log.length)} records`)
      : fails(found.map((x) => String(x['event'])).join(', '));
  },
};

/** `handle` calls blackboard_read after transcript position `after` and before the output. */
function readsAfter(handle: string, what: string, position: (r: ScenarioRecord) => number | string): Claim {
  return {
    claim: `${handle} calls blackboard_read after ${what} and before its output`,
    check: (r) => {
      const after = position(r);
      if (typeof after === 'string') return fails(after);
      const out = theOutput(r);
      if (typeof out === 'string') return fails(out);
      const reads = toolLines(r, handle, 'blackboard_read').filter((i) => i > after && i < out.index);
      if (reads.length > 0) {
        const first = present(reads[0], 'reads[0]');
        const event = present(r.run.events[first], `r.run.events[${String(first)}]`);
        return holds(
          `${line(event)} at line ${String(first)}, after ${what} (${String(after)}) and before the output (${String(out.index)})`,
        );
      }
      return fails(
        `no "${handle} blackboard_read:" line between ${what} (${String(after)}) and the output (${String(out.index)})`,
      );
    },
  };
}

// ---------------------------------------------------------------- P11 · p11-a, the shopping list

const CONTRIBUTORS = ['contrib-a-1', 'contrib-b-1', 'contrib-c-1'] as const;
/** Each item and the member whose files hold it. */
const ITEMS = [
  ['saffron', 'contrib-a'],
  ['quince jam', 'contrib-b'],
  ['rye flour', 'contrib-c'],
] as const;
const ASK_ITEM = 'Post your item to the blackboard.';

/**
 * A reply's list lines (claim 7): every non-empty line that does not end with ":" (a heading), with a leading "- ", "* ",
 * "• " or "<n>. " and an "item: " taken off, and a final "." — lower-cased.
 */
function listLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.endsWith(':'))
    .map((l) =>
      l
        .replace(/^(?:[-*•]|\d+\.)\s+/, '')
        .replace(/^item:\s*/i, '')
        .replace(/\.$/, '')
        .trim()
        .toLowerCase(),
    );
}

/** The editor's one call (claim 2), or why there is not exactly one. */
function theCall(r: ScenarioRecord): CallRecord | string {
  const calls = callsOf(r);
  return calls.length === 1
    ? present(calls[0], 'calls[0]')
    : `${String(calls.length)} calls: ${calls.map(callLine).join(' | ') || 'none'}`;
}

export const P11_A: readonly Claim[] = [
  exitCode(0),
  {
    claim: `one call, by editor-1, to exactly ${CONTRIBUTORS.join(', ')}, each question exactly "${ASK_ITEM}"`,
    check: (r) => {
      const c = theCall(r);
      if (typeof c === 'string') return fails(c);
      const to = [...c.addressees].sort(byCodeUnit);
      if (c.caller !== 'editor-1' || JSON.stringify(to) !== JSON.stringify([...CONTRIBUTORS]))
        return fails(callLine(c));
      const wrong = c.questions.filter((q) => squash(q.text) !== ASK_ITEM);
      return wrong.length === 0 && c.questions.length === 3
        ? holds(`${callLine(c)}; questions: ${c.questions.map((q) => JSON.stringify(q.text)).join(', ')}`)
        : fails(`questions: ${c.questions.map(questionLine).join(' | ')}`);
    },
  },
  {
    claim:
      "the scenario's board entries, read through GET /v1/blackboard, are exactly item: saffron by contrib-a-1, item: quince jam by contrib-b-1 and item: rye flour by contrib-c-1, in any order: three distinct authors",
    check: (r) => {
      const board = boardOf(r);
      const want = ITEMS.map(([item], k) => `${String(CONTRIBUTORS[k])}: item: ${item}`).sort(byCodeUnit);
      const got = board.map((e) => `${e.author}: ${squash(e.text)}`).sort(byCodeUnit);
      return JSON.stringify(got) === JSON.stringify(want)
        ? holds(board.map(entryLine).join('; '))
        : fails(`entries: ${board.map(entryLine).join('; ') || 'none'}`);
    },
  },
  {
    claim: "each contributor's blackboard.posted is logged before the call's gather",
    check: (r) => {
      const c = theCall(r);
      if (typeof c === 'string') return fails(c);
      const gather = rolePosted(r, c.id, 'gather');
      if (gather === -1) return fails(`no gather of ${callLine(c)} in the log`);
      const late = CONTRIBUTORS.filter((h) => {
        const posts = boardPosts(r, h);
        return posts.length !== 1 || present(posts[0], 'posts[0]') > gather;
      });
      return late.length === 0
        ? holds(`${CONTRIBUTORS.map((h) => boardPostLine(r, h)).join(', ')}; the gather at ${String(gather)}`)
        : fails(
            `not exactly one blackboard.posted before the gather (${String(gather)}): ${late.map((h) => boardPostsLine(r, h)).join('; ')}`,
          );
    },
  },
  nothingCarried(
    ITEMS.map(([i]) => i),
    true,
    'editor-1',
  ),
  readsAfter('editor-1', 'the gather', (r) => {
    const gathers = internalMessages(r).filter((m) => m.role === 'gather');
    return gathers.length === 1 ? present(gathers[0], 'gathers[0]').index : `${String(gathers.length)} gathers`;
  }),
  {
    claim:
      "exactly one output, from editor-1, whose list lines are exactly the board's items, in the board's order: each entry's item, and no item that is not on the board",
    check: (r) => {
      const out = theOutput(r);
      if (typeof out === 'string') return fails(out);
      if (out.output.from !== 'editor-1') return fails(`the output is ${out.output.from}'s`);
      const items = boardOf(r)
        .filter((e) => squash(e.text).toLowerCase().startsWith('item:'))
        .map((e) => squash(e.text.slice(e.text.indexOf(':') + 1)).toLowerCase());
      const listed = listLines(replyText(r));
      return items.length > 0 && JSON.stringify(listed) === JSON.stringify(items)
        ? holds(`${line(out.output)} ${JSON.stringify(replyText(r))}: ${listed.join(', ')}, the board's order`)
        : fails(`listed ${JSON.stringify(listed)}, the board's items ${JSON.stringify(items)}`);
    },
  },
  factsInOneMember(ITEMS, true),
  noErrorRecord,
  withinBound,
];

// ---------------------------------------------------------------- P11 · p11-b, the meeting notice

const NOTES = ['note-day-1', 'note-room-1', 'note-time-1'] as const;
/** Each fact, the member whose files hold it, and the entry it first appears in. */
const FACTS = [
  ['Thursday', 'note-day'],
  ['Juniper', 'note-room'],
  ['14:30', 'note-time'],
] as const;
const ASK_PART = 'Add your part to the notice on the blackboard.';

/**
 * planner-1's calls, or why there are not exactly three, one per note member in order.
 * @returns the three calls in order, or a string naming why there are not exactly three in order.
 */
function theCalls(r: ScenarioRecord): CallRecord[] | string {
  const calls = callsOf(r);
  if (calls.length !== 3) return `${String(calls.length)} calls: ${calls.map(callLine).join(' | ') || 'none'}`;
  const wrong = calls.filter(
    (c, k) => c.caller !== 'planner-1' || c.addressees.length !== 1 || c.addressees[0] !== NOTES[k],
  );
  return wrong.length === 0 ? calls : `calls: ${calls.map(callLine).join(' | ')}`;
}

export const P11_B: readonly Claim[] = [
  exitCode(0),
  {
    claim: `planner-1 opens exactly three calls, in order to ${NOTES.join(', ')}, one addressee each, each question exactly "${ASK_PART}", each opened after the previous call's gather`,
    check: (r) => {
      const calls = theCalls(r);
      if (typeof calls === 'string') return fails(calls);
      const bad = calls.flatMap((c) => c.questions.filter((q) => squash(q.text) !== ASK_PART).map(questionLine));
      if (bad.length > 0) return fails(`questions: ${bad.join(' | ')}`);
      const opened = calls.map((c) =>
        r.log.findIndex((x) => x['event'] === 'channel.call_opened' && x['call'] === c.id),
      );
      for (let k = 1; k < calls.length; k++) {
        const previous = present(calls[k - 1], 'calls[k - 1]');
        const previousGather = rolePosted(r, previous.id, 'gather');
        const openedAtK = present(opened[k], 'opened[k]');
        if (previousGather === -1 || openedAtK < previousGather)
          return fails(
            `${callLine(present(calls[k], 'calls[k]'))} opened at ${String(openedAtK)}, the previous gather at ${String(previousGather)}`,
          );
      }
      return holds(
        calls.map((c, k) => `${callLine(c)} opened at ${String(present(opened[k], 'opened[k]'))}`).join('; '),
      );
    },
  },
  {
    claim:
      "the scenario's board entries are exactly three, in id order by note-day-1, note-room-1 and note-time-1, each starting notice:, each posted while its call was open (between its question and its gather)",
    check: (r) => {
      const board = boardOf(r);
      if (board.length !== 3 || board.some((e, k) => e.author !== NOTES[k] || !squash(e.text).startsWith('notice:')))
        return fails(`entries: ${board.map(entryLine).join('; ') || 'none'}`);
      const calls = theCalls(r);
      if (typeof calls === 'string') return fails(calls);
      const outside = NOTES.filter((h, k) => {
        const posts = boardPosts(r, h);
        if (posts.length !== 1) return true;
        const post = present(posts[0], 'posts[0]');
        const call = present(calls[k], 'calls[k]');
        return post < rolePosted(r, call.id, 'question') || post > rolePosted(r, call.id, 'gather');
      });
      return outside.length === 0
        ? holds(board.map(entryLine).join('; '))
        : fails(`not posted while its call was open: ${outside.join(', ')}`);
    },
  },
  {
    claim:
      "each later entry builds on the earlier one: the first holds Thursday; the second starts with the first's text, word for word, and adds Juniper; the third starts with the second's and adds 14:30",
    check: (r) => {
      const [e1, e2, e3] = boardOf(r);
      if (e1 === undefined || e2 === undefined || e3 === undefined)
        return fails(`${String(boardOf(r).length)} entries`);
      const [a, b, c] = [squash(e1.text), squash(e2.text), squash(e3.text)];
      const wrong: string[] = [];
      if (!holdsFact(a, 'Thursday', false)) wrong.push(`the first, ${JSON.stringify(a)}, lacks Thursday`);
      if (!b.startsWith(a) || !holdsFact(b.slice(a.length), 'Juniper', false))
        wrong.push(`the second, ${JSON.stringify(b)}, is not the first followed by Juniper`);
      if (!c.startsWith(b) || !holdsFact(c.slice(b.length), '14:30', false))
        wrong.push(`the third, ${JSON.stringify(c)}, is not the second followed by 14:30`);
      return wrong.length === 0
        ? holds(`${JSON.stringify(a)} → ${JSON.stringify(b)} → ${JSON.stringify(c)}`)
        : fails(wrong.join('; '));
    },
  },
  factsInOneMember(FACTS, false),
  nothingCarried(
    FACTS.map(([f]) => f),
    false,
    'planner-1',
  ),
  {
    claim: 'note-room-1 and note-time-1 each call blackboard_read before their blackboard_post',
    check: (r) => {
      const shown: string[] = [];
      for (const h of ['note-room-1', 'note-time-1']) {
        const reads = toolLines(r, h, 'blackboard_read');
        const posts = toolLines(r, h, 'blackboard_post');
        if (posts.length === 0) return fails(`no "${h} blackboard_post:" line`);
        const post = present(posts[0], 'posts[0]');
        if (reads.length === 0 || present(reads[0], 'reads[0]') > post)
          return fails(`${h}: reads at [${reads.join(', ')}], its first post at ${String(post)}`);
        shown.push(`${h}: read at ${String(present(reads[0], 'reads[0]'))}, post at ${String(post)}`);
      }
      return holds(shown.join('; '));
    },
  },
  readsAfter('planner-1', 'the third gather', (r) => {
    const gathers = internalMessages(r).filter((m) => m.role === 'gather');
    return gathers.length === 3 ? present(gathers[2], 'gathers[2]').index : `${String(gathers.length)} gathers`;
  }),
  {
    claim:
      "exactly one output, from planner-1, holding each fact of the notice (Thursday, Juniper, 14:30), each as a whole word, and no item of the board's other entries",
    check: (r) => {
      const out = theOutput(r);
      if (typeof out === 'string') return fails(out);
      if (out.output.from !== 'planner-1') return fails(`the output is ${out.output.from}'s`);
      const text = replyText(r);
      // Each fact is in the last entry by claim 4 (each entry starts with the one before it); here, in the reply.
      const missing = FACTS.map(([f]) => f).filter((f) => !holdsFact(text, f, false));
      const items = ITEMS.map(([i]) => i).filter((i) => holdsFact(text, i, true));
      if (missing.length > 0) return fails(`missing ${missing.join(', ')} in ${JSON.stringify(text)}`);
      if (items.length > 0) return fails(`holds ${items.join(', ')}: ${JSON.stringify(text)}`);
      return holds(`${line(out.output)} ${JSON.stringify(text)}`);
    },
  },
  noErrorRecord,
  withinBound,
];

/** Every phase-4 checker, by scenario id. */
export const PHASE_4: Readonly<Record<string, readonly Claim[]>> = {
  'p11-a': P11_A,
  'p11-b': P11_B,
};
