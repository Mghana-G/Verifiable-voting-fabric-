#!/usr/bin/env node
'use strict';
/**
 * Generates evidence/SUMMARY.md mapping IMPLEMENTATION_BRIEF.md Section 6.1
 * success criteria 1-9 to the evidence files that prove each. Criteria 1-7
 * use the three most recent runs of each functional test found under
 * evidence/<test>/. Criteria 8 (latency) and 9 (throughput) are "measured"
 * criteria per Section 6.2, not pass/fail x3 — they use the latest test7
 * result at each of the five required scales (100/500/1000/5000/10000).
 */

const fs = require('fs');
const path = require('path');

const EVIDENCE_ROOT = path.join(__dirname, '..', '..', 'evidence');

function latestRuns(testDir, n = 3) {
    const dir = path.join(EVIDENCE_ROOT, testDir);
    if (!fs.existsSync(dir)) return [];
    const stamps = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory()).sort();
    return stamps.slice(-n).map((stamp) => {
        const resultPath = path.join(dir, stamp, 'result.json');
        let result = null;
        if (fs.existsSync(resultPath)) {
            try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch (_) { result = null; }
        }
        return { stamp, path: `evidence/${testDir}/${stamp}/`, result };
    });
}

const REQUIRED_RUNS = 3;

// MASTER_PLAN.md Part D Phase 4 exit gate requires every functional test to
// pass three consecutive times — fewer than 3 runs is incomplete evidence,
// not a pass, even if every run present did pass.
function allPass(runs) {
    return runs.length >= REQUIRED_RUNS && runs.every((r) => r.result && r.result.pass === true);
}

function summaryLine(runs) {
    if (runs.length === 0) return 'no runs found';
    const detail = runs.map((r) => `${r.stamp}: ${r.result && r.result.pass ? 'PASS' : 'FAIL'}`).join('; ');
    if (runs.length < REQUIRED_RUNS) return `INCOMPLETE (${runs.length}/${REQUIRED_RUNS} runs) — ${detail}`;
    return detail;
}

const REQUIRED_SCALES = [100, 500, 1000, 5000, 10000];

// Latest run at each required test7 scale (dir: evidence/test7/scale-<N>/<stamp>/).
function test7Scales() {
    const out = {};
    for (const scale of REQUIRED_SCALES) {
        const runs = latestRuns(`test7/scale-${scale}`, 1);
        out[scale] = runs.length > 0 ? runs[0] : null;
    }
    return out;
}

function main() {
    const tests = {
        '1a': latestRuns('test1a'),
        '1b': latestRuns('test1b'),
        '2': latestRuns('test2'),
        '3': latestRuns('test3'),
        '4a': latestRuns('test4a'),
        '4b': latestRuns('test4b'),
        '5': latestRuns('test5'),
        '6': latestRuns('test6'),
    };

    const criteria = [
        {
            n: 1,
            desc: 'Double voting rejection (sequential + concurrent): 100%',
            testKeys: ['1a', '1b'],
        },
        {
            n: 2,
            desc: 'Replay attack rejection: 100%',
            testKeys: ['4a', '4b'],
        },
        {
            n: 3,
            desc: 'Tampered ballot rejection: 100%',
            testKeys: ['5'],
        },
        {
            n: 4,
            desc: 'Invalid endorsement rejection: 100%',
            testKeys: ['6'],
        },
        {
            n: 5,
            desc: 'Audit invariant accuracy: 100% (burnedCount == tallyTotal, 3 repeats)',
            testKeys: ['3'],
            note: 'GetAuditInvariant is also checked as a side-assertion inside test1a, test1b, test4a and test4b (invariant must be unchanged by a rejected transaction); test3 is the direct 3-repeat evidence for this criterion.',
        },
        {
            n: 6,
            desc: '1,000-vote tally parity: 100%',
            testKeys: ['3'],
        },
        {
            n: 7,
            desc: 'Ledger recovery / detection after peer inconsistency: successful',
            testKeys: ['2'],
        },
    ];

    const lines = [];
    lines.push('# Phase 4 Validation Summary');
    lines.push('');
    lines.push(`Generated ${new Date().toISOString()}.`);
    lines.push('');
    lines.push('Maps IMPLEMENTATION_BRIEF.md Section 6.1 success criteria 1-9 to the evidence');
    lines.push('that proves each. Criteria 1-7 (below) are pass/fail x3 repeats; criteria 8');
    lines.push('and 9 (latency, throughput) are "measured" criteria per Section 6.2 and are');
    lines.push('reported separately further down, from the test7 performance sweep.');
    lines.push('');
    lines.push('| # | Criterion | Test(s) | Result (3 runs) | Evidence |');
    lines.push('|---|---|---|---|---|');

    let overallPass = true;
    for (const c of criteria) {
        const runsPerTest = c.testKeys.map((k) => ({ key: k, runs: tests[k] }));
        const criterionPass = runsPerTest.every(({ runs }) => allPass(runs));
        if (!criterionPass) overallPass = false;
        const testLabel = c.testKeys.join(' + ');
        const resultLabel = runsPerTest.map(({ key, runs }) => `${key}: ${summaryLine(runs)}`).join('<br>');
        const evidenceLabel = runsPerTest.flatMap(({ runs }) => runs.map((r) => r.path)).join('<br>');
        lines.push(`| ${c.n} | ${c.desc} | ${testLabel} | ${criterionPass ? 'PASS' : 'FAIL'} — ${resultLabel} | ${evidenceLabel} |`);
        if (c.note) lines.push(`| | *${c.note}* | | | |`);
    }

    lines.push('');
    lines.push(`**Overall (criteria 1-7): ${overallPass ? 'PASS' : 'FAIL'}**`);
    lines.push('');

    // Criteria 8/9 — "measured", not pass/fail x3 (brief Section 6.2).
    const scales = test7Scales();
    const scalesComplete = REQUIRED_SCALES.every((s) => scales[s] && scales[s].result);
    const scalesAllOK = scalesComplete && REQUIRED_SCALES.every((s) => scales[s].result.invariantOK && scales[s].result.failed === 0);

    lines.push('## Criteria 8 & 9 — Performance (measured, IMPLEMENTATION_BRIEF.md Section 6.2)');
    lines.push('');
    lines.push('| Scale | Mean latency (ms) | Median (ms) | p95 (ms) | Throughput (ballots/s) | Throughput (tx/s) | Invariant | Evidence |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const s of REQUIRED_SCALES) {
        const entry = scales[s];
        if (!entry || !entry.result) {
            lines.push(`| ${s} | — | — | — | — | — | MISSING | — |`);
            continue;
        }
        const r = entry.result;
        const invLabel = r.invariantOK ? `OK (${r.invariant.burnedCount}=${r.invariant.tallyTotal})` : 'MISMATCH';
        lines.push(`| ${s} | ${r.latencyMeanMs.toFixed(1)} | ${r.latencyMedianMs} | ${r.latencyP95Ms} | ${r.throughputBallotsPerSec.toFixed(3)} | ${r.throughputTxPerSec.toFixed(3)} | ${invLabel} | \`${entry.path}\` |`);
    }
    lines.push('');
    lines.push(`**Criterion 8 (latency, measured at all 5 scales): ${scalesComplete ? 'PASS' : 'FAIL'}** — ${scalesComplete ? 'all 5 required scales measured' : 'one or more scales missing'}`);
    lines.push(`**Criterion 9 (throughput, measured at all 5 scales, invariant holds): ${scalesAllOK ? 'PASS' : 'FAIL'}**`);
    lines.push('');

    // Bounded-concurrency probe (E.1) — supporting evidence for criterion 9's
    // discussion of contention, not itself one of the 9 formal criteria.
    const probeRuns = latestRuns('test7/concurrency-probe', 1);
    if (probeRuns.length > 0 && probeRuns[0].result) {
        const p = probeRuns[0].result;
        lines.push('## Bounded-concurrency probe (evidences the single-counter contention ceiling, PHASE4_DECISIONS.md E.1)');
        lines.push('');
        lines.push(`Scale ${p.scale}, window ${p.windowSize}, max retries ${p.maxRetries}: first-attempt committed ${p.firstAttemptCommitted}/${p.scale}, MVCC conflict rate ${(p.mvccConflictRate * 100).toFixed(1)}%, total retries ${p.totalRetries}, final committed ${p.finalCommitted}. Invariant: ${p.invariantOK ? 'OK' : 'MISMATCH'} (${p.invariant.burnedCount}=${p.invariant.tallyTotal}). Evidence: \`${probeRuns[0].path}\``);
        lines.push('');
    }

    lines.push('## Per-test raw results');
    lines.push('');
    for (const [key, runs] of Object.entries(tests)) {
        lines.push(`### test${key}`);
        if (runs.length === 0) {
            lines.push('No runs found.');
        } else {
            for (const r of runs) {
                lines.push(`- \`${r.path}\` — ${r.result && r.result.pass ? 'PASS' : 'FAIL'}`);
            }
        }
        lines.push('');
    }

    const outPath = path.join(EVIDENCE_ROOT, 'SUMMARY.md');
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    console.log(`SUMMARY.md written to ${outPath} — overall ${overallPass ? 'PASS' : 'FAIL'}`);
    process.exit(overallPass ? 0 : 1);
}

main();
