'use strict';

const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'voter-generator', 'registry.db');

let _db;

function db() {
    if (!_db) {
        _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    }
    return _db;
}

function lookupVoter(voter_id) {
    const row = db().prepare('SELECT salt, hash FROM voters WHERE voter_id = ?').get(voter_id);
    return row || null;
}

// Verify voter_id: looks up DB, recomputes SHA-256(voter_id + salt), compares hashes.
// Returns { ok: true, hash } on match, or { ok: false } on no-match / not found.
function verifyVoter(voter_id) {
    const row = lookupVoter(voter_id);
    if (!row) return { ok: false };
    const computed = crypto.createHash('sha256').update(voter_id + row.salt).digest('hex');
    if (computed !== row.hash) return { ok: false };
    return { ok: true, hash: row.hash };
}

module.exports = { lookupVoter, verifyVoter };
