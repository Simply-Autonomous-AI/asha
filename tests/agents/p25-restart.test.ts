// P25 · Supervisor restart: the demo of docs/patterns/p25-restart.md on the real model (docs/plans/patterns-phase-3.md
// R2, R5). It runs the team's launch and each scenario's message exactly as the page's run-command block gives them,
// with the fault the plan's Traces give each, through colima's docker (AGENTS.md §3): p25-a pauses worker-1's
// container before the message and kills it once the daemon logs the message posted, so the delivery is held and the
// agent frozen; p25-b does the same, then kills each container docker reports started for worker-1's restart. Each
// scenario is asserted only through its checker (tests/agents/patterns/phase-3.ts), whose proof it records.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { present } from '../../src/shared/assert-present.js';
import { harnessPaths } from '../../src/shared/paths.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P25_A, P25_B } from './patterns/phase-3.js';
import { DOCKER_HOST, REPO, agentSuite, containerOf, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p25-restart.md', REPO);
/** worker's recipe's restart window (teams/restart/worker.json): p25-b waits until p25-a's restart has left it. */
const WITHIN_MS = (
  JSON.parse(readFileSync(join(REPO, 'teams', 'restart', 'worker.json'), 'utf8')) as { restart: { withinMs: number } }
).restart.withinMs;
/** Bound on one docker command of the fault. */
const DOCKER_MS = 30_000;
/** Bound on the daemon logging the message posted once its command was sent. */
const POSTED_MS = 30_000;
let suite: AgentSuite;

/** One docker command, on colima's daemon (AGENTS.md §3: never a bare `docker`); a failure or a timeout throws with docker's words. */
function docker(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      'docker',
      args,
      { env: { ...process.env, DOCKER_HOST }, timeout: DOCKER_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`docker ${args.join(' ')}: ${stderr || error.message}`));
      },
    ),
  );
}

/** The daemon log's records, in order. */
function daemonLog(): Record<string, unknown>[] {
  return readFileSync(join(suite.home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Resolves once the daemon has logged the user's message to worker-1 posted at or after `since`; at most POSTED_MS. */
async function posted(since: string): Promise<void> {
  const deadline = Date.now() + POSTED_MS;
  for (;;) {
    if (
      daemonLog().some(
        (r) =>
          r['event'] === 'channel.posted' &&
          r['kind'] === 'input' &&
          r['to'] === 'worker-1' &&
          r['channel'] === suite.channel &&
          String(r['ts']) >= since,
      )
    )
      return;
    if (Date.now() > deadline)
      throw new Error(`no channel.posted of the message to worker-1 within ${String(POSTED_MS)} ms of ${since}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** p25-a's fault, and the start of p25-b's: worker-1's container paused before the message, killed once it is posted. */
function pauseThenKill(): {
  readonly before: () => Promise<void>;
  readonly during: (run: Promise<unknown>, since: string) => Promise<void>;
  readonly container: () => string;
} {
  let container = '';
  return {
    before: async () => {
      container = containerOf(suite.home, suite.channel, 'worker-1');
      await docker(['pause', container]);
    },
    during: async (_run, since) => {
      await posted(since);
      await docker(['kill', container]);
    },
    container: () => container,
  };
}

beforeAll(async () => {
  suite = await agentSuite('p25-restart', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P25 · Supervisor restart — teams/restart/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, ['worker-1']);
  });

  it('p25-a: worker-1 crashes holding the message, is restarted under its handle, and answers it', async (context) => {
    const fault = pauseThenKill();
    await runScenario({
      suite,
      context,
      block,
      id: 'p25-a',
      title: 'p25-a: worker-1 crashes holding the message, is restarted under its handle, and answers it',
      expectation:
        "worker-1's container, paused, is killed once the message is posted: one agent.exited_unexpectedly, then agent.restarting and agent.restarted within 5,000 ms, worker-1 rejoining under its handle; the message re-sent, and one output from worker-1, Hello World; no other error record; exit 0.",
      agents: ['worker-1'],
      claims: P25_A,
      fault,
      members: { handles: ['worker-1'], members: ['worker'] },
    });
  });

  it('p25-b: every restart of worker-1 is killed as it starts; after two restarts in the window the third exit is the limit', async (context) => {
    // Its window must hold only its own restarts: p25-a's restart leaves it WITHIN_MS after it began (the restart counts
    // every restart of worker-1 on the channel), so p25-b starts a second after that.
    const last = daemonLog()
      .filter((r) => r['event'] === 'agent.restarting' && r['handle'] === 'worker-1')
      .at(-1);
    if (last === undefined) throw new Error('p25-b follows p25-a, whose restart is not in the daemon log');
    const wait = Date.parse(String(last['ts'])) + WITHIN_MS + 1_000 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const first = pauseThenKill();
    let events: ChildProcess | undefined;
    /** The watcher's own failure — it could not start, or exited on its own — in docker's words. */
    let watcherFailure: string | undefined;
    const killed: Promise<string>[] = [];
    const watch = (since: string): void => {
      // Each container started for worker-1's restart, as docker reports its start, is killed (the plan's probe E).
      const homeId = harnessPaths({ ASHA_HOME: suite.home }).homeId;
      events = spawn(
        'docker',
        [
          'events',
          '--since',
          since,
          '--filter',
          'type=container',
          '--filter',
          'event=start',
          '--filter',
          `label=asha.home=${homeId}`,
          '--format',
          '{{.Actor.Attributes.name}}',
        ],
        {
          env: { ...process.env, DOCKER_HOST },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      present(events.stderr, "docker events's stderr stream").on(
        'data',
        (chunk: Buffer) => (stderr += chunk.toString('utf8')),
      );
      events.on('error', (error) => (watcherFailure = `docker events could not run: ${error.message}`));
      events.on('exit', (code, signal) => {
        // Killed by the suite (signal) is its end; any exit of its own is a failure the scenario must say.
        if (signal === null) watcherFailure = `docker events exited ${String(code)} on its own: ${stderr.trim()}`;
      });
      let buffered = '';
      present(events.stdout, "docker events's stdout stream").on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const lines = buffered.split('\n');
        buffered = present(lines.pop(), "the buffer's last split line");
        for (const name of lines) {
          if (!name.startsWith(`asha-${suite.channel}-worker-`) || name === first.container()) continue;
          const kill = docker(['kill', name]);
          // Handled here, awaited below: a failed kill fails the scenario with docker's words.
          kill.catch(() => undefined);
          killed.push(kill);
        }
      });
    };
    await runScenario({
      suite,
      context,
      block,
      id: 'p25-b',
      title:
        'p25-b: every restart of worker-1 is killed as it starts; after two restarts in the window the third exit is the limit',
      expectation:
        'As p25-a to the first exit, then each restarted container killed as it starts: three agent.exited_unexpectedly, two agent.restarting and no agent.restarted, then agent.restart_limit and no further start; the conversation ends with the error event restart_limit naming worker-1, and worker-1 leaves; no output; exit 1.',
      agents: ['worker-1'],
      claims: P25_B,
      fault: {
        before: async () => {
          await first.before();
          // From a second before now, so no start is missed between the watcher's spawn and its subscription.
          watch(((Date.now() - 1_000) / 1_000).toFixed(3));
        },
        during: async (run, since) => {
          try {
            await first.during(run, since);
            await run;
          } finally {
            events?.kill();
          }
          if (watcherFailure !== undefined) throw new Error(watcherFailure);
          // Every kill sent is awaited: one that failed (the container gone already) is the docker's words, which fail the scenario.
          await Promise.all(killed);
        },
      },
      members: { handles: ['worker-1'], members: ['worker'] },
    });
  });
});
