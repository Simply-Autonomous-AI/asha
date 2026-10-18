---
title: The tavily module
description: The reference ToolModule — web search through Tavily's Search API at its basic depth — its manifest, data flows, cost, approval and vendor-side limit, its key, and its threat model.
---

# The `tavily` module

`tavily` gives an agent one tool, `tavily__search`: a web search through Tavily's Search API (a paid web-search service), at its basic search depth, returning each result's title, URL and an extract of its content. It is the reference [ToolModule](modules.md#kinds), and the example the [walkthrough](extending.md#module) builds from.

<div class="facts"><span>verified 2026-10-02</span><span><span class="badge built">built</span> 2026-10-02; never run against Tavily (no live call made)</span><span>code: <a href="../../modules/tavily/index.mjs"><code>modules/tavily/index.mjs</code></a>, <a href="../../modules/tavily/module.json"><code>module.json</code></a></span><span>tests: <a href="../../tests/unit/reference-module-calls.test.ts"><code>reference-module-calls.test.ts</code></a> against <a href="../../tests/fixtures/modules/tavily-search.json">a fake built from Tavily's docs</a> (D49)</span></div>

> [!SUMMARY]
> - One tool, `search {query, max_results?}`, classed `untrusted-input` and `egress`; 5 results unless the model asks for another number.
> - It reaches one host, `api.tavily.com`, with one secret, `TAVILY_API_KEY`, through the egress proxy.
> - Metered at 1 credit a search, $0.008 a credit; approved by the owner up to $25 a month; off until `asha --enable-module`.
> - Plain JavaScript with no dependency: Node's `fetch` only.

## What it sends and returns {#data}

`call('search', {query, max_results}, context)` sends one `POST https://api.tavily.com/search` with `Authorization: Bearer <key>` and the body `{query, search_depth: "basic", max_results, include_usage: true}`, bounded at 25 s (inside the tool's 30 s). It returns `{query, results: [{title, url, content}]}` — never Tavily's `raw_content` (a whole page) — and Tavily's reported `usage.credits` as `{units}`, which settles the meter. A non-2xx answer is `module_unavailable` naming only the status; a body that is not JSON, `module_unavailable`; its own bound, `timeout`. Facts read 2026-10-01 from [Tavily's search reference](https://docs.tavily.com/documentation/api-reference/endpoint/search): the endpoint, the bearer header, `search_depth` (default `basic`), `max_results` (default 10), `include_usage` (default false; when true the answer carries `usage` with the request's credits).

**What leaves the machine:** the query the model writes, which may hold anything in the agent's context — the user's words, a file's text ([the stated limit](modules.md#approvals)) — and the key. Tavily's answer is untrusted text: it reaches the model only inside a tool result, which the tool's description tells the model to treat as data.

## Its manifest {#manifest}

| Field | Value |
|---|---|
| `id`, `kind`, `version` | `tavily`, `ToolModule`, `1.0.0` |
| `hosts` | `api.tavily.com` |
| `secrets` | `TAVILY_API_KEY` |
| `cost` | `metered`, 1 credit a call at $0.008 a credit ([docs.tavily.com/documentation/api-credits](https://docs.tavily.com/documentation/api-credits), read 2026-09-27), approved up to $25 a month |
| `licence` | `Apache-2.0`; no dependency (`package-lock.json` lists no package) |
| `tools` | `search`: classes `untrusted-input`, `egress`; `timeoutMs` 30,000 |

## Cost and approval {#cost}

**Approved:** by the owner, 2026-09-27, cap $25 a month.

The estimate the owner approved (record `live-vendor-cost-estimate`, 2026-09-27, the plan's R18a (`docs/plans/extension-modules.md`)): 500 basic searches a month × 1 credit × $0.008 a credit, after the account's 1,000 free monthly credits ("You get 1,000 free API Credits every month", and a basic search "costs 1 API credit": [API credits](https://docs.tavily.com/documentation/api-credits), read 2026-10-02) = at most $4.00 a month. The owner's $50 cap over both reference modules is split $25 here and $25 to [bedrock](modules-bedrock.md).

**The key** is one the owner already holds, reused (the owner, records `tavily-key-reuse` and `tavily-key-choice`, 2026-09-27): no new key is made, and the owner enters it with `asha --set-secret module=tavily name=TAVILY_API_KEY` when live use starts. It is never committed, logged, or put in a recipe or an agent container. A file that holds it in plain text is refused to any command plugin by the content scan, should it lie inside an allowed root.

**The vendor-side limit:** none is set at Tavily (the owner's answer to record `live-run-values`, option (b), 2026-10-12, before live use started): asha's meter alone holds asha to its $25 a month on Tavily, and nothing caps the key's total spend, since the meter counts only asha's searches on it. *(Until 2026-10-12 this said one Tavily-side monthly limit on the shared key, covering both projects, at an amount the owner would choose and set when live use started — the owner's answer O3, record `tavily-limit-with-shared-key`, 2026-09-28.)*

## Threat model {#threats}

| Concern | What holds it |
|---|---|
| The key leaks | It is only in its module's container environment; every line the module prints is redacted; the fake and every fixture carry a placeholder, never a `tvly-` prefix (a test scans the module's files) |
| The module reaches elsewhere | Only `api.tavily.com:443`, by the egress proxy, its server name checked; its network is internal |
| Prompt injection in results | Results arrive only as a tool result; an instruction in them is text for the model to read, not a message from the user (the gate's fake carries one) |
| A consequential action | It has none: a search changes nothing |
| An agent misusing it | Each search costs a credit: the meter's per-conversation, day and month caps refuse past them before Tavily is called |
| Data the user did not mean to send | The `untrusted-input` class makes any command plugin's local-file upload in the same recipe need approval (R15); the model can still copy file text into a query, the stated limit |
