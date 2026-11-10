'use strict';

// Builds and signs a ballot with the thesis client code itself:
// buildPayload() from client-app/lib/ballot.js and signBallot() from
// client-app/lib/ephemeral.js. The private key never leaves signBallot().

const path = require('path');
const { REPO } = require('./util');

const { buildPayload } = require(path.join(REPO, 'client-app', 'lib', 'ballot.js'));
const { signBallot } = require(path.join(REPO, 'client-app', 'lib', 'ephemeral.js'));

function seal(vatID, candidateID, electionID) {
    const { payloadStr, nonce, timestamp } = buildPayload(vatID, candidateID, electionID);
    const { ephemeralPubKey, signatureB64 } = signBallot(payloadStr);
    return { vatID, candidateID, payloadStr, nonce, timestamp, ephemeralPubKey, signatureB64 };
}

module.exports = { seal };
