# 21. Automated assurance, and guidance that keeps improving

*(The owner's direction, 2026-09-27.)* **Human review is optional and minimal;
the owner answers only the decisions that are theirs (§4).** So the automated
assurance — the gate (§1), its guards (§3), the reviews (§18, §19), the repo's
checklists — must be complete on its own. **A defect only a human looking could
catch is a missing check.**

**Every escaped defect improves the guidance:** its fix includes, in the same
change, the earliest check that would have caught it — a test, a guard, a
checklist item, or a rule here or in `AGENTS.md`. The reviewer's "earlier check"
list (§18) is the main source.

**Amend, don't append.** Sharpen the existing rule rather than adding a
near-duplicate, and delete what no longer earns its place. A general rule
belongs here; a rule for this repo alone belongs in `AGENTS.md`.
