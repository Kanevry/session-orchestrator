---
description: Run a 4-phase systematic debugging investigation before proposing any fix. Iron Law — NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST. Produces a `.orchestrator/debug/` artifact the fixer agent must reference.
argument-hint: "[bug-description-or-issue-ref]"
---

# /debug

Use the Session Orchestrator command definition at `commands/debug.md`.

Arguments: $@

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
