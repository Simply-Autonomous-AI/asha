// The module commands (docs/plans/extension-modules.md R4, R24, R26, R28, R36): `--install-module`,
// `--uninstall-module` and `--set-secret`. Install and uninstall run in the CLI alone, never beside a daemon of the
// home — refused while one answers — holding daemon.lock, so no daemon starts meanwhile and none ever sees the modules
// directory change. `--set-secret` reads the value from standard input (never an argument or the environment),
// writes the store itself, never over HTTP, and prints only the name and the value's length.

import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { present } from '../shared/assert-present.js';
import {
  readHandle,
  installModule,
  InstallRefused,
  removeModuleDirectory,
  installSummary,
} from '../daemon/modules/install.js';
import { ModuleImages } from '../daemon/modules/images.js';
import { LockHeld, acquirePidLock } from '../daemon/process/index.js';
import { FileSecretStore, SecretsInsideGitTree } from '../daemon/secrets/index.js';
import { streamFile } from '../daemon/images/index.js';
import {
  MANIFEST_FILE,
  MODULE_ID_PATTERN,
  SECRET_NAME_PATTERN,
  parseModuleManifest,
  type ModuleManifest,
} from '../shared/modules.js';
import { ensureHome, harnessPaths, insideGitTree, type HarnessPaths } from '../shared/paths.js';
import {
  ConversationTracker,
  EXIT,
  findDaemonAfterStop,
  notEventStream,
  sseEvents,
  streamCut,
  type Ctx,
  type FoundDaemon,
} from './commands.js';
import { readFile } from 'node:fs/promises';
import { enableRefusal, Meter, requestSha256, type ApprovalRequest, type Caps } from '../daemon/modules/index.js';
import { writePrivateFile } from '../daemon/private-file/index.js';
import { Routes, type ApprovedCall, type ConversationEvent } from '../shared/protocol.js';
import { visible } from '../shared/visible.js';
import { canonicalJson, NotCanonicalizable } from '../shared/jcs.js';

/** parseModuleArgs' result: the once-only keys' values and the flags given, or the error naming what is wrong. */
type ParsedModuleArgs = { readonly values: Map<string, string>; readonly flags: Set<string> } | string;

/** parseModuleArgs' error, typed as its result (see messageArgsProblem in commands.ts on why every return must go through one). */
function parseModuleArgsProblem(message: string): ParsedModuleArgs {
  return message;
}

/** parseModuleArgs' success, typed the same way as parseModuleArgsProblem. */
function parsedModuleArgsOk(values: Map<string, string>, flags: Set<string>): ParsedModuleArgs {
  return { values, flags };
}

/** `key=value` arguments of `keys`, each at most once, and the flags of `flags`; an error string when malformed. */
function parseModuleArgs(argv: readonly string[], keys: readonly string[], flags: readonly string[]): ParsedModuleArgs {
  const values = new Map<string, string>();
  const set = new Set<string>();
  for (const arg of argv) {
    if (flags.includes(arg)) {
      if (set.has(arg)) return parseModuleArgsProblem(`${arg} given twice`);
      set.add(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : '';
    if (!keys.includes(key)) return parseModuleArgsProblem(`unrecognized argument: ${arg}`);
    const value = arg.slice(eq + 1);
    if (value === '') return parseModuleArgsProblem(`${key}= is empty`);
    if (values.has(key)) return parseModuleArgsProblem(`${key}= given twice`);
    values.set(key, value);
  }
  return parsedModuleArgsOk(values, set);
}

/** The line a command refused for a running daemon prints (R4, R36). */
export const DAEMON_RUNNING = '✗ a daemon is running for this home; stop it first: asha --stop\n';

/**
 * Runs `work` holding daemon.lock, once no daemon of the home answers (R4, R36): a daemon that answers refuses it with
 * DAEMON_RUNNING; a lock held by a live process refuses it naming the holder. Returns its exit code.
 */
async function offlineOnly(
  ctx: Ctx,
  work: (paths: HarnessPaths, logger: ReturnType<Ctx['createLogger']>) => Promise<number>,
): Promise<number> {
  const found = await findDaemonAfterStop(ctx, { warnStale: false, stopping: false });
  if (found.kind === 'failed') return EXIT.failed;
  if (found.kind === 'running' || found.kind === 'legacy') {
    ctx.stderr(DAEMON_RUNNING);
    return EXIT.failed;
  }
  const paths = harnessPaths(ctx.env);
  await ensureHome(paths);
  const logger = ctx.createLogger(paths);
  let release: () => Promise<void>;
  try {
    release = await acquirePidLock({ file: paths.daemonLock, pid: ctx.pid, isAlive: ctx.isAlive, logger });
  } catch (error) {
    if (error instanceof LockHeld) {
      ctx.stderr(
        `✗ ${error.message}: a daemon is starting or another asha command holds this home; try again once it is done\n`,
      );
      return EXIT.failed;
    }
    throw error;
  }
  try {
    return await work(paths, logger);
  } finally {
    await release();
  }
}

/** Asks on a terminal for the exact word `yes`; off one, `--yes` alone confirms (R4). */
async function confirm(ctx: Ctx, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!ctx.input.isTerminal) {
    ctx.stderr('✗ not at a terminal: add --yes to confirm\n');
    return false;
  }
  ctx.stderr(question);
  const typed = await ctx.input.lines[Symbol.asyncIterator]().next();
  return typed.done !== true && typed.value === 'yes';
}

/** `asha --install-module path=<dir> [archive=<file>] [--yes]` (R1, R4, R26, R28). */
export async function installCommand(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const parsed = parseModuleArgs(argv, ['path', 'archive'], ['--yes']);
  if (typeof parsed === 'string' || !parsed.values.has('path')) {
    ctx.stderr(
      `${typeof parsed === 'string' ? parsed : 'missing path='}\n\n--install-module takes path=<module directory>, archive=<release archive> for a command plugin, and --yes\n`,
    );
    return EXIT.usage;
  }
  const source = present(parsed.values.get('path'), "path=, since parsed.values.has('path') was checked above");
  const archive = parsed.values.get('archive');
  const yes = parsed.flags.has('--yes');
  return offlineOnly(ctx, async (paths, logger) => {
    const runtime = ctx.dependencies(paths, logger).runtime;
    try {
      const installed = await installModule({
        source,
        archive,
        home: paths.home,
        modulesDir: paths.modulesDir,
        logger,
        vm: runtime,
        insideGitTree,
        beforeStaging: () => Promise.resolve(undefined),
        readArchive: readHandle,
        io: {
          progress: ctx.progress,
          warn: ctx.stderr,
          confirm: async (summary) => {
            ctx.stdout(summary);
            return confirm(ctx, 'Install this module? Type yes to install: ', yes);
          },
        },
      });
      // The image, built once at install from the installed directory (R5, R28), offline.
      ctx.progress(`› container_runtime: ${await runtime.ensureRunning()}\n`);
      const images = new ModuleImages({
        runtime,
        root: ctx.root,
        stagingDir: paths.stagingDir,
        logger,
        read: streamFile,
      });
      const image =
        installed.manifest.kind === 'CommandTool' ? await images.plugin(installed) : await images.module(installed);
      ctx.progress(`› image: ${image.tag} ${image.status}\n`);
      ctx.stdout(
        `${installed.upgraded ? 'upgraded' : 'installed'} ${installed.manifest.id} ${installed.manifest.version}\n`,
      );
      return EXIT.ok;
    } catch (error) {
      if (error instanceof InstallRefused) {
        ctx.stderr(`${error.message}\n`);
        return error.usage ? EXIT.usage : EXIT.failed;
      }
      throw error;
    }
  });
}

/** `asha --uninstall-module id=<id> [--yes]` (R4): the module's directory and its secrets removed. */
export async function uninstallCommand(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const parsed = parseModuleArgs(argv, ['id'], ['--yes']);
  const id = typeof parsed === 'string' ? undefined : parsed.values.get('id');
  if (typeof parsed === 'string' || id === undefined || !MODULE_ID_PATTERN.test(id)) {
    ctx.stderr(
      `${typeof parsed === 'string' ? parsed : 'id= must name a module'}\n\n--uninstall-module takes id=<module> and --yes\n`,
    );
    return EXIT.usage;
  }
  return offlineOnly(ctx, async (paths, logger) => {
    let manifest: ModuleManifest;
    try {
      manifest = parseModuleManifest(
        JSON.parse(await readFile(join(paths.modulesDir, id, MANIFEST_FILE), 'utf8')),
        MANIFEST_FILE,
        id,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        ctx.stderr(`✗ no module ${id} is installed\n`);
        return EXIT.failed;
      }
      throw error;
    }
    const store = secretStore(ctx, paths, logger);
    const names = await store.names(id);
    ctx.stdout(installSummary(manifest));
    ctx.stdout(`  its stored secrets, removed with it: ${names.length === 0 ? 'none' : names.join(', ')}\n`);
    if (!(await confirm(ctx, 'Uninstall this module? Type yes to uninstall: ', parsed.flags.has('--yes')))) {
      ctx.stderr(`✗ module ${id} was not uninstalled: not confirmed\n`);
      return EXIT.failed;
    }
    try {
      await store.deleteModule(id);
    } catch (error) {
      if (error instanceof LockHeld || error instanceof SecretsInsideGitTree) {
        ctx.stderr(`✗ ${error.message}\n`);
        return EXIT.failed;
      }
      throw error;
    }
    await removeModuleDirectory(paths.modulesDir, id, logger);
    ctx.stdout(`uninstalled ${id}\n`);
    return EXIT.ok;
  });
}

function secretStore(ctx: Ctx, paths: HarnessPaths, logger: ReturnType<Ctx['createLogger']>): FileSecretStore {
  return new FileSecretStore({
    home: paths.home,
    dir: paths.secretsDir,
    logger,
    pid: ctx.pid,
    isAlive: ctx.isAlive,
    insideGitTree,
  });
}

/** The module's manifest, read from its directory; undefined if none is installed by that id (ENOENT only). */
async function readModuleManifest(paths: HarnessPaths, id: string): Promise<ModuleManifest | undefined> {
  try {
    return parseModuleManifest(
      JSON.parse(await readFile(join(paths.modulesDir, id, MANIFEST_FILE), 'utf8')),
      MANIFEST_FILE,
      id,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/** setSecretCommand's home check: makes it if missing, since the first secret for a home can precede any other step. */
async function ensureHomeExists(paths: HarnessPaths, error: unknown): Promise<void> {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') await ensureHome(paths);
  else throw error;
}

/** setSecretCommand's module= and name= check, printed itself: {module, name} once both are given and valid. */
function setSecretArgs(
  ctx: Ctx,
  parsed: ParsedModuleArgs,
): { readonly module: string; readonly name: string } | undefined {
  const module = typeof parsed === 'string' ? undefined : parsed.values.get('module');
  const name = typeof parsed === 'string' ? undefined : parsed.values.get('name');
  if (
    typeof parsed === 'string' ||
    module === undefined ||
    name === undefined ||
    !MODULE_ID_PATTERN.test(module) ||
    !SECRET_NAME_PATTERN.test(name)
  ) {
    ctx.stderr(
      `${typeof parsed === 'string' ? parsed : 'module= and name= are required'}\n\n--set-secret takes module=<module> name=<NAME>, and the value on standard input\n`,
    );
    return undefined;
  }
  return { module, name };
}

/**
 * `asha --set-secret module=<id> name=<NAME>` (R7, R24): the value read from standard input — its first line — never
 * from an argument or the environment; refused at a terminal, where it would be shown as typed. Written to the store
 * by this command, never sent to the daemon; prints only the name and the value's length.
 */
export async function setSecretCommand(ctx: Ctx, argv: readonly string[]): Promise<number> {
  if (argv.some((a) => a.startsWith('value='))) {
    ctx.stderr(
      'a secret is never given as an argument, where a process listing or shell history would show it: pipe it on standard input\n',
    );
    return EXIT.usage;
  }
  const parsed = parseModuleArgs(argv, ['module', 'name'], []);
  const args = setSecretArgs(ctx, parsed);
  if (args === undefined) return EXIT.usage;
  const { module, name } = args;
  if (ctx.input.isTerminal) {
    ctx.stderr(
      `✗ the value is read from standard input, and at a terminal it would be shown as typed: pipe it in, for example: pbpaste | asha --set-secret module=${module} name=${name}\n`,
    );
    return EXIT.failed;
  }
  const paths = harnessPaths(ctx.env);
  const manifest = await readModuleManifest(paths, module);
  if (manifest === undefined) {
    ctx.stderr(`✗ no module ${module} is installed\n`);
    return EXIT.failed;
  }
  if (!manifest.secrets.includes(name)) {
    ctx.stderr(
      `✗ module ${module} declares no secret ${name}; it declares ${manifest.secrets.length === 0 ? 'none' : manifest.secrets.join(', ')}\n`,
    );
    return EXIT.failed;
  }
  const first = await ctx.input.lines[Symbol.asyncIterator]().next();
  const value = first.done === true ? '' : first.value.replace(/\r$/, '');
  if (value === '') {
    ctx.stderr('✗ standard input held no value\n');
    return EXIT.failed;
  }
  await access(paths.home).catch((error: unknown) => ensureHomeExists(paths, error));
  try {
    await secretStore(ctx, paths, ctx.createLogger(paths)).set(module, name, value);
  } catch (error) {
    if (error instanceof LockHeld || error instanceof SecretsInsideGitTree) {
      ctx.stderr(`✗ ${error.message}\n`);
      return EXIT.failed;
    }
    throw error;
  }
  const characters = Array.from(value).length;
  ctx.stdout(`stored ${module}/${name} (${String(characters)} characters)\n`);
  return EXIT.ok;
}

/** A refusal's body: `{error, reason}` as the daemon sends it, or its raw text named as the error when it is not JSON. */
async function refusalBody(response: Response): Promise<{ readonly error?: unknown; readonly reason?: unknown }> {
  const text = await response.text();
  try {
    return JSON.parse(text) as { error?: unknown; reason?: unknown };
  } catch {
    // Not JSON (a proxy's page, a truncated body): its text is the error, shown as it came.
    return { error: text.slice(0, 500) };
  }
}

/** Bound on one short request to the daemon (the approval's read, the opt-in). */
const REQUEST_MS = 10_000;

/** parseCaps' error, typed as its result (see messageArgsProblem in commands.ts on why every return must go through one). */
function capsProblem(message: string): Record<string, number> | string {
  return message;
}

/** parseCaps' success, typed the same way as capsProblem. */
function capsOk(caps: Record<string, number>): Record<string, number> | string {
  return caps;
}

/** enableCommand's caps (conversation, day, month), each a non-negative USD amount; the reason one is bad, if so. */
function parseCaps(parsed: { readonly values: Map<string, string> }): Record<string, number> | string {
  const caps: Record<string, number> = {};
  for (const key of ['conversation', 'day', 'month'] as const) {
    const raw = parsed.values.get(key);
    if (raw === undefined) return capsProblem(`missing ${key}=: every cap is given, none defaulted`);
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(raw)) return capsProblem(`${key}=${raw} is not a number of USD`);
    caps[key] = Number(raw);
  }
  return capsOk(caps);
}

/** enableCommand's opt-in through the daemon, once answered (R18b). */
async function enableThroughDaemon(ctx: Ctx, response: Response, id: string, typed: Caps): Promise<number> {
  if (response.status === 200) {
    ctx.stdout(
      `enabled ${id}: at most ${String(typed.conversation)} USD a conversation, ${String(typed.day)} a day, ${String(typed.month)} a month (UTC)\n`,
    );
    return EXIT.ok;
  }
  const body = await refusalBody(response);
  if (
    response.status === 409 &&
    (body.reason === 'not_installed' || body.reason === 'not_metered' || body.reason === 'over_cap')
  ) {
    ctx.stderr(`✗ ${body.reason}: ${String(body.error)}\n`);
    return EXIT.failed;
  }
  ctx.stderr(`✗ the daemon refused the opt-in: HTTP ${String(response.status)}: ${JSON.stringify(body)}\n`);
  return EXIT.failed;
}

/** enableCommand's opt-in offline (R36): this command is the one writer, holding the daemon's lock. */
async function enableOffline(ctx: Ctx, id: string, typed: Caps): Promise<number> {
  const paths = harnessPaths(ctx.env);
  await ensureHome(paths);
  const logger = ctx.createLogger(paths);
  let release: () => Promise<void>;
  try {
    release = await acquirePidLock({ file: paths.daemonLock, pid: ctx.pid, isAlive: ctx.isAlive, logger });
  } catch (error) {
    if (error instanceof LockHeld) {
      ctx.stderr(
        `✗ ${error.message}: a daemon is starting or another asha command holds this home; try again once it is done\n`,
      );
      return EXIT.failed;
    }
    throw error;
  }
  try {
    const manifest = await readModuleManifest(paths, id);
    const refusal = enableRefusal(manifest, typed);
    if (refusal !== undefined) {
      ctx.stderr(`✗ ${refusal.reason}: ${refusal.detail}\n`);
      return EXIT.failed;
    }
    const meter = new Meter({ file: paths.meteringFile, logger, now: () => new Date(), write: writePrivateFile });
    await meter.load([id]);
    await meter.enable(id, typed);
    ctx.stdout(
      `enabled ${id}: at most ${String(typed.conversation)} USD a conversation, ${String(typed.day)} a day, ${String(typed.month)} a month (UTC)\n`,
    );
    return EXIT.ok;
  } finally {
    await release();
  }
}

/** `asha --enable-module id=<id> conversation=<usd> day=<usd> month=<usd>` (R18b, R36): through the daemon, or holding its lock. */
export async function enableCommand(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const parsed = parseModuleArgs(argv, ['id', 'conversation', 'day', 'month'], []);
  const usage = (why: string): number => {
    ctx.stderr(`${why}\n\n--enable-module takes id=<module> conversation=<usd> day=<usd> month=<usd>, all four\n`);
    return EXIT.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const id = parsed.values.get('id');
  if (id === undefined || !MODULE_ID_PATTERN.test(id)) return usage('id= must name a module');
  const caps = parseCaps(parsed);
  if (typeof caps === 'string') return usage(caps);
  const typed = caps as unknown as Caps;
  const found = await findDaemonAfterStop(ctx, { warnStale: true, stopping: false });
  if (found.kind === 'failed') return EXIT.failed;
  if (found.kind === 'running') {
    const response = await ctx.fetch(`http://127.0.0.1:${String(found.port)}${Routes.modulesEnable}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${found.credential}` },
      body: JSON.stringify({ id, ...typed }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    return enableThroughDaemon(ctx, response, id, typed);
  }
  if (found.kind === 'legacy') {
    ctx.stderr(DAEMON_RUNNING);
    return EXIT.failed;
  }
  return enableOffline(ctx, id, typed);
}

/** The approval statuses the CLI handles (R12 (b)): any other is a failure it names. */
const APPROVAL_STATUSES = [200, 400, 401, 404, 409, 503] as const;

/** approveCommand's connection: the running daemon, the approval's URL and headers, or the exit code to return. */
type ApprovalConnection =
  | {
      readonly ok: true;
      readonly found: FoundDaemon;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly exitCode: number };

/** approveCommand's prologue: the running daemon this approval is on, and the request's URL and headers. */
async function connectForApproval(
  ctx: Ctx,
  id: string,
  refuse: (reason: string) => number,
): Promise<ApprovalConnection> {
  const found = await findDaemonAfterStop(ctx, { warnStale: true, stopping: false });
  if (found.kind === 'failed') return { ok: false, exitCode: EXIT.failed };
  if (found.kind !== 'running') return { ok: false, exitCode: refuse('unknown (no daemon is running for this home)') };
  return {
    ok: true,
    found,
    url: `http://127.0.0.1:${String(found.port)}${Routes.approvals}/${encodeURIComponent(id)}`,
    headers: { authorization: `Bearer ${found.credential}` },
  };
}

/** approveCommand's reading of the daemon's answer to a GET or POST: refused, or undefined once it answered ok. */
async function approvalAnswer(response: Response, refuse: (reason: string) => number): Promise<number | undefined> {
  if (response.status === 200) return undefined;
  if (!(APPROVAL_STATUSES as readonly number[]).includes(response.status))
    return refuse(`the daemon answered HTTP ${String(response.status)}`);
  if (response.status === 503) return refuse('the daemon is stopping');
  const body = await refusalBody(response);
  return refuse(
    typeof body.reason === 'string' ? body.reason : `HTTP ${String(response.status)}: ${String(body.error)}`,
  );
}

/** approveCommand's read: the request shown, and its sha256 computed from what was shown, or the exit code to return. */
type ApprovalRead =
  | { readonly ok: true; readonly request: ApprovalRequest; readonly sha256: string }
  | { readonly ok: false; readonly exitCode: number };

/**
 * approveCommand's GET, once answered: the request read and shown — every invisible or direction-changing
 * character escaped — its sha256 computed here from what was shown and compared with the daemon's (R12 (b), (c)).
 */
async function readApprovalRequest(
  ctx: Ctx,
  read: Response,
  shownId: string,
  refuse: (reason: string) => number,
): Promise<ApprovalRead> {
  const readRefused = await approvalAnswer(read, refuse);
  if (readRefused !== undefined) return { ok: false, exitCode: readRefused };
  const request = (await read.json()) as ApprovalRequest;
  ctx.stderr(
    [
      `approval ${shownId}`,
      `  agent:        ${visible(request.agent)}`,
      `  channel:      ${visible(request.channel)}`,
      `  conversation: ${visible(request.conversation)}`,
      `  call:         ${visible(request.module)}/${visible(request.tool)}`,
      `  arguments:    ${visible(request.arguments)}`,
      '',
    ].join('\n'),
  );
  let sha256: string;
  try {
    // What was shown must be the canonical string itself: a string with a duplicate key, or any other spelling, would
    // show one thing and hash another (review of 2026-10-02, B-34).
    if (canonicalJson(JSON.parse(request.arguments)) !== request.arguments)
      return { ok: false, exitCode: refuse("the request's arguments are not RFC 8785 JSON") };
    sha256 = requestSha256(request);
  } catch (error) {
    // Only the arguments' own failures: not JSON, or a value RFC 8785 cannot hold; anything else is a defect.
    if (error instanceof SyntaxError || error instanceof NotCanonicalizable)
      return { ok: false, exitCode: refuse("the request's arguments are not RFC 8785 JSON") };
    throw error;
  }
  ctx.stderr(`  sha256:       ${sha256}\n`);
  if (sha256 !== request.sha256)
    return { ok: false, exitCode: refuse("the request's sha256 does not match what was shown") };
  return { ok: true, request, sha256 };
}

/** approveCommand's confirmation (R12 (b)): the exact word `yes` typed at a terminal, or `--yes` off one. */
async function confirmApproval(
  ctx: Ctx,
  yes: boolean,
  refuse: (reason: string) => number,
): Promise<number | undefined> {
  if (ctx.input.isTerminal) {
    ctx.stderr('Approve this call? Type yes to approve: ');
    const typed = await ctx.input.lines[Symbol.asyncIterator]().next();
    if (typed.done === true || typed.value !== 'yes') return refuse('not approved');
    return undefined;
  }
  if (!yes) return refuse('not approved: not at a terminal, and --yes was not given');
  return undefined;
}

/**
 * approveCommand's follow of the posted approval's conversation: the outcome printed from the result message's
 * `approved` field alone (R12 (d)), and the agent's reply as a message command prints one.
 */
async function followApprovalStream(
  ctx: Ctx,
  body: ReadableStream<Uint8Array>,
  found: FoundDaemon,
  shownId: string,
  controller: AbortController,
  posted: { value: boolean },
  refuse: (reason: string) => number,
): Promise<number> {
  const tracker = new ConversationTracker(ctx, { sameBuild: found.health.build === ctx.build, deltas: null });
  let outcomeCode: number = EXIT.ok;
  let idle: NodeJS.Timeout | undefined;
  const rearm = () => {
    // Before the outcome, only the outcome or an error ends the wait (R12 (e)); after it, the conversation's own idle bound.
    if (!posted.value) return;
    clearTimeout(idle);
    idle = setTimeout(() => {
      controller.abort();
    }, ctx.timing.streamIdleMs);
  };
  try {
    for await (const raw of sseEvents(body, rearm)) {
      const event = raw as ConversationEvent;
      if (event.type === 'error') {
        ctx.stderr(`✗ ${event.reason}: ${event.detail}\n`);
        return EXIT.failed;
      }
      if (event.type === 'posted') {
        posted.value = true;
        rearm();
        outcomeCode = printApproved(ctx, shownId, event.message.approved);
      }
      const settled = tracker.handle(event);
      if (settled !== undefined) return outcomeCode !== EXIT.ok ? outcomeCode : settled;
    }
    return refuse('the daemon closed the stream before the conversation settled; see its log');
  } finally {
    clearTimeout(idle);
  }
}

/** approveCommand's POST timer: a bound of timeoutMs + 10,000 ms, armed until the approval is posted. */
function approvalPostTimer(
  controller: AbortController,
  timeoutMs: number,
): { readonly bound: number; readonly posted: { value: boolean }; readonly timer: NodeJS.Timeout } {
  const bound = timeoutMs + 10_000;
  const posted = { value: false };
  const timer = setTimeout(() => {
    if (!posted.value) controller.abort();
  }, bound);
  return { bound, posted, timer };
}

/** approveCommand's POST, once answered: the approval's result stream followed, or the daemon's refusal. */
async function followApprovalPost(
  ctx: Ctx,
  response: Response,
  found: FoundDaemon,
  shownId: string,
  controller: AbortController,
  posted: { value: boolean },
  refuse: (reason: string) => number,
): Promise<number> {
  const refused = await approvalAnswer(response, refuse);
  if (refused !== undefined) return refused;
  if (response.body === null || notEventStream(ctx, response, 'approval')) return EXIT.failed;
  return followApprovalStream(ctx, response.body, found, shownId, controller, posted, refuse);
}

/** approveCommand's POST, once it threw: interrupted, no word from the daemon, or the stream cut. */
function approvalPostError(
  ctx: Ctx,
  error: unknown,
  controller: AbortController,
  posted: { value: boolean },
  bound: number,
  refuse: (reason: string) => number,
): number {
  if (controller.signal.aborted && !posted.value)
    return refuse(`no outcome within ${String(bound)} ms; the call may still complete: see the audit`);
  if (controller.signal.aborted)
    return refuse(`no word from the daemon for ${String(ctx.timing.streamIdleMs)} ms; see its log`);
  if (streamCut(error)) return refuse(`the daemon closed the stream (${String(streamCut(error))})`);
  throw error;
}

/**
 * `asha --approve id=<id> [--yes]` (R12 (b)–(e)): the request read and shown — every invisible or direction-changing
 * character escaped — its sha256 computed here from what was shown and compared with the daemon's, the exact word
 * `yes` typed (or `--yes` off a terminal), then approved; the outcome printed from the result message's `approved`
 * field alone, and the agent's reply as a message command prints one. The wait for the outcome is bounded at the
 * tool's timeoutMs + 10,000 ms, which only the outcome or an error ends — never a heartbeat.
 */
export async function approveCommand(ctx: Ctx, argv: readonly string[]): Promise<number> {
  const parsed = parseModuleArgs(argv, ['id'], ['--yes']);
  const id = typeof parsed === 'string' ? undefined : parsed.values.get('id');
  if (typeof parsed === 'string' || id === undefined) {
    ctx.stderr(
      `${typeof parsed === 'string' ? parsed : 'missing id='}\n\n--approve takes id=<approval>, and --yes off a terminal\n`,
    );
    return EXIT.usage;
  }
  const shownId = visible(id);
  const refuse = (reason: string): number => {
    ctx.stderr(`✗ approval ${shownId}: ${reason}\n`);
    return EXIT.failed;
  };
  const connection = await connectForApproval(ctx, id, refuse);
  if (!connection.ok) return connection.exitCode;
  const { found, url, headers } = connection;
  const read = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_MS) });
  const parsedRead = await readApprovalRequest(ctx, read, shownId, refuse);
  if (!parsedRead.ok) return parsedRead.exitCode;
  const { request, sha256 } = parsedRead;
  const confirmed = await confirmApproval(ctx, parsed.flags.has('--yes'), refuse);
  if (confirmed !== undefined) return confirmed;
  const controller = new AbortController();
  const { bound, posted, timer } = approvalPostTimer(controller, request.timeoutMs);
  try {
    const response = await ctx.fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sha256 }),
      signal: controller.signal,
    });
    return await followApprovalPost(ctx, response, found, shownId, controller, posted, refuse);
  } catch (error) {
    return approvalPostError(ctx, error, controller, posted, bound, refuse);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `JSON.stringify`'s declared type claims it always returns `string`; at runtime it returns `undefined` for a
 * value JSON cannot represent (`undefined` itself, a function, a symbol) — the hole this corrects, so
 * printApproved's `?? 'null'` fallback is checked as the real possibility it is, not reported as unreachable.
 */
function stringifyMaybe(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/** The outcome line, from the message's `approved` field alone (R12 (d)); its exit code. */
function printApproved(ctx: Ctx, shownId: string, approved: ApprovedCall | undefined): number {
  if (approved === undefined) {
    ctx.stderr(`✗ approval ${shownId}: the daemon's result message carries no outcome\n`);
    return EXIT.failed;
  }
  const call = `${visible(approved.module)}/${visible(approved.tool)}`;
  const outcome = approved.outcome;
  if (!outcome.ok) {
    ctx.stderr(`✗ approval ${shownId}: asha's call ${call} failed: ${visible(outcome.reason)}\n`);
    return EXIT.failed;
  }
  const result = outcome.result as { exit_code?: unknown } | null;
  const json = visible(stringifyMaybe(outcome.result) ?? 'null');
  if (result !== null && typeof result === 'object' && typeof result.exit_code === 'number' && result.exit_code !== 0) {
    ctx.stderr(`✗ approval ${shownId}: asha's call ${call} ran and exited ${String(result.exit_code)}\n${json}\n`);
    return EXIT.failed;
  }
  ctx.stderr(`✓ approval ${shownId}: asha made the call ${call}: ok\n${json}\n`);
  return EXIT.ok;
}
