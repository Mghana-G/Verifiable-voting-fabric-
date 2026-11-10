# Phase 4 Validation Summary

Generated 2026-09-28T22:56:10.044Z.

Maps IMPLEMENTATION_BRIEF.md Section 6.1 success criteria 1-9 to the evidence
that proves each. Criteria 1-7 (below) are pass/fail x3 repeats; criteria 8
and 9 (latency, throughput) are "measured" criteria per Section 6.2 and are
reported separately further down, from the test7 performance sweep.

| # | Criterion | Test(s) | Result (3 runs) | Evidence |
|---|---|---|---|---|
| 1 | Double voting rejection (sequential + concurrent): 100% | 1a + 1b | PASS — 1a: 2026-09-28T07-04-01-624Z: PASS; 2026-09-28T07-04-07-410Z: PASS; 2026-09-28T07-04-12-973Z: PASS<br>1b: 2026-09-28T07-04-18-491Z: PASS; 2026-09-28T07-04-24-130Z: PASS; 2026-09-28T07-04-29-794Z: PASS | evidence/test1a/2026-09-28T07-04-01-624Z/<br>evidence/test1a/2026-09-28T07-04-07-410Z/<br>evidence/test1a/2026-09-28T07-04-12-973Z/<br>evidence/test1b/2026-09-28T07-04-18-491Z/<br>evidence/test1b/2026-09-28T07-04-24-130Z/<br>evidence/test1b/2026-09-28T07-04-29-794Z/ |
| 2 | Replay attack rejection: 100% | 4a + 4b | PASS — 4a: 2026-09-28T10-26-24-076Z: PASS; 2026-09-28T10-26-29-432Z: PASS; 2026-09-28T10-26-34-733Z: PASS<br>4b: 2026-09-28T10-26-39-936Z: PASS; 2026-09-28T10-26-45-187Z: PASS; 2026-09-28T10-26-50-409Z: PASS | evidence/test4a/2026-09-28T10-26-24-076Z/<br>evidence/test4a/2026-09-28T10-26-29-432Z/<br>evidence/test4a/2026-09-28T10-26-34-733Z/<br>evidence/test4b/2026-09-28T10-26-39-936Z/<br>evidence/test4b/2026-09-28T10-26-45-187Z/<br>evidence/test4b/2026-09-28T10-26-50-409Z/ |
| 3 | Tampered ballot rejection: 100% | 5 | PASS — 5: 2026-09-28T10-26-55-553Z: PASS; 2026-09-28T10-26-58-513Z: PASS; 2026-09-28T10-27-01-387Z: PASS | evidence/test5/2026-09-28T10-26-55-553Z/<br>evidence/test5/2026-09-28T10-26-58-513Z/<br>evidence/test5/2026-09-28T10-27-01-387Z/ |
| 4 | Invalid endorsement rejection: 100% | 6 | PASS — 6: 2026-09-28T10-27-04-272Z: PASS; 2026-09-28T10-27-13-049Z: PASS; 2026-09-28T10-27-21-540Z: PASS | evidence/test6/2026-09-28T10-27-04-272Z/<br>evidence/test6/2026-09-28T10-27-13-049Z/<br>evidence/test6/2026-09-28T10-27-21-540Z/ |
| 5 | Audit invariant accuracy: 100% (burnedCount == tallyTotal, 3 repeats) | 3 | PASS — 3: 2026-09-28T11-12-56-900Z: PASS; 2026-09-28T11-25-53-276Z: PASS; 2026-09-28T11-38-20-118Z: PASS | evidence/test3/2026-09-28T11-12-56-900Z/<br>evidence/test3/2026-09-28T11-25-53-276Z/<br>evidence/test3/2026-09-28T11-38-20-118Z/ |
| | *GetAuditInvariant is also checked as a side-assertion inside test1a, test1b, test4a and test4b (invariant must be unchanged by a rejected transaction); test3 is the direct 3-repeat evidence for this criterion.* | | | |
| 6 | 1,000-vote tally parity: 100% | 3 | PASS — 3: 2026-09-28T11-12-56-900Z: PASS; 2026-09-28T11-25-53-276Z: PASS; 2026-09-28T11-38-20-118Z: PASS | evidence/test3/2026-09-28T11-12-56-900Z/<br>evidence/test3/2026-09-28T11-25-53-276Z/<br>evidence/test3/2026-09-28T11-38-20-118Z/ |
| 7 | Ledger recovery / detection after peer inconsistency: successful | 2 | PASS — 2: 2026-09-28T10-31-41-314Z: PASS; 2026-09-28T10-35-50-258Z: PASS; 2026-09-28T10-39-57-783Z: PASS | evidence/test2/2026-09-28T10-31-41-314Z/<br>evidence/test2/2026-09-28T10-35-50-258Z/<br>evidence/test2/2026-09-28T10-39-57-783Z/ |

**Overall (criteria 1-7): PASS**

## Criteria 8 & 9 — Performance (measured, IMPLEMENTATION_BRIEF.md Section 6.2)

| Scale | Mean latency (ms) | Median (ms) | p95 (ms) | Throughput (ballots/s) | Throughput (tx/s) | Invariant | Evidence |
|---|---|---|---|---|---|---|---|
| 100 | 1109.5 | 699 | 2863 | 0.900 | 1.801 | OK (100=100) | `evidence/test7/scale-100/2026-09-28T11-51-33-649Z/` |
| 500 | 1109.4 | 696 | 2873 | 0.901 | 1.801 | OK (500=500) | `evidence/test7/scale-500/2026-09-28T11-53-32-445Z/` |
| 1000 | 1149.8 | 704 | 2887 | 0.869 | 1.738 | OK (1000=1000) | `evidence/test7/scale-1000/2026-09-28T12-03-21-270Z/` |
| 5000 | 1174.5 | 714 | 2891 | 0.851 | 1.701 | OK (5000=5000) | `evidence/test7/scale-5000/2026-09-28T12-23-44-742Z/` |
| 10000 | 1202.8 | 729 | 2884 | 0.831 | 1.661 | OK (10000=10000) | `evidence/test7/scale-10000/2026-09-28T19-09-43-638Z/` |

**Criterion 8 (latency, measured at all 5 scales): PASS** — all 5 required scales measured
**Criterion 9 (throughput, measured at all 5 scales, invariant holds): PASS**

## Bounded-concurrency probe (evidences the single-counter contention ceiling, PHASE4_DECISIONS.md E.1)

Scale 500, window 10, max retries 5: first-attempt committed 167/500, MVCC conflict rate 66.6%, total retries 1488, final committed 276. Invariant: OK (276=276). Evidence: `evidence/test7/concurrency-probe/2026-09-28T22-52-11-796Z/`

## Per-test raw results

### test2
- `evidence/test2/2026-09-28T10-31-41-314Z/` — PASS
- `evidence/test2/2026-09-28T10-35-50-258Z/` — PASS
- `evidence/test2/2026-09-28T10-39-57-783Z/` — PASS

### test3
- `evidence/test3/2026-09-28T11-12-56-900Z/` — PASS
- `evidence/test3/2026-09-28T11-25-53-276Z/` — PASS
- `evidence/test3/2026-09-28T11-38-20-118Z/` — PASS

### test5
- `evidence/test5/2026-09-28T10-26-55-553Z/` — PASS
- `evidence/test5/2026-09-28T10-26-58-513Z/` — PASS
- `evidence/test5/2026-09-28T10-27-01-387Z/` — PASS

### test6
- `evidence/test6/2026-09-28T10-27-04-272Z/` — PASS
- `evidence/test6/2026-09-28T10-27-13-049Z/` — PASS
- `evidence/test6/2026-09-28T10-27-21-540Z/` — PASS

### test1a
- `evidence/test1a/2026-09-28T07-04-01-624Z/` — PASS
- `evidence/test1a/2026-09-28T07-04-07-410Z/` — PASS
- `evidence/test1a/2026-09-28T07-04-12-973Z/` — PASS

### test1b
- `evidence/test1b/2026-09-28T07-04-18-491Z/` — PASS
- `evidence/test1b/2026-09-28T07-04-24-130Z/` — PASS
- `evidence/test1b/2026-09-28T07-04-29-794Z/` — PASS

### test4a
- `evidence/test4a/2026-09-28T10-26-24-076Z/` — PASS
- `evidence/test4a/2026-09-28T10-26-29-432Z/` — PASS
- `evidence/test4a/2026-09-28T10-26-34-733Z/` — PASS

### test4b
- `evidence/test4b/2026-09-28T10-26-39-936Z/` — PASS
- `evidence/test4b/2026-09-28T10-26-45-187Z/` — PASS
- `evidence/test4b/2026-09-28T10-26-50-409Z/` — PASS

