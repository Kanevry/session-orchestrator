#!/usr/bin/env bash
set -u

# ===========================================================================
echo ""
echo "=== Group 7: AGENTS.md Config Parsing ==="
# ===========================================================================

# Create a temp AGENTS.md
AGENTS_TMPDIR="$MASTER_TMPDIR/agents-md"
mkdir -p "$AGENTS_TMPDIR"
cat > "$AGENTS_TMPDIR/AGENTS.md" << 'AGEOF'
# Project Instructions

Some instructions here.

## Session Config

agents-per-wave: 8
waves: 3
persistence: true
enforcement: strict
test-command: npm test

## Other Section

This is not config.
AGEOF

agents_json=$(bash "$PARSE_CONFIG" "$AGENTS_TMPDIR/AGENTS.md" 2>/dev/null)
agents_exit=$?
assert_eq "7a: AGENTS.md parse exits 0" "0" "$agents_exit"

agents_apw=$(echo "$agents_json" | jq -r '."agents-per-wave"')
assert_eq "7c: AGENTS.md agents-per-wave" "8" "$agents_apw"

agents_waves=$(echo "$agents_json" | jq -r '.waves')
assert_eq "7d: AGENTS.md waves" "3" "$agents_waves"

agents_persist=$(echo "$agents_json" | jq -r '.persistence')
assert_eq "7e: AGENTS.md persistence" "true" "$agents_persist"

agents_enforce=$(echo "$agents_json" | jq -r '.enforcement')
assert_eq "7f: AGENTS.md enforcement" "strict" "$agents_enforce"

agents_test=$(echo "$agents_json" | jq -r '."test-command"')
assert_eq "7g: AGENTS.md test-command" "npm test" "$agents_test"
