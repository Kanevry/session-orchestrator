---
description: "Use this skill when performing manual memory consolidation (Dream-equivalent). Reviews, consolidates, and prunes memory files under ~/.claude/projects/*/memory/. Run after major refactors, every 5+ sessions, or when memory quality degrades (broken links, stale references, contradictions, MEMORY.md > 200 lines). Invoke with /memory-cleanup."
argument-hint: "[--dry-run | --apply-pending]"
---

# /memory-cleanup

Use the Session Orchestrator skill definition at `skills/memory-cleanup/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
