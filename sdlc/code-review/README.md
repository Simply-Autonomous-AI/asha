# Adversarial Code Review Workflows

Two complementary agentic workflows that hand off to each other in a loop, for **general code reviews** (not just unit tests) in any language and framework:

| Workflow | Who runs it | What it produces |
|---|---|---|
| [`code-review-review.md`](./code-review-review.md) | A **fresh, isolated reviewer agent** each time | `report.html` (opened in the browser) and `findings.json` — a pass/fail verdict for every source file against the review gates, and every issue found |
| [`code-review-update.md`](./code-review-update.md) | The **updater** — the agent you start | Fixes for every finding, a commit per round, `report.html` + `update.json` for the round (opened in the browser), then a hand-off to a new reviewer |

Both are plain instructions for an AI agent; there is no executable program. The updater drives the loop and starts each reviewer as a new isolated agent.

## Running them

In Claude Code, from the repository root:

```
> Follow sdlc/code-review/code-review-update.md with target . and scope <changed paths>
```

or, for a read-only verdict and no fixes:

```
> Follow sdlc/code-review/code-review-review.md with target . and scope <changed paths>
```

Add any optional inputs (e.g. `scope src/`) in the same sentence. See each workflow for a full list of inputs.

Before an update run, ensure the target's dependencies are installed and the working tree is clean (the updater commits its own changes only).

## The review gates

The reviewer checks each source file against the following six quality gates, in order. A cell (file, gate) ends **PASS** or **FAIL**; un-answered cells are **UNCHECKED**, which makes the review **INCOMPLETE**.

| # | Gate | Pass condition |
|---|---|---|
| 1 | **Static analysis** | No lint, type-check or static-analysis errors. The tool must run and produce results; if the tool is missing or broken the gate fails for every file. |
| 2 | **Test coverage** | The file is covered by unit/integration tests meeting the project’s coverage thresholds (default line 95 % / branch 75 %). Measured, not judged. |
| 3 | **Design consistency** | The file follows the repository’s architectural guidelines (e.g. layering, dependency direction, naming conventions). |
| 4 | **Security hygiene** | No obvious security anti-patterns (hard-coded secrets, unsafe deserialization, SQL injection, etc.). |
| 5 | **Documentation** | Public symbols are documented; the change is reflected in the appropriate Markdown docs. |
| 6 | **Reliability** | The code passes all existing tests on repeated runs, with no flaky behaviour. |

A **high** or **medium** finding on any gate makes the cell FAIL. Low findings are reported but do not cause a FAIL.

## Output

```
<repo>/.qa/code-review/<UTC timestamp>/
  round-1/review/report.html
  round-1/review/findings.json
  round-1/review/evidence/
  round-1/review/scratch/
  round-1/update/report.html
  round-1/update/update.json
  round-1/update/evidence/
  round-1/update/scratch/
  round-2/review/…
```

All temporary files live under `scratch/` and are deleted after each step.

## Loop termination statuses

| Status | Meaning |
|---|---|
| **converged** | A fresh review passed every gate – no open high/medium findings. |
| **awaiting owner** | Review passed but owner questions remain (e.g. product decisions). |
| **not converged** | `maxRounds` was reached and the last review still has failures. |

---

The two workflows together implement an **adversarial code-review loop**: a fresh reviewer finds problems, the updater fixes them, and the cycle repeats until the code meets all quality gates.
