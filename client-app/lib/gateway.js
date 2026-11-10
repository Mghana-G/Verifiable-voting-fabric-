'use strict';

const { connect, signers } = require('@hyperledger/fabric-gateway');
const grpc    = require('@grpc/grpc-js');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const NETWORK_ROOT = path.join(__dirname, '..', '..', 'network');

const IEBC_PEER_ENDPOINT  = 'localhost:7051';
const IEBC_PEER_HOSTNAME  = 'peer0.orgiebc.example.com';
const IEBC_MSP_ID         = 'OrgIEBCMSP';

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

function buildGrpcClient(endpoint, hostname, tlsCaPath) {
    const tlsCert = fs.readFileSync(tlsCaPath);
    const creds   = grpc.credentials.createSsl(tlsCert);
    return new grpc.Client(endpoint, creds, {
        'grpc.ssl_target_name_override': hostname,
        'grpc.max_receive_message_length': 10 * 1024 * 1024,
    });
}

async function connectIEBC() {
    const { certPath, keyPath, tlsCaPath } = iebcPaths();
    const certBytes  = fs.readFileSync(certPath);
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    const grpcClient = buildGrpcClient(IEBC_PEER_ENDPOINT, IEBC_PEER_HOSTNAME, tlsCaPath);

    const gateway = connect({
        client  : grpcClient,
        identity: { mspId: IEBC_MSP_ID, credentials: certBytes },
        signer  : signers.newPrivateKeySigner(privateKey),
        evaluateOptions      : () => ({ deadline: Date.now() + 10000 }),
        endorseOptions       : () => ({ deadline: Date.now() + 30000 }),
        submitOptions        : () => ({ deadline: Date.now() + 10000 }),
        commitStatusOptions  : () => ({ deadline: Date.now() + 120000 }),
    });

    return {
        gateway,
        close: () => { gateway.close(); grpcClient.close(); },
    };
}

module.exports = { connectIEBC };
