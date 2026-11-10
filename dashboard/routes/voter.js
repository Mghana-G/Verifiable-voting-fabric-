'use strict';

const express = require('express');
const session = require('../lib/session');
const election = require('../lib/election');
const station = require('../lib/station');
const ballotkit = require('../lib/ballotkit');
const batch = require('../lib/batch');
const jobs = require('../lib/jobs');

const router = express.Router();
router.use(express.json({ limit: '4kb' }));

// Booth and polling-station mode: a voter session (the booth) or an admin session.
const voterOnly = session.requireRole('voter');

function networkBusy(res) {
    const j = jobs.active();
    if (!j) return false;
    res.status(409).json({ error: `A network operation is running (${j.label}), so voting is paused until it ends.` });
    return true;
}

router.get('/state', voterOnly, (req, res) => {
    const s = req.session;
    const el = election.current();
    const c = election.candidates();
    res.json({
        election: { electionID: el.electionID, title: el.title, pollingStationID: el.pollingStationID, locked: el.locked },
        candidates: c.onBallot,
        hashPrefix: s.voterHash.slice(0, 12),
        expiresAt: s.expiresAt,
        vat: s.vat ? { vatID: s.vat.vatID, blockNumber: s.vat.blockNumber, validationCode: s.vat.validationCode, endorsedBy: s.vat.endorsedBy } : null,
        sealed: s.sealed ? { candidateID: s.sealed.candidateID, payloadStr: s.sealed.payloadStr, ephemeralPubKey: s.sealed.ephemeralPubKey, signatureB64: s.sealed.signatureB64, nonce: s.sealed.nonce } : null,
    });
});

router.post('/mint', voterOnly, async (req, res) => {
    const s = req.session;
    const el = election.current();
    if (el.locked) return res.status(403).json({ error: 'Voting is closed for this election (dashboard lock).' });
    if (networkBusy(res)) return undefined;
    if (s.vat) return res.json({ ok: true, vat: s.vat });
    const stages = [];
    try {
        const r = await station.mintVAT(s.voterHash, el.electionID, el.pollingStationID, (e) => stages.push(e));
        s.vat = { vatID: r.result, txID: r.txID, blockNumber: r.blockNumber, validationCode: r.validationCode, endorsedBy: r.endorsedBy, latencyMs: r.latencyMs };
        return res.json({ ok: true, vat: s.vat });
    } catch (e) {
        const c = e.classified || station.classify(e);
        return res.status(c.transport ? 503 : 422).json({ error: c.text, code: c.code });
    }
});

// Build the payload with the thesis client code and sign it with an ephemeral key.
router.post('/seal', voterOnly, (req, res) => {
    const s = req.session;
    if (!s.vat) return res.status(409).json({ error: 'Issue the ballot token first.' });
    const el = election.current();
    const candidateID = String((req.body && req.body.candidateID) || '');
    if (!election.candidates().onBallot.some((c) => c.candidateID === candidateID)) return res.status(400).json({ error: 'That candidate is not on this ballot.' });
    s.sealed = ballotkit.seal(s.vat.vatID, candidateID, el.electionID);
    return res.json({ candidateID, payloadStr: s.sealed.payloadStr, ephemeralPubKey: s.sealed.ephemeralPubKey, signatureB64: s.sealed.signatureB64, nonce: s.sealed.nonce, privateKeyDiscarded: true });
});

// Submits CastBallot and streams the four real stages as Server-Sent Events.
// If the browser drops the connection the cast still finishes; the session
// then holds the sealed ballot so "retry cast" resumes safely.
router.post('/cast', voterOnly, async (req, res) => {
    const s = req.session;
    if (!s.vat || !s.sealed) return res.status(409).json({ error: 'Seal the ballot first.' });
    const el = election.current();
    if (el.locked) return res.status(403).json({ error: 'Voting is closed for this election (dashboard lock).' });
    if (networkBusy(res)) return undefined;
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    const hb = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, jobs.HEARTBEAT_MS);
    try {
        const r = await station.castBallot(s.sealed, send);
        const result = JSON.parse(r.result);
        election.addVotes(1);
        send({ type: 'receipt', receipt: {
            ballotID: result.ballotID, blockNumber: r.blockNumber, validationCode: r.validationCode, timestamp: result.timestamp,
            electionID: el.electionID, title: el.title, endorsedBy: r.endorsedBy, latencyMs: r.latencyMs,
        } });
        session.destroy(s.id); // a committed ballot ends the session immediately
    } catch (e) {
        const c = e.classified || station.classify(e);
        // A chaincode or commit rejection is final; a transport failure keeps the token for "retry cast".
        send({ type: 'error', error: c.text, code: c.code, retry: !!c.transport });
        if (!c.transport) { s.sealed = null; }
    } finally {
        clearInterval(hb);
        res.end();
    }
    return undefined;
});

router.post('/batch', session.requireRole('voter'), (req, res) => startBatch(req, res));

function startBatch(req, res) {
    const r = batch.start(req.body && req.body.count);
    if (!r.ok) return res.status(409).json({ error: r.reason });
    return res.status(202).json(jobs.view(r.job));
}

router.post('/logout', (req, res) => { if (req.session) session.destroy(req.session.id); session.clearCookie(res); res.json({ ok: true }); });

module.exports = { router, startBatch };
