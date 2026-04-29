#!/bin/sh
# scripts/check-doc-consistency.sh
#
# Cross-file consistency check for README.md ↔ CLAUDE.md (issue #30).
# POSIX-only; no Bashisms. Uses awk + grep + sed.
#
# Checks:
#   1. H2 parity   — every CLAUDE.md ## heading (other than the canonical
#                    runtime-only set: Structure, Destructive-Command Guard,
#                    Agent Authoring Rules, Current State, Session Config)
#                    must have a counterpart in README.md, or carry an
#                    inline `<!-- consistency:exempt: <reason> -->` marker
#                    on the heading line.
#   2. Count parity — for the noun set (skills | commands | agents |
#                    hook | hooks | event matchers | handlers), if both
#                    README.md and CLAUDE.md mention `\b<N>\s+<noun>\b`,
#                    the numbers must agree.
#   3. Live ## Session Config — must exist in CLAUDE.md (this is the
#                    runtime SSOT consumed by skills/_shared/config-reading.md).
#   4. Alias phrasing — every standalone `CLAUDE.md` mention outside fenced
#                    code blocks must appear as
#                    `CLAUDE.md (or AGENTS.md on Codex CLI)`, OR carry an
#                    inline `<!-- consistency:exempt: <reason> -->` marker,
#                    OR live in a SSOT-pointer line containing
#                    `instruction-file-resolution.md`.
#
# Exit codes:
#   0  consistent
#   1  drift detected
#   2  setup error
#
# Output:
#   Per finding (stdout):
#     DRIFT  <file>:<lineno>  <category>  <detail>
#   Footer summary (stdout):
#     => N findings (N1 missing-h2, N2 count-mismatch, N3 alias-phrasing)

set -eu

README="README.md"
CLAUDE="CLAUDE.md"

if [ ! -f "$README" ]; then
  echo "ERROR: $README not found in cwd ($(pwd))" >&2
  exit 2
fi
if [ ! -f "$CLAUDE" ]; then
  echo "ERROR: $CLAUDE not found in cwd ($(pwd))" >&2
  exit 2
fi

# Workspace
TMPDIR="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMPDIR%/}/check-doc-consistency.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

FINDINGS="$WORK/findings"
: > "$FINDINGS"

n_missing_h2=0
n_count_mismatch=0
n_alias=0

emit() {
  # emit <category> <file:lineno> <detail>
  printf 'DRIFT  %s  %s  %s\n' "$2" "$1" "$3" >> "$FINDINGS"
}

# ---------------------------------------------------------------------------
# Helper: strip code fences from a markdown file. Lines inside ``` … ``` blocks
# are blanked (kept as empty lines so line numbers are preserved).
# ---------------------------------------------------------------------------
strip_fences() {
  awk '
    BEGIN { fence = 0 }
    /^[[:space:]]*```/ { fence = 1 - fence; print ""; next }
    { if (fence) print ""; else print }
  ' "$1"
}

README_NOFENCE="$WORK/README.nofence"
CLAUDE_NOFENCE="$WORK/CLAUDE.nofence"
strip_fences "$README" > "$README_NOFENCE"
strip_fences "$CLAUDE" > "$CLAUDE_NOFENCE"

# ---------------------------------------------------------------------------
# Check 3: live `## Session Config` present in CLAUDE.md
# ---------------------------------------------------------------------------
if ! grep -qE '^## Session Config[[:space:]]*$' "$CLAUDE"; then
  emit "$CLAUDE:1" "live-config-missing" "## Session Config heading not found (skills/_shared/config-reading.md depends on it)"
fi

# ---------------------------------------------------------------------------
# Check 1: H2 parity (CLAUDE.md → README.md)
# Canonical runtime-only headings live in CLAUDE.md exclusively and are exempt.
# ---------------------------------------------------------------------------
EXEMPT_HEADINGS_RE='^## (Structure|Destructive-Command Guard|Agent Authoring Rules|Current State|Session Config)[[:space:]]*$'

# Extract README H2 set (one per line, normalized — heading text without the leading `## `)
README_H2="$WORK/readme.h2"
grep -nE '^## ' "$README_NOFENCE" | sed -E 's/^[0-9]+:## //' | sed -E 's/[[:space:]]*$//' | sort -u > "$README_H2"

# Walk CLAUDE.md H2s
grep -nE '^## ' "$CLAUDE_NOFENCE" | while IFS= read -r line; do
  lineno="${line%%:*}"
  rest="${line#*:}"
  # rest is "## Heading Title" possibly with trailing inline comment
  heading_full="$rest"

  # Skip exempt canonical headings
  if echo "$heading_full" | grep -qE "$EXEMPT_HEADINGS_RE"; then
    continue
  fi

  # Inline-exempt marker on the same line
  if echo "$heading_full" | grep -q '<!-- consistency:exempt:'; then
    continue
  fi

  heading_text=$(echo "$heading_full" | sed -E 's/^## //' | sed -E 's/[[:space:]]*$//')

  # Lookup in README H2 set (case-sensitive match)
  if ! grep -qxF "$heading_text" "$README_H2"; then
    printf 'DRIFT  %s:%s  missing-h2  CLAUDE.md heading "%s" has no counterpart in README.md\n' \
      "$CLAUDE" "$lineno" "$heading_text" >> "$FINDINGS"
  fi
done

# ---------------------------------------------------------------------------
# Check 2: count parity for known noun set
# ---------------------------------------------------------------------------
# Count parity is restricted to inventory-style claims only. The matcher requires
# the noun to be capitalized (i.e., a count claim like "25 Skills" / "10 Commands"
# / "7 Agents" / "7 hook handlers" / "6 event matchers"), which screens out
# in-prose noun usages like "1-2 agents per wave" or "the hook chain".
extract_capitalized_count() {
  # extract_capitalized_count <file> <noun-capitalized>
  # Matches "<N> <Noun>" where <Noun> starts with an uppercase letter, exactly
  # as it appears in inventory claims. Word-boundary both sides.
  awk -v noun="$2" '
    {
      # Build regex: \b<N>[ \t]+<Noun>(s|)\b
      # POSIX awk has no \b; use [^A-Za-z0-9_] sentinels via match.
      n_line = $0
      # Try to find the first occurrence
      while (match(n_line, /[0-9]+[ \t]+[A-Z][A-Za-z]+/)) {
        token = substr(n_line, RSTART, RLENGTH)
        # Split into <count> and <word>
        split(token, parts, /[ \t]+/)
        if (parts[2] == noun) {
          print NR ":" parts[1]
          exit
        }
        n_line = substr(n_line, RSTART + RLENGTH)
      }
    }
  ' "$1"
}

# Phrase-aware extractor: matches "<N> <word1> <word2>" exactly.
extract_phrase_count() {
  awk -v w1="$2" -v w2="$3" '
    {
      line_lc = tolower($0)
      n = split(line_lc, words, /[^a-z0-9]+/)
      for (i = 1; i <= n - 2; i++) {
        if (words[i] ~ /^[0-9]+$/ && words[i+1] == w1 && words[i+2] == w2) {
          print NR ":" words[i]
          exit
        }
      }
    }
  ' "$1"
}

# Inventory claims (capitalized, "Components"-style)
for capnoun in Skills Commands Agents; do
  r=$(extract_capitalized_count "$README_NOFENCE" "$capnoun")
  c=$(extract_capitalized_count "$CLAUDE_NOFENCE" "$capnoun")
  if [ -n "$r" ] && [ -n "$c" ]; then
    rcount="${r#*:}"; ccount="${c#*:}"
    rline="${r%%:*}"; cline="${c%%:*}"
    if [ "$rcount" != "$ccount" ]; then
      printf 'DRIFT  %s:%s  count-mismatch  README says %s %s, CLAUDE.md says %s %s (line %s)\n' \
        "$README" "$rline" "$rcount" "$capnoun" "$ccount" "$capnoun" "$cline" >> "$FINDINGS"
    fi
  fi
done

# Phrase claims
for pair in "event matchers" "hook handlers"; do
  w1=$(echo "$pair" | awk '{print $1}')
  w2=$(echo "$pair" | awk '{print $2}')
  # Try plural and singular w2
  r=$(extract_phrase_count "$README_NOFENCE" "$w1" "$w2")
  if [ -z "$r" ]; then
    r=$(extract_phrase_count "$README_NOFENCE" "$w1" "${w2%s}")
  fi
  c=$(extract_phrase_count "$CLAUDE_NOFENCE" "$w1" "$w2")
  if [ -z "$c" ]; then
    c=$(extract_phrase_count "$CLAUDE_NOFENCE" "$w1" "${w2%s}")
  fi
  if [ -n "$r" ] && [ -n "$c" ]; then
    rcount="${r#*:}"; ccount="${c#*:}"
    rline="${r%%:*}"; cline="${c%%:*}"
    if [ "$rcount" != "$ccount" ]; then
      printf 'DRIFT  %s:%s  count-mismatch  README says %s %s, CLAUDE.md says %s %s (line %s)\n' \
        "$README" "$rline" "$rcount" "$pair" "$ccount" "$pair" "$cline" >> "$FINDINGS"
    fi
  fi
done

# ---------------------------------------------------------------------------
# Check 4: alias phrasing
# Every line that mentions `CLAUDE.md` outside code fences must be one of:
#   (a) part of `CLAUDE.md (or AGENTS.md on Codex CLI)` phrase
#   (b) carry an inline `<!-- consistency:exempt:...-->` marker
#   (c) reference `instruction-file-resolution.md` (the SSOT pointer line)
#   (d) inside a markdown link target like `(./CLAUDE.md)` or `[`CLAUDE.md`]`
#       — those are file-link references, not prose mentions
# ---------------------------------------------------------------------------
check_alias_in() {
  file="$1"
  nofence="$2"
  awk '
    /CLAUDE\.md/ {
      line = $0
      lineno = NR
      # Skip code-fence-stripped (already blank) lines — awk keeps them, just skip empties
      if (line == "") next
      # Exemption: inline marker
      if (line ~ /<!-- consistency:exempt:/) next
      # Exemption: SSOT pointer line
      if (line ~ /instruction-file-resolution\.md/) next
      # Exemption: alias phrase present
      if (line ~ /CLAUDE\.md \(or AGENTS\.md on Codex CLI\)/) next
      # Exemption: alias phrase present in alternate phrasing (Codex CLI alias for CLAUDE.md)
      if (line ~ /alias for `CLAUDE\.md`/) next
      if (line ~ /CLAUDE\.md \(Cursor reads it natively\)/) next
      # Exemption: pure file-link / inline code references (no prose claim)
      #   - "(./CLAUDE.md)" or "(CLAUDE.md)" as link target
      #   - "[`CLAUDE.md`]" inline code link text
      tmp = line
      gsub(/`CLAUDE\.md`/, "", tmp)
      gsub(/\(\.?\/?CLAUDE\.md\)/, "", tmp)
      gsub(/\[CLAUDE\.md\]/, "", tmp)
      if (tmp !~ /CLAUDE\.md/) next
      printf "DRIFT  %s:%d  alias-phrasing  bare CLAUDE.md mention not aliased to AGENTS.md: %s\n", FILE, lineno, line
    }
  ' FILE="$file" "$nofence" >> "$FINDINGS"
}

check_alias_in "$README" "$README_NOFENCE"
check_alias_in "$CLAUDE" "$CLAUDE_NOFENCE"

# ---------------------------------------------------------------------------
# Tally + emit
# ---------------------------------------------------------------------------
total=0
if [ -s "$FINDINGS" ]; then
  while IFS= read -r ln; do
    echo "$ln"
    total=$((total + 1))
    case "$ln" in
      *missing-h2*)        n_missing_h2=$((n_missing_h2 + 1));;
      *count-mismatch*)    n_count_mismatch=$((n_count_mismatch + 1));;
      *alias-phrasing*)    n_alias=$((n_alias + 1));;
      *live-config-missing*) ;;
    esac
  done < "$FINDINGS"
fi

if [ "$total" -eq 0 ]; then
  echo "=> 0 findings (clean)"
  exit 0
fi

echo "=> $total findings ($n_missing_h2 missing-h2, $n_count_mismatch count-mismatch, $n_alias alias-phrasing)"
exit 1
