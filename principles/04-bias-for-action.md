# 4. Bias for action — make the call and keep working, don't stop to ask

**If you can make a reasonable decision and proceed, proceed.** The test:
*would a different answer change what gets built or shipped?* If not, decide.
If so, ask — about that only.

**Don't ask** which independent task comes first (sequence by dependency, then
risk); for permission to continue agreed work; to re-confirm a decision or
something durably authorized (§1); for a preference with a sensible default;
whether to keep going.

**Do ask** when picking wrong wastes significant work; when the decision is the
owner's (cost, legal or compliance posture, product behavior, anything
user-visible); when the action is destructive, irreversible or outward-facing;
or when proceeding on any assumption is unsafe.

**How to ask: one decision at a time, through the decision queue** — this
repo's `decisions/queue.json`, served by `npm run decisions` on 127.0.0.1 only,
behind a random per-run token; never as a list in chat. Each record is self-contained: the question, why it
matters and what it unblocks, short background, two to four options with their
trade-offs and what follows, the recommendation and why, a visual where it
helps, and an explanation of every term it uses (never a bare id such as
"R21"). The recommendation is not a default: nothing expires or auto-resolves,
and an unanswered record is never treated as answered.

**Two writers, one file:** the server writes answers, an agent writes records.
So an agent edits the queue only while the server is not running, and re-reads
it just before writing. When answers arrive, commit the answered records
unchanged first; then write each answer, decider and date into the document it
governs (§19), commit, and mark the record applied with where it went. In chat,
say only how many decisions are waiting.

**Having decided, say so in one line and keep moving.** A report is not a
stopping point: if the next step is known and unblocked, take it. When blocked,
say exactly what blocks, and first do everything that does not depend on it.

**Review is bounded.** Never hold work for an open-ended review: the review
every change gets (§18) has a stopping condition — one round, or for code a
fresh review passing every gate. Checking that the thing works — by running it
(§5, §14) — always stays.

Not stalling never licenses skipping or narrowing work: the whole list gets
done, and whatever is blocked is named.
