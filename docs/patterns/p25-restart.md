---
title: Supervisor Restart Demo
description: P25 · Supervisor restart: An agent that crashes is restarted under its handle by its supervisor, and the message it held is sent to it again; past its restart intensity it is not restarted, and its conversation ends. Its team, how to run it, its message flow and its test.
---

# P25 · Supervisor restart

An agent that crashes is restarted under its handle by its supervisor, and the message it held is sent to it again; past its restart intensity — two restarts in a minute — it is not restarted, and its conversation ends.

<div class="facts"><span>written 2026-10-02</span><span>status: <span class="badge built">built</span> 2026-10-02, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/restart/team.json"><code>teams/restart/</code></a></span><span>test: <a href="../../tests/agents/p25-restart.test.ts"><code>tests/agents/p25-restart.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-3.md</code>, its runs</span></div>

> [!SUMMARY]
> - Scenarios: `p25-a` and `p25-b`, as `docs/plans/orchestration-patterns.md` specifies them.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `0fe982a` (runs (`docs/plans/patterns-phase-3.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with every member on `pico-v2-q8_0` (it has no router): three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `worker` on `pico-v2-q8_0`.
> - The supervisor is the harness: `worker`'s recipe names `restart: {"max": 2, "withinMs": 60000}`, and an agent that exits on its own is restarted under its handle with its held message sent again ([restarting a crashed agent](../architecture/channel.md#restarting)).
> - The fault is the suite's, never the model's: `worker-1`'s container is paused before the message and killed once the daemon logs the message posted; in p25-b each restarted container is killed as it starts. Each time it goes, the chat shows `worker-1: system failure — offline` and the scene crosses its robot with a red ✕ until it greets again — or, in p25-b's last, leaves (since 2026-10-16, `docs/plans/demo-scene-refresh.md` R6–R8). The supervisor's work is told as it goes (R16): `restarting (1 of 2 within 60 s)`, then in p25-a the worker's greeting and `sent again the message it held`; in p25-b `restart 1 failed: its container exited before coming online`, `restarting (2 of 2 within 60 s)`, `restart 2 failed: …` and `restart limit reached (2 within 60 s): removed`, then `worker-1 left`.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p25-restart.webm"></video>

Recorded at `4dfa2d0` on 2026-10-16, its team on `pico-v2-q8_0` ([sidecar](videos/p25-restart.json)): the portal's scene and chat as the demo's agent-suite run went, 73 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when an agent can crash mid-task and the same agent should take the task up again, under the name other agents and the user know it by, without a crash loop running for ever.

**Do not use it** when the work should go to another agent (watchdog and reassignment, P14), or when the agent keeps state across restarts of the daemon (a persisted agent's re-sends, `docs/plans/agent-persistence.md`), which a restart refuses.

## How the messages flow {#flow}

![p25-a: the user asks worker-1, whose container is paused, then killed; the harness restarts it under the same handle and sends the message again, framed as sent before the restart; worker-1 replies Hello World. p25-b: each restarted container is killed as it starts; after two restarts in a minute the third exit is the limit, and the conversation ends restart_limit.](p25-restart.svg)

## Run it {#run}

Launch the team, then send a scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs, with the fault around them (the suite pauses and kills containers through colima's docker; a reader can do the same with `docker pause` and `docker kill`). The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 8,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p25-a's 4,689 ms in run 2 at `6eed097` with the move, times 1.5 (7,033.5), rounded up to a whole second; the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 7,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-3.md` R4) — the largest request, p25-a's 4,555 ms at `04c77b3`, times 1.5 (6,832.5), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=restart
# bound: 8000 ms
# p25-a
./asha to=worker-1 user=alice message="Please say: Hello World."
# p25-b
./asha to=worker-1 user=alice message="Please say: Hello World."
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `p25-restart.json` (`evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p14-restart.json`): each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p25-restart.md`).

**p25-a** — exit 0, 4,478 ms:

```text
$ ./asha --verbose to=worker-1 user=alice message="Please say: Hello World."
› alice → worker-1 on main: Please say: Hello World.
› worker-1: ok
› output worker-1 → alice:
Hello World.
```

**p25-b** — exit 1, 3,102 ms:

```text
$ ./asha --verbose to=worker-1 user=alice message="Please say: Hello World."
› alice → worker-1 on main: Please say: Hello World.
✗ restart_limit: worker-1 exited 3 times within 60 s; not restarted
```

## The team and the test {#team}

- [`teams/restart/team.json`](../../teams/restart/team.json): the team — `worker`, joining as `worker-1`.
- `worker`: [`worker.json`](../../teams/restart/worker.json), its recipe, with its `restart`, and [`worker.md`](../../teams/restart/worker.md), its guidance, a full-text document in its system prompt.
- [`tests/agents/p25-restart.test.ts`](../../tests/agents/p25-restart.test.ts): launches the team and sends each scenario's message from this page, with its fault, then asserts each scenario only through its checker, `P25_A` and `P25_B` in [`tests/agents/patterns/phase-3.ts`](../../tests/agents/patterns/phase-3.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p25-a/`](../../tests/agents/patterns/fixtures/p25-a/pass.json) and [`p25-b/`](../../tests/agents/patterns/fixtures/p25-b/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With every member on `pico-v2-q8_0` (it has no router) (demo-model-pico, 2026-10-10): its largest request took 4,689 ms in the three recorded runs and 4,478 ms in the fourth, under its bound of 8,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- The model sees the restart only as one line before the message, `This message was sent before you were restarted; some of its work may already be done.`; whether work outside the agent was already done is for its guidance to check, and `worker`'s has nothing outside to check.
- p25-b starts once p25-a's restart is a minute old, so its three exits meet a window holding only its own restarts: the intensity counts every restart of `worker-1` on the channel, not one scenario's.
- Measured in the premise probes (2026-10-02, `d102a45`): the worker's turn on the re-sent message, 3/3 (`docs/plans/patterns-phase-3.md`); a warm restart, `agent.isolation_ready` to `agent.online`, about 0.4 s (probe L).

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P25 · Supervisor restart](../testing/agent-tests.html#pattern-p25).
