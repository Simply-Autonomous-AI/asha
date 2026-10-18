# 17. Documentation — thorough, hierarchical, indexed, Markdown rendered to HTML

*(The owner's direction, 2026-09-27, for a project that ships software. A repo
of business documents rather than a system is exempt from §17–§21.)*

**From `docs/` alone, a reader — human or agent — learns how the system works,
how to use it and how to extend it.**

- **Markdown is the source; HTML its committed render.** Each page is
  `docs/**/<name>.md`, its diagrams `.svg` files beside it; the repo's renderer
  writes `<name>.html` beside it, chrome included. Never edit a render by hand.
  (Agents read Markdown at about half the tokens of HTML, and it diffs cleanly.)
- **One index, one hierarchy.** `docs/index.html` is the table of contents, each
  section has its own `docs/<section>/index.html`, and every page is linked from
  one of them. A page with more than three sections has its own contents.
- **Default sections**, adapted to the project: Project details; Interfaces;
  Architecture (each component, what it talks to, deep links, key code,
  patterns, configuration, how to extend it); Quality controls; Testing (the
  suites, and the latest results with provenance, §13); Deployments; Plans
  (§19).
- **Light theme, one stylesheet, nothing loaded from the network.** Diagrams are
  inline SVG showing the real mechanism. Code is deep-linked by a relative link
  naming the symbol.
- **Mark gaps** with a literal `TODO:` saying what is missing; never guess (§5).
- **Guarded.** A gate test fails on a stale or missing render, a broken link, an
  unreached page, a network-loaded resource, a `planned` badge outside the
  plans that does not name its plan as text, or a link from a published page
  into what the public export leaves out, the plans included (§19). A doc change
  is done (§15) only when it is green.
