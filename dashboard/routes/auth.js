'use strict';

const crypto = require('crypto');
const express = require('express');
const session = require('../lib/session');
const registry = require('../lib/registry');
const election = require('../lib/election');
require('../lib/env');

const router = express.Router();
router.use(express.json({ limit: '2kb' }));

// Only a scrypt hash of the admin password is held in memory.
const SALT = crypto.randomBytes(16);
const ADMIN_HASH = process.env.DASHBOARD_ADMIN_PASSWORD
    ? crypto.scryptSync(process.env.DASHBOARD_ADMIN_PASSWORD, SALT, 32)
    : null;
delete process.env.DASHBOARD_ADMIN_PASSWORD;

const adminEnabled = () => ADMIN_HASH !== null;

// Slow down guessing: a failed attempt costs the next attempt a second.
let nextAdminAttemptAt = 0;

router.get('/me', (req, res) => {
    const s = req.session;
    let el = null;
    try { el = election.config(); } catch { /* shown by the other endpoints */ }
    res.json({
        role: s ? s.role : null,
        adminEnabled: adminEnabled(),
        expiresAt: s ? s.expiresAt : null,
        election: el ? { electionID: el.electionID, title: el.title } : null,
    });
});

// Signing in IS the off-chain verification step (HOW_IT_WORKS 3.1).
router.post('/voter', (req, res) => {
    const voterID = String((req.body && req.body.voterID) || '').trim().toUpperCase();
    const v = registry.verify(voterID);
    if (!v.ok) return res.status(401).json({ error: v.reason === 'format' ? 'A voter ID is 6 to 16 letters and digits, for example KE00001915.' : 'This voter ID is not in the registry, or its hash did not match.' });
    const el = election.current();
    if (el.locked) return res.status(403).json({ error: 'Voting is closed for this election (dashboard lock).' });
    const s = session.create('voter', { voterID, voterHash: v.hash, vat: null, sealed: null });
    session.setCookie(res, s);
    return res.json({ ok: true, hashPrefix: v.hash.slice(0, 12), expiresAt: s.expiresAt });
});

router.get('/sample-voters', (req, res) => {
    res.json({ electionID: election.config().electionID, voterIDs: registry.samples(5, election.takeSampleOffset(5)), note: 'Demo helper. Each request gives five registry IDs from the end of the registry, not handed out before for this election.' });
});

router.post('/admin', (req, res) => {
    if (!adminEnabled()) return res.status(503).json({ error: 'Administrator sign-in is off: DASHBOARD_ADMIN_PASSWORD is not set in dashboard/.env.' });
    const wait = nextAdminAttemptAt - Date.now();
    if (wait > 0) return res.status(429).json({ error: `Wait ${Math.ceil(wait / 1000)} s before trying again.` });
    const given = crypto.scryptSync(String((req.body && req.body.password) || ''), SALT, 32);
    if (!crypto.timingSafeEqual(given, ADMIN_HASH)) {
        nextAdminAttemptAt = Date.now() + 1000;
        return res.status(401).json({ error: 'Wrong password.' });
    }
    const s = session.create('admin');
    session.setCookie(res, s);
    return res.json({ ok: true });
});

router.post('/logout', (req, res) => {
    if (req.session) session.destroy(req.session.id);
    session.clearCookie(res);
    res.json({ ok: true });
});

module.exports = { router, adminEnabled };
