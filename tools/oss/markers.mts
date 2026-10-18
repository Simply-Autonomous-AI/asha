// The marker scan (docs/plans/oss-release.md R9, R10): the values that must never be published — the owner's login,
// home, name and email, the NAS, the AWS account, private paths, where a key lives, the other project's name — read
// only from the file ASHA_OSS_MARKERS names, one `<kind><TAB><value>` a line, which must exist, be readable by its
// owner alone and lie outside the internal repository and the scanned folder. Each value is matched without regard to
// case against every file's bytes in the folder (binaries too), every path, and, when the folder is a repository,
// every commit's author, committer and message and every tag's name, message and tagger. A match is printed by its
// kind and a location that cannot carry the value — `file:line`, or the sha256 of a path, or a commit or tag id and
// the field — never the value itself.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { byCodeUnit } from '../../src/shared/order.js';

/** Every kind a markers file must give at least one value for (R9). */
export const REQUIRED_KINDS = [
  'login',
  'home',
  'nas',
  'aws-account',
  'private-path',
  'email',
  'key-location',
  'name',
  'other-project',
] as const;
type MarkerKind = (typeof REQUIRED_KINDS)[number];

export interface Marker {
  readonly kind: MarkerKind;
  readonly value: string;
}

/** The scan refused to run: its message names the cause, never a value. */
export class MarkerScanRefused extends Error {
  override readonly name = 'MarkerScanRefused';
}

/** One match: its kind and where, in a form that cannot carry the value. */
export interface MarkerMatch {
  readonly kind: MarkerKind;
  readonly where: string;
}

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(folder + sep);

/**
 * The markers of the file `env.ASHA_OSS_MARKERS` names, refused (naming the cause) when the variable is unset, the
 * file is missing or unreadable, its mode grants any access to group or others, it lies inside one of `forbidden` (the
 * internal repository, the scanned folder), or a required kind has no value.
 */
export function readMarkers(env: NodeJS.ProcessEnv, forbidden: readonly string[]): Marker[] {
  const file = env['ASHA_OSS_MARKERS'];
  if (file === undefined || file === '')
    throw new MarkerScanRefused(
      'ASHA_OSS_MARKERS is not set: it names the markers file, kept outside every repository',
    );
  let real: string;
  let mode: number;
  try {
    real = realpathSync(file);
    mode = statSync(real).mode;
  } catch {
    throw new MarkerScanRefused(`the markers file ASHA_OSS_MARKERS names does not exist: ${file}`);
  }
  if ((mode & 0o077) !== 0)
    throw new MarkerScanRefused(
      `the markers file's mode is ${(mode & 0o777).toString(8)}: it must grant nothing to group or others (chmod 600)`,
    );
  for (const folder of forbidden) {
    const realFolder = realpathSync(folder);
    if (inside(real, realFolder))
      throw new MarkerScanRefused(`the markers file lies inside ${realFolder}: keep it outside`);
  }
  let text: string;
  try {
    text = readFileSync(real, 'utf8');
  } catch {
    throw new MarkerScanRefused(`the markers file cannot be read: ${file}`);
  }
  const markers: Marker[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    const tab = line.indexOf('\t');
    const kind = tab === -1 ? '' : line.slice(0, tab);
    const value = tab === -1 ? '' : line.slice(tab + 1);
    if (!(REQUIRED_KINDS as readonly string[]).includes(kind) || value.trim() === '')
      throw new MarkerScanRefused(`the markers file's line ${String(i + 1)} is not <kind><TAB><value> of a known kind`);
    markers.push({ kind: kind as MarkerKind, value });
  });
  const missing = REQUIRED_KINDS.filter((k) => !markers.some((m) => m.kind === k));
  if (missing.length > 0) throw new MarkerScanRefused(`the markers file gives no value of kind ${missing.join(', ')}`);
  return markers;
}

/**
 * The one text a published file may hold that a marker would find (docs/plans/oss-release.md R25a, amended 2026-10-17 by
 * the owner's answer to `release-model-name`, option (b), "Keep the address as the one exception"): the Pico V2 model's
 * Hugging Face address, which names its publisher. It is taken out of a line, exactly as written, before the line is
 * matched, so the name anywhere else — another spelling, another case, the address's earlier form — is still found.
 */
export const ALLOWED_TEXT = ['OculusMindAI/OculusMind-ToolCall-8B-v2'] as const;

/** Each marker whose value `text` holds, any case, ALLOWED_TEXT taken out first. */
const holding = (markers: readonly Marker[], text: string): Marker[] => {
  const lower = ALLOWED_TEXT.reduce((t, allowed) => t.split(allowed).join(' '), text).toLowerCase();
  return markers.filter((m) => lower.includes(m.value.toLowerCase()));
};

/** Every match in one file's bytes, by line (read as Latin-1, so a binary file is read too, byte for byte). */
function contentMatches(markers: readonly Marker[], file: string, bytes: Buffer): MarkerMatch[] {
  const lines = bytes.toString('latin1').split('\n');
  // A value is matched in its UTF-8 bytes, as the file holds it.
  const asBytes = markers.map((m) => ({ ...m, value: Buffer.from(m.value, 'utf8').toString('latin1') }));
  return lines.flatMap((line, i) =>
    holding(asBytes, line).map((m) => ({ kind: m.kind, where: `${file}:${String(i + 1)}` })),
  );
}

/** Every file of `dir`, `.git` aside, as paths relative to it, symlinks as themselves (never followed). */
function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git' || folder !== dir) walk(path);
      } else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort(byCodeUnit);
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Every match in the git fields of the repository `dir`: each commit's people and message, each tag's. */
function gitMatches(markers: readonly Marker[], dir: string): MarkerMatch[] {
  const git = (...args: string[]): string => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 28 });
    if (run.status !== 0)
      throw new MarkerScanRefused(`git ${args[0] ?? ''} failed in the scanned repository: ${run.stderr.trim()}`);
    return run.stdout;
  };
  const found: MarkerMatch[] = [];
  // A repository with no commit yet has no history to read.
  if (spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir }).status !== 0) return found;
  const RS = '\u001e';
  const US = '\u001f';
  for (const record of git('log', '--all', `--format=%H${US}%an${US}%ae${US}%cn${US}%ce${US}%B${RS}`).split(RS)) {
    const [id, ...fields] = record.replace(/^\n/, '').split(US);
    if (id === undefined || id === '') continue;
    ['author name', 'author email', 'committer name', 'committer email', 'message'].forEach((field, i) => {
      for (const m of holding(markers, fields[i] ?? '')) found.push({ kind: m.kind, where: `commit ${id} ${field}` });
    });
  }
  for (const record of git(
    'for-each-ref',
    'refs/tags',
    `--format=%(objectname)${US}%(refname:strip=2)${US}%(contents)${US}%(taggername)${US}%(taggeremail)${RS}`,
  ).split(RS)) {
    const [id, ...fields] = record.replace(/^\n/, '').split(US);
    if (id === undefined || id === '') continue;
    ['name', 'message', 'tagger name', 'tagger email'].forEach((field, i) => {
      for (const m of holding(markers, fields[i] ?? '')) found.push({ kind: m.kind, where: `tag ${id} ${field}` });
    });
  }
  return found;
}

/** R9's scan of `dir`: its files' bytes, its paths, and when it is a repository, its commits and tags. */
export function scanMarkers(markers: readonly Marker[], dir: string): MarkerMatch[] {
  const root = resolve(dir);
  const found: MarkerMatch[] = [];
  for (const file of filesOf(root)) {
    for (const m of holding(markers, file)) found.push({ kind: m.kind, where: `path sha256 ${sha(file)}` });
    const path = join(root, file);
    // A symlink's bytes are its target's name, as git keeps it.
    const bytes = lstatSync(path).isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    found.push(...contentMatches(markers, file, bytes));
  }
  const isRepo = existsSync(join(root, '.git'));
  if (isRepo) found.push(...gitMatches(markers, root));
  return found;
}

/** A match as printed: its kind and where, never its value. */
export const matchLine = (m: MarkerMatch): string => `${m.kind}: ${m.where}`;
