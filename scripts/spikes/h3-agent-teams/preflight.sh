#!/usr/bin/env bash
# preflight.sh — NON-claude smoke test of the H3 hook seam's command contract.
#
# Builds the fixture if missing, then runs `npm run --silent typecheck` in both
# toggle states and asserts the exit codes the TaskCompleted hook depends on:
#   pass-state → exit 0   (hook would allow completion)
#   fail-state → exit 2   (hook would BLOCK completion)
#
# This validates the seam's command contract WITHOUT spawning any claude
# session — only node/npm in /tmp. Exit 0 iff both assertions pass.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="/tmp/h3-agent-teams-test"
FAILED=0

echo "=== H3 preflight — hook-seam command contract (no claude session) ==="

# Build fixture if missing.
if [ ! -f "${FIXTURE}/package.json" ]; then
  echo "[preflight] fixture missing — running setup.sh"
  bash "${HERE}/setup.sh"
fi

run_assert() {
  local state="$1" expected="$2"
  bash "${HERE}/toggle.sh" "${state}" >/dev/null
  local out exit_code
  out="$(cd "${FIXTURE}" && npm run --silent typecheck 2>&1)"
  exit_code=$?
  if [ "${exit_code}" -eq "${expected}" ]; then
    echo "PASS: ${state}-state → exit ${exit_code} (expected ${expected})  | ${out}"
  else
    echo "FAIL: ${state}-state → exit ${exit_code} (expected ${expected})  | ${out}"
    FAILED=1
  fi
}

run_assert pass 0
run_assert fail 2

# Leave the fixture in PASS state for run 1 (operator toggles to fail before runs 2-3).
bash "${HERE}/toggle.sh" pass >/dev/null

echo "=== preflight result ==="
if [ "${FAILED}" -eq 0 ]; then
  echo "ALL ASSERTIONS PASSED — hook command contract verified (exit 0 pass / exit 2 fail)"
  echo "Fixture left in PASS state at ${FIXTURE} (ready for run 1)."
  exit 0
else
  echo "ONE OR MORE ASSERTIONS FAILED — do not proceed to the interactive runs."
  exit 1
fi
