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

# Resolve this script's directory and source shared library
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
  if [[ -z "$CONFIG" ]]; then
    echo "$default"
    return
  fi

  local config_json=""

  # Determine if CONFIG is a file path or a JSON string
  if [[ -f "$CONFIG" ]]; then
    config_json="$(cat "$CONFIG")"
  else
    # Try to parse as JSON string
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

# Run a command, capturing output and exit code.
# Handles "skip" commands and command-not-found (exit 127) gracefully.
# Sets: _run_status ("pass"|"fail"|"skip"), _run_output, _run_exit_code
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
  _run_output="$(eval "$cmd" 2>&1)"
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

# Variant: baseline
run_baseline() {
  local tc_status="skip" tc_output=""
  local test_status="skip" test_output=""

  if [[ "$TYPECHECK_CMD" != "skip" ]]; then
    run_check "$TYPECHECK_CMD 2>&1 | tail -5"
    tc_status="$_run_status"
    tc_output="$_run_output"
  fi

  if [[ "$TEST_CMD" != "skip" ]]; then
    run_check "$TEST_CMD 2>&1 | tail -5"
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

  local tc_status="skip"
  local test_status="skip"
  local errors_json="[]"

  # Typecheck
  run_check "$TYPECHECK_CMD"
  tc_status="$_run_status"
  if [[ "$tc_status" == "fail" ]]; then
    # Collect error lines
    errors_json="$(echo "$_run_output" | grep -i 'error' | head -20 | jq -R -s 'split("\n") | map(select(length > 0))')"
    [[ -z "$errors_json" || "$errors_json" == "null" ]] && errors_json="[]"
  fi

  # Determine test files
  local test_files=""

  if [[ -n "$FILES" ]]; then
    # Use provided files — filter to test files
    local IFS=','
    local items=()
    read -ra items <<< "$FILES"
    local filtered=()
    for f in "${items[@]}"; do
      f="$(echo "$f" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      if echo "$f" | grep -qE '\.(test|spec)\.(ts|tsx|js|jsx|mjs)$'; then
        filtered+=("$f")
      fi
    done
    if [[ ${#filtered[@]} -gt 0 ]]; then
      test_files="${filtered[*]}"
    fi
  elif [[ -n "$SESSION_START_REF" ]]; then
    # Find changed test files via git diff
    test_files="$(find_changed_test_files "$SESSION_START_REF" | tr '\n' ' ')"
    test_files="$(echo "$test_files" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  fi

  # Run tests
  if [[ "$TEST_CMD" == "skip" ]]; then
    test_status="skip"
  elif [[ -n "$test_files" ]]; then
    run_check "$TEST_CMD -- $test_files"
    test_status="$_run_status"
    if [[ "$test_status" == "fail" ]]; then
      local test_errors
      test_errors="$(echo "$_run_output" | grep -iE '(fail|error|FAIL)' | head -20 | jq -R -s 'split("\n") | map(select(length > 0))')"
      [[ -z "$test_errors" || "$test_errors" == "null" ]] && test_errors="[]"
      # Merge errors
      errors_json="$(jq -n --argjson a "$errors_json" --argjson b "$test_errors" '$a + $b')"
    fi
  else
    # No test files to run — still run full suite if no files filter available
    if [[ -z "$FILES" && -z "$SESSION_START_REF" ]]; then
      run_check "$TEST_CMD"
      test_status="$_run_status"
    else
      warn "No test files found for incremental run; skipping tests"
      test_status="skip"
    fi
  fi

  local duration=$SECONDS

  jq -n \
    --arg variant "incremental" \
    --argjson duration "$duration" \
    --arg typecheck "$tc_status" \
    --arg test "$test_status" \
    --argjson errors "$errors_json" \
    '{
      variant: $variant,
      duration_seconds: $duration,
      typecheck: $typecheck,
      test: $test,
      errors: $errors
    }'

  exit 0
}

# Variant: full-gate
run_full_gate() {
  SECONDS=0

  local gate_failed=0

  # --- Typecheck ---
  local tc_status="skip" tc_error_count=0
  run_check "$TYPECHECK_CMD"
  tc_status="$_run_status"
  if [[ "$tc_status" == "fail" ]]; then
    tc_error_count="$(echo "$_run_output" | grep -ic 'error' || true)"
    [[ -z "$tc_error_count" ]] && tc_error_count=0
    gate_failed=1
  fi

  # --- Test ---
  local test_status="skip" test_total=0 test_passed=0
  run_check "$TEST_CMD"
  test_status="$_run_status"
  if [[ "$test_status" == "fail" ]]; then
    gate_failed=1
  fi
  # Try to extract test counts from output (common patterns: "X passed", "X tests", "Tests: X passed, Y failed")
  if [[ "$test_status" != "skip" ]]; then
    # Try vitest/jest style: "Tests  X passed" or "X passed"
    test_passed="$(echo "$_run_output" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || true)"
    [[ -z "$test_passed" ]] && test_passed=0
    local test_failed
    test_failed="$(echo "$_run_output" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || true)"
    [[ -z "$test_failed" ]] && test_failed=0
    test_total=$(( test_passed + test_failed ))
  fi

  # --- Lint ---
  local lint_status="skip" lint_warnings=0
  run_check "$LINT_CMD"
  lint_status="$_run_status"
  if [[ "$lint_status" == "fail" ]]; then
    gate_failed=1
  fi
  if [[ "$lint_status" != "skip" ]]; then
    lint_warnings="$(echo "$_run_output" | grep -ic 'warning' || true)"
    [[ -z "$lint_warnings" ]] && lint_warnings=0
  fi

  # --- Debug artifacts ---
  local debug_artifacts_json="[]"
  if [[ -n "$SESSION_START_REF" ]]; then
    local changed_files
    changed_files="$(find_changed_files "$SESSION_START_REF")"
    if [[ -n "$changed_files" ]]; then
      local artifacts
      artifacts="$(echo "$changed_files" | xargs grep -rn 'console\.log\|debugger\|TODO: remove' 2>/dev/null || true)"
      if [[ -n "$artifacts" ]]; then
        debug_artifacts_json="$(echo "$artifacts" | head -50 | jq -R -s 'split("\n") | map(select(length > 0))')"
        [[ -z "$debug_artifacts_json" || "$debug_artifacts_json" == "null" ]] && debug_artifacts_json="[]"
      fi
    fi
  fi

  local duration=$SECONDS

  jq -n \
    --arg variant "full-gate" \
    --argjson duration "$duration" \
    --arg tc_status "$tc_status" \
    --argjson tc_error_count "$tc_error_count" \
    --arg test_status "$test_status" \
    --argjson test_total "$test_total" \
    --argjson test_passed "$test_passed" \
    --arg lint_status "$lint_status" \
    --argjson lint_warnings "$lint_warnings" \
    --argjson debug_artifacts "$debug_artifacts_json" \
    '{
      variant: $variant,
      duration_seconds: $duration,
      typecheck: { status: $tc_status, error_count: $tc_error_count },
      test: { status: $test_status, total: $test_total, passed: $test_passed },
      lint: { status: $lint_status, warnings: $lint_warnings },
      debug_artifacts: $debug_artifacts
    }'

  if (( gate_failed )); then
    exit 2
  fi
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

  # Typecheck (runs on the whole project, not per-file)
  run_check "$TYPECHECK_CMD"
  tc_status="$_run_status"

  # Test with file args
  if [[ "$TEST_CMD" == "skip" ]]; then
    test_status="skip"
  elif [[ -n "$FILES" ]]; then
    # Convert comma-separated to space-separated for test runner
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
