#!/usr/bin/env bash
# validate-plugin.sh — Validate plugin structure against the Claude Code Plugin API
# Part of Session Orchestrator v2.0
#
# Usage: validate-plugin.sh [<plugin-root>]
#
# If <plugin-root> is omitted, uses `git rev-parse --show-toplevel`.
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more validation failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_jq

PASS=0
FAIL=0

pass() {
  echo "  PASS: $1"
  ((PASS++)) || true
}

fail() {
  echo "  FAIL: $1"
  ((FAIL++)) || true
}

# Resolve plugin root
if [[ -n "${1:-}" ]]; then
  PLUGIN_ROOT="$1"
else
  PLUGIN_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git repository"
fi

PLUGIN_JSON="$PLUGIN_ROOT/.claude-plugin/plugin.json"

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

# ============================================================================
# Check 4: Component path fields resolve to real files/directories
# ============================================================================
echo ""
echo "--- Check 4: component paths ---"

check_component_path() {
  local field="$1"
  local rel_path
  rel_path="$(jq -r ".$field // empty" "$PLUGIN_JSON")"

  if [[ -z "$rel_path" ]]; then
    pass "$field not specified (optional, skipped)"
    return
  fi

  # Paths must start with ./
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

check_component_path "commands"
check_component_path "agents"
check_component_path "hooks"
check_component_path "mcpServers"

# ============================================================================
# Check 5: hooks file is valid JSON (if it's a .json file)
# ============================================================================
echo ""
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
  pass "hooks is not a JSON file or not specified (skipped)"
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
  pass "mcpServers is not a JSON file or not specified (skipped)"
fi

# ============================================================================
# Check 6: Agent .md files have valid YAML frontmatter
# ============================================================================
echo ""
echo "--- Check 6: agent frontmatter ---"

AGENTS_PATH="$(jq -r '.agents // empty' "$PLUGIN_JSON")"
if [[ -n "$AGENTS_PATH" ]]; then
  AGENTS_DIR="$PLUGIN_ROOT/${AGENTS_PATH#./}"
  if [[ -d "$AGENTS_DIR" ]]; then
    AGENT_COUNT=0
    for agent_file in "$AGENTS_DIR"/*.md; do
      [[ -f "$agent_file" ]] || continue
      ((AGENT_COUNT++)) || true
      agent_name="$(basename "$agent_file")"

      # Extract YAML frontmatter (between first --- and second ---)
      frontmatter="$(sed -n '/^---$/,/^---$/p' "$agent_file" | sed '1d;$d')"

      if [[ -z "$frontmatter" ]]; then
        fail "$agent_name: missing YAML frontmatter"
        continue
      fi

      REQUIRED_FIELDS=("name" "description" "model" "color")
      all_present=true
      missing_fields=()
      for field in "${REQUIRED_FIELDS[@]}"; do
        if ! echo "$frontmatter" | grep -qE "^${field}:"; then
          all_present=false
          missing_fields+=("$field")
        fi
      done

      if $all_present; then
        pass "$agent_name: all required frontmatter fields present"
      else
        fail "$agent_name: missing frontmatter fields: ${missing_fields[*]}"
      fi
    done

    if [[ $AGENT_COUNT -eq 0 ]]; then
      fail "agents directory is empty (no .md files)"
    fi
  else
    fail "agents path is not a directory: $AGENTS_PATH"
  fi
else
  pass "agents path not specified (skipped)"
fi

# ============================================================================
# Check 7: Command .md files exist
# ============================================================================
echo ""
echo "--- Check 7: command files ---"

COMMANDS_PATH="$(jq -r '.commands // empty' "$PLUGIN_JSON")"
if [[ -n "$COMMANDS_PATH" ]]; then
  COMMANDS_DIR="$PLUGIN_ROOT/${COMMANDS_PATH#./}"
  if [[ -d "$COMMANDS_DIR" ]]; then
    CMD_COUNT=0
    for cmd_file in "$COMMANDS_DIR"/*.md; do
      [[ -f "$cmd_file" ]] || continue
      ((CMD_COUNT++)) || true
    done

    if [[ $CMD_COUNT -gt 0 ]]; then
      pass "commands directory contains $CMD_COUNT .md files"
    else
      fail "commands directory is empty (no .md files)"
    fi
  else
    fail "commands path is not a directory: $COMMANDS_PATH"
  fi
else
  pass "commands path not specified (skipped)"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
