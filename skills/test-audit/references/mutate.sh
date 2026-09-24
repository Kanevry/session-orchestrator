#!/usr/bin/env bash
# Mutation runner for the test-audit skill; manifest format in campaign.md, section "Mutation manifest".
# Usage: bash mutate.sh <mutations-dir>   from the offload worktree root, never a live checkout.
# Reads <mutations-dir>/<lane>/manifest.tsv (tab-separated):
#   id  patch  testfiles  pattern  contract  ledger_refs
# Env, defaults fit vitest: MUTATE_CMD, MUTATE_PATTERN_FLAG, MUTATE_RED_RE.
# Exit 0 only when the control run is green and every mutation is CAUGHT; 1 otherwise,
# 2 red control, 3 restore mismatch (aborts at once). CMD and testfiles split on spaces.
set -u
MDIR="${1:?usage: mutate.sh <mutations-dir>}"
CMD="${MUTATE_CMD:-pnpm exec vitest run}"
PFLAG="${MUTATE_PATTERN_FLAG:--t}"
RED_RE="${MUTATE_RED_RE:-Tests +[0-9]+ failed}"
export NO_COLOR=1; ESC=$(printf '\033')  # colour codes are stripped too: a runner may force colour
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
echo "SHA=$(git rev-parse HEAD) HOST=$(hostname) START=$(date -u +%FT%TZ)"
$CMD >"$MDIR/control.out" 2>&1 </dev/null || { echo "CONTROLRED rc=$? see $MDIR/control.out"; exit 2; }
echo "CONTROL green"
bad=0; n=0
for M in "$MDIR"/*/manifest.tsv; do
  [ -f "$M" ] || continue
  L=$(dirname "$M"); lane=$(basename "$L")
  while IFS=$'\t' read -r id patch testfiles pattern contract refs || [ -n "${id:-}" ]; do
    case "$id" in (''|\#*|id) continue ;; esac
    n=$((n + 1)); P="$L/$patch"
    files=$(git apply --numstat "$P" 2>/dev/null | awk '{print $3}')
    if [ -z "$files" ] || ! before=$(sha $files) || ! git apply "$P" 2>"$L/$id.apply.err"; then
      echo "APPLYFAIL $lane $id patch=$patch (see $id.apply.err if present)"; bad=1; continue
    fi
    if [ "$pattern" = "-" ]; then $CMD $testfiles; else $CMD $testfiles "$PFLAG" "$pattern"; fi >"$L/$id.out" 2>&1 </dev/null
    rc=$?
    git apply -R "$P" 2>"$L/$id.revert.err"; rrc=$?
    after=$(sha $files)
    if [ "$rrc" -ne 0 ] || [ "$before" != "$after" ]; then
      echo "RESTOREFAIL $lane $id files=[$files] see $L/$id.revert.err"; exit 3
    fi
    red=$(sed "s/$ESC\[[0-9;]*m//g" "$L/$id.out" | grep -E "$RED_RE" | head -n 1 | tr -s ' ')
    if [ "$rc" -ne 0 ] && [ -n "$red" ]; then v=CAUGHT; elif [ "$rc" -ne 0 ]; then v=NOPROOF; bad=1; else v=SURVIVED; bad=1; fi
    echo "$v $lane $id rc=$rc restore=OK [$red] files=[$files] refs=$refs"
  done <"$M"
done
[ "$n" -gt 0 ] || { echo "NOMUTATIONS in $MDIR"; bad=1; }
echo "END=$(date -u +%FT%TZ) mutations=$n"; git status --porcelain
exit "$bad"
