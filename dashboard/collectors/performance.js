'use strict';

// Panels 6 (timing trials), 9 (performance sweep), 10 (contention probe),
// 11 (resources) and 12 (recovery). Every number comes from an evidence file
// and is passed through unrounded; derived figures (percentage change,
// projections, durations) are computed here from those values only.

const fs = require('fs');
const {
    missing, isMissing, repoPath, readJSON, readText, field, listDirs, safe,
} = require('../lib/util');

const SCALES = [100, 500, 1000, 5000, 10000];
const SWEEP_KEYS = ['latencyMeanMs', 'latencyMedianMs', 'latencyP95Ms', 'throughputBallotsPerSec', 'throughputTxPerSec'];

function newestDir(relBase) {
    const dirs = listDirs(repoPath(relBase)).filter((d) => /^\d{4}-/.test(d));
    return dirs.length ? `${relBase}/${dirs[dirs.length - 1]}` : null;
}

function sweep() {
    return SCALES.map((scale) => {
        const dir = newestDir(`evidence/test7/scale-${scale}`);
        if (!dir) return { scale, error: missing(`no run directory under evidence/test7/scale-${scale}/`) };
        const file = `${dir}/result.json`;
        const r = readJSON(repoPath(file));
        const row = { scale, dir };
        for (const k of [...SWEEP_KEYS, 'committed', 'failed', 'mintTotalMs', 'castTotalMs', 'invariant', 'invariantOK', 'pass']) {
            row[k] = field(r, k, file);
        }
        return row;
    });
}

// Percentage change from the smallest to the largest scale, per metric.
function change(rows) {
    const first = rows.find((r) => r.scale === SCALES[0]);
    const last = rows.find((r) => r.scale === SCALES[SCALES.length - 1]);
    const out = { from: SCALES[0], to: SCALES[SCALES.length - 1] };
    for (const k of SWEEP_KEYS) {
        const a = first && first[k];
        const b = last && last[k];
        if (!first || !last || isMissing(a) || isMissing(b) || typeof a !== 'number' || typeof b !== 'number') {
            out[k] = missing(`cannot compute ${k} change: value absent at scale ${SCALES[0]} or ${SCALES[SCALES.length - 1]}`);
        } else {
            out[k] = { from: a, to: b, percent: ((b - a) / a) * 100 };
        }
    }
    return out;
}

function probe() {
    const base = 'evidence/test7/concurrency-probe';
    const dirs = listDirs(repoPath(base)).filter((d) => /^\d{4}-/.test(d));
    if (!dirs.length) return { error: missing(`no run directory under ${base}/`) };
    const dir = `${base}/${dirs[dirs.length - 1]}`;
    const file = `${dir}/result.json`;
    const r = readJSON(repoPath(file));
    const out = { dir, runCount: dirs.length };
    for (const k of ['scale', 'windowSize', 'maxRetries', 'firstAttemptCommitted', 'firstAttemptMvccConflicts',
        'firstAttemptOtherFail', 'mvccConflictRate', 'totalRetries', 'finalCommitted', 'invariant', 'invariantOK', 'pass']) {
        out[k] = field(r, k, file);
    }
    out.earlierRuns = dirs.slice(0, -1).map((d) => {
        const f = `${base}/${d}/result.json`;
        return { dir: `${base}/${d}`, pass: field(readJSON(repoPath(f)), 'pass', f) };
    });
    return out;
}

function trial(relDir, label) {
    const file = `${relDir}/100-vote-trial-raw/result.json`;
    const r = readJSON(repoPath(file));
    const t = { label, dir: relDir, file };
    for (const k of ['count', 'mintTotalMs', 'castTotalMs', 'totalMs', 'invariant', 'pass']) t[k] = field(r, k, file);
    const nums = [t.count, t.mintTotalMs, t.castTotalMs, t.totalMs];
    if (nums.some(isMissing)) {
        t.meanCastMs = missing(`cannot compute mean cast latency: field absent in ${file}`);
        t.perVoteTotalMs = t.meanCastMs;
        return t;
    }
    t.meanCastMs = t.castTotalMs / t.count;
    t.meanMintMs = t.mintTotalMs / t.count;
    t.perVoteTotalMs = t.totalMs / t.count;
    const sweepVotes = SCALES.reduce((a, b) => a + b, 0);
    t.projection = {
        test3x3Ms: t.perVoteTotalMs * 1000 * 3,
        sweepMs: t.perVoteTotalMs * sweepVotes,
        sweepVotes,
    };
    t.projection.totalMs = t.projection.test3x3Ms + t.projection.sweepMs;
    return t;
}

function decodedBatchTimeout() {
    const file = 'evidence/network-tuning-500ms/config_block_decoded.json';
    const b = readJSON(repoPath(file));
    if (isMissing(b)) return b;
    const config = field(b, 'data.data', file);
    if (isMissing(config) || !Array.isArray(config) || !config.length) return missing(`no data.data[0] in ${file}`);
    return field(config[0], 'payload.data.config.channel_group.groups.Orderer.values.BatchTimeout.value.timeout', file);
}

function trials() {
    const slow = trial('evidence/timing-trial', '2 s BatchTimeout');
    const fast = trial('evidence/timing-trial-500ms', '500 ms BatchTimeout');
    slow.batchTimeoutDecoded = missing('no decoded channel config was captured while the 2 s BatchTimeout was in force');
    fast.batchTimeoutDecoded = decodedBatchTimeout();
    const factor = (a, b) => (isMissing(a) || isMissing(b) ? missing('trial value absent') : a / b);
    return {
        trials: [slow, fast],
        reduction: {
            meanCast: factor(slow.meanCastMs, fast.meanCastMs),
            perVoteTotal: factor(slow.perVoteTotalMs, fast.perVoteTotalMs),
        },
    };
}

const MEM_UNITS = { B: 1 / 1048576, kB: 1000 / 1048576, KiB: 1 / 1024, MB: 1e6 / 1048576, MiB: 1, GB: 1e9 / 1048576, GiB: 1024 };

// Per-container CPU% and memory (MiB) range across one scale's samples.
// The parse is memoised by file size and mtime: a finished run's CSV never
// changes, and re-reading four megabytes on every page load is wasted work.
const statsMemo = new Map();
function dockerStats(relFile) {
    let key;
    try { const st = fs.statSync(repoPath(relFile)); key = `${relFile}:${st.size}:${st.mtimeMs}`; } catch { return missing(`${relFile} not readable`); }
    if (statsMemo.has(key)) return statsMemo.get(key);
    const parsed = parseDockerStats(relFile);
    statsMemo.set(key, parsed);
    return parsed;
}

function parseDockerStats(relFile) {
    const text = readText(repoPath(relFile));
    if (isMissing(text)) return text;
    const lines = text.split('\n');
    if (!lines[0].startsWith('timestamp,container,cpuPct,memUsage')) return missing(`unexpected header in ${relFile}`);
    const byContainer = new Map();
    let first = null;
    let last = null;
    let errors = 0;
    for (const line of lines.slice(1)) {
        if (!line) continue;
        const [ts, name, cpuStr, memStr = ''] = line.split(',');
        if (name === 'ERROR') { errors++; continue; }
        const cpu = Number(cpuStr);
        const mm = /([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)\b/.exec(memStr);
        if (!Number.isFinite(cpu) || !mm) { errors++; continue; }
        const mem = Number(mm[1]) * MEM_UNITS[mm[2]];
        first = first || ts;
        last = ts;
        const c = byContainer.get(name) || { samples: 0, cpuMin: Infinity, cpuMax: -Infinity, memMinMiB: Infinity, memMaxMiB: -Infinity };
        c.samples++;
        c.cpuMin = Math.min(c.cpuMin, cpu); c.cpuMax = Math.max(c.cpuMax, cpu);
        c.memMinMiB = Math.min(c.memMinMiB, mem); c.memMaxMiB = Math.max(c.memMaxMiB, mem);
        byContainer.set(name, c);
    }
    if (!byContainer.size) return missing(`no parseable samples in ${relFile}`);
    return {
        file: relFile,
        firstSample: first,
        lastSample: last,
        unparsedRows: errors,
        containers: [...byContainer.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, c]) => ({ name, ...c })),
    };
}

function couchSize(relFile) {
    const j = readJSON(repoPath(relFile));
    if (isMissing(j)) return j;
    if (!Array.isArray(j) || !j.length) return missing(`${relFile} is not a non-empty _dbs_info array`);
    const e = j[0];
    return {
        db: field(e, 'key', relFile),
        fileBytes: field(e, 'info.sizes.file', relFile),
        activeBytes: field(e, 'info.sizes.active', relFile),
        externalBytes: field(e, 'info.sizes.external', relFile),
        docCount: field(e, 'info.doc_count', relFile),
    };
}

function resources() {
    return SCALES.map((scale) => {
        const dir = newestDir(`evidence/test7/scale-${scale}`);
        if (!dir) return { scale, error: missing(`no run directory under evidence/test7/scale-${scale}/`) };
        return {
            scale,
            dir,
            dockerStats: dockerStats(`${dir}/dockerstats.csv`),
            couchBefore: couchSize(`${dir}/couchdb-before.json`),
            couchAfter: couchSize(`${dir}/couchdb-after.json`),
        };
    });
}

// Replay window from the Media peer's own log lines in peer-logs.txt:
// "Recommitting lost blocks ... lastBlockNum=N" (start) and
// "Recommitted lost blocks" (end). rebuild-dbs-output.txt is empty in every
// run (the peer writes to stderr), so these markers are the only timing source.
const TS_RE = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d+) UTC/;

function mediaLog(relFile) {
    const text = readText(repoPath(relFile));
    if (isMissing(text)) return text;
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
    const start = clean.indexOf('=== docker logs peer0.orgmedia');
    if (start < 0) return missing(`no Media peer section in ${relFile}`);
    const next = clean.indexOf('=== docker logs', start + 10);
    return clean.slice(start, next < 0 ? clean.length : next);
}

function marker(section, needle) {
    const line = section.split('\n').find((l) => l.includes(needle));
    if (!line) return null;
    const ts = TS_RE.exec(line);
    const last = /lastBlockNum=(\d+)/.exec(line);
    return { at: ts ? `${ts[1]}T${ts[2]}Z` : null, lastBlockNum: last ? Number(last[1]) : null };
}

function recoveryRun(relDir, category) {
    const file = `${relDir}/result.json`;
    const r = readJSON(repoPath(file));
    const run = { dir: relDir, category, pass: field(r, 'pass', file) };

    const fatal = isMissing(r) ? null : r.fatalError;
    run.outcome = fatal ? `failed: ${fatal.split('\n')[0]}` : (run.pass === true ? 'passed' : run.pass);

    const h = field(r, 'heightBeforeRecovery', file);
    const hFromError = fatal && /reach height (\d+)/.exec(fatal);
    if (!isMissing(h)) {
        run.chainHeight = h;
        run.heightSource = 'result.json heightBeforeRecovery';
    } else if (hFromError) {
        run.chainHeight = Number(hFromError[1]);
        run.heightSource = 'result.json fatalError text';
    } else {
        run.chainHeight = h;
    }

    const section = mediaLog(`${relDir}/peer-logs.txt`);
    if (isMissing(section)) {
        run.replayDurationMs = section;
        return run;
    }
    const begin = marker(section, 'Recommitting lost blocks');
    const end = marker(section, 'Recommitted lost blocks');
    run.replayStart = begin ? begin.at : missing(`no 'Recommitting lost blocks' line in ${relDir}/peer-logs.txt`);
    run.replayEnd = end ? end.at : missing(`no 'Recommitted lost blocks' line in ${relDir}/peer-logs.txt`);
    run.replayedBlocks = begin && begin.lastBlockNum !== null ? begin.lastBlockNum + 1 : missing('replay start marker absent, block count unknown');
    const timeout = fatal && /within (\d+)ms/.exec(fatal);
    if (begin && end && begin.at && end.at) {
        run.replayDurationMs = Date.parse(end.at) - Date.parse(begin.at);
        if (typeof run.replayedBlocks === 'number') run.msPerBlock = run.replayDurationMs / run.replayedBlocks;
    } else if (begin && !end && timeout) {
        run.replayDurationMs = missing(`replay still running when the ${timeout[1]} ms wait expired; no end marker`);
    } else {
        run.replayDurationMs = missing(`replay markers fell outside the 300-line peer-logs.txt tail captured at run end (start ${begin ? 'present' : 'absent'}, end ${end ? 'present' : 'absent'})`);
    }
    return run;
}

function recovery() {
    const runs = [];
    for (const d of listDirs(repoPath('evidence/test2'))) {
        runs.push(recoveryRun(`evidence/test2/${d}`, d.startsWith('regression-') ? 'regression' : 'valid'));
    }
    for (const [base, category] of [['evidence/_invalid/test2', 'invalid'], ['evidence/_superseded/test2', 'superseded']]) {
        for (const d of listDirs(repoPath(base))) runs.push(recoveryRun(`${base}/${d}`, category));
    }
    return { runs };
}

async function collect() {
    const rows = sweep();
    return {
        sweep: rows,
        change: change(rows),
        probe: probe(),
        timing: trials(),
        resources: resources(),
        recovery: recovery(),
    };
}

module.exports = { collect: () => safe('performance', collect), SCALES };
