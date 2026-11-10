#!/usr/bin/env bash
# Orchestrates the Phase 4 validation suite.
#
# Runs 1a, 1b, 3, 4a, 4b, 5, 6 three times each, then 2 three times last (it
# stops and restarts a peer container, so it runs after everything else that
# needs the network in a steady state). Never runs test7 (performance) — out
# of scope for this pass (IMPLEMENTATION_BRIEF.md Section 6.2 is a separate,
# much longer sweep; see MASTER_PLAN.md Part E.1 / docs/PHASE4_DECISIONS.md).
#
# Stops immediately on the first failed run and writes the failure to
# docs/BLOCKERS.md.
#
# Usage: test/run-all.sh [test3VoteCount]   (default 1000, per the brief)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EVIDENCE_ROOT="$REPO_ROOT/evidence"
BLOCKERS_FILE="$REPO_ROOT/docs/BLOCKERS.md"
RUN_STAMP=$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)
LOG_FILE="$EVIDENCE_ROOT/run-all-${RUN_STAMP}.log"
TEST3_COUNT="${1:-1000}"

mkdir -p "$EVIDENCE_ROOT"
: > "$LOG_FILE"

RESULTS=()   # each entry: "test<US>run<US>status<US>keyEvidence"
US=$'\x1f'
OVERALL_PASS=true

log() {
    echo "$1" | tee -a "$LOG_FILE"
}

# Appends a FAIL entry to docs/BLOCKERS.md and stops the whole suite.
record_and_maybe_stop() {
    local test_name="$1" run_index="$2" exit_code="$3" line="$4"

    local status="FAIL"
    if [ "$exit_code" -eq 0 ]; then status="PASS"; fi
    local key_evidence="${line#*| }"
    RESULTS+=("${test_name}${US}${run_index}${US}${status}${US}${key_evidence}")

    if [ "$exit_code" -ne 0 ]; then
        OVERALL_PASS=false
        {
            echo ""
            echo "## test${test_name} run${run_index} FAILED ($(date -u +%FT%TZ))"
            echo ""
            echo '```'
            echo "$line"
            echo '```'
            echo ""
            echo "See evidence/test${test_name}/ for the latest result.json and peer-logs.txt."
            echo "Full run-all log: evidence/$(basename "$LOG_FILE")"
        } >> "$BLOCKERS_FILE"
        log ""
        log "STOPPING: test${test_name} run${run_index} FAILED. Details written to docs/BLOCKERS.md."
        print_table
        exit 1
    fi
}

run_js_test() {
    local test_name="$1" script="$2"
    shift 2
    for i in 1 2 3; do
        log ">>> test${test_name} run${i} starting ($(date -u +%FT%TZ))"
        local out code last_line
        out=$(cd "$SCRIPT_DIR" && node "$script" "$i" "$@" 2>>"$LOG_FILE")
        code=$?
        last_line=$(echo "$out" | tail -1)
        log "$last_line"
        record_and_maybe_stop "$test_name" "$i" "$code" "$last_line"
    done
}

run_sh_test() {
    local test_name="$1" script="$2"
    for i in 1 2 3; do
        log ">>> test${test_name} run${i} starting ($(date -u +%FT%TZ))"
        local out code last_line
        out=$(bash "$script" "$i" 2>>"$LOG_FILE")
        code=$?
        last_line=$(echo "$out" | tail -1)
        log "$last_line"
        record_and_maybe_stop "$test_name" "$i" "$code" "$last_line"
    done
}

print_table() {
    log ""
    log "=== Phase 4 Validation Results ==="
    printf "%-6s %-5s %-6s %s\n" "Test" "Run" "Result" "Key evidence" | tee -a "$LOG_FILE"
    for r in "${RESULTS[@]}"; do
        IFS="$US" read -r t run status ev <<< "$r"
        printf "%-6s %-5s %-6s %s\n" "$t" "$run" "$status" "$ev" | tee -a "$LOG_FILE"
    done
}

log "=== Phase 4 validation suite starting: ${RUN_STAMP} (test3 count=${TEST3_COUNT}) ==="

run_js_test "1a" "test1a-double-voting-sequential.js"
run_js_test "1b" "test1b-double-voting-concurrent.js"
run_js_test "3"  "test3-parity-audit.js" "$TEST3_COUNT"
run_js_test "4a" "test4a-replay-byte-identical.js"
run_js_test "4b" "test4b-replay-argument-tuple.js"
run_js_test "5"  "test5-tampered-ballot.js"
run_sh_test "6"  "$SCRIPT_DIR/test6-invalid-endorsement.sh"
run_js_test "2"  "test2-insider-modification.js"

print_table

node "$SCRIPT_DIR/lib/summarize.js"
SUMMARY_CODE=$?

log ""
log "=== Phase 4 validation suite complete: ${RUN_STAMP} ==="
log "SUMMARY.md written to evidence/SUMMARY.md"

if [ "$OVERALL_PASS" = true ] && [ "$SUMMARY_CODE" -eq 0 ]; then
    exit 0
else
    exit 1
fi
