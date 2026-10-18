---
title: Approval Gate Demo
description: P15 · Human approval gate: An agent asks the user before a consequential step and takes it only on a yes. Its team, how to run it, its message flow and its test.
---

# P15 · Human approval gate

An agent waits for the user's approval before a consequential step, and takes it only when the user says yes.

<div class="facts"><span>written 2026-10-02</span><span>status: <span class="badge built">built</span> 2026-10-02, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/approval/team.json"><code>teams/approval/</code></a></span><span>test: <a href="../../tests/agents/p15-approval.test.ts"><code>tests/agents/p15-approval.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-3.md</code>, its runs</span></div>

> [!SUMMARY]
> - Scenarios: `p15-a` (the user answers yes) and `p15-b` (no), as `docs/plans/orchestration-patterns.md` specifies them.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `b8fe251` (runs (`docs/plans/patterns-phase-3.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with every member on `pico-v2-q8_0` (it has no router): three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `clerk` on `pico-v2-q8_0`.
> - The consequential step is a post to the channel's blackboard: observable in the daemon log (`blackboard.posted`), inside the harness, free.
> - The clerk asks with `ask_user` ([asking the user](../architecture/channel.md#asking)): its question is its reply, and the conversation waits. The user's answer, sent with `conversation=`, comes back to it framed with its question, so it knows what it asked to post.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p15-approval.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` ([sidecar](videos/p15-approval.json)): the portal's scene and chat as the demo's agent-suite run went, 15 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when an agent may take a step the user must agree to first — a post, a payment, a message sent outside — and the agent can say exactly what it is about to do.

**Do not use it** when the user should take over the work rather than approve one step (escalation, P22), or when the step is a module tool's call the harness itself can hold for approval (`docs/plans/extension-modules.md` R12, enforced whatever the model does).

## How the messages flow {#flow}

![p15-a: you ask clerk-1 to post an announcement; it asks you to approve the text and the conversation waits; you answer yes in that conversation; it reaches clerk-1 framed with its question; clerk-1 posts the announcement to the blackboard, then replies Posted. p15-b: you answer no, and it replies Not posted. with no post.](p15-approval.svg)

## Run it {#run}

Launch the team, then send a scenario's commands: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The second command answers the first in its conversation: `@previous` stands for the conversation id the first command's waiting line prints (`? clerk-1 is waiting for your answer: asha user=alice conversation=<id> message="…"`), which the suite fills in. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 7,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p15-a's 4,230 ms in run 1 at `6eed097` with the move, times 1.5 (6,345), rounded up to a whole second; the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 7,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-3.md` R4) — the largest request, p15-a's 4,138 ms at `970ebc9`, times 1.5 (6,207), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=approval
# bound: 7000 ms
# p15-a
./asha to=clerk-1 user=alice message="Post the announcement: Office closed Friday."
./asha user=alice conversation=@previous message="yes"
# p15-b
./asha to=clerk-1 user=alice message="Post the announcement: Office closed Friday."
./asha user=alice conversation=@previous message="no"
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `p15-approval.json` (`evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p16-approval.json`): each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p15-approval.md`).

**p15-a** — exit 0, 4,178 ms:

```text
$ ./asha --verbose to=clerk-1 user=alice message="Post the announcement: Office closed Friday."
› alice → clerk-1 on main: Post the announcement: Office closed Friday.
› clerk-1: ok
› output clerk-1 → alice:
? clerk-1 is waiting for your answer: asha user=alice conversation=1bfe8fc67cc24a25 message="…"
Approve posting "Office closed Friday."? Answer yes or no.
```

**p15-a** — exit 0, 1,360 ms:

```text
$ ./asha --verbose user=alice conversation=1bfe8fc67cc24a25 message="yes"
› alice → clerk-1 on main: yes
› clerk-1: ok
› output clerk-1 → alice:
Posted.
```

**p15-b** — exit 0, 1,040 ms:

```text
$ ./asha --verbose to=clerk-1 user=alice message="Post the announcement: Office closed Friday."
› alice → clerk-1 on main: Post the announcement: Office closed Friday.
› clerk-1: ok
› output clerk-1 → alice:
? clerk-1 is waiting for your answer: asha user=alice conversation=53ef1d0dc1147017 message="…"
Approve posting "Office closed Friday."? Answer yes or no.
```

**p15-b** — exit 0, 653 ms:

```text
$ ./asha --verbose user=alice conversation=53ef1d0dc1147017 message="no"
› alice → clerk-1 on main: no
› clerk-1: ok
› output clerk-1 → alice:
Not posted.
```

## The team and the test {#team}

- [`teams/approval/team.json`](../../teams/approval/team.json): the team — `clerk`, joining as `clerk-1`.
- `clerk`: [`clerk.json`](../../teams/approval/clerk.json), its recipe — the four file tools, then `blackboard_post` and `ask_user` — and [`clerk.md`](../../teams/approval/clerk.md), its guidance, a full-text document in its system prompt.
- [`tests/agents/p15-approval.test.ts`](../../tests/agents/p15-approval.test.ts): launches the team and sends each scenario's commands from this page, then asserts each scenario only through its checker, `P15_A` and `P15_B` in [`tests/agents/patterns/phase-3.ts`](../../tests/agents/patterns/phase-3.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p15-a/`](../../tests/agents/patterns/fixtures/p15-a/pass.json) and [`p15-b/`](../../tests/agents/patterns/fixtures/p15-b/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With every member on `pico-v2-q8_0` (it has no router) (demo-model-pico, 2026-10-10): its largest request took 4,230 ms in the three recorded runs and 4,178 ms in the fourth, under its bound of 7,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- **The gate is the agent's.** Nothing in the harness stops `blackboard_post` before the user's yes: the clerk waits because its guidance says to, and the checker proves it did — no `blackboard.posted` before the answer is posted. Without that guidance the model posts at once (the plan's control C1, 0/3). For a step the harness must hold whatever the model does, use a `consequential` module tool, which `docs/plans/extension-modules.md` R12 gates: the call is not made until the user runs `asha --approve`.
- The answer reaches the clerk framed with its own question, so it reads the announcement back from the question; the probes showed it word for word, 3/3 (premise probes (`docs/plans/patterns-phase-3.md`)).
- `--interactive` cannot answer the question; the waiting line's command can, from any shell, or the portal's **Answer** (D57).

## Its report {#report}

Each run's proof — every claim with the transcript line or log record that shows it — and every repeat's time: [agent test report, P15 · Human approval gate](../testing/agent-tests.html#pattern-p15).
