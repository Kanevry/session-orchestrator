---
description: "Use when extracting a project into its own repo — a venture spinout (e.g. a product leaving its incubator repo) or a sanitized content-snapshot fork. Guided 5-step runbook: target sphere + path, confidentiality/sanitize check, copy + fresh git init, SNAPSHOT-FREEZE marker in the source repo, remotes + registration. Trigger on 'spin out X', 'extract this into its own repo', 'fork X sanitized'."
argument-hint: "[--type venture|snapshot] [--dry-run]"
---

# /spinout

Use the Session Orchestrator skill definition at `skills/spinout/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
