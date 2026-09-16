---
description: "Use when the user wants a plan, design, or PRD stress-tested before any build — relentlessly interrogates one decision at a time, grounds every question in the codebase, hunts contradictions against the domain language and the code, and challenges the load-bearing assumptions. Triggered by \"grill me\", \"stress-test this plan\", \"poke holes in my design\". Composable — run standalone or as an adversarial pass before /plan feature."
argument-hint: "[file-path-or-topic]"
---

# /grill

Use the Session Orchestrator skill definition at `skills/grill/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
