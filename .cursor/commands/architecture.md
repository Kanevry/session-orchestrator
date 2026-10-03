---
description: Use when the user asks to improve architecture, find refactoring opportunities, surface deepening opportunities, consolidate tightly-coupled modules, or make a codebase more testable and AI-navigable. Surfaces shallow modules and hypothetical seams using a precise vocabulary (Module / Interface / Implementation / Depth / Seam / Adapter / Leverage / Locality from LANGUAGE.md).
---

# /architecture

Use the Session Orchestrator skill definition at `skills/architecture/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
