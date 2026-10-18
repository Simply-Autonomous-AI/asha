---
title: Quality History
description: Dated guard proofs, measurements and corrections behind the asha quality controls, newest first.
---

# Quality history

The dated evidence behind [Quality controls](index.md). That page says what is true now; this one keeps the proofs, measurements and corrections (PRINCIPLES §12).

> [!SUMMARY]
> - Every compiler setting the guard covers was broken on 2026-09-27 and failed naming its canary.
> - Three claims about TypeScript 7 were corrected on 2026-09-27; one was withdrawn.
> - Hello-world replies were byte-identical 25 of 25 times on 2026-09-26.

## 2026-09-27: compiler-settings guard proof {#tsconfig-proof}

[tsconfig.test.ts](../../tests/unit/tsconfig.test.ts) was proven by one change to `tsconfig.json` at a time (restored afterwards, md5 unchanged), or `@types/node` 22.20.4 installed without saving (restored with `npm ci`). Each break failed naming exactly these canaries:

| How it was broken | The canaries named |
|---|---|
| `noImplicitAny: false` | `implicit-any.ts` |
| `strictNullChecks: false` | `null-check.ts`, `unchecked-index.ts` |
| `strict: false` | `implicit-any.ts`, `null-check.ts`, `unchecked-index.ts` |
| `noUnusedLocals: false` | `unused-local.ts` |
| `noUnusedParameters: false` | `unused-param.ts` |
| `noImplicitReturns: false` | `implicit-return.ts` |
| `noFallthroughCasesInSwitch: false` | `fallthrough.ts` |
| `noUncheckedIndexedAccess: false` | `unchecked-index.ts` |
| `noImplicitOverride: false` | `implicit-override.ts` |
| `allowUnreachableCode` removed | `unreachable.ts` |
| `allowUnusedLabels` removed | `unused-label.ts` |
| `verbatimModuleSyntax: false` | `type-import.ts` |
| `lib` plus `ES2025.Regexp` | `regexp-escape.ts` |
| `lib: ["ESNext"]` | `float16.ts`, `promise-try.ts`, `regexp-escape.ts` |
| `@types/node` 22.20.4 installed | `node-api.ts` |

## 2026-09-27: correction, TypeScript 7 {#ts7-correction}

The first version of the TypeScript 6.0.3 section said the `typescript@7.0.2` package "exports only its version", which is true of its main entry only. It also said StrykerJS "crashed on 7.0 in a scratch run", a run recorded nowhere in this repo (StrykerJS's TypeScript checker declares `typescript >=3.6`), so that claim is withdrawn. It also gave, as the reason `exactOptionalPropertyTypes` is off, errors measured in the `web` repo, not here. The review of the change found all three.

## 2026-09-26: determinism measured {#determinism}

25 of 25 hello-world replies were byte-identical, 5 of them across daemon restarts (the former `docs/architecture.md`, evidence section, at `719dad4`).

## 2026-09-26: guards proven in the former architecture doc {#architecture-proofs}

The former `docs/architecture.md` (replaced by this site in `5adbdba`; read it with `git show 719dad4:docs/architecture.md`) records these guards as broken on purpose and seen to go red:

- the channel's ack bookkeeping
- the CLI's "no reply" failure
- the server's connect-before-headers order
- the model store's sha256 check
- the gateway's `stream:false`
- the model server's `--port 0`
- the image's staged SDK
