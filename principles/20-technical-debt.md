# 20. Technical debt — allowed, and always tracked

*(The owner's rule, 2026-09-27.)* **A sub-optimal implementation that keeps the
project moving is acceptable; an untracked one is not.** Register it in
`docs/plans/debt.md` in the same commit: an id (`D1`, `D2`, …), what it is and
where (deep links), why it was accepted, what it costs while it stays (risk,
limits, workarounds), what paying it off looks like, and the date.

- It stays **open** until a plan (§19) names it; that plan's completing commit
  marks it **paid**.
- A known unfixed defect is debt — but one below a hard floor (a security hole
  exploitable as the system is used, data loss, a swallowed error, §11) is
  fixed, not deferred.
- An undeclared shortcut found in review (§18) is material: fix it, or register
  it.
