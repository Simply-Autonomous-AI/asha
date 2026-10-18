// Runs a pattern demo's scenario exactly as its page gives it
// (docs/plans/orchestration-patterns.md R2, R10, A1; docs/plans/patterns-phase-1.md
// R2, R3): the command from the page's run-command block, its conversation's
// daemon log records, its deliveries, the agent logs and /workspace files the
// scenario names (patterns-phase-2 R3) and its team folder read back, its checker run on them,
// the checker's proof recorded with the scenario, and the scenario failed
// exactly when the checker reports a failure.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type TestContext } from 'vitest';

import { present } from '../../../src/shared/assert-present.js';
import { scenarioCommands, withPrevious, type RunBlock } from '../../../evals/patterns/run-block.js';
import {
  agentLog,
  containerOf,
  conversationDeliveries,
  conversationLog,
  daemonAddress,
  readBoard,
  readWorkspaceFile,
  teamFiles,
  type AgentSuite,
  type Run,
  type TranscriptEvent,
} from '../support.js';
import { runClaims, type Claim, type LogRecord, type RunRecord } from './record.js';

/** A team's launch: bounded at 900 s, since the first launch of a run builds the image and loads the model. */
export const LAUNCH_TIMEOUT_MS = 900_000;
/** One scenario's message: a guard, far above any pattern's bound (at most 45 s, orchestration-patterns R8). */
export const MESSAGE_TIMEOUT_MS = 300_000;

/** Launches the demo's team, recorded as the scenario `launch`; fails unless every member came online. */
export async function launchTeam(
  suite: AgentSuite,
  context: TestContext,
  block: RunBlock,
  members: readonly string[],
): Promise<void> {
  suite.begin(context, {
    id: 'launch',
    title: `./asha ${block.launch.join(' ')}`,
    agents: [],
    expectation: `Every member comes online on channel ${suite.channel}: ${members.join(', ')}.`,
  });
  const run = await suite.send(context, block.launch, LAUNCH_TIMEOUT_MS);
  expect([run.code, run.stdout], run.stderr).toEqual([0, members.map((m) => `${m}\n`).join('')]);
}

export interface ScenarioProps {
  readonly suite: AgentSuite;
  readonly context: TestContext;
  readonly block: RunBlock;
  readonly id: string;
  readonly title: string;
  readonly expectation: string;
  readonly agents: readonly string[];
  readonly claims: readonly Claim[];
  /** Members whose agent logs the checker reads (a suite that names any sends that member one scenario only). */
  readonly agentLogs?: readonly string[];
  /** Files the checker reads from members' /workspace, by handle, read after the command exits and before the team stops. */
  readonly workspace?: Readonly<Record<string, readonly string[]>>;
  /**
   * Daemon records the checker reads that carry no conversation id (a member's `channel.left`), each awaited after the
   * command exits — a stop the channel starts asynchronously may land after the conversation settles — for at most
   * AWAIT_DAEMON_MS, then added to the record's log. One not found by then is simply absent, and its claim fails.
   */
  readonly awaitDaemon?: readonly { readonly event: string; readonly handle: string }[];
  /**
   * The fault the scenario injects around its first command (docs/plans/patterns-phase-3.md R2): `before` runs, and is
   * awaited, before the command is sent; `during` runs while it runs, given the command's run and the time just before
   * it was sent, and is awaited with it. Either failing fails the scenario.
   */
  readonly fault?: {
    readonly before?: () => Promise<void>;
    readonly during?: (run: Promise<Run>, since: string) => Promise<void>;
  };
  /**
   * The members' own daemon records the checker reads, which carry no conversation id (`agent.*`, `channel.rejoined`,
   * `channel.left`, …; patterns-phase-3 R3): every record from the scenario's start whose `handle` is one of `handles`,
   * that names one of `members` as its `member` on the suite's channel (`agent.starting`), or that is a
   * `blackboard.posted` on the suite's channel by one of `handles` (its `author`), in the log's order.
   */
  readonly members?: { readonly handles: readonly string[]; readonly members: readonly string[] };
  /**
   * Reads the scenario's board entries through the control API (docs/plans/patterns-phase-4.md R6): the last entry's id
   * before the first command, then every entry after it once the commands have exited.
   */
  readonly board?: true;
}

/** Bound on awaiting a daemon record after a command exits (a kill and its leave take well under a second). */
const AWAIT_DAEMON_MS = 30_000;

/**
 * The awaited daemon records at or after `since` — each on `channel`, or carrying no channel (`agent.stopping` names a
 * container and a handle) — polled once a second; one not logged within AWAIT_DAEMON_MS fails the scenario, naming it.
 */
async function daemonRecords(
  home: string,
  channel: string,
  since: string,
  wanted: readonly { readonly event: string; readonly handle: string }[],
): Promise<Record<string, unknown>[]> {
  if (wanted.length === 0) return [];
  const deadline = Date.now() + AWAIT_DAEMON_MS;
  for (;;) {
    const records = readFileSync(join(home, 'logs', 'daemon.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter(
        (r) =>
          (r['channel'] === undefined || r['channel'] === channel) &&
          String(r['ts']) >= since &&
          wanted.some((w) => w.event === r['event'] && w.handle === r['handle']),
      );
    const missing = wanted.filter((w) => !records.some((r) => r['event'] === w.event && r['handle'] === w.handle));
    if (missing.length === 0) return records;
    if (Date.now() > deadline) {
      const names = missing.map((w) => w.event + ' for ' + w.handle).join(', ');
      throw new Error(`no ${names} in the daemon log within ${String(AWAIT_DAEMON_MS)} ms of ${since}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** The records of the daemon's log, in its order. */
function daemonLog(home: string): Record<string, unknown>[] {
  return readFileSync(join(home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * The conversation's records and the members' own records from `since` (ScenarioProps.members), in the log's order,
 * with the awaited records not already among them after them.
 */
function scenarioLog(
  home: string,
  channel: string,
  since: string,
  conversation: string,
  own: ScenarioProps['members'],
  awaited: readonly LogRecord[],
): LogRecord[] {
  const mine = (r: Record<string, unknown>): boolean =>
    own !== undefined &&
    String(r['ts']) >= since &&
    (own.handles.includes(String(r['handle'])) ||
      (r['channel'] === channel && own.members.includes(String(r['member']))) ||
      (r['channel'] === channel && r['event'] === 'blackboard.posted' && own.handles.includes(String(r['author']))));
  const records = daemonLog(home).filter((r) => r['conversation'] === conversation || mine(r));
  const seen = new Set(records.map((r) => JSON.stringify(r)));
  return [...records, ...awaited.filter((r) => !seen.has(JSON.stringify(r)))];
}

/** A run as the checker reads it. */
const runRecord = (run: Run & { readonly events: TranscriptEvent[] }): RunRecord => ({
  args: run.args,
  code: run.code,
  stdout: run.stdout,
  events: run.events,
  ms: run.ms,
});

/**
 * Sends the scenario's commands from the page — one, or several in order, a later one's `conversation=@previous`
 * filled with the first command's conversation id (patterns-phase-3 R9) — with its fault around the first, checks its
 * records, and records the proof.
 */
export async function runScenario(props: ScenarioProps): Promise<void> {
  const { suite, context, block, id } = props;
  suite.begin(context, { id, title: props.title, agents: props.agents, expectation: props.expectation });
  const runs: (Run & { readonly events: TranscriptEvent[] })[] = [];
  let conversation: string | undefined;
  let since: string | undefined;
  // The board before the scenario: its entries are the ones after the last of these (the daemon runs by now: the launch).
  const boardBefore =
    props.board === true
      ? ((await readBoard({ daemon: daemonAddress(suite.home), channel: suite.channel, since: 0 })).at(-1)?.id ?? 0)
      : undefined;
  for (const [k, args] of scenarioCommands(block, id).entries()) {
    if (k === 0) await props.fault?.before?.();
    const at = new Date().toISOString();
    const sending = suite.send(context, withPrevious(args, conversation), MESSAGE_TIMEOUT_MS);
    const during = k === 0 ? props.fault?.during?.(sending, at) : undefined;
    const [run] = await Promise.all([sending, during]);
    runs.push(run);
    if (k === 0) {
      since = run.startedAt;
      conversation = conversationLog(suite.home, suite.channel, run.startedAt).conversation;
    }
  }
  const sinceValue = present(since, 'since (the scenario sent no command)');
  const conversationValue = present(conversation, 'conversation (the scenario sent no command)');
  const awaited = await daemonRecords(suite.home, suite.channel, sinceValue, props.awaitDaemon ?? []);
  const log = scenarioLog(suite.home, suite.channel, sinceValue, conversationValue, props.members, awaited);
  const workspace: Record<string, Record<string, string | null>> = {};
  for (const [handle, paths] of Object.entries(props.workspace ?? {})) {
    const container = containerOf(suite.home, suite.channel, handle);
    const files: Record<string, string | null> = {};
    for (const path of paths) files[path] = await readWorkspaceFile(container, path);
    workspace[handle] = files;
  }
  const board =
    boardBefore === undefined
      ? undefined
      : await readBoard({ daemon: daemonAddress(suite.home), channel: suite.channel, since: boardBefore });
  const result = runClaims(
    {
      scenario: id,
      run: runRecord(present(runs[0], 'runs[0] (the scenario sent no command)')),
      runs: runs.map(runRecord),
      conversation: conversationValue,
      log,
      team: teamFiles(block.team),
      boundMs: block.boundMs,
      deliveries: conversationDeliveries(suite.home, conversationValue).map((d) => d.handle),
      agentLogs: Object.fromEntries((props.agentLogs ?? []).map((h) => [h, agentLog(suite.home, suite.channel, h)])),
      workspace,
      ...(board === undefined ? {} : { board }),
    },
    props.claims,
  );
  suite.prove(context, result.proof);
  expect(result.failures, runs.map((r) => r.stderr).join('\n')).toEqual([]);
}
