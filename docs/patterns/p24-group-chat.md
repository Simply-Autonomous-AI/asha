---
title: Managed Group Chat Demo
description: P24 · Managed group chat — a manager chooses who speaks next, one participant at a time, each turn a call carrying the thread so far, in a fixed order (round robin) or by who holds the fact the next step needs (selector). Its team, how to run it, its message flow and its test.
---

# P24 · Managed group chat

A manager chooses who speaks next, one participant at a time, each turn a call carrying the thread so far: in a fixed order (round robin), or by who holds the fact the next step needs (selector).

<div class="facts"><span>written 2026-09-29</span><span>status: <span class="badge built">built</span> 2026-09-29, three recorded runs and one under its bound, after R6's remedies, all green; listed once the <a href="../testing/index.md#selection">demo selector</a> was built</span><span>team: <a href="../../teams/group-chat/team.json"><code>teams/group-chat/</code></a></span><span>test: <a href="../../tests/agents/p24-group-chat.test.ts"><code>tests/agents/p24-group-chat.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-2.md</code></span></div>

> [!SUMMARY]
> - Scenarios: `p24-a`, `p24-b`, as `docs/plans/orchestration-patterns.md` specifies them.
> - Built: its three recorded runs on the pinned model passed after R6's remedies, then one under the bound they set, at `e50be16` (runs (`docs/plans/patterns-phase-2.md`)); it joined the built demos once the demo selector existed (patterns-phase-2 R13), and its checker's every claim is also unit-tested on fixtures.
> - Models: `manager`, `alpha`, `beta`, `gamma` on `qwen3-8b-q4_k_m`.
> - Round robin (p24-a) follows `team.json`'s order; the selector (p24-b) reads each participant's role from `list_agents` to ask the keeper of the first digit, then asks the keeper each answer names next (`5. Next: alpha-1.`), never knowing a digit itself — a reshape for the pinned model, which chose the wrong second keeper from the roles (`docs/plans/patterns-phase-2.md`; the `list_agents` step shown in every run, not asserted: D42).

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p24-group-chat.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `qwen3-8b-q4_k_m` ([sidecar](videos/p24-group-chat.json)): the portal's scene and chat as the demo's agent-suite run went, 38 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when a conversation among several agents needs one agent to decide, turn by turn, who contributes next.

**Do not use it** when each agent can decide for itself whether to act (self-selection, P12), or when all can answer at once (fan-out, P4).

## How the messages flow {#flow}

![For the vault code, manager-1 reads the roles and asks beta-1, the keeper of the first digit; each keeper answers with its digit and the keeper of the next, so the manager asks alpha-1, then gamma-1, one call each, each question carrying the digits so far, and replies 528.](p24-group-chat.svg)

## Run it {#run}

Launch the team, then send a scenario's message: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 32,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-2.md` R4) — the largest request, p24-a's 20,805 ms at `83ba716`, times 1.5 (31,208), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=group-chat
# bound: 32000 ms
# p24-a
./asha to=manager-1 user=alice message="Write a three-line poem about rain, one line from each participant."
# p24-b
./asha to=manager-1 user=alice message="Find the vault code."
```

## A real transcript {#transcript}

Recorded at `e50be16` (clean tree), the run under its bound, from its results file as committed in `3e2b8cd` (`git show 3e2b8cd:tests/agents/results/p24-group-chat.json`): each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' output as it streams — lines such as "› delegator-1 consult: {…" printed one fragment each (D38) — is left out here; the results file holds it.

**p24-a** — exit 0, 22,184 ms:

```text
$ ./asha --verbose to=manager-1 user=alice message="Write a three-line poem about rain, one line from each participant."
› alice → manager-1 on main: Write a three-line poem about rain, one line from each participant.
› manager-1: ok
› internal manager-1 → alpha-1: Poem so far: (none yet). Add one line.
› internal alpha-1 → manager-1: The moon whispers secrets to the night.
› internal asha → manager-1: Answers to manager-1's call: 1 answered.
› manager-1: ok
› internal manager-1 → beta-1: Poem so far: The moon whispers secrets to the night. Add one line.
› internal beta-1 → manager-1: Stars blink in silent agreement.
› internal asha → manager-1: Answers to manager-1's call: 1 answered.
› manager-1: ok
› internal manager-1 → gamma-1: Poem so far: The moon whispers secrets to the night. Stars blink in silent agreement. Add one line.
› internal gamma-1 → manager-1: The wind carries their tales through the shadows.
› internal asha → manager-1: Answers to manager-1's call: 1 answered.
› manager-1: ok
› output manager-1 → alice:
The moon whispers secrets to the night.
Stars blink in silent agreement.
The wind carries their tales through the shadows.
```

**p24-b** — exit 0, 7,003 ms:

```text
$ ./asha --verbose to=manager-1 user=alice message="Find the vault code."
› alice → manager-1 on main: Find the vault code.
› manager-1: ok
› internal manager-1 → beta-1: Digits so far: none. What is your digit?
› internal beta-1 → manager-1: 5. Next: alpha-1.
› internal asha → manager-1: Answers to manager-1's call: 1 answered.
› manager-1: ok
› internal manager-1 → alpha-1: Digits so far: 5. What is your digit?
› internal alpha-1 → manager-1: 2. Next: gamma-1.
› internal asha → manager-1: Answers to manager-1's call: 1 answered.
› manager-1: ok
› internal manager-1 → gamma-1: Digits so far: 5, 2. What is your digit?
› internal gamma-1 → manager-1: 8. Next: none.
› internal asha → manager-1: Answers to manager-1's call: 1 answered.
› manager-1: ok
› output manager-1 → alice:
The vault code is 528.
```

## The team and the test {#team}

- [`teams/group-chat/team.json`](../../teams/group-chat/team.json): the team — `manager`, `alpha`, `beta`, `gamma`, launched in that order, each joining as `<name>-1`.
- `manager`: [`manager.json`](../../teams/group-chat/manager.json), its recipe, and [`manager.md`](../../teams/group-chat/manager.md), its guidance, a full-text document in its system prompt.
- `alpha`: [`alpha.json`](../../teams/group-chat/alpha.json), its recipe, and [`alpha.md`](../../teams/group-chat/alpha.md), its guidance, a full-text document in its system prompt.
- `beta`: [`beta.json`](../../teams/group-chat/beta.json), its recipe, and [`beta.md`](../../teams/group-chat/beta.md), its guidance, a full-text document in its system prompt.
- `gamma`: [`gamma.json`](../../teams/group-chat/gamma.json), its recipe, and [`gamma.md`](../../teams/group-chat/gamma.md), its guidance, a full-text document in its system prompt.
- [`tests/agents/p24-group-chat.test.ts`](../../tests/agents/p24-group-chat.test.ts): launches the team and sends each scenario's message from this page, then asserts each scenario only through its checker, `P24_A` and `P24_B` in [`tests/agents/patterns/phase-2.ts`](../../tests/agents/patterns/phase-2.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p24-a/`](../../tests/agents/patterns/fixtures/p24-a/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- Measured in the premise probes (2026-09-29, `0be190f`), its chain of model turns took 21.2 s (p24-a) and 10.1 s (p24-b) with cold prompts (`docs/plans/patterns-phase-2.md`).
- Each gather shows only its own call, so the manager carries the thread in each question it writes; one that drops an earlier line or digit fails the proof.
- The selector's second choice was the model's weak point: after beta-1's first digit the manager, choosing again from `list_agents` in a turn that sees only the latest call, asked gamma-1, in the probes under seven wordings and in the first recorded run. Reshaped (R6): each keeper names the next keeper in its answer, and the manager asks whom the answer names (`docs/plans/patterns-phase-2.md`); the order is still not `team.json`'s, and no digit is in the manager's files.

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P24 · Managed group chat](../testing/agent-tests.html#pattern-p24).
