# Copies of internal records the shipped tests read

The internal repository keeps its probe records (`evals/probes/`), its recorded agent runs (`tests/agents/results/`)
and its history out of the published tree (docs/plans/oss-release.md R2, R3). A shipped test that reads one reads instead its copy here,
made by `git show <commit>:<origin>` at the internal commit below (R12), so a published clone runs the same test on
the same bytes. Each copy is its origin byte for byte, but where the table's last column says otherwise: a recorded
run's macOS temporary folder, which names the machine it ran on, is written `$TMPDIR/` (R11), as the agent test report
writes it; and a record's field that lists the machine's other processes — another project's paths among them — is
left out, the rest of the record as it was (its JSON written again as it was, two spaces), as are a text record's lines
that list them. `tests/unit/fixtures-origin.test.ts`, which stays in the internal repository with the origins, checks every
row against its origin.

| Copy | Origin | Commit | Changed |
|---|---|---|---|
| `agent-results/p05-orchestrator-workers.json` | `tests/agents/results/p05-orchestrator-workers.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | its temporary folder written `$TMPDIR/` (2 times) |
| `agent-results/p12-self-selection.json` | `tests/agents/results/p12-self-selection.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | its temporary folder written `$TMPDIR/` (2 times) |
| `agent-results/p24-group-chat.json` | `tests/agents/results/p24-group-chat.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | its temporary folder written `$TMPDIR/` (2 times) |
| `probes/debt-paydown-2026-10-03/r6-aws-cli-verify.out.txt` | `evals/probes/debt-paydown-2026-10-03/r6-aws-cli-verify.out.txt` | `af80af22044eb6606b0381e2f803791a7610fd71` | its lines 11–15 left out |
| `probes/demo-scene-refresh-2026-10-16/capacity.json` | `evals/probes/demo-scene-refresh-2026-10-16/capacity.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/ministral-3-8b-instruct-2512-q4_k_m-cut-by-max-tokens.json` | `evals/probes/model-streaming-2026-09-29/captures/ministral-3-8b-instruct-2512-q4_k_m-cut-by-max-tokens.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/ministral-3-8b-instruct-2512-q4_k_m-over-context.json` | `evals/probes/model-streaming-2026-09-29/captures/ministral-3-8b-instruct-2512-q4_k_m-over-context.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/ministral-3-8b-instruct-2512-q4_k_m-text.json` | `evals/probes/model-streaming-2026-09-29/captures/ministral-3-8b-instruct-2512-q4_k_m-text.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/ministral-3-8b-instruct-2512-q4_k_m-tool-call.json` | `evals/probes/model-streaming-2026-09-29/captures/ministral-3-8b-instruct-2512-q4_k_m-tool-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-cut-by-max-tokens.json` | `evals/probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-cut-by-max-tokens.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-over-context.json` | `evals/probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-over-context.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-text.json` | `evals/probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-text.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-thinking-cut.json` | `evals/probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-thinking-cut.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-thinking.json` | `evals/probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-thinking.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-tool-call.json` | `evals/probes/model-streaming-2026-09-29/captures/qwen3-8b-q4_k_m-tool-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/measure-e241518.json` | `evals/probes/model-streaming-2026-09-29/measure-e241518.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/model-streaming-2026-09-29/measure.json` | `evals/probes/model-streaming-2026-09-29/measure.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | its field `otherLlamaServers` left out |
| `probes/patterns-phase-3-2026-10-02/probe/1161e29/control--C1-clerk-first-no-guidance.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/1161e29/control--C1-clerk-first-no-guidance.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/1161e29/control--C4-helper-answer-no-step-3.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/1161e29/control--C4-helper-answer-no-step-3.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/1161e29/p16--clerk-first.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/1161e29/p16--clerk-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/1161e29/p16-a--clerk-yes.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/1161e29/p16-a--clerk-yes.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/1161e29/p16-b--clerk-no.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/1161e29/p16-b--clerk-no.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/1161e29/p23-a--helper-first.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/1161e29/p23-a--helper-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/1161e29/p23-b--helper-answer.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/1161e29/p23-b--helper-answer.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/1161e29/probe.log.txt` | `evals/probes/patterns-phase-3-2026-10-02/probe/1161e29/probe.log.txt` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C1-clerk-first-no-guidance.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C1-clerk-first-no-guidance.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C2-lead-warm-call-not-granted.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C2-lead-warm-call-not-granted.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C3-lead-first-no-launch.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C3-lead-first-no-launch.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C4-helper-answer-no-step-3.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C4-helper-answer-no-step-3.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C5-ping-first-no-guidance.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/control--C5-ping-first-no-guidance.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--blue-call.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--blue-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--lead-cool-call.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--lead-cool-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--lead-cool-gather.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--lead-cool-gather.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--lead-warm-call.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--lead-warm-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--lead-warm-gather.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--lead-warm-gather.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--orange-call.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--orange-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--red-call.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--red-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--top-first.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--top-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--top-gather.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--top-gather.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--violet-call.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p07-a--violet-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p14-a--worker-first.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p14-a--worker-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p14-a--worker-redelivered.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p14-a--worker-redelivered.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p16--clerk-first.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p16--clerk-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p16-a--clerk-yes.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p16-a--clerk-yes.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p16-b--clerk-no.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p16-b--clerk-no.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p18--ping-first.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p18--ping-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p18--ping-on-pong.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p18--ping-on-pong.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p18--pong-on-ping.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p18--pong-on-ping.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p20-a--helper-call.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p20-a--helper-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p20-a--lead-after-launch.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p20-a--lead-after-launch.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p20-a--lead-first.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p20-a--lead-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p20-a--lead-gather.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p20-a--lead-gather.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p22-a--front-page.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p22-a--front-page.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p22-a--weather-desk.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p22-a--weather-desk.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p22-b--front-page.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p22-b--front-page.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p22-b--sports-desk.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p22-b--sports-desk.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p23-a--helper-first.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p23-a--helper-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/p23-b--helper-answer.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/p23-b--helper-answer.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/probe.log.txt` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/probe.log.txt` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/probe/d102a45/summary.json` | `evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/summary.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-3-2026-10-02/teams.mjs` | `evals/probes/patterns-phase-3-2026-10-02/teams.mjs` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/control--C1-editor-gather-empty-board.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/control--C1-editor-gather-empty-board.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/control--C2-note-room-no-notice.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/control--C2-note-room-no-notice.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/control--C3-planner-gather-time-no-notice.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/control--C3-planner-gather-time-no-notice.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/control--C4-note-room-no-guidance.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/control--C4-note-room-no-guidance.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--contrib-a-call.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--contrib-a-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--contrib-b-call.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--contrib-b-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--contrib-c-call.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--contrib-c-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-first.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-abc.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-abc.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-acb.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-acb.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-bac.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-bac.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-bca.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-bca.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-cab.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-cab.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-cba.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-a--editor-gather-cba.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--note-day-call.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--note-day-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--note-room-call.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--note-room-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--note-time-call.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--note-time-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--planner-first.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--planner-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--planner-gather-day.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--planner-gather-day.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--planner-gather-room.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--planner-gather-room.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--planner-gather-time.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/p11-b--planner-gather-time.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/probe.log.txt` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/probe.log.txt` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-4-2026-10-03/probe/c797439/summary.json` | `evals/probes/patterns-phase-4-2026-10-03/probe/c797439/summary.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/control--C1-supervisor-gather-unanswered.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/control--C1-supervisor-gather-unanswered.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/control--C2-worker-no-guidance.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/control--C2-worker-no-guidance.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-a--supervisor-first.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-a--supervisor-first.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-a--supervisor-gather.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-a--supervisor-gather.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-a--supervisor-resent.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-a--supervisor-resent.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-a--worker-call.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-a--worker-call.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-b--tasker-resent-3.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-b--tasker-resent-3.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-b--tasker-resent-4.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-b--tasker-resent-4.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-b--tasker-task-1.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-b--tasker-task-1.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-b--tasker-task-2.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/p21-b--tasker-task-2.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/probe.log.txt` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/probe.log.txt` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/patterns-phase-5-2026-10-03/probe/a9567ca/summary.json` | `evals/probes/patterns-phase-5-2026-10-03/probe/a9567ca/summary.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `probes/prompt-prefix-2026-09-28/capture-usage.json` | `evals/probes/prompt-prefix-2026-09-28/capture-usage.json` | `b7e5d056edba46c1a958ad35cdb2c7d76fb6e5c7` | no |
| `source-before-withTimeout/src/agent-sdk/index.ts.txt` | `src/agent-sdk/index.ts` | `31c01a545412c2749e209f5cdf6467df0446df3c` | no |
| `source-before-withTimeout/src/cli/commands.ts.txt` | `src/cli/commands.ts` | `31c01a545412c2749e209f5cdf6467df0446df3c` | no |
| `source-before-withTimeout/src/cli/files.ts.txt` | `src/cli/files.ts` | `31c01a545412c2749e209f5cdf6467df0446df3c` | no |
| `source-before-withTimeout/src/daemon/files/index.ts.txt` | `src/daemon/files/index.ts` | `31c01a545412c2749e209f5cdf6467df0446df3c` | no |
| `source-before-withTimeout/src/daemon/model-gateway/index.ts.txt` | `src/daemon/model-gateway/index.ts` | `31c01a545412c2749e209f5cdf6467df0446df3c` | no |
