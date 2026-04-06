#!/usr/bin/env bash
# run-all.sh — Run all test scripts and report results
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOTAL_PASS=0
TOTAL_FAIL=0

for test_file in "$SCRIPT_DIR"/test-*.sh; do
  test_name="$(basename "$test_file")"
  echo "=== $test_name ==="

  if bash "$test_file"; then
    echo "  --- $test_name: ALL PASSED ---"
  else
    echo "  --- $test_name: SOME FAILURES ---"
    TOTAL_FAIL=1
  fi
  echo ""
done

if [[ "$TOTAL_FAIL" -eq 0 ]]; then
  echo "ALL TEST SUITES PASSED"
  exit 0
else
  echo "SOME TEST SUITES HAD FAILURES"
  exit 1
fi
