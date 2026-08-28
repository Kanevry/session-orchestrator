---
description: Say the last answer again in plain words — same facts, in the order the operator needs them. Optional topic argument.
argument-hint: [topic]
---

# /eli5

Use the Session Orchestrator command definition at `commands/eli5.md`.

Arguments: $ARGUMENTS

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the command says to invoke a skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
