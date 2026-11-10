#!/usr/bin/env node
'use strict';
/**
 * Test 1a — Double-Voting Rejection, Sequential Replay
 * IMPLEMENTATION_BRIEF.md Section 6: mint VAT, cast ballot successfully
 * (commits), then submit a second CastBallot with the same vatID after the
 * first has committed. Success: 100% rejection at the chaincode
 * Execute-phase check (ERR_VAT_NOT_ACTIVE), and the second attempt never
 * reaches the orderer (no new block).
 */

const path = require('path');
const { connectAs } = require('./lib/gateway');
const { mintVAT, buildCastArgs, errorText, containsCode } = require('./lib/vote');
const { loadVoters } = require('./lib/voters');
const { getChannelHeight } = require('./lib/blockchain');
const { isoStamp, evidenceDir, writeJSON, capturePeerLogs, jsonSafe } = require('./lib/evidence');

const CANDIDATE = 'C001';
const POLLING_STATION = 'PS-TEST1A';
const PEER_LOGS = ['peer0.orgiebc.example.com', 'peer0.orgjudiciary.example.com'];

async function run(runIndex) {
    const stamp = isoStamp();
    const dir = evidenceDir('test1a', stamp);
    const electionID = `test1a-run${runIndex}-${Date.now()}`;
    const result = { test: '1a', runIndex, electionID, pass: false };

    const { contract, close } = await connectAs('IEBC');
    try {
        const [voter] = loadVoters(1, runIndex * 3); // distinct voter per run, avoids overlap
        const vatID = await mintVAT(contract, voter.hash, electionID, POLLING_STATION);
        result.vatID = vatID;

        // First CastBallot — must commit successfully.
        const args1 = buildCastArgs(vatID, CANDIDATE, electionID);
        const res1Bytes = await contract.submitTransaction(
            'CastBallot', args1.vatID, args1.candidateID, args1.ephemeralPubKey, args1.signatureB64, args1.payloadStr, args1.nonce
        );
        result.firstCastCommitted = true;
        result.firstCastResult = JSON.parse(Buffer.from(res1Bytes).toString('utf8'));

        const heightBeforeReplay = getChannelHeight('IEBC');

        // Second CastBallot — same vatID (now BURNED), fresh nonce/payload.
        const args2 = buildCastArgs(vatID, CANDIDATE, electionID);
        let secondError = null;
        try {
            await contract.submitTransaction(
                'CastBallot', args2.vatID, args2.candidateID, args2.ephemeralPubKey, args2.signatureB64, args2.payloadStr, args2.nonce
            );
        } catch (err) {
            secondError = errorText(err);
            result.secondErrorName = err.name;
        }

        const heightAfterReplay = getChannelHeight('IEBC');

        result.secondCastError = secondError;
        result.secondCastRejected = secondError !== null;
        result.errorContainsVatNotActive = !!(secondError && secondError.includes('ERR_VAT_NOT_ACTIVE'));
        result.heightBeforeReplay = heightBeforeReplay;
        result.heightAfterReplay = heightAfterReplay;
        result.noNewBlock = heightAfterReplay === heightBeforeReplay;

        const invBytes = await contract.evaluateTransaction('GetAuditInvariant', electionID);
        const invariant = JSON.parse(Buffer.from(invBytes).toString('utf8'));
        result.invariant = invariant;
        result.invariantOK = invariant.burnedCount === 1 && invariant.tallyTotal === 1;

        result.pass = result.secondCastRejected && result.errorContainsVatNotActive && result.noNewBlock && result.invariantOK;
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        close();
    }

    writeJSON(dir, 'result.json', jsonSafe(result));
    capturePeerLogs(dir, PEER_LOGS, 200);

    const keyEvidence = result.secondCastError ? result.secondCastError.split(' || ').pop() : (result.fatalError || 'no error captured');
    console.log(`test1a run${runIndex} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

if (require.main === module) {
    const runIndex = parseInt(process.argv[2] || '1', 10);
    run(runIndex).then((r) => process.exit(r.pass ? 0 : 1)).catch((e) => { console.error('FATAL', e); process.exit(2); });
}

module.exports = { run };
