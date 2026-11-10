# test3 Timing Trial — Concurrent Mint / Sequential Cast

**Date:** 2026-09-28
**Purpose:** Measure the speed-up from DEV-005 (concurrent MintVAT, sequential
CastBallot, unchanged success metric) before committing to the full 1,000-vote
x3 parity sweep, and project realistic completion times at larger scales.

## Raw trial

100 votes, run index 5, election `test3-run5-1790590881024`, mint concurrency
30. Raw evidence: `100-vote-trial-raw/` (`result.json`, `votes.csv`,
`peer-logs.txt`).

| Metric | Value |
|---|---|
| Mint phase total (100 votes, concurrent) | 4,755 ms |
| Cast phase total (100 votes, sequential) | 223,491 ms |
| Total | 228,246 ms (3.80 min) |
| Mean mint latency (effective, concurrent) | 47.55 ms/vote |
| Mean cast latency (sequential) | 2,234.91 ms/vote |
| Result | `burnedCount=100 tallyTotal=100 committed=100/100` — PASS |

The cast-phase mean (2,234.91 ms/vote) is consistent with the Phase 3 harness
baseline and docs/PHASE4_DECISIONS.md E.1 (`BatchTimeout: 2s` dominates each
sequential CastBallot). The mint phase, previously ~2,150 ms/vote sequential,
is now under 50 ms/vote effective at concurrency 30 — a ~45x reduction in the
mint phase specifically.

## Projections

Linear extrapolation from the 100-vote per-vote rates above. Mint scaling is
throughput-bound by the fixed concurrency window (30) rather than a per-call
fixed cost, so it should hold roughly linearly at larger N; cast scaling is
exactly linear since it is unchanged sequential submission.

| N | Projected mint | Projected cast | Projected total (1 run) | x3 repeats |
|---|---|---|---|---|
| 250 | 11.9 s | 558.7 s | 570.6 s (9.51 min) | 28.53 min (0.48 h) |
| 500 | 23.8 s | 1,117.5 s | 1,141.2 s (19.02 min) | 57.06 min (0.95 h) |
| 1,000 | 47.5 s | 2,234.9 s | 2,282.5 s (38.04 min) | 114.12 min (1.90 h) |
| 10,000 (single run, not x3) | 475.5 s | 22,349.1 s | 22,824.6 s (380.41 min, 6.34 h) | — |

## Comparison to the original fully-sequential design

The interrupted suite's actual test3 run 1 (before this optimisation) is
directly timestamped in `evidence/run-all-2026-09-28T07-04-01-296Z.log`:
started 07:04:35Z, test3 run 2 started 08:17:23Z, giving an observed
**4.368 s/vote** for the old fully-sequential design (1,000 votes in
72.80 min).

| | Old (fully sequential) | New (concurrent mint) | Speed-up |
|---|---|---|---|
| 1,000-vote run | 72.80 min | 38.04 min | **1.91x** |
| 1,000-vote x3 | 218.4 min (3.64 h) | 114.12 min (1.90 h) | **1.91x** |

The speed-up approaches but does not reach 2x because the cast phase — the
larger of the two components at ~98% of total time — is intentionally left
unchanged (see docs/DEVIATIONS.md DEV-005 for why concurrent casting would
invalidate the test's own success metric via spurious MVCC conflicts on the
shared TALLY/BURNEDCOUNT keys).

## Caveat

This is a linear projection from a single 100-vote sample. At much larger N
(5,000–10,000), CouchDB database size growth, ledger height, and gossip/state
propagation overhead could shift the effective per-vote rate somewhat from
what a 100-vote trial suggests — the projection here is for planning purposes
(deciding whether/when to schedule a full 10,000-vote sequential sweep for
test7), not a substitute for measuring the actual sweep.
