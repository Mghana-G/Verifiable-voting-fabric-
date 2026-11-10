# Prompt for Sonnet: Dashboard v2 (Admin console, Voter booth, Public verifier)

Paste everything below the line into a fresh Claude Code session (Sonnet) started in `~/voting-network`.

---

## 0. Who you are and what you are doing

You are rebuilding `dashboard/` for a Hyperledger Fabric 2.5 e-voting prototype that is part of a BSc thesis
(Gift Mghana, 169774). The network, chaincode, client app, tests and evidence **already work and are frozen**.
Your job is only the dashboard: turn the current generic "project command centre" into a presentable,
three-role application that shows the system working end to end and sits beside the Chapter 5 write-up.

Read these first, in this order, before writing any code:

1. `CLAUDE.md` (hard rules; they all still apply)
2. `docs/HOW_IT_WORKS.md` (the definitive description of how everything works; sections 2, 3, 5 and 6 drive this build)
3. `IMPLEMENTATION_BRIEF.md` sections 1, 3 and 4
4. `docs/DEVIATIONS.md` (especially DEV-003 and DEV-005)
5. `docs/DASHBOARD_PLAN.md` and the whole of `dashboard/` (you will reuse a lot of it)
6. `client-app/lib/*.js`, `test/lib/vote.js`, `test/lib/gateway.js`, `verification-dashboard/lib/audit.js`

### 0.1 Frozen: never edit these

`network/` (every file, including scripts), `chaincode/`, `client-app/`, `test/`, `voter-generator/`,
`verification-dashboard/`, `evidence/` (never write, rename or delete; only tests you launch may add new timestamped
folders), `IMPLEMENTATION_BRIEF.md`, `MASTER_PLAN.md`, `docs/HOW_IT_WORKS.md`.
If you believe one of them must change, stop and write the reason in `docs/DEVIATIONS.md` instead.

### 0.2 Allowed to change

`dashboard/**`, `docs/DASHBOARD_PLAN.md` (rewrite it as v2), `docs/PROGRESS.md`, `docs/COMMANDS.md`,
`.gitignore` (only to add dashboard secrets or output paths).

### 0.3 Step zero

The working tree has uncommitted Phase D2 dashboard work. Before changing anything, commit it as a checkpoint:
`git add dashboard && git commit -m "dashboard: Phase D2 live panels (checkpoint before v2 rebuild)"`.
Then work on a branch `dashboard-v2`.

---

## 1. Facts about the running system (verified; do not rediscover)

| Item | Value |
|---|---|
| Channel / chaincode | `votingchannel` / `voting` (sequence 1, label `voting_1.0`) |
| Peers (host ports) | IEBC 7051, Judiciary 7061, CivilSociety 7071, Media 7081; CouchDB 5984 to 5987 (`admin:adminpw`) |
| Orderers | orderer1/2/3 on 7050/8050/9050, admin API 9443/9444/9445 (mutual TLS); etcdraft, crash fault tolerant |
| Containers | 17 from `network/docker-compose.yaml` plus 4 `cc-peer0-*-voting_1.0` chaincode containers |
| Endorsement policy | `OutOf(3, IEBC, Judiciary, CivilSociety, Media)` |
| Private collection | `voterIssuedCollection`, members IEBC and Judiciary only, `memberOnlyRead` and `memberOnlyWrite` true |
| Block cutting | BatchTimeout 500 ms, MaxMessageCount 10 (DEV-006). Chain height is over 25,000 blocks: never scan from block 0 |
| Polling-station identity | `User1@orgiebc.example.com` (what `client-app` uses) |
| Auditor identity | `User1@orgcivilsociety.example.com` (what `verification-dashboard` uses; the auditor is not IEBC) |
| Admin ABAC identity | `network/organizations/votingadmin/votingadmin/msp` (carries `role=admin`; only `CreateCandidate` needs it) |
| Registry | `voter-generator/registry.db`, table `voters(voter_id, salt, hash)`, 12,000 rows, IDs like `KE00001915` |
| Candidates on chain | C001 to C004 from `voter-generator/candidates.json` (global, not per election; there is **no chaincode function that reads a candidate**) |
| Chaincode errors | `ERR_NOT_ADMIN`, `ERR_DUPLICATE_ISSUANCE`, `ERR_VAT_NOT_ACTIVE`, `ERR_NONCE_USED`, `ERR_BAD_SIGNATURE`, `ERR_NO_CANDIDATE`. The text is in `err.details[i].message`, use `errorText()` logic from `test/lib/vote.js` |
| CastBallot result | JSON `{ballotID, vatID, candidateID, electionID, timestamp}`; `ballotID` and `vatID` are transaction IDs |
| Protobufs | `@hyperledger/fabric-protos` 0.3.7 is already in `dashboard/node_modules`; read its `index.d.ts` for the API |
| Tool env | `RUN_ENV` in `dashboard/lib/util.js` and `BASE_ENV` / `orgEnv()` in `dashboard/lib/fabric.js` already set PATH and FABRIC_CFG_PATH |
| Access | Dashboard listens on `127.0.0.1:5050` only, reached from Windows through `ssh -L 5050:localhost:5050` |

Keep the existing security middleware in `dashboard/server.js` (Host header check, Origin check on non-GET, CSP, no CDNs).

---

## 2. What to build

One Express app on 5050 with a landing page and three roles. Everything is offline (no CDN, no external fonts),
vanilla JS or a single vendored file you write yourself, no build step.

### 2.1 Landing page and sign-in

Three large tiles:

1. **Voter (polling station booth).** Sign in with a voter ID from the registry. Signing in *is* the off-chain
   verification step (HOW_IT_WORKS 3.1): the server calls `verifyVoter()` from `client-app/lib/registry.js`.
   A small "sample voter IDs" link shows five IDs not yet used in the current election, for demos.
2. **Administrator.** Password sign-in. The password comes from `DASHBOARD_ADMIN_PASSWORD` in `dashboard/.env`
   (gitignored); store only a scrypt hash in memory, compare with `crypto.timingSafeEqual`. If unset, the server
   refuses to start the admin role and says so on the tile.
3. **Public verifier.** No sign-in. Anyone can open it.

Sessions: in-memory store, random 32-byte ID, cookie `HttpOnly; SameSite=Strict; Path=/`. Every API route checks
the role on the server. Voter sessions expire 10 minutes after sign-in or immediately after a committed ballot.
State in the UI and in `docs/DASHBOARD_PLAN.md` that this is demo-grade access control for a local prototype,
not production authentication.

### 2.2 The mock election

Configuration in `dashboard/data/election.json`:

```json
{
  "electionID": "KE-PRES-2027-MOCK-01",
  "title": "Mock Presidential Election 2027",
  "pollingStationID": "PS-DASH-01",
  "candidates": ["C001", "C002", "C003"]
}
```

- Names and parties come from `voter-generator/candidates.json` at runtime (C001 Amara Ochieng, National Unity
  Party; C002 Jabari Kamau, People's Democratic Party; C003 Zawadi Muthoni, Progressive Alliance). Three
  presidential candidates on the ballot. C004 exists on chain but is not on this ballot; say so in the admin view.
- Do **not** call `CreateCandidate`. C001 to C003 already exist. If a cast fails with `ERR_NO_CANDIDATE`, show
  "candidates not loaded: run step 6 (06-init-candidates.sh) in Network control".
- Everything on chain is scoped by `electionID`, so "start a fresh mock election" in the admin console simply
  writes a new `electionID` (`...-MOCK-02`, and so on) into `election.json`. Earlier elections stay on the ledger
  and are listed as history. This is the only way to "reset"; never touch ledger volumes for it.
- "Close voting" is a dashboard-level lock only. The chaincode has no election lifecycle (HOW_IT_WORKS 6.7);
  label the lock "enforced by this dashboard, not by the chaincode".

### 2.3 Voter booth (role: voter)

A guided, full-screen stepper. Each step has a collapsible **"What happened on the network"** drawer (see 2.7).

1. **Verified.** Show that the registry hash was recomputed and matched: the first 12 hex of `voterHash` only.
   Text: the voter ID and salt stay on the polling-station machine; only the hash goes to the chain.
2. **Ballot token issued.** Server runs MintVAT exactly as `client-app/lib/vat.js` does: endorsing organisations
   `['OrgIEBCMSP','OrgJudiciaryMSP','OrgCivilSocietyMSP']` (DEV-003), polling-station identity. Show vatID
   (transaction ID), block number, validation code, and the three endorsing orgs. `ERR_DUPLICATE_ISSUANCE` shows
   "This voter has already been issued a ballot token in this election".
3. **Ballot.** Three candidate cards (initials avatar, name, party, colour band). Select one, then confirm.
4. **Seal and sign.** Build the payload with `buildPayload()` logic from `client-app/lib/ballot.js` and sign with
   `signBallot()` from `client-app/lib/ephemeral.js` (require these files directly so the dashboard runs the
   thesis client code, not a copy). Show the canonical payload, the ephemeral public key (PEM, collapsed), the
   signature, and "private key discarded".
5. **Submitting.** Submit `CastBallot` with the six arguments in brief order, **without** `endorsingOrganizations`
   (same as `client-app`). Use the fabric-gateway step API (`newProposal` then `endorse()`, `submit()`,
   `getStatus()`) so the UI can animate four real stages: Endorsement (3 of 4 peers simulate and sign) then
   Ordering (Raft cuts a block within 500 ms) then Validation (policy and MVCC) then Committed. Stream stage
   events to the browser with Server-Sent Events.
6. **Receipt.** ballotID, block number, validation code `VALID`, timestamp, election. Buttons: "Verify on the
   public portal" (opens the verifier's ballot lookup with the ID filled in) and "Print receipt".
   Rejections show the named chaincode error in plain English (map every code in section 1).

If MintVAT committed but CastBallot failed for a transport reason, keep the vatID **in the in-memory session only**
and offer "retry cast". Never write it to disk.

**Secrecy rule (critical):** never persist anything that links `voter_id` or `voterHash` to `vatID`, `ballotID`
or `candidateID`, in files, logs or `dashboard/out/`. The only voter-side persistence allowed is the count of
votes cast through the dashboard per election.

**Batch button: "Simulate 20 voters at this polling station".** Shown in the booth header (polling-station mode)
and also in the admin Election panel. Server side:

- Picks the next 20 registry voters not yet used by the dashboard in this election (track only an integer offset
  per election in `dashboard/out/election-state.json`; on `ERR_DUPLICATE_ISSUANCE` skip to the next voter).
- Verifies each hash, mints with up to 5 concurrent mints, then **casts strictly one at a time** (DEV-005: the
  single TALLY and BURNEDCOUNT keys conflict under concurrency; say so in the UI with a link to the explanation).
- Candidate choice per simulated voter is random across the three (client-side randomness is fine; never in
  chaincode). Keys are generated server-side per ballot with `signBallot()`; label these "simulated voters".
- Live progress table over SSE: n of 20, short txID, block, latency ms, result. Finish with totals, mean latency,
  ballots per second, and a fresh `GetAuditInvariant`.
- Configurable count (default 20, cap 100). Only one batch at a time; refused while a network operation runs.

### 2.4 Admin console (role: admin)

Left navigation, top status strip (network up or down, block height, peers in sync, Raft leader, current election,
invariant OK). Sections:

1. **Overview.** An SVG topology diagram: four organisation boxes (peer plus CouchDB plus CA each), the ordering
   service box with three Raft nodes and the leader marked, the channel joining them, the chaincode containers.
   Each node is coloured by live state. Below it: per-peer heights, blocks per minute over the last 10 minutes,
   current election tally mini-chart, invariant badge. Reuse `collectors/network.js` and `lib/gw.js`.
2. **Network control** (the "one place to run everything"). A vertical runbook of the bring-up from
   HOW_IT_WORKS section 2, one card per step: 00 prereqs, 01 crypto, 02 genesis block, 03 compose up,
   04 create channel, health check, 05 deploy chaincode, 06 load candidates. Plus **Start nodes**
   (`docker compose start`, non-destructive, already in `lib/ops.js`), **Stop nodes** (`docker compose stop`,
   non-destructive, ledgers kept) and **Teardown** (`99-network-down.sh`).
   Each card shows: what the script does and what it produces (one or two lines taken from HOW_IT_WORKS
   section 2), the exact command, a Run button, a live log pane (SSE), exit code, duration, and a link to the
   saved log in `dashboard/out/ops/`.
   Safety gates, enforced on the server:
   - A fixed whitelist maps an operation name to one script; no arguments ever come from the page.
   - One operation at a time; voting and batches are refused while one runs.
   - 01, 02, 03 and 04 are disabled while any network container is running (they would destroy or clash with a
     live network). Explain why on the disabled button.
   - 05 shows "this will commit chaincode sequence N+1" before running.
   - Teardown requires typing `TEARDOWN`, and warns that it deletes every ledger volume, that block numbers cited in
     `evidence/` will no longer exist on the new chain, and that a full 01 to 06 rebuild follows.
   - Commands need confirm `true` in a JSON body (keep the existing `guarded()` pattern).
3. **Chaincode.** Committed definition, endorsement policy, collection config, approvals (already decoded in
   `lib/gw.js committedDefinition`). The six functions with their argument order and the CastBallot check order
   table from HOW_IT_WORKS 3.4.
4. **Election.** Current election, the three candidates, live tally and invariant, start a fresh mock election,
   close or reopen voting (dashboard lock), batch button, history of previous mock election IDs with their final
   tallies.
5. **Ledger explorer.** Latest blocks first, paginated (20 per page, plus "jump to block"). Live tail via
   `network.getBlockEvents()` from the current height, pushed over SSE. Per block: number, time, tx count, data
   hash, previous hash. Per transaction: txID, function name, validation code with its label (use the code table
   in `test/lib/blockchain.js`), creator MSP, endorsing MSPs, decoded arguments, public write set keys
   (composite keys shown with `~` in place of the NUL delimiter), and private collection writes shown as
   "hashed only" with their hashes. A filter "this election only" (parse the electionID from the CastBallot
   payload argument or MintVAT argument). Read blocks with qscc `GetBlockByNumber` through the auditor identity so
   the `TRANSACTIONS_FILTER` is populated (HOW_IT_WORKS 3.6 step 3). Cache decoded blocks in memory (LRU 500).
   Mark CastBallot rows that show both vatID and candidateID with an info icon: "this link is public on the
   channel by design; see HOW_IT_WORKS 5.3".
6. **Tests and evidence.** Reuse the D1 collectors (`tests.js`, `criteria.js`, `performance.js`): one card per
   test with what it attacks, what stops it (the layer: chaincode check N, MVCC, platform duplicate txID,
   endorsement policy), latest result, pass or fail, link into `/evidence/`. Run buttons for the quick tests only:
   1a, 1b, 4a, 4b, 5, 6, and 3 with a count box (default 50). Test 2 gets a button behind a typed `RUN TEST 2`
   confirm and a warning that it stops the Media peer and that `rebuild-dbs` replay took about 45 minutes on the
   current chain. Do not offer `run-all.sh` or test 7 as buttons; show their commands with a copy button instead.
   Tests write their own evidence folders; the dashboard never writes in `evidence/`.
7. **Logs.** `docker logs --tail 200` for a container chosen from the whitelisted 17 plus chaincode containers.
8. **Project records (carried over from D1 and D2, nothing dropped).** Every existing panel survives, restyled
   to the new design, with its collector reused as is (`collectors/*.js` keep their current output shapes):
   - Environment: host spec, guest resources, OS and kernel, toolchain versions against MASTER_PLAN A.4
     (`environment.js`).
   - Build history: phases from `docs/PROGRESS.md`, last 15 commits (`build.js`).
   - Deviations and blockers: DEV-001 to DEV-006 with status, open or resolved blockers (`deviations.js`).
   - Success criteria 1 to 9 from `evidence/SUMMARY.md` (`criteria.js`), linked to the test cards.
   - Performance: test 7 scales, concurrency probe, BatchTimeout trials, docker stats ranges, CouchDB size
     (`performance.js`), drawn as proper charts (latency by scale, throughput by scale).
   - Screenshots: expected Chapter 5 figure files against files present (`screenshots.js`).
   - Milestones and notes editors (`PUT /api/data/<file>`), the read-only `/evidence/` browser, and the
     status-report export (`POST /api/export/report`, `lib/report.js`).
   - The parked demo panel (`collectors/demo.js`) is retired: the voter booth is the live demo. Delete its UI and
     its call in `lib/live.js`, and say so in `docs/DASHBOARD_PLAN.md`.
   Keep the MISSING convention (a missing file or field shows MISSING in red with the reason) and the status
   counter of MISSING fields. `/api/state` stays available to the admin role and still writes
   `dashboard/out/state.json`.
9. **Report companion.** The Chapter 5 figure and table map from `data/figures.json`, each entry linking to the
   live panel that is its source. A **Presentation mode** toggle (hides navigation and debug detail, larger type,
   clean white background) for taking thesis screenshots.

### 2.5 Public verifier (no sign-in)

Uses only the auditor identity (CivilSociety) and only evaluate or qscc reads. Sections:

1. **Results.** Bar chart for the three candidates, total ballots, and the audit invariant
   (`burnedCount == tallyTotal`) as a large tick or cross. Plus **"Four peers agree"**: run `GetTally` and
   `GetAuditInvariant` separately against each of the four peers (one gateway connection per org, as
   `lib/gw.js` already does) and show the four results side by side with an agreement badge. This is the
   positive form of test 2.
2. **Verify my ballot.** Enter a ballotID (transaction ID). Use qscc `GetTransactionByID` (validation code and
   envelope) and `GetBlockByTxID` (block number). Decode the write set and show the `BALLOT~ballotID` record from
   the block itself: candidate, election, timestamp, and "counted" if the code is VALID. A non-existent ID or an
   invalid code is shown plainly.
3. **Chain integrity.** For the latest N blocks (default 50), recompute and check in the server:
   - data hash: SHA-256 of the concatenation of `block.data.data` entries equals `header.data_hash`;
   - header hash: SHA-256 of the ASN.1 DER encoding of `SEQUENCE { INTEGER number, OCTET STRING previous_hash,
     OCTET STRING data_hash }` equals the next block's `previous_hash`.
   Draw the result as a chain of linked blocks, green links where they match. Validate your encoder against the
   live chain first: if links do not match on an untouched chain, your encoding is wrong, not the chain.
4. **Privacy check.** Show the public view of a recent MintVAT transaction: the VOTERISSUED write appears only as a
   hashed private write set. Optionally a "run read probe" button that evaluates (never submits) the MintVAT read
   as CivilSociety and shows the refusal message, reproducing HOW_IT_WORKS 5.2. State what this proves and what
   it does not (UNKNOWN 5).
5. **What this verification does and does not prove.** A short honest box drawn from HOW_IT_WORKS section 6:
   the invariant is a consistency check, not an independent count (item 11); a VAT is not bound to its election
   at cast time (item 6); the signature proves integrity, not identity (item 9); the receipt lets a voter prove
   their choice to someone else (no receipt-freeness, future work). Never overclaim.

### 2.6 Shared server design

- Split `server.js` into routers: `routes/auth.js`, `routes/voter.js`, `routes/admin.js`, `routes/verify.js`,
  `routes/stream.js` (SSE).
- New libs: `lib/session.js`, `lib/station.js` (write path: MintVAT and CastBallot only, polling-station identity,
  one persistent connection, no other function allowed), `lib/blocks.js` (qscc reads, block and transaction
  decoding, hash checks, LRU cache), `lib/jobs.js` (single-lock job runner for scripts, tests and batches with an
  SSE log stream; extend `lib/ops.js` rather than duplicating it), `lib/election.js`.
- Keep `lib/gw.js` read-only, and add only qscc `GetBlockByNumber`, `GetTransactionByID`, `GetBlockByTxID` to
  its whitelist. The only module that can submit is `lib/station.js`, and only `MintVAT` and `CastBallot`.
- Keep the existing MISSING / unavailable conventions: a value that cannot be read is shown as unavailable with
  the reason, never as a made-up number.
- Every SSE stream sends a heartbeat every 15 s and closes cleanly when the job ends.

### 2.7 "What happened on the network" drawers (report alignment)

Each voter step, each runbook card and each explorer transaction can open a drawer showing:
- the plain-English explanation (one paragraph, from HOW_IT_WORKS);
- the **actual source lines** being exercised, read from disk at request time by locating the function by name
  (for example `MintVAT` in `chaincode/voting/lib/votingContract.js`, `signBallot` in
  `client-app/lib/ephemeral.js`), with file path and current line numbers. Never hard-code line numbers;
- the keys read and written (tables from HOW_IT_WORKS 3.2 and 3.5).
This is what makes the dashboard go hand in hand with the report: the text on screen and the code on screen cannot
drift apart.

---

## 3. Visual design

Presentable enough for a viva projector and for Chapter 5 screenshots.

- Light theme default, dark theme toggle, both defined as CSS custom properties on `:root`.
- Typography: system UI stack, 15 px base, tabular numerals for hashes, heights and counts; monospace only for
  IDs, hashes and code.
- Colour: neutral greys plus one accent; status colours green (valid or up), amber (degraded or pending), red
  (invalid or down). Each role has a subtle header tint so screenshots show which view is which: Admin slate,
  Voter green, Verifier blue. Candidate colour bands: three distinct, colour-blind-safe hues, never red or green.
- Hashes and IDs: show first 8 and last 6 characters with a copy button, full value on hover.
- Motion only where it explains something: the four-stage submit pipeline and new blocks sliding into the explorer.
  Respect `prefers-reduced-motion`.
- Works at 1366 x 768 (projector) and down to 390 px wide. No horizontal page scroll.
- Every empty, loading, error and network-down state is designed, not left blank.

---

## 4. Order of work and acceptance checks

Do these as separate commits. After each phase add one line to `docs/PROGRESS.md` and any new non-trivial command
to `docs/COMMANDS.md`. British English, no em dashes, Raft is "crash fault tolerant".

1. **Shell and auth.** Landing page, three roles, sessions, role guard. Check with curl: voter and admin APIs return
   401 without a session; the verifier API answers without one.
2. **Voter booth.** Sign in with a real registry ID, mint, choose, sign, cast, receipt. Check: one real vote on the
   live network commits VALID, `GetAuditInvariant` for the mock election goes up by one on both sides, and a second
   sign-in with the same voter shows the duplicate issuance message.
3. **Batch.** 20 simulated voters commit, the table streams live, the invariant equals the number cast, no file in
   `dashboard/out/` contains a voter ID or voter hash (grep for it).
4. **Explorer and verifier.** The receipt's ballotID verifies on the public portal; the chain integrity check passes
   for the latest 50 blocks; the four-peer agreement shows four identical tallies.
5. **Admin control.** Health check and Start nodes stream logs; with the network running, 01 to 04 are disabled
   with the reason shown; Teardown refuses without the typed word. **Do not actually run Teardown, 01, 02, 03 or 04
   during development**: test their gates only. Stop and Start nodes may be tested once, then confirm the health
   check returns 11 of 11.
6. **Tests panel, project records, report companion, presentation mode, polish.** Run test 5 from the dashboard once
   and confirm a new evidence folder appears and the card updates. Open every carried-over panel from section 2.4
   item 8 and compare it with the old dashboard (checkpoint commit): every field the old page showed is still
   shown, and `/evidence/`, milestones, notes and the report export still work.
7. **Docs.** Rewrite `docs/DASHBOARD_PLAN.md` as v2 (purpose, roles, rules, what the dashboard can and cannot write
   to the ledger, safety gates, API table). Update `dashboard/README.md` (how to set the admin password, run, tunnel).

If a Fabric error is not resolved after two attempts, follow the "When stuck" rule in `CLAUDE.md`.

## 5. Things you must not do

- Edit anything in section 0.1.
- Call `CreateCandidate`, or submit any chaincode function other than `MintVAT` and `CastBallot`.
- Cast ballots concurrently.
- Store voter-to-ballot links anywhere.
- Load anything from a CDN or the internet.
- Scan the chain from block 0.
- Describe Raft as Byzantine fault tolerant, or mention gas, mining or proof of work.
