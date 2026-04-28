#!/usr/bin/env bash
# validate-plugin.sh — Validate plugin structure against the Claude Code Plugin API
# Part of Session Orchestrator v2.0
#
# Usage: validate-plugin.sh [<plugin-root>]
#
# If <plugin-root> is omitted, uses `git rev-parse --show-toplevel`.
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more validation failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_jq

# Resolve plugin root
if [[ -n "${1:-}" ]]; then
  PLUGIN_ROOT="$1"
else
  PLUGIN_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git repository"
fi

VALIDATE_DIR="$SCRIPT_DIR/lib/validate"

TOTAL_PASS=0
TOTAL_FAIL=0

run_check() {
  local script="$1"
  local output
  local rc=0
  output="$(bash "$VALIDATE_DIR/$script" "$PLUGIN_ROOT" 2>&1)" || rc=$?
  # Print output minus the per-helper "Results:" summary line (orchestrator emits one final tally)
  echo "$output" | grep -v "^Results: "
  local passed failed
  passed="$(echo "$output" | grep -c "  PASS:" 2>/dev/null)" || passed=0
  failed="$(echo "$output" | grep -c "  FAIL:" 2>/dev/null)" || failed=0
  ((TOTAL_PASS += passed)) || true
  ((TOTAL_FAIL += failed)) || true
  return $rc
}

# Run all checks — continue even if one fails, to collect full report
# plugin.json checks are a prerequisite; abort early if they fail (plugin.json missing/invalid)
CHECK_FAILED=0
run_check "check-plugin-json.sh" || {
  CHECK_FAILED=1
  echo ""
  echo "==========================================="
  echo "  Results: $TOTAL_PASS passed, $TOTAL_FAIL failed"
  echo "==========================================="
  exit 1
}
echo ""
run_check "check-component-paths.sh" || CHECK_FAILED=1
echo ""
run_check "check-json-files.sh"      || CHECK_FAILED=1
echo ""
run_check "check-agents.sh"          || CHECK_FAILED=1
echo ""
run_check "check-commands.sh"        || CHECK_FAILED=1

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "==========================================="
echo "  Results: $TOTAL_PASS passed, $TOTAL_FAIL failed"
echo "==========================================="

if [[ "$CHECK_FAILED" -gt 0 ]] || [[ "$TOTAL_FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
