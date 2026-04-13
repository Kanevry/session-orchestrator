#!/usr/bin/env bash
# codex-install.sh — Install Session Orchestrator into the active Codex plugin catalog
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SO_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_jq

PLUGIN_NAME="session-orchestrator"
CODEx_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
ACTIVE_SYNC_ROOT="${CODEX_HOME:-$HOME/.codex}/.tmp/plugins"
ACTIVE_MARKETPLACE="$ACTIVE_SYNC_ROOT/.agents/plugins/marketplace.json"
ACTIVE_PLUGIN_DIR="$ACTIVE_SYNC_ROOT/plugins/$PLUGIN_NAME"
FALLBACK_MARKETPLACE="$HOME/.agents/plugins/marketplace.json"
FALLBACK_PLUGIN_DIR="$HOME/plugins/$PLUGIN_NAME"

USE_ACTIVE_SYNC=false
MARKETPLACE_PATH=""
PLUGIN_DEST=""
MARKETPLACE_NAME=""

if [[ -f "$ACTIVE_MARKETPLACE" && -d "$ACTIVE_SYNC_ROOT/plugins" ]]; then
  USE_ACTIVE_SYNC=true
  MARKETPLACE_PATH="$ACTIVE_MARKETPLACE"
  PLUGIN_DEST="$ACTIVE_PLUGIN_DIR"
  MARKETPLACE_NAME="$(jq -r '.name // "openai-curated"' "$ACTIVE_MARKETPLACE")"
else
  MARKETPLACE_PATH="$FALLBACK_MARKETPLACE"
  PLUGIN_DEST="$FALLBACK_PLUGIN_DIR"
  MARKETPLACE_NAME="local"
fi

mkdir -p "$(dirname "$MARKETPLACE_PATH")" "$(dirname "$PLUGIN_DEST")" "$PLUGIN_DEST"

echo "Session Orchestrator — Codex Setup"
echo "================================="
echo ""
echo "Source:      $SO_ROOT"
echo "Destination: $PLUGIN_DEST"
echo "Marketplace: $MARKETPLACE_PATH"
echo "Catalog:     $MARKETPLACE_NAME"
echo ""

rsync -a \
  --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .claude \
  --exclude .codex \
  --exclude .cursor \
  --exclude .orchestrator \
  --exclude coverage \
  --exclude dist \
  "$SO_ROOT/" "$PLUGIN_DEST/"

if [[ ! -f "$MARKETPLACE_PATH" ]]; then
  cat > "$MARKETPLACE_PATH" <<JSON
{
  "name": "$MARKETPLACE_NAME",
  "interface": {
    "displayName": "Local Plugins"
  },
  "plugins": []
}
JSON
fi

tmp_marketplace="$(mktemp)"
jq --arg plugin "$PLUGIN_NAME" '
  .plugins |= (
    map(select(.name != $plugin)) + [
      {
        "name": $plugin,
        "source": {
          "source": "local",
          "path": ("./plugins/" + $plugin)
        },
        "policy": {
          "installation": "AVAILABLE",
          "authentication": "ON_INSTALL"
        },
        "category": "Coding"
      }
    ]
  )
' "$MARKETPLACE_PATH" > "$tmp_marketplace"
mv "$tmp_marketplace" "$MARKETPLACE_PATH"

mkdir -p "$(dirname "$CODEx_CONFIG")"
touch "$CODEx_CONFIG"

CONFIG_KEY="$PLUGIN_NAME@$MARKETPLACE_NAME"
tmp_config="$(mktemp)"
awk -v section="[plugins.\"$CONFIG_KEY\"]" '
  BEGIN {
    in_target = 0
    seen = 0
    wrote_enabled = 0
  }
  $0 == section {
    print
    in_target = 1
    seen = 1
    next
  }
  /^\[plugins\."/ {
    if (in_target && !wrote_enabled) {
      print "enabled = true"
      wrote_enabled = 1
    }
    in_target = 0
  }
  {
    if (in_target && $0 ~ /^enabled = /) {
      print "enabled = true"
      wrote_enabled = 1
      next
    }
    print
  }
  END {
    if (in_target && !wrote_enabled) {
      print "enabled = true"
    }
    if (!seen) {
      print ""
      print section
      print "enabled = true"
    }
  }
' "$CODEx_CONFIG" > "$tmp_config"
mv "$tmp_config" "$CODEx_CONFIG"

echo "Done."
echo ""
if [[ "$USE_ACTIVE_SYNC" == "true" ]]; then
  echo "Installed into the active Codex desktop sync catalog."
else
  echo "Installed into the fallback local Codex marketplace."
fi
echo "Restart Codex completely to reload plugin commands."
