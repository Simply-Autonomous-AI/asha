---
title: Hierarchical Teams Demo
description: P7 · Hierarchical teams: A top supervisor calls sub-leads, each of which calls its own workers. Its team, how to run it, its message flow and its test.
---

# P7 · Hierarchical teams

A top supervisor calls sub-leads, each of which calls its own workers before answering.

<div class="facts"><span>written 2026-10-02</span><span>status: <span class="badge built">built</span> 2026-10-02, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/hierarchy/team.json"><code>teams/hierarchy/</code></a></span><span>test: <a href="../../tests/agents/p07-hierarchy.test.ts"><code>tests/agents/p07-hierarchy.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-3.md</code>, its runs</span></div>

> [!SUMMARY]
> - Scenario: `p07-a`, as `docs/plans/orchestration-patterns.md` specifies it.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `7198bb0` (runs (`docs/plans/patterns-phase-3.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0`: three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `top`, `lead-warm`, `lead-cool` on `qwen3-8b-q4_k_m`; `red`, `orange`, `blue`, `violet` on `pico-v2-q8_0`.
> - The two leads' recipes name `nestedCalls: true` ([nested calls](../architecture/channel.md#nested)): asked by top-1 in a call, each consults its own workers first; their answers come back to it as a gather that is a call turn answering top-1.
> - Each worker knows one colour's number, and no other file of the team holds it, so the right answer can only come through the hierarchy.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p07-hierarchy.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` and `qwen3-8b-q4_k_m` ([sidecar](videos/p07-hierarchy.json)): the portal's scene and chat as the demo's agent-suite run went, 49 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when a task splits into parts that each split again, and each part has an agent that knows how to split it: the top agent need not know the workers.

**Do not use it** when one lead can ask every worker itself (fan-out, P4; orchestrator–workers, P5), or when the parts must be done in order (pipeline, P3). Calls nest one level only: a worker asked by a lead cannot consult in turn.

## How the messages flow {#flow}

![top-1 consults lead-warm-1 and lead-cool-1; each lead, asked in a call, consults its two workers; the workers answer their numbers; each lead's gather is a call turn in which it answers top-1 with its two numbers; top-1's gather holds both, and it replies warm: 4, 7; cool: 3, 2.](p07-hierarchy.svg)

## Run it {#run}

Launch the team, then send the scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 45,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p07-a's 37,804 ms in run 3 at `6eed097` with the move, times 1.5 (56,706, over the cap, so the cap); the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 45,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-3.md` R4) — the largest request, p07-a's 34,402 ms at `65e1fab`, times 1.5 (51,603) is over the cap, so the bound is the cap, 45,000 ms.

```asha-run
./asha --launch team=hierarchy
# bound: 45000 ms
# p07-a
./asha to=top-1 user=alice message="Which numbers stand for the warm colours and for the cool colours?"
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p07-hierarchy.json`: each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p07-hierarchy.md`).

**p07-a** — exit 0, 32,555 ms:

```text
$ ./asha --verbose to=top-1 user=alice message="Which numbers stand for the warm colours and for the cool colours?"
› alice → top-1 on main: Which numbers stand for the warm colours and for the cool colours?
› top-1: ok
› internal top-1 → lead-warm-1: What are your colours' numbers?
› internal top-1 → lead-cool-1: What are your colours' numbers?
› lead-warm-1: ok
› internal lead-warm-1 → red-1: What is your number?
› internal lead-warm-1 → orange-1: What is your number?
› lead-cool-1: ok
› internal lead-cool-1 → blue-1: What is your number?
› internal lead-cool-1 → violet-1: What is your number?
› internal red-1 → lead-warm-1: 4
› internal orange-1 → lead-warm-1: 7
› internal asha → lead-warm-1: Answers to lead-warm-1's call: 2 answered.
› internal blue-1 → lead-cool-1: 3
› internal violet-1 → lead-cool-1: 2
› internal asha → lead-cool-1: Answers to lead-cool-1's call: 2 answered.
› internal lead-warm-1 → top-1: 4, 7
› internal lead-cool-1 → top-1: 3, 2
› internal asha → top-1: Answers to top-1's call: 2 answered.
› top-1: ok
› output top-1 → alice:
warm: 4, 7; cool: 3, 2
```

## The team and the test {#team}

- [`teams/hierarchy/team.json`](../../teams/hierarchy/team.json): the team — `top`, `lead-warm`, `lead-cool`, `red`, `orange`, `blue`, `violet`, launched in that order, each joining as `<name>-1`.
- Each member's recipe `<name>.json` and its guidance `<name>.md`, a full-text document in its system prompt: [`top.json`](../../teams/hierarchy/top.json), [`lead-warm.json`](../../teams/hierarchy/lead-warm.json) and [`lead-cool.json`](../../teams/hierarchy/lead-cool.json) (each with `nestedCalls: true`), [`red.json`](../../teams/hierarchy/red.json), [`orange.json`](../../teams/hierarchy/orange.json), [`blue.json`](../../teams/hierarchy/blue.json), [`violet.json`](../../teams/hierarchy/violet.json).
- [`tests/agents/p07-hierarchy.test.ts`](../../tests/agents/p07-hierarchy.test.ts): launches the team and sends the scenario's message from this page, then asserts it only through its checker, `P07_A` in [`tests/agents/patterns/phase-3.ts`](../../tests/agents/patterns/phase-3.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p07-a/`](../../tests/agents/patterns/fixtures/p07-a/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0` (demo-model-pico, 2026-10-10): its largest request took 37,804 ms in the three recorded runs and 32,555 ms in the fourth, under its bound of 45,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- Without `nestedCalls` a lead is offered no `consult` in its call turn, and cannot ask its workers (the plan's control C2, 0/3).
- Calls nest one level deep (`CALL_MAX_DEPTH` 2): the channel refuses a consult from a question of a nested call. The nested call's rules — its parent recorded, its outcomes, its close with its parent, both levels counted against the conversation's posts — are proven without a model in [`nested-calls.test.ts`](../../tests/unit/nested-calls.test.ts).
- The seven members' ten turns take about 34 s a request in its recorded runs, every turn on the one model server — over the plan's estimate of about 20 s from the probes' single turns (runs (`docs/plans/patterns-phase-3.md`)) — so its bound is R4's cap, 45,000 ms.

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P7 · Hierarchical teams](../testing/agent-tests.html#pattern-p07).
