---
description: "Agentic end-to-end test orchestrator — drive web/macOS flows, evaluate UX rubric, reconcile issues"
argument-hint: "[scope|profile-name] [--since <git-ref>] [--full]"
---

# /test

Use the Session Orchestrator skill definition at `skills/test/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
