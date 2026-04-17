#!/usr/bin/env bash
set -u

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
