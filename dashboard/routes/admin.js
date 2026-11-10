'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { execFile } = require('child_process');
const session = require('../lib/session');
const election = require('../lib/election');
const live = require('../lib/live');
const ops = require('../lib/ops');
const jobs = require('../lib/jobs');
const blocks = require('../lib/blocks');
const batch = require('../lib/batch');
const gw = require('../lib/gw');
const testmeta = require('../lib/testmeta');
const { REPO } = require('../lib/util');
const { ORGS } = require('../lib/fabric');
const { expectedServices } = require('../collectors/network');

const router = express.Router();
router.use(session.requireRole('admin'));
router.use(express.json({ limit: '4kb' }));

// Commands change things: JSON body with confirm: true, enforced here.
const confirmed = (req, res) => {
    if (!req.is('application/json') || !req.body || req.body.confirm !== true) {
        res.status(400).json({ error: 'confirmation required: send JSON {"confirm": true}' });
        return false;
    }
    return true;
};

// ── Overview ────────────────────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
    const el = election.current();
    const [reading, rate] = await Promise.all([live.collect({ electionID: el.electionID }), blocks.rate(10).catch(() => ({ ok: false }))]);
    res.json({ live: reading, election: el, rate: rate.ok ? rate : { unavailable: true }, job: jobs.active() });
});

// ── Network control ─────────────────────────────────────────────────────────
router.get('/network/ops', async (req, res) => res.json({ ops: await ops.describe(), job: jobs.view(jobs.current() || jobs.lastJob()) }));

router.post('/network/run', async (req, res) => {
    if (!confirmed(req, res)) return undefined;
    const r = await ops.runOp(String(req.body.op || ''), req.body.typed);
    return r.ok ? res.status(202).json(r.job) : res.status(r.status || 409).json({ error: r.reason });
});

router.get('/jobs/current', (req, res) => res.json(jobs.view(jobs.current() || jobs.lastJob()) || { state: 'idle' }));

// ── Election ────────────────────────────────────────────────────────────────
router.get('/election', async (req, res) => {
    const el = election.current();
    const c = election.candidates();
    const auditor = ORGS.find((o) => o.key === 'CivilSociety');
    const history = election.history();
    const tallies = await Promise.all(history.map(async (h) => {
        const [t, i] = await Promise.all([gw.queryVoting(auditor, 'GetTally', h.electionID, 4000), gw.queryVoting(auditor, 'GetAuditInvariant', h.electionID, 4000)]);
        return { ...h, tally: t.ok ? t.value : null, invariant: i.ok ? i.value : null };
    }));
    res.json({ election: el, candidates: c.onBallot, onChainOnly: c.onChainOnly, current: tallies.find((t) => t.current) || null, history: tallies.filter((t) => !t.current) });
});

router.post('/election/fresh', (req, res) => {
    if (!confirmed(req, res)) return undefined;
    if (jobs.busy()) return res.status(409).json({ error: 'An operation is running.' });
    return res.json({ electionID: election.startFresh() });
});

router.post('/election/lock', (req, res) => {
    if (!confirmed(req, res)) return undefined;
    election.setLocked(!!req.body.locked);
    return res.json({ locked: election.current().locked, note: 'Enforced by this dashboard, not by the chaincode.' });
});

router.post('/election/batch', (req, res) => {
    const r = batch.start(req.body && req.body.count);
    if (!r.ok) return res.status(409).json({ error: r.reason });
    return res.status(202).json(jobs.view(r.job));
});

// ── Ledger explorer ─────────────────────────────────────────────────────────
router.get('/blocks', async (req, res) => {
    const before = req.query.before !== undefined ? Number(req.query.before) : undefined;
    const electionOnly = req.query.election === '1' ? election.config().electionID : undefined;
    const r = await blocks.page({ before: Number.isFinite(before) ? before : undefined, perPage: 20, election: electionOnly });
    return r.ok ? res.json(r) : res.status(503).json({ error: 'The ledger could not be read.', detail: r.detail || r.reason });
});

router.get('/block/:n', async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'block number must be a whole number' });
    const r = await blocks.block(n);
    return r.ok ? res.json(blocks.publicBlock(r.block)) : res.status(r.reason === 'failed' ? 404 : 503).json({ error: `Block ${n} could not be read.`, detail: r.detail || r.reason });
});

// ── Tests ───────────────────────────────────────────────────────────────────
router.get('/tests/meta', (req, res) => res.json(testmeta.TESTS));

router.post('/tests/run', (req, res) => {
    if (!confirmed(req, res)) return undefined;
    const id = String(req.body.test || '');
    const t = testmeta.TESTS[id];
    if (!t || !t.script) return res.status(400).json({ error: 'that test cannot be started from the dashboard' });
    if (!t.quick && t.typed !== req.body.typed) return res.status(400).json({ error: `type ${t.typed} to run this test` });
    const args = [t.bash ? 'bash' : 'node', t.script, '1'];
    if (t.count) args.push(String(Math.max(1, Math.min(1000, Math.floor(Number(req.body.count)) || 50))));
    const dir = path.join(REPO, 'evidence', `test${id}`);
    const before = fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : new Set();
    const started = jobs.start(`test${id}`, `Test ${id}`, async (ctx) => {
        ctx.log(`$ cd test && ${args.join(' ')}`);
        const r = await ctx.spawn(args[0], args.slice(1), { cwd: path.join(REPO, 'test'), timeoutMs: id === '2' ? 90 * 60 * 1000 : 20 * 60 * 1000 });
        const created = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => !before.has(d)) : [];
        ctx.log(created.length ? `[dashboard] new evidence folder: evidence/test${id}/${created.join(', ')}` : '[dashboard] no new evidence folder was created');
        return { exitCode: r.code, result: { evidence: created.map((d) => `evidence/test${id}/${d}`) } };
    });
    return started.ok ? res.status(202).json(jobs.view(started.job)) : res.status(409).json({ error: started.reason });
});

// ── Logs ────────────────────────────────────────────────────────────────────
const CC_RE = /^cc-peer0-org(iebc|judiciary|civilsociety|media)-example-com-voting_[0-9.]+$/;
function logNames() {
    return new Promise((resolve) => {
        execFile('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 6000 }, (err, out) => {
            const have = err ? [] : String(out).split('\n').filter(Boolean);
            const exp = expectedServices();
            resolve(have.filter((n) => (Array.isArray(exp) && exp.includes(n)) || CC_RE.test(n)).sort());
        });
    });
}
router.get('/logs', async (req, res) => res.json({ containers: await logNames() }));
router.get('/logs/:name', async (req, res) => {
    const names = await logNames();
    if (!names.includes(req.params.name)) return res.status(404).json({ error: 'not a whitelisted container' });
    return execFile('docker', ['logs', '--tail', '200', req.params.name], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout && !stderr) return res.status(503).json({ error: err.message });
        return res.json({ name: req.params.name, text: `${stdout}${stderr}` });
    });
});

module.exports = { router };
