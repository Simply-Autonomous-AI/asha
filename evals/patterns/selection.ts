// The gate's demo selector (docs/plans/demo-selector.md; orchestration-patterns
// R11(b)–(e)): before the agent suite runs, it works out from git which pattern
// demos the change since the last green gate touches, and writes
// tests/agents/results/selection.json: three repeats for a touched demo, one for
// an untouched one. It fails closed: a path the rules do not place is shared
// (every demo), a base it cannot trust means no base (every demo), and a git
// command that fails stops the step — an empty listing is never read as
// "nothing changed". The entry point is select.ts (`npm run demos:select`).
//
// Everything that leaves the process goes through an injected CommandRunner with
// a 30 s bound; the file writes go through injected FileOps, so the unit tests
// (tests/unit/demo-selector.test.ts) reach every failure path.

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { ContainerRuntimeError, parseDockerSocket } from '../../src/daemon/container-runtime/index.js';
import { loadTeam, parseCatalogueEntry } from '../../src/daemon/definitions/index.js';
import { treeDigest } from '../../src/daemon/model-store/index.js';
import {
  CommandNotFound,
  CommandTimedOut,
  type CommandResult,
  type CommandRunner,
} from '../../src/daemon/process/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { VersionUnreadable, versionLine } from '../routing/record.js';
import { readManifest, type Demo } from './manifest.js';

/**
 * The results paths (orchestration-patterns R11(c)): a change under either touches no demo, and neither makes a run's
 * tree dirty. Imported by the selector and by tests/agents/support.ts's dirty check (and, once built, by the gate
 * record's writer, R11(f)); nothing else spells them.
 */
export const RESULTS_PATHS = ['tests/agents/results/', 'evals/routing/results/'] as const;

/** The selection record, and the green-gate record the selector reads its base from. */
export const SELECTION = 'tests/agents/results/selection.json';
const GATE_RECORD = 'tests/agents/results/gate.json';

/** Every command the selector runs, git's included, is bounded at this (PRINCIPLES §11). */
export const COMMAND_TIMEOUT_MS = 30_000;

/** Why there is no base: the closed set of R11(b). */
type NoBaseReason = 'no-record' | 'unreadable' | 'dirty' | 'environment changed' | 'not-ancestor' | 'unknown-commit';

/** The environment fingerprint of R11(f), as demo-selector R7 defines it. */
export interface Fingerprint {
  readonly node: string;
  readonly llamaServer: string;
  readonly colima: string;
  readonly docker: string;
  readonly npmInstall: string;
  readonly models: Readonly<Record<string, string>>;
}

/** One demo's line of the selection. */
interface DemoSelection {
  readonly pattern: string;
  readonly suite: string;
  readonly repeats: 1 | 3;
  readonly reason: string;
}

/** tests/agents/results/selection.json (demo-selector R8), keys in this order. */
export interface SelectionRecord {
  readonly commit: string;
  readonly mode: 'check' | 'full';
  readonly base: string | null;
  readonly baseReason: string;
  readonly baseDetail: string | null;
  readonly changed: readonly string[] | null;
  readonly demos: readonly DemoSelection[];
}

/** The step cannot produce a selection it can stand behind; names what failed. Nothing is written. */
export class SelectionFailed extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SelectionFailed';
  }
}

/** selection.json is missing, malformed or from another commit: repeats 2 and 3 cannot use it (R11(e)). */
export class SelectionUnusable extends Error {
  constructor(problem: string, options?: ErrorOptions) {
    super(`${SELECTION}: ${problem}`, options);
    this.name = 'SelectionUnusable';
  }
}

/** The file operations the step performs, injected so a failed rename or deletion can be tested. */
export interface FileOps {
  /** Removes a file; a file that does not exist is not an error, any other failure throws. */
  remove(path: string): void;
  write(path: string, text: string): void;
  rename(from: string, to: string): void;
}

export const nodeFileOps: FileOps = {
  remove: (path) => {
    rmSync(path, { force: true });
  },
  write: (path, text) => {
    writeFileSync(path, text, { flag: 'wx' });
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
};

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UNAVAILABLE = 'unavailable: ';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** Runs `git -C <root> <args>` bounded; any exit status not in `allowed` fails the step, naming the command and status. */
/**
 * Machine-local settings that would hide a change from git's listings, overridden on every call (the code review of
 * 2026-09-29, finding 4): `core.fileMode=false` hides a mode change, a filesystem monitor can report stale results,
 * and `diff.ignoreSubmodules` hides a submodule's change.
 */
export const GIT_OVERRIDES = [
  '-c',
  'core.fileMode=true',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.ignoreSubmodules=none',
] as const;

async function git(
  runner: CommandRunner,
  root: string,
  args: readonly string[],
  allowed: readonly number[] = [0],
): Promise<CommandResult> {
  const result = await runner.run('git', ['-C', root, ...GIT_OVERRIDES, ...args], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (!allowed.includes(result.code)) {
    throw new SelectionFailed(
      `git ${args.join(' ')} exited ${String(result.code)}: ${firstLine(result.stderr) || '(no message)'}`,
    );
  }
  return result;
}

const nulList = (text: string): string[] => text.split('\0').filter((p) => p !== '');

/** `HEAD`'s commit. */
async function headCommit(runner: CommandRunner, root: string): Promise<string> {
  const head = (await git(runner, root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (!HEX40.test(head)) throw new SelectionFailed(`git rev-parse --verify HEAD printed "${head}", not a commit`);
  return head;
}

// ---- which demo a path touches (R1, R3) ----

/** Whether `path` is one of the demo's own paths: its team folder, its page, render and diagrams, its suite. */
function isOwnPath(demo: Demo, path: string): boolean {
  const slug = demo.page.slice(0, -'.md'.length);
  return (
    path.startsWith(`teams/${demo.team}/`) ||
    path === demo.page ||
    path === `${slug}.html` ||
    path === `${slug}.svg` ||
    (path.startsWith(`${slug}-`) && path.endsWith('.svg')) ||
    path === demo.suite
  );
}

/**
 * Whether `path` touches no demo: under a results path, under docs/ but not docs/patterns/, or a demo's video or its
 * sidecar under docs/patterns/videos/ (docs/plans/demo-videos.md R11): a recording is the demo's output, not its input.
 */
function touchesNoDemo(path: string): boolean {
  if (RESULTS_PATHS.some((prefix) => path.startsWith(prefix))) return true;
  if (path.startsWith('docs/patterns/videos/')) return true;
  return path.startsWith('docs/') && !path.startsWith('docs/patterns/');
}

/** Each demo's repeat count and reason for these changed files (R3, R4, R8): own before shared. */
function classify(demos: readonly Demo[], changed: readonly string[]): DemoSelection[] {
  const sorted = [...changed].sort(byCodeUnit);
  const shared = sorted.filter((path) => !touchesNoDemo(path) && !demos.some((demo) => isOwnPath(demo, path)));
  return demos.map((demo) => {
    const own = sorted.find((path) => isOwnPath(demo, path));
    if (own !== undefined) return { pattern: demo.pattern, suite: demo.suite, repeats: 3, reason: `own: ${own}` };
    if (shared[0] !== undefined)
      return { pattern: demo.pattern, suite: demo.suite, repeats: 3, reason: `shared: ${shared[0]}` };
    return { pattern: demo.pattern, suite: demo.suite, repeats: 1, reason: 'untouched' };
  });
}

// ---- the changed files (R2) ----

/**
 * The union of the files changed since `base` (committed), against `HEAD` (staged and unstaged), untracked (hidden
 * only by the committed .gitignore files), and every tracked file git flags so a diff cannot see it (skip-worktree,
 * assume-unchanged, unmerged): sorted, each once. Every listing's exit status is checked.
 */
async function changedFiles(runner: CommandRunner, root: string, base: string): Promise<string[]> {
  const committed = nulList((await git(runner, root, ['diff', '--name-only', '--no-renames', '-z', base])).stdout);
  const uncommitted = nulList((await git(runner, root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD'])).stdout);
  const untracked = nulList(
    (await git(runner, root, ['ls-files', '--others', '--exclude-per-directory=.gitignore', '-z'])).stdout,
  );
  // What an ignore file could still hide (the code review of 2026-09-29, findings 1 and 12): every untracked
  // .gitignore anywhere, since one can hide itself and its folder; and every untracked file, ignored or not, where
  // demos' own paths live.
  const unignored = nulList(
    (
      await git(runner, root, [
        'ls-files',
        '--others',
        '-z',
        '--',
        ':(glob)**/.gitignore',
        'teams/',
        'docs/patterns/',
        'tests/agents/',
      ])
    ).stdout,
  );
  const flagged = nulList((await git(runner, root, ['ls-files', '-v', '-z'])).stdout)
    .filter((entry) => !entry.startsWith('H '))
    .map((entry) => entry.slice(2));
  // The step's own output is left out: it touches no demo (a results path), and a second selection of the same tree
  // must write the same bytes (R11(e): the selection depends only on git, the manifest, gate.json and the fingerprint).
  return [...new Set([...committed, ...uncommitted, ...untracked, ...unignored, ...flagged])]
    .filter((path) => path !== SELECTION)
    .sort(byCodeUnit);
}

// ---- no link out of a demo's own paths (R14) ----

function symlinksUnder(root: string, dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) found.push(path);
    else if (entry.isDirectory()) found.push(...symlinksUnder(root, path));
  }
  return found;
}

const TEAM_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const THROUGH_A_LINK = "a change reached through a link is reported under its target's path";

/**
 * Fails the step, naming the path, when a demo's team name is not a plain folder name, when its team folder, page or
 * suite does not resolve to itself (it, or a folder above it, is a link), or when its team folder holds a link.
 */
function refuseLinks(root: string, demos: readonly Demo[]): void {
  const real = realpathSync(root);
  for (const demo of demos) {
    if (!TEAM_NAME.test(demo.team))
      throw new SelectionFailed(`${demo.pattern}: team "${demo.team}" is not a plain folder name`);
    const folder = `teams/${demo.team}`;
    if (!lstatSync(join(root, folder)).isDirectory())
      throw new SelectionFailed(`${demo.pattern}: ${folder} is not a real directory; ${THROUGH_A_LINK}`);
    for (const path of [folder, demo.page, demo.suite]) {
      if (realpathSync(join(root, path)) !== join(real, path))
        throw new SelectionFailed(`${demo.pattern}: ${path} is reached through a symlink; ${THROUGH_A_LINK}`);
    }
    const link = symlinksUnder(root, folder).sort(byCodeUnit)[0];
    if (link !== undefined) throw new SelectionFailed(`${demo.pattern}: ${link} is a symlink; ${THROUGH_A_LINK}`);
  }
}

/** Fails the step when git's work tree is not `root` (an inherited GIT_DIR or GIT_WORK_TREE would point it elsewhere). */
async function refuseOtherTree(runner: CommandRunner, root: string): Promise<void> {
  const top = (await git(runner, root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  if (realpathSync(top) !== realpathSync(root))
    throw new SelectionFailed(`git's work tree is ${top}, not ${root} (is GIT_DIR or GIT_WORK_TREE set?)`);
}

// ---- the base (R2, R6) ----

interface Base {
  readonly base: string | null;
  readonly reason: NoBaseReason | null;
  readonly detail: string | null;
}

const noBase = (reason: NoBaseReason, detail: string): Base => ({ base: null, reason, detail });

/** `gate.json`'s shape, once `readBase` has checked it: a commit, a dirty flag, the recorded environment and results. */
interface ParsedGateRecord {
  readonly commit: string;
  readonly dirty: boolean;
  readonly environment: Record<string, unknown>;
  readonly results: Record<string, string>;
}

/** Parses and shape-checks `gate.json`'s text (the checks before results' and the environment's contents are read). */
function parseGateRecord(
  text: string,
  head: string,
): { ok: true; record: ParsedGateRecord } | { ok: false; base: Base } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, base: noBase('unreadable', `${GATE_RECORD} is not JSON: ${error.message}`) };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, base: noBase('unreadable', `${GATE_RECORD} is not an object`) };
  const record = raw as Record<string, unknown>;
  const commit = record['commit'];
  if (typeof commit !== 'string' || !HEX40.test(commit))
    return { ok: false, base: noBase('unreadable', `${GATE_RECORD}: commit is not 40 lowercase hex characters`) };
  if (commit === head) {
    return {
      ok: false,
      base: noBase('unreadable', `${GATE_RECORD}: commit is HEAD itself, which cannot hold a record of itself`),
    };
  }
  if (typeof record['dirty'] !== 'boolean')
    return { ok: false, base: noBase('unreadable', `${GATE_RECORD}: dirty is not a boolean`) };
  const environment = record['environment'];
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment))
    return { ok: false, base: noBase('unreadable', `${GATE_RECORD}: environment is not an object`) };
  const results = record['results'];
  if (typeof results !== 'object' || results === null || Array.isArray(results) || Object.keys(results).length === 0) {
    return {
      ok: false,
      base: noBase('unreadable', `${GATE_RECORD}: results is not a non-empty object of results files and their sha256`),
    };
  }
  return {
    ok: true,
    record: {
      commit,
      dirty: record['dirty'],
      environment: environment as Record<string, unknown>,
      results: results as Record<string, string>,
    },
  };
}

/** Each result's hash is a sha256 and its path is under the results paths (R2), before any is trusted. */
function validateResultsPaths(results: Record<string, unknown>): Base | null {
  for (const [path, hash] of Object.entries(results)) {
    if (typeof hash !== 'string' || !HEX64.test(hash))
      return noBase('unreadable', `${GATE_RECORD}: results["${path}"] is not a sha256`);
    if (!RESULTS_PATHS.some((prefix) => path.startsWith(prefix)) || path.split('/').includes('..')) {
      return noBase('unreadable', `${GATE_RECORD}: results names ${path}, outside the results paths`);
    }
  }
  return null;
}

/** Every result file `gate.json` named is still at `HEAD`, unchanged since it was recorded (sha256). */
async function verifyResultsAtHead(
  runner: CommandRunner,
  root: string,
  results: Record<string, string>,
): Promise<Base | null> {
  for (const [path, hash] of Object.entries(results)) {
    const blob = await git(runner, root, ['cat-file', 'blob', `HEAD:${path}`], [0, 128]);
    if (blob.code === 128) return noBase('unreadable', `${path}, which ${GATE_RECORD} checked, is not at HEAD`);
    if (sha256(Buffer.from(blob.stdout, 'utf8')) !== hash)
      return noBase('unreadable', `${path} at HEAD is not the file ${GATE_RECORD} checked (sha256 differs)`);
  }
  return null;
}

/** JSON with every object's keys sorted, so two fingerprints compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The keys of the current fingerprint that are unavailable, or differ from the recorded environment. */
function environmentProblems(current: Fingerprint, recorded: Record<string, unknown>): string | null {
  const unavailable = Object.entries(current)
    .filter(([, v]) => typeof v === 'string' && v.startsWith(UNAVAILABLE))
    .map(([k, v]) => `${k} (${String(v).slice(UNAVAILABLE.length)})`);
  const keys = [...new Set([...Object.keys(current), ...Object.keys(recorded)])].sort(byCodeUnit);
  const differ = keys.filter(
    (k) => canonical((current as unknown as Record<string, unknown>)[k]) !== canonical(recorded[k]),
  );
  if (unavailable.length === 0 && differ.length === 0) return null;
  return [
    differ.length > 0 ? `differs: ${differ.join(', ')}` : '',
    unavailable.length > 0 ? `unavailable: ${unavailable.join('; ')}` : '',
  ]
    .filter((s) => s !== '')
    .join('; ');
}

/**
 * The base: the committed gate.json's commit, used only when every check of R6 passes, in order; otherwise the first
 * failing check's reason and a one-line detail. `fingerprint` is called only once checks 1–4 pass.
 */
async function readBase(
  runner: CommandRunner,
  root: string,
  head: string,
  fingerprint: () => Promise<Fingerprint>,
): Promise<Base> {
  const listed = (await git(runner, root, ['ls-tree', '-z', 'HEAD', '--', GATE_RECORD])).stdout;
  if (listed === '') return noBase('no-record', `HEAD holds no ${GATE_RECORD}`);
  const text = (await git(runner, root, ['cat-file', 'blob', `HEAD:${GATE_RECORD}`])).stdout;

  const parsed = parseGateRecord(text, head);
  if (!parsed.ok) return parsed.base;
  const { commit, dirty, environment, results } = parsed.record;

  const pathProblem = validateResultsPaths(results);
  if (pathProblem !== null) return pathProblem;
  if (dirty) return noBase('dirty', `${GATE_RECORD} records a dirty tree at ${commit}`);

  const headProblem = await verifyResultsAtHead(runner, root, results);
  if (headProblem !== null) return headProblem;

  const problems = environmentProblems(await fingerprint(), environment);
  if (problems !== null) return noBase('environment changed', problems);

  const ancestor = await git(runner, root, ['merge-base', '--is-ancestor', commit, 'HEAD'], [0, 1, 128]);
  if (ancestor.code === 1) return noBase('not-ancestor', `${commit} is not an ancestor of HEAD`);
  if (ancestor.code === 128)
    return noBase('unknown-commit', firstLine(ancestor.stderr) || `git does not hold ${commit}`);
  return { base: commit, reason: null, detail: null };
}

// ---- the environment fingerprint (R7) ----

export interface FingerprintProps {
  readonly runner: CommandRunner;
  readonly root: string;
  /** The agent suite's model cache: harnessPaths({ ASHA_MODELS_DIR }).modelsDir. */
  readonly modelsDir: string;
  readonly demos: readonly Demo[];
}

/** A command's result, or why it cannot be read: a missing binary, a timeout and a non-zero exit are expected. */
async function probe(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<CommandResult | string> {
  const line = [command, ...args].join(' ');
  let result: CommandResult;
  try {
    result = await runner.run(
      command,
      args,
      env === undefined ? { timeoutMs: COMMAND_TIMEOUT_MS } : { timeoutMs: COMMAND_TIMEOUT_MS, env },
    );
  } catch (error) {
    if (error instanceof CommandNotFound) return `${UNAVAILABLE}${line}: not found`;
    if (error instanceof CommandTimedOut)
      return `${UNAVAILABLE}${line}: timed out after ${String(COMMAND_TIMEOUT_MS)} ms`;
    throw error;
  }
  if (result.code !== 0)
    return `${UNAVAILABLE}${line}: exit ${String(result.code)}: ${firstLine(result.stderr) || firstLine(result.stdout)}`;
  return result;
}

/** `docker version` against the engine colima serves (the socket `colima status --json` names), as the daemon runs docker. */
async function dockerVersion(runner: CommandRunner, statusJson: string): Promise<string> {
  let socket: string;
  try {
    socket = parseDockerSocket(statusJson);
  } catch (error) {
    if (!(error instanceof ContainerRuntimeError)) throw error;
    return `${UNAVAILABLE}colima status --profile default --json: ${error.message}`;
  }
  const result = await probe(runner, 'docker', ['version'], { DOCKER_HOST: socket });
  return typeof result === 'string' ? result : result.stdout.trim();
}

/** llama-server's version and "built with" lines, from its probe result; `unavailable: …` when neither is readable. */
function resolveLlamaServer(llama: CommandResult | string): string {
  if (typeof llama === 'string') return llama;
  // Lines split on any line break and trimmed, so the version check and the kept lines see the same text.
  const lines = `${llama.stdout}\n${llama.stderr}`.split(/\r\n|\r|\n/).map((line) => line.trim());
  try {
    versionLine(lines.join('\n'));
    // The build's identity only: its version line and its "built with" line. The rest is the server's log, whose
    // lines start with an elapsed time that differs on every run (measured 2026-09-29, demo-selector R7 amended).
    return lines.filter((line) => line.startsWith('version: ') || line.startsWith('built with ')).join('\n');
  } catch (error) {
    if (!(error instanceof VersionUnreadable)) throw error;
    return `${UNAVAILABLE}llama-server --version: no version line`;
  }
}

/** The sha256 of `node_modules/.package-lock.json`, or `unavailable: …` when `npm install` has not run. */
function readNpmInstall(root: string): string {
  try {
    return sha256(readFileSync(join(root, 'node_modules', '.package-lock.json')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return `${UNAVAILABLE}node_modules/.package-lock.json: no such file`;
  }
}

/** Every model id (and embedding model id, when set) the demos' teams' recipes name. */
async function modelIdsForDemos(root: string, demos: readonly Demo[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const demo of demos) {
    const team = await loadTeam(join(root, 'teams'), demo.team);
    for (const member of team.members) {
      ids.add(member.recipe.model);
      if (member.recipe.embeddingModel !== null) ids.add(member.recipe.embeddingModel);
    }
  }
  return ids;
}

/** Each model id's cache directory name, or `absent` when `modelsDir` does not hold it. */
function fingerprintModels(root: string, modelsDir: string, ids: ReadonlySet<string>): Record<string, string> {
  const models: Record<string, string> = {};
  for (const id of [...ids].sort(byCodeUnit)) {
    const file = join(root, 'catalogue', `${id}.json`);
    const entry = parseCatalogueEntry(JSON.parse(readFileSync(file, 'utf8')), file);
    const dir = `sha256-${treeDigest(entry.files)}`;
    models[id] = existsSync(join(modelsDir, dir)) ? dir : 'absent';
  }
  return models;
}

/**
 * What the demos run on, outside git (orchestration-patterns R11(f), demo-selector R7): node, llama-server's version
 * and "built with" lines, colima, the docker engine colima serves, what npm installed, and each cached model the demos'
 * recipes name. A value that cannot be read is `unavailable: <what>: <why>`, which refuses a base.
 */
export async function environmentFingerprint(props: FingerprintProps): Promise<Fingerprint> {
  const { runner } = props;
  const text = (r: CommandResult | string): string => (typeof r === 'string' ? r : r.stdout.trim());

  const node = text(await probe(runner, 'node', ['--version']));
  const llamaServer = resolveLlamaServer(await probe(runner, 'llama-server', ['--version']));
  const colima = text(await probe(runner, 'colima', ['version']));

  const status = await probe(runner, 'colima', ['status', '--profile', 'default', '--json']);
  const docker = typeof status === 'string' ? status : await dockerVersion(runner, status.stdout);

  const npmInstall = readNpmInstall(props.root);

  const ids = await modelIdsForDemos(props.root, props.demos);
  const models = fingerprintModels(props.root, props.modelsDir, ids);

  return { node, llamaServer, colima, docker, npmInstall, models };
}

// ---- the selection (R4, R5, R8) ----

export interface SelectProps {
  readonly root: string;
  readonly mode: 'check' | 'full';
  readonly runner: CommandRunner;
  /** The current environment's fingerprint for these demos; called only when a base record passes checks 1–4. */
  readonly fingerprint: (demos: readonly Demo[]) => Promise<Fingerprint>;
  readonly files: FileOps;
}

/** The selection for the tree at `HEAD`, working-tree changes included. Reads no clock. */
export async function computeSelection(props: SelectProps): Promise<SelectionRecord> {
  const demos = readManifest(props.root);
  await refuseOtherTree(props.runner, props.root);
  const commit = await headCommit(props.runner, props.root);
  refuseLinks(props.root, demos);
  if (props.mode === 'full') {
    return {
      commit,
      mode: 'full',
      base: null,
      baseReason: 'full',
      baseDetail: null,
      changed: null,
      demos: demos.map((d) => ({ pattern: d.pattern, suite: d.suite, repeats: 3, reason: 'full' })),
    };
  }
  const base = await readBase(props.runner, props.root, commit, () => props.fingerprint(demos));
  if (base.base === null) {
    const reason = `no-base: ${present(base.reason, "readBase's reason when base is null")}`;
    return {
      commit,
      mode: 'check',
      base: null,
      baseReason: reason,
      baseDetail: base.detail,
      changed: null,
      demos: demos.map((d) => ({ pattern: d.pattern, suite: d.suite, repeats: 3, reason })),
    };
  }
  const changed = await changedFiles(props.runner, props.root, base.base);
  return {
    commit,
    mode: 'check',
    base: base.base,
    baseReason: 'last green gate',
    baseDetail: null,
    changed,
    demos: classify(demos, changed),
  };
}

/** `<suite's file name without .test.ts>`: the stem of its results files. */
function resultsStem(suite: string): string {
  const name = suite.slice(suite.lastIndexOf('/') + 1);
  if (!name.endsWith('.test.ts')) throw new SelectionFailed(`${suite} is not a .test.ts file`);
  return name.slice(0, -'.test.ts'.length);
}

/**
 * Deletes the `.r2.json` and `.r3.json` of every demo selected once, then writes the record to a name unique to this
 * run and renames it into place (PRINCIPLES §13); a failed write or rename removes the temporary file and throws.
 */
function writeSelection(root: string, record: SelectionRecord, files: FileOps): void {
  const dir = join(root, 'tests', 'agents', 'results');
  for (const demo of record.demos) {
    if (demo.repeats !== 1) continue;
    for (const n of [2, 3]) files.remove(join(dir, `${resultsStem(demo.suite)}.r${String(n)}.json`));
  }
  const temporary = join(dir, `.selection-${String(process.pid)}-${randomBytes(6).toString('hex')}.json`);
  try {
    files.write(temporary, `${JSON.stringify(record, null, 2)}\n`);
    files.rename(temporary, join(root, SELECTION));
  } catch (error) {
    files.remove(temporary);
    throw new SelectionFailed(`writing ${SELECTION} failed: ${(error as Error).message}`, { cause: error });
  }
}

/** Computes the selection and writes it (the `demos:select` step). */
export async function select(props: SelectProps): Promise<SelectionRecord> {
  const record = await computeSelection(props);
  writeSelection(props.root, record, props.files);
  return record;
}

// ---- reading the selection (R9, and the report) ----

/** Parses selection.json's text as R8's record; throws SelectionUnusable naming the problem. */
export function parseSelection(text: string): SelectionRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SelectionUnusable(`not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  const keys = ['commit', 'mode', 'base', 'baseReason', 'baseDetail', 'changed', 'demos'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).join() !== keys.join())
    throw new SelectionUnusable(`must be an object with exactly ${keys.join(', ')}, in that order`);
  const o = raw as Record<string, unknown>;
  const ok =
    typeof o['commit'] === 'string' &&
    HEX40.test(o['commit']) &&
    (o['mode'] === 'check' || o['mode'] === 'full') &&
    (o['base'] === null || (typeof o['base'] === 'string' && HEX40.test(o['base']))) &&
    typeof o['baseReason'] === 'string' &&
    (o['baseDetail'] === null || typeof o['baseDetail'] === 'string') &&
    (o['changed'] === null || (Array.isArray(o['changed']) && o['changed'].every((p) => typeof p === 'string'))) &&
    Array.isArray(o['demos']) &&
    o['demos'].every((d: unknown) => {
      const e = d as Record<string, unknown> | null;
      return (
        typeof e === 'object' &&
        e !== null &&
        Object.keys(e).join() === 'pattern,suite,repeats,reason' &&
        typeof e['pattern'] === 'string' &&
        typeof e['suite'] === 'string' &&
        (e['repeats'] === 1 || e['repeats'] === 3) &&
        typeof e['reason'] === 'string'
      );
    });
  if (!ok) throw new SelectionUnusable('a field does not have the type the selection record gives it');
  return o as unknown as SelectionRecord;
}

/** The suites repeats 2 and 3 run: every demo selected for three, in the file's order; throws naming the file when it cannot be used. */
export interface SuitesForRepeatProps {
  readonly runner: CommandRunner;
  readonly root: string;
  /** 2 or 3: repeat 1 runs every demo. */
  readonly repeat: number;
}

export async function suitesForRepeat(props: SuitesForRepeatProps): Promise<string[]> {
  const { runner, root, repeat } = props;
  if (repeat !== 2 && repeat !== 3)
    throw new SelectionUnusable(
      `repeat ${String(repeat)} does not read the selection: repeat 1 runs every demo, and there are three repeats`,
    );
  let text: string;
  try {
    text = readFileSync(join(root, SELECTION), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new SelectionUnusable('missing: run npm run demos:select before the agent suite', { cause: error });
    throw error;
  }
  const record = parseSelection(text);
  const head = await headCommit(runner, root);
  if (record.commit !== head)
    throw new SelectionUnusable(`computed at ${record.commit}, not at HEAD ${head}: run npm run demos:select again`);
  return record.demos.filter((d) => d.repeats === 3).map((d) => d.suite);
}
