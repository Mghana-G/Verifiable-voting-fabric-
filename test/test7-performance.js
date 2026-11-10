#!/usr/bin/env node
'use strict';
/**
 * Test 7 — Performance Sweep
 * IMPLEMENTATION_BRIEF.md Section 6.2: measure latency and throughput at
 * increasing vote volumes (100/500/1000/5000/10000). Mint concurrent, cast
 * sequential (docs/DEVIATIONS.md DEV-005), orderer BatchTimeout 500ms
 * (DEV-006). Per scale: cast latency mean/median/p95, throughput (committed
 * ballots/sec and, since each ballot is 2 Fabric transactions, committed
 * tx/sec labelled separately — see docs/PHASE4_DECISIONS.md E.1 "Throughput
 * reporting"), docker stats every 5s, CouchDB votingchannel_voting size
 * before/after, final GetAuditInvariant equality.
 *
 * Also implements the bounded-concurrency probe at one scale (E.1 procedure
 * step 6): a window of concurrent CastBallot submissions with MVCC-conflict
 * retry, evidencing the single-counter (TALLY/BURNEDCOUNT) contention
 * ceiling. This is a separate, additional run — not a replacement for that
 * scale's entry in the main sequential-cast sweep.
 */

const { connectAs } = require('./lib/gateway');
const { mintVAT, buildCastArgs, errorText, submitAndGetStatus } = require('./lib/vote');
const { loadVoters } = require('./lib/voters');
const { mapConcurrent } = require('./lib/concurrency');
const { diskFreeGB, startDockerStatsSampler } = require('./lib/monitoring');
const couchdb = require('./lib/couchdb');
const { isoStamp, evidenceDir, writeJSON, writeText, capturePeerLogs, jsonSafe } = require('./lib/evidence');

const CANDIDATES = ['C001', 'C002', 'C003', 'C004'];
const POLLING_STATION = 'PS-TEST7';
const PEER_LOGS = ['peer0.orgiebc.example.com', 'peer0.orgjudiciary.example.com'];
const MINT_CONCURRENCY = 30;
const MIN_FREE_GB = 5;

function stats(arr) {
    if (arr.length === 0) return { mean: 0, median: 0, p95: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return { mean, median, p95 };
}

async function runScale(scale) {
    const freeGB = diskFreeGB('/');
    if (freeGB < MIN_FREE_GB) {
        const msg = `ABORT: only ${freeGB}GB free on /, below the ${MIN_FREE_GB}GB threshold (Part G risk register)`;
        console.log(`test7 scale=${scale} FAIL | ${msg}`);
        throw new Error(msg);
    }

    const stamp = isoStamp();
    const dir = evidenceDir(`test7/scale-${scale}`, stamp);
    const electionID = `perf-${scale}-${Date.now()}`;
    const result = { test: '7', scale, electionID, pass: false, diskFreeGBBefore: freeGB };

    const couchBefore = await couchdb.dbsInfo(couchdb.COUCHDB_PORTS.IEBC);
    writeJSON(dir, 'couchdb-before.json', couchBefore);

    const statsSampler = startDockerStatsSampler(`${dir}/dockerstats.csv`, 5000);

    const { contract, close } = await connectAs('IEBC');
    let committed = 0, failed = 0;
    const castLatencies = [];
    const csvRows = ['voteIndex,voterId,candidateID,mintMs,castMs,error'];

    try {
        const voters = loadVoters(scale, 0);

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

        const castStart = Date.now();
        for (let i = 0; i < voters.length; i++) {
            const voter = voters[i];
            const candidateID = CANDIDATES[i % CANDIDATES.length];
            const mintResult = mintResults[i];
            let castMs = 0, errMsg = mintResult.mintError || '';
            if (!mintResult.mintError) {
                try {
                    const args = buildCastArgs(mintResult.vatID, candidateID, electionID);
                    const t1 = Date.now();
                    await contract.submitTransaction(
                        'CastBallot', args.vatID, args.candidateID, args.ephemeralPubKey, args.signatureB64, args.payloadStr, args.nonce
                    );
                    castMs = Date.now() - t1;
                    castLatencies.push(castMs);
                    committed++;
                } catch (err) {
                    failed++;
                    errMsg = (errorText(err) || err.message).replace(/[\n,]/g, ' ');
                }
            } else {
                failed++;
            }
            csvRows.push(`${i},${voter.voter_id},${candidateID},${mintResult.mintMs},${castMs},${errMsg}`);
        }
        const castTotalMs = Date.now() - castStart;

        const latStats = stats(castLatencies);
        const throughputBallotsPerSec = committed / (castTotalMs / 1000);
        const throughputTxPerSec = throughputBallotsPerSec * 2; // mint + cast per ballot, DEV-005/E.1

        const invBytes = await contract.evaluateTransaction('GetAuditInvariant', electionID);
        const invariant = JSON.parse(Buffer.from(invBytes).toString('utf8'));

        result.mintTotalMs = mintTotalMs;
        result.castTotalMs = castTotalMs;
        result.committed = committed;
        result.failed = failed;
        result.latencyMeanMs = latStats.mean;
        result.latencyMedianMs = latStats.median;
        result.latencyP95Ms = latStats.p95;
        result.throughputBallotsPerSec = throughputBallotsPerSec;
        result.throughputTxPerSec = throughputTxPerSec;
        result.invariant = invariant;
        result.invariantOK = invariant.burnedCount === invariant.tallyTotal && invariant.burnedCount === committed;
        result.pass = failed === 0 && result.invariantOK && committed === scale;

        writeText(dir, 'latency.csv', csvRows.join('\n') + '\n');
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        close();
        statsSampler.stop();
    }

    const couchAfter = await couchdb.dbsInfo(couchdb.COUCHDB_PORTS.IEBC);
    writeJSON(dir, 'couchdb-after.json', couchAfter);
    result.diskFreeGBAfter = diskFreeGB('/');

    writeJSON(dir, 'result.json', jsonSafe(result));
    capturePeerLogs(dir, PEER_LOGS, 500);

    const keyEvidence = result.invariant
        ? `mean=${result.latencyMeanMs.toFixed(0)}ms median=${result.latencyMedianMs}ms p95=${result.latencyP95Ms}ms throughput=${result.throughputBallotsPerSec.toFixed(2)}ballots/s invariant=${JSON.stringify(result.invariant)}`
        : (result.fatalError || 'no result');
    console.log(`test7 scale=${scale} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

// Bounded-concurrency probe — E.1 step 6. Window of `windowSize` in-flight
// CastBallot submissions, retrying MVCC_READ_CONFLICT up to `maxRetries`.
async function runConcurrencyProbe(scale = 500, windowSize = 10, maxRetries = 5) {
    const stamp = isoStamp();
    const dir = evidenceDir('test7/concurrency-probe', stamp);
    const electionID = `perf-conc-${scale}-${Date.now()}`;
    const result = { test: '7-concurrency-probe', scale, electionID, windowSize, maxRetries, pass: false };

    const { contract, close } = await connectAs('IEBC');
    let firstAttemptCommitted = 0;
    let firstAttemptMvcc = 0;
    let firstAttemptOtherFail = 0;
    let totalRetries = 0;

    try {
        const voters = loadVoters(scale, 0);

        const mintResults = await mapConcurrent(voters, MINT_CONCURRENCY, async (voter) => {
            try {
                const vatID = await mintVAT(contract, voter.hash, electionID, POLLING_STATION);
                return { vatID, mintError: null };
            } catch (err) {
                return { vatID: null, mintError: errorText(err) || err.message };
            }
        });

        async function castWithRetry(mintResult, candidateID) {
            if (mintResult.mintError) return { committed: false };
            for (let attempt = 1; ; attempt++) {
                try {
                    const args = buildCastArgs(mintResult.vatID, candidateID, electionID);
                    const { status } = await submitAndGetStatus(
                        contract, 'CastBallot',
                        [args.vatID, args.candidateID, args.ephemeralPubKey, args.signatureB64, args.payloadStr, args.nonce]
                    );
                    if (status.successful) {
                        if (attempt === 1) firstAttemptCommitted++;
                        return { committed: true };
                    }
                    if (attempt === 1) {
                        if (Number(status.code) === 11) firstAttemptMvcc++;
                        else firstAttemptOtherFail++;
                    }
                    if (attempt > maxRetries) return { committed: false };
                    totalRetries++;
                    await new Promise((r) => setTimeout(r, 200 * attempt));
                } catch (err) {
                    if (attempt === 1) firstAttemptOtherFail++;
                    if (attempt > maxRetries) return { committed: false };
                    totalRetries++;
                    await new Promise((r) => setTimeout(r, 200 * attempt));
                }
            }
        }

        const outcomes = await mapConcurrent(voters, windowSize, (voter, i) =>
            castWithRetry(mintResults[i], CANDIDATES[i % CANDIDATES.length])
        );
        const finalCommitted = outcomes.filter((o) => o.committed).length;

        const invBytes = await contract.evaluateTransaction('GetAuditInvariant', electionID);
        const invariant = JSON.parse(Buffer.from(invBytes).toString('utf8'));

        result.firstAttemptCommitted = firstAttemptCommitted;
        result.firstAttemptMvccConflicts = firstAttemptMvcc;
        result.firstAttemptOtherFail = firstAttemptOtherFail;
        result.mvccConflictRate = firstAttemptMvcc / scale;
        result.totalRetries = totalRetries;
        result.finalCommitted = finalCommitted;
        result.invariant = invariant;
        result.invariantOK = invariant.burnedCount === invariant.tallyTotal && invariant.burnedCount === finalCommitted;
        // This probe's purpose is to EVIDENCE the single-counter contention
        // ceiling (E.1), not to guarantee every vote commits — under heavy
        // concurrent contention on the shared TALLY/BURNEDCOUNT keys, a
        // bounded retry budget (maxRetries) can legitimately leave some
        // votes uncommitted; that is the finding, not a defect. Pass
        // criteria: the probe ran cleanly and the invariant holds exactly
        // for whatever DID commit (no corruption, no double-counting), not
        // finalCommitted === scale.
        result.pass = result.invariantOK;
    } catch (err) {
        result.fatalError = errorText(err) || err.message;
        result.stack = err.stack;
    } finally {
        close();
    }

    writeJSON(dir, 'result.json', jsonSafe(result));

    const keyEvidence = result.fatalError
        || `firstAttemptCommitted=${result.firstAttemptCommitted}/${scale} mvccRate=${(result.mvccConflictRate * 100).toFixed(1)}% retries=${result.totalRetries} finalCommitted=${result.finalCommitted}`;
    console.log(`test7-probe scale=${scale} ${result.pass ? 'PASS' : 'FAIL'} | ${keyEvidence}`);
    return result;
}

if (require.main === module) {
    const mode = process.argv[2] || 'sweep';
    (async () => {
        if (mode === 'sweep') {
            const scales = (process.argv[3] || '100,500,1000,5000,10000').split(',').map(Number);
            let allPass = true;
            for (const scale of scales) {
                const r = await runScale(scale);
                if (!r.pass) allPass = false;
            }
            process.exit(allPass ? 0 : 1);
        } else if (mode === 'probe') {
            const scale = parseInt(process.argv[3] || '500', 10);
            const r = await runConcurrencyProbe(scale);
            process.exit(r.pass ? 0 : 1);
        } else {
            console.error('usage: test7-performance.js sweep [scales] | probe [scale]');
            process.exit(2);
        }
    })().catch((e) => { console.error('FATAL', e); process.exit(2); });
}

module.exports = { runScale, runConcurrencyProbe };
