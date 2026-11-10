'use strict';

// The public verifier. No sign-in. Auditor identity (CivilSociety) and
// evaluate or qscc reads only; there is no write path in this file.

const express = require('express');
const gw = require('../lib/gw');
const blocks = require('../lib/blocks');
const election = require('../lib/election');
const drawers = require('../lib/drawers');
const { ORGS, ELECTION_RE } = require('../lib/fabric');

const router = express.Router();
const AUDITOR = ORGS.find((o) => o.key === 'CivilSociety');

const unavailable = (r) => ({ unavailable: true, reason: r.reason, detail: r.detail || null });

router.get('/results', async (req, res) => {
    const el = typeof req.query.election === 'string' && ELECTION_RE.test(req.query.election) ? req.query.election : election.config().electionID;
    const cands = election.candidates().onBallot;
    const perPeer = await Promise.all(ORGS.map(async (org) => {
        const [tally, inv] = await Promise.all([gw.queryVoting(org, 'GetTally', el, 6000), gw.queryVoting(org, 'GetAuditInvariant', el, 6000)]);
        return {
            org: org.label, key: org.key,
            tally: tally.ok ? tally.value : unavailable(tally),
            invariant: inv.ok ? inv.value : unavailable(inv),
            ok: tally.ok && inv.ok,
        };
    }));
    const auditor = perPeer.find((p) => p.key === 'CivilSociety');
    const sig = (p) => (p.ok ? JSON.stringify([Object.entries(p.tally).sort(), p.invariant.burnedCount, p.invariant.tallyTotal]) : null);
    const sigs = perPeer.map(sig);
    const agree = sigs.every((x) => x !== null) && new Set(sigs).size === 1;
    const rows = cands.map((c) => ({ candidateID: c.candidateID, name: c.name, party: c.party, votes: auditor.ok ? (auditor.tally[c.candidateID] || 0) : null }));
    res.json({
        electionID: el,
        candidates: rows,
        total: auditor.ok ? auditor.invariant.tallyTotal : null,
        invariant: auditor.ok ? { ...auditor.invariant, holds: auditor.invariant.burnedCount === auditor.invariant.tallyTotal } : auditor.invariant,
        peers: perPeer,
        agree,
        readAt: new Date().toISOString(),
    });
});

router.get('/ballot/:id', async (req, res) => {
    const r = await blocks.transaction(String(req.params.id).trim().toLowerCase());
    if (!r.ok) {
        if (r.reason === 'not-found') return res.json({ found: false });
        if (r.reason === 'invalid') return res.status(400).json({ error: r.detail });
        return res.status(503).json({ error: 'The ledger could not be read.', detail: r.detail || r.reason });
    }
    const tx = r.tx;
    const rec = tx.writes.find((w) => /^BALLOT~/.test(w.key));
    let ballot = null;
    if (rec) { try { ballot = JSON.parse(rec.value); } catch { ballot = null; } }
    return res.json({
        found: true,
        txID: tx.txID, blockNumber: tx.blockNumber, validationCode: tx.validationCode, validationName: tx.validationName,
        function: tx.function, timestamp: tx.timestamp, electionID: tx.electionID,
        isBallot: tx.function === 'CastBallot',
        ballot: ballot ? { key: rec.key, ...ballot } : null,
        counted: tx.function === 'CastBallot' && tx.validationCode === 0 && !!ballot,
        endorsers: tx.endorsers,
    });
});

router.get('/integrity', async (req, res) => {
    const n = Math.max(2, Math.min(200, Number(req.query.n) || 50));
    const r = await blocks.integrity(n);
    if (!r.ok) return res.status(503).json({ error: 'The ledger could not be read.', detail: r.detail || r.reason });
    return res.json({ height: r.height, count: r.count, allValid: r.allValid, blocks: r.rows });
});

// The public view of a recent MintVAT: the VOTERISSUED write is a hashed private write set.
router.get('/privacy', async (req, res) => {
    const page = await blocks.page({ perPage: 60 });
    if (!page.ok) return res.status(503).json({ error: 'The ledger could not be read.', detail: page.detail || page.reason });
    for (const b of page.blocks) {
        const tx = b.transactions.find((t) => t.function === 'MintVAT' && t.validationCode === 0);
        if (tx) {
            return res.json({
                found: true, blockNumber: b.number, txID: tx.txID, electionID: tx.electionID,
                publicWrites: tx.writes.map((w) => ({ key: w.key, value: w.value })),
                privateWrites: tx.hashedWrites,
            });
        }
    }
    return res.json({ found: false, scanned: page.blocks.length });
});

router.post('/privacy-probe', async (req, res) => {
    const r = await gw.privacyProbe(AUDITOR, 8000);
    res.json({ evaluatedAs: 'OrgCivilSocietyMSP (non-member of voterIssuedCollection)', submitted: false, ...r });
});

router.get('/drawer/:id', (req, res) => {
    const d = drawers.get(req.params.id);
    return d ? res.json(d) : res.status(404).json({ error: 'unknown drawer' });
});

module.exports = { router };
