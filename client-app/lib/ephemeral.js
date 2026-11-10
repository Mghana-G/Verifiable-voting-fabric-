'use strict';

const crypto = require('crypto');

// ── Canonical JSON ──────────────────────────────────────────────────────────
// COPIED VERBATIM from chaincode/voting/lib/crypto.js.
// Keys are sorted alphabetically; no whitespace.  Any change here will break
// signature verification in the chaincode.
function canonicalise(obj) {
    const sorted = {};
    Object.keys(obj).sort().forEach(k => { sorted[k] = obj[k]; });
    return JSON.stringify(sorted);
}

// ── Ephemeral key pair + ballot signing ────────────────────────────────────
// Generates a one-time P-256 key pair, signs payloadStr, then nulls the
// private key reference (Section 4 steps 4-5 of IMPLEMENTATION_BRIEF.md).
function signBallot(payloadStr) {
    let { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    const sign = crypto.createSign('SHA256');
    sign.update(payloadStr, 'utf8');
    const signatureB64 = sign.sign(privateKey, 'base64');

    const ephemeralPubKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    // Null the private key immediately after use per IMPLEMENTATION_BRIEF Section 4.
    // eslint-disable-next-line no-unused-vars
    privateKey = null;

    return { ephemeralPubKey, signatureB64 };
}

module.exports = { canonicalise, signBallot };
