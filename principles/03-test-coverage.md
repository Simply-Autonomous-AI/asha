# 3. Test coverage — every change to logic carries tests

**Every addition, change or deletion of logic has test coverage**, so a
regression is detected rather than discovered, and the failing test says where.

- **Unit tests** are the most thorough layer: they assert exact values and
  shapes, and verify every mock interaction — called, how often, with exactly
  which arguments, and nothing else.
- **Integration tests** cover every API over its real contract.
- **Eval tests** cover every agentic workflow that involves a model.
- **Deleting logic deletes or updates its tests** in the same change.
- **A new guard must be proven to fail:** break what it guards, see it fail
  naming the offender, then restore. For UI work, screenshot at the target
  viewport and look at the image.
- **No flaky tests.** A pass on retry is not a pass. Find the root cause (a
  race, an unpinned clock, a shared fixture, an unmocked network call, a leaked
  global) — never retries, `.skip`, sleeps, widened tolerances or quarantine.
