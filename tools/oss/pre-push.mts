// The export repository's pre-push hook (docs/plans/oss-release.md R35, A26): every push is refused unless the release
// plan's Status table — read from the internal repository, at the path the hook records — holds the three owner-side
// gate rows `gate G1`, `gate G2` and `gate G3`, each with a date, and a row `publish consent` dated the day of the push
// and naming the version being pushed. The hook is a guard against a mistake, not against a person: `--no-verify` skips
// it, which PRINCIPLES §8 forbids.
//
// Run by the hook as: node --experimental-transform-types --import <internal>/tools/demos/register.mjs \
//   <internal>/tools/oss/pre-push.mts <plan file> <export repository>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The rows a push needs, beside the consent: the three owner-side gates (the plan's #gates). */
const GATE_ROWS = ['gate G1', 'gate G2', 'gate G3'] as const;

/** The Status table's rows, each as its trimmed cells: the table under `## Status`, up to the next heading. */
export function statusRows(plan: string): string[][] {
  const start = plan.indexOf('\n## Status');
  if (start === -1) return [];
  const end = plan.indexOf('\n## ', start + 1);
  const section = end === -1 ? plan.slice(start) : plan.slice(start, end);
  return section
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
    .map((l) => (l.endsWith('|') ? l.slice(1, -1) : l.slice(1)).split('|').map((c) => c.trim()));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a push of `version` may go on `today` (YYYY-MM-DD), or the reason it may not. */
export function pushAllowed(
  plan: string,
  version: string,
  today: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const rows = statusRows(plan);
  for (const gate of GATE_ROWS)
    if (!rows.some((r) => r[0] === gate && DATE.test(r[1] ?? '')))
      return { ok: false, reason: `the plan's Status has no dated row "${gate}": the owner-side gate is not recorded` };
  const consents = rows.filter((r) => r[0] === 'publish consent');
  if (consents.length === 0) return { ok: false, reason: 'the plan\'s Status has no "publish consent" row' };
  if (!consents.some((r) => r[1] === today))
    return { ok: false, reason: `no "publish consent" row is dated today, ${today}` };
  const named = new RegExp(`(^|[^\\w.])v?${version.replace(/\./g, '\\.')}([^\\w.]|$)`);
  if (!consents.some((r) => r[1] === today && named.test(r.slice(2).join(' '))))
    return { ok: false, reason: `today's "publish consent" row does not name version ${version}` };
  return { ok: true };
}

/** Today in the machine's own calendar, as the plan's rows are dated. */
export function localDate(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The hook's entry: exits 0 to let the push go, 1 to refuse it, naming why. */
function main(argv: readonly string[]): number {
  const [planFile, exportRepo] = argv;
  if (planFile === undefined || exportRepo === undefined) {
    process.stderr.write('pre-push: refused: the hook was not given the plan and the repository\n');
    return 1;
  }
  let plan: string;
  let version: string;
  try {
    plan = readFileSync(planFile, 'utf8');
    version = (JSON.parse(readFileSync(join(exportRepo, 'package.json'), 'utf8')) as { version: string }).version;
  } catch (error) {
    process.stderr.write(`pre-push: refused: ${(error as Error).message}\n`);
    return 1;
  }
  const verdict = pushAllowed(plan, version, localDate());
  if (verdict.ok) return 0;
  process.stderr.write(`pre-push: refused: ${verdict.reason} (${planFile})\n`);
  return 1;
}

if (process.argv[1]?.endsWith('pre-push.mts') === true) process.exitCode = main(process.argv.slice(2));
