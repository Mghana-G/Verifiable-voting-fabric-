'use strict';

// Loads a fabric-gateway identity and gRPC channel for one organisation's
// User1. Shared by lib/gw.js (read-only auditor connections) and
// lib/station.js (the polling-station write path).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const { NETWORK, CHANNEL } = require('./fabric');

function material(org, user = 'User1') {
    const msp = path.join(NETWORK, 'organizations', 'peerOrganizations', org.domain, 'users', `${user}@${org.domain}`, 'msp');
    const keyDir = path.join(msp, 'keystore');
    const keyFile = fs.readdirSync(keyDir).find((f) => !f.startsWith('.'));
    return {
        cert: fs.readFileSync(path.join(msp, 'signcerts', `${user}@${org.domain}-cert.pem`)),
        key: fs.readFileSync(path.join(keyDir, keyFile), 'utf8'),
        tlsCa: fs.readFileSync(path.join(NETWORK, 'organizations', 'peerOrganizations', org.domain, 'peers', `peer0.${org.domain}`, 'tls', 'ca.crt')),
    };
}

function open(org, extraOptions = {}) {
    const m = material(org);
    const grpcClient = new grpc.Client(`localhost:${org.peerPort}`, grpc.credentials.createSsl(m.tlsCa), {
        'grpc.ssl_target_name_override': `peer0.${org.domain}`,
        'grpc.initial_reconnect_backoff_ms': 300,
        'grpc.max_reconnect_backoff_ms': 1500,
        'grpc.max_receive_message_length': 20 * 1024 * 1024,
    });
    const gateway = connect({
        client: grpcClient,
        identity: { mspId: org.msp, credentials: m.cert },
        signer: signers.newPrivateKeySigner(crypto.createPrivateKey(m.key)),
        ...extraOptions,
    });
    return { gateway, grpcClient, network: gateway.getNetwork(CHANNEL) };
}

module.exports = { material, open };
