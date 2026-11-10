'use strict';

const { Router }    = require('express');
const { castBallot } = require('../lib/ballot');

const router = Router();

// POST /cast  { vatID, candidateID, electionID }  →  { ballotID, vatID, candidateID, electionID, timestamp }
router.post('/', async (req, res) => {
    const { vatID, candidateID, electionID } = req.body;
    if (!vatID || !candidateID || !electionID) {
        return res.status(400).json({ error: 'vatID, candidateID and electionID are required' });
    }
    try {
        const result = await castBallot(vatID, candidateID, electionID);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
