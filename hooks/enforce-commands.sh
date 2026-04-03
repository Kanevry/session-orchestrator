#!/usr/bin/env bash
# enforce-commands.sh — PreToolUse hook for Bash command restrictions
# Part of Session Orchestrator v2.0
#
# Reads wave-scope.json and blocks dangerous Bash commands during wave execution.
# Enforcement levels: strict (deny), warn (allow + stderr warning), off (skip).

set -euo pipefail

INPUT=$(cat)

# Graceful degradation: if jq is not available, allow everything
if ! command -v jq &>/dev/null; then
  echo "⚠ enforce-commands: jq not found, allowing operation" >&2
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || TOOL_NAME=""
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || COMMAND=""

# Only validate Bash tool calls
[[ "$TOOL_NAME" != "Bash" ]] && exit 0
[[ -z "$COMMAND" ]] && exit 0

# Locate wave-scope manifest
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
SCOPE_FILE="$PROJECT_ROOT/.claude/wave-scope.json"
[[ ! -f "$SCOPE_FILE" ]] && exit 0

# Read enforcement level (default to warn)
ENFORCEMENT=$(jq -r '.enforcement // "warn"' "$SCOPE_FILE" 2>/dev/null) || ENFORCEMENT="warn"
[[ "$ENFORCEMENT" == "off" ]] && exit 0

# Check command against blocked patterns (substring match)
while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  if [[ "$COMMAND" == *"$pattern"* ]]; then
    case "$ENFORCEMENT" in
      strict)
        jq -nc --arg pat "$pattern" --arg cmd "$COMMAND" \
          '{"permissionDecision":"deny","reason":"Blocked command: \($pat) found in: \($cmd)"}'
        exit 2
        ;;
      warn)
        echo "⚠ enforce-commands: blocked pattern '$pattern' found in command — proceeding (warn mode)" >&2
        exit 0
        ;;
    esac
  fi
done < <(jq -r '.blockedCommands[]? // empty' "$SCOPE_FILE" 2>/dev/null)

exit 0
