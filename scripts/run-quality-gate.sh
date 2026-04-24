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
  # before falling back to CLAUDE.md $CONFIG. The policy file is the
  # centralized source of truth when present.
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

TEST_CMD="$(extract_command "test-command" "$DEFAULT_TEST_CMD")"
TYPECHECK_CMD="$(extract_command "typecheck-command" "$DEFAULT_TYPECHECK_CMD")"
LINT_CMD="$(extract_command "lint-command" "$DEFAULT_LINT_CMD")"

# Sets globals: _run_status ("pass"|"fail"|"skip"), _run_output, _run_exit_code
run_check() {
  local cmd="$1"
  _run_status=""
  _run_output=""
  _run_exit_code=0

  if [[ "$cmd" == "skip" ]]; then
    _run_status="skip"
    return
  fi

  set +e
  _run_output="$(bash -c "$cmd" 2>&1)"
  _run_exit_code=$?
  set -e

  if [[ $_run_exit_code -eq 127 ]]; then
    _run_status="skip"
    _run_output="command not found"
    return
  fi

  if [[ $_run_exit_code -eq 0 ]]; then
    _run_status="pass"
  else
    _run_status="fail"
  fi
}

csv_to_json_array() {
  local csv="$1"
  if [[ -z "$csv" ]]; then
    echo "[]"
    return
  fi
  local IFS=','
  local items=()
  read -ra items <<< "$csv"
  local json_arr="["
  local first=1
  for item in "${items[@]}"; do
    item="$(echo "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$item" ]] && continue
    if (( first )); then
      first=0
    else
      json_arr="${json_arr},"
    fi
    json_arr="${json_arr}$(jq -n --arg v "$item" '$v')"
  done
  json_arr="${json_arr}]"
  echo "$json_arr"
}

find_changed_files() {
  local ref="$1"
  git diff --name-only "$ref" HEAD 2>/dev/null || true
}

find_changed_test_files() {
  local ref="$1"
  find_changed_files "$ref" | grep -E '\.(test|spec)\.(ts|tsx|js|jsx|mjs)$' || true
}

extract_count() {
  local output="$1" pattern="$2"
  echo "$output" | grep -ic "$pattern" || true
}

# Sets globals: _test_passed, _test_failed, _test_total
extract_test_counts() {
  local output="$1"
  _test_passed="$(echo "$output" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || true)"
  [[ -z "$_test_passed" ]] && _test_passed=0
  _test_failed="$(echo "$output" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || true)"
  [[ -z "$_test_failed" ]] && _test_failed=0
  _test_total=$(( _test_passed + _test_failed ))
}

collect_debug_artifacts() {
  local ref="$1"
  if [[ -z "$ref" ]]; then
    echo "[]"
    return
  fi
  local changed_files
  changed_files="$(find_changed_files "$ref")"
  if [[ -z "$changed_files" ]]; then
    echo "[]"
    return
  fi
  local artifacts
  artifacts="$(echo "$changed_files" | xargs grep -rn 'console\.log\|debugger\|TODO: remove' 2>/dev/null || true)"
  if [[ -z "$artifacts" ]]; then
    echo "[]"
    return
  fi
  local json
  json="$(echo "$artifacts" | head -50 | jq -R -s 'split("\n") | map(select(length > 0))')"
  [[ -z "$json" || "$json" == "null" ]] && json="[]"
  echo "$json"
}

extract_error_lines_json() {
  local output="$1" pattern="$2"
  local json
  json="$(echo "$output" | grep -iE "$pattern" | head -20 | jq -R -s 'split("\n") | map(select(length > 0))')"
  [[ -z "$json" || "$json" == "null" ]] && json="[]"
  echo "$json"
}

resolve_test_files() {
  local files_csv="$1" start_ref="$2"
  if [[ -n "$files_csv" ]]; then
    local IFS=','
    local items=()
    read -ra items <<< "$files_csv"
    local filtered=()
    for f in "${items[@]}"; do
      f="$(echo "$f" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      if echo "$f" | grep -qE '\.(test|spec)\.(ts|tsx|js|jsx|mjs)$'; then
        filtered+=("$f")
      fi
    done
    if [[ ${#filtered[@]} -gt 0 ]]; then
      echo "${filtered[*]}"
    fi
  elif [[ -n "$start_ref" ]]; then
    local result
    result="$(find_changed_test_files "$start_ref" | tr '\n' ' ')"
    echo "$result" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
  fi
}

# Variant: baseline
run_baseline() {
  local tc_status="skip" tc_output=""
  local test_status="skip" test_output=""

  if [[ "$TYPECHECK_CMD" != "skip" ]]; then
    run_check "set -o pipefail; $TYPECHECK_CMD 2>&1 | tail -5"
    tc_status="$_run_status"
    tc_output="$_run_output"
  fi

  if [[ "$TEST_CMD" != "skip" ]]; then
    run_check "set -o pipefail; $TEST_CMD 2>&1 | tail -5"
    test_status="$_run_status"
    test_output="$_run_output"
  fi

  jq -n \
    --arg variant "baseline" \
    --arg typecheck "$tc_status" \
    --arg test "$test_status" \
    --arg typecheck_output "$tc_output" \
    --arg test_output "$test_output" \
    '{
      variant: $variant,
      typecheck: $typecheck,
      test: $test,
      typecheck_output: $typecheck_output,
      test_output: $test_output
    }'

  exit 0
}

# Variant: incremental
run_incremental() {
  SECONDS=0
  local tc_status="skip" test_status="skip" errors_json="[]"
  run_check "$TYPECHECK_CMD"
  tc_status="$_run_status"
  [[ "$tc_status" == "fail" ]] && errors_json="$(extract_error_lines_json "$_run_output" 'error')"
  local test_files=""
  test_files="$(resolve_test_files "$FILES" "$SESSION_START_REF")"
  if [[ "$TEST_CMD" == "skip" ]]; then
    test_status="skip"
  elif [[ -n "$test_files" ]]; then
    run_check "$TEST_CMD -- $test_files"
    test_status="$_run_status"
    if [[ "$test_status" == "fail" ]]; then
      local test_errors
      test_errors="$(extract_error_lines_json "$_run_output" '(fail|error|FAIL)')"
      errors_json="$(jq -n --argjson a "$errors_json" --argjson b "$test_errors" '$a + $b')"
    fi
  elif [[ -z "$FILES" && -z "$SESSION_START_REF" ]]; then
    run_check "$TEST_CMD"
    test_status="$_run_status"
  else
    warn "No test files found for incremental run; skipping tests"
    test_status="skip"
  fi
  jq -n --arg variant "incremental" --argjson duration "$SECONDS" \
    --arg typecheck "$tc_status" --arg test "$test_status" \
    --argjson errors "$errors_json" \
    '{ variant: $variant, duration_seconds: $duration,
       typecheck: $typecheck, test: $test, errors: $errors }'
  exit 0
}

# Variant: full-gate
run_full_gate() {
  SECONDS=0
  local gate_failed=0
  local tc_status="skip" tc_error_count=0
  run_check "$TYPECHECK_CMD"
  tc_status="$_run_status"
  if [[ "$tc_status" == "fail" ]]; then
    tc_error_count="$(extract_count "$_run_output" 'error')"; gate_failed=1
  fi
  local test_status="skip"
  run_check "$TEST_CMD"
  test_status="$_run_status"
  [[ "$test_status" == "fail" ]] && gate_failed=1
  _test_passed=0; _test_failed=0; _test_total=0
  [[ "$test_status" != "skip" ]] && extract_test_counts "$_run_output"
  local lint_status="skip" lint_warnings=0
  run_check "$LINT_CMD"
  lint_status="$_run_status"
  [[ "$lint_status" == "fail" ]] && gate_failed=1
  [[ "$lint_status" != "skip" ]] && lint_warnings="$(extract_count "$_run_output" 'warning')"
  local debug_artifacts_json
  debug_artifacts_json="$(collect_debug_artifacts "$SESSION_START_REF")"
  jq -n --arg variant "full-gate" --argjson duration "$SECONDS" \
    --arg tc_status "$tc_status" --argjson tc_error_count "$tc_error_count" \
    --arg test_status "$test_status" --argjson test_total "$_test_total" \
    --argjson test_passed "$_test_passed" --arg lint_status "$lint_status" \
    --argjson lint_warnings "$lint_warnings" --argjson debug_artifacts "$debug_artifacts_json" \
    '{ variant: $variant, duration_seconds: $duration,
       typecheck: { status: $tc_status, error_count: $tc_error_count },
       test: { status: $test_status, total: $test_total, passed: $test_passed },
       lint: { status: $lint_status, warnings: $lint_warnings },
       debug_artifacts: $debug_artifacts }'
  if (( gate_failed )); then exit 2; fi
  exit 0
}

# Variant: per-file
run_per_file() {
  if [[ -z "$FILES" ]]; then
    warn "per-file variant requires --files; skipping file-specific tests"
  fi

  local tc_status="skip"
  local test_status="skip"
  local files_json="[]"

  if [[ -n "$FILES" ]]; then
    files_json="$(csv_to_json_array "$FILES")"
  fi

  # Typecheck runs on the whole project, not per-file
  run_check "$TYPECHECK_CMD"
  tc_status="$_run_status"

  if [[ "$TEST_CMD" == "skip" ]]; then
    test_status="skip"
  elif [[ -n "$FILES" ]]; then
    local file_args
    file_args="$(echo "$FILES" | tr ',' ' ')"
    run_check "$TEST_CMD -- $file_args"
    test_status="$_run_status"
  else
    test_status="skip"
  fi

  jq -n \
    --arg variant "per-file" \
    --arg typecheck "$tc_status" \
    --arg test "$test_status" \
    --argjson files "$files_json" \
    '{
      variant: $variant,
      typecheck: $typecheck,
      test: $test,
      files: $files
    }'

  exit 0
}

case "$VARIANT" in
  baseline)     run_baseline ;;
  incremental)  run_incremental ;;
  full-gate)    run_full_gate ;;
  per-file)     run_per_file ;;
esac
