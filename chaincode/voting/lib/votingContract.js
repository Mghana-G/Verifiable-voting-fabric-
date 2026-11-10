'use strict';

const { Contract } = require('fabric-contract-api');
const keys = require('./keys');
const errors = require('./errors');
const { verifySignature } = require('./crypto');

const COLLECTION = 'voterIssuedCollection';

// Drain an async state iterator safely.
async function drainIterator(iter) {
    const results = [];
    try {
        let res = await iter.next();
        while (!res.done) {
            if (res.value) results.push(res.value);
            res = await iter.next();
        }
    } finally {
        await iter.close();
    }
    return results;
}

// Convert protobuf Timestamp (Long seconds) to a plain JS number.
function tsToNumber(ts) {
    if (!ts || !ts.seconds) return 0;
    if (typeof ts.seconds.toNumber === 'function') return ts.seconds.toNumber();
    return (ts.seconds.low >>> 0) + ts.seconds.high * 4294967296;
}

class VotingContract extends Contract {
    constructor() {
        super('VotingContract');
    }

    // ── CreateCandidate ────────────────────────────────────────────────────────
    async CreateCandidate(ctx, candidateID, name, party) {
        const role = ctx.clientIdentity.getAttributeValue('role');
        if (role !== 'admin') {
            throw new Error(errors.ERR_NOT_ADMIN);
        }
        const key = keys.candidateKey(ctx.stub, candidateID);
        await ctx.stub.putState(key, Buffer.from(JSON.stringify({ name, party })));
        return JSON.stringify({ candidateID, name, party });
    }

    // ── MintVAT ────────────────────────────────────────────────────────────────
    async MintVAT(ctx, voterHash, electionID, pollingStationID) {
        const viKey = keys.voterIssuedKey(ctx.stub, electionID, voterHash);
        const existing = await ctx.stub.getPrivateData(COLLECTION, viKey);
        if (existing && existing.length > 0) {
            throw new Error(errors.ERR_DUPLICATE_ISSUANCE);
        }

        const vatID = ctx.stub.getTxID();
        const issuedAt = tsToNumber(ctx.stub.getTxTimestamp());

        const vat = { electionID, pollingStationID, issuedAt, status: 'ACTIVE' };
        await ctx.stub.putState(keys.vatKey(ctx.stub, vatID), Buffer.from(JSON.stringify(vat)));
        await ctx.stub.putPrivateData(COLLECTION, viKey, Buffer.from(vatID));

        return vatID;
    }

    // ── CastBallot ─────────────────────────────────────────────────────────────
    // Validation order per Chapter 4.3.2 — do NOT reorder:
    //   1. Signature   → ERR_BAD_SIGNATURE
    //   2. Nonce       → ERR_NONCE_USED
    //   3. VAT status  → ERR_VAT_NOT_ACTIVE
    //   4. Candidate   → ERR_NO_CANDIDATE
    async CastBallot(ctx, vatID, candidateID, ephemeralPubKey, signature, payload, nonce) {

        // 1. Verify signature over payload.
        if (!verifySignature(ephemeralPubKey, signature, payload)) {
            throw new Error(errors.ERR_BAD_SIGNATURE);
        }

        // Parse the signed payload and cross-check the parameters against it.
        let payloadObj;
        try {
            payloadObj = JSON.parse(payload);
        } catch (_) {
            throw new Error(errors.ERR_BAD_SIGNATURE);
        }
        if (payloadObj.vatID !== vatID ||
            payloadObj.candidateID !== candidateID ||
            payloadObj.nonce !== nonce) {
            throw new Error(errors.ERR_BAD_SIGNATURE);
        }
        const electionID = payloadObj.electionID;

        // 2. Nonce check (replay-attack prevention).
        const nKey = keys.nonceKey(ctx.stub, electionID, nonce);
        const nonceExists = await ctx.stub.getState(nKey);
        if (nonceExists && nonceExists.length > 0) {
            throw new Error(errors.ERR_NONCE_USED);
        }

        // 3. VAT status check.
        const vKey = keys.vatKey(ctx.stub, vatID);
        const vatBytes = await ctx.stub.getState(vKey);
        if (!vatBytes || vatBytes.length === 0) {
            throw new Error(errors.ERR_VAT_NOT_ACTIVE);
        }
        const vat = JSON.parse(vatBytes.toString());
        if (vat.status !== 'ACTIVE') {
            throw new Error(errors.ERR_VAT_NOT_ACTIVE);
        }

        // 4. Candidate existence check.
        const cKey = keys.candidateKey(ctx.stub, candidateID);
        const candBytes = await ctx.stub.getState(cKey);
        if (!candBytes || candBytes.length === 0) {
            throw new Error(errors.ERR_NO_CANDIDATE);
        }

        // All checks passed — five writes in one atomic invocation.
        const ballotID = ctx.stub.getTxID();
        const timestamp = tsToNumber(ctx.stub.getTxTimestamp());

        vat.status = 'BURNED';
        await ctx.stub.putState(vKey, Buffer.from(JSON.stringify(vat)));

        const ballot = { candidateID, electionID, timestamp };
        await ctx.stub.putState(keys.ballotKey(ctx.stub, ballotID), Buffer.from(JSON.stringify(ballot)));

        await ctx.stub.putState(nKey, Buffer.from('used'));

        const tKey = keys.tallyKey(ctx.stub, electionID, candidateID);
        const tallyBytes = await ctx.stub.getState(tKey);
        const tally = (tallyBytes && tallyBytes.length > 0) ? parseInt(tallyBytes.toString(), 10) : 0;
        await ctx.stub.putState(tKey, Buffer.from(String(tally + 1)));

        const bKey = keys.burnedCountKey(ctx.stub, electionID);
        const burnedBytes = await ctx.stub.getState(bKey);
        const burned = (burnedBytes && burnedBytes.length > 0) ? parseInt(burnedBytes.toString(), 10) : 0;
        await ctx.stub.putState(bKey, Buffer.from(String(burned + 1)));

        return JSON.stringify({ ballotID, vatID, candidateID, electionID, timestamp });
    }

    // ── GetAuditInvariant ──────────────────────────────────────────────────────
    async GetAuditInvariant(ctx, electionID) {
        const bKey = keys.burnedCountKey(ctx.stub, electionID);
        const burnedBytes = await ctx.stub.getState(bKey);
        const burnedCount = (burnedBytes && burnedBytes.length > 0)
            ? parseInt(burnedBytes.toString(), 10) : 0;

        const iter = await ctx.stub.getStateByPartialCompositeKey(keys.TALLY, [electionID]);
        const items = await drainIterator(iter);
        let tallyTotal = 0;
        for (const item of items) {
            if (item.value && item.value.length > 0) {
                tallyTotal += parseInt(item.value.toString(), 10);
            }
        }

        return JSON.stringify({ burnedCount, tallyTotal });
    }

    // ── GetTally ───────────────────────────────────────────────────────────────
    async GetTally(ctx, electionID) {
        const result = {};
        const iter = await ctx.stub.getStateByPartialCompositeKey(keys.TALLY, [electionID]);
        const items = await drainIterator(iter);
        for (const item of items) {
            const { attributes } = ctx.stub.splitCompositeKey(item.key);
            const candidateID = attributes[1];
            result[candidateID] = (item.value && item.value.length > 0)
                ? parseInt(item.value.toString(), 10) : 0;
        }
        return JSON.stringify(result);
    }

    // ── GetBlockAudit ──────────────────────────────────────────────────────────
    // Returns raw ChainInfo from QSCC as base64. Protobuf decoding is done
    // in the verification dashboard (Phase 3) — see Part E.5.
    async GetBlockAudit(ctx, electionID) {
        const channelID = ctx.stub.getChannelID();
        let chainInfoB64 = '';
        try {
            const resp = await ctx.stub.invokeChaincode(
                'qscc',
                [Buffer.from('GetChainInfo'), Buffer.from(channelID)],
                channelID
            );
            if (resp && resp.payload && resp.payload.length > 0) {
                chainInfoB64 = Buffer.from(resp.payload).toString('base64');
            }
        } catch (_) {
            // QSCC unavailable in test environments; return empty payload.
        }
        return JSON.stringify({ channelID, chainInfoB64, electionID });
    }
}

module.exports = VotingContract;
