'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EVIDENCE_ROOT = path.join(__dirname, '..', '..', 'evidence');

function isoStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function evidenceDir(testName, stamp) {
    const dir = path.join(EVIDENCE_ROOT, testName, stamp);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeJSON(dir, filename, obj) {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(obj, null, 2) + '\n');
}

function writeText(dir, filename, text) {
    fs.writeFileSync(path.join(dir, filename), text);
}

// docker logs writes to stderr for many runtimes; capture both streams.
function dockerLogs(container, tail = 200) {
    try {
        return execSync(`docker logs ${container} --tail ${tail} 2>&1`, {
            encoding: 'utf8',
            maxBuffer: 20 * 1024 * 1024,
            shell: '/bin/bash',
        });
    } catch (err) {
        return `ERROR capturing logs for ${container}: ${err.message}\n${err.stdout || ''}${err.stderr || ''}`;
    }
}

function capturePeerLogs(dir, containers, tail = 200) {
    const combined = containers
        .map((c) => `=== docker logs ${c} --tail ${tail} ===\n${dockerLogs(c, tail)}`)
        .join('\n\n');
    writeText(dir, 'peer-logs.txt', combined);
}

// Serialize BigInt-bearing objects (fabric-gateway Status.blockNumber is BigInt).
function jsonSafe(obj) {
    return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

module.exports = {
    EVIDENCE_ROOT,
    isoStamp,
    evidenceDir,
    writeJSON,
    writeText,
    dockerLogs,
    capturePeerLogs,
    jsonSafe,
};
