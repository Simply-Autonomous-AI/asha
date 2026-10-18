---
title: Router Pattern Demo
description: P2 · Router (triage) — a router reads every agent's description and sends each request to the one specialist whose description covers it. Its team, how to run it, its message flow and its test.
---

# P2 · Router (triage)

A router reads every agent's description and sends each request to the one specialist whose description covers it. It never answers a request itself.

<div class="facts"><span>written 2026-09-29</span><span>status: <span class="badge built">built</span> 2026-09-29, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/router/team.json"><code>teams/router/</code></a></span><span>test: <a href="../../tests/agents/p02-router.test.ts"><code>tests/agents/p02-router.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-1.md</code>, its runs</span></div>

> [!SUMMARY]
> - Scenarios: `p02-a`, `p02-b`, `p02-c`, as `docs/plans/orchestration-patterns.md` specifies them.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set (runs (`docs/plans/patterns-phase-1.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0`: three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `router` on `qwen3-8b-q4_k_m`; `desk-a`, `desk-b`, `desk-c` on `pico-v2-q8_0`.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p02-router.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` and `qwen3-8b-q4_k_m` ([sidecar](videos/p02-router.json)): the portal's scene and chat as the demo's agent-suite run went, 35 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when requests of different kinds arrive at one place and each kind has one specialist: a help desk, a triage step. The router's choice comes only from what each agent says it does (`list_agents`), so adding a specialist needs no change to the router.

**Do not use it** when a request needs several specialists (orchestrator–workers, P5) or when every agent can decide for itself whether to act (self-selection, P12, which needs no router).

## How the messages flow {#flow}

![Each arrow is one message the channel carries, in order; a note under a lifeline is the tool the agent's guidance tells it to call.](p02-router.svg)

## Run it {#run}

Launch the team, then send a scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 18,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p02-a's 11,607 ms in run 2 at `6eed097` with the move, times 1.5 (17,410.5), rounded up to a whole second; the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 18,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-1.md` R4) — the largest request, p02-a's 11,951 ms at `fb55f7e`, times 1.5, rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=router
# bound: 18000 ms
# p02-a
./asha to=router-1 user=alice message="Please translate 'thank you' into French."
# p02-b
./asha to=router-1 user=alice message="What is 17 plus 25?"
# p02-c
./asha to=router-1 user=alice message="Please have the right agent say: Hello World."
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p02-router.json`: each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p02-router.md`).

**p02-a** — exit 0, 10,935 ms:

```text
$ ./asha --verbose to=router-1 user=alice message="Please translate 'thank you' into French."
› alice → router-1 on main: Please translate 'thank you' into French.
› router-1: ok
› internal router-1 → desk-a-1: Please translate 'thank you' into French.
› desk-a-1: ok
› output desk-a-1 → alice:
Merci
```

**p02-b** — exit 0, 6,370 ms:

```text
$ ./asha --verbose to=router-1 user=alice message="What is 17 plus 25?"
› alice → router-1 on main: What is 17 plus 25?
› router-1: ok
› internal router-1 → desk-b-1: Please add 17 and 25.
› desk-b-1: ok
› output desk-b-1 → alice:
42
```

**p02-c** — exit 0, 6,385 ms:

```text
$ ./asha --verbose to=router-1 user=alice message="Please have the right agent say: Hello World."
› alice → router-1 on main: Please have the right agent say: Hello World.
› router-1: ok
› internal router-1 → desk-c-1: Say: Hello World.
› desk-c-1: ok
› output desk-c-1 → alice:
Hello World.
```

## The team and the test {#team}

- [`teams/router/team.json`](../../teams/router/team.json): the team — `router`, `desk-a`, `desk-b`, `desk-c`, launched in that order, each joining as `<name>-1`.
- `router`: [`router.json`](../../teams/router/router.json), its recipe, and [`router.md`](../../teams/router/router.md), its guidance, a full-text document in its system prompt.
- `desk-a`: [`desk-a.json`](../../teams/router/desk-a.json), its recipe, and [`desk-a.md`](../../teams/router/desk-a.md), its guidance, a full-text document in its system prompt.
- `desk-b`: [`desk-b.json`](../../teams/router/desk-b.json), its recipe, and [`desk-b.md`](../../teams/router/desk-b.md), its guidance, a full-text document in its system prompt.
- `desk-c`: [`desk-c.json`](../../teams/router/desk-c.json), its recipe, and [`desk-c.md`](../../teams/router/desk-c.md), its guidance, a full-text document in its system prompt.
- [`tests/agents/p02-router.test.ts`](../../tests/agents/p02-router.test.ts): launches the team and sends each scenario's message from this page, then asserts each scenario only through its checker, `P02_…` in [`tests/agents/patterns/phase-1.ts`](../../tests/agents/patterns/phase-1.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation and one per mutation the plan lists: [`tests/agents/patterns/fixtures/`](../../tests/agents/patterns/fixtures/p02-a/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0` (demo-model-pico, 2026-10-10): its largest request took 11,607 ms in the three recorded runs and 10,935 ms in the fourth, under its bound of 18,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- The specialists have neutral names (`desk-a`, `desk-b`, `desk-c`), so the router can only route by their descriptions; its recipe names none of them, and the proof checks that.
- Three routes, so a router that always picks one desk fails two of the three scenarios.
- Measured (2026-09-29, runs (`docs/plans/patterns-phase-1.md`)): the router took a request to say words as its own. For "Please say: Hello World." it broadcast the words, replied them itself, or sent them to `desk-a-1` without calling `list_agents` (*corrected 2026-09-29: this also said it called `pass`, which it did only for the sum*) — in every run and under 15 wordings of its guidance and prompt (a probe of its first turn; first written here as 17). So p02-c's input asks for routing outright, "Please have the right agent say: Hello World." (orchestration-patterns R6(2), its assertions unchanged); a say sent to a router as a bare instruction is outside what this demo shows (D35).
- The router's guidance says every request is its to route and never to call `pass` or `reply`; without that line it passed the sum as "not within my role".
- The routed say is phrase-bound: "Please have the right agent say: Good night." went to desk-c-1, but "Please get the right agent to say: Thanks for waiting." went to desk-a-1 (a probe of held-out inputs, 3/3 each, runs (`docs/plans/patterns-phase-1.md`)).
- Its guidance names no desk, as the proof checks, but its example — a say "goes to the agent that says words" — describes desk-c's role.
- desk-b-1's guidance does not decide its answer: told to add one more, it still answered 42 (a guard proof, `proofs/` (`evals/probes/patterns-phase-1-2026-09-29/README.md`)).

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P2 · Router (triage)](../testing/agent-tests.html#pattern-p02).
