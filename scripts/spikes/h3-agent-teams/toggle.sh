#!/usr/bin/env bash
# toggle.sh pass|fail — rewrite the fixture's src/h3.ts to the PASS or FAIL state.
#
#   pass → export const x: number = 42;              (typecheck exits 0)
#   fail → export const x: number = "FAIL_MARKER";   (typecheck exits 2)
#
# Spawns NO claude session. Used by preflight.sh and by the operator between
# runs (run 1 = pass; runs 2-3 = fail before launching the team).
set -euo pipefail

FIXTURE="/tmp/h3-agent-teams-test"
TARGET="${FIXTURE}/src/h3.ts"

usage() {
  echo "usage: $0 pass|fail" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage

if [ ! -d "${FIXTURE}" ]; then
  echo "[toggle] fixture missing at ${FIXTURE} — run ./setup.sh first" >&2
  exit 1
fi

case "$1" in
  pass)
    printf 'export const x: number = 42;\n' > "${TARGET}"
    echo "[toggle] src/h3.ts → PASS state (export const x: number = 42;)"
    ;;
  fail)
    printf 'export const x: number = "FAIL_MARKER";\n' > "${TARGET}"
    echo "[toggle] src/h3.ts → FAIL state (export const x: number = \"FAIL_MARKER\";)"
    ;;
  *)
    usage
    ;;
esac
