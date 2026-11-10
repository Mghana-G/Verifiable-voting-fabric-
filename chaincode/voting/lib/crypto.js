'use strict';

const nodeCrypto = require('crypto');

// Canonical JSON: keys sorted alphabetically, no whitespace.
// This function is copied verbatim into client-app/lib/ephemeral.js so the
// signed bytes are byte-identical to what the chaincode verifies.
function canonicalise(obj) {
    const sorted = {};
    Object.keys(obj).sort().forEach(k => { sorted[k] = obj[k]; });
    return JSON.stringify(sorted);
}

// Verify an ECDSA P-256 signature.
// ephemeralPubKeyPem : SPKI PEM string
// signatureB64       : base64-encoded DER signature
// payload            : canonical JSON string that was signed (SHA-256 digest)
function verifySignature(ephemeralPubKeyPem, signatureB64, payload) {
    try {
        const verify = nodeCrypto.createVerify('SHA256');
        verify.update(payload, 'utf8');
        return verify.verify(ephemeralPubKeyPem, signatureB64, 'base64');
    } catch (_) {
        return false;
    }
}

module.exports = { canonicalise, verifySignature };
