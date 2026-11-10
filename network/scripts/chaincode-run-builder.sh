#!/bin/bash
# External builder run script (node-docker builder).
# Launches the pre-built chaincode Docker image via the host Docker socket
# (Docker-out-of-Docker; socket is mounted at /host/var/run/docker.sock).
#
# chaincode.json is compact single-line JSON; grep -oP is used since jq and
# python3 are absent from the fabric-peer image.
# TLS cert values are raw PEM with \n escape sequences; the chaincode entrypoint
# uses printf '%b' to restore real newlines before writing to files.
set -euo pipefail

# Append diagnostics to a persistent log for debugging.
LOGFILE="/var/hyperledger/production/run-builder.log"
{
  echo "=== run called at $(date) ==="
  echo "  args: ${1:-MISSING} ${2:-MISSING}"
} >> "${LOGFILE}" 2>&1

BUILD_OUTPUT_DIR="${1}"
LAUNCH_METADATA_DIR="${2}"
CC_JSON="${LAUNCH_METADATA_DIR}/chaincode.json"

# Save chaincode.json for post-mortem inspection (masked certs).
cp "${CC_JSON}" /var/hyperledger/production/chaincode-last.json 2>/dev/null || true

# Parse compact single-line JSON using grep -oP (Perl regex, available in GNU grep).
CHAINCODE_ID=$(grep -oP '"chaincode_id"\s*:\s*"\K[^"]+' "${CC_JSON}")
PEER_ADDRESS=$(grep -oP '"peer_address"\s*:\s*"\K[^"]+' "${CC_JSON}")
CLIENT_CERT=$(grep  -oP '"client_cert"\s*:\s*"\K[^"]+'  "${CC_JSON}")
CLIENT_KEY=$(grep   -oP '"client_key"\s*:\s*"\K[^"]+'   "${CC_JSON}")
ROOT_CERT=$(grep    -oP '"root_cert"\s*:\s*"\K[^"]+'    "${CC_JSON}")

{
  echo "  CHAINCODE_ID=${CHAINCODE_ID}"
  echo "  PEER_ADDRESS=${PEER_ADDRESS}"
} >> "${LOGFILE}" 2>&1

# CORE_PEER_ID is not propagated to external builder subprocesses; derive
# the peer FQDN from peer_address (format: fqdn:port).
PEER_HOST="${PEER_ADDRESS%:*}"

# Derive label and package hash from CHAINCODE_ID (format: label:hash).
PKG_HASH="${CHAINCODE_ID##*:}"
LABEL="${CHAINCODE_ID%:*}"
IMAGE="dev-${PEER_HOST}-${LABEL}:${PKG_HASH}"

# Container name must be unique per peer: all 4 peers share the same host
# Docker daemon via DooD, so a shared name would cause a race condition.
CC_NAME="cc-$(echo "${PEER_HOST}" | tr '.' '-')-${LABEL}"

echo "  IMAGE=${IMAGE}" >> "${LOGFILE}" 2>&1
echo "  CC_NAME=${CC_NAME}" >> "${LOGFILE}" 2>&1

# Use the host Docker socket; exec replaces this process so SIGTERM propagates.
export DOCKER_HOST=unix:///host/var/run/docker.sock

# Remove any stale container for this peer's chaincode before starting.
docker rm -f "${CC_NAME}" 2>/dev/null || true

# Launch chaincode container; cert env vars contain raw PEM with literal \n
# escape sequences which the container entrypoint converts to real newlines.
exec docker run --rm \
  --name "${CC_NAME}" \
  --network voting_votingnet \
  -e CORE_CHAINCODE_ID_NAME="${CHAINCODE_ID}" \
  -e CORE_PEER_ADDRESS="${PEER_ADDRESS}" \
  -e CORE_PEER_TLS_ENABLED="true" \
  -e "CHAINCODE_TLS_CA=${ROOT_CERT}" \
  -e "CHAINCODE_TLS_CERT=${CLIENT_CERT}" \
  -e "CHAINCODE_TLS_KEY=${CLIENT_KEY}" \
  "${IMAGE}"
