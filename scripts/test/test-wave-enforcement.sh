#!/usr/bin/env bash
set -u

# ===========================================================================
echo ""
echo "=== Group 2: Wave Scope -> Enforcement Pipeline ==="
# ===========================================================================

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
