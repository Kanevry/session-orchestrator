#!/usr/bin/env bash
set -euo pipefail

# Keep the documented Codex/Cursor startup diagnostic on stderr (GH#64).
if ! command -v jq >/dev/null 2>&1; then
  {
    echo "session-orchestrator: 'jq' not found in PATH — the MCP server did not start."
    echo "  Fix: install jq (macOS: brew install jq · Debian/Ubuntu: apt-get install jq), then restart the client."
    echo "  (MCP server shells do not source ~/.zshrc, so a jq that works in your terminal can still be invisible here.)"
  } >&2
  exit 1
fi

# BV-004 ceiling: use the plugin's required Node runtime for every request.
# Revisit-Trigger: supporting a standalone shell server on hosts without Node.
# jq accepts non-JSON numbers such as 01. Share handleLine() and its exact
# error ordering with the native transport instead of maintaining two parsers.
SO_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec /bin/sh "$SO_ROOT/hooks/run-node.sh" --fail-closed "$SO_ROOT/scripts/mcp-server.mjs"
