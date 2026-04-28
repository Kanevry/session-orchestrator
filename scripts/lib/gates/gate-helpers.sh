#!/usr/bin/env bash
# gate-helpers.sh — shared utility functions for quality-gate handlers
# Sourced by gate handlers; not executed directly.
# Requires: jq, common.sh already sourced by caller

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
