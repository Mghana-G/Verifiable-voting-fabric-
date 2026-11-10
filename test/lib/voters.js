'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', '..', 'voter-generator', 'registry.db');

// VOTERISSUED~{electionID}~{voterHash} is scoped per election, so reusing the
// same voter rows across different (uniquely-named) test runs is safe.
function loadVoters(count, offset = 0) {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT voter_id, salt, hash FROM voters ORDER BY rowid LIMIT ? OFFSET ?').all(count, offset);
    db.close();
    if (rows.length < count) {
        throw new Error(`registry.db only has ${rows.length} voters at offset ${offset}, needed ${count}`);
    }
    return rows;
}

module.exports = { loadVoters, DB_PATH };
