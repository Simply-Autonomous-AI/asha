// The rainbow scenario's proof (docs/plans/collaborating-agents.md R7, R13, A6;
// orchestration-patterns P4's p04-a): the checker of the team rainbow's request,
// over the records of one run — its transcript, its conversation's daemon log
// records and the team folder's files — held once, run by the agent-suite file
// tests/agents/p04-fan-out.test.ts (the rainbow's suite, moved there by
// docs/plans/patterns-phase-2.md R8) on its recorded run and by
// tests/unit/pattern-proofs.test.ts on the fixtures in fixtures/p04-a/, one per
// mutation A6 lists and one per further claim, each of which must fail naming
// its claim. Its bound is P4's page's `# bound:` line (docs/patterns/p04-fan-out.md):
// 45,000 ms, collaborating-agents R13's value — the runs at d9f7dd7, f44ca0a and
// 5ea1d4c took 37,162, 38,137 and 37,715 ms, and 38,137 × 1.5 is over the cap.

import { present } from '../../../src/shared/assert-present.js';
import { byCodeUnit } from '../../../src/shared/order.js';
import { RAINBOW_FACTS, RAINBOW_REPLY, RAINBOW_SUPERVISOR_HANDLE, factHandle } from '../../../evals/routing/rainbow.js';
import {
  exitCode,
  fails,
  holds,
  internals,
  line,
  logLine,
  logged,
  outputs,
  postedLog,
  replyText,
  withinBound,
  type Claim,
  type LogRecord,
  type ScenarioRecord,
} from './record.js';

/**
 * R13's delivery bound, set in every recipe of the team: the largest delivery time of any member in the first
 * recorded A6 run, × 2, rounded up to a whole second — at cee8966 (clean, 2026-09-29, results committed in 4340b31)
 * fact-green-1's 25,252 ms, × 2 = 50,504, so 51,000 ms. That run's recipes had hello-world's 60,000 ms.
 */
export const RAINBOW_MESSAGE_TIMEOUT_MS = 51_000;

const SUPERVISOR = RAINBOW_SUPERVISOR_HANDLE;
const FACT_HANDLES = RAINBOW_FACTS.map(([colour]) => factHandle(colour));

/** The one call the conversation opened, or why there is not exactly one. */
function theCall(r: ScenarioRecord): LogRecord | string {
  const opened = logged(r, 'channel.call_opened');
  return opened.length === 1
    ? present(opened[0], 'opened[0]')
    : `${String(opened.length)} calls opened (channel.call_opened): ${opened.map(logLine).join(' | ') || 'none'}`;
}

/** The call's messages of one role, as the channel logged them. */
const callPosts = (r: ScenarioRecord, role: string): LogRecord[] => postedLog(r).filter((x) => x['role'] === role);

const isQuestion = (e: { from: string; to: string | null }): boolean =>
  e.from === SUPERVISOR && e.to !== null && FACT_HANDLES.includes(e.to);
const isAnswer = (e: { from: string; to: string | null }): boolean =>
  FACT_HANDLES.includes(e.from) && e.to === SUPERVISOR;
const isGather = (e: { from: string; to: string | null }): boolean => e.from === 'asha' && e.to === SUPERVISOR;

/** The scenario's claims, in the order of its proof (collaborating-agents, scenarios). */
export const P04_A: readonly Claim[] = [
  exitCode(0),
  {
    claim:
      "each fact is in exactly one member's files: its number in fact-<colour>.md alone, with its colour — in no other document, prompt, description or team file",
    check: (r) => {
      // Every file of the team folder: the documents, and the recipes and team.json, whose prompts and descriptions
      // reach the model too (the system message, list_agents). A JSON number (51000) holds no fact number as a word.
      const docs = Object.keys(r.team);
      // A numbered step's own number is not a fact: the k-th numbered line starting "k. " and a capital letter
      // ("2. When their answers …"). A list line such as "4. red", or a step out of sequence, is read whole.
      const facts = (p: string): string => {
        let k = 0;
        return present(r.team[p], `team[${p}]`)
          .split('\n')
          .map((l) => {
            const m = /^(\d+)\. (?=[A-Z])/.exec(l);
            if (m === null || Number(m[1]) !== k + 1) return l;
            k += 1;
            return l.slice(m[0].length);
          })
          .join('\n');
      };
      const wrong: string[] = [];
      const shown: string[] = [];
      for (const [colour, n] of RAINBOW_FACTS) {
        const found = docs.filter((p) => new RegExp(`\\b${String(n)}\\b`).test(facts(p)));
        const own = `fact-${colour}.md`;
        if (found.length !== 1 || found[0] !== own) wrong.push(`${String(n)} in ${found.join(', ') || 'no document'}`);
        else if (!new RegExp(`\\b${colour}\\b`, 'i').test(present(r.team[own], `team[${own}]`)))
          wrong.push(`${own} holds ${String(n)} without ${colour}`);
        else shown.push(`${String(n)} ${colour}: ${own}`);
      }
      return wrong.length === 0 ? holds(shown.join('; ')) : fails(wrong.join('; '));
    },
  },
  {
    claim: `every recipe of the team sets messageTimeoutMs to R13's value, ${String(RAINBOW_MESSAGE_TIMEOUT_MS)} ms`,
    check: (r) => {
      const recipes = Object.keys(r.team).filter((p) => p.endsWith('.json') && p !== 'team.json');
      const recipeOf = (p: string): { messageTimeoutMs?: unknown } =>
        JSON.parse(present(r.team[p], `team[${p}]`)) as { messageTimeoutMs?: unknown };
      const wrong = recipes.filter((p) => recipeOf(p).messageTimeoutMs !== RAINBOW_MESSAGE_TIMEOUT_MS);
      if (recipes.length !== 10) return fails(`${String(recipes.length)} recipes in the team folder, not 10`);
      return wrong.length === 0
        ? holds(`${String(recipes.length)} recipes, each messageTimeoutMs ${String(RAINBOW_MESSAGE_TIMEOUT_MS)}`)
        : fails(wrong.map((p) => `${p}: ${String(recipeOf(p).messageTimeoutMs)}`).join(', '));
    },
  },
  {
    claim:
      'one call from supervisor-1, its nine questions to the nine fact members (channel.call_opened), in the order recorded',
    check: (r) => {
      const call = theCall(r);
      if (typeof call === 'string') return fails(call);
      const addressees = call['addressees'] as readonly string[];
      if (call['caller'] !== SUPERVISOR) return fails(`the caller is ${String(call['caller'])}`);
      if (
        addressees.length !== 9 ||
        [...addressees].sort(byCodeUnit).join() !== [...FACT_HANDLES].sort(byCodeUnit).join()
      )
        return fails(`its addressees are ${addressees.join(', ')}`);
      const questions = callPosts(r, 'question');
      if (questions.length !== 9 || questions.some((q) => q['call'] !== call['call'] || q['from'] !== SUPERVISOR))
        return fails(`${String(questions.length)} questions posted on the call: ${questions.map(logLine).join(' | ')}`);
      return holds(`call ${String(call['call'])}; questions in order: ${addressees.join(', ')}`);
    },
  },
  {
    claim: 'all nine questions are posted before any answer (transcript)',
    check: (r) => {
      const lines = internals(r);
      const questions = lines.filter(isQuestion);
      const lastQuestion = lines.findLastIndex(isQuestion);
      const firstAnswer = lines.findIndex(isAnswer);
      if (questions.length !== 9)
        return fails(`${String(questions.length)} questions from supervisor-1 in the transcript`);
      const lastQuestionLine = line(present(lines[lastQuestion], 'lines[lastQuestion]'));
      if (firstAnswer >= 0 && firstAnswer < lastQuestion)
        return fails(`${line(present(lines[firstAnswer], 'lines[firstAnswer]'))} before ${lastQuestionLine}`);
      const afterFirstAnswer = firstAnswer >= 0 ? `, ${line(present(lines[firstAnswer], 'lines[firstAnswer]'))}` : '';
      return holds(`the 9th question, ${lastQuestionLine}, before the first answer${afterFirstAnswer}`);
    },
  },
  {
    claim:
      'an answer from each fact member to supervisor-1, on the call, with its number and colour and no other number, in the arrival order recorded',
    check: (r) => {
      const call = theCall(r);
      if (typeof call === 'string') return fails(call);
      const answers = callPosts(r, 'answer');
      const wrong: string[] = [];
      for (const [colour, n] of RAINBOW_FACTS) {
        const handle = factHandle(colour);
        const logged = answers.filter((a) => a['from'] === handle);
        if (
          logged.length !== 1 ||
          present(logged[0], 'logged[0]')['to'] !== SUPERVISOR ||
          present(logged[0], 'logged[0]')['call'] !== call['call']
        )
          wrong.push(`${handle}: ${String(logged.length)} answers on the call`);
        const said = internals(r).filter((e) => e.from === handle && e.to === SUPERVISOR);
        // Its own number and colour, and no other number: an answer holding a second fact is not its own.
        const numbers =
          said.length === 1 ? [...present(said[0], 'said[0]').text.matchAll(/\b\d+\b/g)].map((m) => m[0]) : [];
        if (
          said.length !== 1 ||
          numbers.join() !== String(n) ||
          !new RegExp(`\\b${colour}\\b`, 'i').test(present(said[0], 'said[0]').text)
        )
          wrong.push(`${handle} said ${JSON.stringify(said.map((e) => e.text))}, not ${String(n)} and ${colour} alone`);
      }
      if (answers.length !== 9) wrong.push(`${String(answers.length)} answers on the call`);
      return wrong.length === 0
        ? holds(
            `arrival order: ${internals(r)
              .filter(isAnswer)
              .map((e) => `${e.from} "${e.text}"`)
              .join('; ')}`,
          )
        : fails(wrong.join('; '));
    },
  },
  {
    claim: 'exactly one gather, to supervisor-1, of nine answered (channel.call_gathered)',
    check: (r) => {
      const call = theCall(r);
      if (typeof call === 'string') return fails(call);
      const gathers = callPosts(r, 'gather');
      const gathered = logged(r, 'channel.call_gathered');
      const shown = internals(r).filter(isGather);
      if (
        gathers.length !== 1 ||
        present(gathers[0], 'gathers[0]')['to'] !== SUPERVISOR ||
        present(gathers[0], 'gathers[0]')['call'] !== call['call']
      )
        return fails(`${String(gathers.length)} gathers posted: ${gathers.map(logLine).join(' | ') || 'none'}`);
      const counts =
        gathered.length === 1 ? (present(gathered[0], 'gathered[0]')['counts'] as Record<string, number>) : null;
      if (
        counts === null ||
        counts['answered'] !== 9 ||
        Object.entries(counts).some(([k, v]) => k !== 'answered' && v !== 0)
      )
        return fails(`channel.call_gathered: ${JSON.stringify(gathered.map((g) => g['counts']))}`);
      if (shown.length !== 1 || present(shown[0], 'shown[0]').text !== "Answers to supervisor-1's call: 9 answered.")
        return fails(`the transcript shows ${shown.map(line).join(' | ') || 'no gather'}`);
      return holds(`${line(present(shown[0], 'shown[0]'))}; counts ${JSON.stringify(counts)}`);
    },
  },
  {
    claim:
      'exactly one output, from supervisor-1, after the gather, with 4, 7, 1, 9, 3, 6, 2 in that order and neither 5 nor 8',
    check: (r) => {
      const found = outputs(r);
      if (found.length !== 1) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      const out = present(found[0], 'found[0]');
      if (out.from !== SUPERVISOR) return fails(`outputs: ${found.map((o) => o.from).join(', ') || 'none'}`);
      const at = r.run.events.indexOf(out);
      const gather = r.run.events.findIndex((e) => e.type === 'internal' && isGather(e));
      if (gather < 0 || at < gather)
        return fails(`the output is at transcript line ${String(at + 1)}, the gather at ${String(gather + 1)}`);
      return RAINBOW_REPLY.test(replyText(r))
        ? holds(`${line(out)} ${JSON.stringify(replyText(r))}`)
        : fails(`its text ${JSON.stringify(replyText(r))}`);
    },
  },
  {
    claim: 'no fact member posts an output',
    check: (r) => {
      const found = outputs(r).filter((o) => FACT_HANDLES.includes(o.from));
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
  },
  withinBound,
];
