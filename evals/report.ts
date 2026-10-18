// Builds docs/testing/agent-tests.html: every agent test and its output, for a
// person to inspect. It reads only the agent suite's results files
// (tests/agents/results/*.json, written by npm run test:agents), so the page
// shows exactly what those runs recorded, with the commit each ran from. The
// page follows the docs page contract (docs/project/documentation.html): it
// links the shared stylesheet docs/assets/docs.css, carries breadcrumbs back to
// docs/index.html and docs/testing/index.html, and loads nothing from the
// network; its report-specific styles and its expand/collapse script are
// inline. The routing eval (npm run eval:routing) is a separate diagnostic and
// is not in the report; the owner asked for it out (2026-09-26): every agent
// here runs qwen3-8b-q4_k_m. Run: npm run report.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  isSuiteResultsFile,
  patternSection,
  repeatOrder,
  selectionLine,
  withoutMachinePaths,
  type ResultFile,
} from './patterns/report-sections.js';
import { SELECTION, parseSelection } from './patterns/selection.js';
import { readRunBlock } from './patterns/run-block.js';
import { present } from '../src/shared/assert-present.js';
import { byCodeUnit } from '../src/shared/order.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'docs', 'testing', 'agent-tests.html');

interface TranscriptEvent {
  readonly type: string;
  readonly from?: string;
  readonly to?: string | null;
  readonly text?: string;
}
interface SuiteRun {
  readonly args: string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
  readonly events: TranscriptEvent[];
}
interface SuiteScenario {
  readonly scenario: { id: string; title: string; agents: string[]; expectation: string };
  readonly runs: SuiteRun[];
  readonly state: 'pass' | 'fail';
  readonly errors: string[];
}
interface SuiteResults {
  readonly suite: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly scenarios: SuiteScenario[];
}
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const short = (sha: string): string => sha.slice(0, 7);
const quoteArg = (a: string): string => (/[\s"'?!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const RESULTS = join(ROOT, 'tests', 'agents', 'results');

/**
 * One section per pattern page (docs/patterns/pNN-<slug>.md; orchestration-patterns R10): its name from the page's
 * title, its team and scenarios from its run-command block, and every results file of its suite, the page's own name.
 */
function patternSections(): {
  readonly id: string;
  readonly name: string;
  readonly html: string;
  readonly passed: number;
  readonly total: number;
}[] {
  const dir = join(ROOT, 'docs', 'patterns');
  if (!existsSync(dir)) return [];
  const results = readdirSync(RESULTS);
  // The gate's selection (demo-selector R12); a malformed one fails the report, naming it.
  const selection = existsSync(join(ROOT, SELECTION))
    ? parseSelection(readFileSync(join(ROOT, SELECTION), 'utf8'))
    : null;
  return readdirSync(dir)
    .filter((f) => /^p\d{2}-[a-z0-9-]+\.md$/.test(f))
    .sort(byCodeUnit)
    .map((f) => {
      const page = `docs/patterns/${f}`;
      const markdown = readFileSync(join(ROOT, page), 'utf8');
      const name = /^# (.+)$/m.exec(markdown)?.[1];
      if (name === undefined) throw new Error(`${page} has no "# " title`);
      const block = readRunBlock(page, ROOT);
      const suite = f.replace(/\.md$/, '');
      const files = repeatOrder(results, suite).map((file) => ({
        file,
        ...(readJson(join(RESULTS, file)) as Omit<ResultFile, 'file'>),
      }));
      const prefix = f.slice(0, 3);
      // The latest run's scenarios, launch included: what the headline counts.
      const latest = files.at(-1)?.scenarios ?? [];
      return {
        id: `pattern-${prefix}`,
        name,
        passed: latest.filter((x) => x.state === 'pass').length,
        total: latest.length,
        html: patternSection({
          prefix,
          name,
          page: `patterns/${f}`,
          team: block.team,
          scenarios: [...block.scenarios.keys()],
          results: files,
          selection: selectionLine(selection, files.at(-1)?.commit, `tests/agents/${suite}.test.ts`),
        }),
      };
    });
}

/** The suites that are not pattern demos: a demo's results are in its own section. */
function suites(): SuiteResults[] {
  const dir = RESULTS;
  if (!existsSync(dir)) throw new Error(`no agent suite results at ${dir}: run npm run test:agents first`);
  const order = [
    'single-agent',
    'multi-agent',
    'teams',
    'memory-agent',
    'memory-tiers',
    'memory-crowd',
    'traces',
    'agent-tools',
    'egress',
  ];
  const rank = (suite: string): number => (order.includes(suite) ? order.indexOf(suite) : order.length);
  return readdirSync(dir)
    .filter((f) => isSuiteResultsFile(f) && !/^p\d{2}-/.test(f))
    .map((f) => readJson(join(dir, f)) as SuiteResults)
    .sort((a, b) => rank(a.suite) - rank(b.suite) || a.suite.localeCompare(b.suite));
}

function badge(ok: boolean, label = ok ? 'pass' : 'fail'): string {
  return `<span class="badge ${ok ? 'ok' : 'bad'}">${label}</span>`;
}

function provenance(commit: string, dirty: boolean, when: string): string {
  return `commit <code>${short(commit)}</code>${dirty ? ' <span class="warn">(uncommitted changes)</span>' : ''} · ${esc(when.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'))}`;
}

/**
 * Each reply's text, paired with the output line that announced it. The CLI
 * prints every reply's text to stdout right after its "output <agent> →
 * <user>:" line on stderr, so when each reply is one line the n-th stdout line
 * is the n-th output's text. When that doesn't hold (a multi-line reply among
 * several), nothing is paired: the report shows the text in order and says so,
 * rather than guess.
 */
function pairReplies(run: SuiteRun): string[] | null {
  const outputs = run.events.filter((e) => e.type === 'output').length;
  if (outputs === 1 && run.stdout !== '') return [run.stdout.replace(/\n$/, '')];
  const lines = run.stdout === '' ? [] : run.stdout.replace(/\n$/, '').split('\n');
  return outputs > 0 && lines.length === outputs ? lines : null;
}

/** One reply, paired by `pairReplies`, under its sender: a `<div class="reply">`. */
function replyDiv(text: string, sender: string | undefined): string {
  return `<div class="reply"><span class="from">${esc(present(sender, "a paired reply's sender"))}</span><pre>${esc(text)}</pre></div>`;
}

/** The output section of a run block: a launch's result, no reply, each paired reply under its sender, or stdout as it printed, unpaired. */
function printedBlock(
  run: SuiteRun,
  launch: boolean,
  paired: readonly string[] | null,
  senders: readonly string[],
): string {
  if (launch) return `<div class="stdout"><span class="k">new agent</span><pre>${esc(run.stdout)}</pre></div>`;
  if (run.stdout === '') return '<div class="stdout"><span class="k">output</span><pre><em>(no reply)</em></pre></div>';
  if (paired !== null) {
    const replies = paired.map((t, i) => replyDiv(t, senders[i])).join('');
    return `<div class="stdout"><span class="k">output</span><div class="replies">${replies}</div></div>`;
  }
  return `<div class="stdout"><span class="k">output</span><pre>${esc(run.stdout)}</pre><span class="note">All replies in the order they arrived (from ${esc(senders.join(', '))}); they can't be matched line by line to their senders here.</span></div>`;
}

/** One ./asha run: the command, then the channel as the user's terminal showed it, with each reply under its sender. */
function runBlock(run: SuiteRun): string {
  const launch = run.args[0] === '--launch';
  const paired = launch ? null : pairReplies(run);
  let reply = 0;
  const lines = run.events
    .map((e) => {
      switch (e.type) {
        case 'posted':
          return `<div class="ev posted"><span class="k">you</span><span>${esc(present(e.from, "a posted event's from"))} → ${esc(e.to ?? 'everyone')}: ${esc(present(e.text, "a posted event's text"))}</span></div>`;
        case 'status':
          return `<div class="ev status"><span class="k">status</span><span>${esc(present(e.from, "a status event's from"))}: ${esc(present(e.text, "a status event's text"))}</span></div>`;
        case 'internal':
          return `<div class="ev internal"><span class="k">agent msg</span><span>${esc(present(e.from, "an internal event's from"))} → ${esc(e.to ?? 'all agents')}: ${esc(present(e.text, "an internal event's text"))}</span></div>`;
        case 'output': {
          const index = reply++;
          const text = paired === null ? '' : `: <b>${esc(present(paired[index], 'a paired reply'))}</b>`;
          const who = e.from === 'asha' ? 'asha (the harness)' : esc(present(e.from, "an output event's from"));
          return `<div class="ev output"><span class="k">reply</span><span>${who} → ${esc(present(e.to, "an output event's to"))}${text}</span></div>`;
        }
        case 'failure':
          return `<div class="ev failure"><span class="k">error</span><span>${esc(present(e.text, "a failure event's text"))}</span></div>`;
        default:
          return `<div class="ev progress"><span class="k">harness</span><span>${esc(e.text ?? '')}</span></div>`;
      }
    })
    .join('');
  const senders = run.events.flatMap((e) =>
    e.type === 'output' ? [e.from === 'asha' ? 'asha (the harness)' : present(e.from, "an output event's from")] : [],
  );
  const printed = printedBlock(run, launch, paired, senders);
  return `<div class="run">
  <div class="cmd"><code>$ ./asha ${esc(run.args.map(quoteArg).join(' '))}</code><span class="meta">exit ${String(run.code)} · ${(run.ms / 1000).toFixed(1)} s</span></div>
  <div class="events">${lines || '<div class="ev progress"><span class="k">—</span><span>nothing printed</span></div>'}</div>
  ${printed}
</div>`;
}

/** What came back for a step whose message went to the channel: no reply, the unpaired stdout, or each paired reply. */
function stepGot(run: SuiteRun, senders: readonly string[], paired: readonly string[] | null): string {
  if (senders.length === 0) return 'no reply';
  if (paired === null) return `${senders.join(', ')}: ${run.stdout.trim()}`;
  return paired.map((t, i) => `${present(senders[i], "a paired reply's sender")}: ${t}`).join(' · ');
}

/** One step of a scenario as a line: what was sent, then what came back and from whom. */
function stepLine(run: SuiteRun, n: number): string {
  const short = (t: string): string => (t.length > 110 ? `${t.slice(0, 110)}…` : t).replace(/\n/g, ' ⏎ ');
  const arg = (name: string): string | undefined =>
    run.args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  let sent: string;
  let got: string;
  if (run.args[0] === '--launch') {
    sent = `launch ${arg('recipe') ?? ''} on ${arg('channel') ?? 'main'}`;
    got = run.code === 0 ? `new agent ${run.stdout.trim()}` : `failed (exit ${String(run.code)})`;
  } else if (run.args[0]?.startsWith('--')) {
    sent = run.args.join(' ');
    got = run.code === 0 ? run.stdout.trim() || 'done' : `failed (exit ${String(run.code)})`;
  } else {
    const who = arg('user') ?? 'a new user';
    const to = arg('to') ?? 'everyone';
    sent = `${who} → ${to}: ${arg('message') ?? ''}`;
    const senders = run.events.flatMap((e) =>
      e.type === 'output' ? [e.from === 'asha' ? 'asha' : present(e.from, "an output event's from")] : [],
    );
    got = stepGot(run, senders, pairReplies(run));
  }
  return `<li><span class="sn">${String(n)}</span><span class="ss">${esc(short(sent))}</span><span class="sa">→ ${esc(short(got))}</span></li>`;
}

/** The scenario at a glance, visible collapsed: what it expects, then every step with its reply. */
function summarySteps(x: SuiteScenario): string {
  return `<div class="glance"><p class="sexpect"><b>Expected:</b> ${esc(x.scenario.expectation)}</p><ol class="steps">${x.runs.map((r, i) => stepLine(r, i + 1)).join('')}</ol></div>`;
}

function suiteTitle(suite: string): string {
  return (
    (
      {
        'single-agent': 'Single agent',
        'multi-agent': 'Multiple agents',
        teams: 'Teams and recipe documents',
        'memory-agent': 'Memory agent',
        'memory-tiers': 'Memory tiers, case by case',
        'memory-crowd': 'Memory in a crowd of ten agents',
        traces: 'Traces with a real agent',
        'agent-tools': 'Agent tools on two models',
        egress: 'Egress from an agent container',
      } as Record<string, string>
    )[suite] ?? suite
  );
}

/** The page's table of contents (docs/project/documentation.html): one entry per pattern section, then per suite section, with its count. */
function toc(ss: SuiteResults[], patterns: readonly { readonly id: string; readonly name: string }[]): string {
  return `<nav class="toc" aria-label="On this page">
    <h2>On this page</h2>
    <ol>
      ${patterns.map((p) => `<li><a href="#${esc(p.id)}">${esc(p.name)}</a></li>`).join('\n      ')}
      ${ss.map((s) => `<li><a href="#${esc(s.suite)}">${suiteTitle(s.suite)}</a> <span class="count">${String(s.scenarios.filter((x) => x.state === 'pass').length)}/${String(s.scenarios.length)}</span></li>`).join('\n      ')}
    </ol>
  </nav>`;
}

function suiteSection(s: SuiteResults): string {
  const passed = s.scenarios.filter((x) => x.state === 'pass').length;
  const title = suiteTitle(s.suite);
  const cards = s.scenarios
    .map(
      (x) => `<details class="scenario ${x.state}"${x.state === 'fail' ? ' open' : ''}>
  <summary>${badge(x.state === 'pass')}<span class="sid">${esc(x.scenario.id)}</span><span class="stitle">${esc(x.scenario.title)}</span>${summarySteps(x)}</summary>
  <div class="body">
    <p><b>On the channel:</b> ${x.scenario.agents.length > 0 ? esc(x.scenario.agents.join(', ')) : 'no agents yet'}</p>
    ${x.errors.length > 0 ? `<div class="errors"><b>Why it failed</b><pre>${esc(x.errors.join('\n\n'))}</pre></div>` : ''}
    ${x.runs.map(runBlock).join('')}
  </div>
</details>`,
    )
    .join('\n');
  return `<section id="${esc(s.suite)}">
  <h2>${title} <span class="count">${String(passed)}/${String(s.scenarios.length)}</span></h2>
  <p class="prov">${provenance(s.commit, s.dirty, s.startedAt)}</p>
  ${cards}
</section>`;
}

function main(): void {
  const ss = suites();
  const patterns = patternSections();
  const total = ss.reduce((n, s) => n + s.scenarios.length, 0);
  const passed = ss.reduce((n, s) => n + s.scenarios.filter((x) => x.state === 'pass').length, 0);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>asha agent tests</title>
<meta name="description" content="Every asha agent-suite scenario with its full channel transcript, pass or fail, and the commit each run came from. Generated by npm run report.">
<link rel="stylesheet" href="../assets/docs.css">
<style>
  :root { --ground:#f6f7f5; --surface:#fff; --ink:#1b2320; --muted:#56625d; --rule:#dde3df; --accent:#0e6b66;
    --ok:#157347; --ok-soft:#e3f3ea; --bad:#b3261e; --bad-soft:#fbe9e7; --mid:#8a5a00; --mid-soft:#fbf1dc;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); font:15px/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; padding-inline:16px; padding-block:32px 64px; }
  main { max-width:1100px; margin:0 auto; display:grid; gap:40px; }
  h1 { font-size:1.9rem; margin:0; letter-spacing:-.01em; }
  h2 { font-size:1.35rem; margin:0 0 6px; border-top:1px solid var(--rule); padding-top:12px; }
  .count { font-size:.9rem; color:var(--muted); font-weight:500; margin-left:8px; }
  .lede, .prov { color:var(--muted); margin:4px 0 12px; max-width:75ch; }
  ul.prov { padding-left:1.2em; font-size:.9rem; }
  code, pre { font-family:var(--mono); font-size:.86em; }
  .summary { display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; }
  .pill { background:var(--surface); border:1px solid var(--rule); border-radius:999px; padding:6px 12px; font-size:.92rem; }
  .badge { display:inline-block; font:600 .72rem/1 var(--mono); padding:4px 7px; border-radius:5px; text-transform:uppercase; letter-spacing:.04em; }
  .badge.ok { background:var(--ok-soft); color:var(--ok); } .badge.bad { background:var(--bad-soft); color:var(--bad); }
  .warn { color:var(--mid); }
  details.scenario { background:var(--surface); border:1px solid var(--rule); border-radius:10px; margin-bottom:10px; }
  details.scenario.fail { border-color:#e8b4ae; }
  details.scenario > summary { cursor:pointer; padding:12px 14px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; list-style:none; }
  details.scenario > summary::-webkit-details-marker { display:none; }
  details.scenario > summary::before { content:"▸"; color:var(--muted); } details.scenario[open] > summary::before { content:"▾"; }
  .sid { font:600 .85rem var(--mono); color:var(--accent); } .stitle { color:var(--ink); }
  .body { padding:0 14px 14px; display:grid; gap:10px; } .body p { margin:0; }
  .errors { background:var(--bad-soft); border-radius:8px; padding:10px 12px; } .errors pre { white-space:pre-wrap; margin:6px 0 0; color:var(--bad); }
  .run { border:1px solid var(--rule); border-radius:8px; overflow:hidden; }
  .cmd { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; background:#eef2f0; padding:8px 12px; border-bottom:1px solid var(--rule); }
  .cmd code { color:var(--accent); word-break:break-word; } .meta { font:.8rem var(--mono); color:var(--muted); white-space:nowrap; }
  .events { padding:6px 0; font:.84rem/1.5 var(--mono); }
  .ev { display:grid; grid-template-columns:7.5em 1fr; gap:10px; padding:2px 12px; white-space:pre-wrap; word-break:break-word; }
  .ev .k { color:var(--muted); text-align:right; font-size:.75rem; line-height:1.9; }
  .ev.posted { color:var(--ink); } .ev.status .k { color:#5b44b0; } .ev.internal { background:var(--mid-soft); } .ev.internal .k { color:var(--mid); }
  .ev.output { background:var(--ok-soft); } .ev.output .k { color:var(--ok); } .ev.failure { background:var(--bad-soft); color:var(--bad); } .ev.progress { color:var(--muted); }
  .stdout { border-top:1px dashed var(--rule); padding:8px 12px; display:grid; grid-template-columns:7.5em 1fr; gap:10px; }
  .stdout .k { font:.75rem var(--mono); color:var(--ok); text-align:right; line-height:2; } .stdout pre { margin:0; white-space:pre-wrap; font-weight:600; }
  .stdout .note { grid-column:2; font-size:.8rem; color:var(--muted); }
  .replies { display:grid; gap:6px; } .reply { display:grid; grid-template-columns:auto 1fr; gap:10px; align-items:baseline; }
  .reply .from { font:600 .78rem var(--mono); color:var(--ok); white-space:nowrap; }
  .glance { flex-basis:100%; padding:2px 0 0 28px; display:grid; gap:6px; cursor:auto; }
  .sexpect { margin:0; font-size:.88rem; color:var(--muted); }
  .steps { margin:0; padding:0; list-style:none; display:grid; gap:3px; font:.82rem var(--mono); }
  .steps li { display:grid; grid-template-columns:1.6em 1fr; column-gap:6px; }
  .steps .sn { grid-row:span 2; color:var(--muted); text-align:right; }
  .steps .ss { color:var(--ink); overflow-wrap:anywhere; } .steps .sa { color:var(--ok); overflow-wrap:anywhere; }
  .toolbar { display:flex; gap:8px; margin-top:12px; }
  .toolbar button { font:600 .85rem inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--rule); background:var(--surface); color:var(--ink); cursor:pointer; }
  .toolbar button:hover { border-color:var(--accent); }
  a { color:var(--accent); }
  /* docs.css styles every pre/code/li for prose pages; the transcript keeps its own look. */
  .run pre, .errors pre { background:none; border:0; border-radius:0; padding:0; overflow-x:visible; }
  .cmd code { background:none; padding:0; }
  .steps li, .glance p { max-width:none; }
  .proofs, .proof { list-style:none; padding-left:0; } .proof { margin:6px 0 10px 18px; display:grid; gap:4px; }
  .proof-item code { overflow-wrap:anywhere; } .check { color:var(--ok); font-weight:700; } .proof-errors { white-space:pre-wrap; color:var(--bad); }
  table.repeats { border-collapse:collapse; font-size:.88rem; } table.repeats td, table.repeats th { border:1px solid var(--rule); padding:4px 8px; text-align:left; }
</style>
</head>
<body>
<main>
  <header class="page">
    <nav class="crumbs"><a href="../index.html">asha docs</a> / <a href="index.html">Testing</a> / Agent test report</nav>
    <h1>asha agent tests</h1>
    <p class="lede">Every agent test and what it printed: real agents in their containers, through <code>./asha</code>, the daemon and the real models (chat: <code>qwen3-8b-q4_k_m</code>; memory's embeddings: <code>qwen3-embedding-0.6b-q8_0</code>). Generated by <code>npm run report</code> from the committed results files. Failures open automatically.</p>
    <div class="facts"><span>generated by <code>npm run report</code></span><span>source: <code>tests/agents/results/*.json</code></span><span>runs from ${[...new Set(ss.map((s) => short(s.commit) + (s.dirty ? ' (dirty)' : '')))].map((c) => `<code>${esc(c)}</code>`).join(', ')}</span></div>
    <div class="toolbar"><button type="button" id="expand">Expand all</button><button type="button" id="collapse">Collapse all</button></div>
    <div class="summary">
      <span class="pill">Agent suite: <b>${String(passed)}/${String(total)}</b> scenarios pass</span>
      <span class="pill">Pattern demos: <b>${String(patterns.reduce((n, p) => n + p.passed, 0))}/${String(patterns.reduce((n, p) => n + p.total, 0))}</b> scenarios pass, latest run of each (${String(patterns.filter((p) => p.total === 0).length)} of ${String(patterns.length)} not run yet)</span>
    </div>
  </header>
  ${toc(ss, patterns)}
  ${patterns.map((p) => p.html).join('\n')}
  ${ss.map(suiteSection).join('\n')}
</main>
<script>
  for (const [id, open] of [['expand', true], ['collapse', false]]) {
    document.getElementById(id).addEventListener('click', () => {
      for (const d of document.querySelectorAll('details')) d.open = open;
    });
  }
</script>
</body>
</html>
`;
  writeFileSync(OUT, withoutMachinePaths(html));
  process.stdout.write(`wrote ${OUT}: agent suite ${String(passed)}/${String(total)}\n`);
}

main();
