#!/usr/bin/env bash
# Test 6 — Invalid Endorsement Rejection
# IMPLEMENTATION_BRIEF.md Section 6: manually construct a transaction with
# only 2-of-4 endorsement signatures (below the OutOf(3,...) policy
# threshold) and submit to the ordering service. Success: rejected at
# commit — VSCC endorsement-policy check fails, transaction marked invalid
# in the block, write-set not applied.
#
# fabric-gateway collects whatever endorsements the policy needs
# automatically, so this cannot be written with the SDK (docs/PHASE4_DECISIONS.md
# E.3). Uses `peer chaincode invoke` directly with exactly two
# --peerAddresses pairs. The validation code is read from a block fetched
# FROM A PEER (never the orderer — orderer copies have an empty
# TRANSACTIONS_FILTER, verified empirically).
#
# Usage: test6-invalid-endorsement.sh <runIndex>

set -euo pipefail

RUN_INDEX="${1:-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_DIR="$(cd "$SCRIPT_DIR/../network" && pwd)"
EVIDENCE_ROOT="$SCRIPT_DIR/../evidence"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)
DIR="$EVIDENCE_ROOT/test6/$STAMP"
mkdir -p "$DIR"

ELECTION_ID="test6-run${RUN_INDEX}-$(date +%s%N)"
CANDIDATE="C001"
POLLING="PS-TEST6"

export PATH="$PATH:$HOME/fabric-samples/bin"
export FABRIC_CFG_PATH="$HOME/fabric-samples/config/"

echo "[test6 run${RUN_INDEX}] election=${ELECTION_ID}" >&2

# 1. Mint a fresh VAT and build a correctly signed CastBallot invocation, so
#    the only defect in this transaction is the endorsement count.
CAPTURED_FILE="$DIR/captured-ballot.json"
INVOKE_JSON=$(cd "$SCRIPT_DIR" && node lib/gen-castballot-invoke.js "$ELECTION_ID" "$CANDIDATE" "$POLLING" "$CAPTURED_FILE")

# 2. Record tally before.
TALLY_BEFORE=$(cd "$SCRIPT_DIR" && node lib/get-tally.js "$ELECTION_ID")
echo "$TALLY_BEFORE" > "$DIR/tally-before.json"

# 3. Under-endorsed invoke: only IEBC + Judiciary (2 of the 4 orgs required
#    by OutOf(3,...)).
source "$NETWORK_DIR/scripts/env-peer.sh"
setPeer IEBC

ORDERER_CA="$NETWORK_DIR/organizations/ordererOrganizations/orgorderer.example.com/tlsca/tlsca.orgorderer.example.com-cert.pem"
IEBC_TLS="$NETWORK_DIR/organizations/peerOrganizations/orgiebc.example.com/peers/peer0.orgiebc.example.com/tls/ca.crt"
JUD_TLS="$NETWORK_DIR/organizations/peerOrganizations/orgjudiciary.example.com/peers/peer0.orgjudiciary.example.com/tls/ca.crt"

set +e
INVOKE_OUTPUT=$(peer chaincode invoke \
  -o localhost:7050 --ordererTLSHostnameOverride orderer1.orgorderer.example.com \
  --tls --cafile "$ORDERER_CA" \
  -C votingchannel -n voting \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$IEBC_TLS" \
  --peerAddresses localhost:7061 --tlsRootCertFiles "$JUD_TLS" \
  -c "$INVOKE_JSON" 2>&1)
INVOKE_EXIT=$?
set -e
echo "$INVOKE_OUTPUT" > "$DIR/invoke-output.txt"

# Give the orderer time to cut the block (BatchTimeout: 2s).
sleep 4

# 4. Decode the resulting block FROM A PEER to read the real validation code.
DECODE_JSON=$(cd "$SCRIPT_DIR" && node lib/decode-last-block.js IEBC "$DIR")
echo "$DECODE_JSON" > "$DIR/block-decode.json"

# 5. Record tally after — must be unchanged.
TALLY_AFTER=$(cd "$SCRIPT_DIR" && node lib/get-tally.js "$ELECTION_ID")
echo "$TALLY_AFTER" > "$DIR/tally-after.json"

# 6. Capture peer logs.
{
  echo "=== docker logs peer0.orgiebc.example.com --tail 200 ==="
  docker logs peer0.orgiebc.example.com --tail 200 2>&1
  echo
  echo "=== docker logs peer0.orgjudiciary.example.com --tail 200 ==="
  docker logs peer0.orgjudiciary.example.com --tail 200 2>&1
} > "$DIR/peer-logs.txt"

# 7. Assemble result.json and print the one-line PASS/FAIL.
python3 - "$DIR" "$INVOKE_EXIT" "$RUN_INDEX" "$ELECTION_ID" <<'PYEOF'
import json, sys, os

evdir, invoke_exit, run_index, election_id = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]

decode = json.load(open(os.path.join(evdir, 'block-decode.json')))
tally_before = json.load(open(os.path.join(evdir, 'tally-before.json')))
tally_after = json.load(open(os.path.join(evdir, 'tally-after.json')))

codes = decode.get('codes', [])
labels = decode.get('labels', [])
has_endorsement_failure = 10 in codes
tally_unchanged = tally_before == tally_after

result = {
    'test': '6',
    'runIndex': int(run_index),
    'electionID': election_id,
    'invokeExitCode': invoke_exit,
    'blockNumber': decode.get('blockNum'),
    'txValidationCodes': codes,
    'txValidationLabels': labels,
    'tallyBefore': tally_before,
    'tallyAfter': tally_after,
    'tallyUnchanged': tally_unchanged,
    'pass': bool(has_endorsement_failure and tally_unchanged),
}
with open(os.path.join(evdir, 'result.json'), 'w') as f:
    json.dump(result, f, indent=2)
    f.write('\n')

key_evidence = "codes={} labels={}".format(codes, labels)
print("test6 run{} {} | {}".format(run_index, 'PASS' if result['pass'] else 'FAIL', key_evidence))
sys.exit(0 if result['pass'] else 1)
PYEOF
