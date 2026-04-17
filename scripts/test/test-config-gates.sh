#!/usr/bin/env bash
set -u

# ===========================================================================
echo "=== Group 1: Config -> Quality Gate Pipeline ==="
# ===========================================================================

# 1a: Parse full config -> feed to quality gate baseline
G1_TMPDIR="$MASTER_TMPDIR/g1"
mkdir -p "$G1_TMPDIR"

full_json=$(bash "$PARSE_CONFIG" "$FIXTURES/claude-md-full.md" 2>/dev/null)
echo "$full_json" > "$G1_TMPDIR/config.json"

baseline_output=$(bash "$QUALITY_GATE" --variant baseline --config "$G1_TMPDIR/config.json" 2>/dev/null)
baseline_exit=$?
assert_eq "1a: parse full -> baseline exits 0" "0" "$baseline_exit"

baseline_json_ok=0
echo "$baseline_output" | jq empty 2>/dev/null || baseline_json_ok=$?
assert_eq "1a: baseline output is valid JSON" "0" "$baseline_json_ok"

baseline_variant=$(echo "$baseline_output" | jq -r '.variant')
assert_eq "1a: baseline variant field" "baseline" "$baseline_variant"

# 1b: Parse echo-commands config -> feed to each variant
echo_json=$(bash "$PARSE_CONFIG" "$FIXTURES/claude-md-echo-commands.md" 2>/dev/null)
echo "$echo_json" > "$G1_TMPDIR/echo-config.json"

# baseline
echo_baseline=$(bash "$QUALITY_GATE" --variant baseline --config "$G1_TMPDIR/echo-config.json" 2>/dev/null)
echo_baseline_exit=$?
assert_eq "1b: echo -> baseline exits 0" "0" "$echo_baseline_exit"

echo_bl_has_tc=$(echo "$echo_baseline" | jq 'has("typecheck")')
assert_eq "1b: echo baseline has typecheck" "true" "$echo_bl_has_tc"

echo_bl_has_test=$(echo "$echo_baseline" | jq 'has("test")')
assert_eq "1b: echo baseline has test" "true" "$echo_bl_has_test"

# full-gate
echo_fullgate=$(bash "$QUALITY_GATE" --variant full-gate --config "$G1_TMPDIR/echo-config.json" 2>/dev/null)
echo_fullgate_exit=$?
assert_eq "1b: echo -> full-gate exits 0" "0" "$echo_fullgate_exit"

echo_fg_tc_status=$(echo "$echo_fullgate" | jq 'has("typecheck") and (.typecheck | has("status"))')
assert_eq "1b: full-gate has typecheck.status" "true" "$echo_fg_tc_status"

echo_fg_test_status=$(echo "$echo_fullgate" | jq 'has("test") and (.test | has("status"))')
assert_eq "1b: full-gate has test.status" "true" "$echo_fg_test_status"

echo_fg_lint_status=$(echo "$echo_fullgate" | jq 'has("lint") and (.lint | has("status"))')
assert_eq "1b: full-gate has lint.status" "true" "$echo_fg_lint_status"

# per-file
echo_perfile=$(bash "$QUALITY_GATE" --variant per-file --config "$G1_TMPDIR/echo-config.json" --files dummy.ts 2>/dev/null)
echo_perfile_exit=$?
assert_eq "1b: echo -> per-file exits 0" "0" "$echo_perfile_exit"

# 1c: Parse minimal config -> baseline (defaults used, may skip/fail but config flows)
minimal_json=$(bash "$PARSE_CONFIG" "$FIXTURES/claude-md-minimal.md" 2>/dev/null)
echo "$minimal_json" > "$G1_TMPDIR/minimal-config.json"

minimal_baseline=$(bash "$QUALITY_GATE" --variant baseline --config "$G1_TMPDIR/minimal-config.json" 2>/dev/null)
minimal_baseline_exit=$?
assert_eq "1c: minimal -> baseline exits 0" "0" "$minimal_baseline_exit"

minimal_bl_json_ok=0
echo "$minimal_baseline" | jq empty 2>/dev/null || minimal_bl_json_ok=$?
assert_eq "1c: minimal baseline output is valid JSON" "0" "$minimal_bl_json_ok"

minimal_bl_variant=$(echo "$minimal_baseline" | jq -r '.variant')
assert_eq "1c: minimal baseline variant field" "baseline" "$minimal_bl_variant"
