# Deviations from locked decisions

## DEV-001 — Docker Engine version 29.x installed instead of locked 27.x

**Locked value (MASTER_PLAN.md A.4):** Docker Engine 27.x (current stable from docker.com apt repo)

**Actual value:** Docker Engine 29.8.1 (installed 2026-09-20 via the official docker.com apt repo for Ubuntu 24.04 Noble; 27.x was no longer the current stable release at install time)

**Impact assessment:** None expected. Docker 29.x is backwards-compatible with Fabric 2.5.x; the same `docker-ce` apt package source is used and all Fabric container images build and run correctly. The `00-prereqs.sh` script has been updated to check for "29." rather than "27.".

**Student action required:** Acknowledge and close, or request a VM rebuild from a snapshot that installs 27.x explicitly via a pinned apt version string (`docker-ce=5:27.*`). Recommendation: close as acceptable — rebuilding the toolchain for a minor version difference carries its own risk and Docker 29.x is LTS-eligible.

## DEV-002 — External builder `run` script required; client TLS cert/key must be base64-encoded PEM

**Context (Phase 2 deployment):** Fabric 2.5 external builder protocol requires a `run` script when the `release` step does not produce a `chaincode/server.json`. The `node-docker` builder only has `detect`, `build`, and `release` scripts; without a `run` script Fabric raised `fork/exec /builders/node-docker/bin/run: no such file or directory`.

**Workarounds applied:**

1. **`run` script (`network/scripts/chaincode-run-builder.sh`)** — added to all four peer containers via `docker cp`. Launches the pre-built chaincode image on the host Docker socket (Docker-out-of-Docker via `/host/var/run/docker.sock`). Uses `grep -oP` instead of `awk` for JSON parsing because Fabric writes `chaincode.json` as compact single-line JSON. Uses a unique container name per peer (`cc-<peer-fqdn-dashes>-<label>`) to prevent a race condition when all four peers share the same Docker daemon.

2. **TLS cert file encoding** — Fabric passes the client TLS certificate and private key in `chaincode.json` as raw PEM strings with literal `\n` escape sequences. The chaincode entrypoint converts `\n` to real newlines via `printf '%b'`. However, `fabric-shim` handler.js reads these files with `Buffer.from(contents, 'base64')`, so the files must contain base64-encoded PEM, not raw PEM. The root CA cert is read without a 'base64' encoding and must remain as raw PEM. The entrypoint now pipes the cert and key through `base64` before writing to their respective files.

3. **`--peer.address` CLI arg** — `fabric-chaincode-node start` does not read `CORE_PEER_ADDRESS` from the environment; `--peer.address` must be passed explicitly on the command line.

**Student action required:** None. These are infrastructure-level workarounds necessitated by the Docker 29.x incompatibility (DEV-001) and are transparent to the application layer.

**Addendum (2026-09-28, discovered during Phase 4C rebuild):** the `node-docker` external builder's registration (`CORE_CHAINCODE_EXTERNALBUILDERS`) and its `detect`/`build` scripts had been set up by hand directly inside the running peer containers at some point before this addendum, and were never captured in `docker-compose.yaml` or any committed script — only the `run` script (`chaincode-run-builder.sh`, deployed via `docker cp` in `05-deploy-chaincode.sh`) was reproducible. A full network rebuild (`99-network-down.sh` + fresh containers) therefore lost the builder registration and its `detect`/`build` scripts, and chaincode deployment failed with `/builders/node-docker` not existing. Fixed properly: `detect` and `build` are now committed at `network/scripts/node-docker-builder/{detect,build}` (both trivial — `build` is a genuine no-op since the real image build happens on the host in `05-deploy-chaincode.sh`, per the comment above), all three scripts (`detect`, `build`, `chaincode-run-builder.sh` as `run`) are bind-mounted directly into `/builders/node-docker/bin/` from `docker-compose.yaml`, `CORE_CHAINCODE_EXTERNALBUILDERS` is set via the peer environment (documented override, `core.yaml` itself says so), and the host's `docker` CLI binary is bind-mounted read-only into each peer (`/usr/bin/docker`) since `run` shells out to it and the previous `apt-get install docker.io` fallback failed on a fresh container with no `apt-get update` run first. The whole `node-docker` builder setup is now fully reproducible from a clean `99-network-down.sh` + `01`-`06` rebuild with no manual steps.

## DEV-003 — fabric-gateway SDK requires `endorsingOrganizations` for MintVAT

**Context (Phase 3 client-app and harness):** When using `@hyperledger/fabric-gateway` (the SDK that replaces the old `fabric-network` SDK), the peer gateway service uses service discovery to compute the endorsement plan. MintVAT calls `putPrivateData` to `voterIssuedCollection`, whose `memberOnlyWrite: true` flag causes the discovery service to restrict eligible endorsers to collection members only (OrgIEBC + OrgJudiciary). Because the chaincode endorsement policy is `OutOf(3, [OrgIEBC, OrgJudiciary, OrgCivilSociety, OrgMedia])`, the combined requirement is unsatisfiable from the discovery service's perspective (only 2 orgs are eligible but 3 are needed). The `peer chaincode invoke` CLI bypasses discovery by accepting explicit `--peerAddresses` flags and so was unaffected during Phase 2.

**Workaround applied:** `contract.newProposal('MintVAT', { endorsingOrganizations: ['OrgIEBCMSP', 'OrgJudiciaryMSP', 'OrgCivilSocietyMSP'] })` bypasses discovery and routes directly to those three orgs' gateway-known peers via the Docker-internal network. CastBallot does not access the private collection and continues to use the default `submitTransaction` with service discovery.

**Student action required:** None. The endorsed transaction is valid and the chaincode/collection policies are correct. The conflict is in the discovery service's conservative interpretation of `memberOnlyWrite`, not in the actual endorsement rules.

## DEV-004 — Test 4 (Replay Attack Rejection) split into 4a and 4b

**Context (Phase 4 validation tests):** IMPLEMENTATION_BRIEF.md Section 6 describes Test 4 as "a byte-for-byte resubmission" of a committed `CastBallot` transaction. Investigating this against `@hyperledger/fabric-gateway` v1.11.0 (docs/PHASE4_DECISIONS.md E.4) found that a byte-identical resubmission is achievable (the SDK exposes `Proposal.getBytes()` / `getDigest()` and `Gateway.newSignedProposal()` for exactly this offline-signing use case), but it does **not** exercise the application-level nonce check the brief's success metric names. Empirically confirmed against the live network: replaying the identical signed proposal bytes is rejected at the **endorsement** stage with `duplicate transaction found [<txid>]` — a platform-level Fabric transaction-ID check that fires before the chaincode is ever invoked. The `NONCE~{electionID}~{nonce}` check inside `CastBallot` is never reached by a byte-identical replay, because the Fabric transaction ID (not the application nonce) is what a byte-identical resubmission necessarily reuses.

**Change applied (additive, not a redesign):** Test 4 is split into two parts, both retained:
- **4a — byte-identical signed-proposal replay.** Reconstructs the exact proposal bytes and signature via the SDK's offline-signing API and resubmits them unmodified. Evidences Fabric's platform-level replay defence (duplicate transaction ID, rejected at the endorser, chaincode never reached).
- **4b — argument-tuple replay.** Resubmits the same six `CastBallot` arguments (`vatID`, `candidateID`, `ephemeralPubKey`, `signature`, `payload`, `nonce`) through a fresh SDK call, which the SDK signs with a new Fabric transaction ID. This is what reaches the chaincode and exercises `ERR_NONCE_USED`, and is the mechanism the brief's Section 6 success metric ("100% rejection, specifically via `NONCE~{electionID}~{nonce}` already existing") actually describes.

Both parts commit to `evidence/test4a/` and `evidence/test4b/` respectively. No chaincode, endorsement policy, or success metric is changed — `NONCE~{electionID}~{nonce}` still fires exactly as specified, and the 100% rejection criterion is evaluated against 4b (with 4a additionally passing as a second, stronger line of evidence at the platform layer).

**Student action required:** None required to proceed; this is an additive clarification of the test procedure, not a change to a locked architecture decision. Status: accepted by student.

## DEV-005 — test3 mints VATs concurrently, casts ballots sequentially (implementation optimisation)

**Context (Phase 4 test3, 1,000-vote parity sweep):** The original `test3-parity-audit.js` submitted every vote fully sequentially — MintVAT fully committed, then CastBallot fully committed, before the next voter started — at roughly 4.3 s/vote (dominated by the orderer's 2 s `BatchTimeout`, per docs/PHASE4_DECISIONS.md E.1). A 1,000-vote run therefore takes on the order of 70+ minutes, and the run interrupted by the VM suspension (test3 run 2 of 3, 2026-09-28) was still in progress after roughly an hour.

**Change applied (implementation speed-up, NOT a design or success-metric change):**
- **MintVAT is now submitted concurrently**, with a bounded worker pool (`MINT_CONCURRENCY = 30` in-flight calls). This is safe because `MintVAT` only touches per-voter-unique keys — `VAT~{vatID}` (vatID = the transaction's own txID) and `VOTERISSUED~{electionID}~{voterHash}` (unique per voter+election) — so no two concurrent MintVAT calls for *different* voters can ever conflict on a shared key. There is no MVCC contention risk in this phase, as already established in docs/PHASE4_DECISIONS.md E.1.
- **CastBallot remains fully sequential**, unchanged from the original design. `CastBallot` increments `TALLY~{electionID}~{candidateID}` and `BURNEDCOUNT~{electionID}`, both single hot keys shared across every vote for that election — this is exactly the contention documented in E.1 and demonstrated as a genuine finding in Test 1b. Running casts concurrently here would produce spurious `MVCC_READ_CONFLICT` failures that are a false signal for a *correctness* test (test3 asserts `burnedCount == tallyTotal == count` with zero failures), not a performance test. Per-vote cast latency capture (`castMs` in `votes.csv`) is preserved exactly as before.
- The test's **success metric is unchanged**: `burnedCount == tallyTotal == count` (brief Section 6, criterion 6), asserted after all mints and all casts complete, exactly as the original implementation asserted it.

**Impact assessment:** Reduces wall-clock time for the mint phase from ~2.15 s/vote sequential to a small fraction of that (see `evidence/timing-trial/` for the measured 100-vote trial and projections for 1,000/5,000/10,000). The cast phase, and therefore the dominant cost, is unchanged. No chaincode, endorsement policy, or test assertion changed.

**Student action required:** Review and accept or reject. This is a build-time/test-harness change, not a change to the voting system itself, and does not touch any locked decision in IMPLEMENTATION_BRIEF.md Section 1. **Status: accepted by student** (2026-09-28).

## DEV-006 — Orderer BatchTimeout reduced from 2s to 500ms

**Context:** Orderer tuning per thesis Chapter 3.2.8. docs/PHASE4_DECISIONS.md E.1 established that sequential vote latency in Phase 4 was dominated by the orderer's 2s `BatchTimeout` (each sequential transaction sat alone in its batch, waiting the full timeout before the orderer cut a block), not by chaincode or network compute. `MaxMessageCount` (10) and the byte limits (`AbsoluteMaxBytes: 99 MB`, `PreferredMaxBytes: 512 KB`) are unchanged.

**Change applied:** `network/configtx.yaml` `Orderer.BatchTimeout: 2s` → `500ms`.

**Scope:** Applies to the test3 reruns and test7 performance sweep run after this change. The functional tests 1a, 1b, 2, 3 (run 1, superseded — see evidence/_superseded/test3/), 4a, 4b, 5 and 6 already ran and passed at the original 2s BatchTimeout; their evidence and pass/fail results are unaffected by and independent of this timing parameter, since none of those tests' success criteria depend on batch timing. They are not rerun for this change.

**Impact assessment:** Reduces the fixed per-transaction wait when a transaction is alone in its batch from up to 2s to up to 500ms, a genuine latency improvement for the performance-sensitive tests (test3, test7) without changing `MaxMessageCount` or byte limits, so batching behaviour under concurrent load is otherwise unchanged. Requires a full network rebuild (crypto/genesis regeneration is not needed — `configtx.yaml` changes affecting channel parameters require rejoining/recreating the channel via 01-06, since the orderer's system channel/application channel parameters are set at genesis and channel-creation time) — ledger state is reset; this is expected and evidence/ already captures everything needed from the prior network instance.

**Student action required:** None required to proceed. **Status: accepted by student** (2026-09-28).

<!-- Agent appends here when a locked decision in IMPLEMENTATION_BRIEF.md Section 1 is
     believed to be incorrect. Student approves or rejects. -->
