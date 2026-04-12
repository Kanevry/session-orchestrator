---
description: Start a development session (housekeeping, feature, deep)
allowed-tools: Bash, Read, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate, WebSearch, WebFetch
argument-hint: [housekeeping|feature|deep]
---

# Session Start

You are beginning a new development session. The user has invoked `/session` with type: **$ARGUMENTS** (if empty, auto-detect from CLAUDE.md `## Session Config` or default to `feature`).

**Argument validation:** Valid session types are `housekeeping`, `feature`, and `deep`. If `$ARGUMENTS` is not empty and does not match any valid type, inform the user: "Invalid session type '$ARGUMENTS'. Valid types: housekeeping, feature, deep." Then auto-detect from CLAUDE.md `## Session Config` or default to `feature`.

**Your job: Autonomously research the full project state, then present structured findings with recommendations for the user to approve before creating a wave plan.**

**Invoke the session-start skill.** Follow its instructions precisely. Do NOT skip any phase. Do NOT make assumptions — verify everything in code and on the VCS platform.
