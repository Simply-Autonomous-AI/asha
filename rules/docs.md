# Documentation — how PRINCIPLES §17 applies here

The detail behind [AGENTS.md](../AGENTS.md) §4.

- **Docs (§17).** [docs/index.html](../docs/index.html) is the table of
  contents. Sections: `project/`, `cli/` (the interface), `portal/`,
  `architecture/`, `patterns/` (the pattern demos), `quality/`, `testing/`,
  `deployments/`, `plans/`. **The
  Markdown is the source** (`docs/**/*.md`, diagrams as `.svg` beside it);
  each `.html` beside it is a committed render — edit the `.md`, then run
  `npm run docs` (or `npm run docs -- cli/index.md` for one page); never edit
  a rendered `.html`. One stylesheet, `docs/assets/docs.css`. The Markdown
  contract and a page template:
  [docs/project/documentation.html](../docs/project/documentation.html).
  Gaps: `TODO: …` in the Markdown.
- **The docs guard** is `tests/unit/docs.test.ts` (renderer unit tests:
  `tests/unit/docs-render.test.ts`), in `npm test` and so in the gate: a stale
  render, an `.html` with no `.md` source, a render error, broken relative
  links and `#fragment`s (from the root Markdown too), a link to a `.md`
  source or to a file git ignores, pages not linked from `docs/index.html` or their
  section index, a page without the stylesheet or the required head, duplicate
  ids, unused diagrams, anything loaded from the network, an invisible or
  direction-changing character in a Markdown source, a `planned` badge outside
  `docs/plans/` that is not a span naming its plan (`planned: <slug>`), and a
  link from a page outside `docs/plans/`, the README or the guidance into a path
  the public export leaves out (`tools/oss/manifest.json`); the plans' own
  checks, such as a status that does not match its row in the plans index, are
  `tests/unit/docs-plans.test.ts`'s.
- **Generated pages.** `docs/testing/agent-tests.html` is written by
  `npm run report` (`evals/report.ts`) from `tests/agents/results/*.json`, not
  by the renderer; never edit it by hand.
- **Files under `docs/`** are Markdown, renders, `.svg` diagrams, the stylesheet
  and the demo videos with their sidecars only; anything else (an image for the README, say) lives
  outside `docs/`.
