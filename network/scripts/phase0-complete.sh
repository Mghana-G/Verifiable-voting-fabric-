#!/usr/bin/env bash
# Phase 0 completion script.
# Run this as labadmin (sudo will prompt once).
# Performs: disk extension, Docker group refresh, Fabric install, test-network proof.
set -euo pipefail

FABRIC_VERSION="2.5.12"
CA_VERSION="1.5.15"
EVIDENCE_DIR="$HOME/voting-network/evidence/screenshots"
mkdir -p "$EVIDENCE_DIR"

echo "=== Step 1: Extend root partition to full disk ==="
# sda2 is the root partition; disk is 62 GB but partition is 20 GB.
sudo parted /dev/sda resizepart 2 100% ---pretend-input-tty <<< "Yes"
sudo resize2fs /dev/sda2
df -h /

echo "=== Step 2: Activate docker group (no re-login needed via newgrp) ==="
# The group membership was added by the Docker installer; activate it for this shell.
if ! id | grep -q docker; then
  echo "Note: docker group not yet active in this shell. Using 'sg docker' for remaining steps."
fi

echo "=== Step 3: Clone fabric-samples and install Fabric $FABRIC_VERSION ==="
mkdir -p ~/fabric-samples
cd ~/fabric-samples
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh --fabric-version "$FABRIC_VERSION" --ca-version "$CA_VERSION" docker binary samples
echo "Fabric binaries installed."

echo "=== Step 4: Add Fabric bin to PATH ==="
FABRIC_BIN='export PATH=$PATH:$HOME/fabric-samples/bin'
if ! grep -qF 'fabric-samples/bin' ~/.bashrc; then
  echo "$FABRIC_BIN" >> ~/.bashrc
  echo "Added to ~/.bashrc"
fi
export PATH=$PATH:$HOME/fabric-samples/bin

echo "=== Step 5: Verify Fabric binaries ==="
peer version
configtxgen --version

echo "=== Step 6: Bring up stock test-network (exit-gate proof) ==="
cd ~/fabric-samples/test-network
./network.sh down 2>/dev/null || true
./network.sh up createChannel -ca -s couchdb

echo "--- Deploying basic chaincode ---"
./network.sh deployCC -ccn basic -ccp ../asset-transfer-basic/chaincode-javascript -ccl javascript

echo "--- Invoking InitLedger ---"
export FABRIC_CFG_PATH=${PWD}/../config/
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH=${PWD}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_TLS_ROOTCERT_FILE=${PWD}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_ADDRESS=localhost:7051

peer chaincode invoke \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "${PWD}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem" \
  -C mychannel -n basic \
  --peerAddresses localhost:7051 \
  --tlsRootCertFiles "${PWD}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt" \
  --peerAddresses localhost:9051 \
  --tlsRootCertFiles "${PWD}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
  -c '{"function":"InitLedger","Args":[]}'

sleep 3

echo "--- Querying GetAllAssets ---"
QUERY_RESULT=$(peer chaincode query -C mychannel -n basic -c '{"Args":["GetAllAssets"]}')
echo "$QUERY_RESULT" | head -3
echo "QUERY_OK"

echo "--- Saving evidence ---"
echo "Invoke result: OK" > "$EVIDENCE_DIR/phase0-testnetwork-invoke.txt"
echo "$QUERY_RESULT" >> "$EVIDENCE_DIR/phase0-testnetwork-invoke.txt"
echo "Date: $(date -u)" >> "$EVIDENCE_DIR/phase0-testnetwork-invoke.txt"
echo "Evidence saved to $EVIDENCE_DIR"

echo "--- Tearing down test-network ---"
./network.sh down

echo ""
echo "=== Phase 0 complete. Running prereqs check ==="
bash ~/voting-network/network/scripts/00-prereqs.sh
