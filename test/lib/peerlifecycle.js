'use strict';

/**
 * peer node rebuild-dbs recovery, used only by test2. Verified live against
 * peer0.orgmedia.example.com (docs/PHASE4_DECISIONS.md E.2): rebuild-dbs is
 * an offline operation (drops CouchDB app DBs + local level DBs), so the
 * peer container must be stopped first; it is then run via a throwaway
 * container sharing the peer's ledger volume and joined to the same Docker
 * network so it can reach its CouchDB instance, and the original container
 * is restarted afterwards to replay the block store back into CouchDB.
 */

const { execSync } = require('child_process');

const FABRIC_VERSION = '2.5.12';
const DOCKER_NETWORK = 'voting_votingnet';

const REBUILD_INFO = {
    Media: {
        container: 'peer0.orgmedia.example.com',
        volume: 'voting_peer0.orgmedia.example.com',
        mspHostPath: 'network/organizations/peerOrganizations/orgmedia.example.com/peers/peer0.orgmedia.example.com/msp',
        tlsHostPath: 'network/organizations/peerOrganizations/orgmedia.example.com/peers/peer0.orgmedia.example.com/tls',
        localMspId: 'OrgMediaMSP',
        couchdbAddress: 'couchdb.orgmedia:5984',
    },
};

const path = require('path');
const REPO_ROOT = path.join(__dirname, '..', '..');

function sh(cmd, opts = {}) {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
}

function stopPeer(org) {
    const info = REBUILD_INFO[org];
    return sh(`docker stop ${info.container}`);
}

function runRebuildDbs(org) {
    const info = REBUILD_INFO[org];
    const mspPath = path.join(REPO_ROOT, info.mspHostPath);
    const tlsPath = path.join(REPO_ROOT, info.tlsHostPath);
    const cmd = [
        'docker run --rm',
        `--network ${DOCKER_NETWORK}`,
        '-e CORE_PEER_TLS_ENABLED=true',
        '-e CORE_PEER_TLS_CERT_FILE=/etc/hyperledger/fabric/tls/server.crt',
        '-e CORE_PEER_TLS_KEY_FILE=/etc/hyperledger/fabric/tls/server.key',
        '-e CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt',
        `-e CORE_PEER_ID=${info.container}`,
        `-e CORE_PEER_LOCALMSPID=${info.localMspId}`,
        '-e CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/fabric/msp',
        '-e CORE_LEDGER_STATE_STATEDATABASE=CouchDB',
        `-e CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS=${info.couchdbAddress}`,
        '-e CORE_LEDGER_STATE_COUCHDBCONFIG_USERNAME=admin',
        '-e CORE_LEDGER_STATE_COUCHDBCONFIG_PASSWORD=adminpw',
        `-v "${mspPath}:/etc/hyperledger/fabric/msp"`,
        `-v "${tlsPath}:/etc/hyperledger/fabric/tls"`,
        `-v ${info.volume}:/var/hyperledger/production`,
        `ghcr.io/hyperledger/fabric-peer:${FABRIC_VERSION} peer node rebuild-dbs`,
    ].join(' ');
    return sh(cmd, { shell: '/bin/bash' });
}

function startPeer(org) {
    const info = REBUILD_INFO[org];
    return sh(`docker start ${info.container}`);
}

module.exports = { stopPeer, runRebuildDbs, startPeer, REBUILD_INFO };
