#!/usr/bin/env node
'use strict';
/**
 * Test 3 — End-to-End Parity Audit
 * IMPLEMENTATION_BRIEF.md Section 6: cast 1,000 synthetic votes via the test
 * harness, then call GetAuditInvariant. Success: burnedCount == tallyTotal
 * exactly, repeated 3 times. Design and success metric unchanged from the
 * original sequential implementation — see docs/DEVIATIONS.md for the
 * implementation-speed optimisation recorded below.
 *
 * Mint phase: VATs are minted CONCURRENTLY (bounded pool). MintVAT touches
 * only per-voter-unique keys (VAT~vatID, VOTERISSUED~electionID~voterHash —
 * see chaincode/voting/lib/votingContract.js), so there is no shared counter
 * and no MVCC contention risk for this phase (docs/PHASE4_DECISIONS.md E.1).
 *
 * Cast phase: ballots are cast SEQUENTIALLY, unchanged from the original
 * design. CastBallot increments TALLY~election~candidate and
 * BURNEDCOUNT~election, both single hot keys — concurrent casts would
 * produce MVCC conflicts (the genuine, correct finding demonstrated
 * separately in test1b) that would falsely fail this parity test if applied
 * here. Per-vote cast latency capture is preserved exactly as before.
 */

const { connectAs } = require('./lib/gateway');
const { mintVAT, buildCastArgs, errorText } = require('./lib/vote');
const { loadVoters } = require('./lib/voters');
const { isoStamp, evidenceDir, writeJSON, writeText, capturePeerLogs, jsonSafe } = require('./lib/evidence');
const { mapConcurrent } = require('./lib/concurrency');

const CANDIDATES = ['C001', 'C002', 'C003', 'C004'];
const POLLING_STATION = 'PS-TEST3';
const PEER_LOGS = ['peer0.orgiebc.example.com', 'peer0.orgjudiciary.example.com'];
const MINT_CONCURRENCY = 30;

async function run(runIndex, count = 1000) {
    const stamp = isoStamp();
    const dir = evidenceDir('test3', stamp);
    const electionID = `test3-run${runIndex}-${Date.now()}`;
    const result = { test: '3', runIndex, electionID, count, pass: false };

    const { contract, close } = await connectAs('IEBC');
    let committed = 0;
    let failed = 0;

    try {
        const voters = loadVoters(count, 1000 + runIndex * count);

        // Mint phase — concurrent, bounded.
        const mintStart = Date.now();
        const mintResults = await mapConcurrent(voters, MINT_CONCURRENCY, async (voter) => {
            const t0 = Date.now();
            try {
                const vatID = await mintVAT(contract, voter.hash, electionID, POLLING_STATION);
                return { vatID, mintMs: Date.now() - t0, mintError: null };
            } catch (err) {
                return { vatID: null, mintMs: Date.now() - t0, mintError: errorText(err) || err.message };
            }
        });
        const mintTotalMs = Date.now() - mintStart;
        process.stderr.write(`  test3 run${runIndex}: mint phase done — ${mintTotalMs}ms for ${count} votes (concurrency=${MINT_CONCURRENCY})\n`);

        // Cast phase — sequential, unchanged; per-vote timing preserved.
        const csvRows = ['voteIndex,voterId,candidateID,mintMs,castMs,error'];
        const castStart = Date.now();
        for (let i = 0; i < voters.length; i++) {
            const voter = voters[i];
            const candidateID = CANDIDATES[i % CANDIDATES.length];
            const mintResult = mintResults[i];
            let castMs = 0;
            let errMsg = mintResult.mintError || '';

            if (!mintResult.mintError) {
                try {
                    const args = buildCastArgs(mintResult.vatID, candidateID, electionID);
                    const t1 = Date.now();
                    await contract.submitTransaction(
                        'CastBallot', args.vatID, args.candidateID, args.ephemeralPubKey, args.signatureB64, args.payloadStr, args.nonce
                    );
                    castMs = Date.now() - t1;
                    committed++;
                } catch (err) {
                    failed++;
                    errMsg = (errorText(err) || err.message).replace(/[\n,]/g, ' ');
                }
            } else {
                failed++;
            }
            csvRows.push(`${i},${voter.voter_id},${candidateID},${mintResult.mintMs},${castMs},${errMsg}`);
            if ((i + 1) % 100 === 0) {
                process.stderr.write(`  test3 run${runIndex}: cast ${i + 1}/${count} (committed=${committed} failed=${failed})\n`);
            }
        }
        const castTotalMs = Date.now() - castStart;
        result.mintTotalMs = mintTotalMs;
        result.castTotalMs = castTotalMs;
        result.totalMs = mintTotalMs + castTotalMs;

        const invBytes = await contract.evaluateTransaction('GetAuditInvariant', electionID);
        const invariant = JSON.parse(Buffer.from(invBytes).toString('utf8'));
        result.invariant = invariant;
        result.committed = committed;
        result.failed = failed;
        result.invariantOK = invariant.burnedCount === invariant.tallyTotal && invariant.burnedCount === committed;
        result.pass = failed === 0 && result.invariantOK && committed === count;

        writeText(dir, 'votes.csv', csvRows.join('\n') + '\n');
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        close();
    }

    writeJSON(dir, 'result.json', jsonSafe(result));
    capturePeerLogs(dir, PEER_LOGS, 300);

    const keyEvidence = result.invariant
        ? `burnedCount=${result.invariant.burnedCount} tallyTotal=${result.invariant.tallyTotal} committed=${committed}/${count} mintMs=${result.mintTotalMs} castMs=${result.castTotalMs}`
        : (result.fatalError || 'no result');
    console.log(`test3 run${runIndex} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

if (require.main === module) {
    const runIndex = parseInt(process.argv[2] || '1', 10);
    const count = parseInt(process.argv[3] || '1000', 10);
    run(runIndex, count).then((r) => process.exit(r.pass ? 0 : 1)).catch((e) => { console.error('FATAL', e); process.exit(2); });
}

module.exports = { run };
