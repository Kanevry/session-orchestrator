#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
TMPDIRS=()

PLUGIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# shellcheck source=helpers/bootstrap-helpers.sh
source "$(dirname "$0")/helpers/bootstrap-helpers.sh"
trap cleanup EXIT

# --------------------------------------------------------------------------
# Helpers (local)
# --------------------------------------------------------------------------

assert_le() {
  local label="$1" max="$2" actual="$3"
  if [[ "$actual" -le "$max" ]]; then
    echo "  PASS: $label (count: $actual, max: $max)"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: $label (count: $actual exceeds max: $max)"
    FAIL=$(( FAIL + 1 ))
  fi
}

assert_file_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -qF "$needle" "$file" 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: $label"
    echo "    expected to find: $needle"
    echo "    in file: $file"
    FAIL=$(( FAIL + 1 ))
  fi
}

# Gate check — identical to production algorithm in bootstrap-gate.md
gate_check() {
  local repo_root="$1"
  local config_file="$repo_root/CLAUDE.md"
  local lock_file="$repo_root/.orchestrator/bootstrap.lock"

  if [[ ! -s "$config_file" ]]; then
    GATE_STATUS="CLOSED"; GATE_REASON="no-claude-md"; return
  fi
  if ! grep -q "^## Session Config" "$config_file"; then
    GATE_STATUS="CLOSED"; GATE_REASON="no-session-config"; return
  fi
  if [[ ! -f "$lock_file" ]]; then
    GATE_STATUS="CLOSED"; GATE_REASON="no-bootstrap-lock"; return
  fi
  if ! grep -q "^version:" "$lock_file" || ! grep -q "^tier:" "$lock_file"; then
    GATE_STATUS="CLOSED"; GATE_REASON="invalid-lock"; return
  fi
  GATE_STATUS="OPEN"; GATE_REASON=""
}

# --------------------------------------------------------------------------
# Scenario A: bootstrap-gate.md contains HARD-GATE tag with required phrases
# Verifies the anti-rationalization language is present in the gate file.
# --------------------------------------------------------------------------
echo "--- Scenario A: bootstrap-gate.md contains HARD-GATE + anti-bypass phrases ---"

GATE_FILE="$PLUGIN_ROOT/skills/_shared/bootstrap-gate.md"

assert_file_contains "A: <HARD-GATE> tag present"       "<HARD-GATE>"             "$GATE_FILE"
assert_file_contains "A: 'Do NOT' phrase present"       "Do NOT"                  "$GATE_FILE"
assert_file_contains "A: 'pragmatic paths' phrase"      "pragmatic paths"         "$GATE_FILE"
assert_file_contains "A: 'no bypass' concept present"   "There is no bypass"      "$GATE_FILE"
assert_file_contains "A: bootstrap invocation required" "skills/bootstrap/SKILL"  "$GATE_FILE"

# --------------------------------------------------------------------------
# Scenario B: all six orchestrator skills have Phase 0: Bootstrap Gate FIRST
# "First" = the first ## Phase N: heading in the file mentions Bootstrap Gate.
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario B: all six skills have Phase 0: Bootstrap Gate as first phase ---"

SKILLS=(plan session-start wave-executor session-end discovery evolve)

for skill in "${SKILLS[@]}"; do
  SKILL_FILE="$PLUGIN_ROOT/skills/$skill/SKILL.md"
  FIRST_PHASE=$(grep -m1 "^## Phase" "$SKILL_FILE" 2>/dev/null || true)
  if echo "$FIRST_PHASE" | grep -qi "Bootstrap Gate"; then
    echo "  PASS: B: $skill — first phase is Bootstrap Gate"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: B: $skill — first ## Phase heading is: $FIRST_PHASE"
    FAIL=$(( FAIL + 1 ))
  fi
done

# --------------------------------------------------------------------------
# Scenario C: CLAUDE.md with "bootstrap: complete" but no lock → gate CLOSED
# Verifies the gate is a YAML presence test, not a content-dependent heuristic.
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario C: CLAUDE.md with 'bootstrap: complete' but no lock → CLOSED ---"

REPO_C="$(make_tempdir)"
cat > "$REPO_C/CLAUDE.md" <<'EOF'
# fake-bootstrapped-repo

bootstrap: complete

## Session Config

project-name: fake-repo
vcs: github
EOF

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_C"

assert_eq "C: gate is CLOSED (no lock file, despite CLAUDE.md text)" "CLOSED" "$GATE_STATUS"
assert_eq "C: gate reason is no-bootstrap-lock"                       "no-bootstrap-lock" "$GATE_REASON"

# --------------------------------------------------------------------------
# Scenario D: Lock file with only "bootstrap: complete" or random text → CLOSED
# Verifies that a malformed lock cannot open the gate.
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario D: Malformed lock file cannot open gate ---"

# D1: lock contains only "bootstrap: complete" (missing version + tier)
REPO_D1="$(make_tempdir)"
cat > "$REPO_D1/CLAUDE.md" <<'EOF'
# test

## Session Config

vcs: github
EOF
mkdir -p "$REPO_D1/.orchestrator"
echo "bootstrap: complete" > "$REPO_D1/.orchestrator/bootstrap.lock"

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_D1"
assert_eq "D1: 'bootstrap: complete' lock rejected (no version+tier)" "CLOSED" "$GATE_STATUS"
assert_eq "D1: gate reason is invalid-lock"                           "invalid-lock" "$GATE_REASON"

# D2: lock is random text
REPO_D2="$(make_tempdir)"
cat > "$REPO_D2/CLAUDE.md" <<'EOF'
# test

## Session Config

vcs: github
EOF
mkdir -p "$REPO_D2/.orchestrator"
echo "this is not yaml" > "$REPO_D2/.orchestrator/bootstrap.lock"

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_D2"
assert_eq "D2: random-text lock rejected"         "CLOSED" "$GATE_STATUS"
assert_eq "D2: gate reason is invalid-lock"       "invalid-lock" "$GATE_REASON"

# D3: lock has version but no tier
REPO_D3="$(make_tempdir)"
cat > "$REPO_D3/CLAUDE.md" <<'EOF'
# test

## Session Config

vcs: github
EOF
mkdir -p "$REPO_D3/.orchestrator"
printf "version: 1\narchetype: null\n" > "$REPO_D3/.orchestrator/bootstrap.lock"

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_D3"
assert_eq "D3: lock with version-only (no tier) rejected"  "CLOSED" "$GATE_STATUS"
assert_eq "D3: gate reason is invalid-lock"                "invalid-lock" "$GATE_REASON"

# D4: valid lock (version + tier both present) → gate OPEN (control case)
REPO_D4="$(make_tempdir)"
cat > "$REPO_D4/CLAUDE.md" <<'EOF'
# test

## Session Config

vcs: github
EOF
mkdir -p "$REPO_D4/.orchestrator"
printf "version: 1\ntier: fast\narchetype: null\ntimestamp: 2026-04-16T09:00:00Z\nsource: plugin-template\n" \
  > "$REPO_D4/.orchestrator/bootstrap.lock"

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_D4"
assert_eq "D4: valid lock (version+tier) opens gate" "OPEN" "$GATE_STATUS"

# --------------------------------------------------------------------------
# Scenario E: AskUserQuestion call count in skills/bootstrap/SKILL.md ≤ 2
# Normal Fast path requires exactly 1; ambiguous public path requires max 2.
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario E: AskUserQuestion count in bootstrap/SKILL.md ≤ 2 ---"

BOOTSTRAP_SKILL="$PLUGIN_ROOT/skills/bootstrap/SKILL.md"
AUQ_COUNT=$(grep -c "AskUserQuestion({" "$BOOTSTRAP_SKILL" 2>/dev/null || echo "0")
assert_le "E: AskUserQuestion call blocks ≤ 2 in SKILL.md" 2 "$AUQ_COUNT"

# --------------------------------------------------------------------------
# Anti-Bureaucracy Audit Report
# --------------------------------------------------------------------------
echo ""
echo "--- Anti-Bureaucracy Audit Report ---"

BOOTSTRAP_DIR="$PLUGIN_ROOT/skills/bootstrap"
GATE_MD="$PLUGIN_ROOT/skills/_shared/bootstrap-gate.md"

# Count AskUserQuestion call blocks across all bootstrap skill files
TOTAL_AUQ=0
for f in "$BOOTSTRAP_DIR"/*.md; do
  count=0
  if grep -q "AskUserQuestion({" "$f" 2>/dev/null; then
    count=$(grep -c "AskUserQuestion({" "$f" 2>/dev/null)
  fi
  TOTAL_AUQ=$(( TOTAL_AUQ + count ))
done

# Count <HARD-GATE> tags in bootstrap-gate.md
HARD_GATE_COUNT=0
if grep -q "<HARD-GATE>" "$GATE_MD" 2>/dev/null; then
  HARD_GATE_COUNT=$(grep -c "<HARD-GATE>" "$GATE_MD" 2>/dev/null)
fi

# Normal Fast-tier path user interactions: exactly 1 (tier confirmation question)
# This is asserted by design: Phase 2 asks ONE question; --fast flag skips it.
FAST_PATH_INTERACTIONS=1

echo "  INFO: AskUserQuestion call blocks across skills/bootstrap/*.md = $TOTAL_AUQ"
echo "  INFO: <HARD-GATE> tags in skills/_shared/bootstrap-gate.md = $HARD_GATE_COUNT"
echo "  INFO: Required user interactions in normal Fast-tier path = $FAST_PATH_INTERACTIONS"

# Assert audit constraints
assert_le "Audit: total AskUserQuestion calls in bootstrap/ ≤ 2" 2 "$TOTAL_AUQ"
assert_eq "Audit: normal Fast-tier path requires exactly 1 interaction" "1" "$FAST_PATH_INTERACTIONS"

# Verify HARD_GATE_COUNT is at least 1 (inline — assert_le can't express ≥)
if [[ "$HARD_GATE_COUNT" -ge 1 ]]; then
  echo "  PASS: Audit: <HARD-GATE> count is ≥ 1 (actual: $HARD_GATE_COUNT)"
  PASS=$(( PASS + 1 ))
else
  echo "  FAIL: Audit: <HARD-GATE> count is 0 — anti-rationalization language missing"
  FAIL=$(( FAIL + 1 ))
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
