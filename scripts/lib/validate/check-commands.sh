#!/usr/bin/env bash
# check-commands.sh — Validate that the commands directory contains .md files.
# Usage: check-commands.sh <plugin-root>
# Outputs lines of the form "PASS: ..." / "FAIL: ..."
# Exit 0 = all checks passed; exit 1 = at least one failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"

if [[ $# -lt 1 ]]; then
  die "Usage: check-commands.sh <plugin-root>"
fi

PLUGIN_ROOT="$1"
PLUGIN_JSON="$PLUGIN_ROOT/.claude-plugin/plugin.json"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

CONVENTIONAL_COMMANDS="commands"

# ============================================================================
# Check 7: Command .md files exist
# ============================================================================
echo "--- Check 7: command files ---"

COMMANDS_PATH="$(jq -r '.commands // empty' "$PLUGIN_JSON")"
if [[ -n "$COMMANDS_PATH" ]]; then
  COMMANDS_DIR="$PLUGIN_ROOT/${COMMANDS_PATH#./}"
else
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

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
