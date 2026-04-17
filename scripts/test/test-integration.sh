#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=helpers.sh
source "$SCRIPT_DIR/helpers.sh"

# shellcheck source=test-config-gates.sh
source "$SCRIPT_DIR/test-config-gates.sh"

# shellcheck source=test-wave-enforcement.sh
source "$SCRIPT_DIR/test-wave-enforcement.sh"

# shellcheck source=test-metrics.sh
source "$SCRIPT_DIR/test-metrics.sh"

# shellcheck source=test-agents-config.sh
source "$SCRIPT_DIR/test-agents-config.sh"

# shellcheck source=test-learnings.sh
source "$SCRIPT_DIR/test-learnings.sh"

# shellcheck source=test-grounding-injection.sh
source "$SCRIPT_DIR/test-grounding-injection.sh"

# ===========================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] || exit 1
