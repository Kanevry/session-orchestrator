---
description: Use this skill when the user wants to reconcile learnings into rules, run /reconcile, propose rules from learnings, turn learnings into .claude/rules/ entries, or review what rules would be generated from current session learnings. On-demand version of session-end Phase 3.6.8.
argument-hint: "[--dry-run]"
---

# /reconcile

Use the Session Orchestrator skill definition at `skills/reconcile/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
