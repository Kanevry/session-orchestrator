#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CB_FILE="$SCRIPT_DIR/../../skills/wave-executor/circuit-breaker.md"
WL_FILE="$SCRIPT_DIR/../../skills/wave-executor/wave-loop.md"
SE_FILE="$SCRIPT_DIR/../../skills/session-end/SKILL.md"
EV_FILE="$SCRIPT_DIR/../../skills/evolve/SKILL.md"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    ((PASS++)) || true
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    ((FAIL++)) || true
  fi
}

assert_contains() {
  local label="$1" pattern="$2" file="$3"
  if grep -qF "$pattern" "$file"; then
    echo "  PASS: $label"
    ((PASS++)) || true
  else
    echo "  FAIL: $label"
    echo "    pattern not found: $pattern"
    ((FAIL++)) || true
  fi
}

# ===========================================================================
echo "=== test-stagnation.sh — circuit-breaker.md Stagnation Patterns ==="
# ===========================================================================

# 1: circuit-breaker.md exists
if [[ -f "$CB_FILE" ]]; then
  echo "  PASS: 1: circuit-breaker.md exists"
  ((PASS++)) || true
else
  echo "  FAIL: 1: circuit-breaker.md does not exist at $CB_FILE"
  ((FAIL++)) || true
fi

# 2: contains ## Stagnation Patterns heading
assert_contains "2: contains '## Stagnation Patterns' heading" \
  "## Stagnation Patterns" "$CB_FILE"

# 3: contains ### 1. Pagination Spiral heading
assert_contains "3: contains '### 1. Pagination Spiral' heading" \
  "### 1. Pagination Spiral" "$CB_FILE"

# 4: contains ### 2. Turn-Key Repetition heading
assert_contains "4: contains '### 2. Turn-Key Repetition' heading" \
  "### 2. Turn-Key Repetition" "$CB_FILE"

# 5: contains ### 3. Error Echo heading
assert_contains "5: contains '### 3. Error Echo' heading" \
  "### 3. Error Echo" "$CB_FILE"

# 6: contains ### Decision Table heading
assert_contains "6: contains '### Decision Table' heading" \
  "### Decision Table" "$CB_FILE"

# 7a: Decision Table mentions STAGNANT action
assert_contains "7a: Decision Table mentions STAGNANT" \
  "STAGNANT" "$CB_FILE"

# 7b: Decision Table mentions SPIRAL action
assert_contains "7b: Decision Table mentions SPIRAL" \
  "SPIRAL" "$CB_FILE"

# 7c: Decision Table mentions FAILED action
assert_contains "7c: Decision Table mentions FAILED" \
  "FAILED" "$CB_FILE"

# 8a: Pagination Spiral indicator references 'offset'
assert_contains "8a: Pagination Spiral references 'offset'" \
  "offset" "$CB_FILE"

# 8b: Pagination Spiral indicator references 'limit'
assert_contains "8b: Pagination Spiral references 'limit'" \
  "limit" "$CB_FILE"

# 9: Turn-Key Repetition references stripping pagination args
assert_contains "9: Turn-Key Repetition references stripping pagination args" \
  "strip pagination args" "$CB_FILE"

# 10: Error Echo section references "same error 3"
assert_contains "10: Error Echo references 'same error' occurring 3 times" \
  "Same error message returned 3 times" "$CB_FILE"

# 11: Detection Discipline warns two different agents reading the same file is not a spiral
assert_contains "11: Detection Discipline: two different agents reading same file is not a spiral" \
  "Two different agents reading the same file is" "$CB_FILE"

# 12: ## Stagnation Patterns appears AFTER ## Worktree Isolation (line ordering)
WORKTREE_LINE=$(grep -n "## Worktree Isolation" "$CB_FILE" | head -1 | cut -d: -f1)
STAGNATION_LINE=$(grep -n "## Stagnation Patterns" "$CB_FILE" | head -1 | cut -d: -f1)
if [[ -n "$WORKTREE_LINE" && -n "$STAGNATION_LINE" && "$STAGNATION_LINE" -gt "$WORKTREE_LINE" ]]; then
  echo "  PASS: 12: '## Stagnation Patterns' (line $STAGNATION_LINE) appears after '## Worktree Isolation' (line $WORKTREE_LINE)"
  ((PASS++)) || true
else
  echo "  FAIL: 12: line ordering check — Worktree Isolation=$WORKTREE_LINE, Stagnation Patterns=$STAGNATION_LINE"
  ((FAIL++)) || true
fi

# ===========================================================================
echo "--- #84 stagnation telemetry ---"
# ===========================================================================

# circuit-breaker.md: Error-Class Taxonomy
assert_contains "circuit-breaker: Error-Class Taxonomy heading" \
  "Error-Class Taxonomy" "$CB_FILE"

assert_contains "circuit-breaker: edit-format-friction class" \
  "edit-format-friction" "$CB_FILE"

assert_contains "circuit-breaker: scope-denied class" \
  "scope-denied" "$CB_FILE"

assert_contains "circuit-breaker: command-blocked class" \
  "command-blocked" "$CB_FILE"

assert_contains "circuit-breaker: other fallback class" \
  '`other`' "$CB_FILE"

# wave-loop.md: stagnation event-write rule
assert_contains "wave-loop: Stagnation event-write heading" \
  "Stagnation event-write" "$WL_FILE"

assert_contains "wave-loop: stagnation_detected event name" \
  "stagnation_detected" "$WL_FILE"

assert_contains "wave-loop: events.jsonl path" \
  "events.jsonl" "$WL_FILE"

# session-end/SKILL.md: stagnation aggregation
assert_contains "session-end: stagnation_events field" \
  "stagnation_events" "$SE_FILE"

assert_contains "session-end: by_pattern sub-field" \
  "by_pattern" "$SE_FILE"

assert_contains "session-end: by_error_class sub-field" \
  "by_error_class" "$SE_FILE"

assert_contains "session-end: learning-type enum includes stagnation-class-frequency" \
  "stagnation-class-frequency" "$SE_FILE"

# evolve/SKILL.md: sixth learning type
assert_contains "evolve: 6 learning types header" \
  "6 learning types" "$EV_FILE"

assert_contains "evolve: stagnation-class-frequency heading" \
  "stagnation-class-frequency" "$EV_FILE"

# ===========================================================================
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [[ "$FAIL" -eq 0 ]]; then
  echo "  --- test-stagnation.sh: ALL PASSED ---"
  exit 0
else
  echo "  --- test-stagnation.sh: FAILURES ---"
  exit 1
fi
