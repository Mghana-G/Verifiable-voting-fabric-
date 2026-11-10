#!/usr/bin/env bash
# Packages, installs, approves, and commits the voting chaincode on all 4 peers.
# Idempotent: re-running bumps the sequence number and redeploys.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${NETWORK_DIR}/.." && pwd)"
cd "${NETWORK_DIR}"

export PATH="$HOME/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="$HOME/fabric-samples/config/"

source "${SCRIPT_DIR}/env-peer.sh"

# ── Paths ──────────────────────────────────────────────────────────────────────
CHAINCODE_DIR="${REPO_DIR}/chaincode/voting"
COLLECTIONS_CONFIG="${NETWORK_DIR}/collections_config.json"
ORDERER_TLS_CA="${NETWORK_DIR}/organizations/ordererOrganizations/orgorderer.example.com/tlsca/tlsca.orgorderer.example.com-cert.pem"

PEER_IEBC_TLS_CA="${NETWORK_DIR}/organizations/peerOrganizations/orgiebc.example.com/peers/peer0.orgiebc.example.com/tls/ca.crt"
PEER_JUDICIARY_TLS_CA="${NETWORK_DIR}/organizations/peerOrganizations/orgjudiciary.example.com/peers/peer0.orgjudiciary.example.com/tls/ca.crt"
PEER_CIVILSOCIETY_TLS_CA="${NETWORK_DIR}/organizations/peerOrganizations/orgcivilsociety.example.com/peers/peer0.orgcivilsociety.example.com/tls/ca.crt"
PEER_MEDIA_TLS_CA="${NETWORK_DIR}/organizations/peerOrganizations/orgmedia.example.com/peers/peer0.orgmedia.example.com/tls/ca.crt"

CC_NAME="voting"
ENDORSEMENT_POLICY="OutOf(3,'OrgIEBCMSP.peer','OrgJudiciaryMSP.peer','OrgCivilSocietyMSP.peer','OrgMediaMSP.peer')"

# ── Sequence / version ─────────────────────────────────────────────────────────
setPeer IEBC
CURRENT_SEQ=$(peer lifecycle chaincode querycommitted \
  -C votingchannel -n "${CC_NAME}" 2>/dev/null \
  | grep -oP 'Sequence: \K[0-9]+' || echo "0")
SEQUENCE=$((CURRENT_SEQ + 1))
CC_VERSION="${SEQUENCE}.0"
echo "=== 05-deploy: sequence=${SEQUENCE}  version=${CC_VERSION} ==="

# ── 1. npm test (must pass before every deploy) ────────────────────────────────
echo "=== 05-deploy: running npm test ==="
npm --prefix "${CHAINCODE_DIR}" test

# ── 2. Package ────────────────────────────────────────────────────────────────
echo "=== 05-deploy: packaging chaincode ==="
rm -f "${NETWORK_DIR}/voting.tar.gz"
peer lifecycle chaincode package "${NETWORK_DIR}/voting.tar.gz" \
  --path "${CHAINCODE_DIR}" \
  --lang node \
  --label "${CC_NAME}_${CC_VERSION}"

# ── 3. Pre-build chaincode images (Docker 29.x workaround: DEV-001) ───────────
# The peer's internal Go Docker client (v23.0.1) is incompatible with the
# POST /build API in Docker 29.x. An external no-op builder handles install;
# the peer falls back to its Docker launcher which uses pre-built images.
echo "=== 05-deploy: pre-building chaincode images (Docker 29.x workaround) ==="
PKG_HASH=$(sha256sum "${NETWORK_DIR}/voting.tar.gz" | awk '{print $1}')
LABEL="${CC_NAME}_${CC_VERSION}"
cd /tmp && mkdir -p chaincode-prebuild && cd chaincode-prebuild
tar xf "${NETWORK_DIR}/voting.tar.gz" code.tar.gz 2>/dev/null || true
cat > entrypoint.sh << 'ENTRYEOF'
#!/bin/sh
# Chaincode container entrypoint.
# TLS certs arrive as raw PEM strings with literal \n escape sequences (set by
# the external-builder run script). printf '%b' expands \n to real newlines.
set -e
mkdir -p /tmp/chaincode-tls
if [ -n "${CHAINCODE_TLS_CA:-}" ]; then
    printf '%b' "${CHAINCODE_TLS_CA}"   > /tmp/chaincode-tls/root.pem
    printf '%b' "${CHAINCODE_TLS_CERT}" | base64 > /tmp/chaincode-tls/client.crt
    printf '%b' "${CHAINCODE_TLS_KEY}"  | base64 > /tmp/chaincode-tls/client.key
    export CORE_PEER_TLS_ROOTCERT_FILE=/tmp/chaincode-tls/root.pem
    export CORE_TLS_CLIENT_CERT_PATH=/tmp/chaincode-tls/client.crt
    export CORE_TLS_CLIENT_KEY_PATH=/tmp/chaincode-tls/client.key
fi
exec node /usr/local/src/src/node_modules/.bin/fabric-chaincode-node start \
  --peer.address "${CORE_PEER_ADDRESS}"
ENTRYEOF
cat > Dockerfile << 'DOCKEREOF'
FROM hyperledger/fabric-nodeenv:2.5 as peer
ADD code.tar.gz /usr/local/src
WORKDIR /usr/local/src/src
RUN npm install --production 2>&1 | tee /dev/fd/2
ENV NODE_PATH=/usr/local/lib/node_modules
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
DOCKEREOF
DOCKER_BUILDKIT=0 docker build -t "voting-chaincode-base:${PKG_HASH}" . 2>&1
for PEER_ID in "peer0.orgiebc.example.com" "peer0.orgjudiciary.example.com" "peer0.orgcivilsociety.example.com" "peer0.orgmedia.example.com"; do
  docker tag "voting-chaincode-base:${PKG_HASH}" "dev-${PEER_ID}-${LABEL}:${PKG_HASH}" 2>/dev/null || true
done
cd "${NETWORK_DIR}"
echo "=== 05-deploy: chaincode images ready ==="

# ── 3b. Verify the external-builder setup on all peers (DEV-002/DEV-006) ─────
# The node-docker builder's detect/build/run scripts and the CORE_CHAINCODE_
# EXTERNALBUILDERS registration are bind-mounted from docker-compose.yaml (no
# per-deploy docker cp needed — they are part of the container definition).
# This just verifies the mount and the docker CLI binary (needed by `run` to
# launch the pre-built image via the host socket) actually landed.
echo "=== 05-deploy: verifying external-builder setup on all peers ==="
for PEER_CONTAINER in "peer0.orgiebc.example.com" "peer0.orgjudiciary.example.com" "peer0.orgcivilsociety.example.com" "peer0.orgmedia.example.com"; do
  docker exec "${PEER_CONTAINER}" sh -c '
    test -x /builders/node-docker/bin/detect &&
    test -x /builders/node-docker/bin/build &&
    test -x /builders/node-docker/bin/run &&
    which docker >/dev/null
  ' || { echo "ERROR: node-docker builder not correctly mounted on ${PEER_CONTAINER}" >&2; exit 1; }
  echo "  node-docker builder present on ${PEER_CONTAINER}"
done

# ── 4. Install on all 4 peers ─────────────────────────────────────────────────
for ORG in IEBC Judiciary CivilSociety Media; do
  echo "=== 05-deploy: installing on ${ORG} ==="
  setPeer "${ORG}"
  peer lifecycle chaincode install "${NETWORK_DIR}/voting.tar.gz" 2>&1 || \
    echo "  (already installed on ${ORG} — continuing)"
done

# ── 4. Get package ID ─────────────────────────────────────────────────────────
setPeer IEBC
PKGID=$(peer lifecycle chaincode queryinstalled 2>&1 \
  | grep "Package ID:" \
  | grep "${CC_NAME}_${CC_VERSION}" \
  | sed 's/.*Package ID: //' | sed 's/,.*//')
echo "=== 05-deploy: package ID = ${PKGID} ==="
[[ -z "${PKGID}" ]] && { echo "ERROR: could not determine package ID" >&2; exit 1; }

# ── 5. Approve from all 4 orgs ────────────────────────────────────────────────
for ORG in IEBC Judiciary CivilSociety Media; do
  echo "=== 05-deploy: approveformyorg for ${ORG} ==="
  setPeer "${ORG}"
  peer lifecycle chaincode approveformyorg \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer1.orgorderer.example.com \
    --tls --cafile "${ORDERER_TLS_CA}" \
    -C votingchannel \
    -n "${CC_NAME}" \
    --version "${CC_VERSION}" \
    --sequence "${SEQUENCE}" \
    --package-id "${PKGID}" \
    --signature-policy "${ENDORSEMENT_POLICY}" \
    --collections-config "${COLLECTIONS_CONFIG}"
done

# ── 6. Check commit readiness ─────────────────────────────────────────────────
echo "=== 05-deploy: checkcommitreadiness ==="
setPeer IEBC
peer lifecycle chaincode checkcommitreadiness \
  -C votingchannel \
  -n "${CC_NAME}" \
  --version "${CC_VERSION}" \
  --sequence "${SEQUENCE}" \
  --signature-policy "${ENDORSEMENT_POLICY}" \
  --collections-config "${COLLECTIONS_CONFIG}" \
  --output json

# ── 7. Commit ─────────────────────────────────────────────────────────────────
echo "=== 05-deploy: committing ==="
setPeer IEBC
peer lifecycle chaincode commit \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer1.orgorderer.example.com \
  --tls --cafile "${ORDERER_TLS_CA}" \
  -C votingchannel \
  -n "${CC_NAME}" \
  --version "${CC_VERSION}" \
  --sequence "${SEQUENCE}" \
  --signature-policy "${ENDORSEMENT_POLICY}" \
  --collections-config "${COLLECTIONS_CONFIG}" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "${PEER_IEBC_TLS_CA}" \
  --peerAddresses localhost:7061 --tlsRootCertFiles "${PEER_JUDICIARY_TLS_CA}" \
  --peerAddresses localhost:7071 --tlsRootCertFiles "${PEER_CIVILSOCIETY_TLS_CA}" \
  --peerAddresses localhost:7081 --tlsRootCertFiles "${PEER_MEDIA_TLS_CA}"

# ── 8. Verify commit ──────────────────────────────────────────────────────────
echo "=== 05-deploy: querycommitted ==="
setPeer IEBC
peer lifecycle chaincode querycommitted -C votingchannel -n "${CC_NAME}" --output json

echo "=== 05-deploy: done — voting chaincode v${CC_VERSION} seq ${SEQUENCE} committed ==="
