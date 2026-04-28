#!/usr/bin/env bash
# gate-full.sh — full-gate quality gate handler
# Runs typecheck + tests + lint; exits 2 if any check fails, 0 otherwise.
#
# Required env: TYPECHECK_CMD, TEST_CMD, LINT_CMD
# Optional env: SESSION_START_REF

set -euo pipefail

_GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$_GATE_DIR/../common.sh"
# shellcheck source=gate-helpers.sh
source "$_GATE_DIR/gate-helpers.sh"

: "${TYPECHECK_CMD:?TYPECHECK_CMD must be set}"
: "${TEST_CMD:?TEST_CMD must be set}"
: "${LINT_CMD:?LINT_CMD must be set}"
SESSION_START_REF="${SESSION_START_REF:-}"

SECONDS=0
gate_failed=0

tc_status="skip"
tc_error_count=0
run_check "$TYPECHECK_CMD"
tc_status="$_run_status"
if [[ "$tc_status" == "fail" ]]; then
  tc_error_count="$(extract_count "$_run_output" 'error')"
  gate_failed=1
fi

test_status="skip"
run_check "$TEST_CMD"
test_status="$_run_status"
[[ "$test_status" == "fail" ]] && gate_failed=1

_test_passed=0
_test_failed=0
_test_total=0
[[ "$test_status" != "skip" ]] && extract_test_counts "$_run_output"

lint_status="skip"
lint_warnings=0
run_check "$LINT_CMD"
lint_status="$_run_status"
[[ "$lint_status" == "fail" ]] && gate_failed=1
[[ "$lint_status" != "skip" ]] && lint_warnings="$(extract_count "$_run_output" 'warning')"

debug_artifacts_json="$(collect_debug_artifacts "$SESSION_START_REF")"

jq -n --arg variant "full-gate" --argjson duration "$SECONDS" \
  --arg tc_status "$tc_status" --argjson tc_error_count "$tc_error_count" \
  --arg test_status "$test_status" --argjson test_total "$_test_total" \
  --argjson test_passed "$_test_passed" --arg lint_status "$lint_status" \
  --argjson lint_warnings "$lint_warnings" --argjson debug_artifacts "$debug_artifacts_json" \
  '{ variant: $variant, duration_seconds: $duration,
     typecheck: { status: $tc_status, error_count: $tc_error_count },
     test: { status: $test_status, total: $test_total, passed: $test_passed },
     lint: { status: $lint_status, warnings: $lint_warnings },
     debug_artifacts: $debug_artifacts }'

if (( gate_failed )); then exit 2; fi
exit 0
