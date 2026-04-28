#!/usr/bin/env bash
# check-agents.sh — Validate agent .md files have valid YAML frontmatter.
# Usage: check-agents.sh <plugin-root>
# Outputs lines of the form "PASS: ..." / "FAIL: ..."
# Exit 0 = all checks passed; exit 1 = at least one failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"

if [[ $# -lt 1 ]]; then
  die "Usage: check-agents.sh <plugin-root>"
fi

PLUGIN_ROOT="$1"
PLUGIN_JSON="$PLUGIN_ROOT/.claude-plugin/plugin.json"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

CONVENTIONAL_AGENTS="agents"

# ============================================================================
# Check 6: Agent .md files have valid YAML frontmatter
# ============================================================================
echo "--- Check 6: agent frontmatter ---"

AGENTS_PATH="$(jq -r '.agents // empty' "$PLUGIN_JSON")"
if [[ -n "$AGENTS_PATH" ]]; then
  AGENTS_DIR="$PLUGIN_ROOT/${AGENTS_PATH#./}"
else
  AGENTS_DIR="$PLUGIN_ROOT/$CONVENTIONAL_AGENTS"
fi

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

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
