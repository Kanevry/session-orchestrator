---
description: "Use when you have a PRD or design spec and need a bite-sized, executable implementation plan that any agent can follow without re-deriving structure. Produces `docs/plans/YYYY-MM-DD-<feature>.md` with per-task Files block, complete code per step (no placeholders), and exact verification commands. Rejects \"TBD\", \"TODO\", \"add error handling\", \"similar to Task N\"."
---

# /write-executable-plan

Use the Session Orchestrator skill definition at `skills/write-executable-plan/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
