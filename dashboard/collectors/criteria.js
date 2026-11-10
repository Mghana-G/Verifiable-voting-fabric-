'use strict';

// Panel 8 (Criteria, Table 5.5): the nine success criteria as recorded in
// evidence/SUMMARY.md. Criteria 1 to 7 come from its table, with the per-run
// PASS/FAIL list inside each row; 8 and 9 from its "**Criterion N (...): X**"
// lines. Nothing is recomputed here; SUMMARY.md is the record.

const { missing, isMissing, repoPath, readText, stripMd, safe } = require('../lib/util');

const FILE = 'evidence/SUMMARY.md';

// "1a: <ts>: PASS; <ts>: PASS<br>1b: ..." -> [{ test, runs: [{ run, result }] }]
function perTest(cell) {
    return cell.split('<br>').map((part) => {
        const m = /^\s*([0-9]+[a-z]?):\s*(.*)$/.exec(part);
        if (!m) return null;
        const runs = m[2].split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
            const r = /^(.*):\s*(PASS|FAIL)\s*$/.exec(s);
            return r ? { run: r[1].trim(), result: r[2] } : { run: s, result: missing(`unparsed run entry '${s}' in ${FILE}`) };
        });
        return { test: m[1], runs };
    }).filter(Boolean);
}

function criteriaOneToSeven(text) {
    const rows = text.split('\n').map((l) => /^\|\s*([1-7])\s*\|(.*)\|\s*$/.exec(l)).filter(Boolean);
    const out = [];
    for (let n = 1; n <= 7; n++) {
        const row = rows.find((r) => r[1] === String(n));
        if (!row) {
            out.push({ number: n, result: missing(`criterion ${n} row not found in ${FILE}`) });
            continue;
        }
        const cells = row[2].split('|').map((c) => c.trim());
        const [desc, tests, resultCell] = cells;
        const rm = /^(PASS|FAIL)\s*[—-]\s*(.*)$/.exec(resultCell || '');
        out.push({
            number: n,
            description: stripMd(desc),
            tests: (tests || '').split('+').map((t) => t.trim()).filter(Boolean),
            result: rm ? rm[1] : missing(`criterion ${n} result cell not parseable in ${FILE}`),
            runs: rm ? perTest(rm[2]) : [],
        });
    }
    return out;
}

function measured(text, n) {
    const m = new RegExp(`^\\*\\*Criterion ${n} \\(([^)]*)\\):\\s*(PASS|FAIL)\\*\\*(.*)$`, 'm').exec(text);
    if (!m) return { number: n, result: missing(`'**Criterion ${n} (...)' line not found in ${FILE}`) };
    return { number: n, description: m[1], result: m[2], detail: stripMd(m[3].replace(/^\s*[—-]\s*/, '')) };
}

async function collect() {
    const text = readText(repoPath(FILE));
    if (isMissing(text)) return { source: FILE, criteria: text };
    const generated = /^Generated (\S+?)\.?$/m.exec(text);
    const oneToSeven = criteriaOneToSeven(text);
    const eightNine = [measured(text, 8), measured(text, 9)];
    return {
        source: FILE,
        generated: generated ? generated[1] : missing(`no 'Generated <date>' line in ${FILE}`),
        criteria: [...oneToSeven, ...eightNine],
        provenCount: oneToSeven.filter((c) => c.result === 'PASS').length,
        measuredCount: eightNine.filter((c) => c.result === 'PASS').length,
    };
}

module.exports = { collect: () => safe('criteria', collect) };
