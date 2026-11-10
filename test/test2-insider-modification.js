#!/usr/bin/env node
'use strict';
/**
 * Test 2 — Insider Modification
 * IMPLEMENTATION_BRIEF.md Section 6: directly modify a committed value in
 * one peer's CouchDB, bypassing chaincode. Success (per
 * docs/PHASE4_DECISIONS.md E.2, corrected wording): the tampered peer does
 * NOT fall out of consensus — the block store and Raft membership are
 * unaffected. The observable effect is confined to endorsement: when the
 * tampered peer is forced into the endorsing set, its write-set diverges
 * from the honest peers' and the client cannot assemble a matching 3-of-4
 * endorsement. `peer node rebuild-dbs` recovers by reconstructing world
 * state from the immutable block store.
 *
 * Procedure (all steps verified live against peer0.orgmedia.example.com
 * before being wired into this script):
 *   1. Cast one real vote to create a genuine TALLY document.
 *   2. Read TALLY~{electionID}~C001 from Media's CouchDB (attachment-based
 *      value, ~version field — see lib/couchdb.js).
 *   3. Overwrite the value, preserving _rev and ~version verbatim.
 *   4. Confirm divergence: GetTally from Media vs. an honest peer disagree.
 *   5. Force Media into the endorsing set for a fresh CastBallot; expect
 *      an EndorseError (RWSet/response mismatch).
 *   6. Recover: stop peer0.orgmedia, run rebuild-dbs, restart, wait for it
 *      to catch back up to the honest peers' height.
 *   7. Confirm restoration: CouchDB value is honest again; the same
 *      3-org (Media-inclusive) CastBallot now commits.
 *
 * Why only ONE prior vote (finding not in docs/PHASE4_DECISIONS.md, found
 * live while building this test): Fabric's CouchDB state implementation
 * keeps a per-peer in-memory cache of recently-committed values for point
 * GetState reads, refreshed on commit (not on read). CastBallot's tally
 * increment does a point GetState on TALLY~election~candidate. If that key
 * was written repeatedly just before the tamper (e.g. 3 prior votes for the
 * same candidate), the cache stays warm with the CORRECT value, and the
 * peer's chaincode simulation reads from cache rather than CouchDB —
 * silently masking the external tamper and producing a MATCHING
 * (non-divergent) endorsement. Verified empirically: with 3 prior votes,
 * the provoked CastBallot endorsed and committed cleanly despite the
 * tamper; with exactly 1 prior vote, it reliably (2/2 trials) threw
 * "ProposalResponsePayloads do not match". GetTally's divergence check
 * (step 4) is unaffected either way because getStateByPartialCompositeKey
 * is a range query, which always goes to CouchDB directly.
 */

const { connectAs } = require('./lib/gateway');
const { mintVAT, buildCastArgs, errorText } = require('./lib/vote');
const { loadVoters } = require('./lib/voters');
const couchdb = require('./lib/couchdb');
const { getChannelHeight, waitForHeight } = require('./lib/blockchain');
const { stopPeer, runRebuildDbs, startPeer } = require('./lib/peerlifecycle');
const { isoStamp, evidenceDir, writeJSON, writeText, capturePeerLogs, jsonSafe } = require('./lib/evidence');

const CANDIDATE = 'C001';
const POLLING_STATION = 'PS-TEST2';
const PEER_LOGS = ['peer0.orgmedia.example.com', 'peer0.orgiebc.example.com'];
const VOTES_BEFORE_TAMPER = 1;

// Requesting endorsement from ALL FOUR orgs does NOT force an observable
// failure: OutOf(3,...) is satisfied by ANY matching 3-of-4 subset, so the
// SDK simply finds the 3 honest agreeing endorsements and commits, silently
// discarding Media's divergent one (verified live — the decisions file's
// [expected] assumption of "cannot be routed around" was wrong here).
// Requesting endorsement from EXACTLY 3 orgs that include the tampered peer
// leaves no honest fallback subset: if Media diverges, only 2 of the 3
// requested match, which cannot satisfy OutOf(3,...).
const PROVOKE_ENDORSERS = ['OrgMediaMSP', 'OrgIEBCMSP', 'OrgJudiciaryMSP'];

async function castOneVote(contract, voterHash, electionID) {
    const vatID = await mintVAT(contract, voterHash, electionID, POLLING_STATION);
    const args = buildCastArgs(vatID, CANDIDATE, electionID);
    await contract.submitTransaction(
        'CastBallot', args.vatID, args.candidateID, args.ephemeralPubKey, args.signatureB64, args.payloadStr, args.nonce
    );
    return vatID;
}

async function run(runIndex) {
    const stamp = isoStamp();
    const dir = evidenceDir('test2', stamp);
    const electionID = `test2-run${runIndex}-${Date.now()}`;
    const result = { test: '2', runIndex, electionID, pass: false, steps: {} };

    const iebc = await connectAs('IEBC');
    let mediaConn = null;

    try {
        // 1. Real votes to create a genuine TALLY document.
        const voters = loadVoters(VOTES_BEFORE_TAMPER, 2000 + runIndex * 10);
        for (const voter of voters) {
            await castOneVote(iebc.contract, voter.hash, electionID);
        }
        result.steps.votesCast = VOTES_BEFORE_TAMPER;

        const tallyBeforeBytes = await iebc.contract.evaluateTransaction('GetTally', electionID);
        const tallyBeforeHonest = JSON.parse(Buffer.from(tallyBeforeBytes).toString('utf8'));
        result.tallyBeforeHonest = tallyBeforeHonest;
        const honestCount = tallyBeforeHonest[CANDIDATE];
        if (honestCount !== VOTES_BEFORE_TAMPER) {
            throw new Error(`expected tally ${CANDIDATE}=${VOTES_BEFORE_TAMPER}, got ${honestCount}`);
        }

        // 2. Read the TALLY document from Media's CouchDB.
        const tallyDocId = couchdb.compositeKey('TALLY', [electionID, CANDIDATE]);
        const before = await couchdb.getDoc(couchdb.COUCHDB_PORTS.Media, tallyDocId);
        if (!before.found) throw new Error(`TALLY document not found on Media CouchDB: ${tallyDocId}`);
        result.docId = tallyDocId;
        result.tamperBefore = before.value;
        writeJSON(dir, 'couchdb-before.json', before.raw);

        // 3. Overwrite the value, preserving _rev and ~version verbatim.
        const forgedValue = '9999';
        const putRes = await couchdb.putTamperedValue(couchdb.COUCHDB_PORTS.Media, tallyDocId, before.rev, before.version, forgedValue);
        result.tamperPutStatus = putRes.statusCode;
        if (putRes.statusCode !== 201 && putRes.statusCode !== 200) {
            throw new Error(`CouchDB PUT failed: ${putRes.statusCode} ${JSON.stringify(putRes.body)}`);
        }
        result.tamperAfter = forgedValue;

        const afterTamper = await couchdb.getDoc(couchdb.COUCHDB_PORTS.Media, tallyDocId);
        writeJSON(dir, 'couchdb-after-tamper.json', afterTamper.raw);
        result.tamperConfirmedInCouchDB = afterTamper.value === forgedValue;

        // 4. Confirm divergence via query: Media disagrees with an honest peer.
        mediaConn = await connectAs('Media');
        const tallyFromMediaBytes = await mediaConn.contract.evaluateTransaction('GetTally', electionID);
        const tallyFromMedia = JSON.parse(Buffer.from(tallyFromMediaBytes).toString('utf8'));
        result.tallyFromMediaPeer = tallyFromMedia;
        result.tallyFromHonestPeer = tallyBeforeHonest;
        result.divergenceConfirmed = tallyFromMedia[CANDIDATE] === Number(forgedValue) && tallyFromMedia[CANDIDATE] !== tallyBeforeHonest[CANDIDATE];

        // 5. Force Media into the endorsing set for a fresh CastBallot;
        //    expect the endorsement itself to fail (before any block is
        //    even proposed) because Media's write-set — built on its
        //    tampered read of the TALLY key — diverges from the honest
        //    peers'. Endorse-only (no submit): if endorsement fails, there
        //    is nothing to submit, and this avoids any ambiguity from a
        //    later commit-time retry/self-heal on the same key.
        const [provokeVoter] = loadVoters(1, 2000 + runIndex * 10 + 50);
        let endorsementError = null;
        let provokeEndorsedUnexpectedly = false;
        try {
            const provokeVatID = await mintVAT(iebc.contract, provokeVoter.hash, electionID, POLLING_STATION);
            const provokeArgs = buildCastArgs(provokeVatID, CANDIDATE, electionID);
            const proposal = iebc.contract.newProposal('CastBallot', {
                arguments: [provokeArgs.vatID, provokeArgs.candidateID, provokeArgs.ephemeralPubKey, provokeArgs.signatureB64, provokeArgs.payloadStr, provokeArgs.nonce],
                endorsingOrganizations: PROVOKE_ENDORSERS,
            });
            await proposal.endorse();
            provokeEndorsedUnexpectedly = true;
        } catch (err) {
            endorsementError = errorText(err) || err.message;
        }
        result.endorsementError = endorsementError;
        result.endorsementFailedAsExpected = endorsementError !== null && !provokeEndorsedUnexpectedly;
        result.provokeEndorsedUnexpectedly = provokeEndorsedUnexpectedly;

        capturePeerLogs(dir, PEER_LOGS, 300);
        writeText(dir, 'peer-logs-after-tamper.txt', require('./lib/evidence').dockerLogs('peer0.orgmedia.example.com', 100));

        // 6. Recovery: stop, rebuild-dbs, restart.
        const heightBeforeRecovery = getChannelHeight('IEBC');
        stopPeer('Media');
        result.steps.peerStopped = true;
        const rebuildOutput = runRebuildDbs('Media');
        writeText(dir, 'rebuild-dbs-output.txt', rebuildOutput);
        result.steps.rebuildDbsRan = true;
        startPeer('Media');
        result.steps.peerRestarted = true;
        // Timeout is generous (see lib/blockchain.js waitForHeight comment):
        // rebuild-dbs replay time scales with chain length, and the chain
        // only grows as the suite runs more tests.
        const heightAfterRecovery = await waitForHeight('Media', heightBeforeRecovery, 3600000, 5000);
        result.heightBeforeRecovery = heightBeforeRecovery;
        result.heightAfterRecovery = heightAfterRecovery;
        result.recoveryReachedHeight = heightAfterRecovery >= heightBeforeRecovery;

        // 7. Confirm restoration: CouchDB value correct again.
        const afterRebuild = await couchdb.getDoc(couchdb.COUCHDB_PORTS.Media, tallyDocId);
        writeJSON(dir, 'couchdb-after-rebuild.json', afterRebuild.raw);
        result.valueAfterRecovery = afterRebuild.value;
        result.recoveryRestoredCorrectValue = Number(afterRebuild.value) === honestCount;

        // Resubmit with the same 3-org (Media-inclusive) list; it should now
        // commit since Media's state is honest again after recovery.
        //
        // waitForHeight above only confirms MEDIA's own view of its height
        // (queried directly against its own peer address). It does NOT
        // confirm that IEBC's gateway service — which is what actually
        // routes our endorsement request to Media — has rediscovered Media
        // via gossip after the restart. That rediscovery has its own lag,
        // observed live as a transient "failed to find any endorsing
        // peers for org(s): OrgMediaMSP" error. Retry a few times with a
        // short backoff to ride out that gossip-propagation window rather
        // than treating a timing artefact as a genuine test failure.
        if (mediaConn) { mediaConn.close(); mediaConn = null; }
        const [resubmitVoter] = loadVoters(1, 2000 + runIndex * 10 + 60);
        let resubmitCommitted = false;
        let resubmitError = null;
        const resubmitAttempts = [];
        const MAX_RESUBMIT_ATTEMPTS = 6;

        // MintVAT only needs OrgIEBC/Judiciary/CivilSociety (DEV-003) and is
        // NOT idempotent (a second call for the same voter+election throws
        // ERR_DUPLICATE_ISSUANCE), so it must run exactly once, outside the
        // retry loop below — only CastBallot needs Media and is what the
        // gossip-propagation lag actually affects.
        const resubmitVatID = await mintVAT(iebc.contract, resubmitVoter.hash, electionID, POLLING_STATION);

        for (let attempt = 1; attempt <= MAX_RESUBMIT_ATTEMPTS; attempt++) {
            resubmitError = null;
            try {
                const resubmitArgs = buildCastArgs(resubmitVatID, CANDIDATE, electionID);
                const proposal = iebc.contract.newProposal('CastBallot', {
                    arguments: [resubmitArgs.vatID, resubmitArgs.candidateID, resubmitArgs.ephemeralPubKey, resubmitArgs.signatureB64, resubmitArgs.payloadStr, resubmitArgs.nonce],
                    endorsingOrganizations: PROVOKE_ENDORSERS,
                });
                const transaction = await proposal.endorse();
                const commit = await transaction.submit();
                const status = await commit.getStatus();
                resubmitCommitted = status.successful;
            } catch (err) {
                resubmitError = errorText(err) || err.message;
            }
            resubmitAttempts.push({ attempt, committed: resubmitCommitted, error: resubmitError });
            if (resubmitCommitted) break;
            const isGossipLag = resubmitError && resubmitError.includes('failed to find any endorsing peers');
            if (!isGossipLag) break; // a real failure — do not mask it with retries
            await new Promise((r) => setTimeout(r, 3000));
        }
        result.resubmitCommitted = resubmitCommitted;
        result.resubmitError = resubmitError;
        result.resubmitAttempts = resubmitAttempts;

        result.pass = result.divergenceConfirmed
            && result.endorsementFailedAsExpected
            && result.recoveryReachedHeight
            && result.recoveryRestoredCorrectValue
            && result.resubmitCommitted;
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        if (mediaConn) mediaConn.close();
        iebc.close();
    }

    writeJSON(dir, 'result.json', jsonSafe(result));
    capturePeerLogs(dir, PEER_LOGS, 300);

    const keyEvidence = result.fatalError
        || `divergence=${result.divergenceConfirmed} endorseFail=${result.endorsementFailedAsExpected} recovered=${result.recoveryRestoredCorrectValue} resubmit=${result.resubmitCommitted}`;
    console.log(`test2 run${runIndex} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

if (require.main === module) {
    const runIndex = parseInt(process.argv[2] || '1', 10);
    run(runIndex).then((r) => process.exit(r.pass ? 0 : 1)).catch((e) => { console.error('FATAL', e); process.exit(2); });
}

module.exports = { run };
