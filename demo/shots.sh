#!/usr/bin/env bash
# Screenshot helper for Chapter 5. Each step prints a banner, runs a real command, waits for Enter.
cd ~/voting-network
latest() { ls -d evidence/$1/2* 2>/dev/null | tail -1; }
reg()    { ls -d evidence/$1/regression-* 2>/dev/null | tail -1; }
shot() { # name, title, command
  clear
  printf '\033[1m[%s]  %s\033[0m\n%s\n\n' "$1" "$2" "$(printf '=%.0s' {1..100})"
  bash -c "$3"
  printf '\n%s\nSave as evidence/screenshots/%s.png  (Win+Shift+S), then press Enter... ' "$(printf '=%.0s' {1..100})" "$1"
  read -r
}
res() { jq -C '.' "$(latest $1)/result.json" | head -${2:-45}; }

shot fig5-1-network-health "Network health: peers, orderers, CouchDB" \
  "./network/scripts/health-check.sh; echo; docker ps --format 'table {{.Names}}\t{{.Status}}' | head -24"

shot fig5-2-orderer-batchtimeout "Orderer tuning (DEV-006): BatchTimeout 500ms" \
  "grep -n -B2 -A4 BatchTimeout network/configtx.yaml; echo; grep -n -A8 'DEV-006' docs/DEVIATIONS.md | head -14"

shot fig5-3-chaincode-committed "Chaincode committed with OutOf(3,4) policy and private data collection" \
  "source network/scripts/env-peer.sh; setPeer IEBC; peer lifecycle chaincode querycommitted -C votingchannel -n voting 2>&1 | head -20"

shot fig5-4-unit-tests "Chaincode unit tests" \
  "cd chaincode/voting && npm test 2>&1 | tail -40"

shot test1a-sequential-double-vote "Test 1a: sequential replay rejected at Execute phase" "res test1a"
shot test1b-concurrent-race "Test 1b: concurrent race, one VALID and one MVCC_READ_CONFLICT" "res test1b"
shot test3-parity-audit "Test 3: burnedCount == tallyTotal == 1000" "res test3"
shot test4a-duplicate-txid "Test 4a: byte-identical proposal replay (duplicate transaction ID)" "res test4a"
shot test4b-nonce-replay "Test 4b: argument replay rejected by ERR_NONCE_USED" "res test4b"
shot test5-tampered-ballot "Test 5: tampered payload, ERR_BAD_SIGNATURE" "res test5"
shot test6-invalid-endorsement "Test 6: 2-of-4 endorsement, ENDORSEMENT_POLICY_FAILURE (code 10)" "res test6"
shot test2-insider-modification "Test 2: CouchDB tamper, divergent endorsement, rebuild-dbs recovery" "res test2 60"

shot test-layers-error-strings "Distinct enforcement layers: error strings across tests" \
  "for t in test1a test4a test4b test5 test6; do printf '%-8s ' \$t; grep -rhoE 'ERR_[A-Z_]+|duplicate transaction found|ENDORSEMENT_POLICY_FAILURE|MVCC_READ_CONFLICT' \$(latest \$t)/result.json | sort -u | tr '\n' ' '; echo; done"

shot fig5-5-summary "Success criteria mapped to evidence" "sed -n '1,60p' evidence/SUMMARY.md"
shot fig5-6-performance-sweep "Performance sweep 100 to 10,000 votes (latency, throughput)" \
  "grep -n -i -A14 'criteria 8' evidence/SUMMARY.md | head -40"
shot fig5-7-contention-probe "Bounded-concurrency probe: MVCC conflict rate" \
  "jq -C '.' \$(ls -d evidence/test7/concurrency-probe/2* | tail -1)/result.json | head -40"
shot fig5-8-timing-500ms "Timing trial at 500 ms BatchTimeout" "sed -n '1,45p' evidence/timing-trial-500ms/ANALYSIS.md"
shot fig5-9-deviations "Deviation log" "grep -E '^#+ |status' docs/DEVIATIONS.md | head -40"
clear; echo "Done. Files should be in evidence/screenshots/"
