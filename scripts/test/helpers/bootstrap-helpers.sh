#!/usr/bin/env bash
# bootstrap-helpers.sh — shared test helpers for bootstrap test suite.
# Source this file; it defines functions only (no side effects on sourcing).
# Usage: source "$(dirname "$0")/helpers/bootstrap-helpers.sh"

# --------------------------------------------------------------------------
# Pass/fail counters — caller must declare PASS=0 FAIL=0 before sourcing.
# --------------------------------------------------------------------------

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$(( FAIL + 1 ))
  fi
}

# Checks existence of a file or directory (uses -e to handle both).
assert_file_exists() {
  local label="$1" path="$2"
  if [[ -e "$path" ]]; then
    echo "  PASS: $label"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: $label"
    echo "    file not found: $path"
    FAIL=$(( FAIL + 1 ))
  fi
}

# Checks that a regular file does NOT contain the given string.
assert_file_not_contains() {
  local label="$1" needle="$2" file="$3"
  if ! grep -qF "$needle" "$file" 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: $label"
    echo "    file should not contain: $needle"
    echo "    file: $file"
    FAIL=$(( FAIL + 1 ))
  fi
}

# --------------------------------------------------------------------------
# Tempdir management — TMPDIRS must be declared in the caller's scope first.
# Callers: declare TMPDIRS=() and trap cleanup EXIT before calling make_tempdir.
# --------------------------------------------------------------------------

make_tempdir() {
  local d
  d="$(mktemp -d)"
  TMPDIRS+=("$d")
  echo "$d"
}

cleanup() {
  for d in "${TMPDIRS[@]+"${TMPDIRS[@]}"}"; do
    rm -rf "$d"
  done
}
