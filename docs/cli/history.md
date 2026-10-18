---
title: CLI History
description: Dated corrections to the asha CLI pages, newest first.
---

# CLI history

Claims the [CLI guide](guide.md) and [reference](index.md) once made that turned out wrong, kept with what is true instead.

> [!SUMMARY]
> - `--status`, `--stop`, `--help`, the `--server` banner and `--watch` lines all print to stdout, not only replies and handles.
> - The guide's `--status` transcripts predate the build fingerprint; today's output is in the [reference](index.md#status).

## 2026-09-27: more than replies go to stdout {#stdout}

**Correction.** The guide said that only a reply and a launched handle ever go to standard output. That is true of a message and of `--launch`, but not of the other commands: `--status`, `--stop`, `--help`, the `--server` banner, and each message line of `--watch` also print to standard output (see `status`, `stop`, `watch` and `server` in [src/cli/commands.ts](../../src/cli/commands.ts)). The guide's transcripts colour those lines as progress; the text itself is unchanged. The [reference](index.md#streams) lists the stream of every line.

## 2026-09-27: `--status` now reports the build {#status-build}

**Correction.** The guide's `--status` transcripts were captured before the daemon reported its build. Today the first line also carries `build <fingerprint>, started <ISO time>`, and when the running daemon was built from different code than your `./asha`, a `⚠` warning comes first on stderr. A real run from 2026-09-27 is in the [reference](index.md#status).
