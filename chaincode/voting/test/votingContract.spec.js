'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');
const { canonicalise, verifySignature } = require('../lib/crypto');
const errors = require('../lib/errors');
const VotingContract = require('../lib/votingContract');

// ── Helpers ──────────────────────────────────────────────────────────────────

// Minimal composite-key helpers that match Fabric's null-byte format closely
// enough for deterministic round-trips within the same process.
function mockCreateCompositeKey(type, attrs) {
    return '\x00' + type + '\x00' + attrs.join('\x00') + '\x00';
}
function mockSplitCompositeKey(key) {
    const parts = key.replace(/^\x00/, '').replace(/\x00$/, '').split('\x00');
    return { objectType: parts[0], attributes: parts.slice(1) };
}

function makeStub(overrides = {}) {
    const state     = {};
    const pvtState  = {};
    let   txCounter = 0;

    const stub = {
        createCompositeKey : mockCreateCompositeKey,
        splitCompositeKey  : mockSplitCompositeKey,
        getTxID            : () => `txid-${++txCounter}`,
        getTxTimestamp     : () => ({ seconds: { toNumber: () => 1700000000, low: 1700000000, high: 0 } }),
        getChannelID       : () => 'votingchannel',

        async getState(key) {
            return state[key] ? Buffer.from(state[key]) : Buffer.alloc(0);
        },
        async putState(key, value) {
            state[key] = value.toString();
        },
        async getPrivateData(collection, key) {
            const k = collection + '|' + key;
            return pvtState[k] ? Buffer.from(pvtState[k]) : Buffer.alloc(0);
        },
        async putPrivateData(collection, key, value) {
            pvtState[collection + '|' + key] = value.toString();
        },
        async getStateByPartialCompositeKey(type, partialKeys) {
            const prefix = '\x00' + type + '\x00' + partialKeys.join('\x00') + '\x00';
            const matching = Object.entries(state)
                .filter(([k]) => k.startsWith(prefix))
                .map(([key, value]) => ({ key, value: Buffer.from(value) }));
            let i = 0;
            return {
                async next() {
                    if (i < matching.length) return { value: matching[i++], done: false };
                    return { value: undefined, done: true };
                },
                async close() {},
            };
        },
        async invokeChaincode() {
            return { status: 200, payload: Buffer.alloc(0) };
        },
        setEvent: sinon.stub(),
        // Allow direct state inspection in tests
        _state: state,
        _pvtState: pvtState,
    };

    return Object.assign(stub, overrides);
}

function makeCtx(stubOverrides = {}, role = 'admin') {
    const stub = makeStub(stubOverrides);
    return {
        stub,
        clientIdentity: { getAttributeValue: sinon.stub().returns(role) },
    };
}

// Generate a real ECDSA P-256 key pair and sign a payload — used for
// CastBallot tests that need a valid signature.
function generateKeyAndSign(payloadObj) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const payload = canonicalise(payloadObj);
    const sign = crypto.createSign('SHA256');
    sign.update(payload, 'utf8');
    const signatureB64 = sign.sign(privateKey, 'base64');
    const pubKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return { pubKeyPem, signatureB64, payload };
}

// ── CreateCandidate ───────────────────────────────────────────────────────────

describe('CreateCandidate', () => {
    const contract = new VotingContract();

    it('writes a candidate when role is admin', async () => {
        const ctx = makeCtx();
        const result = await contract.CreateCandidate(ctx, 'C001', 'Alice', 'Party A');
        const parsed = JSON.parse(result);
        assert.strictEqual(parsed.candidateID, 'C001');
        assert.strictEqual(parsed.name, 'Alice');
        assert.strictEqual(parsed.party, 'Party A');

        const key = mockCreateCompositeKey('CANDIDATE', ['C001']);
        assert.ok(ctx.stub._state[key]);
        const stored = JSON.parse(ctx.stub._state[key]);
        assert.strictEqual(stored.name, 'Alice');
    });

    it('throws ERR_NOT_ADMIN when role is not admin', async () => {
        const ctx = makeCtx({}, 'client');
        await assert.rejects(
            () => contract.CreateCandidate(ctx, 'C001', 'Alice', 'Party A'),
            (err) => { assert.strictEqual(err.message, errors.ERR_NOT_ADMIN); return true; }
        );
    });

    it('throws ERR_NOT_ADMIN when role attribute is null', async () => {
        const ctx = makeCtx({}, null);
        await assert.rejects(
            () => contract.CreateCandidate(ctx, 'C001', 'Alice', 'Party A'),
            (err) => { assert.strictEqual(err.message, errors.ERR_NOT_ADMIN); return true; }
        );
    });
});

// ── MintVAT ───────────────────────────────────────────────────────────────────

describe('MintVAT', () => {
    const contract = new VotingContract();

    it('issues a VAT and returns vatID on first call', async () => {
        const ctx = makeCtx();
        const vatID = await contract.MintVAT(ctx, 'hash1', 'election2027', 'PS001');
        assert.strictEqual(typeof vatID, 'string');
        assert.ok(vatID.length > 0);

        const vKey = mockCreateCompositeKey('VAT', [vatID]);
        const vat = JSON.parse(ctx.stub._state[vKey]);
        assert.strictEqual(vat.status, 'ACTIVE');
        assert.strictEqual(vat.electionID, 'election2027');
        assert.strictEqual(vat.pollingStationID, 'PS001');
    });

    it('writes VOTERISSUED to private data', async () => {
        const ctx = makeCtx();
        const vatID = await contract.MintVAT(ctx, 'hash2', 'election2027', 'PS001');
        const viKey = mockCreateCompositeKey('VOTERISSUED', ['election2027', 'hash2']);
        const pvtKey = 'voterIssuedCollection|' + viKey;
        assert.strictEqual(ctx.stub._pvtState[pvtKey], vatID);
    });

    it('throws ERR_DUPLICATE_ISSUANCE on second mint for same voterHash', async () => {
        const ctx = makeCtx();
        await contract.MintVAT(ctx, 'hash3', 'election2027', 'PS001');
        await assert.rejects(
            () => contract.MintVAT(ctx, 'hash3', 'election2027', 'PS001'),
            (err) => { assert.strictEqual(err.message, errors.ERR_DUPLICATE_ISSUANCE); return true; }
        );
    });

    it('vatID derives from txID (determinism)', async () => {
        const ctx = makeCtx();
        const id = await contract.MintVAT(ctx, 'hashX', 'election2027', 'PS001');
        // txID is provided by the stub; vatID must equal getTxID() at invocation time.
        assert.ok(id.startsWith('txid-'));
    });
});

// ── CastBallot ────────────────────────────────────────────────────────────────

describe('CastBallot', () => {
    const contract = new VotingContract();

    async function setupForCast(ctx) {
        // Create a candidate.
        await contract.CreateCandidate(ctx, 'C001', 'Alice', 'Party A');
        // Mint a VAT.
        const vatID = await contract.MintVAT(ctx, 'hashV', 'election2027', 'PS001');
        return vatID;
    }

    function buildPayloadAndSign(vatID, candidateID) {
        const payloadObj = {
            candidateID,
            electionID : 'election2027',
            nonce      : 'nonce-abc-123',
            timestamp  : 1700000000,
            vatID,
        };
        return {
            ...generateKeyAndSign(payloadObj),
            payloadObj,
            nonce: payloadObj.nonce,
        };
    }

    it('burns the VAT and increments tally + burnedCount on valid ballot', async () => {
        const ctx = makeCtx();
        const vatID = await setupForCast(ctx);
        const { pubKeyPem, signatureB64, payload, nonce } = buildPayloadAndSign(vatID, 'C001');

        const result = await contract.CastBallot(
            ctx, vatID, 'C001', pubKeyPem, signatureB64, payload, nonce
        );
        const parsed = JSON.parse(result);
        assert.strictEqual(parsed.vatID, vatID);
        assert.strictEqual(parsed.candidateID, 'C001');

        const vKey = mockCreateCompositeKey('VAT', [vatID]);
        const vat = JSON.parse(ctx.stub._state[vKey]);
        assert.strictEqual(vat.status, 'BURNED');

        const tKey = mockCreateCompositeKey('TALLY', ['election2027', 'C001']);
        assert.strictEqual(ctx.stub._state[tKey], '1');

        const bKey = mockCreateCompositeKey('BURNEDCOUNT', ['election2027']);
        assert.strictEqual(ctx.stub._state[bKey], '1');
    });

    it('throws ERR_BAD_SIGNATURE when signature is invalid — FIRST check', async () => {
        const ctx = makeCtx();
        const vatID = await setupForCast(ctx);
        const { pubKeyPem, payload, nonce } = buildPayloadAndSign(vatID, 'C001');

        await assert.rejects(
            () => contract.CastBallot(ctx, vatID, 'C001', pubKeyPem, 'badsig==', payload, nonce),
            (err) => { assert.strictEqual(err.message, errors.ERR_BAD_SIGNATURE); return true; }
        );
    });

    it('throws ERR_BAD_SIGNATURE when payload params do not match args', async () => {
        const ctx = makeCtx();
        const vatID = await setupForCast(ctx);
        // Sign with C001 but invoke with C002 — cross-check should catch it.
        const { pubKeyPem, signatureB64, payload, nonce } = buildPayloadAndSign(vatID, 'C001');

        await assert.rejects(
            () => contract.CastBallot(ctx, vatID, 'C002', pubKeyPem, signatureB64, payload, nonce),
            (err) => { assert.strictEqual(err.message, errors.ERR_BAD_SIGNATURE); return true; }
        );
    });

    it('throws ERR_NONCE_USED on replay — SECOND check (after sig, before VAT)', async () => {
        const ctx = makeCtx();
        const vatID1 = await setupForCast(ctx);
        const { pubKeyPem, signatureB64, payload, nonce } = buildPayloadAndSign(vatID1, 'C001');
        // First cast succeeds.
        await contract.CastBallot(ctx, vatID1, 'C001', pubKeyPem, signatureB64, payload, nonce);

        // Mint a second VAT so the VAT check would pass — but nonce check fires first.
        const vatID2 = await contract.MintVAT(ctx, 'hash-new', 'election2027', 'PS002');
        // Build a new payload with the SAME nonce but different vatID, re-sign it.
        const { pubKeyPem: pk2, signatureB64: sig2, payload: pl2 } = generateKeyAndSign({
            candidateID : 'C001',
            electionID  : 'election2027',
            nonce,          // reused nonce
            timestamp   : 1700000001,
            vatID       : vatID2,
        });
        await assert.rejects(
            () => contract.CastBallot(ctx, vatID2, 'C001', pk2, sig2, pl2, nonce),
            (err) => { assert.strictEqual(err.message, errors.ERR_NONCE_USED); return true; }
        );
    });

    it('throws ERR_VAT_NOT_ACTIVE on double-vote — THIRD check', async () => {
        const ctx = makeCtx();
        const vatID = await setupForCast(ctx);
        const { pubKeyPem, signatureB64, payload, nonce } = buildPayloadAndSign(vatID, 'C001');
        // First cast burns the VAT.
        await contract.CastBallot(ctx, vatID, 'C001', pubKeyPem, signatureB64, payload, nonce);

        // Second cast with same vatID but fresh nonce (so nonce check passes).
        const freshNonce = 'nonce-fresh-456';
        const { pubKeyPem: pk2, signatureB64: sig2, payload: pl2 } = generateKeyAndSign({
            candidateID : 'C001',
            electionID  : 'election2027',
            nonce       : freshNonce,
            timestamp   : 1700000002,
            vatID,
        });
        await assert.rejects(
            () => contract.CastBallot(ctx, vatID, 'C001', pk2, sig2, pl2, freshNonce),
            (err) => { assert.strictEqual(err.message, errors.ERR_VAT_NOT_ACTIVE); return true; }
        );
    });

    it('throws ERR_NO_CANDIDATE for unknown candidateID — FOURTH check', async () => {
        const ctx = makeCtx();
        // Mint a VAT but do NOT create a candidate.
        const vatID = await contract.MintVAT(ctx, 'hashW', 'election2027', 'PS001');
        const { pubKeyPem, signatureB64, payload, nonce } = generateKeyAndSign({
            candidateID : 'UNKNOWN',
            electionID  : 'election2027',
            nonce       : 'nonce-xyz',
            timestamp   : 1700000000,
            vatID,
        });
        // Pass the raw payload through generateKeyAndSign's return.
        const payloadStr = canonicalise({
            candidateID : 'UNKNOWN',
            electionID  : 'election2027',
            nonce       : 'nonce-xyz',
            timestamp   : 1700000000,
            vatID,
        });

        await assert.rejects(
            () => contract.CastBallot(ctx, vatID, 'UNKNOWN', pubKeyPem, signatureB64, payloadStr, 'nonce-xyz'),
            (err) => { assert.strictEqual(err.message, errors.ERR_NO_CANDIDATE); return true; }
        );
    });
});

// ── GetAuditInvariant ─────────────────────────────────────────────────────────

describe('GetAuditInvariant', () => {
    const contract = new VotingContract();

    it('returns {burnedCount:0, tallyTotal:0} for a fresh election', async () => {
        const ctx = makeCtx();
        const result = JSON.parse(await contract.GetAuditInvariant(ctx, 'election2027'));
        assert.strictEqual(result.burnedCount, 0);
        assert.strictEqual(result.tallyTotal, 0);
    });

    it('returns matching burnedCount and tallyTotal after casting a ballot', async () => {
        const ctx = makeCtx();
        await contract.CreateCandidate(ctx, 'C001', 'Alice', 'Party A');
        const vatID = await contract.MintVAT(ctx, 'hashAudit', 'election2027', 'PS001');
        const { pubKeyPem, signatureB64, payload, nonce } = (() => {
            const p = { candidateID:'C001', electionID:'election2027', nonce:'n1', timestamp:1700000000, vatID };
            return { ...generateKeyAndSign(p), nonce: p.nonce };
        })();
        await contract.CastBallot(ctx, vatID, 'C001', pubKeyPem, signatureB64, payload, nonce);

        const result = JSON.parse(await contract.GetAuditInvariant(ctx, 'election2027'));
        assert.strictEqual(result.burnedCount, 1);
        assert.strictEqual(result.tallyTotal, 1);
    });
});

// ── GetTally ──────────────────────────────────────────────────────────────────

describe('GetTally', () => {
    const contract = new VotingContract();

    it('returns empty object when no votes cast', async () => {
        const ctx = makeCtx();
        const result = JSON.parse(await contract.GetTally(ctx, 'election2027'));
        assert.deepStrictEqual(result, {});
    });

    it('returns per-candidate counts after voting', async () => {
        const ctx = makeCtx();
        await contract.CreateCandidate(ctx, 'C001', 'Alice', 'Party A');
        await contract.CreateCandidate(ctx, 'C002', 'Bob', 'Party B');

        // Two votes for C001, one for C002.
        for (const [hash, cand, nonce, ts] of [
            ['h1', 'C001', 'n1', 1700000001],
            ['h2', 'C001', 'n2', 1700000002],
            ['h3', 'C002', 'n3', 1700000003],
        ]) {
            const vatID = await contract.MintVAT(ctx, hash, 'election2027', 'PS001');
            const p = { candidateID: cand, electionID: 'election2027', nonce, timestamp: ts, vatID };
            const { pubKeyPem, signatureB64 } = generateKeyAndSign(p);
            const payload = canonicalise(p);
            await contract.CastBallot(ctx, vatID, cand, pubKeyPem, signatureB64, payload, nonce);
        }

        const result = JSON.parse(await contract.GetTally(ctx, 'election2027'));
        assert.strictEqual(result['C001'], 2);
        assert.strictEqual(result['C002'], 1);
    });
});

// ── crypto helpers ────────────────────────────────────────────────────────────

describe('crypto', () => {
    it('canonicalise sorts keys alphabetically', () => {
        const obj = { z: 3, a: 1, m: 2 };
        assert.strictEqual(canonicalise(obj), '{"a":1,"m":2,"z":3}');
    });

    it('verifySignature accepts a valid ECDSA P-256 signature', () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const msg = 'hello world';
        const sign = crypto.createSign('SHA256');
        sign.update(msg, 'utf8');
        const sig = sign.sign(privateKey, 'base64');
        const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        assert.strictEqual(verifySignature(pem, sig, msg), true);
    });

    it('verifySignature rejects a tampered payload', () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const sign = crypto.createSign('SHA256');
        sign.update('original', 'utf8');
        const sig = sign.sign(privateKey, 'base64');
        const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        assert.strictEqual(verifySignature(pem, sig, 'tampered'), false);
    });
});
