---
description: "Use when encountering any bug, test failure, build break, or unexpected behavior — runs a 4-phase systematic debugging process before proposing any fix. Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST. Produces a `.orchestrator/debug/` artifact the fixer agent must reference."
argument-hint: "[bug-description-or-issue-ref]"
---

# /debug

Read `skills/debug/SKILL.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
