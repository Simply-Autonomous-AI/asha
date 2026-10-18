// p20-b's checker on its first recorded run and one mutation per claim (docs/plans/agent-persistence.md A8,
// "Long-running supervisor"; orchestration-patterns R13): each mutation fails exactly its claim, naming what it found.
//
// The passing record is recorded run 1 (tests/agents/p20-b/recorded-run-1.json, at 2d94dc1; its source
// field says how each part was taken), rewritten for the member's move into teams/resume/ by to-resume.mts
// (docs/plans/patterns-phase-5.md R13), checked against p20-b's bound as the demo test sets it.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { present } from '../../src/shared/assert-present.js';
import {
  P20_A,
  P20_B,
  P20_BOUND_MS,
  checkP20,
  checkP20A,
  type P20ACommand,
  type P20ARecord,
  type P20Command,
  type P20Record,
} from '../agents/patterns/p20.js';

const FIXTURE = join(resolve(import.meta.dirname, '..', '..'), 'tests', 'agents', 'p20-b', 'recorded-run-1.json');

function passing(): P20Record {
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Omit<P20Record, 'boundMs'>;
  return {
    commands: f.commands,
    daemonLog: f.daemonLog,
    writes: f.writes,
    tasksJson: f.tasksJson,
    boundMs: P20_BOUND_MS,
  };
}

/** The index of the n-th (from 0) log record `match` holds for. */
const nth = (r: P20Record, match: (x: Record<string, unknown>) => boolean, n: number): number =>
  present(
    r.daemonLog.map((x, i) => (match(x) ? i : -1)).filter((i) => i >= 0)[n],
    `the ${String(n)}-th matching daemon log record`,
  );
const isInput = (x: Record<string, unknown>) =>
  x['event'] === 'channel.posted' && x['kind'] === 'input' && x['redelivered'] !== true;
const PROMOTED = { event: 'state.promoted', identity: 'main/resume/tasker', generation: 3 };

/** The failing claims' texts and why. */
const failing = (r: P20Record) => checkP20(r).flatMap((c) => (c.verdict.ok ? [] : [[c.claim, c.verdict.why]]));

describe("p20-b's checker", () => {
  it('passes recorded run 1, every claim with its evidence', () => {
    const results = checkP20(passing());
    expect(results.map((c) => c.claim)).toEqual(P20_B.map((c) => c.claim));
    expect(results.filter((c) => !c.verdict.ok)).toEqual([]);
  });

  const claim = (start: string) =>
    present(
      P20_B.find((c) => c.claim.startsWith(start)),
      `a P20_B claim starting with ${start}`,
    ).claim;
  const replace = (r: P20Record, label: string, patch: Partial<P20Command>): P20Record => ({
    ...r,
    commands: r.commands.map((c) => (c.label === label ? { ...c, ...patch } : c)),
  });

  it.each<[string, (r: P20Record) => P20Record, string, string | RegExp]>([
    [
      'a task written twice into tasks.json',
      (r) => ({ ...r, tasksJson: '["1","2","3","3","4"]' }),
      'tasks.json names each',
      'tasks.json names ["1","2","3","3","4"]',
    ],
    [
      'tasks.json not JSON',
      (r) => ({ ...r, tasksJson: '1,2,3,4' }),
      'tasks.json names each',
      'tasks.json is not JSON: "1,2,3,4"',
    ],
    [
      "task 3's delivery acknowledged before the kill",
      (r) => {
        const at = nth(r, (x) => x['event'] === 'daemon.started', 1);
        return { ...r, daemonLog: [...r.daemonLog.slice(0, at), PROMOTED, ...r.daemonLog.slice(at)] };
      },
      "task 3's checkpoint",
      /3 state\.promoted in the first run: task 3's delivery was acknowledged before the kill/,
    ],
    [
      'task 4 posted only after the restart',
      (r) => ({ ...r, daemonLog: r.daemonLog.filter((_, i) => i !== nth(r, isInput, 3)) }),
      'task 4 was accepted',
      '3 inputs posted before the kill',
    ],
    [
      'task 3 not written again after the restart',
      (r) => ({ ...r, writes: { first: 3, second: 1 } }),
      'tasks 1 and 2 written exactly once',
      '3 writes in the first run, 1 in the second',
    ],
    [
      'task 2 written again',
      (r) => ({ ...r, writes: { first: 3, second: 3 } }),
      'tasks 1 and 2 written exactly once',
      '3 writes in the first run, 3 in the second',
    ],
    [
      'an original message re-sent twice',
      (r) => {
        const first = present(
          r.daemonLog[nth(r, (x) => x['event'] === 'state.redelivered', 0)],
          'the first state.redelivered record',
        )['originalMessage'];
        return {
          ...r,
          daemonLog: r.daemonLog.map((x) =>
            x['event'] === 'state.redelivered' ? { ...x, originalMessage: first } : x,
          ),
        };
      },
      'one state.pending_found',
      /^state\.redelivered: \["(\w+)","\1"\]$/,
    ],
    [
      'a message sent after the restart',
      (r) => ({ ...r, daemonLog: [...r.daemonLog, { event: 'channel.posted', kind: 'input', from: 'ivy', to: null }] }),
      'no message was sent after the restart',
      '1 inputs posted in the second run',
    ],
    ['task 2 failing', (r) => replace(r, 'task-2', { code: 1 }), 'tasks 1 and 2 exit 0', /^task\(s\) 2: /],
    [
      'task 3 settling before the kill',
      (r) => replace(r, 'task-3', { code: 0, stderr: '› posted\n', stdout: 'done task 3\n' }),
      'tasks 3 and 4 lose their stream',
      /^task\(s\) 3: /,
    ],
    [
      'the relaunch with --verbose',
      (r) => replace(r, 'relaunch', { args: ['--verbose', '--launch', 'team=resume'] }),
      'the relaunch, without --verbose',
      'the relaunch ran with --verbose',
    ],
    [
      'the relaunch returning at launched',
      (r) => replace(r, 'relaunch', { stdout: 'supervisor-1\nworker-1\ntasker-1\n' }),
      'the relaunch, without --verbose',
      'stdout "supervisor-1\\nworker-1\\ntasker-1\\n"',
    ],
    [
      "the relaunch printing A8's one handle",
      (r) => replace(r, 'relaunch', { stdout: 'supervisor-1\ndone task 3\ndone task 4\n' }),
      'the relaunch, without --verbose',
      'stdout "supervisor-1\\ndone task 3\\ndone task 4\\n"',
    ],
    [
      'the resuming lines out of order',
      (r) =>
        replace(r, 'relaunch', {
          stderr: present(
            r.commands.find((c) => c.label === 'relaunch'),
            "the 'relaunch' command",
          )
            .stderr.split('\n')
            .filter((l) => l !== '')
            .reverse()
            .map((l) => `${l}\n`)
            .join(''),
        }),
      'the relaunch, without --verbose',
      /^the resuming lines are out of order: /,
    ],
    [
      'the dead daemon file noted twice',
      (r) =>
        replace(r, 'relaunch', {
          stderr:
            '(daemon file names port 5, which did not answer: fetch failed)\n(daemon file names port 5, which did not answer: fetch failed)\n› resuming your message from 2026-09-29T10:00:03.000Z\n› resuming your message from 2026-09-29T10:00:04.000Z\n',
        }),
      'the relaunch, without --verbose',
      /^stderr /,
    ],
    [
      'an unexpected stderr line',
      (r) =>
        replace(r, 'relaunch', {
          stderr:
            '› resuming your message from 2026-09-29T10:00:03.000Z\nsomething else\n› resuming your message from 2026-09-29T10:00:04.000Z\n',
        }),
      'the relaunch, without --verbose',
      /^stderr /,
    ],
    [
      'one resuming line',
      (r) => replace(r, 'relaunch', { stderr: '› resuming your message from 2026-09-29T10:00:03.000Z\n' }),
      'the relaunch, without --verbose',
      /^stderr /,
    ],
    [
      'a command over the bound',
      (r) => replace(r, 'relaunch', { ms: P20_BOUND_MS }),
      "every command's ms",
      `relaunch ${String(P20_BOUND_MS)} ms ≥ ${String(P20_BOUND_MS)}`,
    ],
  ])('%s fails exactly its claim', (_what, mutate, claimStart, why) => {
    const failed = failing(mutate(passing()));
    expect(failed.map(([c]) => c)).toEqual([claim(claimStart)]);
    if (typeof why === 'string') expect(present(failed[0], 'failed[0]')[1]).toBe(why);
    else expect(present(failed[0], 'failed[0]')[1]).toMatch(why);
  });

  it("passes a relaunch whose stderr also notes the killed daemon's file, once", () => {
    const r = passing();
    const noted = {
      ...r,
      commands: r.commands.map((c) =>
        c.label === 'relaunch'
          ? { ...c, stderr: `(daemon file names port 53604, which did not answer: fetch failed)\n${c.stderr}` }
          : c,
      ),
    };
    expect(failing(noted)).toEqual([]);
  });

  it('its fixture is recorded run 1 rewritten by to-resume.mts, and only so (patterns-phase-5 R13)', async () => {
    const { toResume } = await import('../agents/p20-b/to-resume.mjs');
    const original = JSON.parse(
      readFileSync(
        join(resolve(import.meta.dirname, '..', '..'), 'tests', 'agents', 'p20-b', 'recorded-run-1-resume-tasks.json'),
        'utf8',
      ),
    ) as unknown;
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(toResume(original));
    expect(JSON.stringify(toResume(original)).includes('resume-tasks')).toBe(false);
  });

  it("its bound is the page's: P20's one bound, re-derived for the three-member team (patterns-phase-5's completion review, finding 8)", () => {
    expect(readRunBlock('docs/patterns/p20-resume.md', resolve(import.meta.dirname, '..', '..')).boundMs).toBe(
      P20_BOUND_MS,
    );
  });

  it('refuses a log without the restart: the record is not a p20-b run', () => {
    const r = passing();
    expect(() =>
      checkP20({
        ...r,
        daemonLog: r.daemonLog.slice(
          0,
          nth(r, (x) => x['event'] === 'daemon.started', 1),
        ),
      }),
    ).toThrow('expected two daemon.started records (the first run and the restart), found 1');
  });
});

// p20-a's checker (docs/plans/patterns-phase-5.md R12, A3) on its first recorded run (tests/agents/p20-a/run-1.json, at
// 56b92e0; its source field says how each part was taken) and one fixture per listed mutation and per clause: each fails
// exactly its claim.
describe("p20-a's checker", () => {
  const A_FIXTURE = join(resolve(import.meta.dirname, '..', '..'), 'tests', 'agents', 'p20-a', 'run-1.json');
  const BOUND = 45_000;
  const passingA = (): P20ARecord => {
    const f = JSON.parse(readFileSync(A_FIXTURE, 'utf8')) as Omit<P20ARecord, 'boundMs'>;
    return { commands: f.commands, daemonLog: f.daemonLog, team: f.team, boundMs: BOUND };
  };
  const failingA = (r: P20ARecord) => checkP20A(r).flatMap((c) => (c.verdict.ok ? [] : [[c.claim, c.verdict.why]]));
  const claimA = (start: string) =>
    present(
      P20_A.find((c) => c.claim.startsWith(start)),
      `a P20_A claim starting with ${start}`,
    ).claim;
  /** The index of the second run's first record. */
  const second = (r: P20ARecord) =>
    present(
      r.daemonLog.map((x, i) => (x['event'] === 'daemon.started' ? i : -1)).filter((i) => i >= 0)[1],
      "the second run's daemon.started index",
    );
  const at = (r: P20ARecord, pred: (x: Record<string, unknown>, i: number) => boolean) =>
    r.daemonLog.findIndex((x, i) => pred(x, i));
  const map = (
    r: P20ARecord,
    pred: (x: Record<string, unknown>, i: number) => boolean,
    f: (x: Record<string, unknown>) => Record<string, unknown>,
  ): P20ARecord => ({ ...r, daemonLog: r.daemonLog.map((x, i) => (pred(x, i) ? f(x) : x)) });
  const drop = (r: P20ARecord, pred: (x: Record<string, unknown>, i: number) => boolean): P20ARecord => ({
    ...r,
    daemonLog: r.daemonLog.filter((x, i) => !pred(x, i)),
  });
  const insert = (r: P20ARecord, index: number, x: Record<string, unknown>): P20ARecord => ({
    ...r,
    daemonLog: [...r.daemonLog.slice(0, index), x, ...r.daemonLog.slice(index)],
  });
  const cmd = (r: P20ARecord, label: string, patch: Partial<P20ACommand>): P20ARecord => ({
    ...r,
    commands: r.commands.map((c) => (c.label === label ? { ...c, ...patch } : c)),
  });
  const relaunch = (r: P20ARecord) =>
    present(
      r.commands.find((c) => c.label === 'relaunch'),
      "the 'relaunch' command",
    );
  const resentConversation = (r: P20ARecord) =>
    present(
      r.daemonLog.find((x) => x['event'] === 'channel.posted' && x['redelivered'] === true),
      'the re-sent channel.posted record',
    )['conversation'];
  const inSecond = (r: P20ARecord, i: number) => i >= second(r);
  const SUP = 'main/resume/supervisor';

  it('passes recorded run 1, every claim with its evidence', () => {
    const results = checkP20A(passingA());
    expect(results.map((c) => c.claim)).toEqual(P20_A.map((c) => c.claim));
    expect(results.filter((c) => !c.verdict.ok)).toEqual([]);
  });

  it('passes a second run that found a gather beside the input, superseded', () => {
    const r = passingA();
    const found = at(r, (x, i) => inSecond(r, i) && x['event'] === 'state.pending_found');
    const patched = map(
      r,
      (_, i) => i === found,
      (x) => ({ ...x, entries: 2 }),
    );
    expect(
      failingA(
        insert(patched, found + 1, {
          event: 'state.redelivery_superseded',
          level: 'info',
          identity: SUP,
          kind: 'call_gather',
        }),
      ),
    ).toEqual([]);
  });

  it.each<[string, (r: P20ARecord) => P20ARecord, string]>([
    // The plan's mutations.
    [
      'a second user input in the conversation',
      (r) =>
        insert(r, r.daemonLog.length, {
          event: 'channel.posted',
          level: 'info',
          kind: 'input',
          from: 'alice',
          conversation: resentConversation(r),
        }),
      'the user sent nothing again',
    ],
    [
      'the stop before the call',
      (r) => {
        const stop = at(r, (x) => x['event'] === 'daemon.stop_requested');
        const call = at(r, (x) => x['event'] === 'channel.call_opened');
        const s = present(r.daemonLog[stop], 'r.daemonLog[stop]');
        return insert(
          drop(r, (_, i) => i === stop),
          call,
          s,
        );
      },
      'the fault landed',
    ],
    [
      'an output from supervisor-1 before the stop',
      (r) =>
        insert(
          r,
          at(r, (x) => x['event'] === 'daemon.stop_requested'),
          { event: 'channel.posted', level: 'info', kind: 'output', from: 'supervisor-1', to: 'alice' },
        ),
      'the fault landed',
    ],
    ['no kept input', (r) => drop(r, (x) => x['event'] === 'state.pending_kept'), 'the input was kept'],
    [
      "the message command with an agent's output",
      (r) => cmd(r, 'message', { stdout: "worker-1's word is marigold\n" }),
      'the message command ended',
    ],
    [
      'two re-sends',
      (r) => {
        const i = at(r, (x) => x['event'] === 'state.redelivered');
        return insert(r, i + 1, present(r.daemonLog[i], 'r.daemonLog[i]'));
      },
      'the restart and the resume',
    ],
    [
      'two entries found and none superseded',
      (r) =>
        map(
          r,
          (x, i) => inSecond(r, i) && x['event'] === 'state.pending_found',
          (x) => ({ ...x, entries: 2 }),
        ),
      'the restart and the resume',
    ],
    [
      'an answer without a consult',
      (r) => drop(r, (x, i) => inSecond(r, i) && x['event'] === 'channel.call_opened'),
      'the resumed conversation completes',
    ],
    [
      'the output without the word',
      (r) => cmd(r, 'relaunch', { stdout: relaunch(r).stdout.replace(/marigold/gi, 'tulip') }),
      'the resumed conversation completes',
    ],
    [
      'nothing settled',
      (r) => drop(r, (x) => x['event'] === 'state.pending_settled'),
      'the resumed conversation completes',
    ],
    ['the relaunch exiting 1', (r) => cmd(r, 'relaunch', { code: 1 }), 'seen by the reattached watch'],
    [
      'no resuming line',
      (r) => cmd(r, 'relaunch', { stderr: relaunch(r).stderr.replace(/^› resuming your message from .*\n/m, '') }),
      'seen by the reattached watch',
    ],
    [
      "the word in the supervisor's document",
      (r) => ({
        ...r,
        team: {
          ...r.team,
          'supervisor.md': `${present(r.team['supervisor.md'], "r.team['supervisor.md']")}marigold\n`,
        },
      }),
      'the word came from the worker',
    ],
    [
      "the word in the supervisor's prompt",
      (r) => ({
        ...r,
        team: {
          ...r.team,
          'supervisor.json': present(r.team['supervisor.json'], "r.team['supervisor.json']").replace(
            'what it is.',
            'what it is: marigold.',
          ),
        },
      }),
      'the word came from the worker',
    ],
    [
      "the word in the supervisor's description",
      (r) => ({
        ...r,
        team: {
          ...r.team,
          'supervisor.json': present(r.team['supervisor.json'], "r.team['supervisor.json']").replace(
            'tells the user.',
            'tells the user marigold.',
          ),
        },
      }),
      'the word came from the worker',
    ],
    [
      'the word in team.json',
      (r) => ({
        ...r,
        team: {
          ...r.team,
          'team.json': present(r.team['team.json'], "r.team['team.json']").replace('(p20-a)', '(p20-a, marigold)'),
        },
      }),
      'the word came from the worker',
    ],
    [
      "the word in alice's input",
      (r) =>
        cmd(r, 'message', {
          args: relaunch(r)
            .args.slice(0, 0)
            .concat(
              present(r.commands[0], 'r.commands[0]').args.map((a) =>
                a.startsWith('message=') ? `${a} Is it marigold?` : a,
              ),
            ),
        }),
      'the word came from the worker',
    ],
    ['an error record', (r) => insert(r, 1, { event: 'agent.failed', level: 'error' }), 'no error-level record'],
    ['the relaunch over the bound', (r) => cmd(r, 'relaunch', { ms: BOUND }), 'no error-level record'],
    // One per clause the mutations above leave.
    [
      'the call to two addressees',
      (r) =>
        map(
          r,
          (x, i) => !inSecond(r, i) && x['event'] === 'channel.call_opened',
          (x) => ({ ...x, addressees: ['worker-1', 'tasker-1'] }),
        ),
      'the fault landed',
    ],
    [
      'the call in another conversation',
      (r) =>
        map(
          r,
          (x, i) => !inSecond(r, i) && x['event'] === 'channel.call_opened',
          (x) => ({ ...x, conversation: 'elsewhere' }),
        ),
      'the fault landed',
    ],
    ['no stop requested', (r) => drop(r, (x) => x['event'] === 'daemon.stop_requested'), 'the fault landed'],
    ['the message command exiting 0', (r) => cmd(r, 'message', { code: 0 }), 'the message command ended'],
    [
      'the message command with no no-reply text',
      (r) => cmd(r, 'message', { stdout: 'nothing\n' }),
      'the message command ended',
    ],
    [
      'the no-reply text followed by the word',
      (r) => cmd(r, 'message', { stdout: `${present(r.commands[0], 'r.commands[0]').stdout}- marigold\n` }),
      'the message command ended',
    ],
    [
      "the no-reply text followed by an agent's output (finding 7)",
      (r) =>
        cmd(r, 'message', { stdout: `${present(r.commands[0], 'r.commands[0]').stdout}worker-1's word is tulip\n` }),
      'the message command ended',
    ],
    [
      'a question before the stop holding the word (finding 7)',
      (r) =>
        cmd(r, 'message', {
          events: present(r.commands[0], 'r.commands[0]').events.map((e) =>
            e.type === 'internal' && e.from === 'supervisor-1' ? { ...e, text: `${e.text} marigold?` } : e,
          ),
        }),
      'the word came from the worker',
    ],
    ['no agent.resumed', (r) => drop(r, (x) => x['event'] === 'agent.resumed'), 'the restart and the resume'],
    [
      'another message re-sent',
      (r) =>
        map(
          r,
          (x) => x['event'] === 'state.redelivered',
          (x) => ({ ...x, originalMessage: 'another' }),
        ),
      'the restart and the resume',
    ],
    [
      'two inputs in the first run',
      (r) =>
        insert(
          r,
          at(r, (x) => x['event'] === 'daemon.stop_requested'),
          { event: 'channel.posted', level: 'info', kind: 'input', from: 'alice', conversation: 'other' },
        ),
      'the user sent nothing again',
    ],
    [
      'no answer from worker-1',
      (r) => drop(r, (x, i) => inSecond(r, i) && x['event'] === 'channel.posted' && x['role'] === 'answer'),
      'the resumed conversation completes',
    ],
    [
      'the output to someone else',
      (r) =>
        map(
          r,
          (x, i) => inSecond(r, i) && x['event'] === 'channel.posted' && x['kind'] === 'output',
          (x) => ({ ...x, to: 'bob' }),
        ),
      'the resumed conversation completes',
    ],
    [
      'the resuming line with another time',
      (r) =>
        cmd(r, 'relaunch', {
          stderr: relaunch(r).stderr.replace(
            /(?<prefix>› resuming your message from )\S+/,
            '$<prefix>2020-01-01T00:00:00.000Z',
          ),
        }),
      'seen by the reattached watch',
    ],
    [
      'the output before the question in the watch',
      (r) => cmd(r, 'relaunch', { events: [...relaunch(r).events].reverse() }),
      'seen by the reattached watch',
    ],
    [
      'a question holding the word',
      (r) =>
        cmd(r, 'relaunch', {
          events: relaunch(r).events.map((e) =>
            e.type === 'internal' && e.from === 'supervisor-1' ? { ...e, text: `${e.text} marigold?` } : e,
          ),
        }),
      'the word came from the worker',
    ],
    ['the message command over the bound', (r) => cmd(r, 'message', { ms: BOUND }), 'no error-level record'],
  ])('%s fails exactly its claim', (_what, mutate, claimStart) => {
    const failed = failingA(mutate(passingA()));
    expect(failed.map(([c]) => c)).toEqual([claimA(claimStart)]);
  });

  it('the relaunch printing no reply after the handles fails the watch claim, and the word claim, which reads the reply', () => {
    const failed = failingA(cmd(passingA(), 'relaunch', { stdout: 'supervisor-1\nworker-1\ntasker-1\n' }));
    expect(failed.map(([c]) => c)).toEqual([
      claimA('the resumed conversation completes'),
      claimA('seen by the reattached watch'),
    ]);
  });
});
