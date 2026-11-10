#!/usr/bin/env bash
# Fixes the fabric-samples path and pulls Docker images with sudo.
set -euo pipefail

FABRIC_VERSION="2.5.12"
CA_VERSION="1.5.15"
EVIDENCE_DIR="$HOME/voting-network/evidence/screenshots"
mkdir -p "$EVIDENCE_DIR"

echo "=== Fix 1: Restructure fabric-samples to correct layout ==="
# install-fabric.sh ran from inside ~/fabric-samples/ so created ~/fabric-samples/fabric-samples/
# Move it up: ~/fabric-samples/fabric-samples -> ~/fabric-samples
if [[ -d "$HOME/fabric-samples/fabric-samples" ]] && [[ ! -d "$HOME/fabric-samples/bin" ]]; then
  echo "Moving nested directory up one level..."
  mv "$HOME/fabric-samples/fabric-samples" /tmp/fs-temp
  rm -rf "$HOME/fabric-samples"
  mv /tmp/fs-temp "$HOME/fabric-samples"
  echo "Done — binaries now at $HOME/fabric-samples/bin/"
else
  echo "fabric-samples layout already correct or already fixed."
fi

ls "$HOME/fabric-samples/bin/" | head -5

echo "=== Fix 2: Add fabric-samples/bin to PATH ==="
FABRIC_BIN='export PATH=$PATH:$HOME/fabric-samples/bin'
if ! grep -qF 'fabric-samples/bin' ~/.bashrc; then
  echo "$FABRIC_BIN" >> ~/.bashrc
fi
export PATH=$PATH:$HOME/fabric-samples/bin
peer version | head -3

echo "=== Fix 3: Pull Fabric Docker images (sudo) ==="
IMAGES=(
  "ghcr.io/hyperledger/fabric-peer:${FABRIC_VERSION}"
  "ghcr.io/hyperledger/fabric-orderer:${FABRIC_VERSION}"
  "ghcr.io/hyperledger/fabric-ccenv:${FABRIC_VERSION}"
  "ghcr.io/hyperledger/fabric-baseos:${FABRIC_VERSION}"
  "ghcr.io/hyperledger/fabric-ca:${CA_VERSION}"
  "couchdb:3.3"
)
for img in "${IMAGES[@]}"; do
  echo "Pulling $img ..."
  sudo docker pull "$img"
done
echo "Docker images pulled:"
sudo docker images | grep -E "fabric|couchdb" | awk '{print $1":"$2, $7$8}'

echo "=== Step 4: Set up test-network environment variables ==="
cd "$HOME/fabric-samples/test-network"
./network.sh down 2>/dev/null || true

echo "=== Step 5: Bring up test-network with CouchDB ==="
sudo env "PATH=$PATH" ./network.sh up createChannel -ca -s couchdb

echo "=== Step 6: Deploy basic chaincode ==="
sudo env "PATH=$PATH" ./network.sh deployCC \
  -ccn basic \
  -ccp ../asset-transfer-basic/chaincode-javascript \
  -ccl javascript

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
sudo env "PATH=$PATH" ./network.sh down

echo "=== Step 10: Run prereqs gate ==="
bash "$HOME/voting-network/network/scripts/00-prereqs.sh"

echo ""
echo "============================================"
echo "  Phase 0 COMPLETE — exit gate passed"
echo "  Take snapshot: phase0-clean-toolchain"
echo "============================================"
