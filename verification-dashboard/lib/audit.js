'use strict';

const { getNetwork } = require('./gateway');

const CHAINCODE = 'voting';
const CHANNEL   = 'votingchannel';

// Validation code → human-readable label
const TX_VALIDATION_CODES = {
    0  : 'VALID',
    10 : 'ENDORSEMENT_POLICY_FAILURE',
    11 : 'MVCC_READ_CONFLICT',
    12 : 'BAD_RESPONSE_PAYLOAD',
    13 : 'BAD_RWSET',
    14 : 'FLAG_FORBIDDEN',
    15 : 'INVALID_OTHER_REASON',
};

function validationCodeName(code) {
    return TX_VALIDATION_CODES[code] || `INVALID(${code})`;
}

// In-memory rolling window of the last 20 blocks.
let _blockWindow = [];
const WINDOW_SIZE = 20;

// Start listening to filtered block events from block 0, building a rolling
// window of the last WINDOW_SIZE blocks (historical + live).
// fabric-gateway v1.11: getFilteredBlockEvents() returns a Promise.
async function startBlockListener() {
    const network = getNetwork();
    let events;
    try {
        events = await network.getFilteredBlockEvents({ startBlock: BigInt(0) });
    } catch (err) {
        console.error('[audit] could not subscribe to block events:', err.message);
        return;
    }
    (async () => {
        try {
            for await (const fb of events) {
                const blockNum = Number(fb.getNumber());
                const txList   = fb.getFilteredTransactionsList().map(tx => ({
                    txId           : tx.getTxid(),
                    validationCode : validationCodeName(tx.getTxValidationCode()),
                }));
                _blockWindow.push({ blockNumber: blockNum, transactions: txList });
                if (_blockWindow.length > WINDOW_SIZE) {
                    _blockWindow = _blockWindow.slice(-WINDOW_SIZE);
                }
            }
        } catch (err) {
            console.error('[audit] block listener error:', err.message);
        }
    })();
}

async function getAuditInvariant(electionID) {
    const contract    = getNetwork().getContract(CHAINCODE);
    const resultBytes = await contract.evaluateTransaction('GetAuditInvariant', electionID);
    return JSON.parse(Buffer.from(resultBytes).toString('utf8'));
}

async function getTally(electionID) {
    const contract    = getNetwork().getContract(CHAINCODE);
    const resultBytes = await contract.evaluateTransaction('GetTally', electionID);
    return JSON.parse(Buffer.from(resultBytes).toString('utf8'));
}

function getBlockWindow() {
    return [..._blockWindow];
}

module.exports = { startBlockListener, getAuditInvariant, getTally, getBlockWindow };
