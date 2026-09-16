---
description: Agentic end-to-end test orchestrator — drive web/macOS flows, evaluate UX rubric, reconcile issues
argument-hint: "[scope|profile-name] [--since <git-ref>] [--full]"
---

# Test

Run agentic end-to-end tests against the current project or a named target. The user invoked `/test` with arguments: **$ARGUMENTS**

**Invoke the `test` skill** (`skills/test/SKILL.md`). It carries the argument validation (`--target`, `--profile`, `--dry-run`, `--since`, `--full`), the precedence resolution, the interactive profile AUQ, and the six-argument handoff contract; `skills/test-runner/SKILL.md` owns all further resolution, driver dispatch, evaluation, and issue reconciliation.
