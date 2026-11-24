---
description: "Use when extracting a project into its own repo — a venture spinout (e.g. a product leaving its incubator repo) or a sanitized content-snapshot fork. Guided 5-step runbook: target sphere + path, confidentiality/sanitize check, copy + fresh git init, SNAPSHOT-FREEZE marker in the source repo, remotes + registration. Trigger on 'spin out X', 'extract this into its own repo', 'fork X sanitized'."
argument-hint: "[--type venture|snapshot] [--dry-run]"
---

# /spinout

Read `skills/spinout/SKILL.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
