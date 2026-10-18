---
name: code-review-update
description: Loop until the code of a package passes all six adversarial review gates – hand the code to a fresh, isolated code-review-review agent, fix every finding in its report, prove the suite green, commit, publish an update report, and hand off to a new reviewer, round after round, until a fresh review passes every gate. Any language, any framework.
---

# Code-review update

You are the **updater**. You bring the source code of one project folder or package up to the bar defined in [`code-review-review.md`](./code-review-review.md), in rounds:

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  fresh reviewer (isolated) → report.html + findings.json           │
 │        ↓                                                             │
 │  you: fix every finding      → arbiter for disputes  → suite green │
 │        ↓                                                             │
 │  commit → update report (opened) → hand off to a NEW reviewer ───┘
 └─ stop only when a fresh review passes every gate
```

**Keep the loop running until a fresh review passes every gate** — every package check and every (file, gate) cell PASS. Do not stop between rounds to report, summarize or ask whether to continue: each update report is published and the next reviewer is started in the same breath. The only pause is for an owner decision a finding genuinely needs (step 4, *Blocked*); once it is answered, carry on.

The reviewer is never you, and never the same reviewer twice: each round's review is done by a new agent that knows nothing of earlier rounds except the settled rulings and open owner questions you pass it. That is what makes each report an independent check of the code as it now stands.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `target` | *required* | The project folder or package. |
| `scope` | whole target | Limit the reviews to these source files or directories (relative to the target). |
| `maxRounds` | none | No cap by default: the loop runs until a fresh review passes every gate. Set it only to deliberately stop early; a fresh review always follows the last update round. |
| `commit` | yes | Commit each green round. With `no`, run on a dirty tree and commit nothing. |
| `gateCommand` | none | An extra command that must pass before a round is committed (e.g. `npm run lint`). |
| `openBrowser` | yes | Open every report when it is written. |
| `settledRulings` | none | Findings from earlier rounds that have been adjudicated (refuted or accepted). |
| `ownerQuestions` | none | Owner-level questions that remain unanswered. |

## Ground rules

- **Fix everything you are handed.** Every open finding — high, medium and low — ends in exactly one outcome: **fixed**, **refuted** (by an independent arbiter), or **blocked** (it needs a product decision). "Too hard" and "out of scope" are not outcomes.
- **Never mute a signal.** Never skip, disable, quarantine or delete code to make anything pass (delete a file only when replacing it with a correct implementation, or when the behaviour no longer exists — and say which). Never add retries, real sleeps, wider tolerances, or coverage-ignore pragmas.
- **Production code changes only** (a) to fix a defect a finding demonstrates, with a regression test you have seen fail before the fix and pass after, or (b) to add a minimal seam for determinism — an injectable clock, random source, or ID generator — without changing behaviour.
- **Change code only to fix it.** No mutation testing or experimental edits — not in place, not in a copy. The only "before" run is a new regression test run against the current code before you fix it.
- **Missing or broken static analysis / coverage tools are yours to fix**, like any other finding. "Tool not measured" is never an acceptable end state. Find a suitable standard tool, pin its version, wire it into the repo, and run it.
- **A package with no source files gets a starter scaffold** (e.g. a minimal module and a test) if the repo truly lacks any code.
- **Install nothing else.** Beyond a lint/static-analysis tool, coverage tool and test framework the package lacks, add no dependency.
- **All artifacts live under the round's update folder**:
```
runRoot/round-N/update/
  evidence/   raw outputs the update report cites (post-fix coverage, lint, etc.)
  scratch/    everything else – drafts, notes, helper agents' work – deleted after the round
```
- **Leave nothing behind.** Delete `scratch/` once the round’s report is written. Keep only the code changes, the commit, each round’s `report.html`, `update.json` and `evidence/`.
- **Git:** commit only this round’s own changes; never push, amend, rebase, reset, revert, stash or switch branches; never use git to discard a change.
- **Follow the repository’s own documented conventions** (AGENTS.md, CONTRIBUTING, existing test helpers) — they are part of the bar.

## Procedure

### Step 1 · Preflight

1. Resolve `target`; find the repository root, HEAD commit and branch.
2. With `commit` on, the working tree must be clean (ignoring `/.qa/`): each round commits its own changes and nothing else. If it is not clean, stop and tell the user which paths are dirty — do not commit someone else’s work unasked.
3. Ensure the dependencies are installed (the updater never installs anything else).
4. Create the run root `<repoRoot>/.qa/code-review/<UTC timestamp>` (plain `mkdir` for the leaf, so a run is never reused), and make sure the file printed by `git rev-parse --git-path info/exclude` contains `/.qa/`.
5. Keep two lists for the whole run, both empty at the start: **settled rulings** and **owner questions**.

### Step 2 · Hand off to a fresh reviewer

Start a **new agent** for round N. In Claude Code, that is the `Agent` tool with a general-purpose agent; in another tool, its equivalent — a fresh session or sub-agent that does not inherit your conversation. Give it only this:

> Follow `<absolute path of this folder>/code-review-review.md`
> with inputs: target `<target>`; scope `<scope>`; round `N`; runDir `<runRoot>/round-N/review`; `openBrowser` `<yes|no>`; settledRulings `<list>`; ownerQuestions `<list>`.

Pass nothing else: none of your findings, fixes or opinions about the code.
When it finishes, read `<runRoot>/round-N/review/findings.json` (and the HTML report if you need it). Check the file exists, parses, and is for round N; if not, say so and stop.

### Step 3 · Decide whether to stop

- **Verdict **PASS** → stop: **converged**. Every gate passes. (If owner questions remain, the status is **awaiting owner**; ask the owner, and when the answers come, apply them and start another round.)
- **Verdict **INCOMPLETE** with no open high or medium finding → the reviewer could not answer some cells (missing tool, unsupported language). Do not stop: fix what made the cells unanswerable (install missing tool, add a minimal test harness), then start a new reviewer.
- `maxRounds` was given and round N is past it → stop: **not converged**.
- Otherwise continue with every open finding.

**No progress is not a reason to stop.** If a fresh review raises again a finding you fixed in an earlier round, your fix did not hold: re-read the reviewer’s evidence, fix it properly, or — only with concrete evidence that the finding is wrong — put it to an arbiter. If it needs a product decision, ask the owner. Then go on to the next round.

### Step 4 · Fix every finding

Work through the open findings grouped by the file they affect (high severity first). Findings that belong to no file (`row` is `""` – package checks such as missing lint tool) come first, since they can unblock everything else.

For each group:

1. Read the source file, the reviewer’s evidence, and any related docs.
2. Apply the recommended fix (or a better one) **in the repository**.
3. Run the relevant command(s) to verify the fix resolves the finding (e.g. re-run the linter, re-run coverage, re-run the failing test).
4. If the fix is non-trivial, you may start a helper sub-agent with the same rules; review its diff before integrating.

**Parallel helpers** are allowed only when:

1. The repository permits concurrent writes (no "one writer at a time" rule in AGENTS.md or CONTRIBUTING).
2. Each helper works on a disjoint set of files; shared files (e.g. configuration, shared test helpers) must be edited by you sequentially.

### Step 5 · Dispute a finding (optional)

If you have concrete evidence that a finding is factually wrong, start a **fresh arbiter agent** with the finding and your counter-evidence. Instruct it to read the code and decide whether the finding **stands** or is **refuted**. If refuted, add the finding’s id to **settled rulings** with status `refuted`.

### Step 6 · Blocked findings

If a finding cannot be fixed without a product decision (e.g. "Should this API be public?"), write a clear question and add it to **owner questions** in the form:

```
<finding id> (<location>): <question>
```

Also record the question in the repository’s decision queue if one exists.

### Step 7 · Integrate

1. Read `git status` and `git diff` for this round and check every change against the ground rules. Fix any violation.
2. Run the full test suite twice — the second time with randomised order if the runner supports it — then coverage once, and any static-analysis or security scans required by the repo. Run `gateCommand` if provided. Fix whatever fails, at its root cause, and re-run until everything passes.
3. With `commit` on and everything green: stage exactly this round’s changes (`git add -- <paths>`; never anything under `/.qa/`) and commit:

```
code-review-update round N – <fixed> of <total> review findings

Target: <target> (scope: <scope>)
Review: <runRoot>/round-N/review/report.html (verdict <verdict>, at <commit>)

- <id> [<severity>] <outcome>: <title>
- …
```

plus any required trailer.

If anything is still red, do not commit; explain why in the update report and the next review will see it.

### Step 8 · Write and open the update report

Write `<runRoot>/round-N/update/update.json` — the round’s record:

```json
{
  "workflow": "code-review-update",
  "round": 1,
  "target": "",
  "scope": [],
  "review": {"path": "<runRoot>/round-1/review/report.html", "verdict": "fail", "commit": "", "open": {"high":0,"medium":0,"low":0}},
  "outcomes": [{"id":"R1-STATIC-001","severity":"medium","gate":"STATIC","row":"","location":"","title":"","outcome":"fixed","summary":"","files":[],"ruling":null,"question":"","options":[]}],
  "integration": {"green":true,"commands":[{"command":"","purpose":"","exitCode":0}],"coverageBefore":[],"coverageAfter":[],"violationsFixed":[],"committed":true,"commit":"full sha","note":""},
  "newRulings": [],
  "ownerQuestions": [],
  "filesChanged": [],
  "history": [{"round":1,"open":{"high":0,"medium":0,"low":0}}],
  "timestamp":""
}
```

Then build `<runRoot>/round-N/update/report.html` exactly like the review report (copy `report-head.html`, replace `REPORT_TITLE` with `Code-review update R<N> – <STATE>`, append the body sections listed in step 6 of [`../unit-tests/unit-tests-update.md`](../unit-tests/unit-tests-update.md), adjusted for code-review specifics). Open it with the same command as the review workflow.

### Step 9 · Finish

Only when the loop has stopped — a fresh review passed every gate, or a given `maxRounds` ran out — tell the user in a few lines:

- The final status (converged, awaiting owner, not converged).
- How many rounds were run.
- The commits made.
- The final review’s verdict and any open findings.
- Owner questions, if any.
- Paths of the final review report and the run root.

---

The two workflows together implement an **adversarial code-review loop**: a fresh reviewer finds problems, the updater fixes them, and the cycle repeats until the code meets all quality gates.
