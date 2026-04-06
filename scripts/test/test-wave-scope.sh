#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
VALIDATE="$SCRIPT_DIR/../validate-wave-scope.sh"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    ((PASS++)) || true
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    ((FAIL++)) || true
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
echo "=== Test Group 1: Valid Scope ==="

assert_exit "valid fixture exits 0" "0" "$VALIDATE" "$FIXTURES/wave-scope-valid.json"

# Output is valid JSON
valid_output=$("$VALIDATE" "$FIXTURES/wave-scope-valid.json")
valid_json_code=0
echo "$valid_output" | jq empty 2>/dev/null || valid_json_code=$?
assert_eq "valid output is valid JSON" "0" "$valid_json_code"

# Output matches input
input_normalized=$(jq -cS . "$FIXTURES/wave-scope-valid.json")
output_normalized=$(echo "$valid_output" | jq -cS .)
assert_eq "valid output matches input" "$input_normalized" "$output_normalized"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 2: Invalid Scope ==="

assert_exit "invalid fixture exits 1" "1" "$VALIDATE" "$FIXTURES/wave-scope-invalid.json"

# Stderr should contain error messages
invalid_stderr=$("$VALIDATE" "$FIXTURES/wave-scope-invalid.json" 2>&1 >/dev/null || true)
echo "$invalid_stderr" | grep -q "ERROR" 2>/dev/null
has_errors=$?
assert_eq "invalid stderr contains ERROR" "0" "$has_errors"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 3: Discovery Wave ==="

assert_exit "discovery fixture exits 0 (empty allowedPaths)" "0" "$VALIDATE" "$FIXTURES/wave-scope-discovery.json"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 4: Stdin Input ==="

stdin_code=0
cat "$FIXTURES/wave-scope-valid.json" | "$VALIDATE" > /dev/null 2>&1 || stdin_code=$?
assert_eq "valid JSON via stdin exits 0" "0" "$stdin_code"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 5: Missing Fields ==="

base='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/"],"blockedCommands":["rm -rf"]}'

# Missing wave
no_wave=$(echo "$base" | jq 'del(.wave)')
assert_exit "missing wave exits 1" "1" bash -c "echo '$no_wave' | \"$VALIDATE\""

# Missing role
no_role=$(echo "$base" | jq 'del(.role)')
assert_exit "missing role exits 1" "1" bash -c "echo '$no_role' | \"$VALIDATE\""

# Missing enforcement
no_enforcement=$(echo "$base" | jq 'del(.enforcement)')
assert_exit "missing enforcement exits 1" "1" bash -c "echo '$no_enforcement' | \"$VALIDATE\""

# Missing allowedPaths
no_allowed=$(echo "$base" | jq 'del(.allowedPaths)')
assert_exit "missing allowedPaths exits 1" "1" bash -c "echo '$no_allowed' | \"$VALIDATE\""

# Missing blockedCommands
no_blocked=$(echo "$base" | jq 'del(.blockedCommands)')
assert_exit "missing blockedCommands exits 1" "1" bash -c "echo '$no_blocked' | \"$VALIDATE\""

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 6: Security Checks ==="

# allowedPaths with absolute path /etc/passwd
abs_path='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["/etc/passwd"],"blockedCommands":["rm -rf"]}'
assert_exit "absolute path /etc/passwd exits 1" "1" bash -c "echo '$abs_path' | \"$VALIDATE\""

# allowedPaths with path traversal ../secrets
traversal='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["../secrets"],"blockedCommands":["rm -rf"]}'
assert_exit "path traversal ../secrets exits 1" "1" bash -c "echo '$traversal' | \"$VALIDATE\""

# allowedPaths with empty string
empty_entry='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":[""],"blockedCommands":["rm -rf"]}'
assert_exit "empty string in allowedPaths exits 1" "1" bash -c "echo '$empty_entry' | \"$VALIDATE\""

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 7: Invalid JSON ==="

assert_exit "non-JSON input exits 1" "1" bash -c "echo 'this is not json' | \"$VALIDATE\""

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 8: Enforcement Enum ==="

make_scope() {
  local enf="$1"
  echo "{\"wave\":1,\"role\":\"Impl\",\"enforcement\":\"$enf\",\"allowedPaths\":[\"src/\"],\"blockedCommands\":[\"rm -rf\"]}"
}

assert_exit "enforcement strict exits 0" "0" bash -c "echo '$(make_scope strict)' | \"$VALIDATE\""
assert_exit "enforcement warn exits 0" "0" bash -c "echo '$(make_scope warn)' | \"$VALIDATE\""
assert_exit "enforcement off exits 0" "0" bash -c "echo '$(make_scope off)' | \"$VALIDATE\""
assert_exit "enforcement hard exits 1" "1" bash -c "echo '$(make_scope hard)' | \"$VALIDATE\""

# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
