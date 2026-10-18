---
title: asha Documentation
description: The index of every document about asha, the SimplyAutonomous.AI agent harness — project, CLI, portal, architecture, pattern demos, quality, testing, deployments and plans.
---

# asha documentation

asha, the Autonomous Simple Harness for Agents, runs AI agents in local containers on open-weight models served on your own machine. This is the index of everything written about it.

<div class="facts"><span>index verified 2026-10-10</span><span>asha 0.1.1</span><span>open locally: <code>open docs/index.html</code></span></div>

> [!SUMMARY]
> - Agents talk on named channels and reach a model only through the harness (diagram below).
> - Every page is linked here or from its section index; `tests/unit/docs.test.ts` fails otherwise.
> - Pages are Markdown sources rendered by `npm run docs` under the [documentation contract](project/documentation.md).
> - To start, build once and run `./asha --portal`: it starts the server if none is running, and opens the portal ([Start here](#start)).

## Start here {#start}

Build once, then open the [portal](portal/index.md): `--portal` starts the server — the asha daemon, which runs the agents and their model servers — if none is running, and opens the portal in your browser. It needs macOS on Apple Silicon with Homebrew installed ([prerequisites](deployments/index.md#prerequisites)).

```sh
npm install && npm run build   # build time, once
./asha --portal                # → portal: http://127.0.0.1:<port>/ , opened in your default browser
```

In the portal, **Watch** shows a channel's agents as a robot crew beside its chat, and **Run demo** runs a [pattern demo](patterns/index.md) there; the [portal page](portal/index.md#demo) says which cannot run from it. `./asha --portal user=alice` opens it as the user `alice`; by default it is your login name, as a user ID. The server keeps running until `./asha --stop`, or **Stop the daemon…** in the portal's **Status** view.

### Run the server yourself {#server}

To keep the server in a terminal and read its log as it runs:

```sh
./asha --server    # the server in the foreground; its log on this terminal; Ctrl-C stops it
```

Then, in another terminal:

```sh
./asha --status    # → running: pid …, port …, version …
./asha --portal    # opens the portal on that server
./asha --stop      # stops the server and every agent on every channel
```

The server listens on `127.0.0.1` only. Every command is in the [command line interface](cli/index.md); how the server runs is in [Deployments](deployments/index.md).

### From the command line {#cli}

```sh
./asha recipe=hello-world message="Please say: Hello World."   # → Hello World.
./asha --watch                                                  # everything on the channel
./asha --stop
```

## The system on one page {#system}

![Agents never reach a model directly: every model call goes through the daemon's gateway, authenticated by the agent's token. Details: [Architecture](architecture/index.md).](system.svg)

## Contents {#contents}

1. [Project details](project/index.md) — what asha is, its rules, licence and terms
   1. [Workflows](project/workflows.md) — planning, coding, testing, docs, owner decisions, review, checklists
   2. [Documentation contract](project/documentation.md) — how these pages are written and guarded
2. [Command line interface](cli/index.md) — every `asha` command, with examples
   1. [CLI guide with real output](cli/guide.md) — a fresh install and a warm run, transcribed
3. [Portal user interface](portal/index.md) — `asha --portal`: every command in the browser, the channel as a robot crew, each agent's telemetry
4. [Architecture](architecture/index.md) — components, interactions, where the code lives
   1. [Channels and agents](architecture/channel.md) — handles, delivery, addressing, the SDK, container lifecycle
   2. [Models](architecture/models.md) — pins, download and verification, serving, the gateway
   3. [Recipes and configuration](architecture/recipes.md) — recipe, image and catalogue specifications
   4. [Agent memory](architecture/memory.md) — the four memory tiers of the `memory` recipe
   5. [Extending asha](architecture/extending.md) — adding a recipe, team, image, model or adapter
5. [Pattern demos](patterns/index.md) — the 26 multi-agent patterns, 25 built as a team to run, a test and a page; each one's status
6. [Quality controls](quality/index.md) — static analysis, the gate, guards, review
7. [Testing](testing/index.md) — the suites, what each covers, latest results
   1. [Agent test report](testing/agent-tests.html) — each agent-suite test's transcript (generated)
8. [Deployments](deployments/index.md) — the ephemeral on-premises server, and the persistent-server plans
9. Plans (`docs/plans/index.md`) — all future work as specifications with a status
   1. Plan template (`docs/plans/template.md`) — the sections every plan must have
   2. Debt register (`docs/plans/debt.md`) — known shortcuts and defects, and the plans that pay them off

> [!NOTE] Changing this repo?
> Human or agent, read the rules first: [AGENTS.md](../AGENTS.md) and [PRINCIPLES.md](../PRINCIPLES.md).
