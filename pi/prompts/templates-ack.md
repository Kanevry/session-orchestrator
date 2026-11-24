---
description: "Acknowledge templates-first policy for the current session — bypasses the pre-bash-templates-first hook for the remainder of the session"
argument-hint: "[optional-reason]"
---

# /templates-ack

Read `commands/templates-ack.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
