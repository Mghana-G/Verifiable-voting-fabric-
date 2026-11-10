'use strict';

// Network control: a fixed whitelist maps an operation name to ONE command.
// No argument ever comes from the page. Every operation runs through
// lib/jobs.js, so only one runs at a time and the voter booth is refused
// while it does. Gates are enforced here on the server, not only in the UI.

const { execFile } = require('child_process');
const jobs = require('./jobs');
const { expectedServices } = require('../collectors/network');
const gw = require('./gw');
const { ORGS } = require('./fabric');

const COMPOSE = ['compose', '--project-directory', 'network', '-f', 'network/docker-compose.yaml'];
const WAIT_FOR_ANSWER_MS = 90 * 1000;

// Descriptions come from docs/HOW_IT_WORKS.md section 2.
const OPS = {
    prereqs: { step: '00', title: 'Prerequisites', file: 'bash', args: ['network/scripts/00-prereqs.sh'], needsDown: false, drawer: 'prereqs',
        does: 'Checks the installed tools against the expected versions.', produces: 'PASS or FAIL per tool.' },
    crypto: { step: '01', title: 'Crypto material', file: 'bash', args: ['network/scripts/01-generate-crypto.sh'], needsDown: true, destroysLedger: true, drawer: 'crypto',
        does: 'Runs cryptogen to create every organisation and node certificate, and copies each CA key pair.', produces: 'network/organizations/ (orderer, peer and fabric-ca material). It wipes the old output first.' },
    genesis: { step: '02', title: 'Genesis block', file: 'bash', args: ['network/scripts/02-generate-artifacts.sh'], needsDown: true, destroysLedger: true, drawer: 'genesis',
        does: 'Runs configtxgen to write the channel genesis block with the three Raft consenters, 500 ms BatchTimeout and the application policies.', produces: 'network/channel-artifacts/votingchannel.block.' },
    up: { step: '03', title: 'Compose up', file: 'bash', args: ['network/scripts/03-network-up.sh'], needsDown: true, drawer: 'up',
        does: 'Starts the 17 containers with docker compose up and waits for the peer and orderer ports.', produces: '17 containers. Each peer starts only after its CouchDB is healthy.' },
    channel: { step: '04', title: 'Create channel', file: 'bash', args: ['network/scripts/04-create-channel.sh'], needsDown: false, needsUp: true, drawer: 'channel',
        does: 'Joins the three orderers to votingchannel with osnadmin, waits for a Raft leader, then joins the four peers.', produces: 'Three Raft nodes and four peers on votingchannel.' },
    health: { step: '', title: 'Health check', file: 'bash', args: ['network/scripts/health-check.sh'], needsDown: false, needsUp: true, drawer: 'health',
        does: 'Reads CouchDB, peer heights and orderer channel lists. It only reads.', produces: '11 of 11 checks.' },
    deploy: { step: '05', title: 'Deploy chaincode', file: 'bash', args: ['network/scripts/05-deploy-chaincode.sh'], needsDown: false, needsUp: true, drawer: 'deploy',
        does: 'Runs npm test, packages, installs on four peers, approves for four organisations and commits the next sequence.', produces: 'A new chaincode definition on the channel.' },
    candidates: { step: '06', title: 'Load candidates', file: 'bash', args: ['network/scripts/06-init-candidates.sh'], needsDown: false, needsUp: true, drawer: 'candidates',
        does: 'Enrols the votingadmin identity (role=admin) and invokes CreateCandidate for C001 to C004, then queries the tally.', produces: 'CANDIDATE keys C001 to C004.' },
    start: { step: '', title: 'Start nodes', file: 'docker', args: [...COMPOSE, 'start'], kind: 'compose', drawer: 'start',
        does: 'docker compose start: restarts stopped containers. Non-destructive; ledgers live in named volumes.', produces: 'The 17 services running again.' },
    stop: { step: '', title: 'Stop nodes', file: 'docker', args: [...COMPOSE, 'stop'], kind: 'compose', drawer: 'stop',
        does: 'docker compose stop: stops the containers but keeps every ledger volume.', produces: 'Containers stopped, data kept.' },
    teardown: { step: '99', title: 'Teardown', file: 'bash', args: ['network/scripts/99-network-down.sh'], typed: 'TEARDOWN', drawer: 'teardown',
        does: 'docker compose down --volumes: removes the containers, the ledger volumes, the chaincode images and the generated directories.', produces: 'A clean slate. A full 01 to 06 rebuild follows.' },
};

const command = (o) => `${o.file} ${o.args.join(' ')}`;

function runningServices() {
    return new Promise((resolve) => {
        execFile('docker', ['ps', '--format', '{{.Names}}'], { timeout: 8000 }, (err, out) => {
            if (err) return resolve({ error: err.message, names: [] });
            const expected = expectedServices();
            const set = new Set(String(out).split('\n').filter(Boolean));
            const names = Array.isArray(expected) ? expected.filter((n) => set.has(n)) : [...set].filter((n) => /example\.com|^couchdb|^cli$/.test(n));
            return resolve({ names, total: Array.isArray(expected) ? expected.length : null });
        });
    });
}

// Ledger volumes from a previous network. Regenerating certificates (01) or the
// genesis block (02) over them makes the stored chain unusable.
function ledgerVolumes() {
    return new Promise((resolve) => {
        execFile('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 8000 }, (err, out) => {
            resolve(err ? [] : String(out).split('\n').filter((n) => /^[a-z]+_(peer0|orderer\d)\./.test(n)));
        });
    });
}

async function nextSequence() {
    const r = await gw.committedDefinition(ORGS[0], 'voting', 4000);
    return r.ok ? r.definition.sequence + 1 : null;
}

// What the page needs to draw the runbook, including every gate and its reason.
async function describe() {
    const run = await runningServices();
    const running = run.names.length;
    const seq = await nextSequence();
    const vols = await ledgerVolumes();
    const busy = jobs.active();
    return Object.entries(OPS).map(([id, o]) => {
        let blocked = null;
        if (busy) blocked = `Another operation is running: ${busy.label}.`;
        else if (o.destroysLedger && vols.length) blocked = `Disabled: ${vols.length} ledger volumes already exist. New certificates would make the stored chain unusable (peers reject the new identities). Run Teardown first.`;
        else if (o.needsDown && running > 0) blocked = `Disabled: ${running} network containers are running. This step would destroy or clash with the live network. Tear down first.`;
        else if (o.needsUp && running === 0) blocked = 'Disabled: no network container is running. Start nodes or bring the network up first.';
        return {
            id, step: o.step, title: o.title, command: command(o), does: o.does, produces: o.produces, drawer: o.drawer,
            typed: o.typed || null, blocked,
            warning: id === 'deploy' ? (seq ? `This will commit chaincode sequence ${seq}.` : 'The next sequence could not be read from the channel.')
                : id === 'teardown' ? 'This deletes every ledger volume. Block numbers cited in evidence/ will no longer exist on the new chain, and a full rebuild (01 to 06) follows.' : null,
        };
    });
}

async function runOp(id, typedWord) {
    const o = OPS[id];
    if (!o) return { ok: false, status: 404, reason: 'unknown operation' };
    if (o.typed && typedWord !== o.typed) return { ok: false, status: 400, reason: `type ${o.typed} to confirm this operation` };
    const run = await runningServices();
    const running = run.names.length;
    if (o.destroysLedger && (await ledgerVolumes()).length) return { ok: false, status: 409, reason: `ledger volumes already exist, so step ${o.step} is refused (run Teardown first)` };
    if (o.needsDown && running > 0) return { ok: false, status: 409, reason: `${running} network containers are running, so step ${o.step} is refused` };
    if (o.needsUp && running === 0) return { ok: false, status: 409, reason: 'no network container is running' };
    const started = jobs.start(id, `${o.step ? `${o.step} ` : ''}${o.title}`, async (ctx) => {
        ctx.log(`$ ${command(o)}`);
        const r = await ctx.spawn(o.file, o.args, { timeoutMs: id === 'deploy' ? 30 * 60 * 1000 : 15 * 60 * 1000 });
        if (id === 'start' && r.code === 0) {
            ctx.log('[dashboard] waiting for the peers and orderers to answer…');
            const t0 = Date.now();
            let up = false;
            while (Date.now() - t0 < WAIT_FOR_ANSWER_MS) {
                // eslint-disable-next-line no-await-in-loop
                const h = await gw.chainInfo(ORGS[0], 3000);
                if (!h.ok) gw.closeAll(); // a rebuilt network has new certificates; reopen with fresh material
                if (h.ok) { up = true; break; }
                ctx.log(`[dashboard] still waiting (${Math.round((Date.now() - t0) / 1000)} s of 90 s)${h.reason ? `: ${h.reason}` : ''}`);
                // eslint-disable-next-line no-await-in-loop
                await new Promise((res) => setTimeout(res, 4000));
            }
            ctx.log(up ? `[dashboard] peers answering after ${Math.round((Date.now() - t0) / 1000)} s` : '[dashboard] peers did not answer within 90 s');
        }
        if (id === 'health' || id === 'start') {
            const h = id === 'start' ? await ctx.spawn('bash', ['network/scripts/health-check.sh'], { timeoutMs: 90000 }) : r;
            const parsed = parseHealth(h.text);
            ctx.emit({ type: 'health', ...parsed });
            return { exitCode: id === 'start' ? (r.code || parsed.failed) : r.code, result: parsed };
        }
        return { exitCode: r.code };
    });
    return started.ok ? { ok: true, job: jobs.view(started.job) } : { ok: false, status: 409, reason: started.reason };
}

function parseHealth(text) {
    const lines = text.split('\n').map((l) => /^\s*(PASS|FAIL)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ state: m[1], text: m[2].trim() }));
    const sum = /Result:\s*(\d+) passed,\s*(\d+) failed/.exec(text);
    const passed = sum ? Number(sum[1]) : lines.filter((l) => l.state === 'PASS').length;
    const failed = sum ? Number(sum[2]) : lines.filter((l) => l.state === 'FAIL').length;
    return { lines, passed, failed, total: passed + failed };
}

module.exports = { describe, runOp, parseHealth, runningServices, OPS };
