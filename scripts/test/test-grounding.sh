#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
PARSE_CONFIG="$SCRIPT_DIR/../parse-config.sh"
PLAN_VERIFICATION="$SCRIPT_DIR/../../skills/session-end/plan-verification.md"
SESSION_CONFIG_REF="$SCRIPT_DIR/../../docs/session-config-reference.md"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    ((++PASS))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    ((++FAIL))
  fi
}

assert_exit() {
  local label="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" > /dev/null 2>&1 || actual_code=$?
  assert_eq "$label" "$expected_code" "$actual_code"
}

assert_stderr_contains() {
  local label="$1" pattern="$2"
  shift 2
  local stderr_out
  stderr_out="$("$@" 2>&1 >/dev/null || true)"
  if echo "$stderr_out" | grep -q "$pattern"; then
    echo "  PASS: $label"
    ((++PASS))
  else
    echo "  FAIL: $label"
    echo "    pattern not found in stderr: $pattern"
    echo "    stderr was: $stderr_out"
    ((++FAIL))
  fi
}

assert_contains() {
  local label="$1" pattern="$2" file="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "  PASS: $label"
    ((++PASS))
  else
    echo "  FAIL: $label"
    echo "    pattern not found: $pattern"
    echo "    in file: $file"
    ((++FAIL))
  fi
}

# Helper: run parse-config and extract a field with jq
parse_field() {
  local fixture="$1" field="$2"
  bash "$PARSE_CONFIG" "$fixture" 2>/dev/null | jq -r ".[\"$field\"]"
}

echo "--- Test Group: grounding-check parse-config integration ---"

MINIMAL="$FIXTURES/claude-md-minimal.md"
FULL="$FIXTURES/claude-md-full.md"

# 1. parse-config.sh exposes grounding-check field (minimal fixture — default true)
assert_eq "grounding-check: minimal fixture default is true" \
  "true" \
  "$(parse_field "$MINIMAL" "grounding-check")"

# 2. parse-config.sh honors grounding-check: false from full fixture
assert_eq "grounding-check: full fixture override is false" \
  "false" \
  "$(parse_field "$FULL" "grounding-check")"

echo ""
echo "--- Test Group: plan-verification.md content checks ---"

# 3. plan-verification.md contains the 1.1a heading
assert_contains \
  "plan-verification.md: contains ### 1.1a File-Level Grounding heading" \
  "### 1.1a File-Level Grounding" \
  "$PLAN_VERIFICATION"

# 4. plan-verification.md 1.1a section references session-start-ref
assert_contains \
  "plan-verification.md: 1.1a references session-start-ref" \
  "session-start-ref" \
  "$PLAN_VERIFICATION"

# 5. plan-verification.md 1.1a section references git diff --name-only
assert_contains \
  "plan-verification.md: 1.1a references git diff --name-only" \
  "git diff --name-only" \
  "$PLAN_VERIFICATION"

# 6. plan-verification.md 1.1a section documents the grounding metrics field
assert_contains \
  "plan-verification.md: 1.1a documents grounding metrics field" \
  '"grounding"' \
  "$PLAN_VERIFICATION"

# 7. plan-verification.md 1.1a is gated (mentions grounding-check)
assert_contains \
  "plan-verification.md: 1.1a gate mentions grounding-check" \
  "grounding-check" \
  "$PLAN_VERIFICATION"

# 8. plan-verification.md 1.1a appears between sections 1.1 and 1.2 (line ordering)
LINE_11=$(grep -n "^### 1.1 Done Items" "$PLAN_VERIFICATION" | head -1 | cut -d: -f1)
LINE_11A=$(grep -n "^### 1.1a File-Level Grounding" "$PLAN_VERIFICATION" | head -1 | cut -d: -f1)
LINE_12=$(grep -n "^### 1.2 Partially Done Items" "$PLAN_VERIFICATION" | head -1 | cut -d: -f1)

if [[ -n "$LINE_11" && -n "$LINE_11A" && -n "$LINE_12" ]] \
   && [[ "$LINE_11" -lt "$LINE_11A" ]] \
   && [[ "$LINE_11A" -lt "$LINE_12" ]]; then
  echo "  PASS: plan-verification.md: 1.1a is between 1.1 and 1.2 (lines $LINE_11 < $LINE_11A < $LINE_12)"
  ((++PASS))
else
  echo "  FAIL: plan-verification.md: 1.1a is NOT correctly positioned between 1.1 and 1.2"
  echo "    1.1 line: ${LINE_11:-not found}, 1.1a line: ${LINE_11A:-not found}, 1.2 line: ${LINE_12:-not found}"
  ((++FAIL))
fi

echo ""
echo "--- Test Group: docs/session-config-reference.md ---"

# 9. docs/session-config-reference.md documents grounding-check
assert_contains \
  "session-config-reference.md: documents grounding-check" \
  "grounding-check" \
  "$SESSION_CONFIG_REF"

# ============================================================================
echo ""
echo "--- Test Group: grounding-check invalid-value error paths ---"

BAD="$FIXTURES/claude-md-grounding-bad.md"

# 10. parse-config.sh exits non-zero when grounding-check has an invalid value
assert_exit "grounding-check: invalid value 'maybe' causes exit 1" \
  "1" \
  bash "$PARSE_CONFIG" "$BAD"

# 11. error message mentions the field name 'grounding-check'
assert_stderr_contains "grounding-check: error message names the field" \
  "grounding-check" \
  bash "$PARSE_CONFIG" "$BAD"

# 12. error message mentions the invalid value
assert_stderr_contains "grounding-check: error message contains the bad value" \
  "maybe" \
  bash "$PARSE_CONFIG" "$BAD"

# ============================================================================
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
