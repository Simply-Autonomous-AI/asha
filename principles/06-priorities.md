# 6. Priorities — a working production outranks everything else

**Fixing a production issue comes before feature work, always.** A feature that
broke production is not finished.

**"Fixed" means demonstrated:** a regression test that fails before the fix and
passes after (§3), a green run of the full gate (§1), and the evidence stated —
what broke, why, and what proves the cause is gone.

A break that reached production is two defects: the break and the gate that
missed it. Fix both. Don't ship on top of a known-broken production. **Roll
forward:** fix, test, deploy through the gate; never rewind git history (§1).
Redeploying an earlier build is a rare stopgap for a severe outage, and the real
fix still ships afterwards.
