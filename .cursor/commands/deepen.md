---
description: "Make a task deeper, not bigger. Use when the user asks for a deeper or more ambitious version of a task (tiefer, geh tiefer, go deeper, ambitionierter, wie würde ein Profi das angehen) or hands over an outcome-shaped deliverable (Bericht, Auswertung, Analyse, Plan, Audit, Deck, Performance-Ziel) with no ceiling word, or types /deepen [task]. Not for single-step edits, short commands (run the tests, commit), bug fixes, prompt-wording rewrites, or any request carrying nur, bloß, schnell, just, only, quick."
argument-hint: "[task]"
---

# /deepen

Use the Session Orchestrator skill definition at `skills/deepen/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
