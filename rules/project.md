# What this repo is — in full

The detail behind [AGENTS.md](../AGENTS.md) §1.

**asha** (Autonomous Simple Harness for Agents): the SimplyAutonomous.AI agent
harness. One command, `./asha` (built once with `npm install && npm run
build`; it never runs npm itself), or the same command from a release's
unpacked tarball (docs/deployments/index.md#release), posts
messages to named agent channels (`asha recipe=… [channel=…] [to=hewo-1]
message=…`), watches them (`--watch`), and runs the daemon (`--server`, started
automatically when needed). Agents name themselves; the channel numbers them
into handles (`hewo-1`) by which they are addressed. The daemon installs and starts
colima when needed, runs agent images inside it, carries the channel between
agents and the user, and brokers every call an agent makes to an open-weight
model. Everything runs locally on the user's desktop. Models
are downloaded from pinned catalogue entries, verified, cached, and served on the
host by llama.cpp's `llama-server` (Metal on Apple Silicon).

**Status (2026-09-26): first slice.** `asha recipe=hello-world message="Please
say: Hello World."` brings the hello-world agent online on the channel and
prints its reply. Agents collaborate on a channel by delegating to each other.
The `memory` recipe keeps four memory tiers per user
(docs/architecture/memory.html).
`asha --portal` opens the portal, a web page the daemon serves on its own listener: every command, a channel's agents drawn as a robot crew saying what they say and work on, chats of the channel you can post into, the pattern demos at a click, and each agent's telemetry ([docs/portal/index.html](../docs/portal/index.html); built 2026-10-02, the scene and chats 2026-10-07). Its browser tests need playwright-core's pinned browsers, installed once per machine: `npx playwright-core install --no-remove chromium-headless-shell firefox`.
All docs: [docs/index.html](../docs/index.html).

**Objectives (the owner, 2026-09-27).** New work toward them is specified as
a plan in `docs/plans/` before it is built (PRINCIPLES §19); objectives 2, 3
and 4 have plans (4's measurable targets in `enterprise-targets`), and 1 and 4
are also standing properties every plan must keep (corrected 2026-09-27: this
said only 2 and 3 have plans).

1. **Local first.** Every core capability runs on the user's own hardware with
   local models. Cloud modules (objective 3) are optional additions: nothing in
   the core or the gate depends on one.
2. **Every significant multi-agent pattern, demonstrated.** Runnable, tested,
   documented examples of orchestration, supervision and collaboration
   patterns (`docs/plans/orchestration-patterns.md`).
3. **Extensible by drop-in modules.** Contributors add tools (web search,
   trading, …) and model providers (Anthropic, OpenAI, AWS Bedrock, Google,
   Azure, …) as modules agents can use, without changing the core.
   A module that calls a cloud service is optional, off unless a recipe grants it, and
   enabling a metered one still needs a written estimate and the owner's
   approval (AGENTS.md §2, PRINCIPLES §7)
   (`docs/plans/extension-modules.md`).
4. **Enterprise grade** in quality, reliability, performance, security and
   privacy — met through the principles, the gate, and the reviews, not
   asserted. Its 14 measurable targets were approved by the owner on
   2026-09-27 and are specified, each with its automated check, in
   `docs/plans/enterprise-targets.md`.
