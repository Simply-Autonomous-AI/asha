# 8. Fix it — whoever broke it, you fix the root cause

**A broken test, a red gate or any other defect is yours to fix, wherever it
came from.** There are two legitimate resolutions: fix the root cause, or
correct a genuinely defective test.

**Never remove the signal:** skipping or deleting a test (`.skip`, `.todo`,
`xit`, commenting it out, `if (false)`); disabling or loosening the rule that
fired (an ignore entry, a suppression comment, a lowered threshold, `error`
demoted to `warn`); bypassing the gate (`--no-verify`, dropping a step, running
a sub-command instead); papering over it (a retry, a sleep, a widened
tolerance, a null-guard on a value that should never be null).

"The test is wrong" needs evidence (§5). A check you believe is wrong is an
escalation, not a suppression: say what fired, what you found, and what
suppressing it would cost — then wait for the maintainer. A suppression shipped
without that conversation is a review-blocking defect, even when the reasoning
was sound.
