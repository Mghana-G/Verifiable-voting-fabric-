#!/usr/bin/env node
'use strict';
/**
 * Test 5 — Tampered Ballot Rejection
 * IMPLEMENTATION_BRIEF.md Section 6: modify one field of a signed payload
 * (e.g. candidateID) after signing, submit with the original signature.
 * Success: 100% rejection — signature verification fails against the
 * tampered payload (ERR_BAD_SIGNATURE).
 *
 * Note: the chaincode signs/verifies over `payload` (the canonicalised
 * string), and separately cross-checks payloadObj.candidateID against the
 * candidateID argument (votingContract.js lines 86-90). Tampering the
 * `candidateID` *argument* alone (leaving payload untouched) would trip that
 * cross-check, which also throws ERR_BAD_SIGNATURE — same error, different
 * code path. This test tampers the *payload string itself* after signing,
 * which is the direct signature-forgery case the brief describes.
 */

const { connectAs } = require('./lib/gateway');
const { mintVAT, buildCastArgs, errorText } = require('./lib/vote');
const { loadVoters } = require('./lib/voters');
const { isoStamp, evidenceDir, writeJSON, capturePeerLogs, jsonSafe } = require('./lib/evidence');

const CANDIDATE = 'C001';
const TAMPERED_CANDIDATE = 'C002';
const POLLING_STATION = 'PS-TEST5';
const PEER_LOGS = ['peer0.orgiebc.example.com', 'peer0.orgjudiciary.example.com'];

async function run(runIndex) {
    const stamp = isoStamp();
    const dir = evidenceDir('test5', stamp);
    const electionID = `test5-run${runIndex}-${Date.now()}`;
    const result = { test: '5', runIndex, electionID, pass: false };

    const { contract, close } = await connectAs('IEBC');
    try {
        const [voter] = loadVoters(1, 600 + runIndex * 3);
        const vatID = await mintVAT(contract, voter.hash, electionID, POLLING_STATION);
        result.vatID = vatID;

        const args = buildCastArgs(vatID, CANDIDATE, electionID);

        // Mutate candidateID inside the already-signed payload string, then
        // submit that tampered payload with the original (now-invalid)
        // signature and the original candidateID argument, so the chaincode's
        // arg-vs-payload cross-check is not what fires — the signature
        // verification is.
        const tamperedPayloadStr = args.payloadStr.replace(
            `"candidateID":"${CANDIDATE}"`,
            `"candidateID":"${TAMPERED_CANDIDATE}"`
        );
        if (tamperedPayloadStr === args.payloadStr) {
            throw new Error('tamper did not change the payload string; canonical key format assumption is wrong');
        }
        result.originalPayload = args.payloadStr;
        result.tamperedPayload = tamperedPayloadStr;

        let castError = null;
        try {
            await contract.submitTransaction(
                'CastBallot', args.vatID, args.candidateID, args.ephemeralPubKey, args.signatureB64, tamperedPayloadStr, args.nonce
            );
        } catch (err) {
            castError = errorText(err) || err.message;
        }

        result.castError = castError;
        result.castRejected = castError !== null;
        result.containsBadSignature = !!(castError && castError.includes('ERR_BAD_SIGNATURE'));

        const invBytes = await contract.evaluateTransaction('GetAuditInvariant', electionID);
        const invariant = JSON.parse(Buffer.from(invBytes).toString('utf8'));
        result.invariant = invariant;
        result.invariantOK = invariant.burnedCount === 0 && invariant.tallyTotal === 0;

        result.pass = result.castRejected && result.containsBadSignature && result.invariantOK;
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        close();
    }

    writeJSON(dir, 'result.json', jsonSafe(result));
    capturePeerLogs(dir, PEER_LOGS, 200);

    const keyEvidence = result.castError || result.fatalError || 'no error captured';
    console.log(`test5 run${runIndex} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

if (require.main === module) {
    const runIndex = parseInt(process.argv[2] || '1', 10);
    run(runIndex).then((r) => process.exit(r.pass ? 0 : 1)).catch((e) => { console.error('FATAL', e); process.exit(2); });
}

module.exports = { run };
