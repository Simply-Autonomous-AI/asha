// P20 · Checkpoint and resume (docs/plans/patterns-phase-5.md; its page, docs/patterns/p20-resume.md, whose run block
// this file reads every command from; its team, teams/resume/). Two scenarios in one home, p20-a first:
//
// - p20-a: worker-1's container is paused, alice asks supervisor-1 for worker-1's word, and the daemon is stopped once
//   supervisor-1's call to worker-1 is open; the relaunch starts the daemon again, re-sends alice's message (kept by
//   R1), and follows the re-sent conversation to supervisor-1's answer — the reattached watch.
// - p20-b, the long-running supervisor (agent-persistence A8): tasker-1 does tasks 1 to 4, sent in a fixed
//   order; the daemon is killed with SIGKILL once task 3's tasks.json write is logged and task 4 posted; the relaunch,
//   with no message sent, does tasks 3 and 4.
//
// Each scenario is asserted only through its checker (tests/agents/patterns/p20.ts), on its own slice of the daemon
// log; a run whose fault missed its moment fails its checker and is never retried.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readRunBlock, scenarioCommands } from '../../evals/patterns/run-block.js';
import { present } from '../../src/shared/assert-present.js';
import { P20_IDENTITY, checkP20, checkP20A, type P20ACommand, type P20Command } from './patterns/p20.js';
import { containerFor, daemonLog, docker, killDaemonAt, waitFor } from './persistence-support.js';
import { REPO, agentSuite, parseTranscript, teamFiles, type AgentSuite, type Run } from './support.js';

const CHANNEL = 'main';
const block = readRunBlock('docs/patterns/p20-resume.md', REPO);

let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p20-resume', CHANNEL);
});

afterAll(async () => {
  await suite.finish();
});

/** The daemon log from the n-th `daemon.started` (0-based) on: a scenario's slice begins at its own first run. */
function logFrom(n: number): Record<string, unknown>[] {
  const log = daemonLog(suite.home);
  const starts = log.flatMap((r, i) => (r['event'] === 'daemon.started' ? [i] : []));
  return starts[n] === undefined ? [] : log.slice(starts[n]);
}

const startsSoFar = (): number => daemonLog(suite.home).filter((r) => r['event'] === 'daemon.started').length;

describe('P20 · Checkpoint and resume — teams/resume/', () => {
  it('p20-a: a supervisor waiting on its call when the daemon stops is resumed after the restart, with no message sent again', async (context) => {
    suite.begin(context, {
      id: 'p20-a',
      title: 'p20-a: the daemon stopped while supervisor-1 waits on worker-1; the relaunch resumes the conversation',
      agents: ['supervisor-1', 'worker-1', 'tasker-1'],
      expectation:
        'The input kept at the stop; the relaunch re-sends it once, supervisor-1 asks worker-1 again and answers alice with marigold; nothing sent again by the user.',
    });
    const [messageRaw, stopRaw, relaunchRaw] = scenarioCommands(block, 'p20-a');
    const message = present(messageRaw, 'p20-a commands[0] (message)');
    const stop = present(stopRaw, 'p20-a commands[1] (stop)');
    const relaunch = present(relaunchRaw, 'p20-a commands[2] (relaunch)');
    const from = startsSoFar();
    await suite.send(context, block.launch, 900_000);
    // The fault: worker-1 paused, so the call is still open when the stop begins, whatever the model's speed.
    await docker(['pause', containerFor(suite.home, 'worker-1')]);
    const sent = suite.send(context, message, 120_000);
    await waitFor(
      () =>
        daemonLog(suite.home)
          .slice()
          .some((r) => r['event'] === 'channel.call_opened' && r['caller'] === 'supervisor-1'),
      (x) => x,
      120_000,
      "supervisor-1's channel.call_opened",
    );
    // --stop prints nothing on stderr, so it runs through asha (no progress required) and is recorded.
    const stopped = await suite.asha(stop, 120_000);
    suite.record(context, stopped);
    const messageRun = await sent;
    const relaunched = await suite.send(context, relaunch, 900_000);

    const command = (label: string, run: Run & { readonly events?: unknown }): P20ACommand => ({
      label,
      args: run.args,
      code: run.code,
      stdout: run.stdout,
      stderr: run.stderr,
      ms: run.ms,
      events: label === 'stop' ? [] : parseTranscript(run.stderr, CHANNEL),
    });
    const results = checkP20A({
      commands: [command('message', messageRun), command('stop', stopped), command('relaunch', relaunched)],
      daemonLog: logFrom(from),
      team: teamFiles('resume'),
      boundMs: block.boundMs,
    });
    suite.prove(
      context,
      results.flatMap((r) => (r.verdict.ok ? [{ claim: r.claim, evidence: r.verdict.evidence }] : [])),
    );
    expect(
      results.filter((r) => !r.verdict.ok).map((r) => `${r.claim}: ${(r.verdict as { why: string }).why}`),
    ).toEqual([]);
  });

  it('p20-b: a long-running tasker killed mid-task resumes tasks 3 and 4, doing each task once in its file', async (context) => {
    suite.begin(context, {
      id: 'p20-b',
      title: 'p20-b: four tasks, the daemon killed during task 3, relaunched with no new message',
      agents: ['supervisor-1', 'worker-1', 'tasker-1'],
      expectation:
        'tasks.json names 1–4 once each; task 3 done again after the restart, task 4 after it; the relaunch prints both replies and two resuming lines.',
    });
    const [stopRaw, launchRaw, t1Raw, t2Raw, t3Raw, t4Raw, relaunchArgsRaw] = scenarioCommands(block, 'p20-b');
    const stop = present(stopRaw, 'p20-b commands[0] (stop)');
    const launch = present(launchRaw, 'p20-b commands[1] (launch)');
    const t1 = present(t1Raw, 'p20-b commands[2] (task 1)');
    const t2 = present(t2Raw, 'p20-b commands[3] (task 2)');
    const t3 = present(t3Raw, 'p20-b commands[4] (task 3)');
    const t4 = present(t4Raw, 'p20-b commands[5] (task 4)');
    const relaunchArgs = present(relaunchArgsRaw, 'p20-b commands[6] (relaunch)');
    const commands: P20Command[] = [];
    const record = (label: string, run: Run) =>
      commands.push({ label, args: run.args, code: run.code, stdout: run.stdout, stderr: run.stderr, ms: run.ms });
    // p20-a's agents leave with its daemon; p20-b's run starts with the daemon its launch starts.
    suite.record(context, await suite.asha(stop, 120_000));
    const from = startsSoFar();
    await suite.send(context, launch, 900_000);
    const slice = () => logFrom(from);
    /** The tasker's tasks.json writes in each of its containers' logs in p20-b's slice, oldest container first. */
    const writesPerContainer = (): number[] => {
      const dir = join(suite.home, 'logs', 'agents');
      const containers = slice()
        .filter((r) => r['event'] === 'agent.starting' && String(r['container']).startsWith(`asha-${CHANNEL}-tasker-`))
        .map((r) => String(r['container']));
      return containers.map((c) => {
        if (!readdirSync(dir).includes(`${c}.log`)) return 0;
        return readFileSync(join(dir, `${c}.log`), 'utf8')
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((r) => r['event'] === 'tool.file_written' && /(^|\/)tasks\.json$/.test(String(r['path']))).length;
      });
    };
    const posted = () => slice().filter((r) => r['event'] === 'channel.posted' && r['kind'] === 'input').length;
    record('task-1', await suite.send(context, t1, 120_000));
    record('task-2', await suite.send(context, t2, 120_000));
    const third = suite.send(context, t3, 120_000);
    await waitFor(posted, (n) => n >= 3, 60_000, "task 3's channel.posted");
    const fourth = suite.send(context, t4, 120_000);
    // The fault: task 3's write logged by the tasker and task 4 posted, then SIGKILL — the same moment every run.
    await killDaemonAt(
      suite.home,
      () => writesPerContainer()[0] === 3 && posted() >= 4,
      120_000,
      "task 3's tasks.json write and task 4's channel.posted",
    );
    record('task-3', await third);
    record('task-4', await fourth);

    // The relaunch, without --verbose: no message is sent after the restart.
    const relaunch = await suite.asha(relaunchArgs, 900_000, { verbose: false });
    record('relaunch', relaunch);
    suite.record(context, relaunch);

    const [first = 0, second = 0] = writesPerContainer();
    const tasksJson = await docker(['exec', containerFor(suite.home, 'tasker-1'), 'cat', '/workspace/tasks.json']);
    const results = checkP20({
      commands,
      daemonLog: slice(),
      writes: { first, second },
      tasksJson,
      boundMs: block.boundMs,
    });
    suite.prove(
      context,
      results.flatMap((r) => (r.verdict.ok ? [{ claim: r.claim, evidence: r.verdict.evidence }] : [])),
    );
    expect(
      results.filter((r) => !r.verdict.ok).map((r) => `${r.claim}: ${(r.verdict as { why: string }).why}`),
    ).toEqual([]);
    expect(P20_IDENTITY).toBe(`${CHANNEL}/resume/tasker`);
  });
});
