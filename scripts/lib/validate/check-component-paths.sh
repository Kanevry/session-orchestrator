#!/usr/bin/env bash
# check-component-paths.sh — Validate plugin component path fields resolve to real locations.
# Covers: commands, agents, hooks, mcpServers path resolution from plugin.json.
# Usage: check-component-paths.sh <plugin-root>
# Outputs lines of the form "PASS: ..." / "FAIL: ..."
# Exit 0 = all checks passed; exit 1 = at least one failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"

if [[ $# -lt 1 ]]; then
  die "Usage: check-component-paths.sh <plugin-root>"
fi

PLUGIN_ROOT="$1"
PLUGIN_JSON="$PLUGIN_ROOT/.claude-plugin/plugin.json"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# Conventional auto-discovery locations
CONVENTIONAL_COMMANDS="commands"
CONVENTIONAL_AGENTS="agents"
CONVENTIONAL_HOOKS="hooks/hooks.json"

# ============================================================================
# Check 4: Component path fields resolve to real files/directories
# ============================================================================
echo "--- Check 4: component paths ---"

check_component_path() {
  local field="$1"
  local conventional="$2"        # relative path under PLUGIN_ROOT for auto-discovery
  local optional="${3:-false}"   # "true" → missing is a PASS, not a FAIL
  local rel_path
  rel_path="$(jq -r ".$field // empty" "$PLUGIN_JSON")"

  if [[ -z "$rel_path" ]]; then
    local abs_path="$PLUGIN_ROOT/$conventional"
    if [[ -e "$abs_path" ]]; then
      pass "$field auto-discovered at: ./$conventional"
    elif [[ "$optional" == "true" ]]; then
      pass "$field not found at conventional location (optional, skipped)"
    else
      fail "$field not found at conventional location: ./$conventional"
    fi
    return
  fi

  if [[ "$rel_path" != ./* ]]; then
    fail "$field path does not start with ./: $rel_path"
    return
  fi

  local abs_path="$PLUGIN_ROOT/${rel_path#./}"

  if [[ -e "$abs_path" ]]; then
    pass "$field resolves to: $rel_path"
  else
    fail "$field path does not exist: $rel_path (resolved to $abs_path)"
  fi
}

check_component_path "commands"   "$CONVENTIONAL_COMMANDS"
check_component_path "agents"     "$CONVENTIONAL_AGENTS"
check_component_path "hooks"      "$CONVENTIONAL_HOOKS"
check_component_path "mcpServers" ".mcp.json" "true"

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
