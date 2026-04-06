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

validate() {
  local input="$1"
  local errors=()

  # 1. JSON validity
  if ! echo "$input" | jq empty 2>/dev/null; then
    echo "ERROR: Input is not valid JSON" >&2
    exit 1
  fi

  # 2. Required fields with type checking

  # wave — must be a positive integer (> 0)
  local wave_raw
  wave_raw=$(echo "$input" | jq -r '.wave // empty')
  if [[ -z "$wave_raw" ]]; then
    errors+=("Missing required field: wave")
  else
    local is_int
    is_int=$(echo "$input" | jq 'if (.wave | type) == "number" and (.wave | floor) == .wave and .wave > 0 then "yes" else "no" end' -r)
    if [[ "$is_int" != "yes" ]]; then
      errors+=("wave must be a positive integer, got: $wave_raw")
    fi
  fi

  # role — must be a non-empty string
  local role_type
  role_type=$(echo "$input" | jq -r '.role | type' 2>/dev/null) || role_type="null"
  if [[ "$role_type" != "string" ]]; then
    errors+=("role must be a string, got type: $role_type")
  else
    local role_val
    role_val=$(echo "$input" | jq -r '.role')
    if [[ -z "$role_val" ]]; then
      errors+=("role must be a non-empty string")
    fi
  fi

  # enforcement — must be exactly one of: strict, warn, off
  local enforcement_type
  enforcement_type=$(echo "$input" | jq -r '.enforcement | type' 2>/dev/null) || enforcement_type="null"
  if [[ "$enforcement_type" != "string" ]]; then
    errors+=("enforcement must be a string, got type: $enforcement_type")
  else
    local enforcement_val
    enforcement_val=$(echo "$input" | jq -r '.enforcement')
    if [[ "$enforcement_val" != "strict" && "$enforcement_val" != "warn" && "$enforcement_val" != "off" ]]; then
      errors+=("enforcement must be one of: strict, warn, off — got: $enforcement_val")
    fi
  fi

  # allowedPaths — must be an array
  local ap_type
  ap_type=$(echo "$input" | jq -r 'if has("allowedPaths") then (.allowedPaths | type) else "missing" end' 2>/dev/null) || ap_type="missing"
  if [[ "$ap_type" == "missing" ]]; then
    errors+=("Missing required field: allowedPaths")
  elif [[ "$ap_type" != "array" ]]; then
    errors+=("allowedPaths must be an array, got type: $ap_type")
  else
    # 3. Security checks on allowedPaths entries
    local path_count
    path_count=$(echo "$input" | jq '.allowedPaths | length')
    local i
    for (( i = 0; i < path_count; i++ )); do
      local entry
      entry=$(echo "$input" | jq -r ".allowedPaths[$i]")

      # Reject empty strings
      if [[ -z "$entry" ]]; then
        errors+=("allowedPaths contains empty string")
        continue
      fi

      # Reject absolute paths
      if [[ "$entry" == /* ]]; then
        errors+=("allowedPaths contains absolute path: $entry")
      fi

      # Reject path traversal
      if [[ "$entry" == *"../"* ]]; then
        errors+=("allowedPaths contains path traversal: $entry")
      fi

      # Warn on overly permissive patterns (don't fail)
      if [[ "$entry" == "**/*" || "$entry" == "*" ]]; then
        echo "WARNING: allowedPaths contains overly permissive pattern: $entry" >&2
      fi
    done
  fi

  # blockedCommands — must be an array
  local bc_type
  bc_type=$(echo "$input" | jq -r 'if has("blockedCommands") then (.blockedCommands | type) else "missing" end' 2>/dev/null) || bc_type="missing"
  if [[ "$bc_type" == "missing" ]]; then
    errors+=("Missing required field: blockedCommands")
  elif [[ "$bc_type" != "array" ]]; then
    errors+=("blockedCommands must be an array, got type: $bc_type")
  fi

  # Report all collected errors
  if [[ ${#errors[@]} -gt 0 ]]; then
    for err in "${errors[@]}"; do
      echo "ERROR: $err" >&2
    done
    return 1
  fi

  echo "$input"
}

INPUT=$(read_input "$@")
validate "$INPUT"
