// `asha --list-state` and `asha --reset-state` (docs/plans/agent-persistence.md R5, R16): what is saved, removing
// it, and erasing one user's memory. Through the daemon's control API when a daemon answers; only when none does,
// on the files themselves, holding the daemon's own lock (daemon.lock) so no daemon can start meanwhile. An erase
// needs the container runtime, so it always goes through a daemon, started if none answers.

import { access } from 'node:fs/promises';

import { LockHeld, acquirePidLock } from '../daemon/process/index.js';
import { StateInsideGitTree, StateStore, nodeStateFs, selectorProblem } from '../daemon/state/index.js';
import { present } from '../shared/assert-present.js';
import { harnessPaths, insideGitTree } from '../shared/paths.js';
import {
  Routes,
  userIdProblem,
  type StateEraseEvent,
  type StateListResponse,
  type StateRefusalReason,
  type StateResetResponse,
  type StateSelector,
} from '../shared/protocol.js';
import {
  EXIT,
  findDaemonAfterStop,
  notEventStream,
  runningDaemon,
  sseEvents,
  streamCut,
  type Ctx,
} from './commands.js';
import { daemonRefusedLine, silenceLine } from '../shared/lines.js';
import {
  ERASE_CLOSED,
  ErasePrinter,
  listLines,
  narrowed,
  nothingMatchesLine,
  refusalLine,
  removedLines,
} from '../shared/state-lines.js';

// Shared with the portal's page (docs/plans/portal.md R15); re-exported for the CLI's own tests.
/** The arguments of `--reset-state`: the selector, `user=` for an erase, and `--yes`. */
interface ResetArgs {
  readonly selector: StateSelector;
  readonly user: string | undefined;
  readonly yes: boolean;
}

/** parseResetArgs' scan of argv: `all`, `--yes` and the once-only `key=value`s, or the problem naming what is wrong. */
type ScannedResetArgs = { readonly all: boolean; readonly yes: boolean; readonly values: Map<string, string> } | string;

/** scanResetArgs' error, typed as its result (see messageArgsProblem in commands.ts on why every return must go through one). */
function scanResetArgsProblem(message: string): ScannedResetArgs {
  return message;
}

/** scanResetArgs' success, typed the same way as scanResetArgsProblem. */
function scanResetArgsOk(all: boolean, yes: boolean, values: Map<string, string>): ScannedResetArgs {
  return { all, yes, values };
}

/** parseResetArgs' scan of its argument words, before any of them are checked against each other. */
function scanResetArgs(argv: readonly string[]): ScannedResetArgs {
  let all = false;
  let yes = false;
  const values = new Map<string, string>();
  for (const arg of argv) {
    if (arg === 'all') {
      if (all) return scanResetArgsProblem('all given twice');
      all = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : '';
    if (!['channel', 'name', 'team', 'user'].includes(key))
      return scanResetArgsProblem(`unrecognized argument: ${arg}`);
    if (values.has(key)) return scanResetArgsProblem(`${key}= given twice`);
    values.set(key, arg.slice(eq + 1));
  }
  return scanResetArgsOk(all, yes, values);
}

/** parseResetArgs' error, typed as its result (see messageArgsProblem in commands.ts on why every return must go through one). */
function resetArgsProblem(message: string): ResetArgs | string {
  return message;
}

/** parseResetArgs' success, typed the same way as resetArgsProblem. */
function resetArgsOk(args: ResetArgs): ResetArgs | string {
  return args;
}

/**
 * Parses `--reset-state`'s arguments (R5, R16): `all` or `channel=` with optional `name=` and `team=` (which needs
 * `name=`), optional `user=` and `--yes`. Each selector checked before any path is formed. Returns the problem as
 * the `✗` line's text (exit 2) when malformed.
 */
/** parseResetArgs' channel/name/team check: the problem naming what is wrong, or undefined once it is a valid selector. */
function selectorArgsProblem(
  all: boolean,
  channel: string | undefined,
  name: string | undefined,
  team: string | undefined,
): string | undefined {
  if (all === (channel !== undefined))
    return '--reset-state takes all, or channel=<channel> [name=<name> [team=<team>]]';
  if (all && (name !== undefined || team !== undefined)) return 'all names nothing else';
  if (team !== undefined && name === undefined) return 'team= needs name=';
  return selectorProblem({
    ...(channel === undefined ? {} : { channel }),
    ...(name === undefined ? {} : { name }),
    ...(team === undefined ? {} : { team }),
  });
}

/** parseResetArgs' user= check (R16): needs channel=, and a valid user ID. */
function userArgProblem(all: boolean, user: string | undefined): string | undefined {
  if (user === undefined) return undefined;
  if (all) return 'user= needs channel=: a user ID names a person only on one channel';
  return userIdProblem(user, { isDefault: false });
}

function parseResetArgs(argv: readonly string[]): ResetArgs | string {
  const scanned = scanResetArgs(argv);
  if (typeof scanned === 'string') return resetArgsProblem(scanned);
  const { all, yes, values } = scanned;
  const channel = values.get('channel');
  const name = values.get('name');
  const team = values.get('team');
  const user = values.get('user');
  const problem = selectorArgsProblem(all, channel, name, team);
  if (problem !== undefined) return resetArgsProblem(problem);
  const userProblem = userArgProblem(all, user);
  if (userProblem !== undefined) return resetArgsProblem(userProblem);
  const selector: StateSelector = all
    ? { all: true }
    : {
        channel: present(channel, 'channel, since all is false and all === (channel !== undefined) was checked'),
        ...(name === undefined ? {} : { name }),
        ...(team === undefined ? {} : { team }),
      };
  return resetArgsOk({ selector, user, yes });
}

/**
 * The saved state's files, when no daemon answers (R5): the daemon's own lock taken for the command, as a daemon
 * takes it at start, and released at its end; a live holder refuses it. Undefined once a refusal is printed.
 */
async function offline<T>(ctx: Ctx, use: (store: StateStore) => Promise<T>, whenNoHome: T): Promise<T | undefined> {
  const paths = harnessPaths(ctx.env);
  try {
    await access(paths.home);
  } catch (error) {
    // No home: nothing was ever saved, and nothing is created to say so.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return whenNoHome;
    throw error;
  }
  const logger = ctx.createLogger(paths);
  let release: () => Promise<void>;
  try {
    release = await acquirePidLock({ file: paths.daemonLock, pid: ctx.pid, isAlive: ctx.isAlive, logger });
  } catch (error) {
    if (error instanceof LockHeld) {
      ctx.stderr(`✗ ${error.message}\n`);
      return undefined;
    }
    throw error;
  }
  try {
    return await use(
      new StateStore({ dir: paths.stateDir, fs: nodeStateFs, logger, clock: () => new Date(), insideGitTree }),
    );
  } catch (error) {
    if (error instanceof StateInsideGitTree) {
      ctx.stderr(`✗ ${error.message}\n`);
      return undefined;
    }
    throw error;
  } finally {
    await release();
  }
}

/** Sends a request to the daemon's control API, bounded like every other short one. */
async function control(
  ctx: Ctx,
  daemon: { readonly port: number; readonly credential: string },
  route: string,
  body?: unknown,
): Promise<Response> {
  return ctx.fetch(`http://127.0.0.1:${String(daemon.port)}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${daemon.credential}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(ctx.timing.streamIdleMs),
  });
}

/** What is saved, through the daemon or, with none, from the files. Undefined once a failure is printed. */
async function listed(ctx: Ctx): Promise<StateListResponse | undefined> {
  const daemon = await findDaemonAfterStop(ctx, { warnStale: true, stopping: false });
  if (daemon.kind === 'failed') return undefined;
  if (daemon.kind === 'running') {
    const response = await control(ctx, daemon, Routes.state);
    if (!response.ok) {
      ctx.stderr(daemonRefusedLine('refused the listing', response.status, await response.text()));
      return undefined;
    }
    return (await response.json()) as StateListResponse;
  }
  return offline(ctx, (store) => store.list(), { assets: [], pending: [], totalBytes: 0 });
}

/** `asha --list-state` (R5): one line per saved asset and per record of unsaved deliveries, then the total; `nothing saved`. */
export async function listState(ctx: Ctx): Promise<number> {
  const found = await listed(ctx);
  if (found === undefined) return EXIT.failed;
  for (const line of listLines(found)) ctx.stdout(`${line}\n`);
  return EXIT.ok;
}

/**
 * The confirmation `all`, `channel=…` and an erase without `name=` need (R5, R16): the matching lines and total
 * printed, then on a terminal the typed word `reset`, off one `--yes`; anything else is `✗ reset cancelled`.
 */
async function confirmed(ctx: Ctx, args: ResetArgs, matching: StateListResponse): Promise<boolean> {
  for (const line of listLines(matching)) ctx.stdout(`${line}\n`);
  if (ctx.input.isTerminal) {
    ctx.stderr('type reset to remove them: ');
    const iterator = ctx.input.lines[Symbol.asyncIterator]();
    const typed = await iterator.next();
    if (typed.done !== true && typed.value.trim() === 'reset') return true;
  } else if (args.yes) {
    return true;
  }
  ctx.stderr('✗ reset cancelled\n');
  return false;
}

/** resetState's confirmation, shared by the daemon and offline paths: false once a refusal is printed. */
async function confirmMatching(ctx: Ctx, args: ResetArgs, matching: StateListResponse): Promise<boolean> {
  if (matching.assets.length === 0 && matching.pending.length === 0) {
    ctx.stderr(`${nothingMatchesLine(args.selector)}\n`);
    return false;
  }
  return confirmed(ctx, args, matching);
}

/** resetState's reset through the daemon (R5). */
async function resetThroughDaemon(
  ctx: Ctx,
  daemon: { readonly port: number; readonly credential: string },
  args: ResetArgs,
  needsConfirmation: boolean,
): Promise<number> {
  if (needsConfirmation) {
    const all = await listed(ctx);
    if (all === undefined) return EXIT.failed;
    if (!(await confirmMatching(ctx, args, narrowed(all, args.selector, false)))) return EXIT.failed;
  }
  const response = await control(ctx, daemon, Routes.stateReset, args.selector);
  if (response.status === 409) {
    const refusal = (await response.json()) as { error: string; reason: StateRefusalReason };
    ctx.stderr(`${refusalLine(refusal.reason, refusal.error, args.selector)}\n`);
    return EXIT.failed;
  }
  if (!response.ok) {
    ctx.stderr(daemonRefusedLine('refused the reset', response.status, await response.text()));
    return EXIT.failed;
  }
  for (const line of removedLines(((await response.json()) as StateResetResponse).removed)) ctx.stdout(`${line}\n`);
  return EXIT.ok;
}

/** resetState's reset offline (R5): the daemon's own lock taken for the command. */
async function resetOffline(ctx: Ctx, args: ResetArgs, needsConfirmation: boolean): Promise<number> {
  const outcome = await offline<number>(
    ctx,
    async (store) => {
      if (needsConfirmation) {
        if (!(await confirmMatching(ctx, args, narrowed(await store.list(), args.selector, false)))) return EXIT.failed;
      }
      const removed = await store.reset(args.selector);
      if (removed === 'nothing_matches') {
        ctx.stderr(`${nothingMatchesLine(args.selector)}\n`);
        return EXIT.failed;
      }
      for (const line of removedLines(removed)) ctx.stdout(`${line}\n`);
      return EXIT.ok;
    },
    -1,
  );
  if (outcome === undefined) return EXIT.failed;
  if (outcome === -1) {
    ctx.stderr(`${nothingMatchesLine(args.selector)}\n`);
    return EXIT.failed;
  }
  return outcome;
}

/** `asha --reset-state …` (R5; with `user=`, R16's erase). */
export async function resetState(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const args = parseResetArgs(argv);
  if (typeof args === 'string') {
    ctx.stderr(`✗ ${args}\n`);
    return EXIT.usage;
  }
  if (args.user !== undefined) return eraseUser(ctx, args);
  const needsConfirmation = 'all' in args.selector || args.selector.name === undefined;
  const daemon = await findDaemonAfterStop(ctx, { warnStale: true, stopping: false });
  if (daemon.kind === 'failed') return EXIT.failed;
  if (daemon.kind === 'running') return resetThroughDaemon(ctx, daemon, args, needsConfirmation);
  return resetOffline(ctx, args, needsConfirmation);
}

/** eraseUser's selector type: `args.selector` narrowed to the channel-selector shape `user=` requires. */
type EraseSelector = { readonly channel: string; readonly name?: string; readonly team?: string };

/** eraseUser's idle timer, armed until `dispose`: resets on every event, aborting `controller` on inactivity. */
function eraseIdleTimer(timing: Ctx['timing'], controller: AbortController): { reset(): void; dispose(): void } {
  let idle = setTimeout(() => {
    controller.abort();
  }, timing.streamIdleMs);
  return {
    reset() {
      clearTimeout(idle);
      idle = setTimeout(() => {
        controller.abort();
      }, timing.streamIdleMs);
    },
    dispose() {
      clearTimeout(idle);
    },
  };
}

/** eraseUser's confirmation (R16), needed only without `name=`: the matching lines and total, then the typed word. */
async function confirmEraseSelection(ctx: Ctx, args: ResetArgs, selector: EraseSelector): Promise<number | undefined> {
  if (selector.name !== undefined) return undefined;
  const all = await listed(ctx);
  if (all === undefined) return EXIT.failed;
  const matching = narrowed(all, selector, true);
  if (matching.assets.length === 0) {
    ctx.stderr(`${nothingMatchesLine(selector)}\n`);
    return EXIT.failed;
  }
  if (!(await confirmed(ctx, args, matching))) return EXIT.failed;
  return undefined;
}

/** eraseUser's POST, once answered: the stream of StateEraseEvent, each printed as it comes. */
async function followEraseStream(
  ctx: Ctx,
  response: Response,
  selector: EraseSelector,
  user: string,
  idle: { reset(): void },
): Promise<number> {
  if (response.status === 409) {
    const refusal = (await response.json()) as { error: string; reason: StateRefusalReason };
    ctx.stderr(`${refusalLine(refusal.reason, refusal.error, selector)}\n`);
    return EXIT.failed;
  }
  if (!response.ok || response.body === null) {
    ctx.stderr(daemonRefusedLine('refused the erase', response.status, await response.text()));
    return EXIT.failed;
  }
  if (notEventStream(ctx, response, 'erase')) return EXIT.failed;
  const events = sseEvents(response.body, () => {
    idle.reset();
  });
  const printer = new ErasePrinter(ctx, user);
  for await (const raw of events) {
    const code = printer.handle(raw as StateEraseEvent);
    if (code !== undefined) return code;
  }
  ctx.stderr(ERASE_CLOSED);
  return EXIT.failed;
}

/**
 * R16's erase: through a daemon — started if none answers — as a stream of StateEraseEvent, each printed as it
 * comes; bounded by the stream's inactivity bound, which the daemon's heartbeats keep from firing while it works.
 * Exit 0 when every identity was erased (or held nothing of the user), else 1.
 */
async function eraseUser(ctx: Ctx, args: ResetArgs): Promise<number> {
  const selector = args.selector as EraseSelector;
  const user = present(args.user, 'args.user, since resetState calls eraseUser only when it is given');
  const daemon = await runningDaemon(ctx);
  if (daemon === undefined) return EXIT.failed;
  const confirmResult = await confirmEraseSelection(ctx, args, selector);
  if (confirmResult !== undefined) return confirmResult;
  const controller = new AbortController();
  const idle = eraseIdleTimer(ctx.timing, controller);
  try {
    const response = await ctx.fetch(`http://127.0.0.1:${String(daemon.port)}${Routes.stateReset}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.credential}` },
      body: JSON.stringify({ ...selector, user }),
      signal: controller.signal,
    });
    return await followEraseStream(ctx, response, selector, user, idle);
  } catch (error) {
    if (streamCut(error)) {
      ctx.stderr(`${ERASE_CLOSED.slice(0, -1)} (${String(streamCut(error))})\n`);
      return EXIT.failed;
    }
    if (controller.signal.aborted) {
      ctx.stderr(silenceLine(ctx.timing.streamIdleMs));
      return EXIT.failed;
    }
    throw error;
  } finally {
    idle.dispose();
  }
}
