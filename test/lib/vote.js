'use strict';

/**
 * Shared vote-building helpers for the validation test suite.
 *
 * canonicalise() is copied verbatim from chaincode/voting/lib/crypto.js and
 * client-app/lib/ephemeral.js. Do not let this copy diverge  (see
 * Phase 3 constraint on canonicalisation).
 */

const crypto = require('crypto');
const { signers } = require('@hyperledger/fabric-gateway');
const { ALL_MSPS } = require('./gateway');

function canonicalise(obj) {
    const sorted = {};
    Object.keys(obj).sort().forEach((k) => { sorted[k] = obj[k]; });
    return JSON.stringify(sorted);
}

function signPayload(payloadStr) {
    let { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sign = crypto.createSign('SHA256');
    sign.update(payloadStr, 'utf8');
    const signatureB64 = sign.sign(privateKey, 'base64');
    const ephemeralPubKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privateKey = null;
    return { ephemeralPubKey, signatureB64 };
}

function buildCastArgs(vatID, candidateID, electionID) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadStr = canonicalise({ candidateID, electionID, nonce, timestamp, vatID });
    const { ephemeralPubKey, signatureB64 } = signPayload(payloadStr);
    return { vatID, candidateID, ephemeralPubKey, signatureB64, payloadStr, nonce, timestamp };
}

// DEV-003: MintVAT touches voterIssuedCollection (memberOnlyWrite:true), so
// service discovery cannot satisfy OutOf(3,...) on its own; the endorsing
// organisations must be listed explicitly.
const MINT_ENDORSERS = ['OrgIEBCMSP', 'OrgJudiciaryMSP', 'OrgCivilSocietyMSP'];

async function mintVAT(contract, voterHash, electionID, pollingStationID, endorsingOrgs = MINT_ENDORSERS) {
    const proposal = contract.newProposal('MintVAT', {
        arguments: [voterHash, electionID, pollingStationID],
        endorsingOrganizations: endorsingOrgs,
    });
    const transaction = await proposal.endorse();
    const commit = await transaction.submit();
    const status = await commit.getStatus();
    if (!status.successful) {
        const err = new Error(`MintVAT commit unsuccessful: code=${status.code}`);
        err.code = status.code;
        err.blockNumber = status.blockNumber;
        throw err;
    }
    return Buffer.from(transaction.getResult()).toString('utf8').trim();
}

// Submit-and-wait that returns the full Status (including blockNumber) even
// on an unsuccessful commit, instead of throwing, so callers can inspect the
// validation code directly (needed by test1b).
async function submitAndGetStatus(contract, name, args, endorsingOrgs) {
    const proposal = contract.newProposal(name, { arguments: args, ...(endorsingOrgs ? { endorsingOrganizations: endorsingOrgs } : {}) });
    const transaction = await proposal.endorse();
    const commit = await transaction.submit();
    const status = await commit.getStatus();
    return { status, resultBytes: transaction.getResult() };
}

// fabric-gateway's chaincode error text lives in err.details[i].message
// ("chaincode response 500, ERR_X"), not in the top-level err.message
// (typically "10 ABORTED: failed to collect enough transaction
// endorsements..."). Verified empirically against the live network.
// Fabric's "duplicate transaction found" detail appends the full hex-encoded
// creator certificate ("Creator [<hex>]..."), which is pure noise for
// evidence purposes (it is just the identity cert, already on disk under
// network/organizations/). Strip it so evidence files and console output
// stay readable.
function stripCreatorHexDump(text) {
    return text.replace(/\. Creator \[[0-9a-f]+\]\s*$/i, '.');
}

function errorText(err) {
    if (!err) return '';
    const detailMsgs = (err.details || []).map((d) => d.message).join(' || ');
    return stripCreatorHexDump([err.message, detailMsgs].filter(Boolean).join(' || '));
}

function containsCode(err, code) {
    return errorText(err).includes(code);
}

module.exports = {
    canonicalise,
    signPayload,
    buildCastArgs,
    mintVAT,
    submitAndGetStatus,
    errorText,
    containsCode,
    MINT_ENDORSERS,
    ALL_MSPS,
    signers,
};
