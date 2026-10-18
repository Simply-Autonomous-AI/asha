// A command plugin's paths (docs/plans/extension-modules.md R30, R32): what a `roots` entry may name, checked at the
// launch; and where each path argument of a call lies — inside the channel file space or a named root, in a mode that
// root permits, never on the credential deny list, never (to write) a git directory, a shell start-up file or a
// launch agent. Every comparison is after Unicode NFC normalisation and case folding (APFS is case-insensitive).

import { posix, sep } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { deniedBy } from '../../shared/credentials.js';
import { NAME_PATTERN } from '../../shared/protocol.js';
import type { PathArgument } from './arguments.js';

/** A folder a recipe or its team file names in `roots` (R30): the host path resolved (realpath) at the launch. */
export interface AllowedRoot {
  readonly name: string;
  readonly host: string;
  readonly mode: 'read' | 'read-write';
}

export type ResolvedPath =
  | {
      readonly kind: 'channel';
      readonly name: string;
      readonly rel: string;
      readonly container: string;
      readonly mode: 'read' | 'write';
      readonly recursive: boolean;
    }
  | {
      readonly kind: 'root';
      readonly name: string;
      readonly root: AllowedRoot;
      readonly rel: string;
      readonly host: string;
      readonly container: string;
      readonly mode: 'read' | 'write';
      readonly recursive: boolean;
    };

const fold = (text: string): string => text.normalize('NFC').toLowerCase();

/**
 * `s` with every trailing "/" removed — linear, never a regex: `.replace(/\/+$/, '')` has a trailing-anchored
 * quantifier that is re-tried at every start index as `.replace` scans the string, which `sonarjs/super-linear-regex`
 * (scslre's "Move" ambiguity) correctly flags as super-linear on crafted input (many slashes, one trailing non-slash
 * character); confirmed byte-for-byte equivalent to the regex over a fuzz comparison before this change.
 */
const withoutTrailingSlashes = (s: string): string => {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end -= 1;
  return s.slice(0, end);
};

/** Shell start-up files: a write there runs code later as the user (R32). */
const STARTUP_FILES = [
  '.profile',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.bashrc',
  '.login',
  '.zprofile',
  '.zshrc',
  '.zshenv',
  '.zlogin',
  '.zlogout',
];

/** Why a write may not land at `path` (R32): a `.git` component, a shell start-up file, a launch agent or daemon. */
export function writeRefusal(path: string): string | undefined {
  const parts = fold(path)
    .split('/')
    .filter((p) => p !== '');
  if (parts.includes('.git')) return 'a write into a .git directory, which runs code later as the user';
  if (STARTUP_FILES.includes(parts.at(-1) ?? ''))
    return `a write to the shell start-up file ${present(parts.at(-1), 'the start-up file name (just matched in STARTUP_FILES)')}`;
  for (let i = 0; i + 1 < parts.length; i += 1) {
    if (parts[i] === 'library' && (parts[i + 1] === 'launchagents' || parts[i + 1] === 'launchdaemons'))
      return 'a write under Library/LaunchAgents or Library/LaunchDaemons';
  }
  return undefined;
}

/** A path argument as the command is given it and as it is checked: `..` and `.` removed, no trailing slash (B-22). */
export function normalPluginPath(value: string): string {
  return withoutTrailingSlashes(posix.normalize(value)) || '/';
}

/**
 * The `ResolvedPath` `normal` and its `parts` name — `/channel/...` or `/roots/<name>/...` — or why none fits (R30;
 * helper of {@link resolvePluginPath}, split out to keep its cognitive complexity down).
 */
function resolvePathKind(
  arg: PathArgument,
  roots: readonly AllowedRoot[],
  parts: readonly string[],
  normal: string,
): ResolvedPath | { readonly problem: string } {
  if (parts[0] === 'channel')
    return {
      kind: 'channel',
      name: arg.name,
      rel: parts.slice(1).join('/'),
      container: normal,
      mode: arg.mode,
      recursive: arg.recursive,
    };
  if (parts[0] !== 'roots' || parts[1] === undefined)
    return { problem: `${normal} is outside the allowed roots (/channel, /roots/<name>)` };
  const root = roots.find((r) => r.name === parts[1]);
  if (root === undefined)
    return { problem: `${normal} is in no allowed root (its recipe names no root "${parts[1]}")` };
  if (arg.mode === 'write' && root.mode !== 'read-write')
    return { problem: `${normal} is a write into root ${root.name}, which is read-only` };
  const rel = parts.slice(2).join('/');
  return {
    kind: 'root',
    name: arg.name,
    root,
    rel,
    host: rel === '' ? root.host : `${root.host}${sep}${rel.split('/').join(sep)}`,
    container: normal,
    mode: arg.mode,
    recursive: arg.recursive,
  };
}

/**
 * Why a resolved path is refused (R32; helper of {@link resolvePluginPath}): the credential deny list, then — for a
 * write — `writeRefusal`. Both check the path as the command sees it, and a root's host path too: a read-write root
 * at `<repo>/.git` is a `.git` directory whatever the container calls it (review of 2026-10-02, B-23).
 */
function pluginPathRefusal(
  resolved: ResolvedPath,
  normal: string,
  arg: PathArgument,
  ashaHome: string,
): { readonly problem: string } | undefined {
  const denied =
    deniedBy(normal, { ashaHome }) ?? (resolved.kind === 'root' ? deniedBy(resolved.host, { ashaHome }) : undefined);
  if (denied !== undefined) return { problem: `${normal} matches the credential deny list (${denied})` };
  if (arg.mode !== 'write') return undefined;
  const refusal =
    writeRefusal(normal) ?? (resolved.kind === 'root' ? writeRefusal(resolved.host.split(sep).join('/')) : undefined);
  return refusal === undefined ? undefined : { problem: `${normal}: ${refusal}` };
}

/**
 * Where a path argument lies (R30, R32), or why it is refused: normalised as the command will see it (`..` removed),
 * inside `/channel` or `/roots/<name>`, in a mode its root permits, and on no deny-list entry — the path as the
 * command sees it, and a named root's host path too.
 */
export function resolvePluginPath(
  arg: PathArgument,
  roots: readonly AllowedRoot[],
  ashaHome: string,
): ResolvedPath | { readonly problem: string } {
  const normal = normalPluginPath(arg.value);
  const parts = normal.split('/').filter((p) => p !== '');
  const resolved = resolvePathKind(arg, roots, parts, normal);
  if ('problem' in resolved) return resolved;
  return pluginPathRefusal(resolved, normal, arg, ashaHome) ?? resolved;
}

/**
 * Why a `roots` entry is refused at the launch (R30): its name, its mode, and a folder that is `/`, is or contains the
 * user's home folder, is, contains or lies inside ASHA_HOME, is or lies under ~/Library, or has a component on the
 * credential deny list. `path` is resolved (realpath); `home` and `ashaHome` are too.
 */
export function rootRefusal(
  root: { readonly name: string; readonly path: string; readonly mode: string },
  props: { readonly home: string; readonly ashaHome: string },
): string | undefined {
  if (!NAME_PATTERN.test(root.name)) return `its name "${root.name}" does not match ${String(NAME_PATTERN)}`;
  if (root.mode !== 'read' && root.mode !== 'read-write')
    return `its mode is "${root.mode}", not "read" or "read-write"`;
  const path = withoutTrailingSlashes(fold(root.path)) || '/';
  const home = withoutTrailingSlashes(fold(props.home));
  const asha = withoutTrailingSlashes(fold(props.ashaHome));
  const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
  if (path === '/') return 'it is /';
  if (inside(home, path)) return `it is or contains the home folder ${props.home}`;
  if (inside(asha, path) || inside(path, asha)) return `it is, contains or lies inside ASHA_HOME (${props.ashaHome})`;
  if (inside(path, `${home}/library`)) return 'it is or lies under ~/Library';
  const denied = deniedBy(root.path, { ashaHome: props.ashaHome });
  if (denied !== undefined) return `it matches the credential deny list (${denied})`;
  return undefined;
}

/** Whether two resolved roots are the same for R25: either path lies inside the other. */
export function rootsOverlap(a: string, b: string): boolean {
  const x = withoutTrailingSlashes(fold(a));
  const y = withoutTrailingSlashes(fold(b));
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
