// The public export (docs/plans/oss-release.md R1–R3, R35, R39): one commit of the internal repository becomes one
// commit of the export repository, holding exactly the paths tools/oss/manifest.json ships at that commit, each byte for
// byte with its git mode, a symlink as a symlink. The first release creates the repository (no remote); a later one is
// a commit on top of a clone of the published repository, never a rewrite. Each commit and its annotated tag
// `v<version>` are the publishing identity's, the message names the internal commit and carries a `Co-authored-by:`
// line for each outside contributor the publisher names — each of whom must be in the signers file ASHA_CLA_SIGNERS
// names, kept outside both repositories (R39). It refuses, writing nothing, a dirty internal tree, an `<out>` inside
// it, an unclassified path, and an `<out>` that is neither new nor a clone of the published repository; and it installs
// the pre-push hook that refuses a push until the owner-side gates and the day's consent are recorded (R35).

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { MANIFEST, classify, parseManifest } from './manifest.mjs';

/** Who authors, commits and tags every release (the owner's answer to oss-copyright-holder, 2026-10-03). */
export const PUBLISHER = { name: 'SimplyAutonomous.AI', email: 'admin@SimplyAutonomous.AI' } as const;
/** The line every release's message carries, naming the internal commit it was exported from (R3). */
export const EXPORTED_FROM = 'Exported from internal commit';
/** The release plan, whose Status table the pre-push hook reads (R35). */
const PLAN = join('docs', 'plans', 'oss-release.md');

/** The export refused, writing nothing: its message names the cause. */
export class ExportRefused extends Error {
  override readonly name = 'ExportRefused';
}

export interface ExportProps {
  /** The internal repository. */
  readonly repo: string;
  /** The internal commit to export (any revision git resolves). */
  readonly commit: string;
  /** The export repository: new for the first release, a clone of the published one after. */
  readonly out: string;
  /** Each outside contributor the release includes, `Name <email>` (R3, R39). */
  readonly coAuthors?: readonly string[];
  /** Where ASHA_CLA_SIGNERS is read: the process's environment. */
  readonly env: NodeJS.ProcessEnv;
}

export interface ExportOutcome {
  readonly internal: string;
  readonly commit: string;
  readonly tag: string;
  readonly files: number;
  readonly first: boolean;
}

/** git in `cwd`, its stdout; a failure is a refusal naming the command. */
function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, input?: string): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 28, env, input });
  if (run.error !== undefined || run.status !== 0)
    throw new ExportRefused(`git ${args.join(' ')} failed in ${cwd}: ${(run.stderr || String(run.error)).trim()}`);
  return run.stdout;
}

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(folder + sep);

/** The nearest existing folder at or above `path`, resolved, so a path not yet made is placed by its parents. */
function existingAncestor(path: string): string {
  let p = resolve(path);
  while (!existsSync(p)) p = dirname(p);
  return realpathSync(p);
}

/**
 * The signers of the contributor licence agreement (R39), from the file ASHA_CLA_SIGNERS names — read only when a
 * release names a co-author, failing closed: the variable unset, the file missing or unreadable, its mode granting
 * group or others anything, or the file inside one of `forbidden`.
 */
function readSigners(env: NodeJS.ProcessEnv, forbidden: readonly string[]): Set<string> {
  const file = env['ASHA_CLA_SIGNERS'];
  if (file === undefined || file === '')
    throw new ExportRefused(
      'the release names a co-author, and ASHA_CLA_SIGNERS is not set: it names the signers file',
    );
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    throw new ExportRefused(`the signers file ASHA_CLA_SIGNERS names does not exist: ${file}`);
  }
  const mode = statSync(real).mode;
  if ((mode & 0o077) !== 0)
    throw new ExportRefused(
      `the signers file's mode is ${(mode & 0o777).toString(8)}: it must grant nothing to group or others (chmod 600)`,
    );
  for (const folder of forbidden)
    if (inside(real, existingAncestor(folder)))
      throw new ExportRefused(
        `the signers file lies inside ${existingAncestor(folder)}: keep it outside both repositories`,
      );
  return new Set(
    readFileSync(real, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
}

/** One tracked entry at the commit: its mode, its blob and its path. */
interface Entry {
  readonly mode: string;
  readonly blob: string;
  readonly path: string;
}

/** Every entry `git ls-tree -r` lists at `commit`; a submodule is refused (the export copies blobs only). */
function entriesAt(repo: string, commit: string): Entry[] {
  return git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit])
    .split('\0')
    .filter((l) => l !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, blob] = line.slice(0, tab).split(' ') as [string, string, string];
      if (type !== 'blob') throw new ExportRefused(`${line.slice(tab + 1)} is a ${type}, which the export cannot copy`);
      return { mode, blob, path: line.slice(tab + 1) };
    });
}

/** This checkout's root: the hook runs its tools/oss/pre-push.mts. */
const TOOLS_ROOT = resolve(import.meta.dirname, '..', '..');

/** The pre-push hook (R35): it runs `tools`' tools/oss/pre-push.mts against the internal repository's plan, `plan`. */
function hookScript(tools: string, plan: string): string {
  /** A path quoted for sh: in single quotes, each single quote closed, escaped and reopened. */
  const q = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";
  return `#!/bin/sh
# Installed by npm run oss:export (docs/plans/oss-release.md R35): refuses every push until the plan's Status table
# records the three owner-side gates and today's publish consent naming this version.
exec node --experimental-transform-types --disable-warning=ExperimentalWarning --import ${q(join(tools, 'tools', 'demos', 'register.mjs'))} ${q(join(tools, 'tools', 'oss', 'pre-push.mts'))} ${q(plan)} "$(git rev-parse --show-toplevel)"
`;
}

/** R1's refusals that need nothing written: a dirty tree, an `<out>` inside it, an unclassified path; the shipped entries. */
function shippedEntries(repo: string, internal: string, out: string): Entry[] {
  if (git(repo, ['status', '--porcelain']).trim() !== '')
    throw new ExportRefused('the internal working tree is dirty: commit or remove every change first');
  if (inside(existingAncestor(out), repo))
    throw new ExportRefused(`${out} is inside the internal repository's working tree`);
  const manifest = parseManifest(git(repo, ['show', `${internal}:${MANIFEST}`]));
  const entries = entriesAt(repo, internal);
  const unclassified = entries.filter((e) => classify(manifest, e.path) === undefined).map((e) => e.path);
  if (unclassified.length > 0)
    throw new ExportRefused(`the manifest classifies neither ship nor exclude: ${unclassified.join(', ')}`);
  return entries.filter((e) => classify(manifest, e.path) === 'ship');
}

/** R39: every co-author the release names is in the signers file, read only when one is named. */
function checkSigners(props: ExportProps, repo: string): void {
  const coAuthors = props.coAuthors ?? [];
  if (coAuthors.length === 0) return;
  const signers = readSigners(props.env, [repo, props.out]);
  const unsigned = coAuthors.filter((c) => !signers.has(c));
  if (unsigned.length > 0)
    throw new ExportRefused(`not in the signers file, so not released: ${unsigned.join(', ')} (R39)`);
}

/** A later release's `<out>`: a clone of the published repository, on a clean main without the tag; its tree emptied. */
function readyClone(out: string, tag: string): void {
  if (!existsSync(join(out, '.git')))
    throw new ExportRefused(
      `${out} exists and is not a git repository: name a new folder, or a clone of the published one`,
    );
  const roots = git(out, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n');
  const rootEmail = git(out, ['log', '-1', '--format=%ae', roots[0] ?? 'HEAD']).trim();
  const head = git(out, ['log', '-1', '--format=%B']);
  if (roots.length !== 1 || rootEmail !== PUBLISHER.email || !head.includes(EXPORTED_FROM))
    throw new ExportRefused(`${out} is not a clone of the published repository: its history is no export's`);
  if (
    git(out, ['symbolic-ref', '--short', 'HEAD']).trim() !== 'main' ||
    git(out, ['status', '--porcelain']).trim() !== ''
  )
    throw new ExportRefused(`${out} must be on a clean main`);
  if (git(out, ['tag', '-l', tag]).trim() !== '') throw new ExportRefused(`${out} already holds the tag ${tag}`);
  git(out, ['rm', '-r', '-q', '--ignore-unmatch', '.']);
}

/** Each shipped entry written into `out` from its blob: bytes as committed, its mode, a symlink as a symlink. */
function writeEntries(repo: string, out: string, shipped: readonly Entry[]): void {
  for (const e of shipped) {
    const target = join(out, e.path);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    const bytes = spawnSync('git', ['cat-file', 'blob', e.blob], { cwd: repo, maxBuffer: 1 << 28, timeout: 60_000 });
    if (bytes.status !== 0) throw new ExportRefused(`git cat-file blob ${e.blob} (${e.path}) failed`);
    if (e.mode === '120000') symlinkSync(bytes.stdout.toString('utf8'), target);
    else {
      writeFileSync(target, bytes.stdout);
      chmodSync(target, e.mode === '100755' ? 0o755 : 0o644);
    }
  }
}

/** The release's commit and annotated tag, the publishing identity's (R3). */
function commitRelease(out: string, version: string, internal: string, coAuthors: readonly string[]): void {
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: PUBLISHER.name,
    GIT_AUTHOR_EMAIL: PUBLISHER.email,
    GIT_COMMITTER_NAME: PUBLISHER.name,
    GIT_COMMITTER_EMAIL: PUBLISHER.email,
  };
  git(out, ['add', '-A'], identity);
  const trailers = coAuthors.length === 0 ? [] : ['', ...coAuthors.map((c) => `Co-authored-by: ${c}`)];
  const message = [`asha ${version}`, '', `${EXPORTED_FROM} ${internal}.`, ...trailers, ''].join('\n');
  git(out, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-F', '-'], identity, message);
  git(out, ['-c', 'tag.gpgsign=false', 'tag', '-a', `v${version}`, '-m', `asha ${version}`], identity);
}

/** R1–R3: the export of one internal commit; refuses, writing nothing, on any of R1's conditions. */
export function exportRelease(props: ExportProps): ExportOutcome {
  const repo = realpathSync(props.repo);
  const internal = git(repo, ['rev-parse', '--verify', `${props.commit}^{commit}`]).trim();
  const shipped = shippedEntries(repo, internal, props.out);
  checkSigners(props, repo);
  const version = (JSON.parse(git(repo, ['show', `${internal}:package.json`])) as { version: string }).version;
  const tag = `v${version}`;
  const first = !existsSync(props.out);
  const out = resolve(props.out);
  if (first) {
    mkdirSync(out, { recursive: true });
    git(out, ['init', '-q', '-b', 'main']);
  } else readyClone(out, tag);
  writeEntries(repo, out, shipped);
  commitRelease(out, version, internal, props.coAuthors ?? []);
  const hook = join(out, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, hookScript(TOOLS_ROOT, join(repo, PLAN)));
  chmodSync(hook, 0o755);
  return { internal, commit: git(out, ['rev-parse', 'HEAD']).trim(), tag, files: shipped.length, first };
}
