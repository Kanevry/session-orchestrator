---
description: Guided 5-step venture-spinout / sanitized-fork runbook (copy + fresh-init + SNAPSHOT-FREEZE) — interactive, not scripted
argument-hint: "[--type venture|snapshot] [--dry-run]"
---

# Spinout

The user wants to extract this project (or a sub-path of it) into a new standalone repo — a venture spinout or a sanitized content-snapshot fork. Invoke the `spinout` skill.

## Flags

| Flag | Behavior |
|---|---|
| `--type venture\|snapshot` | Skips the extraction-type question in Phase 1 (`AskUserQuestion`) — still asks for destination path and sphere. |
| `--dry-run` | Runs all 5 phases as a plan-print (target, sanitize checklist, copy plan, freeze-marker draft, remote plan) with no writes. |
