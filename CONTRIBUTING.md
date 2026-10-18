# Contributing to asha

Thank you for wanting to improve asha. This page says how to build and test it, what a change must carry, and on
what terms a contribution from outside SimplyAutonomous.AI, LLC can be merged.

## Build

On a Mac with Apple silicon, Homebrew and Node.js `^22.13.0 || ^24.0.0 || >=26.0.0`:

```sh
npm install && npm run build
```

`./asha` runs what was built and never runs npm itself; build again after changing the source.

## Test

- **What the tests need:** gitleaks 8.30.1 or later below 9 (`brew install gitleaks`), for the secret scan and its
  tests, and Playwright's pinned browsers (`npx playwright-core install --no-remove chromium-headless-shell firefox`),
  for the portal's tests.
- **What continuous integration runs** on every push and pull request, on macOS: the typecheck, `npm test` (the unit
  tests), `npm run test:integration` and `npm run scan:secrets`. They need no GPU and no model.
- **What only a Mac with its GPU runs:** the whole gate, `npm run check`, which also runs the linter and the format
  check, builds, and runs the agent suite, the eval and the routing check — real agents in colima on the real models,
  about 45 minutes on an Apple M4 Pro, after their models are downloaded. A change is done only when it is green.

## What a change carries

- **Tests** that assert exact values, and fail without the change; see [Testing](./docs/testing/index.md).
- **Docs** made true in the same change. The docs are Markdown under `docs/`, rendered to the `.html` beside each by
  `npm run docs`; edit the `.md`, never the `.html`, and commit both.
- **A green gate** (`npm run check`), and the linter and the formatter clean (`npm run lint`, `npm run format`).
- **No key, credential or personal data, ever:** no API key, token or password, no path of your machine, no name or
  address of a person who has not agreed to it. The secret scan and the shipped-file guard fail on what they can see;
  you are the check on the rest.

The rules this repository is built by — for people and for the agents that help build it — are in
[AGENTS.md](./AGENTS.md) and [PRINCIPLES.md](./PRINCIPLES.md).

## The contributor licence agreement

Code, tests and documentation from outside SimplyAutonomous.AI, LLC are merged only after their author has signed the contributor licence agreement, which grants SimplyAutonomous.AI, LLC the right to license the contribution, commercially included.

The agreement is [CLA.md](./CLA.md).

How to sign: comment on your pull request, from the account that opened it, with the sentence in its section 9. To
sign for an organization, someone who may sign for it emails admin@simplyautonomous.ai as that section says.

Where signatures are kept: in SimplyAutonomous.AI, LLC's own records, never in this repository; what each record
holds, and why, is in the [Privacy Policy](./PRIVACY.md).

## Maintainers' tools

`npm run decisions` opens the maintainers' decision queue, which is internal and not part of this repository; in a
clone it fails, naming the missing file. The plans the docs cite as `docs/plans/<plan>.md` are internal too.
