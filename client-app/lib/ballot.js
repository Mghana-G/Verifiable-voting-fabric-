'use strict';

const crypto              = require('crypto');
const { connectIEBC }     = require('./gateway');
const { canonicalise, signBallot } = require('./ephemeral');

const CHANNEL   = 'votingchannel';
const CHAINCODE = 'voting';

function buildPayload(vatID, candidateID, electionID) {
    const nonce     = crypto.randomBytes(16).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadStr = canonicalise({ candidateID, electionID, nonce, timestamp, vatID });
    return { payloadStr, nonce, timestamp };
}

async function castBallot(vatID, candidateID, electionID) {
    const { payloadStr, nonce } = buildPayload(vatID, candidateID, electionID);
    const { ephemeralPubKey, signatureB64 } = signBallot(payloadStr);

    const { gateway, close } = await connectIEBC();
    try {
        const contract = gateway.getNetwork(CHANNEL).getContract(CHAINCODE);
        const resultBytes = await contract.submitTransaction(
            'CastBallot',
            vatID, candidateID,
            ephemeralPubKey,
            signatureB64,
            payloadStr,
            nonce
        );
        const result = JSON.parse(Buffer.from(resultBytes).toString('utf8'));
        return result;
    } finally {
        close();
    }
}

module.exports = { buildPayload, castBallot };
