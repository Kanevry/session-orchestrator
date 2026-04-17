#!/usr/bin/env bash
# config-json-coercion.sh — JSON coercion helpers for parse-config.sh
#
# Sourcing contract:
#   source "$(dirname "$0")/lib/config-json-coercion.sh"
#
# Requires:
#   KV_FILE  — path to the temp file produced by the key-value parser loop
#              in parse-config.sh (tab-separated key\tvalue lines).
#   die()    — error-with-exit helper from lib/common.sh (must be sourced before this file).
#   jq       — must be on PATH (ensured by require_jq in parse-config.sh).
#
# Functions exported:
#   get_val key [default]
#   json_string key [default]
#   json_integer key default
#   json_float key default [min] [max]
#   json_boolean key default
#   json_list key [default]
#   json_enum key default allowed...
#   json_object key [default]
#   json_bool_object key
#   json_max_turns
#
# Compatible with bash 3.2+

# get a parsed value or return a default; last match wins (allows overrides)
get_val() {
  local key="$1" default="${2:-}"
  local result
  result="$(grep "^${key}	" "$KV_FILE" 2>/dev/null | tail -1 | cut -f2-)" || true
  echo "${result:-$default}"
}

json_string() {
  local key="$1" default="${2:-__NULL__}"
  local val
  val="$(get_val "$key" "$default")"
  if [[ "$val" == "__NULL__" || "$val" == "none" || -z "$val" ]]; then
    echo "null"
  else
    jq -n --arg v "$val" '$v'
  fi
}

json_integer() {
  local key="$1" default="$2"
  local val
  val="$(get_val "$key" "$default")"

  # Support override syntax: "N (key1: M1, key2: M2)"
  # Example: "6 (deep: 18)" → base=6, overrides={"deep": 18}
  if echo "$val" | grep -qE '^[0-9]+[[:space:]]*\('; then
    local base overrides_str
    base="$(echo "$val" | sed 's/[[:space:]]*(.*//;s/[[:space:]]*$//')"
    overrides_str="$(echo "$val" | sed 's/^[0-9]*[[:space:]]*(//;s/)[[:space:]]*$//')"

    if ! echo "$base" | grep -qE '^[0-9]+$'; then
      die "Invalid integer base for '$key': '$base' (from '$val')"
    fi

    # Build JSON object: {"default": N, "key1": M1, ...}
    local json_obj
    json_obj="{\"default\":$base"
    local pair
    while IFS= read -r pair; do
      pair="$(echo "$pair" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [[ -z "$pair" ]] && continue
      local okey oval
      okey="$(echo "$pair" | sed 's/:.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      oval="$(echo "$pair" | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      if ! echo "$oval" | grep -qE '^[0-9]+$'; then
        die "Invalid integer override for '$key.$okey': '$oval'"
      fi
      json_obj="${json_obj},\"$okey\":$oval"
    done <<< "$(echo "$overrides_str" | tr ',' '\n')"
    json_obj="${json_obj}}"

    echo "$json_obj"
    return
  fi

  if ! echo "$val" | grep -qE '^[0-9]+$'; then
    die "Invalid integer for '$key': '$val'"
  fi
  echo "$val"
}

json_float() {
  local key="$1" default="$2" min="${3:-}" max="${4:-}"
  local val
  val="$(get_val "$key" "$default")"

  if ! echo "$val" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
    die "Invalid float for '$key': '$val' (expected non-negative number)"
  fi

  # Bounds check via awk (bash cannot do float comparison)
  if [[ -n "$min" ]]; then
    local below_min
    below_min="$(awk -v v="$val" -v m="$min" 'BEGIN { print (v < m) ? "1" : "0" }')"
    if [[ "$below_min" == "1" ]]; then
      die "Float '$key' value '$val' is below minimum '$min'"
    fi
  fi

  if [[ -n "$max" ]]; then
    local above_max
    above_max="$(awk -v v="$val" -v m="$max" 'BEGIN { print (v >= m) ? "1" : "0" }')"
    if [[ "$above_max" == "1" ]]; then
      die "Float '$key' value '$val' must be less than '$max'"
    fi
  fi

  jq -n --arg v "$val" '$v | tonumber'
}

json_boolean() {
  local key="$1" default="$2"
  local val
  val="$(get_val "$key" "$default")"
  # Case-insensitive comparison
  local lower
  lower="$(echo "$val" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    true)  echo "true" ;;
    false) echo "false" ;;
    *)     die "Invalid boolean for '$key': '$val' (expected true or false)" ;;
  esac
}

# Parse a list value: [a, b, c] or a, b, c -> JSON array of strings
# Returns "null" for null/none/empty-when-default-is-null
json_list() {
  local key="$1" default="${2:-__NULL__}"
  local val
  val="$(get_val "$key" "$default")"

  # Null / none / not set
  if [[ "$val" == "__NULL__" || "$val" == "none" ]]; then
    echo "null"
    return
  fi

  # Strip surrounding brackets if present
  val="$(echo "$val" | sed 's/^[[:space:]]*\[//;s/\][[:space:]]*$//')"

  # Trim
  val="$(echo "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  # Empty after stripping brackets -> empty array
  if [[ -z "$val" ]]; then
    echo "[]"
    return
  fi

  # Check for complex object syntax (contains {) — bail to null
  if echo "$val" | grep -q '{'; then
    echo "null"
    return
  fi

  # Split on comma, trim each element, build JSON array
  local json_arr="["
  local first=1
  local item
  while IFS= read -r item; do
    item="$(echo "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$item" ]] && continue
    if (( first )); then
      first=0
    else
      json_arr="${json_arr},"
    fi
    # Use jq for safe JSON string escaping
    json_arr="${json_arr}$(jq -n --arg v "$item" '$v')"
  done <<< "$(echo "$val" | tr ',' '\n')"
  json_arr="${json_arr}]"

  echo "$json_arr"
}

json_enum() {
  local key="$1" default="$2"
  shift 2
  local val
  val="$(get_val "$key" "$default")"
  local lower
  lower="$(echo "$val" | tr '[:upper:]' '[:lower:]')"

  local valid=0
  local a
  for a in "$@"; do
    if [[ "$lower" == "$a" ]]; then
      valid=1
      break
    fi
  done

  if (( !valid )); then
    die "Invalid value for '$key': '$val' (allowed: $*)"
  fi

  jq -n --arg v "$lower" '$v'
}

# Parse a simple object value: { key1: val1, key2: val2 } -> JSON object of strings
# Returns "null" for null/none/empty-when-default-is-null
json_object() {
  local key="$1" default="${2:-__NULL__}"
  local val
  val="$(get_val "$key" "$default")"

  # Null / none / not set
  if [[ "$val" == "__NULL__" || "$val" == "none" ]]; then
    echo "null"
    return
  fi

  # Strip surrounding braces if present
  val="$(echo "$val" | sed 's/^[[:space:]]*{//;s/}[[:space:]]*$//')"

  # Trim
  val="$(echo "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  # Empty after stripping braces -> null
  if [[ -z "$val" ]]; then
    echo "null"
    return
  fi

  # Split on comma, parse key: value pairs, build JSON object
  local json_obj="{"
  local first=1
  local pair
  while IFS= read -r pair; do
    pair="$(echo "$pair" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$pair" ]] && continue
    local okey oval
    okey="$(echo "$pair" | sed 's/:.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    oval="$(echo "$pair" | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$okey" || -z "$oval" ]] && continue
    if (( first )); then
      first=0
    else
      json_obj="${json_obj},"
    fi
    json_obj="${json_obj}$(jq -n --arg k "$okey" --arg v "$oval" '{($k): $v}' | sed 's/^{//;s/}$//')"
  done <<< "$(echo "$val" | tr ',' '\n')"
  json_obj="${json_obj}}"

  echo "$json_obj"
}

# _coerce_boolean — coerce a string "true"/"false" (case-insensitive) to a JSON boolean literal.
# Emits "true" or "false". Calls die() for invalid values.
# Usage: _coerce_boolean <field-name> <string-value>
_coerce_boolean() {
  local field="$1" raw="$2"
  local lower
  lower="$(echo "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    true)  echo "true" ;;
    false) echo "false" ;;
    *)     die "Invalid enforcement-gates value for '$field': '$raw' (must be true or false)" ;;
  esac
}

# json_bool_object — like json_object but coerces string values "true"/"false"
# to real JSON booleans. Used for `enforcement-gates` where each gate is a flag.
# Unknown values default to true (fail-open for unknown gates, consistent with
# hardening.sh gate_enabled behavior).
json_bool_object() {
  local key="$1"
  local val
  val="$(get_val "$key" "__NULL__")"

  if [[ "$val" == "__NULL__" || "$val" == "none" ]]; then
    echo "null"
    return
  fi

  val="$(echo "$val" | sed 's/^[[:space:]]*{//;s/}[[:space:]]*$//')"
  val="$(echo "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  if [[ -z "$val" ]]; then
    echo "null"
    return
  fi

  local json_obj="{"
  local first=1
  local pair
  while IFS= read -r pair; do
    pair="$(echo "$pair" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$pair" ]] && continue
    local okey oval bval
    okey="$(echo "$pair" | sed 's/:.*//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    oval="$(echo "$pair" | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
    [[ -z "$okey" ]] && continue
    bval="$(_coerce_boolean "$okey" "$oval")"
    if (( first )); then
      first=0
    else
      json_obj="${json_obj},"
    fi
    json_obj="${json_obj}$(jq -n --arg k "$okey" --argjson v "$bval" '{($k): $v}' | sed 's/^{//;s/}$//')"
  done <<< "$(echo "$val" | tr ',' '\n')"
  json_obj="${json_obj}}"

  echo "$json_obj"
}

# max-turns accepts a positive integer or the literal "auto"
json_max_turns() {
  local val
  val="$(get_val "max-turns" "auto")"
  local lower
  lower="$(echo "$val" | tr '[:upper:]' '[:lower:]')"

  if [[ "$lower" == "auto" ]]; then
    echo '"auto"'
  elif echo "$val" | grep -qE '^[0-9]+$'; then
    if [[ "$val" -le 0 ]]; then
      die "Invalid max-turns: '$val' (must be positive integer or 'auto')"
    fi
    echo "$val"
  else
    die "Invalid max-turns: '$val' (must be positive integer or 'auto')"
  fi
}
