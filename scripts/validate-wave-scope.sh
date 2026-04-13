#!/usr/bin/env bash
# validate-wave-scope.sh — Validate .claude/wave-scope.json before enforcement hooks consume it
# Part of Session Orchestrator v2.0
#
# Usage:
#   validate-wave-scope.sh <path-to-wave-scope.json>
#   cat wave-scope.json | validate-wave-scope.sh
#
# Exit codes:
#   0 — valid (validated JSON echoed to stdout)
#   1 — invalid (error messages written to stderr)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_jq

read_input() {
  if [[ -n "${1:-}" ]]; then
    if [[ ! -f "$1" ]]; then
      echo "ERROR: File not found: $1" >&2
      exit 1
    fi
    cat "$1"
  else
    cat
  fi
}

validate_json() {
  local input="$1"
  if ! echo "$input" | jq empty 2>/dev/null; then
    echo "ERROR: Input is not valid JSON" >&2
    exit 1
  fi
}

validate_required_fields() {
  local input="$1"

  # wave — must be a positive integer (> 0)
  local wave_raw
  wave_raw=$(echo "$input" | jq -r '.wave // empty')
  if [[ -z "$wave_raw" ]]; then
    echo "Missing required field: wave"
  else
    local is_int
    is_int=$(echo "$input" | jq 'if (.wave | type) == "number" and (.wave | floor) == .wave and .wave > 0 then "yes" else "no" end' -r)
    if [[ "$is_int" != "yes" ]]; then
      echo "wave must be a positive integer, got: $wave_raw"
    fi
  fi

  # role — must be a non-empty string
  local role_type
  role_type=$(echo "$input" | jq -r '.role | type' 2>/dev/null) || role_type="null"
  if [[ "$role_type" != "string" ]]; then
    echo "role must be a string, got type: $role_type"
  else
    local role_val
    role_val=$(echo "$input" | jq -r '.role')
    if [[ -z "$role_val" ]]; then
      echo "role must be a non-empty string"
    fi
  fi

  # enforcement — must be exactly one of: strict, warn, off
  local enforcement_type
  enforcement_type=$(echo "$input" | jq -r '.enforcement | type' 2>/dev/null) || enforcement_type="null"
  if [[ "$enforcement_type" != "string" ]]; then
    echo "enforcement must be a string, got type: $enforcement_type"
  else
    local enforcement_val
    enforcement_val=$(echo "$input" | jq -r '.enforcement')
    if [[ "$enforcement_val" != "strict" && "$enforcement_val" != "warn" && "$enforcement_val" != "off" ]]; then
      echo "enforcement must be one of: strict, warn, off — got: $enforcement_val"
    fi
  fi
}

validate_allowed_paths() {
  local input="$1"

  local ap_type
  ap_type=$(echo "$input" | jq -r 'if has("allowedPaths") then (.allowedPaths | type) else "missing" end' 2>/dev/null) || ap_type="missing"
  if [[ "$ap_type" == "missing" ]]; then
    echo "Missing required field: allowedPaths"
  elif [[ "$ap_type" != "array" ]]; then
    echo "allowedPaths must be an array, got type: $ap_type"
  else
    local path_count
    path_count=$(echo "$input" | jq '.allowedPaths | length')
    local i
    for (( i = 0; i < path_count; i++ )); do
      local entry
      entry=$(echo "$input" | jq -r ".allowedPaths[$i]")

      if [[ -z "$entry" ]]; then
        echo "allowedPaths contains empty string"
        continue
      fi

      if [[ "$entry" == /* ]]; then
        echo "allowedPaths contains absolute path: $entry"
      fi

      if [[ "$entry" == *"../"* ]]; then
        echo "allowedPaths contains path traversal: $entry"
      fi

      # warn, don't fail
      if [[ "$entry" == "**/*" || "$entry" == "*" ]]; then
        echo "WARNING: allowedPaths contains overly permissive pattern: $entry" >&2
      fi
    done
  fi
}

validate_blocked_commands() {
  local input="$1"

  local bc_type
  bc_type=$(echo "$input" | jq -r 'if has("blockedCommands") then (.blockedCommands | type) else "missing" end' 2>/dev/null) || bc_type="missing"
  if [[ "$bc_type" == "missing" ]]; then
    echo "Missing required field: blockedCommands"
  elif [[ "$bc_type" != "array" ]]; then
    echo "blockedCommands must be an array, got type: $bc_type"
  fi
}

validate_gates() {
  local input="$1"
  local gates_type
  gates_type=$(echo "$input" | jq -r 'if has("gates") then (.gates | type) else "missing" end' 2>/dev/null) || gates_type="missing"
  [[ "$gates_type" == "missing" ]] && return 0  # gates is optional

  if [[ "$gates_type" != "object" ]]; then
    echo "gates must be an object, got type: $gates_type"
    return
  fi

  # Each gate value must be a boolean
  local bad_gates
  bad_gates=$(echo "$input" | jq -r '.gates | to_entries | map(select((.value | type) != "boolean")) | map(.key) | join(", ")')
  if [[ -n "$bad_gates" ]]; then
    echo "gates values must be booleans, invalid entries: $bad_gates"
  fi
}

validate() {
  local input="$1"
  local error_output

  validate_json "$input"

  error_output=$(validate_required_fields "$input")
  error_output+=$(printf '\n%s' "$(validate_allowed_paths "$input")")
  error_output+=$(printf '\n%s' "$(validate_blocked_commands "$input")")
  error_output+=$(printf '\n%s' "$(validate_gates "$input")")

  # Strip leading/trailing blank lines
  error_output=$(echo "$error_output" | sed '/^$/d')

  if [[ -n "$error_output" ]]; then
    while IFS= read -r err; do
      echo "ERROR: $err" >&2
    done <<< "$error_output"
    return 1
  fi

  echo "$input"
}

INPUT=$(read_input "$@")
validate "$INPUT"
