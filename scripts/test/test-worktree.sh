#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/worktree.sh"

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

# Set up a fresh git repo for worktree operations
TEST_REPO="$MASTER_TMPDIR/test-repo"
mkdir -p "$TEST_REPO"
git init "$TEST_REPO" >/dev/null 2>&1
(cd "$TEST_REPO" && git commit --allow-empty -m "initial commit" >/dev/null 2>&1)

# Override TMPDIR so worktrees land inside our temp dir
export TMPDIR="$MASTER_TMPDIR"

# ===========================================================================
echo "=== Worktree Tests ==="
# ===========================================================================

# Helper: create_worktree may emit git stdout noise; extract last line (the path)
run_create_worktree() {
  local output
  output=$(cd "$TEST_REPO" && create_worktree "$@" 2>/dev/null)
  echo "$output" | tail -1
}

# 1: create_worktree basic — returned path exists as a directory
wt_path=$(run_create_worktree "test1")
assert_eq "1: create_worktree returns existing directory" "yes" "$( [ -d "$wt_path" ] && echo yes || echo no )"

# 2: create_worktree branch name — so-worktree-<suffix> branch exists
branch_exists=$(cd "$TEST_REPO" && git branch --list "so-worktree-test1" | grep -q "so-worktree-test1" && echo yes || echo no)
assert_eq "2: create_worktree creates so-worktree-<suffix> branch" "yes" "$branch_exists"

# 3: create_worktree collision handling — second call with same suffix succeeds
wt_path2=$(run_create_worktree "test1")
assert_eq "3: create_worktree collision succeeds (dir exists)" "yes" "$( [ -d "$wt_path2" ] && echo yes || echo no )"

# Clean up test1 before continuing
(cd "$TEST_REPO" && cleanup_worktree "$wt_path2")

# 4: create_worktree custom base-ref — explicit HEAD works
wt_path_base=$(run_create_worktree "test-base" HEAD)
assert_eq "4: create_worktree with explicit base-ref HEAD" "yes" "$( [ -d "$wt_path_base" ] && echo yes || echo no )"

# 5: cleanup_worktree removes directory
(cd "$TEST_REPO" && cleanup_worktree "$wt_path_base")
assert_eq "5: cleanup_worktree removes directory" "no" "$( [ -d "$wt_path_base" ] && echo yes || echo no )"

# 6: cleanup_worktree removes branch
branch_gone=$(cd "$TEST_REPO" && git branch --list "so-worktree-test-base" | grep -q "so-worktree-test-base" && echo yes || echo no)
assert_eq "6: cleanup_worktree removes so-worktree-* branch" "no" "$branch_gone"

# 7: cleanup_worktree warns on uncommitted changes
wt_dirty=$(run_create_worktree "dirty")
echo "uncommitted content" > "$wt_dirty/dirty-file.txt"
(cd "$wt_dirty" && git add dirty-file.txt)
warn_output=$(cd "$TEST_REPO" && cleanup_worktree "$wt_dirty" 2>&1 >/dev/null) || true
has_warning=$(echo "$warn_output" | grep -q "WARNING.*uncommitted" && echo yes || echo no)
assert_eq "7: cleanup_worktree warns on uncommitted changes" "yes" "$has_warning"

# 8: cleanup_worktree nonexistent path — returns 0
(cd "$TEST_REPO" && cleanup_worktree "$MASTER_TMPDIR/nonexistent-path")
assert_eq "8: cleanup_worktree nonexistent path returns 0" "0" "$?"

# 9: cleanup_all_worktrees removes all so-worktree-* entries
wt_a=$(run_create_worktree "all-a")
wt_b=$(run_create_worktree "all-b")
(cd "$TEST_REPO" && cleanup_all_worktrees)
both_gone="yes"
[ -d "$wt_a" ] && both_gone="no"
[ -d "$wt_b" ] && both_gone="no"
assert_eq "9: cleanup_all_worktrees removes both worktrees" "yes" "$both_gone"

# 10: cleanup_all_worktrees prunes — only main worktree remains
wt_count=$(cd "$TEST_REPO" && git worktree list | wc -l | tr -d ' ')
assert_eq "10: after cleanup_all only main worktree remains" "1" "$wt_count"

# ===========================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] || exit 1
