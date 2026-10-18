---
title: Recipes and Configuration
description: The specification of every asha configuration file — recipes, their documents, teams, image definitions and catalogue entries — field by field, with validation rules, real examples, the environment variables and the harness home layout.
---

# Recipes and configuration

asha is configured by four kinds of checked-in definition — a recipe (with its documents), a team, an image, a catalogue entry — and a few environment variables.

<div class="facts"><span>verified 2026-09-29</span><span>schema: <a href="../../src/daemon/definitions/index.ts"><code>src/daemon/definitions/index.ts</code></a></span><span>adding a definition: <a href="extending.md">Extending asha</a></span></div>

> [!SUMMARY]
> - A recipe is the whole agent (AGENTS.md §3): its system prompt, one image, one chat model, optionally an embedding model, the tools it selects, optional Markdown documents placed in its `/workspace`, and time bounds. The command line names a recipe (`asha recipe=hello-world …`) or a team (`asha --launch team=…`), never an image.
> - An image carries no system prompt: the agent's role is its recipe's `prompt`, handed to it in its `welcome` event, so one image serves every recipe that names it.
> - A team is a folder `teams/<team>/` holding `team.json`, every member's recipe and every document they name; its members join one channel under their own names.
> - Every definition has a closed schema: an unknown or missing key is an error naming the file and field.
> - Definitions are re-read at every launch: an edit reaches the next agent, not one already online.
> - An image is rebuilt exactly when the digest of its staged files changes.

## How the definitions fit together {#overview}

![The `memory` recipe. `hello-world` is the same shape without `embeddingModel`.](recipe-loading.svg)

## Rules every definition follows {#rules}

| Rule | Detail |
|---|---|
| **Closed objects** | Exactly the listed keys, nested objects too: `unknown field …` or `missing field …` (`closedObject`). Only a recipe's `embeddingModel` and `documents` are optional. |
| **Names** | Match `/^[a-z0-9][a-z0-9._-]*$/` (`isName`); a file's `id` equals its file name. Strings are non-empty; integers > 0. |
| **Errors** | `DefinitionError(file, problem)`, e.g. `r.json: missing field image`; on the wire, `internal`. A missing recipe is `UnknownRecipe` (`unknown_recipe`), a missing image `UnknownImage` (`unknown_image`) (`classify` in [`src/daemon/agents/index.ts`](../../src/daemon/agents/index.ts)). |
| **The harness owns the request** | A `chat` block may not set `model`, `messages`, `max_tokens` or `stream` (`chatSettings`): `chat.<key> is set by the harness, not the definition`; nor `cache_prompt`, `n_cache_reuse`, `id_slot` or `message_delimiters` (`CACHING_FIELDS`): `chat.<key> changes the model server's prompt caching or slot choice, which the harness sets, not the definition` ([prompt cache](models.md#serving)). |

## Recipe: `recipes/<name>.json` {#recipe}

Parsed by `parseRecipe`; type `Recipe`.

| Field | Type | Meaning and validation |
|---|---|---|
| `id` | string | The name given on the command line; equals the file name. |
| `image` | string | `images/<image>/`; its `Dockerfile` is checked at launch. |
| `description` | string | One sentence, shown to other agents by `list_agents`. |
| `prompt` | string | The agent's system prompt: its role text, which the SDK puts into its instructions (`Your role: …`) on every turn. It reaches the agent in its `welcome` event; no image carries one (`tests/unit/image-prompts.test.ts` fails on an image module exporting `PERSONA` or an object with a string `role`). |
| `model` | string | Catalogue id of an entry with `kind: "chat"` (`Definitions.chatModel`), or a hosted model, `<module>/<name>`: a [ModelProvider](modules.md#kinds)'s model, which makes the recipe cloud-granted ([Models](models.md#providers)). |
| `startupTimeoutMs` | positive integer | Launch → announced; past it the container is stopped (`AgentStartFailed`, `agent_start`). |
| `messageTimeoutMs` | positive integer | Delivery → ack; past it the agent is stopped. |
| `chat` | object | Sampling over the model's catalogue `chat` (the recipe wins); `{}` for none; passed to `llama-server` unchecked. For a hosted model only `temperature` and `top_p` are allowed, the settings a provider translates; any other key fails the launch naming it. |
| `embeddingModel` | string, optional | Catalogue id of an entry with `kind: "embedding"`, or a provider's embedding model `<module>/<name>`, for `/agent/v1/model/embed`. Absent → `null`, and that route answers 400. |
| `modules` | list, optional | The [module](modules.md) tools the agent may call, each `<module>/<tool>` — a ToolModule's tool or a command plugin's command — its one allow list (`docs/plans/extension-modules.md` R29); absent → `[]`. Each must match `^[a-z][a-z0-9_]{0,31}/[a-z][a-z0-9_]{0,31}$`, none twice. Checked at launch before any container starts (`checkLaunchModules` in [`src/daemon/modules/launch.ts`](../../src/daemon/modules/launch.ts)): a module not installed, a tool it does not declare, a ModelProvider named here, a granted tool whose `timeoutMs` + 125,000 ms passes `messageTimeoutMs`, a metered module not enabled, or a command plugin without the owner's cost approval fails it (`module_refused`), naming both. The granted tools count with `tools` against the 11 selected and granted. |
| `roots` | list, optional | Folders a command plugin's path arguments may name besides the channel's space, each `{"name", "path", "mode"}`: `name` matching `NAME_PATTERN` and unique, `path` absolute or `~/…`, `mode` `"read"` or `"read-write"`; absent → `[]`. Resolved (`realpath`) and refused at launch (`module_refused`) when it is `/`, is or contains the home folder, is, contains or lies inside `ASHA_HOME`, lies under `~/Library`, or has a deny-listed component ([command plugins](modules.md#plugins)). A root also reached by a recipe of the other kind — one keeps memory, the other is cloud-granted — refuses the launch, naming both recipes. |
| `documents` | list, optional | Markdown documents `{"path", "fullText"}` placed in the agent's `/workspace` at start ([below](#documents)); absent → `[]`. |
| `tools` | list of tool names | The tools the agent is offered after the channel tools, in this order, from the six common tools, its image's `image.json` and the two selectable channel tools, `reply_with_files` and `ask_user`, which are offered right after `reply` instead, in that order ([agent tools](channel.md#tools), [returning files](channel.md#files), [asking the user](channel.md#asking)); `[]` for none; no name twice. Checked at launch before anything starts (`resolveTools` in [`src/daemon/definitions/tools.ts`](../../src/daemon/definitions/tools.ts)): a name no source declares, a name two sources declare (common, image, channel or module tool), an image tool of class `command` or `network`, or more than 11 selected and granted tools fails it with `ToolSelectionInvalid` naming the recipe file and the tool(s). The selection reaches the agent in its `welcome` event, never its environment. |
| `persist` | list, optional | What of the agent is kept across stops (`docs/plans/agent-persistence.md` R1): any of `"memory"` and `"workspace"`, each at most once (`persistList` in [`src/daemon/definitions/index.ts`](../../src/daemon/definitions/index.ts)); absent → `[]`, and nothing is saved. `"memory"` needs an image whose `image.json` declares `keepsMemory`, `eraseUser` and a `stateSchema` ([below](#image)), checked at launch by `checkPersistence`, which fails naming the recipe file and the image. A recipe that persists anything and is launched alone is saved under its `id`, which must then match `NAME_PATTERN`. The saved state, its bounds (`/workspace` 256 files, 16 MiB and 512 entries, `/memory` 4,096 files, 64 MiB and 8,192 entries — every directory and file an entry but the root, `ASSET_BOUNDS`; past any, the checkpoint fails `over_bound`) and what happens at a stop: [where things live](index.md#state), [persisted memory](memory.md#persisted), [stopping](channel.md#stop). |
| `launch` | object, optional | The recipes its agent may launch onto its channel ([launching](channel.md#launching); `docs/plans/patterns-phase-3.md` R29): `{"recipes": [<1–3 distinct ids>], "maxPerConversation": <1–3>}`, a closed object. Only in a team's folder (a recipe in `recipes/` naming it is refused): each id is a channel base name (`agentBaseNameProblem`) and a file `<id>.json` in the same folder, whose recipe names none of `persist`, `restart`, `launch`, `modules`, `roots` and `embeddingModel`, runs the granting recipe's `image` and `model`, and has a `startupTimeoutMs` of at most 30,000; anything else fails the team's load, naming the member, the id and the rule. Absent: launches nothing. |
| `nestedCalls` | `true`, optional | Its call turns may consult other agents before answering ([nested calls](channel.md#nested); `docs/plans/patterns-phase-3.md` R33): only `true` (any other value is refused at load); absent, a call turn answers or passes. |
| `restart` | object, optional | Its supervisor's restart intensity (`docs/plans/patterns-phase-3.md` R10): `{"max": <1–5>, "withinMs": <1,000–3,600,000>}`, whole numbers, a closed object (`restartPolicy` in [`src/daemon/definitions/index.ts`](../../src/daemon/definitions/index.ts)); absent → never restarted. An online agent that exits on its own is restarted under its handle, its held messages sent again, at most `max` times in any `withinMs` and each message at most `max` times ([restarting a crashed agent](channel.md#restarting)). Refused beside a non-empty `persist`. |

<p class="pre-label">recipes/hello-world.json</p>

```
{
  "id": "hello-world",
  "image": "hello-world",
  "description": "Says whatever it is asked to say.",
  "prompt": "you say what you are asked to say, word for word. That is the only work you do: you cannot translate, write, summarise or look anything up.",
  "model": "qwen3-8b-q4_k_m",
  "startupTimeoutMs": 60000,
  "messageTimeoutMs": 60000,
  "chat": { "temperature": 0 },
  "tools": ["list_files", "read_file", "write_file", "append_file", "blackboard_read", "blackboard_post"]
}
```

<p class="pre-label">recipes/memory.json</p>

```
{
  "id": "memory",
  "image": "memory",
  "description": "A personal assistant that remembers each user: facts and preferences they share, earlier conversations, and techniques that worked for their tasks.",
  "prompt": "you are a personal assistant. You answer the user's questions and help with small tasks, and you remember what each user tells you (facts about them and their preferences) and the techniques that worked for their tasks. Use what you remember to answer them well. When a user tells you something or asks you to remember it, that is your job: reply to acknowledge it (your memory keeps it). When a user asks about themselves and you do not know: if they wrote to you, reply that you do not know yet; if they wrote to everyone, call pass and say nothing, so an agent that does know can answer. Never guess, and never use what another user told you.",
  "model": "qwen3-8b-q4_k_m",
  "embeddingModel": "qwen3-embedding-0.6b-q8_0",
  "startupTimeoutMs": 60000,
  "messageTimeoutMs": 120000,
  "chat": { "temperature": 0 },
  "tools": ["list_files", "read_file", "write_file", "append_file", "blackboard_read", "blackboard_post"]
}
```

<p class="pre-label">recipes/hello-router.json — the hello-world image on Qwen3 8B, the agent suites' router (the owner, 2026-10-14)</p>

```
{
  "id": "hello-router",
  "image": "hello-world",
  "description": "Says whatever it is asked to say, on Qwen3 8B: hello-world's agent for the role that routes, hands work to other agents or consults them, which stays on Qwen3 8B while the responders run on Pico-V2.",
  "prompt": "you say what you are asked to say, word for word. That is the only work you do: you cannot translate, write, summarise or look anything up.",
  "model": "qwen3-8b-q4_k_m",
  "startupTimeoutMs": 60000,
  "messageTimeoutMs": 60000,
  "chat": { "temperature": 0 },
  "tools": ["list_files", "read_file", "write_file", "append_file", "blackboard_read", "blackboard_post"]
}
```

A suite or demo that needs its agents to behave a particular way gives them a recipe of its own, with a one-shot example of that behaviour in its prompt, rather than changing a shared recipe (the owner, 2026-10-15). `recipes/suite-multi-agent-responder.json` is the multi-agent suite's responder: `hello-world`'s prompt and model, with *"For example: when the user, or another agent, writes to you "Say: Good morning", you call reply with "Good morning"."* — so on Pico-V2 it answers the user a task another agent hands it, as the [channel instructions](channel.md) say. `hello-world` itself stays as it is: the [routing gate](../testing/index.md#routing) measures its prompt on Qwen3 8B, and the same example there turned Qwen's "the agent that translates" hand-off into "Say: Hello World in French" (`delegate-by-role` 0/3, 2026-10-15).

## Documents: what a recipe places in `/workspace` {#documents}

A recipe MAY name Markdown documents — guidance, workflows, instructions — as paths inside its own folder (`recipes/` for a recipe launched alone; for a team member, the folder its recipe file is in, which is the team's folder or a subfolder of it). Loaded by `loadDocuments` in [`src/daemon/definitions/documents.ts`](../../src/daemon/definitions/documents.ts) at every launch, before any container starts (`docs/plans/collaborating-agents.md` R2–R4, R12).

| Field | Type | Meaning and validation |
|---|---|---|
| `path` | string | Relative to the recipe's folder, and the same relative to `/workspace` in the container. Each part starts with a letter or digit (so no `..`, no hidden file, no absolute path), ends in `.md`, at most 100 bytes (`DOCUMENT_PATH`); no path twice. |
| `fullText` | boolean | `true`: also in the system prompt on every turn, after the instructions and one line saying the guidance wins where it and the general lines differ (`GUIDANCE_PRECEDENCE`), each under `Your guidance, from <path> in your workspace:` (`withGuidance` in [`src/agent-sdk/channel.ts`](../../src/agent-sdk/channel.ts)). The line is in a call's question too. `false`: the agent reads it with its file tools. |

| Check | Fails with |
|---|---|
| A recipe that names documents selects all four file tools (`list_files`, `read_file`, `write_file`, `append_file`), so its agent can list, read, overwrite and append to them. | `DocumentsNeedFileTools`, naming the recipe and each missing tool |
| Every document exists. | `DocumentMissing`, naming the recipe file and the document |
| Every document resolves, through any link, to a regular file inside the recipe's folder. | `DocumentOutsideFolder` |
| The full-text documents together are at most 8,192 bytes (`FULL_TEXT_MAX_BYTES`: four slots of 8,192 tokens share the machine, and the system prompt is sent on every turn). | `DocumentsTooLarge`, naming the recipe, the total and the limit |
| The documents fit `/workspace`'s bound of 256 files and 16 MiB (`WORKSPACE_MAX_FILES`, `WORKSPACE_MAX_BYTES`), which they count toward. | `DocumentsOverWorkspace` |
| A full-text document is UTF-8. | `DocumentNotText` |

Each of these is a definition problem, on the wire `internal`, as a malformed recipe is. **How they reach the container:** the runtime creates the container (`docker create`), copies the documents in as one archive owned by the user the agent runs as (`docker cp -a - <container>:/workspace`, a ustar stream written by [`src/daemon/container-runtime/archive.ts`](../../src/daemon/container-runtime/archive.ts); `docker run` alone copies nothing), then starts it (`docker start --attach`). A failed copy removes the created container and fails the launch; so does a stop that arrives before the start (`ContainerStoppedBeforeStart`), which the daemon logs as the agent's exit, not a failure. **The copy lasts only while the agent runs:** its writes change its own copy, never the recipe folder's file, and every launch starts from the recipe folder's documents. The full-text text in the system prompt is the recipe folder's for the whole run, so every agent of a recipe keeps one shared prompt prefix ([the request](channel.md#prefix)), whatever an agent writes to its copy.

The archive's owner, uid and gid 1000 (`AGENT_WORKSPACE_OWNER` in [`src/daemon/container-runtime/index.ts`](../../src/daemon/container-runtime/index.ts): the `node` user of the pinned `node:22-alpine` base), is assumed, not read from the image: D34. It holds for today's images: the agent suite's `documents-in-workspace` and `documents-per-run` ([`tests/agents/teams.test.ts`](../../tests/agents/teams.test.ts)) append to and write a placed document's copy, green since `f47cc4c` (2026-09-29).

## Team: `teams/<team>/` {#team}

A team is a folder holding `team.json`, every member's recipe and every document those recipes name; `./asha --launch team=<team>` ([CLI](../cli/index.md#launch)) launches every member on one channel (`docs/plans/collaborating-agents.md` R5, R9, R11). Loaded by `loadTeam` in [`src/daemon/definitions/teams.ts`](../../src/daemon/definitions/teams.ts) (`Definitions.team`); a pattern demo is a team folder (`docs/plans/orchestration-patterns.md` R7).

| Field | Type | Meaning and validation |
|---|---|---|
| `id` | string | Equals the folder's name. |
| `description` | string | Non-empty. |
| `persist` | list, optional | What of the channel is kept across stops (agent-persistence R1, R14): `"board"` (the blackboard); absent → `[]`. `"files"` (the channel file space and its file table, [a persisted channel's files](channel.md#files-persisted); since 2026-09-30, when agent-files paid D43 — until then it was refused at load). A team launched onto a channel that is online persisting something else is refused `persist_mismatch`. A member's own `/memory` and `/workspace` are its recipe's `persist`. |
| `roots` | list, optional | Folders every member's command plugins may name, as a recipe's `roots`; a name may not be in both a member's recipe and the team file. |
| `members` | list of 1 to 10 `{"name", "recipe", "topics"?}` | In launch order. `name`: the member's channel base name — it joins as `<name>-<n>` (`lead-1` on a fresh channel) whatever name its image asks for; matches `/^[a-z][a-z0-9-]{0,31}$/`, is not `user` or `asha`, does not end in `-<digits>`, is unique in the team. `recipe`: a relative path to a `.json` recipe inside the folder, whose `id` equals its file name; two members may share one. `topics`, optional: the topics the member subscribes to on its channel, 1 to 8 distinct names each matching `/^[a-z][a-z0-9-]{0,31}$/` (`memberTopics`; `docs/plans/patterns-phase-3.md` R20): a user's message to one of them reaches it ([addressing](channel.md#addressing)); absent → none. A recipe launched alone has none. |

A file that breaks a rule fails before any container starts with `TeamDefinitionError`, naming the file, the member (when there is one) and the rule, for example `teams/crew/team.json: member "fact-1": name must not end in -<digits>: the channel adds the number`; a member's recipe that breaks the recipe schema fails the same way, naming the member and its recipe. A missing team is `UnknownTeam` (`unknown_team`).

**Launching** (`AgentSupervisor.launchTeam` in [`src/daemon/agents/index.ts`](../../src/daemon/agents/index.ts)): every member's recipe, image, tools, models and documents are checked first, so a problem with any member starts nothing; then the members are started one at a time in `team.json`'s order. A member that does not come online stops the members already started, so a team is on the channel whole or not at all, and the failure (`TeamLaunchFailed`) names the member and why; its wire reason is the cause's. The daemon logs `team.launched` (team, channel, handles) or, when a member fails to start, `team.launch_failed` (team, channel, member, the handles it stopped, the error); a problem found while checking the members, before any starts, is logged by the server's `launch.failed` (channel, team, reason, error) alone.

<p class="pre-label">teams/suite-duo/team.json — an agent-suite fixture</p>

```
{
  "id": "suite-duo",
  "description": "Agent-suite fixture (collaborating-agents A4): two members, each saying what it is asked to say.",
  "members": [
    {
      "name": "lead",
      "recipe": "sayer.json"
    },
    {
      "name": "helper",
      "recipe": "sayer.json"
    }
  ]
}
```

The `teams/suite-*/` folders are the agent suite's fixtures ([`tests/agents/teams.test.ts`](../../tests/agents/teams.test.ts)); two of them are broken on purpose (`suite-missing-recipe`, `suite-outside-document`). `suite-remember` (a memory agent persisting `memory` and `workspace` on a channel whose board is kept) and `suite-remember-other` (the same recipe under another member name) are [`tests/agents/persistence.test.ts`](../../tests/agents/persistence.test.ts)'s, `suite-erase-fails` runs the test-only image [`images/suite-erase-fails/`](../../images/suite-erase-fails/src/main.ts), which answers `noted` without a model call and exits 1 in `erase-user`, for A17's real failed erase; and `teams/resume-tasks/` was the p20-b demo's ([pattern demos](../testing/index.md#patterns); *since 2026-10-03 its member is `teams/resume/`'s `tasker`, [P20](../patterns/p20-resume.md)*); all green in `npm run test:agents` at `302eb14` (2026-09-29: 30 files, 111 tests passed). No `suite-*` team or image ships in a release ([deployments](../deployments/index.md)).

> [!TIP] Deterministic where the gate asserts
> Where the eval asserts exact output, set `chat.temperature: 0`; if an upgrade changes the output, update the expectation, never loosen it (AGENTS.md §3).

## Image: `images/<name>/` {#image}

An image is a directory. `Definitions.image(name)` accepts a valid name whose `images/<name>/Dockerfile` exists, reads its `image.json`, and returns `ImageDefinition {name, dir, repository, manifest}`, with `repository = "asha-image-<name>"`. Each build of it is tagged `asha-image-<name>:<source digest hex>` (below).

| Path | What it is |
|---|---|
| `images/<name>/Dockerfile` | Builds from a context of `Dockerfile` and `app/`; `ENTRYPOINT` runs `/app/images/<name>/src/main.js`. No `RUN` line runs `npm`, `npx`, `curl` or `wget` (a guard in [`tests/unit/dependencies.test.ts`](../../tests/unit/dependencies.test.ts)). |
| `images/<name>/image.json` | The tools the image implements ([agent tools](channel.md#tools)), parsed by `parseImageManifest` in [`src/shared/tools.ts`](../../src/shared/tools.ts) — by the daemon at launch and by the agent at start, which fails when a declared tool has no handler or a handler no declaration. A closed object `{"tools": [...]}`, each tool `{name, description, parameters, class, timeoutMs}`: `name` matching `^[a-zA-Z_][a-zA-Z0-9_]{0,63}$` and unique; `parameters` an object schema in the subset tools may use (`properties` of `string`, `integer`, `number` or `boolean`, with optional `description`, `minimum`, `enum`; optional `required`), any other key refused; `class` one of `files`, `command`, `network` (only `files` may be selected); `timeoutMs` an integer in 1..60,000. An optional `answerTools` lists tools the image passes only in its own model calls to get a structured answer back — never offered on the channel, never run by the SDK; the gateway admits them from that image's agents only, and no other source may use their names. A missing or malformed manifest fails loading, naming the file and the key; it has no `services` key. `hello-world` declares one tool, `hold` (class `files`, no parameters, `timeoutMs` 60,000; *changed 2026-09-29 by `docs/plans/patterns-phase-2.md` R7: this said `{"tools": []}`*), which only a recipe that selects it is offered ([agent tools](channel.md#tools)); `memory` has `{"tools": [], "answerTools": ["save_facts", "save_procedures"]}`, its extraction calls ([Agent memory](memory.md)), kept equal to the names in `extract.ts` by a unit test. Three optional keys say what an image can keep (`docs/plans/agent-persistence.md` R1, R12, R16): `keepsMemory` (`true`: it keeps per-user memory, so a recipe may persist `"memory"` and a channel saved while it is online is marked tainted; a recipe on such an image may not be cloud-granted, and its agent is never on a channel beside a cloud-granted one — [memory never leaves the machine](modules.md#memory)), `eraseUser` (`true`: it has the `erase-user` mode, [persisted memory](memory.md#persisted)) and `stateSchema` (a positive integer naming the layout of what it keeps); any other value fails naming the file and key; `memory` declares all three (`true`, `true`, `1`). |
| `images/<name>/src/**/*.ts` | The agent's code, compiled by `npm run build` to `dist/images/<name>/` (`tsconfig.build.json` includes `images/*/src/**/*.ts`). It imports only `src/agent-sdk` and `src/shared`. |

1. `stageAgentImage` ([`src/daemon/images/index.ts`](../../src/daemon/images/index.ts)) copies exactly the Dockerfile, `dist/src/shared`, `dist/src/agent-sdk`, `dist/images/<name>` and `images/<name>/image.json` (to `app/images/<name>/image.json`, beside the compiled code, where the agent reads it) into a fresh `<home>/staging/<name>-<random>/`, and into its `app/node_modules/` — copied from `dist/agent-packages/`, the build's clean offline install of the lockfile ([build](index.md#build-run); debt-paydown R10, R11), never the checkout's `node_modules/`, where a stray `.DS_Store`, a `.env` or a locally edited file would reach the image (D22, now paid; a missing `dist/agent-packages/` fails with `ImageSourceMissing` naming it) — the runtime files of the packages the agent SDK imports: the production closure of `package.json`'s `dependencies` (the four OpenTelemetry packages, [licences](index.md#otel-licences)) as `package-lock.json` records it (`agentPackagePaths`: each dependency and what it reaches through `dependencies` and non-optional `peerDependencies`, resolved as Node does; an entry marked `dev` or missing fails with `AgentPackagesInvalid`), without `*.map`, `*.d.ts`, `esm/`, `esnext/` or nested `node_modules/`. Then it computes `directoryDigest` over them. A missing input fails with `ImageSourceMissing` naming it ("run `npm run build`"). Measured 2026-09-27 on the owner's Mac: 411 package files, 2,291,329 bytes; staging and digest 111–120 ms per launch (`image.staged` in the daemon log, `ms`, with `loadavg`, the host's 1, 5 and 15 minute load averages at that moment), eleven warm launches of `hello-world` 1,155–1,357 ms (A10 (`docs/plans/otel-traces.md`)).
2. `ColimaRuntime.ensureImage` ([`src/daemon/container-runtime/index.ts`](../../src/daemon/container-runtime/index.ts)) makes sure of one tag per source digest, `imageTag`: `asha-image-<name>:<digest hex>` (the 64 hex digits of `sha256:<hex>`). It inspects exactly that tag: present with an `asha.source` label equal to the digest, it is `current` and nothing is built; missing (`No such image`), it takes that tag's VM lock and inspects again, and only if the tag is still missing runs `docker build --network=none --label asha.source=<digest> --tag asha-image-<name>:<digest hex>` and is `built` — otherwise another daemon built it meanwhile and it is `current`; an image declaring `eraseUser` or `stateSchema` also gets `--label asha.erase-user=true` and `--label asha.state-schema=<n>` (`imageLabels` in [`src/daemon/images/index.ts`](../../src/daemon/images/index.ts)). An agent's saved state records the image name, its `asha.source` and its schema: at the next launch another image name is refused `state_image_mismatch`, another schema `state_schema_changed` (each naming the `--reset-state` that removes it), and another source is restored as `imageChanged` in `agent.resumed`. An existing tag is never replaced: a changed source gets a new tag, and the image of the old one keeps its own (AGENTS.md §3: a stale image is never reused, because the new digest names a different tag). A present tag whose label names another digest (something other than asha wrote it), or an inspect that fails for any other reason, fails the launch with `ContainerRuntimeError` naming the tag, and nothing is built. Concurrent launches of one image in a daemon share one `ensureImage` per tag (a launch that joined one reports `current`: it built nothing). <span id="build-lock">**Across daemons**</span> — of other homes or other checkouts on one colima VM — a missing tag's build holds two locks in the VM (debt-paydown R18, D28, now paid; `docs/plans/debt-paydown-2.md` R3): `/run/asha-images.lock` **shared**, then `/run/asha-image-<digest hex>.lock`, in one `colima ssh --profile default -- sudo sh -c 'exec 8>/run/asha-images.lock; flock -s -w 30 8 || exit 6; exec 9>/run/asha-image-<hex>.lock; flock -w 600 9 || exit 4; echo locked; read _ || true'` session (`imageLockScript`), its stdin a pipe, held from `locked` until the build is done and its stdin is closed (released within 155 ms of that, or 213 ms after its client dies: probes P3b, Q2 (e)), then awaited (30 s bound). Builds share the images lock, so they never wait for each other there; an [image prune](#prune) holds it exclusively for at most 10 s, and a build waits up to 30 s for it — not taken, the launch fails `ImageBuildFailed` naming `/run/asha-images.lock` (exit 6). One tag lock per tag, so builds of different tags never wait for each other; a tag lock not taken within 600 s (one build of that tag) fails the launch `ImageBuildFailed` naming that lock (exit 4; wire reason `image_build`). The wait for `locked` is bounded at 660 s, the whole session at 1,410 s. `colima ssh` (0.10.3) exits 1 for any non-zero status of the script it runs and names the status only on its standard error, `level=fatal msg="exit status N"`, which `remoteExitStatus` reads (probe Q4, 2026-10-03; *corrected 2026-10-03:* until then the runtime read colima's own exit status, so exit 4 was reported as `colima ssh exited 1` without its `(flock waited 600 s)`; it named the right lock all the same). A launch of an existing tag opens no session; a build adds one `colima ssh` (0.2–0.34 s). The lock files stay in `/run`, a few bytes each, gone at the VM's restart. **Not covered** (the completion review's finding 16): a session that dies during the build releases the lock early, so another daemon may start its own build of the tag; this one's release then fails (`ContainerRuntimeError` naming the lock), and the tag a later launch inspects is whichever build finished last — D23's tag-per-digest makes both builds of one source. It resolves with `{tag, status}`; the launch prints `› image: asha-image-<name> <status>`, runs the container from exactly that tag (`ContainerRuntime.start`), and logs it as `tag` in `agent.starting`. `--network=none`: no build step reaches the network; the images only copy what staging put in the context.

   Why one tag per digest (debt D23): until 2026-09-27 every build replaced the fixed tag `asha-image-<name>`. With Docker 29's containerd image store, replacing the tag dropped the only reference to the old image's layer snapshots, and containerd's garbage collector — run when containers are removed — could delete a snapshot the new build was still unpacking: `failed to prepare extraction snapshot … parent snapshot … does not exist` (upstream [moby/buildkit#6521](https://github.com/moby/buildkit/issues/6521), closed by [moby/buildkit#6558](https://github.com/moby/buildkit/pull/6558), merged 2026-03-09 for BuildKit v0.29.0; colima's Docker Engine here is 29.2.1, built 2026-02-02, so it lacks that fix — both read 2026-09-27). Old digest tags are removed by the image prune at every daemon start (below; D27, paid); `docker image ls asha-image-<name>` lists those left.

   <span id="prune">**The image prune**</span> (`docs/plans/debt-paydown-2.md` R1–R5; the owner's answer `debt-image-prune` (a), 2026-10-03). Every daemon start, after the runtime's reclaim and the model servers' orphan sweep and before the server listens, calls `ColimaRuntime.pruneImages` ([`src/daemon/container-runtime/index.ts`](../../src/daemon/container-runtime/index.ts); `startDaemon` in [`src/daemon/compose.ts`](../../src/daemon/compose.ts)). It removes asha's own image versions that are not the newest of their image, are older than 24 hours, and are used by no container — every asha repository, `asha-image-*`, `asha-harness-*`, `asha-module-*` and `asha-plugin-*`, and never another project's image (other projects' images may share the VM):

   1. `colima status` (with colima not installed or the profile not running: `image.prune_skipped`, nothing else run);
   2. the images lock taken **exclusively without waiting**, `PRUNE_LOCK_SCRIPT`: `exec 8>/run/asha-images.lock; flock -x -n 8 || { echo busy; exit 5; }; echo locked; read _ || true` — while any build shares it, `busy`, nothing removed, `image.prune_skipped` `a build holds the image lock` (a start never waits for a build; the next start prunes);
   3. under it: `docker image ls --no-trunc --filter reference=asha-*` (one-second `CreatedAt`); every container's image id (`docker ps --all --quiet --no-trunc`, then `docker container inspect --format {{.Image}}`; a container removed between the two, which Docker answers `No such container: <its id>`, uses no image); `docker image inspect` of the versions listed more than 24 h and 1 s old and not the newest, and of the newest of each repository that has one, only (a repository with no old version is not inspected at all);
   4. `selectPrunable(images, usedImageIds, now)` — exactly the versions whose (a) repository matches `^asha-(image|harness|module|plugin)-[a-z0-9][a-z0-9._-]*$`, (b) tag is 64 lowercase hex, (c) `asha.source` label is `sha256:<that tag>`, (d) `.Created` is earlier than another version's of its repository (the newest, and any version tied with it, kept), (e) `.Created` is more than 86,400,000 ms old, and (f) id is no container's image (running or stopped, of any project) — at most 50 per start, the oldest first;
   5. `docker image rm` (never `--force`) in calls of at most 20 tags; a version Docker refuses (a container created since the listing; Docker refuses one any container uses) is kept and logged `image.prune_refused`;
   6. the session closed; `image.pruned` {`removed`, `kept`, `ms`}.

   The whole prune is bounded at 10,000 ms; past it the session is killed (which releases the lock) and `image.prune_failed` `reason: 'timeout'` is logged; any other failure logs `image.prune_failed` with the error and the tags removed before it. **A failed or skipped prune never fails the start**: it frees disk, and nothing depends on it — an explicit, logged degraded mode. Untagging a base version leaves a module or plugin image built `FROM` it runnable (its layers stay referenced; probe Q1 (b)). The prune runs nowhere else: no timer, no `--stop` step. Measured on this Mac: the first real prune (the image-prune eval's daemon start, 2026-10-03) removed 10 versions in 1,424 ms — the 7 old versions its dry run named (`evals/probes/debt-paydown-2-2026-10-03/dry-prune.out.txt`) and the eval's own 3.

   **A removed tag stays local.** Every `docker create` or `docker run` of a tag `ensureImage` returned carries `--pull never` (`start`, the one-shot, `runAttached` — the egress proxy and module containers — `pluginContainer`, the holder, the rollback and a failed fill's emptying), so a tag another server's prune removed is never asked of a registry: Docker answers `No such image: <tag>`, and the runtime throws `ImageGone` (a `ContainerRuntimeError`, wire reason `container_runtime`) — *image <tag> was removed while this launch was starting (an image prune of another asha server); launch again to rebuild it* — and logs `image.gone`. An agent's launch carries it as its `agent_start` failure's detail, as it carries every container failure; nothing retries, and the next launch's `ensureImage` finds the tag missing and builds it. What this leaves — the race itself, a module build whose base is removed under it, and builds by an asha older than R3 that take no shared lock — is D63.

<p class="pre-label">src/daemon/images/index.ts — stageAgentImage</p>

```
const copies: readonly (readonly [string, string])[] = [
  [join(image.dir, 'Dockerfile'), join(contextDir, 'Dockerfile')],
  [join(root, 'dist', 'src', 'shared'), join(contextDir, 'app', 'src', 'shared')],
  [join(root, 'dist', 'src', 'agent-sdk'), join(contextDir, 'app', 'src', 'agent-sdk')],
  [join(root, 'dist', 'images', image.name), join(contextDir, 'app', 'images', image.name)],
  // The manifest: the agent checks at start that it implements exactly the tools declared (agent-tools R1).
  [join(image.dir, 'image.json'), join(contextDir, 'app', 'images', image.name, 'image.json')],
];
…
// The agent packages from the build's clean install of the lockfile (tools/agent-packages/build.mts), never the
// checkout's node_modules, where a stray or edited file would reach the image (debt-paydown R11, D22).
const agentPackages = join(root, 'dist', 'agent-packages');
await requireSource(agentPackages);
await copyAgentPackages(agentPackages, join(contextDir, 'app'));
```

<p class="pre-label">images/hello-world/Dockerfile</p>

```
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
RUN printf '{"type":"module"}\n' > /app/package.json && mkdir -p /workspace && chown node:node /workspace
COPY app/ /app/
USER node
ENTRYPOINT ["node", "/app/images/hello-world/src/main.js"]
```

Both Dockerfiles ([`hello-world`](../../images/hello-world/Dockerfile), [`memory`](../../images/memory/Dockerfile)) pin `node:22-alpine` by digest (read from the local image 2026-09-26). Both create `/workspace` owned by `node`, where the file tools act ([agent tools](channel.md#tools)); the `memory` image also creates `/memory` owned by `node` ([Agent memory](memory.md#where)).

## Catalogue entry: `catalogue/<id>.json` {#catalogue}

Parsed by `parseCatalogueEntry`; type `CatalogueEntry = ChatModelEntry | EmbeddingModelEntry`. Where each pinned value came from: [Models](models.md#pinned).

<div class="table-wrap"><table>
<thead><tr><th>Field</th><th>Type</th><th>Meaning and validation</th></tr></thead>
<tbody>
<tr><td><code>kind</code></td><td><code>"chat"</code> | <code>"embedding"</code></td><td>Checked first; decides the other keys.</td></tr>
<tr><td><code>id</code></td><td>string</td><td>Equals the file name; also the name <code>llama-server</code> answers to (<code>--alias</code>).</td></tr>
<tr><td><code>repo</code></td><td>string</td><td>Hugging Face repo, e.g. <code>Qwen/Qwen3-8B-GGUF</code>.</td></tr>
<tr><td><code>revision</code></td><td>string</td><td>Full 40-hex commit sha (<code>/^[0-9a-f]{40}$/</code>); a branch is never a pin.</td></tr>
<tr><td><code>weights</code></td><td>string</td><td>The file <code>llama-server</code> loads; one of <code>files[].path</code>.</td></tr>
<tr><td><code>files</code></td><td>array, non-empty</td><td>Closed <code>{path, size, sha256}</code> per file. <code>path</code>: relative (not starting <code>/</code> or <code>.</code>, no <code>..</code>), no pickle format (<code>/\.(bin|pt|pth|pkl|ckpt)$/i</code>), no duplicates. <code>size</code> (bytes) and <code>sha256</code> (64 hex) must match the download.</td></tr>
<tr><td><code>license</code></td><td>object</td><td>Closed <code>{id, source, verified}</code>: the id (e.g. <code>apache-2.0</code>); the URL of the licence file at this revision, or of the card declaring it (then in <code>files</code>); the date read (<code>YYYY-MM-DD</code>).</td></tr>
<tr><td><code>serve.contextSize</code></td><td>positive integer</td><td>The context of one request. A chat entry is served with 4 slots of it (<code>--parallel 4 --ctx-size</code> 4 × it, <a href="models.md#serving">why</a>); an embedding entry with <code>--ctx-size</code> and <code>--ubatch-size</code> of it.</td></tr>
<tr><td><code>chat</code> (chat only)</td><td>object</td><td>Sampling merged into every chat request for this model; the recipe's <code>chat</code> overrides it. Same reserved keys.</td></tr>
<tr><td><code>toolCallStart</code> (chat only, required)</td><td>string, non-empty</td><td>The text the model's chat template opens a tool call with (Qwen3: <code>"&lt;tool_call&gt;\n"</code>). When a call is required, the assistant turn is sent already opened with it, since <code>tool_choice: "required"</code> no longer makes the call come first (<a href="models.md#gateway">why</a>).</td></tr>
<tr><td><code>serve.pooling</code> (embedding only)</td><td><code>"last"</code> | <code>"mean"</code> | <code>"cls"</code></td><td><code>--pooling</code>, as the model card says. A chat entry's <code>serve</code> has no other key.</td></tr>
<tr><td><code>embed.dimensions</code> (embedding only)</td><td>positive integer</td><td>Vector length; any other length is rejected as <code>bad_response</code>.</td></tr>
<tr><td><code>embed.queryTemplate</code> (embedding only)</td><td>string</td><td>How a search query is written; must contain <code>{text}</code>. Documents are sent as they are.</td></tr>
</tbody>
</table></div>

<p class="pre-label">catalogue/qwen3-embedding-0.6b-q8_0.json</p>

```
{
  "kind": "embedding",
  "id": "qwen3-embedding-0.6b-q8_0",
  "repo": "Qwen/Qwen3-Embedding-0.6B-GGUF",
  "revision": "370f27d7550e0def9b39c1f16d3fbaa13aa67728",
  "weights": "Qwen3-Embedding-0.6B-Q8_0.gguf",
  "files": [
    {
      "path": "Qwen3-Embedding-0.6B-Q8_0.gguf",
      "size": 639150592,
      "sha256": "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
    },
    {
      "path": "README.md",
      "size": 11889,
      "sha256": "5dc596e802ce79342678281d42ec4b98fbee2fee241758df330cdc35cc15d29f"
    }
  ],
  "license": {
    "id": "apache-2.0",
    "source": "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/blob/370f27d7550e0def9b39c1f16d3fbaa13aa67728/README.md",
    "verified": "2026-09-26"
  },
  "serve": {
    "contextSize": 8192,
    "pooling": "last"
  },
  "embed": {
    "dimensions": 1024,
    "queryTemplate": "Instruct: Given a message sent to an assistant, retrieve the memories about this user that help answer it\nQuery:{text}"
  }
}
```

A chat entry in full: [`catalogue/qwen3-8b-q4_k_m.json`](models.md#qwen3-8b).

> [!WARNING] The schema checks shape, not truth
> Whoever adds the entry checks that the licence is commercially permissive and that sizes and digests came from the exact revision ([Adding a model](models.md#adding)).

## When and how definitions are loaded {#loading}

`Definitions` ([`src/daemon/definitions/index.ts`](../../src/daemon/definitions/index.ts)), built at the composition root ([`src/daemon/compose.ts`](../../src/daemon/compose.ts)), caches nothing. Every launch (`AgentSupervisor`'s private `launch`, or `launchTeam` for each member) reads, before any container starts (`prepare`):

1. `definitions.recipe(name)`: a bad name or missing file is `UnknownRecipe`, so `recipe=../catalogue/x` cannot escape `recipes/<name>.json`. For a team, `definitions.team(name)` reads `teams/<name>/team.json` and each member's recipe instead.
2. `definitions.image(recipe.image)`: the `Dockerfile` must exist.
3. `definitions.chatModel(recipe.model)`, then any `definitions.embeddingModel(recipe.embeddingModel)`: a wrong `kind` is a `DefinitionError`.
4. The recipe's documents, from its folder (`loadDocuments`, [above](#documents)).

![What each definition becomes at launch: catalogue entries become a verified cache and a serving endpoint, the image becomes a built docker image, and the recipe's fields bound and shape the agent at run time.](recipe-launch.svg)

Image code comes from the same checkout's `dist/`.

## Environment variables {#env}

Found with `grep -rn "process.env\|env\['" src images evals tests` on 2026-09-27. A missing required value fails loudly; nothing guesses an endpoint (AGENTS.md §3, PRINCIPLES §9).

| Variable | Read by | Set by | Meaning |
|---|---|---|---|
| `ASHA_HOME` | CLI and daemon (`harnessPaths` in [`src/shared/paths.ts`](../../src/shared/paths.ts)) | the user (optional); tests | The harness home, default `~/.simplyautonomous/harness` (one per user; not environment selection). |
| `ASHA_MODELS_DIR` | `harnessPaths`; [`evals/routing/run.ts`](../../evals/routing/run.ts), the suites | the user (optional); the suites pass it through | The model cache, default `<home>/models` (routing eval: `~/.simplyautonomous/harness/models`). |
| `ASHA_URL` | agent: `readAgentEnvironment` ([`src/agent-sdk/index.ts`](../../src/agent-sdk/index.ts)) | the daemon, on every container (`AgentEnv.harnessUrl`) | `http://host.docker.internal:<daemon port>`. Required (`MissingAgentEnvironment`). |
| `ASHA_AGENT_TOKEN` | agent: `readAgentEnvironment` | the daemon (`AgentEnv.agentToken`) | The [agent token](index.md#token), 64 hex. Required. |
| `DOCKER_HOST` | `docker` | `ColimaRuntime`, from `colima status --json` → `docker_socket` | Set on every `docker` command; no `docker_socket` is a `ContainerRuntimeError`. |

> [!NOTE] How values reach child processes
> Container values go by name (`docker create -e ASHA_URL -e ASHA_AGENT_TOKEN`, `ContainerSpec.env`): not in an argument listing, but visible to `docker inspect`. `docker`, `colima` and `llama-server` inherit the daemon's environment with these laid over it ([`src/daemon/process/launcher.ts`](../../src/daemon/process/launcher.ts), [`src/daemon/process/index.ts`](../../src/daemon/process/index.ts)).

## The harness home {#home}

`daemon.lock`, `daemon.json`, `users.json` (`FileUserLedger`), `logs/` ([`src/daemon/log.ts`](../../src/daemon/log.ts); [queries](index.md#logs)), `staging/` and `models/` (`sha256-<tree digest>/`, `.lock`, transient `.staging-<random>/`): see [Architecture — where things live](index.md#state).
