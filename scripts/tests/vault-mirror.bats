#!/usr/bin/env bats
# vault-mirror.bats — Tests for scripts/vault-mirror.mjs (Issue #14).
#
# Prerequisites: brew install bats-core, node, jq
# Run: bats scripts/tests/vault-mirror.bats  (from session-orchestrator repo root)
#
# Slug behaviour note: subjectToSlug() strips non-[a-z0-9-] chars, so spaces
# are removed (not converted to hyphens). Tests use hyphenated subjects to
# produce predictable slugs.

bats_require_minimum_version 1.5.0

SCRIPT_DIR="${BATS_TEST_DIRNAME}/.."
MIRROR="${SCRIPT_DIR}/vault-mirror.mjs"

# ── Helpers ────────────────────────────────────────────────────────────────────

get_field() {
  # get_field <json> <jq-filter>
  printf '%s' "$1" | jq -r "$2"
}

# Single valid learning JSONL line.
# $1 — output file path
# $2 — optional: id (default: a1b2c3d4-0001-4000-8000-000000000001)
# $3 — optional: subject (default: "cross-repo-deep-session")
make_learning_jsonl() {
  local id="${2:-a1b2c3d4-0001-4000-8000-000000000001}"
  local subject="${3:-cross-repo-deep-session}"
  cat > "$1" <<EOF
{"id":"${id}","type":"architectural","subject":"${subject}","insight":"Prefer explicit contracts over implicit coupling","evidence":"Three separate modules broke when shared util changed without notice","confidence":0.9,"source_session":"session-2026-04-13","created_at":"2026-04-13T10:00:00Z","expires_at":"2027-04-13T10:00:00Z"}
EOF
}

# Single valid session JSONL line.
# $1 — output file path
make_session_jsonl() {
  cat > "$1" <<'EOF'
{"session_id":"session-2026-04-13","session_type":"feature","platform":"claude-code","started_at":"2026-04-13T08:00:00Z","completed_at":"2026-04-13T10:00:00Z","duration_seconds":7200,"total_waves":3,"total_agents":6,"total_files_changed":12,"agent_summary":{"complete":5,"partial":1,"failed":0,"spiral":0},"waves":[{"wave":1,"role":"Planning","agent_count":1,"files_changed":2,"quality":"ok"},{"wave":2,"role":"Implementation","agent_count":3,"files_changed":8,"quality":"ok"},{"wave":3,"role":"QA","agent_count":2,"files_changed":2,"quality":"ok"}],"effectiveness":{"planned_issues":3,"completed":3,"carryover":0,"emergent":1,"completion_rate":1.0}}
EOF
}

# ── Setup / Teardown ───────────────────────────────────────────────────────────

setup() {
  TMPVAULT="$(mktemp -d "${BATS_TMPDIR}/vault-mirror-XXXXXX")"
  TMPJSONL="${BATS_TMPDIR}/vault-mirror-jsonl-$$.jsonl"
  export TMPVAULT TMPJSONL
}

teardown() {
  if [[ -n "${TMPVAULT:-}" && -d "$TMPVAULT" ]]; then
    rm -rf "$TMPVAULT"
  fi
  if [[ -n "${TMPJSONL:-}" && -f "$TMPJSONL" ]]; then
    rm -f "$TMPJSONL"
  fi
}

# ── 1. Happy path — 1 learning → 1 file ───────────────────────────────────────

@test "learning happy path: exit 0 and 'created' action on stdout" {
  make_learning_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  local action
  action=$(get_field "$output" '.action')
  [ "$action" = "created" ]
}

@test "learning happy path: target file exists at 40-learnings/cross-repo-deep-session.md" {
  make_learning_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  # Subject "cross-repo-deep-session" → slug "cross-repo-deep-session"
  [ -f "$TMPVAULT/40-learnings/cross-repo-deep-session.md" ]
}

@test "learning happy path: generated file contains id frontmatter field" {
  make_learning_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  grep -qF "id: cross-repo-deep-session" "$TMPVAULT/40-learnings/cross-repo-deep-session.md"
}

@test "learning happy path: generated file has type: learning" {
  make_learning_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  grep -qF "type: learning" "$TMPVAULT/40-learnings/cross-repo-deep-session.md"
}

@test "learning happy path: generated file has _generator marker" {
  make_learning_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  grep -qF "_generator: session-orchestrator-vault-mirror@1" "$TMPVAULT/40-learnings/cross-repo-deep-session.md"
}

@test "learning happy path: stdout kind field is 'learning'" {
  make_learning_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  local k
  k=$(get_field "$output" '.kind')
  [ "$k" = "learning" ]
}

# ── 2. Happy path — 1 session → 1 file ───────────────────────────────────────

@test "session happy path: exit 0 and 'created' action on stdout" {
  make_session_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind session

  [ "$status" -eq 0 ]
  local action
  action=$(get_field "$output" '.action')
  [ "$action" = "created" ]
}

@test "session happy path: target file exists at 50-sessions/session-2026-04-13.md" {
  make_session_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind session

  [ "$status" -eq 0 ]
  [ -f "$TMPVAULT/50-sessions/session-2026-04-13.md" ]
}

@test "session happy path: generated file has type: session" {
  make_session_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind session >/dev/null

  grep -qF "type: session" "$TMPVAULT/50-sessions/session-2026-04-13.md"
}

@test "session happy path: generated file has _generator marker" {
  make_session_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind session >/dev/null

  grep -qF "_generator: session-orchestrator-vault-mirror@1" "$TMPVAULT/50-sessions/session-2026-04-13.md"
}

@test "session happy path: title is YAML-quoted (starts with double-quote)" {
  make_session_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind session >/dev/null

  # Title always contains em-dash, so it must be wrapped in double quotes.
  grep -qE '^title: "' "$TMPVAULT/50-sessions/session-2026-04-13.md"
}

# ── 3. Idempotent re-run — no diff on second invocation ───────────────────────

@test "idempotent re-run: second invocation exits 0" {
  make_learning_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
}

@test "idempotent re-run: second invocation outputs 'skipped-noop'" {
  make_learning_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  local action
  action=$(get_field "$output" '.action')
  [ "$action" = "skipped-noop" ]
}

@test "idempotent re-run: file content is byte-identical after second run" {
  make_learning_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null
  local file="$TMPVAULT/40-learnings/cross-repo-deep-session.md"
  local hash1
  hash1=$(shasum "$file" | awk '{print $1}')

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null
  local hash2
  hash2=$(shasum "$file" | awk '{print $1}')

  [ "$hash1" = "$hash2" ]
}

# ── 4. Hand-written protection ────────────────────────────────────────────────
# A file at the target slug path without a _generator field must never be
# overwritten, regardless of its content.

@test "hand-written protection: exit 0 when pre-existing file has no _generator" {
  make_learning_jsonl "$TMPJSONL"

  mkdir -p "$TMPVAULT/40-learnings"
  cat > "$TMPVAULT/40-learnings/cross-repo-deep-session.md" <<'EOF'
---
id: cross-repo-deep-session
type: learning
title: Manual Entry
status: draft
created: 2026-01-01
updated: 2026-01-01
tags: [learning/manual]
---

HAND WRITTEN DO NOT TOUCH
EOF

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
}

@test "hand-written protection: stdout action is 'skipped-handwritten'" {
  make_learning_jsonl "$TMPJSONL"

  mkdir -p "$TMPVAULT/40-learnings"
  cat > "$TMPVAULT/40-learnings/cross-repo-deep-session.md" <<'EOF'
---
id: cross-repo-deep-session
type: learning
title: Manual Entry
status: draft
created: 2026-01-01
updated: 2026-01-01
tags: [learning/manual]
---

HAND WRITTEN DO NOT TOUCH
EOF

  # Use --separate-stderr: the utility logs the SKIP message to stderr and
  # emits the JSON action to stdout. Without separation jq cannot parse the
  # combined output.
  run --separate-stderr node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  local action
  action=$(get_field "$output" '.action')
  [ "$action" = "skipped-handwritten" ]
}

@test "hand-written protection: file body still contains sentinel text after run" {
  make_learning_jsonl "$TMPJSONL"

  mkdir -p "$TMPVAULT/40-learnings"
  cat > "$TMPVAULT/40-learnings/cross-repo-deep-session.md" <<'EOF'
---
id: cross-repo-deep-session
type: learning
title: Manual Entry
status: draft
created: 2026-01-01
updated: 2026-01-01
tags: [learning/manual]
---

HAND WRITTEN DO NOT TOUCH
EOF

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  grep -qF "HAND WRITTEN DO NOT TOUCH" "$TMPVAULT/40-learnings/cross-repo-deep-session.md"
}

@test "hand-written protection: original content preserved byte-for-byte" {
  make_learning_jsonl "$TMPJSONL"

  mkdir -p "$TMPVAULT/40-learnings"
  local file="$TMPVAULT/40-learnings/cross-repo-deep-session.md"
  cat > "$file" <<'EOF'
---
id: cross-repo-deep-session
type: learning
title: Manual Entry
status: draft
created: 2026-01-01
updated: 2026-01-01
tags: [learning/manual]
---

HAND WRITTEN DO NOT TOUCH
EOF
  local hash_before
  hash_before=$(shasum "$file" | awk '{print $1}')

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  local hash_after
  hash_after=$(shasum "$file" | awk '{print $1}')
  [ "$hash_before" = "$hash_after" ]
}

# ── 5. Slug collision disambiguation ──────────────────────────────────────────
# A file exists at the target slug path WITH a _generator marker but a DIFFERENT
# id in its frontmatter. The utility must NOT overwrite, and must create a new
# file with a disambiguated slug (slug + "-" + first-8-of-uuid).
#
# Implementation detail: the utility compares fm['id'] against the computed slug
# (not against the JSONL entry id). So the pre-existing file must have fm['id']
# set to something OTHER than the computed slug to trigger the collision path.

@test "collision disambiguation: both files exist after run" {
  make_learning_jsonl "$TMPJSONL" "a1b2c3d4-0001-4000-8000-000000000001" "cross-repo-deep-session"

  mkdir -p "$TMPVAULT/40-learnings"
  cat > "$TMPVAULT/40-learnings/cross-repo-deep-session.md" <<'EOF'
---
id: unrelated-learning-id
type: learning
title: Existing note with different id
status: verified
created: 2026-01-01
updated: 2026-01-01
tags: [learning/architectural]
_generator: session-orchestrator-vault-mirror@1
---

This file belongs to a different entry.
EOF

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  # Both files must exist
  [ -f "$TMPVAULT/40-learnings/cross-repo-deep-session.md" ]
  [ -f "$TMPVAULT/40-learnings/cross-repo-deep-session-a1b2c3d4.md" ]
}

@test "collision disambiguation: original file is unchanged after run" {
  make_learning_jsonl "$TMPJSONL" "a1b2c3d4-0001-4000-8000-000000000001" "cross-repo-deep-session"

  mkdir -p "$TMPVAULT/40-learnings"
  local orig="$TMPVAULT/40-learnings/cross-repo-deep-session.md"
  cat > "$orig" <<'EOF'
---
id: unrelated-learning-id
type: learning
title: Existing note with different id
status: verified
created: 2026-01-01
updated: 2026-01-01
tags: [learning/architectural]
_generator: session-orchestrator-vault-mirror@1
---

This file belongs to a different entry.
EOF
  local hash_before
  hash_before=$(shasum "$orig" | awk '{print $1}')

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  local hash_after
  hash_after=$(shasum "$orig" | awk '{print $1}')
  [ "$hash_before" = "$hash_after" ]
}

@test "collision disambiguation: stdout action is 'skipped-collision-resolved'" {
  make_learning_jsonl "$TMPJSONL" "a1b2c3d4-0001-4000-8000-000000000001" "cross-repo-deep-session"

  mkdir -p "$TMPVAULT/40-learnings"
  cat > "$TMPVAULT/40-learnings/cross-repo-deep-session.md" <<'EOF'
---
id: unrelated-learning-id
type: learning
title: Existing note with different id
status: verified
created: 2026-01-01
updated: 2026-01-01
tags: [learning/architectural]
_generator: session-orchestrator-vault-mirror@1
---

This file belongs to a different entry.
EOF

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  local action
  action=$(get_field "$output" '.action')
  [ "$action" = "skipped-collision-resolved" ]
}

@test "collision disambiguation: disambiguated slug uses first-8-chars of uuid" {
  # id "a1b2c3d4-0001-4000-8000-000000000001"
  # uuidPrefix8: strip hyphens → "a1b2c3d400014000" → first 8 = "a1b2c3d4"
  # Expected file: cross-repo-deep-session-a1b2c3d4.md
  make_learning_jsonl "$TMPJSONL" "a1b2c3d4-0001-4000-8000-000000000001" "cross-repo-deep-session"

  mkdir -p "$TMPVAULT/40-learnings"
  cat > "$TMPVAULT/40-learnings/cross-repo-deep-session.md" <<'EOF'
---
id: unrelated-learning-id
type: learning
title: Existing note with different id
status: verified
created: 2026-01-01
updated: 2026-01-01
tags: [learning/architectural]
_generator: session-orchestrator-vault-mirror@1
---

This file belongs to a different entry.
EOF

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning >/dev/null

  [ -f "$TMPVAULT/40-learnings/cross-repo-deep-session-a1b2c3d4.md" ]
}

# ── 6. Malformed JSONL line → exit 1 ─────────────────────────────────────────
# The utility calls process.exit(1) on JSON parse failure.

@test "malformed JSONL: exit code is 1" {
  # One valid line then a truncated/broken JSON line.
  make_learning_jsonl "$TMPJSONL"
  printf '{"id":\n' >> "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 1 ]
}

@test "malformed JSONL: stderr contains error message" {
  make_learning_jsonl "$TMPJSONL"
  printf '{"id":\n' >> "$TMPJSONL"

  # bats `run` merges stdout+stderr into $output; capture stderr separately.
  local stderr_out
  stderr_out=$(node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning 2>&1 >/dev/null) || true

  [ -n "$stderr_out" ]
}

# ── 7. Dry-run mode — no files written ────────────────────────────────────────
# --dry-run is implemented: the utility checks the `dryRun` flag before every
# writeFileSync call, so files are never written in dry-run mode.

@test "dry-run: exit 0 with --dry-run flag" {
  make_learning_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning --dry-run

  [ "$status" -eq 0 ]
}

@test "dry-run: no .md files written under 40-learnings/" {
  make_learning_jsonl "$TMPJSONL"

  node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning --dry-run >/dev/null

  # 40-learnings/ directory may be created (mkdirSync is not guarded) but
  # no .md files should be written inside it.
  local count
  count=$(find "$TMPVAULT/40-learnings" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  [ "$count" = "0" ]
}

@test "dry-run: stdout still reports an action line" {
  make_learning_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning --dry-run

  [ "$status" -eq 0 ]
  # Output must be non-empty and parseable as JSON
  [ -n "$output" ]
  get_field "$output" '.action' >/dev/null
}

# ── Slug derivation edge cases ─────────────────────────────────────────────────

@test "slug: subject with slashes collapses to last segment" {
  # "libs/node/cross-repo" → last segment "cross-repo" → slug "cross-repo"
  make_learning_jsonl "$TMPJSONL" "a1b2c3d4-0001-4000-8000-000000000001" "libs/node/cross-repo"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  [ -f "$TMPVAULT/40-learnings/cross-repo.md" ]
}

@test "slug: invalid slug (all special chars) falls back to learning-<first8-uuid>" {
  # "!!!@@###" → empty after stripping → falls back to learning-<uuid-prefix>
  make_learning_jsonl "$TMPJSONL" "a1b2c3d4-0001-4000-8000-000000000001" "!!!@@###"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  # uuidPrefix8("a1b2c3d4-0001-4000-8000-000000000001")
  #   strip hyphens → "a1b2c3d400014000800000000000001"
  #   first 8      → "a1b2c3d4"
  [ -f "$TMPVAULT/40-learnings/learning-a1b2c3d4.md" ]
}

@test "slug: dots and underscores in subject are replaced with hyphens" {
  # "use.strict_mode" → "use-strict-mode"
  make_learning_jsonl "$TMPJSONL" "a1b2c3d4-0001-4000-8000-000000000001" "use.strict_mode"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  [ -f "$TMPVAULT/40-learnings/use-strict-mode.md" ]
}

@test "slug: spaces in subject are stripped (not converted to hyphens)" {
  # "hello world" → "helloworld" (spaces are not in [a-z0-9-], so they are removed)
  make_learning_jsonl "$TMPJSONL" "a1b2c3d4-0001-4000-8000-000000000001" "hello world"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 0 ]
  [ -f "$TMPVAULT/40-learnings/helloworld.md" ]
}

# ── CLI argument validation ────────────────────────────────────────────────────

@test "missing --vault-dir: exits 1" {
  make_learning_jsonl "$TMPJSONL"

  run node "$MIRROR" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 1 ]
}

@test "missing --source: exits 1" {
  run node "$MIRROR" --vault-dir "$TMPVAULT" --kind learning

  [ "$status" -eq 1 ]
}

@test "invalid --kind value: exits 1" {
  make_learning_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "$TMPJSONL" --kind unknown

  [ "$status" -eq 1 ]
}

@test "non-existent vault-dir: exits 2" {
  make_learning_jsonl "$TMPJSONL"

  run node "$MIRROR" --vault-dir "/nonexistent/path/$$" --source "$TMPJSONL" --kind learning

  [ "$status" -eq 2 ]
}

@test "non-existent source file: exits 2" {
  run node "$MIRROR" --vault-dir "$TMPVAULT" --source "/nonexistent/$$.jsonl" --kind learning

  [ "$status" -eq 2 ]
}
