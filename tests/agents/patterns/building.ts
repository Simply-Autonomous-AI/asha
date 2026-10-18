// The stop point on `main` (docs/plans/patterns-phase-3.md R5, A20): a pattern demo's suite file is listed in
// tests/agents/patterns/building.json from the commit that adds it until the commit that adds its manifest entry,
// which removes it. The agent-suite config excludes every listed file unless the environment variable
// ASHA_RECORDED_RUN names that file — which only a recorded run of it sets — so the gate runs no demo that has not
// passed its recorded runs. A file stays listed only while its demo is being built: the plan cannot be done while
// the list holds any (A20).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILDING = 'tests/agents/patterns/building.json';
/** Set by a recorded run to the suite file it runs (R5): that file alone is let through. */
export const RECORDED_RUN_ENV = 'ASHA_RECORDED_RUN';

const SUITE = /^tests\/agents\/p\d{2}-[a-z0-9-]+\.test\.ts$/;

/** The listed suite files, checked: a JSON list of distinct `tests/agents/pNN-<slug>.test.ts` paths, each present in `root`. */
export function readBuilding(root: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, BUILDING), 'utf8'));
  } catch (error) {
    throw new Error(`${BUILDING}: not a readable JSON file: ${(error as Error).message}`, { cause: error });
  }
  if (!Array.isArray(raw)) throw new Error(`${BUILDING}: must be a JSON list of suite files`);
  raw.forEach((file: unknown, i) => {
    if (typeof file !== 'string' || !SUITE.test(file))
      throw new Error(
        `${BUILDING}: entry ${String(i)} must be a pattern suite file, tests/agents/pNN-<slug>.test.ts, not ${JSON.stringify(file)}`,
      );
    if (raw.indexOf(file) !== i) throw new Error(`${BUILDING}: ${file} is listed twice`);
    if (!existsSync(join(root, file))) throw new Error(`${BUILDING}: ${file} does not exist`);
  });
  return raw as string[];
}

/** The listed files the agent suite leaves out: every one but the file a recorded run names in ASHA_RECORDED_RUN. */
export function buildingExcluded(
  building: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const recorded = env[RECORDED_RUN_ENV];
  return building.filter((file) => file !== recorded);
}
