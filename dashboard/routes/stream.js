'use strict';

// Server-Sent Events: job logs (scripts, tests, batches) and the live block tail.
// Every stream sends a heartbeat every 15 s and closes cleanly when the job ends.

const express = require('express');
const jobs = require('../lib/jobs');
const blocks = require('../lib/blocks');

const router = express.Router();

// Admin sees every job; a voter session may follow a batch.
router.get('/job/:id', (req, res) => {
    const job = jobs.find(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    const role = req.session && req.session.role;
    if (role !== 'admin' && !(role === 'voter' && job.kind === 'batch')) return res.status(role ? 403 : 401).json({ error: 'not allowed' });
    return jobs.stream(job, req, res);
});

router.get('/blocks', async (req, res) => {
    if (!req.session || req.session.role !== 'admin') return res.status(req.session ? 403 : 401).json({ error: 'not allowed' });
    const h = await blocks.height();
    if (!h.ok) return res.status(503).json({ error: 'The ledger could not be read.' });
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const hb = setInterval(() => res.write(': heartbeat\n\n'), jobs.HEARTBEAT_MS);
    let handle = null;
    try {
        handle = await blocks.tail(h.height, (b) => res.write(`data: ${JSON.stringify(b)}\n\n`));
    } catch (e) {
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        clearInterval(hb);
        return res.end();
    }
    res.write(`data: ${JSON.stringify({ hello: true, fromBlock: h.height })}\n\n`);
    req.on('close', () => { clearInterval(hb); if (handle) handle.close(); });
    return undefined;
});

module.exports = { router };
