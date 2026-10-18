# One agent at a time, on `main`

The detail behind [AGENTS.md](../AGENTS.md) §3 (one writer).

**One agent at a time changes files, on `main`, in this checkout** (the owner,
2026-09-30, decision record `agent-branches`, option (c)). No agent works on a
branch of its own; agents that only read, review or plan without writing may
run alongside the one that changes files. *(This replaces the rule of
2026-09-27 that gave each code-writing agent its own `git worktree`: the tool
that made those worktrees named a branch for each, against PRINCIPLES §1, and
the 28 resulting branches are kept until the owner says otherwise.)* Never
copy whole files over the checkout; before writing a shared file, re-read it,
and merge, never overwrite. *(2026-09-27: an agent copied its
`tests/agents/support.ts` over the checkout and erased another agent's
uncommitted edits; they were restored from its transcript.)*

A gate or test run that needs its own checkout uses a detached worktree, laid
out as [gate-and-tests.md](gate-and-tests.md#a-gate-run-from-a-worktree) says.

**Exception (the owner, 2026-10-17: "Let's run 5 concurrent sub-agents to fix the
code issues").** For the whole-repository review's fixes before the release, up
to five fixers run at once, each in its own **detached** worktree (no branch is
made), committing there; the orchestrating agent, the one writer of `main`,
cherry-picks each fixer's commits onto `main` one at a time, merging what two
fixers changed in a shared file (the Testing table, the debt register, the plans
index), and runs the checks again before the next. Each fixer's debt entry has an
id given in advance. The exception ends with those fixes.
