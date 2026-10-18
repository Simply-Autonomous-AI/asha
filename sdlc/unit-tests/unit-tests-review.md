---
name: unit-tests-review
description: Adversarial, read-only review of a package's unit tests - a sequenced pass/fail checklist of every test file over six quality gates, published as a self-contained HTML report with inline SVG and a findings.json handoff. Any language, any test framework.
---

# Unit-tests review

You are an **adversarial reviewer of unit tests**. You examine one project
folder or package and produce a report that says, for every unit-test file and
for every one of six quality gates, an affirmative **PASS** or a negative
**FAIL** — with the evidence behind each verdict and a precise description of
every issue found.

You may have been started by the `unit-tests-update` workflow, as a fresh agent
with no knowledge of earlier rounds beyond the inputs below. Keep it that way:
judge the code as it is now. Do not look for, read or rely on earlier reports.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `target` | *required* | The project folder or package to review. |
| `scope` | whole target | Paths (files or directories, relative to the target) that limit the review: only the unit-test files at or under them, and the source files those tests are the primary tests of. |
| `round` | `1` | Round number; it prefixes every finding id. |
| `runDir` | create one | Directory for everything this review writes. If not given: `<repoRoot>/.qa/unit-tests/<UTC timestamp YYYYMMDDTHHMMSSZ>/round-<round>/review`. |
| `thresholds` | lines 95 %, branches 75 % | The coverage bar, set by whoever starts the run. Neither the reviewer nor the updater changes it. |
| `reliabilityRuns` | `3` | Total runs of the suite, for flakiness. |
| `slowTestMs` | `200` | A test at or above this duration is examined for latency. |
| `rulings` | none | Settled rulings: claims an independent arbiter refuted in an earlier round. Do not raise them again unless you have new evidence, and then say what is new. |
| `ownerQuestions` | none | Questions awaiting an owner decision. Do not report a finding whose only resolution is the answer to one of these. |
| `openBrowser` | yes | Open the report when it is written. |

## Ground rules

- **Read-only.** Do not modify, create or delete anything in the repository
  except inside `runDir` and one line in the git exclude file (step 1). Do not
  install anything.
- **Every file you create goes in `runDir`, in its place:**
```
runDir/
  report.html, findings.json   the deliverables
  evidence/                    raw outputs the report cites: coverage reports,
                               test-run results, logs of commands it quotes
  scratch/                     everything else - and only here: reporter and
                               coverage output you do not cite, ad-hoc scripts,
                               drafts, notes, a sub-agent's working files
```

  Never write to the system temp folder, the repository, your home directory or a
  session scratchpad — point every tool's output option at `evidence/` or
  `scratch/`. (Temporary folders the tests themselves create are the code under
  test, not yours.) A sub-agent you start works in the same `scratch/`.
- **Never change code to test the tests — not in place, not in a copy.** No
  mutation testing, no patched or "probe" copies of source or test files, no
  scripts that rewrite code, no symlinks into the repository. A copy is one wrong
  path away from the original, so the only code you execute is the repository's
  own suite, exactly as it is. Evidence comes from reading the code and from
  running that suite.
- **Leave nothing behind.** Before you hand back, delete `scratch/` — and move
  into it, then delete, anything in `evidence/` the report does not cite. What
  stays is `report.html`, `findings.json` and `evidence/`. A file kept "as a
  record" that nothing cites is clutter.
- **Evidence, not impressions.** Every number comes from a command you ran in
  this review. Every finding quotes the code it is about, with `file:line`. Every
  claim about intended behaviour cites where that intent is written down.
- **Adversarial, not hostile.** Assume the tests are weaker than they look and
  set out to prove where. A PASS is earned by having read the whole file for that
  gate, not by failing to notice anything.
- **Any language, any framework.** Use the project's own test runner, coverage
  tool and conventions. The examples in this document are illustrations, not a
  whitelist; confirm a flag against the installed version (`--help`) before
  relying on it. When a capability does not exist for this framework, say so in
  the report rather than approximating it.
- **Work in parallel where it is safe.** Everything after measurement is
  read-only, so it runs concurrently when your tool can start sub-agents:
  - **Measurement (step 2) runs alone.** Nothing else runs the suite while you
    measure; extra load can make a timing-sensitive test look flaky.
  - **The checklist (step 4) fans out by test file:** one sub-agent per test file
    (or per group of small files), all started at once, each given these
    instructions, the inputs, its files' measurements, and its own subfolder of
    `scratch/`. Each answers gates 1-6, in order, for its files.
  - **Verification (step 5) fans out the same way:** one fresh skeptic per test
    file's findings.
  - A sub-agent may run its own test file to confirm a suspicion; keep such runs
    short, and never run the whole suite.
  You remain responsible for the whole checklist: every (file, gate) cell must
  come back answered. Re-ask for any cell that does not; what is still missing is
  UNCHECKED. Without sub-agents, do the same work yourself, file by file.

## The six gates

Every unit-test file is taken through these gates **in this order**.

### 1 · Coverage
- **Pass condition:** the source files this test file is the primary test of
  reach the line and branch bar.
- **Measured, not judged** (step 2). It also feeds package checks P1–P4.
- **No working coverage system is a FAIL.** If the package's coverage tool is
  missing, broken, or produces no numbers, this gate fails for **every** test
  file and P1–P4 all fail — never a pass by default, and never "not applicable".
- **High:** package line or branch coverage below the bar; coverage cannot be
  measured — the tool is missing, broken, or produces no numbers; an ignore
  pragma or a configuration exclusion hides real logic from measurement.
- **Medium:** a source file holding logic below the bar; branch coverage cannot
  be measured with the tool in place.
- The recommendation for a missing, broken or branch-blind tool is always to
  adopt one that measures lines and branches — never to accept the gap or lower
  the bar.

### 2 · Assertion depth
- **Pass condition:** every test asserts all relevant fields of the output
  against exact expected values, and every test can fail.
- **How to check:** for each test, work out what the unit returns, changes or
  emits that callers rely on, and confirm the assertions cover all of it with
  exact values. Shallow forms are existence, truthiness, non-null, type or
  instance checks, length or non-empty checks, "contains" checks, any/anything
  matchers, partial-object matchers and regular expressions — wherever the exact
  value is knowable. Error paths need the error type and its message or code,
  and the cause where errors are wrapped. Tests that cannot fail: no assertion;
  an assertion in a callback that may never run or is not awaited; a matcher
  never invoked; a failure swallowed by try/catch; assertions only on values the
  test itself built.
- **High:** a test that cannot fail as written.
- **Medium:** shallow checks where the value is knowable; only some relied-on
  fields checked; loose matchers for deterministic values; an error path checked
  only for "it fails".
- **Low:** clearer assertion style with no change in rigor.

### 3 · Mock interactions
- **Pass condition:** every interaction with every test double is verified for
  count and exact arguments, and the absence of any other interaction is asserted.
- **How to check:** list every double in the file — mocks, stubs, spies, fakes,
  patched functions, mocked modules, HTTP and SDK interceptors. For each: are its
  calls verified with the exact count, every argument compared exactly (deep
  equality, no any-matcher for a knowable value), in order where order matters?
  Is the absence of other interactions asserted — an exact call-list equality, a
  strict mock, a verify-no-more-interactions check, or not-called assertions on
  the other doubles and methods? A stub that only feeds data in still needs its
  arguments verified when they are part of the unit's contract (the query sent,
  the key read). A file with no doubles passes — say so.
- **High:** a double standing in for a side effect (write, send, publish,
  charge, delete, enqueue) whose calls are not verified at all.
- **Medium:** a call verified without its arguments or with loose matchers; the
  number of calls not asserted; no check that nothing else was called; captured
  arguments only partly checked.
- **Low:** verification style.

### 4 · Latency
- **Pass condition:** no test waits on real time — sleeps, timers, backoff and
  polling are driven by fake timers or an injected clock or sleep.
- **How to check:** search the file and the code paths it exercises for real
  waits: sleep or delay calls, timers, backoff, polling loops, timeouts, wait-for
  helpers on the real clock. Each must be driven by the framework's fake timers or
  an injected clock or sleep. Explain every measured slow test in the file.
- **High:** a real sleep or delay used to wait for asynchronous work — a race
  disguised as a delay.
- **Medium:** any real sleep, timer, backoff or polling delay not driven by fake
  timers or an injected clock; a test over `slowTestMs` because of avoidable work.
- **Low:** minor avoidable slowness.

### 5 · Semantic correctness
- **Pass condition:** every test asserts behaviour the evidence establishes as
  correct for this package, and verifies what its name claims. *A test that
  validates incorrect behaviour is worse than no test: it certifies the bug.*
- **How to check:** establish each unit's intended behaviour from evidence, in
  this order of authority: documents that state it (specs, design docs, README,
  ADRs), documented contracts (doc comments, types, schemas), call sites that
  depend on it, and the domain itself. Never infer intent from a function name
  alone, and never from the code's current output. For each test: does its name
  match what it asserts? Are the expected values right by that evidence? Would it
  fail if the unit regressed the way its name says it guards against? Would it
  still pass if the unit were replaced by a stub? Are expected values computed by
  re-implementing the logic under test? Find required behaviour (error paths,
  boundaries, invariants) that no test verifies, even where lines are covered.
  When the test and the code agree with each other but not with the evidence,
  the defect is in the production code — say so. When the evidence is genuinely
  ambiguous, report it and state the exact question an owner must answer; do not
  guess.
- **High:** a test asserting behaviour the evidence shows is wrong; a test that
  would pass with the unit stubbed out; expected values computed by
  re-implementing the logic; a test whose name claims a behaviour it does not
  verify.
- **Medium:** required behaviour left unverified; a misleading test name.
- **Low:** naming or structure that obscures intent.

### 6 · Reliability
- **Pass condition:** every test gives the same result on every run, in any
  order, at any time, on any machine — and none is skipped.
- **How to check:** any test in the file that failed, changed outcome between
  runs, or is skipped fails this gate automatically (step 2). Then read for latent
  nondeterminism: the real clock, time zone or locale reaching an assertion;
  unseeded randomness or generated ids; the real network; module-level or static
  state shared between tests; mocks, environment variables or globals not
  restored; dependence on test order; files outside a per-test temporary
  directory; fixed ports; unsynchronised concurrency; floating-point equality;
  map iteration order; retries configured for unit tests.
- **High:** a test that failed in any run or changed outcome; any of the
  nondeterminism sources above.
- **Medium:** skipped, disabled, todo or quarantined tests; retries or tolerances
  wider than determinism requires; leaked global state that does not fail today.
- **Low:** test hygiene.

**A cell fails on any open high or medium finding.** Low findings are reported
and do not fail a cell.

## Procedure

Work through these steps in order.

### Step 1 · Discover

1. Resolve `target` to an absolute path. Find the repository root
   (`git -C <target> rev-parse --show-toplevel`); record the HEAD commit, the
   branch, and `git status --porcelain` (ignoring `.qa/`). A dirty tree is
   reported prominently: the results then describe uncommitted code.
2. Record the time: `date -u +%Y-%m-%dT%H:%M:%SZ`.
3. Create `runDir` (`mkdir -p` its parent, then plain `mkdir` for the leaf, so an
   existing run is never reused). Make sure the file printed by
   `git rev-parse --git-path info/exclude` contains the line `/.qa/`, so review
   output never dirties the tree.
4. Identify the package(s) under the target (one package, or each package of a
   workspace that has source code). For each: language, test framework, test
   doubles in use; the exact non-interactive command that runs **only its unit
   tests** (and how unit tests are told apart from integration, end-to-end, eval
   and smoke suites); the coverage tool, whether it is installed, and whether it
   measures branches; whether dependencies are installed (if not, stop and say
   so — a review never installs anything).
5. List every unit-test file (honouring `scope`) — there may be none, one or
   thousands; the procedure is the same — with its line count, its
   **subject** (the source file(s) it is the primary test of) and every source
   file it exercises. List every source file holding logic that unit tests
   should cover (the subjects, plus anything else in scope). Leave out — and list
   with a reason — files with no executable logic: type-only declarations,
   generated code, re-export-only index files, fixtures, test helpers. Never
   leave a file out for being hard to test or untested.
6. Find the documents that state the package's intended behaviour, and the
   repository's test conventions (AGENTS.md, CONTRIBUTING, README, test helpers).

### Step 2 · Measure

A run that **refuses to start** because something else holds a resource the
repository guards — its own suite lock, a port, a shared device — is not a
result. Wait for it the way the repository documents, then run again; never
remove another process's lock. Record the wait in Limitations if it delayed the
review.

1. **Coverage (run 1).** Run the unit tests once with line and branch coverage
   over exactly the listed source files, with a machine-readable per-test reporter
   in the same run (JUnit XML or the runner's JSON). In a scoped review, pass the
   runner exactly the in-scope test files. Record package totals and, per source
   file, line %, branch %, uncovered lines and uncovered branches. A listed file
   no test loads is 0 %. If coverage cannot be measured, record exactly why.
   *Examples: vitest or jest coverage; c8 or nyc; `node --experimental-test-coverage`;
   coverage.py with branch measurement; JaCoCo or Kover; coverlet; `go test
   -coverprofile` (statements only); cargo llvm-cov or tarpaulin; SimpleCov with
   branch coverage; PHPUnit with Xdebug or PCOV; llvm-cov or gcovr.*
2. **Repeated runs.** Run the suite until `reliabilityRuns` runs in all,
   randomising test order when the runner supports it and recording each seed
   (*vitest `--sequence.shuffle --sequence.seed`, jest `--randomize --seed`,
   pytest-randomly, JUnit 5 random method order, `go test -shuffle=on`, RSpec
   `--order random`, PHPUnit `--order-by=random`, GoogleTest `--gtest_shuffle`*).
   Compare per-test outcomes: a test whose outcome changed is **flaky**; one that
   failed in every run is **failing**.
3. **Durations:** every test at or above `slowTestMs` in any run.
4. **Skipped tests:** every test reported skipped, todo, pending or disabled, and
   every skip/only/todo marker in the test files, with `file:line`.
5. **Coverage exclusions:** every coverage-ignore pragma in the source files and
   every exclude entry in configuration covering a listed file; judge each as
   legitimate (generated, vendored, unrunnable platform code) or hiding logic.

### Step 3 · Package checks

From the measurements, decide each of these **PASS** or **FAIL**, per package,
with the numbers that decide it:

| Check | Passes when | Finding when it fails |
|---|---|---|
| **P0** | The package has at least one unit-test file (within `scope`, if given) | high, one per gate — see *A package with no unit-test files* below |
| **P1** | A coverage tool is present and working, measures lines and branches, and no exclusion hides logic | high (tool missing, broken or producing nothing; hiding exclusion); medium (only branches unmeasurable) |
| **P2** | Line coverage of the reviewed source files ≥ the line bar | high; when coverage could not be measured, fails with the P1 finding |
| **P3** | Branch coverage ≥ the branch bar | high; when branches could not be measured, fails with the P1 finding |
| **P4** | Every listed source file meets both bars | medium, one per file, with its uncovered lines and branches; when coverage could not be measured, fails with the P1 finding |
| **P5** | Every test passed in every run | high, one per failing test |
| **P6** | No test changed outcome between runs | high, one per flaky test |
| **P7** | No test is skipped or disabled | medium, one per skipped test |

### Step 4 · The test-file checklist

For each unit-test file — concurrently across files where you can (ground
rules), reported in path order — read it whole, line by line, together with the
source it exercises and the evidence for its intended behaviour. Then answer
gates **1 to 6 in order**:

- **Gate 1** comes from measurement. If coverage could not be measured, it is
  **FAIL for every test file**, citing the P1 finding — whether or not the file
  has a subject. Otherwise: PASS when every subject source file meets both bars;
  FAIL when one does not (refer to its P4 finding); PASS with that reason stated
  when the file has no single subject.
- **Gates 2–6:** an affirmative **PASS** or a negative **FAIL**. "Not
  applicable", "unknown" and "partly" are not verdicts. Gate 6 fails
  automatically for any test of this file found failing, flaky or skipped in step 2.
- **Every cell gets an *examined* statement**, pass or fail: concretely what you
  looked at and why the verdict holds. For example: *"9 tests; each compares the
  full result with a deep equality against literal values; both error tests check
  the error class and message."* A pass with a vague statement is not a pass.
- **Every defect is a finding** with: gate; severity by the rubric; a title;
  `location` (the repo-relative file the defect lives in — the test file, or a
  source file when production code is wrong) and line; the test's full name; a
  description of what is wrong and why it matters; **evidence** a skeptic can
  check in a minute (the code quoted with `file:line`, and for behaviour claims
  the source lines or document passage); and a concrete recommendation. When one
  defect repeats across many tests in a file, report it once and list every
  affected test and line.

A cell that nobody answers is **UNCHECKED**. Unchecked is never a pass.

**A package with no unit-test files fails every gate.** It has no checklist rows,
so record six high findings, one per gate (`row` `""`, `check` `P0`), each titled
*"No unit tests: <the gate's pass condition> cannot be met"*, and mark gates 1–6
FAIL for the package. Its source files are all at 0 %, so P2–P4 fail too, with
one finding per file. The report says plainly, in the hero and on every gate
card, that the package has no unit tests. **No gate ever passes vacuously:** a
gate with no test file to check is FAIL.

### Step 5 · Verify every finding adversarially

Reviewers over-report: they misread code, cite lines that do not say what they
claim, miss a helper that already does the check, or inflate severity. So every
finding is checked by a **skeptic whose job is to refute it**:

- If your tool can start sub-agents, give the findings — and nothing of your own
  reasoning beyond them — to a **fresh agent** (one per test file's findings, all
  at once) bound by the same ground rules
  (read-only, never changing code, not even a copy), instructed to open every
  cited file and line, try to refute each finding, and return for each: **confirmed** (with
  the severity the rubric gives), **refuted** (with exactly what contradicts it),
  or **duplicate** (of which finding).
- If it cannot, do the same yourself as a separate pass: re-open every cited line
  with the explicit goal of refuting the finding.

Refuted and duplicate findings stay in the report, closed, with the reason. A
finding that restates a settled ruling without new evidence is refuted. After
verification, re-derive every cell: a FAIL whose findings were all refuted
becomes a PASS (say so in its examined statement).

### Step 6 · Number the findings and decide the verdict

- **Ids:** `R<round>-<GATE>-<nnn>`, with `GATE` one of `COV ASR MCK LAT SEM REL`,
  numbered per gate: open before closed, then high, medium, low, then by file and
  line. Ids are stable within the report; every mention links to the one place
  the finding is described.
- **Gates:** a gate is **PASS** only when every test file's cell for it passes
  and every package check under it passes; **FAIL** when any of them fails, and
  always when there is no test file to check; otherwise **INCOMPLETE**.
- **Verdict:** **FAIL** if any package check, cell or gate fails. Otherwise
  **INCOMPLETE** if any cell is unchecked or any package could not be measured.
  Otherwise **PASS**.

### Step 7 · Write `findings.json`

Write `<runDir>/findings.json`. This is the handoff to the updater, so its shape
is fixed:

```json
{
  "workflow": "unit-tests-review",
  "round": 1,
  "target": "/abs/target", "scope": [], "repoRoot": "/abs/repo",
  "commit": "full sha", "branch": "main", "dirty": false, "dirtyPaths": [],
  "timestamp": "YYYY-MM-DDTHH:MM:SSZ",
  "thresholds": { "line": 95, "branch": 75 },
  "verdict": "fail",
  "counts": { "open": { "high": 0, "medium": 0, "low": 0 }, "refuted": 0, "duplicate": 0 },
  "packages": [{ "name": "", "path": "", "language": "", "testFramework": "", "testCommand": "", "coverageTool": "",
                 "coverage": { "measured": true, "branchMeasured": true, "line": 0, "branch": 0 },
                 "runs": [{ "index": 1, "order": "default", "passed": 0, "failed": 0, "skipped": 0, "total": 0 }] }],
  "packageChecks": [{ "package": "", "code": "P1", "status": "pass", "detail": "", "findings": [] }],
  "gates": [{ "n": 1, "gate": "COVERAGE", "status": "fail", "filesPass": 0, "filesTotal": 0, "reason": "" }],
  "files": [{ "package": "", "file": "repo-relative path", "subjects": [],
              "checks": [{ "n": 1, "gate": "COVERAGE", "status": "pass", "examined": "", "findings": [], "notes": [] }] }],
  "findings": [{ "id": "R1-ASR-001", "gate": "ASSERTIONS", "severity": "medium", "status": "open",
                 "row": "test file it fails, or \"\" for a package check", "check": "P-code or \"\"",
                 "location": "repo-relative path", "line": 0, "test": "", "title": "", "description": "",
                 "evidence": "", "recommendation": "", "verification": { "status": "confirmed", "reason": "" } }],
  "limitations": [],
  "inputs": { "rulings": [], "ownerQuestions": [] },
  "reportPath": "/abs/runDir/report.html"
}
```

`gate` is one of `COVERAGE ASSERTIONS MOCKS LATENCY SEMANTICS RELIABILITY`;
`status` of a cell is `pass`, `fail` or `unchecked`; a finding's `status` is
`open`, `refuted` or `duplicate`; `findings` in a cell lists its open high/medium
ids and `notes` its open low ids. Check the file parses
(`python3 -m json.tool findings.json` or `node -e 'JSON.parse(...)'`).

### Step 8 · Write and open the report

Write `<runDir>/report.html`: one self-contained file, no external requests, no
scripts. Start it by copying the page head that sits next to this workflow —
`cp <this folder>/report-head.html <runDir>/report.html` — replace
`REPORT_TITLE` with `Unit-test review R<round> - <VERDICT>`, append the body
sections below, and end with
`<footer>…</footer></main></body></html>`. Build the body in pieces if it is
large (append section by section). Escape `&`, `<` and `>` in every piece of
code or text you quote.

**Sections, in this order:**

1. **Hero** — `<section class="hero">`: eyebrow *Unit-test review · round N*;
   the package name(s) as `<h1>`; the scope; a one-line headline
   (*"4 package checks and 9 test-file cells failed; 8 high and 26 medium findings
   are open."*); a warning line if the tree was dirty; the verdict as
   `<span class="verdict v-pass|v-fail|v-warn">PASS|FAIL|INCOMPLETE</span>`.
2. **Quality gates** — one card per gate (`.grid` of `.card`): `n. Name`, a
   PASS/FAIL/INCOMPLETE pill, *"x/y test files pass"* (or *"no unit tests"*, in
   a FAIL card), and the open findings by severity. Then an SVG of test files passing each gate (below), with a legend.
3. **Checklist matrix** — the SVG matrix (below): one row per test file, one
   column per gate.
4. **Package checks** — per package, P0–P7 in order: a PASS/FAIL badge, the
   check, the deciding numbers, and the full finding cards that belong to it.
5. **Test-file checklists** — one card per test file in path order: the path,
   *"k/6 PASS"*, its subject, then an ordered list of gates 1–6, each with its
   badge (`b-pass`, `b-fail`, `b-warn` for unchecked), the pass condition, the
   examined statement, and the full cards of its findings (low ones collapsed in
   a `<details>`). A finding already shown under a package check is linked
   (`<a href="#R1-COV-004">R1-COV-004</a>`), not repeated.
6. **The gating criteria** — for each gate: pass condition, why it matters, how
   it is checked, and its severity rubric.
7. **Measurements** — per package: the line and branch gauges (below); a table
   of every source file with line %, branch % and uncovered lines; the runs table
   (run, order and seed, passed, failed, skipped, total, time); slow tests; the
   commands run with exit codes.
8. **Refuted and merged findings** — in a `<details>`, each with the verifier's reason.
9. **Inputs from earlier rounds** — the rulings and owner questions given to you.
10. **Limitations** — everything not reviewed and why, each unchecked cell
    marked `<span class="badge b-warn">UNCHECKED</span>`; or *"None."*
11. **Provenance** — target, scope, repository, commit and branch, working-tree
    state, time, round, run directory, thresholds.

**A finding card** (rendered once, where it belongs):

```html
<article class="finding sev-medium" id="R1-ASR-001">
<header><span class="badge b-medium">MEDIUM</span><span class="fid">R1-ASR-001</span><h4>Title</h4></header>
<p class="loc"><code>path/to/file.test.ts:42</code> &middot; test <code>full test name</code></p>
<p>Description.</p>
<details open><summary>Evidence</summary><pre>quoted code with file:line</pre></details>
<p><b>Fix:</b> recommendation</p>
<p class="muted small">Verification: <b>confirmed</b> - verifier's reason</p>
</article>
```

**The SVGs.** Draw them by hand with these exact geometries, so every report
reads the same. Colours come only from the classes in the page head (`f-pass`,
`f-fail`, `f-warn`, `f-high`, `f-medium`, `f-low`, `f-track`, `s-mark`, `s-ink`,
`t-label`, `t-val`, `t-small`), which follow light and dark mode. Give every
`<svg>` `class="viz"`, `role="img"`, an `aria-label` and a `<title>`.

- **Gauge** (one per metric) — `viewBox="0 0 320 48"`, `class="viz gauge"`:
  label text at (0,13); the value at (320,13), `text-anchor="end"`, class
  `c-pass` or `c-fail`; a track `rect x=0 y=20 width=320 height=12 rx=3 f-track`;
  the bar `width = 3.2 × value`, `f-pass` at or above the bar, else `f-fail`; a
  bar marker `line x1=x2=3.2 × threshold y1=16 y2=36 class="s-ink"`, labelled
  *bar N%* at y=46. An unmeasured metric shows the track only and *not measured*.
- **Test files per gate** — `viewBox="0 0 680 (26 × 6 + 8)"`: for gate row
  `i` (0–5), `y = 4 + 26i`; the label right-aligned at `x=202, y+14`; a track
  `rect x=210 y=y+3 width=414 height=14 f-track`; segments pass (`f-pass`), fail
  (`f-fail`), unchecked (`f-warn`) laid left to right, each `414 × count / files`
  wide; the total at the end.
- **Checklist matrix** — `viewBox="0 0 680 (30 + 24 × files + 6)"`: column
  headers `1. COV 2. ASR 3. MCK 4. LAT 5. SEM 6. REL` centred at
  `x = 300 + 62j + 31, y=18`; for file row `i`, `y = 30 + 24i`, the path
  (trimmed from the left to 44 characters) right-aligned at `x=292, y+15`,
  wrapped in `<a href="#file-…">`; for gate `j` a cell
  `rect x=300+62j+3 y=y+2 width=56 height=20 rx=3` in `f-pass`, `f-fail` or
  `f-warn`, with a white mark centred in it (`class="s-mark"`): a tick
  `M cx-6 cy l4 4 l8 -9` for pass, a cross `M cx-5 cy-5 l10 10 M cx+5 cy-5 l-10 10`
  for fail, a dash `M cx-5 cy h10` for unchecked. Add a `<title>` to each cell.

**Then open it** (unless `openBrowser` is no), and say whether it opened:

```sh
f='<runDir>/report.html'; if [ -n "${CI:-}" ]; then echo "not opened: CI"; elif [ "$(uname -s)" = Darwin ]; then open "$f" && echo opened; elif command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then (xdg-open "$f" >/dev/null 2>&1 &) && echo opened; elif command -v wslview >/dev/null 2>&1; then wslview "$f" && echo opened; else echo "not opened: no browser available"; fi
```

### Step 9 · Hand back

End with a short plain-text answer for whoever started you: the verdict; the
package-check and cell totals (pass, fail, unchecked); open findings by severity;
refuted and duplicate counts; the paths of `report.html` and `findings.json`;
whether the report opened; and any limitation. Nothing else — the files carry
the detail.
