// Shared by the agent test suite (npm run test:agents): real agents in their
// real containers, through ./asha — the auto-started daemon, colima, the
// pinned model on llama-server, the agent image and the channel. Nothing is
// faked. Every ./asha run a scenario makes is recorded with its full
// transcript, and each suite writes tests/agents/results/<suite>.json with the
// commit it ran from; `npm run report` turns those into docs/testing/agent-tests.html.

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { expect, type TestContext } from 'vitest';

import { RESULTS_PATHS } from '../../evals/patterns/selection.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { harnessPaths } from '../../src/shared/paths.js';
import {
  AGENT_CHAT_TIMEOUT_MS,
  BLACKBOARD_MAX_ENTRIES,
  Routes,
  type BlackboardEntry,
  type BlackboardReadResponse,
} from '../../src/shared/protocol.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { startRecorder } from './patterns/recorder.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

export const REPO = resolve(import.meta.dirname, '..', '..');
const ASHA = join(REPO, 'asha');

export interface Run {
  readonly args: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** When the run started (ISO), so a daemon log record can be placed in it. */
  readonly startedAt: string;
  readonly ms: number;
}

/** One line of what ./asha printed to stderr, read back into what happened on the channel. */
export type TranscriptEvent =
  | { readonly type: 'posted'; readonly from: string; readonly to: string | null; readonly text: string }
  | { readonly type: 'status'; readonly from: string; readonly text: string }
  | { readonly type: 'output'; readonly from: string; readonly to: string }
  | { readonly type: 'internal'; readonly from: string; readonly to: string | null; readonly text: string }
  | { readonly type: 'failure'; readonly text: string }
  | { readonly type: 'progress'; readonly text: string };

/**
 * One non-continuation line of ./asha's stderr, read into the event it shows (extracted from parseTranscript to keep
 * its cognitive complexity down: same patterns, same order, same fallback to progress).
 */
function transcriptLine(line: string, channel: string): TranscriptEvent {
  const output = /^› output (\S+) → (\S+):$/.exec(line);
  if (output !== null)
    return { type: 'output', from: present(output[1], 'output[1]'), to: present(output[2], 'output[2]') };
  const internal = /^› internal (\S+) → (all agents|\S+): (.*)$/.exec(line);
  if (internal !== null)
    return {
      type: 'internal',
      from: present(internal[1], 'internal[1]'),
      to: internal[2] === 'all agents' ? null : present(internal[2], 'internal[2]'),
      text: present(internal[3], 'internal[3]'),
    };
  // Any ID the user-ID rule accepts (cli-interactive R16), not only an issued user-<n>: suites name their users.
  const posted = new RegExp(`^› ([a-z][a-z0-9-]{0,31}) → (?:(\\S+) on )?${channel}: (.*)$`).exec(line);
  if (posted !== null)
    return {
      type: 'posted',
      from: present(posted[1], 'posted[1]'),
      to: posted[2] ?? null,
      text: present(posted[3], 'posted[3]'),
    };
  // A handle is a base name — a team member's may hold hyphens (stage-a-1) — and its number.
  const status = /^› ([a-z][a-z0-9-]*-\d+): (.*)$/.exec(line);
  if (status !== null)
    return { type: 'status', from: present(status[1], 'status[1]'), text: present(status[2], 'status[2]') };
  if (line.startsWith('✗ ')) return { type: 'failure', text: line.slice(2) };
  return { type: 'progress', text: line.replace(/^› /, '') };
}

/**
 * Parses ./asha's stderr. The formats are the CLI's (src/cli/commands.ts,
 * ConversationTracker); a line that matches none is kept as progress, so
 * nothing is silently dropped. Continuation lines of a multi-line message are
 * indented four spaces and are appended to the message they belong to.
 */
export function parseTranscript(stderr: string, channel: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of stderr.split('\n')) {
    if (line === '') continue;
    const previous = events.at(-1);
    if (
      line.startsWith('    ') &&
      previous !== undefined &&
      'text' in previous &&
      previous.type !== 'progress' &&
      previous.type !== 'failure'
    ) {
      events[events.length - 1] = { ...previous, text: `${previous.text}\n${line.slice(4)}` };
      continue;
    }
    events.push(transcriptLine(line, channel));
  }
  return events;
}

/**
 * A run `send` records must show what happened on the channel, which only --verbose prints: without a `›` line its
 * transcript would be empty, and every assertion that something is absent from stderr would pass unread
 * (cli-interactive R15). Throws naming the run's arguments.
 */
export function requireProgress(run: Pick<Run, 'args' | 'stderr'>): void {
  // The login-name line (cli-interactive R16) is printed with or without --verbose, so it proves nothing.
  const progress = (line: string) => line.startsWith('› ') && !line.startsWith('› your login name "');
  if (!run.stderr.split('\n').some(progress)) {
    throw new Error(
      `asha ${run.args.join(' ')} printed no progress (no › line on stderr): run it with --verbose\nstderr: ${run.stderr}`,
    );
  }
}

/**
 * A message send must name its user: without user= the CLI sends the machine's login name (cli-interactive R16),
 * which would then be written into the committed results. Throws before anything runs; a --launch needs none.
 */
export function requireUser(args: readonly string[]): void {
  if (args.some((a) => a.startsWith('message=')) && !args.some((a) => a.startsWith('user='))) {
    throw new Error('send(): a message needs user=');
  }
}

/** A scenario as the report shows it: what it sets up and what it expects. */
interface Scenario {
  readonly id: string;
  readonly title: string;
  /** The agents on the channel when the message is sent. */
  readonly agents: readonly string[];
  readonly expectation: string;
}

interface Recorded {
  readonly scenario: Scenario;
  readonly runs: (Run & { readonly events: TranscriptEvent[] })[];
  state: 'pass' | 'fail';
  errors: string[];
  /** A pattern scenario's proof: each claim with the evidence that shows it (docs/plans/orchestration-patterns.md R10). */
  proof?: readonly { readonly claim: string; readonly evidence: string }[];
}

/** How one ./asha run is made: `verbose: false` leaves out --verbose; `cwd` is its working directory (the repo's when not given). */
interface RunOptions {
  readonly verbose?: false;
  /** Where the run's relative paths resolve and its returned files are saved (agent-files R12a): a suite's own folder, never the repo. */
  readonly cwd?: string;
}

export interface AgentSuite {
  readonly channel: string;
  /** This suite's harness home (logs, daemon file). */
  readonly home: string;
  /**
   * Runs ./asha --verbose with this suite's home; a hung run is killed and fails (a guard, PRINCIPLES §14.5).
   * `verbose: false` runs it without --verbose, for a scenario that asserts the default output (agent-persistence p20-b).
   */
  asha(args: readonly string[], timeoutMs: number, options?: RunOptions): Promise<Run>;
  /** Runs ./asha for the current scenario and records the run in its transcript; a run with no progress fails. */
  send(
    context: TestContext,
    args: readonly string[],
    timeoutMs: number,
    options?: Pick<RunOptions, 'cwd'>,
  ): Promise<Run & { readonly events: TranscriptEvent[] }>;
  /** Starts recording a scenario; call first in each test. */
  begin(context: TestContext, scenario: Scenario): void;
  /** Records the current scenario's proof: its checker's claims that hold, with their evidence (orchestration-patterns R10). */
  prove(context: TestContext, proof: readonly { readonly claim: string; readonly evidence: string }[]): void;
  /**
   * Records a run made with asha() rather than send() — one that must run without --verbose, so it prints no progress
   * — in the current scenario's transcript, so its output and ms are in the results (agent-persistence p20-b's relaunch).
   */
  record(context: TestContext, run: Run): void;
  /** Stops the daemon and writes tests/agents/results/<name>.json. */
  finish(): Promise<void>;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

/** A fresh harness home for one suite; the model cache is shared so a run does not re-download 5 GB. */
export async function agentSuite(name: string, channel: string): Promise<AgentSuite> {
  const home = await mkdtemp(join(tmpdir(), `asha-agents-${name}-`));
  const env = {
    ...process.env,
    ...TEST_DAEMON_ENV,
    ASHA_HOME: home,
    // The same cache the demo selector fingerprints (docs/plans/demo-selector.md R7).
    ASHA_MODELS_DIR: harnessPaths({ ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] }).modelsDir,
  };
  const recorded = new Map<string, Recorded>();
  const commit = git(['rev-parse', 'HEAD']);
  // Results files don't make the tree dirty: they are test runs' output (this suite's and the routing
  // eval's), not an input to these agents.
  const dirty = git(['status', '--porcelain', '--', '.', ...RESULTS_PATHS.map((path) => `:!${path}`)]) !== '';
  const startedAt = new Date().toISOString();
  // A pattern demo recorded by `npm run demos:record` (docs/plans/demo-videos.md R1): the recorder follows this suite's
  // daemon from here, starting none of its own, and ends before the suite's --stop.
  const recordDir = process.env['ASHA_RECORD_DIR'];
  if (recordDir !== undefined && !isAbsolute(recordDir))
    throw new Error(`ASHA_RECORD_DIR must be an absolute path, not ${JSON.stringify(recordDir)}`);
  const recorder =
    recordDir === undefined ? undefined : startRecorder({ dir: recordDir, suite: name, home, channel, repo: REPO });

  // Every run asks for progress: the transcripts and the stderr assertions read it (cli-interactive R15).
  const asha = (given: readonly string[], timeoutMs: number, options?: RunOptions): Promise<Run> =>
    new Promise((resolveRun, reject) => {
      const t0 = Date.now();
      const startedAt = new Date(t0).toISOString();
      const args = options?.verbose === false ? [...given] : ['--verbose', ...given];
      execFile(
        ASHA,
        args,
        { env, cwd: options?.cwd ?? REPO, timeout: timeoutMs, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error && error.killed) {
            reject(
              new Error(
                `asha ${args.join(' ')} exceeded ${String(timeoutMs)} ms\nstdout: ${stdout}\nstderr: ${stderr}`,
              ),
            );
            return;
          }
          if (error && typeof error.code !== 'number') {
            reject(error instanceof Error ? error : new Error(error.message));
            return;
          }
          resolveRun({
            args,
            code: typeof error?.code === 'number' ? error.code : 0,
            stdout,
            stderr,
            startedAt,
            ms: Date.now() - t0,
          });
        },
      );
    });

  return {
    channel,
    home,
    asha,
    begin(context, scenario) {
      const entry: Recorded = { scenario, runs: [], state: 'fail', errors: [] };
      recorded.set(context.task.id, entry);
      context.onTestFinished(({ task }) => {
        entry.state = task.result?.state === 'pass' ? 'pass' : 'fail';
        entry.errors = (task.result?.errors ?? []).map((e) => e.message);
      });
    },
    record(context, run) {
      const entry = recorded.get(context.task.id);
      if (entry === undefined) throw new Error('record() before begin(): every scenario must be recorded');
      entry.runs.push({ ...run, events: parseTranscript(run.stderr, channel) });
    },
    prove(context, proof) {
      const entry = recorded.get(context.task.id);
      if (entry === undefined) throw new Error('prove() before begin(): every scenario must be recorded');
      entry.proof = proof;
    },
    async send(context, args, timeoutMs, options) {
      const entry = recorded.get(context.task.id);
      if (entry === undefined) throw new Error('send() before begin(): every scenario must be recorded');
      requireUser(args);
      const run = await asha(args, timeoutMs, options);
      requireProgress(run);
      const withEvents = { ...run, events: parseTranscript(run.stderr, channel) };
      entry.runs.push(withEvents);
      return withEvents;
    },
    async finish() {
      await recorder?.end();
      return finishSuite({
        name,
        home,
        commit,
        dirty,
        startedAt,
        scenarios: [...recorded.values()],
        // --stop waits up to 90 s itself (an agent's 70 s stop grace, then the model servers); after a recorder's end
        // (END_BUDGET_MS, 18 s, at most), inside the 120 s hook bound.
        stop: () => asha(['--stop'], 100_000),
        resultsDir: join(REPO, 'tests', 'agents', 'results'),
        llamaServers: hostLlamaServers,
        volumesLeft: () => homeVolumes(home),
      });
    },
  };
}

/** What finishing a suite needs; agentSuite passes the real ones, the unit tests fixtures. */
export interface FinishSuiteProps {
  readonly name: string;
  /** The suite's harness home: its daemon log is read, and a model server whose command line names it is the suite's own. */
  readonly home: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly startedAt: string;
  readonly scenarios: readonly unknown[];
  /** Stops the suite's daemon (`./asha --stop`). */
  readonly stop: () => Promise<Pick<Run, 'code' | 'stdout' | 'stderr'>>;
  /** Where `<name>.json` is written. */
  readonly resultsDir: string;
  /** The llama-server processes running on the host now. */
  readonly llamaServers: () => readonly HostProcess[];
  /** The volumes labelled with the suite's home still in the VM: none may remain after its stop (agent-files R10a). */
  readonly volumesLeft: () => readonly string[];
}

/**
 * Stops the suite's daemon, writes its results file, then fails the suite if the stop was unclean, lost
 * started work, or any model call came within a quarter of the chat bound (the margin check).
 */
export async function finishSuite(props: FinishSuiteProps): Promise<void> {
  const stopped = await props.stop();
  const calls = modelCalls(props.home);
  await mkdir(props.resultsDir, { recursive: true });
  const results = {
    suite: props.name,
    commit: props.commit,
    dirty: props.dirty,
    startedAt: props.startedAt,
    finishedAt: new Date().toISOString(),
    // Every model call the daemon served for this suite, with its duration: the latency record behind the
    // chat bound's margin (PRINCIPLES §13; agent-tools completion review, finding 6).
    modelCalls: calls,
    scenarios: props.scenarios,
  };
  await writeFile(join(props.resultsDir, `${props.name}.json`), `${JSON.stringify(results, null, 1)}\n`);
  // The stop-time race (enterprise-targets F2): a clean stop loses no started work, silently or loudly.
  expect({ code: stopped.code, stdout: stopped.stdout, stderr: stopped.stderr }).toMatchObject({ code: 0 });
  expect(stopTimeErrors(props.home)).toEqual([]);
  // The stop's reclaim removed every channel file space of the home (agent-files R10a).
  expect(props.volumesLeft(), `volumes labelled with ${props.name}'s home after its stop`).toEqual([]);
  const slow = slowChatCalls(calls);
  if (slow.length > 0)
    throw new Error(marginFailure(props.name, slow, foreignLlamaServers(props.llamaServers(), props.home)));
}

/**
 * Each handle's first `model.chat` on `channel` logged at or after `since` (an ISO time), in `handles` order: the
 * first model call of that agent's turn for a message sent at `since`. A handle with none is left out.
 */
export function firstChatCalls(
  calls: readonly ModelCallRecord[],
  channel: string,
  handles: readonly string[],
  since: string,
): ModelCallRecord[] {
  return handles.flatMap((handle) => {
    const first = calls.find(
      (c) => c.event === 'model.chat' && c.channel === channel && c.handle === handle && c.at >= since,
    );
    return first === undefined ? [] : [first];
  });
}

/** The calls whose prompt the server took at least 90 % from its prompt cache (prompt-prefix R13). */
export function cacheHits(calls: readonly ModelCallRecord[]): ModelCallRecord[] {
  return calls.filter(
    (c) => c.promptTokens !== undefined && c.cachedTokens !== undefined && c.cachedTokens >= 0.9 * c.promptTokens,
  );
}

/**
 * The most a chat call may take and leave the chat bound its margin: 75 % of AGENT_CHAT_TIMEOUT_MS
 * (docs/plans/prompt-prefix.md R14; debt D19). A call nearer the bound is a guard about to fail a correct
 * run (PRINCIPLES §14.5), so the suite fails now, while the cause can still be found.
 */
const CHAT_MARGIN_MS = Math.floor(AGENT_CHAT_TIMEOUT_MS * 0.75);

/** The chat calls (`model.chat`, `model.chat_failed`) that took longer than CHAT_MARGIN_MS. */
function slowChatCalls(calls: readonly ModelCallRecord[]): ModelCallRecord[] {
  return calls.filter((c) => (c.event === 'model.chat' || c.event === 'model.chat_failed') && c.ms > CHAT_MARGIN_MS);
}

/** The colima VM's docker socket, as ColimaRuntime uses it (the default profile). */
export const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;

/**
 * The volumes labelled with a harness home's id (`docker volume ls --filter label=asha.home=<id>`, agent-files R10a).
 * A failing docker throws: an empty list must mean none, never "the listing did not run" (PRINCIPLES §14).
 */
export function homeVolumes(home: string): string[] {
  const out = execFileSync(
    'docker',
    ['volume', 'ls', '--quiet', '--filter', `label=asha.home=${harnessPaths({ ASHA_HOME: home }).homeId}`],
    {
      encoding: 'utf8',
      env: { ...process.env, DOCKER_HOST },
      timeout: 30_000,
    },
  );
  return out.split('\n').filter((v) => v !== '');
}

/** A process on the host: its pid and its command line. */
export interface HostProcess {
  readonly pid: number;
  readonly command: string;
}

/** Every llama-server running on the host now (`ps`), with its full command line. A failing `ps` throws. */
export function hostLlamaServers(): HostProcess[] {
  const out = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', timeout: 10_000 });
  return out.split('\n').flatMap((line) => {
    // The command is read by slicing past the matched "pid " prefix, not by a trailing `(.*)$` capture group, so
    // the pattern never pairs a `\s+` quantifier against the `.` it overlaps with (sonarjs/super-linear-regex).
    const head = /^\s*(\d+)\s+/.exec(line);
    if (head === null) return [];
    const command = line.slice(head[0].length);
    const firstArg = /^\S+/.exec(command);
    if (firstArg === null || !/(^|\/)llama-server$/.test(firstArg[0])) return [];
    return [{ pid: Number(head[1]), command }];
  });
}

/**
 * The llama-servers this suite's daemon did not start — each of its own names the suite's home in its
 * `--api-key-file` — with any key file path, key or Hugging Face token on their command lines left out
 * (`--hf-token`/`-hft`, llama-server 0.5.0's `--help`, read 2026-09-29; added after prompt-prefix's completion review).
 */
function foreignLlamaServers(processes: readonly HostProcess[], home: string): HostProcess[] {
  const hidden: Readonly<Record<string, string>> = {
    '--api-key-file': 'key file',
    '--api-key': 'key',
    '--hf-token': 'token',
    '-hft': 'token',
  };
  return processes
    .filter((p) => !p.command.includes(home))
    .map((p) => ({
      pid: p.pid,
      command: p.command.replace(
        /(?<=^|\s)(--api-key-file|--api-key|--hf-token|-hft)(\s+|=)\S+/g,
        (_, flag: string) => `${flag} <${present(hidden[flag], 'hidden[' + flag + ']')}>`,
      ),
    }));
}

/** The margin check's failure: the suite, each slow call's handle and duration, and the other model servers running (the owner's answer of 2026-09-27, record targets-shared-mac). */
export function marginFailure(
  suite: string,
  slow: readonly ModelCallRecord[],
  foreign: readonly HostProcess[],
): string {
  return [
    `${suite}: ${String(slow.length)} model call(s) took more than ${CHAT_MARGIN_MS.toLocaleString('en-US')} ms, 75 % of the ${AGENT_CHAT_TIMEOUT_MS.toLocaleString('en-US')} ms chat bound:`,
    ...slow.map((c) => `  ${c.handle} ${c.event} ${c.ms.toLocaleString('en-US')} ms at ${c.at}`),
    foreign.length === 0
      ? 'No other llama-server was running when the suite finished.'
      : `Other llama-server processes running (not this suite's daemon's; stop them and re-run):`,
    ...foreign.map((p) => `  pid ${String(p.pid)}: ${p.command}`),
  ].join('\n');
}

/**
 * One model call as the daemon logged it (`model.chat`, `model.chat_failed`, `model.embed`, `model.embed_failed`).
 * A `model.chat` also carries the prompt tokens the server counted and how many came from its prompt cache
 * (docs/plans/prompt-prefix.md R10).
 */
export interface ModelCallRecord {
  readonly at: string;
  readonly event: string;
  readonly channel: string;
  readonly handle: string;
  readonly model: string;
  readonly ms: number;
  readonly promptTokens?: number;
  readonly cachedTokens?: number;
}

/**
 * Every model call in a home's daemon log, in order. A log that cannot be read, or a `model.chat` without
 * both token counts as non-negative integers, throws, failing the suite's finish.
 */
export function modelCalls(home: string): ModelCallRecord[] {
  return readFileSync(join(home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((r) => typeof r['event'] === 'string' && /^model\.(chat|embed)(_failed)?$/.test(r['event']))
    .map((r) => {
      const call = {
        at: String(r['ts']),
        event: String(r['event']),
        channel: String(r['channel']),
        handle: String(r['handle']),
        model: String(r['model']),
        ms: Number(r['ms']),
      };
      if (call.event !== 'model.chat') return call;
      const count = (field: string): number => {
        const value = r[field];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
          throw new Error(`model.chat at ${call.at} (${call.handle}) has no ${field}: ${JSON.stringify(r)}`);
        return value;
      };
      return { ...call, promptTokens: count('promptTokens'), cachedTokens: count('cachedTokens') };
    });
}

/**
 * What a stop left undone, each named with its file: an error-level record in the daemon log at or after
 * its `daemon.stopping`, and any record in an agent's log that says started work or saved memory was lost —
 * `agent.drain_incomplete`, `agent.background_failed`, `memory.write_failed`, `memory.save_failed`, and
 * `memory.file_malformed` and `memory.records_dropped`: a memory file healed to empty, or records dropped from it, lose
 * what it held (the owner, 2026-10-11, record `memory-unreadable-session-episodic`: a malformed tier file is a major
 * defect, logged loudly for the failure scan).
 */
export function stopTimeErrors(home: string): string[] {
  const records = (file: string): Record<string, unknown>[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      // An agent's log also holds plain lines and stack traces; only JSON records are read (as jq's `fromjson?`).
      .flatMap((line) => {
        if (!line.startsWith('{')) return [];
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  const found: string[] = [];
  const daemonLog = join(home, 'logs', 'daemon.jsonl');
  let stopping = false;
  for (const r of records(daemonLog)) {
    if (r['event'] === 'daemon.started') stopping = false;
    if (r['event'] === 'daemon.stopping') stopping = true;
    if (stopping && r['level'] === 'error') found.push(`${daemonLog}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  const lost = new Set([
    'agent.drain_incomplete',
    'agent.background_failed',
    'memory.write_failed',
    'memory.save_failed',
    'memory.file_malformed',
    'memory.records_dropped',
  ]);
  const agents = join(home, 'logs', 'agents');
  for (const name of readdirSync(agents)) {
    for (const r of records(join(agents, name))) {
      if (lost.has(String(r['event']))) found.push(`${join(agents, name)}: ${JSON.stringify(r).slice(0, 300)}`);
    }
  }
  return found;
}

/** The agents' answers to the user: every output line, in order. */
export function outputs(events: readonly TranscriptEvent[]): { from: string; to: string }[] {
  return events.flatMap((e) => (e.type === 'output' ? [{ from: e.from, to: e.to }] : []));
}

/** Messages agents posted to the whole channel. */
export function toAll(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  return events.filter((e) => e.type === 'internal' && e.to === null);
}

/** A memory tier's contents as the agent stored them: each record's text (a session turn as "input => response"). */
export type MemoryContents = Readonly<Record<'session' | 'episodic' | 'semantic' | 'procedural', readonly string[]>>;

/**
 * Reads one user's memory files from inside the memory agent's container
 * (memory lives only there — the owner's option A), by `docker exec`. The
 * container is the newest one of `recipe` on `channel` in this suite's agent
 * logs (container names are asha-<channel>-<recipe>-<id>). Choosing by channel
 * matters: a suite may run the recipe on two channels. A tier with no file yet
 * reads as empty.
 */
export async function readMemory(
  home: string,
  channel: string,
  recipe: string,
  scopeKey: string,
): Promise<MemoryContents> {
  const logs = readdirSync(join(home, 'logs', 'agents')).filter((f) => f.startsWith(`asha-${channel}-${recipe}-`));
  if (logs.length === 0) throw new Error(`no ${recipe} agent on channel "${channel}" in ${home}`);
  const newest = logs
    .map((f) => ({ f, t: statSync(join(home, 'logs', 'agents', f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const container = present(newest[0], 'newest[0]').f.replace(/\.log$/, '');
  return readContainerMemory(container, scopeKey);
}

/** The container an agent runs in, from the daemon's log (agent.connected names both). */
export function containerOf(home: string, channel: string, handle: string): string {
  const lines = readFileSync(join(home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const found = lines
    .filter((r) => r['event'] === 'agent.connected' && r['channel'] === channel && r['handle'] === handle)
    .at(-1);
  if (found === undefined) throw new Error(`no agent.connected for ${handle} on "${channel}" in ${home}`);
  return String(found['container']);
}

/** One user's memory, read from inside the given agent container. */
export async function readContainerMemory(container: string, scopeKey: string): Promise<MemoryContents> {
  const script = [
    "const fs=require('fs');const out={};",
    "for (const t of ['session','episodic','semantic','procedural']) {",
    `  const f='/memory/${scopeKey}/'+t+'.json';`,
    '  if (!fs.existsSync(f)) { out[t]=[]; continue; }',
    "  const d=JSON.parse(fs.readFileSync(f,'utf8'));",
    "  out[t]=(d.turns||d.records).map(r=>r.text!==undefined?r.text:r.input+' => '+r.response);",
    '}',
    'console.log(JSON.stringify(out));',
  ].join('');
  const stdout = await new Promise<string>((resolveOut, reject) =>
    execFile(
      'docker',
      ['exec', container, 'node', '-e', script],
      { env: { ...process.env, DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock` }, timeout: 30_000 },
      (error, out, err) => {
        if (error) reject(new Error(`docker exec ${container}: ${err || error.message}`));
        else resolveOut(out);
      },
    ),
  );
  return JSON.parse(stdout) as MemoryContents;
}

/** Polls `read` until `done` holds, at most `timeoutMs`: memory is written asynchronously after the reply. */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * The daemon log records of the conversation a message started: the first `conversation.started` on `channel` at or
 * after `since` (an ISO time: the run's start) names it, and every record carrying its id is returned, in order.
 * No such conversation throws: the run posted nothing.
 */
export function conversationLog(
  home: string,
  channel: string,
  since: string,
): { readonly conversation: string; readonly log: Record<string, unknown>[] } {
  const records = readFileSync(join(home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const started = records.find(
    (r) => r['event'] === 'conversation.started' && r['channel'] === channel && String(r['ts']) >= since,
  );
  if (started === undefined) throw new Error(`no conversation.started on "${channel}" at or after ${since} in ${home}`);
  const conversation = String(started['conversation']);
  return { conversation, log: records.filter((r) => r['conversation'] === conversation) };
}

/** Every file of teams/<team>/ as text, by its path relative to the folder (links read through); `root` the repo's (fixtures pass a copy's). */
export function teamFiles(team: string, root = REPO): Record<string, string> {
  const dir = join(root, 'teams', team);
  const walk = (sub: string): string[] =>
    readdirSync(join(dir, sub), { withFileTypes: true }).flatMap((e) => {
      const path = sub === '' ? e.name : `${sub}/${e.name}`;
      return e.isDirectory() ? walk(path) : [path];
    });
  return Object.fromEntries(
    walk('')
      .sort(byCodeUnit)
      .map((path) => [path, readFileSync(join(dir, path), 'utf8')]),
  );
}

/** One asha.delivery span of a conversation's trace: the handle it went to, and when it started and ended. */
export interface DeliverySpan {
  readonly handle: string;
  readonly start: string;
  readonly end: string;
}

/**
 * Every asha.delivery span of the conversation's trace (logs/traces-<date>.jsonl), in start order: one per delivery
 * the channel made — an input, a message to an agent, a call's question, a gather — and none for a call's answer or a
 * reply, which go to no agent (docs/plans/agent-calls.md R7). No span at all throws: the trace was not found.
 */
export function conversationDeliveries(home: string, conversation: string): DeliverySpan[] {
  const trace = traceIdFor(conversation);
  const dir = join(home, 'logs');
  const spans = readdirSync(dir)
    .filter((n) => /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .flatMap((n) => readFileSync(join(dir, n), 'utf8').trim().split('\n'))
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { traceId: string; name: string; handle: string; start: string; end: string })
    .filter((s) => s.traceId === trace && s.name === 'asha.delivery')
    .map((s) => ({ handle: s.handle, start: s.start, end: s.end }));
  if (spans.length === 0) throw new Error(`no asha.delivery span in trace ${trace} under ${dir}`);
  return spans.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Every JSON record of one agent's log (logs/agents/<container>.log), in order. Not cut at a time: the records' `ts`
 * is the container's clock, not the host's, so a suite that reads an agent's log sends it one scenario only. The log
 * also holds plain lines ("joining the channel as hewo", a crash's stack), which are not records: a line that is
 * not a JSON object is skipped, and only such a line (a SyntaxError) — any other failure throws.
 */
export function agentLog(home: string, channel: string, handle: string): Record<string, unknown>[] {
  const file = join(home, 'logs', 'agents', `${containerOf(home, channel, handle)}.log`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((l) => {
      if (!l.startsWith('{')) return [];
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch (error) {
        if (error instanceof SyntaxError) return [];
        throw error;
      }
    });
}

/**
 * A file of an agent's /workspace, read from its running container (`docker exec … cat`), or null when the file does
 * not exist there. Any other failure — no container, docker not answering, 30 s passed — throws with docker's words.
 */
export function readWorkspaceFile(container: string, path: string): Promise<string | null> {
  return new Promise((resolveFile, reject) => {
    execFile(
      'docker',
      ['exec', container, 'cat', `/workspace/${path}`],
      {
        env: { ...process.env, DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock` },
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
      (error, out, err) => {
        if (error === null) resolveFile(out);
        else if (typeof error.code === 'number' && /No such file or directory/.test(err)) resolveFile(null);
        else reject(new Error(`docker exec ${container} cat /workspace/${path}: ${err || error.message}`));
      },
    );
  });
}

/** Bound on one read of a channel's board through the control API (docs/plans/patterns-phase-4.md R6): a read answers from memory. */
export const BOARD_READ_TIMEOUT_MS = 10_000;

/** The running daemon's port and control credential, from the suite home's daemon.json (never printed or recorded). */
export function daemonAddress(home: string): { readonly port: number; readonly credential: string } {
  const { port, credential } = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as {
    port: number;
    credential: string;
  };
  return { port, credential };
}

export interface ReadBoardProps {
  readonly daemon: { readonly port: number; readonly credential: string };
  readonly channel: string;
  /** Entries after this id; 0 for every entry. */
  readonly since: number;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * A channel's board entries after `since`, read through `GET /v1/blackboard` with the control credential, paging while
 * `more` (patterns-phase-4 R1, R6). Each request is bounded at BOARD_READ_TIMEOUT_MS; any status but 200, a bound
 * passed, or a page with `more` and no entry throws, naming the status or the bound and never the credential.
 */
export async function readBoard(props: ReadBoardProps): Promise<BlackboardEntry[]> {
  const get = props.fetch ?? fetch;
  const bound = props.timeoutMs ?? BOARD_READ_TIMEOUT_MS;
  const entries: BlackboardEntry[] = [];
  let after = props.since;
  // A board holds at most 256 entries, so at most 256 pages carry one.
  for (let page = 0; page < BLACKBOARD_MAX_ENTRIES + 1; page++) {
    const path = `${Routes.blackboard}?channel=${encodeURIComponent(props.channel)}&since=${String(after)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`GET ${path} passed its ${String(bound)} ms bound`));
    }, bound);
    let body: BlackboardReadResponse;
    try {
      const response = await get(`http://127.0.0.1:${String(props.daemon.port)}${path}`, {
        headers: { authorization: `Bearer ${props.daemon.credential}` },
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status !== 200)
        throw new Error(`GET ${path} answered ${String(response.status)}: ${text.slice(0, 200)}`);
      body = JSON.parse(text) as BlackboardReadResponse;
    } catch (error) {
      if (controller.signal.aborted) throw new Error((controller.signal.reason as Error).message, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
    entries.push(...body.entries);
    if (!body.more) return entries;
    if (body.entries.length === 0) throw new Error(`GET ${path} answered more with no entry`);
    after = present(body.entries.at(-1), 'body.entries.at(-1)').id;
  }
  throw new Error(`the board of ${props.channel} did not end within ${String(BLACKBOARD_MAX_ENTRIES + 1)} pages`);
}
