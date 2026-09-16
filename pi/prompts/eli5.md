---
description: "Explain a topic like I'm a 5 year old — restate my last output, or a named topic, in plain words without dropping a single fact. Use when the user types /eli5 [topic], or says an answer was too technical, too long, or unclear about what he now has to do."
argument-hint: "[topic]"
---

# /eli5

Use the Session Orchestrator skill definition at `skills/eli5/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
