---
description: "Use when you have a feature idea but the scope or UX is still ambiguous — runs a lightweight Socratic design dialogue (3-5 AUQ rounds) and writes a spec markdown file. Use BEFORE /plan feature when product intent needs validation; skip to /plan feature when scope is already clear. HARD-GATE prevents any code work until the design is user-approved."
argument-hint: "[topic-or-feature-slug]"
disable-model-invocation: true
---

# /brainstorm

Use the Session Orchestrator skill definition at `skills/brainstorm/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
