---
description: Identify unused / near-zero-use / stale skills, agents, and commands as Demote or Retire candidates (read-only; never deletes)
argument-hint: "[--kind skill|agent|command] [--window-days N]"
---

# /sunset-review

Use the Session Orchestrator command definition at `commands/sunset-review.md`.

Arguments: $@

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
