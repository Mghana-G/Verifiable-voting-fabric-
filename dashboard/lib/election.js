'use strict';

// The mock election configuration (data/election.json) and the small amount
// of dashboard-side state (out/election-state.json): per election an integer
// batch offset, a count of votes cast through the dashboard and the voting
// lock. No voter ID, voter hash, vatID or ballotID is ever stored here.

const fs = require('fs');
const path = require('path');
const { REPO, DASH, readJSON, isMissing } = require('./util');

const CONFIG = path.join(DASH, 'data', 'election.json');
const STATE = path.join(DASH, 'out', 'election-state.json');
const CANDIDATES = path.join(REPO, 'voter-generator', 'candidates.json');

function writeAtomic(abs, text) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, abs);
}

function config() {
    const c = readJSON(CONFIG);
    if (isMissing(c)) throw new Error(`data/election.json: ${c.why}`);
    return c;
}

function state() {
    const s = readJSON(STATE);
    return isMissing(s) ? { elections: {} } : s;
}

function entry(s, id) {
    if (!s.elections[id]) s.elections[id] = { batchOffset: 0, sampleOffset: 0, dashboardVotes: 0, locked: false, startedAt: new Date().toISOString() };
    return s.elections[id];
}

// The ballot is every candidate in voter-generator/candidates.json, so adding
// one there is the only change needed. An optional "candidates" array in
// election.json narrows the ballot to a subset (the rest show as on chain only).
function candidates() {
    const all = readJSON(CANDIDATES);
    if (isMissing(all)) throw new Error(`voter-generator/candidates.json: ${all.why}`);
    const configured = config().candidates;
    const ids = Array.isArray(configured) ? configured : all.map((c) => c.candidateID);
    return {
        onBallot: ids.map((id) => all.find((c) => c.candidateID === id)).filter(Boolean),
        onChainOnly: all.filter((c) => !ids.includes(c.candidateID)),
    };
}

function current() {
    const c = config();
    const s = state();
    const e = entry(s, c.electionID);
    return { ...c, locked: e.locked, dashboardVotes: e.dashboardVotes, batchOffset: e.batchOffset, startedAt: e.startedAt };
}

function update(electionID, fn) {
    const s = state();
    fn(entry(s, electionID));
    writeAtomic(STATE, `${JSON.stringify(s, null, 2)}\n`);
}

function setLocked(locked) { update(config().electionID, (e) => { e.locked = !!locked; }); }
function addVotes(n) { update(config().electionID, (e) => { e.dashboardVotes += n; }); }
// Hands out the next `n` sample positions (one integer per election, no voter data).
function takeSampleOffset(n) {
    let at = 0;
    update(config().electionID, (e) => { at = e.sampleOffset || 0; e.sampleOffset = at + n; });
    return at;
}
function setBatchOffset(n) { update(config().electionID, (e) => { e.batchOffset = n; }); }

// Writes a new electionID (...-MOCK-02, -03 ...) into election.json.
function startFresh() {
    const c = config();
    const m = /^(.*-MOCK-)(\d+)$/.exec(c.electionID);
    const next = m ? `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, '0')}` : `${c.electionID}-02`;
    const s = state();
    const prev = entry(s, c.electionID);
    prev.endedAt = new Date().toISOString();
    entry(s, next);
    writeAtomic(STATE, `${JSON.stringify(s, null, 2)}\n`);
    writeAtomic(CONFIG, `${JSON.stringify({ ...c, electionID: next }, null, 2)}\n`);
    return next;
}

function history() {
    const s = state();
    const cur = config().electionID;
    return Object.entries(s.elections).map(([id, e]) => ({ electionID: id, current: id === cur, ...e }))
        .sort((a, b) => a.electionID.localeCompare(b.electionID));
}

module.exports = { config, current, candidates, setLocked, addVotes, setBatchOffset, takeSampleOffset, startFresh, history, state };
