#!/usr/bin/env bash
# parse-config.sh — Parse ## Session Config from CLAUDE.md or AGENTS.md and output validated JSON
# Part of Session Orchestrator v2.0
#
# Usage: parse-config.sh [path/to/CLAUDE.md|AGENTS.md]
#   If no path given, finds project root and uses its CLAUDE.md (or AGENTS.md).
#
# Output: Single JSON object to stdout with ALL config fields (defaults applied).
# Exit codes: 0 success, 1 error (message to stderr)
#
# Compatible with bash 3.2+ (macOS default).

set -euo pipefail

# Resolve this script's directory and source shared library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_jq

# Temp file for parsed key-value pairs (bash 3.2 has no associative arrays)
KV_FILE="$(mktemp "${TMPDIR:-/tmp}/parse-config.XXXXXX")"
trap 'rm -f "$KV_FILE"' EXIT

# Resolve config file path (CLAUDE.md or AGENTS.md)
if [[ -n "${1:-}" ]]; then
  CLAUDE_MD="$1"
  [[ -f "$CLAUDE_MD" ]] || die "File not found: $CLAUDE_MD"
else
  PROJECT_ROOT="$(find_project_root)"
  # Prefer $SO_CONFIG_FILE (set by platform.sh), then CLAUDE.md, then AGENTS.md
  if [[ -n "${SO_CONFIG_FILE:-}" && -f "$PROJECT_ROOT/$SO_CONFIG_FILE" ]]; then
    CLAUDE_MD="$PROJECT_ROOT/$SO_CONFIG_FILE"
  elif [[ -f "$PROJECT_ROOT/CLAUDE.md" ]]; then
    CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
  elif [[ -f "$PROJECT_ROOT/AGENTS.md" ]]; then
    CLAUDE_MD="$PROJECT_ROOT/AGENTS.md"
  else
    CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
  fi
fi

# Extract ## Session Config section (between header and next ## or EOF)
extract_config_section() {
  local file="$1"
  [[ -f "$file" ]] || { echo ""; return; }

  # Use sed to grab lines between "## Session Config" and the next "## " heading (or EOF).
  # - Skip code fence lines (``` alone on a line)
  # - Strip trailing whitespace
  sed -n '/^## Session Config$/,/^## /{
    /^## Session Config$/d
    /^## /d
    p
  }' "$file" | sed '/^```$/d' | sed 's/[[:space:]]*$//'
}

CONFIG_SECTION="$(extract_config_section "$CLAUDE_MD")"

# Parse key:value pairs into temp file (key\tvalue per line)
while IFS= read -r line; do
  [[ -z "$line" ]] && continue

  key=""
  value=""

  # Format 1: - **key:** value
  if echo "$line" | grep -qE '^[[:space:]]*-[[:space:]]+\*\*[^*:]+:\*\*'; then
    key="$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*\*\*\([^*:]*\):\*\*.*/\1/')"
    value="$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*\*\*[^*:]*:\*\*[[:space:]]*//')"
  # Format 2: plain key: value
  elif echo "$line" | grep -qE '^[[:space:]]*[a-zA-Z][a-zA-Z0-9_-]+:[[:space:]]+'; then
    key="$(echo "$line" | sed 's/^[[:space:]]*\([a-zA-Z][a-zA-Z0-9_-]*\):.*/\1/')"
    value="$(echo "$line" | sed 's/^[[:space:]]*[a-zA-Z][a-zA-Z0-9_-]*:[[:space:]]*//')"
  else
    continue
  fi

  # Trim leading/trailing whitespace
  key="$(echo "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  # Strip surrounding quotes from value if present
  case "$value" in
    \"*\")
      value="$(echo "$value" | sed 's/^"//;s/"$//')"
      ;;
  esac

  [[ -z "$key" ]] && continue

  # Write to temp file (use tab separator; keys won't contain tabs)
  printf '%s\t%s\n' "$key" "$value" >> "$KV_FILE"
done <<< "$CONFIG_SECTION"

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
    case "$oval" in
      true) bval="true" ;;
      false) bval="false" ;;
      *)
        die "Invalid enforcement-gates value for '$okey': '$oval' (must be true or false)"
        ;;
    esac
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

# String fields
V_VCS=$(json_string "vcs")
V_GITLAB_HOST=$(json_string "gitlab-host")
V_MIRROR=$(json_string "mirror")
V_SPECIAL=$(json_string "special")
V_PENCIL=$(json_string "pencil")
V_TEST_CMD=$(json_string "test-command" "pnpm test --run")
V_TYPECHECK_CMD=$(json_string "typecheck-command" "tsgo --noEmit")
V_LINT_CMD=$(json_string "lint-command" "pnpm lint")
V_PLAN_BASELINE=$(json_string "plan-baseline-path")
V_PLAN_VISIBILITY=$(json_string "plan-default-visibility" "internal")
V_PLAN_PRD=$(json_string "plan-prd-location" "docs/prd/")
V_PLAN_RETRO=$(json_string "plan-retro-location" "docs/retro/")

# Integer fields
V_AGENTS_PER_WAVE=$(json_integer "agents-per-wave" "6")
V_WAVES=$(json_integer "waves" "5")
V_RECENT_COMMITS=$(json_integer "recent-commits" "20")
V_ISSUE_LIMIT=$(json_integer "issue-limit" "50")
V_STALE_BRANCH=$(json_integer "stale-branch-days" "7")
V_STALE_ISSUE=$(json_integer "stale-issue-days" "30")
V_SSOT_FRESH=$(json_integer "ssot-freshness-days" "5")
V_PLUGIN_FRESH=$(json_integer "plugin-freshness-days" "30")
V_MEM_CLEANUP=$(json_integer "memory-cleanup-threshold" "5")
V_LEARNING_EXPIRY=$(json_integer "learning-expiry-days" "30")
V_DISC_CONF=$(json_integer "discovery-confidence-threshold" "60")

# Boolean fields
V_PERSISTENCE=$(json_boolean "persistence" "true")
V_ECO_HEALTH=$(json_boolean "ecosystem-health" "false")
V_DISC_CLOSE=$(json_boolean "discovery-on-close" "false")
V_REASONING_OUTPUT=$(json_boolean "reasoning-output" "false")

# List fields
V_CROSS_REPOS=$(json_list "cross-repos")
V_SSOT_FILES=$(json_list "ssot-files")
V_DISC_PROBES=$(json_list "discovery-probes" "[all]")
V_DISC_EXCLUDE=$(json_list "discovery-exclude-paths" "[]")
V_HEALTH_EP=$(json_list "health-endpoints")

# Enum fields
V_ENFORCEMENT=$(json_enum "enforcement" "warn" "strict" "warn" "off")
V_ISOLATION=$(json_enum "isolation" "auto" "worktree" "none" "auto")
V_DISC_SEV=$(json_enum "discovery-severity-threshold" "low" "critical" "high" "medium" "low")

# Object fields
V_AGENT_MAPPING=$(json_object "agent-mapping")
V_ENFORCEMENT_GATES=$(json_bool_object "enforcement-gates")

# Special field
V_MAX_TURNS=$(json_max_turns)

# Assemble final JSON using jq for correctness
jq -n \
  --argjson agents_per_wave "$V_AGENTS_PER_WAVE" \
  --argjson waves "$V_WAVES" \
  --argjson recent_commits "$V_RECENT_COMMITS" \
  --argjson special "$V_SPECIAL" \
  --argjson vcs "$V_VCS" \
  --argjson gitlab_host "$V_GITLAB_HOST" \
  --argjson mirror "$V_MIRROR" \
  --argjson cross_repos "$V_CROSS_REPOS" \
  --argjson pencil "$V_PENCIL" \
  --argjson ecosystem_health "$V_ECO_HEALTH" \
  --argjson health_endpoints "$V_HEALTH_EP" \
  --argjson issue_limit "$V_ISSUE_LIMIT" \
  --argjson stale_branch_days "$V_STALE_BRANCH" \
  --argjson stale_issue_days "$V_STALE_ISSUE" \
  --argjson test_command "$V_TEST_CMD" \
  --argjson typecheck_command "$V_TYPECHECK_CMD" \
  --argjson lint_command "$V_LINT_CMD" \
  --argjson ssot_files "$V_SSOT_FILES" \
  --argjson ssot_freshness_days "$V_SSOT_FRESH" \
  --argjson plugin_freshness_days "$V_PLUGIN_FRESH" \
  --argjson discovery_on_close "$V_DISC_CLOSE" \
  --argjson discovery_probes "$V_DISC_PROBES" \
  --argjson discovery_exclude_paths "$V_DISC_EXCLUDE" \
  --argjson discovery_severity_threshold "$V_DISC_SEV" \
  --argjson discovery_confidence_threshold "$V_DISC_CONF" \
  --argjson persistence "$V_PERSISTENCE" \
  --argjson memory_cleanup_threshold "$V_MEM_CLEANUP" \
  --argjson learning_expiry_days "$V_LEARNING_EXPIRY" \
  --argjson enforcement "$V_ENFORCEMENT" \
  --argjson isolation "$V_ISOLATION" \
  --argjson max_turns "$V_MAX_TURNS" \
  --argjson plan_baseline_path "$V_PLAN_BASELINE" \
  --argjson plan_default_visibility "$V_PLAN_VISIBILITY" \
  --argjson plan_prd_location "$V_PLAN_PRD" \
  --argjson plan_retro_location "$V_PLAN_RETRO" \
  --argjson agent_mapping "$V_AGENT_MAPPING" \
  --argjson enforcement_gates "$V_ENFORCEMENT_GATES" \
  --argjson reasoning_output "$V_REASONING_OUTPUT" \
  '{
    "agents-per-wave": $agents_per_wave,
    "waves": $waves,
    "recent-commits": $recent_commits,
    "special": $special,
    "vcs": $vcs,
    "gitlab-host": $gitlab_host,
    "mirror": $mirror,
    "cross-repos": $cross_repos,
    "pencil": $pencil,
    "ecosystem-health": $ecosystem_health,
    "health-endpoints": $health_endpoints,
    "issue-limit": $issue_limit,
    "stale-branch-days": $stale_branch_days,
    "stale-issue-days": $stale_issue_days,
    "test-command": $test_command,
    "typecheck-command": $typecheck_command,
    "lint-command": $lint_command,
    "ssot-files": $ssot_files,
    "ssot-freshness-days": $ssot_freshness_days,
    "plugin-freshness-days": $plugin_freshness_days,
    "discovery-on-close": $discovery_on_close,
    "discovery-probes": $discovery_probes,
    "discovery-exclude-paths": $discovery_exclude_paths,
    "discovery-severity-threshold": $discovery_severity_threshold,
    "discovery-confidence-threshold": $discovery_confidence_threshold,
    "persistence": $persistence,
    "memory-cleanup-threshold": $memory_cleanup_threshold,
    "learning-expiry-days": $learning_expiry_days,
    "enforcement": $enforcement,
    "isolation": $isolation,
    "max-turns": $max_turns,
    "plan-baseline-path": $plan_baseline_path,
    "plan-default-visibility": $plan_default_visibility,
    "plan-prd-location": $plan_prd_location,
    "plan-retro-location": $plan_retro_location,
    "agent-mapping": $agent_mapping,
    "enforcement-gates": $enforcement_gates,
    "reasoning-output": $reasoning_output
  }'
