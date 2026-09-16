---
description: "Use this skill when the user wants to audit a repository for baseline compliance, check code quality, security posture, CI/CD setup, testing, documentation, and ecosystem configuration. Runs 9 checklist categories and emits a Markdown report plus JSON sidecar at .orchestrator/metrics/repo-audit-<timestamp>.json. <example>Context: User is in a project repo and wants a baseline compliance check. user: \"/repo-audit\" assistant: \"Running repo-audit across 9 categories — Configuration, Code Quality, Git Hygiene, CI/CD, Testing, Security, Documentation, Clank Integration (optional), and MCP Configuration. Will produce a Markdown checklist report and JSON sidecar.\" <commentary>The user wants a compliance check; this skill is appropriate because it runs all 9 categories with pass/fail/warn/skipped statuses and writes structured output.</commentary></example>"
---

# /repo-audit

Use the Session Orchestrator skill definition at `skills/repo-audit/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
