## test2 rebuild-dbs recovery timeout — RESOLVED (2026-09-28)

**Symptom:** test2 run1 failed twice during the post-VM-suspend re-run: first
with `peer Media did not reach height 2994 within 90000ms` (a hard timeout in
`waitForHeight`), then with `TALLY document not found on Media CouchDB` on
the immediate retry.

**Root cause:** `peer node rebuild-dbs` replay time scales with chain
length (~66-75ms/block observed on this network). Earlier in the session the
chain was short (~180 blocks) and a 90s timeout was generous; by this point
the chain had grown to ~3,000 blocks (from the interrupted 1,000-vote test3
run before the VM suspend), so a full rebuild-dbs replay took ~3-4 minutes —
comfortably past the old 90s timeout. The second failure was caused by
re-running test2 immediately after deleting the first attempt's evidence,
without confirming Media had actually finished catching up from the first
attempt's rebuild-dbs.

**Fix applied:** `test/lib/blockchain.js` `waitForHeight()` default timeout
raised from 90s/3s-poll to 900s/5s-poll (see inline comment). Verified: after
waiting for Media to genuinely catch up (confirmed via `peer channel
getinfo`), all three test2 runs passed cleanly, and `health-check.sh` shows
all four peers at the same height (3011) with all 11 checks passing.

**Student action:** None required — this was an implementation timeout bug,
not a chaincode or design defect. Worth a one-line mention in Chapter 5 if
rebuild-dbs recovery time is discussed: it is not instantaneous and scales
with ledger size, which is itself a reasonable thing to state plainly (the
recovery mechanism trades a proportional-to-history replay cost for not
requiring any out-of-band backup/snapshot infrastructure).

## test7 concurrency probe "FAILED" — RESOLVED, not a real failure (2026-09-29)

**Symptom:** `test7-probe scale=500 FAIL | firstAttemptCommitted=184/500 mvccRate=63.2% retries=1434 finalCommitted=271`.

**Root cause:** a bug in the probe's own pass criteria
(`test7-performance.js` `runConcurrencyProbe`), not a system defect. The
probe's purpose (PHASE4_DECISIONS.md E.1 step 6) is to evidence the
single-counter contention ceiling: with `windowSize=10` concurrent
`CastBallot` submissions all incrementing one of only 4 shared `TALLY` keys
(+1 shared `BURNEDCOUNT` key), heavy MVCC contention is the expected,
correct outcome, and a bounded retry budget (`maxRetries=5`) can
legitimately leave some votes uncommitted — that is the finding, not a
defect. The original `pass` condition wrongly required
`finalCommitted === scale`, i.e. that contention be fully overcome, which
contradicts the probe's own purpose. Checked the actual data first: the
run itself was clean — `invariantOK: true`, `burnedCount === tallyTotal`
exactly for the 271 votes that did commit, zero corruption or
double-counting, 63.2% first-attempt MVCC conflict rate and 1,434 retries
captured correctly.

**Fix applied:** pass criteria changed to `result.pass = result.invariantOK`
— the probe passes when it runs cleanly and the invariant holds for
whatever committed, not when every vote gets through. Re-run after the fix:
see `evidence/test7/concurrency-probe/` for the confirming PASS run. The
original (correctly-computed-data, wrongly-labelled) run is kept in place
as valid evidence — both show the same phenomenon.

**Student action:** None required — implementation bug in the test harness's
own pass/fail judgment, not a chaincode or network defect. The measured
63.2% MVCC conflict rate and the gap between `firstAttemptCommitted` and
`finalCommitted` under a bounded retry budget is itself the Chapter 5
evidence for the single-counter contention ceiling described in
docs/PHASE4_DECISIONS.md E.1.
