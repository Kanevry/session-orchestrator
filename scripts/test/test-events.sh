#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(git rev-parse --show-toplevel)"
EVENTS_LIB="$PLUGIN_ROOT/scripts/lib/events.sh"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    ((PASS++)) || true
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    ((FAIL++)) || true
  fi
}

echo "=== Event Bus Library Tests ==="

# --- Test 1: events.sh exists and is sourceable ---
echo ""
echo "=== Test Group 1: Library loading ==="
(source "$EVENTS_LIB" 2>/dev/null) && RESULT=0 || RESULT=1
assert_eq "events.sh is sourceable" "0" "$RESULT"

# --- Test 2: so_emit_event function exists after sourcing ---
FUNC_EXISTS=$(bash -c "source '$EVENTS_LIB' 2>/dev/null && type -t so_emit_event 2>/dev/null || echo 'missing'")
assert_eq "so_emit_event function exists" "function" "$FUNC_EXISTS"

# --- Test 3: Graceful skip when CLANK_EVENT_SECRET is unset ---
echo ""
echo "=== Test Group 2: Graceful degradation ==="
RESULT=$(bash -c "
  unset CLANK_EVENT_SECRET
  source '$EVENTS_LIB' 2>/dev/null
  so_emit_event 'test.event' '{}' 2>/dev/null
  echo \$?
")
assert_eq "no secret → exits 0 (graceful skip)" "0" "$RESULT"

# --- Test 4: Function requires event_type argument ---
RESULT=$(bash -c "
  export CLANK_EVENT_SECRET='test-secret'
  source '$EVENTS_LIB' 2>/dev/null
  so_emit_event 2>/dev/null
  echo \$?
" 2>/dev/null) || RESULT="1"
assert_eq "missing event_type → exits non-zero" "1" "$RESULT"

# --- Test 5: on-session-start.sh exists and is executable ---
echo ""
echo "=== Test Group 3: Hook scripts ==="
HOOK="$PLUGIN_ROOT/hooks/on-session-start.sh"
[[ -x "$HOOK" ]] && RESULT=0 || RESULT=1
assert_eq "on-session-start.sh is executable" "0" "$RESULT"

# --- Test 6: on-session-start.sh exits 0 without CLANK_EVENT_SECRET ---
RESULT=$(bash -c "
  unset CLANK_EVENT_SECRET
  bash '$HOOK' </dev/null 2>/dev/null
  echo \$?
")
assert_eq "on-session-start.sh without secret exits 0" "0" "$RESULT"

# --- Test 7: on-stop.sh sources events.sh ---
echo ""
echo "=== Test Group 4: Hook integration ==="
RESULT=$(grep -q 'source.*events\.sh' "$PLUGIN_ROOT/hooks/on-stop.sh" && echo 0 || echo 1)
assert_eq "on-stop.sh sources events.sh with source keyword" "0" "$RESULT"

# --- Test 8: on-subagent-stop.sh sources events.sh ---
RESULT=$(grep -q 'source.*events\.sh' "$PLUGIN_ROOT/hooks/on-subagent-stop.sh" && echo 0 || echo 1)
assert_eq "on-subagent-stop.sh sources events.sh with source keyword" "0" "$RESULT"

# --- Test 9: on-stop.sh emits orchestrator.session.stopped ---
RESULT=$(grep -q 'so_emit_event.*"orchestrator\.session\.stopped"' "$PLUGIN_ROOT/hooks/on-stop.sh" && echo 0 || echo 1)
assert_eq "on-stop.sh emits orchestrator.session.stopped via so_emit_event" "0" "$RESULT"

# --- Test 10: on-subagent-stop.sh emits orchestrator.agent.stopped ---
RESULT=$(grep -q 'so_emit_event.*"orchestrator\.agent\.stopped"' "$PLUGIN_ROOT/hooks/on-subagent-stop.sh" && echo 0 || echo 1)
assert_eq "on-subagent-stop.sh emits orchestrator.agent.stopped via so_emit_event" "0" "$RESULT"

# Tests 11–18 check the live hook registration in hooks.json. Since the Node
# migration (v3.0), hooks.json dispatches .mjs handlers via `node "$CLAUDE_PLUGIN_ROOT/hooks/<name>.mjs"`.
# SubagentStop consolidates on on-stop.mjs (same handler, inspects event payload).

# --- Test 11: hooks.json registers on-session-start.mjs with proper structure ---
echo ""
echo "=== Test Group 5: Hook registration ==="
RESULT=$(jq -e '.hooks.SessionStart[0].hooks[] | select(.type == "command" and (.command | contains("on-session-start.mjs")))' "$PLUGIN_ROOT/hooks/hooks.json" >/dev/null 2>&1 && echo 0 || echo 1)
assert_eq "hooks.json registers on-session-start.mjs with type:command" "0" "$RESULT"

# --- Test 12: hooks-codex.json registers on-session-start.mjs with proper structure ---
RESULT=$(jq -e '.hooks.SessionStart[0].hooks[] | select(.type == "command" and (.command | contains("on-session-start.mjs")))' "$PLUGIN_ROOT/hooks/hooks-codex.json" >/dev/null 2>&1 && echo 0 || echo 1)
assert_eq "hooks-codex.json registers on-session-start.mjs with type:command" "0" "$RESULT"

# --- Test 13: hooks.json on-session-start.mjs has async field ---
RESULT=$(jq -e '.hooks.SessionStart[0].hooks[] | select(.command | contains("on-session-start.mjs")) | select(has("async"))' "$PLUGIN_ROOT/hooks/hooks.json" >/dev/null 2>&1 && echo 0 || echo 1)
assert_eq "hooks.json on-session-start.mjs has async field" "0" "$RESULT"

# --- Test 14: hooks.json PreToolUse enforce-scope registered ---
RESULT=$(jq -e '.hooks.PreToolUse[] | select(.matcher == "Edit|Write") | .hooks[] | select(.type == "command" and (.command | contains("enforce-scope.mjs")))' "$PLUGIN_ROOT/hooks/hooks.json" >/dev/null 2>&1 && echo 0 || echo 1)
assert_eq "hooks.json registers enforce-scope.mjs for Edit|Write" "0" "$RESULT"

# --- Test 15: hooks.json PreToolUse enforce-commands registered ---
RESULT=$(jq -e '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[] | select(.type == "command" and (.command | contains("enforce-commands.mjs")))' "$PLUGIN_ROOT/hooks/hooks.json" >/dev/null 2>&1 && echo 0 || echo 1)
assert_eq "hooks.json registers enforce-commands.mjs for Bash" "0" "$RESULT"

# --- Test 16: hooks.json PostToolUse post-edit-validate registered ---
RESULT=$(jq -e '.hooks.PostToolUse[] | select(.matcher == "Edit|Write") | .hooks[] | select(.type == "command" and (.command | contains("post-edit-validate.mjs")))' "$PLUGIN_ROOT/hooks/hooks.json" >/dev/null 2>&1 && echo 0 || echo 1)
assert_eq "hooks.json registers post-edit-validate.mjs for Edit|Write" "0" "$RESULT"

# --- Test 17: hooks.json Stop hook registered ---
RESULT=$(jq -e '.hooks.Stop[0].hooks[] | select(.type == "command" and (.command | contains("on-stop.mjs")))' "$PLUGIN_ROOT/hooks/hooks.json" >/dev/null 2>&1 && echo 0 || echo 1)
assert_eq "hooks.json registers on-stop.mjs" "0" "$RESULT"

# --- Test 18: hooks.json SubagentStop hook registered (consolidated on on-stop.mjs) ---
RESULT=$(jq -e '.hooks.SubagentStop[0].hooks[] | select(.type == "command" and (.command | contains("on-stop.mjs")))' "$PLUGIN_ROOT/hooks/hooks.json" >/dev/null 2>&1 && echo 0 || echo 1)
assert_eq "hooks.json registers SubagentStop handler (on-stop.mjs)" "0" "$RESULT"

echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

[[ $FAIL -eq 0 ]] || exit 1
