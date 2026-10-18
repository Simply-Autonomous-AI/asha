---
title: Orchestrator Workers Demo
description: P5 · Orchestrator–workers: A lead splits a request into parts and gives each part to the worker whose description covers it, then combines their results. Its team, how to run it, its message flow and its test.
---

# P5 · Orchestrator–workers

A lead splits a request into parts and gives each part to the worker whose description covers it, then combines their results.

<div class="facts"><span>written 2026-09-29</span><span>status: <span class="badge built">built</span> 2026-09-29, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/orchestrator/team.json"><code>teams/orchestrator/</code></a></span><span>test: <a href="../../tests/agents/p05-orchestrator-workers.test.ts"><code>tests/agents/p05-orchestrator-workers.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-2.md</code></span></div>

> [!SUMMARY]
> - Scenarios: `p05-a`, as `docs/plans/orchestration-patterns.md` specifies them.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `8745b1a` (runs (`docs/plans/patterns-phase-2.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0`: three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `lead` on `qwen3-8b-q4_k_m`; `worker-a`, `worker-b`, `worker-c` on `pico-v2-q8_0`.
> - The workers have neutral names, so the lead chooses each part's worker only from the descriptions `list_agents` reports; its recipe names none of them, and the proof checks that.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p05-orchestrator-workers.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` and `qwen3-8b-q4_k_m` ([sidecar](videos/p05-orchestrator-workers.json)): the portal's scene and chat as the demo's agent-suite run went, 29 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when one request holds several different kinds of work, each with a specialist, and the answer must combine them.

**Do not use it** when every agent gets the same question (fan-out, P4, or voting, P10), or when one request needs only one specialist (router, P2).

## How the messages flow {#flow}

![lead-1 reads the workers' descriptions, consults each with only its part in one call, gets the three answers in one gather, and replies with three lines.](p05-orchestrator-workers.svg)

## Run it {#run}

Launch the team, then send a scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 27,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p05-a's 17,503 ms in run 1 at `6eed097` with the move, times 1.5 (26,254.5), rounded up to a whole second; the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 27,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-2.md` R4) — the largest request, p05-a's 17,775 ms at `1a4605c`, times 1.5 (26,663), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=orchestrator
# bound: 27000 ms
# p05-a
./asha to=lead-1 user=alice message="Please do three things: translate 'thank you' into French, add 17 and 25, and say Hello World."
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p05-orchestrator-workers.json`: each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p05-orchestrator-workers.md`).

**p05-a** — exit 0, 15,692 ms:

```text
$ ./asha --verbose to=lead-1 user=alice message="Please do three things: translate 'thank you' into French, add 17 and 25, and say Hello World."
› alice → lead-1 on main: Please do three things: translate 'thank you' into French, add 17 and 25, and say Hello World.
› lead-1: ok
› internal lead-1 → worker-a-1: Translate 'thank you' into French.
› internal lead-1 → worker-b-1: Add 17 and 25.
› internal lead-1 → worker-c-1: Say: Hello World.
› internal worker-b-1 → lead-1: 42
› internal worker-c-1 → lead-1: Hello World.
› internal worker-a-1 → lead-1: merci
› internal asha → lead-1: Answers to lead-1's call: 3 answered.
› lead-1: ok
› output lead-1 → alice:
The results are:
1. Translation: merci
2. Addition: 42
3. Message: Hello World.
```

## The team and the test {#team}

- [`teams/orchestrator/team.json`](../../teams/orchestrator/team.json): the team — `lead`, `worker-a`, `worker-b`, `worker-c`, launched in that order, each joining as `<name>-1`.
- `lead`: [`lead.json`](../../teams/orchestrator/lead.json), its recipe, and [`lead.md`](../../teams/orchestrator/lead.md), its guidance, a full-text document in its system prompt.
- `worker-a`: [`worker-a.json`](../../teams/orchestrator/worker-a.json), its recipe, and [`worker-a.md`](../../teams/orchestrator/worker-a.md), its guidance, a full-text document in its system prompt.
- `worker-b`: [`worker-b.json`](../../teams/orchestrator/worker-b.json), its recipe, and [`worker-b.md`](../../teams/orchestrator/worker-b.md), its guidance, a full-text document in its system prompt.
- `worker-c`: [`worker-c.json`](../../teams/orchestrator/worker-c.json), its recipe, and [`worker-c.md`](../../teams/orchestrator/worker-c.md), its guidance, a full-text document in its system prompt.
- [`tests/agents/p05-orchestrator-workers.test.ts`](../../tests/agents/p05-orchestrator-workers.test.ts): launches the team and sends each scenario's message from this page, then asserts each scenario only through its checker, `P05_A` in [`tests/agents/patterns/phase-2.ts`](../../tests/agents/patterns/phase-2.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p05-a/`](../../tests/agents/patterns/fixtures/p05-a/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0` (demo-model-pico, 2026-10-10): its largest request took 17,503 ms in the three recorded runs and 15,692 ms in the fourth, under its bound of 27,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- Measured in the premise probes (2026-09-29, `0be190f`), its chain of model turns took 11.0 s with cold prompts and 3.9 s warm (`docs/plans/patterns-phase-2.md`); the three workers answer in parallel.
- The split is the model's: a lead that sends each worker the whole request, or a part to the wrong worker, fails the proof, which checks each question's words.

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P5 · Orchestrator–workers](../testing/agent-tests.html#pattern-p05).
