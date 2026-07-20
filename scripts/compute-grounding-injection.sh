#!/usr/bin/env bash
# compute-grounding-injection.sh — emit line-numbered GROUNDING blocks for files
# with recent edit-format-friction stagnation history in the agent's file scope.
# Appends orchestrator.grounding.injected events to events.jsonl when PERSISTENCE=true.
# Never exits non-zero — wave dispatch must not be blocked by helper failures.

set -uo pipefail

# --- Resolve this script's own directory + repo root (for emit-event.mjs) ---
# Robust against symlinks and being invoked from any CWD. The script lives at
# <repo>/scripts/compute-grounding-injection.sh, so the repo root is the parent
# of the scripts/ directory. Used to locate scripts/emit-event.mjs (#611).
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [[ -h "$SCRIPT_SOURCE" ]]; do
  _dir="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$_dir/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
EMIT_EVENT_CLI="$REPO_ROOT/scripts/emit-event.mjs"

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

# --- Build list of last 3 REAL session_ids from sessions.jsonl ---

# Filter out phantom `status: 'abandoned'` stubs (#834, session-close-backfill
# — 0 waves, seconds of runtime) BEFORE taking the tail. Otherwise a recent
# phantom can evict the one real session carrying the stagnation evidence,
# silently suppressing grounding injection for a genuinely stagnating file.
#
# `-R` (raw-input) + `fromjson?` parses each line individually and SKIPS
# unparseable ones instead of aborting the whole stream — plain
# `jq -c 'select(...)'` aborts at the FIRST malformed line (jq: parse error,
# exit 5). sessions.jsonl is append-only from multiple writers, so a torn
# write earlier in the file must not silently starve LAST_SESSIONS down to
# "[]" (fail-closed-empty is still wrong here, just a quieter wrong than the
# stale-session-id case this fixes) — the whole point is that corruption
# anywhere in the file no longer poisons the tail. Mirrors the per-line
# try/catch behaviour of the .mjs path (scripts/lib/session-schema/filters.mjs).
# Extract session_id values (skip entries without one, skip empty lines)
LAST_SESSIONS=$(jq -R -c 'fromjson? | select(.status != "abandoned")' "$SESSIONS_JSONL" 2>/dev/null \
  | tail -n 3 \
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

  # Emit an orchestrator.grounding.injected event when persistence is enabled.
  # Routed through the canonical emitEvent() path (scripts/emit-event.mjs) rather
  # than a hand-rolled `jq >> file` append, so the JSONL record and the optional
  # Clank webhook always carry the SAME dotted event name (#611). emitEvent()
  # generates its own `timestamp`, so the payload below omits it.
  if [[ "$PERSISTENCE" == "true" && -f "$EMIT_EVENT_CLI" ]]; then
    PAYLOAD=$(jq -nc \
      --arg session "$SESSION_ID" \
      --argjson wave "$WAVE" \
      --arg agent "$AGENT_TYPE" \
      --arg file "$FILE" \
      --argjson lines "$LINES" \
      --argjson capped "$CAPPED" \
      '{session:$session,wave:$wave,agent:$agent,file:$file,lines:$lines,grounding_capped:$capped}' \
      2>/dev/null) || PAYLOAD=""
    if [[ -n "$PAYLOAD" ]]; then
      node "$EMIT_EVENT_CLI" \
        --type orchestrator.grounding.injected \
        --file "$EVENTS_JSONL" \
        --payload "$PAYLOAD" \
        >/dev/null 2>&1 || true
    fi
  fi
done

exit 0
