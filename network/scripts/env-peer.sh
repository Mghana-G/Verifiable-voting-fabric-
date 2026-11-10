#!/usr/bin/env bash
# Source this file; call setPeer <ORG> to set CORE_PEER_* env vars for that org.
# ORG is one of: IEBC  Judiciary  CivilSociety  Media

NETWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

setPeer() {
  local ORG=$1
  export CORE_PEER_TLS_ENABLED=true
  export FABRIC_CFG_PATH="$HOME/fabric-samples/config/"

  case "$ORG" in
    IEBC)
      export CORE_PEER_LOCALMSPID=OrgIEBCMSP
      export CORE_PEER_ADDRESS=localhost:7051
      export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/orgiebc.example.com/users/Admin@orgiebc.example.com/msp"
      export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_DIR}/organizations/peerOrganizations/orgiebc.example.com/peers/peer0.orgiebc.example.com/tls/ca.crt"
      ;;
    Judiciary)
      export CORE_PEER_LOCALMSPID=OrgJudiciaryMSP
      export CORE_PEER_ADDRESS=localhost:7061
      export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/orgjudiciary.example.com/users/Admin@orgjudiciary.example.com/msp"
      export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_DIR}/organizations/peerOrganizations/orgjudiciary.example.com/peers/peer0.orgjudiciary.example.com/tls/ca.crt"
      ;;
    CivilSociety)
      export CORE_PEER_LOCALMSPID=OrgCivilSocietyMSP
      export CORE_PEER_ADDRESS=localhost:7071
      export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/orgcivilsociety.example.com/users/Admin@orgcivilsociety.example.com/msp"
      export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_DIR}/organizations/peerOrganizations/orgcivilsociety.example.com/peers/peer0.orgcivilsociety.example.com/tls/ca.crt"
      ;;
    Media)
      export CORE_PEER_LOCALMSPID=OrgMediaMSP
      export CORE_PEER_ADDRESS=localhost:7081
      export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/orgmedia.example.com/users/Admin@orgmedia.example.com/msp"
      export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_DIR}/organizations/peerOrganizations/orgmedia.example.com/peers/peer0.orgmedia.example.com/tls/ca.crt"
      ;;
    *)
      echo "ERROR: Unknown org '${ORG}'. Use: IEBC  Judiciary  CivilSociety  Media" >&2
      return 1
      ;;
  esac
}
