#!/usr/bin/env bash
# enforce-scope.sh — PreToolUse hook for Edit/Write scope enforcement
# Part of Session Orchestrator v2.0
#
# Validates that Edit/Write tool calls target files within the current
# wave's allowed scope. Reads scope manifest from .claude/wave-scope.json.
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

# Resolve project root (where .claude/ lives)
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Load scope manifest — no manifest means no wave in progress
SCOPE_FILE="$PROJECT_ROOT/.claude/wave-scope.json"
[[ ! -f "$SCOPE_FILE" ]] && exit 0

# Parse enforcement level
ENFORCEMENT=$(jq -r '.enforcement // "warn"' "$SCOPE_FILE" 2>/dev/null) || ENFORCEMENT="warn"
[[ "$ENFORCEMENT" == "off" ]] && exit 0

# Convert absolute file_path to relative (strip project root prefix)
REL_PATH="${FILE_PATH#"$PROJECT_ROOT"/}"

# Check against allowed paths using prefix/glob/regex matching
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
