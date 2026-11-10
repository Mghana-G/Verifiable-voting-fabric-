'use strict';

// Ledger reads for the explorer and the public verifier. Every read is a
// qscc evaluate through the auditor identity (CivilSociety User1), so the
// TRANSACTIONS_FILTER is filled in by the committing peer. Blocks are
// immutable once committed, so decoded blocks are cached (LRU, 500).
// Nothing here scans from block 0: every walk starts at the current height.

const gw = require('./gw');
const { ORGS } = require('./fabric');
const decode = require('./decode');
const { peer } = require('@hyperledger/fabric-protos');

const AUDITOR = ORGS.find((o) => o.key === 'CivilSociety');
const LRU_MAX = 500;
const cache = new Map();

function remember(n, block) {
    cache.delete(n);
    cache.set(n, block);
    if (cache.size > LRU_MAX) cache.delete(cache.keys().next().value);
}

async function height() {
    const r = await gw.chainInfo(AUDITOR, 4000);
    return r.ok ? { ok: true, height: Number(r.height) } : r;
}

async function block(n) {
    if (cache.has(n)) {
        const b = cache.get(n);
        remember(n, b);
        return { ok: true, block: b };
    }
    const r = await gw.qscc(AUDITOR, 'GetBlockByNumber', [n]);
    if (!r.ok) return r;
    try {
        const b = decode.decodeBlock(r.bytes);
        remember(n, b);
        return { ok: true, block: b };
    } catch (e) {
        return { ok: false, reason: 'failed', detail: `could not decode block ${n}: ${e.message}` };
    }
}

// Blocks sit in the cache with private fields for the hash checks; strip them for the API.
function publicBlock(b) {
    const { _dataList, _header, ...rest } = b;
    return rest;
}

function summary(b) {
    const x = publicBlock(b);
    return {
        number: x.number, previousHash: x.previousHash, dataHash: x.dataHash, txCount: x.txCount,
        time: x.transactions.map((t) => t.timestamp).filter(Boolean).sort().pop() || null,
        transactions: x.transactions,
    };
}

async function fetchMany(numbers) {
    const out = [];
    for (let i = 0; i < numbers.length; i += 8) {
        const part = await Promise.all(numbers.slice(i, i + 8).map(block));
        out.push(...part);
    }
    return out;
}

// One page of blocks, newest first. With `election`, walks backwards from the
// page start looking at no more than SCAN_CAP blocks and keeps those holding
// a transaction of that election.
const SCAN_CAP = 400;
async function page({ before, perPage = 20, election }) {
    const h = await height();
    if (!h.ok) return h;
    const top = before === undefined ? h.height - 1 : Math.min(before, h.height - 1);
    if (!election) {
        const numbers = [];
        for (let n = top; n >= 0 && numbers.length < perPage; n -= 1) numbers.push(n);
        const got = await fetchMany(numbers);
        const bad = got.find((g) => !g.ok);
        if (bad) return bad;
        return { ok: true, height: h.height, blocks: got.map((g) => summary(g.block)), next: numbers.length ? numbers[numbers.length - 1] - 1 : null };
    }
    const blocks = [];
    let n = top;
    let scanned = 0;
    while (n >= 0 && blocks.length < perPage && scanned < SCAN_CAP) {
        const batch = [];
        for (let k = 0; k < 8 && n - k >= 0; k += 1) batch.push(n - k);
        const got = await fetchMany(batch);
        const bad = got.find((g) => !g.ok);
        if (bad) return bad;
        for (const g of got) {
            if (g.block.transactions.some((t) => t.electionID === election) && blocks.length < perPage) blocks.push(summary(g.block));
        }
        n -= batch.length;
        scanned += batch.length;
    }
    return { ok: true, height: h.height, blocks, next: n >= 0 ? n : null, scanned, scanCapped: scanned >= SCAN_CAP };
}

// Transaction lookup by ID: validation code and envelope (GetTransactionByID),
// block number (GetBlockByTxID).
async function transaction(txID) {
    if (!/^[0-9a-f]{64}$/.test(txID)) return { ok: false, reason: 'invalid', detail: 'a transaction ID is 64 hexadecimal characters' };
    const t = await gw.qscc(AUDITOR, 'GetTransactionByID', [txID]);
    if (!t.ok) return /not found|no such transaction|NOT_FOUND/i.test(`${t.detail || ''}`) ? { ok: false, reason: 'not-found' } : t;
    let tx;
    let code;
    try {
        const pt = peer.ProcessedTransaction.deserializeBinary(t.bytes);
        code = pt.getValidationcode();
        tx = decode.decodeEnvelope(pt.getTransactionenvelope().serializeBinary());
    } catch (e) {
        return { ok: false, reason: 'failed', detail: `could not decode the transaction: ${e.message}` };
    }
    const b = await gw.qscc(AUDITOR, 'GetBlockByTxID', [txID]);
    let blockNumber = null;
    if (b.ok) {
        try {
            const dec = decode.decodeBlock(b.bytes);
            blockNumber = dec.number;
            remember(dec.number, dec);
        } catch { /* leave null */ }
    }
    return { ok: true, tx: { ...tx, validationCode: code, validationName: decode.codeName(code), blockNumber, electionID: decode.electionOf(tx) } };
}

// Chain integrity for the latest `count` blocks.
async function integrity(count = 50) {
    const h = await height();
    if (!h.ok) return h;
    const top = h.height - 1;
    const numbers = [];
    for (let n = top; n >= 0 && numbers.length < count + 1; n -= 1) numbers.push(n);
    numbers.reverse(); // ascending
    const got = await fetchMany(numbers);
    const bad = got.find((g) => !g.ok);
    if (bad) return bad;
    const blocks = got.map((g) => g.block);
    const rows = blocks.map((b, i) => {
        const next = blocks[i + 1];
        const hh = decode.headerHash(b._header);
        return {
            number: b.number,
            dataHashOK: decode.dataHashMatches(b),
            headerHash: hh.toString('hex'),
            linkToNextOK: next ? next._header.previous.equals(hh) : null,
        };
    });
    // The oldest block's own previous link points outside the range, so only
    // its data hash and its outgoing link are checked.
    const checked = rows.slice(0, rows.length - 1);
    const ok = rows.every((r) => r.dataHashOK) && checked.every((r) => r.linkToNextOK === true);
    return { ok: true, height: h.height, count: rows.length, rows, allValid: ok };
}

// Blocks per minute over the last `minutes`, newest block first walk capped at 300 blocks.
async function rate(minutes = 10) {
    const h = await height();
    if (!h.ok) return h;
    const cutoff = Date.now() - minutes * 60 * 1000;
    const buckets = new Array(minutes).fill(0);
    let n = h.height - 1;
    let walked = 0;
    let reachedCutoff = false;
    while (n >= 0 && walked < 300 && !reachedCutoff) {
        const batch = [];
        for (let k = 0; k < 10 && n - k >= 0; k += 1) batch.push(n - k);
        // eslint-disable-next-line no-await-in-loop
        const got = await fetchMany(batch);
        for (const g of got) {
            if (!g.ok) return g;
            const t = Date.parse(g.block.transactions.map((x) => x.timestamp).filter(Boolean).sort().pop() || '');
            if (Number.isNaN(t)) continue;
            if (t < cutoff) { reachedCutoff = true; continue; }
            const idx = minutes - 1 - Math.floor((Date.now() - t) / 60000);
            if (idx >= 0 && idx < minutes) buckets[idx] += 1;
        }
        n -= batch.length;
        walked += batch.length;
    }
    return { ok: true, minutes, buckets, capped: !reachedCutoff && walked >= 300 };
}

// Live tail: calls onBlock(summary) for each new block from `startBlock`.
async function tail(startBlock, onBlock) {
    const network = gw.networkFor(AUDITOR);
    const events = await network.getBlockEvents({ startBlock: BigInt(startBlock) });
    (async () => {
        try {
            for await (const ev of events) {
                try {
                    const b = decode.decodeBlock(ev.serializeBinary());
                    remember(b.number, b);
                    onBlock(summary(b));
                } catch { /* skip one unreadable block */ }
            }
        } catch { /* closed or network stopped */ }
    })();
    return { close: () => events.close() };
}

module.exports = { AUDITOR, height, block, page, transaction, integrity, rate, tail, summary, publicBlock };
