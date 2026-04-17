#!/usr/bin/env bash
# scripts/lib/fetch-baseline.sh
#
# Fetch a file from a GitLab project's repository raw endpoint.
# Used by the bootstrap skill to pull canonical baseline files (rules, agents,
# CLAUDE.md snippets) on demand instead of relying on local copies that drift.
#
# Companion to session-orchestrator#110.
#
# Required env vars:
#   GITLAB_TOKEN  — personal access token with read_api or read_repository scope
#
# Optional env vars:
#   GITLAB_HOST     — default: gitlab.gotzendorfer.at
#   BASELINE_REF    — default: main
#   FETCH_TIMEOUT   — default: 10 (seconds)
#   FETCH_RETRIES   — default: 2
#
# Usage:
#   source scripts/lib/fetch-baseline.sh
#   fetch_baseline_file <project_id> <file_path> [ref] <dest>
#
# Example:
#   fetch_baseline_file 52 ".claude/rules/security.md" main /tmp/security.md

set -euo pipefail

# --------------------------------------------------------------------
# Configuration with defaults
# --------------------------------------------------------------------
: "${GITLAB_HOST:=gitlab.gotzendorfer.at}"
: "${BASELINE_REF:=main}"
: "${FETCH_TIMEOUT:=10}"
: "${FETCH_RETRIES:=2}"

# --------------------------------------------------------------------
# Cache configuration
# --------------------------------------------------------------------
# Cache lives at .claude/.baseline-cache/ relative to the repo root.
# Used as offline fallback when fetch fails.

# Resolve repo root for cache path. Allow override via BASELINE_CACHE_DIR.
__fetch_baseline_cache_dir() {
  if [[ -n "${BASELINE_CACHE_DIR:-}" ]]; then
    printf '%s' "$BASELINE_CACHE_DIR"
    return 0
  fi
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  printf '%s/.claude/.baseline-cache' "$root"
}

# --------------------------------------------------------------------
# URL-encode a file path for the GitLab API.
# --------------------------------------------------------------------
__url_encode_path() {
  local raw="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$raw" | jq -sRr @uri
  else
    # Minimal fallback — jq is preferred; if missing, encode slashes only.
    printf '%s' "$raw" | sed 's|/|%2F|g'
  fi
}

# --------------------------------------------------------------------
# Cache key for a (project_id, ref, path) tuple.
# --------------------------------------------------------------------
__cache_key() {
  local project_id="$1" ref="$2" path="$3"
  local sanitized
  sanitized=$(printf '%s' "${project_id}-${ref}-${path}" | tr '/.' '_')
  printf '%s' "$sanitized"
}

# --------------------------------------------------------------------
# Public: fetch_baseline_file <project_id> <file_path> [ref] <dest>
#
# Fetches a single file. On success: writes to dest, also writes to cache.
# On failure: tries cache; if cache hit, copies to dest with a warning.
# Exit codes:
#   0  — success (network or cache)
#   1  — auth failure (401/403) — fatal
#   2  — file not found (404 + no cache) — non-fatal for optional files
#   3  — network/transport failure (timeout, DNS) + no cache
# --------------------------------------------------------------------
fetch_baseline_file() {
  local project_id="$1" file_path="$2"
  local ref dest
  if [[ $# -eq 4 ]]; then
    ref="$3"
    dest="$4"
  else
    ref="$BASELINE_REF"
    dest="$3"
  fi

  if [[ -z "${GITLAB_TOKEN:-}" ]]; then
    echo "ERROR: GITLAB_TOKEN not set — cannot fetch from baseline." >&2
    return 1
  fi

  local cache_dir cache_key cache_file
  cache_dir=$(__fetch_baseline_cache_dir)
  cache_key=$(__cache_key "$project_id" "$ref" "$file_path")
  cache_file="$cache_dir/$cache_key"

  local encoded_path url http_code
  encoded_path=$(__url_encode_path "$file_path")
  url="https://${GITLAB_HOST}/api/v4/projects/${project_id}/repository/files/${encoded_path}/raw?ref=${ref}"

  # Attempt fetch
  local tmp err_log
  tmp=$(mktemp)
  err_log=$(mktemp)
  http_code=$(curl \
    --silent \
    --max-time "$FETCH_TIMEOUT" \
    --retry "$FETCH_RETRIES" --retry-delay 1 \
    -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
    -w '%{http_code}' \
    -o "$tmp" \
    "$url" 2>"$err_log") || {
      # curl exited non-zero (network/transport error) — try cache
      local stderr_msg
      stderr_msg=$(<"$err_log")
      rm -f "$tmp" "$err_log"
      if [[ -f "$cache_file" ]]; then
        echo "WARNING: fetch failed (network error: ${stderr_msg:-unknown}); using cache for $file_path" >&2
        cp "$cache_file" "$dest"
        return 0
      fi
      echo "ERROR: fetch failed and no cache for $file_path (project $project_id, ref $ref): ${stderr_msg:-no error message}" >&2
      return 3
  }
  rm -f "$err_log"  # clean up if curl succeeded

  case "$http_code" in
    200)
      # Success — write to dest + populate cache
      mv "$tmp" "$dest"
      mkdir -p "$cache_dir"
      cp "$dest" "$cache_file"
      return 0
      ;;
    401|403)
      rm -f "$tmp"
      echo "ERROR: auth failed ($http_code) fetching $file_path — check GITLAB_TOKEN scope" >&2
      return 1
      ;;
    404)
      rm -f "$tmp"
      if [[ -f "$cache_file" ]]; then
        echo "WARNING: 404 for $file_path; using cache (file may have been removed from baseline)" >&2
        cp "$cache_file" "$dest"
        return 0
      fi
      echo "ERROR: file not found ($file_path on $ref) and no cache" >&2
      return 2
      ;;
    *)
      rm -f "$tmp"
      if [[ -f "$cache_file" ]]; then
        echo "WARNING: HTTP $http_code for $file_path; using cache" >&2
        cp "$cache_file" "$dest"
        return 0
      fi
      echo "ERROR: HTTP $http_code fetching $file_path — no cache" >&2
      return 3
      ;;
  esac
}

# --------------------------------------------------------------------
# Public: fetch_baseline_files_batch <project_id> <ref> <manifest_file> <dest_dir>
#
# Reads a manifest (one file path per line) and fetches each into dest_dir,
# preserving the relative path. Logs per-file status. Returns 0 if at least
# one file fetched successfully, 1 if every fetch failed.
# --------------------------------------------------------------------
fetch_baseline_files_batch() {
  local project_id="$1" ref="$2" manifest="$3" dest_dir="$4"
  if [[ ! -f "$manifest" ]]; then
    echo "ERROR: manifest not found: $manifest" >&2
    return 1
  fi
  mkdir -p "$dest_dir"

  # Caller can override location; otherwise we write next to the manifest.
  : "${BASELINE_FETCH_SUCCESS_LOG:=${manifest}.success}"
  : > "$BASELINE_FETCH_SUCCESS_LOG"   # truncate

  local successes=0 failures=0 file_path dest
  while IFS= read -r file_path; do
    [[ -z "$file_path" || "$file_path" =~ ^# ]] && continue
    dest="$dest_dir/$file_path"
    mkdir -p "$(dirname "$dest")"
    if fetch_baseline_file "$project_id" "$file_path" "$ref" "$dest"; then
      successes=$((successes + 1))
      printf '%s\n' "$file_path" >> "$BASELINE_FETCH_SUCCESS_LOG"
    else
      failures=$((failures + 1))
    fi
  done < "$manifest"

  echo "fetch-baseline: $successes succeeded, $failures failed" >&2
  [[ $successes -gt 0 ]]
}

# --------------------------------------------------------------------
# Public: write_baseline_fetch_lock <lock_path> <project_id> <ref> <files_json>
#
# Writes a YAML lock file documenting what was fetched.
# files_json must be a JSON array of strings (file paths).
# --------------------------------------------------------------------
write_baseline_fetch_lock() {
  local lock_path="$1" project_id="$2" ref="$3" files_json="$4"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$(dirname "$lock_path")"
  {
    echo "# .claude/.baseline-fetch.lock"
    echo "version: 1"
    echo "project_id: $project_id"
    echo "baseline_ref: $ref"
    echo "fetched_at: $now"
    echo "files:"
    if command -v jq >/dev/null 2>&1; then
      printf '%s\n' "$files_json" | jq -r '.[] | "  - " + .'
    else
      # naive fallback — caller must supply JSON; just echo opaque
      echo "  - <jq required for proper formatting>"
    fi
  } > "$lock_path"
}

# Make this file safe to source AND to invoke directly (for testing)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  # Direct invocation — usage: fetch-baseline.sh <project_id> <file_path> [ref] <dest>
  if [[ $# -lt 3 ]]; then
    echo "Usage: $(basename "$0") <project_id> <file_path> [ref] <dest>" >&2
    exit 1
  fi
  fetch_baseline_file "$@"
fi
