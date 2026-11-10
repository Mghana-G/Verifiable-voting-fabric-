'use strict';

const { connect, signers } = require('@hyperledger/fabric-gateway');
const grpc   = require('@grpc/grpc-js');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const NETWORK_ROOT = path.join(__dirname, '..', '..', 'network');

const CS_PEER_ENDPOINT = 'localhost:7071';
const CS_PEER_HOSTNAME = 'peer0.orgcivilsociety.example.com';
const CS_MSP_ID        = 'OrgCivilSocietyMSP';

function csPaths() {
    const mspBase = path.join(
        NETWORK_ROOT, 'organizations', 'peerOrganizations',
        'orgcivilsociety.example.com', 'users', 'User1@orgcivilsociety.example.com', 'msp'
    );
    const keystoreDir = path.join(mspBase, 'keystore');
    const keyFile = fs.readdirSync(keystoreDir).find(f => !f.startsWith('.'));
    return {
        certPath  : path.join(mspBase, 'signcerts', 'User1@orgcivilsociety.example.com-cert.pem'),
        keyPath   : path.join(keystoreDir, keyFile),
        tlsCaPath : path.join(
            NETWORK_ROOT, 'organizations', 'peerOrganizations',
            'orgcivilsociety.example.com', 'peers', 'peer0.orgcivilsociety.example.com', 'tls', 'ca.crt'
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

let _gateway;
let _grpcClient;
let _network;

function getNetwork() {
    if (_network) return _network;

    const { certPath, keyPath, tlsCaPath } = csPaths();
    const certBytes  = fs.readFileSync(certPath);
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    _grpcClient = buildGrpcClient(CS_PEER_ENDPOINT, CS_PEER_HOSTNAME, tlsCaPath);

    _gateway = connect({
        client  : _grpcClient,
        identity: { mspId: CS_MSP_ID, credentials: certBytes },
        signer  : signers.newPrivateKeySigner(privateKey),
        evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
    });

    _network = _gateway.getNetwork('votingchannel');
    return _network;
}

module.exports = { getNetwork };
