# 9. Consistent behavior — no fallbacks for cases that should never happen

**Don't write fallback logic for a case that cannot legitimately occur.** When a
precondition is violated, succeed or **fail loudly** — never substitute a
default and limp on. A hidden failure surfaces days later, found by a user.

Ruled out: a default for a missing required input (`userId ?? "unknown"`); a
`catch` that returns `[]`, `null`, `{}` or a canned value for an unexpected
error; a branch guarding a state the types already exclude (throw, or
`assertNever`); retries around a deterministic defect; undeclared "best effort".

**Environment selection is the highest-stakes case.** A `STAGE`, a database URL
or an API base is set explicitly where the code is deployed, and a missing
value fails at startup — never defaulted, never guessed.

Instead: fail closed with a typed error carrying context and `cause`; make the
impossible state unrepresentable; handle a genuinely recoverable case
deliberately (named, tested, documented). Real graceful degradation is an
explicit, documented, observable mode. Expected external failures still return
as structured results (§11). If no test can reach a fallback branch, it should
not exist (§3).
