#!/usr/bin/env bash
set -u

# ===========================================================================
echo ""
echo "=== Group 12: Pre-Edit Grounding Injection (#85) ==="
# ===========================================================================

GROUNDING_SCRIPT="$SCRIPT_DIR/../compute-grounding-injection.sh"

if ! command -v jq &>/dev/null; then
  echo "  SKIP: jq not installed — Group 12 skipped"
else

# --- 12a: Config default + override + disable ---

G12_TMPDIR="$MASTER_TMPDIR/g12"
mkdir -p "$G12_TMPDIR"

# 12a-1: No override → default 3
cat > "$G12_TMPDIR/claude-md-no-grounding.md" << 'EOF'
# Project
## Session Config
- **persistence:** true
EOF
g12a_default=$(bash "$PARSE_CONFIG" "$G12_TMPDIR/claude-md-no-grounding.md" 2>/dev/null \
  | jq -r '."grounding-injection-max-files"')
assert_eq "12a: grounding-injection-max-files default = 3" "3" "$g12a_default"

# 12a-2: Override to 7
cat > "$G12_TMPDIR/claude-md-grounding-7.md" << 'EOF'
# Project
## Session Config
- **persistence:** true
- **grounding-injection-max-files:** 7
EOF
g12a_override=$(bash "$PARSE_CONFIG" "$G12_TMPDIR/claude-md-grounding-7.md" 2>/dev/null \
  | jq -r '."grounding-injection-max-files"')
assert_eq "12a: grounding-injection-max-files override = 7" "7" "$g12a_override"

# 12a-3: Disable (0)
cat > "$G12_TMPDIR/claude-md-grounding-0.md" << 'EOF'
# Project
## Session Config
- **persistence:** true
- **grounding-injection-max-files:** 0
EOF
g12a_zero=$(bash "$PARSE_CONFIG" "$G12_TMPDIR/claude-md-grounding-0.md" 2>/dev/null \
  | jq -r '."grounding-injection-max-files"')
assert_eq "12a: grounding-injection-max-files disabled = 0" "0" "$g12a_zero"

# --- 12b: Helper empty-state early-exit ---

G12B_TMPDIR="$MASTER_TMPDIR/g12b"
mkdir -p "$G12B_TMPDIR"

# No EVENTS_JSONL / SESSIONS_JSONL set — only MAX_FILES=3
g12b_exit=0
g12b_out=$(MAX_FILES=3 bash "$GROUNDING_SCRIPT" 2>/dev/null) || g12b_exit=$?
assert_eq "12b: empty-state exits 0" "0" "$g12b_exit"
assert_eq "12b: empty-state stdout is empty" "" "$g12b_out"

# --- 12c: Match found — GROUNDING block emitted + event written ---

G12C_TMPDIR="$MASTER_TMPDIR/g12c"
mkdir -p "$G12C_TMPDIR"
G12C_EVJ="$G12C_TMPDIR/events.jsonl"
G12C_SSJ="$G12C_TMPDIR/sessions.jsonl"
G12C_TGT="$G12C_TMPDIR/target.sh"

printf 'one\ntwo\nthree\n' > "$G12C_TGT"
echo '{"session_id":"sess-1","completed_at":"2026-04-14T11:00:00Z"}' > "$G12C_SSJ"
printf '{"event":"stagnation_detected","timestamp":"2026-04-14T10:00:00Z","session":"sess-1","wave":2,"agent":"x","pattern":"error-echo","error_class":"edit-format-friction","file":"%s","occurrences":3}\n' \
  "$G12C_TGT" > "$G12C_EVJ"

g12c_lines_before=$(wc -l < "$G12C_EVJ" | tr -d ' ')

g12c_out=$(EVENTS_JSONL="$G12C_EVJ" SESSIONS_JSONL="$G12C_SSJ" \
  AGENT_FILES="$G12C_TGT" MAX_FILES=3 PERSISTENCE=true \
  SESSION_ID=sess-now WAVE=1 AGENT_TYPE=x \
  bash "$GROUNDING_SCRIPT" 2>/dev/null)

# stdout contains the GROUNDING header
g12c_has_header=0
echo "$g12c_out" | grep -qF "## GROUNDING — $G12C_TGT" || g12c_has_header=1
assert_eq "12c: stdout contains GROUNDING header for target file" "0" "$g12c_has_header"

# stdout contains a numbered line with "one" (awk format: %5d\ttext)
g12c_has_line1=0
echo "$g12c_out" | grep -qE '^ *1[[:space:]]+one$' || g12c_has_line1=1
assert_eq "12c: stdout contains numbered line 1 = 'one'" "0" "$g12c_has_line1"

# events.jsonl grew by exactly 1 line
g12c_lines_after=$(wc -l < "$G12C_EVJ" | tr -d ' ')
g12c_grew=$(( g12c_lines_after - g12c_lines_before ))
assert_eq "12c: events.jsonl grew by exactly 1 line" "1" "$g12c_grew"

# new event has event=grounding_injected
g12c_event_type=$(tail -n 1 "$G12C_EVJ" | jq -r '.event')
assert_eq "12c: new event type = grounding_injected" "grounding_injected" "$g12c_event_type"

# new event has grounding_capped = false (only 1 match, cap 3)
g12c_capped=$(tail -n 1 "$G12C_EVJ" | jq -r '.grounding_capped')
assert_eq "12c: grounding_capped = false (1 match < cap 3)" "false" "$g12c_capped"

# --- 12d: Cap behavior — MAX_FILES=3, 5 matching files ---

G12D_TMPDIR="$MASTER_TMPDIR/g12d"
mkdir -p "$G12D_TMPDIR"
G12D_EVJ="$G12D_TMPDIR/events.jsonl"
G12D_SSJ="$G12D_TMPDIR/sessions.jsonl"

echo '{"session_id":"sess-cap","completed_at":"2026-04-14T11:00:00Z"}' > "$G12D_SSJ"

# Create 5 target files and 5 matching stagnation events
G12D_FILES=""
for i in 1 2 3 4 5; do
  f="$G12D_TMPDIR/file${i}.sh"
  printf 'line-a\nline-b\n' > "$f"
  G12D_FILES="${G12D_FILES}${f}"$'\n'
  printf '{"event":"stagnation_detected","timestamp":"2026-04-14T1%d:00:00Z","session":"sess-cap","wave":1,"agent":"x","pattern":"error-echo","error_class":"edit-format-friction","file":"%s","occurrences":2}\n' \
    "$i" "$f" >> "$G12D_EVJ"
done
G12D_FILES="${G12D_FILES%$'\n'}"

g12d_lines_before=$(wc -l < "$G12D_EVJ" | tr -d ' ')

g12d_out=$(EVENTS_JSONL="$G12D_EVJ" SESSIONS_JSONL="$G12D_SSJ" \
  AGENT_FILES="$G12D_FILES" MAX_FILES=3 PERSISTENCE=true \
  SESSION_ID=sess-now WAVE=2 AGENT_TYPE=x \
  bash "$GROUNDING_SCRIPT" 2>/dev/null)

# stdout has exactly 3 GROUNDING headers (cap = 3)
g12d_header_count=$(echo "$g12d_out" | grep -c '## GROUNDING —' || true)
assert_eq "12d: stdout has exactly 3 GROUNDING headers (cap=3)" "3" "$g12d_header_count"

# events.jsonl grew by exactly 3 lines
g12d_lines_after=$(wc -l < "$G12D_EVJ" | tr -d ' ')
g12d_grew=$(( g12d_lines_after - g12d_lines_before ))
assert_eq "12d: events.jsonl grew by exactly 3 lines" "3" "$g12d_grew"

# All 3 new events have grounding_capped = true (pre-cap count 5 > MAX_FILES 3)
g12d_capped_count=$(tail -n 3 "$G12D_EVJ" | jq -r 'select(.event=="grounding_injected") | .grounding_capped' | grep -c '^true$' || true)
assert_eq "12d: all 3 new grounding_injected events have grounding_capped=true" "3" "$g12d_capped_count"

# --- 12e: PERSISTENCE=false — stdout emitted, events.jsonl unchanged ---

G12E_TMPDIR="$MASTER_TMPDIR/g12e"
mkdir -p "$G12E_TMPDIR"
G12E_EVJ="$G12E_TMPDIR/events.jsonl"
G12E_SSJ="$G12E_TMPDIR/sessions.jsonl"
G12E_TGT="$G12E_TMPDIR/target.sh"

printf 'alpha\nbeta\n' > "$G12E_TGT"
echo '{"session_id":"sess-nop","completed_at":"2026-04-14T11:00:00Z"}' > "$G12E_SSJ"
printf '{"event":"stagnation_detected","timestamp":"2026-04-14T10:00:00Z","session":"sess-nop","wave":1,"agent":"x","pattern":"error-echo","error_class":"edit-format-friction","file":"%s","occurrences":1}\n' \
  "$G12E_TGT" > "$G12E_EVJ"

g12e_lines_before=$(wc -l < "$G12E_EVJ" | tr -d ' ')

g12e_out=$(EVENTS_JSONL="$G12E_EVJ" SESSIONS_JSONL="$G12E_SSJ" \
  AGENT_FILES="$G12E_TGT" MAX_FILES=3 PERSISTENCE=false \
  SESSION_ID=sess-now WAVE=1 AGENT_TYPE=x \
  bash "$GROUNDING_SCRIPT" 2>/dev/null)

# stdout is non-empty (GROUNDING block still printed)
g12e_nonempty=0
[[ -n "$g12e_out" ]] || g12e_nonempty=1
assert_eq "12e: PERSISTENCE=false still emits GROUNDING block to stdout" "0" "$g12e_nonempty"

# events.jsonl line count unchanged
g12e_lines_after=$(wc -l < "$G12E_EVJ" | tr -d ' ')
assert_eq "12e: PERSISTENCE=false leaves events.jsonl unchanged" "$g12e_lines_before" "$g12e_lines_after"

fi  # end jq guard
