#!/usr/bin/env bash
# Verifies all tool versions required by MASTER_PLAN.md A.4.
# Exits non-zero on the first mismatch.
set -euo pipefail

PASS=0
FAIL=0

check() {
  local label=$1 cmd=$2 want=$3
  local got
  got=$(eval "$cmd" 2>/dev/null | head -1) || true
  if [[ "$got" == *"$want"* ]]; then
    echo "  OK  $label: $got"
    (( PASS++ )) || true
  else
    echo "FAIL  $label: expected '$want', got '$got'"
    (( FAIL++ )) || true
  fi
}

echo "=== Prereqs check ==="

check "Docker"          "docker --version"                   "29."
check "Docker Compose"  "docker compose version"             "v"
check "Node.js"         "node --version"                     "v20."
check "npm"             "npm --version"                      ""
check "git"             "git --version"                      "git version"
check "curl"            "curl --version"                     "curl"
check "python3"         "python3 --version"                  "Python 3.12"
check "peer"            "peer version 2>&1 | grep 'Version:'"        "v2.5"
check "configtxgen"     "configtxgen --version 2>&1 | grep 'Version:'" "v2.5"
check "osnadmin"        "osnadmin --help 2>&1 | head -1"             "osnadmin"
check "jq"              "jq --version"                       "jq-"
check "tmux"            "tmux -V"                            "tmux"

echo ""
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && echo "ALL CHECKS PASSED" && exit 0
echo "SOME CHECKS FAILED — fix above before proceeding" && exit 1
