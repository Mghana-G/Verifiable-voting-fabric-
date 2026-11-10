#!/usr/bin/env bash
# Tears down the network completely: stops and removes all containers,
# volumes, networks, chaincode images, and generated directories.
# Running 01..04 afterwards starts from a completely clean state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${NETWORK_DIR}"

echo "=== 99-network-down: stopping containers ==="
docker compose down --volumes --remove-orphans 2>/dev/null || true

echo "=== 99-network-down: removing chaincode containers ==="
docker ps -a --format '{{.Names}}' \
  | grep -E "^dev-peer0\.(orgiebc|orgjudiciary|orgcivilsociety|orgmedia)" \
  | xargs -r docker rm -f 2>/dev/null || true

echo "=== 99-network-down: removing chaincode images ==="
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep -E "^dev-peer0\.(orgiebc|orgjudiciary|orgcivilsociety|orgmedia)" \
  | xargs -r docker rmi -f 2>/dev/null || true

echo "=== 99-network-down: removing generated directories ==="
# Containers run as root and create root-owned files in bind-mounted directories.
# Use busybox as root to remove them before the host-side rm -rf.
if [[ -d "${NETWORK_DIR}/organizations" ]]; then
  docker run --rm \
    -v "${NETWORK_DIR}/organizations:/cleanup-orgs" \
    busybox sh -c 'rm -rf /cleanup-orgs/*' 2>/dev/null || true
fi
rm -rf organizations channel-artifacts

echo "=== 99-network-down: done — Docker state ==="
docker ps -a --format "table {{.Names}}\t{{.Status}}" \
  | grep -E "orgiebc|orgjudiciary|orgcivilsociety|orgmedia|orgorderer" \
  || echo "  (no voting-network containers remain)"
