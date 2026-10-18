// What the routing eval records, and how it runs one attempt, apart from
// run.ts so the unit tests can reach it (tests/unit/routing.test.ts): the
// llama-server version, the request each case sends as it reached the model
// server (captured from the fetch the gateway is given, never rebuilt), and
// every model round of every attempt with the tool results sent back after
// it (docs/plans/channel-instructions.md, R6). Also the runner's arguments
// and the gate's verdict (R9, R10).

import { createHash } from 'node:crypto';

import {
  CONSULT,
  LIST_AGENTS,
  PASS,
  REPLY,
  SEND_MESSAGE,
  decide,
  requestedActions,
  type ModelClient,
} from '../../src/agent-sdk/index.js';
import { chatCompletion } from '../../src/daemon/model-gateway/index.js';
import type { ModelEndpoint } from '../../src/daemon/model-server/index.js';
import type { CommandRunner } from '../../src/daemon/process/index.js';
import { present } from '../../src/shared/assert-present.js';
import type { AgentInfo, ChatRequest, ConversationMessage } from '../../src/shared/protocol.js';
import type { RoutingCase } from './cases.js';

/**
 * The line of `llama-server --version` that names the build. Two formats seen on this machine:
 * build 8130, `version: 8130 (ed4837891)`; Homebrew 0.5.0 (2026-09-27), `version: 0.5.0 (build 11146, commit 7fe450e19)`.
 */
export const VERSION_LINE = /^version: (?:\d+ \([0-9a-f]+\)|\d+\.\d+\.\d+ \(build \d+, commit [0-9a-f]+\))$/m;

/** llama-server's version line could not be read; the run stops before any case. */
export class VersionUnreadable extends Error {
  constructor(detail: string) {
    super(`llama-server --version: ${detail}`);
    this.name = 'VersionUnreadable';
  }
}

/** The version line from `llama-server --version` output (stdout and stderr together); throws when there is none. */
export function versionLine(output: string): string {
  const match = VERSION_LINE.exec(output);
  if (match === null) throw new VersionUnreadable(`no line matches ${VERSION_LINE.source} in: ${output.slice(-500)}`);
  return match[0];
}

/** Runs `llama-server --version` and returns its version line; a non-zero exit or no version line throws. */
export async function llamaServerVersion(runner: CommandRunner): Promise<string> {
  const result = await runner.run('llama-server', ['--version'], { timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) throw new VersionUnreadable(`exit ${String(result.code)}: ${output.slice(-500)}`);
  return versionLine(output);
}

/** One call the model made in a round, as the gateway parsed it. */
export interface RecordedCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** One tool result sent back to the model after a round. */
export interface RecordedToolResult {
  readonly toolCallId: string;
  readonly content: string;
}

/** One model round: what the model returned (or why the call failed), and the tool results sent back after it. */
export type Round =
  | {
      readonly toolCalls: readonly RecordedCall[];
      readonly text: string;
      readonly toolResults: readonly RecordedToolResult[];
    }
  | { readonly failed: string; readonly detail: string; readonly toolResults: readonly RecordedToolResult[] };

/**
 * One destination of the model's final calls: its tool, and where and what it would post. A reply's destination
 * is "user", or in a call turn the caller; a consult is one action per request, in order (agent-calls R14).
 */
export interface Action {
  readonly tool: typeof REPLY | typeof SEND_MESSAGE | typeof CONSULT;
  readonly to: string;
  readonly text: string;
}

export interface Attempt {
  readonly actions: readonly Action[] | null;
  /** list_agents calls the model made before acting. */
  readonly lookups: number;
  /** Reasons the model gave with pass, if it took no action. */
  readonly passed?: readonly string[];
  /** Set when the model answered with text instead of a tool call, or the call failed. */
  readonly problem: string | null;
  /** sha256 of this attempt's first request body. */
  readonly requestSha256: string;
  /** Every model round, in order. */
  readonly rounds: readonly Round[];
}

/** An attempt, and its first request body exactly as it was sent. */
export interface RecordedAttempt {
  readonly attempt: Attempt;
  readonly firstRequest: string;
}

export interface AttemptProps {
  /** The fetch the gateway is given; every body sent through it is captured. */
  readonly fetch: typeof fetch;
  readonly endpoint: ModelEndpoint;
  readonly chatDefaults: Readonly<Record<string, unknown>>;
  readonly toolCallStart: string;
  /** The turn's first request, as the agent builds it. */
  readonly request: ChatRequest;
  /** The message the turn is for: in a call turn, a reply goes to its sender. */
  readonly message: ConversationMessage;
  readonly roster: readonly AgentInfo[];
  readonly maxRounds: number;
  readonly maxCorrections: number;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Runs one attempt through the SDK's decide() loop and the real gateway,
 * recording each round and the first request body as sent.
 */
export async function runAttempt(props: AttemptProps): Promise<RecordedAttempt> {
  const bodies: string[] = [];
  // The gateway turns a throw from fetch into an `unavailable` response, so a body that cannot be captured
  // is remembered here and fails the attempt loudly once decide() returns, rather than being thrown inside it.
  let uncaptured: string | null = null;
  const capturing: typeof fetch = async (input, init) => {
    if (typeof init?.body === 'string') bodies.push(init.body);
    else uncaptured ??= `the gateway sent a request body that is not a string (${typeof init?.body})`;
    return props.fetch(input, init);
  };
  type Pending = {
    round:
      | { readonly toolCalls: readonly RecordedCall[]; readonly text: string }
      | { readonly failed: string; readonly detail: string };
    toolResults: RecordedToolResult[];
  };
  const rounds: Pending[] = [];
  let seen = props.request.messages.length;
  const model: ModelClient = {
    chat: async (request) => {
      // The tool results decide() sent back after the previous round are the new tool messages in this request.
      const previous = rounds.at(-1);
      if (previous !== undefined) {
        for (const m of request.messages.slice(seen))
          if (m.role === 'tool') previous.toolResults.push({ toolCallId: m.toolCallId, content: m.content });
      }
      seen = request.messages.length;
      const { response } = await chatCompletion({
        fetch: capturing,
        endpoint: props.endpoint,
        chatDefaults: props.chatDefaults,
        toolCallStart: props.toolCallStart,
        request,
      });
      rounds.push({
        round: response.ok
          ? {
              toolCalls: response.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
              text: response.text,
            }
          : { failed: response.reason, detail: response.detail },
        toolResults: [],
      });
      return response;
    },
  };
  const done = (fields: Pick<Attempt, 'actions' | 'passed' | 'problem'>): RecordedAttempt => {
    const recorded: Round[] = rounds.map((r) => ({ ...r.round, toolResults: r.toolResults }));
    const lookups = recorded.reduce(
      (n, r) => n + ('toolCalls' in r ? r.toolCalls.filter((c) => c.name === LIST_AGENTS).length : 0),
      0,
    );
    if (uncaptured !== null) throw new Error(uncaptured);
    const first = bodies[0];
    if (first === undefined) throw new Error('the attempt sent no request to the model server');
    return { attempt: { ...fields, lookups, requestSha256: sha256(first), rounds: recorded }, firstRequest: first };
  };
  let calls;
  try {
    calls = await decide({
      model,
      request: props.request,
      message: props.message,
      roster: props.roster,
      maxRounds: props.maxRounds,
      maxCorrections: props.maxCorrections,
    });
  } catch (error) {
    return done({ actions: null, problem: (error as Error).message });
  }
  /** Why the model's calls can't be accepted: an unknown tool, or both a pass and an action; null when neither. */
  function callsProblem(
    unknownCalls: readonly { readonly name: string }[],
    passes: readonly unknown[],
    sends: readonly unknown[],
  ): string | null {
    if (unknownCalls.length > 0) return `unknown tool ${unknownCalls.map((t) => t.name).join(', ')}`;
    if (passes.length > 0 && sends.length > 0) return 'both passed and acted';
    return null;
  }
  const acting = (name: string): boolean => name === REPLY || name === SEND_MESSAGE || name === CONSULT;
  const sends = calls.filter((t) => acting(t.name));
  const passes = calls.filter((t) => t.name === PASS);
  const actions: Action[] = sends
    .flatMap((t) => requestedActions(t, props.message))
    .map((a) => ({ tool: a.tool, to: String(a.to), text: String(a.text) }));
  const unknown = calls.filter((t) => !acting(t.name) && t.name !== PASS);
  const problem = callsProblem(unknown, passes, sends);
  return done({ actions, passed: passes.map((t) => String(t.arguments['reason'])), problem });
}

/**
 * A request body as the results file holds it: parsed, so it reads as JSON.
 * It must serialise back to exactly the bytes sent, so its sha256 can be
 * checked against the file; a body that does not is an error, never recorded.
 */
export function recordedRequest(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  if (JSON.stringify(parsed) !== body)
    throw new Error('the request body does not round-trip through JSON; it cannot be recorded exactly');
  return parsed;
}

export interface RunArgs {
  readonly models: readonly string[];
  /** Also run the held-out set (R10). */
  readonly heldOut: boolean;
  /** Exit non-zero, naming each case, when any case is below full marks (R9). */
  readonly gate: boolean;
  /** Where the results files go; relative paths are from the repo root. */
  readonly out: string | null;
  /** Run only the rainbow supervisor's gather set (evals/routing/rainbow.ts; collaborating-agents A11), never with --held-out or --gate. */
  readonly rainbow: boolean;
}

/** The runner's arguments: `[--held-out] [--gate] [--rainbow] [--out <dir>] [model-id ...]`. An unknown flag throws. */
export function parseArgs(argv: readonly string[]): RunArgs {
  const models: string[] = [];
  let heldOut = false;
  let gate = false;
  let out: string | null = null;
  let rainbow = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = present(argv[i], `argv[${String(i)}]`);
    if (arg === '--held-out') heldOut = true;
    else if (arg === '--gate') gate = true;
    else if (arg === '--rainbow') rainbow = true;
    else if (arg === '--out') {
      const dir = argv[i + 1];
      if (dir === undefined || dir.startsWith('--')) throw new Error('--out needs a directory');
      out = dir;
      i += 1;
    } else if (arg.startsWith('--'))
      throw new Error(`unknown option ${arg}; the options are --held-out, --gate, --rainbow, --out <dir>`);
    else models.push(arg);
  }
  // The rainbow set is its own measure (A11): it has no held-out set and is not the gate's.
  if (rainbow && (heldOut || gate))
    throw new Error('--rainbow runs the rainbow set alone: it takes neither --held-out nor --gate');
  return { models, heldOut, gate, out, rainbow };
}

/**
 * Whether one attempt took exactly the action the case expects: an explicit pass when a pass is expected;
 * otherwise exactly the expected destinations, in order, each by the expected tool, and each text matching the
 * case's pattern where it has one. Re-expressed 2026-09-27 (agent-calls R15): the tool check replaced the
 * sender-set reply-to check, so a consult cannot pass a hand-off case, nor a send_message an ask-for-yourself case.
 */
export function grade(c: RoutingCase, attempt: Attempt): boolean {
  if (attempt.actions === null || attempt.problem !== null) return false;
  // No action means an explicit pass; with tool calls required, nothing else can mean it.
  if (c.expect.tool === 'pass') return attempt.actions.length === 0 && (attempt.passed?.length ?? 0) > 0;
  const { tool, to, text, notText } = c.expect;
  if (attempt.actions.length !== to.length) return false;
  return attempt.actions.every(
    (action, i) =>
      action.tool === tool &&
      action.to === to[i] &&
      (text === undefined || text.test(action.text)) &&
      (notText === undefined || !notText.test(action.text)),
  );
}

/** One model's graded case, as the gate reads it. */
export interface GradedCase {
  readonly id: string;
  readonly passes: number;
}

/**
 * The cases taken out of the routing check (docs/plans/agent-calls.md R14, as amended by the owner's answer to
 * routing-ask-hand-off-or-consult, option (d), 2026-09-28): the task-shaped "get X to do it, then tell me yourself"
 * requests, which the pinned model hands off with send_message instead of consulting — debt D30
 * (docs/plans/debt.md#d30). They stay in the measure with their expected consult and run without --gate, so each
 * run still records what the model does with them; --gate skips them. D30 is paid when this list is empty.
 */
export const TAKEN_OUT_D30: readonly string[] = ['call-and-return', 'held-self-task-have', 'held-self-task-report'];

/**
 * The approved-result case taken out of the routing check (docs/plans/debt-paydown.md R8): a result asking that the
 * user visit a link, which the pinned model relays under every frame tried (probe P7b (ii), 0/3) — debt D51
 * (docs/plans/debt.md#d51), narrowed to it. It stays in the measure and runs without --gate; --gate skips it.
 */
export const TAKEN_OUT_D51: readonly string[] = ['approved-injection-link'];

/** Every case --gate skips, and the debt entry under which each is taken out. */
const TAKEN_OUT: readonly (readonly [id: string, debt: string])[] = [
  ...TAKEN_OUT_D30.map((id) => [id, 'D30'] as const),
  ...TAKEN_OUT_D51.map((id) => [id, 'D51'] as const),
];
const isTakenOut = (id: string): boolean => TAKEN_OUT.some(([taken]) => taken === id);

/** The debt entry a case is taken out of the routing check under, or undefined for one --gate runs. */
export function takenOutUnder(id: string): string | undefined {
  return TAKEN_OUT.find(([taken]) => taken === id)?.[1];
}

/** The cases a run puts to the model: every case, or with --gate every case but those taken out (R14, R18; D30, D51). */
export function casesToRun<C extends { readonly id: string }>(cases: readonly C[], gate: boolean): readonly C[] {
  if (!gate) return cases;
  return cases.filter((c) => !isTakenOut(c.id));
}

/** What one run puts to the model: its cases, its held-out cases (null without --held-out), and the ids --gate skipped. */
export interface RunPlan<C extends { readonly id: string }> {
  readonly cases: readonly C[];
  readonly heldOut: readonly C[] | null;
  readonly skipped: readonly string[];
}

/**
 * The runner's plan from its arguments (run.ts runs exactly this): casesToRun over each set, and what was skipped;
 * with --rainbow, the rainbow set alone (collaborating-agents A11).
 */
export function planRun<C extends { readonly id: string }>(
  args: Pick<RunArgs, 'gate' | 'heldOut' | 'rainbow'>,
  cases: readonly C[],
  heldOut: readonly C[],
  rainbow: readonly C[],
): RunPlan<C> {
  if (args.rainbow) return { cases: rainbow, heldOut: null, skipped: [] };
  const offered = args.heldOut ? [...cases, ...heldOut] : cases;
  return {
    cases: casesToRun(cases, args.gate),
    heldOut: args.heldOut ? casesToRun(heldOut, args.gate) : null,
    skipped: args.gate ? offered.filter((c) => isTakenOut(c.id)).map((c) => c.id) : [],
  };
}

/** Each case below `repeats` passes, named with its model and score: what the gate prints and fails on. */
export function belowFull(model: string, cases: readonly GradedCase[], repeats: number): string[] {
  return cases.filter((c) => c.passes < repeats).map((c) => `${model} ${c.id} ${String(c.passes)}/${String(repeats)}`);
}
