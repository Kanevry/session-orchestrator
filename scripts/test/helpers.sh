#!/usr/bin/env bash
set -u

# Shared globals — must be set before sourcing test-*.sh files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
PARSE_CONFIG="$SCRIPT_DIR/../parse-config.sh"
QUALITY_GATE="$SCRIPT_DIR/../run-quality-gate.sh"
VALIDATE_SCOPE="$SCRIPT_DIR/../validate-wave-scope.sh"
ENFORCE_SCOPE="$SCRIPT_DIR/../../hooks/enforce-scope.sh"
ENFORCE_COMMANDS="$SCRIPT_DIR/../../hooks/enforce-commands.sh"

export PASS=0
export FAIL=0

MASTER_TMPDIR=$(mktemp -d)
export MASTER_TMPDIR
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

assert_exit() {
  local label="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" > /dev/null 2>&1 || actual_code=$?
  assert_eq "$label" "$expected_code" "$actual_code"
}

# Helper: set up a temp project dir with .claude/wave-scope.json
# Additional args after the JSON are subdirectories to create (for realpath resolution)
_scope_dir_counter=0
setup_scope_dir() {
  local json="$1"
  shift
  _scope_dir_counter=$((_scope_dir_counter + 1))
  local tmpdir="$MASTER_TMPDIR/scope_$_scope_dir_counter"
  mkdir -p "$tmpdir/.claude"
  echo "$json" > "$tmpdir/.claude/wave-scope.json"
  # Create subdirectories so realpath can resolve file paths
  while [[ $# -gt 0 ]]; do
    mkdir -p "$tmpdir/$1"
    shift
  done
  echo "$tmpdir"
}
