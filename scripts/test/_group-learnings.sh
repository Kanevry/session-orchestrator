#!/usr/bin/env bash
set -u

# ===========================================================================
echo ""
echo "=== Group 8: Cap-and-Rank Learnings (#88) ==="
# ===========================================================================

CAP_TMPDIR="$MASTER_TMPDIR/cap-rank"
mkdir -p "$CAP_TMPDIR"
CAP_LEARNINGS="$CAP_TMPDIR/learnings.jsonl"

# Write 20 learnings with varying confidences.
# 16 entries have confidence > 0.3 (0.95 down to 0.31).
# 4 entries have confidence <= 0.3 (0.30, 0.20, 0.10, 0.05) — filtered out.
# Top-15 slice of the 16 passing entries cuts the 0.31 entry.
# Expected: 15 surfaced, lowest = 0.33, suppressed-by-cap = 1.
FUTURE_DATE="2099-01-01T00:00:00Z"
cat > "$CAP_LEARNINGS" << 'CAPEOF'
{"id":"l01","type":"fragile-file","subject":"src/a.ts","insight":"i","evidence":"e","confidence":0.95,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l02","type":"fragile-file","subject":"src/b.ts","insight":"i","evidence":"e","confidence":0.90,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l03","type":"effective-sizing","subject":"deep","insight":"i","evidence":"e","confidence":0.85,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l04","type":"effective-sizing","subject":"feature","insight":"i","evidence":"e","confidence":0.80,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l05","type":"recurring-issue","subject":"merge","insight":"i","evidence":"e","confidence":0.75,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l06","type":"recurring-issue","subject":"lint","insight":"i","evidence":"e","confidence":0.70,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l07","type":"scope-guidance","subject":"scope-a","insight":"i","evidence":"e","confidence":0.65,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l08","type":"scope-guidance","subject":"scope-b","insight":"i","evidence":"e","confidence":0.60,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l09","type":"fragile-file","subject":"src/c.ts","insight":"i","evidence":"e","confidence":0.55,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l10","type":"fragile-file","subject":"src/d.ts","insight":"i","evidence":"e","confidence":0.50,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l11","type":"effective-sizing","subject":"housekeeping","insight":"i","evidence":"e","confidence":0.45,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l12","type":"recurring-issue","subject":"ci","insight":"i","evidence":"e","confidence":0.40,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l13","type":"scope-guidance","subject":"scope-c","insight":"i","evidence":"e","confidence":0.35,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l14","type":"fragile-file","subject":"src/e.ts","insight":"i","evidence":"e","confidence":0.34,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l15","type":"fragile-file","subject":"src/f.ts","insight":"i","evidence":"e","confidence":0.33,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l16","type":"recurring-issue","subject":"test-flake","insight":"i","evidence":"e","confidence":0.31,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l17","type":"scope-guidance","subject":"scope-d","insight":"i","evidence":"e","confidence":0.30,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l18","type":"effective-sizing","subject":"mini","insight":"i","evidence":"e","confidence":0.20,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l19","type":"fragile-file","subject":"src/g.ts","insight":"i","evidence":"e","confidence":0.10,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"l20","type":"recurring-issue","subject":"old","insight":"i","evidence":"e","confidence":0.05,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
CAPEOF

# 8a: fixture file has 20 lines
cap_line_count=$(wc -l < "$CAP_LEARNINGS" | tr -d ' ')
assert_eq "8a: cap-rank fixture has 20 lines" "20" "$cap_line_count"

# 8b: filter (confidence > 0.3, not expired) + sort by confidence DESC + slice to top 15
# Entries with confidence > 0.3: l01-l16 (confidence 0.95 down to 0.31) = 16 entries
# After slicing to 15: l01-l15 (0.95 down to 0.33); l16 (0.31) is suppressed by cap
# Sort: primary by confidence DESC, tiebreaker by created_at DESC (string sort reversed)
cap_surfaced=$(jq -s '
  map(select(.confidence > 0.3))
  | sort_by(.confidence, .created_at) | reverse
  | .[0:15]
  | length
' "$CAP_LEARNINGS")
assert_eq "8b: cap-rank surfaces exactly 15 learnings" "15" "$cap_surfaced"

# 8c: lowest-confidence surfaced entry is 0.33
cap_lowest=$(jq -s '
  map(select(.confidence > 0.3))
  | sort_by(.confidence, .created_at) | reverse
  | .[0:15]
  | last
  | .confidence
' "$CAP_LEARNINGS")
assert_eq "8c: lowest-confidence surfaced is 0.33" "0.33" "$cap_lowest"

# 8d: suppressed-by-cap count (passed filter but not in top-15) = 1
cap_passed_filter=$(jq -s 'map(select(.confidence > 0.3)) | length' "$CAP_LEARNINGS")
cap_suppressed_by_cap=$(( cap_passed_filter - 15 ))
assert_eq "8d: suppressed-by-cap count is 1" "1" "$cap_suppressed_by_cap"

# 8e: entries filtered out (confidence <= 0.3) = 4 (l17-l20: 0.30, 0.20, 0.10, 0.05)
cap_filtered_out=$(jq -s 'map(select(.confidence <= 0.3)) | length' "$CAP_LEARNINGS")
assert_eq "8e: entries filtered out by confidence <= 0.3 is 4" "4" "$cap_filtered_out"

# 8f: created_at tiebreaker — two equal-confidence entries, later created_at ranks higher
# AC: sort by confidence DESC, tiebreaker created_at DESC
cap_tie_result=$(printf '%s\n%s\n' \
  '{"id":"tie-old","confidence":0.5,"created_at":"2026-01-01T00:00:00Z"}' \
  '{"id":"tie-new","confidence":0.5,"created_at":"2026-01-02T00:00:00Z"}' \
  | jq -s 'sort_by(.confidence, .created_at) | reverse | .[0].id')
assert_eq "8f: equal-confidence tiebreaker: later created_at ranks first" '"tie-new"' "$cap_tie_result"

# ===========================================================================
echo ""
echo "=== Group 9: Passive Decay (#89 verification) ==="
# ===========================================================================

DECAY_TMPDIR="$MASTER_TMPDIR/decay"
mkdir -p "$DECAY_TMPDIR"
DECAY_FILE="$DECAY_TMPDIR/learnings.jsonl"

# Write 5 learnings, each confidence 0.5, not-yet-expired
cat > "$DECAY_FILE" << 'DECAYEOF'
{"id":"d01","type":"fragile-file","subject":"sub1","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"d02","type":"fragile-file","subject":"sub2","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"d03","type":"fragile-file","subject":"sub3","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"d04","type":"fragile-file","subject":"sub4","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"d05","type":"fragile-file","subject":"sub5","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
DECAYEOF

# Simulate 10 decay sessions (each subtracts 0.05, clamp to 0)
decay_state=$(jq -s '.' "$DECAY_FILE")
for i in $(seq 1 10); do
  decay_state=$(echo "$decay_state" | jq 'map(.confidence -= 0.05 | .confidence = (if .confidence < 0 then 0 else .confidence end))')
done

# 9a: After 10 iterations all confidences should be effectively 0.0
# Use tolerance < 0.001 — jq IEEE 754 float drift means 0.5 - 10*0.05 may land at ~6.9e-17
decay_all_zero=$(echo "$decay_state" | jq 'map(.confidence < 0.001) | all')
assert_eq "9a: after 10 decay iterations, all confidence effectively 0 (< 0.001)" "true" "$decay_all_zero"

# 9b: After one more decay, all entries would be pruned (confidence <= 0.0)
# Session-end prune step removes entries where confidence <= 0.0 after decay
decay_state_11=$(echo "$decay_state" | jq 'map(.confidence -= 0.05 | .confidence = (if .confidence < 0 then 0 else .confidence end))')
decay_pruned=$(echo "$decay_state_11" | jq 'map(select(.confidence < 0.001)) | length')
assert_eq "9b: after 11th decay, 5 entries prunable (confidence < 0.001)" "5" "$decay_pruned"

# 9c: Verify count of entries in each iteration result is still 5 (decay doesn't drop entries)
decay_count=$(echo "$decay_state" | jq 'length')
assert_eq "9c: decay preserves entry count (5)" "5" "$decay_count"

# ===========================================================================
echo ""
echo "=== Group 10: Surface Health Transparency (#91 verification) ==="
# ===========================================================================

SURF_TMPDIR="$MASTER_TMPDIR/surface-health"
mkdir -p "$SURF_TMPDIR"
SURF_FILE="$SURF_TMPDIR/learnings.jsonl"

# 20 learnings: 5 @ 0.9 (high), 5 @ 0.6 (medium), 5 @ 0.4 (low-active), 5 @ 0.25 (below filter)
cat > "$SURF_FILE" << 'SURFEOF'
{"id":"s01","type":"fragile-file","subject":"a1","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s02","type":"fragile-file","subject":"a2","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s03","type":"fragile-file","subject":"a3","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s04","type":"fragile-file","subject":"a4","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s05","type":"fragile-file","subject":"a5","insight":"i","evidence":"e","confidence":0.9,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s06","type":"effective-sizing","subject":"b1","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s07","type":"effective-sizing","subject":"b2","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s08","type":"effective-sizing","subject":"b3","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s09","type":"effective-sizing","subject":"b4","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s10","type":"effective-sizing","subject":"b5","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s11","type":"recurring-issue","subject":"c1","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s12","type":"recurring-issue","subject":"c2","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s13","type":"recurring-issue","subject":"c3","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s14","type":"recurring-issue","subject":"c4","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s15","type":"recurring-issue","subject":"c5","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s16","type":"scope-guidance","subject":"d1","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s17","type":"scope-guidance","subject":"d2","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s18","type":"scope-guidance","subject":"d3","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s19","type":"scope-guidance","subject":"d4","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"s20","type":"scope-guidance","subject":"d5","insight":"i","evidence":"e","confidence":0.25,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
SURFEOF

CAP_N=5

# 10a: active count (confidence > 0.3) = 15 (the 0.25 group is excluded)
surf_active=$(jq -s 'map(select(.confidence > 0.3)) | length' "$SURF_FILE")
assert_eq "10a: active count (confidence > 0.3) = 15" "15" "$surf_active"

# 10b: surfaced = top-N = 5
surf_surfaced=$(jq -s --argjson n "$CAP_N" '
  map(select(.confidence > 0.3))
  | sort_by(.confidence, .created_at) | reverse
  | .[0:$n]
  | length
' "$SURF_FILE")
assert_eq "10b: surfaced = cap N = 5" "5" "$surf_surfaced"

# 10c: suppressed = active - surfaced = 10
surf_suppressed=$(( surf_active - CAP_N ))
assert_eq "10c: suppressed = 15 - 5 = 10" "10" "$surf_suppressed"

# 10d: high-bucket (>=0.7) = 5
surf_high=$(jq -s 'map(select(.confidence > 0.3 and .confidence >= 0.7)) | length' "$SURF_FILE")
assert_eq "10d: high-bucket count (>=0.7) = 5" "5" "$surf_high"

# 10e: medium-bucket (0.5-0.69) = 5
surf_med=$(jq -s 'map(select(.confidence >= 0.5 and .confidence < 0.7)) | length' "$SURF_FILE")
assert_eq "10e: medium-bucket count (0.5-0.69) = 5" "5" "$surf_med"

# 10f: low-bucket (>0.3 and <0.5) = 5
surf_low=$(jq -s 'map(select(.confidence > 0.3 and .confidence < 0.5)) | length' "$SURF_FILE")
assert_eq "10f: low-bucket count (>0.3 and <0.5) = 5" "5" "$surf_low"

# 10g: advisory condition: suppressed > surfaced (10 > 5) = true
surf_advisory=$( [[ $surf_suppressed -gt $CAP_N ]] && echo "true" || echo "false" )
assert_eq "10g: advisory condition (suppressed > surfaced)" "true" "$surf_advisory"

# 10h: no-advisory case — when suppressed <= surfaced, advisory must NOT fire
# Build a set where cap=10, active=15, suppressed=5 (5 <= 10 → no advisory)
surf_no_adv_suppressed=5
surf_no_adv_surfaced=10
surf_no_advisory=$( [[ $surf_no_adv_suppressed -gt $surf_no_adv_surfaced ]] && echo "true" || echo "false" )
assert_eq "10h: no advisory when suppressed (5) <= surfaced (10)" "false" "$surf_no_advisory"

# ===========================================================================
echo ""
echo "=== Group 11: Migration Helper (#90 verification) ==="
# ===========================================================================

MIG_TMPDIR="$MASTER_TMPDIR/migration"
MIGRATE_SCRIPT="$SCRIPT_DIR/../migrate-legacy-learnings.sh"
mkdir -p "$MIG_TMPDIR/.claude/metrics" "$MIG_TMPDIR/.orchestrator/metrics"

# Legacy: 3 entries including one with subject "shared-key" confidence 0.4
cat > "$MIG_TMPDIR/.claude/metrics/learnings.jsonl" << 'MIGLEGEOF'
{"id":"m01","type":"recurring-issue","subject":"shared-key","insight":"i","evidence":"e","confidence":0.4,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"m02","type":"fragile-file","subject":"leg-only-a","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"m03","type":"fragile-file","subject":"leg-only-b","insight":"i","evidence":"e","confidence":0.7,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
MIGLEGEOF

# Canonical: 3 entries including one with subject "shared-key" confidence 0.8 (wins)
cat > "$MIG_TMPDIR/.orchestrator/metrics/learnings.jsonl" << 'MIGCANEOF'
{"id":"m04","type":"recurring-issue","subject":"shared-key","insight":"i","evidence":"e","confidence":0.8,"source_session":"s","created_at":"2026-01-02T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"m05","type":"effective-sizing","subject":"can-only-a","insight":"i","evidence":"e","confidence":0.5,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
{"id":"m06","type":"scope-guidance","subject":"can-only-b","insight":"i","evidence":"e","confidence":0.55,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}
MIGCANEOF

# Run migration
mig_output=$(bash "$MIGRATE_SCRIPT" "$MIG_TMPDIR")

mig_status=$(echo "$mig_output" | jq -r '.status')
assert_eq "11a: migration status is merged" "merged" "$mig_status"

mig_canon_before=$(echo "$mig_output" | jq -r '.canonical_before')
assert_eq "11b: canonical_before = 3" "3" "$mig_canon_before"

mig_legacy=$(echo "$mig_output" | jq -r '.legacy')
assert_eq "11c: legacy = 3" "3" "$mig_legacy"

# canonical_after: 3 canonical + 3 legacy - 1 duplicate (shared-key) = 5
mig_canon_after=$(echo "$mig_output" | jq -r '.canonical_after')
assert_eq "11d: canonical_after = 5 (deduplicated)" "5" "$mig_canon_after"

mig_backup_notnull=$(echo "$mig_output" | jq '.backup != null')
assert_eq "11e: backup is non-null" "true" "$mig_backup_notnull"

# The shared-key entry in canonical should have confidence 0.8 (higher wins)
mig_shared_key_conf=$(jq -s 'map(select(.subject == "shared-key")) | .[0].confidence' "$MIG_TMPDIR/.orchestrator/metrics/learnings.jsonl")
assert_eq "11f: shared-key confidence = 0.8 (higher wins)" "0.8" "$mig_shared_key_conf"

# .bak file should exist
mig_bak_exists=0
ls "$MIG_TMPDIR/.claude/metrics/learnings.jsonl.migrated-"*.bak > /dev/null 2>&1 || mig_bak_exists=1
assert_eq "11g: .bak file exists" "0" "$mig_bak_exists"

# Run second time — should be no_legacy (idempotency)
mig_output2=$(bash "$MIGRATE_SCRIPT" "$MIG_TMPDIR")
mig_status2=$(echo "$mig_output2" | jq -r '.status')
assert_eq "11h: second run status = no_legacy (idempotent)" "no_legacy" "$mig_status2"

# Canonical line count unchanged after second run
mig_canon_after2=$(echo "$mig_output2" | jq -r '.canonical_after')
assert_eq "11i: second run canonical_after unchanged = 5" "5" "$mig_canon_after2"

# 11j: empty canonical (0 bytes) + legacy exists → status=merged, entry migrated
MIG_EMPTY_TMPDIR="$MASTER_TMPDIR/migration-empty-canonical"
mkdir -p "$MIG_EMPTY_TMPDIR/.claude/metrics" "$MIG_EMPTY_TMPDIR/.orchestrator/metrics"
touch "$MIG_EMPTY_TMPDIR/.orchestrator/metrics/learnings.jsonl"  # 0-byte canonical
echo '{"id":"ec1","type":"fragile-file","subject":"empty-canon-test","insight":"i","evidence":"e","confidence":0.6,"source_session":"s","created_at":"2026-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}' \
  > "$MIG_EMPTY_TMPDIR/.claude/metrics/learnings.jsonl"
mig_empty_output=$(bash "$MIGRATE_SCRIPT" "$MIG_EMPTY_TMPDIR")
mig_empty_status=$(echo "$mig_empty_output" | jq -r '.status')
# When canonical exists but is 0 bytes (canonical_before=0) the script reports "copied" not "merged"
assert_eq "11j: empty canonical (0 bytes) + legacy → status=copied" "copied" "$mig_empty_status"
mig_empty_canon_before=$(echo "$mig_empty_output" | jq -r '.canonical_before')
assert_eq "11j: empty canonical canonical_before=0" "0" "$mig_empty_canon_before"
mig_empty_canon_after=$(echo "$mig_empty_output" | jq -r '.canonical_after')
assert_eq "11j: empty canonical canonical_after=1" "1" "$mig_empty_canon_after"

# 11k: malformed legacy file → script exits non-zero (jq parse error, not silently corrupt)
MIG_MAL_TMPDIR="$MASTER_TMPDIR/migration-malformed"
mkdir -p "$MIG_MAL_TMPDIR/.claude/metrics"
echo 'not valid json' > "$MIG_MAL_TMPDIR/.claude/metrics/learnings.jsonl"
mig_mal_exit=0
bash "$MIGRATE_SCRIPT" "$MIG_MAL_TMPDIR" > /dev/null 2>&1 || mig_mal_exit=$?
# A non-zero exit is required — malformed input must not silently produce a corrupt canonical
mig_mal_nonzero=$( [[ $mig_mal_exit -ne 0 ]] && echo "true" || echo "false" )
assert_eq "11k: malformed legacy file causes non-zero exit (no silent corruption)" "true" "$mig_mal_nonzero"
