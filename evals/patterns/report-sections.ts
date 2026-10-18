// The agent test report's pattern sections (docs/plans/orchestration-patterns.md
// R10): one section per pattern page, docs/patterns/pNN-<slug>.md, with the
// anchor #pattern-pNN — the pattern's name, links to its page and its team
// folder, each scenario's proof as a checklist of claim and evidence, every
// repeat of its agent-suite file that ran with its ms, commit and dirty flag,
// and its line of the gate's selection. A demo whose file has not run shows
// that, never an empty checklist. Pure: npm run report (evals/report.ts) reads
// the files and writes the page; tests/unit/pattern-report.test.ts renders
// fixtures.

import type { SelectionRecord } from './selection.js';

/** One scenario of a results file, as the agent suite records it (tests/agents/support.ts). */
interface ResultScenario {
  readonly scenario: { readonly id: string; readonly title: string };
  readonly runs: readonly { readonly args: readonly string[]; readonly ms: number }[];
  readonly state: 'pass' | 'fail';
  readonly errors: readonly string[];
  readonly proof?: readonly { readonly claim: string; readonly evidence: string }[];
}

/** One results file: tests/agents/results/<suite>.json, or a repeat's <suite>.rN.json. */
export interface ResultFile {
  /** The file's name, e.g. `p01-delegation.json`. */
  readonly file: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly scenarios: readonly ResultScenario[];
}

export interface PatternSectionProps {
  /** The catalogue id's prefix, `p01`: the section's anchor is `pattern-p01`. */
  readonly prefix: string;
  /** The pattern's name: its page's title (`# …`). */
  readonly name: string;
  /** The page's path relative to docs/, `patterns/p01-delegation.md`. */
  readonly page: string;
  /** Its team folder's name. */
  readonly team: string;
  /** The scenario ids its page's run-command block names, in order. */
  readonly scenarios: readonly string[];
  /** Every results file of its suite that ran, in repeat order. */
  readonly results: readonly ResultFile[];
  /** Its line of the gate's selection: its repeat count and why, or `3 repeats: no selection` while no selection exists (R11(h)). */
  readonly selection: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The ms of a scenario's message: its last run (a launch is its own scenario). */
const messageMs = (s: ResultScenario): number | undefined => s.runs.at(-1)?.ms;

/** One repeats-table cell for a scenario: its ms (with a fail flag) when it ran, else the placeholder dash. */
function repeatCell(s: ResultScenario | undefined, ms: number | undefined): string {
  if (s === undefined) return '—';
  const flag = s.state === 'pass' ? '' : '<span class="warn">fail</span> ';
  const value = ms === undefined ? '—' : ms.toLocaleString('en-US');
  return `${flag}${value}`;
}

/** A pattern's section of the report, as HTML. */
export function patternSection(props: PatternSectionProps): string {
  const id = `pattern-${props.prefix}`;
  const html = props.page.replace(/\.md$/, '.html');
  const latest = props.results.at(-1);
  const checklist = props.scenarios
    .map((scenarioId) => {
      const s = latest?.scenarios.find((x) => x.scenario.id === scenarioId);
      if (s === undefined)
        return `<li class="proof-scenario"><span class="sid">${esc(scenarioId)}</span> <em>not run yet</em></li>`;
      const proof = s.proof ?? [];
      const items =
        proof.length === 0
          ? '<li class="proof-missing"><em>no proof recorded</em></li>'
          : proof
              .map(
                (p) =>
                  `<li class="proof-item"><span class="check">✓</span> <b>${esc(p.claim)}</b><br><code>${esc(p.evidence)}</code></li>`,
              )
              .join('');
      const errors = s.errors.length === 0 ? '' : `<pre class="proof-errors">${esc(s.errors.join('\n\n'))}</pre>`;
      return `<li class="proof-scenario"><span class="badge ${s.state === 'pass' ? 'ok' : 'bad'}">${s.state}</span> <span class="sid">${esc(scenarioId)}</span> ${esc(s.scenario.title)}<ul class="proof">${items}</ul>${errors}</li>`;
    })
    .join('\n');
  const scenarioHeaders = props.scenarios.map((s) => `<th>${esc(s)} ms</th>`).join('');
  const repeats =
    props.results.length === 0
      ? '<p class="prov"><em>Its agent-suite file has not run yet: no results file.</em></p>'
      : `<table class="repeats"><thead><tr><th>Run</th><th>Commit</th><th>Tree</th>${scenarioHeaders}</tr></thead><tbody>${props.results
          .map(
            (r) =>
              `<tr><td><code>${esc(r.file)}</code></td><td><code>${esc(r.commit.slice(0, 7))}</code></td><td>${r.dirty ? '<span class="warn">dirty</span>' : 'clean'}</td>${props.scenarios
                .map((sid) => {
                  const s = r.scenarios.find((x) => x.scenario.id === sid);
                  const ms = s === undefined ? undefined : messageMs(s);
                  return `<td>${repeatCell(s, ms)}</td>`;
                })
                .join('')}</tr>`,
          )
          .join('')}</tbody></table>`;
  return `<section id="${id}" class="pattern">
  <h2>${esc(props.name)}</h2>
  <p class="prov">Page: <a href="../${esc(html)}">${esc(html)}</a> · Team: <a href="../../teams/${esc(props.team)}/team.json">teams/${esc(props.team)}/</a> · Gate: ${esc(props.selection)}</p>
  <ul class="proofs">${checklist}</ul>
  ${repeats}
</section>`;
}

/** Whether a file in tests/agents/results/ is a suite's results: not the selection, not the gate record, not a temporary file. */
export function isSuiteResultsFile(name: string): boolean {
  return name.endsWith('.json') && !name.startsWith('.') && name !== 'selection.json' && name !== 'gate.json';
}

/**
 * A demo's gate line (demo-selector R12): from selection.json only when it was computed at the commit its latest
 * results file ran at — "selected", because until the gate's repeats exist each file runs once whatever the
 * selection says (the section's table lists the runs that happened); otherwise `3 repeats: no selection`.
 */
export function selectionLine(
  selection: SelectionRecord | null,
  resultsCommit: string | undefined,
  suite: string,
): string {
  if (selection === null || resultsCommit === undefined || selection.commit !== resultsCommit)
    return '3 repeats: no selection';
  const demo = selection.demos.find((d) => d.suite === suite);
  if (demo === undefined) return 'not in the selection';
  return `selected ${String(demo.repeats)} repeat${demo.repeats === 1 ? '' : 's'}: ${demo.reason}`;
}

/**
 * The page with each macOS temporary folder written `$TMPDIR/` (oss-release R11): a run's progress lines print the
 * daemon's log path under the run's temporary home (`… log: /var/folders/<a>/<b>/T/asha-…/logs/server.log`), and that
 * folder is the machine's own, so the committed report would name the Mac it ran on.
 */
export function withoutMachinePaths(html: string): string {
  return html.replace(/(?:\/private)?\/var\/folders\/[^/\s<>"'&]+\/[^/\s<>"'&]+\/T\//g, () => '$TMPDIR/');
}

/** Orders a suite's results files: `<suite>.json` first (a single run), then `.r1`, `.r2`, `.r3`. */
export function repeatOrder(files: readonly string[], suite: string): string[] {
  const rank = (f: string): number => (f === `${suite}.json` ? 0 : Number(/\.r(\d)\.json$/.exec(f)?.[1] ?? Number.NaN));
  return files
    .filter(
      (f) =>
        f === `${suite}.json` ||
        new RegExp(`^${suite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.r[1-3]\\.json$`).test(f),
    )
    .sort((a, b) => rank(a) - rank(b));
}
