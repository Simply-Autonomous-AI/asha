// Compares two routing results files' first requests, case by case (docs/plans/extension-modules.md R38; A38 (b)):
// with modules unused nothing a model sees changes, so every case's first request — its sha256, recorded by the run
// (record.ts) — must equal the base commit's. Exits 1 naming the first case that differs, or is in one file only.
//
//   npm run build && node dist/evals/routing/compare.js <base results.json> <head results.json>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface CaseResult {
  readonly id: string;
  readonly requestSha256: string;
}
interface ResultsFile {
  readonly commit: string;
  readonly results: readonly CaseResult[];
  readonly heldOut?: { readonly results: readonly CaseResult[] } | null;
}

export type Comparison =
  | { readonly ok: true; readonly cases: number }
  | { readonly ok: false; readonly case: string; readonly base: string; readonly head: string };

/** Every case of `base` and `head`, held-out ones included, in `base`'s order then `head`'s extras. */
export function compareFirstRequests(base: ResultsFile, head: ResultsFile): Comparison {
  const all = (f: ResultsFile) =>
    new Map([...f.results, ...(f.heldOut?.results ?? [])].map((c) => [c.id, c.requestSha256]));
  const b = all(base);
  const h = all(head);
  for (const id of [...b.keys(), ...[...h.keys()].filter((k) => !b.has(k))]) {
    const x = b.get(id) ?? 'absent';
    const y = h.get(id) ?? 'absent';
    if (x !== y) return { ok: false, case: id, base: x, head: y };
  }
  return { ok: true, cases: b.size };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [basePath, headPath] = process.argv.slice(2);
  if (basePath === undefined || headPath === undefined)
    throw new Error('usage: node dist/evals/routing/compare.js <base results.json> <head results.json>');
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as ResultsFile;
  const head = JSON.parse(readFileSync(headPath, 'utf8')) as ResultsFile;
  const result = compareFirstRequests(base, head);
  if (!result.ok) {
    process.stderr.write(
      `✗ case ${result.case}: its first request differs from the base commit's (${base.commit}): sha256 ${result.base} there, ${result.head} here\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `every case's first request equals the base commit's (${base.commit}): ${String(result.cases)} cases\n`,
  );
}
