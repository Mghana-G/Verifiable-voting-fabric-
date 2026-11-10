#!/usr/bin/env bash
# Phase 1 exit-gate health checks.
# Exits non-zero if any check fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${NETWORK_DIR}"
export PATH="$HOME/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="$HOME/fabric-samples/config/"

source "${SCRIPT_DIR}/env-peer.sh"

PASS=0; FAIL=0
ok()   { echo "  PASS  $*"; (( PASS++ )) || true; }
fail() { echo "  FAIL  $*"; (( FAIL++ )) || true; }

echo "=== health-check: Phase 1 exit gate ==="

# ── 1. CouchDB _up ────────────────────────────────────────────────────────
echo "--- CouchDB instances ---"
declare -A COUCH_PORTS=( [IEBC]=5984 [Judiciary]=5985 [CivilSociety]=5986 [Media]=5987 )
for ORG in IEBC Judiciary CivilSociety Media; do
  PORT=${COUCH_PORTS[$ORG]}
  STATUS=$(curl -s "http://admin:adminpw@localhost:${PORT}/_up" 2>/dev/null | grep -o '"status":"ok"' || true)
  if [[ "$STATUS" == '"status":"ok"' ]]; then
    ok "CouchDB ${ORG} (localhost:${PORT}): ${STATUS}"
  else
    fail "CouchDB ${ORG} (localhost:${PORT}): not up (got '${STATUS}')"
  fi
done

# ── 2. Peers on channel ────────────────────────────────────────────────────
echo "--- Peers joined to votingchannel ---"
for ORG in IEBC Judiciary CivilSociety Media; do
  setPeer "$ORG"
  CHANNEL_INFO=$(peer channel getinfo -c votingchannel 2>&1) || true
  if echo "$CHANNEL_INFO" | grep -q "Blockchain info"; then
    HEIGHT=$(echo "$CHANNEL_INFO" | grep -oP '"height":\K[0-9]+' || echo "?")
    ok "Peer ${ORG} on votingchannel (height=${HEIGHT})"
  else
    fail "Peer ${ORG} NOT on votingchannel: ${CHANNEL_INFO}"
  fi
done

# ── 3. Orderer Raft status ─────────────────────────────────────────────────
echo "--- Orderer Raft quorum ---"
ORDERER_TLS_DIR="${NETWORK_DIR}/organizations/ordererOrganizations/orgorderer.example.com"
ORDERER_TLS_CA="${ORDERER_TLS_DIR}/tlsca/tlsca.orgorderer.example.com-cert.pem"
O1_CERT="${ORDERER_TLS_DIR}/orderers/orderer1.orgorderer.example.com/tls/server.crt"
O1_KEY="${ORDERER_TLS_DIR}/orderers/orderer1.orgorderer.example.com/tls/server.key"

declare -A ORDERER_ADMIN_PORTS=( [orderer1]=9443 [orderer2]=9444 [orderer3]=9445 )
for ORDERER in orderer1 orderer2 orderer3; do
  PORT=${ORDERER_ADMIN_PORTS[$ORDERER]}
  RESULT=$(osnadmin channel list \
    --orderer-address "localhost:${PORT}" \
    --ca-file "${ORDERER_TLS_CA}" \
    --client-cert "${O1_CERT}" \
    --client-key  "${O1_KEY}" 2>&1) || true
  if echo "$RESULT" | grep -q "votingchannel"; then
    ok "${ORDERER} (admin:${PORT}) lists votingchannel"
  else
    fail "${ORDERER} (admin:${PORT}) did not list votingchannel: ${RESULT}"
  fi
done

echo ""
echo "Result: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]] && echo "ALL HEALTH CHECKS PASSED" && exit 0
echo "SOME HEALTH CHECKS FAILED" && exit 1
