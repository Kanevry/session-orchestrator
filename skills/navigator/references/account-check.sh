#!/usr/bin/env bash
# account-check.sh — account watch: recommend which account this host should run on.
#
# Usage: account-check.sh [--apply]
#
# Runs $NAVIGATOR_ACCOUNT_CMD (must print JSON rows: an array, or {"accounts": [...]}, each row
# {slot, alias?, active, p7, p5, resetAt}) and pipes it into `fleet-decisions.mjs account`.
# Prints ONLY the decision line — raw account rows never reach stdout or stderr (SEC-008).
#
# --apply does not switch. It prints the command that WOULD run via $NAVIGATOR_ACCOUNT_SWITCH_CMD
# and refuses if that variable is unset: a switch affects every session on the host and needs a
# durable owner approval, so this script only ever recommends.
#
# NAVIGATOR_ACCOUNT_CMD is executed as shell code by design: it is operator-owned configuration.
#
# Env (leading/trailing whitespace is trimmed; a whitespace-only value counts as unset):
#   NAVIGATOR_ACCOUNT_CMD         command printing the account rows as JSON (required)
#   NAVIGATOR_ACCOUNT_SWITCH_CMD  switch command, shown with the target appended under --apply
#
# Exit: 0 stay/switch recommended, 1 no usable account, 2 bad input/usage, 3 not measurable.
set -u

apply=0
case "${1:-}" in
  '') ;;
  --apply) apply=1 ;;
  *) echo "usage: account-check.sh [--apply]" >&2; exit 2 ;;
esac

# Trim leading/trailing whitespace.
trim() {
  local v=$1
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  printf '%s' "$v"
}
account_cmd=$(trim "${NAVIGATOR_ACCOUNT_CMD:-}")
switch_cmd=$(trim "${NAVIGATOR_ACCOUNT_SWITCH_CMD:-}")

if [ -z "$account_cmd" ]; then
  echo "account watch: not measurable (NAVIGATOR_ACCOUNT_CMD unset)"
  exit 3
fi

here=$(cd "$(dirname "$0")" && pwd)
rows=$(timeout 40 bash -c "$account_cmd" 2>/dev/null)
cmd_rc=$?
if [ "$cmd_rc" -ne 0 ] || [ -z "$rows" ]; then
  echo "account watch: not measurable (account command failed, rc=$cmd_rc)"
  exit 3
fi

decision=$(printf '%s' "$rows" | node "$here/fleet-decisions.mjs" account 2>/dev/null)
rc=$?
if [ "$rc" -eq 2 ]; then
  echo "account watch: not measurable (account command output is not valid account JSON)"
  exit 2
fi
if { [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; } || [ -z "$decision" ]; then
  echo "account watch: not measurable (decision unavailable, rc=$rc)"
  exit 3
fi
echo "account: $decision"

if [ "$apply" -eq 1 ] && [ "$rc" -eq 0 ]; then
  if [ -z "$switch_cmd" ]; then
    echo "apply refused: NAVIGATOR_ACCOUNT_SWITCH_CMD unset" >&2
    exit 2
  fi
  target=$(printf '%s' "$decision" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);process.stdout.write(d.action==="switch"?String(d.target):"")})')
  if [ -n "$target" ]; then
    echo "would run: $switch_cmd $target (not executed — switching needs a durable owner approval)"
  else
    echo "would run: nothing (stay)"
  fi
fi
exit "$rc"
