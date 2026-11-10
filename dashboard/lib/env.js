'use strict';

// Minimal .env reader (no dependency). dashboard/.env is gitignored and holds
// DASHBOARD_ADMIN_PASSWORD. Values already in process.env win.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '.env');

function load() {
    let text = '';
    try { text = fs.readFileSync(FILE, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m || line.trim().startsWith('#')) continue;
        if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
}
load();

module.exports = { FILE };
