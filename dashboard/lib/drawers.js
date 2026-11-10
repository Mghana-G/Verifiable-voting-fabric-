'use strict';

// "What happened on the network" drawers. The explanation is a paragraph taken
// from docs/HOW_IT_WORKS.md; the source lines are read from disk at request
// time by locating the function by name, so line numbers are never hard-coded
// and the text on screen cannot drift from the code on screen.

const fs = require('fs');
const path = require('path');
const { REPO } = require('./util');

const VOTING = 'chaincode/voting/lib/votingContract.js';
const CLIENT = 'client-app/lib';

const DRAWERS = {
    verify: {
        title: 'Verified (off-chain registry check)',
        text: 'Signing in recomputes SHA-256(voter_id + salt) from the registry and compares it with the stored hash (HOW_IT_WORKS 3.1). The voter ID and salt stay on the polling-station machine; only the hash can go to the chain.',
        sources: [{ file: `${CLIENT}/registry.js`, fn: 'verifyVoter' }],
        keys: [],
    },
    mint: {
        title: 'Ballot token issued (MintVAT)',
        text: 'The client asks IEBC, Judiciary and Civil Society to endorse MintVAT (DEV-003: the private collection stops discovery picking enough organisations on its own). The chaincode reads VOTERISSUED from the private collection, refuses a repeat, and writes the token (VAT) publicly and the voter-hash record privately. The vatID is the transaction ID, so every peer derives the same value.',
        sources: [{ file: `${CLIENT}/vat.js`, fn: 'mintVAT' }, { file: VOTING, fn: 'MintVAT' }],
        keys: [
            ['Read', 'VOTERISSUED~electionID~voterHash', 'private data, voterIssuedCollection', 'existing vatID, if any'],
            ['Write', 'VAT~vatID', 'public world state', '{electionID, pollingStationID, issuedAt, status:\'ACTIVE\'}'],
            ['Write', 'VOTERISSUED~electionID~voterHash', 'private data, voterIssuedCollection', 'the vatID string'],
        ],
    },
    ballot: {
        title: 'Ballot',
        text: 'The ballot lists the candidates configured for this mock election. Every candidate in voter-generator/candidates.json appears on the ballot unless election.json narrows it with a "candidates" list. There is no chaincode function that reads a candidate, so names come from that file and each candidate must also have been loaded on chain with step 06.',
        sources: [],
        keys: [],
    },
    seal: {
        title: 'Seal and sign',
        text: 'The client builds a canonical payload (keys sorted, no whitespace), creates a one-time P-256 key pair, signs the payload and drops the private key. The chaincode later verifies the signature with the public key it is given. The signature proves integrity, not identity.',
        sources: [{ file: `${CLIENT}/ballot.js`, fn: 'buildPayload' }, { file: `${CLIENT}/ephemeral.js`, fn: 'canonicalise' }, { file: `${CLIENT}/ephemeral.js`, fn: 'signBallot' }],
        keys: [],
    },
    submit: {
        title: 'Submitting (CastBallot)',
        text: 'The gateway sends the proposal to endorsing peers, which simulate CastBallot and sign the read-write set (3 of 4 needed). The transaction goes to the Raft ordering service, which cuts a block within 500 ms or 10 transactions. Every peer then validates the endorsement policy and the key versions (MVCC) and commits. The chaincode checks run in a fixed order: signature, payload match, nonce, token status, candidate.',
        sources: [{ file: VOTING, fn: 'CastBallot' }, { file: 'chaincode/voting/lib/crypto.js', fn: 'verifySignature' }],
        keys: [
            ['Read/Write', 'NONCE~electionID~nonce', 'public', "'used'"],
            ['Read/Write', 'VAT~vatID', 'public', 'status ACTIVE becomes BURNED'],
            ['Read', 'CANDIDATE~candidateID', 'public', 'existence only'],
            ['Write', 'BALLOT~ballotID', 'public', '{candidateID, electionID, timestamp}'],
            ['Read/Write', 'TALLY~electionID~candidateID', 'public', 'integer, +1'],
            ['Read/Write', 'BURNEDCOUNT~electionID', 'public', 'integer, +1'],
        ],
    },
    receipt: {
        title: 'Receipt',
        text: 'The ballotID is the transaction ID. Anyone can look it up on the public portal, which reads the committed block and shows the BALLOT record and its validation code. The receipt lets a voter prove their choice to someone else, so this system is not receipt-free (HOW_IT_WORKS 6).',
        sources: [],
        keys: [],
    },
    tx: {
        title: 'This transaction',
        text: 'Each row is one transaction inside a committed block. The validation code is written by the committing peer into the block\'s TRANSACTIONS_FILTER. Invalid transactions stay in the block but their writes are discarded.',
        sources: [],
        keys: [],
    },
    // Runbook cards
    prereqs: { title: '00 Prerequisites', text: 'Checks tool versions against the expected set. It changes nothing.', sources: [{ file: 'network/scripts/00-prereqs.sh', fn: 'check' }], keys: [] },
    crypto: { title: '01 Crypto material', text: 'cryptogen writes all certificates and keys; the CA key pairs are copied for fabric-ca. Old output is wiped first by a busybox container because containers can leave root-owned files.', sources: [{ file: 'network/scripts/01-generate-crypto.sh', fn: null }], keys: [] },
    genesis: { title: '02 Genesis block', text: 'configtxgen writes the channel genesis block: three etcdraft consenters, BatchTimeout 500 ms, application policies. There is no system channel; orderers start with bootstrap method none.', sources: [{ file: 'network/scripts/02-generate-artifacts.sh', fn: null }], keys: [] },
    up: { title: '03 Compose up', text: 'docker compose up -d starts 17 containers, then the script waits on the peer and orderer ports. A peer starts only after its CouchDB reports healthy.', sources: [{ file: 'network/scripts/03-network-up.sh', fn: null }], keys: [] },
    channel: { title: '04 Create channel', text: 'osnadmin joins each orderer to votingchannel over mutual TLS, a pause lets Raft elect a leader, then each of the four peers joins with the genesis block.', sources: [{ file: 'network/scripts/04-create-channel.sh', fn: null }], keys: [] },
    health: { title: 'Health check', text: 'Reads CouchDB _up, peer channel height and the orderer channel list: 11 checks.', sources: [{ file: 'network/scripts/health-check.sh', fn: null }], keys: [] },
    deploy: { title: '05 Deploy chaincode', text: 'Runs the chaincode unit tests (a failure aborts), packages, installs on four peers, approves for four organisations with the OutOf(3, ...) policy and the collection config, then commits sequence N+1.', sources: [{ file: 'network/scripts/05-deploy-chaincode.sh', fn: null }], keys: [] },
    candidates: { title: '06 Load candidates', text: 'Enrols a votingadmin identity carrying role=admin at the IEBC CA, then calls CreateCandidate for each candidate. Only CreateCandidate needs the admin attribute.', sources: [{ file: VOTING, fn: 'CreateCandidate' }, { file: 'network/scripts/06-init-candidates.sh', fn: null }], keys: [] },
    start: { title: 'Start nodes', text: 'docker compose start restarts stopped containers. Ledgers live in named volumes, so nothing is lost.', sources: [], keys: [] },
    stop: { title: 'Stop nodes', text: 'docker compose stop halts the containers and keeps every volume.', sources: [], keys: [] },
    teardown: { title: '99 Teardown', text: 'docker compose down --volumes removes containers and ledger volumes, then chaincode images and generated directories.', sources: [{ file: 'network/scripts/99-network-down.sh', fn: null }], keys: [] },
};

function locate(lines, fn) {
    const re = new RegExp(`^\\s*(?:async\\s+)?(?:function\\s+)?${fn}\\s*\\(|^\\s*(?:const|let)\\s+${fn}\\s*=|^\\s*${fn}\\(\\)\\s*\\{|^\\s*${fn}\\s*\\(\\)`);
    const startIdx = lines.findIndex((l) => re.test(l));
    if (startIdx < 0) return null;
    let depth = 0;
    let seen = false;
    for (let i = startIdx; i < lines.length; i += 1) {
        for (const ch of lines[i].replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')) {
            if (ch === '{') { depth += 1; seen = true; } else if (ch === '}') depth -= 1;
        }
        if (seen && depth <= 0) return [startIdx, i];
    }
    return [startIdx, Math.min(lines.length - 1, startIdx + 40)];
}

function source({ file, fn }) {
    const abs = path.join(REPO, file);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { return { file, fn, error: 'file not found' }; }
    const lines = text.split('\n');
    if (!fn) {
        const end = Math.min(lines.length, 60);
        return { file, fn: null, from: 1, to: end, total: lines.length, lines: lines.slice(0, end), note: 'First lines of the script; open the file for the rest.' };
    }
    const range = locate(lines, fn);
    if (!range) return { file, fn, error: `function ${fn} not found` };
    const to = Math.min(range[1], range[0] + 90);
    return { file, fn, from: range[0] + 1, to: to + 1, lines: lines.slice(range[0], to + 1), truncated: range[1] > to };
}

function get(id) {
    const d = DRAWERS[id];
    if (!d) return null;
    return { id, title: d.title, text: d.text, keys: d.keys, sources: d.sources.map(source) };
}

module.exports = { get, DRAWERS };
