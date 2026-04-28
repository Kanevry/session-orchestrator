#!/usr/bin/env bash
# gate-per-file.sh — per-file quality gate handler
# Runs typecheck on whole project + tests scoped to specified files; exits 0.
#
# Required env: TYPECHECK_CMD, TEST_CMD
# Optional env: FILES (comma-separated)

set -euo pipefail

_GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$_GATE_DIR/../common.sh"
# shellcheck source=gate-helpers.sh
source "$_GATE_DIR/gate-helpers.sh"

: "${TYPECHECK_CMD:?TYPECHECK_CMD must be set}"
: "${TEST_CMD:?TEST_CMD must be set}"
FILES="${FILES:-}"

if [[ -z "$FILES" ]]; then
  warn "per-file variant requires --files; skipping file-specific tests"
fi

tc_status="skip"
test_status="skip"
files_json="[]"

[[ -n "$FILES" ]] && files_json="$(csv_to_json_array "$FILES")"

# Typecheck runs on the whole project, not per-file
run_check "$TYPECHECK_CMD"
tc_status="$_run_status"

if [[ "$TEST_CMD" == "skip" ]]; then
  test_status="skip"
elif [[ -n "$FILES" ]]; then
  file_args="$(echo "$FILES" | tr ',' ' ')"
  run_check "$TEST_CMD -- $file_args"
  test_status="$_run_status"
else
  test_status="skip"
fi

jq -n \
  --arg variant "per-file" \
  --arg typecheck "$tc_status" \
  --arg test "$test_status" \
  --argjson files "$files_json" \
  '{
    variant: $variant,
    typecheck: $typecheck,
    test: $test,
    files: $files
  }'

exit 0
