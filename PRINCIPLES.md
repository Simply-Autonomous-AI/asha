# PRINCIPLES.md

The principles that govern this repo, for AI agents and humans alike. This index
is loaded every session and stays short; the text of each principle is in
[`principles/`](./principles/). **Read it before you rely on an edge of a rule** —
an exception, a judgement call, anything its line here does not settle. Every
file binds equally.

**Precedence.** These are the floor. [AGENTS.md](./AGENTS.md) may be stricter
for a stated reason, and then it wins. When a rule blocks correct work, stop and
ask (§4); never quietly work around it. Nothing outside this file enumerates the
principles; AGENTS.md names only the few every task applies, as pointers here.

| § | Principle | The rule in one line |
|---|---|---|
| 1 | [Deployments](principles/01-deployments.md) | Ship through the gated command without asking; get consent to bypass it, publish, rewrite history, branch or add spend. |
| 2 | [Git server](principles/02-git-server.md) | Commit at every checkpoint, push opportunistically; an unreachable remote never blocks work. |
| 3 | [Test coverage](principles/03-test-coverage.md) | Every logic change carries tests asserting exact values and mock calls; prove a new guard fails; no flaky tests. |
| 4 | [Bias for action](principles/04-bias-for-action.md) | Decide and proceed unless the answer changes the outcome; ask the owner one decision at a time, through the decision queue. |
| 5 | [Evidence](principles/05-evidence.md) | Nothing is acted on or reported as fact until a command, file, test or source confirms it. |
| 6 | [Priorities](principles/06-priorities.md) | A working production comes first; "fixed" means a regression test and a green gate; roll forward. |
| 7 | [Complexity and cost](principles/07-complexity-and-cost.md) | Reuse, extend or simplify before adding; recurring spend needs a written estimate and approval first. |
| 8 | [Fix it](principles/08-fix-it.md) | Fix the root cause or a genuinely wrong test; never mute the signal. |
| 9 | [Consistent behavior](principles/09-consistent-behavior.md) | No fallbacks for impossible cases; fail loudly; never default an environment. |
| 10 | [Robust interfaces](principles/10-robust-interfaces.md) | Depend on contracts; adapters injected at one composition root; no global state. |
| 11 | [Surface every error](principles/11-surface-every-error.md) | Never swallow; every failure reaches the logging facade; expected failures are data; every remote call is bounded. |
| 12 | [External facts decay](principles/12-external-facts-decay.md) | Verify outside facts at the primary source when used; cite source and date; correct visibly. |
| 13 | [Provenance](principles/13-provenance.md) | Every result traces to its commit, data and artifact; write to a run-unique path, promote on success. |
| 14 | [Run the thing you are claiming](principles/14-run-the-thing.md) | Verify a claim by running exactly what it claims, where it runs; a cap that is hit voids the run. |
| 15 | [Documentation is part of the change](principles/15-documentation-is-part-of-the-change.md) | The doc describing a change is true again in the same commit. |
| 16 | [Sessions](principles/16-sessions.md) | Resume the conversation before reconstructing it; never commit transcripts. |
| 17 | [Documentation](principles/17-documentation.md) | `docs/` is indexed, hierarchical Markdown rendered to committed HTML, guarded in the gate. |
| 18 | [Adversarial review](principles/18-adversarial-review.md) | Every change gets a review by a fresh agent, never a person: code by the `sdlc/` loops, anything else in one round. |
| 19 | [Plans](principles/19-plans.md) | Future work is a testable spec in `docs/plans/`, ready before it is built, done with evidence. |
| 20 | [Technical debt](principles/20-technical-debt.md) | A shortcut is allowed only if registered in `docs/plans/debt.md` in the same commit. |
| 21 | [Automated assurance](principles/21-automated-assurance.md) | Every escaped defect adds the earliest check that would have caught it; amend, don't append. |
| 22 | [Avoid CDK risks](principles/22-cdk-risks.md) | No cross-stack resource references; reference by name; a missing `STAGE` fails at startup. |
