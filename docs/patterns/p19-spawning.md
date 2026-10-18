---
title: Dynamic Spawning Demo
description: P19 · Dynamic spawning of workers — a lead brings a new worker online when it needs one, and calls it. Its team, how to run it, its message flow and its test.
---

# P19 · Dynamic spawning of workers

A lead brings a new worker onto the channel when it needs one, and calls it in the same turn.

<div class="facts"><span>written 2026-10-02</span><span>status: <span class="badge built">built</span> 2026-10-02, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/spawner/team.json"><code>teams/spawner/</code></a></span><span>test: <a href="../../tests/agents/p19-spawning.test.ts"><code>tests/agents/p19-spawning.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-3.md</code>, its runs</span></div>

> [!SUMMARY]
> - Scenario: `p19-a`, as `docs/plans/orchestration-patterns.md` specifies it.
> - Built: its three recorded runs on the pinned model passed, then one under the bound they set, at `2168282` (runs (`docs/plans/patterns-phase-3.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `lead` on `qwen3-8b-q4_k_m`.
> - The team has one member, `lead`, whose recipe grants it `launch: {"recipes": ["helper"], "maxPerConversation": 1}`; `helper.json` sits in the folder, no member's ([launching](../architecture/channel.md#launching)).
> - lead-1 calls `launch_agent`; once helper-1 is online, the turn's next request is rebuilt with helper-1 on the roster, so the same turn can `consult` it. helper-1 is stopped when the conversation settles. The chat shows the launch as it begins, `lead-1: launching a new helper agent`, before helper-1 joins and greets (since 2026-10-16, `docs/plans/demo-scene-refresh.md` R14).

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p19-spawning.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `qwen3-8b-q4_k_m` ([sidecar](videos/p19-spawning.json)): the portal's scene and chat as the demo's agent-suite run went, 21 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when the agents a request needs are not known until it arrives, or are too many or too costly to keep running: the lead brings them in for one conversation, and they go when it ends.

**Do not use it** when the same workers serve every request (keep them on the channel: orchestrator–workers, P5), or when the worker must keep what it learned past the conversation (a launched agent persists nothing).

## How the messages flow {#flow}

![lead-1, alone on the channel, receives the request and calls launch_agent with the recipe helper; the daemon starts helper-1, which joins the channel; launch_agent returns its handle and lead-1's next request is rebuilt with helper-1 on the roster; lead-1 consults helper-1, which answers marigold; the gather returns to lead-1, which replies with the word; when the conversation settles, helper-1 is stopped.](p19-spawning.svg)

## Run it {#run}

Launch the team, then send the scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 21,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-3.md` R4) — the largest request, p19-a's 13,934 ms at `869a0d2`, times 1.5 (20,901), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=spawner
# bound: 21000 ms
# p19-a
./asha to=lead-1 user=alice message="Bring in a helper and tell me its word."
```

## A real transcript {#transcript}

Recorded at `66e5271` (clean tree), its third recorded run, from its results file as committed in `7fee14a` (`git show 7fee14a:tests/agents/results/p19-spawning.json`): each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' output as it streams (lines such as "› <handle> reply: {…}") is left out here; the results file holds it.

**p19-a** — exit 0, 13,731 ms:

```text
$ ./asha --verbose to=lead-1 user=alice message="Bring in a helper and tell me its word."
› alice → lead-1 on main: Bring in a helper and tell me its word.
› lead-1: ok
› internal lead-1 → helper-1: What is your word?
› internal helper-1 → lead-1: marigold
› internal asha → lead-1: Answers to lead-1's call: 1 answered.
› lead-1: ok
› output lead-1 → alice:
The helper's word is marigold.
```


## The team and the test {#team}

- [`teams/spawner/team.json`](../../teams/spawner/team.json): the team — `lead` alone, joining as `lead-1`.
- `lead`: [`lead.json`](../../teams/spawner/lead.json), its recipe, with its launch grant and a `messageTimeoutMs` of 120,000 (the launch lies inside its turn), and [`lead.md`](../../teams/spawner/lead.md), its guidance, a full-text document in its system prompt.
- `helper` (launched, no member): [`helper.json`](../../teams/spawner/helper.json), with a `startupTimeoutMs` of 30,000, and [`helper.md`](../../teams/spawner/helper.md).
- [`tests/agents/p19-spawning.test.ts`](../../tests/agents/p19-spawning.test.ts): launches the team and sends the scenario's message from this page, then asserts it only through its checker, `P19_A` in [`tests/agents/patterns/phase-3.ts`](../../tests/agents/patterns/phase-3.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p19-a/`](../../tests/agents/patterns/fixtures/p19-a/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- A launch takes about half a second warm (the image built and the model serving already: the launched recipe must share the lead's image and model), and lies inside the lead's turn, bounded at 35,000 ms; a helper that does not come online in its `startupTimeoutMs` (at most 30,000) is `launch_failed`, which the model is told.
- One helper per conversation (`maxPerConversation`): a second launch is refused `launch_cap`, which the model is told. The route's refusals and the helper's stop are proven without a model in [`daemon.test.ts`](../../tests/integration/daemon.test.ts) ("an agent launching from its grant").
- Without its grant the lead has no tool to launch with, and does not (the plan's control C3, 0/3).

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P19 · Dynamic spawning of workers](../testing/agent-tests.html#pattern-p19).
