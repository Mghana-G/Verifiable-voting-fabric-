'use strict';

// /api/live: the network and chaincode collectors under one 5 second
// deadline. A stopped network is a normal state, not an error: the result
// carries `status` plus a plain-English `summary`, and the last reading taken
// while everything answered is kept in dashboard/out/live-last.json so the
// page can say "network down, last reading at <time>".

const fs = require('fs');
const path = require('path');
const { DASH, readJSON, isMissing } = require('./util');
const { within } = require('./fabric');
const network = require('../collectors/network');
const chaincode = require('../collectors/chaincode');

const DEADLINE_MS = 5000;
const LAST = path.join(DASH, 'out', 'live-last.json');

const TEXT = {
    up: 'Network up: every service is running and answering.',
    degraded: 'Network partly up: some services are not answering.',
    starting: 'Services are running but the peers and orderers are not answering yet.',
    down: 'Network down: no network service is running.',
    unreachable: 'Docker is not answering, so the network state cannot be read.',
    timeout: 'The network did not answer within 5 seconds.',
};

function lastReading() {
    const r = readJSON(LAST);
    return isMissing(r) ? null : r;
}

function saveLast(live) {
    try {
        fs.mkdirSync(path.dirname(LAST), { recursive: true });
        const tmp = `${LAST}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify({ at: live.readAt, network: live.network, chaincode: live.chaincode }, null, 2)}\n`);
        fs.renameSync(tmp, LAST);
    } catch { /* a failed snapshot must not break the page */ }
}

async function collect({ electionID } = {}) {
    const started = Date.now();
    const readAt = new Date().toISOString();
    const deadlineAt = started + DEADLINE_MS - 700;
    const left = () => Math.max(200, deadlineAt - Date.now());

    // The chaincode queries only need to know that a peer container
    // is running, which `docker ps` reports first; they then run alongside
    // the peer probes so the whole call stays inside one deadline.
    let peersRunningKnown;
    const peersRunning = new Promise((resolve) => { peersRunningKnown = resolve; });
    const netP = within(left(), network.collect(deadlineAt, { onDocker: (i) => peersRunningKnown(i.peersRunning) }),
        { status: 'timeout', services: [], expected: 17 }).finally(() => peersRunningKnown(false));

    const auditP = electionID
        ? peersRunning.then((up) => (up ? within(left(), chaincode.audit(electionID, left()), undefined) : undefined))
        : Promise.resolve(undefined);

    const [net, auditResult] = await Promise.all([netP, auditP]);
    if (net.error) net.status = 'unreachable';

    const live = {
        readAt,
        elapsedMs: Date.now() - started,
        status: net.status,
        summary: TEXT[net.status] || TEXT.timeout,
        network: net,
        chaincode: chaincode.describe(net, auditResult),
    };
    if (electionID && !auditResult && live.status !== 'down') {
        live.chaincode.audit = { electionID, invariant: { __unavailable: true, why: 'no answer within 5 s' }, tally: { __unavailable: true, why: 'no answer within 5 s' }, equal: null };
    }
    if (net.status === 'up') saveLast(live); else live.lastReading = lastReading();
    return live;
}

module.exports = { collect, lastReading };
