#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=helpers.sh
source "$SCRIPT_DIR/helpers.sh"

# shellcheck source=_group-config-gates.sh
source "$SCRIPT_DIR/_group-config-gates.sh"

# shellcheck source=_group-wave-enforcement.sh
source "$SCRIPT_DIR/_group-wave-enforcement.sh"

# shellcheck source=_group-metrics.sh
source "$SCRIPT_DIR/_group-metrics.sh"

# shellcheck source=_group-agents-config.sh
source "$SCRIPT_DIR/_group-agents-config.sh"

# shellcheck source=_group-learnings.sh
source "$SCRIPT_DIR/_group-learnings.sh"

# shellcheck source=_group-grounding-injection.sh
source "$SCRIPT_DIR/_group-grounding-injection.sh"

# ===========================================================================
echo ""
echo "==========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" -eq 0 ]] || exit 1
