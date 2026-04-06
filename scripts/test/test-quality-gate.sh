#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUALITY_GATE="$SCRIPT_DIR/../run-quality-gate.sh"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit() {
  local label="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" > /dev/null 2>&1 || actual_code=$?
  assert_eq "$label" "$expected_code" "$actual_code"
}

# ---------------------------------------------------------------------------
echo "=== Test Group 1: Argument Validation ==="

assert_exit "missing --variant exits 1" "1" bash "$QUALITY_GATE"
assert_exit "invalid variant exits 1" "1" bash "$QUALITY_GATE" --variant bogus

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 2: Baseline with Skip Commands ==="

SKIP_CONFIG='{"test-command":"skip","typecheck-command":"skip","lint-command":"skip"}'
baseline_output=$(bash "$QUALITY_GATE" --variant baseline --config "$SKIP_CONFIG" 2>/dev/null)
baseline_exit=$?
assert_eq "baseline exits 0" "0" "$baseline_exit"

baseline_variant=$(echo "$baseline_output" | jq -r '.variant')
assert_eq "baseline variant field is baseline" "baseline" "$baseline_variant"

baseline_tc=$(echo "$baseline_output" | jq -r '.typecheck')
assert_eq "baseline typecheck is skip" "skip" "$baseline_tc"

baseline_test=$(echo "$baseline_output" | jq -r '.test')
assert_eq "baseline test is skip" "skip" "$baseline_test"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 3: Baseline JSON Structure ==="

echo "$baseline_output" | jq empty 2>/dev/null
baseline_json_valid=$?
assert_eq "baseline output is valid JSON" "0" "$baseline_json_valid"

for key in variant typecheck test typecheck_output test_output; do
  has_key=$(echo "$baseline_output" | jq "has(\"$key\")")
  assert_eq "baseline has key '$key'" "true" "$has_key"
done

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 4: Full-gate JSON Structure ==="

fullgate_output=$(bash "$QUALITY_GATE" --variant full-gate --config "$SKIP_CONFIG" 2>/dev/null)

echo "$fullgate_output" | jq empty 2>/dev/null
fullgate_json_valid=$?
assert_eq "full-gate output is valid JSON" "0" "$fullgate_json_valid"

for key in variant duration_seconds typecheck test lint debug_artifacts; do
  has_key=$(echo "$fullgate_output" | jq "has(\"$key\")")
  assert_eq "full-gate has key '$key'" "true" "$has_key"
done

# Typecheck, test, lint should each have a status field
for section in typecheck test lint; do
  has_status=$(echo "$fullgate_output" | jq ".${section} | has(\"status\")")
  assert_eq "full-gate ${section} has 'status' field" "true" "$has_status"
done

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 5: Incremental JSON Structure ==="

incremental_output=$(bash "$QUALITY_GATE" --variant incremental --config "$SKIP_CONFIG" 2>/dev/null)

echo "$incremental_output" | jq empty 2>/dev/null
incremental_json_valid=$?
assert_eq "incremental output is valid JSON" "0" "$incremental_json_valid"

for key in variant duration_seconds typecheck test errors; do
  has_key=$(echo "$incremental_output" | jq "has(\"$key\")")
  assert_eq "incremental has key '$key'" "true" "$has_key"
done

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 6: Per-file JSON Structure ==="

perfile_output=$(bash "$QUALITY_GATE" --variant per-file --config "$SKIP_CONFIG" --files dummy.ts 2>/dev/null)

echo "$perfile_output" | jq empty 2>/dev/null
perfile_json_valid=$?
assert_eq "per-file output is valid JSON" "0" "$perfile_json_valid"

for key in variant typecheck test files; do
  has_key=$(echo "$perfile_output" | jq "has(\"$key\")")
  assert_eq "per-file has key '$key'" "true" "$has_key"
done

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 7: Config from File ==="

TMPCONFIG=$(mktemp)
trap 'rm -f "$TMPCONFIG"' EXIT
echo '{"test-command":"skip","typecheck-command":"skip","lint-command":"skip"}' > "$TMPCONFIG"

file_config_output=$(bash "$QUALITY_GATE" --variant baseline --config "$TMPCONFIG" 2>/dev/null)
file_config_exit=$?
assert_eq "config from file exits 0" "0" "$file_config_exit"

file_tc=$(echo "$file_config_output" | jq -r '.typecheck')
assert_eq "config from file typecheck is skip" "skip" "$file_tc"

file_test=$(echo "$file_config_output" | jq -r '.test')
assert_eq "config from file test is skip" "skip" "$file_test"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 8: bash -c pipe handling ==="

pipe_config='{"typecheck-command":"echo pipe_test 2>&1 | tail -1","test-command":"skip"}'
pipe_output=$(bash "$QUALITY_GATE" --variant baseline --config "$pipe_config" 2>/dev/null)
pipe_exit=$?
assert_eq "pipe command exits 0" "0" "$pipe_exit"

echo "$pipe_output" | jq empty 2>/dev/null
pipe_json_valid=$?
assert_eq "pipe output is valid JSON" "0" "$pipe_json_valid"

pipe_tc_output=$(echo "$pipe_output" | jq -r '.typecheck_output')
assert_eq "pipe typecheck_output contains pipe_test" "pipe_test" "$pipe_tc_output"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 9: Command not found (exit 127 → skip) ==="

notfound_config='{"typecheck-command":"nonexistent_cmd_xyz_12345","test-command":"skip"}'
notfound_output=$(bash "$QUALITY_GATE" --variant baseline --config "$notfound_config" 2>/dev/null)
notfound_exit=$?
assert_eq "command-not-found exits 0" "0" "$notfound_exit"

notfound_tc=$(echo "$notfound_output" | jq -r '.typecheck')
assert_eq "command-not-found typecheck is skip" "skip" "$notfound_tc"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 10: Full-gate with real echo commands ==="

echo_config='{"typecheck-command":"echo ok","test-command":"echo Tests 5 passed","lint-command":"echo clean"}'
echo_output=$(bash "$QUALITY_GATE" --variant full-gate --config "$echo_config" 2>/dev/null)
echo_exit=$?
assert_eq "full-gate echo exits 0" "0" "$echo_exit"

echo_tc_status=$(echo "$echo_output" | jq -r '.typecheck.status')
assert_eq "full-gate typecheck status is pass" "pass" "$echo_tc_status"

echo_test_status=$(echo "$echo_output" | jq -r '.test.status')
assert_eq "full-gate test status is pass" "pass" "$echo_test_status"

echo_lint_status=$(echo "$echo_output" | jq -r '.lint.status')
assert_eq "full-gate lint status is pass" "pass" "$echo_lint_status"

echo_test_passed=$(echo "$echo_output" | jq -r '.test.passed')
assert_eq "full-gate test.passed is 5" "5" "$echo_test_passed"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 11: Incremental with skip config ==="

incr_skip_output=$(bash "$QUALITY_GATE" --variant incremental --config "$SKIP_CONFIG" 2>/dev/null)
incr_skip_exit=$?
assert_eq "incremental skip exits 0" "0" "$incr_skip_exit"

echo "$incr_skip_output" | jq empty 2>/dev/null
incr_skip_json_valid=$?
assert_eq "incremental skip output is valid JSON" "0" "$incr_skip_json_valid"

for key in variant duration_seconds typecheck test errors; do
  has_key=$(echo "$incr_skip_output" | jq "has(\"$key\")")
  assert_eq "incremental skip has key '$key'" "true" "$has_key"
done

incr_skip_tc=$(echo "$incr_skip_output" | jq -r '.typecheck')
assert_eq "incremental skip typecheck is skip" "skip" "$incr_skip_tc"

incr_skip_test=$(echo "$incr_skip_output" | jq -r '.test')
assert_eq "incremental skip test is skip" "skip" "$incr_skip_test"

# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
