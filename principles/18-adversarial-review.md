# 18. Adversarial review — an agentic workflow for every change

*(The owner's rule, 2026-09-27.)* **Every change — design, plan, code, tests,
docs — gets an adversarial review before it is reported done.** The review is
an agentic workflow, never a human review: a fresh, isolated agent that did not
write the change and is given only its inputs, never the author's reasoning.

- **A change that touches code** goes through the review loops in `sdlc/`
  ([AGENTS.md](../AGENTS.md) §5). Each round is a new reviewer; the loop stops
  when a fresh review passes every gate. Its round commits record the outcomes,
  and the change's completing commit names the converged run.
- **Any other change** gets one round: a fresh subagent given the diff and this
  charter.

The charter — find:

1. **quality problems** — defects, facts that do not match the code, tests that
   cannot fail, docs that are no longer true, undeclared shortcuts (§20);
2. **principles not applied** — these and `AGENTS.md`, rule by rule;
3. **material risks** — security, observability, reliability, performance,
   cost, licences, privacy, legal.

The reviewer verifies by running things (§5, §14), and names, for each material
finding, the earlier check that would have caught it (§21).

In a one-round review, each finding gets one disposition: **fixed** (every
material finding); **rebutted**, with evidence; or **declined** as not
material, with a one-line reason — never a finding about correctness, security,
data loss or a principle. Fixing the findings starts no second round unless the
fix is a new design. The completing commit carries a trailer:

```text
Review: adversarial, 6 findings (3 fixed, 1 rebutted, 2 declined)
```

With none: `Review: adversarial, 0 findings`.
