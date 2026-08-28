---
description: Outside-in product audit as a deep session — 7 read-only roles check what the site promises against what the code does, what a user experiences, what arrives by mail, and what the data says is used. Writes a dossier; needs a per-repo journey-manifest.
argument-hint: [manifest-path]
---

# /journey-audit

Use the Session Orchestrator command definition at `commands/journey-audit.md`.

Arguments: $ARGUMENTS

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the command says to invoke a skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
