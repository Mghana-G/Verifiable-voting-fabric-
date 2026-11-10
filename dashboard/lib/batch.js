'use strict';

// "Simulate N voters at this polling station". Runs as a job (lib/jobs.js).
//   - takes the next N registry voters after the stored integer offset
//   - recomputes each hash, mints with up to 5 concurrent MintVATs
//   - casts strictly ONE AT A TIME (DEV-005: the TALLY and BURNEDCOUNT keys conflict under concurrency)
// Secrecy: the voter-to-vat map exists only in this function's memory. Events
// and logs carry a row number, transaction ID, block, latency and result,
// never a voter ID or voter hash.

const election = require('./election');
const registry = require('./registry');
const station = require('./station');
const ballotkit = require('./ballotkit');
const gw = require('./gw');
const { ORGS } = require('./fabric');

const MINT_CONCURRENCY = 5;
const CAP = 100;

async function pool(items, limit, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next; next += 1;
            // eslint-disable-next-line no-await-in-loop
            await worker(items[i], i);
        }
    });
    await Promise.all(runners);
}

async function run(ctx, requested) {
    const count = Math.max(1, Math.min(CAP, Math.floor(Number(requested)) || 20));
    const el = election.current();
    const cands = election.candidates().onBallot.map((c) => c.candidateID);
    ctx.log(`Simulating ${count} voters for ${el.electionID} at ${el.pollingStationID}. Mints run up to ${MINT_CONCURRENCY} at a time; casts run one at a time.`);
    ctx.emit({ type: 'start', count, electionID: el.electionID });

    let offset = election.state().elections[el.electionID].batchOffset || 0;
    const minted = [];
    let skipped = 0;
    let unverified = 0;
    const total = registry.count();
    while (minted.length < count && offset < total) {
        const want = count - minted.length;
        const chunk = registry.chunk(offset, want);
        if (!chunk.length) break;
        offset += chunk.length;
        const good = chunk.filter((v) => { if (!v.verified) unverified += 1; return v.verified; });
        // eslint-disable-next-line no-await-in-loop
        await pool(good, MINT_CONCURRENCY, async (v) => {
            try {
                const m = await station.mintVAT(v.voterHash, el.electionID, el.pollingStationID);
                minted.push({ vatID: m.result, mintBlock: m.blockNumber });
            } catch (e) {
                if (e.classified && e.classified.code === 'ERR_DUPLICATE_ISSUANCE') skipped += 1;
                else throw e;
            }
        });
        election.setBatchOffset(offset);
        ctx.emit({ type: 'progress', phase: 'mint', minted: minted.length, of: count, skipped });
    }
    if (skipped) ctx.log(`${skipped} registry voters already held a token in this election and were skipped.`);
    if (minted.length < count) ctx.log(`Only ${minted.length} voters could be issued a token (registry exhausted or rejected).`);

    const latencies = [];
    const tally = {};
    let ok = 0;
    let failed = 0;
    const castStart = Date.now();
    for (let i = 0; i < minted.length; i += 1) {
        const candidateID = cands[Math.floor(Math.random() * cands.length)];
        const sealed = ballotkit.seal(minted[i].vatID, candidateID, el.electionID);
        try {
            // eslint-disable-next-line no-await-in-loop
            const r = await station.castBallot(sealed);
            ok += 1;
            latencies.push(r.latencyMs);
            tally[candidateID] = (tally[candidateID] || 0) + 1;
            ctx.emit({ type: 'row', n: i + 1, of: minted.length, txID: r.txID, block: r.blockNumber, ms: r.latencyMs, result: r.validationCode, candidateID });
        } catch (e) {
            failed += 1;
            ctx.emit({ type: 'row', n: i + 1, of: minted.length, txID: e.txID || null, block: e.blockNumber || null, ms: null, result: (e.classified && e.classified.code) || 'FAILED', candidateID });
        }
        minted[i] = null; // drop the token reference as soon as it is used
    }
    const elapsedMs = Date.now() - castStart;
    election.addVotes(ok);

    const audit = await gw.queryVoting(ORGS.find((o) => o.key === 'CivilSociety'), 'GetAuditInvariant', el.electionID, 6000);
    const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
    const summary = {
        requested: count, committed: ok, failed, skipped, unverified, tally,
        meanLatencyMs: mean === null ? null : Math.round(mean * 10) / 10,
        ballotsPerSecond: elapsedMs > 0 && ok ? Math.round((ok / (elapsedMs / 1000)) * 100) / 100 : null,
        elapsedMs,
        invariant: audit.ok ? audit.value : { unavailable: true, reason: audit.reason },
    };
    ctx.log(`Done: ${ok} committed, ${failed} failed. Mean ${summary.meanLatencyMs} ms per ballot, ${summary.ballotsPerSecond} ballots/s.`);
    return { exitCode: failed === 0 ? 0 : 1, result: summary };
}

function start(count) {
    const jobs = require('./jobs');
    const el = election.current();
    if (el.locked) return { ok: false, reason: 'Voting is closed by the dashboard lock for this election.' };
    return jobs.start('batch', `Simulate ${count} voters`, (ctx) => run(ctx, count), { logToFile: false });
}

module.exports = { start, CAP };
