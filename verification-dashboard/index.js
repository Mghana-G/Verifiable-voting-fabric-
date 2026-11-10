'use strict';

const express  = require('express');
const path     = require('path');
const { startBlockListener, getAuditInvariant, getTally, getBlockWindow } = require('./lib/audit');

const app  = express();
const PORT = process.env.PORT || 4000;
const DEFAULT_ELECTION = process.env.ELECTION_ID || 'election2027';

app.use(express.static(path.join(__dirname, 'public')));

// Evaluate-only — no submit calls anywhere in this service.
app.get('/api/audit', async (req, res) => {
    const electionID = req.query.electionID || DEFAULT_ELECTION;
    try {
        const [invariant, tally] = await Promise.all([
            getAuditInvariant(electionID),
            getTally(electionID),
        ]);
        const pass  = invariant.burnedCount === invariant.tallyTotal;
        res.json({ electionID, invariant, pass, tally, blocks: getBlockWindow() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

(async () => {
    await startBlockListener();
    app.listen(PORT, () => {
        console.log(`verification-dashboard listening on port ${PORT} (electionID=${DEFAULT_ELECTION})`);
    });
})();
