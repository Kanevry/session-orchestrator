#!/usr/bin/env bash
# run-quality-gate.sh — Run quality gate checks and output structured JSON results
# Part of Session Orchestrator v2.0
#
# Usage: run-quality-gate.sh --variant <variant> [--config <json-or-file>] [--files <file1,file2,...>] [--session-start-ref <ref>]
#
#   --variant    baseline|incremental|full-gate|per-file (required)
#   --config     Config JSON string or path to JSON file (from parse-config.sh output)
#                If omitted, reads test-command/typecheck-command/lint-command defaults
#   --files      Comma-separated file list (for incremental and per-file)
#   --session-start-ref  Git ref for diff base (for incremental, to find changed files)
#
# Exit codes:
#   0 — pass (or informational, for non-blocking variants)
#   1 — script error (bad arguments, missing dependencies)
#   2 — gate failed (full-gate only: typecheck errors, test failures, or lint errors)
#
# Compatible with bash 3.2+ (macOS default).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_jq

DEFAULT_TEST_CMD="pnpm test --run"
DEFAULT_TYPECHECK_CMD="tsgo --noEmit"
DEFAULT_LINT_CMD="pnpm lint"

VARIANT=""
CONFIG=""
FILES=""
SESSION_START_REF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)
      [[ $# -lt 2 ]] && die "Missing value for --variant"
      VARIANT="$2"; shift 2 ;;
    --config)
      [[ $# -lt 2 ]] && die "Missing value for --config"
      CONFIG="$2"; shift 2 ;;
    --files)
      [[ $# -lt 2 ]] && die "Missing value for --files"
      FILES="$2"; shift 2 ;;
    --session-start-ref)
      [[ $# -lt 2 ]] && die "Missing value for --session-start-ref"
      SESSION_START_REF="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: run-quality-gate.sh --variant <variant> [--config <json-or-file>] [--files <file1,file2,...>] [--session-start-ref <ref>]"
      echo ""
      echo "Variants: baseline, incremental, full-gate, per-file"
      exit 0 ;;
    *)
      die "Unknown argument: $1" ;;
  esac
done

[[ -z "$VARIANT" ]] && die "Missing required argument: --variant"
case "$VARIANT" in
  baseline|incremental|full-gate|per-file) ;;
  *) die "Invalid variant: '$VARIANT' (allowed: baseline, incremental, full-gate, per-file)" ;;
esac

extract_command() {
  local key="$1" default="$2"

  # Policy-file-first (#183): check .orchestrator/policy/quality-gates.json
  # before falling back to the Session Config from the project-instruction
  # file (CLAUDE.md, or AGENTS.md alias on Codex CLI — see
  # skills/_shared/instruction-file-resolution.md) passed in $CONFIG. The
  # policy file is the centralized source of truth when present.
  local policy_file=".orchestrator/policy/quality-gates.json"
  if [[ -f "$policy_file" ]]; then
    local policy_key=""
    case "$key" in
      test-command)      policy_key="test" ;;
      typecheck-command) policy_key="typecheck" ;;
      lint-command)      policy_key="lint" ;;
    esac
    if [[ -n "$policy_key" ]]; then
      local policy_cmd
      policy_cmd="$(jq -r --arg k "$policy_key" '.commands[$k].command // empty' "$policy_file" 2>/dev/null)" || policy_cmd=""
      if [[ -n "$policy_cmd" && "$policy_cmd" != "null" ]]; then
        echo "$policy_cmd"
        return
      fi
    fi
  fi

  if [[ -z "$CONFIG" ]]; then
    echo "$default"
    return
  fi

  local config_json=""

  if [[ -f "$CONFIG" ]]; then
    config_json="$(cat "$CONFIG")"
  else
    if echo "$CONFIG" | jq empty 2>/dev/null; then
      config_json="$CONFIG"
    else
      warn "Config is neither a valid file path nor valid JSON; using defaults"
      echo "$default"
      return
    fi
  fi

  local val
  val="$(echo "$config_json" | jq -r --arg k "$key" '.[$k] // empty' 2>/dev/null)" || val=""
  if [[ -z "$val" || "$val" == "null" ]]; then
    echo "$default"
  else
    echo "$val"
  fi
}

export TYPECHECK_CMD="$(extract_command "typecheck-command" "$DEFAULT_TYPECHECK_CMD")"
export TEST_CMD="$(extract_command "test-command" "$DEFAULT_TEST_CMD")"
export LINT_CMD="$(extract_command "lint-command" "$DEFAULT_LINT_CMD")"
export FILES
export SESSION_START_REF

GATES_DIR="$SCRIPT_DIR/lib/gates"

case "$VARIANT" in
  baseline)    bash "$GATES_DIR/gate-baseline.sh" ;;
  incremental) bash "$GATES_DIR/gate-incremental.sh" ;;
  full-gate)   bash "$GATES_DIR/gate-full.sh" ;;
  per-file)    bash "$GATES_DIR/gate-per-file.sh" ;;
esac
