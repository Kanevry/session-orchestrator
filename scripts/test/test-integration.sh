#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
PARSE_CONFIG="$SCRIPT_DIR/../parse-config.sh"
QUALITY_GATE="$SCRIPT_DIR/../run-quality-gate.sh"
VALIDATE_SCOPE="$SCRIPT_DIR/../validate-wave-scope.sh"
ENFORCE_SCOPE="$SCRIPT_DIR/../../hooks/enforce-scope.sh"
ENFORCE_COMMANDS="$SCRIPT_DIR/../../hooks/enforce-commands.sh"

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

assert_exit() {
  local label="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" > /dev/null 2>&1 || actual_code=$?
  assert_eq "$label" "$expected_code" "$actual_code"
}

# ===========================================================================
echo "=== Group 1: Config -> Quality Gate Pipeline ==="
# ===========================================================================

# 1a: Parse full config -> feed to quality gate baseline
G1_TMPDIR="$MASTER_TMPDIR/g1"
mkdir -p "$G1_TMPDIR"

full_json=$(bash "$PARSE_CONFIG" "$FIXTURES/claude-md-full.md" 2>/dev/null)
echo "$full_json" > "$G1_TMPDIR/config.json"

baseline_output=$(bash "$QUALITY_GATE" --variant baseline --config "$G1_TMPDIR/config.json" 2>/dev/null)
baseline_exit=$?
assert_eq "1a: parse full -> baseline exits 0" "0" "$baseline_exit"

baseline_json_ok=0
echo "$baseline_output" | jq empty 2>/dev/null || baseline_json_ok=$?
assert_eq "1a: baseline output is valid JSON" "0" "$baseline_json_ok"

baseline_variant=$(echo "$baseline_output" | jq -r '.variant')
assert_eq "1a: baseline variant field" "baseline" "$baseline_variant"

# 1b: Parse echo-commands config -> feed to each variant
echo_json=$(bash "$PARSE_CONFIG" "$FIXTURES/claude-md-echo-commands.md" 2>/dev/null)
echo "$echo_json" > "$G1_TMPDIR/echo-config.json"

# baseline
echo_baseline=$(bash "$QUALITY_GATE" --variant baseline --config "$G1_TMPDIR/echo-config.json" 2>/dev/null)
echo_baseline_exit=$?
assert_eq "1b: echo -> baseline exits 0" "0" "$echo_baseline_exit"

echo_bl_has_tc=$(echo "$echo_baseline" | jq 'has("typecheck")')
assert_eq "1b: echo baseline has typecheck" "true" "$echo_bl_has_tc"

echo_bl_has_test=$(echo "$echo_baseline" | jq 'has("test")')
assert_eq "1b: echo baseline has test" "true" "$echo_bl_has_test"

# full-gate
echo_fullgate=$(bash "$QUALITY_GATE" --variant full-gate --config "$G1_TMPDIR/echo-config.json" 2>/dev/null)
echo_fullgate_exit=$?
assert_eq "1b: echo -> full-gate exits 0" "0" "$echo_fullgate_exit"

echo_fg_tc_status=$(echo "$echo_fullgate" | jq 'has("typecheck") and (.typecheck | has("status"))')
assert_eq "1b: full-gate has typecheck.status" "true" "$echo_fg_tc_status"

echo_fg_test_status=$(echo "$echo_fullgate" | jq 'has("test") and (.test | has("status"))')
assert_eq "1b: full-gate has test.status" "true" "$echo_fg_test_status"

echo_fg_lint_status=$(echo "$echo_fullgate" | jq 'has("lint") and (.lint | has("status"))')
assert_eq "1b: full-gate has lint.status" "true" "$echo_fg_lint_status"

# per-file
echo_perfile=$(bash "$QUALITY_GATE" --variant per-file --config "$G1_TMPDIR/echo-config.json" --files dummy.ts 2>/dev/null)
echo_perfile_exit=$?
assert_eq "1b: echo -> per-file exits 0" "0" "$echo_perfile_exit"

# 1c: Parse minimal config -> baseline (defaults used, may skip/fail but config flows)
minimal_json=$(bash "$PARSE_CONFIG" "$FIXTURES/claude-md-minimal.md" 2>/dev/null)
echo "$minimal_json" > "$G1_TMPDIR/minimal-config.json"

minimal_baseline=$(bash "$QUALITY_GATE" --variant baseline --config "$G1_TMPDIR/minimal-config.json" 2>/dev/null)
minimal_baseline_exit=$?
assert_eq "1c: minimal -> baseline exits 0" "0" "$minimal_baseline_exit"

minimal_bl_json_ok=0
echo "$minimal_baseline" | jq empty 2>/dev/null || minimal_bl_json_ok=$?
assert_eq "1c: minimal baseline output is valid JSON" "0" "$minimal_bl_json_ok"

minimal_bl_variant=$(echo "$minimal_baseline" | jq -r '.variant')
assert_eq "1c: minimal baseline variant field" "baseline" "$minimal_bl_variant"

# ===========================================================================
echo ""
echo "=== Group 2: Wave Scope -> Enforcement Pipeline ==="
# ===========================================================================

# Helper: set up a temp project dir with .claude/wave-scope.json
# Additional args after the JSON are subdirectories to create (for realpath resolution)
_scope_dir_counter=0
setup_scope_dir() {
  local json="$1"
  shift
  _scope_dir_counter=$((_scope_dir_counter + 1))
  local tmpdir="$MASTER_TMPDIR/scope_$_scope_dir_counter"
  mkdir -p "$tmpdir/.claude"
  echo "$json" > "$tmpdir/.claude/wave-scope.json"
  # Create subdirectories so realpath can resolve file paths
  while [[ $# -gt 0 ]]; do
    mkdir -p "$tmpdir/$1"
    shift
  done
  echo "$tmpdir"
}

# --- enforce-scope tests ---

# 2a: Strict mode, allowedPaths ["src/", "lib/"]
SCOPE_STRICT='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/","lib/"],"blockedCommands":["rm -rf"]}'
SCOPE_DIR_STRICT=$(setup_scope_dir "$SCOPE_STRICT" "src" "lib" "tests")

# Edit src/foo.ts -> exit 0 (allowed)
scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_STRICT/src/foo.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_STRICT" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "2a: strict Edit src/foo.ts -> exit 0" "0" "$scope_exit"

# Edit tests/bar.ts -> exit 2 (denied)
scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_STRICT/tests/bar.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_STRICT" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "2a: strict Edit tests/bar.ts -> exit 2" "2" "$scope_exit"

# Read tool -> exit 0 (not Edit/Write)
scope_exit=0
echo "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_STRICT/tests/bar.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_STRICT" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "2a: strict Read tests/bar.ts -> exit 0" "0" "$scope_exit"

# 2b: Warn mode
SCOPE_WARN='{"wave":1,"role":"Impl","enforcement":"warn","allowedPaths":["src/","lib/"],"blockedCommands":["rm -rf"]}'
SCOPE_DIR_WARN=$(setup_scope_dir "$SCOPE_WARN" "src" "lib" "tests")

scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_WARN/tests/bar.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_WARN" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "2b: warn Edit tests/bar.ts -> exit 0" "0" "$scope_exit"

# 2c: Off mode
SCOPE_OFF='{"wave":1,"role":"Impl","enforcement":"off","allowedPaths":["src/"],"blockedCommands":["rm -rf"]}'
SCOPE_DIR_OFF=$(setup_scope_dir "$SCOPE_OFF" "anywhere")

scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$SCOPE_DIR_OFF/anywhere/file.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$SCOPE_DIR_OFF" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "2c: off Edit anything -> exit 0" "0" "$scope_exit"

# 2d: No wave-scope.json file
NO_SCOPE_DIR="$MASTER_TMPDIR/no_scope"
mkdir -p "$NO_SCOPE_DIR/.claude"

scope_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$NO_SCOPE_DIR/anything.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$NO_SCOPE_DIR" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "2d: no scope file Edit -> exit 0" "0" "$scope_exit"

# --- enforce-commands tests ---

# 2e: Strict mode, blockedCommands ["rm -rf", "git push --force"]
CMD_STRICT='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/"],"blockedCommands":["rm -rf","git push --force"]}'
CMD_DIR_STRICT=$(setup_scope_dir "$CMD_STRICT" "src")

cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | CLAUDE_PROJECT_DIR="$CMD_DIR_STRICT" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || cmd_exit=$?
assert_eq "2e: strict Bash rm -rf -> exit 2" "2" "$cmd_exit"

cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  | CLAUDE_PROJECT_DIR="$CMD_DIR_STRICT" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || cmd_exit=$?
assert_eq "2e: strict Bash ls -la -> exit 0" "0" "$cmd_exit"

cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | CLAUDE_PROJECT_DIR="$CMD_DIR_STRICT" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || cmd_exit=$?
assert_eq "2e: strict Bash git push --force -> exit 2" "2" "$cmd_exit"

# 2f: Warn mode commands
CMD_WARN='{"wave":1,"role":"Impl","enforcement":"warn","allowedPaths":["src/"],"blockedCommands":["rm -rf"]}'
CMD_DIR_WARN=$(setup_scope_dir "$CMD_WARN" "src")

cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | CLAUDE_PROJECT_DIR="$CMD_DIR_WARN" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || cmd_exit=$?
assert_eq "2f: warn Bash rm -rf -> exit 0" "0" "$cmd_exit"

# 2g: Chain test — validate then enforce
CHAIN_SCOPE='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/","lib/"],"blockedCommands":["rm -rf"]}'
CHAIN_DIR="$MASTER_TMPDIR/chain"
mkdir -p "$CHAIN_DIR/.claude"

mkdir -p "$CHAIN_DIR/src" "$CHAIN_DIR/lib" "$CHAIN_DIR/outside"
validated_output=$(echo "$CHAIN_SCOPE" | bash "$VALIDATE_SCOPE" 2>/dev/null)
echo "$validated_output" > "$CHAIN_DIR/.claude/wave-scope.json"

chain_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$CHAIN_DIR/src/foo.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$CHAIN_DIR" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || chain_exit=$?
assert_eq "2g: chain validate->enforce src/foo.ts -> exit 0" "0" "$chain_exit"

chain_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$CHAIN_DIR/outside/bar.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$CHAIN_DIR" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || chain_exit=$?
assert_eq "2g: chain validate->enforce outside/bar.ts -> exit 2" "2" "$chain_exit"

chain_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | CLAUDE_PROJECT_DIR="$CHAIN_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || chain_exit=$?
assert_eq "2g: chain validate->enforce-cmd rm -rf -> exit 2" "2" "$chain_exit"

# ===========================================================================
echo ""
echo "=== Group 3: Glob Pattern Matching ==="
# ===========================================================================

# 3a: allowedPaths ["src/**/*.ts"]
GLOB_TS='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/**/*.ts"],"blockedCommands":[]}'
GLOB_DIR_TS=$(setup_scope_dir "$GLOB_TS" "src" "src/deep/nested" "lib")

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_TS/src/foo.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_TS" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3a: src/foo.ts matches src/**/*.ts -> exit 0" "0" "$glob_exit"

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_TS/src/deep/nested/bar.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_TS" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3a: src/deep/nested/bar.ts matches ** -> exit 0" "0" "$glob_exit"

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_TS/src/foo.js\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_TS" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3a: src/foo.js no match *.ts -> exit 2" "2" "$glob_exit"

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_TS/lib/foo.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_TS" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3a: lib/foo.ts wrong prefix -> exit 2" "2" "$glob_exit"

# 3b: allowedPaths ["docs/"]
GLOB_DOCS='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["docs/"],"blockedCommands":[]}'
GLOB_DIR_DOCS=$(setup_scope_dir "$GLOB_DOCS" "docs" "docs/sub")

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_DOCS/docs/guide.md\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_DOCS" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3b: docs/guide.md prefix match -> exit 0" "0" "$glob_exit"

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_DOCS/docs/sub/file.txt\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_DOCS" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3b: docs/sub/file.txt prefix match -> exit 0" "0" "$glob_exit"

# 3c: allowedPaths ["src/components/*.tsx", "src/lib/**"]
GLOB_MULTI='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/components/*.tsx","src/lib/**"],"blockedCommands":[]}'
GLOB_DIR_MULTI=$(setup_scope_dir "$GLOB_MULTI" "src/components" "src/components/deep" "src/lib/utils")

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_MULTI/src/components/Button.tsx\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_MULTI" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3c: src/components/Button.tsx -> exit 0" "0" "$glob_exit"

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_MULTI/src/components/deep/Button.tsx\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_MULTI" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3c: src/components/deep/Button.tsx * single segment -> exit 2" "2" "$glob_exit"

glob_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$GLOB_DIR_MULTI/src/lib/utils/helper.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$GLOB_DIR_MULTI" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || glob_exit=$?
assert_eq "3c: src/lib/utils/helper.ts ** recursive -> exit 0" "0" "$glob_exit"

# ===========================================================================
echo ""
echo "=== Group 4: Command Word-Boundary Matching ==="
# ===========================================================================

WB_SCOPE='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/"],"blockedCommands":["rm -rf","git reset --hard"]}'
WB_DIR=$(setup_scope_dir "$WB_SCOPE" "src")

wb_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | CLAUDE_PROJECT_DIR="$WB_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || wb_exit=$?
assert_eq "4: rm -rf / -> exit 2 (blocked)" "2" "$wb_exit"

wb_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"format"}}' \
  | CLAUDE_PROJECT_DIR="$WB_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || wb_exit=$?
assert_eq "4: format -> exit 0 (rm substring)" "0" "$wb_exit"

wb_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"git reset --hard HEAD"}}' \
  | CLAUDE_PROJECT_DIR="$WB_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || wb_exit=$?
assert_eq "4: git reset --hard HEAD -> exit 2" "2" "$wb_exit"

wb_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"git reset --soft HEAD"}}' \
  | CLAUDE_PROJECT_DIR="$WB_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || wb_exit=$?
assert_eq "4: git reset --soft HEAD -> exit 0" "0" "$wb_exit"

wb_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"perform"}}' \
  | CLAUDE_PROJECT_DIR="$WB_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || wb_exit=$?
assert_eq "4: perform -> exit 0 (no word boundary)" "0" "$wb_exit"

wb_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"  rm -rf /tmp"}}' \
  | CLAUDE_PROJECT_DIR="$WB_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || wb_exit=$?
assert_eq "4: leading whitespace rm -rf -> exit 2" "2" "$wb_exit"

# Additional: verify non-Bash tool is ignored
wb_exit=0
echo '{"tool_name":"Edit","tool_input":{"command":"rm -rf /"}}' \
  | CLAUDE_PROJECT_DIR="$WB_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || wb_exit=$?
assert_eq "4: Edit tool_name -> exit 0 (not Bash)" "0" "$wb_exit"

# Empty command
wb_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":""}}' \
  | CLAUDE_PROJECT_DIR="$WB_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || wb_exit=$?
assert_eq "4: empty command -> exit 0" "0" "$wb_exit"

# ===========================================================================
echo ""
echo "=== Group 5: Metrics JSONL Format ==="
# ===========================================================================

METRICS_TMPDIR="$MASTER_TMPDIR/metrics"
mkdir -p "$METRICS_TMPDIR"

# 5a: Write a valid sessions.jsonl line
SESSIONS_FILE="$METRICS_TMPDIR/sessions.jsonl"
SESSION_LINE='{"session_id":"test-2026-04-06-1200","session_type":"deep","started_at":"2026-04-06T12:00:00Z","completed_at":"2026-04-06T12:30:00Z","duration_seconds":1800,"total_waves":4,"total_agents":6,"total_files_changed":10,"agent_summary":{"complete":6,"partial":0,"failed":0,"spiral":0},"waves":[],"effectiveness":{"planned_issues":1,"completed":1,"carryover":0,"emergent":0,"completion_rate":1.0}}'
echo "$SESSION_LINE" > "$SESSIONS_FILE"

test -f "$SESSIONS_FILE"
file_exists=$?
assert_eq "5a: sessions.jsonl created" "0" "$file_exists"

session_json_ok=0
jq empty "$SESSIONS_FILE" 2>/dev/null || session_json_ok=$?
assert_eq "5a: sessions.jsonl is valid JSON" "0" "$session_json_ok"

session_has_id=$(jq -r 'has("session_id")' "$SESSIONS_FILE")
assert_eq "5a: has session_id" "true" "$session_has_id"

session_has_type=$(jq -r 'has("session_type")' "$SESSIONS_FILE")
assert_eq "5a: has session_type" "true" "$session_has_type"

session_has_started=$(jq -r 'has("started_at")' "$SESSIONS_FILE")
assert_eq "5a: has started_at" "true" "$session_has_started"

# 5b: Append a second line -> verify 2 lines, each valid JSON
SESSION_LINE2='{"session_id":"test-2026-04-06-1400","session_type":"feature","started_at":"2026-04-06T14:00:00Z","completed_at":"2026-04-06T14:45:00Z","duration_seconds":2700,"total_waves":3,"total_agents":4,"total_files_changed":5,"agent_summary":{"complete":4,"partial":0,"failed":0,"spiral":0},"waves":[],"effectiveness":{"planned_issues":2,"completed":2,"carryover":0,"emergent":0,"completion_rate":1.0}}'
echo "$SESSION_LINE2" >> "$SESSIONS_FILE"

line_count=$(wc -l < "$SESSIONS_FILE" | tr -d ' ')
assert_eq "5b: sessions.jsonl has 2 lines" "2" "$line_count"

all_valid=0
while IFS= read -r line; do
  echo "$line" | jq empty 2>/dev/null || { all_valid=1; break; }
done < "$SESSIONS_FILE"
assert_eq "5b: each line is valid JSON" "0" "$all_valid"

# 5c: Write a valid learnings.jsonl entry
LEARNINGS_FILE="$METRICS_TMPDIR/learnings.jsonl"
LEARNING_LINE='{"id":"test-uuid","type":"effective-sizing","subject":"test","insight":"test insight","evidence":"test evidence","confidence":0.7,"source_session":"test","created_at":"2026-04-06T12:00:00Z","expires_at":"2026-05-06T12:00:00Z"}'
echo "$LEARNING_LINE" > "$LEARNINGS_FILE"

learning_json_ok=0
jq empty "$LEARNINGS_FILE" 2>/dev/null || learning_json_ok=$?
assert_eq "5c: learnings.jsonl is valid JSON" "0" "$learning_json_ok"

learning_has_id=$(jq -r 'has("id")' "$LEARNINGS_FILE")
assert_eq "5c: has id" "true" "$learning_has_id"

learning_has_type=$(jq -r 'has("type")' "$LEARNINGS_FILE")
assert_eq "5c: has type" "true" "$learning_has_type"

learning_has_subject=$(jq -r 'has("subject")' "$LEARNINGS_FILE")
assert_eq "5c: has subject" "true" "$learning_has_subject"

learning_has_insight=$(jq -r 'has("insight")' "$LEARNINGS_FILE")
assert_eq "5c: has insight" "true" "$learning_has_insight"

learning_has_confidence=$(jq -r 'has("confidence")' "$LEARNINGS_FILE")
assert_eq "5c: has confidence" "true" "$learning_has_confidence"

learning_has_expires=$(jq -r 'has("expires_at")' "$LEARNINGS_FILE")
assert_eq "5c: has expires_at" "true" "$learning_has_expires"

# Verify confidence is between 0 and 1
confidence_valid=$(jq -r 'if .confidence >= 0 and .confidence <= 1 then "yes" else "no" end' "$LEARNINGS_FILE")
assert_eq "5c: confidence between 0 and 1" "yes" "$confidence_valid"

# ===========================================================================
echo ""
echo "=== Group 6: Edge Cases ==="
# ===========================================================================

# 6a: Empty allowedPaths (discovery wave) — deny-all
EDGE_EMPTY_PATHS='{"wave":1,"role":"Discovery","enforcement":"strict","allowedPaths":[],"blockedCommands":[]}'
EDGE_DIR_EMPTY=$(setup_scope_dir "$EDGE_EMPTY_PATHS" "src")

edge_exit=0
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$EDGE_DIR_EMPTY/src/foo.ts\"}}" \
  | CLAUDE_PROJECT_DIR="$EDGE_DIR_EMPTY" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || edge_exit=$?
assert_eq "6a: empty allowedPaths Edit src/foo.ts -> exit 2 (deny-all)" "2" "$edge_exit"

# 6b: Fallback blocklist — no blockedCommands field
EDGE_NO_BLOCKED='{"wave":1,"role":"Impl","enforcement":"strict","allowedPaths":["src/"]}'
EDGE_DIR_NO_BLOCKED=$(setup_scope_dir "$EDGE_NO_BLOCKED" "src")

edge_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | CLAUDE_PROJECT_DIR="$EDGE_DIR_NO_BLOCKED" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || edge_exit=$?
assert_eq "6b: no blockedCommands rm -rf -> exit 2 (fallback blocklist)" "2" "$edge_exit"

edge_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  | CLAUDE_PROJECT_DIR="$EDGE_DIR_NO_BLOCKED" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || edge_exit=$?
assert_eq "6b: no blockedCommands ls -la -> exit 0 (safe)" "0" "$edge_exit"

# 6c: Malformed hook input — graceful degradation

# Empty string to enforce-scope
edge_exit=0
echo "" \
  | CLAUDE_PROJECT_DIR="$EDGE_DIR_EMPTY" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || edge_exit=$?
assert_eq "6c: empty string to enforce-scope -> exit 0" "0" "$edge_exit"

# Empty JSON object to enforce-scope
edge_exit=0
echo '{}' \
  | CLAUDE_PROJECT_DIR="$EDGE_DIR_EMPTY" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || edge_exit=$?
assert_eq "6c: {} to enforce-scope -> exit 0" "0" "$edge_exit"

# Non-JSON to enforce-commands
edge_exit=0
echo 'this is not json at all' \
  | CLAUDE_PROJECT_DIR="$EDGE_DIR_NO_BLOCKED" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || edge_exit=$?
assert_eq "6c: non-JSON to enforce-commands -> exit 0" "0" "$edge_exit"

# 6d: Fallback blocklist covers git push --force and git reset --hard
edge_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | CLAUDE_PROJECT_DIR="$EDGE_DIR_NO_BLOCKED" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || edge_exit=$?
assert_eq "6d: fallback git push --force -> exit 2" "2" "$edge_exit"

edge_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"git reset --hard HEAD~1"}}' \
  | CLAUDE_PROJECT_DIR="$EDGE_DIR_NO_BLOCKED" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || edge_exit=$?
assert_eq "6d: fallback git reset --hard -> exit 2" "2" "$edge_exit"

# ===========================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] || exit 1
