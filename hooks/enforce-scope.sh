#!/usr/bin/env bash
# enforce-scope.sh — PreToolUse hook for Edit/Write scope enforcement
# Part of Session Orchestrator v2.0
#
# Validates that Edit/Write tool calls target files within the current
# wave's allowed scope. Reads scope manifest from .claude/wave-scope.json, .codex/wave-scope.json, or .cursor/wave-scope.json.
#
# Exit codes:
#   0 — allow (or no scope manifest / enforcement off)
#   2 — deny (strict mode, file outside allowed paths)

set -euo pipefail

# Read full stdin
INPUT=$(cat)

# Check jq available — graceful degradation
if ! command -v jq &>/dev/null; then
  echo "WARNING: enforce-scope: jq not installed — ALL file edits allowed without scope checking. Install jq to enable enforcement." >&2
  exit 0
fi

# Parse tool name and file path from hook input (fallback on malformed JSON)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || TOOL_NAME=""
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || FILE_PATH=""

# Only validate Edit and Write tool calls
[[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]] && exit 0
[[ -z "$FILE_PATH" ]] && exit 0

# Source platform detection
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../scripts/lib/platform.sh" 2>/dev/null || {
  # Fallback: if platform.sh not found via relative path, try plugin root
  if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
    source "$CLAUDE_PLUGIN_ROOT/scripts/lib/platform.sh"
  elif [[ -n "${CODEX_PLUGIN_ROOT:-}" ]]; then
    source "$CODEX_PLUGIN_ROOT/scripts/lib/platform.sh"
  else
    # Ultimate fallback: inline minimal detection
    SO_PROJECT_DIR="$(pwd)"
  fi
}
PROJECT_ROOT="$SO_PROJECT_DIR"

# Canonicalize paths to prevent symlink bypass (preserve original if realpath fails)
PROJECT_ROOT=$(realpath "$PROJECT_ROOT" 2>/dev/null || echo "$PROJECT_ROOT")

# Load scope manifest — no manifest means no wave in progress (platform-aware)
if [[ -f "$PROJECT_ROOT/.cursor/wave-scope.json" ]]; then
  SCOPE_FILE="$PROJECT_ROOT/.cursor/wave-scope.json"
elif [[ -f "$PROJECT_ROOT/.codex/wave-scope.json" ]]; then
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

# Resolve symlinks in file path — use directory resolution for new files that don't exist yet
FILE_DIR=$(dirname "$FILE_PATH")
FILE_BASE=$(basename "$FILE_PATH")
FILE_DIR=$(realpath "$FILE_DIR" 2>/dev/null || echo "$FILE_DIR")
FILE_PATH="$FILE_DIR/$FILE_BASE"

# Convert absolute file_path to relative (strip project root prefix)
REL_PATH="${FILE_PATH#"$PROJECT_ROOT"/}"

# If REL_PATH still starts with /, the file is outside the project root
if [[ "$REL_PATH" == /* ]]; then
  case "$ENFORCEMENT" in
    strict)
      jq -nc --arg path "$FILE_PATH" \
        '{"permissionDecision":"deny","reason":"File outside project root: \($path)"}'
      exit 2
      ;;
    warn)
      echo "enforce-scope: $FILE_PATH is outside project root — proceeding (warn mode)" >&2
      exit 0
      ;;
  esac
fi

# Check against allowed paths using prefix/glob/regex matching
# Empty allowedPaths means deny-all (Discovery waves). The loop below won't
# iterate, so MATCHED stays false.
MATCHED=false
while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  # Directory prefix match: pattern ending with / matches any file underneath
  if [[ "$pattern" == */ && "$REL_PATH" == "$pattern"* ]]; then
    MATCHED=true
    break
  # Recursive glob (**) match: convert to regex
  elif [[ "$pattern" == *'**'* ]]; then
    # Escape dots, convert ** to .*, convert remaining standalone * to [^/]*
    regex="$pattern"
    regex="${regex//./\\.}"            # . → \.
    regex="${regex//+/\\+}"
    regex="${regex//\?/\\?}"
    regex="${regex//|/\\|}"
    regex="${regex//\[/\\[}"
    regex="${regex//\]/\\]}"
    regex="${regex//\(/\\(}"
    regex="${regex//\)/\\)}"
    regex="${regex//\*\*\//<<DSLASH>>}" # **/ → placeholder (zero+ dirs with slash)
    regex="${regex//\*\*/<<DBL>>}"     # ** at end → placeholder (zero+ path chars)
    regex="${regex//\*/[^/]*}"         # * → [^/]* (single-segment)
    regex="${regex//<<DSLASH>>/(.*\/)?}" # **/ → optional dir segments
    regex="${regex//<<DBL>>/.*}"       # ** → any depth
    regex="^${regex}$"
    if [[ "$REL_PATH" =~ $regex ]]; then
      MATCHED=true
      break
    fi
  # Glob with * (no **): convert to regex so * doesn't cross directories
  elif [[ "$pattern" == *'*'* ]]; then
    regex="$pattern"
    regex="${regex//./\\.}"        # . → \.
    regex="${regex//+/\\+}"
    regex="${regex//\?/\\?}"
    regex="${regex//|/\\|}"
    regex="${regex//\[/\\[}"
    regex="${regex//\]/\\]}"
    regex="${regex//\(/\\(}"
    regex="${regex//\)/\\)}"
    regex="${regex//\*/[^/]*}"     # * → [^/]* (single-segment only)
    regex="^${regex}$"
    if [[ "$REL_PATH" =~ $regex ]]; then
      MATCHED=true
      break
    fi
  # Exact match (literal path, no wildcards)
  elif [[ "$REL_PATH" == "$pattern" ]]; then
    MATCHED=true
    break
  fi
done < <(jq -r '.allowedPaths[]? // empty' "$SCOPE_FILE" 2>/dev/null)

if [[ "$MATCHED" == false ]]; then
  ALLOWED=$(jq -r '.allowedPaths | join(", ")' "$SCOPE_FILE" 2>/dev/null)
  case "$ENFORCEMENT" in
    strict)
      jq -nc --arg path "$REL_PATH" --arg allowed "$ALLOWED" \
        '{"permissionDecision":"deny","reason":"Scope violation: \($path) not in allowed paths [\($allowed)]"}'
      exit 2
      ;;
    warn)
      echo "enforce-scope: $REL_PATH not in allowed paths [$ALLOWED] — proceeding (warn mode)" >&2
      exit 0
      ;;
  esac
fi

exit 0
