---
name: unit-tests-update
description: Loop until the unit tests of a package pass all six gates - hand the code to a fresh, isolated unit-tests-review agent, fix every finding in its report, prove the suite green, commit, publish an update report, and hand off to a new reviewer, round after round, until a fresh review passes every gate. Any language, any test framework.
---

# Unit-tests update

You are the **updater**. You bring the unit tests of one project folder or
package up to the bar defined in [`unit-tests-review.md`](./unit-tests-review.md),
in rounds:

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  fresh reviewer (isolated)  →  report.html + findings.json           │
 │        ↓                                                             │
 │  you: fix every finding  →  arbiter for disputes  →  suite green     │
 │        ↓                                                             │
 │  commit  →  update report (opened)  →  hand off to a NEW reviewer ───┘
 └─ stop only when a fresh review passes every gate
```

**Keep the loop running until a fresh review passes every gate** — every package
check and every (file, gate) cell PASS. Do not stop between rounds to report,
summarise or ask whether to continue: each update report is published and the
next reviewer is started in the same breath. The only pause is for an owner
decision a finding genuinely needs (step 4, *Blocked*); once it is answered, carry
on.

The reviewer is never you, and never the same reviewer twice: each round's
review is done by a new agent that knows nothing of earlier rounds except the
settled rulings and open owner questions you pass it. That is what makes each
report an independent check of the code as it now stands.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `target` | *required* | The project folder or package. |
| `scope` | whole target | Limit the reviews to these test files or directories (relative to the target). For slicing a large package. |
| `maxRounds` | none | No cap by default: the loop runs until a fresh review passes every gate. Set it only to deliberately stop early; a fresh review always follows the last update round. |
| `commit` | yes | Commit each green round. With no, run on a dirty tree and commit nothing. |
| `gateCommand` | none | An extra command that must pass before a round is committed (e.g. `npm run gate`). |
| `thresholds`, `reliabilityRuns`, `slowTestMs` | as in the review | Passed to every reviewer. |
| `openBrowser` | yes | Open every report when it is written. |

## Ground rules

- **Fix everything you are handed.** Every open finding in the review — high,
  medium and low — ends in exactly one outcome: **fixed**, **refuted** (by an
  independent arbiter), or **blocked** (it needs a product decision). "Too hard"
  and "out of scope" are not outcomes.
- **Never mute a signal.** Never skip, disable, quarantine or delete a test to
  make anything pass (delete one only when replacing it with a correct test of the
  same behaviour, or when the behaviour it tests no longer exists — and say
  which). Never add retries, real sleeps, longer timeouts or wider tolerances.
  Never add coverage-ignore pragmas or exclusions, and never lower a threshold.
  Never compute expected values by re-implementing the code under test.
- **Production code** changes only (a) to fix a defect a finding demonstrates,
  with a regression test you have seen fail before the fix and pass after, or
  (b) to add a minimal seam for determinism — an injectable clock, sleep, random
  source or id generator through the existing constructor or props, with the real
  implementation as the default — without changing behaviour.
- **Change code only to fix it.** No mutation testing or experimental edits —
  not in place, not in a copy. The only "before" run is a new regression test
  run against the current code before you fix it. Arbiters and helper agents you
  start are bound by the same rule; arbiters are read-only.
- **Missing or broken coverage is yours to fix, like any other finding.**
  "Coverage not measured" is never an acceptable end state. Find a suitable tool
  for the project's language and test runner — the ecosystem's standard one
  first; where that cannot measure branches, a maintained tool that can. Check
  its licence, and that the exact version exists and fits the installed runner.
  Add it as a development dependency pinned to that version, wire it into the
  project's test configuration with a command that produces line and branch
  figures, and run that command to prove it does. Never lower a threshold, and
  never set the branch bar to 0, to get around a tool.
- **A package with no unit tests gets a unit-test suite.** If it has no test
  framework at all, add the ecosystem's standard one the same way as a coverage
  tool — licence checked, exact version pinned, wired into a command that runs
  only the unit tests — then write the tests (below).
- **Install nothing else.** Beyond a test framework and a coverage tool the
  package lacks, add no dependency.
- **Every file that is not a code change goes in the round's update folder**,
  `<runRoot>/round-N/update/`: `evidence/` for raw outputs the update report
  cites (the integration runs, coverage after), and `scratch/` for everything
  else — coverage and reporter output you do not cite, ad-hoc scripts, notes,
  drafts, the commit message file, and your helpers' and arbiters' working files.
  Never the system temp folder, the repository or a session scratchpad: point
  every tool's output option there. Give every helper and arbiter that path.
- **Leave nothing behind.** Delete `scratch/` once the round's report is written.
  What stays is the code changes, the commit, each round's `report.html`,
  `update.json` and `evidence/`. Tests you write clean up their own temporary
  files too.
- **Git:** commit only this run's own changes; never push, amend, rebase, reset,
  revert, stash or switch branches; never use git to discard a change.
- Follow the repository's own documented conventions (AGENTS.md, CONTRIBUTING,
  existing test helpers) — they are part of the bar.

## Procedure

### Step 1 · Preflight

1. Resolve `target`; find the repository root, HEAD commit and branch.
2. With `commit` on, the working tree must be clean (ignoring `.qa/`): each round
   commits its own changes and nothing else. If it is not clean, stop and tell the
   user which paths are dirty — do not commit someone else's work unasked.
3. Make sure the dependencies are installed (a reviewer never installs anything).
4. Create the run root `<repoRoot>/.qa/unit-tests/<UTC timestamp YYYYMMDDTHHMMSSZ>`
   (plain `mkdir` for the leaf, so a run is never reused), and make sure the file
   printed by `git rev-parse --git-path info/exclude` contains `/.qa/` — so
   nothing under it, scratch included, can reach a commit. Each round adds
   `round-N/review/` (the reviewer's) and `round-N/update/` (yours), each with
   `evidence/` and `scratch/`.
5. Keep two lists for the whole run, both empty at the start: **settled
   rulings** and **owner questions**.

### Step 2 · Hand off to a fresh reviewer

Start a **new agent** for round N. In Claude Code, that is the Agent tool with a
general-purpose agent; in another tool, its equivalent — a fresh session or
sub-agent that does not inherit your conversation. Give it only this:

> Follow the workflow in `<absolute path of this folder>/unit-tests-review.md`.
> Inputs: target `<target>`; scope `<scope>`; round `N`;
> runDir `<runRoot>/round-N/review`; thresholds, reliabilityRuns and slowTestMs
> as given; openBrowser `<yes|no>`;
> settled rulings: `<the list, verbatim, or "none">`;
> owner questions: `<the list, verbatim, or "none">`.

Pass nothing else: none of your findings, fixes or opinions about the code.
When it finishes, read `<runRoot>/round-N/review/findings.json` (and the HTML
report beside it if you need the rendering). Check the file exists, parses, and
is for round N; if not, say so and stop.

### Step 3 · Decide whether to stop

- Verdict **PASS** → stop: **converged**. Every gate passes. (If owner questions
  are still unanswered, the status is **awaiting owner**: ask the owner, and when
  the answers come, apply them and start another round.)
- Verdict **INCOMPLETE** with no open high or medium finding → the reviewer
  could not answer some cells. Do not stop: read its Limitations, fix what made
  the cells unanswerable if it is in the repository (a broken test command, a
  missing tool), and start a new reviewer.
- `maxRounds` was given and round N is past it → stop: **not converged**.
- Otherwise continue with every open finding.

**No progress is not a reason to stop.** If a fresh review raises again a finding
you fixed in an earlier round, your fix did not hold: re-read the reviewer's
evidence, fix it properly, or — only with concrete evidence that the finding is
wrong — put it to an arbiter. If it needs a product decision, ask the owner.
Then go on to the next round.

### Step 4 · Fix every finding

Work through the open findings grouped by the test file they fail (`row`), high
severity first. Findings that belong to no test file (`row` is `""` — package
checks such as a missing coverage tool, a source file below the bar with no test
file of its own, a skipped test) come first, since they can unblock everything
else. However many test files the package has — none, a handful, thousands — the
procedure is the same; only the number of groups changes. With none (the review
failed every gate under P0), the work is the whole suite: one test file per
source file, by the repository's naming and placement convention, each written
to pass all six gates from the start. For each group: read the test file, its subject source, and the
evidence; fix every finding in the group; run that test file twice — both runs
must pass. You may hand groups to helper agents with these same rules, and you
review what each one changed.

**Run helpers in parallel only when both of these hold:**

1. **The repository allows more than one agent to change files at once.** Some
   forbid it (a "one writer at a time" rule in AGENTS.md or CONTRIBUTING). Then
   helpers run strictly one after another.
2. **Each parallel helper owns a disjoint set of files** — its own test file(s)
   and nothing else. A change to anything shared (test doubles and helpers,
   production code, configuration, dependency manifests, docs) is not made by a
   parallel helper: it describes the change, and you apply shared changes
   yourself, one at a time, re-running the tests they affect.

Package-level fixes (a coverage tool or test framework to add, shared
configuration) go first, alone, since every group depends on them. Each parallel
helper runs only its own test file(s); the full suite runs once, at integration.
When all have returned, review every diff before you integrate.

How to fix, by gate:

- **Coverage** — test the behaviour behind the uncovered lines and branches,
  with full assertions; never the line for its own sake. A source file with no
  test file gets one, named and placed by the repository's own convention. A genuinely unreachable
  branch may be removed when you can prove it unreachable from types or
  invariants. When the coverage tool is missing, broken or cannot measure
  branches, fix that first (ground rules): until coverage is measured, gate 1
  fails for every test file and nothing else about coverage can be judged.
- **Assertion depth** — compare the whole output with deep equality against
  literal expected values; check every field callers rely on; exact collection
  contents (and order where it is contractual); for errors the type, the message
  or code, and the cause. Make every test able to fail: await asynchronous
  assertions, move assertions out of callbacks that may not run, never swallow a
  failure.
- **Mock interactions** — verify every double's exact call count and every
  argument (one exact comparison of the whole recorded call list does both), and
  assert that nothing else was called: a strict mock, a
  verify-no-more-interactions check, or not-called assertions on the other doubles.
- **Latency** — replace every real wait with fake timers or an injected clock or
  sleep and advance time explicitly. Never shorten a real sleep; remove it.
- **Semantic correctness** — rewrite the expectation from the evidence, never
  from the code's current output. When the evidence shows the production code is
  wrong, fix the code (ground rules) and keep the test asserting the correct
  behaviour.
- **Reliability** — remove the nondeterminism at its source: pin the clock and
  time zone, seed or inject randomness and ids, isolate state per test, restore
  mocks, environment and globals, fake the network at its boundary, use per-test
  temporary directories. Un-skip skipped tests and make them pass, or delete them
  when the behaviour they cover is gone (say so). Never add retries.

Record, for every finding: its outcome, what you changed, and every file you
changed.

**Disputes.** If you have concrete evidence that a finding is factually wrong —
cite the `file:line` or document passage — do not just skip it. Start a **fresh
arbiter agent** with the finding (as written in `findings.json`) and your
counter-evidence, instructed to read the code itself and rule *finding stands*
or *finding refuted*; for a refuted finding it writes one standalone sentence a
future reviewer can apply (naming the file, the test or behaviour, and why the
claim is wrong). Add that sentence to the **settled rulings**. A finding that
stands goes back on your list: fix it. Effort, difficulty or scope are never
grounds for a dispute.

**Blocked.** Only when the correct fix depends on a product decision the
evidence does not settle — what *should* the code do? Write the exact question
and the realistic options, and add it to the **owner questions**
(`<finding id> (<location>): <question>`). Where the repository keeps a decision
queue, put the question there in its format as well.

### Step 5 · Integrate

1. Read `git status` and `git diff` for this round and check every change against
   the ground rules. Fix any violation properly.
2. Run every package's full unit-test command twice — the second time in
   randomised order where the runner supports it — then coverage once, and the
   static checks the repository defines for this code (typecheck, lint, format
   check), plus `gateCommand` if given. Fix whatever fails, at its root cause, and
   run it all again until everything passes.

   A run that refuses to start because another process holds a resource the
   repository guards (its suite lock, a port) is not a result: wait as the
   repository documents and run again; never remove another process's lock. A
   test that fails only while another heavy run shares the machine is re-run
   alone before you call it anything; if it then passes, record the load as an
   observation, not a failure of this round.

   Before you name a failure anywhere — a report, a commit message, a message to
   another session — attribute it by the failing test's own header in the
   output, never by the nearest stack line, which can belong to the next
   failure. When several tests in one file fail, read the first one first: a
   test that times out can keep running after the runner moves on, and what it
   changes (a shared fake clock, a fixture, a global) then fails the tests after
   it. Those later failures are knock-ons until shown otherwise.

   **A check that was already failing when the run started** — for a reason
   outside this run's changes — does not block the round, and is not yours to
   patch by guessing at someone else's unfinished work. Prove it: run the same
   check at the start commit (or show that the failing file is untouched since
   it), and show that this round adds no new error. Then record it as a
   pre-existing failure, with that evidence, in the update report's Integration
   section and in your final summary, every round until it is gone.
3. With `commit` on and everything green: stage exactly this run's changes
   (`git add -- <paths>`; never anything under `.qa/`) and commit:

   ```
   test: unit-tests-update round N - <fixed> of <total> review findings fixed

   Target: <target> (scope: <scope>)
   Review: <runRoot>/round-N/review/report.html (verdict <verdict>, at <commit>)

   - <id> [<severity>] <outcome>: <title>
   ...
   ```

   plus any trailer your environment requires. If anything is still red, do not
   commit; say why in the update report, and the next review will see it.

### Step 6 · Write and open the update report

Write `<runRoot>/round-N/update/update.json` — the round's record:

```json
{
  "workflow": "unit-tests-update", "round": 1, "target": "", "scope": [],
  "review": { "path": "<runRoot>/round-1/review/report.html", "verdict": "fail", "commit": "", "open": { "high": 0, "medium": 0, "low": 0 } },
  "outcomes": [{ "id": "R1-ASR-001", "severity": "medium", "gate": "ASSERTIONS", "row": "", "location": "", "title": "",
                 "outcome": "fixed", "summary": "", "files": [], "ruling": null, "question": "", "options": [] }],
  "integration": { "green": true, "commands": [{ "command": "", "purpose": "", "exitCode": 0 }],
                   "coverageBefore": [{ "package": "", "line": 0, "branch": 0 }], "coverageAfter": [{ "package": "", "line": 0, "branch": 0 }],
                   "violationsFixed": [], "committed": true, "commit": "full sha", "note": "" },
  "newRulings": [], "ownerQuestions": [], "filesChanged": [],
  "history": [{ "round": 1, "open": { "high": 0, "medium": 0, "low": 0 } }],
  "timestamp": ""
}
```

Then `<runRoot>/round-N/update/report.html`, built exactly like the review
report: copy `report-head.html` (next to this workflow) as its start, replace
`REPORT_TITLE` with `Unit-test update R<N> - <STATE>`, append the body, and close
with `<footer>…</footer></main></body></html>`. No scripts, no external
requests; escape `&`, `<`, `>` in quoted text. Sections, in order:

1. **Hero** — eyebrow *Unit-test update · round N*; the package(s); the
   headline (*"Fixed <n> of <total> findings; <r> refuted by the arbiter; <b>
   blocked on an owner decision; <u> unresolved. Suite green, committed
   <short sha>."*); a link
   to the review it answered (`../review/report.html`); and the state:
   **ALL RESOLVED** (`v-pass`: every finding fixed or refuted, suite green),
   **NEEDS ATTENTION** (`v-warn`: anything blocked or unresolved) or **RED**
   (`v-fail`: the suite is not green).
2. **Outcomes** — an SVG bar of the outcomes (fixed `f-pass`, refuted `f-muted`,
   blocked `f-warn`, unresolved `f-fail`), and the same split per gate, using the
   review report's *test files per gate* geometry (rows of `x=210…624`, 26 px apart).
3. **Integration** — GREEN or NOT GREEN; coverage before and after per package
   (the review report's gauge geometry, *after* values, with *before* stated
   beneath); every command run with its exit code; rule violations found and fixed.
4. **Progress across rounds** — `viewBox="0 0 (64 × rounds + 40) 170"`: per
   review round `r` a stacked column at `x = 30 + 64r`, width 34, on a baseline at
   y=140, heights proportional to open high (`f-high`), medium (`f-medium`) and low
   (`f-low`) findings (the tallest column 124 px), its total above it and `R<n>`
   below.
5. **What was done, by checklist row** — one card per test file: each finding
   with its outcome badge (`b-pass` fixed, `b-muted` refuted, `b-warn` blocked,
   `b-fail` unresolved), its severity, its id linked to
   `../review/report.html#<id>`, what changed, and the files.
6. **Rulings and questions** — new settled rulings; owner questions with options.
7. **Files changed** and the **commit**.
8. **Provenance** — target, scope, repository, the review answered, the commit
   made, time, run root.

Open it with the same command the review workflow uses, then go to step 2 for
round N+1.

### Step 7 · Finish

Only when the loop has stopped — a fresh review passed every gate, or a given
`maxRounds` ran out — tell the user, in a few lines: the status (converged,
awaiting owner, not converged); how many rounds; the commits made; the final
review's verdict and open findings; the owner questions, if any; and the paths of
the final review report and the run root.
