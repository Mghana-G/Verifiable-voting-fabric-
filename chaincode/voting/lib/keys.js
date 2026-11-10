'use strict';

const CANDIDATE   = 'CANDIDATE';
const VAT         = 'VAT';
const BALLOT      = 'BALLOT';
const TALLY       = 'TALLY';
const BURNEDCOUNT = 'BURNEDCOUNT';
const NONCE       = 'NONCE';
const VOTERISSUED = 'VOTERISSUED';

const candidateKey   = (stub, id)                => stub.createCompositeKey(CANDIDATE,   [id]);
const vatKey         = (stub, id)                => stub.createCompositeKey(VAT,         [id]);
const ballotKey      = (stub, id)                => stub.createCompositeKey(BALLOT,      [id]);
const tallyKey       = (stub, electionID, cand)  => stub.createCompositeKey(TALLY,       [electionID, cand]);
const burnedCountKey = (stub, electionID)        => stub.createCompositeKey(BURNEDCOUNT, [electionID]);
const nonceKey       = (stub, electionID, nonce) => stub.createCompositeKey(NONCE,       [electionID, nonce]);
const voterIssuedKey = (stub, electionID, hash)  => stub.createCompositeKey(VOTERISSUED, [electionID, hash]);

module.exports = {
    CANDIDATE, VAT, BALLOT, TALLY, BURNEDCOUNT, NONCE, VOTERISSUED,
    candidateKey, vatKey, ballotKey, tallyKey, burnedCountKey, nonceKey, voterIssuedKey,
};
