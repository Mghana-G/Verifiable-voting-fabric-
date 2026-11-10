'use strict';

// POST /api/export/report: a one-page status report for the supervisor,
// written to dashboard/out/status-report.md. Built only from the collected
// state and the live reading, so every figure traces to a file or a query.
// British English, no em dashes.

const fs = require('fs');
const path = require('path');
const { DASH, isMissing } = require('./util');

const OUT = path.join(DASH, 'out', 'status-report.md');

const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC') : 'unknown');
const val = (v, f = String) => (isMissing(v) ? `MISSING (${v.why})` : (v && v.__unavailable ? `unavailable (${v.why})` : f(v)));
const n0 = (x) => Number(x).toLocaleString('en-GB');
const n1 = (x) => Number(x).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n3 = (x) => Number(x).toLocaleString('en-GB', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const pct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)} %`;
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ');

function networkSection(live, last) {
    const L = [];
    L.push('## Network');
    L.push('');
    if (live && live.status === 'up') {
        const n = live.network;
        const heights = n.peers.map((p) => `${p.org} ${val(p.height, n0)}`).join(', ');
        L.push(`Up at ${when(live.readAt)}: ${n.runningCount} of ${n.expected} services running, ${n.heightsEqual ? 'all four peer heights equal' : 'peer heights differ'} (${heights}).`);
        const l = n.raftLeader;
        L.push(`Raft leader: ${l && l.leader ? `${l.leader} (term ${l.term})` : 'not yet read'}. Orderer BatchTimeout from the decoded channel config: ${n.batchTimeout && n.batchTimeout.batchTimeout ? n.batchTimeout.batchTimeout : 'not yet read'}.`);
        const d = live.chaincode && live.chaincode.definition;
        if (d && d.version) L.push(`Chaincode ${d.name} ${d.version}, sequence ${d.sequence}, policy ${d.endorsementPolicy}.`);
    } else {
        L.push(`The network was not fully up when this report was written (${live ? live.summary : 'no live reading taken'}).`);
        L.push(last ? `Last reading with every service answering: ${when(last.at)}, peer heights ${last.network.peers.map((p) => val(p.height, n0)).join(', ')}.` : 'No earlier reading is on record.');
    }
    L.push('');
    return L;
}

function build(state, live, last) {
    const L = [];
    const b = state.build;
    L.push('# Voting network: status report');
    L.push('');
    L.push('Blockchain-Based Voting System for End-to-End Verifiability, Kenyan presidential election prototype (Gift Mghana, 169774).');
    L.push(`Generated ${when(new Date().toISOString())}. Repository commit ${isMissing(b.current) || b.error ? 'MISSING' : `${b.current.hash} on ${b.current.branch}`}, ${isMissing(b.uncommitted) || b.error ? 'uncommitted changes MISSING' : `${b.uncommitted.count} uncommitted change${b.uncommitted.count === 1 ? '' : 's'}`}.`);
    L.push('');
    L.push(...networkSection(live, last));

    const c = state.criteria;
    L.push('## Success criteria (evidence/SUMMARY.md)');
    L.push('');
    if (c.error || isMissing(c.criteria)) {
        L.push(`MISSING (${c.error || c.criteria.why})`);
    } else {
        L.push(`${c.provenCount} of 7 proven, ${c.measuredCount} of 2 measured.`);
        L.push('');
        L.push('| # | Criterion | Result |');
        L.push('|---|---|---|');
        for (const x of c.criteria) L.push(`| ${x.number} | ${cell(x.description || '')} | ${val(x.result)} |`);
    }
    L.push('');

    L.push('## Tests');
    L.push('');
    L.push('| Test | Newest valid run | Valid runs | Regression | Invalid | Superseded | Observed |');
    L.push('|---|---|---|---|---|---|---|');
    for (const t of state.tests.cards || []) {
        const r = t.runs;
        L.push(`| ${t.id} ${cell(t.name)} | ${isMissing(t.newest) ? 'MISSING' : (t.newest.pass === true ? 'PASS' : 'FAIL')} | ${r.valid.count} (${r.valid.passed} pass) | ${r.regression.count} (${r.regression.passed} pass) | ${r.invalid.count} | ${r.superseded.count} | ${isMissing(t.newest) ? 'MISSING' : cell(val(t.newest.observed))} |`);
    }
    L.push('');

    const p = state.performance;
    L.push('## Performance (test7, evidence/test7)');
    L.push('');
    if (p.error) {
        L.push(`MISSING (${p.error})`);
    } else {
        L.push('| Scale | Mean ms | Median ms | p95 ms | Ballots/s | Tx/s | Invariant |');
        L.push('|---|---|---|---|---|---|---|');
        for (const r of p.sweep) {
            if (r.error) { L.push(`| ${r.scale} | MISSING | | | | | |`); continue; }
            L.push(`| ${n0(r.scale)} | ${val(r.latencyMeanMs, n1)} | ${val(r.latencyMedianMs, n0)} | ${val(r.latencyP95Ms, n0)} | ${val(r.throughputBallotsPerSec, n3)} | ${val(r.throughputTxPerSec, n3)} | ${isMissing(r.invariant) ? 'MISSING' : `${r.invariant.burnedCount} = ${r.invariant.tallyTotal}`} |`);
        }
        const ch = p.change;
        const f = (k) => (isMissing(ch[k]) ? 'MISSING' : pct(ch[k].percent));
        L.push('');
        L.push(`Change from ${n0(ch.from)} to ${n0(ch.to)} votes: mean latency ${f('latencyMeanMs')}, median ${f('latencyMedianMs')}, p95 ${f('latencyP95Ms')}, throughput ${f('throughputBallotsPerSec')} (computed from the result files).`);
        const q = p.probe;
        if (!q.error) L.push(`Contention probe: ${val(q.firstAttemptMvccConflicts)} of ${val(q.scale)} first attempts conflicted (${isMissing(q.mvccConflictRate) ? 'MISSING' : n1(q.mvccConflictRate * 100)} %), ${val(q.totalRetries)} retries, ${val(q.finalCommitted)} committed within the retry limit.`);
    }
    L.push('');

    const d = state.deviations;
    L.push('## Deviations and blockers');
    L.push('');
    if (d.error || isMissing(d.deviations)) {
        L.push(`MISSING (${d.error || d.deviations.why})`);
    } else {
        for (const x of d.deviations) L.push(`- ${x.id}: ${cell(x.title)}. Status: ${val(x.status)}.`);
        L.push(`- Open blockers: ${isMissing(d.openBlockers) ? 'MISSING' : d.openBlockers}.`);
    }
    L.push('');

    const s = state.screenshots;
    const open = state.missing || [];
    L.push('## Still open');
    L.push('');
    L.push(`- Chapter 5 screenshots present: ${s.error ? 'MISSING' : `${s.present} of ${s.expected}`}.`);
    L.push(`- Fields reported MISSING by the dashboard: ${open.length}.`);
    L.push(`- Live demo (parked): ${live && live.demo ? (live.demo.built ? 'built' : `not built (${live.demo.builtNote})`) : 'not read'}.`);
    L.push(`- Next milestone: ${val(state.status.nextMilestone)}.`);
    L.push('');
    return L.join('\n');
}

function write(state, live, last) {
    const text = build(state, live, last);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const tmp = `${OUT}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, OUT);
    return { path: 'dashboard/out/status-report.md', bytes: Buffer.byteLength(text), lines: text.split('\n').length, writtenAt: new Date().toISOString() };
}

module.exports = { write, build };
