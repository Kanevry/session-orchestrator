#!/usr/bin/env bash
# check-plugin-json.sh — Validate plugin.json existence, JSON validity, name, and version fields.
# Usage: check-plugin-json.sh <plugin-root>
# Outputs lines of the form "PASS: ..." / "FAIL: ..."
# Exit 0 = all checks passed; exit 1 = at least one failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"

if [[ $# -lt 1 ]]; then
  die "Usage: check-plugin-json.sh <plugin-root>"
fi

PLUGIN_ROOT="$1"
PLUGIN_JSON="$PLUGIN_ROOT/.claude-plugin/plugin.json"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# ============================================================================
# Check 1: plugin.json exists and is valid JSON
# ============================================================================
echo "--- Check 1: plugin.json exists and is valid JSON ---"

if [[ ! -f "$PLUGIN_JSON" ]]; then
  fail "plugin.json not found at $PLUGIN_JSON"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi
pass "plugin.json exists"

if ! jq empty "$PLUGIN_JSON" 2>/dev/null; then
  fail "plugin.json is not valid JSON"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi
pass "plugin.json is valid JSON"

# ============================================================================
# Check 2: Required field 'name' is present and kebab-case
# ============================================================================
echo ""
echo "--- Check 2: name field ---"

NAME="$(jq -r '.name // empty' "$PLUGIN_JSON")"
if [[ -z "$NAME" ]]; then
  fail "required field 'name' is missing"
else
  pass "name field is present: $NAME"
  if echo "$NAME" | grep -qE '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
    pass "name is valid kebab-case"
  else
    fail "name is not kebab-case: $NAME (expected pattern: ^[a-z][a-z0-9]*(-[a-z0-9]+)*$)"
  fi
fi

# ============================================================================
# Check 3: version matches semver (if present)
# ============================================================================
echo ""
echo "--- Check 3: version field ---"

VERSION="$(jq -r '.version // empty' "$PLUGIN_JSON")"
if [[ -z "$VERSION" ]]; then
  pass "version field not present (optional, skipped)"
else
  # Semver with optional pre-release and build metadata
  if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$'; then
    pass "version matches semver: $VERSION"
  else
    fail "version does not match semver: $VERSION"
  fi
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
