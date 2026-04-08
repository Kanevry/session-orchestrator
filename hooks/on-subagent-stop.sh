#!/usr/bin/env bash
# on-subagent-stop.sh — SubagentStop hook for agent metrics
# Part of Session Orchestrator v2.0
#
# Logs a subagent_stop event to session metrics when a subagent completes.
# Extracts agent name from hook input JSON.
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

# Extract agent name from input
AGENT=$(echo "$INPUT" | jq -r '.agent_name // "unknown"' 2>/dev/null) || AGENT="unknown"

# Ensure metrics directory exists
METRICS_DIR="$PROJECT_ROOT/.orchestrator/metrics"
mkdir -p "$METRICS_DIR"

# Log subagent stop event
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq -nc --arg ts "$TIMESTAMP" --arg agent "$AGENT" \
  '{"event":"subagent_stop","timestamp":$ts,"agent":$agent}' \
  >> "$METRICS_DIR/sessions.jsonl"

exit 0
