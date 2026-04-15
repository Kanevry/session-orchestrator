#!/usr/bin/env bash
# compute-grounding-injection.sh — emit line-numbered GROUNDING blocks for files
# with recent edit-format-friction stagnation history in the agent's file scope.
# Appends grounding_injected events to events.jsonl when PERSISTENCE=true.
# Never exits non-zero — wave dispatch must not be blocked by helper failures.

set -uo pipefail

# --- Early-exit cases (exit 0, empty stdout, no events write) ---

# 1. MAX_FILES <= 0 → disabled
MAX_FILES="${MAX_FILES:-0}"
if [[ "$MAX_FILES" -le 0 ]] 2>/dev/null; then
  exit 0
fi

# 2. jq not available → silent no-op
if ! command -v jq &>/dev/null; then
  exit 0
fi

# 3 & 4. Required files must exist
EVENTS_JSONL="${EVENTS_JSONL:-}"
SESSIONS_JSONL="${SESSIONS_JSONL:-}"
if [[ -z "$EVENTS_JSONL" || ! -f "$EVENTS_JSONL" ]]; then
  exit 0
fi
if [[ -z "$SESSIONS_JSONL" || ! -f "$SESSIONS_JSONL" ]]; then
  exit 0
fi

# 5. AGENT_FILES empty/unset → nothing to match against
AGENT_FILES="${AGENT_FILES:-}"
if [[ -z "$AGENT_FILES" ]]; then
  exit 0
fi

PERSISTENCE="${PERSISTENCE:-false}"
SESSION_ID="${SESSION_ID:-}"
WAVE="${WAVE:-0}"
AGENT_TYPE="${AGENT_TYPE:-}"

# --- Build list of last 3 session_ids from sessions.jsonl ---

# Extract session_id values (skip entries without one, skip empty lines)
LAST_SESSIONS=$(tail -n 3 "$SESSIONS_JSONL" \
  | jq -r 'select(.session_id != null and .session_id != "") | .session_id' 2>/dev/null \
  | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null) || LAST_SESSIONS="[]"

if [[ "$LAST_SESSIONS" == "[]" || -z "$LAST_SESSIONS" ]]; then
  exit 0
fi

# --- Filter events.jsonl for matching stagnation entries ---

MATCHED=$(jq -c \
  --argjson sessions "$LAST_SESSIONS" \
  'select(
    .event == "stagnation_detected" and
    .error_class == "edit-format-friction" and
    (.session as $s | $sessions | index($s) != null) and
    .file != null
  )' "$EVENTS_JSONL" 2>/dev/null) || MATCHED=""

if [[ -z "$MATCHED" ]]; then
  exit 0
fi

# Deduplicate to latest timestamp per file, sort descending
CANDIDATES=$(echo "$MATCHED" \
  | jq -s 'group_by(.file) | map(max_by(.timestamp)) | sort_by(.timestamp) | reverse | .[].file' -r \
  2>/dev/null) || CANDIDATES=""

if [[ -z "$CANDIDATES" ]]; then
  exit 0
fi

# --- Match candidates against AGENT_FILES scope ---

# Populate SCOPE_ENTRIES from newline-separated AGENT_FILES (bash 3.2 compatible)
SCOPE_ENTRIES=()
while IFS= read -r _scope_line; do
  SCOPE_ENTRIES+=("$_scope_line")
done <<< "$AGENT_FILES"

file_in_scope() {
  local candidate="$1"
  local entry
  for entry in "${SCOPE_ENTRIES[@]+"${SCOPE_ENTRIES[@]}"}"; do
    [[ -z "$entry" ]] && continue
    # Literal match
    if [[ "$candidate" == "$entry" ]]; then
      return 0
    fi
    # Glob match — only attempt if entry contains glob chars
    if [[ "$entry" == *'*'* || "$entry" == *'?'* || "$entry" == *'['* ]]; then
      local expanded
      expanded=$(compgen -G "$entry" 2>/dev/null) || expanded=""
      if [[ -n "$expanded" ]]; then
        local exp_file
        while IFS= read -r exp_file; do
          [[ "$candidate" == "$exp_file" ]] && return 0
        done <<< "$expanded"
      fi
    fi
  done
  return 1
}

# Collect scoped files up to MAX_FILES, tracking whether we capped
SELECTED=()
PRE_CAP_COUNT=0
CAPPED=false

while IFS= read -r candidate; do
  [[ -z "$candidate" ]] && continue
  file_in_scope "$candidate" || continue
  (( PRE_CAP_COUNT++ )) || true
  if [[ ${#SELECTED[@]} -lt "$MAX_FILES" ]]; then
    SELECTED+=("$candidate")
  fi
done <<< "$CANDIDATES"

if [[ "$PRE_CAP_COUNT" -gt "$MAX_FILES" ]]; then
  CAPPED=true
fi

# --- Emit GROUNDING blocks and events ---

FIRST=true
for FILE in "${SELECTED[@]+"${SELECTED[@]}"}"; do
  # Skip unreadable files silently
  [[ -f "$FILE" && -r "$FILE" ]] || continue

  # Blank line between blocks (not before the first)
  if [[ "$FIRST" == "true" ]]; then
    FIRST=false
  else
    printf '\n'
  fi

  printf '## GROUNDING — %s\n' "$FILE"
  awk '{printf "%5d\t%s\n", NR, $0}' "$FILE"

  LINES=$(wc -l < "$FILE" | tr -d ' ')

  # Append grounding_injected event when persistence is enabled
  if [[ "$PERSISTENCE" == "true" ]]; then
    jq -nc \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg session "$SESSION_ID" \
      --argjson wave "$WAVE" \
      --arg agent "$AGENT_TYPE" \
      --arg file "$FILE" \
      --argjson lines "$LINES" \
      --argjson capped "$CAPPED" \
      '{event:"grounding_injected",timestamp:$ts,session:$session,wave:$wave,agent:$agent,file:$file,lines:$lines,grounding_capped:$capped}' \
      >> "$EVENTS_JSONL" 2>/dev/null || true
  fi
done

exit 0
