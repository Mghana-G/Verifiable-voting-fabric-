#!/usr/bin/env node
'use strict';

// Phase 2 smoke test — exit gate item 3:
//   1. MintVAT
//   2. CastBallot (real ECDSA P-256 ephemeral key)
//   3. GetAuditInvariant → must equal {burnedCount:1, tallyTotal:1}

const { execFileSync } = require('child_process');
const crypto           = require('crypto');
const path             = require('path');

const NETWORK_DIR    = path.join(__dirname, '..', 'network');
const ELECTION       = 'election2027';
const CANDIDATE      = 'C001';
const POLLING_STN    = 'PS-SMOKE-01';
const VOTER_HASH     = 'smoke-voter-' + crypto.randomBytes(8).toString('hex');

const ORDERER_TLS    = `${NETWORK_DIR}/organizations/ordererOrganizations/orgorderer.example.com/tlsca/tlsca.orgorderer.example.com-cert.pem`;
const IEBC_TLS       = `${NETWORK_DIR}/organizations/peerOrganizations/orgiebc.example.com/peers/peer0.orgiebc.example.com/tls/ca.crt`;
const JUDICIARY_TLS  = `${NETWORK_DIR}/organizations/peerOrganizations/orgjudiciary.example.com/peers/peer0.orgjudiciary.example.com/tls/ca.crt`;
const CIVIL_TLS      = `${NETWORK_DIR}/organizations/peerOrganizations/orgcivilsociety.example.com/peers/peer0.orgcivilsociety.example.com/tls/ca.crt`;
const MEDIA_TLS      = `${NETWORK_DIR}/organizations/peerOrganizations/orgmedia.example.com/peers/peer0.orgmedia.example.com/tls/ca.crt`;

// For invoke: use the voting-admin cert (which carries role=admin)
const ADMIN_MSP      = `${NETWORK_DIR}/organizations/votingadmin/votingadmin/msp`;
// For query: any IEBC identity suffices
const IEBC_QUERY_MSP = `${NETWORK_DIR}/organizations/peerOrganizations/orgiebc.example.com/users/Admin@orgiebc.example.com/msp`;

const FABRIC_BIN     = `${process.env.HOME}/fabric-samples/bin`;
const PEER_BIN       = `${FABRIC_BIN}/peer`;
const FABRIC_CFG     = `${process.env.HOME}/fabric-samples/config/`;

function baseEnv(msp) {
    return {
        ...process.env,
        PATH: `${FABRIC_BIN}:${process.env.PATH}`,
        FABRIC_CFG_PATH: FABRIC_CFG,
        CORE_PEER_TLS_ENABLED: 'true',
        CORE_PEER_LOCALMSPID: 'OrgIEBCMSP',
        CORE_PEER_ADDRESS: 'localhost:7051',
        CORE_PEER_TLS_ROOTCERT_FILE: IEBC_TLS,
        CORE_PEER_MSPCONFIGPATH: msp,
    };
}

// Invoke chaincode — uses spawnSync so both stdout and stderr are captured
// (the peer CLI writes all log/payload lines to stderr).
function peerInvoke(fnName, args, msp = ADMIN_MSP) {
    const { spawnSync } = require('child_process');
    const ccArgs = JSON.stringify({ function: fnName, Args: args });
    const argv = [
        'chaincode', 'invoke',
        '-o', 'localhost:7050',
        '--ordererTLSHostnameOverride', 'orderer1.orgorderer.example.com',
        '--tls', '--cafile', ORDERER_TLS,
        '-C', 'votingchannel', '-n', 'voting',
        '--peerAddresses', 'localhost:7051', '--tlsRootCertFiles', IEBC_TLS,
        '--peerAddresses', 'localhost:7061', '--tlsRootCertFiles', JUDICIARY_TLS,
        '--peerAddresses', 'localhost:7071', '--tlsRootCertFiles', CIVIL_TLS,
        '--peerAddresses', 'localhost:7081', '--tlsRootCertFiles', MEDIA_TLS,
        '--waitForEvent',
        '-c', ccArgs,
    ];
    const result = spawnSync(PEER_BIN, argv, {
        env: baseEnv(msp),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
        const err = new Error('peer invoke failed');
        err.stderr = result.stderr;
        throw err;
    }
    // Peer writes all output (including payload) to stderr.
    return (result.stdout || Buffer.alloc(0)).toString() +
           (result.stderr || Buffer.alloc(0)).toString();
}

// Query chaincode.
function peerQuery(fnName, args, msp = IEBC_QUERY_MSP) {
    const ccArgs = JSON.stringify({ function: fnName, Args: args });
    const argv = [
        'chaincode', 'query',
        '-C', 'votingchannel', '-n', 'voting',
        '-c', ccArgs,
    ];
    return execFileSync(PEER_BIN, argv, {
        env: baseEnv(msp),
        stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
}

// Canonical JSON — must match lib/crypto.js verbatim.
function canonicalise(obj) {
    const sorted = {};
    Object.keys(obj).sort().forEach(k => { sorted[k] = obj[k]; });
    return JSON.stringify(sorted);
}

// ── main ───────────────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
function ok(label)  { console.log(`  PASS  ${label}`); PASS++; }
function nok(label, e) {
    const msg = (e && e.stderr) ? e.stderr.toString().trim().slice(0, 400) : String(e);
    console.error(`  FAIL  ${label}\n        ${msg}`); FAIL++;
}

(async () => {
    console.log('\n=== smoke-phase2: Phase 2 exit gate smoke test ===\n');

    // ── Step 1: MintVAT ──────────────────────────────────────────────────────
    let vatID;
    try {
        console.log(`--- Step 1: MintVAT(${VOTER_HASH}, ${ELECTION}, ${POLLING_STN}) ---`);
        const out = peerInvoke('MintVAT', [VOTER_HASH, ELECTION, POLLING_STN]);
        console.log(out);
        // The vatID equals the txID in the invoking transaction.
        // Extract it from the "payload" field in the peer's log output.
        const m = out.match(/payload:"([^"]+)"/);
        vatID = m ? m[1] : null;
        if (!vatID) {
            // Some peer output formats wrap differently; fall back to txid.
            const m2 = out.match(/txID[:\s]+([a-f0-9]{60,64})/i);
            vatID = m2 ? m2[1] : null;
        }
        if (!vatID) throw new Error('Could not parse vatID from invoke output:\n' + out);
        console.log(`  vatID = ${vatID}`);
        ok('MintVAT succeeded');
    } catch (e) {
        nok('MintVAT', e);
        process.exit(1);
    }

    // ── Step 2: CastBallot ───────────────────────────────────────────────────
    try {
        console.log('\n--- Step 2: CastBallot ---');
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const nonce = `nonce-smoke-${Date.now()}`;
        const ts    = Math.floor(Date.now() / 1000);

        const payloadObj = {
            candidateID : CANDIDATE,
            electionID  : ELECTION,
            nonce,
            timestamp   : ts,
            vatID,
        };
        const payload = canonicalise(payloadObj);

        const sign = crypto.createSign('SHA256');
        sign.update(payload, 'utf8');
        const signatureB64 = sign.sign(privateKey, 'base64');
        const pubKeyPem    = publicKey.export({ type: 'spki', format: 'pem' }).toString();

        console.log(`  vatID      = ${vatID}`);
        console.log(`  candidateID= ${CANDIDATE}`);
        console.log(`  nonce      = ${nonce}`);
        console.log(`  payload    = ${payload}`);

        const out = peerInvoke('CastBallot',
            [vatID, CANDIDATE, pubKeyPem, signatureB64, payload, nonce],
            IEBC_QUERY_MSP  // any enrolled org identity works for CastBallot
        );
        console.log(out);
        ok('CastBallot succeeded');
    } catch (e) {
        nok('CastBallot', e);
        process.exit(1);
    }

    // ── Step 3: GetAuditInvariant ────────────────────────────────────────────
    try {
        console.log('\n--- Step 3: GetAuditInvariant ---');
        const out = peerQuery('GetAuditInvariant', [ELECTION]);
        console.log(out);
        const inv = JSON.parse(out);
        if (inv.burnedCount >= 1 && inv.tallyTotal >= 1 && inv.burnedCount === inv.tallyTotal) {
            ok(`GetAuditInvariant: burnedCount=${inv.burnedCount} tallyTotal=${inv.tallyTotal} (invariant holds)`);
        } else {
            nok('GetAuditInvariant invariant', `got ${out}`);
        }
    } catch (e) {
        nok('GetAuditInvariant', e);
    }

    console.log(`\n=== smoke-phase2: ${PASS} passed, ${FAIL} failed ===\n`);
    process.exit(FAIL > 0 ? 1 : 0);
})();
