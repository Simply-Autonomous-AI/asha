---
title: Agent As Tool Demo
description: P18 · Agent as tool (call and return) — an agent uses another agent as a tool; it consults it, gets the answer back, and answers the user itself. Its team, how to run it, its message flow and its test.
---

# P18 · Agent as tool (call and return)

An agent uses another agent as a tool: it consults it, gets the answer back, and answers the user itself.

<div class="facts"><span>written 2026-09-29</span><span>status: <span class="badge built">built</span> 2026-09-29, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/agent-tool/team.json"><code>teams/agent-tool/</code></a></span><span>test: <a href="../../tests/agents/p18-agent-tool.test.ts"><code>tests/agents/p18-agent-tool.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-2.md</code></span></div>

> [!SUMMARY]
> - Scenarios: `p18-a`, as `docs/plans/orchestration-patterns.md` specifies them.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `c1b4069` (runs (`docs/plans/patterns-phase-2.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0`: three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `delegator` on `qwen3-8b-q4_k_m`; `worker` on `pico-v2-q8_0`.
> - The delegator keeps the conversation: unlike delegation (P1), the worker never answers the user.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p18-agent-tool.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` and `qwen3-8b-q4_k_m` ([sidecar](videos/p18-agent-tool.json)): the portal's scene and chat as the demo's agent-suite run went, 19 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when one agent must use another agent's result in its own answer — a lookup, a check, a sub-answer — and stay the one the user talks to.

**Do not use it** when the other agent can answer the user directly (delegation, P1, is one message fewer), or when several agents are needed at once (fan-out, P4).

## How the messages flow {#flow}

![The delegator consults worker-1 with one call; worker-1's answer goes back to the delegator only, in one gather from the harness; the delegator replies to you.](p18-agent-tool.svg)

## Run it {#run}

Launch the team, then send a scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 15,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p18-a's 9,475 ms in run 3 at `6eed097` with the move, times 1.5 (14,212.5), rounded up to a whole second; the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 14,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-2.md` R4) — the largest request, p18-a's 8,813 ms at `30226b1`, times 1.5 (13,220), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=agent-tool
# bound: 15000 ms
# p18-a
./asha to=delegator-1 user=alice message="Get worker-1 to say Hello World, then tell me yourself what it said."
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `p18-agent-tool.json` (`evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p19-agent-tool.json`): each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p18-agent-tool.md`).

**p18-a** — exit 0, 8,664 ms:

```text
$ ./asha --verbose to=delegator-1 user=alice message="Get worker-1 to say Hello World, then tell me yourself what it said."
› alice → delegator-1 on main: Get worker-1 to say Hello World, then tell me yourself what it said.
› delegator-1: ok
› internal delegator-1 → worker-1: Say: Hello World
› internal worker-1 → delegator-1: Hello World
› internal asha → delegator-1: Answers to delegator-1's call: 1 answered.
› delegator-1: ok
› output delegator-1 → alice:
worker-1 said: Hello World
```

## The team and the test {#team}

- [`teams/agent-tool/team.json`](../../teams/agent-tool/team.json): the team — `delegator`, `worker`, launched in that order, each joining as `<name>-1`.
- `delegator`: [`delegator.json`](../../teams/agent-tool/delegator.json), its recipe, and [`delegator.md`](../../teams/agent-tool/delegator.md), its guidance, a full-text document in its system prompt.
- `worker`: [`worker.json`](../../teams/agent-tool/worker.json), its recipe, and [`worker.md`](../../teams/agent-tool/worker.md), its guidance, a full-text document in its system prompt.
- [`tests/agents/p18-agent-tool.test.ts`](../../tests/agents/p18-agent-tool.test.ts): launches the team and sends each scenario's message from this page, then asserts each scenario only through its checker, `P18_A` in [`tests/agents/patterns/phase-2.ts`](../../tests/agents/patterns/phase-2.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p18-a/`](../../tests/agents/patterns/fixtures/p18-a/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0` (demo-model-pico, 2026-10-10): its largest request took 9,475 ms in the three recorded runs and 8,664 ms in the fourth, under its bound of 15,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- `qwen3-8b-q4_k_m` hands a task-shaped "do it, then tell me yourself" request to the other agent instead of consulting it (D30); the delegator's guidance tells it to consult, as the owner directed. Run once with that guidance emptied (2026-09-29, `docs/plans/patterns-phase-2.md` A8), the delegator handed the request to worker-1 with `send_message` and worker-1 answered the user: it is the guidance that makes the difference.
- The delegator's guidance says to pass the user's words on word for word; in the probes it wrote them as an instruction instead, "Say: Hello World", 3 of 3 — the worker answers the same. Measured in the premise probes (2026-09-29, `0be190f`), its chain of model turns took 8.7 s with cold prompts and 1.7 s warm (`docs/plans/patterns-phase-2.md`).

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P18 · Agent as tool (call and return)](../testing/agent-tests.html#pattern-p18).
