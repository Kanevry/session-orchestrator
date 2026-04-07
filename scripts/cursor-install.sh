#!/usr/bin/env bash
# cursor-install.sh — Install Session Orchestrator Cursor rules into a project
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SO_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET="${1:-$(pwd)}"

echo "Session Orchestrator — Cursor IDE Setup"
echo "========================================"
echo ""
echo "Source: $SO_ROOT/.cursor/rules/"
echo "Target: $TARGET/.cursor/rules/"
echo ""

# Validate source
if [[ ! -d "$SO_ROOT/.cursor/rules" ]]; then
  echo "ERROR: Source rules not found at $SO_ROOT/.cursor/rules/" >&2
  exit 1
fi

# Create target directory
mkdir -p "$TARGET/.cursor/rules"

# Symlink each .mdc file
COUNT=0
for mdc_file in "$SO_ROOT/.cursor/rules/"*.mdc; do
  [[ ! -f "$mdc_file" ]] && continue
  filename="$(basename "$mdc_file")"
  target_path="$TARGET/.cursor/rules/$filename"

  if [[ -L "$target_path" ]]; then
    echo "  SKIP: $filename (symlink exists)"
  elif [[ -f "$target_path" ]]; then
    echo "  SKIP: $filename (file exists — not overwriting)"
  else
    ln -s "$mdc_file" "$target_path"
    echo "  LINK: $filename"
    ((COUNT++)) || true
  fi
done

echo ""
echo "Done! $COUNT rules linked."
echo ""
echo "Next steps:"
echo "  1. Ensure CLAUDE.md has a '## Session Config' section"
echo "  2. (Optional) Configure hooks in Cursor Settings > Hooks:"
echo "     - afterFileEdit:          $SO_ROOT/hooks/enforce-scope.sh"
echo "     - beforeShellExecution:   $SO_ROOT/hooks/enforce-commands.sh"
echo "  3. Open your project in Cursor and type /session to start!"
