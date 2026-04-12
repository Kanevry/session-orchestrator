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

# Conventional auto-discovery locations (used when plugin.json omits the field)
CONVENTIONAL_COMMANDS="commands"
CONVENTIONAL_AGENTS="agents"
CONVENTIONAL_HOOKS="hooks/hooks.json"
# .mcp.json is optional — absence is not a failure

check_component_path() {
  local field="$1"
  local conventional="$2"        # relative path under PLUGIN_ROOT for auto-discovery
  local optional="${3:-false}"   # "true" → missing is a PASS, not a FAIL
  local rel_path
  rel_path="$(jq -r ".$field // empty" "$PLUGIN_JSON")"

  if [[ -z "$rel_path" ]]; then
    # Auto-discover: check conventional location on disk
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

  # plugin.json has the field — validate it (existing behavior)
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

check_component_path "commands"   "$CONVENTIONAL_COMMANDS"
check_component_path "agents"     "$CONVENTIONAL_AGENTS"
check_component_path "hooks"      "$CONVENTIONAL_HOOKS"
check_component_path "mcpServers" ".mcp.json" "true"

# ============================================================================
# Check 5: hooks file is valid JSON (if it's a .json file)
# ============================================================================
echo ""
echo "--- Check 5: hooks JSON validity ---"

HOOKS_PATH="$(jq -r '.hooks // empty' "$PLUGIN_JSON")"
if [[ -n "$HOOKS_PATH" && "$HOOKS_PATH" == *.json ]]; then
  # plugin.json specifies a hooks path — validate it
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
  # Fall back to conventional location: hooks/hooks.json
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
  # plugin.json specifies an mcpServers path — validate it
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
  # Fall back to conventional location: .mcp.json (optional)
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

# ============================================================================
# Check 6: Agent .md files have valid YAML frontmatter
# ============================================================================
echo ""
echo "--- Check 6: agent frontmatter ---"

AGENTS_PATH="$(jq -r '.agents // empty' "$PLUGIN_JSON")"
if [[ -n "$AGENTS_PATH" ]]; then
  AGENTS_DIR="$PLUGIN_ROOT/${AGENTS_PATH#./}"
else
  # Auto-discover conventional location
  AGENTS_DIR="$PLUGIN_ROOT/$CONVENTIONAL_AGENTS"
fi

validate_agents_dir() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    AGENT_COUNT=0
    for agent_file in "$dir"/*.md; do
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

      # ------------------------------------------------------------------
      # Format validation (only when fields are present)
      # ------------------------------------------------------------------

      # description: must be an inline value, not a YAML block scalar (> or |)
      if echo "$frontmatter" | grep -qE "^description:"; then
        desc_val=$(echo "$frontmatter" | grep -E "^description:" | sed 's/^description: *//')
        if [[ "$desc_val" =~ ^[\>\|] ]]; then
          fail "$agent_name: description must be an inline string, not a YAML block scalar (got: '$desc_val')"
        fi
      fi

      # model: must be one of inherit | sonnet | opus | haiku
      if echo "$frontmatter" | grep -qE "^model:"; then
        model_val=$(echo "$frontmatter" | grep -E "^model:" | sed 's/^model: *//')
        if ! echo "$model_val" | grep -qE "^(inherit|sonnet|opus|haiku)$"; then
          fail "$agent_name: model must be one of inherit|sonnet|opus|haiku (got: '$model_val')"
        fi
      fi

      # color: must be one of blue | cyan | green | yellow | magenta | red
      if echo "$frontmatter" | grep -qE "^color:"; then
        color_val=$(echo "$frontmatter" | grep -E "^color:" | sed 's/^color: *//')
        if ! echo "$color_val" | grep -qE "^(blue|cyan|green|yellow|magenta|red)$"; then
          fail "$agent_name: color must be one of blue|cyan|green|yellow|magenta|red (got: '$color_val')"
        fi
      fi

      # tools: optional — but when present must be a comma-separated string, not a JSON array or YAML block scalar
      if echo "$frontmatter" | grep -qE "^tools:"; then
        tools_val=$(echo "$frontmatter" | grep -E "^tools:" | sed 's/^tools: *//')
        if [[ "$tools_val" =~ ^\[ ]]; then
          fail "$agent_name: tools must be a comma-separated string, not a JSON array (got: '$tools_val')"
        elif [[ "$tools_val" =~ ^[\>\|] ]]; then
          fail "$agent_name: tools must be a comma-separated string, not a YAML block scalar (got: '$tools_val')"
        fi
      fi
    done

    if [[ $AGENT_COUNT -eq 0 ]]; then
      fail "agents directory is empty (no .md files)"
    fi
  else
    if [[ -n "$AGENTS_PATH" ]]; then
      fail "agents path is not a directory: $AGENTS_PATH"
    else
      fail "agents directory not found at conventional location: ./$CONVENTIONAL_AGENTS"
    fi
  fi
}

validate_agents_dir "$AGENTS_DIR"

# ============================================================================
# Check 7: Command .md files exist
# ============================================================================
echo ""
echo "--- Check 7: command files ---"

COMMANDS_PATH="$(jq -r '.commands // empty' "$PLUGIN_JSON")"
if [[ -n "$COMMANDS_PATH" ]]; then
  COMMANDS_DIR="$PLUGIN_ROOT/${COMMANDS_PATH#./}"
else
  # Auto-discover conventional location
  COMMANDS_DIR="$PLUGIN_ROOT/$CONVENTIONAL_COMMANDS"
fi

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
  if [[ -n "$COMMANDS_PATH" ]]; then
    fail "commands path is not a directory: $COMMANDS_PATH"
  else
    fail "commands directory not found at conventional location: ./$CONVENTIONAL_COMMANDS"
  fi
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
