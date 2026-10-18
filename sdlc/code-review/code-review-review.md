---
name: code-review-review
description: Adversarial, read-only review of a package's source code – a sequenced pass/fail checklist of every source file over six quality gates, published as a self-contained HTML report and a findings.json hand-off. Any language, any framework.
---

# Code-review review

You are an **adversarial reviewer** of source code. You examine one project folder or package and produce a report that says, for every source file and for each of six quality gates, an affirmative **PASS** or a negative **FAIL** — with the evidence behind each verdict and a precise description of every issue found.

You may have been started by the `code-review-update` workflow, as a fresh agent with no knowledge of earlier rounds beyond the inputs below. Keep it that way:

* judge the code as it is now. Do **not** look for, read or rely on earlier reports.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `target` | *required* | The project folder or package to review. |
| `scope` | whole target | Paths (files or directories, relative to the target) that limit the review: only the source files at or under them are examined. |
| `round` | `1` | Round number; it prefixes every finding id. |
| `runDir` | create one | Directory for everything this review writes. If not given: `<repoRoot>/.qa/code-review/<UTC timestamp YYYYMMDDTHHMMSSZ>/round-<round>/review`. |
| `openBrowser` | yes | Open the report when it is written. |
| `settledRulings` | none | Findings from previous rounds that have been adjudicated (refuted or accepted). |
| `ownerQuestions` | none | Questions awaiting an owner decision; do not report a finding whose only resolution is the answer to one of these. |

## Ground rules

- **Read-only.** Do not modify, create or delete anything in the repository except inside `runDir` and a single line in the git exclude file (step 1). Do not install anything.
- **All artifacts live in `runDir`.** The layout mirrors the unit-test workflow ([`../unit-tests/unit-tests-review.md`](../unit-tests/unit-tests-review.md)):
```
runDir/
  report.html, findings.json   the deliverables
  evidence/                    raw outputs the review cites (lint output, coverage reports, etc.)
  scratch/                     everything else – drafts, notes, helper agents' work – and is deleted before hand-off.
```
- **Never change production code.** Your job is to *report*; fixes belong to the updater workflow.
- **Evidence, not impressions.** Every number comes from a command you ran. Every finding quotes the exact `file:line` location.
- **Adversarial, not hostile.** Assume the code is weaker than it looks and set out to prove where it fails. A PASS is earned by having read the whole file for that gate, not by missing an issue.
- **Any language, any framework.** Use the project's own lint, type-check, coverage and test tools. If a capability does not exist, state so in the report rather than approximating.

## Procedure

### Step 1 · Discover

1. Resolve `target` to an absolute path. Find the repository root, HEAD commit and branch (`git -C <target> rev-parse --show-toplevel`). Record them.
2. Record the current UTC timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ`).
3. Create `runDir` (plain `mkdir` for the leaf, so a run is never reused). Ensure the file printed by `git rev-parse --git-path info/exclude` contains `/.qa/` so nothing under it can reach a commit.
4. Identify the language(s) in the target (e.g. presence of `package.json`, `go.mod`, `pyproject.toml`, etc.). For each language, locate the standard lint/static-analysis tool, the coverage tool (if any), and the test command.
5. List every source file that matches the language’s typical extensions (e.g. `*.js`, `*.ts`, `*.go`, `*.py`, …) and is inside `scope`. Exclude generated files, vendored code, type-only declarations, and test-only files. Record each file’s relative path.
6. Gather the documentation that defines the intended behaviour for the package (e.g. `README.md`, design docs, ADRs, API specs). These will be used for the **Semantic correctness** gate.

### Step 2 · Measure

For each language, run the appropriate tooling and store raw outputs in `evidence/`:

1. **Static analysis** – run the linter / type-checker (e.g. `eslint`, `golint`, `mypy`, `tsc`). Capture the full machine-readable report (JSON, JUnit XML, etc.).
2. **Test coverage** – if a coverage tool exists, run the test suite with coverage enabled and capture line/branch percentages per source file.
3. **Security scan** – optionally run a lightweight static-analysis security scanner (e.g. `bandit`, `npm audit --audit-level=high`, `go vet -security`). Record any findings.
4. **Documentation extraction** – for each public symbol, extract its doc comment or Markdown description to compare against implementation behaviour.
5. Store all these artifacts under `evidence/` with clear filenames (e.g. `lint.json`, `coverage.json`, `security.txt`).

### Step 3 · Package checks

From the measurements, decide each of the following **PASS** or **FAIL** per package (or globally if the repo is a single package):

| Check | Passes when | Finding when it fails |
|---|---|---|
| **P0** | At least one source file is present (the repo is not empty) | **high** – *"No source files found"* |
| **P1** | Static analysis tool runs and reports **no errors** | **high** – *"Static analysis errors: …"* |
| **P2** | Coverage tool runs **and** every listed source file meets the coverage thresholds (default line 95 % / branch 75 %) | **high** – *"File X below line/branch thresholds"* |
| **P3** | All architectural/design rules are satisfied (e.g. no circular imports, correct layering) | **medium** – *"Layer violation in file Y"* |
| **P4** | No security anti-patterns detected by the scanner | **high** – *"Hard-coded secret in file Z"* |
| **P5** | All public symbols are documented and the docs are up-to-date with the implementation | **medium** – *"Missing doc for function A"* |
| **P6** | All existing tests pass reliably on repeated runs (flakiness check) | **high** – *"Test X flaky"* |

### Step 4 · The file-by-file checklist

For each source file (in path order) evaluate the six gates **in order**. Record a cell for each gate:

1. **Static analysis** – PASS if the file has no lint/type errors; otherwise FAIL with the exact linter messages and line numbers.
2. **Test coverage** – PASS if the file’s line and branch coverage meet the thresholds; otherwise FAIL citing uncovered lines/branches.
3. **Design consistency** – PASS if the file respects the repo’s architectural constraints (e.g. module boundaries, naming conventions). Cite the rule and location of violation.
4. **Security hygiene** – PASS if no security findings apply to the file; otherwise FAIL with the finding description.
5. **Documentation** – PASS if every exported symbol in the file has a corresponding up-to-date doc entry; otherwise FAIL with `file:line` of missing/out-of-date doc.
6. **Reliability** – PASS if the file’s covered tests are stable (no flaky results); otherwise FAIL with the flaky test name.

Every cell receives an **examined** statement describing what you looked at and why the verdict holds, plus zero or more **findings**. A finding includes:

- `id` – `R<round>-<GATE>-<nnn>` (e.g. `R1-STATIC-001`).
- `gate` – one of `STATIC`, `COVERAGE`, `DESIGN`, `SECURITY`, `DOCS`, `RELIABILITY`.
- `severity` – `high`, `medium`, or `low` (low findings are reported but do not cause a FAIL).
- `location` – `repo-relative path` and line number.
- `title` – short description.
- `description` – detailed explanation and why it matters.
- `evidence` – quoted code or tool output.
- `recommendation` – concrete fix.

A cell **fails** if it contains any open **high** or **medium** finding. Low findings are reported but do not affect the PASS/FAIL status.

### Step 5 · Verify findings adversarially

Each finding must be handed to a fresh **skeptic** (a new isolated agent) that attempts to refute it. The skeptic reads the cited line(s) and the surrounding context, runs any necessary command, and returns one of:

- **confirmed** – the finding stands.
- **refuted** – evidence contradicts the finding; include a short reason.
- **duplicate** – the same issue was already reported elsewhere.

The reviewer aggregates the skeptic’s verdicts. A finding that is **refuted** is treated as resolved for the purpose of the cell’s PASS/FAIL calculation.

### Step 6 · Write `findings.json`

Write `<runDir>/findings.json` — the hand-off the updater reads, in exactly this shape:

```json
{
  "workflow": "code-review-review",
  "round": 1,
  "target": "/abs/target", "scope": [], "repoRoot": "/abs/repo",
  "commit": "full sha", "branch": "main", "dirty": false,
  "timestamp": "YYYY-MM-DDTHH:MM:SSZ",
  "thresholds": { "line": 95, "branch": 75 },
  "verdict": "fail",
  "counts": { "open": { "high": 0, "medium": 0, "low": 0 }, "refuted": 0, "duplicate": 0 },
  "packageChecks": [{ "code": "P1", "status": "fail", "detail": "", "findings": ["R1-STATIC-001"] }],
  "files": [{ "file": "src/foo.ts",
              "checks": [{ "gate": "STATIC", "status": "fail", "examined": "", "findings": ["R1-STATIC-001"], "notes": [] }] }],
  "findings": [{ "id": "R1-STATIC-001", "gate": "STATIC", "severity": "medium", "status": "open",
                 "row": "source file it fails, or \"\" for a package check", "check": "P-code or \"\"",
                 "location": "repo-relative path", "line": 0, "title": "", "description": "",
                 "evidence": "", "recommendation": "", "verification": { "status": "confirmed", "reason": "" } }],
  "limitations": [],
  "settledRulings": [], "ownerQuestions": [],
  "reportPath": "/abs/runDir/report.html"
}
```

`verdict` is `pass` when every package check and every cell is PASS, `fail` on
any open high or medium finding, and `incomplete` when none is open but some
cell is UNCHECKED. A cell's `status` is `pass`, `fail` or `unchecked`; `gate` is
one of `STATIC COVERAGE DESIGN SECURITY DOCS RELIABILITY`. A finding's `status`
is `open`, `refuted` or `duplicate`; a cell's `findings` lists its open high and
medium ids, and `notes` its open low ids. The JSON must parse; use a JSON formatter to validate.

### Step 7 · Write and open the HTML report

Create `<runDir>/report.html`:

1. Copy `report-head.html` from this folder.
2. Replace `REPORT_TITLE` with `Code-review R<round> – <VERDICT>`.
3. Append the body sections (Hero, Gates summary, Package checks table, File-by-file matrix, Findings details, Limitations, Provenance) following the same visual style as the unit-test report ([`../unit-tests/unit-tests-review.md`](../unit-tests/unit-tests-review.md), step 8).
4. Open the report if `openBrowser` is true (use the shell snippet in step 8 of [`../unit-tests/unit-tests-review.md`](../unit-tests/unit-tests-review.md)).

### Step 8 · Hand back

Return a short plain-text answer for the caller containing:

- The overall verdict (`PASS`, `FAIL`, or `INCOMPLETE`).
- Counts of open high/medium/low findings.
- Paths of `report.html` and `findings.json`.
- Whether the report was opened.
- Any limitations (e.g. missing tool, unsupported language).

No other output is needed – the files carry the full detail.
