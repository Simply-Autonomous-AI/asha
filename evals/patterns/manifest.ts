// The demo manifest (docs/plans/orchestration-patterns.md R11(a)):
// tests/agents/patterns/demos.json lists every built pattern demo exactly
// once, as a closed object {"pattern", "team", "page", "suite"}. The report's
// pattern sections (R10), the page test (A1), the coverage test (A12) and the
// team test (A13) read it; a demo is listed once it is built. Every function
// takes the repo root: this module runs from the source in tests and from
// dist/ in `npm run report`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = 'tests/agents/patterns/demos.json';

export interface Demo {
  /** Its catalogue id, `P1` … `P26`. */
  readonly pattern: string;
  /** Its team folder's name: `teams/<team>/`. */
  readonly team: string;
  /** Its page, `docs/patterns/pNN-<slug>.md`. */
  readonly page: string;
  /** Its agent-suite file, `tests/agents/pNN-<slug>.test.ts`. */
  readonly suite: string;
}

/** The manifest breaks a rule; names the file, the entry and the rule. */
export class ManifestInvalid extends Error {
  constructor(problem: string) {
    super(`${MANIFEST}: ${problem}`);
    this.name = 'ManifestInvalid';
  }
}

/** `P1` → `p01`: the prefix of the pattern's page, suite file and scenario ids. */
export function patternPrefix(pattern: string): string {
  const n = /^P([1-9]\d?)$/.exec(pattern)?.[1];
  if (n === undefined || Number(n) > 26) throw new Error(`"${pattern}" is not a catalogue id P1–P26`);
  return `p${n.padStart(2, '0')}`;
}

/** Parses and checks the manifest's text: each entry closed, each pattern once, paths named after the pattern, each path present in `root`. */
export function parseManifest(text: string, root: string): Demo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestInvalid(`not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new ManifestInvalid('must be a JSON list of demos');
  const seen = new Set<string>();
  return raw.map((entry: unknown, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new ManifestInvalid(`entry ${String(i)} must be an object {"pattern", "team", "page", "suite"}`);
    const o = entry as Record<string, unknown>;
    const keys = ['pattern', 'team', 'page', 'suite'];
    for (const key of Object.keys(o))
      if (!keys.includes(key)) throw new ManifestInvalid(`entry ${String(i)}: unknown field ${key}`);
    for (const key of keys)
      if (typeof o[key] !== 'string' || o[key] === '')
        throw new ManifestInvalid(`entry ${String(i)}: ${key} must be a non-empty string`);
    const demo = o as unknown as Demo;
    let prefix: string;
    try {
      prefix = patternPrefix(demo.pattern);
    } catch (error) {
      throw new ManifestInvalid(`entry ${String(i)}: ${(error as Error).message}`);
    }
    if (seen.has(demo.pattern)) throw new ManifestInvalid(`${demo.pattern} is listed twice`);
    seen.add(demo.pattern);
    const slug = new RegExp(`^docs/patterns/${prefix}-[a-z0-9-]+\\.md$`);
    if (!slug.test(demo.page))
      throw new ManifestInvalid(`${demo.pattern}: page must be docs/patterns/${prefix}-<slug>.md, not ${demo.page}`);
    if (demo.suite !== `tests/agents/${demo.page.slice('docs/patterns/'.length, -'.md'.length)}.test.ts`) {
      throw new ManifestInvalid(
        `${demo.pattern}: suite must be tests/agents/<the page's name>.test.ts, not ${demo.suite}`,
      );
    }
    for (const path of [demo.page, demo.suite, join('teams', demo.team, 'team.json')]) {
      if (!existsSync(join(root, path))) throw new ManifestInvalid(`${demo.pattern}: ${path} does not exist`);
    }
    return demo;
  });
}

/** The committed manifest. */
export function readManifest(root: string): Demo[] {
  return parseManifest(readFileSync(join(root, MANIFEST), 'utf8'), root);
}
