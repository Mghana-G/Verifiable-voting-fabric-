'use strict';

// Shared helpers for the read-only collectors. Nothing here writes to disk.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DASH = path.resolve(__dirname, '..');

// A value the dashboard expected but could not find. Rendered as a red
// MISSING with `why` as its explanation; never replaced by a default.
function missing(why) {
    return { __missing: true, why };
}

function isMissing(v) {
    return v !== null && typeof v === 'object' && v.__missing === true;
}

function repoPath(...parts) {
    return path.join(REPO, ...parts);
}

function rel(abs) {
    return path.relative(REPO, abs).split(path.sep).join('/');
}

function exists(abs) {
    try { fs.accessSync(abs); return true; } catch { return false; }
}

function readText(abs) {
    try {
        return fs.readFileSync(abs, 'utf8');
    } catch (e) {
        return missing(`${rel(abs)} not readable (${e.code || e.message})`);
    }
}

function readJSON(abs) {
    const text = readText(abs);
    if (isMissing(text)) return text;
    try {
        return JSON.parse(text);
    } catch (e) {
        return missing(`${rel(abs)} is not valid JSON (${e.message})`);
    }
}

// Value at a dotted path, or a MISSING marker naming the field and file.
function field(obj, dotted, fileLabel) {
    if (isMissing(obj)) return obj;
    let cur = obj;
    for (const key of dotted.split('.')) {
        if (cur === null || typeof cur !== 'object' || !(key in cur) || cur[key] === undefined) {
            return missing(`field '${dotted}' absent in ${fileLabel}`);
        }
        cur = cur[key];
    }
    return cur;
}

function listDirs(abs) {
    try {
        return fs.readdirSync(abs, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
    } catch {
        return [];
    }
}

function mtimeISO(abs) {
    try { return fs.statSync(abs).mtime.toISOString(); } catch { return null; }
}

// Newest modification time of a file, or of anything beneath a directory.
function newestMtime(abs) {
    let newest = 0;
    const walk = (p) => {
        let st;
        try { st = fs.statSync(p); } catch { return; }
        if (st.isDirectory()) {
            for (const name of fs.readdirSync(p)) walk(path.join(p, name));
        } else if (st.mtimeMs > newest) {
            newest = st.mtimeMs;
        }
    };
    walk(abs);
    return newest ? new Date(newest).toISOString() : null;
}

// Environment for read-only probes: Fabric binaries on PATH, and tools told
// not to write update-check or bytecode caches as a side effect.
const RUN_ENV = {
    ...process.env,
    PATH: `${process.env.PATH}:${path.join(os.homedir(), 'fabric-samples', 'bin')}`,
    NO_UPDATE_NOTIFIER: '1',
    npm_config_update_notifier: 'false',
    PYTHONDONTWRITEBYTECODE: '1',
};

// Runs a read-only shell command with a timeout. Never rejects.
function sh(cmd, timeoutMs = 10000) {
    return new Promise((resolve) => {
        execFile('bash', ['-c', cmd], {
            cwd: REPO, env: RUN_ENV, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
                error: err ? (err.killed ? `timed out after ${timeoutMs} ms` : err.message.split('\n')[0]) : null,
            });
        });
    });
}

// Like shValue, but remembers the last successful output. A value younger
// than ttlMs is returned without spawning anything; if a later read fails
// (typically a timeout on a busy host) the last good value is kept rather
// than reporting an installed tool as MISSING. Tool versions change rarely,
// so the default is ten minutes.
const shCache = new Map();
async function shCached(cmd, { ttlMs = 10 * 60 * 1000, timeoutMs = 30000 } = {}) {
    const hit = shCache.get(cmd);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const v = await shValue(cmd, timeoutMs);
    if (!isMissing(v)) {
        shCache.set(cmd, { value: v, at: Date.now() });
        return v;
    }
    return hit ? hit.value : v;
}

// Command output trimmed, or MISSING carrying the failure reason.
async function shValue(cmd, timeoutMs) {
    const r = await sh(cmd, timeoutMs);
    const out = r.stdout.trim();
    if (!r.ok && !out) return missing(`\`${cmd}\` failed: ${r.error || r.stderr.trim()}`);
    if (!out) return missing(`\`${cmd}\` produced no output`);
    return out;
}

function stripMd(s) {
    return String(s).replace(/\*\*/g, '').replace(/`/g, '').trim();
}

// Rows of the first markdown table after the heading line starting with
// `heading`, header and separator rows removed. Missing when not found.
function mdTableAfter(text, heading, fileLabel) {
    if (isMissing(text)) return text;
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.startsWith(heading));
    if (start < 0) return missing(`heading '${heading}' not found in ${fileLabel}`);
    const rows = [];
    let inTable = false;
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i].trim();
        if (l.startsWith('|')) {
            inTable = true;
            rows.push(l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
        } else if (inTable || l.startsWith('#')) {
            break;
        }
    }
    if (rows.length < 3) return missing(`no table under '${heading}' in ${fileLabel}`);
    return rows.slice(2);
}

// Never let a collector throw: a failure becomes an { error } object.
async function safe(name, fn) {
    try {
        return await fn();
    } catch (e) {
        return { error: `${name} collector failed: ${e.message}` };
    }
}

// Every MISSING marker and collector error in a state tree, with its path.
function collectMissing(node, at = '', out = []) {
    if (isMissing(node)) {
        out.push({ path: at, why: node.why });
    } else if (Array.isArray(node)) {
        node.forEach((v, i) => collectMissing(v, `${at}[${i}]`, out));
    } else if (node !== null && typeof node === 'object') {
        if (typeof node.error === 'string' && at.split('.').length <= 1) {
            out.push({ path: at, why: node.error });
        }
        for (const [k, v] of Object.entries(node)) collectMissing(v, at ? `${at}.${k}` : k, out);
    }
    return out;
}

module.exports = {
    REPO, DASH, missing, isMissing, repoPath, rel, exists, readText, readJSON, field,
    listDirs, mtimeISO, newestMtime, RUN_ENV, sh, shValue, shCached, stripMd, mdTableAfter, safe, collectMissing,
};
