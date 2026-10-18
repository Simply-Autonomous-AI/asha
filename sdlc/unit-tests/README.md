# Unit-test workflows

Two agentic workflows that hand off to each other in a loop, for unit tests in
any language and any test framework:

| Workflow | Who runs it | What it produces |
|---|---|---|
| [`unit-tests-review.md`](./unit-tests-review.md) | A **fresh, isolated reviewer agent** each time | `report.html` (opened in the browser) and `findings.json` — a pass/fail verdict for every test file on every gate, and every issue found |
| [`unit-tests-update.md`](./unit-tests-update.md) | The **updater** — the agent you start | Fixes for every finding, a commit per round, `report.html` + `update.json` for the round (opened in the browser), then a hand-off to a new reviewer |

Both are plain instructions for an AI agent. There is no program: the updater
agent drives the loop and starts each reviewer as a new agent that does not
inherit its conversation.

[`report-head.html`](./report-head.html) is the shared page head (doctype and
CSS, light and dark) that both reports start from, so every report looks the
same.

## Running them

In Claude Code, from the repository root:

> Follow `sdlc/unit-tests/unit-tests-update.md`
> with target `.`

or, for a read-only verdict and no fixes:

> Follow `sdlc/unit-tests/unit-tests-review.md`
> with target `.`

Add any of the optional inputs in the same sentence (for example *scope
`tests/unit/billing`*, to limit a large package to one slice). Each workflow
lists its inputs at the top.

Before an update run, install the target's dependencies, and — with committing
on, the default — make sure its working tree is clean: each round commits its
own changes and nothing else.

## The six gates

Every unit-test file is checked against these, in order, and every (file, gate)
cell ends in an affirmative **PASS** or a negative **FAIL**. A cell nobody
answered is **UNCHECKED**, which makes the review **INCOMPLETE** — never a pass.
No gate passes vacuously: **a package with no unit tests fails every gate.**

| # | Gate | Pass condition |
|---|---|---|
| 1 | Coverage | The source files this test file is the primary test of reach 95 % of lines and 75 % of branches (by default). Measured, not judged — and if the coverage tool is missing or not working, this gate fails for every file. |
| 2 | Assertion depth | Every test asserts all relevant fields of the output against exact expected values, and every test can fail. |
| 3 | Mock interactions | Every interaction with every test double is verified for count and exact arguments, and the absence of any other interaction is asserted. |
| 4 | Latency | No test waits on real time: sleeps, timers, backoff and polling are driven by fake timers or an injected clock or sleep. |
| 5 | Semantic correctness | Every test asserts behaviour the evidence establishes as correct, and verifies what its name claims. |
| 6 | Reliability | Every test gives the same result on every run, in any order, at any time, on any machine — and none is skipped. |

Eight package checks come from measurement first: unit tests exist (P0),
coverage measurable and not hidden (P1), line and branch coverage at the bar (P2, P3), every source file at
the bar (P4), no failing (P5), flaky (P6) or skipped (P7) test.

Findings are high, medium or low by a fixed rubric per gate (in
`unit-tests-review.md`). A cell fails on any open high or medium finding. Every
finding is checked by a skeptic whose job is to refute it before it counts. The
loop keeps running, round after round with no cap by default, until a fresh
review **passes every gate** — no open high or medium finding anywhere.

## Output

```
<repo>/.qa/unit-tests/<UTC timestamp>/
  round-1/review/report.html     the review, opened when written
  round-1/review/findings.json   the hand-off to the updater
  round-1/review/evidence/       raw outputs the review cites
  round-1/review/scratch/        the reviewer's scratch work - deleted before it hands back
  round-1/update/report.html     what the updater did, opened when written
  round-1/update/update.json
  round-1/update/evidence/       raw outputs the update report cites
  round-1/update/scratch/        the updater's scratch work - deleted after the round
  round-2/review/...             the next fresh review
```

**Scratch work lives only in `scratch/`.** Every agent — reviewer, skeptic,
updater, helper, arbiter — writes its probes, drafts, notes and uncited tool
output there and nowhere else: not the system temp folder, not the repository.
`/.qa/` is added to the repository's `.git/info/exclude`, so nothing under it can
dirty the tree or reach a commit, and each `scratch/` is deleted when its agent
is done.

## Statuses the update loop ends with

| Status | Meaning |
|---|---|
| converged | A fresh review passed every package check and every cell. |
| awaiting owner | A fresh review passed, but some findings were set aside as owner questions. Not done until they are answered. |
| not converged | Only when a `maxRounds` cap was given: it ran out and the last fresh review still failed. With no cap (the default), the loop keeps going until every gate passes. |
