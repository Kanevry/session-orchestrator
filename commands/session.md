---
description: Start a development session (housekeeping, feature, deep)
allowed-tools: Bash, Read, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate, WebSearch, WebFetch
argument-hint: [housekeeping|feature|deep]
---

# Session Start

You are beginning a new development session. The user has invoked `/session` with type: **$ARGUMENTS** (if empty, auto-detect from CLAUDE.md `## Session Config` or default to `feature`).

**Your job: Autonomously research the full project state, then present structured findings with recommendations for the user to approve before creating a wave plan.**

Follow the session-start skill instructions precisely. Do NOT skip any phase. Do NOT make assumptions — verify everything in code and on GitLab.
