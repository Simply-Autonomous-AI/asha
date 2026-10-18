// P20's checkers. p20-a's (docs/plans/patterns-phase-5.md, Scenarios): the commands of a supervisor waiting on its
// call when the daemon stops, and of its relaunch, over p20-a's slice of the daemon log and the team folder.
// p20-b's (docs/plans/agent-persistence.md A8, "Long-running supervisor"; orchestration-patterns R12, R13; its member
// moved into teams/resume/ as `tasker` by patterns-phase-5 R13):
// one checker over the run's records — the CLI transcripts of the four tasks and of the relaunch, the daemon log of
// both daemon runs, the supervisor's `tool.file_written` records of tasks.json in each run, and the persisted
// tasks.json — run by tests/agents/p20-resume.test.ts on a real run and by tests/unit/p20-checker.test.ts on the
// committed fixtures, one passing and one failing per mutation.

import { present } from '../../../src/shared/assert-present.js';
import { byCodeUnit } from '../../../src/shared/order.js';
import type { TranscriptEvent } from '../support.js';
import { fails, holds, type LogRecord, type Verdict } from './record.js';

/** One `./asha` command of the scenario. */
export interface P20Command {
  /** `task-1` … `task-4`, or `relaunch`. */
  readonly label: string;
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

export interface P20Record {
  readonly commands: readonly P20Command[];
  /** The daemon log of both runs, in order: the first run's, then the restarted daemon's (from its `daemon.started`). */
  readonly daemonLog: readonly LogRecord[];
  /** How many times the supervisor wrote tasks.json in each daemon run (its agent logs' `tool.file_written`). */
  readonly writes: { readonly first: number; readonly second: number };
  /** tasks.json as the persisted /workspace holds it after the relaunch's conversations settled. */
  readonly tasksJson: string;
  /** p20-b's bound on each command, ms (orchestration-patterns R8; at most 45,000). */
  readonly boundMs: number;
}

export interface P20Claim {
  readonly claim: string;
  readonly check: (r: P20Record) => Verdict;
}

/** p20-b's long-running member's identity: `tasker` of teams/resume/ on main (patterns-phase-5 R13; A8's `resume-tasks/supervisor` until then). */
export const P20_IDENTITY = 'main/resume/tasker';
/** The handles a relaunch of teams/resume prints, in its members' order. */
const RESUME_HANDLES = ['supervisor-1', 'worker-1', 'tasker-1'];

/**
 * P20's bound on each command, p20-b's too (orchestration-patterns R8): re-derived by patterns-phase-5 (its completion
 * review, finding 8) for p20-b as it now runs, in a three-member team — the largest of its three recorded runs'
 * commands, 15,582 ms (run 1's relaunch at 56b92e0), times 1.5, rounded up to a whole second: 24,000 ms, the page's
 * `# bound:` too (p20-a's largest, 15,559 ms, gives the same). It was 17,000 ms from A8's one-member runs (10,807 ms at
 * 5e8f1e3), which the three-member relaunch, 15,134–15,809 ms, came within 7 % of.
 *
 * 27,000 ms since 2026-10-10, when demo-model-pico R3 moved worker and tasker to pico-v2-q8_0: the largest of the three
 * recorded runs' commands with the move, p20-b's 17,391 ms in run 1 at 6eed097, times 1.5, rounded up to a whole second,
 * as the page's `# bound:` says (docs/patterns/p20-resume.md).
 */
export const P20_BOUND_MS = 27_000;
const CLOSED = /^✗ the daemon closed the conversation before it settled; see its log \(.+\)\n$/;
/** The CLI's note for a daemon file whose daemon no longer answers (findDaemon), said once per command. */
const STALE_NOTE = /^\(daemon file names port \d+, which did not answer: .+\)$/;
const RESUMING = /^› resuming your message from (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** The daemon log split at the restarted daemon's `daemon.started`: [first run, second run]. */
function runs(log: readonly LogRecord[]): [LogRecord[], LogRecord[]] {
  const starts = log.flatMap((x, i) => (x['event'] === 'daemon.started' ? [i] : []));
  if (starts.length !== 2)
    throw new Error(
      `expected two daemon.started records (the first run and the restart), found ${String(starts.length)}`,
    );
  return [log.slice(0, starts[1]), log.slice(starts[1])];
}

/** A command by label, or a thrown error naming it missing (command and commandA share this body: sonarjs/no-identical-functions). */
function commandOf<C extends P20Command>(commands: readonly C[], label: string): C {
  const found = commands.find((c) => c.label === label);
  if (found === undefined) throw new Error(`no command ${label} in the record`);
  return found;
}
const command = (r: P20Record, label: string): P20Command => commandOf(r.commands, label);
const events = (log: readonly LogRecord[], event: string) =>
  log.filter((x) => x['event'] === event && (x['identity'] === undefined || x['identity'] === P20_IDENTITY));
/** A task's command label, `task-<i>` (helper to avoid a nested template literal, sonarjs/no-nested-template-literals). */
const taskLabel = (i: string): string => `task-${i}`;

export const P20_B: readonly P20Claim[] = [
  {
    claim: 'tasks.json names each of tasks 1, 2, 3 and 4 exactly once',
    check: (r) => {
      let ids: unknown;
      try {
        ids = JSON.parse(r.tasksJson);
      } catch {
        return fails(`tasks.json is not JSON: ${JSON.stringify(r.tasksJson.slice(0, 80))}`);
      }
      if (!Array.isArray(ids)) return fails(`tasks.json is not an array: ${r.tasksJson}`);
      const names = ids.map((x) => String(x));
      return [...names].sort(byCodeUnit).join(',') === '1,2,3,4'
        ? holds(r.tasksJson.trim())
        : fails(`tasks.json names ${JSON.stringify(names)}`);
    },
  },
  {
    claim:
      "task 3's checkpoint was not promoted before the kill: the first run promoted exactly two checkpoints of the supervisor (tasks 1 and 2)",
    check: (r) => {
      const promoted = events(runs(r.daemonLog)[0], 'state.promoted').length;
      if (promoted === 2) return holds('2 state.promoted in the first run');
      const detail =
        promoted > 2
          ? "task 3's delivery was acknowledged before the kill — the fault missed its moment; this run does not count"
          : 'tasks 1 and 2 were not both saved';
      return fails(`${String(promoted)} state.promoted in the first run: ${detail}`);
    },
  },
  {
    claim: 'task 4 was accepted while task 3 ran: the first run posted all four tasks',
    check: (r) => {
      const posted = runs(r.daemonLog)[0].filter(
        (x) => x['event'] === 'channel.posted' && x['kind'] === 'input',
      ).length;
      return posted === 4
        ? holds('4 inputs posted before the kill')
        : fails(`${String(posted)} inputs posted before the kill`);
    },
  },
  {
    claim:
      'tasks 1 and 2 written exactly once across both runs, task 3 in both (R9 (g)), task 4 after the restart: 3 writes of tasks.json in the first run, 2 in the second',
    check: (r) =>
      r.writes.first === 3 && r.writes.second === 2
        ? holds('3 writes, then 2')
        : fails(`${String(r.writes.first)} writes in the first run, ${String(r.writes.second)} in the second`),
  },
  {
    claim: 'one state.pending_found naming 2 entries, and exactly 2 state.redelivered with no originalMessage repeated',
    check: (r) => {
      const second = runs(r.daemonLog)[1];
      const found = events(second, 'state.pending_found');
      const redelivered = events(second, 'state.redelivered').map((x) => String(x['originalMessage']));
      if (found.length !== 1 || present(found[0], 'found[0]')['entries'] !== 2)
        return fails(`state.pending_found: ${JSON.stringify(found.map((x) => x['entries']))}`);
      if (redelivered.length !== 2 || new Set(redelivered).size !== 2)
        return fails(`state.redelivered: ${JSON.stringify(redelivered)}`);
      return holds(`pending_found 2; redelivered ${redelivered.join(', ')}`);
    },
  },
  {
    claim: 'no message was sent after the restart: the second run posted no input',
    check: (r) => {
      // The re-sent posts carry redelivered: true; a new message from the user does not.
      const posted = runs(r.daemonLog)[1].filter(
        (x) => x['event'] === 'channel.posted' && x['kind'] === 'input' && x['redelivered'] !== true,
      ).length;
      return posted === 0
        ? holds('no input posted in the second run')
        : fails(`${String(posted)} inputs posted in the second run`);
    },
  },
  {
    claim: 'tasks 1 and 2 exit 0 with their replies',
    check: (r) => {
      const bad = ['1', '2'].filter((i) => {
        const c = command(r, `task-${i}`);
        return c.code !== 0 || !new RegExp(`done task ${i}\\b`, 'i').test(c.stdout);
      });
      return bad.length === 0
        ? holds('task-1 and task-2: exit 0, "done task <i>"')
        : fails(
            `task(s) ${bad.join(', ')}: ${bad.map((i) => JSON.stringify(command(r, taskLabel(i)).stdout)).join(' ')}`,
          );
    },
  },
  {
    claim:
      'tasks 3 and 4 lose their stream at the kill: exit 1, `✗ the daemon closed the conversation before it settled; see its log (<cause>)`',
    check: (r) => {
      const bad = ['3', '4'].filter((i) => {
        const c = command(r, `task-${i}`);
        return c.code !== 1 || !c.stderr.split(/(?<=\n)/).some((l) => CLOSED.test(l));
      });
      return bad.length === 0
        ? holds('task-3 and task-4: exit 1 with the closed-stream line')
        : fails(
            `task(s) ${bad.join(', ')}: ${bad.map((i) => JSON.stringify(command(r, taskLabel(i)).stderr.slice(-160))).join(' ')}`,
          );
    },
  },
  {
    claim:
      "the relaunch, without --verbose: exit 0; stdout the team's handles, then task 3's reply, then task 4's; stderr exactly two resuming lines, task 3's savedAt then task 4's",
    check: (r) => {
      const c = command(r, 'relaunch');
      if (c.args.includes('--verbose')) return fails('the relaunch ran with --verbose');
      if (c.code !== 0) return fails(`exit ${String(c.code)}: ${c.stderr.slice(-200)}`);
      const out = c.stdout.split('\n').filter((l) => l !== '');
      const n = RESUME_HANDLES.length;
      if (
        out.slice(0, n).join() !== RESUME_HANDLES.join() ||
        out.length !== n + 2 ||
        !/done task 3\b/i.test(present(out[n], 'out[n]')) ||
        !/done task 4\b/i.test(present(out[n + 1], 'out[n + 1]'))
      )
        return fails(`stdout ${JSON.stringify(c.stdout)}`);
      const lines = c.stderr.split('\n').filter((l) => l !== '');
      const resuming = lines.map((l) => RESUMING.exec(l)?.[1]).filter((x): x is string => x !== undefined);
      // Beside the two resuming lines, only the documented note for the killed daemon's file, once (docs/cli, finding).
      const others = lines.filter((l) => RESUMING.exec(l) === null);
      const noted = others.filter((l) => STALE_NOTE.test(l));
      if (resuming.length !== 2 || others.length !== noted.length || noted.length > 1)
        return fails(`stderr ${JSON.stringify(c.stderr)}`);
      return present(resuming[0], 'resuming[0]') <= present(resuming[1], 'resuming[1]')
        ? holds(`${out.join(' | ')}; resuming ${resuming.join(', ')}`)
        : fails(`the resuming lines are out of order: ${resuming.join(', ')}`);
    },
  },
  {
    claim: "every command's ms under p20-b's bound",
    check: (r) => {
      const over = r.commands.filter((c) => c.ms >= r.boundMs);
      return over.length === 0
        ? holds(r.commands.map((c) => `${c.label} ${String(c.ms)} ms`).join(', '))
        : fails(over.map((c) => `${c.label} ${String(c.ms)} ms ≥ ${String(r.boundMs)}`).join(', '));
    },
  },
];

/** Every claim's verdict, in order. */
export function checkP20(record: P20Record): { readonly claim: string; readonly verdict: Verdict }[] {
  return P20_B.map((c) => ({ claim: c.claim, verdict: c.check(record) }));
}

// ---------------------------------------------------------------- p20-a

/** One `./asha` command of p20-a: `message`, `stop` or `relaunch`. */
export interface P20ACommand extends P20Command {
  /** The transcript (parseTranscript over its stderr) of the message and the relaunch; empty for the stop. */
  readonly events: readonly TranscriptEvent[];
}

export interface P20ARecord {
  readonly commands: readonly P20ACommand[];
  /** p20-a's slice of the daemon log: from its first `daemon.started` to the next scenario's (both of its runs). */
  readonly daemonLog: readonly LogRecord[];
  /** teams/resume/'s files as text, by path relative to the folder. */
  readonly team: Readonly<Record<string, string>>;
  /** P20's bound on a request (its page's `# bound:` line). */
  readonly boundMs: number;
}

export interface P20AClaim {
  readonly claim: string;
  readonly check: (r: P20ARecord) => Verdict;
}

const SUPERVISOR = 'main/resume/supervisor';
// /i already folds case, so `A-Z` alone covers `a-z` too: `A-Za-z0-9-` repeated the letters (sonarjs/duplicates-in-
// character-class); verified byte-for-byte equivalent over a set of sample inputs (node -e), case-fold included.
const WORD = /(?<![A-Z0-9-])marigold(?![A-Z0-9-])/i;
const NO_REPLY = 'No agent could answer this:';
const commandA = (r: P20ARecord, label: string): P20ACommand => commandOf(r.commands, label);
const ofEvent = (log: readonly LogRecord[], event: string) => log.filter((x) => x['event'] === event);
const ofIdentity = (log: readonly LogRecord[], event: string) =>
  ofEvent(log, event).filter((x) => x['identity'] === SUPERVISOR);
const inputs = (log: readonly LogRecord[]) =>
  log.filter((x) => x['event'] === 'channel.posted' && x['kind'] === 'input');
/** The first run's input: alice's message (the only one, claim 5). */
const firstInput = (r: P20ARecord): LogRecord | undefined =>
  inputs(runs(r.daemonLog)[0]).find((x) => x['redelivered'] !== true);
/** The second run's re-sent input. */
const resentInput = (r: P20ARecord): LogRecord | undefined =>
  inputs(runs(r.daemonLog)[1]).find((x) => x['redelivered'] === true);

export const P20_A: readonly P20AClaim[] = [
  {
    claim:
      "the fault landed: in the first run, one call by supervisor-1 to worker-1 alone in alice's conversation, the stop after it, and no output from supervisor-1",
    check: (r) => {
      const first = runs(r.daemonLog)[0];
      const input = firstInput(r);
      if (input === undefined) return fails('no input in the first run');
      const calls = ofEvent(first, 'channel.call_opened').filter((x) => x['caller'] === 'supervisor-1');
      const callsProblem = (): Verdict =>
        fails(`calls by supervisor-1: ${JSON.stringify(calls.map((c) => [c['addressees'], c['conversation']]))}`);
      if (calls.length !== 1) return callsProblem();
      const call = present(calls[0], 'calls[0]');
      if (JSON.stringify(call['addressees']) !== '["worker-1"]' || call['conversation'] !== input['conversation'])
        return callsProblem();
      const opened = first.indexOf(call);
      const stop = first.findIndex((x) => x['event'] === 'daemon.stop_requested');
      if (stop < opened)
        return fails(
          stop === -1
            ? 'no daemon.stop_requested in the first run'
            : 'the stop was requested before the call was opened',
        );
      const outputs = first.filter(
        (x) => x['event'] === 'channel.posted' && x['kind'] === 'output' && x['from'] === 'supervisor-1',
      );
      return outputs.length === 0
        ? holds(`call ${String(call['call'])} to worker-1, then daemon.stop_requested; no output from supervisor-1`)
        : fails(
            `${String(outputs.length)} output(s) from supervisor-1 before the stop: the conversation finished first`,
          );
    },
  },
  {
    claim: "the input was kept: the first run's state.pending_kept for main/resume/supervisor names 1 entry",
    check: (r) => {
      const kept = ofIdentity(runs(r.daemonLog)[0], 'state.pending_kept');
      return kept.length === 1 && present(kept[0], 'kept[0]')['entries'] === 1
        ? holds('state.pending_kept entries 1')
        : fails(`state.pending_kept: ${JSON.stringify(kept.map((x) => x['entries']))}`);
    },
  },
  {
    claim: "the message command ended with the harness's no-reply: exit 1, stdout the no-reply text, no agent's output",
    check: (r) => {
      const c = commandA(r, 'message');
      if (c.code !== 1) return fails(`exit ${String(c.code)}`);
      // The no-reply text alone: its heading, then one `- <handle> …` line per agent; nothing else, so no agent's output.
      const lines = c.stdout.split('\n').filter((l) => l !== '');
      if (lines[0] !== NO_REPLY || lines.length < 2 || !lines.slice(1).every((l) => l.startsWith('- ')))
        return fails(`stdout ${JSON.stringify(c.stdout)}`);
      if (WORD.test(c.stdout)) return fails(`stdout holds the word: ${JSON.stringify(c.stdout)}`);
      return holds(JSON.stringify(c.stdout.split('\n')[0]));
    },
  },
  {
    claim:
      "the restart and the resume: two daemon runs; in the second, state.pending_found for the supervisor with 1 entry (or 2, the second a superseded call_gather), agent.resumed, and one state.redelivered of alice's message",
    check: (r) => {
      const second = runs(r.daemonLog)[1];
      const found = ofIdentity(second, 'state.pending_found');
      const superseded = ofIdentity(second, 'state.redelivery_superseded');
      const entries = found[0]?.['entries'];
      const foundOk =
        found.length === 1 &&
        (entries === 1
          ? superseded.length === 0
          : entries === 2 &&
            superseded.length === 1 &&
            present(superseded[0], 'superseded[0]')['kind'] === 'call_gather');
      if (!foundOk)
        return fails(
          `state.pending_found ${JSON.stringify(found.map((x) => x['entries']))}, state.redelivery_superseded ${JSON.stringify(superseded.map((x) => x['kind']))}`,
        );
      if (ofIdentity(second, 'agent.resumed').length !== 1)
        return fails(`agent.resumed: ${String(ofIdentity(second, 'agent.resumed').length)}`);
      const redelivered = ofIdentity(second, 'state.redelivered');
      const original = firstInput(r)?.['id'];
      if (redelivered.length !== 1 || present(redelivered[0], 'redelivered[0]')['originalMessage'] !== original)
        return fails(
          `state.redelivered ${JSON.stringify(redelivered.map((x) => x['originalMessage']))}, alice's message ${String(original)}`,
        );
      return holds(`pending_found ${String(entries)}; agent.resumed; redelivered ${String(original)}`);
    },
  },
  {
    claim: "the user sent nothing again: one input in the first run, alice's; in the second only its re-send",
    check: (r) => {
      const [first, second] = runs(r.daemonLog);
      const a = inputs(first).filter((x) => x['redelivered'] !== true);
      const b = inputs(second);
      if (a.length !== 1 || inputs(first).length !== 1)
        return fails(`${String(inputs(first).length)} inputs in the first run`);
      if (b.length !== 1 || present(b[0], 'b[0]')['redelivered'] !== true)
        return fails(
          `second run's inputs: ${JSON.stringify(b.map((x) => (x['redelivered'] === true ? 'resent' : 'new')))}`,
        );
      return holds('first run: 1 input; second run: 1 re-send, no new input');
    },
  },
  {
    claim:
      'the resumed conversation completes: supervisor-1 calls worker-1 again, worker-1 answers, the gather, then one output from supervisor-1 to alice holding marigold; and nothing is left kept (state.pending_settled, 1 entry)',
    check: (r) => {
      const second = runs(r.daemonLog)[1];
      const resent = resentInput(r);
      if (resent === undefined) return fails('no re-sent input in the second run');
      const conv = resent['conversation'];
      const inConv = second.filter((x) => x['conversation'] === conv);
      const calls = ofEvent(inConv, 'channel.call_opened').filter((x) => x['caller'] === 'supervisor-1');
      if (calls.length !== 1 || JSON.stringify(present(calls[0], 'calls[0]')['addressees']) !== '["worker-1"]')
        return fails(`calls in the re-sent conversation: ${JSON.stringify(calls.map((c) => c['addressees']))}`);
      const posted = inConv.filter((x) => x['event'] === 'channel.posted');
      const answer = posted.findIndex((x) => x['from'] === 'worker-1' && x['role'] === 'answer');
      const gather = posted.findIndex((x) => x['role'] === 'gather' && x['to'] === 'supervisor-1');
      const outs = posted.filter((x) => x['kind'] === 'output');
      if (answer === -1 || gather < answer) return fails(`answer at ${String(answer)}, gather at ${String(gather)}`);
      if (outs.length !== 1) return fails(`outputs: ${JSON.stringify(outs.map((x) => [x['from'], x['to']]))}`);
      const out0 = present(outs[0], 'outs[0]');
      if (out0['from'] !== 'supervisor-1' || out0['to'] !== 'alice' || posted.indexOf(out0) < gather)
        return fails(`outputs: ${JSON.stringify(outs.map((x) => [x['from'], x['to']]))}`);
      const watched = commandA(r, 'relaunch').events.filter((e) => e.type === 'output' && e.from === 'supervisor-1');
      const reply = commandA(r, 'relaunch').stdout;
      if (watched.length !== 1 || !WORD.test(reply))
        return fails(
          `the relaunch saw ${String(watched.length)} output(s) from supervisor-1; stdout ${JSON.stringify(reply)}`,
        );
      const settled = ofIdentity(second, 'state.pending_settled');
      if (settled.length !== 1 || present(settled[0], 'settled[0]')['entries'] !== 1)
        return fails(`state.pending_settled: ${JSON.stringify(settled.map((x) => x['entries']))}`);
      return holds(`call to worker-1, its answer, the gather, one output from supervisor-1; state.pending_settled 1`);
    },
  },
  {
    claim:
      "seen by the reattached watch: the relaunch exits 0, prints the team's handles then the reply, one resuming line with alice's message's time, and supervisor-1's question to worker-1 before its output",
    check: (r) => {
      const c = commandA(r, 'relaunch');
      if (c.code !== 0) return fails(`exit ${String(c.code)}`);
      const out = c.stdout.split('\n').filter((l) => l !== '');
      const n = RESUME_HANDLES.length;
      // The reply's words are claim 6's; here, that the reply follows the handles.
      if (out.slice(0, n).join() !== RESUME_HANDLES.join() || out.length <= n)
        return fails(`stdout ${JSON.stringify(c.stdout)}`);
      const resuming = c.stderr
        .split('\n')
        .map((l) => RESUMING.exec(l)?.[1])
        .filter((x): x is string => x !== undefined);
      const savedAt = ofIdentity(runs(r.daemonLog)[1], 'state.pending_found')[0]?.['savedAt'];
      if (resuming.length !== 1 || resuming[0] !== savedAt)
        return fails(`resuming lines ${JSON.stringify(resuming)}, the message's time ${String(savedAt)}`);
      const question = c.events.findIndex(
        (e) => e.type === 'internal' && e.from === 'supervisor-1' && e.to === 'worker-1',
      );
      const output = c.events.findIndex((e) => e.type === 'output' && e.from === 'supervisor-1');
      if (question === -1 || output < question)
        return fails(`question at ${String(question)}, output at ${String(output)} in the relaunch's transcript`);
      return holds(`${out.join(' | ')}; resuming ${String(resuming[0])}`);
    },
  },
  {
    claim:
      'the word came from the worker: marigold is in worker.md alone of teams/resume/, and in no input or question',
    check: (r) => {
      const holding = Object.entries(r.team)
        .filter(([, text]) => WORD.test(text))
        .map(([path]) => path);
      if (holding.join() !== 'worker.md') return fails(`marigold in ${JSON.stringify(holding)}`);
      const message = commandA(r, 'message').args.find((a) => a.startsWith('message='));
      if (message === undefined || WORD.test(message)) return fails(`the input: ${String(message)}`);
      // Every question supervisor-1 put, before the stop (the message command's transcript) and after it (the relaunch's).
      const questions = ['message', 'relaunch']
        .flatMap((l) => commandA(r, l).events)
        .filter((e) => e.type === 'internal' && e.from === 'supervisor-1');
      if (questions.some((e) => 'text' in e && WORD.test(e.text))) return fails('a question holds marigold');
      return holds('worker.md only; not in the input or a question');
    },
  },
  {
    claim: 'no error-level record in either run; the message command and the relaunch within the bound',
    check: (r) => {
      const errors = r.daemonLog.filter((x) => x['level'] === 'error');
      if (errors.length > 0) return fails(`error records: ${errors.map((x) => String(x['event'])).join(', ')}`);
      const over = ['message', 'relaunch'].map((l) => commandA(r, l)).filter((c) => c.ms >= r.boundMs);
      return over.length === 0
        ? holds(['message', 'relaunch'].map((l) => `${l} ${String(commandA(r, l).ms)} ms`).join(', '))
        : fails(over.map((c) => `${c.label} ${String(c.ms)} ms ≥ ${String(r.boundMs)}`).join(', '));
    },
  },
];

/** p20-a's every claim's verdict, in order. */
export function checkP20A(record: P20ARecord): { readonly claim: string; readonly verdict: Verdict }[] {
  return P20_A.map((c) => ({ claim: c.claim, verdict: c.check(record) }));
}
