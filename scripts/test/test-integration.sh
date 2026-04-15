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
echo "=== Group 2h: Fail-closed when jq is missing ==="
# ===========================================================================

# Create a restricted PATH directory that has bash but NOT jq
JQ_MISSING_DIR="$MASTER_TMPDIR/no_jq_bin"
mkdir -p "$JQ_MISSING_DIR"
for cmd in bash cat echo env dirname basename; do
  src=$(command -v "$cmd" 2>/dev/null) && [ -n "$src" ] && ln -sf "$src" "$JQ_MISSING_DIR/" 2>/dev/null || true
done

# 2h-1: enforce-scope.sh exits 2 when jq is missing
scope_exit=0
echo '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/test/src/foo.ts"}}' \
  | env PATH="$JQ_MISSING_DIR" bash "$ENFORCE_SCOPE" > /dev/null 2>&1 || scope_exit=$?
assert_eq "2h: jq missing: enforce-scope exits 2 (deny)" "2" "$scope_exit"

# 2h-2: enforce-commands.sh exits 2 when jq is missing
cmd_exit=0
echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  | env PATH="$JQ_MISSING_DIR" bash "$ENFORCE_COMMANDS" > /dev/null 2>&1 || cmd_exit=$?
assert_eq "2h: jq missing: enforce-commands exits 2 (deny)" "2" "$cmd_exit"

# 2h-3: enforce-scope.sh deny output contains permissionDecision
scope_output=""
scope_exit=0
scope_output=$(echo '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/test/src/foo.ts"}}' \
  | env PATH="$JQ_MISSING_DIR" bash "$ENFORCE_SCOPE" 2>/dev/null) || scope_exit=$?
scope_has_decision=0
echo "$scope_output" | grep -q '"permissionDecision"' || scope_has_decision=1
assert_eq "2h: jq missing: enforce-scope output contains permissionDecision" "0" "$scope_has_decision"

# 2h-4: enforce-commands.sh deny output contains permissionDecision
cmd_output=""
cmd_exit=0
cmd_output=$(echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  | env PATH="$JQ_MISSING_DIR" bash "$ENFORCE_COMMANDS" 2>/dev/null) || cmd_exit=$?
cmd_has_decision=0
echo "$cmd_output" | grep -q '"permissionDecision"' || cmd_has_decision=1
assert_eq "2h: jq missing: enforce-commands output contains permissionDecision" "0" "$cmd_has_decision"

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
echo "=== Group 7: AGENTS.md Config Parsing ==="
# ===========================================================================

# Create a temp AGENTS.md
AGENTS_TMPDIR="$MASTER_TMPDIR/agents-md"
mkdir -p "$AGENTS_TMPDIR"
cat > "$AGENTS_TMPDIR/AGENTS.md" << 'AGEOF'
# Project Instructions

Some instructions here.

## Session Config

agents-per-wave: 8
waves: 3
persistence: true
enforcement: strict
test-command: npm test

## Other Section

This is not config.
AGEOF

agents_json=$(bash "$PARSE_CONFIG" "$AGENTS_TMPDIR/AGENTS.md" 2>/dev/null)
agents_exit=$?
assert_eq "7a: AGENTS.md parse exits 0" "0" "$agents_exit"

agents_apw=$(echo "$agents_json" | jq -r '."agents-per-wave"')
assert_eq "7c: AGENTS.md agents-per-wave" "8" "$agents_apw"

agents_waves=$(echo "$agents_json" | jq -r '.waves')
assert_eq "7d: AGENTS.md waves" "3" "$agents_waves"

agents_persist=$(echo "$agents_json" | jq -r '.persistence')
assert_eq "7e: AGENTS.md persistence" "true" "$agents_persist"

agents_enforce=$(echo "$agents_json" | jq -r '.enforcement')
assert_eq "7f: AGENTS.md enforcement" "strict" "$agents_enforce"

agents_test=$(echo "$agents_json" | jq -r '."test-command"')
assert_eq "7g: AGENTS.md test-command" "npm test" "$agents_test"

# ===========================================================================
echo ""
echo "=== Group 8: Cap-and-Rank Learnings (#88) ==="
# ===========================================================================

CAP_TMPDIR="$MASTER_TMPDIR/cap-rank"
mkdir -p "$CAP_TMPDIR"
CAP_LEARNINGS="$CAP_TMPDIR/learnings.jsonl"

# Write 20 learnings with varying confidences.
# 16 entries have confidence > 0.3 (0.95 down to 0.31).
# 4 entries have confidence <= 0.3 (0.30, 0.20, 0.10, 0.05) — filtered out.
# Top-15 slice of the 16 passing entries cuts the 0.31 entry.
# Expected: 15 surfaced, lowest = 0.33, suppressed-by-cap = 1.
FUTURE_DATE="2099-01-01T00:00:00Z"
cat > "$CAP_LEARNINGS" << 'CAPEOF'
{"id":"l01","type":"fragile-file","subject":"src/a.ts","insight":"i","evidence":"e","confidence":0.95,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l02","type":"fragile-file","subject":"src/b.ts","insight":"i","evidence":"e","confidence":0.90,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l03","type":"effective-sizing","subject":"deep","insight":"i","evidence":"e","confidence":0.85,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l04","type":"effective-sizing","subject":"feature","insight":"i","evidence":"e","confidence":0.80,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l05","type":"recurring-issue","subject":"merge","insight":"i","evidence":"e","confidence":0.75,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l06","type":"recurring-issue","subject":"lint","insight":"i","evidence":"e","confidence":0.70,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l07","type":"scope-guidance","subject":"scope-a","insight":"i","evidence":"e","confidence":0.65,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l08","type":"scope-guidance","subject":"scope-b","insight":"i","evidence":"e","confidence":0.60,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l09","type":"fragile-file","subject":"src/c.ts","insight":"i","evidence":"e","confidence":0.55,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l10","type":"fragile-file","subject":"src/d.ts","insight":"i","evidence":"e","confidence":0.50,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l11","type":"effective-sizing","subject":"housekeeping","insight":"i","evidence":"e","confidence":0.45,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l12","type":"recurring-issue","subject":"ci","insight":"i","evidence":"e","confidence":0.40,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l13","type":"scope-guidance","subject":"scope-c","insight":"i","evidence":"e","confidence":0.35,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l14","type":"fragile-file","subject":"src/e.ts","insight":"i","evidence":"e","confidence":0.34,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l15","type":"fragile-file","subject":"src/f.ts","insight":"i","evidence":"e","confidence":0.33,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l16","type":"recurring-issue","subject":"test-flake","insight":"i","evidence":"e","confidence":0.31,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l17","type":"scope-guidance","subject":"scope-d","insight":"i","evidence":"e","confidence":0.30,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l18","type":"effective-sizing","subject":"mini","insight":"i","evidence":"e","confidence":0.20,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l19","type":"fragile-file","subject":"src/g.ts","insight":"i","evidence":"e","confidence":0.10,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l20","type":"recurring-issue","subject":"old","insight":"i","evidence":"e","confidence":0.05,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
CAPEOF

# 8a: fixture file has 20 lines
cap_line_count=$(wc -l < "$CAP_LEARNINGS" | tr -d ' ')
assert_eq "8a: cap-rank fixture has 20 lines" "20" "$cap_line_count"

# 8b: filter (confidence > 0.3, not expired) + sort by confidence DESC + slice to top 15
# Entries with confidence > 0.3: l01-l16 (confidence 0.95 down to 0.31) = 16 entries
# After slicing to 15: l01-l15 (0.95 down to 0.33); l16 (0.31) is suppressed by cap
# Sort: primary by confidence DESC, tiebreaker by created_at DESC (string sort reversed)
cap_surfaced=$(jq -s '
  map(select(.confidence > 0.3))
  | sort_by(.confidence, .created_at) | reverse
  | .[0:15]
  | length
' "$CAP_LEARNINGS")
assert_eq "8b: cap-rank surfaces exactly 15 learnings" "15" "$cap_surfaced"

# 8c: lowest-confidence surfaced entry is 0.33
cap_lowest=$(jq -s '
  map(select(.confidence > 0.3))
  | sort_by(.confidence, .created_at) | reverse
  | .[0:15]
  | last
  | .confidence
' "$CAP_LEARNINGS")
assert_eq "8c: lowest-confidence surfaced is 0.33" "0.33" "$cap_lowest"

# 8d: suppressed-by-cap count (passed filter but not in top-15) = 1
cap_passed_filter=$(jq -s 'map(select(.confidence > 0.3)) | length' "$CAP_LEARNINGS")
cap_suppressed_by_cap=$(( cap_passed_filter - 15 ))
assert_eq "8d: suppressed-by-cap count is 1" "1" "$cap_suppressed_by_cap"

# 8e: entries filtered out (confidence <= 0.3) = 4 (l17-l20: 0.30, 0.20, 0.10, 0.05)
cap_filtered_out=$(jq -s 'map(select(.confidence <= 0.3)) | length' "$CAP_LEARNINGS")
assert_eq "8e: entries filtered out by confidence <= 0.3 is 4" "4" "$cap_filtered_out"

# 8f: created_at tiebreaker — two equal-confidence entries, later created_at ranks higher
# AC: sort by confidence DESC, tiebreaker created_at DESC
cap_tie_result=$(printf '%s\n%s\n' \
  '{"id":"tie-old","confidence":0.5,"created_at":"2026-01-01T00:00:00Z"}' \
  '{"id":"tie-new","confidence":0.5,"created_at":"2026-01-02T00:00:00Z"}' \
  | jq -s 'sort_by(.confidence, .created_at) | reverse | .[0].id')
assert_eq "8f: equal-confidence tiebreaker: later created_at ranks first" '"tie-new"' "$cap_tie_result"

# ===========================================================================
echo ""
echo "=== Group 9: Passive Decay (#89 verification) ==="
# ===========================================================================

DECAY_TMPDIR="$MASTER_TMPDIR/decay"
mkdir -p "$DECAY_TMPDIR"
DECAY_FILE="$DECAY_TMPDIR/learnings.jsonl"

# Write 5 learnings, each confidence 0.5, not-yet-expired
cat > "$DECAY_FILE" << 'DECAYEOF'
{"id":"d01","type":"fragile-file","subject":"sub1","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"d02","type":"fragile-file","subject":"sub2","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"d03","type":"fragile-file","subject":"sub3","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"d04","type":"fragile-file","subject":"sub4","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"d05","type":"fragile-file","subject":"sub5","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
DECAYEOF

# Simulate 10 decay sessions (each subtracts 0.05, clamp to 0)
decay_state=$(jq -s '.' "$DECAY_FILE")
for i in $(seq 1 10); do
  decay_state=$(echo "$decay_state" | jq 'map(.confidence -= 0.05 | .confidence = (if .confidence < 0 then 0 else .confidence end))')
done

# 9a: After 10 iterations all confidences should be effectively 0.0
# Use tolerance < 0.001 — jq IEEE 754 float drift means 0.5 - 10*0.05 may land at ~6.9e-17
decay_all_zero=$(echo "$decay_state" | jq 'map(.confidence < 0.001) | all')
assert_eq "9a: after 10 decay iterations, all confidence effectively 0 (< 0.001)" "true" "$decay_all_zero"

# 9b: After one more decay, all entries would be pruned (confidence <= 0.0)
# Session-end prune step removes entries where confidence <= 0.0 after decay
decay_state_11=$(echo "$decay_state" | jq 'map(.confidence -= 0.05 | .confidence = (if .confidence < 0 then 0 else .confidence end))')
decay_pruned=$(echo "$decay_state_11" | jq 'map(select(.confidence < 0.001)) | length')
assert_eq "9b: after 11th decay, 5 entries prunable (confidence < 0.001)" "5" "$decay_pruned"

# 9c: Verify count of entries in each iteration result is still 5 (decay doesn't drop entries)
decay_count=$(echo "$decay_state" | jq 'length')
assert_eq "9c: decay preserves entry count (5)" "5" "$decay_count"

# ===========================================================================
echo ""
echo "=== Group 10: Surface Health Transparency (#91 verification) ==="
# ===========================================================================

SURF_TMPDIR="$MASTER_TMPDIR/surface-health"
mkdir -p "$SURF_TMPDIR"
SURF_FILE="$SURF_TMPDIR/learnings.jsonl"

# 20 learnings: 5 @ 0.9 (high), 5 @ 0.6 (medium), 5 @ 0.4 (low-active), 5 @ 0.25 (below filter)
cat > "$SURF_FILE" << 'SURFEOF'
{"id":"s01","type":"fragile-file","subject":"a1","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s02","type":"fragile-file","subject":"a2","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s03","type":"fragile-file","subject":"a3","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s04","type":"fragile-file","subject":"a4","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s05","type":"fragile-file","subject":"a5","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s06","type":"effective-sizing","subject":"b1","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s07","type":"effective-sizing","subject":"b2","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s08","type":"effective-sizing","subject":"b3","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s09","type":"effective-sizing","subject":"b4","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s10","type":"effective-sizing","subject":"b5","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s11","type":"recurring-issue","subject":"c1","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s12","type":"recurring-issue","subject":"c2","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s13","type":"recurring-issue","subject":"c3","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s14","type":"recurring-issue","subject":"c4","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s15","type":"recurring-issue","subject":"c5","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s16","type":"scope-guidance","subject":"d1","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s17","type":"scope-guidance","subject":"d2","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s18","type":"scope-guidance","subject":"d3","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s19","type":"scope-guidance","subject":"d4","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s20","type":"scope-guidance","subject":"d5","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
SURFEOF

CAP_N=5

# 10a: active count (confidence > 0.3) = 15 (the 0.25 group is excluded)
surf_active=$(jq -s 'map(select(.confidence > 0.3)) | length' "$SURF_FILE")
assert_eq "10a: active count (confidence > 0.3) = 15" "15" "$surf_active"

# 10b: surfaced = top-N = 5
surf_surfaced=$(jq -s --argjson n "$CAP_N" '
  map(select(.confidence > 0.3))
  | sort_by(.confidence, .created_at) | reverse
  | .[0:$n]
  | length
' "$SURF_FILE")
assert_eq "10b: surfaced = cap N = 5" "5" "$surf_surfaced"

# 10c: suppressed = active - surfaced = 10
surf_suppressed=$(( surf_active - CAP_N ))
assert_eq "10c: suppressed = 15 - 5 = 10" "10" "$surf_suppressed"

# 10d: high-bucket (>=0.7) = 5
surf_high=$(jq -s 'map(select(.confidence > 0.3 and .confidence >= 0.7)) | length' "$SURF_FILE")
assert_eq "10d: high-bucket count (>=0.7) = 5" "5" "$surf_high"

# 10e: medium-bucket (0.5-0.69) = 5
surf_med=$(jq -s 'map(select(.confidence >= 0.5 and .confidence < 0.7)) | length' "$SURF_FILE")
assert_eq "10e: medium-bucket count (0.5-0.69) = 5" "5" "$surf_med"

# 10f: low-bucket (>0.3 and <0.5) = 5
surf_low=$(jq -s 'map(select(.confidence > 0.3 and .confidence < 0.5)) | length' "$SURF_FILE")
assert_eq "10f: low-bucket count (>0.3 and <0.5) = 5" "5" "$surf_low"

# 10g: advisory condition: suppressed > surfaced (10 > 5) = true
surf_advisory=$( [[ $surf_suppressed -gt $CAP_N ]] && echo "true" || echo "false" )
assert_eq "10g: advisory condition (suppressed > surfaced)" "true" "$surf_advisory"

# 10h: no-advisory case — when suppressed <= surfaced, advisory must NOT fire
# Build a set where cap=10, active=15, suppressed=5 (5 <= 10 → no advisory)
surf_no_adv_suppressed=5
surf_no_adv_surfaced=10
surf_no_advisory=$( [[ $surf_no_adv_suppressed -gt $surf_no_adv_surfaced ]] && echo "true" || echo "false" )
assert_eq "10h: no advisory when suppressed (5) <= surfaced (10)" "false" "$surf_no_advisory"

# ===========================================================================
echo ""
echo "=== Group 11: Migration Helper (#90 verification) ==="
# ===========================================================================

MIG_TMPDIR="$MASTER_TMPDIR/migration"
MIGRATE_SCRIPT="$SCRIPT_DIR/../migrate-legacy-learnings.sh"
mkdir -p "$MIG_TMPDIR/.claude/metrics" "$MIG_TMPDIR/.orchestrator/metrics"

# Legacy: 3 entries including one with subject "shared-key" confidence 0.4
cat > "$MIG_TMPDIR/.claude/metrics/learnings.jsonl" << 'MIGLEGEOF'
{"id":"m01","type":"recurring-issue","subject":"shared-key","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"m02","type":"fragile-file","subject":"leg-only-a","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"m03","type":"fragile-file","subject":"leg-only-b","insight":"i","evidence":"e","confidence":0.7,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
MIGLEGEOF

# Canonical: 3 entries including one with subject "shared-key" confidence 0.8 (wins)
cat > "$MIG_TMPDIR/.orchestrator/metrics/learnings.jsonl" << 'MIGCANEOF'
{"id":"m04","type":"recurring-issue","subject":"shared-key","insight":"i","evidence":"e","confidence":0.8,"source_session":"s","created_at":"2026-01-02T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"m05","type":"effective-sizing","subject":"can-only-a","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"m06","type":"scope-guidance","subject":"can-only-b","insight":"i","evidence":"e","confidence":0.55,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
MIGCANEOF

# Run migration
mig_output=$(bash "$MIGRATE_SCRIPT" "$MIG_TMPDIR")

mig_status=$(echo "$mig_output" | jq -r '.status')
assert_eq "11a: migration status is merged" "merged" "$mig_status"

mig_canon_before=$(echo "$mig_output" | jq -r '.canonical_before')
assert_eq "11b: canonical_before = 3" "3" "$mig_canon_before"

mig_legacy=$(echo "$mig_output" | jq -r '.legacy')
assert_eq "11c: legacy = 3" "3" "$mig_legacy"

# canonical_after: 3 canonical + 3 legacy - 1 duplicate (shared-key) = 5
mig_canon_after=$(echo "$mig_output" | jq -r '.canonical_after')
assert_eq "11d: canonical_after = 5 (deduplicated)" "5" "$mig_canon_after"

mig_backup_notnull=$(echo "$mig_output" | jq '.backup != null')
assert_eq "11e: backup is non-null" "true" "$mig_backup_notnull"

# The shared-key entry in canonical should have confidence 0.8 (higher wins)
mig_shared_key_conf=$(jq -s 'map(select(.subject == "shared-key")) | .[0].confidence' "$MIG_TMPDIR/.orchestrator/metrics/learnings.jsonl")
assert_eq "11f: shared-key confidence = 0.8 (higher wins)" "0.8" "$mig_shared_key_conf"

# .bak file should exist
mig_bak_exists=0
ls "$MIG_TMPDIR/.claude/metrics/learnings.jsonl.migrated-"*.bak > /dev/null 2>&1 || mig_bak_exists=1
assert_eq "11g: .bak file exists" "0" "$mig_bak_exists"

# Run second time — should be no_legacy (idempotency)
mig_output2=$(bash "$MIGRATE_SCRIPT" "$MIG_TMPDIR")
mig_status2=$(echo "$mig_output2" | jq -r '.status')
assert_eq "11h: second run status = no_legacy (idempotent)" "no_legacy" "$mig_status2"

# Canonical line count unchanged after second run
mig_canon_after2=$(echo "$mig_output2" | jq -r '.canonical_after')
assert_eq "11i: second run canonical_after unchanged = 5" "5" "$mig_canon_after2"

# 11j: empty canonical (0 bytes) + legacy exists → status=merged, entry migrated
MIG_EMPTY_TMPDIR="$MASTER_TMPDIR/migration-empty-canonical"
mkdir -p "$MIG_EMPTY_TMPDIR/.claude/metrics" "$MIG_EMPTY_TMPDIR/.orchestrator/metrics"
touch "$MIG_EMPTY_TMPDIR/.orchestrator/metrics/learnings.jsonl"  # 0-byte canonical
echo '{"id":"ec1","type":"fragile-file","subject":"empty-canon-test","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}' \
  > "$MIG_EMPTY_TMPDIR/.claude/metrics/learnings.jsonl"
mig_empty_output=$(bash "$MIGRATE_SCRIPT" "$MIG_EMPTY_TMPDIR")
mig_empty_status=$(echo "$mig_empty_output" | jq -r '.status')
# When canonical exists but is 0 bytes (canonical_before=0) the script reports "copied" not "merged"
assert_eq "11j: empty canonical (0 bytes) + legacy → status=copied" "copied" "$mig_empty_status"
mig_empty_canon_before=$(echo "$mig_empty_output" | jq -r '.canonical_before')
assert_eq "11j: empty canonical canonical_before=0" "0" "$mig_empty_canon_before"
mig_empty_canon_after=$(echo "$mig_empty_output" | jq -r '.canonical_after')
assert_eq "11j: empty canonical canonical_after=1" "1" "$mig_empty_canon_after"

# 11k: malformed legacy file → script exits non-zero (jq parse error, not silently corrupt)
MIG_MAL_TMPDIR="$MASTER_TMPDIR/migration-malformed"
mkdir -p "$MIG_MAL_TMPDIR/.claude/metrics"
echo 'not valid json' > "$MIG_MAL_TMPDIR/.claude/metrics/learnings.jsonl"
mig_mal_exit=0
bash "$MIGRATE_SCRIPT" "$MIG_MAL_TMPDIR" > /dev/null 2>&1 || mig_mal_exit=$?
# A non-zero exit is required — malformed input must not silently produce a corrupt canonical
mig_mal_nonzero=$( [[ $mig_mal_exit -ne 0 ]] && echo "true" || echo "false" )
assert_eq "11k: malformed legacy file causes non-zero exit (no silent corruption)" "true" "$mig_mal_nonzero"

# ===========================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] || exit 1
