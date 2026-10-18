---
title: Budgets Demo
description: P17 · Budgets and circuit breaker — a conversation that would run for ever is ended by its post or token budget, given on its message; every agent post in it afterwards is refused. A harness control, not a collaboration pattern. Its team, how to run it, its message flow and its test.
---

# P17 · Budgets and circuit breaker

A conversation that would run for ever is ended by its post or token budget, given on its message; every agent post in it afterwards is refused. A harness control, not a collaboration pattern.

<div class="facts"><span>written 2026-10-02</span><span>status: <span class="badge built">built</span> 2026-10-02, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/budget/team.json"><code>teams/budget/</code></a></span><span>test: <a href="../../tests/agents/p17-budget.test.ts"><code>tests/agents/p17-budget.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-3.md</code>, its runs</span></div>

> [!SUMMARY]
> - Scenarios: `p17-a` (a post budget) and `p17-b` (a token budget), as `docs/plans/orchestration-patterns.md` specifies them.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `95e3bab` (runs (`docs/plans/patterns-phase-3.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with every member on `pico-v2-q8_0` (it has no router): three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `ping`, `pong` on `pico-v2-q8_0`.
> - The budget is the message's, on its command: `posts=8` (1 to 32; 32 without it) and `tokens=6000` (1 to 1,000,000; none without it). The post past it, or the model call that takes the tokens past it, ends the conversation `budget_exceeded` ([the end of a conversation](../architecture/channel.md#ended)).
> - `ping` and `pong` are built never to stop: each answers every message by messaging the other.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p17-budget.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` ([sidecar](videos/p17-budget.json)): the portal's scene and chat as the demo's agent-suite run went, 27 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when agents that hand work to each other could loop, and a conversation must stop at a known size or cost, whatever the agents decide.

**Do not use it** to stop one slow agent (watchdog, P14) or to end a conversation on the user's word (propagating cancellation, P26).

## How the messages flow {#flow}

![p17-a: ping-1 and pong-1 send ping and pong to each other; the eighth post is the budget's last; the ninth is refused, the conversation ends budget_exceeded, and the user's command prints the error. p17-b: the same with a budget of 6,000 tokens, ended after the call that passes it.](p17-budget.svg)

## Run it {#run}

Launch the team, then send a scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 23,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p17-a's 15,272 ms in run 2 at `6eed097` with the move, times 1.5 (22,908), rounded up to a whole second; the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 21,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-3.md` R4) — the largest request, p17-a's 13,996 ms at `f38bbfa`, times 1.5 (20,994), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=budget
# bound: 23000 ms
# p17-a
./asha to=ping-1 posts=8 user=alice message="Start."
# p17-b
./asha to=ping-1 tokens=6000 user=alice message="Start."
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `p17-budget.json` (`evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p18-budget.json`): each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p17-budget.md`).

**p17-a** — exit 1, 14,746 ms:

```text
$ ./asha --verbose to=ping-1 posts=8 user=alice message="Start."
› alice → ping-1 on main: Start.
› ping-1: ok
› internal ping-1 → pong-1: ping
› pong-1: ok
› internal pong-1 → ping-1: pong
› ping-1: ok
› internal ping-1 → pong-1: ping
› pong-1: ok
› internal pong-1 → ping-1: pong
› ping-1: ok
› internal ping-1 → pong-1: ping
› pong-1: ok
› internal pong-1 → ping-1: pong
› ping-1: ok
› internal ping-1 → pong-1: ping
› pong-1: ok
› internal pong-1 → ping-1: pong
› ping-1: ok
✗ budget_exceeded: conversation 039208e25279a41a reached its budget of 8 agent posts
```

**p17-b** — exit 1, 3,153 ms:

```text
$ ./asha --verbose to=ping-1 tokens=6000 user=alice message="Start."
› alice → ping-1 on main: Start.
› ping-1: ok
› internal ping-1 → pong-1: ping
› pong-1: ok
› internal pong-1 → ping-1: pong
› ping-1: ok
› internal ping-1 → pong-1: ping
✗ budget_exceeded: conversation 2288a2f6be669d78 used 6891 tokens of its budget of 6000
```

## The team and the test {#team}

- [`teams/budget/team.json`](../../teams/budget/team.json): the team — `ping`, `pong`, launched in that order, each joining as `<name>-1`.
- `ping`: [`ping.json`](../../teams/budget/ping.json), its recipe, and [`ping.md`](../../teams/budget/ping.md), its guidance, a full-text document in its system prompt.
- `pong`: [`pong.json`](../../teams/budget/pong.json), its recipe, and [`pong.md`](../../teams/budget/pong.md), its guidance.
- [`tests/agents/p17-budget.test.ts`](../../tests/agents/p17-budget.test.ts): launches the team and sends each scenario's message from this page, then asserts each scenario only through its checker, `P17_A` and `P17_B` in [`tests/agents/patterns/phase-3.ts`](../../tests/agents/patterns/phase-3.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p17-a/`](../../tests/agents/patterns/fixtures/p17-a/pass.json) and [`p17-b/`](../../tests/agents/patterns/fixtures/p17-b/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With every member on `pico-v2-q8_0` (it has no router) (demo-model-pico, 2026-10-10): its largest request took 15,272 ms in the three recorded runs and 14,746 ms in the fourth, under its bound of 23,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- The budget does not depend on the model: the harness counts the posts and the tokens. The model only has to keep the loop going, which the probes showed it does, 3/3 for each turn (`docs/plans/patterns-phase-3.md`).
- A token count is known only once a call ends, so the call that passes the budget is served, its result returned to its agent, and only its post is refused. Each ping or pong call costs about 1,800 tokens (the probes), so 6,000 ends p17-b at the fourth call.
- The refused agent's turn ends there, logged `post.refused` in its own log, and the agent stays online for the next message.

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P17 · Budgets and circuit breaker](../testing/agent-tests.html#pattern-p17).
