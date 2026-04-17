#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
TMPDIRS=()

# shellcheck source=helpers/bootstrap-helpers.sh
source "$(dirname "$0")/helpers/bootstrap-helpers.sh"
trap cleanup EXIT

# --------------------------------------------------------------------------
# Helpers (local)
# --------------------------------------------------------------------------

# Gate check function — implements the algorithm from skills/_shared/bootstrap-gate.md
# Sets GATE_STATUS (OPEN | CLOSED) and GATE_REASON in the caller's scope.
gate_check() {
  local repo_root="$1"
  local config_file="$repo_root/CLAUDE.md"
  local lock_file="$repo_root/.orchestrator/bootstrap.lock"

  # Check 1: CLAUDE.md exists and is non-empty
  if [[ ! -s "$config_file" ]]; then
    GATE_STATUS="CLOSED"
    GATE_REASON="no-claude-md"
    return
  fi

  # Check 2: ## Session Config section present
  if ! grep -q "^## Session Config" "$config_file"; then
    GATE_STATUS="CLOSED"
    GATE_REASON="no-session-config"
    return
  fi

  # Check 3: bootstrap.lock exists and has required keys (version + tier)
  if [[ ! -f "$lock_file" ]]; then
    GATE_STATUS="CLOSED"
    GATE_REASON="no-bootstrap-lock"
    return
  fi

  if ! grep -q "^version:" "$lock_file" || ! grep -q "^tier:" "$lock_file"; then
    GATE_STATUS="CLOSED"
    GATE_REASON="invalid-lock"
    return
  fi

  GATE_STATUS="OPEN"
  GATE_REASON=""
}

# --------------------------------------------------------------------------
# Scenario A: Empty tempdir — no CLAUDE.md → GATE_CLOSED / no-claude-md
# --------------------------------------------------------------------------
echo "--- Scenario A: Empty repo (no CLAUDE.md) ---"

REPO_A="$(make_tempdir)"

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_A"

assert_eq "A: gate status is CLOSED"  "CLOSED" "$GATE_STATUS"
assert_eq "A: gate reason is no-claude-md" "no-claude-md" "$GATE_REASON"

# --------------------------------------------------------------------------
# Scenario B: CLAUDE.md + Session Config BUT no bootstrap.lock
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario B: CLAUDE.md + Session Config, no bootstrap.lock ---"

REPO_B="$(make_tempdir)"
cat > "$REPO_B/CLAUDE.md" <<'EOF'
# My Project

Some project description.

## Session Config

persistence: true
vcs: github
EOF

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_B"

assert_eq "B: gate status is CLOSED"  "CLOSED" "$GATE_STATUS"
assert_eq "B: gate reason is no-bootstrap-lock" "no-bootstrap-lock" "$GATE_REASON"

# --------------------------------------------------------------------------
# Scenario C: CLAUDE.md + Session Config + valid bootstrap.lock → GATE_OPEN
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario C: All three present — gate open ---"

REPO_C="$(make_tempdir)"
cat > "$REPO_C/CLAUDE.md" <<'EOF'
# My Project

Some project description.

## Session Config

persistence: true
vcs: github
EOF

mkdir -p "$REPO_C/.orchestrator"
cat > "$REPO_C/.orchestrator/bootstrap.lock" <<'EOF'
version: 1
tier: fast
archetype: null
timestamp: 2026-04-16T09:30:00Z
source: plugin-template
EOF

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_C"

assert_eq "C: gate status is OPEN" "OPEN" "$GATE_STATUS"
assert_eq "C: gate reason is empty" "" "$GATE_REASON"

# --------------------------------------------------------------------------
# Bonus: CLAUDE.md present but no Session Config section
# --------------------------------------------------------------------------
echo ""
echo "--- Bonus: CLAUDE.md without Session Config section ---"

REPO_D="$(make_tempdir)"
cat > "$REPO_D/CLAUDE.md" <<'EOF'
# My Project

No session config here.
EOF

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_D"

assert_eq "D: gate status is CLOSED" "CLOSED" "$GATE_STATUS"
assert_eq "D: gate reason is no-session-config" "no-session-config" "$GATE_REASON"

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
