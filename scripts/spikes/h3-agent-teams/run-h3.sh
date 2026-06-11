#!/usr/bin/env bash
# run-h3.sh — operator harness for the #484-H3 Agent-Teams hook-seam test.
#
# This script does NOT spawn claude. It ensures the fixture exists and prints
# the exact per-run procedure the operator follows interactively. Agent Teams
# are interactive-only; on this host (Ghostty, no tmux) split-pane is
# unsupported, so `--teammate-mode in-process` is mandatory.
#
# Usage:
#   ./run-h3.sh           # print the full 3-run procedure
#   ./run-h3.sh 1|2|3     # print the procedure for a single run
#   ./run-h3.sh cleanup   # remove fixture + team/task state
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="/tmp/h3-agent-teams-test"

TEAM="h3-test-484"
PROMPT="Create an agent team named ${TEAM} with one teammate called impl-agent. Assign impl-agent a single task: 'Make npm run typecheck pass for src/h3.ts, then mark the task complete.' A TaskCompleted hook runs npm run typecheck and will block completion on exit 2. Do not fix the file yourself — let the teammate do it."

LAUNCH="cd ${FIXTURE} && export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 && claude --teammate-mode in-process"

ensure_fixture() {
  if [ ! -f "${FIXTURE}/package.json" ]; then
    echo "[run-h3] fixture missing — building it"
    bash "${HERE}/setup.sh"
  fi
}

print_run() {
  local n="$1" state expected
  if [ "${n}" -eq 1 ]; then state="pass"; expected="completes UNBLOCKED (hook exit 0)"; else state="fail"; expected="BLOCKED (hook exit 2), then teammate retries to pass"; fi

  cat <<EOF

────────────────────────────────────────────────────────────────────────────
RUN ${n} — required src/h3.ts state: ${state}   →  expected: ${expected}
────────────────────────────────────────────────────────────────────────────
1. Toggle the source state:
     ${HERE}/toggle.sh ${state}

2. Launch (in-process mode — split-pane unsupported in Ghostty):
     ${LAUNCH}

3. Paste this prompt to the lead:
     ${PROMPT}

4. Observe (keys inside the claude TUI):
     - Shift+Down  → focus/scroll the teammate pane (read its actions + hook feedback)
     - Ctrl+T      → toggle the task list (watch the task status transition)
   Look for: the TaskCompleted hook firing, its exit code, whether the task is
   blocked vs completed, whether the typecheck error reached the teammate as
   feedback, and whether the teammate retried after reading it.

5. Record one JSONL line into ${FIXTURE}/h3-results.jsonl
   (shape: ${FIXTURE}/RESULTS-TEMPLATE.jsonl):
     run 1 expect → hook_exit_code:0, task_status:"completed", blocked:false
     runs 2-3 expect → hook_exit_code:2, blocked:true, feedback_delivered:true,
                        teammate_retried:true, then task_status:"completed" after retry

6. Reset before the NEXT run (fresh team each run):
     ${HERE}/run-h3.sh cleanup      # or just remove the team/task dirs (see cleanup)
     ${HERE}/setup.sh               # rebuild a clean fixture
EOF
}

cleanup() {
  echo "[run-h3] cleaning fixture + team/task state"
  rm -rf "${FIXTURE}" "${HOME}/.claude/teams/${TEAM}" "${HOME}/.claude/tasks/${TEAM}"
  echo "[run-h3] removed:"
  echo "  ${FIXTURE}"
  echo "  ${HOME}/.claude/teams/${TEAM}"
  echo "  ${HOME}/.claude/tasks/${TEAM}"
}

case "${1:-all}" in
  cleanup)
    cleanup
    ;;
  1|2|3)
    ensure_fixture
    print_run "$1"
    ;;
  all)
    ensure_fixture
    cat <<EOF
============================================================================
#484-H3 Agent-Teams hook-seam test — operator harness
Fixture: ${FIXTURE}   Team: ${TEAM}   Mode: --teammate-mode in-process
Run preflight.sh FIRST to confirm the command contract (exit 0 pass / 2 fail).
3-run matrix:  run 1 = pass (must complete unblocked)
               run 2 = fail (must block, then retry to pass)
               run 3 = fail (must block, then retry to pass)
============================================================================
EOF
    print_run 1
    print_run 2
    print_run 3
    cat <<EOF

────────────────────────────────────────────────────────────────────────────
CLEANUP (after all 3 runs):
  rm -rf ${FIXTURE} ${HOME}/.claude/teams/${TEAM} ${HOME}/.claude/tasks/${TEAM}
  (or: ${HERE}/run-h3.sh cleanup)
────────────────────────────────────────────────────────────────────────────
EOF
    ;;
  *)
    echo "usage: $0 [1|2|3|cleanup]" >&2
    exit 1
    ;;
esac
