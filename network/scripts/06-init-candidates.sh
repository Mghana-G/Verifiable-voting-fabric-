#!/usr/bin/env bash
# Registers and enrols a voting-admin identity (role=admin) via the IEBC
# Fabric CA, then loads candidates.json into the chaincode via CreateCandidate.
# The CA-issued identity is required because cryptogen certs do not carry
# custom ABAC attributes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${NETWORK_DIR}/.." && pwd)"
cd "${NETWORK_DIR}"

export PATH="$HOME/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="$HOME/fabric-samples/config/"

source "${SCRIPT_DIR}/env-peer.sh"

# ── Paths ──────────────────────────────────────────────────────────────────────
CANDIDATES_JSON="${REPO_DIR}/voter-generator/candidates.json"
CA_TLS_CERT="${NETWORK_DIR}/organizations/fabric-ca/orgiebc/tls-cert.pem"
IEBC_CA_CERT="${NETWORK_DIR}/organizations/peerOrganizations/orgiebc.example.com/ca/ca.orgiebc.example.com-cert.pem"
ORDERER_TLS_CA="${NETWORK_DIR}/organizations/ordererOrganizations/orgorderer.example.com/tlsca/tlsca.orgorderer.example.com-cert.pem"

PEER_IEBC_TLS_CA="${NETWORK_DIR}/organizations/peerOrganizations/orgiebc.example.com/peers/peer0.orgiebc.example.com/tls/ca.crt"
PEER_JUDICIARY_TLS_CA="${NETWORK_DIR}/organizations/peerOrganizations/orgjudiciary.example.com/peers/peer0.orgjudiciary.example.com/tls/ca.crt"
PEER_CIVILSOCIETY_TLS_CA="${NETWORK_DIR}/organizations/peerOrganizations/orgcivilsociety.example.com/peers/peer0.orgcivilsociety.example.com/tls/ca.crt"
PEER_MEDIA_TLS_CA="${NETWORK_DIR}/organizations/peerOrganizations/orgmedia.example.com/peers/peer0.orgmedia.example.com/tls/ca.crt"

ADMIN_HOME="${NETWORK_DIR}/organizations/votingadmin"

# ── Step 1: enrol via IEBC CA ──────────────────────────────────────────────────
echo "=== 06-init-candidates: enrolling IEBC CA admin ==="
CA_ADMIN_HOME="${ADMIN_HOME}/ca-admin"
mkdir -p "${CA_ADMIN_HOME}"
export FABRIC_CA_CLIENT_HOME="${CA_ADMIN_HOME}"
fabric-ca-client enroll \
  -u "https://admin:adminpw@localhost:7054" \
  --caname ca-orgiebc \
  --tls.certfiles "${CA_TLS_CERT}"

# Register votingadmin (skip if already registered — ignore the error)
echo "=== 06-init-candidates: registering votingadmin ==="
fabric-ca-client register \
  --caname ca-orgiebc \
  --id.name votingadmin \
  --id.secret votingpw \
  --id.type client \
  --id.attrs "role=admin:ecert" \
  --tls.certfiles "${CA_TLS_CERT}" \
  -u "https://localhost:7054" 2>/dev/null || echo "  (votingadmin already registered, continuing)"

# Enrol votingadmin — the cert will carry role=admin as an ABAC attribute.
echo "=== 06-init-candidates: enrolling votingadmin ==="
VOTING_ADMIN_HOME="${ADMIN_HOME}/votingadmin"
mkdir -p "${VOTING_ADMIN_HOME}"
export FABRIC_CA_CLIENT_HOME="${VOTING_ADMIN_HOME}"
fabric-ca-client enroll \
  -u "https://votingadmin:votingpw@localhost:7054" \
  --caname ca-orgiebc \
  --enrollment.attrs "role" \
  --tls.certfiles "${CA_TLS_CERT}"

# Build a minimal MSP directory for the peer CLI.
# The peer needs: cacerts/, signcerts/, keystore/
VOTING_ADMIN_MSP="${VOTING_ADMIN_HOME}/msp"
mkdir -p "${VOTING_ADMIN_MSP}/admincerts"
cp "${IEBC_CA_CERT}" "${VOTING_ADMIN_MSP}/cacerts/ca.pem" 2>/dev/null || \
  cp "${CA_ADMIN_HOME}/msp/cacerts/"*.pem "${VOTING_ADMIN_MSP}/cacerts/ca.pem"
# Declare this identity as an admin of the MSP (required when NodeOU is not configured)
cp "${VOTING_ADMIN_MSP}/signcerts/cert.pem" "${VOTING_ADMIN_MSP}/admincerts/cert.pem"
echo "=== 06-init-candidates: voting-admin MSP ready at ${VOTING_ADMIN_MSP} ==="

# ── Step 2: invoke CreateCandidate for each candidate ─────────────────────────
echo "=== 06-init-candidates: loading candidates ==="

export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=OrgIEBCMSP
export CORE_PEER_ADDRESS=localhost:7051
export CORE_PEER_TLS_ROOTCERT_FILE="${PEER_IEBC_TLS_CA}"
export CORE_PEER_MSPCONFIGPATH="${VOTING_ADMIN_MSP}"

while IFS= read -r candidate; do
  CANDIDATE_ID=$(echo "${candidate}" | jq -r '.candidateID')
  NAME=$(echo "${candidate}" | jq -r '.name')
  PARTY=$(echo "${candidate}" | jq -r '.party')

  echo "  CreateCandidate ${CANDIDATE_ID}: ${NAME} (${PARTY})"
  peer chaincode invoke \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer1.orgorderer.example.com \
    --tls --cafile "${ORDERER_TLS_CA}" \
    -C votingchannel -n voting \
    --peerAddresses localhost:7051 --tlsRootCertFiles "${PEER_IEBC_TLS_CA}" \
    --peerAddresses localhost:7061 --tlsRootCertFiles "${PEER_JUDICIARY_TLS_CA}" \
    --peerAddresses localhost:7071 --tlsRootCertFiles "${PEER_CIVILSOCIETY_TLS_CA}" \
    --peerAddresses localhost:7081 --tlsRootCertFiles "${PEER_MEDIA_TLS_CA}" \
    -c "{\"function\":\"CreateCandidate\",\"Args\":[\"${CANDIDATE_ID}\",\"${NAME}\",\"${PARTY}\"]}" \
    --waitForEvent
  sleep 1
done < <(jq -c '.[]' "${CANDIDATES_JSON}")

# ── Step 3: verify with GetTally ──────────────────────────────────────────────
echo "=== 06-init-candidates: verifying with GetTally ==="
setPeer IEBC
peer chaincode query \
  -C votingchannel -n voting \
  -c '{"function":"GetTally","Args":["election2027"]}'

echo "=== 06-init-candidates: done ==="
