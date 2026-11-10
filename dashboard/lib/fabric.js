'use strict';

// Helpers for the live (D2) collectors. Everything here is read-only: the
// only Fabric commands the dashboard may run are the ones whitelisted in
// QUERY_FUNCTIONS and READ_ONLY_PEER_SUBCOMMANDS below.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { REPO, DASH } = require('./util');

const NETWORK = path.join(REPO, 'network');
const OUT_LIVE = path.join(DASH, 'out', 'live');

const ORGS = [
    { key: 'IEBC', msp: 'OrgIEBCMSP', domain: 'orgiebc.example.com', peerPort: 7051, couchPort: 5984, label: 'IEBC' },
    { key: 'Judiciary', msp: 'OrgJudiciaryMSP', domain: 'orgjudiciary.example.com', peerPort: 7061, couchPort: 5985, label: 'Judiciary' },
    { key: 'CivilSociety', msp: 'OrgCivilSocietyMSP', domain: 'orgcivilsociety.example.com', peerPort: 7071, couchPort: 5986, label: 'Civil Society' },
    { key: 'Media', msp: 'OrgMediaMSP', domain: 'orgmedia.example.com', peerPort: 7081, couchPort: 5987, label: 'Media' },
];

const ORDERERS = [
    { name: 'orderer1.orgorderer.example.com', short: 'orderer1', node: 1, port: 7050, adminPort: 9443 },
    { name: 'orderer2.orgorderer.example.com', short: 'orderer2', node: 2, port: 8050, adminPort: 9444 },
    { name: 'orderer3.orgorderer.example.com', short: 'orderer3', node: 3, port: 9050, adminPort: 9445 },
];

const ORDERER_ORG = path.join(NETWORK, 'organizations', 'ordererOrganizations', 'orgorderer.example.com');
const ORDERER_TLS_CA = path.join(ORDERER_ORG, 'tlsca', 'tlsca.orgorderer.example.com-cert.pem');

const CHANNEL = 'votingchannel';
const CHAINCODE = 'voting';

// Only these peer subcommands are ever spawned, and only from cached background reads.
const READ_ONLY_PEER_SUBCOMMANDS = new Set(['channel fetch', 'lifecycle querycommitted']);

const ELECTION_RE = /^[A-Za-z0-9._-]{1,80}$/;

const BASE_ENV = {
    ...process.env,
    PATH: `${process.env.PATH}:${path.join(os.homedir(), 'fabric-samples', 'bin')}`,
    FABRIC_CFG_PATH: `${path.join(os.homedir(), 'fabric-samples', 'config')}/`,
    CORE_PEER_TLS_ENABLED: 'true',
};

function orgEnv(org) {
    return {
        ...BASE_ENV,
        CORE_PEER_LOCALMSPID: org.msp,
        CORE_PEER_ADDRESS: `localhost:${org.peerPort}`,
        CORE_PEER_MSPCONFIGPATH: path.join(NETWORK, 'organizations', 'peerOrganizations', org.domain, 'users', `Admin@${org.domain}`, 'msp'),
        CORE_PEER_TLS_ROOTCERT_FILE: path.join(NETWORK, 'organizations', 'peerOrganizations', org.domain, 'peers', `peer0.${org.domain}`, 'tls', 'ca.crt'),
    };
}

// Runs a binary with an argument array (no shell). Never rejects.
function run(file, args, { env = BASE_ENV, timeoutMs = 4500, cwd = REPO } = {}) {
    return new Promise((resolve) => {
        execFile(file, args, { env, cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
                timedOut: !!(err && err.killed),
                code: err && typeof err.code === 'number' ? err.code : 0,
            });
        });
    });
}

function peer(org, args, opts = {}) {
    const sub = args.slice(0, 2).join(' ');
    if (!READ_ONLY_PEER_SUBCOMMANDS.has(sub)) {
        return Promise.resolve({ ok: false, stdout: '', stderr: `peer ${sub} is not a read-only subcommand`, timedOut: false, code: 1 });
    }
    return run('peer', args, { ...opts, env: orgEnv(org) });
}

// GET with a hard timeout. Resolves { ok, status, body } and never rejects.
function httpGet(port, urlPath, { auth, timeoutMs = 3000 } = {}) {
    return new Promise((resolve) => {
        const req = http.get({
            host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs,
            headers: auth ? { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {},
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
        req.on('error', (e) => resolve({ ok: false, reason: e.code || 'error' }));
    });
}

// Docker engine API over its unix socket (GET only, no CLI process).
function dockerGet(urlPath, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.get({ socketPath: '/var/run/docker.sock', path: urlPath, timeout: timeoutMs }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve({ ok: res.statusCode === 200, status: res.statusCode, json: JSON.parse(body) }); } catch { resolve({ ok: false, status: res.statusCode }); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
        req.on('error', (e) => resolve({ ok: false, reason: e.code || 'error' }));
    });
}

// Orderer admin API (participation API) over mutual TLS, in-process.
function ordererChannel(o, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const tls = path.join(ORDERER_ORG, 'orderers', o.name, 'tls');
        let material;
        try {
            material = { ca: fs.readFileSync(ORDERER_TLS_CA), cert: fs.readFileSync(path.join(tls, 'server.crt')), key: fs.readFileSync(path.join(tls, 'server.key')) };
        } catch {
            return resolve({ ok: false, reason: 'no-credentials' });
        }
        const req = https.get({ host: 'localhost', port: o.adminPort, path: `/participation/v1/channels/${CHANNEL}`, timeout: timeoutMs, ...material }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve({ ok: res.statusCode === 200, json: JSON.parse(body) }); } catch { resolve({ ok: false, reason: 'unreadable' }); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
        req.on('error', (e) => resolve({ ok: false, reason: e.code || 'error' }));
        return undefined;
    });
}

function ensureLiveDir() {
    fs.mkdirSync(OUT_LIVE, { recursive: true });
    return OUT_LIVE;
}

// Resolves to `fallback` if `promise` has not settled within `ms`.
function within(ms, promise, fallback) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Stale-while-revalidate cache for reads too slow for a 5 s page poll
// (the committed chaincode definition, the decoded channel config, the Raft
// leader scan). `get()` never waits: it returns the last value, kicks off a
// refresh when it is older than ttlMs (or keyFn() changed), and reports
// whether the first value is still being computed.
function swr(ttlMs, fn, keyFn = () => '') {
    const st = { value: undefined, at: null, key: null, promise: null, failedAt: null };
    return {
        get() {
            const key = keyFn();
            const stale = st.at === null || Date.now() - st.at > ttlMs || key !== st.key;
            const backoff = st.failedAt !== null && Date.now() - st.failedAt < 5000;
            if (stale && !st.promise && !backoff) {
                st.promise = fn().then((v) => {
                    st.value = v; st.at = Date.now(); st.key = key; st.failedAt = null;
                }).catch(() => {
                    st.failedAt = Date.now();
                }).finally(() => { st.promise = null; });
            }
            return {
                value: st.value,
                at: st.at ? new Date(st.at).toISOString() : null,
                pending: st.value === undefined,
                refreshing: !!st.promise,
            };
        },
        clear() { st.at = null; st.value = undefined; st.failedAt = null; },
    };
}

module.exports = {
    ORGS, ORDERERS, ORDERER_TLS_CA, ORDERER_ORG, CHANNEL, CHAINCODE, NETWORK, ELECTION_RE,
    run, peer, httpGet, dockerGet, ordererChannel, ensureLiveDir, within, swr, orgEnv, BASE_ENV,
};
