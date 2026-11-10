'use strict';

const { Router }  = require('express');
const { mintVAT } = require('../lib/vat');

const router = Router();

// POST /mint  { hash, electionID, pollingStationID }  →  { vatID }
router.post('/', async (req, res) => {
    const { hash, electionID, pollingStationID } = req.body;
    if (!hash || !electionID || !pollingStationID) {
        return res.status(400).json({ error: 'hash, electionID and pollingStationID are required' });
    }
    try {
        const vatID = await mintVAT(hash, electionID, pollingStationID);
        res.json({ vatID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
