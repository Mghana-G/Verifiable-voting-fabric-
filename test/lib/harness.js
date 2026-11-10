#!/usr/bin/env node
'use strict';
/**
 * End-to-end vote harness.
 *
 * Usage:
 *   node test/lib/harness.js [--count N] [--election ELECTION_ID]
 *
 * Default: 50 votes against election2027-harness so the totals do not
 * collide with the Phase 2 smoke-test vote on election2027.
 *
 * Exit 0 if every vote committed without error, exit 1 otherwise.
 */

const { connect, signers } = require('@hyperledger/fabric-gateway');
const grpc     = require('@grpc/grpc-js');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

// ── Config ───────────────────────────────────────────────────────────────────
const NETWORK_ROOT = path.join(__dirname, '..', '..', 'network');
const DB_PATH      = path.join(__dirname, '..', '..', 'voter-generator', 'registry.db');
const CHANNEL      = 'votingchannel';
const CHAINCODE    = 'voting';
const POLLING_STN  = 'PS-HARNESS-01';
const CANDIDATES   = ['C001', 'C002', 'C003', 'C004'];

const argv   = process.argv.slice(2);
const COUNT  = parseInt(argv[argv.indexOf('--count')   + 1] || '50',         10);
const ELECTION = argv[argv.indexOf('--election') + 1] || 'election2027-harness';

// ── Canonical JSON — copied verbatim from chaincode/voting/lib/crypto.js ─────
function canonicalise(obj) {
    const sorted = {};
    Object.keys(obj).sort().forEach(k => { sorted[k] = obj[k]; });
    return JSON.stringify(sorted);
}

// ── Identity helpers ─────────────────────────────────────────────────────────
function iebcPaths() {
    const mspBase = path.join(
        NETWORK_ROOT, 'organizations', 'peerOrganizations',
        'orgiebc.example.com', 'users', 'User1@orgiebc.example.com', 'msp'
    );
    const keystoreDir = path.join(mspBase, 'keystore');
    const keyFile = fs.readdirSync(keystoreDir).find(f => !f.startsWith('.'));
    return {
        certPath  : path.join(mspBase, 'signcerts', 'User1@orgiebc.example.com-cert.pem'),
        keyPath   : path.join(keystoreDir, keyFile),
        tlsCaPath : path.join(
            NETWORK_ROOT, 'organizations', 'peerOrganizations',
            'orgiebc.example.com', 'peers', 'peer0.orgiebc.example.com', 'tls', 'ca.crt'
        ),
    };
}

function buildGateway() {
    const { certPath, keyPath, tlsCaPath } = iebcPaths();
    const tlsCert    = fs.readFileSync(tlsCaPath);
    const grpcClient = new grpc.Client(
        'localhost:7051',
        grpc.credentials.createSsl(tlsCert),
        {
            'grpc.ssl_target_name_override'    : 'peer0.orgiebc.example.com',
            'grpc.max_receive_message_length'  : 10 * 1024 * 1024,
        }
    );
    const certBytes  = fs.readFileSync(certPath);
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));

    const gateway = connect({
        client  : grpcClient,
        identity: { mspId: 'OrgIEBCMSP', credentials: certBytes },
        signer  : signers.newPrivateKeySigner(privateKey),
        evaluateOptions     : () => ({ deadline: Date.now() + 10000 }),
        endorseOptions      : () => ({ deadline: Date.now() + 30000 }),
        submitOptions       : () => ({ deadline: Date.now() + 10000 }),
        commitStatusOptions : () => ({ deadline: Date.now() + 120000 }),
    });

    return { gateway, grpcClient };
}

// ── Vote flow for one voter ───────────────────────────────────────────────────
async function vote(contract, voter_id, salt, storedHash, candidateID) {
    // 1. Verify hash locally
    const computed = crypto.createHash('sha256').update(voter_id + salt).digest('hex');
    if (computed !== storedHash) throw new Error(`hash mismatch for ${voter_id}`);

    // 2. MintVAT
    // endorsingOrganizations bypasses service discovery because voterIssuedCollection
    // has memberOnlyWrite:true which restricts discovery to 2 orgs, conflicting with
    // the OutOf(3,...) chaincode endorsement policy.
    const mintStart = Date.now();
    const mintTransaction = await contract.newProposal('MintVAT', {
        arguments: [storedHash, ELECTION, POLLING_STN],
        endorsingOrganizations: ['OrgIEBCMSP', 'OrgJudiciaryMSP', 'OrgCivilSocietyMSP'],
    }).endorse();
    const mintSubmit = await mintTransaction.submit();
    await mintSubmit.getStatus();
    const vatID  = Buffer.from(mintSubmit.getResult()).toString('utf8').trim();
    const mintMs = Date.now() - mintStart;

    // 3. Build canonical payload
    const nonce     = crypto.randomBytes(16).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadStr = canonicalise({ candidateID, electionID: ELECTION, nonce, timestamp, vatID });

    // 4. Generate ephemeral P-256 key, sign, null private key
    let { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sign = crypto.createSign('SHA256');
    sign.update(payloadStr, 'utf8');
    const signatureB64  = sign.sign(privateKey, 'base64');
    const ephemeralPub  = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privateKey = null; // null immediately after signing

    // 5. CastBallot
    const castStart   = Date.now();
    const ballotBytes = await contract.submitTransaction(
        'CastBallot',
        vatID, candidateID,
        ephemeralPub,
        signatureB64,
        payloadStr,
        nonce
    );
    const castMs    = Date.now() - castStart;
    const ballotRes = JSON.parse(Buffer.from(ballotBytes).toString('utf8'));

    return { vatID, ballotID: ballotRes.ballotID, mintMs, castMs };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`\n=== e-voting harness: ${COUNT} votes → ${ELECTION} ===\n`);

    // Load voters from registry
    if (!fs.existsSync(DB_PATH)) {
        console.error(`registry.db not found at ${DB_PATH}`);
        console.error('Run: python3 voter-generator/generate.py --count 12000 --seed 169774');
        process.exit(1);
    }
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const voters = db.prepare('SELECT voter_id, salt, hash FROM voters LIMIT ?').all(COUNT);
    db.close();

    if (voters.length < COUNT) {
        console.error(`Only ${voters.length} voters in registry — expected ${COUNT}`);
        process.exit(1);
    }

    const { gateway, grpcClient } = buildGateway();
    const contract = gateway.getNetwork(CHANNEL).getContract(CHAINCODE);

    let passed = 0, failed = 0;
    let totalMintMs = 0, totalCastMs = 0;
    const errors = [];

    const startAll = Date.now();
    for (let i = 0; i < voters.length; i++) {
        const { voter_id, salt, hash } = voters[i];
        const candidateID = CANDIDATES[i % CANDIDATES.length];
        try {
            const res = await vote(contract, voter_id, salt, hash, candidateID);
            passed++;
            totalMintMs += res.mintMs;
            totalCastMs += res.castMs;
            if ((i + 1) % 10 === 0) {
                process.stdout.write(`  [${i+1}/${COUNT}] passed=${passed} failed=${failed}\r`);
            }
        } catch (err) {
            failed++;
            errors.push({ voter_id, error: err.message });
        }
    }
    const totalMs = Date.now() - startAll;

    console.log('');

    // Final invariant check
    let invariant;
    try {
        const inv = await contract.evaluateTransaction('GetAuditInvariant', ELECTION);
        invariant = JSON.parse(Buffer.from(inv).toString());
    } catch (err) {
        invariant = { burnedCount: '?', tallyTotal: '?', error: err.message };
    }

    gateway.close();
    grpcClient.close();

    console.log('─'.repeat(60));
    console.log(`Votes attempted : ${COUNT}`);
    console.log(`Passed          : ${passed}`);
    console.log(`Failed          : ${failed}`);
    console.log(`Total time      : ${totalMs} ms`);
    console.log(`Avg mint latency: ${passed ? Math.round(totalMintMs / passed) : 0} ms`);
    console.log(`Avg cast latency: ${passed ? Math.round(totalCastMs / passed) : 0} ms`);
    console.log('─'.repeat(60));
    console.log(`GetAuditInvariant (${ELECTION}):`, JSON.stringify(invariant));
    const invariantPass = invariant.burnedCount === invariant.tallyTotal && invariant.burnedCount === passed;
    console.log(`Invariant check : ${invariantPass ? 'PASS' : 'FAIL'}`);
    console.log('─'.repeat(60));

    if (errors.length > 0) {
        console.error('\nErrors:');
        errors.forEach(e => console.error(`  ${e.voter_id}: ${e.error}`));
    }

    process.exit(failed > 0 ? 1 : 0);
})();
