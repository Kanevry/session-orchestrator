#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATE="$SCRIPT_DIR/../validate-plugin.sh"
PLUGIN_ROOT="$(git rev-parse --show-toplevel)"

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
echo "=== Test Group 1: Real Plugin Structure ==="

assert_exit "real plugin passes validation" "0" bash "$VALIDATE" "$PLUGIN_ROOT"

# Verify output contains PASS lines
real_output=$(bash "$VALIDATE" "$PLUGIN_ROOT" 2>&1 || true)
has_pass=1
echo "$real_output" | grep -q "PASS" 2>/dev/null && has_pass=0
assert_eq "output contains PASS lines" "0" "$has_pass"

has_zero_fail=1
echo "$real_output" | grep -qE "0 failed" 2>/dev/null && has_zero_fail=0
assert_eq "output shows 0 failures" "0" "$has_zero_fail"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 2: Missing plugin.json ==="

MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

# Init a git repo so git rev-parse works inside the mock
git -C "$MOCK_DIR" init --quiet

assert_exit "missing plugin.json exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 3: Invalid JSON in plugin.json ==="

mkdir -p "$MOCK_DIR/.claude-plugin"
echo "not valid json {{{" > "$MOCK_DIR/.claude-plugin/plugin.json"

assert_exit "invalid JSON exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 4: Missing name field ==="

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "version": "1.0.0",
  "description": "test plugin"
}
JSON

assert_exit "missing name exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 5: Invalid name (not kebab-case) ==="

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "MyPlugin",
  "version": "1.0.0"
}
JSON

assert_exit "PascalCase name exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "my_plugin",
  "version": "1.0.0"
}
JSON

assert_exit "snake_case name exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 6: Invalid version ==="

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "not-a-version"
}
JSON

assert_exit "invalid version exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 7: Valid semver variants ==="

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "2.0.0-alpha.14"
}
JSON

assert_exit "semver with pre-release exits 0" "0" bash "$VALIDATE" "$MOCK_DIR"

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "1.0.0"
}
JSON

assert_exit "plain semver exits 0" "0" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 8: Broken component paths ==="

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "1.0.0",
  "commands": "./commands",
  "agents": "./agents"
}
JSON

assert_exit "non-existent component paths exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 9: Valid component paths ==="

mkdir -p "$MOCK_DIR/commands" "$MOCK_DIR/agents"
echo "# test command" > "$MOCK_DIR/commands/test.md"
cat > "$MOCK_DIR/agents/test-agent.md" <<'AGENT'
---
name: test-agent
description: A test agent
model: sonnet
color: blue
---

Agent instructions here.
AGENT

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "1.0.0",
  "commands": "./commands",
  "agents": "./agents"
}
JSON

assert_exit "valid component paths exits 0" "0" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 10: Agent missing frontmatter fields ==="

cat > "$MOCK_DIR/agents/bad-agent.md" <<'AGENT'
---
name: bad-agent
description: Missing model and color
---

Agent instructions here.
AGENT

assert_exit "agent missing model+color exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

# Clean up bad agent for next test
rm "$MOCK_DIR/agents/bad-agent.md"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 11: Agent with no frontmatter ==="

echo "No frontmatter at all" > "$MOCK_DIR/agents/no-front.md"

assert_exit "agent without frontmatter exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

rm "$MOCK_DIR/agents/no-front.md"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 12: Invalid hooks JSON ==="

mkdir -p "$MOCK_DIR/hooks"
echo "not json" > "$MOCK_DIR/hooks/hooks.json"

cat > "$MOCK_DIR/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "1.0.0",
  "commands": "./commands",
  "agents": "./agents",
  "hooks": "./hooks/hooks.json"
}
JSON

assert_exit "invalid hooks JSON exits 1" "1" bash "$VALIDATE" "$MOCK_DIR"

# Fix hooks for final sanity check
echo '[]' > "$MOCK_DIR/hooks/hooks.json"

assert_exit "valid hooks JSON exits 0" "0" bash "$VALIDATE" "$MOCK_DIR"

# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
