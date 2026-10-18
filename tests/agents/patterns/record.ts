// What a pattern scenario's checker reads, and how it answers
// (docs/plans/orchestration-patterns.md R10, R13): the records of one recorded
// run, and for each claim of the scenario's proof either its evidence — the
// transcript line, log record or recipe line that shows it — or why it fails.
// A checker holds the scenario's assertions once: the agent-suite scenario calls
// it on its run, and tests/unit/pattern-proofs.test.ts on committed fixtures,
// one per mutation the scenario lists, each of which must fail naming its claim.

import { present } from '../../../src/shared/assert-present.js';
import type { BlackboardEntry } from '../../../src/shared/protocol.js';
import type { TranscriptEvent } from '../support.js';

/** One ./asha run: its arguments, exit code, stdout and the transcript read from its stderr (parseTranscript). */
export interface RunRecord {
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly events: readonly TranscriptEvent[];
  readonly ms: number;
}

/** A daemon log record (logs/daemon.jsonl), as JSON. */
export type LogRecord = Readonly<Record<string, unknown>>;

/** Everything a scenario's checker reads. */
export interface ScenarioRecord {
  readonly scenario: string;
  /** The scenario's first command's run. */
  readonly run: RunRecord;
  /**
   * Every command's run, in order: the one command's, or each of a scenario of several commands, a later one answering
   * in the first one's conversation (docs/plans/patterns-phase-3.md R9). `runs[0]` is `run`.
   */
  readonly runs: readonly RunRecord[];
  /** The conversation the scenario's message started. */
  readonly conversation: string;
  /**
   * The daemon log records carrying that conversation id, in order — and, for a scenario that reads them, the scenario's
   * members' own records from its start, which carry no conversation (`agent.*`, `channel.rejoined`, …; patterns-phase-3
   * R3), in the log's order.
   */
  readonly log: readonly LogRecord[];
  /** The team folder's files as text, by path relative to teams/<team>/. */
  readonly team: Readonly<Record<string, string>>;
  /** The pattern's bound on its request, from its page's run-command block (patterns-phase-1 R4). */
  readonly boundMs: number;
  /**
   * The handle of every delivery the conversation's trace records (its asha.delivery spans), in start order: an input,
   * a message to an agent, a call's question, a gather. A call's answer and a reply go to no agent (patterns-phase-2 R3).
   */
  readonly deliveries: readonly string[];
  /** The agent-log records of the members a scenario reads them for, by handle, in order (patterns-phase-2 R3). */
  readonly agentLogs: Readonly<Record<string, readonly LogRecord[]>>;
  /** Files read from a member's /workspace after the command exited, by handle and path; null: it did not exist. */
  readonly workspace: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  /**
   * The scenario's board entries, for a scenario that reads them (docs/plans/patterns-phase-4.md R6, R7): every entry
   * posted after the last one before its first command, read through `GET /v1/blackboard` after its commands exited.
   * Absent for every other scenario.
   */
  readonly board?: readonly BlackboardEntry[];
}

/** One claim of the proof and the evidence that shows it. */
interface ProofItem {
  readonly claim: string;
  readonly evidence: string;
}

export interface CheckResult {
  /** Every claim that holds, with its evidence, in the scenario's order. */
  readonly proof: readonly ProofItem[];
  /** Every claim that does not, as `<claim>: <why>`. Empty when the scenario passes. */
  readonly failures: readonly string[];
}

export type Verdict = { readonly ok: true; readonly evidence: string } | { readonly ok: false; readonly why: string };

/** One claim: its text as the proof shows it, and how it is checked. */
export interface Claim {
  readonly claim: string;
  readonly check: (record: ScenarioRecord) => Verdict;
}

export const holds = (evidence: string): Verdict => ({ ok: true, evidence });
export const fails = (why: string): Verdict => ({ ok: false, why });

/** Checks every claim; a claim whose check throws fails with the thrown message (a record missing a field it reads). */
export function runClaims(record: ScenarioRecord, claims: readonly Claim[]): CheckResult {
  const proof: ProofItem[] = [];
  const failures: string[] = [];
  for (const c of claims) {
    let verdict: Verdict;
    try {
      verdict = c.check(record);
    } catch (error) {
      verdict = fails(`the check could not read the record: ${(error as Error).message}`);
    }
    if (verdict.ok) proof.push({ claim: c.claim, evidence: verdict.evidence });
    else failures.push(`${c.claim}: ${verdict.why}`);
  }
  return { proof, failures };
}

// ---------------------------------------------------------------- reading the records

/** The transcript's line for an event, as the CLI printed it. */
export function line(e: TranscriptEvent): string {
  switch (e.type) {
    case 'posted': {
      const to = e.to === null ? '' : `${e.to} on `;
      return `› ${e.from} → ${to}…: ${e.text}`;
    }
    case 'status':
      return `› ${e.from}: ${e.text}`;
    case 'output':
      return `› output ${e.from} → ${e.to}:`;
    case 'internal':
      return `› internal ${e.from} → ${e.to ?? 'all agents'}: ${e.text}`;
    case 'failure':
      return `✗ ${e.text}`;
    case 'progress':
      return `› ${e.text}`;
  }
}

export type Internal = Extract<TranscriptEvent, { type: 'internal' }>;
export type Output = Extract<TranscriptEvent, { type: 'output' }>;
export type Status = Extract<TranscriptEvent, { type: 'status' }>;

export const internals = (r: ScenarioRecord): Internal[] =>
  r.run.events.filter((e): e is Internal => e.type === 'internal');
export const outputs = (r: ScenarioRecord): Output[] => r.run.events.filter((e): e is Output => e.type === 'output');
export const statuses = (r: ScenarioRecord, from?: string): Status[] =>
  r.run.events.filter((e): e is Status => e.type === 'status' && (from === undefined || e.from === from));
/** `pass: …` statuses (an agent's announced pass). */
const passes = (r: ScenarioRecord, from?: string): Status[] =>
  statuses(r, from).filter((e) => e.text.startsWith('pass'));
/** The daemon log's records of one event. */
export const logged = (r: ScenarioRecord, event: string): LogRecord[] => r.log.filter((x) => x['event'] === event);
/** `channel.posted` records: every message of the conversation as the channel logged it. */
export const postedLog = (r: ScenarioRecord): LogRecord[] => logged(r, 'channel.posted');
/** A log record, short, as evidence. */
export const logLine = (x: LogRecord): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(x).filter(([k]) => ['event', 'from', 'to', 'kind', 'call', 'caller', 'addressees'].includes(k)),
    ),
  );

/** The replies' text: stdout, one reply per line, without its final newline (patterns-phase-1 R3). */
export const replyText = (r: ScenarioRecord): string => r.run.stdout.replace(/\n$/, '');

// ---------------------------------------------------------------- claims every scenario can use

/** The command exited with `code`. */
export const exitCode = (code: number): Claim => ({
  claim: `the command exits ${String(code)}`,
  check: (r) => (r.run.code === code ? holds(`exit ${String(r.run.code)}`) : fails(`exit ${String(r.run.code)}`)),
});

/** No `internal` message at all. */
export const noInternal: Claim = {
  claim: 'no agent posts an internal message',
  check: (r) => {
    const found = internals(r);
    return found.length === 0
      ? holds('no "› internal" line in the transcript')
      : fails(`found ${found.map(line).join(' | ')}`);
  },
};

/** No call was opened in the conversation (a hand-off, not a call). */
export const noCall: Claim = {
  claim: 'no call is opened in the conversation (channel.call_opened)',
  check: (r) => {
    const found = logged(r, 'channel.call_opened');
    return found.length === 0
      ? holds(`no channel.call_opened among the conversation's ${String(r.log.length)} daemon log records`)
      : fails(`found ${found.map(logLine).join(' | ')}`);
  },
};

/** Exactly one output, from `from`, whose text (the reply, replyText) matches `text`. */
export const oneOutputFrom = (from: string, text: RegExp): Claim => ({
  claim: `exactly one output, from ${from}, matching ${String(text)}`,
  check: (r) => {
    const found = outputs(r);
    if (found.length !== 1) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
    const out = present(found[0], 'found[0]');
    if (out.from !== from) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
    return text.test(replyText(r))
      ? holds(`${line(out)} ${JSON.stringify(replyText(r))}`)
      : fails(`its text ${JSON.stringify(replyText(r))} does not match`);
  },
});

/** The request completed within the pattern's bound (orchestration-patterns R8; patterns-phase-1 R4): every command of it (patterns-phase-3 R4). */
export const withinBound: Claim = {
  claim: "the request completes within the pattern's bound",
  check: (r) => {
    const over = r.runs.filter((run) => run.ms > r.boundMs);
    const times = r.runs.map((run) => `${String(run.ms)} ms`).join(', ');
    return over.length === 0
      ? holds(`${times} of ${String(r.boundMs)} ms`)
      : fails(`${times}: over ${String(r.boundMs)} ms`);
  },
};

/** Exactly one `pass: …` status from `from`. */
export const onePass = (from: string): Claim => ({
  claim: `${from} posts exactly one "pass: …" status`,
  check: (r) => {
    const found = passes(r, from);
    return found.length === 1
      ? holds(line(present(found[0], 'found[0]')))
      : fails(`${String(found.length)} pass statuses from ${from}`);
  },
});

/** A word (as a whole word, any case) appears in exactly one member's document, `file`. */
export const inOneDocument = (word: string, file: string): Claim => ({
  claim: `"${word}" appears in exactly one member's document, ${file}`,
  check: (r) => {
    const pattern = new RegExp(`\\b${word}\\b`, 'i');
    const docs = Object.keys(r.team).filter((p) => p.endsWith('.md'));
    const found = docs.filter((p) => pattern.test(present(r.team[p], `team[${p}]`)));
    if (found.length === 1 && found[0] === file) {
      const doc = present(r.team[file], 'team[' + file + ']');
      return holds(`${file}: ${JSON.stringify(doc.split('\n').find((l) => pattern.test(l)))}`);
    }
    return fails(`found in ${found.join(', ') || 'no document'}`);
  },
});

// ---------------------------------------------------------------- calls (patterns-phase-2 R3)

/**
 * Text as a containment check compares it: trimmed, every run of whitespace one space, case kept
 * (orchestration-patterns #demo-conventions, "Containment").
 */
export const squash = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** Does `haystack` contain `needle`, both squashed? */
export const containsText = (haystack: string, needle: string): boolean => squash(haystack).includes(squash(needle));

/** An internal message of the conversation: the transcript's line, with the call id and role the daemon logged for it. */
export interface CallMessage {
  /** Its position in `run.events`. */
  readonly index: number;
  readonly from: string;
  readonly to: string | null;
  readonly text: string;
  readonly call: string | null;
  readonly role: 'question' | 'answer' | 'gather' | null;
}

/**
 * Every internal message, in order, each paired with its `channel.posted` record: the transcript has the text, the log
 * the call id and role. The two list the same messages in the same order (the channel logs a message and then shows
 * it); a count or a sender that differs throws, and the claim reading it fails with the reason.
 */
export function internalMessages(r: ScenarioRecord): CallMessage[] {
  const shown = r.run.events.flatMap((e, index) => (e.type === 'internal' ? [{ e, index }] : []));
  const posted = postedLog(r).filter((x) => x['kind'] === 'internal');
  if (shown.length !== posted.length)
    throw new Error(
      `${String(shown.length)} internal messages in the transcript, ${String(posted.length)} internal channel.posted records`,
    );
  return shown.map(({ e, index }, k) => {
    const x = present(posted[k], `posted[${String(k)}]`);
    if (x['from'] !== e.from || (x['to'] ?? null) !== e.to) {
      throw new Error(
        `internal message ${String(k + 1)}: the transcript's ${e.from} → ${e.to ?? 'all agents'}, the log's ${String(x['from'])} → ${String(x['to'])}`,
      );
    }
    const role = x['role'];
    return {
      index,
      from: e.from,
      to: e.to,
      text: e.text,
      call: typeof x['call'] === 'string' ? x['call'] : null,
      role: role === 'question' || role === 'answer' || role === 'gather' ? role : null,
    };
  });
}

/** One call of the conversation: who opened it, whom it asked, its questions, answers and gather, as they happened. */
export interface CallRecord {
  readonly id: string;
  readonly caller: string;
  /** In request order (channel.call_opened). */
  readonly addressees: readonly string[];
  /** In posting order. */
  readonly questions: readonly CallMessage[];
  /** In arrival order. */
  readonly answers: readonly CallMessage[];
  readonly gather: CallMessage | null;
  /** Its outcome counts (channel.call_gathered), or null when it was never gathered. */
  readonly counts: Readonly<Record<string, number>> | null;
}

/** Every call the conversation opened, in order (channel.call_opened), with its messages. */
export function callsOf(r: ScenarioRecord): CallRecord[] {
  const messages = internalMessages(r);
  return logged(r, 'channel.call_opened').map((opened) => {
    const id = String(opened['call']);
    const mine = messages.filter((m) => m.call === id);
    const gathered = logged(r, 'channel.call_gathered').find((g) => g['call'] === id);
    const gathers = mine.filter((m) => m.role === 'gather');
    if (gathers.length > 1) throw new Error(`call ${id} has ${String(gathers.length)} gathers`);
    return {
      id,
      caller: String(opened['caller']),
      addressees: (opened['addressees'] as readonly unknown[]).map(String),
      questions: mine.filter((m) => m.role === 'question'),
      answers: mine.filter((m) => m.role === 'answer'),
      gather: gathers[0] ?? null,
      counts: gathered === undefined ? null : (gathered['counts'] as Record<string, number>),
    };
  });
}

/** A call, short, as evidence: `call k1 lead-1 → worker-a-1, worker-b-1`. */
export const callLine = (c: CallRecord): string => `call ${c.id} ${c.caller} → ${c.addressees.join(', ')}`;

/** Internal messages that belong to no call (a send_message). */
export const outsideCalls = (r: ScenarioRecord): CallMessage[] => internalMessages(r).filter((m) => m.call === null);

/** The conversation's error-level daemon log records. */
export const errorRecords = (r: ScenarioRecord): LogRecord[] => r.log.filter((x) => x['level'] === 'error');

/**
 * A document's text without its numbered steps' own numbers: the k-th line starting "k. " and a capital letter loses
 * that prefix (the rainbow's rule, collaborating-agents' completion review), so "2. When …" holds no fact 2; a list
 * line such as "4. red", or a step out of sequence, is kept whole.
 */
export function withoutStepNumbers(text: string): string {
  let k = 0;
  return text
    .split('\n')
    .map((l) => {
      const m = /^(\d+)\. (?=[A-Z])/.exec(l);
      if (m === null || Number(m[1]) !== k + 1) return l;
      k += 1;
      return l.slice(m[0].length);
    })
    .join('\n');
}

/**
 * The one output and its position in the transcript, or why there is not exactly one.
 * @returns the output and its index, or a string naming why there is not exactly one.
 */
export function theOutput(r: ScenarioRecord): { readonly output: Output; readonly index: number } | string {
  const found = outputs(r);
  if (found.length !== 1) return `${String(found.length)} outputs: ${found.map((o) => o.from).join(', ') || 'none'}`;
  const out = present(found[0], 'found[0]');
  return { output: out, index: r.run.events.indexOf(out) };
}
