#!/usr/bin/env bash
# test-hooks-integration.sh — Integration tests for the full hook sequence
# Fires hooks in the actual lifecycle sequence:
#   SessionStart → PreToolUse → PostToolUse → Stop/SubagentStop
# Catches interaction failures, state corruption, and silent crashes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/../../hooks"

ON_SESSION_START="$HOOKS_DIR/on-session-start.sh"
ENFORCE_SCOPE="$HOOKS_DIR/enforce-scope.sh"
ENFORCE_COMMANDS="$HOOKS_DIR/enforce-commands.sh"
POST_EDIT_VALIDATE="$HOOKS_DIR/post-edit-validate.sh"
ON_STOP="$HOOKS_DIR/on-stop.sh"
ON_SUBAGENT_STOP="$HOOKS_DIR/on-subagent-stop.sh"

PASS=0
FAIL=0

MASTER_TMPDIR=$(mktemp -d)
trap 'rm -rf "$MASTER_TMPDIR"' EXIT

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

# Helper: create a temp project dir with .claude/wave-scope.json and a git repo
_hook_counter=0
setup_hook_dir() {
  local json="$1"
  local tmpdir="$MASTER_TMPDIR/hook_$((_hook_counter++))"
  mkdir -p "$tmpdir/.claude" "$tmpdir/.orchestrator/metrics"
  echo "$json" > "$tmpdir/.claude/wave-scope.json"
  # Initialize git repo so hooks that use git rev-parse work
  (cd "$tmpdir" && git init -q && git config user.name "Test" && git config user.email "test@test.com")
  echo "$tmpdir"
}

# ===========================================================================
echo "=== Group 1: SessionStart hook ==="
# ===========================================================================

# 1: on-session-start.sh runs without error (exits 0) when CLANK_EVENT_SECRET is unset
session_start_exit=0
echo '{}' | CLANK_EVENT_SECRET="" bash "$ON_SESSION_START" > /dev/null 2>&1 || session_start_exit=$?
assert_eq "1: on-session-start exits 0 without CLANK_EVENT_SECRET" "0" "$session_start_exit"

# 2: on-session-start.sh is executable
executable_check=0
[[ -x "$ON_SESSION_START" ]] || executable_check=1
assert_eq "2: on-session-start.sh is executable" "0" "$executable_check"

# ===========================================================================
echo ""
echo "=== Group 2: PreToolUse — enforce-scope lifecycle ==="
# ===========================================================================

SCOPE_STRICT='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/","lib/"],"blockedCommands":["rm -rf"]}'
SCOPE_DIR_STRICT=$(setup_hook_dir "$SCOPE_STRICT")
mkdir -p "$SCOPE_DIR_STRICT/src" "$SCOPE_DIR_STRICT/lib" "$SCOPE_DIR_STRICT/tests"

# 3: enforce-scope.sh blocks out-of-scope Edit in strict mode (exit 2)
scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_STRICT/tests/bar.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_STRICT" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "3: enforce-scope strict mode blocks out-of-scope Edit (exit 2)" "2" "$scope_exit"

# 4: enforce-scope.sh allows in-scope Edit in strict mode (exit 0)
scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_STRICT/src/foo.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_STRICT" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "4: enforce-scope strict mode allows in-scope Edit (exit 0)" "0" "$scope_exit"

# 5: enforce-scope.sh allows all in warn mode for out-of-scope (exit 0)
SCOPE_WARN='{"wave":1,"role":"Impl","enforcement":"warn","allowedPaths":["src/"],"blockedCommands":[]}'
SCOPE_DIR_WARN=$(setup_hook_dir "$SCOPE_WARN")
mkdir -p "$SCOPE_DIR_WARN/src" "$SCOPE_DIR_WARN/tests"

scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_WARN/tests/bar.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_WARN" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "5: enforce-scope warn mode allows out-of-scope Edit (exit 0)" "0" "$scope_exit"

# 6: enforce-scope.sh allows when enforcement is off (exit 0)
SCOPE_OFF='{"wave":1,"role":"Impl","enforcement":"off","allowedPaths":["src/"],"blockedCommands":[]}'
SCOPE_DIR_OFF=$(setup_hook_dir "$SCOPE_OFF")
mkdir -p "$SCOPE_DIR_OFF/anywhere"

scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_OFF/anywhere/file.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_OFF" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "6: enforce-scope off mode allows everything (exit 0)" "0" "$scope_exit"

# ===========================================================================
echo ""
echo "=== Group 3: PreToolUse — enforce-commands lifecycle ==="
# ===========================================================================

CMD_STRICT='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/"],"blockedCommands":["rm -rf","git push --force"]}'
CMD_DIR_STRICT=$(setup_hook_dir "$CMD_STRICT")
mkdir -p "$CMD_DIR_STRICT/src"

# 7: enforce-commands.sh blocks dangerous command in strict mode (exit 2)
cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | CLAUDE_PROJECT_DIR="$CMD_DIR_STRICT" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || cmd_exit=$?
assert_eq "7: enforce-commands strict mode blocks rm -rf (exit 2)" "2" "$cmd_exit"

# 8: enforce-commands.sh allows safe command (exit 0)
cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  | CLAUDE_PROJECT_DIR="$CMD_DIR_STRICT" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || cmd_exit=$?
assert_eq "8: enforce-commands allows safe command ls -la (exit 0)" "0" "$cmd_exit"

# 9: enforce-commands.sh fallback blocklist catches rm -rf when no blockedCommands (exit 2)
NO_BLOCKED_SCOPE='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/"]}'
NO_BLOCKED_DIR=$(setup_hook_dir "$NO_BLOCKED_SCOPE")
mkdir -p "$NO_BLOCKED_DIR/src"

cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | CLAUDE_PROJECT_DIR="$NO_BLOCKED_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || cmd_exit=$?
assert_eq "9: enforce-commands fallback blocklist catches rm -rf (exit 2)" "2" "$cmd_exit"

# ===========================================================================
echo ""
echo "=== Group 4: PostToolUse — post-edit-validate ==="
# ===========================================================================

# 10: post-edit-validate.sh exits 0 for non-TS file
validate_exit=0
echo '{"tool_name":"Edit","tool_input":{"file_path":"README.md"}}' \
  | bash "$POST_EDIT_VALIDATE" > /dev/null 2>&1 || validate_exit=$?
assert_eq "10: post-edit-validate exits 0 for non-TS file (README.md)" "0" "$validate_exit"

# 11: post-edit-validate.sh exits 0 with valid TS file input (informational hook, never blocks)
validate_exit=0
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/app.ts"}}' \
  | bash "$POST_EDIT_VALIDATE" > /dev/null 2>&1 || validate_exit=$?
assert_eq "11: post-edit-validate exits 0 for TS file (always informational)" "0" "$validate_exit"

# ===========================================================================
echo ""
echo "=== Group 5: Stop hooks — event logging ==="
# ===========================================================================

STOP_SCOPE='{"wave":3,"role":"Impl","enforcement":"strict","allowedPaths":["src/"],"blockedCommands":[]}'
STOP_DIR=$(setup_hook_dir "$STOP_SCOPE")

# 12: on-stop.sh logs event to events.jsonl when wave-scope.json exists
stop_exit=0
echo '{}' | (cd "$STOP_DIR" && bash "$ON_STOP") > /dev/null 2>&1 || stop_exit=$?
assert_eq "12: on-stop exits 0 when wave-scope.json exists" "0" "$stop_exit"

events_file="$STOP_DIR/.orchestrator/metrics/events.jsonl"
events_exist=0
[[ -f "$events_file" ]] || events_exist=1
assert_eq "12: on-stop creates events.jsonl" "0" "$events_exist"

has_stop_event=1
grep -q '"event":"stop"' "$events_file" 2>/dev/null && has_stop_event=0
assert_eq "12: events.jsonl contains stop event" "0" "$has_stop_event"

# 13: on-subagent-stop.sh logs event to events.jsonl
SUBAGENT_DIR=$(setup_hook_dir "$STOP_SCOPE")
subagent_exit=0
echo '{"agent_name":"test-writer"}' | (cd "$SUBAGENT_DIR" && bash "$ON_SUBAGENT_STOP") > /dev/null 2>&1 || subagent_exit=$?
assert_eq "13: on-subagent-stop exits 0" "0" "$subagent_exit"

subagent_events_file="$SUBAGENT_DIR/.orchestrator/metrics/events.jsonl"
subagent_events_exist=0
[[ -f "$subagent_events_file" ]] || subagent_events_exist=1
assert_eq "13: on-subagent-stop creates events.jsonl" "0" "$subagent_events_exist"

has_subagent_event=1
grep -q '"event":"subagent_stop"' "$subagent_events_file" 2>/dev/null && has_subagent_event=0
assert_eq "13: events.jsonl contains subagent_stop event" "0" "$has_subagent_event"

# 14: on-stop.sh exits 0 when no wave-scope.json exists
NO_SCOPE_DIR="$MASTER_TMPDIR/no_scope_stop"
mkdir -p "$NO_SCOPE_DIR/.orchestrator/metrics"
(cd "$NO_SCOPE_DIR" && git init -q && git config user.name "Test" && git config user.email "test@test.com")

stop_no_scope_exit=0
echo '{}' | (cd "$NO_SCOPE_DIR" && bash "$ON_STOP") > /dev/null 2>&1 || stop_no_scope_exit=$?
assert_eq "14: on-stop exits 0 when no wave-scope.json exists" "0" "$stop_no_scope_exit"

# ===========================================================================
echo ""
echo "=== Group 6: Error paths — jq unavailable ==="
# ===========================================================================

# Build a PATH that has essential commands but NOT jq
JQ_MISSING_DIR="$MASTER_TMPDIR/no_jq_bin"
mkdir -p "$JQ_MISSING_DIR"
for cmd in bash cat echo env dirname basename git realpath; do
  src=$(command -v "$cmd" 2>/dev/null) && [ -n "$src" ] && ln -sf "$src" "$JQ_MISSING_DIR/" 2>/dev/null || true
done
NO_JQ_PATH="$JQ_MISSING_DIR"

SCOPE_FOR_JQ='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/"],"blockedCommands":["rm -rf"]}'
JQ_SCOPE_DIR=$(setup_hook_dir "$SCOPE_FOR_JQ")
mkdir -p "$JQ_SCOPE_DIR/src"

# 15: enforce-scope.sh exits 2 when jq is missing (CRITICAL: fixed in #65 — was silent pass)
jq_scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$JQ_SCOPE_DIR/tests/bad.ts\"}}" \
  | PATH="$NO_JQ_PATH" CLAUDE_PROJECT_DIR="$JQ_SCOPE_DIR" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || jq_scope_exit=$?
assert_eq "15: enforce-scope exits 2 when jq missing (fail-closed per #65)" "2" "$jq_scope_exit"

# 16: enforce-commands.sh exits 2 when jq is missing (fail-closed per #65)
jq_cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | PATH="$NO_JQ_PATH" CLAUDE_PROJECT_DIR="$JQ_SCOPE_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || jq_cmd_exit=$?
assert_eq "16: enforce-commands exits 2 when jq missing (fail-closed per #65)" "2" "$jq_cmd_exit"

# 17: post-edit-validate.sh exits 0 when jq is missing (informational hook)
jq_validate_exit=0
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/app.ts"}}' \
  | PATH="$NO_JQ_PATH" bash "$POST_EDIT_VALIDATE" > /dev/null 2>&1 || jq_validate_exit=$?
assert_eq "17: post-edit-validate exits 0 when jq missing" "0" "$jq_validate_exit"

# 18: on-stop.sh exits 0 when jq is missing
JQ_STOP_DIR=$(setup_hook_dir "$SCOPE_FOR_JQ")
jq_stop_exit=0
echo '{}' | env PATH="$NO_JQ_PATH" bash -c "cd '$JQ_STOP_DIR' && bash '$ON_STOP'" > /dev/null 2>&1 || jq_stop_exit=$?
assert_eq "18: on-stop exits 0 when jq missing" "0" "$jq_stop_exit"

# 19: on-subagent-stop.sh exits 0 when jq is missing
JQ_SUBAGENT_DIR=$(setup_hook_dir "$SCOPE_FOR_JQ")
jq_subagent_exit=0
echo '{"agent_name":"test-writer"}' | env PATH="$NO_JQ_PATH" bash -c "cd '$JQ_SUBAGENT_DIR' && bash '$ON_SUBAGENT_STOP'" > /dev/null 2>&1 || jq_subagent_exit=$?
assert_eq "19: on-subagent-stop exits 0 when jq missing" "0" "$jq_subagent_exit"

# ===========================================================================
echo ""
echo "=== Group 7: Error paths — malformed input ==="
# ===========================================================================

MALFORM_SCOPE='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/"],"blockedCommands":["rm -rf"]}'
MALFORM_DIR=$(setup_hook_dir "$MALFORM_SCOPE")
mkdir -p "$MALFORM_DIR/src"

# 20: enforce-scope.sh exits 0 with empty stdin (no JSON)
empty_scope_exit=0
echo "" \
  | CLAUDE_PROJECT_DIR="$MALFORM_DIR" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || empty_scope_exit=$?
assert_eq "20: enforce-scope exits 0 with empty stdin" "0" "$empty_scope_exit"

# 21: enforce-commands.sh exits 0 with empty stdin
empty_cmd_exit=0
echo "" \
  | CLAUDE_PROJECT_DIR="$MALFORM_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || empty_cmd_exit=$?
assert_eq "21: enforce-commands exits 0 with empty stdin" "0" "$empty_cmd_exit"

# 22: on-stop.sh exits 0 with empty stdin
EMPTY_STOP_DIR=$(setup_hook_dir "$MALFORM_SCOPE")
empty_stop_exit=0
echo "" | bash -c "cd '$EMPTY_STOP_DIR' && bash '$ON_STOP'" > /dev/null 2>&1 || empty_stop_exit=$?
assert_eq "22: on-stop exits 0 with empty stdin" "0" "$empty_stop_exit"

# ===========================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] || exit 1
