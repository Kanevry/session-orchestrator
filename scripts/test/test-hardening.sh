#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARDENING_LIB="$SCRIPT_DIR/../lib/hardening.sh"

# Source in a subshell-safe way — the guard prevents double-source
# shellcheck disable=SC1090
source "$HARDENING_LIB"

PASS=0
FAIL=0

MASTER_TMPDIR=$(mktemp -d)
trap 'rm -rf "$MASTER_TMPDIR"' EXIT

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

assert_true() {
  local label="$1"
  if "${@:2}"; then
    echo "  PASS: $label"
    ((PASS++)) || true
  else
    echo "  FAIL: $label (expected success)"
    ((FAIL++)) || true
  fi
}

assert_false() {
  local label="$1"
  if ! "${@:2}"; then
    echo "  PASS: $label"
    ((PASS++)) || true
  else
    echo "  FAIL: $label (expected failure)"
    ((FAIL++)) || true
  fi
}

# ===========================================================================
echo "=== hardening.sh — path_matches_pattern ==="
# ===========================================================================

# 1: directory prefix match
assert_true "1: 'src/' prefix matches 'src/foo.ts'" \
  path_matches_pattern "src/foo.ts" "src/"

# 2: directory prefix does not match sibling
assert_false "2: 'src/' does not match 'lib/foo.ts'" \
  path_matches_pattern "lib/foo.ts" "src/"

# 3: recursive glob matches any depth
assert_true "3: '**/*.ts' matches 'a/b/c/foo.ts'" \
  path_matches_pattern "a/b/c/foo.ts" "**/*.ts"

# 4: recursive glob inside directory
assert_true "4: 'src/**/*.ts' matches 'src/a/b/foo.ts'" \
  path_matches_pattern "src/a/b/foo.ts" "src/**/*.ts"

# 5: recursive glob rejects non-matching extension
assert_false "5: 'src/**/*.ts' does not match 'src/a/foo.js'" \
  path_matches_pattern "src/a/foo.js" "src/**/*.ts"

# 6: single-segment glob restricts to one directory
assert_false "6: 'src/*.ts' does not match 'src/sub/foo.ts'" \
  path_matches_pattern "src/sub/foo.ts" "src/*.ts"

# 7: single-segment glob accepts same directory
assert_true "7: 'src/*.ts' matches 'src/foo.ts'" \
  path_matches_pattern "src/foo.ts" "src/*.ts"

# 8: exact path match
assert_true "8: exact path matches" \
  path_matches_pattern "docs/README.md" "docs/README.md"

# 9: exact path mismatch
assert_false "9: exact path mismatches" \
  path_matches_pattern "docs/README.md" "docs/CHANGELOG.md"

# 10: empty pattern never matches
assert_false "10: empty pattern does not match" \
  path_matches_pattern "foo.ts" ""

# ===========================================================================
echo "=== hardening.sh — command_matches_blocked ==="
# ===========================================================================

# 11: blocked pattern at start of command
assert_true "11: 'rm -rf' matches 'rm -rf /tmp/foo'" \
  command_matches_blocked "rm -rf /tmp/foo" "rm -rf"

# 12: blocked pattern with word boundary
assert_true "12: 'rm -rf' matches 'sudo rm -rf /'" \
  command_matches_blocked "sudo rm -rf /" "rm -rf"

# 13: blocked pattern does not match substring
assert_false "13: 'rm' does not match 'format'" \
  command_matches_blocked "format my-disk" "rm"

# 14: blocked pattern does not match suffix of another word
assert_false "14: 'push' does not match 'pushup'" \
  command_matches_blocked "run pushup" "push"

# 15: empty pattern never matches
assert_false "15: empty blocked pattern does not match" \
  command_matches_blocked "rm -rf /" ""

# ===========================================================================
echo "=== hardening.sh — find_scope_file ==="
# ===========================================================================

# Set up a fake project root with claude scope file
FAKE_ROOT="$MASTER_TMPDIR/proj1"
mkdir -p "$FAKE_ROOT/.claude"
echo '{"enforcement":"warn"}' > "$FAKE_ROOT/.claude/wave-scope.json"

# 16: finds claude scope file
SCOPE=$(find_scope_file "$FAKE_ROOT")
assert_eq "16: finds .claude/wave-scope.json" "$FAKE_ROOT/.claude/wave-scope.json" "$SCOPE"

# 17: codex takes precedence over claude
mkdir -p "$FAKE_ROOT/.codex"
echo '{"enforcement":"strict"}' > "$FAKE_ROOT/.codex/wave-scope.json"
SCOPE=$(find_scope_file "$FAKE_ROOT")
assert_eq "17: .codex/ takes precedence over .claude/" "$FAKE_ROOT/.codex/wave-scope.json" "$SCOPE"

# 18: cursor takes precedence over codex
mkdir -p "$FAKE_ROOT/.cursor"
echo '{"enforcement":"off"}' > "$FAKE_ROOT/.cursor/wave-scope.json"
SCOPE=$(find_scope_file "$FAKE_ROOT")
assert_eq "18: .cursor/ takes precedence over .codex/" "$FAKE_ROOT/.cursor/wave-scope.json" "$SCOPE"

# 19: no scope file returns empty
EMPTY_ROOT="$MASTER_TMPDIR/empty"
mkdir -p "$EMPTY_ROOT"
SCOPE=$(find_scope_file "$EMPTY_ROOT")
assert_eq "19: no scope file returns empty" "" "$SCOPE"

# ===========================================================================
echo "=== hardening.sh — get_enforcement_level ==="
# ===========================================================================

# 20: strict level read from scope file
STRICT_FILE="$MASTER_TMPDIR/strict.json"
echo '{"enforcement":"strict"}' > "$STRICT_FILE"
LEVEL=$(get_enforcement_level "$STRICT_FILE")
assert_eq "20: reads strict enforcement" "strict" "$LEVEL"

# 21: warn level read
WARN_FILE="$MASTER_TMPDIR/warn.json"
echo '{"enforcement":"warn"}' > "$WARN_FILE"
LEVEL=$(get_enforcement_level "$WARN_FILE")
assert_eq "21: reads warn enforcement" "warn" "$LEVEL"

# 22: missing enforcement defaults to strict (fail-closed)
NO_FIELD_FILE="$MASTER_TMPDIR/no-field.json"
echo '{}' > "$NO_FIELD_FILE"
LEVEL=$(get_enforcement_level "$NO_FIELD_FILE")
assert_eq "22: missing enforcement defaults to strict" "strict" "$LEVEL"

# 23: malformed JSON defaults to strict
BAD_FILE="$MASTER_TMPDIR/bad.json"
echo 'not-json-at-all' > "$BAD_FILE"
LEVEL=$(get_enforcement_level "$BAD_FILE")
assert_eq "23: malformed JSON defaults to strict" "strict" "$LEVEL"

# ===========================================================================
echo "=== hardening.sh — gate_enabled (#77 per-gate toggles) ==="
# ===========================================================================

# 24: gate enabled by default when .gates missing
NO_GATES_FILE="$MASTER_TMPDIR/no-gates.json"
echo '{"enforcement":"strict"}' > "$NO_GATES_FILE"
assert_true "24: path-guard enabled when .gates absent" \
  gate_enabled "$NO_GATES_FILE" "path-guard"

# 25: gate explicitly disabled
DISABLED_FILE="$MASTER_TMPDIR/disabled.json"
echo '{"gates":{"path-guard":false,"command-guard":true}}' > "$DISABLED_FILE"
assert_false "25: path-guard disabled via .gates" \
  gate_enabled "$DISABLED_FILE" "path-guard"

# 26: different gate still enabled in same file
assert_true "26: command-guard enabled while path-guard disabled" \
  gate_enabled "$DISABLED_FILE" "command-guard"

# 27: unknown gate defaults to enabled
assert_true "27: unknown gate defaults to enabled" \
  gate_enabled "$DISABLED_FILE" "made-up-gate"

# 28: missing scope file allows gate
assert_true "28: missing scope file allows gate" \
  gate_enabled "/nonexistent/path.json" "path-guard"

# ===========================================================================
echo "=== hardening.sh — suggest_for_* (#78 actionable suggestions) ==="
# ===========================================================================

# 29: scope violation suggestion includes allowed paths
SUGGESTION=$(suggest_for_scope_violation "bad/path.ts" "src/, docs/")
case "$SUGGESTION" in
  *"Allowed paths"*"src/, docs/"*"bad/path.ts"*)
    echo "  PASS: 29: scope-violation suggestion references allowed paths + file"
    ((PASS++)) || true
    ;;
  *)
    echo "  FAIL: 29: scope-violation suggestion shape"
    echo "    got: $SUGGESTION"
    ((FAIL++)) || true
    ;;
esac

# 30: empty allowed list gives different guidance
SUGGESTION=$(suggest_for_scope_violation "bad/path.ts" "")
case "$SUGGESTION" in
  *"No paths are currently allowed"*)
    echo "  PASS: 30: empty allowed list gives specific guidance"
    ((PASS++)) || true
    ;;
  *)
    echo "  FAIL: 30: empty allowed list guidance"
    echo "    got: $SUGGESTION"
    ((FAIL++)) || true
    ;;
esac

# 31: rm -rf suggestion mentions destructive deletion
SUGGESTION=$(suggest_for_command_block "rm -rf")
case "$SUGGESTION" in
  *"Destructive deletion"*)
    echo "  PASS: 31: rm -rf suggestion mentions destructive deletion"
    ((PASS++)) || true
    ;;
  *)
    echo "  FAIL: 31: rm -rf suggestion content"
    ((FAIL++)) || true
    ;;
esac

# 32: git push --force suggestion mentions force-with-lease alternative
SUGGESTION=$(suggest_for_command_block "git push --force")
case "$SUGGESTION" in
  *"force-with-lease"*)
    echo "  PASS: 32: force-push suggestion names force-with-lease alternative"
    ((PASS++)) || true
    ;;
  *)
    echo "  FAIL: 32: force-push suggestion content"
    ((FAIL++)) || true
    ;;
esac

# 33: generic suggestion for unknown pattern
SUGGESTION=$(suggest_for_command_block "obscure-command")
case "$SUGGESTION" in
  *"obscure-command"*"not permitted"*)
    echo "  PASS: 33: unknown pattern gets generic suggestion with pattern name"
    ((PASS++)) || true
    ;;
  *)
    echo "  FAIL: 33: generic suggestion content"
    ((FAIL++)) || true
    ;;
esac

# ===========================================================================
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [[ "$FAIL" -eq 0 ]]; then
  echo "  --- test-hardening.sh: ALL PASSED ---"
  exit 0
else
  echo "  --- test-hardening.sh: FAILURES ---"
  exit 1
fi
