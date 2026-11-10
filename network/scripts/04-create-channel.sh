#!/usr/bin/env bash
# Joins all three orderers to votingchannel via osnadmin, waits for Raft
# leader election, then joins all four peer orgs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${NETWORK_DIR}"
export PATH="$HOME/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="$HOME/fabric-samples/config/"

source "${SCRIPT_DIR}/env-peer.sh"

BLOCKFILE="${NETWORK_DIR}/channel-artifacts/votingchannel.block"
ORDERER_TLS_DIR="${NETWORK_DIR}/organizations/ordererOrganizations/orgorderer.example.com"
ORDERER_TLS_CA="${ORDERER_TLS_DIR}/tlsca/tlsca.orgorderer.example.com-cert.pem"

# TLS cert/key for all three orderers (signed by the same orderer TLS CA)
O1_CERT="${ORDERER_TLS_DIR}/orderers/orderer1.orgorderer.example.com/tls/server.crt"
O1_KEY="${ORDERER_TLS_DIR}/orderers/orderer1.orgorderer.example.com/tls/server.key"
O2_CERT="${ORDERER_TLS_DIR}/orderers/orderer2.orgorderer.example.com/tls/server.crt"
O2_KEY="${ORDERER_TLS_DIR}/orderers/orderer2.orgorderer.example.com/tls/server.key"
O3_CERT="${ORDERER_TLS_DIR}/orderers/orderer3.orgorderer.example.com/tls/server.crt"
O3_KEY="${ORDERER_TLS_DIR}/orderers/orderer3.orgorderer.example.com/tls/server.key"

echo "=== 04-create-channel: joining orderer1 ==="
osnadmin channel join \
  --channelID votingchannel \
  --config-block "${BLOCKFILE}" \
  --orderer-address localhost:9443 \
  --ca-file "${ORDERER_TLS_CA}" \
  --client-cert "${O1_CERT}" \
  --client-key  "${O1_KEY}"

echo "=== 04-create-channel: joining orderer2 ==="
osnadmin channel join \
  --channelID votingchannel \
  --config-block "${BLOCKFILE}" \
  --orderer-address localhost:9444 \
  --ca-file "${ORDERER_TLS_CA}" \
  --client-cert "${O2_CERT}" \
  --client-key  "${O2_KEY}"

echo "=== 04-create-channel: joining orderer3 ==="
osnadmin channel join \
  --channelID votingchannel \
  --config-block "${BLOCKFILE}" \
  --orderer-address localhost:9445 \
  --ca-file "${ORDERER_TLS_CA}" \
  --client-cert "${O3_CERT}" \
  --client-key  "${O3_KEY}"

echo "=== 04-create-channel: waiting for Raft leader election (10 s) ==="
sleep 10

echo "=== 04-create-channel: joining peers ==="
for ORG in IEBC Judiciary CivilSociety Media; do
  setPeer "$ORG"
  peer channel join -b "${BLOCKFILE}"
  echo "  ${ORG} peer joined votingchannel"
done

echo "=== 04-create-channel: done ==="
