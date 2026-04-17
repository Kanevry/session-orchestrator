#!/usr/bin/env bats
#
# Tests for scripts/lib/fetch-baseline.sh
# Covers the 4 critical paths documented in fetch-baseline.sh exit-code taxonomy:
#   0 — success (200 or cache fallback)
#   1 — auth failure (401/403) — fatal, never falls back to cache
#   2 — file not found (404, no cache)
#   3 — network/transport failure (no cache)
#
# Prerequisites: brew install bats-core
# Run: bats scripts/tests/fetch-baseline.bats  (from session-orchestrator repo root)

bats_require_minimum_version 1.5.0

FIXTURES="${BATS_TEST_DIRNAME}/fixtures/fetch-baseline"

# ---------------------------------------------------------------------------
# setup: create isolated temp dirs, install a PATH-prepended mock curl,
#        export BASELINE_CACHE_DIR so the sourced module uses our dir,
#        then source the module under test.
# ---------------------------------------------------------------------------
setup() {
  # Temp workspace for each test
  BATS_TMP_DEST="$(mktemp -d)"
  export BATS_TMP_DEST

  # Override cache dir so tests do not touch real .claude/.baseline-cache
  BASELINE_CACHE_DIR="${BATS_TMP_DEST}/.cache"
  export BASELINE_CACHE_DIR

  # Build a mock bin dir and prepend it to PATH
  MOCK_DIR="${BATS_TMP_DEST}/mocks"
  mkdir -p "${MOCK_DIR}"
  export MOCK_DIR
  PATH="${MOCK_DIR}:${PATH}"
  export PATH

  export GITLAB_TOKEN="test-token-do-not-use-in-real-calls"

  # Determine repo root relative to test file
  REPO_ROOT="$(git -C "${BATS_TEST_DIRNAME}" rev-parse --show-toplevel)"
  export REPO_ROOT

  # Source the module under test.
  # fetch-baseline.sh sets -euo pipefail; we re-allow errors after sourcing
  # because BATS tests must be able to call `run` without the shell aborting.
  # shellcheck source=/dev/null
  set +euo pipefail
  source "${REPO_ROOT}/scripts/lib/fetch-baseline.sh"
  set +euo pipefail
}

# ---------------------------------------------------------------------------
# teardown: remove temp dirs created in setup
# ---------------------------------------------------------------------------
teardown() {
  rm -rf "${BATS_TMP_DEST}"
}

# ---------------------------------------------------------------------------
# Helper: install_curl_mock
#
# Installs a curl mock script that:
#   - Parses the -o <output_path> argument and writes $body_file there (200 path)
#   - Prints the HTTP status code to stdout (simulating -w '%{http_code}')
#   - Exits with $exit_code (non-zero simulates transport failure)
#
# Parameters:
#   $1 — http_code  (e.g. 200, 401, 404)
#   $2 — body_file  (path to file whose contents are written to -o target; optional)
#   $3 — exit_code  (curl transport exit code; 0 = success, 7 = connection refused)
# ---------------------------------------------------------------------------
install_curl_mock() {
  local http_code="${1:-200}"
  local body_file="${2:-}"
  local exit_code="${3:-0}"

  cat > "${MOCK_DIR}/curl" <<MOCK
#!/usr/bin/env bash
# Mock curl for fetch-baseline.bats
# Simulates: curl -w '%{http_code}' -o <dest> [other flags] <url>

out_path=""
args=("\$@")
i=0
while [[ \$i -lt \${#args[@]} ]]; do
  case "\${args[\$i]}" in
    -o)
      i=\$(( i + 1 ))
      out_path="\${args[\$i]}"
      ;;
    -o*)
      out_path="\${args[\$i]#-o}"
      ;;
  esac
  i=\$(( i + 1 ))
done

# Simulate transport-level failure (curl exit 7, 6, etc.)
if [[ "${exit_code}" != "0" ]]; then
  echo "mock: simulated transport failure (exit ${exit_code})" >&2
  exit ${exit_code}
fi

# Write body to -o destination if provided
if [[ -n "\${out_path}" ]]; then
  if [[ -n "${body_file}" && -f "${body_file}" ]]; then
    cp "${body_file}" "\${out_path}"
  else
    printf '' > "\${out_path}"
  fi
fi

# Emit HTTP status code on stdout (matches -w '%{http_code}' behaviour)
printf '%s' "${http_code}"
MOCK
  chmod +x "${MOCK_DIR}/curl"
}

# ===========================================================================
# Test 1 — Happy path: 200 OK fetches file and populates cache
# ===========================================================================

@test "200 OK: fetches file to dest and populates cache" {
  install_curl_mock 200 "${FIXTURES}/sample-rule.md" 0

  local dest="${BATS_TMP_DEST}/out.md"
  run fetch_baseline_file 52 ".claude/rules/security.md" main "${dest}"

  # Exit code 0
  [ "${status}" -eq 0 ]

  # Dest file exists and matches fixture
  [ -f "${dest}" ]
  run diff "${dest}" "${FIXTURES}/sample-rule.md"
  [ "${status}" -eq 0 ]

  # Cache directory was created and contains an entry with project id in the name
  [ -d "${BASELINE_CACHE_DIR}" ]
  local cache_entries
  cache_entries=$(ls "${BASELINE_CACHE_DIR}" | grep "52" | wc -l | tr -d ' ')
  [ "${cache_entries}" -eq 1 ]
}

# ===========================================================================
# Test 2 — 401 auth failure: returns 1, does NOT fall back to cache
# ===========================================================================

@test "401 auth failure: returns 1 even when cache is seeded" {
  # Seed cache with a successful fetch first
  install_curl_mock 200 "${FIXTURES}/sample-rule.md" 0
  fetch_baseline_file 52 ".claude/rules/security.md" main "${BATS_TMP_DEST}/prime.md"

  # Confirm cache was seeded
  [ -f "${BATS_TMP_DEST}/prime.md" ]

  # Now simulate 401
  install_curl_mock 401 "" 0

  local dest="${BATS_TMP_DEST}/auth-fail.md"
  run fetch_baseline_file 52 ".claude/rules/security.md" main "${dest}"

  # Must return exit code 1 (auth failure — fatal, no cache fallback)
  [ "${status}" -eq 1 ]

  # Output must mention auth or GITLAB_TOKEN
  [[ "${output}" == *"auth"* ]] || [[ "${output}" == *"GITLAB_TOKEN"* ]]

  # dest must NOT have been written (no cache fallback on 401)
  [ ! -f "${dest}" ]
}

# ===========================================================================
# Test 3 — 404 with no cache: returns 2
# ===========================================================================

@test "404 with no cache: returns 2 and mentions not found" {
  install_curl_mock 404 "" 0

  local dest="${BATS_TMP_DEST}/missing.md"
  run fetch_baseline_file 52 ".claude/rules/security.md" main "${dest}"

  # Exit code 2
  [ "${status}" -eq 2 ]

  # Output must mention "not found" (case insensitive)
  [[ "${output}" == *"not found"* ]] || [[ "${output}" == *"404"* ]]

  # No dest file written
  [ ! -f "${dest}" ]
}

# ===========================================================================
# Test 4 — Network failure with seeded cache: falls back to cache, returns 0
# ===========================================================================

@test "network failure with seeded cache: returns 0 and copies cached content" {
  # Seed cache via successful fetch
  install_curl_mock 200 "${FIXTURES}/sample-rule.md" 0
  fetch_baseline_file 52 ".claude/rules/security.md" main "${BATS_TMP_DEST}/prime.md"

  # Confirm cache entry exists
  local cache_key_file
  cache_key_file=$(ls "${BASELINE_CACHE_DIR}" | grep "52" | head -1)
  [ -n "${cache_key_file}" ]

  # Simulate transport failure: curl exits 7 (failed to connect)
  install_curl_mock 200 "${FIXTURES}/sample-rule.md" 7

  local dest="${BATS_TMP_DEST}/offline-result.md"
  run fetch_baseline_file 52 ".claude/rules/security.md" main "${dest}"

  # Must return 0 (cache fallback success)
  [ "${status}" -eq 0 ]

  # Dest written from cache
  [ -f "${dest}" ]
  run diff "${dest}" "${FIXTURES}/sample-rule.md"
  [ "${status}" -eq 0 ]

  # Output must warn about cache usage
  [[ "${output}" == *"cache"* ]] || [[ "${output}" == *"WARNING"* ]]
}
