'use strict';

// Read-only fabric-gateway client for the live panels. Persistent gRPC
// connections make a poll cost a few milliseconds instead of spawning the
// `peer` CLI (which cannot finish inside the 5 s deadline when the host is
// busy). The only thing this module can do is `evaluate` one of a few
// whitelisted functions: it never calls submit or endorse, so it cannot
// write to the ledger.

const { parse, applicationPolicyText, envelopeText } = require('./proto');
const identity = require('./identity');
const { CHANNEL, CHAINCODE, ELECTION_RE } = require('./fabric');

const ALLOWED = {
    qscc: new Set(['GetChainInfo', 'GetBlockByNumber', 'GetTransactionByID', 'GetBlockByTxID']),
    [CHAINCODE]: new Set(['GetAuditInvariant', 'GetTally']),
    _lifecycle: new Set(['QueryChaincodeDefinition']),
};

const clients = new Map();

const open = (org) => identity.open(org);

function discard(orgKey) {
    const c = clients.get(orgKey);
    if (!c) return;
    clients.delete(orgKey);
    try { c.gateway.close(); c.grpcClient.close(); } catch { /* already closed */ }
}

// Evaluates one whitelisted function. Resolves { ok, bytes } or
// { ok: false, reason: 'timeout' | 'unreachable' | 'refused' | 'failed' }.
async function evaluate(org, chaincode, fn, args, timeoutMs) {
    // Arguments are strings (election IDs, channel) or Buffers (a protobuf message).
    if (!ALLOWED[chaincode] || !ALLOWED[chaincode].has(fn)) {
        return { ok: false, reason: 'refused', detail: `${chaincode}.${fn} is not a whitelisted query` };
    }
    if (chaincode === CHAINCODE && !ELECTION_RE.test(String(args[0] || ''))) {
        return { ok: false, reason: 'refused', detail: 'election ID must be 1 to 80 letters, digits, dots, dashes or underscores' };
    }
    try {
        let c = clients.get(org.key);
        if (!c) { c = open(org); clients.set(org.key, c); }
        const bytes = await c.network.getContract(chaincode).newProposal(fn, { arguments: args }).evaluate({ deadline: Date.now() + timeoutMs });
        return { ok: true, bytes: Buffer.from(bytes) };
    } catch (e) {
        // Drop the client on any transport failure so the next call builds a
        // fresh connection instead of waiting out gRPC reconnect back-off.
        discard(org.key);
        const text = `${e.message || ''} ${e.code || ''}`;
        if (/DEADLINE|timed? ?out/i.test(text) || e.code === 4) return { ok: false, reason: 'timeout' };
        if (/UNAVAILABLE|ECONNREFUSED|connect/i.test(text) || e.code === 14) return { ok: false, reason: 'unreachable' };
        return { ok: false, reason: 'failed', detail: String(e.message || e).split('\n')[0] };
    }
}

// qscc GetChainInfo -> { height, currentBlockHash } (a BlockchainInfo message).
async function chainInfo(org, timeoutMs) {
    const r = await evaluate(org, 'qscc', 'GetChainInfo', [CHANNEL], timeoutMs);
    if (!r.ok) return r;
    const f = parse(r.bytes);
    const h = f.find((x) => x.field === 1);
    const hash = f.find((x) => x.field === 2);
    return { ok: true, height: h ? h.value : 0, currentBlockHash: hash ? hash.value.toString('base64') : null };
}

async function queryVoting(org, fn, electionID, timeoutMs) {
    const r = await evaluate(org, CHAINCODE, fn, [electionID], timeoutMs);
    if (!r.ok) return r;
    try {
        return { ok: true, value: JSON.parse(r.bytes.toString('utf8')) };
    } catch {
        return { ok: false, reason: 'failed', detail: 'unreadable query reply' };
    }
}

const str = (f, n) => { const x = f.find((y) => y.field === n); return x ? x.value.toString('utf8') : null; };
const num = (f, n) => { const x = f.find((y) => y.field === n); return x ? x.value : 0; };
const bool = (f, n) => num(f, n) === 1;

// _lifecycle QueryChaincodeDefinition(name) -> the committed definition,
// decoded from QueryChaincodeDefinitionResult (protos/peer/lifecycle).
async function committedDefinition(org, name, timeoutMs) {
    const nameBytes = Buffer.from(name, 'utf8');
    const arg = Buffer.concat([Buffer.from([0x0a, nameBytes.length]), nameBytes]); // field 1: name
    const r = await evaluate(org, '_lifecycle', 'QueryChaincodeDefinition', [arg], timeoutMs);
    if (!r.ok) return r;
    try {
        const f = parse(r.bytes);
        const collections = [];
        const pkg = f.find((x) => x.field === 6);
        if (pkg) {
            for (const cfg of parse(pkg.value).filter((x) => x.field === 1)) {
                const stat = parse(cfg.value).find((x) => x.field === 1); // static_collection_config
                if (!stat) continue;
                const c = parse(stat.value);
                const member = c.find((x) => x.field === 2);
                const endorse = c.find((x) => x.field === 8);
                const memberEnv = member ? parse(member.value).find((x) => x.field === 1) : null;
                collections.push({
                    name: str(c, 1),
                    memberOrgs: memberEnv ? envelopeText(memberEnv.value) : null,
                    requiredPeerCount: num(c, 3),
                    maximumPeerCount: num(c, 4),
                    blockToLive: num(c, 5),
                    memberOnlyRead: bool(c, 6),
                    memberOnlyWrite: bool(c, 7),
                    endorsementPolicy: endorse ? applicationPolicyText(endorse.value.toString('base64')) : null,
                });
            }
        }
        const approvals = {};
        for (const a of f.filter((x) => x.field === 8)) {
            const e = parse(a.value);
            approvals[str(e, 1)] = bool(e, 2);
        }
        const vp = f.find((x) => x.field === 5);
        return {
            ok: true,
            definition: {
                name,
                sequence: num(f, 1),
                version: str(f, 2),
                endorsementPlugin: str(f, 3),
                validationPlugin: str(f, 4),
                endorsementPolicy: vp ? applicationPolicyText(vp.value.toString('base64')) : null,
                collections,
                approvals,
            },
        };
    } catch (e) {
        return { ok: false, reason: 'failed', detail: `could not decode the definition: ${e.message}` };
    }
}

// qscc reads for the ledger explorer and the public verifier. Evaluate only.
async function qscc(org, fn, args, timeoutMs = 8000) {
    return evaluate(org, 'qscc', fn, [CHANNEL, ...args.map(String)], timeoutMs);
}

// The network handle for one org, for block event streaming (read-only).
function networkFor(org) {
    let c = clients.get(org.key);
    if (!c) { c = open(org); clients.set(org.key, c); }
    return c.network;
}

// Reproduces HOW_IT_WORKS 5.2: MintVAT is evaluated (never submitted) so the
// peer's first statement, a private data read, shows the collection policy.
// The arguments are a fixed probe, nothing from the page reaches the ledger.
async function privacyProbe(org, timeoutMs = 8000) {
    try {
        let c = clients.get(org.key);
        if (!c) { c = open(org); clients.set(org.key, c); }
        const bytes = await c.network.getContract(CHAINCODE).newProposal('MintVAT', { arguments: ['secrecy-probe-hash', 'SECRECY-PROBE', 'PS-X'] }).evaluate({ deadline: Date.now() + timeoutMs });
        return { ok: true, result: Buffer.from(bytes).toString('utf8') };
    } catch (e) {
        const detail = (e.details || []).map((d) => d.message).filter(Boolean).join(' || ') || String(e.message || e);
        return { ok: false, message: detail };
    }
}

function closeAll() { [...clients.keys()].forEach(discard); }

module.exports = { chainInfo, queryVoting, committedDefinition, qscc, networkFor, privacyProbe, closeAll };
