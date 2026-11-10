'use strict';

// Panel 4 (Chaincode, live). Queries only: `peer lifecycle chaincode
// querycommitted` for the committed definition, and the whitelisted
// GetAuditInvariant / GetTally evaluations for a chosen election ID.
// Nothing here can MintVAT, CastBallot or CreateCandidate.

const { readJSON, isMissing, listDirs, repoPath } = require('../lib/util');
const F = require('../lib/fabric');
const gw = require('../lib/gw');

const unavailable = (why, detail) => ({ __unavailable: true, why, detail });

async function readDefinition() {
    const r = await gw.committedDefinition(F.ORGS[0], F.CHAINCODE, 15000);
    if (!r.ok) throw new Error(r.reason);
    return r.definition;
}
const definitionCache = F.swr(60 * 1000, readDefinition);

// Election IDs seen in the evidence files, offered as suggestions.
function knownElections() {
    const out = [];
    const add = (rel, label) => {
        const r = readJSON(repoPath(rel, 'result.json'));
        if (!isMissing(r) && typeof r.electionID === 'string') out.push({ id: r.electionID, label });
    };
    for (const t of ['test1a', 'test1b', 'test2', 'test3', 'test4a', 'test4b', 'test5', 'test6']) {
        const dirs = listDirs(repoPath('evidence', t)).filter((d) => /^\d{4}-/.test(d));
        if (dirs.length) add(`evidence/${t}/${dirs[dirs.length - 1]}`, t);
    }
    for (const s of [100, 500, 1000, 5000, 10000]) {
        const dirs = listDirs(repoPath('evidence/test7', `scale-${s}`)).filter((d) => /^\d{4}-/.test(d));
        if (dirs.length) add(`evidence/test7/scale-${s}/${dirs[dirs.length - 1]}`, `test7 scale ${s}`);
    }
    return out;
}

// Starts the two read-only evaluations for one election ID.
async function audit(electionID, timeoutMs) {
    const [inv, tally] = await Promise.all([
        gw.queryVoting(F.ORGS[0], 'GetAuditInvariant', electionID, timeoutMs),
        gw.queryVoting(F.ORGS[0], 'GetTally', electionID, timeoutMs),
    ]);
    const shape = (q) => {
        if (q.ok) return q.value;
        if (q.reason === 'refused') return unavailable(q.detail);
        return unavailable(q.reason === 'timeout' ? 'no answer within 5 s' : 'query not answered', q.detail);
    };
    const invariant = shape(inv);
    return {
        electionID,
        invariant,
        tally: shape(tally),
        equal: !invariant.__unavailable ? invariant.burnedCount === invariant.tallyTotal : null,
        queriedAt: new Date().toISOString(),
    };
}

// Builds the panel 4 object once the network result and any audit are known.
function describe(net, auditResult) {
    const answering = net && Array.isArray(net.peers) && net.peers.some((p) => typeof p.height === 'number');
    const result = {
        elections: knownElections(),
        containers: net && net.chaincodeContainers ? net.chaincodeContainers : [],
    };
    if (!answering) {
        result.definition = unavailable('no peer is answering, so the committed definition cannot be read');
    } else {
        const d = definitionCache.get();
        result.definition = d.pending ? { pending: true, note: 'reading the committed definition from the peer' } : { ...d.value, readAt: d.at };
    }
    if (auditResult) result.audit = auditResult;
    return result;
}

module.exports = { audit, describe };
