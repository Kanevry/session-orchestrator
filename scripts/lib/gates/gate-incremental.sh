#!/usr/bin/env bash
# gate-incremental.sh — incremental quality gate handler
# Runs typecheck + targeted tests for changed files; always exits 0.
#
# Required env: TYPECHECK_CMD, TEST_CMD
# Optional env: FILES (comma-separated), SESSION_START_REF

set -euo pipefail

_GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$_GATE_DIR/../common.sh"
# shellcheck source=gate-helpers.sh
source "$_GATE_DIR/gate-helpers.sh"

: "${TYPECHECK_CMD:?TYPECHECK_CMD must be set}"
: "${TEST_CMD:?TEST_CMD must be set}"
FILES="${FILES:-}"
SESSION_START_REF="${SESSION_START_REF:-}"

SECONDS=0
tc_status="skip"
test_status="skip"
errors_json="[]"

run_check "$TYPECHECK_CMD"
tc_status="$_run_status"
[[ "$tc_status" == "fail" ]] && errors_json="$(extract_error_lines_json "$_run_output" 'error')"

test_files=""
test_files="$(resolve_test_files "$FILES" "$SESSION_START_REF")"

if [[ "$TEST_CMD" == "skip" ]]; then
  test_status="skip"
elif [[ -n "$test_files" ]]; then
  run_check "$TEST_CMD -- $test_files"
  test_status="$_run_status"
  if [[ "$test_status" == "fail" ]]; then
    test_errors="$(extract_error_lines_json "$_run_output" '(fail|error|FAIL)')"
    errors_json="$(jq -n --argjson a "$errors_json" --argjson b "$test_errors" '$a + $b')"
  fi
elif [[ -z "$FILES" && -z "$SESSION_START_REF" ]]; then
  run_check "$TEST_CMD"
  test_status="$_run_status"
else
  warn "No test files found for incremental run; skipping tests"
  test_status="skip"
fi

jq -n --arg variant "incremental" --argjson duration "$SECONDS" \
  --arg typecheck "$tc_status" --arg test "$test_status" \
  --argjson errors "$errors_json" \
  '{ variant: $variant, duration_seconds: $duration,
     typecheck: $typecheck, test: $test, errors: $errors }'

exit 0
