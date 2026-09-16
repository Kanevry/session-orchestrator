---
description: Approve session plan and begin wave execution
disable-model-invocation: true
argument-hint: "[optional instructions]"
---

# Execute Session Plan

The user has approved the session plan and invoked `/go` with arguments: **$ARGUMENTS**. Begin execution immediately.

**Invoke the `go` skill** (`skills/go/SKILL.md`). It carries the Express-Path detection branch (coordinator-direct + auto-`/close`) and the standard hand-off to `skills/wave-executor/SKILL.md`, to which `$ARGUMENTS` is forwarded as priority guidance.

Do NOT re-plan. Do NOT re-analyze. Execute the agreed plan NOW with maximum efficiency.
