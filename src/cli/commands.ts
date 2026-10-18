// The `asha` commands. Everything the process touches — output, environment,
// fetch, the daemon starter, spawning, signals, the clock — is injected, so
// each command's exit code and output are unit-testable.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DaemonDependencies, RunningDaemon, StartDaemonProps } from '../daemon/compose.js';
import { DAEMON_IDLE_EXIT_MS, MODEL_IDLE_UNLOAD_MS, processRunning, type LifetimeOptions } from '../daemon/lifetime.js';
import type { Logger } from '../daemon/log.js';
import { portalFolders } from '../daemon/portal/index.js';
import { timerSchedule } from '../daemon/refusal-log/index.js';
import { withTimeout } from '../shared/abort.js';
import { present } from '../shared/assert-present.js';
import { harnessPaths, type HarnessPaths } from '../shared/paths.js';
import type { OpenAttachment } from './attach.js';
import { interactive, type CliInput, type InteractiveSession } from './interactive.js';
import { listState, resetState } from './state.js';
import { approveCommand, enableCommand, installCommand, setSecretCommand, uninstallCommand } from './modules.js';
import {
  pathContext,
  prepareSpace,
  readMessageFiles,
  saveReturned,
  upload,
  withinBounds,
  type AttachRequest,
} from './files.js';
import type { ShutdownSignals } from './signals.js';
import {
  AGENT_CHAT_TIMEOUT_MS,
  loginNameToUserId,
  userIdProblem,
  budgetOfText,
  NAME_PATTERN,
  DEFAULT_CHANNEL,
  Routes,
  type ConversationBudgetRequest,
  type ConversationEvent,
  type ConversationRequest,
  type DaemonFile,
  type HealthResponse,
  type ChannelStopEvent,
  type LaunchEvent,
  type ReturnedFile,
  type WatchEvent,
} from '../shared/protocol.js';
import { SSE_CONTENT_TYPE, sseEvents } from '../shared/sse.js';
import {
  CONVERSATION_CLOSED,
  ChannelStopPrinter,
  ConversationTracker,
  DeltaPrinter,
  EXIT,
  LAUNCH_CLOSED,
  LaunchPrinter,
  WATCH_CLOSED,
  WatchPrinter,
  attachedLine,
  cloudWarning,
  daemonRefusedLine,
  errorLine,
  noAgentOnChannelLine,
  returnedFiles,
  silenceLine,
  stillRunningLine,
} from '../shared/lines.js';
import { statusLines } from '../shared/state-lines.js';
import { HEALTH_TIMEOUT_MS } from '../shared/timing.js';

// The lines and the rule that settles a conversation are shared with the portal's page (docs/plans/portal.md R15):
// exported from here too, for the CLI's own modules and tests.
export { ConversationTracker, DeltaPrinter, EXIT, formatWatchEvent } from '../shared/lines.js';
export { sseEvents } from '../shared/sse.js';

export interface CliContext {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch: typeof fetch;
  /** Repo root and version of this installation. */
  readonly root: string;
  readonly version: string;
  /** Fingerprint of this installation's compiled code (src/shared/build.ts). */
  readonly build: string;
  readonly pid: number;
  readonly startDaemon: (props: StartDaemonProps) => Promise<RunningDaemon>;
  readonly createLogger: (paths: HarnessPaths) => Logger;
  readonly dependencies: (paths: HarnessPaths, logger: Logger) => DaemonDependencies;
  /** Subscribes to every SIGINT, SIGTERM and SIGHUP until unsubscribed (signals.ts). */
  readonly shutdownSignals: ShutdownSignals;
  /** Starts `asha --server` detached, with `env` as its environment, output to the server log. Returns its pid. */
  readonly spawnServer: (paths: HarnessPaths, env: NodeJS.ProcessEnv) => Promise<number>;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly isAlive: (pid: number) => boolean;
  /**
   * A live process's command line, `ps -o command= -p <pid>` bounded at 2,000 ms, or null when no such process exists
   * (ps exits 1 printing nothing); any other failure throws. What tells a stopping asha daemon from a reused pid
   * (docs/plans/debt-paydown.md R15).
   */
  readonly processCommand: (pid: number) => Promise<string | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timing: CliTiming;
  /**
   * Whether stdout and stderr are terminals. Text printed to a terminal has its control characters replaced
   * (scrubControl), so a message cannot move the cursor, retitle the window or write the clipboard.
   */
  readonly terminal: { readonly stdout: boolean; readonly stderr: boolean };
  /** What the user types or pipes, for --interactive: one string per line, and whether it comes from a terminal. */
  readonly input: CliInput;
  /** Resolves on the first Ctrl-C after it is called (process SIGINT); --interactive ends with exit 130 then. */
  readonly interrupt: () => Promise<void>;
  /** The login name (`os.userInfo().username`), read only when a message carries no user= (cli-interactive R16). */
  readonly loginName: () => string;
  /** The folder `asha` runs in: relative paths a message attaches, and where returned files are saved (agent-files R1, R12a). */
  readonly cwd: () => string;
  /** The user's home folder: what a leading `~/` names (agent-files R1). */
  readonly homeDir: () => string;
  /** How `--portal` opens the page (docs/plans/portal.md R1). */
  readonly portal: PortalOpener;
}

/** `--portal`'s two effects on the machine, injected so each is testable. */
interface PortalOpener {
  /** Writes the forwarding file as a new 0600 file renamed into place, replacing any earlier one (writePrivateFile). */
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Spawns `open <path>` (found by PATH): its exit — a code, or the signal that ended it — and a kill. `exited`
   * rejects when it cannot be spawned.
   */
  open(path: string): { readonly exited: Promise<number | NodeJS.Signals>; kill(): void };
}

/** How long `--portal` waits for `open` to exit before it kills it (R1). */
export const PORTAL_OPEN_MS = 10_000;

interface CliTiming {
  /** Bound on a daemon the CLI started becoming healthy. */
  readonly serverStartMs: number;
  /** Bound on the daemon exiting after `--stop`. */
  readonly serverStopMs: number;
  /** Bound on silence on the conversation stream; heartbeats arrive well inside it. */
  readonly streamIdleMs: number;
  readonly pollMs: number;
  /** Bound on an upload's answer (agent-files R3a): 260 s, 20 s past the daemon's 240. */
  readonly uploadAnswerMs: number;
  /** Bound on silence in a returned file's body (agent-files R12a): 30 s. */
  readonly downloadIdleMs: number;
}

export const USAGE = `asha — Autonomous Simple Harness for Agents

usage:
  asha [user=<id>] [recipe=<recipe>] [channel=<channel>] [to=<handle> | topic=<topic>]
       [file=<path> ...] [posts=<n>] [tokens=<n>] message=<text>
                   post a message to a channel (default "main"), first
                   bringing the recipe's agent online there if one is named;
                   to= sends it to one agent (e.g. to=hewo-1) instead of
                   everyone, topic= to the agents of a team that subscribe
                   to that topic. posts= and tokens= are its conversation's
                   budget: the agents' messages in it (1 to 32; 32 without
                   it) and their model calls' tokens (1 to 1,000,000; none
                   without it), past which it ends. user= says who you are
                   (e.g. user=alice);
                   without it you are your login name on this Mac, made to
                   fit a user ID (John.Smith is sent as john-smith, and
                   says so). file= attaches a file (repeat it for more, at
                   most 10): every agent on the channel can read it. Prints
                   the replies meant for you, saves the files an agent
                   returns as ./asha-files/<channel>/<name>, and returns
                   once no agent is still working on it
  asha [user=<id>] [channel=<channel>] conversation=<id> message=<text>
                   answer what an agent asked you: the line "? <handle> is
                   waiting for your answer" gives this command, its
                   conversation= filled in
  asha --interactive [user=<id>] [recipe=<recipe>] [channel=<channel>] [to=<handle>]
                   type messages into the channel, one per line, and see the
                   replies. A word in a line that is a file's path (it has a
                   / or starts with ~/; drag a file in to type it) attaches
                   that file. /watch on shows everything on the channel,
                   /watch off only your replies again; /quit or Ctrl-D
                   leaves; Ctrl-C leaves at once (exit 130), abandoning the
                   reply to a message still being worked on
  asha --launch recipe=<recipe> [channel=<channel>]
                   start a new agent for the recipe on a channel (another
                   one, if one is already there) and print its handle
  asha --launch team=<team> [channel=<channel>]
                   start every member of teams/<team>/ on a channel, each
                   under its own name, and print their handles, one a line
  asha --watch [channel=<channel>]
                   print every message on the channel as it happens, until
                   Ctrl-C
  asha --portal [user=<id>]
                   open the portal, asha's web page, in your browser: every
                   command here, a live picture of a channel's agents, and
                   their telemetry; user= says who you are there
  asha --server    run the harness daemon in the foreground
  asha --status    report whether the daemon is running, and its agents
  asha --stop      stop the daemon and every agent it runs
  asha --stop channel=<channel>
                   stop one channel's agents, then every model server no
                   agent still needs; the daemon keeps running
  asha --list-state
                   list what persisted agents and teams have saved: one line
                   per saved asset and per agent's unsaved messages, then the
                   total
  asha --reset-state all | channel=<channel> [name=<name> [team=<team>]] [--yes]
                   remove saved state: everything, a channel's agents and
                   board, or one agent (team= for a team member); all and
                   channel= list what goes and ask you to type reset (--yes
                   when not at a terminal)
  asha --reset-state channel=<channel> [name=<name> [team=<team>]] user=<id> [--yes]
                   erase one user's saved memory from the agents named; files
                   and boards are shared by every user and are kept
  asha --install-module path=<dir> [archive=<file>] [--yes]
                   install a module from a directory (from this repository's
                   modules/, or a separate package): its files, licences and
                   tool descriptions are checked and summarised, and you type
                   yes (--yes when not at a terminal); a command plugin also
                   needs archive=, its release downloaded from the URL its
                   manifest names. Refused while a daemon runs
  asha --uninstall-module id=<id> [--yes]
                   remove an installed module and its secrets. Refused while a
                   daemon runs
  asha --set-secret module=<id> name=<NAME>
                   store a module's secret, read from standard input (pipe it
                   in: pbpaste | asha --set-secret …); prints only its length
  asha --enable-module id=<id> conversation=<usd> day=<usd> month=<usd>
                   turn on a metered module, with what it may spend in one
                   conversation, one day and one month (UTC), each at most its
                   approved cap
  asha --approve id=<id> [--yes]
                   see a held call an agent asked to make, and approve it by
                   typing yes (--yes when not at a terminal): asha then makes
                   exactly that call, once, and the agent tells you what
                   happened
  asha --help      this text

  --verbose        with any command: also print progress on stderr (the
                   steps of bringing an agent online, your message and user
                   ID, each file attached, agents' internal messages and
                   status, the daemon starting on its own) and the models'
                   output as they generate it

asha prints only each command's output on stdout; errors (✗) and warnings (⚠)
always go to stderr. The daemon starts on its own when a message,
--interactive, --launch or --watch needs it.
`;

/**
 * The context the commands run with: CliContext plus where progress goes —
 * stderr with --verbose, nowhere without it. Errors and warnings always go to
 * stderr: a failure must still say why, or it would read as an empty answer.
 */
export type Ctx = CliContext & {
  readonly progress: (text: string) => void;
  /** The daemon builds already warned about in this command or session (warnStale): each is warned about once. */
  readonly warnedBuilds: Set<string>;
  /**
   * The stale daemon files already reported in this command, by port: a start polls findDaemon until the new daemon
   * rewrites the file, and the note for a dead daemon's file is said once, not on every poll (found by p20-b, 2026-09-29).
   */
  readonly notedStalePorts: Set<number>;
  /** Aborted when the user interrupts --interactive: every wait for the daemon gives up at once. */
  readonly signal: AbortSignal;
};

/** `start`\u2013`end` inclusive, as the literal characters: builds CONTROL_PATTERN without a control character written
 * directly into a regex literal (no-control-regex). */
function charRange(start: number, end: number): string {
  let range = '';
  for (let code = start; code <= end; code += 1) range += String.fromCharCode(code);
  return range;
}

/** Every C0 and C1 control character and DEL, except line feed (0x0a) and tab (0x09). */
const CONTROL_PATTERN = new RegExp(`[${charRange(0x00, 0x08)}${charRange(0x0b, 0x1f)}${charRange(0x7f, 0x9f)}]`, 'g');

/**
 * Replaces every C0 and C1 control character and DEL, except line feed and tab, with U+FFFD: text a model or
 * another user wrote cannot move a terminal's cursor, retitle its window or set its clipboard (OSC 52).
 */
export function scrubControl(text: string): string {
  return text.replace(CONTROL_PATTERN, '\ufffd');
}

/** The flags that name a mode; --interactive combines with none of them (R1). */
const MODES = [
  '--launch',
  '--watch',
  '--portal',
  '--server',
  '--status',
  '--stop',
  '--help',
  '--list-state',
  '--reset-state',
  '--install-module',
  '--uninstall-module',
  '--set-secret',
  '--enable-module',
  '--approve',
] as const;

/**
 * The running context: `stdout` and `stderr` scrub control characters when the terminal shows them raw (R14);
 * `--verbose` turns progress on. Its own function, never inlined into runCli: a nested closure defined directly in
 * a function's body inflates that function's own cognitive complexity far past what its statements alone would
 * (measured here, 2026-10-13 — three closures, otherwise-simple guard clauses after them costing +4 each instead
 * of +1), so runCli's dispatch stays readable only with this built apart from it.
 */
function makeCliContext(cliContext: CliContext, verbose: boolean): Ctx {
  const stdout = cliContext.terminal.stdout
    ? (text: string) => {
        cliContext.stdout(scrubControl(text));
      }
    : cliContext.stdout;
  const stderr = cliContext.terminal.stderr
    ? (text: string) => {
        cliContext.stderr(scrubControl(text));
      }
    : cliContext.stderr;
  return {
    ...cliContext,
    stdout,
    stderr,
    progress: verbose ? stderr : () => undefined,
    warnedBuilds: new Set(),
    notedStalePorts: new Set(),
    signal: new AbortController().signal,
  };
}

export async function runCli(rawArgv: readonly string[], cliContext: CliContext): Promise<number> {
  const argv = rawArgv.filter((a) => a !== '--verbose');
  const ctx = makeCliContext(cliContext, rawArgv.includes('--verbose'));
  if (argv.includes('--quiet')) {
    // Refused rather than ignored: a script's --quiet would otherwise keep working while its meaning changed.
    ctx.stderr(`--quiet is gone: asha is quiet by default; add --verbose for progress\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (argv.includes('--interactive')) return runInteractive(ctx, argv);
  if (argv[0] === '--launch') return runLaunch(ctx, argv.slice(1));
  // Extension modules (docs/plans/extension-modules.md R4, R24, R28), and --reset-state: one flag, args untouched.
  const simple = SIMPLE_COMMANDS[argv[0] ?? ''];
  if (simple !== undefined) return simple(ctx, argv.slice(1));
  if (argv[0] === '--portal') return runPortal(ctx, argv.slice(1));
  // docs/plans/portal-demo-stop.md R4: one channel's agents, the daemon left running; --stop alone is unchanged.
  if (argv[0] === '--stop' && argv.length > 1) return runStopChannel(ctx, argv.slice(1));
  if (argv[0] === '--watch') return runWatch(ctx, argv.slice(1));
  if (argv.length === 1) {
    switch (argv[0]) {
      case '--server':
        return server(ctx);
      case '--status':
        return status(ctx);
      case '--stop':
        return stop(ctx);
      case '--list-state':
        return listState(ctx);

      case '--help':
        ctx.stdout(USAGE);
        return EXIT.ok;
    }
  }
  return runMessage(ctx, argv);
}

/** --reset-state and every extension-module command: one flag, its own args untouched (R4, R24, R28). */
const SIMPLE_COMMANDS: Readonly<Record<string, (ctx: Ctx, args: readonly string[]) => Promise<number>>> = {
  '--reset-state': resetState,
  '--install-module': installCommand,
  '--uninstall-module': uninstallCommand,
  '--set-secret': setSecretCommand,
  '--enable-module': enableCommand,
  '--approve': approveCommand,
};

/** runCli's --interactive: a session's user=, else the login name's default (cli-interactive R16). */
async function runInteractive(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const rest = argv.filter((a) => a !== '--interactive');
  const session = parseInteractiveArgs(rest);
  if (typeof session === 'string') {
    ctx.stderr(`${session}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (session.user !== undefined) return interactive(ctx, { ...session, user: session.user });
  const user = defaultUser(ctx);
  return user === undefined ? EXIT.failed : interactive(ctx, { ...session, user });
}

/** runCli's --launch: recipe=<recipe> or team=<team>, exactly one, and optionally channel=<name>. */
async function runLaunch(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const values = parseKeyValues(argv, ['recipe', 'team', 'channel']);
  const recipe = typeof values === 'string' ? undefined : values.get('recipe');
  const team = typeof values === 'string' ? undefined : values.get('team');
  if (typeof values === 'string' || (recipe === undefined) === (team === undefined)) {
    ctx.stderr(`--launch takes recipe=<recipe> or team=<team>, and optionally channel=<name>\n\n${USAGE}`);
    return EXIT.usage;
  }
  const grant = recipe !== undefined ? { recipe } : { team: present(team, 'team, since recipe= was not given') };
  return launch(ctx, grant, values.get('channel') ?? DEFAULT_CHANNEL);
}

/** runCli's --portal: user=<id>, else the login name's default. */
async function runPortal(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const values = parseKeyValues(argv, ['user']);
  if (typeof values === 'string') {
    ctx.stderr(`--portal takes only user=<id>\n\n${USAGE}`);
    return EXIT.usage;
  }
  const given = values.get('user');
  if (given !== undefined) {
    // Checked here: the page drops a user ID that is not one, and would open with the field empty.
    const problem = userIdProblem(given, { isDefault: false });
    if (problem !== undefined) {
      ctx.stderr(`✗ ${problem}\n`);
      return EXIT.usage;
    }
    return portal(ctx, given);
  }
  const user = defaultUser(ctx);
  return user === undefined ? EXIT.failed : portal(ctx, user);
}

/** runCli's --stop channel=<name> (portal-demo-stop R4): one channel's agents, the daemon left running. */
async function runStopChannel(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const values = parseKeyValues(argv, ['channel']);
  const channel = typeof values === 'string' ? undefined : values.get('channel');
  if (typeof values === 'string' || channel === undefined || !NAME_PATTERN.test(channel)) {
    ctx.stderr(`--stop takes nothing, or channel=<name> (${String(NAME_PATTERN)})\n\n${USAGE}`);
    return EXIT.usage;
  }
  return stopChannel(ctx, channel);
}

/** runCli's --watch channel=<name>. */
async function runWatch(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const channel = parseWatchArgs(argv);
  if (channel === undefined) {
    ctx.stderr(`--watch takes only channel=<name>\n\n${USAGE}`);
    return EXIT.usage;
  }
  return watch(ctx, channel);
}

/** runCli's fallback: message=…, attaching file= strictly (agent-files R1, R2), the default user applied here
 * alone since parseMessageArgs stays pure (cli-interactive R16). */
async function runMessage(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const parsed = parseMessageArgs(argv);
  if (typeof parsed === 'string') {
    ctx.stderr(`${parsed}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { request, files } = parsed;
  // file= attaches each named file, strictly: one that cannot attach refuses the message (agent-files R1, R2).
  const attach: AttachRequest | undefined = files.length === 0 ? undefined : { kind: 'files', paths: files };
  const options = {
    printer: new DeltaPrinter(ctx.progress),
    deltas: true,
    ...(attach === undefined ? {} : { attach }),
  };
  if (request.user !== undefined) return converse(ctx, request, options);
  const user = defaultUser(ctx);
  return user === undefined ? EXIT.failed : converse(ctx, { ...request, user }, options);
}

/**
 * Whether the response is not the daemon's event stream (R7, amendment 6): a daemon of an older build answers
 * NDJSON, which this CLI cannot read. Says so, naming the type it got, rather than waiting on it for nothing.
 */
export function notEventStream(ctx: Pick<Ctx, 'stderr'>, response: Response, what: string): boolean {
  const type = response.headers.get('content-type') ?? '(none)';
  if (type === SSE_CONTENT_TYPE || type.startsWith(`${SSE_CONTENT_TYPE};`)) return false;
  ctx.stderr(
    `✗ the daemon answered the ${what} with ${type}, not ${SSE_CONTENT_TYPE}: it runs a different build than this asha. Run asha --stop to use this build.\n`,
  );
  return true;
}

/**
 * The user ID a message without user= carries (cli-interactive R16): the login name, converted to fit the user-ID
 * rule and checked against it before any daemon is found or started. A changed name is announced, always; a name
 * that still breaks the rule, or cannot be read, is refused loudly — never replaced by an issued ID (PRINCIPLES §9).
 * Undefined once the refusal has been printed.
 */
function defaultUser(ctx: Ctx): string | undefined {
  let name: string;
  try {
    name = ctx.loginName();
  } catch (error) {
    ctx.stderr(
      `✗ cannot read your login name: ${error instanceof Error ? error.message : String(error)}; type user=<id> to choose one\n`,
    );
    return undefined;
  }
  const converted = loginNameToUserId(name);
  const problem = userIdProblem(converted, { isDefault: true });
  if (problem !== undefined) {
    ctx.stderr(
      `✗ your login name "${name}" converts to "${converted}", which cannot be a user ID: ${problem}; type user=<id> to choose one\n`,
    );
    return undefined;
  }
  // Not progress: the owner's answer promises this line with no condition (record login-name-refused).
  if (converted !== name) ctx.stderr(`› your login name "${name}" is sent as user ID "${converted}"\n`);
  return converted;
}

/**
 * `message=…` with optional `recipe=`, `channel=`, `to=`, `posts=` and `tokens=` (the conversation's budget,
 * docs/plans/patterns-phase-3.md R15), each at most once, and `file=` any number of times (the one key that repeats,
 * agent-files R1). Returns an error string when malformed.
 */
/** parseMessageArgs' conversation= branch: channel=, user= and message= only (patterns-phase-3 R27). */
/** parseMessageArgs' result: a request and the files it attaches, or the error naming what is wrong. */
type MessageArgsResult = { readonly request: ConversationRequest; readonly files: readonly string[] } | string;

/**
 * `message`, as parseMessageArgs' result: every one of its return statements goes through a function typed to
 * this same result (this one, or one of the builders below), never a literal — a function whose return
 * statements directly construct conflicting shapes (a string here, an object literal there) is reported as not
 * always returning the same type (sonarjs/function-return-type), even where the shapes could never both occur.
 */
function messageArgsProblem(message: string): MessageArgsResult {
  return message;
}

function answerRequestFrom(values: ReadonlyMap<string, string>, answers: string, message: string): MessageArgsResult {
  const user = values.get('user');
  return {
    request: {
      ...(user === undefined ? {} : { user }),
      channel: values.get('channel') ?? DEFAULT_CHANNEL,
      conversation: answers,
      message,
    },
    files: [],
  };
}

/** parseMessageArgs' new-message branch (not answering a conversation): recipe=, to=, topic= and the budget. */
function newMessageRequest(
  values: ReadonlyMap<string, string>,
  repeated: ReadonlyMap<string, readonly string[]>,
  message: string,
  recipe: string | undefined,
  to: string | undefined,
  topic: string | undefined,
  budget: ConversationBudgetRequest | undefined,
): MessageArgsResult {
  const user = values.get('user');
  return {
    request: {
      ...(user === undefined ? {} : { user }),
      channel: values.get('channel') ?? DEFAULT_CHANNEL,
      ...(recipe === undefined ? {} : { recipe }),
      ...(to === undefined ? {} : { to }),
      ...(topic === undefined ? {} : { topic }),
      message,
      ...(budget === undefined ? {} : { budget }),
    },
    files: repeated.get('file') ?? [],
  };
}

export function parseMessageArgs(argv: readonly string[]): MessageArgsResult {
  if (argv.length === 0) return messageArgsProblem('nothing to do');
  const parsed = parseArgs(
    argv,
    ['user', 'recipe', 'channel', 'to', 'topic', 'message', 'file', 'posts', 'tokens', 'conversation'],
    ['file'],
  );
  if (typeof parsed === 'string') return messageArgsProblem(parsed);
  const { values, repeated } = parsed;
  const message = values.get('message');
  if (message === undefined) return messageArgsProblem('missing message=');
  // An answer to the ask a conversation waits on (docs/plans/patterns-phase-3.md R27): channel=, user= and message= only.
  const answers = values.get('conversation');
  if (answers !== undefined) {
    const beside = ['recipe', 'to', 'topic', 'file', 'posts', 'tokens'].filter((k) => values.has(k) || repeated.has(k));
    if (beside.length > 0) {
      const names = beside.map((k) => `${k}=`).join(', ');
      return messageArgsProblem(
        `conversation= answers what an agent asked: it takes only channel=, user= and message=, not ${names}`,
      );
    }
    return answerRequestFrom(values, answers, message);
  }
  const recipe = values.get('recipe');
  const to = values.get('to');
  // A topic (docs/plans/patterns-phase-3.md R21) reaches the agents subscribed to it: never with to=, one agent.
  const topic = values.get('topic');
  if (topic !== undefined && to !== undefined)
    return messageArgsProblem('topic= and to= cannot be given together: a message goes to a topic or to one agent');
  if (topic !== undefined && !NAME_PATTERN.test(topic))
    return messageArgsProblem(`topic= must be a topic name (${String(NAME_PATTERN)}), not ${topic}`);
  const budget = budgetOfText({
    ...(values.has('posts') ? { posts: present(values.get('posts'), 'posts=, since it is present') } : {}),
    ...(values.has('tokens') ? { tokens: present(values.get('tokens'), 'tokens=, since it is present') } : {}),
  });
  if (typeof budget === 'string') return messageArgsProblem(budget);
  return newMessageRequest(values, repeated, message, recipe, to, topic, budget);
}

/** parseConversationArgs' error, typed as its result (see messageArgsProblem on why every return must go through one). */
function conversationArgsProblem(message: string): ConversationRequest | string {
  return message;
}

/** parseConversationArgs' success, typed the same way as conversationArgsProblem. */
function conversationArgsOk(request: ConversationRequest): ConversationRequest | string {
  return request;
}

/** A message command's request, for one that attaches no file (`file=` is refused here: parseMessageArgs reads it). */
export function parseConversationArgs(argv: readonly string[]): ConversationRequest | string {
  const parsed = parseMessageArgs(argv);
  if (typeof parsed === 'string') return conversationArgsProblem(parsed);
  if (parsed.files.length > 0)
    return conversationArgsProblem('file= attaches a file to a message: parseMessageArgs reads it');
  return conversationArgsOk(parsed.request);
}

/** parseInteractiveArgs' error, typed as its result (see messageArgsProblem on why every return must go through one). */
function interactiveArgsProblem(message: string): InteractiveSession | string {
  return message;
}

/** parseInteractiveArgs' session, once its arguments are known well-formed; typed the same way as the error. */
function interactiveSessionFrom(values: ReadonlyMap<string, string>): InteractiveSession | string {
  const user = values.get('user');
  const recipe = values.get('recipe');
  const to = values.get('to');
  return {
    ...(user === undefined ? {} : { user }),
    channel: values.get('channel') ?? DEFAULT_CHANNEL,
    ...(recipe === undefined ? {} : { recipe }),
    ...(to === undefined ? {} : { to }),
  };
}

/**
 * The session `--interactive` starts: `user=`, `recipe=`, `channel=` and `to=`, each at most once. Returns an error
 * string for another mode or `message=` beside it, or malformed arguments.
 */
export function parseInteractiveArgs(argv: readonly string[]): InteractiveSession | string {
  const mode = argv.find((a) => (MODES as readonly string[]).includes(a));
  if (mode !== undefined) return interactiveArgsProblem(`--interactive cannot be combined with ${mode}`);
  if (argv.some((a) => a.startsWith('message=')))
    return interactiveArgsProblem('--interactive takes no message=: type each message after it starts');
  // agent-files R1: in a session a path in a line attaches its file; file= is a single message's.
  if (argv.some((a) => a.startsWith('file=')))
    return interactiveArgsProblem(
      '✗ file= is for a single message: in --interactive, a path in a line attaches its file',
    );
  // patterns-phase-3 R15: a budget is one message's, given on its command.
  const budgetKey = argv.find((a) => a.startsWith('posts=') || a.startsWith('tokens='));
  if (budgetKey !== undefined) {
    const budgetName = present(budgetKey.split('=')[0], "the budget key's name");
    return interactiveArgsProblem(
      `--interactive takes no ${budgetName}=: a budget is one message's (asha ${budgetName}=<n> message=…)`,
    );
  }
  const values = parseKeyValues(argv, ['user', 'recipe', 'channel', 'to']);
  if (typeof values === 'string') return interactiveArgsProblem(values);
  return interactiveSessionFrom(values);
}

/** The channel for `--watch [channel=…]`, or undefined when the arguments are malformed. */
function parseWatchArgs(argv: readonly string[]): string | undefined {
  const values = parseKeyValues(argv, ['channel']);
  if (typeof values === 'string') return undefined;
  return values.get('channel') ?? DEFAULT_CHANNEL;
}

function parseKeyValues(argv: readonly string[], keys: readonly string[]): Map<string, string> | string {
  const parsed = parseArgs(argv, keys, []);
  return typeof parsed === 'string' ? parsed : parsed.values;
}

/** parseArgs' result: the once-only and the repeatable keys' values, or the error naming what is wrong. */
type ParsedArgs = { readonly values: Map<string, string>; readonly repeated: Map<string, string[]> } | string;

/** parseArgs' error, typed as its result (see messageArgsProblem on why every return must go through one). */
function parseArgsProblem(message: string): ParsedArgs {
  return message;
}

/** parseArgs' success, typed the same way as parseArgsProblem. */
function parsedArgsOk(values: Map<string, string>, repeated: Map<string, string[]>): ParsedArgs {
  return { values, repeated };
}

/** `key=value` arguments: each key of `keys` at most once, but those of `repeatable` any number of times (in order). */
function parseArgs(argv: readonly string[], keys: readonly string[], repeatable: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : '';
    if (!keys.includes(key)) return parseArgsProblem(`unrecognized argument: ${arg}`);
    const value = arg.slice(eq + 1);
    if (value === '') return parseArgsProblem(`${key}= is empty`);
    if (repeatable.includes(key)) {
      repeated.set(key, [...(repeated.get(key) ?? []), value]);
      continue;
    }
    if (values.has(key)) return parseArgsProblem(`${key}= given twice`);
    values.set(key, value);
  }
  return parsedArgsOk(values, repeated);
}

/** The environment variables that set a daemon's lifetime (docs/plans/idle-shutdown.md R1, R3, R4, R6). */
const LifetimeEnv = {
  idleExitMs: 'ASHA_IDLE_EXIT_MS',
  modelIdleMs: 'ASHA_MODEL_IDLE_MS',
  exitWithPid: 'ASHA_EXIT_WITH_PID',
} as const;

/** A positive whole number, no sign, no leading zero, within Number's exact integers: a duration or a pid. */
const POSITIVE_WHOLE = /^[1-9]\d{0,14}$/;

/** A lifetime variable the daemon's environment gets wrong (R4, R6): the message names the variable and its value. */
export class LifetimeEnvInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifetimeEnvInvalid';
  }
}

/** `env[name]` as a positive whole number, or undefined when it is not set; anything else throws LifetimeEnvInvalid. */
function wholeFrom(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (!POSITIVE_WHOLE.test(value))
    throw new LifetimeEnvInvalid(`${name}=${JSON.stringify(value)} is not a positive whole number`);
  return Number(value);
}

/**
 * The daemon's lifetime from its environment: ASHA_IDLE_EXIT_MS (absent: no idle stop, R4) and ASHA_MODEL_IDLE_MS
 * (absent: MODEL_IDLE_UNLOAD_MS), each a positive whole number of milliseconds; ASHA_EXIT_WITH_PID, a positive whole
 * number naming a process of this user running now (R6). Throws LifetimeEnvInvalid for any of them it cannot use.
 */
export function lifetimeFrom(env: NodeJS.ProcessEnv, running: (pid: number) => boolean): LifetimeOptions {
  const idleExitMs = wholeFrom(env, LifetimeEnv.idleExitMs);
  const modelIdleMs = wholeFrom(env, LifetimeEnv.modelIdleMs);
  const exitWithPid = wholeFrom(env, LifetimeEnv.exitWithPid);
  if (exitWithPid !== undefined && !running(exitWithPid))
    throw new LifetimeEnvInvalid(
      `${LifetimeEnv.exitWithPid}=${String(exitWithPid)} names no running process of this user`,
    );
  return {
    modelIdleMs: modelIdleMs ?? MODEL_IDLE_UNLOAD_MS,
    ...(idleExitMs === undefined ? {} : { idleExitMs }),
    ...(exitWithPid === undefined ? {} : { exitWithPid }),
  };
}

async function server(ctx: Ctx): Promise<number> {
  const paths = harnessPaths(ctx.env);
  // Read before anything starts: a lifetime the environment gets wrong fails the start, naming it (R4, R6).
  let lifetime: LifetimeOptions;
  try {
    lifetime = lifetimeFrom(ctx.env, processRunning);
  } catch (error) {
    if (!(error instanceof LifetimeEnvInvalid)) throw error;
    ctx.stderr(`✗ ${error.message}\n`);
    return EXIT.failed;
  }
  const logger = ctx.createLogger(paths);
  const daemon = await ctx.startDaemon({
    paths,
    root: ctx.root,
    version: ctx.version,
    build: ctx.build,
    pid: ctx.pid,
    logger,
    dependencies: ctx.dependencies(paths, logger),
    heartbeatMs: 10_000,
    // The one chat bound: the agents' HarnessClient and the agent suite's margin check (prompt-prefix R14) read it too.
    chatTimeoutMs: AGENT_CHAT_TIMEOUT_MS,
    schedule: timerSchedule,
    // The portal's page, read at start from this installation (docs/plans/portal.md R2).
    portal: portalFolders(ctx.root),
    lifetime,
  });
  ctx.stdout(
    `asha ${ctx.version} serving on 127.0.0.1:${String(daemon.port)} (pid ${String(ctx.pid)}); home ${paths.home}\n`,
  );
  // The handlers stay installed until the process exits. Every signal goes to the daemon's one stop trigger
  // (docs/plans/portal.md R14), as the portal's POST /v1/stop does: the first starts the stop; any later one — a second
  // Ctrl-C, a shutdown during `asha --stop`, the terminal closing, a stop the page began — is logged and changes nothing.
  ctx.shutdownSignals((signal) => {
    daemon.requestStop({ source: 'signal', signal });
  });
  // Settles when the stop settles, whoever began it: --server then exits 0, or with the stop's failure.
  await daemon.stopped;
  return EXIT.ok;
}

/**
 * `asha --portal` (docs/plans/portal.md R1): the daemon found or started as a message finds it; the forwarding page
 * written to ASHA_HOME/portal.html — its only content a script sending the browser to the daemon's page with the
 * credential and the user ID in the URL fragment, which no request carries — then `open` on that file, bounded by
 * PORTAL_OPEN_MS. The credential is in no output, no process's arguments and no log record.
 */
async function portal(ctx: Ctx, user: string): Promise<number> {
  const daemon = await runningDaemon(ctx);
  if (daemon === undefined) return EXIT.failed;
  const { portalFile } = harnessPaths(ctx.env);
  const fragment = new URLSearchParams({ c: daemon.credential, u: user }).toString();
  const target = JSON.stringify(`http://127.0.0.1:${String(daemon.port)}/#${fragment}`);
  await ctx.portal.writeFile(
    portalFile,
    `<!doctype html>\n<meta charset="utf-8">\n<title>asha portal</title>\n<script>location.replace(${target});</script>\n`,
  );
  let reason: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = ctx.portal.open(portalFile);
    const bound = new Promise<'timeout'>((resolveBound) => {
      timer = setTimeout(() => {
        resolveBound('timeout');
      }, PORTAL_OPEN_MS);
    });
    const exited = await Promise.race([opened.exited, bound]);
    if (exited === 0) {
      ctx.stdout(`portal: http://127.0.0.1:${String(daemon.port)}/\n`);
      return EXIT.ok;
    }
    if (exited === 'timeout') {
      opened.kill();
      reason = `open did not exit within ${String(PORTAL_OPEN_MS)} ms, and was killed`;
    } else reason = typeof exited === 'number' ? `open exited ${String(exited)}` : `open was ended by ${exited}`;
  } catch (error) {
    // `open` could not be spawned (not on PATH, say).
    reason = `open could not be started: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
  ctx.stderr(`✗ could not open a browser (${reason}); open ${portalFile} in one\n`);
  return EXIT.failed;
}

async function status(ctx: Ctx): Promise<number> {
  const found = await findDaemon(ctx, { warnStale: true, stopping: false });
  if (found.kind === 'failed') return EXIT.failed;
  if (found.kind === 'absent') {
    ctx.stdout('not running\n');
    return EXIT.failed;
  }
  // The true state, with "not running"'s exit code: it takes no new work (debt-paydown R16).
  if (found.kind === 'stopping') {
    ctx.stdout(`stopping (pid ${String(found.pid)})\n`);
    return EXIT.failed;
  }
  if (found.kind === 'legacy') throw new Error('findDaemon returned a legacy daemon without stopping');
  for (const line of statusLines(found.health, found.port)) ctx.stdout(`${line}\n`);
  return EXIT.ok;
}

async function stop(ctx: Ctx): Promise<number> {
  // A daemon from before credentials is found too: stopping it is how it is replaced.
  const daemon = await findDaemon(ctx, { warnStale: false, stopping: true });
  if (daemon.kind === 'failed') return EXIT.failed;
  if (daemon.kind === 'absent') {
    ctx.stdout('not running\n');
    return EXIT.ok;
  }
  // A daemon already stopping is sent no signal: its stop is under way, so this waits for it (debt-paydown R16).
  if (daemon.kind === 'stopping') {
    if (await stoppedWithin(ctx, daemon.pid)) {
      ctx.stdout(`stopped (pid ${String(daemon.pid)})\n`);
      return EXIT.ok;
    }
    ctx.stderr(stillRunningLine(daemon.pid, ctx.timing.serverStopMs, 'this --stop began waiting for its stop'));
    return EXIT.failed;
  }
  const pid = daemon.health.pid;
  ctx.kill(pid, 'SIGTERM');
  const deadline = Date.now() + ctx.timing.serverStopMs;
  while (Date.now() < deadline) {
    if (!ctx.isAlive(pid)) {
      ctx.stdout(`stopped (pid ${String(pid)})\n`);
      return EXIT.ok;
    }
    await ctx.sleep(ctx.timing.pollMs);
  }
  ctx.stderr(stillRunningLine(pid, ctx.timing.serverStopMs, 'SIGTERM'));
  return EXIT.failed;
}

/**
 * `--stop channel=<name>` (docs/plans/portal-demo-stop.md R4): every agent on the channel stopped, then every model
 * server no agent needs, the daemon left running. Prints `stopped <handle>` per agent and `stopped the model server for
 * <model>` per server, then exits 0. No daemon running, no agent on the channel, or a failed stop: one ✗ line, exit 1.
 * It never starts a daemon: there would be nothing to stop.
 */
async function stopChannel(outer: Ctx, channel: string): Promise<number> {
  const ctx = outer;
  const daemon = await findDaemon(ctx, { warnStale: true, stopping: false });
  if (daemon.kind === 'failed') return EXIT.failed;
  if (daemon.kind === 'absent') {
    ctx.stderr('✗ no daemon is running\n');
    return EXIT.failed;
  }
  if (daemon.kind === 'stopping') {
    ctx.stderr(`✗ the daemon (pid ${String(daemon.pid)}) is stopping, which stops every channel's agents\n`);
    return EXIT.failed;
  }
  if (daemon.kind === 'legacy') {
    ctx.stderr(
      `✗ the daemon (pid ${String(daemon.health.pid)}) is from before credentials and cannot stop one channel; run asha --stop\n`,
    );
    return EXIT.failed;
  }
  const controller = new AbortController();
  let idle = setTimeout(() => {
    controller.abort();
  }, ctx.timing.streamIdleMs);
  try {
    const response = await ctx.fetch(`http://127.0.0.1:${String(daemon.port)}${Routes.channelStop}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.credential}` },
      body: JSON.stringify({ channel, source: 'cli' }),
      signal: controller.signal,
    });
    if (response.status === 404) {
      ctx.stderr(noAgentOnChannelLine(channel));
      return EXIT.failed;
    }
    if (!response.ok || response.body === null) {
      ctx.stderr(daemonRefusedLine('refused the stop', response.status, await response.text()));
      return EXIT.failed;
    }
    if (notEventStream(ctx, response, 'stop')) return EXIT.failed;
    const printer = new ChannelStopPrinter(ctx, channel);
    const events = sseEvents(response.body, () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        controller.abort();
      }, ctx.timing.streamIdleMs);
    });
    for await (const raw of events) {
      const code = printer.handle(raw as ChannelStopEvent);
      if (code !== undefined) return code;
    }
    return printer.ended();
  } catch (error) {
    if (streamCut(error)) {
      ctx.stderr(
        `✗ the daemon closed the stop of channel ${channel} before it was done (${String(streamCut(error))})\n`,
      );
      return EXIT.failed;
    }
    if (controller.signal.aborted) {
      ctx.stderr(silenceLine(ctx.timing.streamIdleMs));
      return EXIT.failed;
    }
    throw error;
  } finally {
    clearTimeout(idle);
  }
}

/** An abort controller signalling, its idle timer and `ctx.signal`'s own listener, for idleAbort's dispose. */
interface IdleAbort {
  readonly controller: AbortController;
  /** Called on every event from the stream: restarts the idle timer. */
  reset(): void;
  /** Stops the idle timer and detaches from ctx.signal. Always called, in a `finally`. */
  dispose(): void;
}

/**
 * An AbortController that aborts when `ctx.signal` does, or when `reset` has not been called for `streamIdleMs`.
 * Its own function, never inlined: a nested closure defined directly in a function's body inflates that function's
 * own cognitive complexity far past what its statements alone would (measured for runCli's ctx, 2026-10-13), and
 * this one function builds three.
 */
function idleAbort(ctx: Pick<Ctx, 'signal' | 'timing'>): IdleAbort {
  const controller = new AbortController();
  const abandon = () => {
    controller.abort();
  };
  ctx.signal.addEventListener('abort', abandon, { once: true });
  let idle = setTimeout(() => {
    controller.abort();
  }, ctx.timing.streamIdleMs);
  return {
    controller,
    reset() {
      clearTimeout(idle);
      idle = setTimeout(() => {
        controller.abort();
      }, ctx.timing.streamIdleMs);
    },
    dispose() {
      clearTimeout(idle);
      ctx.signal.removeEventListener('abort', abandon);
    },
  };
}

/**
 * A reply's returned files (agent-files R12a): handed to `onFiles` if given, else saved here. True once every
 * file handed off this way, or every one saved, failed none; false if any save failed.
 */
async function handedOrSaved(
  ctx: Ctx,
  daemon: FoundDaemon,
  channel: string,
  returned: readonly ReturnedFile[],
  onFiles: ((files: readonly ReturnedFile[], daemon: FoundDaemon) => void) | undefined,
): Promise<boolean> {
  if (onFiles !== undefined) {
    onFiles(returned, daemon);
    return true;
  }
  let allSaved = true;
  for (const file of returned) if (!(await saveReturned(ctx, daemon, channel, file))) allSaved = false;
  return allSaved;
}

/** converse's options, named here so postAndFollow can share the type. */
interface ConverseOptions {
  readonly printer: DeltaPrinter;
  readonly deltas: boolean;
  /** Files to attach (agent-files R1): `file=`'s, or a line's paths. */
  readonly attach?: AttachRequest;
  /**
   * Where the files of a reply to this conversation go instead of being saved here: the interactive session with its
   * view on saves them once the view has printed that reply (R12a).
   */
  readonly onFiles?: (files: readonly ReturnedFile[], daemon: FoundDaemon) => void;
}

/** converse's try block, once the message is posted: follows its conversation until it settles, or the turn closes. */
async function followConversation(
  ctx: Ctx,
  daemon: FoundDaemon,
  request: ConversationRequest,
  response: Response,
  idle: IdleAbort,
  options: ConverseOptions,
): Promise<number> {
  const { printer } = options;
  if (!response.ok || response.body === null) {
    ctx.stderr(daemonRefusedLine('rejected the message', response.status, await response.text()));
    return EXIT.failed;
  }
  if (notEventStream(ctx, response, 'message')) return EXIT.failed;
  const tracker = new ConversationTracker(ctx, {
    sameBuild: daemon.health.build === ctx.build,
    deltas: options.deltas ? printer : null,
  });
  const events = sseEvents(response.body, () => {
    idle.reset();
  });
  let settled: number | undefined;
  let filesFailed = false;
  for await (const event of events) {
    settled = tracker.handle(event as ConversationEvent);
    // A reply's files, after its text: saved here, or handed to the session's view (agent-files R12a).
    const returned = returnedFiles(event as ConversationEvent);
    if (returned.length > 0 && !(await handedOrSaved(ctx, daemon, request.channel, returned, options.onFiles)))
      filesFailed = true;
    if (settled !== undefined) break;
  }
  printer.end();
  if (settled !== undefined) return filesFailed ? EXIT.failed : settled;
  ctx.stderr(CONVERSATION_CLOSED);
  return EXIT.failed;
}

/** converse's prologue, once settled: the daemon and the message's uploaded attachments, or the exit code to return. */
type ConversePrep =
  | { readonly ok: true; readonly daemon: FoundDaemon; readonly attachments: string | undefined }
  | { readonly ok: false; readonly exitCode: number };

/**
 * converse's prologue: reads the message's files (R2), finds or starts the daemon, and uploads the files to it.
 * Nothing is posted yet.
 */
async function prepareConversation(
  ctx: Ctx,
  request: ConversationRequest,
  options: ConverseOptions,
): Promise<ConversePrep> {
  // A message's files are read before anything is sent: a file= that cannot attach refuses the message (R2).
  const files =
    options.attach === undefined
      ? []
      : await readMessageFiles(ctx, options.attach, pathContext(ctx, harnessPaths(ctx.env).home));
  if (files === undefined) return { ok: false, exitCode: EXIT.failed };
  const daemon = await runningDaemon(ctx);
  if (daemon === undefined) {
    for (const f of files) await f.close();
    return { ok: false, exitCode: ctx.signal.aborted ? EXIT.interrupted : EXIT.failed };
  }
  if (files.length === 0) return { ok: true, daemon, attachments: undefined };
  const attach = present(options.attach, 'options.attach, since files is non-empty only when it was given');
  const uploaded = await attachFiles(ctx, daemon, request, files, attach.kind === 'files');
  if (uploaded === 'failed') return { ok: false, exitCode: ctx.signal.aborted ? EXIT.interrupted : EXIT.failed };
  return { ok: true, daemon, attachments: uploaded };
}

/**
 * Posts one message and follows its conversation until it settles; returns the exit code. When `ctx.signal` aborts,
 * the request is abandoned and EXIT.interrupted returned, with nothing printed. `printer` prints the models' output
 * as it streams (with --verbose) and ends its open line before anything else is printed: one per command or session,
 * so a channel view printing beside the conversation shares it. `deltas`: false where another view prints the
 * deltas (--interactive's /watch on, model-streaming R7).
 */
export async function converse(outer: Ctx, request: ConversationRequest, options: ConverseOptions): Promise<number> {
  const ctx = options.printer.around(outer);
  const prepared = await prepareConversation(ctx, request, options);
  if (!prepared.ok) return prepared.exitCode;
  const { daemon, attachments } = prepared;
  const idle = idleAbort(ctx);
  try {
    const response = await ctx.fetch(`http://127.0.0.1:${String(daemon.port)}${Routes.conversations}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.credential}` },
      body: JSON.stringify(attachments === undefined ? request : { ...request, attachments }),
      signal: idle.controller.signal,
    });
    return await followConversation(ctx, daemon, request, response, idle, options);
  } catch (error) {
    if (ctx.signal.aborted) return EXIT.interrupted;
    if (streamCut(error)) {
      ctx.stderr(`${CONVERSATION_CLOSED.slice(0, -1)} (${String(streamCut(error))})\n`);
      return EXIT.failed;
    }
    if (idle.controller.signal.aborted) {
      ctx.stderr(silenceLine(ctx.timing.streamIdleMs));
      return EXIT.failed;
    }
    throw error;
  } finally {
    idle.dispose();
  }
}

/**
 * A message's files sent to the daemon (agent-files R3a, R7, R8, R11): the channel's space made ready, the cloud
 * warning said for each cloud-granted agent before any byte leaves, the bounds checked against the space's usage, then
 * one upload. Its id, or 'failed' once a refusal is printed; every file's descriptor is closed either way.
 */
async function attachFiles(
  ctx: Ctx,
  daemon: FoundDaemon,
  request: ConversationRequest,
  files: OpenAttachment[],
  strict: boolean,
): Promise<string | undefined> {
  try {
    const space = await prepareSpace(
      ctx,
      daemon,
      { channel: request.channel, ...(request.recipe === undefined ? {} : { recipe: request.recipe }) },
      sseEvents,
    );
    if (space === undefined) return 'failed';
    for (const agent of space.cloudAgents) ctx.stderr(cloudWarning(agent, request.channel));
    const fitting = await withinBounds(ctx, files, space, request.channel, strict);
    if (fitting === undefined) return 'failed';
    if (fitting.length === 0) return undefined;
    const user = present(request.user, 'request.user, set by every caller of converse() before this point');
    const answer = await upload(ctx, daemon, { channel: request.channel, user, files: fitting });
    if (answer === undefined) return 'failed';
    // Only with --verbose (the owner's answer to question 4): the daemon's files.attached record is kept either way.
    answer.files.forEach((f, i) => {
      ctx.progress(attachedLine(present(fitting[i], 'the fitting file at this upload answer’s index').shown, f));
    });
    return answer.upload;
  } finally {
    for (const f of files) await f.close();
  }
}

/**
 * Launches a recipe's agent, printing its handle, or every member of a team, printing each handle as it comes
 * online (collaborating-agents R5); exits non-zero, naming the member and why, when any fails to start.
 *
 * To a daemon of its own build it sends `followResent` (agent-persistence R9 (h), (i)): a persisted agent's launch
 * that re-sends users' messages from before a restart then streams each re-sent conversation, and this command
 * prints `› resuming your message from <savedAt>` for each — always, with or without --verbose — and its replies on
 * stdout as a message command prints its own, reading the stream to its end, bounded by the stream's inactivity
 * bound; it exits 0 at the stream's end after `launched`, 1 when the stream goes silent, is cut or ends with an
 * error. An older daemon's closed body would refuse the field, so another build is not asked, and its launch
 * returns at `launched` as ever.
 */
async function launch(
  outer: Ctx,
  what: { readonly recipe: string } | { readonly team: string },
  channel: string,
): Promise<number> {
  const team = 'team' in what;
  const printer = new DeltaPrinter(outer.progress);
  const ctx = printer.around(outer);
  const daemon = await runningDaemon(ctx);
  if (daemon === undefined) return EXIT.failed;
  const follow = daemon.health.build === ctx.build;
  const controller = new AbortController();
  let idle = setTimeout(() => {
    controller.abort();
  }, ctx.timing.streamIdleMs);
  const launchPrinter = new LaunchPrinter(ctx, printer, { team, follow });
  try {
    const response = await ctx.fetch(`http://127.0.0.1:${String(daemon.port)}${Routes.agents}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.credential}` },
      body: JSON.stringify({ ...what, channel, ...(follow ? { followResent: true } : {}) }),
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      ctx.stderr(daemonRefusedLine('refused the launch', response.status, await response.text()));
      return EXIT.failed;
    }
    if (notEventStream(ctx, response, 'launch')) return EXIT.failed;
    const events = sseEvents(response.body, () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        controller.abort();
      }, ctx.timing.streamIdleMs);
    });
    for await (const raw of events) {
      const code = launchPrinter.handle(raw as LaunchEvent);
      if (code !== undefined) return code;
    }
    return launchPrinter.ended();
  } catch (error) {
    if (streamCut(error)) {
      ctx.stderr(`${LAUNCH_CLOSED.slice(0, -1)} (${String(streamCut(error))})\n`);
      return EXIT.failed;
    }
    if (controller.signal.aborted) {
      ctx.stderr(silenceLine(ctx.timing.streamIdleMs));
      return EXIT.failed;
    }
    throw error;
  } finally {
    clearTimeout(idle);
  }
}

/**
 * The socket's cause when the daemon's end of a stream went away mid-body (the daemon stopped or crashed): fetch
 * throws TypeError "terminated" with an undici socket error as its cause. Any other error is not this.
 */
export function streamCut(error: unknown): string | undefined {
  if (!(error instanceof TypeError) || error.message !== 'terminated') return undefined;
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  return cause?.code === 'UND_ERR_SOCKET' ? String(cause.message) : undefined;
}

async function watch(outer: Ctx, channel: string): Promise<number> {
  // With --verbose the models' output is printed on stderr as it streams (model-streaming R7); stdout is unchanged.
  const printer = new DeltaPrinter(outer.progress);
  const ctx = printer.around(outer);
  const controller = new AbortController();
  const unsubscribe = ctx.shutdownSignals(() => {
    controller.abort();
  });
  try {
    const watchPrinter = new WatchPrinter(ctx, printer, '; Ctrl-C to stop');
    const ended = await followChannel({ ...ctx, signal: controller.signal }, channel, (event) => {
      watchPrinter.handle(event);
    });
    printer.end();
    // Ctrl-C is how a watch normally ends.
    return ended === 'stopped' ? EXIT.ok : EXIT.failed;
  } finally {
    unsubscribe();
  }
}

/**
 * Follows the channel stream (`GET /v1/channel`), finding or starting the daemon first and handing each event to
 * `onEvent`, until `ctx.signal` aborts ('stopped') or the stream ends with an error event, ends, is cut or goes
 * silent past streamIdleMs ('failed', already reported on stderr).
 */
export async function followChannel(
  ctx: Ctx,
  channel: string,
  onEvent: (event: Exclude<WatchEvent, { type: 'error' }>) => void,
): Promise<'stopped' | 'failed'> {
  const daemon = await runningDaemon(ctx);
  if (daemon === undefined) return ctx.signal.aborted ? 'stopped' : 'failed';

  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  ctx.signal.addEventListener('abort', stop, { once: true });
  let idle = setTimeout(() => {
    controller.abort();
  }, ctx.timing.streamIdleMs);
  try {
    const url = `http://127.0.0.1:${String(daemon.port)}${Routes.channel}?name=${encodeURIComponent(channel)}`;
    const response = await ctx.fetch(url, {
      headers: { authorization: `Bearer ${daemon.credential}` },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      ctx.stderr(`✗ the daemon refused the watch: HTTP ${String(response.status)}: ${await response.text()}\n`);
      return 'failed';
    }
    if (notEventStream(ctx, response, 'watch')) return 'failed';
    const events = sseEvents(response.body, () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        controller.abort();
      }, ctx.timing.streamIdleMs);
    });
    for await (const raw of events) {
      const event = raw as WatchEvent;
      if (event.type === 'error') {
        // The daemon ended the watch, saying why: this watcher fell behind (slow_reader, model-streaming R6).
        ctx.stderr(errorLine(event));
        return 'failed';
      }
      onEvent(event);
    }
    ctx.stderr(WATCH_CLOSED);
    return 'failed';
  } catch (error) {
    if (ctx.signal.aborted) return 'stopped';
    if (streamCut(error)) {
      ctx.stderr(`${WATCH_CLOSED.slice(0, -1)} (${String(streamCut(error))})\n`);
      return 'failed';
    }
    if (controller.signal.aborted) {
      ctx.stderr(silenceLine(ctx.timing.streamIdleMs));
      return 'failed';
    }
    throw error;
  } finally {
    clearTimeout(idle);
    ctx.signal.removeEventListener('abort', stop);
  }
}

export interface FoundDaemon {
  readonly kind: 'running';
  readonly port: number;
  /** The control credential from daemon.json, sent on every request. */
  readonly credential: string;
  readonly health: HealthResponse;
}

/**
 * What `findDaemon` found. `absent`: no daemon.json, or its daemon no longer
 * answers. `failed`: a problem already reported on stderr, which the command
 * must not paper over by starting a second daemon.
 */
type DaemonLookup =
  | FoundDaemon
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed' }
  /** A daemon from before credentials; returned only to --stop. */
  | { readonly kind: 'legacy'; readonly port: number; readonly health: HealthResponse }
  /**
   * A live asha daemon that is stopping (debt-paydown R15): daemon.json says `stopping: true`, or its health answers
   * 503 with reason `stopping`. Only --status, --stop and a start's poll see it; every other command waits for it to
   * stop first (findDaemonAfterStop).
   */
  | { readonly kind: 'stopping'; readonly pid: number };

/** What a command other than --status, --stop and a start's poll sees: a stopping daemon has been waited out. */
export type SettledLookup = Exclude<DaemonLookup, { readonly kind: 'stopping' }>;

interface FindOptions {
  /** Warn when the daemon runs a different build than this CLI (not for --stop, where stopping it is the fix). */
  readonly warnStale: boolean;
  /** For --stop: a daemon from before credentials is returned (to be stopped) rather than refused. */
  readonly stopping: boolean;
}

/** daemon.json as written by a daemon from before credentials: `{pid, port}`. */
interface LegacyDaemonFile {
  readonly pid: number;
  readonly port: number;
}

/**
 * `JSON.stringify`'s declared type claims it always returns `string`; at runtime it returns `undefined` for a
 * value JSON cannot represent (`undefined` itself, a function, a symbol) — the hole this corrects, so parseDaemonFile's
 * `?? 'missing'` fallbacks are checked as the real possibility they are, not reported as unreachable.
 */
function stringifyMaybe(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/** parseDaemonFile's result: the parsed file, or what is wrong with it. */
type DaemonFileResult = DaemonFile | LegacyDaemonFile | string;

/** parseDaemonFile's error, typed as its result (see messageArgsProblem on why every return must go through one). */
function daemonFileProblem(message: string): DaemonFileResult {
  return message;
}

/** parseDaemonFile's success, typed the same way as daemonFileProblem. */
function daemonFileOk(file: DaemonFile | LegacyDaemonFile): DaemonFileResult {
  return file;
}

/** The daemon file's content, or what is wrong with it. `stopping`, when present, is exactly true (debt-paydown R15). */
export function parseDaemonFile(text: string): DaemonFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return daemonFileProblem('it is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return daemonFileProblem('it is not a JSON object');
  const { pid, port, credential, stopping } = parsed as {
    pid?: unknown;
    port?: unknown;
    credential?: unknown;
    stopping?: unknown;
  };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
    return daemonFileProblem(`pid is not a process id (${stringifyMaybe(pid) ?? 'missing'})`);
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535)
    return daemonFileProblem(`port is not a TCP port (${stringifyMaybe(port) ?? 'missing'})`);
  if (stopping !== undefined && stopping !== true)
    return daemonFileProblem(`stopping is not true (${JSON.stringify(stopping)})`);
  if (credential === undefined) return daemonFileOk({ pid, port });
  if (typeof credential !== 'string' || !/^[\x21-\x7e]+$/.test(credential))
    return daemonFileProblem('credential is not a non-empty string of printable characters');
  return daemonFileOk({ pid, port, credential, ...(stopping === true ? { stopping } : {}) });
}

/** findDaemon's probe of the health route: the response, or the lookup once something there has settled it. */
/** findDaemon's fetch of the health route failed: interrupted, or the daemon no longer answers (a stale file). */
function healthFetchFailed(ctx: Ctx, file: DaemonFile | LegacyDaemonFile, error: unknown): DaemonLookup {
  // Interrupted: the command is ending, and the daemon is no more absent than before.
  if (ctx.signal.aborted) return { kind: 'failed' };
  // A daemon file whose daemon no longer answers (killed without shutting
  // down). Reported, then treated as not running; a new daemon replaces it.
  if (!ctx.notedStalePorts.has(file.port))
    ctx.stderr(`(daemon file names port ${String(file.port)}, which did not answer: ${(error as Error).message})\n`);
  ctx.notedStalePorts.add(file.port);
  return { kind: 'absent' };
}

/** findDaemon's lookup once the health route has answered, ok or not: the 401 and 503 it reads specially. */
async function healthResponseLookup(
  ctx: Ctx,
  options: FindOptions,
  paths: HarnessPaths,
  file: DaemonFile | LegacyDaemonFile,
  credential: string | undefined,
  response: Response,
): Promise<DaemonLookup> {
  if (credential !== undefined && response.status === 401) {
    // The file's daemon is dead and another server took its port: the file is stale, and a new daemon replaces it
    // (the pid lock of a dead process is cleared on start). Without this, every command, --stop too, failed until
    // the user removed the file by hand (control-api-auth completion review, F1).
    if (!ctx.isAlive(file.pid)) {
      ctx.stderr(
        `(daemon file names pid ${String(file.pid)}, which is not running; port ${String(file.port)} now belongs to another server)\n`,
      );
      return { kind: 'absent' };
    }
    // A daemon answers but refuses this credential: never "not running", which would start a second daemon against the held lock.
    ctx.stderr(
      `✗ the daemon on port ${String(file.port)} refused the credential in ${paths.daemonFile} (HTTP 401), so that file is not this daemon's. ` +
        `If no asha daemon is running for this home, remove the file.\n`,
    );
    return { kind: 'failed' };
  }
  if (!response.ok) {
    // A stopping daemon answers every /v1/ request 503 with reason stopping (R15): read before its file says so.
    if (response.status === 503 && (await stoppingRefusal(response)) && (await isStoppingDaemon(ctx, file.pid)))
      return { kind: 'stopping', pid: file.pid };
    return { kind: 'absent' };
  }
  return healthLookup(ctx, options, file, credential, response);
}

/** findDaemon's lookup once the health route has answered ok: legacy, stale-build-warned, or running. */
async function healthLookup(
  ctx: Ctx,
  options: FindOptions,
  file: DaemonFile | LegacyDaemonFile,
  credential: string | undefined,
  response: Response,
): Promise<DaemonLookup> {
  // A daemon from before build tracking reports neither field: it is certainly another build.
  const reported = (await response.json()) as Omit<HealthResponse, 'build' | 'startedAt'> &
    Partial<Pick<HealthResponse, 'build' | 'startedAt'>>;
  const health: HealthResponse = {
    ...reported,
    build: reported.build ?? 'unknown, from before builds were tracked',
    startedAt: reported.startedAt ?? 'at an unknown time',
  };
  if (credential === undefined) {
    // A daemon from before credentials answered without one (R4).
    if (options.stopping) return { kind: 'legacy', port: file.port, health };
    ctx.stderr(
      `✗ the running daemon (pid ${String(health.pid)}, port ${String(file.port)}) predates credentials: it serves its API to any local process. ` +
        `Run asha --stop to replace it with this build.\n`,
    );
    return { kind: 'failed' };
  }
  if (options.warnStale && health.build !== ctx.build && !ctx.warnedBuilds.has(health.build)) {
    // Always shown, --verbose or not: answers from old code look like a bug in the new code. Once per build in a
    // command or an interactive session, so it does not bury the replies; a daemon of yet another build is news.
    ctx.warnedBuilds.add(health.build);
    ctx.stderr(
      `⚠ the running daemon (pid ${String(health.pid)}, started ${health.startedAt}) runs a different build (${health.build}) ` +
        `than this asha (${ctx.build}), and so do its agents. Run asha --stop to use this build.\n`,
    );
  }
  return { kind: 'running', port: file.port, credential, health };
}

/**
 * The running daemon, found through daemon.json and authenticated with its
 * credential; see DaemonLookup. With `warnStale`, says so when it runs a
 * different build than this CLI.
 */
async function findDaemon(ctx: Ctx, options: FindOptions): Promise<DaemonLookup> {
  const paths = harnessPaths(ctx.env);
  let text: string;
  try {
    text = await readFile(paths.daemonFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  const file = parseDaemonFile(text);
  if (typeof file === 'string') {
    ctx.stderr(
      `✗ ${paths.daemonFile} cannot be read as a daemon file: ${file}. If no asha daemon is running for this home, remove it.\n`,
    );
    return { kind: 'failed' };
  }
  const credential = 'credential' in file ? file.credential : undefined;
  // A daemon that has begun to stop says so in its file until it releases its lock (debt-paydown R14, R15).
  if ('stopping' in file && file.stopping === true)
    return (await isStoppingDaemon(ctx, file.pid)) ? { kind: 'stopping', pid: file.pid } : { kind: 'absent' };
  let response: Response;
  try {
    response = await ctx.fetch(`http://127.0.0.1:${String(file.port)}${Routes.health}`, {
      ...(credential === undefined ? {} : { headers: { authorization: `Bearer ${credential}` } }),
      signal: withTimeout(HEALTH_TIMEOUT_MS, ctx.signal),
    });
  } catch (error) {
    return healthFetchFailed(ctx, file, error);
  }
  return healthResponseLookup(ctx, options, paths, file, credential, response);
}

/** Whether a 503's body is the stopping daemon's refusal, `reason: 'stopping'`; a body that is not JSON is not. */
async function stoppingRefusal(response: Response): Promise<boolean> {
  const text = await response.text();
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === 'object' && body !== null && (body as { reason?: unknown }).reason === 'stopping';
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** The command line an asha daemon runs with: `node …/dist/src/cli/main.js --server` (a checkout or a Homebrew keg). */
const DAEMON_COMMAND = /\/dist\/src\/cli\/main\.js --server$/;

/**
 * Whether `pid` is alive and an asha daemon (R15): a file saying stopping whose pid is dead, or was reused by another
 * program after a crash or a reboot, is no daemon at all, and never a 90 s wait.
 */
async function isStoppingDaemon(ctx: Ctx, pid: number): Promise<boolean> {
  if (!ctx.isAlive(pid)) return false;
  const command = await ctx.processCommand(pid);
  return command !== null && DAEMON_COMMAND.test(command);
}

/** Polls every pollMs until `pid` has exited, up to serverStopMs: whether it did. */
async function stoppedWithin(ctx: Ctx, pid: number): Promise<boolean> {
  const deadline = Date.now() + ctx.timing.serverStopMs;
  while (Date.now() < deadline) {
    if (!ctx.isAlive(pid)) return true;
    await ctx.sleep(ctx.timing.pollMs);
  }
  return !ctx.isAlive(pid);
}

/**
 * findDaemon for every command but --status, --stop and a start's poll (debt-paydown R16): a stopping daemon is
 * announced on stderr, with or without --verbose, and waited for; then the command goes on as if no daemon ran (a
 * command that starts one starts one). Past serverStopMs it fails, naming the log and the file.
 */
export async function findDaemonAfterStop(ctx: Ctx, options: FindOptions): Promise<SettledLookup> {
  const found = await findDaemon(ctx, options);
  if (found.kind !== 'stopping') return found;
  ctx.stderr(`⚠ the asha daemon (pid ${String(found.pid)}) is stopping; waiting for it to stop\n`);
  if (await stoppedWithin(ctx, found.pid)) return { kind: 'absent' };
  const paths = harnessPaths(ctx.env);
  ctx.stderr(
    `✗ the asha daemon (pid ${String(found.pid)}) was still stopping after ${String(ctx.timing.serverStopMs)} ms; see ${join(paths.logsDir, 'daemon.jsonl')}, ` +
      `and if no asha daemon runs for this home, remove ${paths.daemonFile}\n`,
  );
  return { kind: 'failed' };
}

/** The running daemon, started first if none is; undefined once a failure has been reported. */
export async function runningDaemon(ctx: Ctx): Promise<FoundDaemon | undefined> {
  const found = await findDaemonAfterStop(ctx, { warnStale: true, stopping: false });
  if (found.kind === 'running') return found;
  if (found.kind === 'failed' || ctx.signal.aborted) return undefined;
  if (found.kind === 'legacy') throw new Error('findDaemon returned a legacy daemon without stopping');
  return startServer(ctx);
}

/** startServer's one poll: the daemon once running, 'retry' to poll again, or undefined once this has given up. */
async function pollForServer(ctx: Ctx, pid: number, paths: HarnessPaths): Promise<FoundDaemon | 'retry' | undefined> {
  const daemon = await findDaemon(ctx, { warnStale: true, stopping: false });
  if (daemon.kind === 'running') return daemon;
  if (daemon.kind === 'failed') return undefined;
  if (daemon.kind === 'legacy') throw new Error('findDaemon returned a legacy daemon without stopping');
  // A stopping daemon is not yet up (debt-paydown R16): polled on like an absent one.
  if (ctx.isAlive(pid)) return 'retry';
  // Another CLI may have won the race to start one; if so, use it.
  const other = await findDaemonAfterStop(ctx, { warnStale: true, stopping: false });
  if (other.kind === 'running') return other;
  if (other.kind === 'failed') return undefined;
  if (other.kind === 'legacy') throw new Error('findDaemon returned a legacy daemon without stopping');
  ctx.stderr(`✗ the daemon exited during startup; see ${paths.serverLog}\n`);
  return undefined;
}

/**
 * The environment the CLI's auto-start gives the daemon it spawns (docs/plans/idle-shutdown.md R3): this command's, with
 * ASHA_IDLE_EXIT_MS at DAEMON_IDLE_EXIT_MS unless it is already set — a daemon nobody asked for leaves after 30 idle
 * minutes; one set, even to something invalid, is passed on for the daemon to judge.
 */
export function autoStartEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [LifetimeEnv.idleExitMs]: env[LifetimeEnv.idleExitMs] ?? String(DAEMON_IDLE_EXIT_MS) };
}

/** Starts a background daemon and waits, bounded, for it to answer. */
async function startServer(ctx: Ctx): Promise<FoundDaemon | undefined> {
  const paths = harnessPaths(ctx.env);
  const pid = await ctx.spawnServer(paths, autoStartEnv(ctx.env));
  ctx.progress(`› started the asha daemon (pid ${String(pid)}); log: ${paths.serverLog}\n`);
  const deadline = Date.now() + ctx.timing.serverStartMs;
  while (Date.now() < deadline) {
    await ctx.sleep(ctx.timing.pollMs);
    if (ctx.signal.aborted) return undefined;
    const polled = await pollForServer(ctx, pid, paths);
    if (polled !== 'retry') return polled;
  }
  ctx.stderr(`✗ the daemon did not answer within ${String(ctx.timing.serverStartMs)} ms; see ${paths.serverLog}\n`);
  return undefined;
}
