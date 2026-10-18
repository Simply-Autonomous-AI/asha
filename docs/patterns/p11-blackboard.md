---
title: Blackboard Demo
description: P11 · Blackboard — agents build the answer on the channel's shared board, each reading what others posted, and never send each other their work. Its team, how to run it, its message flow and its test.
---

# P11 · Blackboard

Agents build the answer on a shared board: each posts what it alone knows, later ones read the board and build on what earlier ones posted, and the answer is read from the board — no agent sends another its work.

<div class="facts"><span>written 2026-10-03</span><span>status: <span class="badge built">built</span> 2026-10-03, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/blackboard/team.json"><code>teams/blackboard/</code></a></span><span>test: <a href="../../tests/agents/p11-blackboard.test.ts"><code>tests/agents/p11-blackboard.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-4.md</code>, its runs</span></div>

> [!SUMMARY]
> - Scenarios: `p11-a`, a shopping list each contributor adds one item to, and `p11-b`, a meeting notice each member reads from the board and extends, as `docs/plans/patterns-phase-4.md` specifies them.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `d06bd2b` (runs (`docs/plans/patterns-phase-4.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0`: three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checker's every claim is also unit-tested on fixtures.
> - Models: `editor` on `qwen3-8b-q4_k_m`; `contrib-a`, `contrib-b`, `contrib-c` on `pico-v2-q8_0`; `planner` on `qwen3-8b-q4_k_m`; `note-day`, `note-room`, `note-time` on `pico-v2-q8_0`.
> - The board is the channel's blackboard ([the blackboard](../architecture/channel.md#blackboard)): agents post with `blackboard_post` and read with `blackboard_read`; the test reads it through the control API, `GET /v1/blackboard?channel=main` ([APIs](../architecture/index.md#apis)).
> - The proof that work travels only through the board: no question, answer or gather of the conversation holds an item or a fact, and each fact is in one member's files only — yet the replies hold them all.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p11-blackboard.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` and `qwen3-8b-q4_k_m` ([sidecar](videos/p11-blackboard.json)): the portal's scene and chat as the demo's agent-suite run went, 65 s, every scenario passed. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when several agents each hold part of what the answer needs, and later work depends on what others have already contributed: each reads the shared state and adds to it, and nobody has to know who else exists or pass work along. The control — here a lead that decides whose turn it is — need not carry, or even see, the content.

**Do not use it** when one agent can ask the others and combine their answers itself (fan-out, P4; orchestrator–workers, P5): a call's gather already brings the answers back. Nor when the work is a fixed relay of one result through stages (pipeline, P3), where each stage hands its output to the next.

## How the messages flow {#flow}

![p11-a: you ask editor-1 for the shopping list; it consults contrib-a-1, contrib-b-1 and contrib-c-1 in one call; each posts its item to the channel's blackboard and answers only "posted"; editor-1 reads the board and replies with the items. p11-b: you ask planner-1 for the meeting notice; it consults note-day-1, then note-room-1, then note-time-1, one call each; note-day-1 posts "notice: meeting on Thursday"; note-room-1 and note-time-1 each read the board and post the last notice extended with their own fact; planner-1 reads the board and replies with the notice. No question or answer carries an item or a fact: they travel only through the board.](p11-blackboard.svg)

## Run it {#run}

Launch the team, then send each scenario's message, p11-a first: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8): 43,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p11-b's 28,128 ms in run 1 at `6eed097` with the move, times 1.5 (42,192), rounded up to a whole second; the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 41,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-4.md` R8) — the largest request, p11-b's 26,700 ms at `92b5f15`, times 1.5 (40,050), rounded up to a whole second; the cap is 45,000 ms.

```asha-run
./asha --launch team=blackboard
# bound: 43000 ms
# p11-a
./asha to=editor-1 user=alice message="Assemble the shopping list."
# p11-b
./asha to=planner-1 user=alice message="Write the meeting notice."
```

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p11-blackboard.json`: each scenario's command as the suite ran it (it adds `--verbose`, which prints the `›` progress lines), its stderr, then its stdout. The models' tool calls as they stream — lines such as `› <handle> <tool>: …`, one fragment each (D38) — are left out here; the results file holds them. The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p11-blackboard.md`). **Kept:** every `blackboard_read` line and p11-b's `blackboard_post` lines, because the reads and posts are the pattern; p11-a's contributors post at once, in interleaved fragments, which are left out.

**p11-a** — exit 0, 18,889 ms:

```text
$ ./asha --verbose to=editor-1 user=alice message="Assemble the shopping list."
› alice → editor-1 on main: Assemble the shopping list.
› editor-1: ok
› internal editor-1 → contrib-a-1: Post your item to the blackboard.
› internal editor-1 → contrib-b-1: Post your item to the blackboard.
› internal editor-1 → contrib-c-1: Post your item to the blackboard.
› internal contrib-b-1 → editor-1: posted
› internal contrib-c-1 → editor-1: posted
› internal contrib-a-1 → editor-1: posted
› internal asha → editor-1: Answers to editor-1's call: 3 answered.
› editor-1 blackboard_read: {}
› editor-1: ok
› output editor-1 → alice:
The shopping list is:
- quince jam
- rye flour
- saffron
```

**p11-b** — exit 0, 25,970 ms:

```text
$ ./asha --verbose to=planner-1 user=alice message="Write the meeting notice."
› alice → planner-1 on main: Write the meeting notice.
› planner-1: ok
› internal planner-1 → note-day-1: Add your part to the notice on the blackboard.
› note-day-1 blackboard_post: {"text": "notice: meeting on Thursday"}
› internal note-day-1 → planner-1: posted
› internal asha → planner-1: Answers to planner-1's call: 1 answered.
› planner-1: ok
› internal planner-1 → note-room-1: Add your part to the notice on the blackboard.
› note-room-1 blackboard_read: {}
› note-room-1 blackboard_post: {"text": "notice: meeting on Thursday, in the Juniper room"}
› internal note-room-1 → planner-1: posted
› internal asha → planner-1: Answers to planner-1's call: 1 answered.
› planner-1: ok
› internal planner-1 → note-time-1: Add your part to the notice on the blackboard.
› note-time-1 blackboard_read: {}
› note-time-1 blackboard_post: {"text": "notice: meeting on Thursday, in the Juniper room, at 14:30"}
› internal note-time-1 → planner-1: posted
› internal asha → planner-1: Answers to planner-1's call: 1 answered.
› planner-1 blackboard_read: {}
› planner-1: ok
› output planner-1 → alice:
The meeting notice is complete. The meeting is scheduled for Thursday in the Juniper room at 14:30.
```

Neither the planner's questions nor the members' answers hold Thursday, Juniper or 14:30: each member found the earlier parts on the board.

## The team and the test {#team}

- [`teams/blackboard/team.json`](../../teams/blackboard/team.json): the team, eight members — `editor` and `contrib-a`, `contrib-b`, `contrib-c` (p11-a); `planner` and `note-day`, `note-room`, `note-time` (p11-b) — each joining as `<name>-1`.
- Each member's recipe and guidance, a full-text document in its system prompt: [`editor.json`](../../teams/blackboard/editor.json) and [`editor.md`](../../teams/blackboard/editor.md) (`blackboard_read`); [`contrib-a.json`](../../teams/blackboard/contrib-a.json), [`contrib-b.json`](../../teams/blackboard/contrib-b.json), [`contrib-c.json`](../../teams/blackboard/contrib-c.json) and their documents (`blackboard_post`); [`planner.json`](../../teams/blackboard/planner.json) and [`planner.md`](../../teams/blackboard/planner.md) (`blackboard_read`); [`note-day.json`](../../teams/blackboard/note-day.json) (`blackboard_post`), [`note-room.json`](../../teams/blackboard/note-room.json) and [`note-time.json`](../../teams/blackboard/note-time.json) (both board tools) and their documents. Every recipe also selects the four file tools.
- [`tests/agents/p11-blackboard.test.ts`](../../tests/agents/p11-blackboard.test.ts): launches the team and sends each scenario's command from this page; before and after each, reads the board through the control API (`readBoard` in [`tests/agents/support.ts`](../../tests/agents/support.ts)), so the checker sees exactly the entries the scenario posted; then asserts each scenario only through its checker, `P11_A` and `P11_B` in [`tests/agents/patterns/phase-4.ts`](../../tests/agents/patterns/phase-4.ts), and records the checker's proof for the report.
- The checker's fixtures, one passing conversation, one per mutation the plan lists and one breaking every other claim: [`tests/agents/patterns/fixtures/p11-a/`](../../tests/agents/patterns/fixtures/p11-a/pass.json) and [`p11-b/`](../../tests/agents/patterns/fixtures/p11-b/pass.json), run by [`tests/unit/pattern-proofs.test.ts`](../../tests/unit/pattern-proofs.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0` (demo-model-pico, 2026-10-10): its largest request took 28,128 ms in the three recorded runs and 25,970 ms in the fourth, under its bound of 43,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- **The board is in the daemon's memory.** It is lost when the daemon stops, unless the team names `persist: ["board"]` ([team](../architecture/recipes.md#team)); this team does not, so every run starts with an empty board. The test reads it through `GET /v1/blackboard`, which any holder of the control credential can call.
- **p11-b's control is a fixed schedule.** planner-1 asks the members in an order its guidance gives, and reads the board only at the end; a member does not check the board's state before it acts — given a board with no notice, note-room-1 still posts one, built from the shopping list's items (the plan's control C2). A step telling the members to post nothing until a notice is there broke their main step on `qwen3-8b-q4_k_m` under two wordings (premise probes (`docs/plans/patterns-phase-4.md`)). What p11-b shows is the blackboard's information path: work built on work through the shared space.
- **The tool-call lines show what the model asked for.** The checker's "reads before it posts" claims read the `--verbose` lines of each tool call; the board's entries — each later one starting with the earlier one's text — show what happened.
- The editor and the planner reply in their own words (a heading and bullets, a sentence around the notice); the checker reads the content: the board's items in the board's order, and the notice's three facts.

## Its report {#report}

Each run's proof — every claim with the transcript line, log record or board entry that shows it — and every repeat's time: [agent test report, P11 · Blackboard](../testing/agent-tests.html#pattern-p11).
