#!/usr/bin/env bash
# validator.sh — POSIX wrapper for the vault-sync Phase 1 validator.
#
# Usage:
#   bash validator.sh [VAULT_DIR]
#   VAULT_DIR=/path/to/vault bash validator.sh
#
# Behavior:
#   - Resolves VAULT_DIR from arg 1 or env.
#   - Ensures `node` is available.
#   - Checks that `zod` and `yaml` resolve from this directory. They are
#     runtime dependencies of the ROOT package (package.json `dependencies`),
#     so Node resolves them from the plugin root's node_modules/. Missing →
#     exit 2 with status `setup-required` and the one npm-canonical setup
#     command. Never installs anything itself (#1070 AC3/AC6).
#   - Execs validator.mjs; propagates exit code.
#
# Exit codes (mirror validator.mjs):
#   0 — vault valid (or skipped: no vault)
#   1 — validation errors
#   2 — infrastructure error (missing node, missing validator.mjs,
#       dependencies not installed → status `setup-required`)
#
# Output: JSON report on stdout (machine-readable).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR_MJS="${SCRIPT_DIR}/validator.mjs"

# ── Resolve vault dir ──────────────────────────────────────────────────────
if [[ $# -ge 1 && -n "${1:-}" && "${1:-}" != --* ]]; then
  export VAULT_DIR="$1"
  shift
fi
: "${VAULT_DIR:=$PWD}"

# ── Dependency checks ──────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo '{"status":"infra-error","reason":"node not found in PATH"}' >&2
  exit 2
fi

# Emit the infra-error envelope via node so a path containing a quote or a
# backslash still yields valid JSON (paths travel through env, never through
# the JSON text). Args: reason [detail] [setup].
infra_error() {
  SO_VS_REASON="$1" SO_VS_DETAIL="${2:-}" SO_VS_SETUP="${3:-}" node -e '
    const o = { status: "infra-error", reason: process.env.SO_VS_REASON };
    if (process.env.SO_VS_DETAIL) o.detail = process.env.SO_VS_DETAIL;
    if (process.env.SO_VS_SETUP) o.setup = process.env.SO_VS_SETUP;
    console.error(JSON.stringify(o));' >&2
}

if [[ ! -f "$VALIDATOR_MJS" ]]; then
  infra_error "validator.mjs not found at $VALIDATOR_MJS"
  exit 2
fi

# ── Dependency readiness (no install, no foreign package manager) ─────────
# `zod`/`yaml` come from the root package's `dependencies`; a nested
# skills/vault-sync/node_modules/ is NOT required. Probe resolution from this
# directory instead of testing for a particular node_modules folder, so an npm
# install (deps hoisted above the package) and a plugin checkout both pass.
if ! (cd "$SCRIPT_DIR" && node --input-type=module \
      -e "import.meta.resolve('zod'); import.meta.resolve('yaml');") >/dev/null 2>&1; then
  PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  infra_error "setup-required" "zod/yaml not resolvable from $SCRIPT_DIR" "cd $(printf %q "$PLUGIN_ROOT") && npm ci"
  exit 2
fi

# ── Execute validator ──────────────────────────────────────────────────────
export VAULT_DIR
exec node "$VALIDATOR_MJS" "$@"
