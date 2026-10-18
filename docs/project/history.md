---
title: Project History
description: Dated records behind the asha project pages, newest first — guard proofs, corrections, and how asha was built.
---

# Project history

How the [project pages](index.md) got to what they say today. The durable pages say what is true now; this page keeps the dated evidence and corrections (PRINCIPLES §12).

> [!SUMMARY]
> - Every docs-guard check was broken on purpose and seen to fail on 2026-09-27; the breakage and the message for each are below.
> - The HTML site replaced the Markdown docs in `5adbdba`, then became a render of Markdown sources (2026-09-27).
> - asha was built in one day, 2026-09-26: 59 commits, AI-assisted.

## 2026-09-27: docs-guard proofs {#guard-proofs}

Each check in [the guard](documentation.md#guard) was broken on a scratch copy of the tree (never the working tree); the guard went red naming the offender, and the copy went green again once restored.

| Check | Breakage | Failure named |
|---|---|---|
| one summary | the summary callout of `portal/index.html` turned into a note | `portal/index.html: 0 summaries in the header` |
| stylesheet hash | one byte appended to `docs/assets/docs.css` | the stylesheet test, "docs/assets/docs.css changed: re-copy it to the sibling repo and update the sha256 in both AGENTS.md" |
| stale render | a comment appended by hand to `cli/index.html` | `cli/index.html: differs from the render of its .md — run npm run docs, never edit the .html` |
| no source | a copy of a page as `cli/zz-orphan.html` | `cli/zz-orphan.html` (and, by the index check, `not linked from index.html or cli/index.html`) |
| link to a source | `href="guide.html"` changed to `guide.md` in a render | `cli/index.html: guide.md` |
| unique ids | a second element with `id="build-run"` | `cli/index.html: id="build-run"` |
| unused diagram | `zz-unused.svg` referenced by no source | `zz-unused.svg` |
| root fragment | AGENTS.md linking `workflows.html#zz-nope` | `AGENTS.md: ./docs/project/workflows.html#zz-nope (no id="zz-nope")` |
| plan status | portal's index row changed to `ready` | `plans/portal.md: status "draft" but its index row says otherwise` |
| checked off | portal's row marked ☑ while `draft` | `plans/portal.md: status "draft" but its index row is checked off` |
| renderer hash | one line appended to `render.mts` | the hash test, "tools/docs/render.mts changed: re-copy it to the sibling repo and update the sha256 in both AGENTS.md" |
| render error | `titel:` in the front matter of `cli/index.md` | `DocsRenderError: cli/index.md: unknown front matter key "titel" (allowed: title, description)` |
| Node range | `engines.node` set to `>=22.12` | the engines test, `expected '>=22.12' to be '^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0'` |
| ignored target | a link to `../../dist/src/cli/main.js` (ignored by git) added to a render of `cli/index.html` (2026-09-27, control-api-auth; the check was added after a clean checkout failed on links to the ignored `tools/release/evidence/v0.1.1.log`) | `cli/index.html: ../../dist/src/cli/main.js (ignored by git)` |
| Node floor | the installed Vitest's `engines` and `package.json` both rewritten to `^22.0.0 \|\| >=24`, then Vitest's to `>=22.12` (restored byte-identical) | `expected '22.0' to be '22.12'` (the floor must equal the `@types/node` major.minor), then `Vitest's engines does not start with a ^major.minor.patch floor` |
| hidden characters (2026-10-01) | none needed: the guard was written against `plans/extension-modules.md` at `ca06d90`, which held two raw U+202E and one raw U+200B, then the characters were replaced by their escapes | `plans/extension-modules.md:520 U+202E`, `plans/extension-modules.md:1035 U+202E`, `plans/extension-modules.md:1035 U+200B` |

The renderer's unit tests (`tests/unit/docs-render.test.ts`) were proven by mutating `render.mts`; each mutation turned the named test red.

| Mutation | Test that failed |
|---|---|
| `.md` links outside docs/ rewritten | rewrites .md links under docs/…; rewriteHref: a link resolving outside docs/ is unchanged |
| TOC threshold 4 → 5 | adds a table of contents at four sections |
| duplicate-id check removed | fails on a duplicate id, naming it |
| SVG `<title>` check removed | fails on an svg without `<title>` |
| raster-image check removed | fails on a local raster image |
| wrap any `TODO:`, not only a literal one | renders a TODO&#58; mention as text, not as a gap |
| depth limit removed | refuses deep nesting |
| no `lede` class | renders the exact head, breadcrumbs, lede, sections and footer |
| captions not walked | rewrites .md links inside a diagram caption |
| text escaped twice | keeps entities the author wrote, and escapes bare characters once |

## 2026-09-27: HTML-era guard proofs {#html-guard-proofs}

Made against the hand-written HTML pages, before the Markdown sources, with scratch files that were then removed. The first six rows ran against the guard's first version; the rest against a copy of `docs/` and the root Markdown. The "no Markdown" check was later replaced by the no-source check.

| Check | Breakage | Failure named |
|---|---|---|
| links | a link to `zz-nope.html` and to `agent-tests.html#zz-no-such-id` | `testing/index.html: zz-nope.html (no such file)`; `…#zz-no-such-id (no id="zz-no-such-id" in testing/agent-tests.html)` |
| stylesheet | `href="assets/docs.css"` (wrong relative path) | `testing/zz-bad.html` |
| network | loads from `https://`, `//`, `http://`, `@import url()` and CSS `url()` | six entries, each naming the tag or URL |
| head | no doctype, title or viewport | three entries naming the file |
| no Markdown | `zz-notes.md` | `testing/zz-notes.md` |
| linked directly: top level | a valid `docs/zz-orphan.html` linked from nowhere | `zz-orphan.html: not linked from index.html` |
| linked directly: section | `cli/zz-deep.html` linked only from another cli page | `cli/zz-deep.html: not linked from index.html or cli/index.html` |
| network: SVG | `<image href="https://e.com/1.png">` | `zz-net.html: <image href="https://e.com/1.png">` |
| network: srcset | `srcset="a.png 1x, https://e.com/2.png 2x"` | `zz-net.html: <img srcset="a.png 1x, https://e.com/2.png 2x">` |
| network: object | `<object data="https://e.com/zz.svg">` | `zz-net.html: <object data="https://e.com/zz.svg">` |
| root Markdown | `[x](./docs/nope.html#frag)` appended to `README.md` | `README.md: ./docs/nope.html#frag (no such file)` |
| planned badge: not a link | `<span class="badge planned">` | `zz-net.html: <span class="badge planned">` |
| planned badge: outside plans | `<a class="badge planned" href="index.html">` | `zz-net.html: <a class="badge planned" href="index.html">` |

## 2026-09-27: correction, callout colours {#callout-colours}

The contract's class table said `.note` looks like an "Amber bar" and `.tip` a "Teal bar". The stylesheet draws `.note` blue and `.tip` green, each with an icon (`.note`, `.tip` rules in `docs/assets/docs.css`); the descriptions predated the callout restyle in `cc82770`.

## 2026-09-27: push verified {#push}

`GIT_SSH_COMMAND="ssh -o ConnectTimeout=5" git push origin main` was run in this repository after commit `fa414ac`, and in the company's two other repositories, and exited 0 each time.

## 2026-09-27: HTML site, then Markdown sources {#docs-site}

- `5adbdba`: the Markdown docs under `docs/` were replaced by an HTML site (the owner's direction, now PRINCIPLES §17).
- The same day each hand-written page became a Markdown source, and the HTML a render of it by `tools/docs/render.mts` (the owner's decision).

## 2026-09-26: built in one day {#built}

From `git log`, read on 2026-09-27: 59 commits up to `719dad4`, all dated 2026-09-26 from 17:48 to 23:35 (UTC−5), all by the owner. Development used Claude Code: the repo carries a [CLAUDE.md](../../CLAUDE.md) for it, and every commit carries the trailer `Co-Authored-By: Claude Opus 5.5`.

| Milestone | Commit | What it added |
|---|---|---|
| The first slice | `87e5885` | A CLI then named `sah` and a daemon ran hello-world end to end: colima, a pinned Qwen3-0.6B GGUF downloaded and verified, served with `llama-server`, the agent image built and run. The commit records a hand-measured cold run of 12.4 s (the 640 MB download and the image build) and a warm run of 1.27 s, both on Qwen3-0.6B. Tests came later. |
| Renamed to asha | `4145b27` | The agent channel, recipe-driven agents, and the auto-started daemon |
| Tests for every layer | `6ecd2e5` | Tests that found races, then fixed, and a deterministic hello-world |
| Two-agent hello world | `426eecb` | Delegation through `send_message(to)`, `--launch`, and the routing eval |
| Memory tiers | `f0620ca` design through `723dcb5` | The `memory` recipe and a local embedding model |
| Latest recorded result | `719dad4` | Agent suite 35/35 at `5b4e25c` |
