---
description: "Use when encountering any bug, test failure, build break, or unexpected behavior — runs a 4-phase systematic debugging process before proposing any fix. Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST. Produces a `.orchestrator/debug/` artifact the fixer agent must reference."
argument-hint: "[bug-description-or-issue-ref]"
---

# /debug

Use the Session Orchestrator skill definition at `skills/debug/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
