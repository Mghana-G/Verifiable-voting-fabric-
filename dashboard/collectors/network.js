'use strict';

// Panel 3 (Network, live). Read-only: docker ps, peer getinfo, CouchDB _up,
// osnadmin channel list, Raft leader from orderer logs, and BatchTimeout
// from the DECODED channel config (never from configtx.yaml).

const fs = require('fs');
const path = require('path');
const { readText, repoPath, isMissing } = require('../lib/util');
const F = require('../lib/fabric');
const gw = require('../lib/gw');

const unavailable = (why, detail) => ({ __unavailable: true, why, detail });

// The 17 services are whatever docker-compose.yaml names via container_name.
function expectedServices() {
    const text = readText(repoPath('network/docker-compose.yaml'));
    if (isMissing(text)) return text;
    return [...text.matchAll(/^\s+container_name:\s*(\S+)/gm)].map((m) => m[1]);
}

function groupOf(name) {
    if (name.includes('orgiebc')) return 'IEBC';
    if (name.includes('orgjudiciary')) return 'Judiciary';
    if (name.includes('orgcivilsociety')) return 'Civil Society';
    if (name.includes('orgmedia')) return 'Media';
    if (name.startsWith('orderer') || name.includes('orgorderer')) return 'Orderer';
    return 'Tools';
}

function roleOf(name) {
    if (name.startsWith('peer0')) return 'peer';
    if (name.startsWith('couchdb')) return 'CouchDB';
    if (name.startsWith('ca.')) return 'certificate authority';
    if (name.startsWith('orderer')) return 'Raft orderer';
    if (name === 'cli') return 'CLI';
    return 'service';
}

async function dockerContainers(left) {
    const r = await F.dockerGet('/containers/json?all=true', left());
    if (!r.ok || !Array.isArray(r.json)) {
        return { unreachable: true, detail: r.reason || `docker API status ${r.status}` };
    }
    const byName = new Map();
    for (const c of r.json) byName.set(c.Names[0].replace(/^\//, ''), { state: c.State, status: c.Status });
    return { byName };
}

async function peerInfo(org, up, left) {
    const base = { org: org.label, key: org.key, peer: `peer0.${org.domain}`, port: org.peerPort };
    if (!up) return { ...base, height: unavailable('container not running') };
    const r = await gw.chainInfo(org, left());
    if (!r.ok) {
        return { ...base, height: unavailable(r.reason === 'timeout' ? 'no answer within 5 s' : 'peer not answering yet', r.detail) };
    }
    return { ...base, height: r.height, currentBlockHash: r.currentBlockHash };
}

async function couchInfo(org, up, left) {
    const base = { org: org.label, container: `couchdb.org${org.key.toLowerCase()}`, port: org.couchPort };
    if (!up) return { ...base, up: unavailable('container not running') };
    const r = await F.httpGet(org.couchPort, '/_up', { auth: 'admin:adminpw', timeoutMs: left() });
    if (!r.ok) return { ...base, up: unavailable(r.reason === 'timeout' ? 'no answer within 5 s' : 'not answering yet') };
    return { ...base, up: r.status === 200 && /"status":"ok"/.test(r.body) };
}

async function ordererInfo(o, up, left) {
    const base = { name: o.name, short: o.short, node: o.node, port: o.port };
    if (!up) return { ...base, channel: unavailable('container not running') };
    const r = await F.ordererChannel(o, left());
    if (!r.ok) return { ...base, channel: unavailable(r.reason === 'timeout' ? 'no answer within 5 s' : 'orderer not answering yet') };
    return { ...base, channel: { status: r.json.status, consensusRelation: r.json.consensusRelation, height: r.json.height } };
}

// ── Slow reads, cached (never block the 5 s poll) ───────────────────────────

const ELECTED_RE = /raft\.node: (\d+) elected leader (\d+) at term (\d+)/;
const TS_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d+) UTC/;
const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Reads each running orderer's own log for its latest "elected leader" line,
// widening the tail only until every orderer has reported one. Deep scans of
// an orderer log are slow (tens of seconds on a long chain), hence the cache.
async function scanLeader(running) {
    let views = [];
    for (const tail of [500, 5000, 60000]) {
        const logs = await Promise.all(running.map((o) => F.run('docker', ['logs', '--tail', String(tail), o.name], { timeoutMs: 40000 })));
        views = running.map((o, i) => {
            const lines = clean(logs[i].stdout + logs[i].stderr).split('\n').filter((l) => ELECTED_RE.test(l));
            const last = lines[lines.length - 1];
            if (!last) return { orderer: o.short, found: false };
            const m = ELECTED_RE.exec(last);
            const ts = TS_RE.exec(last);
            return { orderer: o.short, found: true, leaderNode: Number(m[2]), term: Number(m[3]), at: ts ? `${ts[1]}T${ts[2]}Z` : null };
        });
        if (views.every((v) => v.found)) return { views, tail };
    }
    return { views, tail: 60000 };
}

function leaderSummary(scan) {
    const found = scan.views.filter((v) => v.found);
    if (!found.length) return unavailable(`no leader election line in the last ${scan.tail.toLocaleString('en-GB')} log lines of any orderer`);
    const maxTerm = Math.max(...found.map((v) => v.term));
    const current = found.filter((v) => v.term === maxTerm);
    const nodes = [...new Set(current.map((v) => v.leaderNode))];
    const leader = F.ORDERERS.find((o) => o.node === nodes[0]);
    return {
        leader: leader ? leader.short : `node ${nodes[0]}`,
        node: nodes[0],
        term: maxTerm,
        agreement: nodes.length === 1 && found.length === scan.views.length,
        views: scan.views,
        source: 'each orderer log, latest "elected leader" line',
    };
}

let leaderKey = '';
const leaderCache = F.swr(5 * 60 * 1000, async () => {
    const running = F.ORDERERS.filter((o) => leaderKey.split('|')[0].split(',').includes(o.short));
    return scanLeader(running);
}, () => leaderKey);

// Decoded channel config: fetch the config block through an orderer, decode
// it with configtxlator into dashboard/out/live/, read BatchTimeout from the
// decoded JSON. Writes only under dashboard/out/.
async function decodeBatchTimeout() {
    const dir = F.ensureLiveDir();
    const pb = path.join(dir, 'config_block.pb');
    const json = path.join(dir, 'config_block.json');
    let fetched = null;
    for (const o of F.ORDERERS) {
        const r = await F.peer(F.ORGS[0], ['channel', 'fetch', 'config', pb, '-c', F.CHANNEL, '-o', `localhost:${o.port}`,
            '--ordererTLSHostnameOverride', o.name, '--tls', '--cafile', F.ORDERER_TLS_CA], { timeoutMs: 15000 });
        if (r.ok) { fetched = o.short; break; }
    }
    if (!fetched) throw new Error('no orderer returned the config block');
    const d = await F.run('configtxlator', ['proto_decode', '--input', pb, '--type', 'common.Block', '--output', json], { timeoutMs: 15000 });
    if (!d.ok) throw new Error('configtxlator could not decode the config block');
    const block = JSON.parse(fs.readFileSync(json, 'utf8'));
    const orderer = block.data.data[0].payload.data.config.channel_group.groups.Orderer.values;
    return {
        batchTimeout: orderer.BatchTimeout.value.timeout,
        maxMessageCount: orderer.BatchSize.value.max_message_count,
        blockNumber: Number(block.header.number),
        fetchedVia: fetched,
    };
}
const batchCache = F.swr(2 * 60 * 1000, decodeBatchTimeout);

// `deadlineAt` (epoch ms) bounds every probe; whatever has not answered by
// then is reported as "no answer within 5 s" while the rest is still shown.
async function collect(deadlineAt = Date.now() + 4800, hooks = {}) {
    const notify = (info) => { if (hooks.onDocker) hooks.onDocker(info); };
    const left = () => Math.max(300, deadlineAt - Date.now());
    const noAnswer = () => unavailable('no answer within 5 s');
    const bounded = (promise, fallback) => F.within(left(), promise, fallback);

    const expected = expectedServices();
    if (isMissing(expected)) return { error: expected.why };

    const [dock, started] = await Promise.all([
        bounded(dockerContainers(left), { timedOut: true }),
        bounded(Promise.all(F.ORDERERS.map(async (o) => {
            const r = await F.dockerGet(`/containers/${o.name}/json`, left());
            return r.ok ? `${o.name}=${r.json.State.StartedAt}` : '';
        })), []),
    ]);
    if (dock.timedOut) { notify({ peersRunning: false }); return { status: 'timeout', expected: expected.length, services: [] }; }
    if (dock.unreachable) { notify({ peersRunning: false }); return { status: 'unreachable', expected: expected.length, services: [], detail: dock.detail }; }

    const services = expected.map((name) => {
        const c = dock.byName.get(name);
        return {
            name, group: groupOf(name), role: roleOf(name),
            state: c ? c.state : 'absent', status: c ? c.status : 'container does not exist',
        };
    });
    const running = (name) => (services.find((s) => s.name === name) || {}).state === 'running';
    const runningCount = services.filter((s) => s.state === 'running').length;
    notify({ peersRunning: F.ORGS.some((o) => running(`peer0.${o.domain}`)) });

    const result = {
        status: 'down', expected: expected.length, runningCount, services,
        chaincodeContainers: [...dock.byName.entries()].filter(([n]) => n.startsWith('cc-')).map(([name, c]) => ({ name, state: c.state, status: c.status })),
    };
    if (runningCount === 0) return result;

    const runningOrderers = F.ORDERERS.filter((o) => running(o.name));
    // A restart changes StartedAt, which invalidates the cached leader scan.
    const startedFor = started.filter((l) => runningOrderers.some((o) => l.includes(o.name)));
    leaderKey = `${runningOrderers.map((o) => o.short).join(',')}|${startedFor.join(';')}`;

    const [peers, couch, orderers] = await Promise.all([
        Promise.all(F.ORGS.map((o) => bounded(peerInfo(o, running(`peer0.${o.domain}`), left),
            { org: o.label, key: o.key, peer: `peer0.${o.domain}`, port: o.peerPort, height: noAnswer() }))),
        Promise.all(F.ORGS.map((o) => bounded(couchInfo(o, running(`couchdb.org${o.key.toLowerCase()}`), left),
            { org: o.label, container: `couchdb.org${o.key.toLowerCase()}`, port: o.couchPort, up: noAnswer() }))),
        Promise.all(F.ORDERERS.map((o) => bounded(ordererInfo(o, running(o.name), left),
            { name: o.name, short: o.short, node: o.node, port: o.port, channel: noAnswer() }))),
    ]);
    Object.assign(result, { peers, couch, orderers });

    const heights = peers.map((p) => p.height).filter((h) => typeof h === 'number');
    result.heightsEqual = heights.length === peers.length ? heights.every((h) => h === heights[0]) : null;
    result.height = heights.length ? Math.max(...heights) : null;

    const ordererOk = orderers.filter((o) => !o.channel.__unavailable).length;
    const couchOk = couch.filter((c) => c.up === true).length;
    const answering = heights.length + couchOk + ordererOk;
    const everything = runningCount === expected.length && heights.length === 4 && couchOk === 4 && ordererOk === 3;
    result.status = everything ? 'up' : (answering > 0 ? 'degraded' : 'starting');

    if (runningOrderers.length) {
        const l = leaderCache.get();
        result.raftLeader = l.pending ? { pending: true, note: 'reading the orderer logs, which can take up to a minute after a restart' }
            : { ...leaderSummary(l.value), readAt: l.at };
    } else {
        result.raftLeader = unavailable('no orderer is running');
    }
    if (heights.length) {
        const b = batchCache.get();
        result.batchTimeout = b.pending ? { pending: true, note: 'decoding the channel config' }
            : { ...b.value, readAt: b.at, source: `decoded channel config block ${b.value.blockNumber}, fetched via ${b.value.fetchedVia}` };
    } else {
        result.batchTimeout = unavailable('no peer is answering, so the channel config cannot be read');
    }
    return result;
}

module.exports = { collect, expectedServices };
