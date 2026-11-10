'use strict';

/**
 * peer CLI helpers for reading channel height and block-level validation
 * codes. Per docs/PHASE4_DECISIONS.md E.3:
 *   - `peer channel getinfo` takes lowercase -c and prefixes its output with
 *     "Blockchain info: "
 *   - a block MUST be fetched from a peer (no -o) to get a populated
 *     TRANSACTIONS_FILTER; the orderer's copy has an empty filter because
 *     validation codes are written by the committing peer, not the orderer
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NETWORK_DIR = path.join(__dirname, '..', '..', 'network');
const FABRIC_BIN = path.join(os.homedir(), 'fabric-samples', 'bin');
const FABRIC_CFG_PATH = path.join(os.homedir(), 'fabric-samples', 'config') + '/';

const PEER_ORG_INFO = {
    IEBC:         { msp: 'OrgIEBCMSP',         address: 'localhost:7051', domain: 'orgiebc.example.com',         peerHost: 'peer0.orgiebc.example.com' },
    Judiciary:    { msp: 'OrgJudiciaryMSP',    address: 'localhost:7061', domain: 'orgjudiciary.example.com',    peerHost: 'peer0.orgjudiciary.example.com' },
    CivilSociety: { msp: 'OrgCivilSocietyMSP', address: 'localhost:7071', domain: 'orgcivilsociety.example.com', peerHost: 'peer0.orgcivilsociety.example.com' },
    Media:        { msp: 'OrgMediaMSP',        address: 'localhost:7081', domain: 'orgmedia.example.com',        peerHost: 'peer0.orgmedia.example.com' },
};

const VALIDATION_CODE_NAMES = {
    0: 'VALID',
    1: 'NIL_ENVELOPE',
    2: 'BAD_PAYLOAD',
    3: 'BAD_COMMON_HEADER',
    4: 'BAD_CREATOR_SIGNATURE',
    5: 'INVALID_ENDORSER_TRANSACTION',
    8: 'BAD_PROPOSAL_TXID',
    9: 'DUPLICATE_TXID',
    10: 'ENDORSEMENT_POLICY_FAILURE',
    11: 'MVCC_READ_CONFLICT',
    22: 'BAD_RWSET',
    255: 'INVALID_OTHER_REASON',
};

function peerEnv(org = 'IEBC') {
    const o = PEER_ORG_INFO[org];
    return {
        ...process.env,
        PATH: `${process.env.PATH}:${FABRIC_BIN}`,
        FABRIC_CFG_PATH,
        CORE_PEER_TLS_ENABLED: 'true',
        CORE_PEER_LOCALMSPID: o.msp,
        CORE_PEER_ADDRESS: o.address,
        CORE_PEER_MSPCONFIGPATH: path.join(NETWORK_DIR, 'organizations', 'peerOrganizations', o.domain, 'users', `Admin@${o.domain}`, 'msp'),
        CORE_PEER_TLS_ROOTCERT_FILE: path.join(NETWORK_DIR, 'organizations', 'peerOrganizations', o.domain, 'peers', o.peerHost, 'tls', 'ca.crt'),
    };
}

function ordererCaPath() {
    return path.join(NETWORK_DIR, 'organizations', 'ordererOrganizations', 'orgorderer.example.com', 'tlsca', 'tlsca.orgorderer.example.com-cert.pem');
}

function getChannelHeight(org = 'IEBC') {
    const out = execSync('peer channel getinfo -c votingchannel', { env: peerEnv(org), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const line = out.split('\n').find((l) => l.includes('Blockchain info:'));
    if (!line) throw new Error(`could not find "Blockchain info:" in getinfo output: ${out}`);
    const json = line.replace(/^.*Blockchain info:\s*/, '').trim();
    return JSON.parse(json).height;
}

// Fetch a block FROM A PEER (never pass an orderer address here) so the
// TRANSACTIONS_FILTER metadata is populated.
function fetchBlockFromPeer(blockNum, org, outFile) {
    execSync(`peer channel fetch ${blockNum} ${outFile} -c votingchannel`, {
        env: peerEnv(org),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return outFile;
}

function decodeBlock(pbFile, org = 'IEBC') {
    // configtxlator's default --output is /dev/stdout, which is unreliable
    // through Node's execSync pipe in this environment ("no such device or
    // address"); write to an explicit file instead.
    const jsonFile = `${pbFile}.json`;
    execSync(`configtxlator proto_decode --input "${pbFile}" --type common.Block --output "${jsonFile}"`, {
        env: peerEnv(org),
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
    });
    const json = fs.readFileSync(jsonFile, 'utf8');
    const block = JSON.parse(json);
    const filterB64 = (block.metadata && block.metadata.metadata && block.metadata.metadata[2]) || '';
    const codes = filterB64 ? Array.from(Buffer.from(filterB64, 'base64')) : [];
    const labels = codes.map((c) => VALIDATION_CODE_NAMES[c] || `CODE_${c}`);
    const numTx = (block.data && block.data.data) ? block.data.data.length : 0;
    return { block, codes, labels, numTx };
}

function getBlockValidationCodes(blockNum, org, scratchDir) {
    const outFile = path.join(scratchDir, `block-${blockNum}.pb`);
    fetchBlockFromPeer(blockNum, org, outFile);
    return decodeBlock(outFile, org);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Used after `peer node rebuild-dbs` + restart (test2 recovery): polls until
// the peer's channel height catches up, i.e. it has finished replaying the
// block store into a fresh CouchDB.
// Default timeout is generous because rebuild-dbs replay time scales with
// chain length (~66ms/block observed on this network at ~3,000 blocks, i.e.
// ~3-4 minutes just to replay — before the peer's gRPC endpoint even starts
// accepting connections reliably). A short timeout here that was fine early
// in a session becomes wrong once the chain has grown from later test runs.
// Raised twice: 90s -> 900s (chain ~3,000 blocks) -> 2400s, and now to 3600s
// after observing a live replay of the ~25,000-block post-test7-sweep chain
// actually take ~45 minutes (measured: block 8000/25487 reached after ~14
// min in this session). The chain only grows across a session, so this
// stays generous rather than being re-tuned to whatever height is current.
async function waitForHeight(org, targetHeight, timeoutMs = 3600000, intervalMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    let lastHeight = null;
    while (Date.now() < deadline) {
        try {
            lastHeight = getChannelHeight(org);
            if (lastHeight >= targetHeight) return lastHeight;
        } catch (err) {
            lastErr = err;
        }
        await sleep(intervalMs);
    }
    throw new Error(`peer ${org} did not reach height ${targetHeight} within ${timeoutMs}ms (last seen: ${lastHeight}, lastErr: ${lastErr ? lastErr.message : 'none'})`);
}

module.exports = {
    PEER_ORG_INFO,
    VALIDATION_CODE_NAMES,
    peerEnv,
    ordererCaPath,
    getChannelHeight,
    fetchBlockFromPeer,
    decodeBlock,
    getBlockValidationCodes,
    waitForHeight,
    NETWORK_DIR,
    FABRIC_BIN,
};
