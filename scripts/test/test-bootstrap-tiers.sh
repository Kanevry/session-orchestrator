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
# Tempdir setup + cleanup
# --------------------------------------------------------------------------

TMPDIRS=()

make_tempdir() {
  local d
  d="$(mktemp -d)"
  TMPDIRS+=("$d")
  echo "$d"
}

cleanup() {
  for d in "${TMPDIRS[@]+"${TMPDIRS[@]}"}"; do
    rm -rf "$d"
  done
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# Helper: simulate Fast tier scaffold
# Writes exactly the files that fast-template.md produces.
# --------------------------------------------------------------------------

simulate_fast() {
  local root="$1"
  mkdir -p "$root/.orchestrator"

  # CLAUDE.md with Session Config (required by gate)
  cat > "$root/CLAUDE.md" <<'EOF'
# test-repo

Test project.

## Session Config

project-name: test-repo
vcs: github
EOF

  # .gitignore
  cat > "$root/.gitignore" <<'EOF'
.DS_Store
.env
node_modules/
EOF

  # README.md
  echo "# test-repo" > "$root/README.md"

  # bootstrap.lock
  cat > "$root/.orchestrator/bootstrap.lock" <<EOF
version: 1
tier: fast
archetype: null
timestamp: 2026-04-16T09:00:00Z
source: plugin-template
EOF
}

# --------------------------------------------------------------------------
# Helper: simulate Standard tier scaffold (superset of Fast)
# Uses node-minimal archetype.
# --------------------------------------------------------------------------

simulate_standard() {
  local root="$1"
  simulate_fast "$root"

  # Overwrite lock with standard tier
  cat > "$root/.orchestrator/bootstrap.lock" <<EOF
version: 1
tier: standard
archetype: node-minimal
timestamp: 2026-04-16T09:00:00Z
source: plugin-template
EOF

  # Standard-specific files
  cat > "$root/package.json" <<'EOF'
{
  "name": "test-repo",
  "version": "0.1.0",
  "type": "module"
}
EOF

  cat > "$root/tsconfig.json" <<'EOF'
{
  "compilerOptions": { "strict": true, "noEmit": true }
}
EOF

  cat > "$root/eslint.config.mjs" <<'EOF'
export default [];
EOF

  cat > "$root/.prettierrc" <<'EOF'
{ "semi": true }
EOF

  cat > "$root/.editorconfig" <<'EOF'
root = true
EOF

  mkdir -p "$root/src" "$root/tests"
  echo "export {};" > "$root/src/index.ts"
  echo "// sanity test" > "$root/tests/sanity.test.ts"
}

# --------------------------------------------------------------------------
# Helper: simulate Deep tier scaffold (superset of Standard)
# Uses node-minimal archetype + github VCS.
# --------------------------------------------------------------------------

simulate_deep() {
  local root="$1"
  simulate_standard "$root"

  # Overwrite lock with deep tier
  cat > "$root/.orchestrator/bootstrap.lock" <<EOF
version: 1
tier: deep
archetype: node-minimal
timestamp: 2026-04-16T09:00:00Z
source: plugin-template
EOF

  # Deep-specific files (github VCS)
  mkdir -p "$root/.github/workflows" "$root/.github/ISSUE_TEMPLATE"
  cat > "$root/.github/workflows/ci.yml" <<'EOF'
name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
EOF

  cat > "$root/.github/CODEOWNERS" <<'EOF'
* @placeholder-owner
EOF

  cat > "$root/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]
EOF

  cat > "$root/.github/ISSUE_TEMPLATE/bug_report.md" <<'EOF'
---
name: Bug Report
---
EOF

  cat > "$root/.github/ISSUE_TEMPLATE/feature_request.md" <<'EOF'
---
name: Feature Request
---
EOF

  cat > "$root/.github/pull_request_template.md" <<'EOF'
## Summary
EOF
}

# --------------------------------------------------------------------------
# Scenario 1: Fast tier
# --------------------------------------------------------------------------
echo "--- Scenario 1: Fast tier ---"

REPO_1="$(make_tempdir)"
simulate_fast "$REPO_1"

LOCK_1="$REPO_1/.orchestrator/bootstrap.lock"

assert_file_exists "1: CLAUDE.md exists"           "$REPO_1/CLAUDE.md"
assert_file_exists "1: .gitignore exists"          "$REPO_1/.gitignore"
assert_file_exists "1: README.md exists"           "$REPO_1/README.md"
assert_file_exists "1: bootstrap.lock exists"      "$LOCK_1"
assert_eq          "1: lock tier = fast"           "fast" "$(lock_tier "$LOCK_1")"
assert_eq          "1: lock source = plugin-template" "plugin-template" "$(lock_source "$LOCK_1")"

# Fast MUST NOT have Standard-only files
assert_file_absent "1: no package.json (Fast)"    "$REPO_1/package.json"
assert_file_absent "1: no tsconfig.json (Fast)"   "$REPO_1/tsconfig.json"
assert_file_absent "1: no .editorconfig (Fast)"   "$REPO_1/.editorconfig"

# Fast MUST NOT have Deep-only files
assert_file_absent "1: no CHANGELOG.md (Fast)"    "$REPO_1/CHANGELOG.md"

# --------------------------------------------------------------------------
# Scenario 2: Standard tier (node-minimal archetype)
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario 2: Standard tier (node-minimal) ---"

REPO_2="$(make_tempdir)"
simulate_standard "$REPO_2"

LOCK_2="$REPO_2/.orchestrator/bootstrap.lock"

# Inherits Fast files
assert_file_exists "2: CLAUDE.md exists"             "$REPO_2/CLAUDE.md"
assert_file_exists "2: .gitignore exists"            "$REPO_2/.gitignore"
assert_file_exists "2: README.md exists"             "$REPO_2/README.md"
assert_file_exists "2: bootstrap.lock exists"        "$LOCK_2"

# Standard-specific files
assert_file_exists "2: package.json exists"          "$REPO_2/package.json"
assert_file_exists "2: tsconfig.json exists"         "$REPO_2/tsconfig.json"
assert_file_exists "2: eslint.config.mjs exists"     "$REPO_2/eslint.config.mjs"
assert_file_exists "2: .prettierrc exists"           "$REPO_2/.prettierrc"
assert_file_exists "2: .editorconfig exists"         "$REPO_2/.editorconfig"
assert_file_exists "2: src/index.ts exists"          "$REPO_2/src/index.ts"
assert_file_exists "2: tests/sanity.test.ts exists"  "$REPO_2/tests/sanity.test.ts"

assert_eq          "2: lock tier = standard"         "standard" "$(lock_tier "$LOCK_2")"

# Standard MUST NOT have Deep-only files
assert_file_absent "2: no CHANGELOG.md (Standard)"  "$REPO_2/CHANGELOG.md"
assert_file_absent "2: no CI file (Standard)"       "$REPO_2/.github/workflows/ci.yml"

# --------------------------------------------------------------------------
# Scenario 3: Deep tier (node-minimal archetype, github VCS)
# --------------------------------------------------------------------------
echo ""
echo "--- Scenario 3: Deep tier (node-minimal, github) ---"

REPO_3="$(make_tempdir)"
simulate_deep "$REPO_3"

LOCK_3="$REPO_3/.orchestrator/bootstrap.lock"

# Inherits Fast + Standard files
assert_file_exists "3: CLAUDE.md exists"                     "$REPO_3/CLAUDE.md"
assert_file_exists "3: package.json exists"                  "$REPO_3/package.json"
assert_file_exists "3: tsconfig.json exists"                 "$REPO_3/tsconfig.json"
assert_file_exists "3: .editorconfig exists"                 "$REPO_3/.editorconfig"
assert_file_exists "3: tests/sanity.test.ts exists"          "$REPO_3/tests/sanity.test.ts"

# Deep-specific files
assert_file_exists "3: .github/workflows/ci.yml exists"      "$REPO_3/.github/workflows/ci.yml"
assert_file_exists "3: .github/CODEOWNERS exists"            "$REPO_3/.github/CODEOWNERS"
assert_file_exists "3: CHANGELOG.md exists"                  "$REPO_3/CHANGELOG.md"
assert_file_exists "3: bug_report.md exists"                 "$REPO_3/.github/ISSUE_TEMPLATE/bug_report.md"
assert_file_exists "3: feature_request.md exists"            "$REPO_3/.github/ISSUE_TEMPLATE/feature_request.md"
assert_file_exists "3: pull_request_template.md exists"      "$REPO_3/.github/pull_request_template.md"

assert_eq          "3: lock tier = deep"                     "deep" "$(lock_tier "$LOCK_3")"

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $((FAIL > 0 ? 1 : 0))
