# test3 Timing Trial at 500ms BatchTimeout (DEV-006)

**Date:** 2026-09-28
**Purpose:** Measure the speed-up from DEV-006 (orderer `BatchTimeout` 2s → 500ms)
combined with DEV-005 (concurrent mint), and apply the step 5 decision rule to
choose the test7 sweep ladder before committing machine time to it.

## Raw trial

100 votes, run index 7, election `test3-run7-<ts>`, mint concurrency 30.
Raw evidence: `100-vote-trial-raw/` (`result.json`, `votes.csv`, `peer-logs.txt`).

| Metric | Value |
|---|---|
| Mint phase total (100 votes, concurrent) | 4,943 ms |
| Cast phase total (100 votes, sequential) | 72,000 ms |
| Total | 76,943 ms (1.28 min) |
| Mean mint latency (effective, concurrent) | 49.43 ms/vote |
| **Mean cast latency (sequential)** | **720.00 ms/vote** |
| Result | `burnedCount=100 tallyTotal=100 committed=100/100` — PASS |

Mean cast latency dropped from 2,234.91 ms/vote (2s BatchTimeout,
`evidence/timing-trial/`) to **720.00 ms/vote** — a **3.10x** reduction,
consistent with cutting the batch wait from 2s to 500ms while the ~50-230ms of
real chaincode/network work per transaction is unchanged.

## Projections (linear extrapolation from the 100-vote rates)

| Scale | Projected time (1 run) |
|---|---|
| 100 | 76.9 s (1.28 min) |
| 500 | 384.7 s (6.41 min) |
| 1,000 | 769.4 s (12.82 min) |
| 5,000 | 3,847.1 s (64.12 min, 1.07 h) |
| 10,000 | 7,694.3 s (128.24 min, 2.14 h) |

| Component | Projected total |
|---|---|
| test3 (1,000 votes, 1 run) | 769.4 s (12.82 min) |
| **test3 (1,000 votes, x3 runs)** | **2,308.3 s (38.47 min, 0.641 h)** |
| Sweep (100+500+1,000+5,000+10,000, one run each) | 12,772.5 s (212.88 min, 3.548 h) |
| **Grand total (test3 x3 + full sweep)** | **15,080.8 s (251.35 min, 4.189 h)** |

## Step 5 decision

**Projected grand total: 4.19 hours ≤ 5 hours.**

Per the decision rule: use the **original sizes** — test3 at 1,000 votes x3,
and the full sweep at 100 / 500 / 1,000 / 5,000 / 10,000 votes. No reduction
applied; **no DEV-007 entry required** (that entry is only for the reduced-ladder
case, which does not apply here).

## Caveat

Linear projection from a single 100-vote sample, same caveat as the 2s trial:
CouchDB size growth, ledger height, and gossip overhead could shift the
effective per-vote rate somewhat at 5,000-10,000 scale. This is a planning
estimate, not a substitute for the actual measured sweep in evidence/test7/.
