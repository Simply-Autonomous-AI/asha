---
title: Deployments History
description: Dated decisions and evaluations behind the asha deployment choices, newest first.
---

# Deployments history

What was evaluated and decided on the way to today's [deployments](index.md). The durable page says what is true now; this page keeps how it got there.

> [!SUMMARY]
> - macOS only for now; Linux, Windows and the PC path wait (2026-09-27).
> - vLLM was set aside for llama.cpp (2026-09-26).

## 2026-09-27: macOS only for now {#macos-only}

The owner: "Mac OSX only for now - linux and windows later" (decisions/queue.json at `f538cb7`, record `pc-platform`). The same day the owner chose Docker Engine for the PC path when it resumes (record `docker-runtime`) and an optional launchd job for boot-time start-up (record `run-before-login`).

## 2026-09-26: vLLM set aside {#vllm}

vLLM was evaluated and set aside by the owner, because llama.cpp covers Metal and CUDA with one fewer moving part.
