---
title: asha Project Details
description: What asha is, its objectives, the rules that govern it, its licence and terms, and where its procedures and history live.
---

# Project details

What asha is, what it is for, and the rules every change follows. Procedures are on [Workflows](workflows.md); dated records are on [History](history.md).

<div class="facts"><span>verified 2026-10-11</span><span>asha 0.1.1</span><span>© 2026 SimplyAutonomous.AI, LLC; PolyForm Noncommercial or Small Business</span><span>package: <code>private: true</code></span><span>sources: AGENTS.md, PRINCIPLES.md, package.json, git log</span></div>

> [!SUMMARY]
> - asha is one CLI and one daemon that run agents in local containers on local models, at $0 recurring cost.
> - Objectives: local first, every multi-agent pattern demonstrated, drop-in modules, enterprise grade; patterns, modules and the enterprise targets have plans.
> - PRINCIPLES.md governs; AGENTS.md adds this repo's rules. The gate is `npm run check`; there is no deploy path.
> - Copyright © 2026 SimplyAutonomous.AI, LLC. Licensed under PolyForm Noncommercial 1.0.0 or PolyForm Small Business 1.0.0, at the user's choice; any other use needs a licence agreement signed with the company. Published on GitHub as `Simply-Autonomous-AI/asha` from 0.2.0 (2026-10-18; moved there the same day from `SimplyAutonomous-AI/asha`, which redirects to it), with its Terms of Service, Privacy Policy and contributor licence agreement.
> - The [Terms of Service](../../TERMS.md), the [Privacy Policy](../../PRIVACY.md) and the [contributor licence agreement](../../CLA.md) are drafts, not reviewed by counsel, published as they are at the owner's direction (2026-10-18, `docs/plans/oss-release.md`, gate G3).

## Summary {#summary}

**asha** is the Autonomous Simple Harness for Agents: the SimplyAutonomous.AI agent harness.

- **`./asha`** posts messages to named agent channels, watches them, and starts the daemon when needed.
- **The daemon** runs agent images in colima containers, carries the channel between agents and the user, and brokers every model call.
- **Models** are open-weight, served on the host by llama.cpp's `llama-server`.
- **Everything is local.** The daemon binds only to `127.0.0.1`; recurring cost is $0 ([AGENTS.md](../../AGENTS.md) §2, §7). See the [system diagram](../index.md#system).

| Fact | Value | Source |
|---|---|---|
| Package | `asha` 0.2.4 (named `simplyautonomous-ai-harness` until 2026-10-16, `docs/plans/oss-release.md` R27), `"private": true`, `"license": "SEE LICENSE IN LICENSE"`, `"author": "SimplyAutonomous.AI, LLC"` | [package.json](../../package.json) |
| Runtime | Node.js `^22.13.0 \|\| ^24.0.0 \|\| >=26.0.0` (the range both Vitest 5 and ESLint 10 support, needed for `npm install`; product code stops at `@types/node` 22.13 and `lib` ES2024, [Quality](../quality/index.md#typecheck)), TypeScript 6.0.3 | [package.json](../../package.json) |
| Status | First slice: single- and multi-agent hello world, and the `memory` recipe with four memory tiers | [AGENTS.md](../../AGENTS.md) §1 |
| Remote | A private server, only sometimes reachable (`git remote get-url origin`) | [AGENTS.md](../../AGENTS.md) §2 |

## Objectives {#objectives}

The owner's objectives (2026-09-27). Work toward them starts as a plan (PRINCIPLES §19); 1 and 4 are standing properties every plan keeps.

| Objective | What it means | Plan |
|---|---|---|
| **1. Local first** | Every core capability runs on the user's hardware with local models. Cloud modules are optional; nothing in the core or the gate depends on one. The gate needs the network only to fill cold caches (host tools, the model, the images' base); the unit and integration suites refuse any connection but loopback, and every network call site is listed by a guard ([the gate stays offline](../quality/index.md#offline), since 2026-10-02). | holds today ([Models](../architecture/models.md)) |
| **2. Every multi-agent pattern, demonstrated** | A runnable, tested, documented example of each significant orchestration, supervision and collaboration pattern. Delegation is built ([Channels](../architecture/channel.md#delegation)); the owner confirmed all 23 patterns of the catalogue (decisions/queue.json at `f538cb7`, record `pattern-catalogue`). | <span class="badge planned">planned: orchestration-patterns</span> `docs/plans/orchestration-patterns.md` |
| **3. Drop-in modules** | Tools (web search such as Tavily, trading such as Alpaca) and model providers (Anthropic, OpenAI, AWS Bedrock, Google, Microsoft Azure) added as modules, with no change to the core. A cloud module is off unless a recipe grants it; a metered one needs a written estimate and the owner's approval (§7). | built 2026-10-02 by `docs/plans/extension-modules.md`: the [module](../architecture/modules.md) contracts, sandbox, egress proxy, approvals, meter and command plugins, with the reference `tavily` (Tavily) and `bedrock` (AWS Bedrock) modules and the AWS CLI plugin, tested against fakes; no vendor called yet (keys and credential are the owner's to give); trading is out of scope (the owner, question 6); TODO: the colima sandbox proofs and the gate run (plan (`docs/plans/extension-modules.md`)) |
| **4. Enterprise grade** | Quality, reliability, performance, security and privacy fit for an enterprise, shown by evidence through [the principles](../../PRINCIPLES.md) and [Quality controls](../quality/index.md). The owner approved fourteen measurable targets on 2026-09-27 (decisions/queue.json record `enterprise-targets-approval`, option a): reply and launch times, no flaky tests, findable failures, crash recovery, no open door for containers, secrets, pinned dependencies, and data kept local, each to become an automated check in the gate. | standing; <span class="badge planned">planned: enterprise-targets</span> `docs/plans/enterprise-targets.md` |

## Principles and repo rules {#principles}

- **[PRINCIPLES.md](../../PRINCIPLES.md) governs this repo.** It is a one-line index loaded every session; each principle's text is a file in `principles/`, read when a task reaches it. It asks that nothing else enumerate the principles, so this page lists only how they apply here. §17–§21 date from 2026-09-27.
- **[AGENTS.md](../../AGENTS.md) is canonical for this repo;** [CLAUDE.md](../../CLAUDE.md) only points to it.

> [!TIP] Precedence
> AGENTS.md may be stricter than the principles where it names a reason. When a rule blocks correct work, stop and ask; never violate it silently.

### How the principles apply here {#repo-rules}

- **§1:** no deploy path. The gate is `npm run check` (lint → format check → typecheck → secret scan → unit → integration → build → demo selection → agents → eval → routing); nothing is done until it is green.
- **§2:** origin is a private server; commit and push freely.
- **§3:** the agent suite (`npm run test:agents`) and the eval (`npm run eval`) run real agents, both in the gate. `npm run eval:routing` measures the model's routing choices; its gate step, `npm run eval:routing:gate`, is the last step of the gate (since 2026-09-29).
- **§7:** a paid model API, a hosted service, a second model backend or a second container runtime each needs a written justification first.
- **§11:** every failure goes through [`src/daemon/log.ts`](../../src/daemon/log.ts) (`JsonLinesLogger`).
- **§12:** model licences, revisions, digests, and llama.cpp and colima behaviour are recorded with source and date in [Models](../architecture/models.md).
- **§17–§21:** docs are `.md` sources rendered by `npm run docs`, linked from `docs/index.md` or their section index, under the [documentation contract](documentation.md), guarded by `tests/unit/docs.test.ts`; one [adversarial review](workflows.md#review) per change; future work in Plans (`docs/plans/index.md`) via the [planning workflow](workflows.md#planning); shortcuts in the debt register (`docs/plans/debt.md`); done is checked by the [checklists](workflows.md#checklists).
- **§22:** there is no CDK infrastructure here; it applies only if some is added.

### Rules specific to this repo (AGENTS.md §3)

| Area | Rule |
|---|---|
| Pins | Every model is pinned by Hugging Face commit sha plus a sha256 per file. A name or branch is never a pin. |
| Licences | Verified for the exact repo and revision served, and commercially permissive. |
| Formats | GGUF or safetensors only. Pickle formats are never downloaded. |
| Model cache | Only the harness writes it: stage, verify every sha256, rename atomically. A digest mismatch is fatal and never retried. |
| Images | Rebuilt from the tree under test: each is tagged by its `asha.source` digest, so a changed tree is a new tag and a new build. |
| Model access | Agents never reach a model server directly; every call goes through `/agent/v1/model/chat`. |
| Environments | Nothing guesses an endpoint or environment. The one automatic behaviour, the CLI starting a daemon, is announced on stderr. |
| Recipes | A recipe is the whole agent: one image, one model, and its bounds. |
| Determinism | Output the gate asserts exactly decodes deterministically (`chat.temperature: 0`). |
| Placement | Models on the host, agents in colima, because colima's VM has no Metal. |

## Licence {#licence}

> [!DECISION] PolyForm Noncommercial or PolyForm Small Business, at the user's choice — the owner, 2026-10-11
> The owner first set the terms: *"We should plan to publish the ASHA harness (Autonomous Simple Harness for Agents), under a license that allows for non-commercial use unlimited, and commercial use unlimited for any company making less that $10 million USD annually."* Then *"Make sure the company copyrights and rights reservations are in the repo docs."* Asked which licence should carry the terms, the owner asked for research into the licences most used for this, then chose *"PolyForm Noncommercial and Small Business"* (decision record `asha-publishing-licence-2`, option (c)). The option stated its line plainly: commercial use is free for companies under 100 people and US$1 million revenue (2019 dollars, adjusted for inflation), a tenth of the first terms' line. For asha this supersedes the owner's *"Apache 2.0 for everything."* of 2026-09-27. *Corrected 2026-10-16:* this said the web repo stays Apache-2.0; since web `ac3db26` it is under the same two PolyForm licences, at the owner's word (2026-10-16) that nothing in the web repository is Apache-2.0 and that it carries the licence of the company's review-workflow repository.

- **The licences:** anyone may use asha under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) or the [PolyForm Small Business License 1.0.0](https://polyformproject.org/licenses/small-business/1.0.0), at their choice; each text governs what it permits. In short, the first covers noncommercial purposes (personal uses and noncommercial organizations among them), and the second use for the benefit of a company with fewer than 100 people working as employees and independent contractors and less than 1,000,000 USD (2019, adjusted by the US consumer price index) total revenue in the prior tax year, where "your company" counts every organization that controls it, is controlled by it, or shares control with it. A use neither permits — commercial use for a larger company among them — requires a separate licence agreement signed with SimplyAutonomous.AI, LLC. *(Reworded after the review of 2026-10-11, finding 5: this summary first left out the affiliates and stated the line as the licences' whole grant. Amended 2026-10-12, the owner: commercial use by a large business only "under signed license agreement"; this said a separate written licence "is available".)*
- **Attribution and indemnity** *(added 2026-10-12, the owner: "requiring attribution and indemnifying SimplyAutonomous.AI (like Apache 2.0)")*: both licences oblige every redistributor to pass on the licence terms and every `Required Notice:` line. The second such line carries one condition under either licence, after the Apache License 2.0 §9 (*amended 2026-10-12, the owner's answer to record `harness-licence-indemnity`, option (b): it was in the preamble, which nothing obliges a redistributor to pass on*): a redistributor who offers support, a warranty, an indemnity or another liability obligation does so on their own behalf only, and indemnifies, defends and holds SimplyAutonomous.AI, LLC harmless for any liability that brings. Both texts' *No Liability* section disclaims warranty and liability, as the Apache License 2.0 §7–§8 do. Neither licence makes a user indemnify the company for their own use.
- **The file:** [LICENSE](../../LICENSE) holds the line `Required Notice: Copyright © 2026 SimplyAutonomous.AI, LLC (https://simplyautonomous.ai)` and a second `Required Notice:` line with the indemnity condition, both of which the licences oblige every redistributor to pass on; the company's preamble; the carve-outs; and both texts. Each text is verbatim from the PolyForm project's repository at commit `76a278c402bc43b8d2b561da140b0f3e17263015`, fetched 2026-10-11: `PolyForm-Noncommercial-1.0.0.md`, sha256 `c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5`, and `PolyForm-Small-Business-1.0.0.md`, sha256 `03eea824bff13316b767424b3e8f49538b46e52d897aecc87d6344343364aa56`.
- **The notice:** Copyright © 2026 SimplyAutonomous.AI, LLC. All rights not granted by those licences are reserved. Every rendered page's footer carries the notice, and so does the [README](../../README.md).
- **Carve-outs:** the modules under `modules/` stay Apache-2.0, as each `module.json` declares, under the owner's record `module-distribution` (separate packages under permissive licences). Third-party components keep their own licences. *(Amended 2026-10-12: `PRINCIPLES.md` is no longer carved out; it and `principles/` are under the repo's licences, the owner directing that no other project be attributed.)*
- **The holder:** SimplyAutonomous.AI, LLC, a Texas single-member LLC; its legal name was decided on 2026-10-10. Its certificate of formation (Form 205) was submitted on 2026-10-10 and awaits the Secretary of State's review, and the written assignment of the existing code to it is not yet signed (the company's formation records, read 2026-10-11). The notice names the holder as the owner directed, before both are done. The `LICENSE` preamble is an agent's draft, tracked for attorney review in the company's legal records.
- **`package.json`:** `"license": "SEE LICENSE IN LICENSE"`, npm's form for a custom licence (docs.npmjs.com, `package.json`, read 2026-10-12), since the condition makes the terms more than an SPDX expression can say. *(Amended 2026-10-12, record `harness-licence-indemnity`, option (b); it was `(PolyForm-Noncommercial-1.0.0 OR PolyForm-Small-Business-1.0.0)`, the SPDX expression for the choice alone, read 2026-10-11.)* `"private": true` stays, and `"author"` is `SimplyAutonomous.AI, LLC <admin@simplyautonomous.ai>`.
- **The Homebrew formula** declares `license :cannot_represent`, Homebrew's form for a licence no SPDX expression represents (docs.brew.sh, Licence Guidelines, read 2026-10-12). *(Amended 2026-10-12, record `harness-licence-indemnity`, option (b); it was `license any_of: ["PolyForm-Noncommercial-1.0.0", "PolyForm-Small-Business-1.0.0"]`.)*
- **Not open source:** neither licence is approved by the Open Source Initiative (the SPDX list marks both so). asha is source-available. The release plan (`docs/plans/oss-release.md`) carries what publishing it needs, contribution terms among them.
- **Names and marks:** neither licence grants any right to use the names "asha" or "SimplyAutonomous.AI".
- **Models are licensed separately,** per pinned revision, in each `catalogue/<id>.json` (`license.id`, `license.source`, `license.verified`); see [Models](../architecture/models.md).
- **Before:**
  - From 2026-09-27, `LICENSE` was the Apache License 2.0, fetched verbatim from <https://www.apache.org/licenses/LICENSE-2.0.txt> (sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`), and `package.json` declared `Apache-2.0`. From the morning of 2026-10-11 until the owner's choice, `LICENSE` reserved all rights.
  - No copy was published: the two releases, 0.1.0 and 0.1.1, went only to the maintainers' local tap ([Deployments](../deployments/index.md#release)). Those two versions still hold the Apache text — the local tap's formula declares `license "Apache-2.0"`, and their tarballs under `build/release/` hold the Apache `LICENSE` — so they stay Apache-2.0 if they are ever shared.

TODO: licences of third-party dependencies (npm devDependencies, colima, docker, llama.cpp, Homebrew formulas) are not yet reviewed or recorded.

## Terms {#terms}

> [!WARNING] Drafts, not reviewed by counsel
> The owner chose a full product Terms of Service and Privacy Policy (2026-09-27, decisions/queue.json record `asha-terms` at `f538cb7`). They, and the contributor licence agreement, were drafted on 2026-10-18 at the owner's direction and are published as they are, unreviewed: [TERMS.md](../../TERMS.md), [PRIVACY.md](../../PRIVACY.md), [CLA.md](../../CLA.md) (gate G3, waived in part by the owner, `docs/plans/oss-release.md`).

Legal text is drafted, reviewed and tracked in the company's legal records, outside this repo; the published texts at this repo's root are copies of those records, byte for byte.

TODO: the Terms of Service for asha (and the Privacy Policy it relies on) are to be drafted and attorney-reviewed in the company's legal records — item "Terms of Service / customer agreement for the product" (marked required for asha, 2026-09-27) — then linked here once approved.

## In this section {#more}

<div class="cards">
<a class="card" href="workflows.md"><h3>Workflows</h3><p>How a change is planned, built, reviewed and called done, with the checklists.</p></a>
<a class="card" href="documentation.md"><h3>Documentation contract</h3><p>How these pages are written, rendered and guarded, with a template.</p></a>
<a class="card" href="history.md"><h3>History</h3><p>How asha was built, guard proofs and corrections, newest first.</p></a>
</div>
