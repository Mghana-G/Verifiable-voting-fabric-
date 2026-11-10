'use strict';

// Registry access for the dashboard. Verification uses client-app/lib/registry.js
// directly (the thesis client code, not a copy). The extra reads here only list
// registry rows by position for the sample IDs and the simulated-voter batch.

const path = require('path');
const crypto = require('crypto');
const { REPO } = require('./util');

const clientRegistry = require(path.join(REPO, 'client-app', 'lib', 'registry.js'));
const Database = require(path.join(REPO, 'client-app', 'node_modules', 'better-sqlite3'));

let db;
function handle() {
    if (!db) db = new Database(path.join(REPO, 'voter-generator', 'registry.db'), { readonly: true, fileMustExist: true });
    return db;
}

const VOTER_ID_RE = /^[A-Z0-9]{6,16}$/;

// Same check client-app does: recompute SHA-256(voter_id + salt) and compare.
function verify(voterID) {
    if (!VOTER_ID_RE.test(voterID)) return { ok: false, reason: 'format' };
    const r = clientRegistry.verifyVoter(voterID);
    return r.ok ? { ok: true, hash: r.hash } : { ok: false, reason: 'not-found' };
}

function count() { return handle().prepare('SELECT COUNT(*) AS n FROM voters').get().n; }

// Voter IDs from the end of the registry (the batch works from the start),
// `n` at a time from position `offset`, so each request gives fresh IDs.
function samples(n, offset) {
    return handle().prepare('SELECT voter_id FROM voters ORDER BY rowid DESC LIMIT ? OFFSET ?').all(n, offset).map((r) => r.voter_id);
}

// A run of registry rows by position, with the hash recomputed and checked.
function chunk(offset, n) {
    return handle().prepare('SELECT voter_id, salt, hash FROM voters ORDER BY rowid LIMIT ? OFFSET ?').all(n, offset)
        .map((r) => ({ voterHash: r.hash, verified: crypto.createHash('sha256').update(r.voter_id + r.salt).digest('hex') === r.hash }));
}

module.exports = { verify, count, samples, chunk, VOTER_ID_RE };
