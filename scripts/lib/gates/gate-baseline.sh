#!/usr/bin/env bash
# gate-baseline.sh — baseline quality gate handler
# Runs typecheck (tail-5) + test (tail-5); informational only, always exits 0.
#
# Required env: TYPECHECK_CMD, TEST_CMD
# Sourced functions: run_check (from gate-helpers.sh via caller)

set -euo pipefail

_GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$_GATE_DIR/../common.sh"
# shellcheck source=gate-helpers.sh
source "$_GATE_DIR/gate-helpers.sh"

: "${TYPECHECK_CMD:?TYPECHECK_CMD must be set}"
: "${TEST_CMD:?TEST_CMD must be set}"

tc_status="skip"
tc_output=""
test_status="skip"
test_output=""

if [[ "$TYPECHECK_CMD" != "skip" ]]; then
  run_check "set -o pipefail; $TYPECHECK_CMD 2>&1 | tail -5"
  tc_status="$_run_status"
  tc_output="$_run_output"
fi

if [[ "$TEST_CMD" != "skip" ]]; then
  run_check "set -o pipefail; $TEST_CMD 2>&1 | tail -5"
  test_status="$_run_status"
  test_output="$_run_output"
fi

jq -n \
  --arg variant "baseline" \
  --arg typecheck "$tc_status" \
  --arg test "$test_status" \
  --arg typecheck_output "$tc_output" \
  --arg test_output "$test_output" \
  '{
    variant: $variant,
    typecheck: $typecheck,
    test: $test,
    typecheck_output: $typecheck_output,
    test_output: $test_output
  }'

exit 0
