---
description: "Use this skill when performing manual memory consolidation (Dream-equivalent). Reviews, consolidates, and prunes memory files under ~/.claude/projects/*/memory/. Run after major refactors, every 5+ sessions, or when memory quality degrades (broken links, stale references, contradictions, MEMORY.md > 200 lines). Invoke with /memory-cleanup."
argument-hint: "[--dry-run | --apply-pending]"
---

# /memory-cleanup

Read `skills/memory-cleanup/SKILL.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
