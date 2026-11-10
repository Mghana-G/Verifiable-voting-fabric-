'use strict';

const { Router }      = require('express');
const { verifyVoter } = require('../lib/registry');

const router = Router();

// POST /verify  { voter_id }  →  { ok, hash? }
router.post('/', (req, res) => {
    const { voter_id } = req.body;
    if (!voter_id || typeof voter_id !== 'string') {
        return res.status(400).json({ error: 'voter_id is required' });
    }
    const result = verifyVoter(voter_id.trim());
    res.json(result);
});

module.exports = router;
