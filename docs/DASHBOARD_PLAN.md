# DASHBOARD PLAN v2: three-role application

**Project:** A Blockchain-Based Voting System for End-to-End Verifiability (Gift Mghana, 169774)
**Replaces:** the v1 "project command centre" plan (Phases D1 and D2, kept in git history at commit `9398ca3`).
**Scope:** `dashboard/` only. The network, chaincode, client app, tests and evidence are frozen.

---

## 1. Purpose

One Express app on `127.0.0.1:5050` that shows the system working end to end and sits beside the Chapter 5 write-up. A
landing page offers three roles:

| Role | Who | What it does |
|---|---|---|
| Voter | Polling-station booth | Sign in with a registry voter ID, get a ballot token (MintVAT), choose, sign, cast (CastBallot), receive a receipt. A "polling-station mode" panel simulates a batch of voters. |
| Administrator | The operator | Network control (bring-up runbook), live topology, chaincode, election, ledger explorer, tests and evidence, logs, project records, report companion. |
| Public verifier | Anyone | Results and audit invariant, four-peer agreement, ballot lookup, chain integrity, privacy check, and an honest statement of what the verification does not prove. |

Access control is **demo-grade, for a local prototype, not production authentication** (see section 3). The same note is
shown on the landing page.

## 2. Hard rules

| Rule | Detail |
|---|---|
| Frozen areas | Never edits `network/`, `chaincode/`, `client-app/`, `test/`, `voter-generator/`, `verification-dashboard/`, `evidence/`, `IMPLEMENTATION_BRIEF.md`, `MASTER_PLAN.md`, `docs/HOW_IT_WORKS.md`. |
| Evidence is read-only | The dashboard never writes in `evidence/`. Tests it launches write their own new timestamped folders. |
| Only two ledger writes | `lib/station.js` is the only module that can endorse or submit, and only `MintVAT` and `CastBallot`, as `User1@orgiebc` (what `client-app` uses). `CreateCandidate` is never called: C001 to C004 already exist. |
| Read paths are evaluate-only | `lib/gw.js` can only `evaluate` whitelisted calls: `qscc` (`GetChainInfo`, `GetBlockByNumber`, `GetTransactionByID`, `GetBlockByTxID`), `voting` (`GetTally`, `GetAuditInvariant`), `_lifecycle` (`QueryChaincodeDefinition`). The one extra read is the privacy probe: it evaluates (never submits) a fixed `MintVAT` call as Civil Society to reproduce HOW_IT_WORKS 5.2. |
| Casts are sequential | Ballots are cast one at a time (DEV-005: the single `TALLY` and `BURNEDCOUNT` keys conflict under concurrency). Mints may run up to 5 at once. |
| Secrecy | Nothing that links `voter_id` or `voterHash` to `vatID`, `ballotID` or `candidateID` is written to disk, to logs or to `dashboard/out/`. The only voter-side persistence is an integer count of dashboard votes per election, an integer batch offset and an integer sample cursor. The token for a failed cast lives in the session in memory only. |
| No guessing | A value that cannot be read shows as unavailable (amber) or MISSING (red) with the reason, never a made-up number. |
| Offline | No CDN, no external fonts, no build step. Vanilla JavaScript. |
| No gas, mining or proof of work | Raft is crash fault tolerant, never Byzantine fault tolerant. |

## 3. Access control (demo-grade)

- Cookie `vn_session`: 32 random bytes, `HttpOnly; SameSite=Strict; Path=/`. Sessions are held in memory only.
- **Voter** signs in with a registry ID. Signing in *is* the off-chain verification (`verifyVoter()` from
  `client-app/lib/registry.js`: recompute `SHA-256(voter_id + salt)` and compare). The session expires after 10 minutes
  or immediately after a committed ballot.
- **Administrator** signs in with `DASHBOARD_ADMIN_PASSWORD` from `dashboard/.env` (gitignored). Only a scrypt hash is
  held in memory and the comparison uses `crypto.timingSafeEqual`. If the variable is unset the tile says admin sign-in
  is off. A wrong password delays the next attempt by one second. Admin sessions last 8 hours.
- **Verifier** needs no sign-in.
- Every protected API route checks the role on the server. Existing middleware stays: Host header check, Origin check
  on non-GET requests, a Content-Security-Policy with no inline scripts and no CDNs.
- Not production authentication: no password reset, no lockout beyond a one-second delay, no TLS (loopback only, reached
  by SSH tunnel), one shared admin password.

## 4. The mock election

`dashboard/data/election.json`:

```json
{ "electionID": "KE-PRES-2027-MOCK-01", "title": "Mock Presidential Election 2027",
  "pollingStationID": "PS-DASH-01", "candidates": ["C001", "C002", "C003"] }
```

Names and parties come from `voter-generator/candidates.json` at run time. C004 exists on chain but is not on this ballot.
Everything on chain is scoped by `electionID`, so "start a fresh mock election" writes `...-MOCK-02` and so on into
`election.json`; earlier elections stay on the ledger and appear in History. "Close voting" is a dashboard lock only,
**enforced by this dashboard, not by the chaincode** (HOW_IT_WORKS 6.7). Dashboard-side state is
`dashboard/out/election-state.json` (integers and the lock only).

## 5. Architecture

```
dashboard/
  server.js            Express, security middleware, routers, project-records endpoints, evidence browser
  routes/              auth.js, voter.js, admin.js, verify.js, stream.js (SSE)
  lib/
    session.js         in-memory sessions and role guard
    identity.js        fabric-gateway identity and gRPC channel for an org's User1
    station.js         the ONLY write path: MintVAT and CastBallot, four-stage reporting
    gw.js              read-only evaluate client (whitelist above)
    blocks.js          qscc reads, decoding, hash checks, LRU cache (500), block tail
    decode.js          pure protobuf decoding of blocks and envelopes, DER header hash
    jobs.js            single-lock job runner with SSE replay and log files
    ops.js             fixed whitelist of network operations and their gates
    batch.js           simulated voters (mint up to 5 at once, cast one at a time)
    ballotkit.js       buildPayload() and signBallot() taken from client-app/lib directly
    registry.js        verifyVoter() from client-app/lib plus positional reads
    election.js        election.json and election-state.json
    drawers.js         "What happened on the network": text plus source lines read from disk by function name
    testmeta.js        what each test attacks and which layer stops it
    (fabric.js, proto.js, util.js, live.js, report.js: carried over from D1 and D2)
  collectors/          carried over unchanged (environment, build, deviations, tests, criteria, performance, screenshots, network, chaincode)
  public/              index.html (landing), voter.html, admin.html, verify.html, css/, js/
  data/                election.json, figures.json, milestones.json, notes.json
  out/                 generated, gitignored: state.json, ops logs, election-state.json
```

### Never scanning from block 0

The chain is over 25,000 blocks. Every walk (explorer pages, blocks per minute, integrity check, election filter) starts
at the current height and is capped (the election filter looks at no more than 400 blocks per request).

### "What happened on the network" drawers

Each voter step, runbook card and explorer view opens a drawer with a plain-English paragraph from HOW_IT_WORKS, the
keys read and written, and the **actual source lines**, found at request time by function name (for example `MintVAT`
in `chaincode/voting/lib/votingContract.js`). Line numbers are never hard-coded, so the text and the code on screen
cannot drift apart.

## 6. Safety gates for network operations

- A fixed whitelist maps an operation name to one command; no argument ever comes from the page.
- One job at a time. Voting and batches are refused while a network operation runs.
- 01, 02 and 03 are refused on the server while any network container is running; 01 and 02 are also refused while ledger volumes exist (new certificates would make the stored chain unusable). 04 and later steps need the containers running. The button shows why.
- 05 shows the sequence it will commit (N+1) before running.
- Teardown needs the typed word `TEARDOWN` and warns that it deletes every ledger volume and invalidates block
  numbers cited in `evidence/`.
- Commands need `{"confirm": true}` in a JSON body. Test 2 additionally needs `RUN TEST 2`. `run-all.sh` and test 7 are
  shown as commands only.
- Output streams over Server-Sent Events with a 15 s heartbeat and closes when the job ends. Logs are saved in
  `dashboard/out/ops/`.

## 7. What the dashboard can and cannot write

| Can write | Cannot write |
|---|---|
| `MintVAT` and `CastBallot` transactions (voter booth and batch) | Any other chaincode function, including `CreateCandidate` |
| `dashboard/data/*.json` (milestones, notes, `election.json`), `dashboard/out/` | Anything in `evidence/`, `network/`, `chaincode/`, `client-app/`, `test/` |
| New evidence folders, but only by launching a test script, which writes them itself | The ledger volumes, except through the typed-word Teardown |

## 8. API

| Route | Role | Purpose |
|---|---|---|
| `GET /api/auth/me`, `POST /api/auth/voter`, `/admin`, `/logout`, `GET /api/auth/sample-voters` | none | Sessions |
| `GET /api/voter/state`, `POST /mint`, `/seal`, `/cast` (SSE), `/batch`, `/logout` | voter | Booth |
| `GET /api/verify/results`, `/ballot/:id`, `/integrity?n=`, `/privacy`, `/drawer/:id`; `POST /privacy-probe` | none | Public verifier |
| `GET /api/admin/overview`, `/network/ops`, `/election`, `/blocks`, `/block/:n`, `/tests/meta`, `/logs`, `/logs/:name`, `/jobs/current` | admin | Console data |
| `POST /api/admin/network/run`, `/election/fresh`, `/election/lock`, `/election/batch`, `/tests/run` | admin | Commands (confirm required) |
| `GET /api/stream/job/:id` | admin (voter for batches) | Job output over SSE |
| `GET /api/stream/blocks` | admin | Live block tail over SSE |
| `GET /api/state`, `/api/live`, `GET/PUT /api/data/:file`, `POST /api/export/report`, `GET /out/:file`, `/evidence/**` | admin | Project records, carried over from D1 and D2 |

## 9. Project records (carried over)

Every D1 and D2 panel survives inside the admin console under "Project records", restyled, with its collector reused
unchanged: status, environment, toolchain, network (live), chaincode (live), deviations and blockers, timing trials,
tests, criteria, performance, contention probe, resources, recovery, figures, repo. The MISSING convention and the
MISSING counter are kept. Milestones and notes editors, the read-only `/evidence/` browser and the status-report export
still work. The parked demo panel (`collectors/demo.js`) is **retired**: the voter booth is the live demo. Its UI, its
collector and its call in `lib/live.js` are deleted.

## 10. Known limits

- Demo-grade access control (section 3).
- The simulated batch uses server-side generated keys per ballot; it measures the network, not a real polling station.
- Block cutting is 500 ms or 10 transactions (DEV-006), so the "Ordering" and "Validation" stages of the submit
  animation are separated by what the gateway API reports: `submit()` returns when the orderer accepts the transaction,
  and `getStatus()` returns when the peers commit it.
- After a node restart the gateway needs about 30 s for peers to re-gossip before MintVAT can find endorsers; the
  booth reports the network as not answering until then.
