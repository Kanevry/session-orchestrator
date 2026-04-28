---
description: Run a 9-category baseline compliance audit on the current repository
argument-hint: ""
---

# Repo Audit

The user wants to audit the current repository against the ecosystem baseline. There are no arguments.

Invoke `skills/repo-audit/SKILL.md` to perform the audit.

The skill will:
1. Read Session Config to resolve `test-command`, `typecheck-command`, and `lint-command` (falls back to `pnpm test --run`, `tsgo --noEmit`, `pnpm lint`)
2. Detect Clank integration markers (`.clank/`, `clank.config.*`) — Category 8 is skipped if absent
3. Run all 9 audit categories with status: ✓ pass / ✗ fail / ⚠ warn / skipped
4. Emit a structured Markdown report to stdout
5. Write a JSON sidecar to `.orchestrator/metrics/repo-audit-<timestamp>.json`

Do NOT skip any category (except Clank when not detected). Do NOT auto-fix findings — report only.

Distinguish from related commands:
- `/discovery` — broad quality probes, interactive triage, creates issues
- `/harness-audit` — plugin installation health (is session-orchestrator installed correctly?)
- `/repo-audit` — consuming-repo compliance (does this repo match the ecosystem baseline?)
