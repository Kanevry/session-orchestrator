#!/bin/sh
# hooks/run-node.sh — resolve the Node.js binary robustly, then exec a plugin hook.
#
# Why this exists (GH Kanevry/session-orchestrator#53): the Claude Code harness
# executes hook commands via `/bin/sh -c` with the PATH of the harness process
# itself. That shell does NOT source ~/.zshrc / ~/.bashrc, so Node installed via
# Homebrew on Apple Silicon (/opt/homebrew/bin), nvm, volta, or asdf may be
# invisible to hooks even though `node` works fine in a normal terminal. A bare
# `node ...` command then fails with "node: command not found" on EVERY hook of
# EVERY tool call — loud, repetitive, and useless to the operator.
#
# Contract:
#   sh run-node.sh [--fail-closed] <hook-script.mjs> [args...]
#   - Resolution order: $SO_NODE_BIN override > PATH > well-known install dirs
#     ($SO_NODE_SEARCH_DIRS, colon-separated, overrides the built-in list) > nvm.
#   - A relative SO_NODE_BIN, PATH entry, search-list entry or nvm directory is
#     skipped, never resolved against the cwd (the repo being worked on).
#   - Automatic lookup skips the working and project directories themselves
#     and any node_modules segment. It skips descendants of the project unless
#     the project is a filesystem root, the user's home or an ancestor of home.
#     SO_NODE_BIN remains an explicit absolute override. An unexpanded `~` or
#     `~/…` PATH entry is rewritten to HOME first and then checked like any
#     other entry.
#     CEILING (BV-004): with the project at HOME and the hook's cwd in a repo
#     below it, that repo's own bin/ on PATH is trusted, as before #2237. A
#     project at HOME does not shape PATH itself (settings come from the user,
#     direnv acts when the harness starts in the repo, which then is the
#     project). Revisit if a harness ever starts in HOME and enters repos.
#   - Found:   exec's node — stdin/stdout/stderr and exit code pass through
#              unchanged (PreToolUse exit-2 blocking still works).
#   - Missing with --fail-closed: prints a diagnostic every time and exits 2.
#   - Missing otherwise: prints ONE warning per rate-limit window (marker file in
#              ${TMPDIR:-/tmp}, 6h TTL) and exits 0 so hooks degrade gracefully
#              instead of spamming a shell error on every tool call.

fail_closed=false
if [ "${1-}" = "--fail-closed" ]; then
  fail_closed=true
  shift
fi

# 1. Explicit operator override wins — only as an absolute path. A relative
#    value would resolve against the hook's cwd, the repo being worked on; it is
#    ignored like an unset one. A drive-letter form (`C:/…`) counts only on
#    Windows (`OS=Windows_NT`, inherited by Git Bash): on macOS and Linux it is
#    a relative path. A backslash form is never taken, because a value without
#    `/` would make `exec` search PATH.
so_node_bin_abs=false
case "${SO_NODE_BIN:-}" in
  /*) so_node_bin_abs=true ;;
  [A-Za-z]:/*) [ "${OS:-}" = Windows_NT ] && so_node_bin_abs=true ;;
esac
if [ "$so_node_bin_abs" = true ] && [ -x "${SO_NODE_BIN:-}" ]; then
  exec "${SO_NODE_BIN:-}" "$@"
fi

# 2. Check candidates before exec, including automatic fallback locations.
# Comparing ancestor directories by identity handles trailing separators,
# filesystem case rules and short names without mistaking a sibling with a
# common prefix for a descendant. Check the spelling and the physical directory
# so neither a link into the project nor a project-local link out is trusted.
working_dir=$PWD
absolute_dir() {
  case "$1" in
    /*) return 0 ;;
    [A-Za-z]:[\\/]* | \\\\*) [ "${OS:-}" = Windows_NT ] ;;
    *) return 1 ;;
  esac
}

project_dir=${CLAUDE_PROJECT_DIR:-}
absolute_dir "$project_dir" || project_dir=$working_dir

at_or_below() {
  ancestor=$1
  while :; do
    [ "$ancestor" -ef "$2" ] && return 0
    case "$ancestor" in
      /) return 1 ;;
      */*) ancestor=${ancestor%/*}; ancestor=${ancestor:-/} ;;
      *) return 1 ;;
    esac
  done
}

# Same rule as hookProgram: compare the physical home with the project once.
# PWD is a subtree boundary only when it supplied the project directory.
broad_project() (
  [ "$project_dir" -ef "$project_dir/.." ] && return 0
  home_dir=${HOME:-}
  if [ "${OS:-}" = Windows_NT ]; then
    home_dir=${USERPROFILE:-}
    CDPATH= cd -P "$project_dir" || return 1
    # Git Bash exposes drive roots as /c, /d, etc.
    case "$PWD" in /[A-Za-z]) [ "$PWD" -ef "${PWD#/}:/" ] && return 0 ;; esac
  fi
  absolute_dir "$home_dir" && CDPATH= cd -P "$home_dir" && at_or_below "$PWD" "$project_dir"
)
exclude_tree=true
if broad_project 2>/dev/null; then exclude_tree=false; fi

outside_project() {
  case "/$1/" in
    *[\\/][nN][oO][dD][eE]_[mM][oO][dD][uU][lL][eE][sS][\\/]*) return 1 ;;
  esac
  [ "$1" -ef "$working_dir" ] && return 1
  if [ "$exclude_tree" = true ]; then
    ! at_or_below "$1" "$project_dir"
  else
    ! [ "$1" -ef "$project_dir" ]
  fi
}

trusted_program() {
  # Keep missing PATH candidates in this shell; only an actual executable
  # needs a subshell in which to change directories.
  [ -f "$1" ] && [ -x "$1" ] || return 1
  trusted_location "$1"
}

trusted_location() (
  candidate=$1
  absolute_dir "$candidate" || return 1
  while :; do
    parent=${candidate%/*}
    parent=${parent:-/}
    outside_project "$parent" || return 1
    CDPATH= cd -P "$parent" 2>/dev/null || return 1
    if [ "$PWD" != "$parent" ]; then
      outside_project "$PWD" || return 1
    fi
    [ -L "$candidate" ] || return 0
    # PATH itself is untrusted. Use the system lookup for readlink, including
    # on hosts whose realpath utility lacks support for resolving files.
    # The sentinel preserves any trailing newlines in the link value.
    target=$(command -p readlink "$candidate" && printf '.') || return 1
    target=${target%'
.'}
    case "$target" in
      /*) candidate=$target ;;
      *) candidate=$PWD/$target ;;
    esac
  done
)

# Parse literal colon-delimited entries, preserving spaces and glob characters.
lookup_program() {
  rest=$1:
  while [ -n "$rest" ]; do
    dir=${rest%%:*}
    rest=${rest#*:}
    # An unexpanded `~` or `~/…` entry (fnm, mise, nodenv) means the home folder:
    # rewrite it to an absolute HOME path, as 5.21.x promised. `~user/…` is never
    # resolved. A colon in HOME would split the result into further, possibly
    # relative, entries: then the entry is dropped like any other relative one.
    # The rewritten entry then passes the same trust checks as any other.
    case "${HOME-}" in
      *:*) ;;
      /*)
        case "$dir" in
          \~) dir="$HOME" ;;
          \~/*) dir="$HOME/${dir#\~/}" ;;
        esac
        ;;
    esac
    case "$dir" in
      /*)
        program=$dir/$2
        if trusted_program "$program"; then return 0; fi
        ;;
    esac
  done
  return 1
}

if lookup_program "${PATH-}" node; then
  exec "$program" "$@"
fi

# 3. Well-known install locations (Homebrew arm64/intel, system, volta, asdf).
search_dirs="${SO_NODE_SEARCH_DIRS:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:${VOLTA_HOME:-${HOME:-}/.volta}/bin:${HOME:-}/.asdf/shims:${HOME:-}/.local/bin}"
if lookup_program "$search_dirs" node; then
  exec "$program" "$@"
fi

# Windows paths are checked separately to preserve spaces and drive-letter colons.
# An explicit search list disables these built-in locations (#1900).
if [ "${SO_NODE_SEARCH_DIRS+x}" != x ]; then
  for dir in "${ProgramFiles:+$ProgramFiles/nodejs}" \
    "${PROGRAMFILES:+$PROGRAMFILES/nodejs}" \
    "${LOCALAPPDATA:+$LOCALAPPDATA/Volta/bin}" "${NVM_SYMLINK:-}"; do
    if [ -n "$dir" ] && trusted_program "$dir/node"; then
      exec "$dir/node" "$@"
    fi
  done
fi

# 4. nvm keeps versioned dirs; glob order is lexical for this last resort.
for cand in "${NVM_DIR:-${HOME:-}/.nvm}"/versions/node/*/bin/node; do
  if trusted_program "$cand"; then
    exec "$cand" "$@"
  fi
done

# Diagnose relative PATH entries too, without ever invoking their node.
if command -v node >/dev/null 2>&1; then
  diagnostic="Node candidates on the hook PATH were rejected by the path rules (relative, working directory, project or node_modules)."
else
  diagnostic="'node' not found on the hook PATH."
fi

if [ "$fail_closed" = true ]; then
  echo "session-orchestrator: $diagnostic The tool call is blocked. Fix: install Node.js 24+, expose it on the harness PATH as an absolute directory (relative PATH entries are never searched), or set SO_NODE_BIN=/abs/path/to/node." >&2
  exit 2
fi

# 5. Not found anywhere: degrade gracefully. Warn at most once per 6 hours so
#    the operator gets ONE actionable diagnostic instead of per-tool-call spam.
#    Deliberately dependency-free: a PATH broken enough to lose `node` may also
#    lack `touch`/`find`/`id`, so the marker is written via shell redirection
#    and `find` only upgrades the check to a 6h TTL when it happens to exist.
marker="${TMPDIR:-/tmp}/session-orchestrator-node-missing-${USER:-uid}"
if [ -f "$marker" ]; then
  # The warning path uses the same trust boundary as the Node lookup.
  if lookup_program "${PATH-}" find; then
    expired=$("$program" "$marker" -mmin +360 2>/dev/null || true)
  else
    expired=""
  fi
else
  expired="yes"
fi
if [ -n "$expired" ]; then
  : > "$marker" 2>/dev/null || true
  {
    echo "session-orchestrator: $diagnostic Plugin hooks are skipped."
    echo "  Fix: install Node.js 24+, expose it on the harness PATH as an absolute directory"
    echo "  (relative PATH entries are never searched), or set SO_NODE_BIN=/abs/path/to/node."
    echo "  (Hook shells do not source ~/.zshrc — Homebrew/nvm/volta installs can be invisible here."
    echo "   Rate-limited to once per 6h. See docs/USER-GUIDE.md § Node is missing from the hook PATH.)"
  } >&2
fi
exit 0
