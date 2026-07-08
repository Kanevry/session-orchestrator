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
#   sh run-node.sh <hook-script.mjs> [args...]
#   - Resolution order: $SO_NODE_BIN override > PATH > well-known install dirs
#     ($SO_NODE_SEARCH_DIRS, colon-separated, overrides the built-in list) > nvm.
#   - Found:   exec's node — stdin/stdout/stderr and exit code pass through
#              unchanged (PreToolUse exit-2 blocking still works).
#   - Missing: prints ONE warning per rate-limit window (marker file in
#              ${TMPDIR:-/tmp}, 6h TTL) and exits 0 so hooks degrade gracefully
#              instead of spamming a shell error on every tool call.

# 1. Explicit operator override wins.
if [ -n "$SO_NODE_BIN" ] && [ -x "$SO_NODE_BIN" ]; then
  exec "$SO_NODE_BIN" "$@"
fi

# 2. PATH as inherited from the harness.
if command -v node >/dev/null 2>&1; then
  exec node "$@"
fi

# 3. Well-known install locations (Homebrew arm64/intel, system, volta, asdf).
search_dirs="${SO_NODE_SEARCH_DIRS:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:${VOLTA_HOME:-$HOME/.volta}/bin:$HOME/.asdf/shims:$HOME/.local/bin}"
old_ifs="$IFS"
IFS=:
for dir in $search_dirs; do
  if [ -n "$dir" ] && [ -x "$dir/node" ]; then
    IFS="$old_ifs"
    exec "$dir/node" "$@"
  fi
done
IFS="$old_ifs"

# 4. nvm keeps versioned dirs; any installed version is good enough for hooks.
#    (Glob order is lexical, not semver — acceptable for a last-resort fallback.)
for cand in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node; do
  if [ -x "$cand" ]; then
    exec "$cand" "$@"
  fi
done

# 5. Not found anywhere: degrade gracefully. Warn at most once per 6 hours so
#    the operator gets ONE actionable diagnostic instead of per-tool-call spam.
#    Deliberately dependency-free: a PATH broken enough to lose `node` may also
#    lack `touch`/`find`/`id`, so the marker is written via shell redirection
#    and `find` only upgrades the check to a 6h TTL when it happens to exist.
marker="${TMPDIR:-/tmp}/session-orchestrator-node-missing-${USER:-uid}"
if [ -f "$marker" ]; then
  expired="$(find "$marker" -mmin +360 2>/dev/null || true)"
else
  expired="yes"
fi
if [ -n "$expired" ]; then
  : > "$marker" 2>/dev/null || true
  {
    echo "session-orchestrator: 'node' not found on the hook PATH — plugin hooks are skipped."
    echo "  Fix: install Node.js 24+, expose it on the harness PATH, or set SO_NODE_BIN=/abs/path/to/node."
    echo "  (Hook shells do not source ~/.zshrc — Homebrew/nvm/volta installs can be invisible here."
    echo "   Rate-limited to once per 6h. See README.md § Troubleshooting.)"
  } >&2
fi
exit 0
