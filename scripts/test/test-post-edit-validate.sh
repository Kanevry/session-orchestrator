#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../../hooks/post-edit-validate.sh"

# Workaround: macOS BSD date doesn't support %3N (nanoseconds).
# The hook uses date +%s%3N which outputs literal "N" on macOS, causing
# arithmetic errors. Create a thin wrapper that delegates to gdate if available.
SHIM_DIR=$(mktemp -d)
trap 'rm -rf "$SHIM_DIR"' EXIT
cat > "$SHIM_DIR/date" <<'DATESHIM'
#!/usr/bin/env bash
# If any arg contains %3N and gdate exists, use gdate; otherwise fall back to real date
for arg in "$@"; do
  if [[ "$arg" == *"%3N"* ]]; then
    if command -v gdate &>/dev/null; then
      exec gdate "$@"
    else
      # Fallback: strip %3N → use seconds with 000 appended
      new_args=()
      for a in "$@"; do
        new_args+=("${a//%3N/000}")
      done
      exec /usr/bin/date "${new_args[@]}"
    fi
  fi
done
exec /usr/bin/date "$@"
DATESHIM
chmod +x "$SHIM_DIR/date"

# Prepend shim so the hook picks up our date wrapper
export PATH="$SHIM_DIR:$PATH"

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

assert_exit() {
  local label="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" > /dev/null 2>&1 || actual_code=$?
  assert_eq "$label" "$expected_code" "$actual_code"
}

# ---------------------------------------------------------------------------
echo "=== Test Group 1: Non-Edit/Write Tools Exit 0 ==="

assert_exit "Bash tool exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Bash","tool_input":{"command":"ls"}}'"'"' | bash "'"$HOOK"'"'

assert_exit "Read tool exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Read","tool_input":{"file_path":"foo.ts"}}'"'"' | bash "'"$HOOK"'"'

assert_exit "Grep tool exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Grep","tool_input":{"pattern":"TODO"}}'"'"' | bash "'"$HOOK"'"'

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 2: Non-TS Files Exit 0 ==="

assert_exit "Edit on README.md exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Edit","tool_input":{"file_path":"README.md"}}'"'"' | bash "'"$HOOK"'"'

assert_exit "Write on config.json exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Write","tool_input":{"file_path":"config.json"}}'"'"' | bash "'"$HOOK"'"'

assert_exit "Edit on style.css exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Edit","tool_input":{"file_path":"src/style.css"}}'"'"' | bash "'"$HOOK"'"'

assert_exit "Write on script.py exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Write","tool_input":{"file_path":"script.py"}}'"'"' | bash "'"$HOOK"'"'

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 3: Edit/Write on TS Files Exit 0 ==="

assert_exit "Edit on .ts file exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Edit","tool_input":{"file_path":"src/app.ts"}}'"'"' | bash "'"$HOOK"'"'

assert_exit "Write on .tsx file exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Write","tool_input":{"file_path":"src/component.tsx"}}'"'"' | bash "'"$HOOK"'"'

assert_exit "Edit on .js file exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Edit","tool_input":{"file_path":"lib/utils.js"}}'"'"' | bash "'"$HOOK"'"'

assert_exit "Write on .jsx file exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Write","tool_input":{"file_path":"src/App.jsx"}}'"'"' | bash "'"$HOOK"'"'

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 4: Empty/Malformed Input Exit 0 ==="

assert_exit "empty input exits 0" "0" \
  bash -c 'echo "" | bash "'"$HOOK"'"'

assert_exit "non-JSON input exits 0" "0" \
  bash -c 'echo "not json" | bash "'"$HOOK"'"'

assert_exit "empty JSON object exits 0" "0" \
  bash -c 'echo '"'"'{}'"'"' | bash "'"$HOOK"'"'

assert_exit "missing file_path exits 0" "0" \
  bash -c 'echo '"'"'{"tool_name":"Edit","tool_input":{}}'"'"' | bash "'"$HOOK"'"'

# ---------------------------------------------------------------------------
echo ""
echo "=== Test Group 5: Stderr Output Format ==="

# For TS file edits, stderr should contain structured JSON with check/status/file fields
stderr=$(echo '{"tool_name":"Edit","tool_input":{"file_path":"src/app.ts"}}' | bash "$HOOK" 2>&1 >/dev/null || true)

has_check=1
echo "$stderr" | grep -q '"check"' 2>/dev/null && has_check=0
assert_eq "stderr contains check field" "0" "$has_check"

has_typecheck=1
echo "$stderr" | grep -q '"typecheck"' 2>/dev/null && has_typecheck=0
assert_eq "stderr contains typecheck value" "0" "$has_typecheck"

has_status=1
echo "$stderr" | grep -q '"status"' 2>/dev/null && has_status=0
assert_eq "stderr contains status field" "0" "$has_status"

# Non-TS edit should produce no stderr
stderr_md=$(echo '{"tool_name":"Edit","tool_input":{"file_path":"README.md"}}' | bash "$HOOK" 2>&1 >/dev/null || true)
assert_eq "non-TS edit produces no stderr" "" "$stderr_md"

# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
