'use strict';

// Pure decoding of Fabric blocks and transaction envelopes with
// @hyperledger/fabric-protos, plus the two hash checks of the public
// verifier. Nothing here touches the network.

const crypto = require('crypto');
const protos = require('@hyperledger/fabric-protos');

const { common, peer, msp, ledger } = protos;
const kv = ledger.rwset.kvrwset;

const CODES = {
    0: 'VALID', 1: 'NIL_ENVELOPE', 2: 'BAD_PAYLOAD', 3: 'BAD_COMMON_HEADER', 4: 'BAD_CREATOR_SIGNATURE',
    5: 'INVALID_ENDORSER_TRANSACTION', 6: 'INVALID_CONFIG_TRANSACTION', 7: 'UNSUPPORTED_TX_PAYLOAD', 8: 'BAD_PROPOSAL_TXID',
    9: 'DUPLICATE_TXID', 10: 'ENDORSEMENT_POLICY_FAILURE', 11: 'MVCC_READ_CONFLICT', 12: 'PHANTOM_READ_CONFLICT',
    13: 'UNKNOWN_TX_TYPE', 14: 'TARGET_CHAIN_NOT_FOUND', 15: 'MARSHAL_TX_ERROR', 16: 'NIL_TXACTION',
    17: 'EXPIRED_CHAINCODE', 18: 'CHAINCODE_VERSION_CONFLICT', 19: 'BAD_HEADER_EXTENSION', 20: 'BAD_CHANNEL_HEADER',
    21: 'BAD_RESPONSE_PAYLOAD', 22: 'BAD_RWSET', 23: 'ILLEGAL_WRITESET', 24: 'INVALID_WRITESET',
    254: 'NOT_VALIDATED', 255: 'INVALID_OTHER_REASON',
};
const codeName = (c) => CODES[c] || `CODE_${c}`;

const hex = (u8) => Buffer.from(u8).toString('hex');
const utf8 = (u8) => Buffer.from(u8).toString('utf8');
// Composite keys use a NUL delimiter; show it as ~.
const keyText = (k) => k.replace(/\u0000/g, '~').replace(/^~|~$/g, '');

function mspOf(identityBytes) {
    try { return msp.SerializedIdentity.deserializeBinary(identityBytes).getMspid(); } catch { return null; }
}

function tsISO(ts) {
    if (!ts) return null;
    return new Date(ts.getSeconds() * 1000 + Math.floor(ts.getNanos() / 1e6)).toISOString();
}

function valuePreview(u8) {
    const t = utf8(u8);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000e-\u001f]/.test(t)) return `(${u8.length} bytes, binary)`;
    return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

function decodeRwset(resultsU8) {
    const writes = [];
    const hashed = [];
    const reads = [];
    const txrw = ledger.rwset.TxReadWriteSet.deserializeBinary(resultsU8);
    for (const ns of txrw.getNsRwsetList()) {
        const name = ns.getNamespace();
        if (name === 'lscc' || name === '_lifecycle') continue;
        const rw = kv.KVRWSet.deserializeBinary(ns.getRwset_asU8());
        for (const r of rw.getReadsList()) reads.push({ ns: name, key: keyText(r.getKey()) });
        for (const w of rw.getWritesList()) {
            writes.push({ ns: name, key: keyText(w.getKey()), isDelete: w.getIsDelete(), value: w.getIsDelete() ? null : valuePreview(w.getValue_asU8()) });
        }
        for (const c of ns.getCollectionHashedRwsetList()) {
            const h = kv.HashedRWSet.deserializeBinary(c.getHashedRwset_asU8());
            hashed.push({
                ns: name,
                collection: c.getCollectionName(),
                writes: h.getHashedWritesList().map((w) => ({ keyHash: hex(w.getKeyHash_asU8()), valueHash: hex(w.getValueHash_asU8()), isDelete: w.getIsDelete() })),
                reads: h.getHashedReadsList().length,
            });
        }
    }
    return { writes, hashed, reads };
}

// Envelope bytes -> a plain object. Config transactions are labelled, not decoded further.
function decodeEnvelope(envBytes) {
    const env = common.Envelope.deserializeBinary(envBytes);
    const payload = common.Payload.deserializeBinary(env.getPayload_asU8());
    const ch = common.ChannelHeader.deserializeBinary(payload.getHeader().getChannelHeader_asU8());
    const sh = common.SignatureHeader.deserializeBinary(payload.getHeader().getSignatureHeader_asU8());
    const out = {
        txID: ch.getTxId(),
        type: ch.getType(),
        typeName: Object.keys(common.HeaderType).find((k) => common.HeaderType[k] === ch.getType()) || String(ch.getType()),
        timestamp: tsISO(ch.getTimestamp()),
        channel: ch.getChannelId(),
        creatorMsp: mspOf(sh.getCreator_asU8()),
        function: null, args: [], endorsers: [], writes: [], hashedWrites: [], readKeys: [], response: null,
    };
    if (ch.getType() !== common.HeaderType.ENDORSER_TRANSACTION) return out;
    const tx = peer.Transaction.deserializeBinary(payload.getData_asU8());
    const action = tx.getActionsList()[0];
    if (!action) return out;
    const cap = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8());
    const prop = peer.ChaincodeProposalPayload.deserializeBinary(cap.getChaincodeProposalPayload_asU8());
    const spec = peer.ChaincodeInvocationSpec.deserializeBinary(prop.getInput_asU8());
    const argv = spec.getChaincodeSpec().getInput().getArgsList_asU8().map(utf8);
    out.chaincode = spec.getChaincodeSpec().getChaincodeId().getName();
    [out.function, ...out.args] = argv;
    const ea = cap.getAction();
    out.endorsers = ea.getEndorsementsList().map((e) => mspOf(e.getEndorser_asU8()));
    const prp = peer.ProposalResponsePayload.deserializeBinary(ea.getProposalResponsePayload_asU8());
    const cc = peer.ChaincodeAction.deserializeBinary(prp.getExtension_asU8());
    const resp = cc.getResponse();
    if (resp) out.response = { status: resp.getStatus(), payload: valuePreview(resp.getPayload_asU8()) };
    const rw = decodeRwset(cc.getResults_asU8());
    out.writes = rw.writes;
    out.hashedWrites = rw.hashed;
    out.readKeys = rw.reads;
    return out;
}

// The election a transaction belongs to, taken from its arguments.
function electionOf(tx) {
    if (tx.function === 'MintVAT') return tx.args[1] || null;
    if (tx.function === 'CastBallot') {
        try { return JSON.parse(tx.args[4]).electionID || null; } catch { return null; }
    }
    if (['GetTally', 'GetAuditInvariant'].includes(tx.function)) return tx.args[0] || null;
    return null;
}

function decodeBlock(blockBytes) {
    const b = common.Block.deserializeBinary(blockBytes);
    const h = b.getHeader();
    const dataList = b.getData().getDataList_asU8();
    const md = b.getMetadata() ? b.getMetadata().getMetadataList_asU8() : [];
    const filter = md[2] ? Array.from(md[2]) : [];
    const transactions = dataList.map((d, i) => {
        let tx;
        try { tx = decodeEnvelope(d); } catch (e) { tx = { txID: null, typeName: 'UNREADABLE', error: e.message, endorsers: [], writes: [], hashedWrites: [], args: [] }; }
        const code = filter[i];
        return { index: i, ...tx, validationCode: code === undefined ? null : code, validationName: code === undefined ? 'NOT_FILLED' : codeName(code), electionID: electionOf(tx) };
    });
    return {
        number: Number(h.getNumber()),
        previousHash: hex(h.getPreviousHash_asU8()),
        dataHash: hex(h.getDataHash_asU8()),
        txCount: dataList.length,
        transactions,
        // kept for the integrity check
        _dataList: dataList,
        _header: { number: Number(h.getNumber()), previous: Buffer.from(h.getPreviousHash_asU8()), data: Buffer.from(h.getDataHash_asU8()) },
    };
}

// ── Hash checks ──────────────────────────────────────────────────────────────

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function derLen(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
function derInteger(n) {
    const bytes = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    if (bytes.length === 0) bytes.push(0);
    if (bytes[0] & 0x80) bytes.unshift(0); // keep it non-negative
    return tlv(0x02, Buffer.from(bytes));
}

// SHA-256 of DER SEQUENCE { INTEGER number, OCTET STRING previous_hash, OCTET STRING data_hash }
function headerHash(header) {
    const body = Buffer.concat([derInteger(header.number), tlv(0x04, header.previous), tlv(0x04, header.data)]);
    return sha256(tlv(0x30, body));
}

function dataHashMatches(block) {
    return sha256(Buffer.concat(block._dataList.map((d) => Buffer.from(d)))).equals(block._header.data);
}

module.exports = { decodeBlock, decodeEnvelope, electionOf, codeName, CODES, headerHash, dataHashMatches, keyText, sha256, hex };
