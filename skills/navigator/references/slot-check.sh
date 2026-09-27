#!/usr/bin/env bash
# slot-check.sh — measure the slot gate and the busy gate for one repo, decide via fleet-decisions.mjs.
#
# Usage: slot-check.sh <repo-path>
#
# Measures only; every rule lives in fleet-decisions.mjs next to this file.
#   slot gate: free memory % (memory_pressure), 1-min load (vm.loadavg, integer),
#              running headless runs (`timeout -k 60 <n>[smhd] claude -p` + `... codex exec`);
#              anchored on the timeout wrapper because one Codex run spawns three processes matching `codex exec`
#   busy gate: Codex rollouts for <repo-path> younger than 30 min, <repo-path>/.orchestrator/session.lock
#              younger than 6 h
# A value that cannot be measured is passed as null; the decision module fails closed on it.
#
# Env:
#   NAVIGATOR_CODEX_HOME  Codex home directory (default: $HOME/.codex; empty/whitespace = unset)
#   FLEET_SLOT_OVERRIDE=1 owner override for the slot gate
#   FLEET_BUSY_OVERRIDE=1 owner override for the busy gate
#
# Exit: 0 both gates pass, 1 at least one gate refuses, 2 usage error.
set -u

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: slot-check.sh <repo-path>" >&2
  exit 2
fi
repo=${1%/}
here=$(cd "$(dirname "$0")" && pwd)
decide="$here/fleet-decisions.mjs"

# Trim leading/trailing whitespace; a whitespace-only value counts as unset.
trim() {
  local v=$1
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  printf '%s' "$v"
}
codex_home=$(trim "${NAVIGATOR_CODEX_HOME:-}")
[ -n "$codex_home" ] || codex_home=$HOME/.codex

# Rollouts record the cwd as the session saw it; match both the logical and the physical path.
repo_abs=$(cd "$repo" 2>/dev/null && pwd)
repo_phys=$(cd "$repo" 2>/dev/null && pwd -P)

# Print the argument if it is a non-negative integer, else the JSON literal null.
num_or_null() {
  case "$1" in
    ''|*[!0-9]*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}

# --- slot gate measurements ---------------------------------------------------
free_pct=$(memory_pressure 2>/dev/null | awk '/free percentage/{gsub("%","",$NF); print $NF}')
load1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print int($2)}')
# Count pgrep matches: rc 0 → count, rc 1 → 0 (no match), rc >= 2 → empty (not measurable).
count_runs() {
  local out rc
  out=$(pgrep -f "$1")
  rc=$?
  case "$rc" in
    0) printf '%s' "$out" | grep -c . ;;
    1) printf '0' ;;
    *) printf '' ;;
  esac
}
runs=''
if command -v pgrep >/dev/null 2>&1; then
  claude_runs=$(count_runs '^timeout -k 60 [0-9]+[smhd]? claude -p')
  codex_runs=$(count_runs '^timeout -k 60 [0-9]+[smhd]? codex exec')
  if [ -n "$claude_runs" ] && [ -n "$codex_runs" ]; then
    runs=$((claude_runs + codex_runs))
  fi
fi

# --- busy gate measurements ---------------------------------------------------
# Only the first line of each rollout is matched, as a fixed string; file content is never evaluated.
if [ -z "$repo_abs" ] || [ -z "$repo_phys" ]; then
  # Repo path not resolvable: both busy counts are unknown, the decision fails closed.
  codex_fresh=''
  lock_fresh=''
else
  codex_fresh=0
  if [ -d "$codex_home/sessions" ]; then
    codex_fresh=$(find "$codex_home/sessions" -name 'rollout-*.jsonl' -mmin -30 2>/dev/null |
      while IFS= read -r f; do
        head -1 "$f" 2>/dev/null |
          grep -qF -e "\"cwd\":\"$repo_abs\"" -e "\"cwd\":\"$repo_phys\"" && echo x
      done | wc -l | tr -d ' ')
  fi
  lock_fresh=$(find "$repo_abs/.orchestrator" -maxdepth 1 -name session.lock -mmin -360 2>/dev/null | wc -l | tr -d ' ')
fi

slot_override=false
[ "${FLEET_SLOT_OVERRIDE:-0}" = 1 ] && slot_override=true
busy_override=false
[ "${FLEET_BUSY_OVERRIDE:-0}" = 1 ] && busy_override=true

slot_json=$(printf '{"freePct":%s,"load1":%s,"runs":%s,"override":%s}' \
  "$(num_or_null "$free_pct")" "$(num_or_null "$load1")" "$(num_or_null "$runs")" "$slot_override")
busy_json=$(printf '{"codexRolloutsFresh":%s,"lockFresh":%s,"override":%s}' \
  "$(num_or_null "$codex_fresh")" "$(num_or_null "$lock_fresh")" "$busy_override")

slot_out=$(printf '%s' "$slot_json" | node "$decide" slot)
slot_rc=$?
busy_out=$(printf '%s' "$busy_json" | node "$decide" busy)
busy_rc=$?

echo "slot: $slot_out"
echo "busy: $busy_out"

if [ "$slot_rc" -ne 0 ] || [ "$busy_rc" -ne 0 ]; then
  exit 1
fi
exit 0
