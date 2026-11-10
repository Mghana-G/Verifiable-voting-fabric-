#!/usr/bin/env bash
# Completes the Phase 0 exit-gate after phase0-fix.sh reached the invoke step.
# Fixes: organizations/ directory was created by root (sudo network.sh), so labadmin
#        cannot read MSP files for peer chaincode invoke.
set -euo pipefail

EVIDENCE_DIR="$HOME/voting-network/evidence/screenshots"
mkdir -p "$EVIDENCE_DIR"
export PATH=$PATH:$HOME/fabric-samples/bin

echo "=== Fix permissions on organizations/ ==="
sudo chown -R labadmin:labadmin "$HOME/fabric-samples/test-network/organizations/"
echo "Done."

echo "=== Step 7: Invoke InitLedger ==="
export FABRIC_CFG_PATH="${HOME}/fabric-samples/config/"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${HOME}/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_TLS_ROOTCERT_FILE="${HOME}/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_ADDRESS=localhost:7051

peer chaincode invoke \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls \
  --cafile "${HOME}/fabric-samples/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem" \
  -C mychannel -n basic \
  --peerAddresses localhost:7051 \
  --tlsRootCertFiles "${HOME}/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt" \
  --peerAddresses localhost:9051 \
  --tlsRootCertFiles "${HOME}/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
  -c '{"function":"InitLedger","Args":[]}'

sleep 3

echo "=== Step 8: Query GetAllAssets ==="
QUERY_RESULT=$(peer chaincode query -C mychannel -n basic -c '{"Args":["GetAllAssets"]}')
echo "$QUERY_RESULT" | python3 -m json.tool | head -20
echo "QUERY_OK"

echo "--- Saving evidence ---"
{
  echo "Phase 0 exit-gate evidence"
  echo "Date: $(date -u)"
  echo "Invoke: InitLedger OK"
  echo "Query result:"
  echo "$QUERY_RESULT"
} > "$EVIDENCE_DIR/phase0-testnetwork.txt"
echo "Evidence saved to $EVIDENCE_DIR/phase0-testnetwork.txt"

echo "=== Step 9: Tear down test-network ==="
cd "$HOME/fabric-samples/test-network"
sudo env "PATH=$PATH" ./network.sh down

echo "=== Step 10: Run prereqs gate ==="
bash "$HOME/voting-network/network/scripts/00-prereqs.sh"

echo ""
echo "============================================"
echo "  Phase 0 COMPLETE -- exit gate passed"
echo "  Take snapshot: phase0-clean-toolchain"
echo "============================================"
