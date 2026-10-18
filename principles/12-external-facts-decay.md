# 12. External facts decay — verify at the point of use, record what changed

**Any fact about something outside our own work has a shelf life** — laws,
filing rules, fees, tax rules, licences, model architectures, API behavior,
prices, vendor terms, dependency defaults.

- **Verify from the primary source when you use it.** The "assumption" label
  (§5) is for when evidence cannot be obtained, never for when a fetch or a
  command would settle it. For legal, tax and regulatory facts the primary
  source is the agency or the statute — not a blog or model memory.
- **Never infer a fact from a family, a vendor or a previous release.** One
  model generation's licence or architecture says nothing about the next, and
  one product name can cover both a research-only and an `apache-2.0` model.
  Read the card, changelog, statute or terms for the exact thing.
- **Cite the source and the date** of every recorded external fact; pin the
  exact version where it matters (a model by repository revision, a form by its
  revision date), and record when it was re-verified.
- **Correct a wrong claim visibly** — what was claimed, what is true, why the
  reasoning failed. Never overwrite it silently.
