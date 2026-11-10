#!/usr/bin/env node
'use strict';
/**
 * Test 1b — Double-Voting Rejection, Concurrent Race
 * IMPLEMENTATION_BRIEF.md Section 6: mint one VAT, then submit two
 * CastBallot transactions referencing the same still-ACTIVE vatID at
 * effectively the same time (Promise.all on two submit calls). Success:
 * exactly one commits; the other is marked invalid in the block due to an
 * MVCC read-set conflict, not a chaincode-level rejection.
 *
 * Uses submitAndGetStatus (not contract.submitTransaction) so an
 * unsuccessful commit is observed as a Status object (code, blockNumber)
 * rather than a thrown CommitError, letting both outcomes be inspected
 * uniformly.
 */

const { connectAs } = require('./lib/gateway');
const { mintVAT, buildCastArgs, submitAndGetStatus, errorText } = require('./lib/vote');
const { loadVoters } = require('./lib/voters');
const { getBlockValidationCodes } = require('./lib/blockchain');
const { isoStamp, evidenceDir, writeJSON, capturePeerLogs, jsonSafe } = require('./lib/evidence');

const CANDIDATE = 'C001';
const POLLING_STATION = 'PS-TEST1B';
const PEER_LOGS = ['peer0.orgiebc.example.com', 'peer0.orgjudiciary.example.com'];

async function run(runIndex) {
    const stamp = isoStamp();
    const dir = evidenceDir('test1b', stamp);
    const electionID = `test1b-run${runIndex}-${Date.now()}`;
    const result = { test: '1b', runIndex, electionID, pass: false };

    const { contract, close } = await connectAs('IEBC');
    try {
        const [voter] = loadVoters(1, 100 + runIndex * 3);
        const vatID = await mintVAT(contract, voter.hash, electionID, POLLING_STATION);
        result.vatID = vatID;

        const argsA = buildCastArgs(vatID, CANDIDATE, electionID);
        const argsB = buildCastArgs(vatID, CANDIDATE, electionID);

        const [outcomeA, outcomeB] = await Promise.allSettled([
            submitAndGetStatus(contract, 'CastBallot', [argsA.vatID, argsA.candidateID, argsA.ephemeralPubKey, argsA.signatureB64, argsA.payloadStr, argsA.nonce]),
            submitAndGetStatus(contract, 'CastBallot', [argsB.vatID, argsB.candidateID, argsB.ephemeralPubKey, argsB.signatureB64, argsB.payloadStr, argsB.nonce]),
        ]);

        function summarize(outcome, label) {
            if (outcome.status === 'fulfilled') {
                const { status } = outcome.value;
                return { label, settled: 'fulfilled', successful: status.successful, code: Number(status.code), transactionId: status.transactionId, blockNumber: status.blockNumber };
            }
            return { label, settled: 'rejected', error: errorText(outcome.reason) || outcome.reason.message };
        }

        const summaryA = summarize(outcomeA, 'A');
        const summaryB = summarize(outcomeB, 'B');
        result.outcomeA = summaryA;
        result.outcomeB = summaryB;

        // Independently corroborate via the block's TRANSACTIONS_FILTER metadata
        // (peer-sourced, per E.3 — orderer copies have an empty filter).
        const blockNumbers = [summaryA, summaryB]
            .filter((s) => s.settled === 'fulfilled' && s.blockNumber !== undefined)
            .map((s) => Number(s.blockNumber));
        const uniqueBlocks = [...new Set(blockNumbers)];
        result.blocksInvolved = uniqueBlocks;
        const blockDecodes = uniqueBlocks.map((b) => {
            const decoded = getBlockValidationCodes(b, 'IEBC', dir);
            return { blockNumber: b, codes: decoded.codes, labels: decoded.labels, numTx: decoded.numTx };
        });
        result.blockDecodes = blockDecodes;

        const codes = [summaryA, summaryB].filter((s) => s.settled === 'fulfilled').map((s) => s.code);
        const successCount = codes.filter((c) => c === 0).length;
        const mvccCount = codes.filter((c) => c === 11).length;
        result.successCount = successCount;
        result.mvccConflictCount = mvccCount;

        const invBytes = await contract.evaluateTransaction('GetAuditInvariant', electionID);
        const invariant = JSON.parse(Buffer.from(invBytes).toString('utf8'));
        result.invariant = invariant;
        result.invariantOK = invariant.burnedCount === 1 && invariant.tallyTotal === 1;

        const blockShowsBoth = blockDecodes.some((bd) => bd.codes.includes(0)) &&
            (blockDecodes.some((bd) => bd.codes.includes(11)) || mvccCount >= 1);

        result.pass = successCount === 1 && mvccCount === 1 && result.invariantOK;
        result.blockCorroboration = blockShowsBoth;
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        close();
    }

    writeJSON(dir, 'result.json', jsonSafe(result));
    capturePeerLogs(dir, PEER_LOGS, 200);

    const keyEvidence = `success=${result.successCount} mvcc=${result.mvccConflictCount}`;
    console.log(`test1b run${runIndex} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

if (require.main === module) {
    const runIndex = parseInt(process.argv[2] || '1', 10);
    run(runIndex).then((r) => process.exit(r.pass ? 0 : 1)).catch((e) => { console.error('FATAL', e); process.exit(2); });
}

module.exports = { run };
