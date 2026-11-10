#!/usr/bin/env bash
# Generates the votingchannel genesis block using configtxgen.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${NETWORK_DIR}"
export PATH="$HOME/fabric-samples/bin:$PATH"
# configtx.yaml lives in network/ so FABRIC_CFG_PATH = NETWORK_DIR
export FABRIC_CFG_PATH="${NETWORK_DIR}"

mkdir -p channel-artifacts

echo "=== 02-generate-artifacts: generating votingchannel genesis block ==="
configtxgen \
  -profile VotingChannel \
  -channelID votingchannel \
  -outputBlock channel-artifacts/votingchannel.block

echo "=== 02-generate-artifacts: done ==="
ls -lh channel-artifacts/votingchannel.block
