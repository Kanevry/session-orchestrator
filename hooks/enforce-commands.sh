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
  echo "WARNING: enforce-commands: jq not installed — ALL commands allowed without restriction. Install jq to enable enforcement." >&2
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || TOOL_NAME=""
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || COMMAND=""

# Only validate Bash tool calls
[[ "$TOOL_NAME" != "Bash" ]] && exit 0
[[ -z "$COMMAND" ]] && exit 0

# Locate wave-scope manifest
find_project_root() {
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -d "${CLAUDE_PROJECT_DIR}/.claude" ]]; then echo "$CLAUDE_PROJECT_DIR"; return; fi
  if [[ -n "${CODEX_PROJECT_DIR:-}" && -d "${CODEX_PROJECT_DIR}/.codex" ]]; then echo "$CODEX_PROJECT_DIR"; return; fi
  local dir
  dir="$(pwd)"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.claude/wave-scope.json" || -f "$dir/.codex/wave-scope.json" ]]; then echo "$dir"; return; fi
    dir="$(dirname "$dir")"
  done
  pwd
}
PROJECT_ROOT="$(find_project_root)"
if [[ -f "$PROJECT_ROOT/.codex/wave-scope.json" ]]; then
  SCOPE_FILE="$PROJECT_ROOT/.codex/wave-scope.json"
elif [[ -f "$PROJECT_ROOT/.claude/wave-scope.json" ]]; then
  SCOPE_FILE="$PROJECT_ROOT/.claude/wave-scope.json"
else
  exit 0
fi

# Enforcement level from wave-scope.json. Default "strict" to fail-closed.
# The wave-executor MUST always write this field explicitly.
ENFORCEMENT=$(jq -r '.enforcement // "strict"' "$SCOPE_FILE" 2>/dev/null) || ENFORCEMENT="strict"
[[ "$ENFORCEMENT" == "off" ]] && exit 0

# Check command against blocked patterns (word-boundary match).
# Each blockedCommands entry is matched as a literal string (not regex) with
# word boundaries: the pattern must appear at the start of the command or after
# whitespace, and end at the end of the command or before whitespace. This
# prevents partial matches (e.g., "rm" won't match "format").
while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  if [[ "$COMMAND" =~ (^|[[:space:]])"$pattern"([[:space:]]|$) ]]; then
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

# Fallback: if wave-scope.json had no blockedCommands, enforce minimum safety blocklist
BLOCKED_COUNT=$(jq -r '.blockedCommands | length // 0' "$SCOPE_FILE" 2>/dev/null) || BLOCKED_COUNT=0
if [[ "$BLOCKED_COUNT" -eq 0 ]]; then
  for pattern in "rm -rf" "git push --force" "git reset --hard" "DROP TABLE" "git checkout -- ."; do
    if [[ "$COMMAND" =~ (^|[[:space:]])"$pattern"([[:space:]]|$) ]]; then
      case "$ENFORCEMENT" in
        strict)
          jq -nc --arg pat "$pattern" --arg cmd "$COMMAND" \
            '{"permissionDecision":"deny","reason":"Blocked by fallback safety list: \($pat) found in: \($cmd)"}'
          exit 2
          ;;
        warn)
          echo "⚠ enforce-commands: fallback blocklist pattern '$pattern' found in command — proceeding (warn mode)" >&2
          exit 0
          ;;
      esac
    fi
  done
fi

exit 0
