#!/usr/bin/env bash
set -euo pipefail

# MCP stdio server for session-orchestrator
# Speaks JSON-RPC 2.0 over stdin/stdout
#
# Exposes two read-only tools:
#   - session_config  — reads Session Config from the project instruction file
#                       (CLAUDE.md, or AGENTS.md alias on Codex CLI — see
#                       skills/_shared/instruction-file-resolution.md)
#   - session_metrics — reads last 5 session metrics entries

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
if ! command -v jq >/dev/null 2>&1; then
  # Emit a single error and exit; without jq we cannot operate
  printf '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"jq is required but not found in PATH"}}\n'
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
        "description": "Reads the last 5 session metrics entries from .orchestrator/metrics/sessions.jsonl",
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

  # Extract everything from "## Session Config" to the next heading or EOF
  local config
  config=$(sed -n '/^## Session Config$/,/^## /{/^## Session Config$/d;/^## /d;p;}' "$instr_file" 2>/dev/null) || true

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

  local metrics_file="$project_root/.orchestrator/metrics/sessions.jsonl"
  if [[ ! -f "$metrics_file" ]]; then
    metrics_file="$project_root/.claude/metrics/sessions.jsonl"
  fi
  if [[ ! -f "$metrics_file" ]]; then
    respond "$id" "$(text_content "No metrics found (checked .orchestrator/metrics/ and .claude/metrics/)")"
    return
  fi

  local entries
  entries=$(tail -n 5 "$metrics_file" 2>/dev/null) || true

  if [[ -z "$entries" ]]; then
    respond "$id" "$(text_content "No metrics found (file is empty)")"
    return
  fi

  # Derive a token summary from the most-recent record that carries token totals.
  # Fields total_token_input / total_token_output / subagents_with_tokens are
  # optional (null when no subagent token data was captured for that session).
  # Low coverage (subagents_with_tokens == 0 while matched_records > 0) means
  # the total is PARTIAL — do not read it as "free / zero cost".
  local token_summary
  # Use -Rrs (raw-input + slurp + raw-output) so jq receives the multi-line
  # JSONL block as a single string, can split + parse each line independently,
  # and outputs plain text (no surrounding JSON quotes on the result string).
  # The plain -r flag alone does not work for multi-record JSONL piped as one
  # string — it treats the entire input as a single JSON value.
  token_summary=$(printf '%s' "$entries" | \
    jq -Rrs '
      # Parse each non-empty line as JSON; skip malformed lines.
      [ split("\n")[] | select(length > 0) | (try fromjson catch null) | select(. != null) ]
      | reverse
      | ( map(select( (.total_token_input != null) or (.total_token_output != null) )) | first ) as $rec
      | if $rec then
          "tokens: \($rec.total_token_input // "?") in / \($rec.total_token_output // "?") out" +
          " (coverage: \($rec.subagents_with_tokens // 0) subagents)" +
          ( if ($rec.subagents_with_tokens // 0) == 0 then
              " ⚠ partial — subagent token data missing; total is not a reliable cost estimate"
            else "" end ) +
          " [session: \($rec.session_id // "unknown")]"
        else
          "tokens: no token data in last 5 sessions (subagent telemetry not yet captured)"
        end
    ' 2>/dev/null) || token_summary=""

  local output
  if [[ -n "$token_summary" ]]; then
    output="${entries}

--- token summary ---
${token_summary}"
  else
    output="$entries"
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
