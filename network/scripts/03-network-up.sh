#!/usr/bin/env bash
# Starts all 17 containers. Waits until each peer's listen port is open
# before returning so callers can immediately proceed to channel creation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${NETWORK_DIR}"

echo "=== 03-network-up: pulling couchdb:3.3 if needed ==="
docker pull couchdb:3.3 2>/dev/null || true

echo "=== 03-network-up: starting containers ==="
docker compose up -d

echo "=== 03-network-up: waiting for peers to be ready ==="
declare -A PEER_PORTS=( [IEBC]=7051 [Judiciary]=7061 [CivilSociety]=7071 [Media]=7081 )
for ORG in IEBC Judiciary CivilSociety Media; do
  PORT=${PEER_PORTS[$ORG]}
  echo -n "  waiting for peer (${ORG}, localhost:${PORT})..."
  timeout 90 bash -c "until nc -z localhost ${PORT} 2>/dev/null; do sleep 2; done"
  echo " ready"
done

echo "=== 03-network-up: waiting for orderers to be ready ==="
for PORT in 7050 8050 9050; do
  echo -n "  waiting for orderer (localhost:${PORT})..."
  timeout 60 bash -c "until nc -z localhost ${PORT} 2>/dev/null; do sleep 2; done"
  echo " ready"
done

echo "=== 03-network-up: done — $(docker compose ps --services | wc -l) services up ==="
