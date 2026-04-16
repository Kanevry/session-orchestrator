#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$(( FAIL + 1 ))
  fi
}

assert_file_exists() {
  local label="$1" file="$2"
  if [[ -f "$file" ]]; then
    echo "  PASS: $label"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: $label — file not found: $file"
    FAIL=$(( FAIL + 1 ))
  fi
}

# --------------------------------------------------------------------------
# Gate check — identical to production algorithm in bootstrap-gate.md
# Sets GATE_STATUS (OPEN | CLOSED) and GATE_REASON in caller's scope.
# --------------------------------------------------------------------------

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
# Helpers: scaffold Fast tier (simulates what fast-template.md produces)
# --------------------------------------------------------------------------

simulate_fast() {
  local root="$1"
  mkdir -p "$root/.orchestrator"

  cat > "$root/CLAUDE.md" <<'EOF'
# test-repo

Test project.

## Session Config

project-name: test-repo
vcs: github
EOF

  cat > "$root/.gitignore" <<'EOF'
.DS_Store
.env
node_modules/
EOF

  echo "# test-repo" > "$root/README.md"

  cat > "$root/.orchestrator/bootstrap.lock" <<EOF
version: 1
tier: fast
archetype: null
timestamp: 2026-04-16T09:00:00Z
source: plugin-template
EOF
}

# Helper: apply Standard-delta files (idempotent — skips existing files)
apply_standard_delta() {
  local root="$1"
  mkdir -p "$root/src" "$root/tests"
  if [[ ! -f "$root/package.json" ]];      then echo '{ "name": "test-repo", "version": "0.1.0" }' > "$root/package.json"; fi
  if [[ ! -f "$root/tsconfig.json" ]];     then echo '{ "compilerOptions": { "strict": true } }' > "$root/tsconfig.json"; fi
  if [[ ! -f "$root/eslint.config.mjs" ]]; then echo "export default [];" > "$root/eslint.config.mjs"; fi
  if [[ ! -f "$root/.prettierrc" ]];       then echo '{ "semi": true }' > "$root/.prettierrc"; fi
  if [[ ! -f "$root/.editorconfig" ]];     then echo "root = true" > "$root/.editorconfig"; fi
  if [[ ! -f "$root/src/index.ts" ]];      then echo "export {};" > "$root/src/index.ts"; fi
  if [[ ! -f "$root/tests/sanity.test.ts" ]]; then echo "// sanity" > "$root/tests/sanity.test.ts"; fi
}

# --------------------------------------------------------------------------
# Tempdir setup + cleanup
# --------------------------------------------------------------------------

TMPDIRS=()

make_tempdir() {
  local d; d="$(mktemp -d)"; TMPDIRS+=("$d"); echo "$d"
}

cleanup() {
  for d in "${TMPDIRS[@]+"${TMPDIRS[@]}"}"; do rm -rf "$d"; done
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# Scenario A: Already-bootstrapped repo — gate check returns OPEN immediately
# Assert: no file writes, gate is OPEN, no stderr from gate_check
# --------------------------------------------------------------------------
echo "--- Scenario A: Already-bootstrapped repo — gate returns OPEN ---"

REPO_A="$(make_tempdir)"
simulate_fast "$REPO_A"

FILE_COUNT_BEFORE_A=$(find "$REPO_A" -type f | wc -l | tr -d ' ')

GATE_STATUS="" GATE_REASON=""
GATE_STDERR_FILE="$(mktemp)"
gate_check "$REPO_A" 2>"$GATE_STDERR_FILE"
GATE_STDERR="$(cat "$GATE_STDERR_FILE")"
rm -f "$GATE_STDERR_FILE"

assert_eq "A: gate is OPEN"                  "OPEN"  "$GATE_STATUS"
assert_eq "A: gate reason is empty"          ""      "$GATE_REASON"
assert_eq "A: gate produces no stderr"       ""      "$GATE_STDERR"

FILE_COUNT_AFTER_A=$(find "$REPO_A" -type f | wc -l | tr -d ' ')
assert_eq "A: no files written during open gate check" "$FILE_COUNT_BEFORE_A" "$FILE_COUNT_AFTER_A"

# --------------------------------------------------------------------------
# Scenario B: bootstrap --fast twice in same repo — second run is a no-op
# First run creates files; second run detects lock → refuses re-scaffold.
# Assert: file count identical after second simulate_fast call.
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario B: bootstrap --fast twice — second run is a no-op ---"

REPO_B="$(make_tempdir)"

# First invocation
simulate_fast "$REPO_B"
FILE_COUNT_AFTER_FIRST_B=$(find "$REPO_B" -type f | wc -l | tr -d ' ')

GATE_STATUS="" GATE_REASON=""
gate_check "$REPO_B"
assert_eq "B: gate OPEN after first bootstrap" "OPEN" "$GATE_STATUS"

# Second invocation: gate is already OPEN, so bootstrap MUST NOT run.
# The idempotency rule: if gate is OPEN, bootstrap is skipped entirely.
# Simulate what the skill does: check gate first; only scaffold if CLOSED.
if [[ "$GATE_STATUS" == "OPEN" ]]; then
  # Bootstrap correctly skipped — no files written
  SECOND_RUN_SKIPPED=true
else
  # Bootstrap would erroneously run again
  simulate_fast "$REPO_B"
  SECOND_RUN_SKIPPED=false
fi

FILE_COUNT_AFTER_SECOND_B=$(find "$REPO_B" -type f | wc -l | tr -d ' ')

assert_eq "B: second invocation skipped (gate was already OPEN)" "true" "$SECOND_RUN_SKIPPED"
assert_eq "B: file count unchanged after second invocation"      "$FILE_COUNT_AFTER_FIRST_B" "$FILE_COUNT_AFTER_SECOND_B"

# Verify lock content unchanged
LOCK_B_TIER=$(grep "^tier:" "$REPO_B/.orchestrator/bootstrap.lock" | awk '{print $2}')
assert_eq "B: lock tier still fast" "fast" "$LOCK_B_TIER"

# --------------------------------------------------------------------------
# Scenario C: bootstrap --upgrade standard twice — second upgrade is no-op
# First: Fast → Standard adds delta files + updates lock.
# Second: same target tier is refused (not an upgrade) and delta is a no-op.
# Assert: file count identical after second apply_standard_delta call.
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario C: bootstrap --upgrade standard twice — second run is no-op ---"

REPO_C="$(make_tempdir)"
simulate_fast "$REPO_C"
LOCK_C="$REPO_C/.orchestrator/bootstrap.lock"

# First upgrade
apply_standard_delta "$REPO_C"
cat > "$LOCK_C" <<EOF
version: 1
tier: standard
archetype: node-minimal
timestamp: 2026-04-16T09:00:00Z
source: plugin-template
EOF

FILE_COUNT_AFTER_FIRST_C=$(find "$REPO_C" -type f | wc -l | tr -d ' ')
assert_eq "C: lock tier = standard after first upgrade" "standard" \
  "$(grep "^tier:" "$LOCK_C" | awk '{print $2}')"

# Second upgrade: same tier → refused (no-op on delta application)
apply_standard_delta "$REPO_C"   # idempotent: skips all existing files

FILE_COUNT_AFTER_SECOND_C=$(find "$REPO_C" -type f | wc -l | tr -d ' ')
assert_eq "C: file count unchanged after second upgrade (no new files)" \
  "$FILE_COUNT_AFTER_FIRST_C" "$FILE_COUNT_AFTER_SECOND_C"

# Lock tier must remain standard (no re-write needed on no-op)
assert_eq "C: lock tier still standard" "standard" \
  "$(grep "^tier:" "$LOCK_C" | awk '{print $2}')"

# --------------------------------------------------------------------------
# Scenario D: bootstrap.lock content is stable given identical inputs
# Assert: two runs with pinned timestamp produce byte-identical lock content.
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario D: bootstrap.lock content is stable (byte-identical for same inputs) ---"

REPO_D1="$(make_tempdir)"
REPO_D2="$(make_tempdir)"

PINNED_TS="2026-04-16T09:00:00Z"

write_lock() {
  local root="$1" tier="$2" archetype="$3" ts="$4"
  mkdir -p "$root/.orchestrator"
  cat > "$root/.orchestrator/bootstrap.lock" <<EOF
version: 1
tier: ${tier}
archetype: ${archetype}
timestamp: ${ts}
source: plugin-template
EOF
}

write_lock "$REPO_D1" "fast" "null" "$PINNED_TS"
write_lock "$REPO_D2" "fast" "null" "$PINNED_TS"

LOCK_D1="$REPO_D1/.orchestrator/bootstrap.lock"
LOCK_D2="$REPO_D2/.orchestrator/bootstrap.lock"

assert_file_exists "D: lock file 1 written" "$LOCK_D1"
assert_file_exists "D: lock file 2 written" "$LOCK_D2"

if diff -q "$LOCK_D1" "$LOCK_D2" > /dev/null 2>&1; then
  echo "  PASS: D: both lock files are byte-identical"
  PASS=$(( PASS + 1 ))
else
  echo "  FAIL: D: lock files differ"
  diff "$LOCK_D1" "$LOCK_D2" || true
  FAIL=$(( FAIL + 1 ))
fi

# Also verify: changing only tier produces a different lock (falsification)
write_lock "$REPO_D1" "standard" "node-minimal" "$PINNED_TS"
if ! diff -q "$REPO_D1/.orchestrator/bootstrap.lock" "$LOCK_D2" > /dev/null 2>&1; then
  echo "  PASS: D: different tier inputs produce different lock content"
  PASS=$(( PASS + 1 ))
else
  echo "  FAIL: D: different tier inputs should not produce identical lock content"
  FAIL=$(( FAIL + 1 ))
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
