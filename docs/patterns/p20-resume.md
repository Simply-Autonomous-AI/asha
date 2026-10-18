---
title: Checkpoint And Resume Demo
description: P20 · Checkpoint and resume: a conversation in progress when the daemon stops is resumed after the restart and completes, and a long-running supervisor killed mid-task finishes the rest. Its team, how to run it, its message flow and its test.
---

# P20 · Checkpoint and resume

Work in progress survives a stop of the harness: a conversation waiting on another agent when the daemon stops is resumed when the agent is relaunched, and completes without the user sending anything again; a long-running supervisor that keeps its progress in its saved workspace, killed mid-task, does the rest after its relaunch, each task once in its file.

<div class="facts"><span>written 2026-10-03</span><span>status: <span class="badge built">built</span> 2026-10-03, three recorded runs and one under its bound, all green</span><span>team: <a href="../../teams/resume/team.json"><code>teams/resume/</code></a></span><span>test: <a href="../../tests/agents/p20-resume.test.ts"><code>tests/agents/p20-resume.test.ts</code></a></span><span>plan: <code>docs/plans/patterns-phase-5.md</code>, its runs</span></div>

> [!SUMMARY]
> - Scenarios: `p20-a`, a supervisor waiting on its call to a worker when the daemon stops, resumed by the relaunch; and `p20-b`, the long-running supervisor of `docs/plans/agent-persistence.md` A8, as `docs/plans/patterns-phase-5.md` specifies them.
> - What carries the work across the stop: a persisted agent's saved `/workspace` ([persisted agents](../architecture/channel.md#persisted)), and its record of unsaved messages, which keeps a user's message until its conversation is finished and re-sends it, once, at the agent's next launch in a later daemon run.
> - Built: its three recorded runs with every member on `qwen3-8b-q4_k_m` passed, then one under the bound they set, at `b0a4ea3` (runs (`docs/plans/patterns-phase-5.md`)); moved 2026-10-10 by `docs/plans/demo-model-pico.md` R3, with its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0`: three recorded runs passed at `6eed097` with the move, then one under the bound they set at `8dd3a26` (runs (`evals/probes/demo-model-pico-runs-2026-10-09/README.md`)); its checkers' every claim is also unit-tested on fixtures.
> - Models: `supervisor` on `qwen3-8b-q4_k_m`; `worker`, `tasker` on `pico-v2-q8_0`.
> - The relaunch is the user's `./asha --launch team=resume`: it starts the daemon, re-sends the kept message marked as a retry, and follows the resumed conversation, printing `› resuming your message from <time>` and the answer.

## Watch it run {#watch}

<video controls preload="metadata" src="videos/p20-resume.webm"></video>

Recorded at `fb3d995` on 2026-10-16, its team on `pico-v2-q8_0` and `qwen3-8b-q4_k_m` ([sidecar](videos/p20-resume.json)): the portal's scene and chat as the demo's agent-suite run went, 76 s, every scenario passed. The page followed the daemon's 3 restarts: after each, it loads again and watches the channel afresh, so the chat starts over. How it is recorded: [Testing](../testing/index.md#videos).

## What it is for {#use}

**Use it** when work can outlive a run of the harness: a supervisor waiting on other agents, or working through a list of tasks in its own turns, should pick up where it was rather than lose the work or start again. Give the agent `persist: ["workspace"]` (or `"memory"`) in its recipe, keep its progress in a file there, and relaunch it after the restart.

**Do not use it** for work whose effects must happen exactly once. The resume replays the user's message from the agent's last saved state: anything the interrupted turn did outside that state — a question to another agent, a post, a file in `/channel`, a model call, a web search — can happen again. The re-sent message says it was sent before the restart, so a well-guided agent checks its saved progress first (p20-b's tasker reads `tasks.json`), but the harness gives no exactly-once guarantee.

## How the messages flow {#flow}

![p20-a: you ask supervisor-1 for worker-1's word; it consults worker-1, whose container the test has paused, and the daemon is stopped while the call is open; supervisor-1's record keeps your message; the relaunch starts a new daemon, re-sends the message marked as a retry, supervisor-1 consults worker-1 again, worker-1 answers marigold, and supervisor-1 answers you. p20-b: tasker-1 does tasks 1 and 2, saving each in tasks.json; the daemon is killed while task 3 runs; the relaunch re-sends tasks 3 and 4, and the tasker finds task 3 not saved and does it, then task 4.](p20-resume.svg)

## Run it {#run}

Launch the team, then each scenario's commands, p20-a first: exactly the commands below, which the demo's agent-suite file reads from this page and runs. The `# bound` line is the most a request may take (`docs/plans/orchestration-patterns.md` R8), asserted on p20-a's message and relaunch and on each of p20-b's commands: 27,000 ms since 2026-10-10, set from its three recorded runs with its sub-agents on `pico-v2-q8_0` (`docs/plans/demo-model-pico.md` R3) — the largest request, p20-b's 17,391 ms in run 1 at `6eed097` with the move, times 1.5 (26,086.5), rounded up to a whole second; the cap is 45,000 ms. *Before, with every member on `qwen3-8b-q4_k_m`:* 24,000 ms, set from its first three recorded runs (`docs/plans/patterns-phase-5.md` R14) — p20-a's largest, the relaunch of run 2, 15,559 ms at `0c79534`, times 1.5 (23,338.5), rounded up to a whole second, and p20-b's, run 1's relaunch, 15,582 ms, giving the same; the cap is 45,000 ms. (p20-b's bound was 17,000 ms in its one-member team, `docs/plans/agent-persistence.md` A8.)

```asha-run
./asha --launch team=resume
# bound: 27000 ms
# p20-a
./asha to=supervisor-1 user=alice message="Ask worker-1 for its word and tell me."
./asha --stop
./asha --launch team=resume
# p20-b
./asha --stop
./asha --launch team=resume
./asha to=tasker-1 user=alice message="do task 1"
./asha to=tasker-1 user=alice message="do task 2"
./asha to=tasker-1 user=alice message="do task 3"
./asha to=tasker-1 user=alice message="do task 4"
./asha --launch team=resume
```

**The faults are the test's.** In p20-a the test pauses worker-1's container before the message and runs `--stop` once the daemon logs supervisor-1's call, so the stop always lands while the call is open; typed by hand, worker-1 may answer first and the conversation finish before the stop. In p20-b the test sends tasks 3 and 4 together and kills the daemon with SIGKILL once task 3's write to `tasks.json` is logged — by hand, `kill -9` the daemon while task 3 runs.

## A real transcript {#transcript}

Recorded at `8dd3a26` (clean tree), `docs/plans/demo-model-pico.md`'s fourth run (R3 (d)), with its sub-agents on `pico-v2-q8_0`, from its results file `p20-resume.json` (`evals/probes/demo-model-pico-runs-2026-10-09/run-4/results/p21-resume.json`): p20-a's message and relaunch, and p20-b's relaunch, as the suite ran them (it adds `--verbose`, which prints the `›` progress lines, to all but p20-b's relaunch), each command's stderr, then its stdout. **Left out below:**
- the relaunch's progress lines up to each member's `Hi`: the daemon's start, with the log path of a temporary home, and each member's container runtime, model, model server and image;
- p20-a's `--stop` (`stopped (pid …)`, 3,713 ms);
- p20-b's `--stop`, launch and tasks 1–4;
- the models' tool-call lines.

The transcript before, with every member on `qwen3-8b-q4_k_m`, is in this page's history (`git show 8dd3a26:docs/patterns/p20-resume.md`).

**p20-a, the message** — exit 1, 8,021 ms; the daemon was stopped while worker-1 held the question:

```text
$ ./asha --verbose to=supervisor-1 user=alice message="Ask worker-1 for its word and tell me."
› alice → supervisor-1 on main: Ask worker-1 for its word and tell me.
› supervisor-1: ok
› internal supervisor-1 → worker-1: What is your word?
› tasker-1 left the channel: channel stream closed
› supervisor-1 left the channel: channel stream closed
› output asha → alice:
No agent could answer this:
- supervisor-1 worked on it but sent you no reply
- worker-1 received it but said nothing
```

**p20-a, the relaunch** — exit 0, 16,736 ms; nothing sent again:

```text
$ ./asha --verbose --launch team=resume
› supervisor-1 resumed from state saved 2026-10-10T03:37:47.357Z
› tasker-1 resumed from state saved 2026-10-10T03:37:47.350Z
› resuming your message from 2026-10-10T03:37:42.080Z
› supervisor-1: ok
› internal supervisor-1 → worker-1: What is your word?
› internal worker-1 → supervisor-1: marigold
› internal asha → supervisor-1: Answers to supervisor-1's call: 1 answered.
› supervisor-1: ok
› output supervisor-1 → alice:
supervisor-1
worker-1
tasker-1
worker-1's word is marigold
```

The resuming line names the time alice sent the message, before the stop; supervisor-1 asked worker-1 again, from the re-sent message.

**p20-b, the relaunch** — exit 0, 16,772 ms, without `--verbose`; the daemon had been killed while task 3 ran:

```text
$ ./asha --launch team=resume
(daemon file names port 63559, which did not answer: fetch failed)
› resuming your message from 2026-10-10T03:38:25.416Z
› resuming your message from 2026-10-10T03:38:25.630Z
supervisor-1
worker-1
tasker-1
done task 3
done task 4
```

Task 3 had been written to `tasks.json` before the kill, but its checkpoint was never promoted, so the restored file lacked it: the re-sent task wrote it again, then task 4. The run's proof records it: two checkpoints promoted before the kill, three writes of `tasks.json` in the first run and two in the second, and `tasks.json` naming each task once.

## The team and the test {#team}

- [`teams/resume/team.json`](../../teams/resume/team.json): three members, each joining as `<name>-1` — `supervisor` and `worker` (p20-a), `tasker` (p20-b).
- [`supervisor.json`](../../teams/resume/supervisor.json) and [`supervisor.md`](../../teams/resume/supervisor.md): persists `workspace`; asks worker-1 for its word with `consult`, also when the message was sent before the restart, then replies with it.
- [`worker.json`](../../teams/resume/worker.json) and [`worker.md`](../../teams/resume/worker.md): holds the word, `marigold`, in its document alone, and replies with it when asked.
- [`tasker.json`](../../teams/resume/tasker.json) and [`tasker.md`](../../teams/resume/tasker.md): persists `workspace`; for each `do task <id>`, reads `tasks.json`, writes it with the id added once, and replies `done task <id>` (`docs/plans/agent-persistence.md` A8's long-running supervisor).
- [`tests/agents/p20-resume.test.ts`](../../tests/agents/p20-resume.test.ts): runs this page's block with each scenario's fault, and asserts each scenario only through its checker, `P20_A` and `P20_B` in [`tests/agents/patterns/p20.ts`](../../tests/agents/patterns/p20.ts), each on its own slice of the daemon log.
- The checkers' fixtures — each scenario's first recorded run, and one failing fixture per claim and per clause: [`tests/agents/p20-a/run-1.json`](../../tests/agents/p20-a/run-1.json) and [`tests/agents/p20-b/recorded-run-1.json`](../../tests/agents/p20-b/recorded-run-1.json), run by [`tests/unit/p20-checker.test.ts`](../../tests/unit/p20-checker.test.ts) in `npm test`.

## Limits on a local model {#limits}

- With its routers on `qwen3-8b-q4_k_m` and its sub-agents on `pico-v2-q8_0` (demo-model-pico, 2026-10-10): its largest request took 17,391 ms in the three recorded runs and 16,772 ms in the fourth, under its bound of 27,000 ms. The limits after it were measured with every member on `qwen3-8b-q4_k_m`, before the move; one about a sub-agent was not measured again on `pico-v2-q8_0`.
- **The resume replays the user's message.** Nothing of the open call is saved: after the restart supervisor-1 asks worker-1 again, so the worker's turn — and anything else the interrupted turn did outside the supervisor's saved `/workspace` — can repeat (delivery at least once; `docs/plans/agent-persistence.md` R9 (g)).
- **It needs a persisted agent and a later daemon run.** Only an agent whose recipe persists something has a record of unsaved messages; its message is re-sent at its next launch after the daemon has stopped and started again, never by a relaunch in the same run, and only when the user relaunches it: the daemon starts no agent by itself.
- **Once.** A message re-sent once is not re-sent again if the daemon stops during its re-send.
- **Only the user's message is resumed.** An agent's own message to another, or a call's question to a persisted callee, is not.
- **The interrupted command still says no agent could answer.** At the stop, the message command ends with the harness's `No agent could answer this: …` and exits 1, as for any conversation a stop interrupts; the answer comes with the relaunch (D62, for the owner to decide).
- **The faults are the test's** (above): the pause of worker-1 and p20-b's SIGKILL.

## Its report {#report}

Each run's proof — every claim with the log record or transcript line that shows it — and every repeat's time: [agent test report, P20 · Checkpoint and resume](../testing/agent-tests.html#pattern-p20).
