---
description: Run a lightweight Socratic design dialogue (3-5 AUQ rounds) and write a spec markdown file before any implementation work. Use BEFORE /plan feature when scope/UX is ambiguous.
argument-hint: [topic-or-feature-slug]
---

# /brainstorm

Use the Session Orchestrator command definition at `commands/brainstorm.md`.

Arguments: $ARGUMENTS

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the command says to invoke a skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
