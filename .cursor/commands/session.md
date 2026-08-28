---
description: Start a development session (housekeeping, feature, deep)
argument-hint: [housekeeping|feature|deep]
---

# /session

Use the Session Orchestrator command definition at `commands/session.md`.

Arguments: $ARGUMENTS

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the command says to invoke a skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
