---
title: The bedrock module
description: The reference ModelProvider — Mistral's Ministral 3 8B on Amazon Bedrock through its Chat Completions API — its manifest, the provider path, cost, approval, the credential and vendor-side limit, lifecycle risks, terms, and its threat model.
---

# The `bedrock` module

`bedrock` serves a hosted chat model to a recipe that names it: `model: "bedrock/ministral"` is Mistral AI's Ministral 3 8B on Amazon Bedrock (AWS's hosted-model service), in the company's AWS account, region `us-east-1`, the same model family as the local second chat model, so a local and a hosted run compare like for like. It is the reference [ModelProvider](modules.md#kinds).

<div class="facts"><span>verified 2026-10-02</span><span><span class="badge built">built</span> 2026-10-02; never run against Bedrock (no credential exists yet)</span><span>code: <a href="../../modules/bedrock/index.mjs"><code>modules/bedrock/index.mjs</code></a>, <a href="../../modules/bedrock/module.json"><code>module.json</code></a></span><span>tests: <a href="../../tests/unit/reference-module-calls.test.ts"><code>reference-module-calls.test.ts</code></a> against <a href="../../tests/fixtures/modules/">streams built from AWS's docs</a> (D49)</span></div>

> [!SUMMARY]
> - The agent's code does not change: its chat and embed calls go through the same routes, and the daemon sends them to this module's container instead of llama.cpp.
> - It streams through Bedrock's OpenAI-compatible Chat Completions API with a bearer key, sends a required tool call as `tool_choice: "required"`, and returns the vendor's token usage.
> - Pinned to `mistral.ministral-3-8b-instruct`; metered at $0.15 per million input and output tokens; approved up to $25 a month.
> - A recipe naming it is cloud-granted: every prompt leaves the machine, so no image that keeps memory may use it.

## The provider path {#path}

The gateway's provider path ([`providerChat`](../../src/daemon/modules/provider.ts)) reserves the call's worst case on the meter — the UTF-8 bytes of the messages and tools as input tokens, and `maxTokens` as output — then sends the module `{model, messages, maxTokens, tools?, requireToolCall?, settings}`: never llama.cpp's tool-call prefill, `return_progress` or prompt-store request, and no `model` or `model_server` launch phase. The module ([`chat`](../../modules/bedrock/index.mjs)) posts to `https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions` with `Authorization: Bearer <key>`, `stream: true`, `stream_options: {include_usage: true}`, the recipe's `temperature` and `top_p` (the only settings it translates), and `tool_choice: "required"` when the agent's turn requires a tool call. Each streamed piece is a `model_delta` event; the last chunk's usage settles the meter. Facts read 2026-10-01 from AWS's [Chat Completions guide](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html) and [API keys page](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).

`lifecycle` reads `GetFoundationModel`'s `modelDetails.modelLifecycle.status` from `https://bedrock.us-east-1.amazonaws.com/foundation-models/<id>` ([API reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModel.html), read 2026-10-02); the opt-in live check refuses before any chat call unless it is `ACTIVE`. AWS's own data-retention examples call that control plane with the same bearer key (`PUT /data-retention`, [data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html), read 2026-10-02); TODO: that `GetFoundationModel` accepts it is not yet shown — the first live run records it.

**Not yet shown on the model** (R19's probe, recorded by the first live run): that Ministral 3 8B honours `tool_choice: "required"` and reports usage in its stream. Until then the plan's R19 premise stands unproven on the vendor.

## Its manifest {#manifest}

| Field | Value |
|---|---|
| `id`, `kind`, `version` | `bedrock`, `ModelProvider`, `1.0.0` |
| `hosts` | `bedrock-runtime.us-east-1.amazonaws.com`, `bedrock.us-east-1.amazonaws.com` (the lifecycle read) |
| `secrets` | `AWS_BEARER_TOKEN_BEDROCK` |
| `models` | `ministral`: `mistral.ministral-3-8b-instruct`, launched 2025-12-02, $0.15 / $0.15 per million tokens ([pricing](https://aws.amazon.com/bedrock/pricing/), read 2026-09-27), its card, terms and retention policy each by URL and date |
| `cost` | `metered`, approved up to $25 a month |
| `licence` | `Apache-2.0`; no dependency |

## Cost and approval {#cost}

**Approved:** by the owner, 2026-09-27, cap $25 a month.

The estimate the owner approved (record `live-vendor-cost-estimate`): 2,000 calls a month × (3,000 input + 500 output tokens) = 6 M input × $0.15 + 1 M output × $0.15 per million = $1.05 a month. The docs guard fails once the price was read more than 90 days before the day it runs: re-read the pricing page and update `prices.read`.

**The credential** (the planning agent's decision of 2026-09-27): a long-term Amazon Bedrock API key — a bearer token — expiring in at most 90 days, on an IAM user of its own whose policy allows only invoking the pinned model and reading its lifecycle, never the web site's deploy credential. AWS writes that "Long-term keys are for exploration only"; this module is a reference within a $25 cap, which is exploration, and the owner rotates the key before it expires. Creating it changes the AWS account, so it is done only with the owner's consent at that time, in one step that also creates the AWS Budget below and records the owner's acceptance of the model's third-party terms ([aws.amazon.com/legal/bedrock/third-party-models](https://aws.amazon.com/legal/bedrock/third-party-models/)). TODO: not done yet; record the key's IAM user, the budget, the terms' acceptance and each date here when it is.

**The vendor-side limit:** an AWS Budget over the account's Bedrock spend whose action attaches a deny-all policy to the module's IAM user at $25 (*corrected 2026-10-11: this said the budget was scoped to the module's IAM user; AWS's post on cost by IAM user (April 2026) says such tags "only appear for activation after the IAM principal with the tags has made at least one API call" and documents Cost Explorer, not Budgets, as the filter, as read 2026-10-02*). AWS Budgets information "is updated up to three times a day", typically 8–12 hours apart ([Managing your costs with AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html), read 2026-10-02), so the action can act hours after the cap is passed: asha's meter is the prompt bound, the budget the backstop. The budget's email alert goes to `admin@SimplyAutonomous.AI` (the owner, 2026-10-12, record `live-run-values`); the budget is created with the owner's consent at the first live run, not yet.

**Data retention:** Bedrock's per-Region retention setting applies; under `default`, AWS may retain data for abuse detection and the model provider does not receive it; under `none`, Chat Completions requests are never retained ([data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html), read 2026-10-02; the manifest's `retention.read` said 2026-10-01 until the same day, when the page was read again and the manifest's date brought to it).

## Lifecycle risks {#risks}

Read 2026-09-27 from the model's card and Bedrock's lifecycle pages (`docs/plans/extension-modules.md` question 7): the model is `Active`, with an end-of-life date no sooner than 2026-12-02 — about 9 weeks from then; once Legacy, "existing customers may lose access to Legacy models after 15 days of inactivity"; and for models with end-of-life dates after February 1, 2026, after at least 3 months in Legacy the model enters public extended access, where "you should expect higher pricing, which will be set by the model provider". The live check's lifecycle read refuses a model that is not `ACTIVE`.

## Threat model {#threats}

| Concern | What holds it |
|---|---|
| The key leaks | It is only in its module's container environment; lines the module prints are redacted; fixtures carry placeholders. Its IAM policy allows only this model, so a leak costs at most spend on one model, bounded by the AWS Budget |
| The module reaches elsewhere | Only its two hosts on 443, by the egress proxy |
| Prompt injection through output | The model's reply is the agent's own turn, as a local model's is; tool results it is fed stay tool results |
| Memory leaving the machine | A recipe naming it is cloud-granted: refused for an image that keeps memory, and never beside a memory agent on a channel |
| An agent spending | Every chat is reserved against the meter's caps before it is sent |
