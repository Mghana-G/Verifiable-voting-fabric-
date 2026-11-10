'use strict';

/**
 * Multi-org fabric-gateway connection helper for the validation test suite.
 * client-app/lib/gateway.js is IEBC-only (the polling-station simulator);
 * these tests also need Media (test2) and, in principle, the other orgs,
 * so this is a small generalisation rather than a duplicate of that file.
 */

const { connect, signers } = require('@hyperledger/fabric-gateway');
const grpc = require('@grpc/grpc-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NETWORK_ROOT = path.join(__dirname, '..', '..', 'network');
const CHANNEL = 'votingchannel';
const CHAINCODE = 'voting';

const ORGS = {
    IEBC:         { domain: 'orgiebc.example.com',         msp: 'OrgIEBCMSP',         peerHost: 'peer0.orgiebc.example.com',         endpoint: 'localhost:7051' },
    Judiciary:    { domain: 'orgjudiciary.example.com',    msp: 'OrgJudiciaryMSP',    peerHost: 'peer0.orgjudiciary.example.com',    endpoint: 'localhost:7061' },
    CivilSociety: { domain: 'orgcivilsociety.example.com', msp: 'OrgCivilSocietyMSP', peerHost: 'peer0.orgcivilsociety.example.com', endpoint: 'localhost:7071' },
    Media:        { domain: 'orgmedia.example.com',        msp: 'OrgMediaMSP',        peerHost: 'peer0.orgmedia.example.com',        endpoint: 'localhost:7081' },
};

const ALL_MSPS = Object.values(ORGS).map((o) => o.msp);

function identityPaths(orgKey, user) {
    const org = ORGS[orgKey];
    const userName = `${user}@${org.domain}`;
    const mspBase = path.join(NETWORK_ROOT, 'organizations', 'peerOrganizations', org.domain, 'users', userName, 'msp');
    const keystoreDir = path.join(mspBase, 'keystore');
    const keyFile = fs.readdirSync(keystoreDir).find((f) => !f.startsWith('.'));
    return {
        certPath: path.join(mspBase, 'signcerts', `${userName}-cert.pem`),
        keyPath: path.join(keystoreDir, keyFile),
        tlsCaPath: path.join(NETWORK_ROOT, 'organizations', 'peerOrganizations', org.domain, 'peers', org.peerHost, 'tls', 'ca.crt'),
    };
}

async function connectAs(orgKey, user = 'User1') {
    const org = ORGS[orgKey];
    if (!org) throw new Error(`Unknown org: ${orgKey}`);
    const { certPath, keyPath, tlsCaPath } = identityPaths(orgKey, user);
    const certBytes = fs.readFileSync(certPath);
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    const tlsCert = fs.readFileSync(tlsCaPath);
    const grpcClient = new grpc.Client(org.endpoint, grpc.credentials.createSsl(tlsCert), {
        'grpc.ssl_target_name_override': org.peerHost,
        'grpc.max_receive_message_length': 10 * 1024 * 1024,
    });

    const gateway = connect({
        client: grpcClient,
        identity: { mspId: org.msp, credentials: certBytes },
        signer: signers.newPrivateKeySigner(privateKey),
        evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
        endorseOptions: () => ({ deadline: Date.now() + 30000 }),
        submitOptions: () => ({ deadline: Date.now() + 10000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 120000 }),
    });

    const network = gateway.getNetwork(CHANNEL);
    const contract = network.getContract(CHAINCODE);

    return {
        gateway,
        network,
        contract,
        grpcClient,
        privateKey,
        close: () => { gateway.close(); grpcClient.close(); },
    };
}

module.exports = { connectAs, ORGS, ALL_MSPS, CHANNEL, CHAINCODE };
