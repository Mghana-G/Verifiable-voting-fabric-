#!/usr/bin/env bash
# Generates all cryptographic material with cryptogen and prepares
# fabric-ca home directories so the CA containers can start immediately.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${NETWORK_DIR}"
export PATH="$HOME/fabric-samples/bin:$PATH"

echo "=== 01-generate-crypto: removing any previous crypto material ==="
# Guard against root-owned files left by containers in bind-mounted paths.
if [[ -d "${NETWORK_DIR}/organizations" ]]; then
  docker run --rm \
    -v "${NETWORK_DIR}/organizations:/cleanup-orgs" \
    busybox sh -c 'rm -rf /cleanup-orgs/*' 2>/dev/null || true
fi
rm -rf organizations/peerOrganizations organizations/ordererOrganizations organizations/fabric-ca

echo "=== 01-generate-crypto: running cryptogen ==="
cryptogen generate --config=crypto-config.yaml --output=organizations

echo "=== 01-generate-crypto: preparing fabric-ca directories ==="
for ORG in orgiebc orgjudiciary orgcivilsociety orgmedia; do
  CA_DIR="${NETWORK_DIR}/organizations/peerOrganizations/${ORG}.example.com/ca"
  FA_DIR="${NETWORK_DIR}/organizations/fabric-ca/${ORG}"
  mkdir -p "${FA_DIR}"

  CERTFILE=$(ls "${CA_DIR}/"*.pem 2>/dev/null | head -1)
  KEYFILE=$(ls  "${CA_DIR}/"*_sk  2>/dev/null | head -1)

  if [[ -z "$CERTFILE" || -z "$KEYFILE" ]]; then
    echo "ERROR: could not find CA cert/key in ${CA_DIR}" >&2
    exit 1
  fi

  cp "${CERTFILE}" "${FA_DIR}/ca.crt"
  cp "${KEYFILE}"  "${FA_DIR}/ca.key"
  echo "  ${ORG}: CA material copied to ${FA_DIR}"
done

ORDERER_CA_DIR="${NETWORK_DIR}/organizations/ordererOrganizations/orgorderer.example.com/ca"
FA_ORDERER_DIR="${NETWORK_DIR}/organizations/fabric-ca/orgorderer"
mkdir -p "${FA_ORDERER_DIR}"
CERTFILE=$(ls "${ORDERER_CA_DIR}/"*.pem 2>/dev/null | head -1)
KEYFILE=$(ls  "${ORDERER_CA_DIR}/"*_sk  2>/dev/null | head -1)
cp "${CERTFILE}" "${FA_ORDERER_DIR}/ca.crt"
cp "${KEYFILE}"  "${FA_ORDERER_DIR}/ca.key"
echo "  orgorderer: CA material copied to ${FA_ORDERER_DIR}"

echo "=== 01-generate-crypto: done ==="
