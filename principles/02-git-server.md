# 2. Git server — commit freely, never block on the remote

The remote is a private server (`git remote get-url origin`) that is **only
occasionally connected** — a backup, not a dependency. **Nothing blocks on a push.**

- Commit locally at every meaningful checkpoint; push opportunistically, with a
  short timeout.
- If the remote is unreachable, note it in one line and finish the work; never
  retry in a loop or stop to ask.
- Never leave work uncommitted, or report it incomplete, because a push did not
  land. Being ahead of `origin/main` is fine.

**Exception:** where origin is a public host, a push publishes and needs consent
(§1).
