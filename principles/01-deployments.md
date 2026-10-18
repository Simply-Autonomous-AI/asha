# 1. Deployments — ship completed work through the guardrails, without asking

**A project that deploys, deploys through one gated command** (by convention
`npm run push`) that chains its checks and aborts on the first failure. When
work is complete, **commit and run it. Do not ask first** — the gate is the
safety.

**No consent needed:** `git add` / `git commit` on `main`; `git push` to the
private remote (§2); the gated deploy command.

**Needs explicit consent for that specific action:**

- any path that bypasses the gate — a raw infrastructure deploy, a direct sync
  or upload, a manual container push, direct cloud mutation, a pipeline trigger;
- publishing to a public registry or repository (npm, PyPI, Docker Hub,
  Hugging Face, a public GitHub repo);
- mutating git history (rebase, reset, amend, force-push, cherry-pick, revert,
  branch/tag deletion) — history rolls forward only;
- creating or switching branches — all work lives on `main`;
- anything that adds recurring spend (§7);
- anything else outward-facing: email, filings, paid sign-ups, public posts.

A repo with no gated deploy command has no autonomous deploy. **A red gate is
not done:** fix the cause and re-run; never route around it (§8).
