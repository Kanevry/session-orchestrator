# common.sh — shared library for session-orchestrator scripts
# Sourced by callers, not executed directly.

# Print error message to stderr and exit 1
die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Print warning message to stderr (does not exit)
warn() {
  echo "WARNING: $*" >&2
}

# Check that jq is available
require_jq() {
  command -v jq &>/dev/null || die "jq is required but not installed. Install via: brew install jq"
}

# Walk up from CWD (or $1) looking for CLAUDE.md or .claude/ directory.
# Echoes the found project root, or CWD if nothing found.
find_project_root() {
  # Fast path: trust CLAUDE_PROJECT_DIR if it has the right markers
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    if [[ -f "$CLAUDE_PROJECT_DIR/CLAUDE.md" || -d "$CLAUDE_PROJECT_DIR/.claude" ]]; then
      echo "$CLAUDE_PROJECT_DIR"
      return
    fi
  fi

  local dir
  dir="${1:-$(pwd)}"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/CLAUDE.md" || -d "$dir/.claude" ]]; then
      echo "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done
  pwd
}

# Resolve the session-orchestrator plugin root directory.
# Tries $CLAUDE_PLUGIN_ROOT first, then walks up from this script's location
# looking for skills/ directory.
resolve_plugin_root() {
  if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -d "$CLAUDE_PLUGIN_ROOT" ]]; then
    echo "$CLAUDE_PLUGIN_ROOT"
    return
  fi

  # Walk up from the sourcing script's directory
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")" && pwd)"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/plugin.json" || -d "$dir/skills" ]]; then
      echo "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done
  die "Could not locate plugin root from ${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}"
}
