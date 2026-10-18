# 19. Plans — specify, then build, then document

*(The owner's rule, 2026-09-27.)* **Future work lives only in `docs/plans/`**;
the durable docs describe the system as it is. `docs/plans/index.md` lists every
plan with its status.

**A plan is a one-page specification, from the repo's template:**

- **Context** — what exists (linked) and the problem.
- **Requirements** `R1`, `R2`, … — each testable, MUST / MUST NOT, with no vague
  words ("fast", "simple", "support").
- **Out of scope.**
- **Open questions** — each a `TODO:` naming who decides.
- **Acceptance criteria** `A1`, `A2`, … — each an observable check (a command or
  test and its expected result) naming the requirements it proves; every
  requirement is covered.
- **Steps**, with **two adversarial reviews** (§18): a *plan review* before
  ready — are the requirements unambiguous, complete and testable, and do the
  criteria prove them? — and a *completion review* before done: the code, tests
  and docs, plus a table `R1 | implemented: file | tested: test | documented:
  page` with evidence in every cell. A gap in any cell is material.
- **Durable docs to update**, and the **debt retired** (§20).

**Status moves `draft → ready → in progress → done`.**

- **ready:** no open questions, a criterion for every requirement, the plan
  review done. The owner's questions (§4) are answered and dated; the planner
  decides the rest and records why. **No one implements a plan that is not
  ready.** *(Exception — the owner, 2026-09-29, record
  `pattern-build-before-ready`: a pattern-demo plan whose only step left is its
  premise probes may have its model-free parts built, on a branch, unmerged
  until ready.)*
- **done**, in the completing commit: every criterion checked off with its
  evidence, the gap-free completion table on the plan page, the durable docs
  updated, the retired debt marked paid. The plan page stays as the record.

Durable docs mention unbuilt work only through a `planned` badge naming its
plan as text, `planned: <slug>` — never the plan's design, and never a link:
the plans are not published, so a durable page cites one as code,
`docs/plans/<slug>.md`.
