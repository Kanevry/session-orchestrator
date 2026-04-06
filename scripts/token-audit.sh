#!/usr/bin/env bash
# Token Audit — Quick ecosystem-wide token efficiency check
# Usage: bash scripts/token-audit.sh [projects_dir]
# Runs standalone without a Claude session. Reports CLAUDE.md sizes,
# .claude/ hygiene, .claudeignore coverage, and plugin mismatches.

set -euo pipefail

PROJECTS_DIR="${1:-$HOME/Projects}"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo "=== Token Audit Report ==="
echo "Date: $(date +%Y-%m-%d)"
echo "Projects: $PROJECTS_DIR"
echo ""

# ── 1. CLAUDE.md Sizes ──────────────────────────────────────────────
echo -e "${CYAN}## CLAUDE.md Sizes${NC} (flagged if > 150 lines)"
echo ""

declare -a high_items=()
declare -a warn_items=()
total_lines=0
project_count=0

for dir in "$PROJECTS_DIR"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    # Skip non-project dirs
    [[ "$name" == "Archives" || "$name" == "Videos" || "$name" == "n8n" ]] && continue

    claude_md="$dir/CLAUDE.md"
    if [ -f "$claude_md" ]; then
        lines=$(wc -l < "$claude_md" | tr -d ' ')
        total_lines=$((total_lines + lines))
        project_count=$((project_count + 1))

        if [ "$lines" -gt 250 ]; then
            echo -e "  ${RED}[HIGH]${NC} $name: ${lines} lines"
            high_items+=("$name")
        elif [ "$lines" -gt 150 ]; then
            echo -e "  ${YELLOW}[WARN]${NC} $name: ${lines} lines"
            warn_items+=("$name")
        fi
    fi
done

if [ ${#high_items[@]} -eq 0 ] && [ ${#warn_items[@]} -eq 0 ]; then
    echo -e "  ${GREEN}[OK]${NC} All CLAUDE.md files under 150 lines"
fi
echo ""
echo "  Total: $total_lines lines across $project_count projects (avg: $((total_lines / (project_count > 0 ? project_count : 1))))"
echo ""

# ── 2. .claude Directory Sizes ───────────────────────────────────────
echo -e "${CYAN}## .claude Directory Sizes${NC} (flagged if > 10MB)"
echo ""

has_bloat=false
for dir in "$PROJECTS_DIR"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    claude_dir="$dir/.claude"
    if [ -d "$claude_dir" ]; then
        size_kb=$(du -sk "$claude_dir" 2>/dev/null | cut -f1)
        size_mb=$((size_kb / 1024))
        if [ "$size_mb" -gt 50 ]; then
            echo -e "  ${RED}[HIGH]${NC} $name: ${size_mb}MB"
            has_bloat=true
        elif [ "$size_mb" -gt 10 ]; then
            echo -e "  ${YELLOW}[WARN]${NC} $name: ${size_mb}MB"
            has_bloat=true
        fi
    fi
done

if [ "$has_bloat" = false ]; then
    echo -e "  ${GREEN}[OK]${NC} All .claude directories under 10MB"
fi
echo ""

# ── 3. Missing .claudeignore ─────────────────────────────────────────
echo -e "${CYAN}## Missing .claudeignore${NC}"
echo ""

missing_ignore=()
for dir in "$PROJECTS_DIR"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    [[ "$name" == "Archives" || "$name" == "Videos" || "$name" == "n8n" ]] && continue

    if [ -f "$dir/CLAUDE.md" ] && [ ! -f "$dir/.claudeignore" ]; then
        # Check if project has enough files to warrant .claudeignore
        file_count=$(find "$dir" -maxdepth 3 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')
        if [ "$file_count" -gt 200 ]; then
            missing_ignore+=("$name ($file_count files)")
        fi
    fi
done

if [ ${#missing_ignore[@]} -gt 0 ]; then
    for item in "${missing_ignore[@]}"; do
        echo -e "  ${YELLOW}[WARN]${NC} $item"
    done
else
    echo -e "  ${GREEN}[OK]${NC} All active projects have .claudeignore"
fi
echo ""

# ── 4. Plugin Configuration ──────────────────────────────────────────
echo -e "${CYAN}## Plugin Check${NC}"
echo ""

if [ -f "$CLAUDE_SETTINGS" ]; then
    # Check for swift-lsp with no Swift files
    if grep -q '"swift-lsp.*true' "$CLAUDE_SETTINGS" 2>/dev/null; then
        swift_count=$(find "$PROJECTS_DIR" -maxdepth 3 -name "*.swift" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$swift_count" -eq 0 ]; then
            echo -e "  ${YELLOW}[WARN]${NC} swift-lsp enabled but no .swift files found"
        fi
    fi

    # Count enabled plugins
    plugin_count=$(grep -c ': true' "$CLAUDE_SETTINGS" 2>/dev/null || echo "0")
    echo "  Enabled plugins: $plugin_count"
fi
echo ""

# ── 5. Environment Variables ──────────────────────────────────────────
echo -e "${CYAN}## Token Optimization Env Vars${NC}"
echo ""

if [ -n "${MAX_THINKING_TOKENS:-}" ]; then
    echo -e "  ${GREEN}[OK]${NC} MAX_THINKING_TOKENS=$MAX_THINKING_TOKENS"
else
    echo -e "  ${YELLOW}[WARN]${NC} MAX_THINKING_TOKENS not set (uncapped thinking token burn)"
fi

if [ -n "${CLAUDE_CODE_SUBAGENT_MODEL:-}" ]; then
    echo -e "  ${GREEN}[OK]${NC} CLAUDE_CODE_SUBAGENT_MODEL=$CLAUDE_CODE_SUBAGENT_MODEL"
else
    echo "  [INFO] CLAUDE_CODE_SUBAGENT_MODEL not set (using per-skill model-preference)"
fi
echo ""

# ── 6. User-level CLAUDE.md ──────────────────────────────────────────
echo -e "${CYAN}## User-level Config${NC}"
echo ""

if [ -f "$HOME/.claude/CLAUDE.md" ]; then
    user_lines=$(wc -l < "$HOME/.claude/CLAUDE.md" | tr -d ' ')
    echo -e "  ${GREEN}[OK]${NC} ~/.claude/CLAUDE.md exists ($user_lines lines)"
else
    echo -e "  ${YELLOW}[WARN]${NC} No ~/.claude/CLAUDE.md — cross-project patterns may be duplicated"
fi
echo ""

echo "=== End of Report ==="
