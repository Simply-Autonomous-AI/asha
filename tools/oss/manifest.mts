// The public export's manifest, tools/oss/manifest.json (docs/plans/oss-release.md R1, R2): which tracked paths ship
// and which stay in the internal repository. An entry ending in `/` names a folder, any other entry one file; a path's
// class is the list of its longest matching entry, so `docs/` ships while `docs/plans/` does not. A path that no entry
// matches is unclassified: the export refuses it, and the manifest's test names it. The same entry in both lists is
// refused when the manifest is read, since a path it matched would be in both.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Manifest {
  readonly ship: readonly string[];
  readonly exclude: readonly string[];
}

export type PathClass = 'ship' | 'exclude';

/** The manifest's file is not a manifest: its message names what is wrong. */
export class ManifestInvalid extends Error {
  override readonly name = 'ManifestInvalid';
}

/** The manifest's path under a repository's root. */
export const MANIFEST = join('tools', 'oss', 'manifest.json');

/** Why an entry is not a path relative to the root, or undefined when it is one. */
function entryProblem(entry: string): string | undefined {
  if (entry === '' || entry === '/') return 'is empty';
  if (entry.startsWith('/')) return 'starts with /';
  if (entry.split('/').some((part, i, parts) => part === '.' || part === '..' || (part === '' && i < parts.length - 1)))
    return 'has an empty, . or .. segment';
  if (/[*?[\]\\]/.test(entry)) return 'holds a pattern character (entries are paths, not globs)';
  return undefined;
}

/** A manifest from its JSON text, each list checked: strings, no duplicate, no entry in both, each a plain path. */
export function parseManifest(text: string): Manifest {
  const json: unknown = JSON.parse(text);
  if (typeof json !== 'object' || json === null) throw new ManifestInvalid('the manifest is not a JSON object');
  const lists: Record<PathClass, string[]> = { ship: [], exclude: [] };
  for (const key of ['ship', 'exclude'] as const) {
    const value: unknown = (json as Record<string, unknown>)[key];
    if (!Array.isArray(value) || !value.every((e): e is string => typeof e === 'string'))
      throw new ManifestInvalid(`the manifest's "${key}" is not a list of strings`);
    for (const entry of value) {
      const problem = entryProblem(entry);
      if (problem !== undefined) throw new ManifestInvalid(`the manifest's "${key}" entry "${entry}" ${problem}`);
      if (lists[key].includes(entry)) throw new ManifestInvalid(`the manifest's "${key}" lists "${entry}" twice`);
      lists[key].push(entry);
    }
  }
  const both = lists.ship.filter((e) => lists.exclude.includes(e));
  const quoted = both.map((e) => JSON.stringify(e)).join(', ');
  if (both.length > 0) throw new ManifestInvalid(`the manifest lists ${quoted} in both`);
  return lists;
}

/** The manifest of the repository at `root`. */
export function readManifest(root: string): Manifest {
  return parseManifest(readFileSync(join(root, MANIFEST), 'utf8'));
}

const matches = (entry: string, path: string): boolean =>
  entry.endsWith('/') ? path.startsWith(entry) : path === entry;

/** The class of a tracked path: its longest matching entry's list, or undefined when no entry matches it. */
export function classify(manifest: Manifest, path: string): PathClass | undefined {
  let best: { readonly length: number; readonly cls: PathClass } | undefined;
  for (const cls of ['ship', 'exclude'] as const)
    for (const entry of manifest[cls])
      if (matches(entry, path) && (best === undefined || entry.length > best.length))
        best = { length: entry.length, cls };
  return best?.cls;
}

/** The paths of `paths` the manifest ships, in their order. */
export function shipped(manifest: Manifest, paths: readonly string[]): string[] {
  return paths.filter((p) => classify(manifest, p) === 'ship');
}

/** The paths of `paths` that no entry matches, in their order. */
export function unclassified(manifest: Manifest, paths: readonly string[]): string[] {
  return paths.filter((p) => classify(manifest, p) === undefined);
}
