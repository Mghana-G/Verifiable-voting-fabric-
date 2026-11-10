# How the system works: an oral-defence reference

Written 2026-10-25 from the repository as committed plus the live network. Every claim cites a file
path (and line numbers where the code is quoted). Where the repository does not let me decide a
point, the text says **UNKNOWN**. Line numbers are those of the files at the time of writing; if a
file changes, re-check the numbers before quoting them.

Conventions: paths are relative to the repository root. "Platform behaviour" means behaviour of
Hyperledger Fabric 2.5.12 itself, whose source is not in this repository; for those points the only
proof offered is the evidence file named beside the claim.

Contents

1. Repo map
2. Network bring-up
3. One vote, end to end
4. The tests
5. Ballot secrecy
6. Known limits
7. Scenario questions
8. UNKNOWN items

---

## 1. Repo map

Generated or ignored material is listed last in each subsection and is not source: see
`.gitignore`. 

### 1.1 Root and docs

| File | What it does | Used by |
|---|---|---|
| `.env` (root) | Four lines: `FABRIC_VERSION`, `CA_VERSION`, `COMPOSE_PROJECT_NAME=voting-network`, `COUCHDB_IMAGE`. | No file in the repository refers to it by path (searched with grep). `MASTER_PLAN.md` line 89 lists it in the layout. Docker Compose is run from `network/`, which has its own `.env`. UNKNOWN whether anything reads the root copy. |
| `.gitignore` | Excludes `network/organizations/`, `network/channel-artifacts/`, `node_modules/`, `voter-generator/registry.db`, `network/voting.tar.gz`. | Git. |
| `docs/COMMANDS.md` | Every non-trivial command run, including the bring-up order (lines 65 to 81, 274 to 281). | Humans; `dashboard/data/figures.json` refers to scripts named in it. |
| `docs/DEVIATIONS.md` | DEV-001 to DEV-006: every departure from the brief with its reason. | `dashboard/collectors/deviations.js`, `environment.js`. |
| `docs/PHASE4_DECISIONS.md` | Design decisions E.1 to E.4 for the test suite. | Cited by `test/test2-*.js`, `test3-*.js`, `test4a-*.js`, `test6-*.sh`, `test/lib/blockchain.js`. |
| `docs/HOW_IT_WORKS.md` | This file. | Nothing. |

### 1.2 `network/` (Fabric infrastructure)

| File | What it does | Used by |
|---|---|---|
| `network/.env` | Image versions (`FABRIC_VERSION=2.5.12`, `CA_VERSION=1.5.15`, `couchdb:3.3`), project name `voting`, host ports (peers 7051/7061/7071/7081). | `docker compose` when run from `network/`; `docker-compose.yaml` via `${...}`; `dashboard/collectors/environment.js` (expected images). |
| `network/crypto-config.yaml` | Declares OrgOrderer (3 orderers) and four peer orgs (1 peer, 2 users each, NodeOUs on). | `scripts/01-generate-crypto.sh` (cryptogen). |
| `network/configtx.yaml` | Org definitions and policies (lines 1 to 103), etcdraft consenters and batching (135 to 160), profile `VotingChannel` (193). | `scripts/02-generate-artifacts.sh` (configtxgen). |
| `network/docker-compose.yaml` | 17 services: 4 CouchDB, 5 CA, 3 orderers, 4 peers, 1 `cli`; network `voting_votingnet`. | `scripts/03-network-up.sh`, `99-network-down.sh`, `dashboard/lib/ops.js` (start), `test/lib/peerlifecycle.js` (restart of a peer container). |
| `network/collections_config.json` | The single private data collection `voterIssuedCollection`. | `scripts/05-deploy-chaincode.sh` line 18, 142, 154, 169. |
| `network/scripts/00-prereqs.sh` | Checks tool versions against MASTER_PLAN A.4; exits on first mismatch. | `dashboard/collectors/environment.js` re-evaluates its `check` lines. |
| `network/scripts/01-generate-crypto.sh` | Runs cryptogen, copies each CA cert and key into `organizations/fabric-ca/<org>/`. | Manual; order in `docs/COMMANDS.md` 65. |
| `network/scripts/02-generate-artifacts.sh` | Runs configtxgen to write the channel genesis block. | Manual. |
| `network/scripts/03-network-up.sh` | `docker compose up -d`, then waits for peer and orderer ports. | Manual. |
| `network/scripts/04-create-channel.sh` | `osnadmin channel join` on three orderers, then `peer channel join` for four peers. | Manual; sources `env-peer.sh`. |
| `network/scripts/05-deploy-chaincode.sh` | `npm test`, package, pre-build image, install, approve x4, commit. | Manual; sources `env-peer.sh`; uses `collections_config.json`. |
| `network/scripts/06-init-candidates.sh` | Enrols `votingadmin` (attribute `role=admin`) at the IEBC CA, invokes `CreateCandidate` per entry of `voter-generator/candidates.json`, then `GetTally`. | Manual; sources `env-peer.sh`. |
| `network/scripts/99-network-down.sh` | `docker compose down --volumes --remove-orphans`, removes leftover chaincode containers and images. | Manual. Destroys ledger volumes. |
| `network/scripts/env-peer.sh` | Defines `setPeer <IEBC|Judiciary|CivilSociety|Media>` which exports `CORE_PEER_*` for the org Admin. | `04`, `05`, `06`, `health-check.sh`, `test/test6-invalid-endorsement.sh`, `demo/shots.sh`. |
| `network/scripts/health-check.sh` | 11 checks: 4 CouchDB `_up`, 4 peers on channel, 3 orderers via `osnadmin channel list`. | `dashboard/lib/ops.js`, `demo/shots.sh`. |
| `network/scripts/chaincode-run-builder.sh` | External builder `run` step: starts the pre-built chaincode image through the host Docker socket and passes TLS material. | Bind-mounted into each peer as `/builders/node-docker/bin/run` (`docker-compose.yaml` peer volumes). |
| `network/scripts/node-docker-builder/detect` | Accepts a package whose `metadata.json` type is `node`. | Bind-mounted into each peer. |
| `network/scripts/node-docker-builder/build` | Deliberate no-op (DEV-001/002: peer's Docker client cannot call Docker 29.x build API). | Bind-mounted into each peer. |
| `network/scripts/phase0-fix.sh`, `phase0-complete.sh`, `phase0-complete-gate.sh` | One-off Phase 0 repairs (fabric-samples path, disk, test-network proof). | Nothing; `dashboard/collectors/environment.js` mentions the evidence they produced. |
| Generated | `network/organizations/` (all MSPs and TLS), `network/channel-artifacts/votingchannel.block`, `network/voting.tar.gz`. | Created by `01`, `02`, `05`. |

### 1.3 `chaincode/voting/`

| File | What it does | Used by |
|---|---|---|
| `index.js` | Exports `VotingContract` (5 lines). | `fabric-chaincode-node start` (`package.json` "start"). |
| `lib/votingContract.js` | The six functions: `CreateCandidate` 38, `MintVAT` 49, `CastBallot` 72, `GetAuditInvariant` 144, `GetTally` 163, `GetBlockAudit` 179. | `index.js`; `test/*.js` call it by name. |
| `lib/keys.js` | Composite-key builders: CANDIDATE, VAT, BALLOT, TALLY, BURNEDCOUNT, NONCE, VOTERISSUED (lines 3 to 17). | `votingContract.js`; `test/lib/couchdb.js` re-implements the encoding to find a document. |
| `lib/errors.js` | Six named errors (lines 3 to 8). | `votingContract.js`; tests match these strings in `result.json`. |
| `lib/crypto.js` | `canonicalise` (8 to 12) and `verifySignature` (18 to 26). | `votingContract.js`; copied verbatim to `client-app/lib/ephemeral.js`, `test/lib/vote.js`, `test/lib/harness.js`. |
| `test/votingContract.spec.js` | Mocha unit tests against a stubbed ledger; 20 `it` blocks (by grep), including one per validation step (lines 223, 246, 269, 291). | `npm test`; run by `05-deploy-chaincode.sh` line 40. |
| `package.json` | Pins `fabric-contract-api` and `fabric-shim` 2.5.4; "test" = `mocha --timeout 10000 test/`. | npm. |

### 1.4 `client-app/` (polling-station simulator)

| File | What it does | Used by |
|---|---|---|
| `index.js` | Express on port 3000: `/verify`, `/mint`, `/cast`, `/health` (lines 14 to 18). No authentication middleware. | Run by hand. |
| `routes/verify.js` | `POST /verify {voter_id}` calls `verifyVoter`. | `index.js`. |
| `routes/mint.js` | `POST /mint {hash, electionID, pollingStationID}` calls `mintVAT`. Does not call `verifyVoter` (lines 9 to 15). | `index.js`. |
| `routes/cast.js` | `POST /cast {vatID, candidateID, electionID}` calls `castBallot`. | `index.js`. |
| `lib/registry.js` | Read-only SQLite handle on `voter-generator/registry.db`; `verifyVoter` recomputes the hash (25 to 31). | `routes/verify.js`. |
| `lib/vat.js` | `mintVAT`: builds the `MintVAT` proposal naming three endorsing orgs (15 to 21). | `routes/mint.js`. |
| `lib/ballot.js` | `buildPayload` (10 to 15), `castBallot` (17 to 37). | `routes/cast.js`. |
| `lib/ephemeral.js` | `canonicalise` copy and `signBallot` (18 to 32). | `lib/ballot.js`. |
| `lib/gateway.js` | fabric-gateway connection as `User1@orgiebc` to `localhost:7051` (11 to 61). | `lib/vat.js`, `lib/ballot.js`. |

### 1.5 `voter-generator/`

| File | What it does | Used by |
|---|---|---|
| `generate.py` | Builds `registry.db` table `voters(voter_id, salt, hash)`; salt `secrets.token_hex(16)` (line 65), hash `sha256(voter_id + salt)` (line 66); Faker seeded with 169774. | Manual; `test/lib/harness.js` prints the command. |
| `candidates.json` | Candidates C001 to C004. | `network/scripts/06-init-candidates.sh` line 19. |
| `requirements.txt` | Python dependencies. | pip. |
| `registry.db` (generated, ignored) | The off-chain registry. | `client-app/lib/registry.js`, `test/lib/voters.js`, `test/lib/harness.js`. |

### 1.6 `test/`

| File | What it does | Used by |
|---|---|---|
| `run-all.sh` | Runs 1a, 1b, 3, 4a, 4b, 5, 6, then 2, three runs each (lines 104 to 111); stops on first failure and appends to `docs/BLOCKERS.md`; then `lib/summarize.js`. Never runs test 7 (line 4 to 8). | Manual. |
| `test1a-double-voting-sequential.js` | Test 1a. | `run-all.sh`. |
| `test1b-double-voting-concurrent.js` | Test 1b. | `run-all.sh`. |
| `test2-insider-modification.js` | Test 2. | `run-all.sh` (last). |
| `test3-parity-audit.js` | Test 3. | `run-all.sh`. |
| `test4a-replay-byte-identical.js`, `test4b-replay-argument-tuple.js` | Tests 4a, 4b. | `run-all.sh`. |
| `test5-tampered-ballot.js` | Test 5. | `run-all.sh`. |
| `test6-invalid-endorsement.sh` | Test 6 (bash, `peer chaincode invoke`). | `run-all.sh` via `run_sh_test`. |
| `test7-performance.js` | Test 7: `sweep <scales>` or `probe <scale>` (`docs/COMMANDS.md` 300 to 301). | Manual only. |
| `smoke-phase2.js` | Phase 2 smoke: MintVAT, CastBallot, GetAuditInvariant via the `peer` CLI with the `votingadmin` identity. | Manual (`docs/COMMANDS.md` 115). |
| `lib/harness.js` | 50-vote end-to-end driver, the shortest complete vote flow (lines 87 to 133). | Manual (`docs/COMMANDS.md` 183). |
| `lib/vote.js` | `canonicalise`, `signPayload`, `buildCastArgs`, `mintVAT`, `submitAndGetStatus`, `errorText`. | Every JS test. |
| `lib/gateway.js` | `connectAs(org)` for any of four orgs. | Every JS test. |
| `lib/voters.js` | `loadVoters(count, offset)` from `registry.db`. | Every JS test. |
| `lib/evidence.js` | Writes `evidence/<test>/<timestamp>/` files and docker logs. | Every test. |
| `lib/blockchain.js` | `peer channel getinfo` height; fetch and decode a block from a peer (lines 62 to 120). | Tests 1a, 1b, 2, `decode-last-block.js`. |
| `lib/couchdb.js` | Direct CouchDB HTTP: read and overwrite a state document. | Tests 2, 7. |
| `lib/peerlifecycle.js` | Stop a peer, `peer node rebuild-dbs`, restart. | Test 2. |
| `lib/concurrency.js` | `mapConcurrent` bounded pool. | Tests 3, 7. |
| `lib/monitoring.js` | Disk free and `docker stats` sampler. | Test 7. |
| `lib/gen-castballot-invoke.js` | Mints a VAT and prints a valid CastBallot invoke JSON. | Test 6. |
| `lib/get-tally.js`, `lib/decode-last-block.js` | Print the tally / the last block's validation codes as JSON. | Test 6. |
| `lib/summarize.js` | Writes `evidence/SUMMARY.md` mapping brief 6.1 criteria 1 to 9 to evidence. | `run-all.sh` line 115. |
| `package.json` | Test dependencies. | npm. |

### 1.7 `verification-dashboard/` and `demo/`

| File | What it does | Used by |
|---|---|---|
| `verification-dashboard/index.js` | Express on port 4000; `/api/audit` evaluates only (comment at line 12). | Run by hand. |
| `verification-dashboard/lib/audit.js` | Block listener, `GetAuditInvariant`, `GetTally`, code names 0/10/11 (lines 19 to 27). | `index.js`. |
| `verification-dashboard/lib/gateway.js` | Gateway as `OrgCivilSocietyMSP` (line 13): the auditor is not an IEBC identity. | `audit.js`. |
| `verification-dashboard/public/index.html` | Page showing invariant, tally, block window. | `index.js`. |
| `demo/shots.sh` | Prints a banner, runs one real command, waits for Enter (for thesis screenshots). | Manual. |

### 1.8 `dashboard/` (project command centre; D1 committed, D2 uncommitted)

| File | What it does |
|---|---|
| `server.js` | HTTP server: `/api/state` (files), `/api/live` (network, 5 s deadline), two guarded operations. |
| `lib/util.js` | Read-only helpers and the MISSING marker. |
| `lib/fabric.js` | Whitelist of read-only peer commands and chaincode queries. |
| `lib/gw.js` | Persistent read-only fabric-gateway client (evaluate of three functions only). |
| `lib/live.js` | Combines network, chaincode, demo collectors; keeps last good reading in `dashboard/out/`. |
| `lib/ops.js` | Start network (`docker compose start`) and run `health-check.sh`; no stop, down, rebuild or test-run. |
| `lib/proto.js` | Minimal protobuf reader for the committed policy and collection members. |
| `lib/report.js` | Writes `dashboard/out/status-report.md`. |
| `collectors/environment.js` `build.js` `deviations.js` `tests.js` `criteria.js` `performance.js` `screenshots.js` | File-based panels (host, toolchain, phases, DEV list, test cards, criteria, timings, figures). Read `MASTER_PLAN.md`, `docs/`, `evidence/`. |
| `collectors/network.js` `chaincode.js` `demo.js` | Live panels 3, 4, 14; BatchTimeout comes from the decoded channel config (header of `network.js`). |
| `public/index.html`, `public/app.js` | Single-page UI. |
| `data/figures.json`, `milestones.json`, `notes.json` | Static expectations and notes. |
| `README.md`, `package.json` | Run instructions, dependencies. |

The dashboard never writes to the ledger: `lib/fabric.js` header and `collectors/chaincode.js` header
say queries only.

---

## 2. Network bring-up

Run from `network/`. The order is fixed by `docs/COMMANDS.md` lines 65 to 71 and 274 to 281 and by
the data dependencies shown below. Chaincode steps need a running channel; candidates need a
committed chaincode.

| Step | Script | Command that does the work | Produces |
|---|---|---|---|
| 0 (optional) | `scripts/00-prereqs.sh` | `check "<label>" "<cmd>" "<expected>"` lines | PASS/FAIL per tool. |
| 1 Crypto material | `scripts/01-generate-crypto.sh` | line 21: `cryptogen generate --config=crypto-config.yaml --output=organizations`; lines 24 to 50 copy each CA cert/key to `organizations/fabric-ca/<org>/ca.crt, ca.key` | `network/organizations/ordererOrganizations/`, `peerOrganizations/`, `fabric-ca/`. Line 14 first wipes old output with a busybox container, because containers can leave root-owned files. |
| 2 Genesis / channel config | `scripts/02-generate-artifacts.sh` | lines 15 to 18: `configtxgen -profile VotingChannel -channelID votingchannel -outputBlock channel-artifacts/votingchannel.block` | Genesis block with the etcdraft consenters, 500 ms BatchTimeout and application policies (`configtx.yaml` 125 to 129, 135 to 160, 193 to 207). No system channel: orderers start with `ORDERER_GENERAL_BOOTSTRAPMETHOD=none` and `ORDERER_CHANNELPARTICIPATION_ENABLED=true` (`docker-compose.yaml`, orderer environment). |
| 3 Compose up | `scripts/03-network-up.sh` | line 14: `docker compose up -d`; lines 18 to 29 `nc -z` wait on ports 7051/7061/7071/7081 and 7050/8050/9050 | 17 containers (`docker-compose.yaml`). Peers start only after their CouchDB reports healthy (`depends_on ... service_healthy`, peer block). |
| 4a Orderers join | `scripts/04-create-channel.sh` | lines 27, 36, 45: `osnadmin channel join --channelID votingchannel --config-block ... --orderer-address localhost:9443 / 9444 / 9445` with mutual TLS | Three Raft nodes on the channel. Line 54: `sleep 10` for leader election. |
| 4b Peers join | same script | lines 57 to 60: `setPeer <org>; peer channel join -b <block>` for IEBC, Judiciary, CivilSociety, Media | Four peers on `votingchannel`. |
| Check | `scripts/health-check.sh` | CouchDB `_up` (line 25), `peer channel getinfo -c votingchannel` (37), `osnadmin channel list` (56) | 11 of 11 checks. |
| 5a Unit tests | `scripts/05-deploy-chaincode.sh` | line 40: `npm --prefix chaincode/voting test` | Aborts the deploy on failure (`set -e`, line 4). |
| 5b Package | same | lines 45 to 48: `peer lifecycle chaincode package voting.tar.gz --path chaincode/voting --lang node --label voting_<seq>.0` | `network/voting.tar.gz`. Sequence = committed sequence + 1 (lines 31 to 35). |
| 5c Pre-build image | same | lines 55 to 90: write an entrypoint and Dockerfile, `docker build -t voting-chaincode-base:<sha256>`, tag per peer as `dev-<peer>-<label>:<sha256>` | Image that `chaincode-run-builder.sh` starts (DEV-001: peer's own Docker client cannot build on Docker 29.x). |
| 5d Check builder | same | lines 101 to 109: `docker exec` tests `detect`, `build`, `run` and `docker` exist in each peer | Fails fast if bind mounts missing. |
| 5e Install | same | lines 112 to 117: `peer lifecycle chaincode install voting.tar.gz` for each of four orgs | Package installed on each peer. |
| 5f Approve | same | lines 129 to 143: `peer lifecycle chaincode approveformyorg ... --signature-policy "OutOf(3,'OrgIEBCMSP.peer','OrgJudiciaryMSP.peer','OrgCivilSocietyMSP.peer','OrgMediaMSP.peer')" --collections-config collections_config.json` for each org | Four approvals (the channel-level `LifecycleEndorsement` is `MAJORITY Endorsement`, `configtx.yaml` 125 to 127). |
| 5g Commit | same | lines 160 to 173: `peer lifecycle chaincode commit ... --peerAddresses` for all four peers | Chaincode `voting` definition on the channel; line 178 `querycommitted`. |
| 6 Candidates | `scripts/06-init-candidates.sh` | lines 36 to 60 enrol `votingadmin` at `ca-orgiebc` with attribute `role=admin:ecert` (line 48); lines 88 to 97 `peer chaincode invoke ... CreateCandidate` per candidate; line 105 `peer chaincode query ... GetTally` | CANDIDATE keys C001 to C004 (`voter-generator/candidates.json`). The admin attribute is required by `votingContract.js` 39 to 42; cryptogen certificates do not carry it (header of `06`). |
| Voter registry (any time before voting) | `voter-generator/generate.py` | `python3 generate.py --count 12000 --seed 169774` | `voter-generator/registry.db`. |
| Teardown | `scripts/99-network-down.sh` | line 12 `docker compose down --volumes --remove-orphans` | Ledger volumes destroyed. |

---

## 3. One vote, end to end

The trace follows `client-app/` (the real path) and notes where `test/lib/harness.js` does the same
thing in one function (lines 87 to 133). All chaincode line numbers are in
`chaincode/voting/lib/votingContract.js` unless stated.

### 3.1 Registry lookup and hashing (off-chain)

`voter-generator/generate.py` created the registry. Per voter it stored a salt and a hash:

```
65:        salt     = secrets.token_hex(16)
66:        h        = hashlib.sha256((voter_id + salt).encode()).hexdigest()
```

`POST /verify` calls `verifyVoter` (`client-app/lib/registry.js`):

```
28:    const computed = crypto.createHash('sha256').update(voter_id + row.salt).digest('hex');
29:    if (computed !== row.hash) return { ok: false };
30:    return { ok: true, hash: row.hash };
```

The `hash` is what goes on-chain as `voterHash`. The voter_id and salt never leave the client
machine. Nothing forces `/mint` to follow `/verify` (`client-app/routes/mint.js` 9 to 15 takes any
`hash` from the request body); see section 6.

### 3.2 MintVAT

Client (`client-app/lib/vat.js`):

```
15:        const transaction = await contract.newProposal('MintVAT', {
16:            arguments: [voterHash, electionID, pollingStationID],
17:            endorsingOrganizations: ['OrgIEBCMSP', 'OrgJudiciaryMSP', 'OrgCivilSocietyMSP'],
```

The explicit org list is DEV-003: the collection has `memberOnlyWrite: true` (`network/collections_config.json`
9), so service discovery alone cannot assemble the `OutOf(3,...)` chaincode policy.

Chaincode (`MintVAT`, lines 49 to 64):

```
50:        const viKey = keys.voterIssuedKey(ctx.stub, electionID, voterHash);
51:        const existing = await ctx.stub.getPrivateData(COLLECTION, viKey);
52:        if (existing && existing.length > 0) {
53:            throw new Error(errors.ERR_DUPLICATE_ISSUANCE);
...
56:        const vatID = ctx.stub.getTxID();
...
59:        const vat = { electionID, pollingStationID, issuedAt, status: 'ACTIVE' };
60:        await ctx.stub.putState(keys.vatKey(ctx.stub, vatID), Buffer.from(JSON.stringify(vat)));
61:        await ctx.stub.putPrivateData(COLLECTION, viKey, Buffer.from(vatID));
```

| Direction | Key | Where | Value |
|---|---|---|---|
| Read (line 51) | `VOTERISSUED~electionID~voterHash` | private data, `voterIssuedCollection` | existing vatID, if any. |
| Write (line 60) | `VAT~vatID` | public world state | `{electionID, pollingStationID, issuedAt, status:'ACTIVE'}`. |
| Write (line 61) | `VOTERISSUED~electionID~voterHash` | private data, `voterIssuedCollection` | the vatID string. |

`vatID` is the transaction ID (line 56), so every peer derives the same value.
`keys.js` 11 to 17 builds each key with `createCompositeKey`, which uses a NUL delimiter
(`test/lib/couchdb.js` header).

### 3.3 Ephemeral key and signature (client)

`client-app/lib/ballot.js`:

```
11:    const nonce     = crypto.randomBytes(16).toString('hex');
12:    const timestamp = Math.floor(Date.now() / 1000);
13:    const payloadStr = canonicalise({ candidateID, electionID, nonce, timestamp, vatID });
```

`client-app/lib/ephemeral.js` `signBallot`:

```
19:    let { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
21:    const sign = crypto.createSign('SHA256');
22:    sign.update(payloadStr, 'utf8');
23:    const signatureB64 = sign.sign(privateKey, 'base64');
25:    const ephemeralPubKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
...
29:    privateKey = null;
```

`canonicalise` sorts keys and prints no whitespace (`ephemeral.js` 9 to 13, identical to
`chaincode/voting/lib/crypto.js` 8 to 12), so client and chaincode sign and verify the same bytes.
Randomness and time are used only on the client; the chaincode never generates either.

### 3.4 CastBallot: the call and the check order

Client (`client-app/lib/ballot.js` 24 to 31) sends six arguments, in this order:
`vatID, candidateID, ephemeralPubKey, signatureB64, payloadStr, nonce`. It uses
`submitTransaction` with no `endorsingOrganizations`, so the gateway chooses the endorsers
(see section 8, UNKNOWN 2).

Chaincode check order (header comment at lines 67 to 71 says "do NOT reorder"):

| # | Lines | Check | Throws |
|---|---|---|---|
| 1 | 75 to 77 | `verifySignature(ephemeralPubKey, signature, payload)` | `ERR_BAD_SIGNATURE` |
| 1b | 80 to 90 | payload must parse as JSON and `payloadObj.vatID`, `.candidateID`, `.nonce` must equal the arguments | `ERR_BAD_SIGNATURE` |
| (91) | 91 | `electionID = payloadObj.electionID` (taken from the payload, not from the VAT) | none |
| 2 | 94 to 98 | `getState(NONCE~election~nonce)` must be empty | `ERR_NONCE_USED` |
| 3 | 101 to 109 | `getState(VAT~vatID)` must exist and `status === 'ACTIVE'` | `ERR_VAT_NOT_ACTIVE` |
| 4 | 112 to 116 | `getState(CANDIDATE~candidateID)` must exist | `ERR_NO_CANDIDATE` |

Quoted:

```
75:        if (!verifySignature(ephemeralPubKey, signature, payload)) {
76:            throw new Error(errors.ERR_BAD_SIGNATURE);
...
96:        if (nonceExists && nonceExists.length > 0) {
97:            throw new Error(errors.ERR_NONCE_USED);
...
107:        if (vat.status !== 'ACTIVE') {
108:            throw new Error(errors.ERR_VAT_NOT_ACTIVE);
```

`verifySignature` (`chaincode/voting/lib/crypto.js` 18 to 26) returns `false` on any exception, so a
malformed key or signature is also `ERR_BAD_SIGNATURE`.

### 3.5 Keys read and written by CastBallot

| Key | Read at | Written at | Content |
|---|---|---|---|
| `NONCE~electionID~nonce` | 95 | 128 | `'used'` |
| `VAT~vatID` | 102 | 123 | status changed `ACTIVE` to `BURNED` (line 122) |
| `CANDIDATE~candidateID` | 113 | not written | existence only |
| `BALLOT~ballotID` | not read | 126 | `{candidateID, electionID, timestamp}`; `ballotID` is the txID (line 119) |
| `TALLY~electionID~candidateID` | 131 | 133 | integer string, +1 |
| `BURNEDCOUNT~electionID` | 136 | 138 | integer string, +1 |

```
122:        vat.status = 'BURNED';
123:        await ctx.stub.putState(vKey, Buffer.from(JSON.stringify(vat)));
...
130:        const tKey = keys.tallyKey(ctx.stub, electionID, candidateID);
131:        const tallyBytes = await ctx.stub.getState(tKey);
133:        await ctx.stub.putState(tKey, Buffer.from(String(tally + 1)));
...
138:        await ctx.stub.putState(bKey, Buffer.from(String(burned + 1)));
```

All five writes sit after the last check and inside one invocation, so they commit together or not
at all (comment at line 118). The BALLOT record contains no vatID and no voter hash.

### 3.6 Endorsement, ordering, validation, commit

1. **Endorsement.** The gateway sends the signed proposal to peers. Each endorsing peer runs the
   chaincode against its own world state and returns a read-write set. The channel needs 3 matching
   endorsements: policy `OutOf(3,'OrgIEBCMSP.peer','OrgJudiciaryMSP.peer','OrgCivilSocietyMSP.peer','OrgMediaMSP.peer')`
   (`network/scripts/05-deploy-chaincode.sh` 27 and 141). For a collection write the collection
   policy `OR('OrgIEBCMSP.peer', 'OrgJudiciaryMSP.peer')` also applies
   (`network/collections_config.json` 10 to 12). Evidence that a chaincode throw is reported at this
   stage and never reaches the orderer: `evidence/test1a/regression-2026-09-28T23-08-59-722Z/result.json`
   (`secondErrorName: "EndorseError"`, `heightBeforeReplay == heightAfterReplay`).
2. **Ordering.** The client submits the endorsed transaction to the Raft ordering service (three
   consenters, `network/configtx.yaml` 137 to 149). A block is cut after `BatchTimeout: 500ms`
   (line 156) or `MaxMessageCount: 10` (line 158), whichever comes first. The 500 ms value replaced
   the earlier 2 s value (DEV-006); `test/test6-invalid-endorsement.sh` line 67 still says "2s" in a
   comment, which is stale.
3. **Validation.** Each peer, on receiving the block, checks every transaction for (a) the
   endorsement policy (platform behaviour; code 10 = `ENDORSEMENT_POLICY_FAILURE`) and (b) that
   every key read still has the version it had at simulation (code 11 = `MVCC_READ_CONFLICT`).
   The code is stored per transaction in the block's `TRANSACTIONS_FILTER`, filled in only when the
   block is fetched from a peer (`test/lib/blockchain.js` header; `test/test1b-double-voting-concurrent.js` 60 to 61).
   Proof: `evidence/test6/regression-2026-09-28T23-09-21-581Z/result.json` (`txValidationCodes: [10]`)
   and `evidence/test1b/regression-2026-09-28T23-09-04-361Z/result.json` (codes 11 and 0 in block 25476).
4. **Commit.** Valid transactions apply their write set to the peer's CouchDB state database
   (`CORE_LEDGER_STATE_STATEDATABASE=CouchDB`, `network/docker-compose.yaml` 312); invalid ones stay
   in the block but their writes are discarded. `submitTransaction` returns only after commit status
   is known (`client-app/lib/ballot.js` 24; `commitStatusOptions` deadline 120 s in
   `client-app/lib/gateway.js` 54). Private data goes only to members' peers; other peers keep a hash.

---

## 4. The tests

Run order and repetition: `test/run-all.sh` 104 to 111 (three runs each; test 2 last because it stops
a peer). Each run writes `evidence/<test>/<timestamp>/result.json` through `test/lib/evidence.js`.
Latest regression run folders named below are those present in `evidence/` on 2026-10-25. Every
JS test finishes with `GetAuditInvariant` and a `peer-logs.txt` capture.

### Test 1a: double voting, sequential

- **Script:** `test/test1a-double-voting-sequential.js`.
- **Steps:** (1) load one voter (line 31); (2) `mintVAT` (32); (3) cast a valid ballot and wait for
  commit (36 to 41); (4) read channel height (43); (5) cast again with the same `vatID` but a fresh
  nonce and signature (46 to 55); (6) read height again (57); (7) `GetAuditInvariant` (66).
- **What stops it:** check 3 in `CastBallot`, `votingContract.js` 107 to 109 (`vat.status !== 'ACTIVE'`
  because line 122 set `BURNED`). Signature and nonce checks pass because both are fresh.
- **Evidence fields** (`result.json`): `secondCastError` containing `ERR_VAT_NOT_ACTIVE`,
  `errorContainsVatNotActive: true`, `heightBeforeReplay == heightAfterReplay` (`noNewBlock: true`),
  `invariant {burnedCount:1, tallyTotal:1}`, `pass`. Example: `evidence/test1a/regression-2026-09-28T23-08-59-722Z/`
  (height 25475 before and after).

### Test 1b: double voting, concurrent

- **Script:** `test/test1b-double-voting-concurrent.js`.
- **Steps:** mint one VAT (36); build two different signed ballots for it (39 to 40); submit both
  with `Promise.allSettled` (42 to 45); read each commit `Status` (code, block number); fetch the
  block from a peer and decode its codes (60 to 71); `GetAuditInvariant` (79).
- **What stops it:** not a chaincode check. Both simulations see the VAT `ACTIVE` (line 107 passes
  for both) and both read and write `VAT~vatID`, `TALLY~...`, `BURNEDCOUNT~...`. Fabric's commit-time
  version check marks the second one in the block invalid (code 11). The brief's wording is "MVCC
  read-set conflict, not a chaincode-level rejection" (header lines 7 to 9).
- **Evidence fields:** `outcomeA.code`, `outcomeB.code` (one 0, one 11), `successCount: 1`,
  `mvccConflictCount: 1`, `blocksInvolved`, `blockDecodes[].codes`, `blockCorroboration`, `invariant`.
  Example: `evidence/test1b/regression-2026-09-28T23-09-04-361Z/` (both in block 25476; also
  `block-25476.pb.json`).

### Test 2: insider modification

- **Script:** `test/test2-insider-modification.js`; helpers `test/lib/couchdb.js`,
  `test/lib/peerlifecycle.js`, `test/lib/blockchain.js`.
- **Steps:** (1) mint and cast one real vote (89 to 93); (2) read the TALLY document from Media's
  CouchDB (104 to 106); (3) overwrite it with `9999`, keeping `_rev` and `~version` (112 to 118);
  (4) `GetTally` through Media and through IEBC, compare (125 to 130); (5) mint a second VAT and
  ask for a `CastBallot` endorsed by exactly Media, IEBC, Judiciary (67, 143 to 149), expecting the
  endorsement to fail; (6) stop Media, `peer node rebuild-dbs`, restart, wait for height (162 to
  176); (7) read CouchDB again, resubmit a Media-inclusive cast and expect commit (178 to 233).
- **What stops it:** this test shows containment and recovery, not prevention. The block store is
  untouched, so the peer stays in consensus (header lines 6 to 13). A tampered peer cannot
  contribute to a 3-of-4 endorsement because its read-write set (built from the forged TALLY read,
  `votingContract.js` 131) differs from the honest peers'. With 4 orgs requested, the three honest
  responses simply outvote it (lines 59 to 63), so the test deliberately requests exactly three.
  Recovery is the platform's `rebuild-dbs` replaying the immutable block store.
- **Evidence fields:** `divergenceConfirmed` (`tallyFromMediaPeer {C001:9999}` vs
  `tallyFromHonestPeer {C001:1}`), `endorsementError` ("ProposalResponsePayloads do not match"),
  `endorsementFailedAsExpected`, `recoveryReachedHeight`, `recoveryRestoredCorrectValue`
  (`valueAfterRecovery "1"`), `resubmitCommitted`; files `couchdb-before.json`,
  `couchdb-after-tamper.json`, `couchdb-after-rebuild.json`, `rebuild-dbs-output.txt`. Example:
  `evidence/test2/regression-2026-09-28T23-57-28-373Z/`.
- **Caveat the code states (lines 29 to 43):** the peer's in-memory point-read cache can mask a
  CouchDB tamper if the key was written repeatedly just before; hence `VOTES_BEFORE_TAMPER = 1` (line 57).

### Test 3: parity audit

- **Script:** `test/test3-parity-audit.js` (default 1000 votes; `run-all.sh` passes the count).
- **Steps:** load 1000 voters (46); mint concurrently with a pool of 30 (50 to 58); cast
  sequentially, one `CastBallot` at a time, cycling C001 to C004 (65 to 92); `GetAuditInvariant` (98).
- **What it checks:** `GetAuditInvariant` (`votingContract.js` 144 to 160): `burnedCount` from the
  `BURNEDCOUNT` key against `tallyTotal`, the sum of every `TALLY~election~*` value found by a
  range query. Casts are sequential because concurrent casts would collide on the single counters
  (header lines 16 to 21; DEV-005).
- **Evidence fields:** `invariant {burnedCount, tallyTotal}`, `invariantOK`, `committed`, `failed`,
  `mintTotalMs`, `castTotalMs`; `votes.csv` per-vote timing. Example:
  `evidence/test3/2026-09-28T11-38-20-118Z/result.json` (1000 committed, 0 failed, 1000 = 1000).
  Three passing runs exist under `evidence/test3/`.

### Test 4a: replay, byte-identical proposal

- **Script:** `test/test4a-replay-byte-identical.js`.
- **Steps:** mint (35); build the six arguments (38); build an unsigned proposal, take its bytes and
  digest, sign the digest with the identity key (45 to 51); submit it and wait for commit (53 to 56);
  `GetAuditInvariant` (63); resubmit the same bytes and signature (70 to 85); invariant again (93).
- **What stops it:** a platform check, not repository code: the peer rejects a transaction ID it
  has already committed ("duplicate transaction found [txid]") at the endorse stage, before the
  chaincode runs. The test asserts `ERR_NONCE_USED` is absent (line 97) to prove the chaincode
  never ran. Source of the check is Fabric; only the evidence is in this repository.
- **Evidence fields:** `replayStage: "rejected at endorse"`, `replayError`, `containsDuplicateTxid:
  true`, `containsNonceUsed: false`, `invariantUnchanged: true`. Example:
  `evidence/test4a/regression-2026-09-28T23-09-08-920Z/`.

### Test 4b: replay, argument tuple

- **Script:** `test/test4b-replay-argument-tuple.js`.
- **Steps:** mint (34); build the six arguments and save them to `captured-ballot.json` (37 to 39);
  cast and commit (41); invariant (47); call `submitTransaction('CastBallot', ...)` again with the
  identical six arguments (54 to 58), which makes a new transaction ID; invariant (69).
- **What stops it:** check 2, `votingContract.js` 94 to 98. The signature still verifies (same
  payload bytes), so check 1 passes, and `NONCE~election~nonce` was written at line 128. Because the
  nonce check precedes the VAT check, the error is `ERR_NONCE_USED`, not `ERR_VAT_NOT_ACTIVE`.
- **Evidence fields:** `containsNonceUsed: true`, `containsVatNotActive: false`,
  `containsBadSignature: false`, `replayError`, `invariantUnchanged`. Example:
  `evidence/test4b/regression-2026-09-28T23-09-13-272Z/` (and `captured-ballot.json`).
- 4a and 4b together are DEV-004: one replay is stopped by the platform, the other by the chaincode.

### Test 5: tampered ballot

- **Script:** `test/test5-tampered-ballot.js`.
- **Steps:** mint (38); build and sign a ballot for C001 (41); string-replace `"candidateID":"C001"`
  with `"candidateID":"C002"` inside the signed payload (48 to 51); submit the tampered payload with
  the original signature and original candidate argument (60 to 62); invariant (71).
- **What stops it:** check 1, `votingContract.js` 75 to 77 via `crypto.js` `verifySignature`
  (18 to 26): the signature no longer matches the payload bytes.
- **Evidence fields:** `castError` containing `ERR_BAD_SIGNATURE`, `containsBadSignature: true`,
  `invariant {0, 0}`, plus `originalPayload` and `tamperedPayload` for comparison. Example:
  `evidence/test5/regression-2026-09-28T23-09-17-926Z/`.
- **Scope of this test:** it tampers the payload without re-signing it. See section 6 item 9 on
  what an attacker who also holds the submission path could do.

### Test 6: invalid endorsement

- **Script:** `test/test6-invalid-endorsement.sh`, with `test/lib/gen-castballot-invoke.js`,
  `get-tally.js`, `decode-last-block.js`.
- **Steps:** mint a VAT and print a valid CastBallot invoke (40); record the tally (43); run
  `peer chaincode invoke` with only two `--peerAddresses`, IEBC and Judiciary (56 to 62); wait 4 s
  (68); fetch the last block from a peer and decode codes (71); record the tally again (75); write
  `result.json` with `pass = (10 in codes) and tally_unchanged` (113).
- **What stops it:** the endorsement policy `OutOf(3,...)` (`05-deploy-chaincode.sh` 27, 141),
  enforced by the peers at commit. The SDK cannot be used because it collects the endorsements the
  policy needs (header lines 9 to 11), so the `peer` CLI is used.
- **Evidence fields:** `txValidationCodes: [10]`, `txValidationLabels: ["ENDORSEMENT_POLICY_FAILURE"]`,
  `invokeExitCode` (0, because the orderer accepts the transaction), `tallyUnchanged`; files
  `block-decode.json`, `block-<n>.pb.json`, `invoke-output.txt`. Example:
  `evidence/test6/regression-2026-09-28T23-09-21-581Z/` (block 25483). Note `tallyBefore` and
  `tallyAfter` are both `{}` there, because the election had no committed ballot; the comparison
  shows no TALLY key appeared.

### Test 7: performance

- **Script:** `test/test7-performance.js` (`sweep 100,500,1000,5000,10000` and `probe 500`; not in
  `run-all.sh`).
- **Steps per scale (`runScale`, line 44):** disk check, CouchDB size before, start the `docker stats`
  sampler (5 s), mint concurrently, cast sequentially with per-vote timing, `GetAuditInvariant`,
  CouchDB size after. `runConcurrencyProbe` (line 154) casts in a window of 10 with up to 5 retries.
- **What it shows:** there is no attack. The probe shows the cost of the single counters.
- **Evidence fields:** `latencyMeanMs`, `latencyMedianMs`, `latencyP95Ms`, `throughputBallotsPerSec`,
  `throughputTxPerSec`, `invariant`, `invariantOK`, `latency.csv`, `dockerstats.csv`. Probe:
  `firstAttemptCommitted: 167`, `firstAttemptMvccConflicts: 333`, `mvccConflictRate: 0.666`,
  `totalRetries: 1488`, `finalCommitted: 276` of 500, invariant 276 = 276
  (`evidence/test7/concurrency-probe/2026-09-28T22-52-11-796Z/result.json`). Scale 10000:
  `evidence/test7/scale-10000/2026-09-28T19-09-43-638Z/result.json` (mean 1202.8 ms, median 729 ms,
  p95 2884 ms, 0.831 ballots/s, invariant 10000 = 10000). Summary table: `evidence/SUMMARY.md`.

Aggregated criteria 1 to 9 are in `evidence/SUMMARY.md`, generated by `test/lib/summarize.js`.

---

## 5. Ballot secrecy

### 5.1 Who holds the collection

`network/collections_config.json` lines 3 to 12:

```
 3    "name": "voterIssuedCollection",
 4    "policy": "OR('OrgIEBCMSP.member', 'OrgJudiciaryMSP.member')",
 8    "memberOnlyRead": true,
 9    "memberOnlyWrite": true,
11      "signaturePolicy": "OR('OrgIEBCMSP.peer', 'OrgJudiciaryMSP.peer')"
```

Members: **OrgIEBC and OrgJudiciary**. Non-members: **OrgCivilSociety and OrgMedia**, so non-member
orgs exist and the proof below is possible. `blockToLive` is 0 (line 7), so the data is never purged.
The collection is declared to the chaincode at `votingContract.js` line 8 and written only by
`MintVAT` line 61.

### 5.2 Read-only query: member versus non-members

The chaincode has no function that returns private data, so the query uses `MintVAT` as the
carrier: its first statement (line 51) is `getPrivateData` on the collection. Run through
`peer chaincode query` it is evaluated on one peer and never submitted to the orderer. No ledger
invoke was made. Run on 2026-10-25 from `network/` against the live network (`docker ps` listed 21
containers):

```bash
export PATH=$PATH:$HOME/fabric-samples/bin FABRIC_CFG_PATH=$HOME/fabric-samples/config/
source scripts/env-peer.sh
Q='{"function":"MintVAT","Args":["secrecy-probe-hash","SECRECY-PROBE","PS-X"]}'
setPeer IEBC          # or: setPeer CivilSociety  /  setPeer Media
peer chaincode query -C votingchannel -n voting -c "$Q"
```

(`setPeer` is `network/scripts/env-peer.sh` line 7; it selects the org Admin identity and its peer.)

| Caller | Exit | Output |
|---|---|---|
| OrgIEBCMSP (member) | 0 | `c3324699c05fbc525ac68529ba4b624bd1aeee4ec7720884f593ee798f4e2b74` (a transaction ID returned by the simulated MintVAT) |
| OrgCivilSocietyMSP (non-member) | 1 | `Error: endorsement failure during query. response: status:500 message:"GET_STATE failed: transaction ID: ed1a9cd40a621ac6fdb449cb409b1f9d79e2122a69343df06e3faf7197044bc9: tx creator does not have read access permission on privatedata in chaincodeName:voting collectionName: voterIssuedCollection"` |
| OrgMediaMSP (non-member) | 1 | `Error: endorsement failure during query. response: status:500 message:"GET_STATE failed: transaction ID: dc21bfc6eb16f05601468e038ad3c8afe70c4c04c15d4ffcb32c933bbdbbc113: tx creator does not have read access permission on privatedata in chaincodeName:voting collectionName: voterIssuedCollection"` |

What this proves: the peer refuses a non-member creator's read of the collection (the effect of
`memberOnlyRead: true`). What it does not prove: that non-member peers hold no copy of the data.
Whether their stores contain only hashes is platform behaviour and was not inspected (UNKNOWN 5).

### 5.3 What secrecy covers and what it does not

Covered: the map from voter hash to vatID (`VOTERISSUED`, `votingContract.js` 61). Not covered, by
construction of the code:

- `VAT~vatID` is public state (line 60), and the `CastBallot` arguments, which include both `vatID`
  and `candidateID`, are part of the transaction recorded in the block (`client-app/lib/ballot.js`
  24 to 31). So the link vatID to candidate is visible to every channel member.
- IEBC and Judiciary hold the link voterHash to vatID. Together with the transaction arguments
  they can link a voter hash to a candidate. Linking the hash to a person needs the off-chain
  registry (`voter-generator/registry.db`).
- Every CastBallot from `client-app` is signed by the same identity, `User1@orgiebc`
  (`client-app/lib/gateway.js` 18, 23), so the transaction creator tells an observer nothing about
  the voter, but it also shows that one organisation submits all ballots.

---

## 6. Known limits visible in the code

1. **Single-key counters limit concurrency.** Every CastBallot for an election reads and writes
   `BURNEDCOUNT~election` (`votingContract.js` 135 to 138) and `TALLY~election~candidate` (130 to
   133). Concurrent casts therefore conflict at commit. Evidence: 66.6% first-attempt conflicts and
   only 276 of 500 committed after up to five retries in the probe
   (`evidence/test7/concurrency-probe/2026-09-28T22-52-11-796Z/result.json`); test 3 and test 7
   cast sequentially for this reason (`test/test3-parity-audit.js` 16 to 21; DEV-005).
   Sequential throughput is about 0.83 to 0.90 ballots per second (`evidence/SUMMARY.md`).
2. **Raft gives crash fault tolerance only.** The ordering service is `OrdererType: etcdraft`
   (`network/configtx.yaml` 135) with three consenters (137 to 149). It tolerates the loss of a
   minority of orderers; it does not defend against a consenter that sends false data. All three
   orderers belong to one organisation, OrgOrderer (`network/crypto-config.yaml` 1 to 17;
   `configtx.yaml` Orderer `Organizations` in profile `VotingChannel`), so a single organisation
   operates the whole ordering service.
3. **One host, so fault tolerance is logical.** All 17 containers are in one Compose file
   (`network/docker-compose.yaml`), run on one VM. Tests do not show
   survival of an orderer failure: none of the nine tests stops an orderer. Only test 2 stops a
   container (a peer).
4. **The registry is off-chain and trusted.** Eligibility is decided by `client-app/lib/registry.js`
   25 to 31 reading a local SQLite file. The chaincode never sees a voter ID. `MintVAT` accepts any
   `voterHash` string (`votingContract.js` 49 to 64), and `client-app/routes/mint.js` does not call
   `verifyVoter`. The salt is stored next to the hash in the same table (`voter-generator/generate.py`
   65 to 67). Nothing on-chain proves a hash belongs to a real voter. Duplicate issuance is stopped
   only per `electionID` and `voterHash` (line 50 to 54).
5. **MintVAT and CastBallot have no caller authorisation.** Only `CreateCandidate` checks an attribute
   (`votingContract.js` 39 to 42). Any identity of IEBC or Judiciary can mint (the collection read
   blocks the other two, section 5.2). Any channel identity can submit a CastBallot for a VAT whose
   ID it knows; the VAT is a bearer token. VAT records are public state (line 60).
6. **A VAT is not bound to its election at cast time.** `MintVAT` stores `electionID` in the VAT
   (line 59), but `CastBallot` takes `electionID` from the signed payload (line 91) and never
   compares it with `vat.electionID` (lines 106 to 109). A ballot can therefore be counted under an
   election other than the one the VAT was issued for. The nonce check is likewise scoped by the
   payload's election (line 94). Not exercised by any test.
7. **The payload timestamp is never checked, and there is no election lifecycle.** Lines 86 to 90
   compare only vatID, candidateID and nonce. There is no open, close or deadline function among the
   six; `GetTally` (163 to 174) is readable at any time.
8. **Candidates are global.** `keys.js` line 11 keys a candidate by ID only, not by election, and
   `CreateCandidate` overwrites without checking (`votingContract.js` 43 to 44).
9. **The signature does not authenticate a person.** The verifying key arrives in the same call as
   the signature and the payload (`votingContract.js` 72 and 75). So check 1 proves the payload was
   not altered after signing with that key, as test 5 shows, but a party who controls the arguments
   could re-sign a modified payload with a new key and pass check 1. The remaining defence is the
   VAT status, the nonce and the transport and client identity. `client-app/lib/ephemeral.js` 29
   sets the variable to `null`, which drops the reference but does not erase key bytes from memory.
10. **Ballot unlinkability is partial.** See section 5.3.
11. **The audit invariant is a consistency check, not an independent count.** Both sides are written
    by the same function in one transaction (lines 130 to 138). It detects a missing or doubled write
    (and test 2 shows a forged value gives a disagreeing result); it cannot detect a logic error that
    keeps both counters in step, such as item 6.
12. **Test 2 proves containment and recovery, not prevention.** A tampered CouchDB can be read by
    queries on that peer (`tallyFromMediaPeer {C001: 9999}`), is outvoted at endorsement only when
    exactly three orgs are requested with the tampered one among them, and can be masked by the
    peer cache (`test/test2-insider-modification.js` 29 to 43, 59 to 67).
13. **Error naming is coarse in one place.** `ERR_VAT_NOT_ACTIVE` is thrown both when the VAT does
    not exist (lines 103 to 105) and when it is not active (107 to 109).
14. **Block audit is incomplete in the chaincode.** `GetBlockAudit` returns undecoded base64 and
    swallows a QSCC failure silently (`votingContract.js` 188 to 193).
15. **Credentials and trust shortcuts in the lab set-up.** CouchDB admin password and CA bootstrap
    credentials are literals in `network/docker-compose.yaml` (`COUCHDB_PASSWORD=adminpw`;
    `fabric-ca-server start -b admin:adminpw`); `votingadmin` has secret `votingpw`
    (`network/scripts/06-init-candidates.sh` 46); every peer mounts the host Docker socket and the
    docker binary (peer `volumes`); chaincode TLS material is passed through container environment
    variables (`05-deploy-chaincode.sh` 59 to 76); the client Express app has no authentication or
    TLS (`client-app/index.js` 12 to 22).
16. **A documentation inconsistency.** `test/test6-invalid-endorsement.sh` line 67 says
    "BatchTimeout: 2s"; the configured value is 500 ms (`network/configtx.yaml` 156, DEV-006).
17. **Unit tests use a stubbed ledger.** `chaincode/voting/test/votingContract.spec.js` proves check
    order and writes against stubs; it cannot show endorsement, ordering or MVCC behaviour. Those
    are shown only by the live tests in section 4.

---

## 7. Scenario questions an examiner could ask

Questions only. Each names the place that answers it.

1. A voter says they voted but the tally does not include their ballot. How would you establish
   what happened to their transaction? Look at: `verification-dashboard/lib/audit.js`
   (`startBlockListener`, code names), `test/lib/blockchain.js` (`getBlockValidationCodes`),
   `votingContract.js` `CastBallot` 72 to 141.
2. Why did you make the nonce check run before the VAT status check, and what is the observable
   difference for a caller? Look at: `votingContract.js` 66 to 116,
   `test/test4b-replay-argument-tuple.js` 65 to 73.
3. If the IEBC and Judiciary peers are compromised together, what can they learn about how a
   particular voter voted? Look at: `network/collections_config.json`, `votingContract.js` 49 to 64
   and 119 to 138, `client-app/lib/ballot.js` 24 to 31.
4. Two ballots arrive for the same VAT at the same instant. Which one wins, who decides, and where
   is that decision visible? Look at: `test/test1b-double-voting-concurrent.js` 42 to 88,
   `evidence/test1b/*/block-*.pb.json`.
5. An insider edits a vote count directly in one peer's database. What do the other peers do, what
   does a user querying that peer see, and how is the peer repaired? Look at:
   `test/test2-insider-modification.js`, `test/lib/peerlifecycle.js`, `test/lib/couchdb.js`.
6. Why are 4 organisations required to approve the chaincode but only 3 endorse a transaction, and
   what happens with 2? Look at: `network/scripts/05-deploy-chaincode.sh` 27 and 129 to 143,
   `network/configtx.yaml` 125 to 129, `test/test6-invalid-endorsement.sh`.
7. Why does `MintVAT` need a hard-coded list of three endorsing organisations, and what breaks
   without it? Look at: `client-app/lib/vat.js` 12 to 17, `network/collections_config.json`
   9 to 12, `docs/DEVIATIONS.md` (DEV-003).
8. Your throughput is under one ballot per second. Where is the bottleneck, which line of code
   causes it, and what would you change? Look at: `votingContract.js` 130 to 138,
   `test/test7-performance.js` `runConcurrencyProbe`, `evidence/SUMMARY.md`, `docs/DEVIATIONS.md` (DEV-005).
9. How do you know the registry itself was not altered to add ghost voters, and what in the chain
   would reveal ghost voters after the fact? Look at: `client-app/lib/registry.js`,
   `client-app/routes/mint.js`, `votingContract.js` `MintVAT`, `GetAuditInvariant`.
10. What does "Raft is crash fault tolerant" mean here: which failure did you test, which did you
    not, and what would a malicious orderer be able to do? Look at: `network/configtx.yaml` 135 to
    160, `network/crypto-config.yaml` 1 to 17, `test/run-all.sh` 104 to 111, `test/test6-invalid-endorsement.sh`.

---

## 8. UNKNOWN items

1. **Purpose and readers of the root `.env`.** No file refers to it (section 1.1). Its
   `COMPOSE_PROJECT_NAME=voting-network` differs from `network/.env` (`voting`); the peers'
   `CORE_VM_DOCKER_HOSTCONFIG_NETWORKMODE=voting_votingnet` matches the `network/.env` value.
2. **Which three organisations endorse a given CastBallot.** `client-app/lib/ballot.js` and the tests
   use `submitTransaction`, so the gateway chooses; `result.json` files do not record the choice.
   The selection rule is inside Fabric, not in this repository.
3. **The source of the platform checks** that stop tests 1b, 4a and 6 (version check at commit,
   duplicate transaction ID, endorsement policy evaluation). They are demonstrated by evidence
   files only.
4. **Which orderer is the Raft leader at any moment.** Runtime state; `dashboard/collectors/network.js`
   reads it from orderer logs, and this document did not.
5. **Whether non-member peers hold only hashes of the private data.** Not inspected; the read refusal
   in section 5.2 is the only evidence gathered.
6. **Thesis text.** The brief says the thesis describes exactly what this code does, but the thesis
   (`Chapter5.docx` is mentioned in `dashboard/collectors/environment.js` 220) is not in the
   repository, so agreement between it and this document is unchecked.
