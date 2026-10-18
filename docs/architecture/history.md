---
title: Architecture History
description: Dated record of what the architecture pages used to say, the corrections made to them, earlier test and eval runs, and the background behind current designs.
---

# Architecture history

The architecture pages describe the system as it is now. This page keeps what they no longer need to say: corrections, earlier runs and results, finished milestones, and background. Newest first.

<div class="facts"><span>started 2026-09-27</span><span>entries moved from the six architecture pages on 2026-09-27</span></div>

> [!SUMMARY]
> - Every correction to these pages is here, with what was claimed, what is true and why the claim was wrong (PRINCIPLES §12).
> - Earlier gate runs are here: the page at `a3fe9e4` (unit 453/453) and the 2026-09-26 run (unit 249). The current gate is on [Architecture](index.md#evidence).
> - Earlier routing-eval runs, at `942eb7e` and `426eecb`, are here; the run at `b168dfe` (llama.cpp 8130) is summarized, and the latest, at `d8350f0` (0.5.0), is on [Models](models.md#choice).
> - The owner's memory brief, the design it set out, and the memory build phases are here; [Agent memory](memory.md) shows only what is built.

## 2026-09-27 {#h-2026-09-27}

### Correction: `tool_choice: "required"` and llama.cpp 0.5.0 {#forced-calls-correction}

- **Claimed.** [Models](models.md#gateway) and [Channel](channel.md#acting) said a turn with `requireToolCall` is sent as `tool_choice: "required"`, and so ends in a tool call.
- **True now.** Homebrew upgraded llama.cpp from build 8130 (`ed4837891`) to 0.5.0 (build 11146, `7fe450e19`) on 2026-09-27 at 12:47 local (the Cellar's `INSTALL_RECEIPT.json`). 0.5.0 contains upstream [PR #22654](https://github.com/ggml-org/llama.cpp/pull/22654), "common/autoparser: fixes for newline handling / forced tool calls", merged 2026-05-04T11:18:11Z as `a4701c98f72160144b101090596c7ea1ef0c1d7b`; its description says forced tool calls "now allow for content before the tool call". 8130 does not contain it (the GitHub compare API: `ed4837891` is 890 commits behind it, `7fe450e19` 2,126 ahead). Read 2026-09-27. On 0.5.0, `qwen3-8b` at temperature 0 sometimes wrote text until `max_tokens` with no call, and the gateway returned it as `ok`, so the agent failed with "answered with text instead of a tool call" rather than the real cause. The [Models](models.md#qwen3-0.6b) "Thinking off" row, which said "verified against `llama-server` build 8130 with `--jinja`: the reply is `"Hello, World!"` with no `<think>` block", was re-verified on 0.5.0 the same day.
- **Why the claim failed.** It described one llama.cpp build's grammar as a property of `tool_choice`, and the build is not pinned (debt D11).
- **Fixed.** A chat entry's required `toolCallStart` (Qwen3: `"<tool_call>\n"`) opens the assistant turn when a call is required; a required call cut off by the token limit is the failure `truncated`.
- **A second effect.** With the call forced from the first token, the pass rule ("only take on work your role covers") also took a question about the agent's own role: the routing case `solo-question` went to 0/3 (a `list_agents` lookup, then `pass`, "No agents available"); 17/19 at `3ebb0c6` plus the uncommitted fix. One instruction line, "A question about you or your role is always yours to answer, with your role exactly as given above.", restored 18/19, the `b168dfe` baseline, with both question cases replying with the role. Wordings without "exactly as given above" routed correctly but let the model describe itself as a general assistant.

### Gate run while the pages were written {#evidence-a3fe9e4}

| Claim | Evidence | Date |
|---|---|---|
| <span class="badge pass">pass</span> `npm run check` green | at `a3fe9e4` (clean tree): unit 453/453, integration 41/41, agent suite 35/35, eval 10/10 ([Testing](../testing/index.md#results)) | 2026-09-27 |
| Agent suite 35/35 | the latest recorded result then, at `5b4e25c` (commit `719dad4`'s message); transcripts in the [agent test report](../testing/agent-tests.md) | 2026-09-27 |

Superseded by the gate at `05555b1` ([Architecture — evidence](index.md#evidence)).

### Memory results before the current gate {#memory-results}

From the commit messages:

| Result | At | Commit |
|---|---|---|
| `memory-tiers` 12/12 (agent suite 32/32) | `2e0783d` | `b6d9e4f` |
| the memory crowd 3/3 | `28b0d3f` | `7d9e670` |
| agent suite 35/35 | `5b4e25c` | `719dad4` |

### Corrections made while migrating to `docs/architecture/` {#corrections}

Each was found by reading the code on 2026-09-27.

- **API shapes.** `docs/architecture.md` said the roster route returns `{handles}` and health `{ok, pid, version, agents}`. The code returns `{agents: [{handle, recipe, description}]}` (so agents can choose whom to delegate to by description), and health adds `build` and `startedAt`. The markdown was not updated when those fields were added.
- **The control API has no credential.** The page said anything else that reaches the daemon's port is refused with a 401. That holds only for `/agent/` routes: the control routes are matched in `route()` *before* the token check. The reasoning that missed it read "loopback-only" as "only the user", which a container that can reach loopback breaks. Tracked as debt D1. Fixed by the `docs/plans/control-api-auth.md` plan in `222a6c5` (2026-09-27): a control credential on every `/v1/` route, `Host` and `Origin` checks, a key on every `llama-server`, and a network rule confining agent containers to the daemon's port ([the credential](index.md#token)).
- **Error events.** `docs/architecture.md` listed six error events. Reading every `logger.error` call in `src/` found five more: `launch.failed`, `http.handler_failed`, `model.embed_failed`, `agent.container_failed` and `model_server.spawn_failed`. They were added with `--launch`, embeddings and the process adapters without the list being updated.
- **The roster lookup.** `docs/architecture.md` said `decide()` fetches the roster and allows "up to 3 rounds". In the code the handler fetches it before `decide()`, and the check `lookups >= maxRounds` fails on the third lookup.
- **Acking an `output`.** `docs/architecture.md` said the SDK acks a reply meant for the user (`output`) directly, without handing it to the handler. The channel never delivers an `output` to any agent (its recipient list is empty), so there is nothing for the SDK to skip or ack.
- **Which routing run the table came from.** `docs/models.md` said both "the table is from the run at commit `426eecb`" and, a paragraph later, "Results (2026-09-26), from the run at commit `942eb7e`". The table is the `942eb7e` run; `426eecb` was the previous run it was compared with. The first sentence was left over from before the re-run.
- **"What still fails" was stale.** `docs/models.md` said both "ignore" cases fail on every model. That was true of `942eb7e`, but the recorded results in `evals/routing/results/` had since been replaced by the `b168dfe` run, in which 8B passes both. The page was not updated with the later runs.
- **Memory as built** differed from its design in two points the page claimed ([below](#memory-design)): our records are `{id, ts, text, embedding}` — no `kind` or `meta` — and the session tier holds `turns`, not `records` ([`types.ts`](../../images/memory/src/memory/types.ts)); and there is no version tag and no re-read-and-merge, because only the agent's own process writes its files, so [`store.ts`](../../images/memory/src/memory/store.ts) says "there is no cross-process merge to do". The atomic temp-file-then-rename is built.
- **The procedural test line.** The memory page listed "a stated way of working (for example "answer me in bullet points") shapes a later answer" as a procedural test. It predates the owner's 2026-09-26 correction ([below](#procedural)): that is a semantic fact. The agent suite tests the owner's definition instead — "procedural: a task done with a technique that worked is recorded as a reusable procedure" (`memory-agent.test.ts`) and "records a technique from a worked task, then applies it to a new one without recording it twice" (`memory-tiers.test.ts`).
- **The user-ID warning** was added to the memory page on 2026-09-27: the identity the harness passes is the one the caller claimed with `user=` (debt D2).

## 2026-09-26 {#h-2026-09-26}

### Evidence recorded in `docs/architecture.md` {#evidence-2026-09-26}

| Claim | Evidence |
|---|---|
| <span class="badge pass">pass</span> `npm run check` was green | 249 unit tests, 31 integration tests and 9 eval tests. The eval includes the real two-agent hello world, asserting the exact `internal` hand-off and the reply |
| The eval also covered | starting from no daemon and asserting `Hello World!` exactly (then the reply of `qwen3-0.6b-q8_0`; with today's `qwen3-8b-q4_k_m` the eval asserts `Hello World.`); reuse of the online agent; `--watch` against a live conversation; `to=hewo-1`, where only that agent works; `channel=lab`, which brings up a second, separate `hewo-1`; `--status` listing both agents; `--stop`, after which no container of its own remains and nothing was logged above info level |
| Integration: two agents on one channel | `hewo-1`, `hewo-2`: `to=hewo-2` reaches only `hewo-2`, with exactly one model call |
| Greedy decoding (`temperature: 0`, the hello-world recipe's override) is deterministic | with `qwen3-0.6b-q8_0`, 25 of 25 hello-world replies byte-identical, 5 of them across daemon restarts |
| Reply variance at temperature 0.7 | with `qwen3-0.6b-q8_0`, 31 replies to "Please say: Hello World." — 25 "Hello World!"/"Hello world!", 5 "Hello! Welcome to … world …", 1 "Hello!", measured through `asha` |
| Cold model download | the first run after a build, empty model cache and no image: 15.4 s, 19.2 s, 27.5 s and 34.4 s on different runs. Almost all of it is the 640 MB download of `qwen3-0.6b-q8_0`, the model pinned then; today's `qwen3-8b-q4_k_m` is larger. TODO: a cold-download timing for qwen3-8b-q4_k_m. |
| `./asha`, run for real | with no `dist`, it exits 1 and names the build command, without running npm; after `npm install && npm run build` (0.9 s from a fresh clone), it runs the CLI; it works through a symlink |
| Containers reach the host's loopback | a listener bound only to `127.0.0.1` answered from a colima container |
| colima needs no interaction | a fresh throwaway profile started with stdin closed: exited 0 in about 2 minutes 11 seconds, including the VM image download; logged "Terminal is not available, proceeding without opening an editor"; the profile was deleted afterwards |
| `brew install colima docker` is non-interactive | run as part of the same check |
| Guard proofs (PRINCIPLES §3) | each broken on purpose, and its test went red: the channel's ack bookkeeping; the CLI's "no reply" failure; the server's connect-before-headers order; the model store's sha256 check; the gateway's `stream:false`; the model server's `--port 0`; the image's staged SDK |

### Why the build fingerprint exists

A daemon started before a fix kept answering with the old behaviour, and nothing said so; the version was `0.1.0` in both. The fingerprint and the build warning followed ([Architecture](index.md#which-build)).

### `reply` split from `send_message`

Until then, `send_message` was the only tool, with `user` as one of its destinations. Through `./asha`, a user's `Hi` to everyone was answered with `Hi` posted to the channel, so the user got no reply. The routing eval reproduced it on every attempt. Choosing between two named tools replaced filling in a destination field. The `all-agents` destination was called `channel` until the same day, renamed because the user is on the channel too.

### Routing eval at `942eb7e` (clean tree) {#routing-942eb7e}

The shared channel layer as it was then: `send_message` plus `list_agents` and `pass`; a tool call required on every turn; the recipe's `description` in the roster. Each cell is passes out of 3 runs.

| Case | 0.6B Q8_0 | 1.7B Q8_0 | 4B Q4_K_M | 8B Q4_K_M |
|---|---|---|---|---|
| `solo-answer`: alone, a request to everyone is answered to the user | 0/3 | 0/3 | 0/3 | 3/3 |
| `solo-addressed`: alone, a request addressed to the agent is answered to the user | 0/3 | 3/3 | 3/3 | 3/3 |
| `addressed-answer`: with another agent present, a request to the agent is answered to the user | 3/3 | 3/3 | 3/3 | 3/3 |
| `broadcast-answer`: with another agent present, a request to everyone is answered to the user | 3/3 | 3/3 | 0/3 | 3/3 |
| `delegate`: "ask hewo-2 to …" goes to hewo-2 as a task | 0/3 | 3/3 | 3/3 | 3/3 |
| `delegated`: a task from an agent is done, and the result goes to the user | 3/3 | 3/3 | 0/3 | 3/3 |
| `delegated-bare`: bare words from an agent are said to the user | 0/3 | 3/3 | 0/3 | 3/3 |
| `delegate-by-role`: "the agent that translates" is found through `list_agents` and gets the task | 0/3 | 3/3 | 3/3 | 3/3 |
| `claim`: asked "which agent can …", tell the asker you'll take it | 0/3 | 3/3 | 0/3 | 3/3 |
| `ignore-agent-request`: an agent's request the role doesn't cover gets `pass` | 0/3 | 0/3 | 0/3 | 0/3 |
| `ignore-user-request`: a user's request the role doesn't cover gets `pass` | 3/3 | 0/3 | 0/3 | 0/3 |

- **Why 8B then.** It passed every case except the two "ignore" cases. In `delegate-by-role` it called `list_agents` once, then picked `trans-1` from the translator's description.
- **What still failed.** Both "ignore" cases, on every model, the same way: after `list_agents`, the agent either offered to do work outside its role or forwarded it to an agent whose description doesn't cover it — even with an explicit rule, "only take on work your role covers, and only pass work to an agent whose description covers it".

**Compared with the previous run, at `426eecb`**, which had no `list_agents` or `pass` and allowed plain-text answers:

- **Required tool calls fixed the case that exposed the problem.** A real `./asha` run with one agent addressed directly lost the reply: the model answered in text, and the eval missed it because its addressed case always had a second agent. Adding `solo-addressed` confirmed it; requiring a tool call fixed it.
- **`claim` now passed on 8B** (and on 1.7B).
- **The 0.6B model made real tool calls.** Before, it only wrote them out as text; its "ignore" passes became real `pass` calls rather than vacuous.

### Correction: model size and judgement {#model-size}

Earlier in this work it was said that small models were "not reliable at general judgement tasks (broadcasts, claiming requests, avoiding unrelated work) at that size." That was a guess from ad-hoc spike scripts with hand-copied prompts, one run per case. The eval at `942eb7e` does not support it: 1.7B and 8B pass the broadcast case, and the judgement cases fail the same way at every size, which does not show a size limit.

### Milestones built {#built}

- <span class="badge built">built</span> **The two-agent hello world** ([now](channel.md#two-agent)). The owner's plan: two hello-world instances, `hewo-1` and `hewo-2`, on one channel. The user sends `to=hewo-1` a request to ask `hewo-2` to say Hello World; `hewo-1` delegates with an `internal` message addressed `to=hewo-2`, and `hewo-2` answers with `output`. Why: it shows the channel carrying agent-to-agent traffic, and addressing working at both levels, user to agent and agent to agent. It needed a second instance of a recipe on a channel, agents knowing who else is on the channel, and an agent turning a request into an addressed `internal` message.
- <span class="badge built">built</span> **Agent memory tiers**, as the `memory` recipe ([now](memory.md)). Memory lives in the agent's container (the owner's option A), keyed by (channel, user) from the harness-set `user`, so the per-run handle numbering doesn't matter.
- <span class="badge built">built</span> **Installing asha with Homebrew** ([now](index.md#homebrew-keg)). The owner's plan, 2026-09-26: `brew install` with no checkout and no build. Built 2026-09-27 from a local tap, with no public tap until the owner says so (plan (`docs/plans/brew-install.md`)).
- <span class="badge built">built</span> **Collaborating agents** ([recipes](recipes.md#documents), [teams](recipes.md#team)). The owner's target, 2026-09-27: agents specified by their recipes — prompt, tools and Markdown documents they can read and edit in `/workspace` — and teams in their own folders launched together with `--launch team=<team>`, each member under its team name. Built 2026-09-29 (`docs/plans/collaborating-agents.md`); its approved ten-agent scenario, the rainbow, runs on the model: a supervisor consults nine members in one call and orders their numbers by the rainbow from one gather ([Testing](../testing/index.md#rainbow)).

### The owner's memory brief {#brief}

A new agent image and recipe to test memory. Once running, the agent builds memory from its conversations on the channel, in four tiers:

1. **Session**: the current session, as a sliding window of recent turns.
2. **Episodic**: earlier turns — previous sessions, plus turns of the current session that have slid out of the window. Searchable.
3. **Semantic**: important facts extracted from the turns, including the user's preferences. Searchable.
4. **Procedural**: reusable techniques. When the agent determines that a technique was effective for accomplishing a task, it records the procedure for future use. Searchable.

Each tier has a **read** (search) component and an **async write** component: relevant memory goes into the model's context **before** each model call; extraction happens **after** the agent has responded. Nothing from one user's memory may reach another user's context: mixing them would be a privacy failure. The harness passes the user's identity with every message as metadata the agent cannot change.

The brief's tests: two users at once never see each other's memory (unit, integration and agent-suite tests); a fact told in one conversation is recalled in a later one, and not for another user; a turn that has slid out of the session window is still found by relevance; a stated way of working (for example "answer me in bullet points") shapes a later answer (superseded, [above](#corrections)); memory lasts exactly as long as the container; a delegated task keeps the user's identity end to end.

### Correction: what "procedural" means {#procedural}

The first draft defined the procedural tier as "learnings about how to do things well for this user", and it was built that way (extracting "how to work with this user" notes such as "answer in bullet points"). The owner corrected it: procedural memory is a reusable technique the agent determined was effective for accomplishing a task, recorded for future use. A preference like "answer in bullet points" is a fact about the user, so it belongs to the semantic tier. The extraction prompts, tool name (`save_procedures`) and tests now follow the owner's definition (commit `34abbb6`).

### The memory design {#memory-design}

The design the first build set out to follow, 2026-09-26:

| Idea | The design |
|---|---|
| **One JSON document per (user, agent, tier)** | Rewritten whole: `{schemaVersion, tier, updatedAt, records: [{id, ts, kind, text, meta, embedding}]}`. Tolerant parsing: a bad record is dropped, not the whole file. |
| **Atomic writes** | Write to `<file>.tmp-<ts>-<rand>`, then rename over the target. The version tag is a sha256 of the content; a write whose file changed underneath it re-reads, merges and retries. |
| **In-memory cache** | An LRU keyed by file path in front of the files. Writes change the cached document at once, then save in the background; saves for one file queue behind each other. |
| **Recall** | Cosine similarity over vectors held in memory, with a hard cutoff (`minScore`). Nothing below it is included; no fallback to "most recent". |
| **A token budget with a reserved share per tier** | A greedy budget can starve one tier, so each tier keeps a share of its own. |
| **Semantic extraction** | The model sees the existing facts and is asked for at most 3 *stable* new ones. A new fact with cosine ≥ 0.95 to an existing one is dropped, so paraphrases of a known fact do not pile up. |
| **Identity is a parameter on every call** | Never a field on an object. Every cache and storage key includes the user. Any change to per-user data needs a test with two users at once. |

Choices of its own: embeddings are local (no hosted embedding service); the session tier is time-bounded rather than a stored conversation, because each `./asha message=…` is its own conversation, usually one turn (it continues while turns are less than `sessionIdleMinutes` apart, default 30, and shows the last `sessionWindow` turns, default 8); and old-turn summarisation isn't planned: the tiers drop the oldest records past a cap.

### Memory build phases {#phases}

| # | Phase | Status |
|---|---|---|
| 1 | User identity on every conversation message | <span class="badge built">built</span> 2026-09-26 |
| 2 | <s>Memory mount</s>: not needed; memory stays in the container (owner's option A) | dropped |
| 3 | Embedding model, server and route | <span class="badge built">built</span> 2026-09-26, after the owner accepted Apache-2.0 declared only in the model card |
| 4 | Memory library and agent graph in `images/memory`, with fakes for model and embedder | <span class="badge built">built</span> 2026-09-26: 34 unit tests, incl. two users at once; the privacy and read-your-writes guards were each broken on purpose and caught |
| 5 | Recipe, integration tests, agent-suite scenarios (single and multi agent, two users), report | <span class="badge built">built</span> 2026-09-26. `tests/agents/memory-agent.test.ts`, 7 of 7 at `f0815ae`, passing on two consecutive runs; `npm run check` is green |
