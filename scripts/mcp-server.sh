#!/usr/bin/env bash
set -euo pipefail

# MCP stdio server for session-orchestrator
# Speaks JSON-RPC 2.0 over stdin/stdout
#
# Exposes two read-only tools:
#   - session_config  — reads Session Config from the project instruction file
#                       (CLAUDE.md, or AGENTS.md alias on Codex CLI — see
#                       skills/_shared/instruction-file-resolution.md)
#   - session_metrics — reads last 5 canonical MEASURED session metrics entries
#                       via the shared native reader (#1584)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

respond() {
  # $id is expected to be valid JSON already (a quoted string, a number, or the
  # literal null — see the main loop's id extraction). Rebuild via jq so the id
  # and result are re-encoded as valid JSON regardless of their original type.
  local id="$1" result="$2"
  jq -nc --argjson id "$id" --argjson result "$result" \
    '{jsonrpc:"2.0",id:$id,result:$result}'
}

respond_error() {
  # $id is valid JSON (quoted string / number / null). $code is numeric
  # (--argjson); $msg is an arbitrary string (--arg, jq quotes + escapes it).
  local id="$1" code="$2" msg="$3"
  jq -nc --argjson id "$id" --argjson code "$code" --arg msg "$msg" \
    '{jsonrpc:"2.0",id:$id,error:{code:$code,message:$msg}}'
}

text_content() {
  local text="$1"
  jq -nc --arg t "$text" '{"content":[{"type":"text","text":$t}]}'
}

# ---------------------------------------------------------------------------
# Verify jq is available (fatal — we cannot parse JSON without it)
# ---------------------------------------------------------------------------
# The diagnostic goes to STDERR, never stdout. A `{"id":null,"error":...}` line
# on stdout is NOT a valid `initialize` response, so the client reports the same
# opaque "connection closed: initialize response" it reports when the script
# cannot be found at all — the two failure modes were indistinguishable
# (GH Kanevry/session-orchestrator#64). A named, actionable stderr line keeps
# them apart. Same shape as hooks/run-node.sh's Node-missing diagnostic.
if ! command -v jq >/dev/null 2>&1; then
  {
    echo "session-orchestrator: 'jq' not found in PATH — the MCP server did not start."
    echo "  Fix: install jq (macOS: brew install jq · Debian/Ubuntu: apt-get install jq), then restart the client."
    echo "  (MCP server shells do not source ~/.zshrc, so a jq that works in your terminal can still be invisible here.)"
  } >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Protocol handlers
# ---------------------------------------------------------------------------

handle_initialize() {
  local id="$1"
  local result
  result=$(jq -nc '{
    "protocolVersion": "2024-11-05",
    "capabilities": {"tools": {}},
    "serverInfo": {
      "name": "session-orchestrator",
      "version": "2.0.0"
    }
  }')
  respond "$id" "$result"
}

handle_tools_list() {
  local id="$1"
  local result
  result=$(jq -nc '{
    "tools": [
      {
        "name": "session_config",
        "description": "Reads Session Config section from the project instruction file (CLAUDE.md or AGENTS.md alias)",
        "inputSchema": {"type": "object", "properties": {}, "required": []}
      },
      {
        "name": "session_metrics",
        "description": "Reads the last 5 MEASURED session metrics entries from .orchestrator/metrics/sessions.jsonl (unmeasured records excluded)",
        "inputSchema": {"type": "object", "properties": {}, "required": []}
      }
    ]
  }')
  respond "$id" "$result"
}

handle_tools_call() {
  local id="$1" line="$2"

  local tool_name
  tool_name=$(printf '%s' "$line" | jq -r '.params.name // empty' 2>/dev/null) || true

  case "$tool_name" in
    session_config)
      tool_session_config "$id"
      ;;
    session_metrics)
      tool_session_metrics "$id"
      ;;
    *)
      respond_error "$id" -32602 "Unknown tool: $tool_name"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

tool_session_config() {
  local id="$1"
  local project_root
  project_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    respond "$id" "$(text_content "Error: not inside a git repository")"
    return
  }

  # Resolve project-instruction file (CLAUDE.md or AGENTS.md alias).
  # See skills/_shared/instruction-file-resolution.md for the alias rule.
  local instr_file=""
  if [[ -s "$project_root/CLAUDE.md" ]]; then
    instr_file="$project_root/CLAUDE.md"
  elif [[ -s "$project_root/AGENTS.md" ]]; then
    instr_file="$project_root/AGENTS.md"
  fi
  if [[ -z "$instr_file" ]]; then
    respond "$id" "$(text_content "No CLAUDE.md or AGENTS.md found at $project_root")"
    return
  fi

  # Extract everything from "## Session Config" to the next heading or EOF.
  #
  # The address matches isSessionConfigHeading() in
  # scripts/lib/config/section-extractor.mjs (the SSOT) exactly: the literal
  # heading, plus an optional CR so a CRLF checkout is read the same way. Shell
  # cannot import the JS predicate, so the alignment is by hand and this
  # comment names the authority. Before #968 this was the only STRICTER site in
  # the repo — a bare `$` anchors before the CR in a BRE, so on a CRLF checkout
  # (this plugin ships to Windows-side Codex/Cursor users) the tool reported
  # "no Session Config section" for a file the runtime parses fine.
  #
  # `\r` is not portable inside a BRE (GNU sed only), so the CR is injected as
  # a literal byte via printf.
  local cr config sc_re
  cr=$(printf '\r')
  sc_re="^## Session Config${cr}\{0,1\}\$"
  config=$(sed -n "/$sc_re/,/^## /{/$sc_re/d;/^## /d;p;}" "$instr_file" 2>/dev/null) || true

  if [[ -z "$config" ]]; then
    respond "$id" "$(text_content "No '## Session Config' section found in $instr_file")"
    return
  fi

  respond "$id" "$(text_content "$config")"
}

tool_session_metrics() {
  local id="$1"
  local project_root
  project_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    respond "$id" "$(text_content "Error: not inside a git repository")"
    return
  }

  # Delegate to the same reader as the native transport: canonical identity,
  # measured-session definition, main-checkout ledger and token summary.
  local server_dir output
  server_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  if ! output=$(node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { readSessionMetrics } = await import(pathToFileURL(process.argv[2]).href);
    process.stdout.write(readSessionMetrics(process.argv[3]));
  ' session-metrics-reader "$server_dir/mcp-server.mjs" "$project_root" </dev/null); then
    respond_error "$id" -32603 "Unable to read session data"
    return
  fi
  respond "$id" "$(text_content "$output")"
}

# ---------------------------------------------------------------------------
# Main loop — read JSON-RPC messages from stdin, one per line
# ---------------------------------------------------------------------------

while IFS= read -r line; do
  [[ -z "$line" ]] && continue

  method=$(printf '%s' "$line" | jq -r '.method // empty' 2>/dev/null) || continue
  # Extract id as VALID JSON (never bare, never empty): a quoted string ("foo"),
  # a number (5), or the literal null. -c keeps it compact so it can be fed
  # straight back into jq via --argjson in respond()/respond_error().
  id=$(printf '%s' "$line" | jq -c '.id // null' 2>/dev/null) || id=null

  case "$method" in
    initialize)
      handle_initialize "$id"
      ;;
    notifications/*)
      # Notifications require no response
      ;;
    tools/list)
      handle_tools_list "$id"
      ;;
    tools/call)
      handle_tools_call "$id" "$line"
      ;;
    *)
      # $id is already valid JSON (literal null when the request omitted it),
      # so no ${id:-null} fallback is needed.
      respond_error "$id" -32601 "Method not found: $method"
      ;;
  esac
done
