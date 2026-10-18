---
title: Extending asha
description: How to extend asha — add a recipe, an agent image built on the agent SDK, a pinned model, a module, or an adapter behind an existing contract such as ContainerRuntime or ModelServer, with the steps, the files to touch and the tests to add.
---

# Extending asha

Five ways to extend the harness, smallest first: a recipe, an agent image, a model, a module, and an adapter behind an existing contract.

<div class="facts"><span>verified 2026-09-27</span><span>gate: <code>npm run check</code></span><span>specifications: <a href="recipes.md">Recipes and configuration</a> · <a href="models.md">Models</a></span></div>

> [!SUMMARY]
> - A new agent from existing parts is one JSON file, a recipe; new behaviour is an image; a new model is a catalogue entry; a tool or hosted model from outside is a module; a new platform is an adapter.
> - Every change carries tests, docs in the same commit, one review, and a green `npm run check`.
> - An image uses only the agent SDK (with the OpenTelemetry packages it sends spans with) and Node's standard library; `hello-world` is the reference.
> - An adapter is wired only in `productionDependencies`; if a consumer must change, the contract leaks.

## What every change carries {#every-change}

![Each row is one kind of extension, smallest first; every row ends at the same gate.](extending-flow.svg)

- **Tests** for every change to logic; a new guard is proven to fail (PRINCIPLES §3).
- **Docs in the same commit** (PRINCIPLES §15, AGENTS.md §4), new pages listed in [`docs/index.html`](../index.md); **the code-review loop** in `sdlc/`, converged (AGENTS.md §5).
- **A green gate:** `npm run check` (lint → format check → typecheck → secret scan → unit → integration → build → demo selection → agents → eval → routing).

> [!WARNING] Simplicity first (PRINCIPLES §7)
> A second model backend or container runtime is a new moving part: justify it in writing first (AGENTS.md §2). A paid API needs a written estimate and the owner's approval.

## Add a recipe {#recipe}

1. Write `recipes/<name>.json` with every required field ([spec](recipes.md#recipe)); `id` equals `<name>` and matches `/^[a-z0-9][a-z0-9._-]*$/`.
2. Write the `description` for other agents: `list_agents` shows it when they choose whom to delegate to ([`delegate-by-role`](models.md#choice)).
3. Write its `prompt`: the agent's role, which goes into its instructions as `Your role: <prompt>` on every turn. The image carries none: the same image with another prompt is another agent.
4. Optionally, name Markdown `documents` in the recipe's folder — a numbered workflow, guidance — each `{"path", "fullText"}` ([documents](recipes.md#documents)). A full-text document is in the system prompt on every turn (all of them together at most 8 KiB); the rest the agent reads with its file tools. A recipe with documents selects the four file tools.
5. If a test asserts its output exactly, set `"chat": { "temperature": 0 }` (AGENTS.md §3).
6. Select its tools in `tools`: any of the six common tools, its image's own, `reply_with_files` for an agent that returns files to the user and `ask_user` for one that asks the user and waits for the answer ([agent tools](channel.md#tools), [returning files](channel.md#files), [asking the user](channel.md#asking)); `[]` for none. At most 11 with any granted module tools; a name no source declares, or an image tool of class `command` or `network`, fails the launch before anything starts.
7. Try it: `./asha recipe=<name> message="…"`.

> [!TIP] No restart needed
> The daemon reads recipes at every launch; an agent already online keeps its old recipe until stopped ([loading](recipes.md#loading)).

| Touch | Test |
|---|---|
| `recipes/<name>.json` | A `Definitions` case in [`tests/unit/definitions.test.ts`](../../tests/unit/definitions.test.ts) asserting every field, like "loads the checked-in memory recipe, whose embedding model is the pinned Qwen3-Embedding-0.6B"; an agent-suite scenario in `tests/agents/`. |

## Add a team {#team}

A team is several agents launched together on one channel, each under its own name — the unit of a multi-agent demo ([team spec](recipes.md#team)).

1. Create `teams/<team>/` and, in it, one recipe per kind of member (as [above](#recipe); two members may share a recipe) and every document those recipes name. Nothing a member needs may live outside the folder: a document that links out fails the launch.
2. Write `teams/<team>/team.json`: `{"id": "<team>", "description": "…", "members": [{"name": "lead", "recipe": "lead.json"}, …]}` — 1 to 10 members, in launch order. Each `name` is the member's handle base, so `lead` is `lead-1` on a fresh channel and other members address it by that; it matches `/^[a-z][a-z0-9-]{0,31}$/`, is not `user` or `asha`, and does not end in `-<digits>`.
3. Try it: `./asha --launch team=<team>` prints every member's handle; `./asha to=lead-1 message="…"` then talks to one of them.

| Touch | Test |
|---|---|
| `teams/<team>/` | Every committed team loads (`tests/unit/teams.test.ts`, "every committed team folder …"); an agent-suite scenario that launches it with `--launch team=<team>`, like [`tests/agents/teams.test.ts`](../../tests/agents/teams.test.ts). |

## Add an agent image {#image}

An image is a Dockerfile, a tool manifest `image.json` and TypeScript under `images/<name>/`, importing only the agent SDK ([`src/agent-sdk`](../../src/agent-sdk/index.ts), [described here](channel.md#sdk)) and the shared contracts ([`src/shared`](../../src/shared/protocol.ts)). `readAgentEnvironment(process.env)` finds the harness; `AgentTelemetry.forHarness` sends the agent's spans to it; `HarnessClient` returns model failures as `{ok: false, reason}`; `serveAgent` checks `/workspace`, the channel's file space `/channel` (each a writable directory, else the agent fails before it joins: `WorkspaceUnavailable`, `ChannelSpaceUnavailable`) and the image's tools, joins as `name` (numbered `name-1`, …), builds the tools its recipe selects (`context.tools`), calls `handler(delivery, context)` per delivery inside its span, and flushes the spans before each ack ([spans](channel.md#spans)). The handler passes `context.tools` to `decide`, which runs the tool rounds ([agent tools](channel.md#tools)).

> [!NOTE] No npm in an image
> Besides the compiled code and `image.json`, only the runtime files of the harness's own pinned `dependencies` are staged into the build context, copied from the build's clean install of the lockfile, `dist/agent-packages/` (never the checkout's `node_modules/`); no `npm install` runs at a launch and the image build has no network ([image spec](recipes.md#image)). A new npm package for an image is a new dependency: it needs the owner's approval and passes the [dependency guard](index.md#otel-licences).

<p class="pre-label">images/hello-world/src/main.ts — wiring only</p>

```
import {
  AgentTelemetry,
  exitOnFailure,
  HarnessClient,
  JsonLinesAgentLog,
  nodeAgentProcess,
  readAgentEnvironment,
  readImageManifest,
  REPLY_WITH_FILES_TIMEOUT_MS,
  serveAgent,
} from '../../../src/agent-sdk/index.js';
import { AGENT_CHAT_TIMEOUT_MS, AGENT_DRAIN_MS } from '../../../src/shared/protocol.js';
import { NAME, handleHelloWorld } from './agent.js';
import { HOLD, holdHandler } from './hold.js';

const environment = readAgentEnvironment(process.env);
// Spans to the harness; an export failure is one JSON line on stdout, in the agent's log.
const telemetry = AgentTelemetry.forHarness(environment, (line) => process.stdout.write(`${line}\n`));
const client = new HarnessClient({
  environment,
  chatTimeoutMs: AGENT_CHAT_TIMEOUT_MS,
  requestTimeoutMs: 10_000,
  // An output with files waits on the daemon's copies: 30 s, not 10 (docs/plans/agent-files.md R12).
  filesRequestTimeoutMs: REPLY_WITH_FILES_TIMEOUT_MS,
  streamIdleTimeoutMs: 45_000,
  fetch: globalThis.fetch,
  telemetry,
});

// One log for the SDK and the image's own tool, which announces itself in it (hold.started).
const log = new JsonLinesAgentLog({ write: (line) => process.stdout.write(line), clock: () => new Date() });

console.log(`joining the channel as ${NAME}`);
await exitOnFailure(
  async () => {
  await serveAgent({
    client,
    telemetry,
    name: NAME,
    handler: handleHelloWorld,
    process: nodeAgentProcess(process),
    // image.json is staged beside the compiled code. Its one tool, hold, is offered only to a recipe that selects it
    // (docs/plans/patterns-phase-2.md R7).
    imageTools: { manifest: await readImageManifest(new URL('../image.json', import.meta.url)), handlers: { [HOLD]: holdHandler(log) } },
    workspace: '/workspace',
    // The channel's file space, mounted by the harness in every agent container (docs/plans/agent-files.md R4, R10).
    channelSpace: '/channel',
    log,
    // On SIGTERM, the bound on finishing started work; shorter than the harness's stop grace.
    drainMs: AGENT_DRAIN_MS,
    onJoined: ({ handle, channel }) => console.log(`joined channel "${channel}" as ${handle}`),
  });
  console.log('the harness closed the channel; exiting');
  },
  nodeAgentProcess(process),
  // Captured in the agent's log, then exit 1 at once (exitOnFailure); serveAgent has flushed the spans.
  (error) => console.error('failed', error),
);
```

A main runs `serveAgent` through `exitOnFailure` ([`src/agent-sdk/index.ts`](../../src/agent-sdk/index.ts)): a failure is reported, then the process exits 1 at once. Setting only `process.exitCode` left a failed agent running — its channel stream and timers keep Node's loop alive — connected and silent until the harness's delivery bound killed it (agent-persistence's agent suite, 2026-09-29). A unit test ([`tests/unit/agent-exit.test.ts`](../../tests/unit/agent-exit.test.ts)) checks that every image's main does this.

<p class="pre-label">images/hello-world/src/agent.ts — the handler, with the persona its recipe gives it</p>

```
/** The base name this agent joins the channel under; the channel numbers it (hewo-1, hewo-2, …). */
export const NAME = 'hewo';

/**
 * Bound on generated tokens per model call. 1,024 since agent calls (docs/plans/agent-calls.md R20): a nine-request
 * consult took 180–196 tokens and nine parallel send_message calls 271, against the former 256 (probe P2). A bound,
 * not a target: at temperature 0 it changes no output that completed within the old bound.
 */
export const MAX_TOKENS = 1_024;

/** Bound on list_agents rounds in one turn. */
export const MAX_ROUNDS = 3;

/** Bound on invalid replies or messages sent back to the model to fix, per message. */
export const MAX_CORRECTIONS = 2;

/**
 * The model request for one message, with the persona its recipe gives it: the prompt as its role and the tools it
 * selects. The routing eval runs exactly this, with the persona read from recipes/hello-world.json.
 */
export function helloWorldTurn(message: ConversationMessage, handle: string, others: readonly string[], persona: AgentPersona): ChatRequest {
  // hello-world recalls nothing: its per-agent block is the identity line and the message.
  return channelTurn({ handle, others, persona, message, maxTokens: MAX_TOKENS, memory: '' });
}

export const handleHelloWorld: DeliveryHandler = async (delivery, context) => {
  const { message } = delivery;
  const roster = await context.roster();
  const others = roster.map((a) => a.handle);
  const calls = await decide({
    model: context.model,
    request: helloWorldTurn(message, context.handle, others, { role: context.prompt, guidance: context.guidance, tools: context.tools.definitions }),
    message,
    roster,
    maxRounds: MAX_ROUNDS,
    maxCorrections: MAX_CORRECTIONS,
    tools: context.tools,
  });
  for (const call of calls.filter((c) => c.name === PASS)) console.log(`pass: ${String(call.arguments['reason'])}`);
  await act(calls, others, delivery, context);
};
```

**Implementing a tool of the image's own.** Declare it in `images/<name>/image.json` — `{"tools": [{"name", "description", "parameters", "class": "files", "timeoutMs"}]}`, `parameters` in the JSON Schema subset `src/shared/tools.ts` checks (`type: "object"`, `properties` of `string`, `integer`, `number` or `boolean`, optional `required`, `minimum`, `enum`), `timeoutMs` at most 60,000 ([the manifest](recipes.md#image)) — and pass one handler per declared tool in `serveAgent`'s `imageTools.handlers`: `(args, signal) => Promise<{ok: true, value} | {ok: false, reason}>`, where `reason` is one of [the closed set](channel.md#tools), `value` serializes to at most 8 KiB, and `signal` aborts at the bound. Arguments are checked before the handler runs; a throw fails the turn and is logged as `tool.crashed`. A declared tool with no handler, or a handler with no declaration, fails the agent's start. A tool that runs a command or sends a request is never an image tool: it is a [module](#module). A recipe then selects it by name in `tools`. `hello-world`'s one tool, `hold` ([`hold.ts`](../../images/hello-world/src/hold.ts), [agent tools](channel.md#tools)), is the example: its handler is built in `main.ts` with the agent's log and passed as `handlers: { [HOLD]: holdHandler(log) }`.

**`/workspace`.** Every image creates `/workspace` owned by `node` (the Dockerfiles' `RUN … mkdir -p /workspace && chown node:node /workspace`), where the file tools act; `serveAgent` refuses to start without it (`WorkspaceUnavailable`).

The larger example, `images/memory`, adds [memory](memory.md#cycle) around `decide` and `act`.

### Steps {#image-steps}

1. Create `images/<name>/src/main.ts` (wiring) and `images/<name>/src/agent.ts` with your `NAME` (a base name matching `/^[a-z][a-z0-9-]{0,31}$/`, not `user`) and handler. The handler builds its persona from `context.prompt`, `context.guidance` and `context.tools.definitions`: the role is the recipe's, never the image's (`tests/unit/image-prompts.test.ts` fails on an image module exporting one). Keep the handler's work inside the recipe's `messageTimeoutMs`, or the harness stops the agent; work it starts and does not await (as the memory agent's write) goes to `context.background`, so a stop waits for it ([stopping](channel.md#stop)); pass `drainMs: AGENT_DRAIN_MS` to `serveAgent`; a recipe that selects tools needs a bound at which 11 model calls fit ([the tool loop](channel.md#tools)).
2. Create `images/<name>/image.json`: `{"tools": []}`, or the tools the image implements (above).
3. Copy [`images/hello-world/Dockerfile`](../../images/hello-world/Dockerfile), changing only the `ENTRYPOINT` path to `/app/images/<name>/src/main.js`; keep the base image pinned by digest, and keep the `/workspace` line.
4. Add a recipe whose `image` is `<name>` and whose `tools` selects what it needs ([above](#recipe)).
5. `npm run build`: `tsconfig.build.json` already includes `images/*/src/**/*.ts`. The daemon builds the image on first use as `asha-image-<name>:<digest hex>`, and builds a new tag when the staged files' digest (`asha.source`) changes.
6. `./asha recipe=<recipe> message="…"`; the container's output is in `<home>/logs/agents/<container>.log`.

| Touch | Test |
|---|---|
| `images/<name>/Dockerfile`, `src/main.ts`, `src/agent.ts` | Handler unit tests with a fake `ModelClient` and a recording `post`, asserting the exact posts and model requests (`serveAgent with the hello-world handler` in [`tests/unit/agent-sdk.test.ts`](../../tests/unit/agent-sdk.test.ts); [`tests/unit/memory/agent.test.ts`](../../tests/unit/memory/agent.test.ts)). |
| `recipes/<recipe>.json`, a docs page | The `Definitions` case above; `tests/agents/<name>.test.ts` with `agentSuite` from [`tests/agents/support.ts`](../../tests/agents/support.ts), through `./asha`, rendered by `npm run report` into the [agent test report](../testing/agent-tests.md). |

## Add a model {#model}

The procedure, with the API calls and the routing-eval run, is [Models — adding a model](models.md#adding). It enforces AGENTS.md §3:

| Rule | Detail |
|---|---|
| **Pinned by Hugging Face commit sha and a sha256 per file** | A name or a branch (`main`) is never a pin. |
| **Licence verified for the exact repo and revision** | Not the family's (PRINCIPLES §12): its id, URL at that revision, and date read. |
| **No licence file?** | The card's `README.md` at that revision is pinned in `files` and `license.source` (the owner, 2026-09-26). |
| **Commercially permissive licences only** | The owner's requirement. |
| **GGUF or safetensors only** | The schema rejects `.bin`, `.pt`, `.pth`, `.pkl`, `.ckpt`. |

The entry's fields: [catalogue spec](recipes.md#catalogue). The first `npm run check` using it downloads and verifies it.

| Touch | Test |
|---|---|
| `catalogue/<id>.json`, [`docs/architecture/models.html`](models.md#pinned) | A `Definitions` case loading it through `chatModel` or `embeddingModel`. |
| the recipe that uses it | The agent suite with that recipe: the real download, digest check and `llama-server` launch. If the eval asserts exact output, update the expectation, never loosen it. |

## Write a module {#module}

A module adds a tool an agent calls, or a hosted model a recipe names, without touching `src/` and without a build: a directory with a manifest, installed with `asha --install-module`. What the harness does with it — the sandbox, the egress proxy, approvals, the meter — is on [Modules](modules.md). This walkthrough builds from the reference [`tavily`](modules-tavily.md) module; [`bedrock`](modules-bedrock.md) is the model provider's version of the same steps.

1. **Write the code** as one plain ES module, `index.mjs`, with no dependency — `fetch` is enough, and the module base sends it through the egress proxy. A tool module exports `call(tool, args, context)`; a provider exports `chat(args, context)` and optionally `embed` and `lifecycle`. Take the key from `context.secrets.<NAME>`, bound every request (`AbortSignal.timeout`, inside the tool's `timeoutMs`), and answer `{ok: true, result, usage?}` or `{ok: false, reason, detail}` with a reason from the closed set — never throw for a vendor's failure. [`modules/tavily/index.mjs`](../../modules/tavily/index.mjs) is 40 lines.

```js
export async function call(tool, args, context) {
  if (tool !== 'search') return { ok: false, reason: 'unknown_tool', detail: `no tool ${tool}` };
  const response = await fetch('https://api.example.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${context.secrets.EXAMPLE_KEY}` },
    body: JSON.stringify({ query: args.query }),
    signal: AbortSignal.timeout(25_000),
  }).catch((error) => error);
  if (response instanceof Error) return { ok: false, reason: 'module_unavailable', detail: response.message };
  if (!response.ok) return { ok: false, reason: 'module_unavailable', detail: `HTTP ${response.status}` };
  return { ok: true, result: await response.json(), usage: { units: 1 } };
}
```

2. **Write `module.json`**, the closed manifest ([fields](modules.md#manifest)): `id` (lower case, digits, `_`), `kind`, `version`, `entry`, the sha256 of each file (`shasum -a 256 index.mjs package-lock.json`), the licence with its URL and the date you read it, every host, every secret, each tool with a description the model reads, its classes and its `timeoutMs`, and the cost model. A tool that returns text from outside is `untrusted-input`; every tool of a module with a host is `egress`; one that changes something outside the machine is `consequential`, and is never called without the user's approval. A paid service needs a written estimate on the module's page and the owner's approval in `cost.approved` before any live call (PRINCIPLES §7). Add a `package-lock.json` listing no package.

3. **Test it against a fake, never the vendor.** The [contract suite](../../tests/helpers/module-contract.ts) (`runContract`) runs your entry through the real module runtime with `fetch` replaced by a fake built from the vendor's documented answer, and checks the framing, the reason set, the hosts and that each secret goes only into the `Authorization` header to a listed host. Assert the exact request and result of every path, as [`tests/unit/reference-module-calls.test.ts`](../../tests/unit/reference-module-calls.test.ts) does, and prove each guard fails ([`reference-modules.test.ts`](../../tests/unit/reference-modules.test.ts) recomputes the sha256 values).

4. **Install it and grant it.**

```
asha --stop
asha --install-module path=modules/<id>
printf '%s' "$KEY" | asha --set-secret module=<id> name=<NAME>
asha --enable-module id=<id> conversation=0.10 day=1 month=10    # a metered module only
```

These are the commands the CLI's own tests run against a temporary home ([`tests/unit/cli-modules.test.ts`](../../tests/unit/cli-modules.test.ts)); installing a tool module also builds its image in colima. Then in a recipe, `"modules": ["<id>/<tool>"]` with a `messageTimeoutMs` of at least the tool's `timeoutMs` + 125,000 ([recipe spec](recipes.md#recipe)).

5. **Write its page** in `docs/architecture/`: what it does, its manifest, what leaves the machine, its estimate and the approval line `**Approved:** by <who>, <date>, cap $<cap> a month` (the docs guard compares it with the manifest), its vendor-side limit, and a threat model — its secrets, its egress, injection through its output, its consequential actions and what an agent could do with it. Its review covers the same.

| Touch | Test |
|---|---|
| `modules/<id>/index.mjs`, `module.json`, `package-lock.json` | The contract suite and exact unit tests against a fake; `reference-modules.test.ts`' manifest and sha256 checks |
| `docs/architecture/modules-<id>.md` | The docs guard: the approval line, and a provider's price read within 90 days |
| a live check, once approved | `ASHA_LIVE_MODULE=<id> npm run live:modules`, outside the gate, recording what the vendor did ([Deployments](../deployments/index.md#live-modules)) |

A command plugin is the same steps with a Dockerfile in place of the JavaScript and the program's release archive pinned by sha256 and supplied by the user at install; [`aws_cli`](modules-aws-cli.md) is the reference.

## Add an adapter behind an existing contract {#adapter}

Implementations are chosen only in `productionDependencies` in [`src/daemon/compose.ts`](../../src/daemon/compose.ts), the composition root (PRINCIPLES §10); tests call `startDaemon` with fakes.

| Contract | Methods | Today | Fake |
|---|---|---|---|
| `ContainerRuntime` — [`container-runtime/index.ts`](../../src/daemon/container-runtime/index.ts) | `hostAddress`; `ensureReady()` → `'ready' \| 'started' \| 'installed'`; `ensureImage(spec)` → `{tag, status: 'current' \| 'built'}` (one tag per source digest, `imageTag`; build only a missing tag, never replace one); `start(spec)` → `{exited}` (env passed by name); `stop(name, mode)` (`drain`: SIGTERM, SIGKILL after `AGENT_STOP_GRACE_MS`; `kill`: at once) | `ColimaRuntime` (colima + docker CLI, Homebrew install) | `FakeRuntime` |
| `ModelServer` — [`model-server/index.ts`](../../src/daemon/model-server/index.ts) | `ensureServing(entry, cached)` → `ModelEndpoint {baseUrl, model}`, an OpenAI-compatible server on loopback answering to the catalogue id; `stopAll()` | `LlamaCppServer` (`llama-server`, Metal) | `FakeModelServer` |
| `ModelStore` — [`model-store/index.ts`](../../src/daemon/model-store/index.ts) | `ensure(entry)` → `CachedModel {dir, weightsPath, status}`, every file verified | `HuggingFaceModelStore` | `FakeStore` |

Fakes are in [`tests/helpers/daemon-fakes.ts`](../../tests/helpers/daemon-fakes.ts); the process-level fakes (`FakeRunner`, `FakeLauncher`, `FakeFetch`, `RecordingLogger`) in [`tests/helpers/fakes.ts`](../../tests/helpers/fakes.ts).

<p class="pre-label">src/daemon/compose.ts — productionDependencies</p>

```
export function productionDependencies(paths: HarnessPaths, logger: Logger): DaemonDependencies {
  const runner = new ExecCommandRunner();
  const launcher = new SpawnProcessLauncher();
  return {
    runtime: new ColimaRuntime({ runner, launcher, logger, profile: 'default' }),
    modelServer: new LlamaCppServer({
      runner,
      launcher,
      logger,
      fetch: globalThis.fetch,
      logDir: paths.logsDir,
      readyTimeoutMs: 120_000,
    }),
    store: new HuggingFaceModelStore({
      modelsDir: paths.modelsDir,
      baseUrl: 'https://huggingface.co',
      fetch: globalThis.fetch,
      logger,
      stallTimeoutMs: 60_000,
      pid: process.pid,
      isAlive,
    }),
    fetch: globalThis.fetch,
  };
}
```

### Steps {#adapter-steps}

1. **Justify it in writing** (PRINCIPLES §7, AGENTS.md §2): the closest thing that exists, why it cannot be extended, and what the adapter costs.
2. **Implement the contract** in its module folder: a `readonly` props interface, every call bounded, every failure a typed error with its cause (PRINCIPLES §10, §11); export it from `index.ts`.
3. **Wire it** in `productionDependencies`.
4. **Map any new error class** to a wire reason in `classify` ([`src/daemon/agents/index.ts`](../../src/daemon/agents/index.ts)); an unmapped error becomes `internal`.

> [!WARNING] If a consumer must change, the contract is leaking
> No consumer — `AgentSupervisor`, the gateway, the server — should change when an adapter is added.

| Touch | Test |
|---|---|
| the adapter | Unit tests with `FakeRunner` / `FakeLauncher` / `FakeFetch` asserting exact commands, arguments, env, failures and bounds, like [`tests/unit/model-server.test.ts`](../../tests/unit/model-server.test.ts) and [`tests/unit/container-runtime.test.ts`](../../tests/unit/container-runtime.test.ts). |
| `src/daemon/compose.ts`, [Architecture](index.md), this page | The agent suite and eval, on the adapter's platform (PRINCIPLES §14). |

A second container runtime and a CUDA build of llama.cpp for a PC are <span class="badge planned">planned: pc-cuda</span>; the pc-cuda plan (`docs/plans/pc-cuda.md`) has the design.
