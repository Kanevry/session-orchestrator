#!/usr/bin/env bash
# hooks/agent-teams-h3-test.sh — Empirical H3 hook-seam test harness for Agent Teams Adapter
#
# Per ADR 0002 (issue #484): verify that a TaskCompleted exit-2 hook reliably blocks
# task completion + feeds back to the teammate across 3 repeat runs (lagging-task-status race).
#
# This is a DRY-RUN harness. Live Agent Teams execution is interactive and cannot be
# fully automated from bash. The script:
#   1. Verifies preconditions (claude-code version, experimental flag availability)
#   2. Sets up the test team scaffold at ~/.claude/teams/h3-test-deep3/
#   3. Prints the manual 3-run procedure for the operator to execute
#   4. Generates a JSONL log template for capturing results
#
# Exit codes:
#   0 — preconditions met, scaffold created, ready for manual 3-run
#   1 — preconditions failed (version too low, flag unrecognized, etc.)
#   2 — scaffold creation failed (permission/path issue)

set -euo pipefail

TEAM_NAME="h3-test-deep3"
TEAM_DIR="${HOME}/.claude/teams/${TEAM_NAME}"
LOG_TEMPLATE_PATH=".orchestrator/research/h3-hook-seam-test-template.jsonl"
MIN_CLAUDE_VERSION="2.1.32"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

print_header() {
  echo ""
  echo "============================================================"
  echo "  H3 Hook-Seam Test Harness — Agent Teams Adapter (ADR 0002)"
  echo "============================================================"
  echo ""
  echo "Purpose: Verify that a TaskCompleted exit-2 hook reliably blocks"
  echo "         task completion and delivers feedback to the teammate,"
  echo "         across 3 repeat runs (lagging-task-status race check)."
  echo ""
  echo "This is a DRY-RUN setup harness. Live execution is interactive."
  echo ""
}

version_gte() {
  # Returns 0 if $1 >= $2 (semver comparison, major.minor.patch)
  local actual="$1"
  local required="$2"
  # Use sort -V to compare; if the required version comes first (or is equal),
  # the actual version is sufficient.
  local lowest
  lowest="$(printf '%s\n%s\n' "$actual" "$required" | sort -V | head -n1)"
  [ "$lowest" = "$required" ]
}

# ---------------------------------------------------------------------------
# Step 1: Precondition check
# ---------------------------------------------------------------------------

precondition_check() {
  echo "=== Step 1: Precondition Check ==="
  echo ""

  local failed=0

  # 1a. claude-code binary present
  if ! command -v claude >/dev/null 2>&1; then
    echo "[FAIL] 'claude' binary not found on PATH."
    echo "       Install Claude Code >= ${MIN_CLAUDE_VERSION} and ensure it is on your PATH."
    failed=1
  else
    # 1b. Version check
    local raw_version
    raw_version="$(claude --version 2>/dev/null | head -n1)" || true
    # Extract the semver portion (e.g. "2.1.144" from "2.1.144 (Claude Code)")
    local actual_version
    actual_version="$(echo "${raw_version}" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)" || true

    if [ -z "${actual_version}" ]; then
      echo "[FAIL] Could not parse version from: '${raw_version}'"
      echo "       Expected format: '2.1.144 (Claude Code)'"
      failed=1
    elif version_gte "${actual_version}" "${MIN_CLAUDE_VERSION}"; then
      echo "[PASS] claude version: ${actual_version} >= ${MIN_CLAUDE_VERSION} (minimum required)"
    else
      echo "[FAIL] claude version: ${actual_version} < ${MIN_CLAUDE_VERSION} (minimum required)"
      echo "       Please upgrade Claude Code before running the H3 test."
      failed=1
    fi
  fi

  # 1c. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS recognized in binary
  # We check via 'strings' (available on macOS/Linux) rather than actually
  # setting the env-var, since setting it alone has no side effects but
  # we want to confirm the flag is compiled in — not just accepted silently.
  echo ""
  echo "Checking CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS flag recognition..."
  local claude_bin
  claude_bin="$(command -v claude 2>/dev/null)" || true

  if [ -n "${claude_bin}" ] && command -v strings >/dev/null 2>&1; then
    local flag_hits
    flag_hits="$(strings "${claude_bin}" 2>/dev/null | grep -c 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' || true)"
    if [ "${flag_hits}" -ge 1 ]; then
      echo "[PASS] CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is compiled into the binary (${flag_hits} occurrences)"
    else
      echo "[WARN] Could not confirm flag in binary via 'strings'. This may be a macOS SIP or binary format issue."
      echo "       Proceeding; flag may still be recognized at runtime."
    fi
  else
    echo "[INFO] 'strings' not available or claude binary not found — skipping binary flag scan."
    echo "       Flag recognition was confirmed empirically at W1 D2 (session 2026-05-19-deep-2)."
  fi

  # 1d. No existing ~/.claude/teams/ team with this name (avoid clobber)
  echo ""
  if [ -d "${TEAM_DIR}" ]; then
    echo "[WARN] ${TEAM_DIR} already exists. Scaffold step will skip overwriting existing files."
  else
    echo "[INFO] ${TEAM_DIR} does not exist — scaffold will create it fresh."
  fi

  echo ""
  if [ "${failed}" -eq 1 ]; then
    echo "[FAIL] One or more preconditions not met. Resolve issues above before proceeding."
    return 1
  fi

  echo "[PASS] All preconditions met."
  return 0
}

# ---------------------------------------------------------------------------
# Step 2: Scaffold the test team directory
# ---------------------------------------------------------------------------

scaffold_team_dir() {
  echo "=== Step 2: Team Scaffold ==="
  echo ""
  echo "Creating team scaffold at: ${TEAM_DIR}"
  echo ""

  # Use a subshell so set -e applies; any failure returns 2 to caller via trap
  if ! mkdir -p "${TEAM_DIR}"; then
    echo "[FAIL] Could not create ${TEAM_DIR} — check permissions."
    return 2
  fi

  # Write the hooks config that will exercise the H3 seam.
  # NOTE: This is the INTENDED config shape; the operator must verify that
  # the actual Agent Teams schema in their claude-code version matches this
  # before live execution. The machine-owned config.json is NOT created here
  # (that is generated by claude-code on first team spawn).
  local hooks_file="${TEAM_DIR}/hooks.json"
  if [ ! -f "${hooks_file}" ]; then
    cat >"${hooks_file}" <<'HOOKS_JSON'
{
  "_comment": "H3 test hook config — NOT machine-owned config.json. Verify schema with your claude-code version.",
  "_warning": "config.json for Agent Teams is machine-owned; do not hand-edit it. This hooks.json is reference only.",
  "teamHooks": {
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npm run typecheck",
            "_rationale": "Exit-2 on typecheck failure blocks task completion + feeds back to teammate. H3 test seam."
          }
        ]
      }
    ],
    "TeammateIdle": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '[H3] TeammateIdle hook fired — teammate is idle'",
            "_rationale": "Witness hook to confirm TeammateIdle seam fires. No blocking behavior for H3."
          }
        ]
      }
    ]
  }
}
HOOKS_JSON
    echo "[DONE] Created ${hooks_file} (reference hook config — NOT the machine-owned config.json)"
  else
    echo "[SKIP] ${hooks_file} already exists — not overwritten."
  fi

  # Write the test task definition (reference only)
  local task_file="${TEAM_DIR}/h3-test-task.json"
  if [ ! -f "${task_file}" ]; then
    cat >"${task_file}" <<'TASK_JSON'
{
  "_comment": "Reference task definition for H3 manual test run. Adapt to your team lead's task-creation flow.",
  "id": "h3-ts-error-task",
  "subject": "Introduce a deliberate TypeScript error in a scratch file, then confirm typecheck blocks completion",
  "description": "Add 'const x: number = \"not-a-number\";' to src/scratch/h3-test.ts. This guarantees a typecheck failure. The TaskCompleted hook (npm run typecheck) must exit 2, blocking the teammate and delivering the error message as feedback. Verify the teammate sees the block, reads the feedback, corrects the file, and retries.",
  "expectedOutcome": {
    "hookFires": true,
    "exitCode": 2,
    "taskBlocked": true,
    "feedbackDelivered": true,
    "teammateRetries": true
  }
}
TASK_JSON
    echo "[DONE] Created ${task_file} (reference task definition)"
  else
    echo "[SKIP] ${task_file} already exists — not overwritten."
  fi

  echo ""
  echo "[PASS] Scaffold complete: ${TEAM_DIR}"
  return 0
}

# ---------------------------------------------------------------------------
# Step 3: Generate JSONL log template
# ---------------------------------------------------------------------------

generate_log_template() {
  echo "=== Step 3: JSONL Log Template ==="
  echo ""

  local log_dir
  log_dir="$(dirname "${LOG_TEMPLATE_PATH}")"

  if [ ! -d "${log_dir}" ]; then
    echo "[INFO] Creating directory: ${log_dir}"
    if ! mkdir -p "${log_dir}"; then
      echo "[WARN] Could not create ${log_dir} — skipping log template generation."
      return 0
    fi
  fi

  if [ -f "${LOG_TEMPLATE_PATH}" ]; then
    echo "[SKIP] ${LOG_TEMPLATE_PATH} already exists — not overwritten."
    return 0
  fi

  cat >"${LOG_TEMPLATE_PATH}" <<'JSONL_TEMPLATE'
{"timestamp":"YYYY-MM-DDTHH:MM:SSZ","run_n":1,"hook_exit_code":null,"task_status":null,"blocked":null,"feedback_delivered":null,"teammate_retried":null,"notes":"Run 1 — PENDING. Fill after manual execution."}
{"timestamp":"YYYY-MM-DDTHH:MM:SSZ","run_n":2,"hook_exit_code":null,"task_status":null,"blocked":null,"feedback_delivered":null,"teammate_retried":null,"notes":"Run 2 — PENDING. Fill after manual execution."}
{"timestamp":"YYYY-MM-DDTHH:MM:SSZ","run_n":3,"hook_exit_code":null,"task_status":null,"blocked":null,"feedback_delivered":null,"teammate_retried":null,"notes":"Run 3 — PENDING. Fill after manual execution."}
JSONL_TEMPLATE

  echo "[DONE] Created log template: ${LOG_TEMPLATE_PATH}"
  echo ""
  echo "Schema per row:"
  echo "  timestamp          — ISO-8601 UTC timestamp of the run"
  echo "  run_n              — 1, 2, or 3"
  echo "  hook_exit_code     — observed exit code from the TaskCompleted hook (expect 2 on TS error)"
  echo "  task_status        — 'blocked' | 'completed' | 'error'"
  echo "  blocked            — true if teammate saw the task blocked; false otherwise"
  echo "  feedback_delivered — true if teammate received the typecheck error message; false otherwise"
  echo "  teammate_retried   — true if teammate corrected the error and retried; false otherwise"
  echo "  notes              — free-text observations (race condition signs, UI behaviour, etc.)"
  return 0
}

# ---------------------------------------------------------------------------
# Step 4: Print manual 3-run procedure
# ---------------------------------------------------------------------------

print_manual_procedure() {
  echo ""
  echo "=== Step 4: Manual 3-Run Procedure ==="
  echo ""
  echo "Complete the following steps manually in a terminal with an interactive Claude Code session."
  echo "Run the full procedure 3 times, logging results to: ${LOG_TEMPLATE_PATH}"
  echo ""
  echo "--- Pre-run setup (once) ---"
  echo ""
  echo "  1. Export the Agent Teams flag:"
  echo "     export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
  echo ""
  echo "  2. Create the scratch TypeScript file for the test task:"
  echo "     mkdir -p src/scratch"
  echo "     echo 'const x: number = \"not-a-number\";' > src/scratch/h3-test.ts"
  echo ""
  echo "--- Per-run procedure (repeat 3 times) ---"
  echo ""
  echo "  Run N (replace N with 1, 2, 3):"
  echo ""
  echo "  Step 1. Launch Claude Code in team lead mode:"
  echo "          claude (with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in env)"
  echo ""
  echo "  Step 2. In the Claude Code session, use /team to configure the team:"
  echo "          - Team name: ${TEAM_NAME}"
  echo "          - Spawn 1 teammate (e.g., named 'impl-agent')"
  echo "          - Attach the TaskCompleted hook: 'npm run typecheck' (exit-2 blocks)"
  echo "          Reference hooks config: ${TEAM_DIR}/hooks.json"
  echo ""
  echo "  Step 3. Assign the teammate the H3 test task:"
  echo "          'Implement src/scratch/h3-test.ts — it currently has a TypeScript error."
  echo "           The task is complete when typecheck passes. Task ID: h3-ts-error-task.'"
  echo "          Reference task definition: ${TEAM_DIR}/h3-test-task.json"
  echo ""
  echo "  Step 4. Observe TaskCompleted hook behavior:"
  echo "          - Hook fires 'npm run typecheck'"
  echo "          - Does the hook exit 2? (typecheck should fail on the deliberate error)"
  echo "          - Is the task marked 'blocked' (not 'completed') in the task list?"
  echo "          - Does the teammate receive the typecheck error output as feedback?"
  echo ""
  echo "  Step 5. Observe teammate correction:"
  echo "          - Does the teammate read the feedback and correct src/scratch/h3-test.ts?"
  echo "          - Does the teammate retry task completion after correction?"
  echo "          - Does the hook exit 0 on the corrected file?"
  echo "          - Is the task marked 'completed'?"
  echo ""
  echo "  Step 6. Log results:"
  echo "          Edit ${LOG_TEMPLATE_PATH} and fill in row N with observed values."
  echo ""
  echo "--- Promotion criteria (from ADR 0002) ---"
  echo ""
  echo "  PASS: All 3 runs show hook_exit_code=2, blocked=true, feedback_delivered=true"
  echo "        → H3 PASS → Agent Teams backend spike proceeds (#484)"
  echo ""
  echo "  FAIL: Any run shows blocked=false OR feedback_delivered=false"
  echo "        → H3 FAIL → Spike closed won't-do, ADR 0002 collapses to Stay"
  echo ""
  echo "  After recording results, update docs/research/2026-05-19-deep-3-agent-teams-h3.md"
  echo "  § Results and § Status with the outcome."
  echo ""
  echo "--- Cleanup ---"
  echo ""
  echo "  After all 3 runs:"
  echo "  rm -f src/scratch/h3-test.ts"
  echo "  # Team dir ${TEAM_DIR} can be left for H4 config-overwrite test"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  print_header

  precondition_check || exit 1
  echo ""

  scaffold_team_dir || exit 2
  echo ""

  generate_log_template
  echo ""

  print_manual_procedure

  echo "============================================================"
  echo "  Harness setup complete — ready for manual 3-run execution"
  echo "  Log template: ${LOG_TEMPLATE_PATH}"
  echo "  Team scaffold: ${TEAM_DIR}"
  echo "============================================================"
  echo ""
  exit 0
}

main "$@"
