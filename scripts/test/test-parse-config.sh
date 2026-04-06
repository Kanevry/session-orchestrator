#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
PARSE_CONFIG="$SCRIPT_DIR/../parse-config.sh"

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

# Helper: run parse-config and extract a field with jq
parse_field() {
  local fixture="$1" field="$2"
  bash "$PARSE_CONFIG" "$fixture" 2>/dev/null | jq -r ".[\"$field\"]"
}

# Helper: run parse-config and extract a field as raw JSON
parse_json_field() {
  local fixture="$1" field="$2"
  bash "$PARSE_CONFIG" "$fixture" 2>/dev/null | jq -c ".[\"$field\"]"
}

# ============================================================================
# Test Group 1: Full Config (claude-md-full.md)
# ============================================================================
echo "--- Test Group 1: Full Config ---"

FULL="$FIXTURES/claude-md-full.md"

assert_eq "full: session-types" \
  '["housekeeping","feature","deep"]' \
  "$(parse_json_field "$FULL" "session-types")"

assert_eq "full: agents-per-wave" \
  "4" \
  "$(parse_field "$FULL" "agents-per-wave")"

assert_eq "full: waves" \
  "3" \
  "$(parse_field "$FULL" "waves")"

assert_eq "full: recent-commits" \
  "15" \
  "$(parse_field "$FULL" "recent-commits")"

assert_eq "full: vcs" \
  "github" \
  "$(parse_field "$FULL" "vcs")"

assert_eq "full: mirror" \
  "github" \
  "$(parse_field "$FULL" "mirror")"

assert_eq "full: test-command" \
  "npm test" \
  "$(parse_field "$FULL" "test-command")"

assert_eq "full: typecheck-command" \
  "npx tsc --noEmit" \
  "$(parse_field "$FULL" "typecheck-command")"

assert_eq "full: lint-command" \
  "npx eslint ." \
  "$(parse_field "$FULL" "lint-command")"

assert_eq "full: enforcement" \
  "strict" \
  "$(parse_field "$FULL" "enforcement")"

assert_eq "full: isolation" \
  "worktree" \
  "$(parse_field "$FULL" "isolation")"

assert_eq "full: persistence" \
  "false" \
  "$(parse_field "$FULL" "persistence")"

assert_eq "full: discovery-on-close" \
  "true" \
  "$(parse_field "$FULL" "discovery-on-close")"

assert_eq "full: max-turns" \
  "15" \
  "$(parse_field "$FULL" "max-turns")"

assert_eq "full: discovery-severity-threshold" \
  "medium" \
  "$(parse_field "$FULL" "discovery-severity-threshold")"

assert_eq "full: discovery-confidence-threshold" \
  "70" \
  "$(parse_field "$FULL" "discovery-confidence-threshold")"

assert_eq "full: stale-branch-days" \
  "5" \
  "$(parse_field "$FULL" "stale-branch-days")"

assert_eq "full: stale-issue-days" \
  "14" \
  "$(parse_field "$FULL" "stale-issue-days")"

# ============================================================================
# Test Group 2: Minimal Config (claude-md-minimal.md)
# ============================================================================
echo ""
echo "--- Test Group 2: Minimal Config (defaults) ---"

MINIMAL="$FIXTURES/claude-md-minimal.md"

assert_eq "minimal: agents-per-wave (default)" \
  "6" \
  "$(parse_field "$MINIMAL" "agents-per-wave")"

assert_eq "minimal: waves (default)" \
  "5" \
  "$(parse_field "$MINIMAL" "waves")"

assert_eq "minimal: enforcement (default)" \
  "warn" \
  "$(parse_field "$MINIMAL" "enforcement")"

assert_eq "minimal: persistence (default)" \
  "true" \
  "$(parse_field "$MINIMAL" "persistence")"

assert_eq "minimal: test-command (default)" \
  "pnpm test --run" \
  "$(parse_field "$MINIMAL" "test-command")"

assert_eq "minimal: max-turns (default)" \
  "auto" \
  "$(parse_field "$MINIMAL" "max-turns")"

assert_eq "minimal: vcs (default null)" \
  "null" \
  "$(parse_field "$MINIMAL" "vcs")"

# ============================================================================
# Test Group 3: Partial Config (claude-md-partial.md)
# ============================================================================
echo ""
echo "--- Test Group 3: Partial Config ---"

PARTIAL="$FIXTURES/claude-md-partial.md"

assert_eq "partial: test-command (set)" \
  "pytest" \
  "$(parse_field "$PARTIAL" "test-command")"

assert_eq "partial: enforcement (set)" \
  "strict" \
  "$(parse_field "$PARTIAL" "enforcement")"

assert_eq "partial: waves (set)" \
  "3" \
  "$(parse_field "$PARTIAL" "waves")"

assert_eq "partial: agents-per-wave (default)" \
  "6" \
  "$(parse_field "$PARTIAL" "agents-per-wave")"

assert_eq "partial: persistence (default)" \
  "true" \
  "$(parse_field "$PARTIAL" "persistence")"

# ============================================================================
# Test Group 4: Plain Format (claude-md-plain-format.md)
# ============================================================================
echo ""
echo "--- Test Group 4: Plain Format ---"

PLAIN="$FIXTURES/claude-md-plain-format.md"

assert_eq "plain: session-types" \
  '["feature","deep"]' \
  "$(parse_json_field "$PLAIN" "session-types")"

assert_eq "plain: agents-per-wave" \
  "8" \
  "$(parse_field "$PLAIN" "agents-per-wave")"

assert_eq "plain: test-command" \
  "yarn test" \
  "$(parse_field "$PLAIN" "test-command")"

assert_eq "plain: enforcement" \
  "warn" \
  "$(parse_field "$PLAIN" "enforcement")"

# ============================================================================
# Test Group 4b: Override Syntax (claude-md-overrides.md)
# ============================================================================
echo ""
echo "--- Test Group 4b: Override Syntax ---"

OVERRIDES="$FIXTURES/claude-md-overrides.md"

assert_eq "overrides: agents-per-wave is object" \
  '{"default":6,"deep":18}' \
  "$(parse_json_field "$OVERRIDES" "agents-per-wave")"

assert_eq "overrides: agents-per-wave.default" \
  "6" \
  "$(bash "$PARSE_CONFIG" "$OVERRIDES" 2>/dev/null | jq -r '."agents-per-wave".default')"

assert_eq "overrides: agents-per-wave.deep" \
  "18" \
  "$(bash "$PARSE_CONFIG" "$OVERRIDES" 2>/dev/null | jq -r '."agents-per-wave".deep')"

assert_eq "overrides: waves (plain integer)" \
  "5" \
  "$(parse_field "$OVERRIDES" "waves")"

assert_eq "overrides: valid JSON" \
  "0" \
  "$(bash "$PARSE_CONFIG" "$OVERRIDES" 2>/dev/null | jq . > /dev/null 2>&1; echo $?)"

# ============================================================================
# Test Group 5: Bad Types (claude-md-bad-types.md)
# ============================================================================
echo ""
echo "--- Test Group 5: Bad Types ---"

assert_exit "bad-types: exits 1" \
  "1" \
  bash "$PARSE_CONFIG" "$FIXTURES/claude-md-bad-types.md"

# ============================================================================
# Test Group 6: Missing File
# ============================================================================
echo ""
echo "--- Test Group 6: Missing File ---"

assert_exit "missing file: exits 1" \
  "1" \
  bash "$PARSE_CONFIG" "/tmp/this-file-does-not-exist-$$"

# ============================================================================
# Test Group 7: JSON Output Validity
# ============================================================================
echo ""
echo "--- Test Group 7: JSON Output Validity ---"

full_valid=0
bash "$PARSE_CONFIG" "$FULL" 2>/dev/null | jq . > /dev/null 2>&1 || full_valid=$?
assert_eq "full config: valid JSON" "0" "$full_valid"

minimal_valid=0
bash "$PARSE_CONFIG" "$MINIMAL" 2>/dev/null | jq . > /dev/null 2>&1 || minimal_valid=$?
assert_eq "minimal config: valid JSON" "0" "$minimal_valid"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
