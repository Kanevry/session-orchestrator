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

# shellcheck source=lib/config-yaml-parser.sh
source "$SCRIPT_DIR/lib/config-yaml-parser.sh"
# shellcheck source=lib/config-json-coercion.sh
source "$SCRIPT_DIR/lib/config-json-coercion.sh"

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

# String fields
V_VCS=$(json_string "vcs")
V_GITLAB_HOST=$(json_string "gitlab-host")
V_MIRROR=$(json_string "mirror")
V_SPECIAL=$(json_string "special")
V_PENCIL=$(json_string "pencil")
V_TEST_CMD=$(json_string "test-command" "pnpm test --run")
V_TYPECHECK_CMD=$(json_string "typecheck-command" "tsgo --noEmit")
V_LINT_CMD=$(json_string "lint-command" "pnpm lint")
V_BASELINE_REF=$(json_string "baseline-ref")
V_BASELINE_PROJECT_ID=$(json_string "baseline-project-id")
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
V_LEARNINGS_TOP_N=$(json_integer "learnings-surface-top-n" "15")
V_GROUNDING_INJECTION_MAX=$(json_integer "grounding-injection-max-files" "3")
V_LEARNING_DECAY=$(json_float "learning-decay-rate" "0.05" "0.0" "1.0")
V_DISC_CONF=$(json_integer "discovery-confidence-threshold" "60")

# Boolean fields
V_PERSISTENCE=$(json_boolean "persistence" "true")
V_ECO_HEALTH=$(json_boolean "ecosystem-health" "false")
V_DISC_CLOSE=$(json_boolean "discovery-on-close" "false")
V_REASONING_OUTPUT=$(json_boolean "reasoning-output" "false")
V_GROUNDING_CHECK=$(json_boolean "grounding-check" "true")
V_ALLOW_DESTRUCTIVE=$(json_boolean "allow-destructive-ops" "false")
V_RESOURCE_AWARE=$(json_boolean "resource-awareness" "true")
V_ENABLE_HOST_BANNER=$(json_boolean "enable-host-banner" "true")

# resource-thresholds block (v3.1.0 env-aware — issue #166).
# Sub-key names are deliberately unique across all blocks (no collision with
# vault-integration / vault-sync) because they flatten into the same KV map.
V_RT_RAM_MIN=$(json_integer "ram-free-min-gb" "4")
V_RT_RAM_CRIT=$(json_integer "ram-free-critical-gb" "2")
V_RT_CPU_MAX=$(json_integer "cpu-load-max-pct" "80")
V_RT_CONC_WARN=$(json_integer "concurrent-sessions-warn" "5")
V_RT_SSH_NO_DOCKER=$(json_boolean "ssh-no-docker" "true")

# List fields
V_CROSS_REPOS=$(json_list "cross-repos")
V_SSOT_FILES=$(json_list "ssot-files")
V_DISC_PROBES=$(json_list "discovery-probes" "[all]")
V_DISC_EXCLUDE=$(json_list "discovery-exclude-paths" "[]")
V_HEALTH_EP=$(json_list "health-endpoints")
V_WORKTREE_EXCLUDE=$(json_list "worktree-exclude" "[node_modules, dist, build, .next, .nuxt, coverage, .cache, .turbo, .vercel, out]")

# Enum fields
V_ENFORCEMENT=$(json_enum "enforcement" "warn" "strict" "warn" "off")
V_ISOLATION=$(json_enum "isolation" "auto" "worktree" "none" "auto")
V_DISC_SEV=$(json_enum "discovery-severity-threshold" "low" "critical" "high" "medium" "low")

# Object fields
V_AGENT_MAPPING=$(json_object "agent-mapping")
V_ENFORCEMENT_GATES=$(json_bool_object "enforcement-gates")

# Special field
V_MAX_TURNS=$(json_max_turns)

# vault-integration block — read sub-keys directly from Session Config section.
# Users add these as flat indented yaml under a `vault-integration:` header.
# Key names must be unique within the Session Config to avoid collision with
# other blocks. The vault-sync block (see parse_vault_sync below) uses the
# same sub-key names but is extracted separately via a scoped block reader
# that tolerates placement outside the Session Config section.
# These defaults are applied when the block is absent or keys are missing.
VI_ENABLED=$(json_boolean "enabled" "false")
VI_VAULT_DIR=$(json_string "vault-dir")
VI_MODE=$(json_enum "mode" "warn" "warn" "strict" "off")

# vault-sync block — read as a standalone top-level YAML block from
# CLAUDE.md regardless of whether it sits inside `## Session Config`. This
# is the contract the session-end skill consumes at Phase 2.1 via
# `$CONFIG | jq -r '."vault-sync".enabled'` and friends.
VS_BLOCK_JSON=$(parse_vault_sync "$CLAUDE_MD")

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
  --argjson learnings_surface_top_n "$V_LEARNINGS_TOP_N" \
  --argjson learning_decay_rate "$V_LEARNING_DECAY" \
  --argjson enforcement "$V_ENFORCEMENT" \
  --argjson isolation "$V_ISOLATION" \
  --argjson max_turns "$V_MAX_TURNS" \
  --argjson baseline_ref "$V_BASELINE_REF" \
  --argjson baseline_project_id "$V_BASELINE_PROJECT_ID" \
  --argjson plan_baseline_path "$V_PLAN_BASELINE" \
  --argjson plan_default_visibility "$V_PLAN_VISIBILITY" \
  --argjson plan_prd_location "$V_PLAN_PRD" \
  --argjson plan_retro_location "$V_PLAN_RETRO" \
  --argjson agent_mapping "$V_AGENT_MAPPING" \
  --argjson enforcement_gates "$V_ENFORCEMENT_GATES" \
  --argjson reasoning_output "$V_REASONING_OUTPUT" \
  --argjson grounding_injection_max_files "$V_GROUNDING_INJECTION_MAX" \
  --argjson grounding_check "$V_GROUNDING_CHECK" \
  --argjson allow_destructive_ops "$V_ALLOW_DESTRUCTIVE" \
  --argjson resource_awareness "$V_RESOURCE_AWARE" \
  --argjson enable_host_banner "$V_ENABLE_HOST_BANNER" \
  --argjson rt_ram_min "$V_RT_RAM_MIN" \
  --argjson rt_ram_crit "$V_RT_RAM_CRIT" \
  --argjson rt_cpu_max "$V_RT_CPU_MAX" \
  --argjson rt_conc_warn "$V_RT_CONC_WARN" \
  --argjson rt_ssh_no_docker "$V_RT_SSH_NO_DOCKER" \
  --argjson worktree_exclude "$V_WORKTREE_EXCLUDE" \
  --argjson vi_enabled "$VI_ENABLED" \
  --argjson vi_vault_dir "$VI_VAULT_DIR" \
  --argjson vi_mode "$VI_MODE" \
  --argjson vs_block "$VS_BLOCK_JSON" \
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
    "learnings-surface-top-n": $learnings_surface_top_n,
    "learning-decay-rate": $learning_decay_rate,
    "enforcement": $enforcement,
    "isolation": $isolation,
    "max-turns": $max_turns,
    "baseline-ref": $baseline_ref,
    "baseline-project-id": $baseline_project_id,
    "plan-baseline-path": $plan_baseline_path,
    "plan-default-visibility": $plan_default_visibility,
    "plan-prd-location": $plan_prd_location,
    "plan-retro-location": $plan_retro_location,
    "agent-mapping": $agent_mapping,
    "enforcement-gates": $enforcement_gates,
    "reasoning-output": $reasoning_output,
    "grounding-injection-max-files": $grounding_injection_max_files,
    "grounding-check": $grounding_check,
    "allow-destructive-ops": $allow_destructive_ops,
    "resource-awareness": $resource_awareness,
    "enable-host-banner": $enable_host_banner,
    "resource-thresholds": {
      "ram-free-min-gb": $rt_ram_min,
      "ram-free-critical-gb": $rt_ram_crit,
      "cpu-load-max-pct": $rt_cpu_max,
      "concurrent-sessions-warn": $rt_conc_warn,
      "ssh-no-docker": $rt_ssh_no_docker
    },
    "worktree-exclude": $worktree_exclude,
    "vault-integration": {
      "enabled": $vi_enabled,
      "vault-dir": $vi_vault_dir,
      "mode": $vi_mode
    },
    "vault-sync": $vs_block
  }'
