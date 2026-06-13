---
description: Acknowledge templates-first policy for the current session — bypasses the pre-bash-templates-first hook for the remainder of the session
argument-hint: "[optional-reason]"
---

# /templates-ack

Use the Session Orchestrator command definition at `commands/templates-ack.md`.

Arguments: $@

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
