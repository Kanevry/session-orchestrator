#!/usr/bin/env bash
# config-yaml-parser.sh — YAML extraction helpers for parse-config.sh
#
# Sourcing contract:
#   source "$(dirname "$0")/lib/config-yaml-parser.sh"
#
# Functions exported:
#   extract_config_section <file>  — prints the raw ## Session Config block
#   parse_vault_sync <file>        — emits vault-sync JSON object
#
# Dependencies: awk, sed, jq (jq must be available before sourcing)
# Compatible with bash 3.2+

# Extract ## Session Config section (between header and next ## or EOF)
extract_config_section() {
  local file="$1"
  [[ -f "$file" ]] || { echo ""; return; }

  # Use sed to grab lines between "## Session Config" and the next "## " heading (or EOF).
  # - Skip code fence lines (``` alone on a line)
  # - Strip trailing whitespace
  sed -n '/^## Session Config$/,/^## /{
    /^## Session Config$/d
    /^## /d
    p
  }' "$file" | sed '/^```$/d' | sed 's/[[:space:]]*$//'
}

# parse_vault_sync — extract the top-level `vault-sync:` YAML block from
# CLAUDE.md / AGENTS.md (wherever it lives — the block is commonly placed
# inside a markdown code fence outside the `## Session Config` section) and
# emit a JSON object with enabled / mode / vault-dir / exclude.
#
# Defaults: enabled=false, mode="warn", vault-dir=null, exclude=[].
#
# The block is recognized by a line `vault-sync:` (optional trailing spaces)
# starting at column 0. All subsequent lines that begin with whitespace are
# part of the block; the block terminates at the first non-indented line
# (including markdown code-fence closers).
#
# Supported sub-keys:
#   enabled: true|false
#   mode:    hard|warn|off  (trailing `# comment` tolerated)
#   vault-dir: <path>
#   exclude:
#     - "glob-1"
#     - 'glob-2'
#     - glob-3
parse_vault_sync() {
  local file="$1"
  local block
  block="$(awk '
    /^vault-sync:[[:space:]]*$/ { in_block = 1; next }
    in_block {
      if ($0 !~ /^[[:space:]]/) exit
      print
    }
  ' "$file" 2>/dev/null)"

  if [[ -z "$block" ]]; then
    echo '{"enabled":false,"mode":"warn","vault-dir":null,"exclude":[]}'
    return
  fi

  local vs_enabled="false" vs_mode="warn" vs_dir_json="null"
  local tmp_excl
  tmp_excl="$(mktemp "${TMPDIR:-/tmp}/vs-excl.XXXXXX")"
  local in_exclude=0

  while IFS= read -r line; do
    # Strip inline "# comment" and trailing whitespace (preserve leading indent for detection)
    local clean
    clean="$(echo "$line" | sed 's/[[:space:]]*#.*$//;s/[[:space:]]*$//')"
    [[ -z "$clean" ]] && continue

    # Dash-prefixed list item — consume into exclude if currently in that block
    if echo "$clean" | grep -qE '^[[:space:]]+-[[:space:]]+'; then
      if (( in_exclude )); then
        local item
        item="$(echo "$clean" | sed -e 's/^[[:space:]]*-[[:space:]]*//' \
                                    -e 's/^"\(.*\)"$/\1/' \
                                    -e "s/^'\(.*\)'\$/\1/")"
        [[ -n "$item" ]] && printf '%s\n' "$item" >> "$tmp_excl"
      fi
      continue
    fi

    # Any other non-list line ends the exclude block
    in_exclude=0

    # key: value   or   key:
    if echo "$clean" | grep -qE '^[[:space:]]+[a-zA-Z_-]+:'; then
      local k v
      k="$(echo "$clean" | sed -E 's/^[[:space:]]+([a-zA-Z_-]+):.*/\1/')"
      v="$(echo "$clean" | sed -E 's/^[[:space:]]+[a-zA-Z_-]+:[[:space:]]*//')"
      # Strip matching quotes from value
      v="$(echo "$v" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"

      case "$k" in
        enabled)
          case "$(echo "$v" | tr '[:upper:]' '[:lower:]')" in
            true)  vs_enabled="true" ;;
            false) vs_enabled="false" ;;
          esac
          ;;
        mode)
          case "$v" in
            hard|warn|off) vs_mode="$v" ;;
          esac
          ;;
        vault-dir)
          if [[ -n "$v" && "$v" != "none" && "$v" != "null" ]]; then
            vs_dir_json="$(jq -n --arg v "$v" '$v')"
          fi
          ;;
        exclude)
          [[ -z "$v" ]] && in_exclude=1
          ;;
      esac
    fi
  done <<< "$block"

  local vs_exclude_json="[]"
  if [[ -s "$tmp_excl" ]]; then
    vs_exclude_json="$(jq -R -s 'split("\n") | map(select(length>0))' < "$tmp_excl")"
  fi
  rm -f "$tmp_excl"

  jq -n \
    --argjson en "$vs_enabled" \
    --arg mode "$vs_mode" \
    --argjson dir "$vs_dir_json" \
    --argjson excl "$vs_exclude_json" \
    '{enabled:$en, mode:$mode, "vault-dir":$dir, exclude:$excl}'
}
