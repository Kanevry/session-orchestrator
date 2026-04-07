#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARSE_CONFIG="$SCRIPT_DIR/../parse-config.sh"

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

# ===========================================================================
echo "=== AGENTS.md Config Parsing Tests ==="
# ===========================================================================

# Setup: create a temp AGENTS.md fixture
FIXTURE_DIR="$MASTER_TMPDIR/fixture"
mkdir -p "$FIXTURE_DIR"
cat > "$FIXTURE_DIR/AGENTS.md" << 'MDEOF'
# My Project

## Session Config

session-types: feature, deep
agents-per-wave: 4
waves: 3
persistence: true
enforcement: strict
vcs: github

## Other Section
This should not be parsed.
MDEOF

# 1: Parse exits 0
agents_json=$(bash "$PARSE_CONFIG" "$FIXTURE_DIR/AGENTS.md" 2>/dev/null)
agents_exit=$?
assert_eq "1: AGENTS.md parse exits 0" "0" "$agents_exit"

# 2: session-types contains feature and deep
types_csv=$(echo "$agents_json" | jq -r '."session-types" | join(",")')
assert_eq "2: session-types" "feature,deep" "$types_csv"

# 3: agents-per-wave is 4
apw=$(echo "$agents_json" | jq -r '."agents-per-wave"')
assert_eq "3: agents-per-wave is 4" "4" "$apw"

# 4: waves is 3
waves=$(echo "$agents_json" | jq -r '.waves')
assert_eq "4: waves is 3" "3" "$waves"

# 5: persistence is true
persist=$(echo "$agents_json" | jq -r '.persistence')
assert_eq "5: persistence is true" "true" "$persist"

# 6: enforcement is strict
enforce=$(echo "$agents_json" | jq -r '.enforcement')
assert_eq "6: enforcement is strict" "strict" "$enforce"

# 7: vcs is github
vcs=$(echo "$agents_json" | jq -r '.vcs')
assert_eq "7: vcs is github" "github" "$vcs"

# 8: Auto-detection — SO_CONFIG_FILE=AGENTS.md, run parse-config without args
AUTO_DIR="$MASTER_TMPDIR/auto"
mkdir -p "$AUTO_DIR"
cat > "$AUTO_DIR/AGENTS.md" << 'MDEOF'
# Auto Project

## Session Config

session-types: housekeeping
agents-per-wave: 2
waves: 1
persistence: false
enforcement: off

## Other
Ignored.
MDEOF

auto_json=$(cd "$AUTO_DIR" && SO_CONFIG_FILE=AGENTS.md bash "$PARSE_CONFIG" 2>/dev/null)
auto_exit=$?
assert_eq "8a: auto-detect AGENTS.md exits 0" "0" "$auto_exit"

auto_types=$(echo "$auto_json" | jq -r '."session-types" | join(",")')
assert_eq "8b: auto-detect session-types" "housekeeping" "$auto_types"

auto_apw=$(echo "$auto_json" | jq -r '."agents-per-wave"')
assert_eq "8c: auto-detect agents-per-wave" "2" "$auto_apw"

auto_persist=$(echo "$auto_json" | jq -r '.persistence')
assert_eq "8d: auto-detect persistence" "false" "$auto_persist"

auto_enforce=$(echo "$auto_json" | jq -r '.enforcement')
assert_eq "8e: auto-detect enforcement" "off" "$auto_enforce"

# ===========================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] || exit 1
