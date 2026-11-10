#!/usr/bin/env node
'use strict';
/**
 * Test 4b — Replay Attack Rejection, argument-tuple replay
 * docs/PHASE4_DECISIONS.md E.4 / docs/DEVIATIONS.md DEV-004.
 *
 * Resubmits the same six CastBallot arguments (vatID, candidateID,
 * ephemeralPubKey, signature, payload, nonce) in a fresh SDK call. The SDK
 * signs a new Fabric transaction ID, so the proposal reaches the chaincode;
 * the signature still verifies (payload is byte-identical), so validation
 * proceeds to the nonce check, which fires ERR_NONCE_USED. This is the
 * mechanism IMPLEMENTATION_BRIEF.md Section 6 describes and must produce a
 * different error string from test1a's ERR_VAT_NOT_ACTIVE.
 */

const { connectAs } = require('./lib/gateway');
const { mintVAT, buildCastArgs, errorText } = require('./lib/vote');
const { loadVoters } = require('./lib/voters');
const { isoStamp, evidenceDir, writeJSON, capturePeerLogs, jsonSafe } = require('./lib/evidence');

const CANDIDATE = 'C001';
const POLLING_STATION = 'PS-TEST4B';
const PEER_LOGS = ['peer0.orgiebc.example.com', 'peer0.orgjudiciary.example.com'];

async function run(runIndex) {
    const stamp = isoStamp();
    const dir = evidenceDir('test4b', stamp);
    const electionID = `test4b-run${runIndex}-${Date.now()}`;
    const result = { test: '4b', runIndex, electionID, pass: false };

    const { contract, close } = await connectAs('IEBC');
    try {
        const [voter] = loadVoters(1, 500 + runIndex * 3);
        const vatID = await mintVAT(contract, voter.hash, electionID, POLLING_STATION);
        result.vatID = vatID;

        const args = buildCastArgs(vatID, CANDIDATE, electionID);
        const capturedBallot = { vatID: args.vatID, candidateID: args.candidateID, ephemeralPubKey: args.ephemeralPubKey, signatureB64: args.signatureB64, payloadStr: args.payloadStr, nonce: args.nonce };
        writeJSON(dir, 'captured-ballot.json', capturedBallot);

        const res1Bytes = await contract.submitTransaction(
            'CastBallot', args.vatID, args.candidateID, args.ephemeralPubKey, args.signatureB64, args.payloadStr, args.nonce
        );
        result.originalCommitted = true;
        result.originalResult = JSON.parse(Buffer.from(res1Bytes).toString('utf8'));

        const invBefore = JSON.parse(Buffer.from(await contract.evaluateTransaction('GetAuditInvariant', electionID)).toString('utf8'));
        result.invariantBefore = invBefore;

        // Argument-tuple replay: identical six arguments, fresh SDK call
        // (new Fabric transaction ID, new gRPC proposal — see DEV-004).
        let replayError = null;
        try {
            await contract.submitTransaction(
                'CastBallot',
                capturedBallot.vatID, capturedBallot.candidateID, capturedBallot.ephemeralPubKey,
                capturedBallot.signatureB64, capturedBallot.payloadStr, capturedBallot.nonce
            );
        } catch (err) {
            replayError = errorText(err) || err.message;
        }

        result.replayError = replayError;
        result.replayRejected = replayError !== null;
        result.containsNonceUsed = !!(replayError && replayError.includes('ERR_NONCE_USED'));
        result.containsVatNotActive = !!(replayError && replayError.includes('ERR_VAT_NOT_ACTIVE'));
        result.containsBadSignature = !!(replayError && replayError.includes('ERR_BAD_SIGNATURE'));

        const invAfter = JSON.parse(Buffer.from(await contract.evaluateTransaction('GetAuditInvariant', electionID)).toString('utf8'));
        result.invariantAfter = invAfter;
        result.invariantUnchanged = invBefore.burnedCount === invAfter.burnedCount && invBefore.tallyTotal === invAfter.tallyTotal;

        result.pass = result.replayRejected && result.containsNonceUsed && !result.containsVatNotActive && result.invariantUnchanged;
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        close();
    }

    writeJSON(dir, 'result.json', jsonSafe(result));
    capturePeerLogs(dir, PEER_LOGS, 200);

    const keyEvidence = result.replayError || result.fatalError || 'no error captured';
    console.log(`test4b run${runIndex} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

if (require.main === module) {
    const runIndex = parseInt(process.argv[2] || '1', 10);
    run(runIndex).then((r) => process.exit(r.pass ? 0 : 1)).catch((e) => { console.error('FATAL', e); process.exit(2); });
}

module.exports = { run };
