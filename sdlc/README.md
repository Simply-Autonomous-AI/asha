# sdlc — agentic review workflows

The adversarial reviews (PRINCIPLES §18) for code, as instructions an AI agent
follows; there is no program. **Open them only when a change touches code**
([AGENTS.md](../AGENTS.md) §5) — they stay out of the guidance every session
loads.

| Workflow | Run it to |
|---|---|
| [`code-review/code-review-update.md`](code-review/code-review-update.md) | Loop until the code passes: a fresh, isolated reviewer → fix every finding → commit → a new reviewer. Gates: static analysis, coverage, design, security, documentation, reliability. |
| [`code-review/code-review-review.md`](code-review/code-review-review.md) | Get one read-only verdict on the code; no fixes. |
| [`unit-tests/unit-tests-update.md`](unit-tests/unit-tests-update.md) | The same loop for unit tests. Gates: coverage, assertion depth, mock interactions, latency, semantic correctness, reliability. |
| [`unit-tests/unit-tests-review.md`](unit-tests/unit-tests-review.md) | Get one read-only verdict on the unit tests; no fixes. |

**Status (2026-10-12):** copied into this repo; not yet run from here. The
first code change after the copy is its first run.

Each folder's README has its gates, inputs and output layout. Runs write to
`.qa/<workflow>/<UTC timestamp>/`, which the workflows add to
`.git/info/exclude`.

**Changing a workflow.** A workflow is plain instructions, self-contained in its
folder: it may use the files beside it, the `unit-tests/` report conventions,
and start another workflow in `sdlc/` in a fresh agent — nothing else. Name tools as
examples, never as a whitelist. A reviewer that must judge independently starts
as a new agent with only its inputs. Verify a change by running it for real on a
small target and reading what it wrote (PRINCIPLES §14), and name that run in
the commit message.
