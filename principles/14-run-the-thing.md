# 14. Run the thing you are claiming — one instance is not the class

The error of §12, committed against our own work: checking one branch, path or
case, and reporting about all of them.

1. **Evidence about one instance is evidence about that instance.** A claim
   about every case needs a check of every case.
2. **A command works only once you have run it.** Never put an unrun command in
   a document, a handoff or a message.
3. **Run it where it will run.**
4. **A check that reimplements the thing under test proves nothing about it.**
   Call the real function; build the real arguments.
5. **A harness cap is a guard, not a measurement, and a cap that is hit voids
   the run.** Set token budgets, timeouts and retry counts as low as nothing
   legitimate reaches; if one is hit, raise it and re-run. The lowest cap
   nothing touches is the right one. If raising it never stops it being hit, the
   generation is non-terminating — a finding about the model.

**Your checks must fail loudly too** — "the check did not run" must never read
as "no problem":

- no `2>/dev/null` on a verification command, and no verification output piped
  straight into a counter (`wc -l` counts error text);
- a pipeline's status is its last command's — capture the real one
  (`cmd > log 2>&1; echo "EXIT=$?" >> log`);
- prefer commands whose failure is an error, not an empty set; an empty result
  proves nothing until the query is shown to address the right thing;
- prove the path under test actually ran;
- confirm a deploy against reality — the live page, the deployed version, the
  stored object.

**A green summary is not evidence; the rows are.** Before an unattended run, a
handoff or a claim of readiness, execute the checks — as a command with an exit
code, not a judgement. A checklist that cannot fail is not a checklist.
