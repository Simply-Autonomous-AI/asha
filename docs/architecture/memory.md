---
title: Agent Memory
description: The memory recipe's four memory tiers — session, episodic, semantic, procedural — scoped per (channel, user), read before each model call and written after the agent answers, where they live, and how they are built and tested.
---

# Agent memory

The `memory` recipe's agent (`memo`) remembers each user in four tiers — session, episodic, semantic and procedural. It recalls before each model call and extracts new memory after it has answered.

<div class="facts"><span>verified 2026-09-27</span><span><span class="badge built">built</span> 2026-09-26</span><span>tests: gate at <code>05555b1</code></span><span>code: <a href="../../images/memory/src/memory/index.ts"><code>images/memory/src/memory/</code></a></span></div>

> [!SUMMARY]
> - Memory is per (channel, user) and lasts as long as the container — unless its recipe names `persist: ["memory"]`, when it is saved at every acknowledged turn and restored at the next launch of the same identity ([below](#persisted)); identity is claimed, not authenticated (debt D2).
> - Session is the last 8 turns with gaps of at most 30 minutes; episodic, semantic and procedural are searched by meaning, cosine ≥ 0.3.
> - Recall runs before the model call; extraction runs after the reply without delaying it, and the next message waits for it.
> - Files live at `/memory` inside the container, one folder per user and one JSON file per tier; the harness never reads or writes them.
> - Every memory scenario passes at `05555b1`: 7 agent, 12 tiers, 3 crowd.

## Status {#status}

<div class="stats"><div class="stat"><b>4</b><span>tiers, one folder per user</span></div><div class="stat"><b>7/7</b><span>memory-agent at 05555b1</span></div><div class="stat"><b>12/12</b><span>memory-tiers at 05555b1</span></div><div class="stat"><b>3/3</b><span>memory crowd at 05555b1</span></div></div>

Built 2026-09-26 on the real chat and embedding models, from the owner's brief and the design it set out ([both in history](history.md#brief)). Results from the gate at `05555b1`, committed in `c34f38e`; transcripts in the [agent test report](../testing/agent-tests.md).

## One message: read before, write after {#cycle}

`memoryAgent` in [`images/memory/src/agent.ts`](../../images/memory/src/agent.ts) runs a pipeline of nodes, the "agent graph", for each delivery.

![The numbers are `DEFAULT_POLICY` in [`memory/index.ts`](../../images/memory/src/memory/index.ts) and the extraction limits in [`memory/extract.ts`](../../images/memory/src/memory/extract.ts).](memory-cycle.svg)

1. **identify:** the user is `delivery.message.user`; a message without one is refused (`scopeOf` throws).
2. **recall,** each tier in parallel: the session window as real chat turns; for the other tiers, the top-k by cosine to the embedding of the message's text — or, for a [gather](channel.md#calls), of the message the call was made for (`call.context.text`), since a gather's own text is only the harness's count of answers — at or above `minScore`.
3. **assemble**: a `# Memory` section with a reserved share per tier (`assemble`), passed to `channelTurn` as `memory`, where it opens the incoming message's user turn after the agent's identity line (an agent alone has none) — never the system prompt, which every memory agent on the channel shares byte for byte so the model server's prompt cache can reuse it ([the shared prefix](channel.md#prefix)); then `withMemory` puts the session turns before the incoming message and leaves the system prompt untouched. Each session turn is framed by who wrote it, as its episode is (`writerOf` in [`memory/session.ts`](../../images/memory/src/memory/session.ts)): "The user wrote:" for the user's own, "Agent <name>, for the user, wrote:" for a task another agent passed on (the owner, 2026-10-12, record `memory-delegated-task-replay`, option (a)). *(Corrected 2026-10-12: every remembered turn was replayed as "The user wrote:", whoever wrote it, so the model was told the user wrote a delegated task's words; found by the unit-test workflow's ninth review, R9-SEM-001.)*
4. **decide / act:** the normal [channel layer](channel.md#acting) (`reply`, `send_message`, `consult`, `pass`, and in a call turn only `reply` and `pass`, plus any tool its recipe selects, such as `reply_with_files` or `ask_user`) from [`src/agent-sdk/channel.ts`](../../src/agent-sdk/channel.ts); `act` is given the whole delivery, so an answer in a call turn goes to the caller through the answer route.
5. **remember,** not awaited by the handler but registered as background work, which the agent finishes before it exits when stopped: append the turn to session and to episodic at once, embedded (recall skips episodes still in the window, so nothing moves between tiers — except a turn whose own episode could not be embedded, which the write after it stores as an episode once it slides out of the session window, its facts and procedures having been extracted anyway; a turn either tier already holds, by id, is not stored there again); extract semantic facts and procedures (reusable techniques that worked) with the chat model, de-duplicated and embedded; the model is shown the turn framed by who wrote it, as in step 3 (*until 2026-10-12, always as "The user wrote:"*). Replies, hand-offs, consults, replies with files and questions to the user are remembered (`responseOf`): a consult as `(consulted <to>: <text>)` per request, a reply with files as its text followed by `(gave the user files: <name>, …)`, each name the last part of its `/channel` path, and a question as `(asked the user: <text>)` (the owner, 2026-10-11, record `memory-remember-files-and-questions`, option (a)); a pass isn't a turn (`responseOf` returns `null`). *(Corrected 2026-10-11: this said only replies, hand-offs and consults were remembered, which was true of the code: a turn answered with files or a question was not remembered at all, so the user's own message in it was lost; found by the unit-test workflow's fifth review, R5-SEM-001.)* A call's question and a gather are never remembered (`message.call` set): their words are an agent's, not the user's; the turn that consulted is remembered. *(Corrected 2026-10-12: this also gave as a reason that every remembered turn is replayed as the user's, untrue since step 3 frames each turn by who wrote it.)*

> [!NOTE] The agent reads its own writes
> The next message's recall waits for that user's pending writes (`AgentMemory.recall` awaits `AgentMemory.settled`: the scope's queued `remember`, then `MemoryCache.settled`).

> [!NOTE] A write in flight at stop is finished, not failed
> Each `remember`, through its files being saved (`AgentMemory.settled`), is registered with the SDK as background work (`context.background('memory.remember', …)`). When the agent is stopped it waits for it, up to 65 s, before it exits, and the daemon keeps its model servers running until the agent has exited ([stopping](channel.md#stop)). A write still unfinished at that bound is logged at error as `agent.drain_incomplete`, never dropped silently. Until 2026-09-27 a write in flight at `asha --stop` failed as `memory.write_failed` ("fact extraction failed: unavailable: fetch failed"), because the daemon stopped its server and model servers under it; the regression test is `a remember in flight when SIGTERM arrives is written to disk before the agent exits` in [`tests/unit/memory/agent.test.ts`](../../tests/unit/memory/agent.test.ts). For a recipe that does not persist memory the finished write is still removed with the container (`docker run --rm`, [below](#where)), so what the drain saves is a complete record and clean logs; for one that does, the SDK acks a persisted agent's delivery only after its background work settles, so the checkpoint that follows the ack holds the turn's writes ([persisted memory](#persisted)).

<p class="pre-label">images/memory/src/agent.ts — memoryAgent</p>

```
return async (delivery, context) => {
  const { message } = delivery;
  const scope = scopeOf(message);
  // A gather's text is the harness's count; recall by the message the call was made for.
  const recall = await props.memory.recall(scope, message.call?.role === 'gather' ? message.call.context.text : message.text);
  const roster = await context.roster();
  const others = roster.map((a) => a.handle);
  // Its role is its recipe's prompt; its tools are the ones its recipe selects.
  const persona = { role: context.prompt, guidance: context.guidance, tools: context.tools.definitions, … };
  const request = withMemory(channelTurn({ handle: context.handle, others, persona, message, maxTokens: MAX_TOKENS, memory: recall.context }), recall.history);
  // One working status for the turn, whether reply_with_files (posted inside decide) or act() says it first.
  const poster = turnPoster(delivery, context);
  const calls = await decide({ model: context.model, request, message, roster, maxRounds: MAX_ROUNDS, maxCorrections: MAX_CORRECTIONS, tools: context.tools, replyWithFiles: poster.replyWithFiles });
  …
  await act(calls, others, delivery, context, poster);
  const response = responseOf(calls);
  // A call's question and a gather are not remembered.
  if (response !== null && message.call === undefined) {
    …
    // Not awaited: extraction takes model calls, and the user already has the answer. Registered, so an
    // agent told to stop waits for the write to reach disk (serveAgent's drain) instead of losing it.
    context.background('memory.remember', props.memory.remember(scope, turn).then(() => props.memory.settled(scope)));
  }
};
```

*(Corrected 2026-10-11: this excerpt showed `persona: PERSONA`, `withMemory(…, recall)` and a `decide` without the message or tools — the agent before `docs/plans/collaborating-agents.md` R1, which took the role out of the image and into its recipe, and before the recalled memory moved into the per-agent block; found by the unit-test workflow's fifth review, R5-SEM-007.)*

Asked about themselves when it knows nothing yet, `memo` says so if addressed directly, but calls `pass` when the question went to everyone, so an agent that does know can answer (the owner's rule, 2026-09-26, commit `5b4e25c`; carried by its recipe's prompt, [`recipes/memory.json`](../../recipes/memory.json) — *corrected 2026-10-11: this said "carried by the persona", the image's own prompt, which no longer exists*).

## User identity {#identity}

![From the claimed ID to one folder per (channel, user): the same name on two channels is two scopes.](memory-scope.svg)

The channel sets `user` on every `ConversationMessage` ([`src/shared/protocol.ts`](../../src/shared/protocol.ts)), including agent-to-agent `internal` messages and statuses; no agent can change it, so a delegated task carries the same user's memory. The scope is (channel, user), never the ID alone: `user-1` on `main` isn't `user-1` on `lab`. The ID is whatever the caller claimed with `user=`, or by default the CLI user's login name, converted ([Users](channel.md#users)): isolation holds between honest users, not against someone who names themselves as another, and login names that differ only in case, `.`, `_` or `-` are one user.

## Where memory lives {#where}

> [!DECISION] The owner, 2026-09-26, option A
> Memory lives only in the agent container's own filesystem, at `/memory`, with nothing mounted from the host or a volume. The [`images/memory/Dockerfile`](../../images/memory/Dockerfile) creates `/memory` owned by `node`.

- **One folder per user,** named `sha256("<channel>/<user>")[:16]` (`scopeKey`), so raw IDs aren't in paths.
- **One file per tier:** `session.json`, `episodic.json`, `semantic.json`, `procedural.json`.

> [!WARNING] Memory lasts as long as the container — unless its recipe persists it
> For every recipe that does not name `"memory"` in `persist` (`recipes/memory.json` does not), `./asha --stop`, a daemon restart, or a rebuilt image (which replaces the container) starts it empty, and "previous conversations" means those since the container started. The owner's decision above stays true for them.

### Persisted memory {#persisted}

A recipe may name `"memory"` in `persist` ([recipes](recipes.md#recipe); `docs/plans/agent-persistence.md` R1, R12, R16), and only on an image whose `image.json` declares `"keepsMemory": true`, `"eraseUser": true` and a `"stateSchema"` — the memory image does (`stateSchema` 1). Then:

- **Where it lives.** Still only in the container at `/memory` while the agent runs; nothing is mounted. The daemon copies `/memory` out (`docker cp`, streamed through its tar reader) after every acknowledged turn and at a stop, into `ASHA_HOME/state/agents/<channel>/<team or ->/<name>/` ([where things live](index.md#state)), and copies it back in before the next launch of the same identity starts the container. The identity is (channel, team or `-`, member name or recipe id), never the handle.
- **Bounded:** at most 4,096 files, 64 MiB and 8,192 entries for the whole of `/memory` (`ASSET_BOUNDS` in [`src/daemon/state/store.ts`](../../src/daemon/state/store.ts)): every directory and file counts as an entry but the root, twice the files' bound, room for every file in a directory of its own. The bound is on the snapshot, not per user: once it is passed every later checkpoint of that agent fails `over_bound` — for every user of it — until `--reset-state` or an erase makes room; the agent keeps running and the channel shows `⚠ <handle>'s state is not being saved (over_bound); …` ([CLI](../cli/index.md#state)).
- **Validated at start.** Before it joins, the memory image checks every restored file (`validateMemory` in [`images/memory/src/memory/persisted.ts`](../../images/memory/src/memory/persisted.ts)): only scope folders of 16 hex digits, each holding only `<tier>.json` documents that parse as their tier. The first invalid one makes the agent exit non-zero, logging `memory.invalid_at_start` with `MemoryFileInvalid` naming the file and, for a file that is not JSON, only `SyntaxError at position <n>` — never a byte of it (`jsonErrorPosition` in [`store.ts`](../../images/memory/src/memory/store.ts)). A failed write removes its temporary file — and if removing it fails too, rejects with `MemoryWriteCleanupFailed`, its message naming both failures by code and syscall (*corrected 2026-10-11: until then the removal's error replaced the write's own, which was lost; found by the unit-test workflow's sixth review, R6-SEM-001*); a write's temporary that a checkpoint's copy caught half done (`<tier>.json.tmp-<ms>-<hex>`) is removed at start and counted in the agent's log, its document being the one beside it — any other stray name is still refused.
- **Erasing one user** (`asha --reset-state channel=… [name=… [team=…]] user=<id>`, [CLI](../cli/index.md#state)): the daemon runs the agent's image once in erase mode, `erase-user --channel <c> --user <u>` (`runEraseMode`), with `--network none`, no `ASHA_URL` or token, and a copy of the saved `/memory` alone. It deletes that user's scope folder without parsing any file and prints one line, `{"erased":{"files":<n>,"bytes":<n>}}` — `0` and `0` when the scope folder is absent, or is there but holds no regular file (an empty folder, as a scope's first failed write leaves, is then deleted) (*corrected 2026-10-11: this said "only when the scope folder itself is absent", which the code never did; found by the unit-test workflow's tenth review, R10-SEM-004*); exit 0, 2 for arguments it does not take, 1 for any other failure (its reason on stderr, naming the scope by its key, never the user), a file or folder vanishing from inside a found scope folder included. *(Corrected 2026-10-11: a "not found" from anywhere inside the folder was taken as nothing there, so the erase printed `0` and `0`, exited 0 and left the user's folder in place — a false success the daemon reported as `no_memory`; found by the unit-test workflow's fifth review, R5-SEM-004.)* The daemon accepts the result only if the new `/memory` is the old one with entries removed and none added or changed, the removed files' count and bytes equal to the line's (`subsetProblem` in [`src/daemon/agents/index.ts`](../../src/daemon/agents/index.ts)), and promotes it as a new generation; the one-shot is bounded by 60 s and 4 KiB of stdout; anything else keeps the previous generation (`erase_not_subset`, [logs](index.md#logs)).
- **What it cannot protect.** Saved memory is served to anyone who claims the user name on that channel (D2); a reset or erase does not reach backups (Time Machine) made before it.

The agent-suite scenarios that exercise this on the real model and containers — a fact recalled and each file byte-identical after `--stop` and relaunch, another member name holding none of it, a corrupted file refused at start, an erase leaving the other users byte-identical (agent-persistence A2, A9, A10, A17; [`tests/agents/persistence.test.ts`](../../tests/agents/persistence.test.ts)) — are green in `npm run test:agents` at `302eb14` (2026-09-29: 30 files, 111 tests passed).

## The tiers as built {#tiers}

<p class="pre-label">images/memory/src/memory/index.ts — DEFAULT_POLICY</p>

```
export const DEFAULT_POLICY: MemoryPolicy = {
  sessionIdleMs: 30 * 60_000,
  sessionWindow: 8,
  topK: { episodes: 4, facts: 6, procedures: 4 },
  minScore: 0.3,
  duplicateScore: 0.95,
  caps: { episodes: 500, facts: 200, procedures: 100 },
  budget: { chars: 4800, shares: { episodes: 0.35, facts: 0.35, procedures: 0.3 }, perItem: 480 },
};
```

| Tier | Read | Write | Cap |
|---|---|---|---|
| session | `currentSession`: turns with gaps ≤ 30 min, last 8, as `user`/`assistant` chat turns. Each `./asha message=…` is its own conversation, so a session is this user's recent turns. | append, unless the session already holds that turn's id; `slide` keeps the window | the window |
| episodic | `search`: top 4, cosine ≥ 0.3, excluding turns in the window | every turn as `episodeText`, embedded as a `document` | 500 newest |
| semantic | top 6, cosine ≥ 0.3 | `extractFacts`: a forced `save_facts` call, at most 3, shown what is already known | 200 newest |
| procedural | top 4, cosine ≥ 0.3 | `extractProcedures`: a forced `save_procedures` call, at most 2, "To \<accomplish what>: \<the steps or technique that worked>" | 100 newest |

- **De-duplication** (`addDistinct`): a new fact or procedure is dropped if its normalised text equals an existing one or its cosine to one is ≥ 0.95. Normalising sets aside case, punctuation and Unicode form (NFKC) and keeps every letter, combining mark and digit of any script, so "The user likes 寿司." and "The user likes 抹茶." are two facts. *(Corrected 2026-10-11: until then normalising deleted every letter outside ASCII, so different facts in another script, or differing only in such letters, were dropped as duplicates; found by the unit-test workflow's fourth review, R4-SEM-001.)*
- **Budget** (`assemble`): 4,800 characters (about 4 per token), 35% / 35% / 30% for episodes, facts and procedures, each item cut at 480 characters with `…`; shares above 1 throw. Sections: "What you know about this user", "Procedures that worked before", "Earlier conversations with this user".
- **Search:** ties go to the newer memory; vectors of different sizes throw.
- **Cache** (`MemoryCache`): bounded at 400 documents (`maxDocs` in [`main.ts`](../../images/memory/src/main.ts)). Past the bound it drops the least recently used documents with no save pending, no update in progress and no failed last save, so it holds more while saves are slow or failing: a document whose last save failed stays cached until a later save of it succeeds, so the change reported as unsaved is never then lost by eviction (the owner, 2026-10-11, record `memory-cache-failed-save`, option (a)). *(Corrected 2026-10-11: this said "at most 400 documents", which the code never promised — a document with a save pending was always kept past the bound (R5-SEM-016) — and a document whose save had failed could be dropped, losing its change (R5-SEM-005); both found by the unit-test workflow's fifth review.)*
- **Files** (`MemoryStore`): `{schemaVersion: 1, tier, updatedAt, turns | records}`, written to a temp file and renamed. A missing file reads as empty; a bad record is dropped and reported (`memory.records_dropped`); a file that is not a document of its tier is malformed (`MemoryFileInvalid`, with a reason naming what is wrong: `expected schemaVersion 1 and tier "<tier>"`, `no updatedAt string`, `no records array`). A running agent that reads a malformed file heals it: it is reported first, at error, as `memory.file_malformed` naming the file, then overwritten with its tier's empty document, which the read then returns — what was in it is lost, and only the log line records why (the owner, 2026-10-11, record `memory-unreadable-session-episodic`: a malformed tier file is a major defect, logged loudly for the failure scan, and the agent loop self-heals by overwriting it). A file that cannot be read at all (`EACCES`, `EIO`) is not malformed and is not overwritten: its read fails. At start, a persisted agent's restored file that is malformed still ends the launch ([validated at start](#persisted), agent-persistence R12). *(Corrected 2026-10-11: a malformed file threw on every read, so one bad file stopped that user's memory for good; found by the unit-test workflow's seventh review, R7-SEM-002.)*
- **Failures:** `memory.save_failed`, `memory.write_failed`, `memory.records_dropped` and `memory.file_malformed` go to the agent's log as one JSON error line each, with the scope as its hash, never the raw user ID. A failed embedding throws `EmbeddingFailed`, a failed extraction `ExtractionFailed` — including a `save_facts` or `save_procedures` reply with an item that is not text, of which nothing is then kept (the owner, 2026-10-11, record `memory-extract-non-string-items`, option (a); until then such an item was dropped silently). A turn's two extractions, and their saves, are independent: a failed one is reported and costs only its own tier, and the other tier's items are still saved (the owner, 2026-10-11, record `memory-extraction-partial-failure`, option (a); until then a failure in either discarded both). An episode that cannot be embedded is reported and costs only the episodic tier: the turn's facts and procedures are still extracted and saved (the owner, 2026-10-11, record `memory-episode-failure-extraction`, option (a); until then the write stopped there and the turn's facts and procedures were never extracted). So does every other tier: a session or episodic document that cannot be read, and a facts or procedures document that cannot be read, is reported once with its own error and costs only its own tier — a failed session step leaves the turn itself as the only episode — while the turn's facts and procedures are still extracted and saved (the owner, 2026-10-11, record `memory-unreadable-session-episodic`, option (a); until then such a document stopped the whole write, R7-SEM-002).

## Embeddings {#embeddings}

A catalogue entry for **Qwen3-Embedding-0.6B (Q8_0)**, [`qwen3-embedding-0.6b-q8_0`](models.md#qwen3-embedding), recommended by the 2026-09-26 research, runs on a second `llama-server` (`--embeddings --pooling last`, since one server serves one model): about 0.9 GB more memory and $0 per call, with nothing leaving the machine. The agent calls `POST /agent/v1/model/embed`, authenticated like `/model/chat` ([the gateway](models.md#gateway)), through `harnessEmbedder`, which wraps `HarnessClient.embed`. A recipe names its `embeddingModel` ([recipe spec](recipes.md#recipe)). Neither `Qwen/Qwen3-Embedding-0.6B-GGUF` (revision `370f27d7`) nor `Qwen/Qwen3-Embedding-0.6B` (`97b0c614`) has a LICENSE file; both cards declare `apache-2.0`, which the owner accepted on 2026-09-26, so the card is pinned as the licence record (AGENTS.md §3).

## Code map {#code}

| File | Symbols | Role |
|---|---|---|
| [`images/memory/src/main.ts`](../../images/memory/src/main.ts) | — | Entry point, wiring only: `MEMORY_ROOT = '/memory'` |
| [`images/memory/src/agent.ts`](../../images/memory/src/agent.ts) | `memoryAgent`, `scopeOf`, `withMemory`, `responseOf`, `NAME`, `MAX_TOKENS`, `MAX_ROUNDS`, `MAX_CORRECTIONS` | The agent graph; its role and tools come from its recipe *(corrected 2026-10-11: listed `PERSONA`, removed by collaborating-agents R1)* |
| [`memory/index.ts`](../../images/memory/src/memory/index.ts) | `AgentMemory` (`recall`, `remember`, `settled`), `DEFAULT_POLICY` | The module's public surface |
| [`memory/session.ts`](../../images/memory/src/memory/session.ts) | `currentSession`, `slide`, `episodeText` | The time-bounded session |
| [`memory/relevance.ts`](../../images/memory/src/memory/relevance.ts) | `cosine`, `search` | Recall with a hard cutoff |
| [`memory/assemble.ts`](../../images/memory/src/memory/assemble.ts) | `assemble` | The `# Memory` section |
| [`memory/extract.ts`](../../images/memory/src/memory/extract.ts) | `extractFacts`, `extractProcedures`, `SAVE_FACTS`, `SAVE_PROCEDURES` | Semantic and procedural extraction |
| [`memory/cache.ts`](../../images/memory/src/memory/cache.ts) | `MemoryCache` (`get`, `update`, `settled`) | LRU cache, background saves |
| [`memory/store.ts`](../../images/memory/src/memory/store.ts) | `MemoryStore`, `scopeKey`, `parseDoc`, `jsonErrorPosition`, `MemoryFileInvalid`, `MemoryWriteCleanupFailed` | Files, atomic writes, tolerant parsing; an invalid file named by position, never quoted |
| [`memory/persisted.ts`](../../images/memory/src/memory/persisted.ts) | `validateMemory`, `runEraseMode`, `eraseUser`, `parseEraseArgs` | A persisted `/memory` checked at start; the `erase-user` mode |
| [`memory/harness-embedder.ts`](../../images/memory/src/memory/harness-embedder.ts) | `harnessEmbedder`, `EmbeddingFailed` | Embedder over the harness route |
| [`memory/types.ts`](../../images/memory/src/memory/types.ts) | `Scope`, `Tier`, `Turn`, `Memory`, `Embedder` | The shapes |

## Tests {#tests}

| Suite | Where | What |
|---|---|---|
| Unit, with fakes for model and embedder | `tests/unit/memory/`: [`memory.test.ts`](../../tests/unit/memory/memory.test.ts), [`store-cache.test.ts`](../../tests/unit/memory/store-cache.test.ts), [`agent.test.ts`](../../tests/unit/memory/agent.test.ts), [`harness-embedder.test.ts`](../../tests/unit/memory/harness-embedder.test.ts), [`persisted.test.ts`](../../tests/unit/memory/persisted.test.ts) | Two users at once never see each other's memory; read-your-writes; a persisted agent acks only after `remember` settles; validation at start and the erase mode |
| Agent suite, real models and containers | [`memory-agent.test.ts`](../../tests/agents/memory-agent.test.ts) | alice and bob: semantic, recall, privacy, procedural, past the window, identity through delegation |
| | [`memory-tiers.test.ts`](../../tests/agents/memory-tiers.test.ts) | Each tier, privacy and scope, lifecycle (kept across conversations, empty after a restart) |
| | [`memory-crowd.test.ts`](../../tests/agents/memory-crowd.test.ts) | Ten agents, one told, all asked: exactly one answer |
| | [`persistence.test.ts`](../../tests/agents/persistence.test.ts) | Persisted memory across `--stop`, a crash and an erase (agent-persistence A2, A7–A10, A12, A17): green in `npm run test:agents` at `302eb14` (2026-09-29: 30 files, 111 tests passed) |

A procedure is a technique that worked for a task, not a user preference such as "answer in bullet points", which is a semantic fact ([the owner's correction](history.md#procedural)).
