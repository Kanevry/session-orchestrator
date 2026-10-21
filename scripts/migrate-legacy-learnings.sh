#!/usr/bin/env bash
set -euo pipefail
# Migrate learnings from platform-specific paths (.claude/.codex/.cursor) to the
# canonical .orchestrator/metrics/learnings.jsonl. Idempotent; backs up each
# legacy file as <path>.migrated-YYYY-MM-DD.bak.

ROOT="${1:-$(pwd)}"
CANONICAL="$ROOT/.orchestrator/metrics/learnings.jsonl"
TODAY="$(date +%Y-%m-%d)"

# #1516: a host whose learnings-store role is `inbox` never rewrites the
# canonical store. The role resolver is the JS one (env SO_LEARNINGS_STORE_ROLE
# > owner.yaml learnings.store-role > writer), imported relative to this script.
# Fail-closed: if node fails, or the role is `invalid` (set but unusable) or
# anything other than writer/inbox, nothing is written and the script exits 4.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STORE_ROLE="$(node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const m = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(m.resolveStoreRole().role);
' "$SCRIPT_DIR/lib/learnings/store-role.mjs" 2>/dev/null)" || STORE_ROLE="unresolved"
if [ "$STORE_ROLE" = "inbox" ]; then
  echo "migrate-legacy-learnings: learnings store role is inbox on this host (#1516) — nothing written; run it on the writer host" >&2
  printf '{"status":"refused_store_role"}\n'
  exit 3
fi
if [ "$STORE_ROLE" != "writer" ]; then
  echo "migrate-legacy-learnings: learnings store role is ${STORE_ROLE} on this host (#1516) — nothing written; fix owner.yaml learnings.store-role or SO_LEARNINGS_STORE_ROLE" >&2
  printf '{"status":"refused_store_role_invalid"}\n'
  exit 4
fi
LEGACY_PATHS=("$ROOT/.claude/metrics/learnings.jsonl" "$ROOT/.codex/metrics/learnings.jsonl" "$ROOT/.cursor/metrics/learnings.jsonl")

tmp=""
cleanup() { [[ -n "$tmp" && -f "$tmp" ]] && rm -f "$tmp"; [[ -f "${CANONICAL}.tmp" ]] && rm -f "${CANONICAL}.tmp"; return 0; }
trap cleanup EXIT

existing_legacy=()
for p in "${LEGACY_PATHS[@]}"; do [[ -f "$p" ]] && existing_legacy+=("$p"); done

canonical_before=0
[[ -f "$CANONICAL" ]] && canonical_before=$(wc -l < "$CANONICAL" | tr -d ' ')

if [[ ${#existing_legacy[@]} -eq 0 ]]; then
  printf '{"canonical_before":%d,"legacy":0,"canonical_after":%d,"backup":null,"status":"no_legacy"}\n' \
    "$canonical_before" "$canonical_before"
  exit 0
fi

legacy_total=0
for p in "${existing_legacy[@]}"; do legacy_total=$(( legacy_total + $(wc -l < "$p" | tr -d ' ') )); done

# Dedupe contract: collapse by id (keep one), then by (type, subject) keeping the
# entry with higher confidence — created_at breaks ties (later wins).
DEDUP_JQ='group_by(.id) | map(max_by(.confidence))
  | group_by([.type, .subject])
  | map(if length == 1 then .[0] else sort_by(.confidence, .created_at) | last end)
  | .[]'

mkdir -p "$(dirname "$CANONICAL")"
tmp="$CANONICAL.merge.tmp"
: > "$tmp"
[[ -f "$CANONICAL" ]] && cat "$CANONICAL" >> "$tmp"
for p in "${existing_legacy[@]}"; do cat "$p" >> "$tmp"; done
jq -sc "$DEDUP_JQ" "$tmp" > "$CANONICAL.tmp"
mv "$CANONICAL.tmp" "$CANONICAL"
rm -f "$tmp"
canonical_after=$(wc -l < "$CANONICAL" | tr -d ' ')

# Back up each legacy file, then emit the list as a JSON array
bak_list=()
for p in "${existing_legacy[@]}"; do
  bak="${p}.migrated-${TODAY}.bak"
  mv "$p" "$bak"
  bak_list+=("$bak")
done
bak_json=$(printf '%s\n' "${bak_list[@]}" | jq -Rs 'split("\n") | map(select(. != ""))')

status="merged"
[[ "$canonical_before" -eq 0 ]] && status="copied"

printf '{"canonical_before":%d,"legacy":%d,"canonical_after":%d,"backup":%s,"status":"%s"}\n' \
  "$canonical_before" "$legacy_total" "$canonical_after" "$bak_json" "$status"
