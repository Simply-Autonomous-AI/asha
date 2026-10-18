# 11. Surface every error — never swallow, always discoverable

**A failure nobody can see is worse than a failure that stops the system.**

- **Never swallow.** No empty `catch {}`, `.catch(() => {})`, floating promise,
  `// ignore`, or non-2xx response treated as success. A caught error is either
  resolved (genuinely recoverable, *and still recorded*) or re-thrown as a typed
  error with its `cause` — on best-effort paths too.
- **Never turn one error into a benign one.** Narrow on its actual shape: an
  access-denied read treated as "not found" rebuilds a record from nothing.
- **Catch at one boundary.** Logging is observability, not handling.
- **Every server-side failure is findable** as a structured error-level record
  through the project's one logging facade — never ad-hoc `console.*`. Answer
  *"if this fails at 3am, which query finds it?"* before shipping; a failure
  that kills the process before it can log is caught by platform signature, and
  a failure mode neither route catches extends the scan in the same change. A
  line that scrolls away is not a durable surface. Silence is not health: check
  invocation *and* error counts.
- **Expected external failures are data** — `{ ok: false, reason }`, the reason
  from a small stable set. Throw only for programmer error or a broken
  invariant.
- **Every remote call is bounded** by a timeout, a stream by inactivity rather
  than wall-clock. A longer bound is explicit at its call site, with its reason.
- **Client errors** show a fallback UI carrying the error *and* report
  server-side, with no identifying user data. Zero consent-gated events is not
  zero users.
