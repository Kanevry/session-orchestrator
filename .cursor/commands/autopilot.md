---
description: Autonomous session-orchestration loop with kill-switches (Phase C-1.b — all 10 kill-switches shipped)
argument-hint: [--headless] [--verbose] [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X] [--dry-run]
---

# /autopilot

Use the Session Orchestrator command definition at `commands/autopilot.md`.

Arguments: $ARGUMENTS

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the command says to invoke a skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
