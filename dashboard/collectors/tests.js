'use strict';

// Panel 7 (Tests, Table 5.4): one card per functional test. Field names differ
// per test, so each test has its own map onto the result.json fields it
// actually writes (inspected, not assumed). A field the test does not write
// is shown as MISSING; `notes` explain absences that follow from the design.

const path = require('path');
const {
    missing, isMissing, repoPath, readJSON, readText, field, listDirs, safe,
} = require('../lib/util');

const KEY_RE = /ERR_[A-Z_]+|duplicate transaction found|ProposalResponsePayloads do not match|ENDORSEMENT_POLICY_FAILURE|MVCC_READ_CONFLICT/;

function keyString(v) {
    if (isMissing(v)) return v;
    if (v === null) return missing('error string is null');
    const m = KEY_RE.exec(String(v));
    return m ? m[0] : String(v);
}

// Joins already-read parts; any MISSING part makes the whole value MISSING.
function compose(parts, fn) {
    const bad = parts.find(isMissing);
    return bad || fn(...parts);
}

function fmtInvariant(v, file, name) {
    if (isMissing(v)) return v;
    const b = field(v, 'burnedCount', `${file} (${name})`);
    const t = field(v, 'tallyTotal', `${file} (${name})`);
    return compose([b, t], (bb, tt) => `burnedCount ${bb}, tallyTotal ${tt}`);
}

function fmtTally(v) {
    if (isMissing(v)) return v;
    const entries = Object.entries(v);
    return entries.length ? entries.map(([k, n]) => `${k}: ${n}`).join(', ') : '{} (no votes for this election)';
}

const NO_BLOCK = 'rejected at endorsement, so the transaction was never ordered into a block';
const AFTER_ONLY = 'this test records the invariant only after the attempt';

// Static scenario/expected text (Table 5.4) plus how to read each result.json.
const SPECS = {
    '1a': {
        name: 'Double voting, sequential replay',
        scenario: 'Cast a ballot, let it commit, then cast again with the same VAT and a fresh nonce.',
        expected: 'Second cast rejected at endorsement with ERR_VAT_NOT_ACTIVE; no new block.',
        read: (r, f) => ({
            observed: keyString(field(r, 'secondCastError', f)),
            block: compose([field(r, 'heightBeforeReplay', f), field(r, 'heightAfterReplay', f), field(r, 'noNewBlock', f)],
                (b, a, n) => `chain height ${b} before, ${a} after (noNewBlock: ${n})`),
            before: fmtInvariant(field(r, 'invariantBefore', f), f, 'before'),
            after: fmtInvariant(field(r, 'invariant', f), f, 'after'),
            notes: { before: AFTER_ONLY },
        }),
    },
    '1b': {
        name: 'Double voting, concurrent race',
        scenario: 'Submit two CastBallot transactions for the same ACTIVE VAT at the same time.',
        expected: 'One VALID, the other invalidated as MVCC_READ_CONFLICT (code 11) in block metadata.',
        read: (r, f) => {
            const decodes = field(r, 'blockDecodes', f);
            const observed = isMissing(decodes) ? decodes
                : decodes.map((d) => `${(d.labels || []).join(' + ')} (codes ${(d.codes || []).join(', ')})`).join('; ');
            return {
                observed,
                block: compose([field(r, 'blocksInvolved', f)], (b) => `block ${b.join(', ')}`),
                before: fmtInvariant(field(r, 'invariantBefore', f), f, 'before'),
                after: fmtInvariant(field(r, 'invariant', f), f, 'after'),
                notes: { before: AFTER_ONLY },
            };
        },
    },
    '2': {
        name: 'Insider modification of CouchDB',
        scenario: "Tamper a TALLY document in the Media peer's CouchDB, force Media into the endorsement set, then rebuild-dbs.",
        expected: 'Query diverges, endorsement fails (ProposalResponsePayloads do not match), rebuild-dbs restores the honest value.',
        read: (r, f) => ({
            observed: compose([keyString(field(r, 'endorsementError', f)), field(r, 'tallyFromMediaPeer.C001', f), field(r, 'tallyFromHonestPeer.C001', f)],
                (k, media, honest) => `${k}; Media tally ${media} vs honest ${honest}`),
            block: compose([field(r, 'heightBeforeRecovery', f)], (h) => `chain height ${h} at recovery`),
            before: compose([field(r, 'tallyBeforeHonest', f)], (t) => `honest tally ${fmtTally(t)}`),
            after: compose([field(r, 'valueAfterRecovery', f)], (v) => `C001: ${v} after rebuild-dbs`),
            notes: {},
        }),
    },
    '3': {
        name: 'End-to-end parity audit',
        scenario: 'Mint and cast 1,000 votes, then call GetAuditInvariant.',
        expected: 'burnedCount == tallyTotal == 1000, three runs.',
        read: (r, f) => ({
            observed: compose([field(r, 'invariant.burnedCount', f), field(r, 'invariant.tallyTotal', f), field(r, 'committed', f), field(r, 'count', f)],
                (b, t, c, n) => `burnedCount ${b}, tallyTotal ${t}, committed ${c}/${n}`),
            block: field(r, 'blockNumber', f),
            before: fmtInvariant(field(r, 'invariantBefore', f), f, 'before'),
            after: fmtInvariant(field(r, 'invariant', f), f, 'after'),
            notes: { block: 'test3 spreads 1,000 ballots over many blocks and records no single block number', before: AFTER_ONLY },
        }),
    },
    '4a': {
        name: 'Replay, byte-identical signed proposal',
        scenario: 'Re-endorse the exact signed proposal bytes of a committed CastBallot (DEV-004).',
        expected: 'Rejected at the endorser: duplicate transaction found; chaincode never reached.',
        read: (r, f) => ({
            observed: keyString(field(r, 'replayError', f)),
            block: field(r, 'blockNumber', f),
            before: fmtInvariant(field(r, 'invariantBefore', f), f, 'before'),
            after: fmtInvariant(field(r, 'invariantAfter', f), f, 'after'),
            notes: { block: NO_BLOCK },
        }),
    },
    '4b': {
        name: 'Replay, argument tuple',
        scenario: 'Resubmit the same six CastBallot arguments with a fresh transaction ID (DEV-004).',
        expected: 'Rejected by ERR_NONCE_USED, not ERR_VAT_NOT_ACTIVE.',
        read: (r, f) => ({
            observed: keyString(field(r, 'replayError', f)),
            block: field(r, 'blockNumber', f),
            before: fmtInvariant(field(r, 'invariantBefore', f), f, 'before'),
            after: fmtInvariant(field(r, 'invariantAfter', f), f, 'after'),
            notes: { block: NO_BLOCK },
        }),
    },
    '5': {
        name: 'Tampered ballot',
        scenario: 'Change candidateID inside the payload after signing and submit with the original signature.',
        expected: 'Rejected with ERR_BAD_SIGNATURE.',
        read: (r, f) => ({
            observed: keyString(field(r, 'castError', f)),
            block: field(r, 'blockNumber', f),
            before: fmtInvariant(field(r, 'invariantBefore', f), f, 'before'),
            after: fmtInvariant(field(r, 'invariant', f), f, 'after'),
            notes: { block: NO_BLOCK, before: AFTER_ONLY },
        }),
    },
    '6': {
        name: 'Invalid endorsement (2 of 4)',
        scenario: 'peer chaincode invoke with only two --peerAddresses against the OutOf(3, ...) policy.',
        expected: 'Committed as invalid, ENDORSEMENT_POLICY_FAILURE (code 10); tally unchanged.',
        read: (r, f) => ({
            observed: compose([field(r, 'txValidationLabels', f), field(r, 'txValidationCodes', f)],
                (l, c) => `${l.join(', ')} (code ${c.join(', ')})`),
            block: compose([field(r, 'blockNumber', f)], (b) => `block ${b}`),
            before: compose([field(r, 'tallyBefore', f)], (t) => `tally ${fmtTally(t)}`),
            after: compose([field(r, 'tallyAfter', f), field(r, 'tallyUnchanged', f)], (t, u) => `tally ${fmtTally(t)} (unchanged: ${u})`),
            notes: {},
        }),
    },
};

const TEST_ORDER = ['1a', '1b', '2', '3', '4a', '4b', '5', '6'];

function runInfo(relDir) {
    const file = `${relDir}/result.json`;
    const r = readJSON(repoPath(file));
    return { dir: relDir, pass: isMissing(r) ? r : field(r, 'pass', file) };
}

// INVALID.txt / SUPERSEDED.txt first line explains why a run was set aside.
function archivedInfo(relDir) {
    const reasonFile = ['INVALID.txt', 'SUPERSEDED.txt'].map((n) => `${relDir}/${n}`)
        .find((p) => !isMissing(readText(repoPath(p))));
    const reason = reasonFile ? readText(repoPath(reasonFile)).split('\n')[0] : missing(`no INVALID.txt or SUPERSEDED.txt in ${relDir}`);
    return { ...runInfo(relDir), reason };
}

function card(id) {
    const spec = SPECS[id];
    const base = `evidence/test${id}`;
    const dirs = listDirs(repoPath(base));
    const valid = dirs.filter((d) => /^\d{4}-/.test(d)).map((d) => runInfo(`${base}/${d}`));
    const regression = dirs.filter((d) => d.startsWith('regression-')).map((d) => runInfo(`${base}/${d}`));
    const invalid = listDirs(repoPath('evidence/_invalid', `test${id}`)).map((d) => archivedInfo(`evidence/_invalid/test${id}/${d}`));
    const superseded = listDirs(repoPath('evidence/_superseded', `test${id}`)).map((d) => archivedInfo(`evidence/_superseded/test${id}/${d}`));

    const readRun = (run) => {
        const file = `${run.dir}/result.json`;
        const r = readJSON(repoPath(file));
        return { dir: run.dir, pass: run.pass, ...(isMissing(r) ? { error: r } : spec.read(r, file)) };
    };

    const passes = (list) => list.filter((x) => x.pass === true).length;
    return {
        id,
        name: spec.name,
        scenario: spec.scenario,
        expected: spec.expected,
        newest: valid.length ? readRun(valid[valid.length - 1]) : missing(`no valid run directories under ${base}/`),
        regression: regression.length ? readRun(regression[regression.length - 1]) : null,
        runs: {
            valid: { count: valid.length, passed: passes(valid), dirs: valid },
            regression: { count: regression.length, passed: passes(regression), dirs: regression },
            invalid: { count: invalid.length, dirs: invalid },
            superseded: { count: superseded.length, dirs: superseded },
        },
        evidenceDir: base,
    };
}

async function collect() {
    return { cards: TEST_ORDER.map(card) };
}

module.exports = { collect: () => safe('tests', collect), TEST_ORDER };
