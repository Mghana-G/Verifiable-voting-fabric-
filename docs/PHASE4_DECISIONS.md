# Phase 4 Decisions (MASTER_PLAN Part E)

Decisions for E.1 to E.4, resolved against the deployed system on 2026-09-28.

Facts marked **[verified]** were confirmed by inspecting the running network. Facts marked
**[expected]** follow from Fabric semantics and must be confirmed on first run.

Environment facts used throughout, all **[verified]**:

| Fact | Value |
|---|---|
| Chaincode state database in CouchDB | `votingchannel_voting` |
| Composite key delimiter | `U+0000` (NUL), percent-encoded `%00` in URLs |
| Public state value storage | binary attachment `valueBytes`, base64 |
| Version field | `~version`, base64 protobuf of (blockNum, txNum) |
| CouchDB host ports | IEBC 5984, Judiciary 5985, CivilSociety 5986, Media 5987 |
| Peer host ports | IEBC 7051, Judiciary 7061, CivilSociety 7071, Media 7081 |
| Orderer | localhost:7050, host override `orderer1.orgorderer.example.com` |
| `BatchTimeout` / `MaxMessageCount` | 2s / 10 |

---

## E.1 Counter contention and test7 submission strategy

### Decision

Run **both**, with distinct and clearly separated purposes:

1. **Sequential stream is the primary sweep** across all five scales (100/500/1000/5000/10000).
   It produces the latency figures (criterion 8) and guarantees `burnedCount == tallyTotal == N`
   (criterion 6). This is the headline result.
2. **Bounded-concurrency probe at one scale only (500)** with an MVCC retry loop. It exists to
   characterise and evidence the contention ceiling, not to produce the headline number.

The counters are not redesigned. No deviation is raised: the locked design is correct for
integrity and is what makes Test 1b demonstrable. The constraint below is a reportable finding,
not a defect.

### Why, and what the numbers actually mean

Two independent effects must not be conflated in Chapter 5.

**Latency is dominated by `BatchTimeout`, not by compute.** With sequential submission each
transaction is alone in its batch, so the orderer always waits the full 2s before cutting a
block. The Phase 3 harness measured 2151 ms mean MintVAT and 2179 ms mean CastBallot, which is
2s of batch wait plus roughly 150 ms of real work. Sequential throughput is therefore about
1 ballot per 4.3 s (about 0.23 ballots/s), and that figure measures the orderer's batch timeout,
not the system's capacity. **Reporting 0.23 ballots/s as "throughput" without this explanation
would understate the system by roughly two orders of magnitude and would answer the research
question wrongly.** State the cause explicitly wherever the number appears.

**`BURNEDCOUNT~{electionID}` is a single hot key incremented by every ballot.** Under
concurrency, every CastBallot in a block reads the same version of that key and writes
version+1. At validation exactly one commits; the rest fail `MVCC_READ_CONFLICT`. Concurrency
therefore cannot raise committed CastBallot throughput above roughly one per block regardless of
window size, and the surplus attempts still occupy ordering bandwidth and are written into
blocks as invalid transactions, inflating the ledger. `MintVAT` has no shared key
(`VAT~{vatID}` and the private `VOTERISSUED` entry are unique per transaction) and does
parallelise cleanly.

This is why the concurrency run is a bounded probe at one scale and not the main sweep: at
10,000 votes it would generate a large majority of invalid transactions and a retry storm.

**Runtime budget for the sequential sweep:** about 4.3 s per vote gives roughly 12 h for the
10,000 scale and about 20 h for all five scales combined. Run it under `tmux`. The brief
explicitly accepts this as machine time.

### Procedure

1. Use a distinct `electionID` per scale (`perf-100`, `perf-500`, `perf-1000`, `perf-5000`,
   `perf-10000`) so tallies never interfere.
2. Sequential loop per vote: `MintVAT` (with the `endorsingOrganizations` bypass from DEV-003,
   awaiting `getStatus()`), then `CastBallot` via `submitTransaction`. Record
   `{voteIndex, mintMs, castMs}`. Do not start vote *i+1* before vote *i* has committed.
3. Sample `docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}"` every 5 s
   for the duration, appending to CSV.
4. Capture CouchDB size before and after each scale:
   ```bash
   curl -s -X POST 'http://admin:adminpw@localhost:5984/_dbs_info' \
     -H 'Content-Type: application/json' \
     -d '{"keys":["votingchannel_voting"]}'
   ```
5. After each scale assert `GetAuditInvariant` returns `burnedCount === tallyTotal === N`.
6. Concurrency probe, scale 500 only, separate `electionID` (`perf-conc-500`): window of 10
   in-flight CastBallot submissions, retrying any `MVCC_READ_CONFLICT` up to 5 times with a
   short backoff. Record first-attempt count, retry count, and final committed count.

### Throughput reporting

Define the terms explicitly in Chapter 5 and use them consistently:

- **Ballot throughput** = committed ballots / wall-clock seconds. This is the headline figure.
- **Transaction throughput** = 2 x ballot throughput, since each vote is two Fabric transactions.
  Report it alongside, labelled, so the two are never confused.
- For the concurrency probe report **raw** (all submissions / elapsed) and **effective**
  (committed only / elapsed) separately, plus the MVCC conflict rate.
- Every throughput figure carries the note that sequential latency is `BatchTimeout`-bound.

### Evidence

`evidence/test7/<scale>/<ISO-timestamp>/` containing:

- `result.json`: `{scale, passCount, failCount, meanMintMs, meanCastMs, medianMs, p95Ms, ballotThroughput, txThroughput, invariant:{burnedCount,tallyTotal}}`
- `latency.csv`: one row per vote, `voteIndex,mintMs,castMs`
- `dockerstats.csv`: `timestamp,container,cpuPct,memUsage`
- `couchdb-before.json`, `couchdb-after.json`
- concurrency probe only: `concurrency.json` with raw vs effective throughput and conflict rate

### Failure modes

- **MVCC conflicts appear during the sequential sweep.** Vote *i* had not committed when *i+1*
  started. Confirm `getStatus()` is awaited on the MintVAT submit and that `submitTransaction`
  is awaited for CastBallot.
- **Chaincode container killed (exit 137)** under the long run. The peer then refuses new
  chaincode connections until restarted: `docker restart peer0.orgiebc.example.com`. Watch
  chaincode container memory in `dockerstats.csv`.
- **Node heap exhaustion at 10,000.** Run with `NODE_OPTIONS=--max-old-space-size=2048` and
  stream `latency.csv` rows to disk rather than accumulating in memory.
- **Disk pressure.** Abort if free space drops below 5 GB (Part G risk register).

---

## E.2 Test 2, insider modification of a TALLY document

### Decision on wording

The peer does **not** fall out of consensus. Say this plainly in Chapter 5.

Editing CouchDB changes only derived world state. The block store is untouched, the hash chain
stays intact, Raft membership is unaffected, and the peer keeps receiving and committing blocks.
The single observable consequence is that **the tampered peer produces a divergent endorsement**
for the next transaction that reads the tampered key, so a client that includes that peer in its
endorsement set cannot assemble a matching 3-of-4 set.

Two further honest points that must appear in the write-up:

- The peer never detects the tampering by itself. Nothing alerts.
- The divergence is **self-erasing**. The next CastBallot that commits for that candidate carries
  the honest write-set, and the tampered peer applies it like any other block, overwriting the
  forged value. The tamper must therefore be observed before another transaction writes that key.

Recommended Chapter 5 sentence:

> Directly modifying a peer's CouchDB world state neither corrupts the block store nor removes
> the peer from Raft consensus. Its effect is confined to endorsement: when the tampered peer is
> included in the endorsement set for a transaction reading the modified key, its write-set
> diverges from that of the honest peers and the client cannot assemble three matching
> endorsements. Running `peer node rebuild-dbs` reconstructs world state from the immutable block
> store and restores the correct value, demonstrating that the block store, not CouchDB, is the
> source of truth.

Chapter 3's phrase "altered state fails validation and is rejected during ledger synchronisation"
must be reconciled against this in Chapter 5, and the reconciliation flagged to the supervisor.

### Procedure

Target OrgMedia (CouchDB 5987, peer 7081). Use an election with existing votes.

1. **Read the document.** The key delimiter is NUL, percent-encoded `%00`:
   ```bash
   DOC='%00TALLY%00election2027-harness%00C001%00'
   curl -s "http://admin:adminpw@localhost:5987/votingchannel_voting/${DOC}?attachments=true" \
     -H 'Accept: application/json'
   ```
   Observed shape **[verified]**:
   ```json
   {"_id":" TALLY election2027-harness C001 ",
    "_rev":"13-7fee...","~version":"CgMBcQA=",
    "_attachments":{"valueBytes":{"content_type":"application/octet-stream","data":"MTM="}}}
   ```
   `"MTM="` is base64 for `13`. Record this as `tamperBefore`.

2. **Write the forged value.** The value lives in the `valueBytes` attachment, not in a JSON
   `value` field. `~version` **must be preserved verbatim**: keeping it means the tampered peer's
   read-set version still matches the honest peers, so the divergence shows up purely as a
   write-set mismatch rather than as an unrelated version error. Dropping `~version` or the
   attachment produces a document Fabric cannot unmarshal, which is a different and less
   instructive failure.
   ```bash
   REV='13-7fee...'          # from step 1
   VER='CgMBcQA='            # from step 1, copied unchanged
   NEW=$(printf '9999' | base64)
   curl -s -X PUT "http://admin:adminpw@localhost:5987/votingchannel_voting/${DOC}" \
     -H 'Content-Type: application/json' \
     -d "{\"_rev\":\"${REV}\",\"~version\":\"${VER}\",
          \"_attachments\":{\"valueBytes\":{\"content_type\":\"application/octet-stream\",
          \"data\":\"${NEW}\"}}}"
   ```

3. **Confirm divergence by query,** the cleanest single piece of evidence. Evaluate `GetTally`
   against the Media peer (7081) and against an honest peer (7051). Media returns 9999 for C001,
   IEBC returns the true count. **[expected]**

4. **Provoke the endorsement mismatch.** Submit a CastBallot for C001 with all four orgs forced
   into the endorsement set, so the tampered peer cannot be routed around:
   ```javascript
   contract.newProposal('CastBallot', {
       arguments: [...],
       endorsingOrganizations: ['OrgIEBCMSP','OrgJudiciaryMSP','OrgCivilSocietyMSP','OrgMediaMSP'],
   }).endorse()
   ```
   The gateway rejects the proposal because the endorsement responses do not match. **[expected]**
   Capture the full error. Without the explicit list, service discovery may select three honest
   peers and the tamper will have no observable effect.

5. **Recover.** `rebuild-dbs` is an offline operation, so the peer must be stopped first:
   ```bash
   docker stop peer0.orgmedia.example.com
   docker run --rm ... # not required; run inside the container instead:
   docker start peer0.orgmedia.example.com
   docker exec peer0.orgmedia.example.com peer node rebuild-dbs
   docker restart peer0.orgmedia.example.com
   ```
   If the subcommand refuses to run against a live peer, stop the container, run `rebuild-dbs`
   via a one-shot container sharing the peer's ledger volume, then start the peer again. The
   peer replays the block store and rebuilds CouchDB on next start.

6. **Confirm restoration.** Re-read the document from step 1 and confirm `valueBytes` is back to
   the honest value, then resubmit the four-org CastBallot and confirm it now commits.

### Evidence

`evidence/test2/<ISO-timestamp>/`:

- `result.json`: `{docId, tamperBefore, tamperAfter, tallyFromMediaPeer, tallyFromHonestPeer, endorsementError, rebuildDbs, valueAfterRecovery, resubmitCommitted, pass}`
- `peer-logs.txt`: `docker logs peer0.orgmedia.example.com` slice covering tamper, failed
  endorsement, and rebuild
- `couchdb-before.json`, `couchdb-after-tamper.json`, `couchdb-after-rebuild.json`

### Correction found while implementing test2 (2026-09-28, live-verified)

Two parts of step 4 above turned out to be wrong when actually run:

1. **The explicit four-org endorser list does NOT force a failure.** `OutOf(3,...)` is satisfied
   by *any* matching 3-of-4 subset. Requesting endorsement from all four orgs lets the SDK collect
   IEBC+Judiciary+CivilSociety's agreeing responses and commit, silently discarding Media's
   divergent one — the transaction succeeds and the tamper is immediately overwritten by that
   commit. **Fix:** request endorsement from exactly **three** orgs that include the tampered
   peer (e.g. `['OrgMediaMSP','OrgIEBCMSP','OrgJudiciaryMSP']`). With only three responses total
   and one diverging, at most two can match, which cannot satisfy `OutOf(3,...)` — endorsement
   fails with `ProposalResponsePayloads do not match`.

2. **More prior votes on the tampered key make the tamper *less* likely to be observed, not
   more.** Fabric's CouchDB state implementation keeps a per-peer in-memory cache of recently
   committed values for point `GetState` reads, refreshed on commit (not on read). CastBallot's
   tally increment does a point `GetState` on `TALLY~election~candidate`. If that key was written
   repeatedly just before the tamper, the cache stays warm with the correct value, and the peer's
   chaincode simulation reads from cache rather than CouchDB — masking the external tamper and
   producing a matching (non-divergent) endorsement despite CouchDB itself holding the forged
   value. Verified empirically: with 3 prior votes for the tampered candidate, the provoked
   CastBallot endorsed and committed cleanly; with exactly 1 prior vote, endorsement reliably (2/2
   trials) failed as expected. `GetTally`'s divergence check (step 3 above) is unaffected either
   way, because `getStateByPartialCompositeKey` is a range query and always goes to CouchDB
   directly rather than through the point-read cache — this is why the divergence is visible by
   query even in the run where the endorsement provocation itself did not fail. **Fix:** use only
   one real vote before tampering, and evidence the mismatch via `.endorse()` alone (no
   `.submit()`) — the failure is a proposal-endorsement error, not a commit-time one, so there is
   no block and nothing for a self-heal to overwrite.

Chapter 5 should mention the cache behaviour if this test is reproduced: it means the
demonstrated CouchDB-tamper effect on endorsement is real but *transient and read-pattern
dependent*, not a permanent property of the tampered value — which is itself consistent with
"CouchDB is derived, disposable state" and reinforces this test's actual point.

### Failure modes

- **404 on the document.** The `%00` encoding was dropped or `~` was used as the delimiter. List
  candidates with `_all_docs` and match on the `TALLY` substring.
- **Wrong database.** It is `votingchannel_voting`. `votingchannel_` is a different database and
  does not hold chaincode state.
- **Tamper has no observable effect on endorsement.** Either (a) the endorser list included all
  four orgs rather than exactly three (see correction above), or (b) the key was warmed by
  multiple prior votes before tampering (see correction above) — use one prior vote and a
  three-org list that includes the tampered peer.
- **Tamper silently disappears.** Another CastBallot for the same candidate committed first and
  overwrote it. Re-tamper and provoke immediately, with no other traffic running.
- **Peer fails to start after the PUT.** `~version` or the attachment was dropped, leaving an
  unreadable document. Recover with `rebuild-dbs`; this is itself worth noting in the log but is
  not the intended demonstration.

---

## E.3 Test 6, a 2-of-4 endorsed transaction

### Decision

`fabric-gateway` collects whatever endorsements the policy requires, so Test 6 cannot be written
with the SDK. Use `peer chaincode invoke` with exactly two `--peerAddresses` pairs. The orderer
accepts the transaction and the committing peers mark it `ENDORSEMENT_POLICY_FAILURE` (code 10).

**The validation code must be read from a peer, not from the orderer.** The `TRANSACTIONS_FILTER`
metadata is written by the committing peer during validation, so a block fetched from the orderer
has an empty filter. This was confirmed: fetching block 115 with `-o localhost:7050` gave
`metadata[2] = ""`, while fetching the same block from the peer gave `metadata[2] = "AA=="`,
which decodes to `[0]` (VALID). **[verified]**

### Procedure

1. Mint a fresh, unused VAT and build a correctly signed CastBallot argument tuple. The six
   arguments require a real ECDSA signature, so generate them with a small Node helper that
   prints JSON, and have the shell script consume that. The transaction must be internally valid
   so that both endorsing peers return success; the only defect is that there are two
   endorsements rather than three.

2. Record `GetTally` before the invoke.

3. Invoke with two endorsers only:
   ```bash
   cd ~/voting-network/network
   source scripts/env-peer.sh && setPeer IEBC
   export PATH=$PATH:$HOME/fabric-samples/bin
   ORDERER_CA="$PWD/organizations/ordererOrganizations/orgorderer.example.com/tlsca/tlsca.orgorderer.example.com-cert.pem"
   IEBC_TLS="$PWD/organizations/peerOrganizations/orgiebc.example.com/peers/peer0.orgiebc.example.com/tls/ca.crt"
   JUD_TLS="$PWD/organizations/peerOrganizations/orgjudiciary.example.com/peers/peer0.orgjudiciary.example.com/tls/ca.crt"

   peer chaincode invoke \
     -o localhost:7050 --ordererTLSHostnameOverride orderer1.orgorderer.example.com \
     --tls --cafile "$ORDERER_CA" \
     -C votingchannel -n voting \
     --peerAddresses localhost:7051 --tlsRootCertFiles "$IEBC_TLS" \
     --peerAddresses localhost:7061 --tlsRootCertFiles "$JUD_TLS" \
     -c '{"function":"CastBallot","Args":["<vatID>","C001","<ephPubPem>","<sigB64>","<payload>","<nonce>"]}'
   ```
   The command reports success because it reached the orderer. Rejection happens at commit.

4. Read the block height. Note `getinfo` takes lowercase `-c` and prefixes its output with
   `Blockchain info: `, so the prefix must be stripped **[verified]**:
   ```bash
   HEIGHT=$(peer channel getinfo -c votingchannel 2>/dev/null \
            | sed 's/^Blockchain info: //' \
            | python3 -c 'import sys,json; print(json.load(sys.stdin)["height"])')
   BLOCK=$((HEIGHT-1))
   ```

5. Fetch that block **from the peer**, omitting `-o`, and decode the filter:
   ```bash
   peer channel fetch $BLOCK /tmp/block.pb -c votingchannel      # no -o: peer deliver service
   configtxlator proto_decode --input /tmp/block.pb --type common.Block \
     | python3 -c '
   import sys, json, base64
   b = json.load(sys.stdin)
   codes = list(base64.b64decode(b["metadata"]["metadata"][2]))
   names = {0:"VALID",10:"ENDORSEMENT_POLICY_FAILURE",11:"MVCC_READ_CONFLICT"}
   print(json.dumps({"codes":codes,"labels":[names.get(c,f"CODE_{c}") for c in codes]}))'
   ```
   Expected `{"codes":[10],"labels":["ENDORSEMENT_POLICY_FAILURE"]}`. **[expected]**

6. Record `GetTally` after and confirm it is unchanged.

7. Optional corroboration: the verification dashboard already decodes per-transaction validation
   codes from filtered block events, which are peer-sourced. Refresh it and screenshot the row
   to `evidence/screenshots/test6-run1-dashboard.png`.

### Evidence

`evidence/test6/<ISO-timestamp>/`:

- `result.json`: `{blockNumber, txValidationCodes:[10], txValidationLabels:["ENDORSEMENT_POLICY_FAILURE"], tallyBefore, tallyAfter, tallyUnchanged:true, pass}`
- `block.json`: the decoded block
- `peer-logs.txt`: `docker logs peer0.orgiebc.example.com` slice showing the VSCC policy failure
- `test6-run1-dashboard.png`

### Failure modes

- **`metadata[2]` is empty.** The block was fetched from the orderer. Omit `-o`.
- **`getinfo` prints usage text.** The flag is lowercase `-c` for `getinfo` (uppercase `-C` is
  used by `chaincode invoke`).
- **Transaction never reaches a block.** Chaincode execution failed at the two endorsers, for
  example a reused VAT or an invalid signature, so the CLI aborted before the orderer. Use a
  fresh VAT and verify the signature independently.
- **Code is 11 rather than 10.** Concurrent traffic touched the same key. Re-run with the network
  otherwise idle.
- **More than one code in the array.** The block held several transactions. Match the target by
  transaction ID from the invoke output rather than assuming index 0.

---

## E.4 Test 4, replay of a committed CastBallot

### Decision

**A byte-identical resubmission is achievable**, contrary to the assumption that the gateway
prevents it. `@hyperledger/fabric-gateway` v1.11.0 exposes `Proposal.getBytes()`,
`Proposal.getDigest()` and `Gateway.newSignedProposal(bytes, signature)` **[verified]**, so the
exact signed proposal can be reconstructed and re-endorsed.

**However, a byte-identical replay does not reach the chaincode nonce check.** The proposal bytes
carry the channel header, which fixes the Fabric transaction ID. Replaying identical bytes
replays that transaction ID, and the peer's endorser rejects a transaction ID already present in
the ledger before the chaincode is invoked, with a message of the form
`duplicate transaction found [<txid>]`. **[expected]** That exercises Fabric's platform-level
replay defence, not `NONCE~{electionID}~{nonce}`.

Test 4 therefore has two parts, and both should be captured because together they are strictly
stronger evidence than either alone:

- **4a, byte-identical replay.** Reconstruct the signed proposal with `newSignedProposal` and
  re-endorse. Expect rejection at the endorser for a duplicate transaction ID. Evidences the
  platform layer.
- **4b, application-layer replay (the one the brief requires).** Resubmit the same six CastBallot
  arguments in a fresh transaction. The SDK generates a new transaction ID and gRPC nonce, so the
  proposal reaches the chaincode. The signature still verifies because `payload` is unchanged, and
  the nonce check then fires. Evidences `ERR_NONCE_USED`.

### Why 4b hits the nonce check and not the VAT check

The validation order in `chaincode/voting/lib/votingContract.js` is fixed **[verified]**:

```
1. signature over payload            -> ERR_BAD_SIGNATURE
2. NONCE~{electionID}~{nonce} exists -> ERR_NONCE_USED      <- fires here
3. VAT~{vatID}.status != ACTIVE      -> ERR_VAT_NOT_ACTIVE
4. CANDIDATE~{candidateID} missing   -> ERR_NO_CANDIDATE
```

The replayed ballot has both a spent nonce and a burned VAT, but the nonce is checked first, so
the error is `ERR_NONCE_USED`. Test 1a sends a fresh nonce with an already-burned VAT, passes the
nonce check, and fails at step 3 with `ERR_VAT_NOT_ACTIVE`. The differing error strings are the
proof that these are two distinct mechanisms, which is exactly what brief Section 6 requires.

### What is and is not resubmitted in 4b

| Field | 4b |
|---|---|
| `vatID`, `candidateID`, `ephemeralPubKey`, `signature`, `payload`, `nonce` | identical bytes |
| Fabric transaction ID | new, generated by the SDK |
| gRPC proposal nonce and TLS session | new |

Chapter 5 must describe 4b as an application-layer replay of the signed ballot, not as a
byte-identical network replay. 4a is the byte-identical case and is reported separately.

### Procedure

1. During a normal vote, capture the six arguments and persist them to
   `evidence/test4/captured-ballot.json`. For 4a also capture `proposal.getBytes()` and the
   signature bytes before submission.
2. Wait for the original to commit: await `getStatus()`, then confirm via `GetAuditInvariant`
   that the counts incremented.
3. **4a:** rebuild with `gateway.newSignedProposal(bytes, signature)` and call `.endorse()`.
   Expect a thrown error naming a duplicate transaction ID. Record the full message and assert it
   does not contain `ERR_NONCE_USED`.
4. **4b:** call `contract.submitTransaction('CastBallot', vatID, candidateID, ephemeralPubKey,
   signatureB64, payloadStr, nonce)` with the captured values. Expect a thrown error.
5. Assert the 4b error contains `ERR_NONCE_USED` and does **not** contain `ERR_VAT_NOT_ACTIVE`.
6. Assert `GetAuditInvariant` is unchanged by either attempt.

### Evidence

`evidence/test4/<ISO-timestamp>/`:

- `captured-ballot.json`: the reused `vatID` and `nonce`, plus the payload
- `result.json`:
  `{byteIdentical:{attempted:true,error,rejectedAtEndorser:true,containsNonceUsed:false},
    argumentReplay:{error,containsNonceUsed:true,containsVatNotActive:false},
    invariantBefore, invariantAfter, pass}`
- `peer-logs.txt`: slice showing the duplicate transaction ID rejection for 4a and
  `ERR_NONCE_USED` for 4b
- For the contrast required by the brief, cross-reference `evidence/test1a/.../result.json`
  showing `ERR_VAT_NOT_ACTIVE` from the same chaincode

### Failure modes

- **4b returns `ERR_VAT_NOT_ACTIVE`.** The nonce was regenerated rather than reused. Confirm the
  `nonce` argument and the `nonce` field inside `payload` are both the captured values. Note the
  chaincode cross-checks `payloadObj.nonce !== nonce` and throws `ERR_BAD_SIGNATURE` on mismatch,
  so the two must agree.
- **4b returns `ERR_BAD_SIGNATURE`.** `payloadStr` was re-serialised rather than reused verbatim.
  It must be the exact captured string: any key reordering or whitespace change invalidates the
  signature. Log the byte length of `payloadStr` in both the original and the replay and compare.
- **4b returns the duplicate transaction ID error.** The captured proposal object was reused
  instead of building a fresh call. 4b must go through `submitTransaction`.
- **4a succeeds and commits.** The original had not committed when the replay fired, so there was
  no duplicate to detect. Confirm commit first, then replay.
