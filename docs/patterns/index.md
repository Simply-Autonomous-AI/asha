---
title: Pattern Demos
description: The catalogue of multi-agent orchestration, supervision and collaboration patterns asha demonstrates — one runnable, tested, documented demo per pattern — with each one's status.
---

# Pattern demos

asha is to demonstrate every significant pattern for orchestrating, supervising and letting agents collaborate (AGENTS.md objective 2): 26 patterns, each a team of agents in its own folder that you launch with one command and talk to with another, proven by its own agent-suite file and explained on its own page.

<div class="facts"><span>verified 2026-10-03</span><span>catalogue: <code>docs/plans/orchestration-patterns.md</code>, confirmed by the owner 2026-09-27</span><span>teams: <code>teams/&lt;team&gt;/</code> (<a href="../architecture/recipes.md#team">spec</a>)</span><span>coverage: <a href="../testing/index.md#patterns">Testing, pattern demos</a></span></div>

> [!SUMMARY]
> - **Twenty-five are built** (2026-10-03, [checkpoint and resume](p20-resume.md) the latest; *corrected 2026-10-03: this said seventeen, as of 2026-09-29, after phase 3 had built six more on 2026-10-02*); only propagating cancellation (`docs/plans/orchestration-patterns.md`), P26, is not: a pattern is built once its demo passes three recorded runs on the models its recipes name and one under its bound, has its page here, and is listed in the demo manifest (`tests/agents/patterns/demos.json`). Each page's models line names them: every member on `qwen3-8b-q4_k_m`, or, in 18 demos since 2026-10-10, the routers on it and the sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md`); *corrected 2026-10-10: this said "on the pinned model", true while every recipe named one.*
> - The first five — [delegation](p01-delegation.md), [router](p02-router.md), [sequential pipeline](p03-pipeline.md), [self-selection](p12-self-selection.md) and [escalation's summary](p22-escalation.md) — are built: each page has its commands, its bound and a real transcript (`docs/plans/patterns-phase-1.md`).
> - Of phase 2, [agent as tool](p18-agent-tool.md), [fan-out / fan-in](p04-fan-out.md), [orchestrator–workers](p05-orchestrator-workers.md) and [voting](p10-voting.md) are built, and so are the other eight — [debate](p09-debate.md), [iterative consensus](p23-consensus.md), [managed group chat](p24-group-chat.md), [generator–critic](p08-critic-loop.md), [guardrail](p16-guardrail.md), [contract net](p13-contract-net.md), [plan-and-execute](p06-plan-execute.md) and [watchdog](p14-watchdog.md) — green in three recorded runs and one under their bounds, P23, P24, P8, P16 and P6 after R6's remedies (`docs/plans/patterns-phase-2.md`), and listed once the [demo selector](../testing/index.md#selection) was built.
> - The twelve of phase 2 are each built on a call and its gather: team, page, checker and test written without a model, then proven by their recorded runs with every member on `qwen3-8b-q4_k_m` (`docs/plans/patterns-phase-2.md`); eight of them (P4, P5, P6, P8, P10, P13, P14, P18) later moved their sub-agents to `pico-v2-q8_0` (demo-model-pico).
> - Every other pattern's team and test scenarios are specified in `docs/plans/orchestration-patterns.md`.
> - Of phase 4, the [blackboard](p11-blackboard.md) is built: the shopping list each contributor adds to, and a meeting notice each member reads from the board and extends (`docs/plans/patterns-phase-4.md`).
> - P17 is a harness control — a budget the harness enforces — not a way agents collaborate.

> [!NOTE]
> **Renumbered 2026-10-16.** At the owner's request the supervisor-restart demo moved to the end of the demos, and the twelve after it moved up one (`docs/plans/demo-scene-refresh.md` R9). Every page, plan, suite and file here uses the new numbers; commit messages, probe records under `evals/probes/`, decision records and the routing eval's results before that date use the old:
>
> | Before 2026-10-16 | Since |
> |---|---|
> | P14 Supervisor restart | **P25** |
> | P15–P25 (Watchdog … Managed group chat) | P14–P24, each one lower |
> | P1–P13, P26 | unchanged |

## Watch them run {#watch}

**[Watch the combined video](https://simplyautonomous.ai/asha/demo.mp4)** on the [SimplyAutonomous.AI website](https://simplyautonomous.ai/#asha), with music — a link, since these pages load nothing from the network. The website keeps it, and it changes there with each new recording (the owner's answer to `demo-reel-mp4`, 2026-10-17). As of 2026-10-17 it plays the opening page, then every demo but [P25](p25-restart.md) (supervisor restart, left out at the owner's word, 2026-10-16) in catalogue order — each after a card naming it and its purpose, shown long enough to read, played at twice its speed and its last frame held 3 s — then the end page. The reel it was cut from is recorded in its [sidecar](videos/demos.json). Each demo's own video is on its page, and here: [P1](videos/p01-delegation.webm) · [P2](videos/p02-router.webm) · [P3](videos/p03-pipeline.webm) · [P4](videos/p04-fan-out.webm) · [P5](videos/p05-orchestrator-workers.webm) · [P6](videos/p06-plan-execute.webm) · [P7](videos/p07-hierarchy.webm) · [P8](videos/p08-critic-loop.webm) · [P9](videos/p09-debate.webm) · [P10](videos/p10-voting.webm) · [P11](videos/p11-blackboard.webm) · [P12](videos/p12-self-selection.webm) · [P13](videos/p13-contract-net.webm) · [P14](videos/p14-watchdog.webm) · [P15](videos/p15-approval.webm) · [P16](videos/p16-guardrail.webm) · [P17](videos/p17-budget.webm) · [P18](videos/p18-agent-tool.webm) · [P19](videos/p19-spawning.webm) · [P20](videos/p20-resume.webm) · [P21](videos/p21-topics.webm) · [P22](videos/p22-escalation.webm) · [P23](videos/p23-consensus.webm) · [P24](videos/p24-group-chat.webm) · [P25](videos/p25-restart.webm).

## How a demo runs {#run}

Every demo is a team folder, `teams/<team>/`: its `team.json`, each member's recipe, and each member's guidance, a numbered workflow in Markdown that is part of its system prompt ([team](../architecture/recipes.md#team)). You run it with two commands — `./asha --launch team=<team>`, then `./asha to=<handle> message="…"` to one member (or without `to=`, to everyone) — exactly as its page's run-command block gives them; the page's commands are the ones its test runs. The block is marked `asha-run`: its first line is the team's launch, its second the pattern's bound on a request (`# bound: <ms> ms`), then each scenario's id (`# pNN-x`) and its command — or its commands, run in order, a later one naming `conversation=@previous`, which the suite fills with the conversation id of the scenario's command before it (an answer into the same conversation; `docs/plans/patterns-phase-3.md` R9). A scenario may also stop the daemon, `./asha --stop`, and launch a team again, `./asha --launch team=<team>` — exactly these forms — as [P20](p20-resume.md)'s do (`docs/plans/patterns-phase-5.md` R8).

Its agent-suite file, `tests/agents/pNN-<slug>.test.ts`, runs exactly the commands on its page, and every assertion of its proof is one checker, unit-tested on fixtures that each break one claim ([Testing](../testing/index.md#patterns)).

## The catalogue {#catalogue}

Status: **built** (its demo passes and its page is linked here), or **planned**, a badge linking the plan that specifies its team and scenarios.

| # | Pattern | Family | What it shows | Team | Status |
|---|---|---|---|---|---|
| P1 | [Delegation (hand-off)](p01-delegation.md) | orchestration | A lead hands a task to one agent, which answers the user itself. | [`teams/delegation/`](../../teams/delegation/team.json) | <span class="badge built">built</span> at `f64eadf` |
| P2 | [Router (triage)](p02-router.md) | orchestration | A router sends each request to the one specialist whose description covers it. | [`teams/router/`](../../teams/router/team.json) | <span class="badge built">built</span> at `f64eadf` |
| P3 | [Sequential pipeline](p03-pipeline.md) | orchestration | Each stage adds its part and hands the result to the next; the last replies. | [`teams/pipeline/`](../../teams/pipeline/team.json) | <span class="badge built">built</span> at `f64eadf` |
| P4 | [Fan-out / fan-in (scatter-gather)](p04-fan-out.md) | orchestration | One call asks many agents at once; their answers come back together. | [`teams/rainbow/`](../../teams/rainbow/team.json) | <span class="badge built">built</span> at `7a0536a` |
| P5 | [Orchestrator–workers](p05-orchestrator-workers.md) | orchestration | A lead splits a request into parts and gives each to the worker that does it. | [`teams/orchestrator/`](../../teams/orchestrator/team.json) | <span class="badge built">built</span> at `8745b1a` |
| P6 | [Plan-and-execute with simulated failure, re-plan, task and progress ledgers](p06-plan-execute.md) | orchestration | A planner keeps a plan and a progress ledger, and re-plans when a step stalls. | [`teams/plan-execute/`](../../teams/plan-execute/team.json) | <span class="badge built">built</span> at `3e2b8cd` |
| P7 | [Hierarchical teams](p07-hierarchy.md) | orchestration | A top supervisor calls sub-leads, each calling its own workers. | [`teams/hierarchy/`](../../teams/hierarchy/team.json) | <span class="badge built">built</span> at `7198bb0` |
| P8 | [Generator–critic loop](p08-critic-loop.md) | collaboration | A draft is critiqued and revised until accepted, within a bound. | [`teams/critic-loop/`](../../teams/critic-loop/team.json) | <span class="badge built">built</span> at `c929f30` |
| P9 | [Debate with a judge](p09-debate.md) | collaboration | Two debaters argue assigned stances; a judge gives the verdict. | [`teams/debate/`](../../teams/debate/team.json) | <span class="badge built">built</span> at `86bbeaf` |
| P10 | [Voting / ensemble](p10-voting.md) | collaboration | Several voters answer independently; an aggregator reports the majority. | [`teams/vote/`](../../teams/vote/team.json) | <span class="badge built">built</span> at `0f047be` |
| P11 | [Blackboard](p11-blackboard.md) | collaboration | Agents post to a shared board and build on each other's entries; the answer is assembled from it. | [`teams/blackboard/`](../../teams/blackboard/team.json) | <span class="badge built">built</span> at `d06bd2b` |
| P12 | [Group chat, self-selection](p12-self-selection.md) | collaboration | A message goes to everyone; only agents whose role covers it act. | [`teams/self-select/`](../../teams/self-select/team.json) | <span class="badge built">built</span> at `f64eadf` |
| P13 | [Contract net (bidding)](p13-contract-net.md) | collaboration | Agents bid for a task; it is awarded to one bidder. | [`teams/contract-net/`](../../teams/contract-net/team.json) | <span class="badge built">built</span> at `98f62be` |
| P14 | [Watchdog and reassignment](p14-watchdog.md) | supervision | A stalled worker is stopped and its task given to another. | [`teams/watchdog/`](../../teams/watchdog/team.json) | <span class="badge built">built</span> at `3d3ee52` |
| P15 | [Human approval gate](p15-approval.md) | supervision | An agent waits for the user's approval before a consequential step. | [`teams/approval/`](../../teams/approval/team.json) | <span class="badge built">built</span> at `b8fe251` |
| P16 | [Guardrail / policy check](p16-guardrail.md) | supervision | Every reply is approved by a policy agent first. | [`teams/guardrail/`](../../teams/guardrail/team.json) | <span class="badge built">built</span> at `e5f1b20` |
| P17 | [Budgets and circuit breaker](p17-budget.md) | **harness control**, not a collaboration pattern | A conversation past its post or token budget ends with a budget error. | [`teams/budget/`](../../teams/budget/team.json) | <span class="badge built">built</span> at `95e3bab` |
| P18 | [Agent as tool (call and return)](p18-agent-tool.md) | orchestration | An agent consults another and answers the user itself. | [`teams/agent-tool/`](../../teams/agent-tool/team.json) | <span class="badge built">built</span> at `c1b4069` |
| P19 | [Dynamic spawning of workers](p19-spawning.md) | orchestration | A lead brings a new worker online and calls it. | [`teams/spawner/`](../../teams/spawner/team.json) | <span class="badge built">built</span> at `2168282` |
| P20 | [Checkpoint and resume](p20-resume.md) | supervision | A conversation survives a daemon restart and completes; a long-running supervisor finishes its tasks after one. | [`teams/resume/`](../../teams/resume/team.json) | <span class="badge built">built</span> at `b0a4ea3` |
| P21 | [Publish / subscribe (topic routing)](p21-topics.md) | collaboration | A message to a topic reaches exactly its subscribers. | [`teams/topics/`](../../teams/topics/team.json) | <span class="badge built">built</span> at `0ed2808` |
| P22 | [Escalation to a human](p22-escalation.md) | supervision | An agent that cannot finish hands the conversation to the user with a summary. | [`teams/escalation/`](../../teams/escalation/team.json) | <span class="badge built">built</span> p22-a, the summary; p22-b, the take-over, at `01184ad` |
| P23 | [Iterative consensus debate](p23-consensus.md) | collaboration | Debaters revise their answers over rounds until they agree. | [`teams/consensus/`](../../teams/consensus/team.json) | <span class="badge built">built</span> at `e82c5e4` |
| P24 | [Managed group chat](p24-group-chat.md) | collaboration | A manager chooses who speaks next (the selector's later choices named in the answers, on the pinned model). | [`teams/group-chat/`](../../teams/group-chat/team.json) | <span class="badge built">built</span> at `e50be16` |
| P25 | [Supervisor restart](p25-restart.md) | supervision | A killed agent is restarted under its handle, at most R times in T seconds. | [`teams/restart/`](../../teams/restart/team.json) | <span class="badge built">built</span> at `0fe982a` |
| P26 | Propagating cancellation | supervision | A cancel stops every open call and tool call of a conversation. | `cancel` | <span class="badge planned">planned: orchestration-patterns</span> |
