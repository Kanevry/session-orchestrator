#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_LIB="$SCRIPT_DIR/../lib/platform.sh"

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

# ===========================================================================
echo "=== Platform Detection Tests ==="
# ===========================================================================

# 1: Claude Code detection via env var
result=$(
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  export CLAUDE_PLUGIN_ROOT=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "1: Claude detection via CLAUDE_PLUGIN_ROOT" "claude" "$result"

# 2: Codex detection via env var
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  export CODEX_PLUGIN_ROOT=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "2: Codex detection via CODEX_PLUGIN_ROOT" "codex" "$result"

# 3: State dir for Claude
result=$(
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  export CLAUDE_PLUGIN_ROOT=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_STATE_DIR"
)
assert_eq "3: State dir for Claude is .claude" ".claude" "$result"

# 4: State dir for Codex
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  export CODEX_PLUGIN_ROOT=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_STATE_DIR"
)
assert_eq "4: State dir for Codex is .codex" ".codex" "$result"

# 5: Config file for Claude
result=$(
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  export CLAUDE_PLUGIN_ROOT=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_CONFIG_FILE"
)
assert_eq "5: Config file for Claude is CLAUDE.md" "CLAUDE.md" "$result"

# 6: Config file for Codex
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  export CODEX_PLUGIN_ROOT=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_CONFIG_FILE"
)
assert_eq "6: Config file for Codex is AGENTS.md" "AGENTS.md" "$result"

# 7a: Shared dir always .orchestrator (Claude)
result=$(
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  export CLAUDE_PLUGIN_ROOT=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_SHARED_DIR"
)
assert_eq "7a: Shared dir for Claude is .orchestrator" ".orchestrator" "$result"

# 7b: Shared dir always .orchestrator (Codex)
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  export CODEX_PLUGIN_ROOT=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_SHARED_DIR"
)
assert_eq "7b: Shared dir for Codex is .orchestrator" ".orchestrator" "$result"

# 8: Default platform is claude (no env vars, no markers)
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_EMPTY="$MASTER_TMPDIR/empty"
  mkdir -p "$TMPDIR_EMPTY"
  cd "$TMPDIR_EMPTY"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "8: Default platform is claude" "claude" "$result"

# 9: Cursor detection via env var
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  export CURSOR_RULES_DIR=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "9: Cursor detection via CURSOR_RULES_DIR" "cursor" "$result"

# 10: State dir for Cursor
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  export CURSOR_RULES_DIR=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_STATE_DIR"
)
assert_eq "10: State dir for Cursor is .cursor" ".cursor" "$result"

# 11: Config file for Cursor
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  export CURSOR_RULES_DIR=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_CONFIG_FILE"
)
assert_eq "11: Config file for Cursor is CLAUDE.md" "CLAUDE.md" "$result"

# 12: Shared dir for Cursor
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  export CURSOR_RULES_DIR=/tmp/test
  source "$PLATFORM_LIB"
  echo "$SO_SHARED_DIR"
)
assert_eq "12: Shared dir for Cursor is .orchestrator" ".orchestrator" "$result"

# ---------------------------------------------------------------------------
# Slow-path tests: marker directory detection (no env vars)
# ---------------------------------------------------------------------------

# 13: Claude slow path — .claude-plugin/ marker in CWD
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_13="$MASTER_TMPDIR/t13"
  mkdir -p "$TMPDIR_13/.claude-plugin"
  cd "$TMPDIR_13"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "13: Claude slow path via .claude-plugin marker" "claude" "$result"

# 14: Codex slow path — .codex-plugin/ marker in CWD
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_14="$MASTER_TMPDIR/t14"
  mkdir -p "$TMPDIR_14/.codex-plugin"
  cd "$TMPDIR_14"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "14: Codex slow path via .codex-plugin marker" "codex" "$result"

# 15: Cursor slow path — .cursor/rules/ marker in CWD
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_15="$MASTER_TMPDIR/t15"
  mkdir -p "$TMPDIR_15/.cursor/rules"
  cd "$TMPDIR_15"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "15: Cursor slow path via .cursor/rules marker" "cursor" "$result"

# 16: Walk-up from subdirectory — Claude
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_16="$MASTER_TMPDIR/t16"
  mkdir -p "$TMPDIR_16/.claude-plugin"
  mkdir -p "$TMPDIR_16/src/components"
  cd "$TMPDIR_16/src/components"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "16: Walk-up from subdir detects Claude marker" "claude" "$result"

# 17: Walk-up from subdirectory — Codex
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_17="$MASTER_TMPDIR/t17"
  mkdir -p "$TMPDIR_17/.codex-plugin"
  mkdir -p "$TMPDIR_17/src/components"
  cd "$TMPDIR_17/src/components"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "17: Walk-up from subdir detects Codex marker" "codex" "$result"

# 18: Walk-up from subdirectory — Cursor
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_18="$MASTER_TMPDIR/t18"
  mkdir -p "$TMPDIR_18/.cursor/rules"
  mkdir -p "$TMPDIR_18/src/components"
  cd "$TMPDIR_18/src/components"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "18: Walk-up from subdir detects Cursor marker" "cursor" "$result"

# 19: Priority — closest marker wins (child .claude-plugin beats parent .codex-plugin)
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_19="$MASTER_TMPDIR/t19"
  mkdir -p "$TMPDIR_19/.codex-plugin"
  mkdir -p "$TMPDIR_19/child/.claude-plugin"
  cd "$TMPDIR_19/child"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "19: Closest marker wins (claude over parent codex)" "claude" "$result"

# 20: No markers defaults to claude
result=$(
  unset CLAUDE_PLUGIN_ROOT 2>/dev/null || true
  unset CODEX_PLUGIN_ROOT 2>/dev/null || true
  unset CURSOR_RULES_DIR 2>/dev/null || true
  TMPDIR_20="$MASTER_TMPDIR/t20"
  mkdir -p "$TMPDIR_20"
  cd "$TMPDIR_20"
  source "$PLATFORM_LIB"
  echo "$SO_PLATFORM"
)
assert_eq "20: No markers defaults to claude" "claude" "$result"

# ===========================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] || exit 1
