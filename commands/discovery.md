---
description: Systematic quality discovery and issue detection
allowed-tools: Bash, Read, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate
argument-hint: "[all|code|infra|ui|arch|session]"
---

# Quality Discovery

The user wants to run systematic quality discovery. Invoke the discovery skill with scope: **$ARGUMENTS** (if empty, default to `all`).

Scan the codebase for quality issues, technical debt, and improvement opportunities within the requested scope.

Do NOT skip the interactive triage phase. Every finding must be confirmed by the user before issue creation. Evidence before assertions.
