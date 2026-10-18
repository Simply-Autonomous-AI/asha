---
title: Testing History
description: Superseded asha test results and corrections to the testing page, newest first.
---

# Testing history

Results and claims the [testing page](index.md) no longer shows, kept so each old figure stays traceable to its commit.

> [!SUMMARY]
> - The current figures are from the gate at `71488d8` (2026-09-30 UTC); everything here is superseded. *(Corrected 2026-09-29: this still named `c6bf61f` after later gates, and then `93a30d9` after later gates — the first at `e7c0510` (commit `dadcd11`), the last at `c01fc94` — replaced the testing page's rows without moving them here; the rows between `93a30d9` and `c01fc94` remain only in the git history of `docs/testing/index.md`.)*
> - The gate at `05555b1` (484 unit, 41 integration, 35 agent-suite, 10 eval) was the page's latest until 2026-09-27; its rows are kept below.
> - Before `05555b1`, the unit suite had 454 tests; `decision-queue.test.ts` added 30.
> - The page once named two different gates for its results; it now names one.

## 2026-09-30: latest results moved from `e67573c` to `71488d8` {#gate-e67573c}

The gate at `71488d8`, which pays D44, replaced these rows of the [latest results](index.md#results):

| Suite | Result | Commit | When (UTC) | Source |
|---|---|---|---|---|
| Unit | <span class="badge pass">pass</span> 1947/1947 | `e67573c`, clean | 2026-09-29 22:51–23:13 | the final gate for `docs/plans/cli-interactive.md`, `npm run check`, `EXIT=0`, from a new run-named folder holding a detached worktree of the commit beside `web`, `setup` and `PRINCIPLES.md` links (the AGENTS.md layout), log `evals/probes/cli-interactive-2026-09-29/gate-e67573c.log.txt` (its run folder's path replaced by `<scratch>`, scanned for secrets and the login name: none). The run before, at `c01fc94` for demo-selector A7, is in `evals/probes/demo-selector-2026-09-29/gate-c01fc94.log.txt` |
| Integration | <span class="badge pass">pass</span> 103/103 | `e67573c`, clean | 2026-09-29 | the same run |
| Agent suite | <span class="badge pass">pass</span> 111/111 tests in 30 files — every suite, the seventeen pattern demos among them; before it, `demos:select` wrote `selection.json`: all seventeen `no-base: no-record`, 3 repeats ([selection](index.md#selection)) | `e67573c`, clean | 2026-09-29 | the same run; each file's results in `tests/agents/results/` (`commit` `e67573c`, `dirty: false`), [report](agent-tests.html) |
| Eval | <span class="badge pass">pass</span> 24/24 | `e67573c`, clean | 2026-09-29 | the same run; no results file (debt D4) |
| Routing, the gate step (`--held-out --gate`) | <span class="badge pass">pass</span> qwen3-8b-q4_k_m 27/27 and held-out 18/18, skipped the three task-shaped cases (D30) | `e67573c` (the run prints "dirty tree": the agent suite's results files were rewritten before it) | 2026-09-29 | the same run, `.tmp/routing-gate` (not kept) |

## 2026-09-29: latest results moved from `c01fc94` to `e67573c` {#gate-c01fc94}

The gate at `e67573c`, which completes cli-interactive, replaced these rows of the [latest results](index.md#results):

| Suite | Result | Commit | When (UTC) | Source |
|---|---|---|---|---|
| Unit | <span class="badge pass">pass</span> 1943/1943 | `c01fc94`, clean | 2026-09-29 21:55–22:17 | the gate for `docs/plans/demo-selector.md` A7, `npm run check`, `EXIT=0`, from a new run-named folder holding a detached worktree of the commit (the AGENTS.md layout), log `evals/probes/demo-selector-2026-09-29/gate-c01fc94.log.txt` (its run folder's path replaced by `<scratch>`, scanned for secrets and the login name: none) |
| Integration | <span class="badge pass">pass</span> 103/103 | `c01fc94`, clean | 2026-09-29 | the same run |
| Agent suite | <span class="badge pass">pass</span> 111/111 tests in 30 files — every suite, the seventeen pattern demos among them; before it, `demos:select` wrote `selection.json`: all seventeen `no-base: no-record`, 3 repeats ([selection](index.md#selection)) | `c01fc94`, clean | 2026-09-29 | the same run; each file's results in `tests/agents/results/` (`commit` `c01fc94`, `dirty: false`), [report](agent-tests.html) |
| Eval | <span class="badge pass">pass</span> 24/24 | `c01fc94`, clean | 2026-09-29 | the same run; no results file (debt D4) |
| Routing, the gate step (`--held-out --gate`) | <span class="badge pass">pass</span> qwen3-8b-q4_k_m 27/27 and held-out 18/18, skipped the three task-shaped cases (D30) | `c01fc94` (the run prints "dirty tree": the agent suite's results files were rewritten before it) | 2026-09-29 | the same run, `.tmp/routing-gate` (not kept) |

## 2026-09-29: latest results moved from `1315ddb` to `93a30d9` {#gate-1315ddb}

The gate at `93a30d9`, which completes collaborating-agents, replaced these rows of the [latest results](index.md#results):

| Suite | Result | Commit | When (UTC) | Source |
|---|---|---|---|---|
| Unit | <span class="badge pass">pass</span> 1344/1344 | `1315ddb`, clean | 2026-09-29 12:57–13:10 | `npm run check`, `EXIT=0`, the first gate with the routing step (agent-calls R18), after `forged-identity` was removed in applying the owner's answer (log `evals/probes/agent-calls-2026-09-29/gate-done/gate-1315ddb.log.txt`, scanned: no key or token), from a new run-named folder holding a detached worktree as `<dir>/harness` beside `web`, `setup` and `PRINCIPLES.md` links (the AGENTS.md layout). The gate before, at `332667e`, was green with 1343, 75, 72 and 23 (log (`evals/probes/agent-calls-2026-09-29/gate/gate-332667e.log.txt`)) |
| Integration | <span class="badge pass">pass</span> 75/75 | `1315ddb`, clean | 2026-09-29 | the same run |
| Agent suite | <span class="badge pass">pass</span> 72/72 tests in 16 files; recorded scenarios — agent-calls 4/4 (the fan-out 25,255 ms, within B, 38,000 ms), single-agent 6/6, multi-agent 7/7, memory-agent 7/7, memory-tiers 12/12, memory-crowd 3/3 (ask-all 16,838 ms), traces 2/2 (of its 5 tests), agent-tools 7/7, egress 2/2, teams 4/4, and the five pattern demos (p01 2, p02 4, p03 2, p12 4, p22 2, each with its launch); images 1 test, unrecorded. Slowest model call 16,577 ms (memory-crowd), 28 % of the 60 s bound | `1315ddb`, clean | 2026-09-29 12:57–13:10 | `tests/agents/results/*.json` (`commit` `1315ddb`, `dirty: false`, every scenario passing), rendered in [agent-tests.html](agent-tests.html) |
| Eval | <span class="badge pass">pass</span> 23/23 | `1315ddb`, clean | 2026-09-29 | the same run; no results file (debt D4) |
| Routing, the gate step (`--held-out --gate`) | <span class="badge pass">pass</span> qwen3-8b-q4_k_m 27/27 and held-out 18/18, skipped the three task-shaped cases (D30); every request's sha256 and every attempt's actions identical to agent-calls A6's two runs at `9b6559d` | `1315ddb` (the file says `dirty: true`: the agent suite had just rewritten `tests/agents/results/`, nothing else), `version: 0.5.0 (build 11146, commit 7fe450e19)` | 2026-09-29 13:07–13:10 (about 156 s) | the same run; its file, which the step writes to `.tmp/routing-gate/`, copied to `evals/probes/agent-calls-2026-09-29/gate-done/` (`evals/probes/agent-calls-2026-09-29/README.md`) |

## 2026-09-27: latest results moved from `05555b1` to `c6bf61f` {#gate-05555b1}

The testing page's latest results named the gate at `05555b1` (recorded in `c34f38e`) long after later gates had been committed; the channel-instructions completion review found it. They now name the gate at `c6bf61f` (recorded in `fbe80be`, the latest "test results at" commit). The rows they replace:

| Suite | Result | Commit | When (UTC) | Source |
|---|---|---|---|---|
| Unit | pass 484/484 (docs guard 20/20, renderer 48) | `05555b1`, clean | 2026-09-27 | `npm run check`; count in the message of `c34f38e` |
| Integration | pass 41/41 | `05555b1`, clean | 2026-09-27 | the same run |
| Agent suite | pass 35/35 — single-agent 6/6, multi-agent 7/7, memory-agent 7/7, memory-tiers 12/12, memory-crowd 3/3 | `05555b1`, clean | 2026-09-27 16:29 – 16:33 | `tests/agents/results/*.json`, committed in `c34f38e` |
| Eval | pass 10/10 | `05555b1`, clean | 2026-09-27 | the same run |

## 2026-09-27: one gate for the whole page {#one-gate}

**Correction.** The testing page's header said its results came from the gate at `a3fe9e4`, while its tables said `2289f8c` (unit 454/454). Both were superseded: the latest committed gate results are at `05555b1` (`git log -3 -- tests/agents/results` shows `c34f38e`, "test results at 05555b1"), and every results file's `commit` field names `05555b1`, clean. The page now uses that gate throughout.

## 2026-09-27: unit count 454 → 484 {#unit-454}

`a3fe9e4` (before `tsconfig.test.ts`), then the gates at `0077584` and `2289f8c`, ran 454 unit tests in total. `decision-queue.test.ts` (30) is new since, giving 484 at `05555b1`.
