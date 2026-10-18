# AGENTS.md — `harness`

Canonical rules for this repo, kept to what every session needs; the detail is
in [`rules/`](rules/README.md), [`principles/`](principles/) and
[`sdlc/`](sdlc/README.md), opened when a task reaches it. `CLAUDE.md` is a
pointer to this file.

**Before any task, read [PRINCIPLES.md](./PRINCIPLES.md)** — a one-line index;
open a principle's file in `principles/` when a task reaches it. These apply to
every task:

- **Verify every assumption** before acting on it or reporting it as fact: run
  the command, read the file, log or primary source
  ([§5](principles/05-evidence.md), [§12](principles/12-external-facts-decay.md)).
- **Run the thing you claim:** a claim about a command, a case or a class is
  checked by running exactly that; a green summary is not evidence
  ([§14](principles/14-run-the-thing.md)).
- **Fix the root cause:** never skip, suppress or route around a failing check
  ([§8](principles/08-fix-it.md)).
- **Fail loudly:** no fallbacks for impossible cases, no swallowed errors, and
  every wait and remote call bounded ([§9](principles/09-consistent-behavior.md),
  [§11](principles/11-surface-every-error.md)).
- **Tests and docs are part of the change** ([§3](principles/03-test-coverage.md),
  [§15](principles/15-documentation-is-part-of-the-change.md)).
- **Decide and keep going;** ask the owner only through the decision queue, one
  decision at a time ([§4](principles/04-bias-for-action.md)).
- **Done means reviewed:** every change gets its agentic review — for code, the
  `sdlc/` loops of §5 below ([§18](principles/18-adversarial-review.md)).

## 1 · What this repo is

**asha** (Autonomous Simple Harness for Agents), the SimplyAutonomous.AI agent
harness. `./asha` posts messages to named agent channels, watches them, and runs
the daemon, which starts colima, runs agent images in it, carries the channel
between agents and the user, and brokers every model call to open-weight models
served on the host by llama.cpp. Everything runs locally. Build once with
`npm install && npm run build`; `./asha` never runs npm. Docs:
[docs/index.html](./docs/index.html). Install, status, portal and objectives in
full: [rules/project.md](rules/project.md).

**Objectives (the owner, 2026-09-27):** (1) local first; (2) every significant
multi-agent pattern, demonstrated; (3) extensible by drop-in modules; (4)
enterprise grade. New work toward them is a plan in `docs/plans/` before it is
built (PRINCIPLES §19).

## 2 · Scope of the principles

- **§1** — no deploy path; commit and push freely. **The gate is
  `npm run check`**, and work is not done until it is green; its steps and suites:
  [rules/gate-and-tests.md](rules/gate-and-tests.md).
- **§2** — origin is a private server, only sometimes reachable (`git remote get-url origin`).
- **§7** — recurring cost is **$0**: models run locally. A paid model API or a
  hosted service needs a written estimate and the owner's approval first; a
  second model backend or container runtime needs a written justification first
  ([rules/models.md](rules/models.md)).
- **§11** — every daemon failure goes through `src/daemon/log.ts`.
- **§12** — model licences, revisions and digests, and llama.cpp and colima
  behaviour, are recorded with source and date in docs/architecture/models.html.
- **§22** — there is no CDK infrastructure here.

## 3 · Rules specific to this repo

One line each; the full text and history are in the linked file.

- **Models** are pinned by Hugging Face commit sha and a sha256 per file (a
  hosted model by its exact vendor id), under a commercially permissive licence
  verified for that exact revision; GGUF or safetensors only; and only the
  harness writes the cache, verified and promoted atomically —
  [rules/models.md](rules/models.md).
- **Model serving runs on the host** (llama.cpp, Metal on Apple Silicon);
  **agents run in colima** — [rules/models.md](rules/models.md).
- **Agent images** are rebuilt from the tree under test and tagged by its
  digest; anything that runs one names the exact tag —
  [rules/containers.md](rules/containers.md).
- **Agents never reach a model server directly:** every call goes through the
  harness, authenticated by the run's token —
  [rules/containers.md](rules/containers.md).
- **Nothing guesses an endpoint or an environment;** the CLI's daemon auto-start,
  announced only with `--verbose`, is the owner's one deliberate exception —
  [rules/containers.md](rules/containers.md).
- **A recipe is the whole agent:** one image, one model and its bounds; the
  command line never names an image.
- **Lint and format:** `npm run lint` (ESLint: type-checked typescript-eslint
  and SonarJS, every rule on), `npm run lint:unused` (knip: a file, export or
  dependency nothing uses) and `npm run format:check` (Prettier), the gate's
  first three links. An exemption is the owner's decision, made in
  `eslint.config.mjs` or `knip.jsonc`, never an `eslint-disable` comment —
  [docs/quality/index.html](./docs/quality/index.html#lint).
- **Deterministic where the gate asserts:** never loosen an assertion; no gate
  suite uses a hosted model or the network —
  [rules/gate-and-tests.md](rules/gate-and-tests.md).
- **Every hand-run `docker` command names colima** (`docker --context colima …`)
  and never changes the current context; touch only what you created and
  labelled, and never stop colima — [rules/containers.md](rules/containers.md).
- **One agent at a time changes files, on `main`, in this checkout** — no agent
  branches. Never copy whole files over the checkout; re-read a shared file
  before writing it, and merge — [rules/working-on-main.md](rules/working-on-main.md).
- **One full gate at a time on this Mac,** enforced by
  `/tmp/asha-agent-suite.lock`: when refused, wait; never delete a live holder's
  lock or registration. Not enforced: never run `npm run build`, `npm run docs`
  or a probe beside an agent suite (debt D29). A gate run from a worktree
  follows [rules/gate-and-tests.md](rules/gate-and-tests.md).

## 4 · Documentation, review, plans and debt (PRINCIPLES §17–§21)

- **Docs:** edit `docs/**/*.md`, then `npm run docs`; never edit a rendered
  `.html`. Sections, contract, guard and generated pages:
  [rules/docs.md](rules/docs.md).
- **The renderer and stylesheet are pinned:** `tools/docs/render.mts` sha256 `005b482f95374892eb2f2c3f9d8334e19358726b3ab793938590beacc9863f81` and `docs/assets/docs.css` sha256 `56554a66f3941b54fed23256035357a048b7ca2e9d708eafa5e5afb7d9c2a522`,
  checked by the docs guard; a change to either updates its hash here in the
  same change.
- **Review (§18):** §5 below for code; for any other change, the one-round
  prompt and the checklists in
  [docs/project/workflows.html](./docs/project/workflows.html#review).
- **Plans (§19):** `docs/plans/index.md`, from
  `docs/plans/template.md`.
- **Debt (§20):** `docs/plans/debt.md`.
- **Owner decisions (§4):** records in `decisions/queue.json`, never a list in
  chat, answered in the browser with `npm run decisions`; rules in
  [docs/project/workflows.md](./docs/project/workflows.md#decisions).
- **Assurance (§21):** amend the checklists in docs/project/workflows.html when
  an escaped defect shows one is missing an item.

---

## 5 · Adversarial review of code changes — the `sdlc/` workflows

*(The owner, 2026-10-11; amended 2026-10-12: the workflows live in this repo,
and reviews are agentic workflows, not human reviews.)* A change that touches
code — anything under `src/`, `images/`, `harness-images/`, `modules/`,
`portal/`, `decider/`, `tools/`, `tests/` or `evals/`, the `asha`
launcher, or the build and test config (`package.json`, `tsconfig*.json`,
`vitest*.mts`) — is done only when its review loop has converged as well as the
gate. A change to docs, plans, decisions, guidance or data (`catalogue/`,
`recipes/`, `teams/`) alone gets the one-round review of PRINCIPLES §18
instead, and **opens none of the workflow files**: they load only when code
changes.

- **Code review**, for every code change:
  > Follow `sdlc/code-review/code-review-update.md` with target `.` and scope `<changed paths>`
- **Unit-test review**, when the change touches `tests/unit/`:
  > Follow `sdlc/unit-tests/unit-tests-update.md` with target `.` and scope `<changed test files>`
- **Isolation is of context, not of checkout:** each reviewer is a fresh agent
  given only its inputs; the updater fixes and commits on `main`, in this
  checkout, as the one writer (§3).
- **Converged** means a fresh review whose verdict is PASS — every package check
  and every cell; INCOMPLETE is not converged. `npm run check` does not run the
  review, so a green gate alone is not done.
- For a read-only verdict, with no fixes: `code-review-review.md` or
  `unit-tests-review.md` in the same folders, with the same inputs.
- **The reviews' coverage bar** (95 % of lines, 75 % of branches) holds product
  code as `npm run test:coverage` measures it: `src/` and `images/`. Tools and
  test helpers keep their decisions in plain functions with exact tests (the
  owner, 2026-10-17, record `review-coverage-scope`).
