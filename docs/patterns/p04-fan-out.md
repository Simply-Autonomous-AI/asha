---
title: Fan-Out Fan-In Demo
description: P4 · Fan-out / fan-in (scatter-gather) — one call asks many agents at once, and all their answers come back together, in one gather, to the agent that asked. Its team, how to run it, its message flow and its test.
---

# P4 · Fan-out / fan-in (scatter-gather)

One call asks many agents at once, and all their answers come back together, in one gather, to the agent that asked.

<div class="facts"><span>written 2026-09-29</span><span>status: <span class="badge built">built</span> 2026-09-29, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/rainbow/team.json"><code>teams/rainbow/</code></a></span><span>test: <a href="../../tests/agents/p04-fan-out.test.ts"><code>tests/agents/p04-fan-out.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-2.md</code></span></div>

> [!SUMMARY]
> - Scenarios: `p04-a`, as `docs/plans/orchestration-patterns.md` specifies them.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `7a0536a` (runs (`docs/plans/patterns-phase-2.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0`: three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `supervisor` on `qwen3-8b-q4_k_m`; `fact-red`, `fact-orange`, `fact-yellow`, `fact-green`, `fact-blue`, `fact-indigo`, `fact-violet`, `fact-pink`, `fact-brown` on `pico-v2-q8_0`.
> - The team is the rainbow of `docs/plans/collaborating-agents.md`: ten agents, a supervisor and nine members that each know one number and its colour; it passed three recorded runs and one under its bound there (runs (`docs/plans/collaborating-agents.md`)).

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p04-fan-out.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` and `qwen3-8b-q4_k_m` ([sidecar](videos/p04-fan-out.json)): the portal's scene and chat as the demo's agent-suite run went, 59 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when one agent needs a piece of information from each of many agents and must combine them: the questions go out at once and the answers arrive in one turn, so the combining agent never has to remember an answer between turns.

**Do not use it** when each step needs the one before (a pipeline, P3), or when the parts differ in kind and the lead must choose who does what (orchestrator–workers, P5).

## How the messages flow {#flow}

![supervisor-1 consults the nine fact members in one call; their nine answers go back to it only, as one gather; it replies with the rainbow's numbers.](p04-fan-out.svg)

## Run it {#run}

Launch the team, then send a scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 45,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p04-a's 37,076 ms in run 2 at `6eed097` with the move, times 1.5 (55,614, over the cap, so the cap); the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 45,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-2.md` R4) — the largest request, p04-a's 38,769 ms at `245104c`, times 1.5 (58,154, over the cap, so the cap), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=rainbow
# bound: 45000 ms
# p04-a
./asha to=supervisor-1 user=alice message="Which sequence of the numbers lists their colours in rainbow order?"
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p04-fan-out.json`: each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p04-fan-out.md`).

**p04-a** — exit 0, 35,668 ms:

```text
$ ./asha --verbose to=supervisor-1 user=alice message="Which sequence of the numbers lists their colours in rainbow order?"
› alice → supervisor-1 on main: Which sequence of the numbers lists their colours in rainbow order?
› supervisor-1: ok
› internal supervisor-1 → fact-blue-1: What number and colour do you know?
› internal supervisor-1 → fact-brown-1: What number and colour do you know?
› internal supervisor-1 → fact-green-1: What number and colour do you know?
› internal supervisor-1 → fact-indigo-1: What number and colour do you know?
› internal supervisor-1 → fact-orange-1: What number and colour do you know?
› internal supervisor-1 → fact-pink-1: What number and colour do you know?
› internal supervisor-1 → fact-red-1: What number and colour do you know?
› internal supervisor-1 → fact-violet-1: What number and colour do you know?
› internal supervisor-1 → fact-yellow-1: What number and colour do you know?
› internal fact-violet-1 → supervisor-1: I know the number 2 stands for the colour violet.
› internal fact-red-1 → supervisor-1: I know the number 4 stands for the colour red.
› internal fact-brown-1 → supervisor-1: I know the number 8 stands for the colour brown.
› internal fact-pink-1 → supervisor-1: I know the number 5 stands for the colour pink.
› internal fact-green-1 → supervisor-1: I know the number 9 stands for the colour green.
› internal fact-yellow-1 → supervisor-1: I know the number 1 stands for the colour yellow.
› internal fact-indigo-1 → supervisor-1: I know the number 6 stands for the colour indigo.
› internal fact-blue-1 → supervisor-1: I know the number 3 stands for the colour blue.
› internal fact-orange-1 → supervisor-1: I know the number 7 stands for the colour orange.
› internal asha → supervisor-1: Answers to supervisor-1's call: 9 answered.
› supervisor-1: ok
› output supervisor-1 → alice:
The sequence of numbers that lists their colours in rainbow order is: red (4), orange (7), yellow (1), green (9), blue (3), indigo (6), violet (2).
```

## The team and the test {#team}

- [`teams/rainbow/team.json`](../../teams/rainbow/team.json): the team — `supervisor`, `fact-red`, `fact-orange`, `fact-yellow`, `fact-green`, `fact-blue`, `fact-indigo`, `fact-violet`, `fact-pink`, `fact-brown`, launched in that order, each joining as `<name>-1`.
- `supervisor`: [`supervisor.json`](../../teams/rainbow/supervisor.json), its recipe, and [`supervisor.md`](../../teams/rainbow/supervisor.md), its guidance, a full-text document in its system prompt.
- `fact-red`: [`fact-red.json`](../../teams/rainbow/fact-red.json), its recipe, and [`fact-red.md`](../../teams/rainbow/fact-red.md), its guidance, a full-text document in its system prompt.
- `fact-orange`: [`fact-orange.json`](../../teams/rainbow/fact-orange.json), its recipe, and [`fact-orange.md`](../../teams/rainbow/fact-orange.md), its guidance, a full-text document in its system prompt.
- `fact-yellow`: [`fact-yellow.json`](../../teams/rainbow/fact-yellow.json), its recipe, and [`fact-yellow.md`](../../teams/rainbow/fact-yellow.md), its guidance, a full-text document in its system prompt.
- `fact-green`: [`fact-green.json`](../../teams/rainbow/fact-green.json), its recipe, and [`fact-green.md`](../../teams/rainbow/fact-green.md), its guidance, a full-text document in its system prompt.
- `fact-blue`: [`fact-blue.json`](../../teams/rainbow/fact-blue.json), its recipe, and [`fact-blue.md`](../../teams/rainbow/fact-blue.md), its guidance, a full-text document in its system prompt.
- `fact-indigo`: [`fact-indigo.json`](../../teams/rainbow/fact-indigo.json), its recipe, and [`fact-indigo.md`](../../teams/rainbow/fact-indigo.md), its guidance, a full-text document in its system prompt.
- `fact-violet`: [`fact-violet.json`](../../teams/rainbow/fact-violet.json), its recipe, and [`fact-violet.md`](../../teams/rainbow/fact-violet.md), its guidance, a full-text document in its system prompt.
- `fact-pink`: [`fact-pink.json`](../../teams/rainbow/fact-pink.json), its recipe, and [`fact-pink.md`](../../teams/rainbow/fact-pink.md), its guidance, a full-text document in its system prompt.
- `fact-brown`: [`fact-brown.json`](../../teams/rainbow/fact-brown.json), its recipe, and [`fact-brown.md`](../../teams/rainbow/fact-brown.md), its guidance, a full-text document in its system prompt.
- [`tests/agents/p04-fan-out.test.ts`](../../tests/agents/p04-fan-out.test.ts): launches the team and sends each scenario's message from this page, then asserts each scenario only through its checker, `P04_A` in [`tests/agents/patterns/rainbow.ts`](../../tests/agents/patterns/rainbow.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p04-a/`](../../tests/agents/patterns/fixtures/p04-a/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0` (demo-model-pico, 2026-10-10): its largest request took 37,076 ms in the three recorded runs and 35,668 ms in the fourth, under its bound of 45,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- The supervisor's first guidance, "order the rest as the rainbow does", failed on `qwen3-8b-q4_k_m`; an explicit colour-by-colour lookup passed (D37, paid; runs (`docs/plans/collaborating-agents.md`)).
- Nine questions share four model-server slots, so the last waits for a slot while its delivery bound runs; every recipe's `messageTimeoutMs` is 51,000 ms, twice the longest delivery measured (collaborating-agents R13). The request took 36,941–38,137 ms in its recorded runs, under the 45,000 ms cap.

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P4 · Fan-out / fan-in (scatter-gather)](../testing/agent-tests.html#pattern-p04).
