---
description: Plan a new project, feature, or retrospective with structured requirement gathering
disable-model-invocation: true
argument-hint: "[new|feature|retro]"
---

# Plan

You are beginning a structured planning session. The user has invoked `/plan` with mode: **$ARGUMENTS** (if empty, ask the user which mode they want: `new`, `feature`, or `retro`).

**Modes:** `new` = project kickoff, `feature` = feature PRD, `retro` = retrospective.

**Your job: Guide the user through structured requirement gathering and produce a complete plan document for the chosen mode.**

**Invoke the plan skill.** Follow its instructions precisely. Do NOT skip any phase. Do NOT make assumptions — gather requirements interactively.

## Headless (`claude -p`)

`session` and `plan` are **reserved terminal-only built-in names** in non-interactive sessions — under `claude -p` the bare form answers `"/plan isn't available in this environment."`, and no frontmatter or manifest field overrides that (reproduced with an empty `CLAUDE_CONFIG_DIR` and no plugin loaded, claude 2.1.273, measured 2026-09-16). Use the namespaced form, which does resolve:

```bash
claude -p "/session-orchestrator:plan feature" --plugin-dir "$PWD"
```

Interactive sessions are unaffected — `/plan` works there as it always has.
