---
title: asha Deployments
description: Running the asha daemon on your own machine — the ephemeral server that exists today, the plan for an optional persistent server on macOS, and the deferred Linux, Windows and PC plans.
---

# Deployments

asha runs on your own machine, as an ephemeral daemon that ends when stopped or at reboot.

<div class="facts"><span>verified 2026-09-27</span><span>run on: macOS, Apple Silicon</span><span>state: <code>ASHA_HOME</code></span></div>

> [!SUMMARY]
> - Run `./asha --server`, or just send a message and the CLI starts the daemon.
> - Needs macOS on Apple Silicon, Homebrew and Node, and a built checkout (`npm install && npm run build`).
> - `asha --status` checks, `asha --stop` stops (`./asha` in a checkout); state lives in `~/.simplyautonomous/harness`.
> - A release is `npm run release` at a tagged commit: a tarball of the commit and its build ([release](#release)).
> - No persistent server yet; past decisions are in [history](history.md).

## What exists {#overview}

Local only: no deploy path, no remote hosting ([AGENTS.md](../../AGENTS.md) §2), and everything binds to `127.0.0.1`.

| Deployment | Status | Survives reboot |
|---|---|---|
| Ephemeral, in the foreground: `./asha --server` | <span class="badge built">built</span> | No |
| Ephemeral, started by the CLI in the background | <span class="badge built">built</span> | No |
| Persistent on macOS (launchd) | <span class="badge planned">planned: persistent-macos</span> | Not built |
| Persistent on Linux (systemd) | <span class="badge planned">planned: persistent-linux</span>, deferred | Not built |
| Persistent on Windows | <span class="badge planned">planned: persistent-windows</span>, deferred | Not built |

## Prerequisites {#prerequisites}

- **macOS on Apple Silicon** (the only platform tested); `llama-server` uses Metal.
- A built checkout: **Node.js `^22.13.0 || ^24.0.0 || >=26.0.0`** (`engines.node` in [package.json](../../package.json), the range both Vitest 5 and ESLint 10 support), **bash** for the [`./asha`](../../asha) launcher, and `npm install && npm run build` once (without `dist/`, `./asha` exits 1 naming that command).
- **Installed on demand**, in a checkout, with `brew install`: `colima`, `docker` (the CLI) and `llama.cpp` (`llama-server`). Each install is bounded to 15 minutes, `colima start` to 10.
- **Network on first use** for models from Hugging Face; the chat model `qwen3-8b-q4_k_m` is 5,027,783,488 bytes ([catalogue/qwen3-8b-q4_k_m.json](../../catalogue/qwen3-8b-q4_k_m.json)). The pattern demos' sub-agents in 18 teams name `pico-v2-q8_0`, 9,028,871,552 bytes ([catalogue/pico-v2-q8_0.json](../../catalogue/pico-v2-q8_0.json)), downloaded the first time such a demo runs. A daemon running one of the 13 whose routers name `qwen3-8b-q4_k_m` serves both models until it stops, about 24.6 GiB resident together at their largest in its recorded runs; P3, P12, P25, P15 and P17 have no router and load `pico-v2-q8_0` alone (since 2026-10-10, `docs/plans/demo-model-pico.md`).

> [!WARNING] Homebrew must already be installed
> The harness never installs it. When a tool is needed, the daemon fails with `PrerequisiteMissing` and points to https\://brew.sh (`ensureHostTool` in [`src/daemon/host-tools/index.ts`](../../src/daemon/host-tools/index.ts)).

TODO: minimum RAM, disk and macOS version are not measured or recorded.

**Disk in colima's VM.** Each build of an agent, harness, module or plugin image is a new tag, and every daemon start removes asha's versions that are not the newest of their image, are older than 24 hours and are used by no container — at most 50 per start, never another project's image, never Docker's build cache or dangling layers ([the image prune](../architecture/recipes.md#prune); since 2026-10-03, `docs/plans/debt-paydown-2.md`). Its record is `image.pruned` in the daemon's log; `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock docker image ls 'asha-*'` lists the versions kept.

## Ephemeral server <span class="badge built">built</span> {#ephemeral}

One daemon per harness home, on an ephemeral port on `127.0.0.1`, until SIGINT, SIGTERM or SIGHUP; nothing restarts it.

![From [src/cli/commands.ts](../../src/cli/commands.ts) (`server`, `startServer`, `stop`) and [src/daemon/compose.ts](../../src/daemon/compose.ts) (`startDaemon`).](ephemeral-lifecycle.svg)

**In the foreground:**

```
./asha --server
```

It prints `asha <version> serving on 127.0.0.1:<port> (pid <pid>); home <home>` on stdout and every log record as a JSON line on stderr. Ctrl-C (SIGINT) stops it, as does closing its terminal (SIGHUP); a second Ctrl-C during the stop is logged and ignored. A second daemon on that home fails with `LockHeld`.

**Started by the CLI:** a message (or a message of an `--interactive` session), `/watch on`, `--launch` or `--watch` that finds no daemon spawns a detached `asha --server`, prints `› started the asha daemon (pid N); log: …/logs/server.log` with `--verbose`, and waits up to 20 s for it. Racing CLIs share the winner's daemon.

> [!DECISION]
> The one deliberate automatic behaviour (AGENTS.md §3), announced on stderr only with `--verbose` (the owner's answer of 2026-09-27, record `auto-start-announcement`; *changed 2026-09-28: this said "unless `--quiet` is given", and before 2026-09-27 "always"*).

**Check and stop:**

```
./asha --status   # running: pid, port, version, build, started; then each agent
./asha --stop     # SIGTERM; prints "stopped (pid N)", or exits 1 if still alive after 90 s
```

The 90 s bound is `timing.serverStopMs` in [`src/cli/main.ts`](../../src/cli/main.ts): 45 s until the stop-time fix `c088357` (2026-09-27), which raised an agent's stop grace to 70 s; this page's line was updated in `c766499`, whose message names only the before-login line.

After a rebuild the CLI warns that the daemon's build differs; `./asha --stop` picks up the new one. The colima VM (profile `default`) is never stopped.

## Releases {#release}

A release is a tarball of one tagged commit plus its build. There is no published tap for Homebrew and no npm package (the owner's answer `oss-distribution` (a), 2026-10-03, `docs/plans/oss-release.md` R31): the ways in are a built checkout ([prerequisites](#prerequisites)) and, once one is published, a release's tarball and its sha256. Plan and evidence: `docs/plans/brew-install.md`.

**1. Cut the release** on a clean `main` whose gate is green, with `package.json`'s `version` set:

```
git tag -a v0.1.1 -m "asha 0.1.1"
npm run --silent release
```

`npm run release` ([`tools/release/pack.mts`](../../tools/release/pack.mts)) refuses, writing nothing, when the tree is dirty, when `HEAD` is not the commit tagged `v<version>`, or when `build/release/v<version>/` already exists. Otherwise it builds; stages the tracked entries from `git archive HEAD` (so no ignored file among them ships) less the agent suite's fixtures, `teams/suite-*` and the test-only `images/suite-*`, the fresh `dist/` less `dist/images/suite-*` (the build compiles every image), and refuses a finished tarball that still holds any `suite-` path (guarded by [`tests/unit/release.test.ts`](../../tests/unit/release.test.ts)), and the agent packages' runtime files from the build's `dist/agent-packages/`, never from the checkout's `node_modules/`: since 2026-10-03 (`docs/plans/debt-paydown.md` R10, R11) `npm run build` itself ends with a clean `npm ci --omit=dev --ignore-scripts --offline --no-audit --no-fund --loglevel=error --no-dry-run` of `package.json` and `package-lock.json` ([`tools/agent-packages/build.mts`](../../tools/agent-packages/build.mts)), and the release runs none of its own (from `d231ad0`, 2026-09-27, the release ran that install in its run directory; until then a stray or edited file inside a locked package's folder shipped, although this line said "so no ignored file ships"). The build, and with it the release, fails when the npm cache does not hold an intact copy of a locked package (npm checks each against the lockfile's `integrity`): `build: the npm cache does not hold an intact copy of <url>, which package-lock.json locks; run npm ci in the checkout, then retry`. The last two flags override the `npm_config_loglevel` and `npm_config_dry_run` that `npm run --silent build` and `npm run release --dry-run` pass to every npm a script starts, which would otherwise hide the cache miss or install nothing or the lockfile marks an agent package dev; writes the tarball and the formula into a run directory; and promotes that to `build/release/v<version>/`. It prints four lines: `version`, `commit`, `sha256` and `url`. Push the tag: `git push origin v<version>`.

**What a release holds** (`ENTRIES` in [`tools/release/pack.mts`](../../tools/release/pack.mts)): one folder, `asha-<version>/`, with `LICENSE`, `asha`, `catalogue/`, `decider/`, the fresh `dist/` less the test-only images, `harness-images/`, `images/` less `images/suite-*`, `modules/`, the agent packages' runtime files in `node_modules/` (never `playwright`), `package.json`, `package-lock.json`, `portal/`, `recipes/` and `teams/` less `teams/suite-*`. `npm run release` also writes a Homebrew formula for the maintainers' local tap, which is not published (`docs/plans/brew-install.md`, its section on the local tap's procedure). Each release's run logs are internal records (`tools/release/evidence/`).

## Publishing {#publish}

asha 0.2.0 was published on 2026-10-18 with gates G1–G3 waived in part by the owner, each row saying what stands in its place (`docs/plans/oss-release.md`). The same day the repository moved to the owner's organization, `Simply-Autonomous-AI/asha`; GitHub redirects every link to its first address, `SimplyAutonomous-AI/asha`, web and git alike, for as long as no repository or fork named `asha` is made again under the `SimplyAutonomous-AI` account. asha is published only by these manual commands, and only once the release plan's Status table (`docs/plans/oss-release.md`, internal) records the three owner-side gates — `gate G1`, the company filed and the code assigned to it; `gate G2`, the GitHub organization (the owner's is `Simply-Autonomous-AI`, created 2026-10-18) and the name-holding `simplyautonomous`; `gate G3`, the Terms of Service, the Privacy Policy and the contributor licence agreement reviewed — each dated, with its evidence (R33). Each outward step below waits for the owner's explicit consent to that step, given in conversation and recorded in that table with its date; the export repository's pre-push hook refuses a push until a `publish consent` row dated that day names the version (R35).

**Before it, that day,** in this repository at the commit to publish, clean:

```sh
ASHA_OSS_MARKERS=<the owner's markers file> npm run oss:check -- <commit>
```

Every step must pass: the export, the marker scan, gitleaks over the export's history and tree, the size check, then a clone with nothing beside it — `npm ci`, every other npm step CI runs (the linters, the formatter, the typecheck, the unit and integration tests, the secret scan), the build, the release and its tarball, each with `CI=true` as on GitHub's runners (typescript-eslint, for one, reads it). The run's folder, printed at the end, holds `run.log`, every step's output and exit status. Then check that `LICENSE`'s first `Required Notice:` line, the README's licence section and `package.json`'s `author` name the company as G1 filed it, that `package.json`'s `repository`, `homepage` and `bugs` name G2's organization, and re-read the plan's external facts; a mismatch is fixed here, committed, and checked again.

**The first release:**

```sh
npm run oss:export -- <commit> ../asha-public          # a new repository: one commit, tagged v<version>, no remote
cd ../asha-public
gh repo create Simply-Autonomous-AI/asha --public --source . --remote origin   # consent: creating the repository
git push origin main v<version>                         # consent: the push (the hook checks it)
gh release create v<version> <the tarball and its sha256 from oss:check's run> --title "asha <version>"   # consent: the release
```

**A later release** is one commit more on the published history, never a force-push: clone the published repository, then `npm run oss:export -- <commit> <the clone> [--co-author "Name <email>"]…` — each outside contributor named must be in the signers file `ASHA_CLA_SIGNERS` names (R39) — and push and release as above.

**After it,** check the published repository against reality (R34): its `main` tree is the export's (`git ls-remote origin main`), its first CI run is green, and a `git clone` from GitHub followed by the README's quickstart prints `Hello World.`.

## The opt-in live-vendor check {#live-modules}

`npm run live:modules` ([`tests/live/modules.test.ts`](../../tests/live/modules.test.ts), [`liveCheck`](../../src/daemon/modules/live.ts)) checks one installed [module](../architecture/modules.md) against its real vendor, outside the gate: it is the only thing in this repository that calls a vendor, and it spends. Name the module, and for a tool module the call:

```
ASHA_LIVE_MODULE=bedrock npm run live:modules
ASHA_LIVE_MODULE=tavily ASHA_LIVE_TOOL=search ASHA_LIVE_ARGS='{"query":"asha"}' npm run live:modules
```

It runs in the home `ASHA_HOME` names, holding its `daemon.lock`, so no daemon may run meanwhile. It refuses, before anything reaches the network, a module whose manifest carries no owner's approval of its cost (`cost.approved`), and a command plugin (not yet supported, D52). Then, through the module's own container and the egress proxy, as a launch uses them: for a model provider, each chat model's lifecycle state first — anything but `ACTIVE` refused before any chat — then one chat requiring a tool call, recording whether the vendor honoured the forced tool choice and reported its usage; for a tool module, the named call. It removes what it made (the reclaim) and writes its record, with the commit and whether the tree was dirty, to `evals/probes/extension-modules-live-<date>/<module>-<time>.json`. Run on 2026-10-02 in its refusal paths only (no module named; a metered module with no approval, refused with no network call); no vendor has been called: the keys are the owner's to enter, and the Bedrock credential is created only with the owner's consent.

## Where state and logs live {#state}

Everything is under `ASHA_HOME` (default `~/.simplyautonomous/harness`; set it to run a separate daemon). `ASHA_MODELS_DIR` moves the model cache. Paths come from `harnessPaths` in [`src/shared/paths.ts`](../../src/shared/paths.ts). A home that does not exist is created with mode `0700` by the daemon or the CLI (`ensureHome`); an existing one keeps its mode, so an older home stays `0755` unless you `chmod 700` it. Each home's agent containers run on their own Docker network, `asha-<homeId>` ([reaching the host](../architecture/index.md#host-inference)).

| Path under ASHA_HOME | What |
|---|---|
| `daemon.lock` | The pid lock: one daemon per home |
| `daemon.json` | `{pid, port, credential}` of the running daemon, mode `0600`, removed on a clean stop. The credential is the control API's ([the two APIs](../architecture/index.md#apis)) |
| `model-server.key` | The key every `llama-server` of this daemon requires, mode `0600`, removed on a clean stop |
| `users.json` | Highest user number per channel, so IDs are never reused |
| `logs/daemon.jsonl` | Every daemon log record, as JSON lines |
| `logs/server.log` | Output of a CLI-started daemon |
| `logs/model-server-<id>.log` | `llama-server` output |
| `logs/agents/<container>.log` | An agent container's output; the daemon log's `agent.connected` names its handle |
| `models/sha256-<digest>/` | Verified model cache |
| `staging/` | Per-build docker contexts |

Every failure the daemon saw ([more on logs](../architecture/index.md#logs)):

```
jq -c 'select(.level=="error")' ~/.simplyautonomous/harness/logs/daemon.jsonl
```

## Persistent server {#persistent}

Not built: no service definition exists in the repo. **macOS only for now** (the owner, 2026-09-27: "Mac OSX only for now - linux and windows later"; decisions/queue.json at `f538cb7`, record `pc-platform`).

| Platform | Plan | Notes |
|---|---|---|
| macOS (launchd) | <span class="badge planned">planned: persistent-macos</span> | Optional launchd job at boot (record `run-before-login`); starting before anyone logs in was confirmed by the owner on 2026-09-27 (record `service-boot-confirmation`). With FileVault on, the owner answered the same day (record `service-filevault-boot`): the service starts as soon as the disk is unlocked at FileVault's screen, with no other action (`docs/plans/persistent-macos.md` R1). *Corrected 2026-09-27: this said what "before login" means was still an open owner question.* Settles `--stop`, `--status` and auto-start. |
| Linux (systemd) | <span class="badge planned">planned: persistent-linux</span> | Deferred; needs the PC adapters. |
| Windows | <span class="badge planned">planned: persistent-windows</span> | Deferred; bash, Homebrew and colima are not native. |

TODO: a persistent deployment, for each platform, once its plan is done; record the working service definition and commands here with the date verified.

## Platform notes {#platforms}

| Concern | macOS (built) |
|---|---|
| Container runtime | colima + docker CLI (`ColimaRuntime` in [src/daemon/container-runtime/index.ts](../../src/daemon/container-runtime/index.ts)) |
| Model server | `llama-server` from `brew install llama.cpp`, Metal, on the host (`LlamaCppServer` in [src/daemon/model-server/index.ts](../../src/daemon/model-server/index.ts)) |
| Why models run on the host | colima's Linux VM has no Metal GPU |

**PC path** <span class="badge planned">planned: pc-cuda</span>, deferred: a CUDA build of llama.cpp with Docker Engine (record `docker-runtime`, 2026-09-27). See [AGENTS.md](../../AGENTS.md) §3, [Architecture](../architecture/index.md) and [Models](../architecture/models.md).

Sources: [src/cli/main.ts](../../src/cli/main.ts), [src/cli/commands.ts](../../src/cli/commands.ts), [src/daemon/compose.ts](../../src/daemon/compose.ts), [src/shared/paths.ts](../../src/shared/paths.ts).
