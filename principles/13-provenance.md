# 13. Provenance — a result you cannot reproduce is not a result

**Every number traces to the exact code, data and artifact that produced it, and
no state exists in only one place.**

- A working tree that is not a commit is not a state you have — on any machine.
  A dirty tree on a compute host is an incident: commit it, or record the diff,
  before it produces anything.
- An artifact carrying a measurement records our own commit and whether the tree
  was dirty, in the artifact itself.
- Before any destructive sync (`rsync --delete`, a force-overwrite, a checkout
  over changes), verify the target holds nothing unique.
- **Never write a result to the path others read.** Write to a path unique to
  the run, promote only a completed run, record what was promoted from, and keep
  failed runs. Killing a job does not kill its children, and an mtime says
  nothing about a process still writing — vigilance is not the control;
  removing the shared path is.
- Reproduce before relying: a number not yet reproduced on the current committed
  code is provisional, and labelled so wherever it is quoted. **Without
  provenance, discard the number.**
