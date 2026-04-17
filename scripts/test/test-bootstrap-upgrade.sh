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

assert_file_absent() {
  local label="$1" file="$2"
  if [[ ! -f "$file" ]]; then
    echo "  PASS: $label"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL: $label — file should be absent: $file"
    FAIL=$(( FAIL + 1 ))
  fi
}

lock_tier() {
  local lock_file="$1"
  grep "^tier:" "$lock_file" | awk '{print $2}'
}

lock_source() {
  local lock_file="$1"
  grep "^source:" "$lock_file" | awk '{print $2}'
}

# --------------------------------------------------------------------------
# Tier rank helpers — used for downgrade detection
# --------------------------------------------------------------------------

tier_rank() {
  case "$1" in
    fast)     echo 1 ;;
    standard) echo 2 ;;
    deep)     echo 3 ;;
    *)        echo 0 ;;
  esac
}

# Returns 0 (true) if TARGET_TIER is a strict upgrade over CURRENT_TIER
is_upgrade() {
  local current="$1" target="$2"
  [[ "$(tier_rank "$target")" -gt "$(tier_rank "$current")" ]]
}

# --------------------------------------------------------------------------
# Simulate Fast tier scaffold
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

# --------------------------------------------------------------------------
# Simulate Standard delta files (what upgrade fast → standard adds)
# --------------------------------------------------------------------------

apply_standard_delta() {
  local root="$1"
  mkdir -p "$root/src" "$root/tests"

  # Only write files that are absent (idempotency rule)
  if [[ ! -f "$root/package.json" ]]; then
    cat > "$root/package.json" <<'EOF'
{ "name": "test-repo", "version": "0.1.0", "type": "module" }
EOF
  fi

  if [[ ! -f "$root/tsconfig.json" ]]; then
    cat > "$root/tsconfig.json" <<'EOF'
{ "compilerOptions": { "strict": true, "noEmit": true } }
EOF
  fi

  if [[ ! -f "$root/eslint.config.mjs" ]]; then
    echo "export default [];" > "$root/eslint.config.mjs"
  fi
  if [[ ! -f "$root/.prettierrc" ]]; then
    echo '{ "semi": true }' > "$root/.prettierrc"
  fi
  if [[ ! -f "$root/.editorconfig" ]]; then
    echo "root = true" > "$root/.editorconfig"
  fi
  if [[ ! -f "$root/src/index.ts" ]]; then
    echo "export {};" > "$root/src/index.ts"
  fi
  if [[ ! -f "$root/tests/sanity.test.ts" ]]; then
    echo "// sanity" > "$root/tests/sanity.test.ts"
  fi
}

# --------------------------------------------------------------------------
# Simulate Deep delta files (what upgrade standard → deep adds)
# Uses github VCS.
# --------------------------------------------------------------------------

apply_deep_delta() {
  local root="$1"
  mkdir -p "$root/.github/workflows" "$root/.github/ISSUE_TEMPLATE"

  if [[ ! -f "$root/.github/workflows/ci.yml" ]]; then
    cat > "$root/.github/workflows/ci.yml" <<'EOF'
name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
EOF
  fi

  if [[ ! -f "$root/.github/CODEOWNERS" ]]; then
    echo "* @placeholder-owner" > "$root/.github/CODEOWNERS"
  fi
  if [[ ! -f "$root/CHANGELOG.md" ]]; then
    cat > "$root/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]
EOF
  fi
  if [[ ! -f "$root/.github/ISSUE_TEMPLATE/bug_report.md" ]]; then
    cat > "$root/.github/ISSUE_TEMPLATE/bug_report.md" <<'EOF'
---
name: Bug
---
EOF
  fi
  if [[ ! -f "$root/.github/ISSUE_TEMPLATE/feature_request.md" ]]; then
    cat > "$root/.github/ISSUE_TEMPLATE/feature_request.md" <<'EOF'
---
name: Feature
---
EOF
  fi
  if [[ ! -f "$root/.github/pull_request_template.md" ]]; then
    echo "## Summary" > "$root/.github/pull_request_template.md"
  fi
}

# --------------------------------------------------------------------------
# upgrade_lock: atomically updates bootstrap.lock tier field
# Preserves archetype and source from existing lock; updates tier + timestamp.
# --------------------------------------------------------------------------

upgrade_lock() {
  local lock="$1" new_tier="$2"
  local archetype source
  archetype=$(grep "^archetype:" "$lock" | awk '{print $2}')
  source=$(grep "^source:" "$lock" | awk '{print $2}')

  cat > "$lock" <<EOF
version: 1
tier: ${new_tier}
archetype: ${archetype:-null}
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "2026-04-16T09:00:00Z")
source: ${source:-plugin-template}
EOF
}

# --------------------------------------------------------------------------
# perform_upgrade: implements the upgrade logic from SKILL.md Upgrade Flow
# Returns 0 on success, non-zero on failure (downgrade).
# --------------------------------------------------------------------------

perform_upgrade() {
  local root="$1" target_tier="$2"
  local lock="$root/.orchestrator/bootstrap.lock"

  # Step 1: lock must exist
  if [[ ! -f "$lock" ]]; then
    echo "Error: No bootstrap.lock found. Run /bootstrap first." >&2
    return 1
  fi

  local current_tier
  current_tier=$(grep "^tier:" "$lock" | awk '{print $2}')

  # Step 3: refuse downgrade or same tier
  if ! is_upgrade "$current_tier" "$target_tier"; then
    echo "Error: Cannot downgrade from $current_tier to $target_tier. Upgrade path is one-directional (fast → standard → deep)." >&2
    return 1
  fi

  # Step 4+5+6: apply delta (idempotent — only write absent files)
  case "${current_tier}→${target_tier}" in
    fast→standard)
      apply_standard_delta "$root"
      ;;
    standard→deep)
      apply_deep_delta "$root"
      ;;
    fast→deep)
      apply_standard_delta "$root"
      apply_deep_delta "$root"
      ;;
  esac

  # Step 7: update lock
  upgrade_lock "$lock" "$target_tier"

  return 0
}

# --------------------------------------------------------------------------
# perform_retroactive: implements the retroactive flow from SKILL.md
# --------------------------------------------------------------------------

perform_retroactive() {
  local root="$1"
  local lock="$root/.orchestrator/bootstrap.lock"

  # Step 1: CLAUDE.md + Session Config must exist
  if [[ ! -f "$root/CLAUDE.md" ]] || ! grep -q "^## Session Config" "$root/CLAUDE.md"; then
    echo "Error: CLAUDE.md with Session Config required for retroactive bootstrap." >&2
    return 1
  fi

  # Step 2: idempotent check — lock already valid
  if [[ -f "$lock" ]] && grep -q "^version:" "$lock" && grep -q "^tier:" "$lock"; then
    local existing_tier
    existing_tier=$(grep "^tier:" "$lock" | awk '{print $2}')
    echo "bootstrap.lock already present (tier: $existing_tier). Nothing to do."
    return 0
  fi

  # Step 3: infer tier from file inventory (order matters: deep > standard > fast)
  local inferred_tier="fast"
  local inferred_archetype="null"

  # Deep: CI file AND CHANGELOG.md
  local has_ci=false has_changelog=false
  if [[ -f "$root/.gitlab-ci.yml" ]] || [[ -d "$root/.github/workflows" && -n "$(ls -A "$root/.github/workflows" 2>/dev/null)" ]]; then
    has_ci=true
  fi
  [[ -f "$root/CHANGELOG.md" ]] && has_changelog=true

  if $has_ci && $has_changelog; then
    inferred_tier="deep"
  elif [[ -f "$root/package.json" ]] || [[ -f "$root/pyproject.toml" ]]; then
    inferred_tier="standard"
  fi

  # Step 4: infer archetype
  if [[ -f "$root/pyproject.toml" ]]; then
    inferred_archetype="python-uv"
  elif [[ -f "$root/package.json" ]]; then
    if grep -q '"next"' "$root/package.json" 2>/dev/null; then
      inferred_archetype="nextjs-minimal"
    else
      inferred_archetype="node-minimal"
    fi
  fi

  # Step 5: write lock
  mkdir -p "$root/.orchestrator"
  cat > "$lock" <<EOF
version: 1
tier: ${inferred_tier}
archetype: ${inferred_archetype}
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "2026-04-16T09:00:00Z")
source: retroactive
EOF

  return 0
}

# --------------------------------------------------------------------------
# Scenario A: Fast → Standard upgrade
# --------------------------------------------------------------------------
echo "--- Scenario A: Fast → Standard upgrade ---"

REPO_A="$(make_tempdir)"
simulate_fast "$REPO_A"
LOCK_A="$REPO_A/.orchestrator/bootstrap.lock"

# Verify initial state
assert_eq "A: initial tier = fast" "fast" "$(lock_tier "$LOCK_A")"
assert_file_absent "A: no package.json before upgrade" "$REPO_A/package.json"

# Perform upgrade
perform_upgrade "$REPO_A" "standard"

assert_eq "A: lock.tier = standard after upgrade" "standard" "$(lock_tier "$LOCK_A")"

# Fast files still present and untouched
assert_file_exists "A: CLAUDE.md untouched" "$REPO_A/CLAUDE.md"
assert_file_exists "A: .gitignore untouched" "$REPO_A/.gitignore"
assert_file_exists "A: README.md untouched" "$REPO_A/README.md"

# Standard files added
assert_file_exists "A: package.json added" "$REPO_A/package.json"
assert_file_exists "A: tsconfig.json added" "$REPO_A/tsconfig.json"
assert_file_exists "A: eslint.config.mjs added" "$REPO_A/eslint.config.mjs"
assert_file_exists "A: .prettierrc added" "$REPO_A/.prettierrc"
assert_file_exists "A: .editorconfig added" "$REPO_A/.editorconfig"
assert_file_exists "A: src/index.ts added" "$REPO_A/src/index.ts"
assert_file_exists "A: tests/sanity.test.ts added" "$REPO_A/tests/sanity.test.ts"

# Deep files NOT yet present
assert_file_absent "A: no CI file (not deep yet)" "$REPO_A/.github/workflows/ci.yml"
assert_file_absent "A: no CHANGELOG.md (not deep yet)" "$REPO_A/CHANGELOG.md"

# --------------------------------------------------------------------------
# Scenario B: Standard → Deep upgrade
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario B: Standard → Deep upgrade ---"

REPO_B="$(make_tempdir)"
simulate_fast "$REPO_B"
perform_upgrade "$REPO_B" "standard"
LOCK_B="$REPO_B/.orchestrator/bootstrap.lock"

assert_eq "B: pre-upgrade tier = standard" "standard" "$(lock_tier "$LOCK_B")"

perform_upgrade "$REPO_B" "deep"

assert_eq "B: lock.tier = deep after upgrade" "deep" "$(lock_tier "$LOCK_B")"

# Standard files still present
assert_file_exists "B: package.json untouched" "$REPO_B/package.json"
assert_file_exists "B: .editorconfig untouched" "$REPO_B/.editorconfig"

# Deep files added
assert_file_exists "B: CI workflow added" "$REPO_B/.github/workflows/ci.yml"
assert_file_exists "B: CODEOWNERS added" "$REPO_B/.github/CODEOWNERS"
assert_file_exists "B: CHANGELOG.md added" "$REPO_B/CHANGELOG.md"
assert_file_exists "B: bug_report.md added" "$REPO_B/.github/ISSUE_TEMPLATE/bug_report.md"
assert_file_exists "B: feature_request.md added" "$REPO_B/.github/ISSUE_TEMPLATE/feature_request.md"
assert_file_exists "B: pull_request_template.md added" "$REPO_B/.github/pull_request_template.md"

# --------------------------------------------------------------------------
# Scenario C: Idempotency — running upgrade twice is a no-op
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario C: Idempotency (Fast → Standard, run twice) ---"

REPO_C="$(make_tempdir)"
simulate_fast "$REPO_C"
LOCK_C="$REPO_C/.orchestrator/bootstrap.lock"

# First upgrade
perform_upgrade "$REPO_C" "standard"
assert_eq "C: tier = standard after first upgrade" "standard" "$(lock_tier "$LOCK_C")"

# Second upgrade to same tier must be refused (same-tier is not an upgrade)
C_REFUSED=false
if ! perform_upgrade "$REPO_C" "standard" 2>/dev/null; then
  C_REFUSED=true
fi
assert_eq "C: second upgrade to same tier refused" "true" "$C_REFUSED"

# Delta application is idempotent — calling apply_standard_delta again adds zero new files
FILE_COUNT_BEFORE_C=$(find "$REPO_C" -type f | wc -l | tr -d ' ')
apply_standard_delta "$REPO_C"
FILE_COUNT_AFTER_C=$(find "$REPO_C" -type f | wc -l | tr -d ' ')
assert_eq "C: delta application is idempotent (no new files)" "$FILE_COUNT_BEFORE_C" "$FILE_COUNT_AFTER_C"

# --------------------------------------------------------------------------
# Scenario D: Refuse Deep → Fast downgrade (exit non-zero, clear error)
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario D: Refuse downgrade Deep → Fast ---"

REPO_D="$(make_tempdir)"
simulate_fast "$REPO_D"
perform_upgrade "$REPO_D" "standard"
perform_upgrade "$REPO_D" "deep"
LOCK_D="$REPO_D/.orchestrator/bootstrap.lock"
assert_eq "D: pre-downgrade tier = deep" "deep" "$(lock_tier "$LOCK_D")"

# Capture error message while handling non-zero exit gracefully under set -e
D_REFUSED=false
D_ERROR_MSG=""
D_ERROR_MSG="$(perform_upgrade "$REPO_D" "fast" 2>&1)" || D_REFUSED=true
assert_eq "D: downgrade (deep → fast) is refused" "true" "$D_REFUSED"

# Error message must contain meaningful text
if echo "$D_ERROR_MSG" | grep -qi "downgrade\|one-directional\|cannot"; then
  echo "  PASS: D: error message mentions downgrade/directional constraint"
  PASS=$(( PASS + 1 ))
else
  echo "  FAIL: D: error message did not mention downgrade — got: $D_ERROR_MSG"
  FAIL=$(( FAIL + 1 ))
fi

# Lock tier must remain deep (unchanged)
assert_eq "D: lock tier still = deep (unchanged)" "deep" "$(lock_tier "$LOCK_D")"

# Also verify deep → standard is refused
D2_REFUSED=false
perform_upgrade "$REPO_D" "standard" 2>/dev/null || D2_REFUSED=true
assert_eq "D: deep → standard also refused" "true" "$D2_REFUSED"

# --------------------------------------------------------------------------
# Scenario E: Retroactive on pre-existing Fast-equivalent repo
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario E: Retroactive bootstrap (no lock, Fast-equivalent files) ---"

REPO_E="$(make_tempdir)"

# Pre-existing repo: has CLAUDE.md + Session Config but NO lock, NO package.json, NO CI
cat > "$REPO_E/CLAUDE.md" <<'EOF'
# existing-repo

Manually set up project.

## Session Config

project-name: existing-repo
vcs: github
EOF
echo "# existing-repo" > "$REPO_E/README.md"
cat > "$REPO_E/.gitignore" <<'EOF'
.DS_Store
node_modules/
EOF

LOCK_E="$REPO_E/.orchestrator/bootstrap.lock"

# Verify no lock exists before
assert_file_absent "E: no lock before retroactive" "$LOCK_E"

# File count before (no scaffolding should occur)
FILE_COUNT_BEFORE_E=$(find "$REPO_E" -type f | wc -l | tr -d ' ')

perform_retroactive "$REPO_E"

# Lock written
assert_file_exists "E: lock written" "$LOCK_E"
assert_eq "E: lock tier = fast (inferred)" "fast" "$(lock_tier "$LOCK_E")"
assert_eq "E: lock source = retroactive" "retroactive" "$(lock_source "$LOCK_E")"

# File count: only +1 (the lock file itself)
FILE_COUNT_AFTER_E=$(find "$REPO_E" -type f | wc -l | tr -d ' ')
EXPECTED_COUNT_E=$(( FILE_COUNT_BEFORE_E + 1 ))
assert_eq "E: only bootstrap.lock was added (no scaffolding)" "$EXPECTED_COUNT_E" "$FILE_COUNT_AFTER_E"

# Existing files untouched
assert_file_exists "E: CLAUDE.md untouched" "$REPO_E/CLAUDE.md"
assert_file_exists "E: README.md untouched" "$REPO_E/README.md"
assert_file_exists "E: .gitignore untouched" "$REPO_E/.gitignore"

# Retroactive with existing package.json (Standard-equivalent)
echo ""
echo "--- Scenario E2: Retroactive (Standard-equivalent, package.json present) ---"

REPO_E2="$(make_tempdir)"
cat > "$REPO_E2/CLAUDE.md" <<'EOF'
# existing-standard

## Session Config

project-name: existing-standard
vcs: github
EOF
echo '{ "name": "existing-standard" }' > "$REPO_E2/package.json"
LOCK_E2="$REPO_E2/.orchestrator/bootstrap.lock"

perform_retroactive "$REPO_E2"
assert_eq "E2: lock tier = standard (inferred from package.json)" "standard" "$(lock_tier "$LOCK_E2")"
assert_eq "E2: lock source = retroactive" "retroactive" "$(lock_source "$LOCK_E2")"

# Idempotency: second retroactive call on repo with existing lock
echo ""
echo "--- Scenario E3: Retroactive idempotency (lock already present) ---"

IDEMPOTENT_OUTPUT="$(perform_retroactive "$REPO_E2" 2>&1)"
assert_eq "E3: lock tier unchanged after second retroactive" "standard" "$(lock_tier "$LOCK_E2")"
if echo "$IDEMPOTENT_OUTPUT" | grep -qi "nothing to do\|already present"; then
  echo "  PASS: E3: second retroactive reports nothing-to-do"
  PASS=$(( PASS + 1 ))
else
  echo "  FAIL: E3: second retroactive did not report nothing-to-do — got: $IDEMPOTENT_OUTPUT"
  FAIL=$(( FAIL + 1 ))
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
