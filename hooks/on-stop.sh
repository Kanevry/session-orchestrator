#!/usr/bin/env bash
# on-stop.sh — Stop hook for session state persistence
# Part of Session Orchestrator v2.0
#
# Logs a stop event to session metrics when Claude stops unexpectedly.
# Reads wave number from wave-scope.json if a wave is in progress.
#
# Exit codes:
#   0 — always (informational, never blocking)

set -euo pipefail

# Read full stdin
INPUT=$(cat)

# Check jq available — graceful degradation
if ! command -v jq &>/dev/null; then
  exit 0
fi

# Find project root
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# Check if a wave is in progress (platform-aware lookup)
SCOPE_FILE=""
for dir in .claude .codex .cursor; do
  if [[ -f "$PROJECT_ROOT/$dir/wave-scope.json" ]]; then
    SCOPE_FILE="$PROJECT_ROOT/$dir/wave-scope.json"
    break
  fi
done
[[ -z "$SCOPE_FILE" ]] && exit 0

# Extract wave number
WAVE=$(jq -r '.wave // 0' "$SCOPE_FILE" 2>/dev/null) || WAVE=0

# Ensure metrics directory exists
METRICS_DIR="$PROJECT_ROOT/.orchestrator/metrics"
mkdir -p "$METRICS_DIR"

# Log stop event
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq -nc --arg ts "$TIMESTAMP" --argjson wave "$WAVE" \
  '{"event":"stop","timestamp":$ts,"wave":$wave}' \
  >> "$METRICS_DIR/sessions.jsonl"

exit 0
