#!/usr/bin/env bash
# check-json-files.sh — Validate hooks and mcpServers JSON file contents.
# Usage: check-json-files.sh <plugin-root>
# Outputs lines of the form "PASS: ..." / "FAIL: ..."
# Exit 0 = all checks passed; exit 1 = at least one failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"

if [[ $# -lt 1 ]]; then
  die "Usage: check-json-files.sh <plugin-root>"
fi

PLUGIN_ROOT="$1"
PLUGIN_JSON="$PLUGIN_ROOT/.claude-plugin/plugin.json"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

CONVENTIONAL_HOOKS="hooks/hooks.json"

# ============================================================================
# Check 5: hooks file is valid JSON (if it's a .json file)
# ============================================================================
echo "--- Check 5: hooks JSON validity ---"

HOOKS_PATH="$(jq -r '.hooks // empty' "$PLUGIN_JSON")"
if [[ -n "$HOOKS_PATH" && "$HOOKS_PATH" == *.json ]]; then
  HOOKS_ABS="$PLUGIN_ROOT/${HOOKS_PATH#./}"
  if [[ -f "$HOOKS_ABS" ]]; then
    if jq empty "$HOOKS_ABS" 2>/dev/null; then
      pass "hooks file is valid JSON"
    else
      fail "hooks file is not valid JSON: $HOOKS_PATH"
    fi
  else
    fail "hooks file not found (already reported above)"
  fi
else
  HOOKS_ABS="$PLUGIN_ROOT/$CONVENTIONAL_HOOKS"
  if [[ -f "$HOOKS_ABS" ]]; then
    if jq empty "$HOOKS_ABS" 2>/dev/null; then
      pass "hooks file is valid JSON (auto-discovered at ./$CONVENTIONAL_HOOKS)"
    else
      fail "hooks file is not valid JSON: ./$CONVENTIONAL_HOOKS"
    fi
  else
    pass "hooks is not a JSON file or not specified (skipped)"
  fi
fi

# ============================================================================
# Check 5b: mcpServers file is valid JSON (if specified)
# ============================================================================
echo ""
echo "--- Check 5b: mcpServers JSON validity ---"

MCP_PATH="$(jq -r '.mcpServers // empty' "$PLUGIN_JSON")"
if [[ -n "$MCP_PATH" && "$MCP_PATH" == *.json ]]; then
  MCP_ABS="$PLUGIN_ROOT/${MCP_PATH#./}"
  if [[ -f "$MCP_ABS" ]]; then
    if jq empty "$MCP_ABS" 2>/dev/null; then
      pass "mcpServers file is valid JSON"
    else
      fail "mcpServers file is not valid JSON: $MCP_PATH"
    fi
  else
    fail "mcpServers file not found (already reported above)"
  fi
else
  MCP_ABS="$PLUGIN_ROOT/.mcp.json"
  if [[ -f "$MCP_ABS" ]]; then
    if jq empty "$MCP_ABS" 2>/dev/null; then
      pass "mcpServers file is valid JSON (auto-discovered at ./.mcp.json)"
    else
      fail "mcpServers file is not valid JSON: ./.mcp.json"
    fi
  else
    pass "mcpServers not found at conventional location (optional, skipped)"
  fi
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
