# 22. Avoid CDK risks — no cross-stack resource references, and STAGE is mandatory

*(For infrastructure defined with AWS CDK.)* Existing resources stay stable: a
change that reads as a refactor can make CloudFormation replace a live resource,
or wedge two stacks against each other.

- **No resource in one stack depends on a reference injected from another.** An
  export/import locks the export: neither stack can change it alone, and an
  update that fails partway can deadlock both. Derive names and ARNs from
  stage-specific constants and reference resources **by name**, stating the
  trade-off the choice accepts.
- **A value that must be discovered** is read at runtime from SSM under a
  stage-deterministic name — a data dependency, not a stack one.
- **Every element that runs code carries an explicit `STAGE`**, set in the
  infrastructure code that defines it. **A missing `STAGE` fails at startup** —
  never defaulted or guessed, never "beta" or "prod" by fallback (§9).
- **Logical ids and outputs are published surfaces** (§10): renaming a
  construct's logical id destroys and recreates its resource, and renaming an
  output breaks every importer and script that reads it.
