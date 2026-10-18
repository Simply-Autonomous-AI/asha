# The gate and the test suites

The detail behind [AGENTS.md](../AGENTS.md) §2 (§1, §3) and §3.

## The gate

The gate is `npm run check` (lint → unused code → format check → typecheck → secret scan →
unit → integration → build → demo selection → agents → eval → routing); work is
not done until it is green. The secret scan, `npm run scan:secrets`, needs
gitleaks 8.30.1 to below 9 (`brew install gitleaks`; tools/oss/secrets.mts). The demo selection, `npm run demos:select`, records
which pattern demos a change repeats (docs/testing/index.html#selection).

The linter and the formatter, `npm run lint` and `npm run format:check`
(docs/quality/index.html#lint), are the gate's first links (since
2026-10-14, plan docs/plans/lint-format.md), with the unused-code check between
them, `npm run lint:unused` (knip, docs/quality/index.html#unused; since
2026-10-17). Check each file you write or
rewrite with `npx eslint <file>` and `npx prettier --check <file>` before the
gate does; `npm run format` writes the formatting.

## The suites that run real agents (PRINCIPLES §3)

The portal's browser tests need playwright-core's pinned browsers, installed
once per machine: `npx playwright-core install --no-remove chromium-headless-shell firefox`.

Two tiers run real agents, and both are part of the gate:

- `npm run test:agents`, the agent suite (`tests/agents/`): single-agent and
  multi-agent scenarios, with real agents in their containers, through
  `./asha`, the daemon and the real model;
- `npm run eval` (`tests/eval/`): the `./asha` CLI end to end.

`npm run eval:routing` measures each model's per-message decisions without
containers; it is not in the report. Its gate step, `npm run
eval:routing:gate` (the last step of `check`, since agent-calls R18,
2026-09-29), runs every case and held-out case on `qwen3-8b-q4_k_m` but
those taken out as debt D30, and fails on any below 3/3.
`npm run report` renders every recorded agent-suite test and its output to
`docs/testing/agent-tests.html`.

## Deterministic where the gate asserts

A recipe whose output the eval asserts exactly must decode deterministically
(`chat.temperature: 0`). If an upgrade changes that output, re-verify and update
the expectation — never loosen the assertion (§8). This applies to local models:
no gate suite uses a hosted model, and no suite reaches the network — the unit
and integration suites refuse any connection but loopback, and module tests run
against fakes (extension-modules R17, R20); a vendor is reached only by the
opt-in `npm run live:modules`.

## One full gate at a time

Only one full gate runs at a time on this Mac: two agent suites on one GPU slow
model calls past their bounds (debt D19), and a unit or integration run (the
docs guard included) beside an agent suite slows its timed launches past theirs
(the `01f037a` failure, docs/testing). `/tmp/asha-agent-suite.lock` enforces
it both ways (debt D20, 2026-10-03): the agent suite and eval configs
hold it for their run (a second one fails naming the holder pid; a dead
holder's lock is reclaimed) and, once they hold it, wait up to 300 s for
every unit or integration run still registered; the unit, integration,
live and screenshots configs register themselves in
`/tmp/asha-light-runs/<pid>` first, then refuse to start while it is held
(`tests/helpers/suite-lock.ts`). When
refused, wait; never delete a live holder's lock or registration. Not
enforced (debt D29, narrowed): any other load — `npm run build`,
`npm run docs`, a probe — which registers nothing, so do not run those
beside an agent suite.

## A gate run from a worktree

A gate or test run that needs its own checkout runs from a detached worktree of
a commit (no branch, nothing committed from it), in a new folder named for the
run, never one reused (a copy into a reused folder followed an old `harness`
symlink and overwrote another worktree on 2026-09-29). It needs nothing beside
it: every test resolves paths from the repository root, and
`tests/unit/isolation.test.ts` fails on one that does not. *(Until 2026-10-12
the folder had to be named `harness`, a real directory, beside a link to each
other repository a decision record cited; debt D9,
paid that day.)*
