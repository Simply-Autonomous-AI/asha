# 15. Documentation is part of the change

**A change is complete only when the document describing it is true again, in
the same commit.** A wrong doc is worse than none.

- Every repo indexes its docs. An unlisted doc is invisible; a listed one that
  no longer exists is worse.
- Say when something exists but is not live, and un-say it when it ships;
  re-verify status when you touch the doc, and record the date.
- A contract with anything outside the repo is documented at its boundary here.
- Correct a stale doc, or delete it if it cannot be corrected. Corrections are
  visible (§12).
