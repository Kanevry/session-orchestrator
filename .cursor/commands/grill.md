---
description: Stress-test a plan, design, or PRD before any build — relentless one-question-at-a-time interrogation that hunts contradictions against the code and challenges assumptions. Composable; no HARD-GATE.
argument-hint: [file-path-or-topic]
---

# /grill

Use the Session Orchestrator command definition at `commands/grill.md`.

Arguments: $ARGUMENTS

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the command says to invoke a skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
