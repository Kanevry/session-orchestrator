#!/usr/bin/env bash
# measure-context-overhead.sh — measure the REAL instruction overhead of a directory.
#
# Why this exists (and why token-audit.sh does not replace it):
# token-audit.sh measures instruction bytes ON DISK. That is a proxy, and a poor
# one: it cannot see which rule files the loader classifies as always-on, it
# cannot see plugin skill descriptions, and it cannot see the tool definitions.
# This script measures what actually reaches the model, by sending a trivial
# prompt and reading the token accounting back out of the API response. Every
# token it reports is overhead, because the prompt itself does no work.
#
# Method: `claude -p "<trivial prompt>" --output-format json`, then sum
#   input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
# The cache split varies between runs; the SUM is the stable quantity and is
# what the model is charged for reading.
#
# COST WARNING: each measurement is a real API call against the configured
# model. Measured 2026-07-30 on claude-opus-5[1m]: USD 0.27 (empty directory)
# to USD 1.06 (this repo). Budget accordingly before running a large matrix.
#
# Usage:
#   bash scripts/measure-context-overhead.sh <dir> [<dir> ...]
#   bash scripts/measure-context-overhead.sh --ablate <repo-root>
#
# --ablate builds throwaway copies of <repo-root>'s instruction surface
# (CLAUDE.md + .claude/rules/) under $TMPDIR and measures the full / reduced /
# stripped variants, so the cost of each layer can be attributed. It never
# writes to, and never deletes from, the source repository.
#
# Baseline recorded 2026-07-30 (claude-opus-5[1m], CLI 2.1.220), this repo:
#   full 110687 tok | no top-3 rules 83138 | no rules 43291 | nothing 42001
# Reading: the 26 rule files account for 67396 tokens (61% of total); CLAUDE.md
# itself accounts for 1290. Optimising CLAUDE.md is optimising the wrong file.

set -uo pipefail

PROMPT='Antworte nur mit dem Wort: OK'

measure_one() {
  local dir="$1" label="$2"
  if [ ! -d "$dir" ]; then
    printf '%s\tNO-SUCH-DIR\n' "$label"
    return
  fi
  ( cd "$dir" && claude -p "$PROMPT" --output-format json 2>/dev/null ) | node -e "
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const label = process.argv[1];
  try {
    const j = JSON.parse(s);
    const u = j.usage || {};
    const ctx =
      (u.input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0);
    process.stdout.write(
      [label, ctx, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0,
       u.output_tokens || 0, (j.total_cost_usd || 0).toFixed(4)].join('\t') + '\n',
    );
  } catch {
    process.stdout.write(label + '\tPARSE-ERROR\n');
  }
});
" "$label"
}

header() { printf 'LABEL\tCONTEXT_TOK\tcache_create\tcache_read\toutput\tUSD\n'; }

# ── --ablate mode ───────────────────────────────────────────────────
if [ "${1:-}" = "--ablate" ]; then
  SRC="${2:-$(pwd)}"
  [ -d "$SRC" ] || { echo "not a directory: $SRC" >&2; exit 1; }
  BASE="${TMPDIR:-/tmp}/so-ablation-$$"
  mkdir -p "$BASE"
  # Copy ONLY the instruction surface. No git, no source, no side effects.
  build() {
    local v="$BASE/$1"
    mkdir -p "$v/.claude/rules"
    cp "$SRC/CLAUDE.md" "$v/CLAUDE.md" 2>/dev/null || true
    cp "$SRC"/.claude/rules/*.md "$v/.claude/rules/" 2>/dev/null || true
  }
  build v0-full
  build v1-no-top3
  rm -f "$BASE/v1-no-top3/.claude/rules/loop-and-monitor.md" \
        "$BASE/v1-no-top3/.claude/rules/parallel-sessions.md" \
        "$BASE/v1-no-top3/.claude/rules/security.md"
  build v2-no-rules
  rm -f "$BASE"/v2-no-rules/.claude/rules/*.md
  build v3-bare
  rm -f "$BASE"/v3-bare/.claude/rules/*.md "$BASE/v3-bare/CLAUDE.md"

  echo "=== instruction bytes on disk ==="
  for v in v0-full v1-no-top3 v2-no-rules v3-bare; do
    b=$(cat "$BASE/$v/CLAUDE.md" "$BASE/$v"/.claude/rules/*.md 2>/dev/null | wc -c | tr -d ' ')
    n=$(ls "$BASE/$v"/.claude/rules/*.md 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-14s %8s B  rules=%s\n' "$v" "${b:-0}" "${n:-0}"
  done
  echo
  header
  for v in v0-full v1-no-top3 v2-no-rules v3-bare; do
    measure_one "$BASE/$v" "$v"
  done
  echo
  echo "variants left in $BASE (throwaway; remove when done)"
  exit 0
fi

# ── direct mode ─────────────────────────────────────────────────────
if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/measure-context-overhead.sh <dir> [<dir> ...]" >&2
  echo "       bash scripts/measure-context-overhead.sh --ablate <repo-root>" >&2
  exit 1
fi

header
for d in "$@"; do
  measure_one "$d" "$(basename "$d")"
done
