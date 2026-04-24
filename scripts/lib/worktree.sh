# worktree.sh — git worktree helpers for session-orchestrator
# Sourced by callers, not executed directly.
# Provides worktree create/cleanup for platforms without built-in isolation.

# create_worktree <branch-suffix> [base-ref]
# Creates a git worktree for isolated agent work.
# Returns the worktree path via stdout.
# Args:
#   branch-suffix: unique suffix for the worktree branch (e.g., "wave2-agent1")
#   base-ref: git ref to base the worktree on (default: HEAD)
# Example: path=$(create_worktree "wave2-agent1")
create_worktree() {
  local suffix="${1:?Usage: create_worktree <suffix> [base-ref]}"
  local base="${2:-HEAD}"
  local branch="so-worktree-${suffix}"
  local worktree_dir="${TMPDIR:-/tmp}/so-worktrees/${branch}"

  mkdir -p "$(dirname "$worktree_dir")"
  git worktree add -b "$branch" "$worktree_dir" "$base" 2>/dev/null || {
    # Branch may already exist from a previous failed run — remove and retry
    git worktree remove "$worktree_dir" --force 2>/dev/null || true
    git branch -D "$branch" 2>/dev/null || true
    git worktree add -b "$branch" "$worktree_dir" "$base"
  }

  # -------------------------------------------------------------------------
  # Exclude build artifacts (issue #192)
  # -------------------------------------------------------------------------
  # Read V_WORKTREE_EXCLUDE from the environment (set by parse-config.sh callers)
  # or fall back to the hardcoded default 10-pattern list.
  local _wt_exclude_json="${V_WORKTREE_EXCLUDE:-}"

  local _patterns
  if [[ -z "$_wt_exclude_json" || "$_wt_exclude_json" == "null" ]]; then
    # Hardcoded default — mirrors DEFAULT_EXCLUDE_PATTERNS in worktree.mjs
    _patterns="node_modules dist build .next .nuxt coverage .cache .turbo .vercel out"
  else
    # Parse JSON array produced by parse-config.sh into whitespace-separated list.
    # Uses jq when available; otherwise falls back to sed-based extraction.
    if command -v jq >/dev/null 2>&1; then
      _patterns="$(echo "$_wt_exclude_json" | jq -r '.[]?' 2>/dev/null | tr '\n' ' ')" || _patterns=""
    else
      # NOTE: sed fallback assumes ASCII directory names with no embedded commas
      # or quotes inside values. Canonical parser is jq (preferred path above).
      _patterns="$(echo "$_wt_exclude_json" | sed 's/^\[//;s/\]$//' | tr ',' '\n' | sed 's/^[[:space:]]*"//;s/"[[:space:]]*$//' | tr '\n' ' ')"
    fi
  fi

  local _pattern
  for _pattern in $_patterns; do
    local _target="${worktree_dir}/${_pattern}"
    if [ -d "$_target" ]; then
      rm -rf "$_target" && echo "[worktree] excluded: ${_pattern}" >&2 || true
    fi
  done

  echo "$worktree_dir"
}

# cleanup_worktree <worktree-path>
# Removes a worktree and its associated branch.
# If the worktree has uncommitted changes, emits a warning to stderr.
cleanup_worktree() {
  local worktree_path="${1:?Usage: cleanup_worktree <path>}"

  [ ! -d "$worktree_path" ] && return 0

  # Check if worktree has uncommitted changes
  if (cd "$worktree_path" && [ -n "$(git status --porcelain)" ]); then
    echo "WARNING: worktree at $worktree_path has uncommitted changes" >&2
  fi

  # Get the branch name before removing
  local branch=""
  branch=$(cd "$worktree_path" && git rev-parse --abbrev-ref HEAD 2>/dev/null) || branch=""

  # Remove worktree
  git worktree remove "$worktree_path" --force 2>/dev/null || true

  # Clean up the temporary branch
  if [ -n "$branch" ]; then
    case "$branch" in
      so-worktree-*) git branch -D "$branch" 2>/dev/null || true ;;
    esac
  fi
}

# cleanup_all_worktrees
# Removes all session-orchestrator worktrees (so-worktree-* branches).
cleanup_all_worktrees() {
  git worktree list --porcelain | while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        local path="${line#worktree }"
        case "$path" in
          *so-worktree*) cleanup_worktree "$path" ;;
        esac
        ;;
    esac
  done

  # Prune any stale worktree references
  git worktree prune 2>/dev/null || true
}
