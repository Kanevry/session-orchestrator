---
description: Systematic quality discovery and issue detection
disable-model-invocation: true
argument-hint: "[all|code|infra|ui|arch|session|audit|vault] [--since <git-ref>] [--full]"
---

# Quality Discovery

The user wants to run systematic quality discovery. Invoke the discovery skill with scope: **$ARGUMENTS** (if empty, default to `all`).

## Argument Parsing

Parse `$ARGUMENTS` before doing anything else. Extract the following flags and tokens in any order:

- `--since <git-ref>` — restrict discovery to files changed since the given git ref (e.g. `HEAD~5`, `main`, a commit hash). Sets `since_ref = <git-ref>`.
- `--full` — explicit full-repo scan. Sets `full_scan = true`.
- Any remaining tokens are treated as scope specifiers (see below).

**Conflict check:** If BOTH `--since` and `--full` are present, stop immediately and report:

```
Error: Cannot use --since with --full. Provide one, not both.
```

Do NOT proceed with discovery when this conflict is present.

**Argument validation:** Valid scopes: `all`, `code`, `infra`, `ui`, `arch`, `session`, `audit`, `vault` (comma-separated for multiple). If any scope is invalid, inform the user: "Invalid scope '[token]'. Valid scopes: all, code, infra, ui, arch, session, audit, vault." and default that token to `all`.

When `--since <git-ref>` is provided, pass `since_ref` to the discovery skill (Phase 3 plumbing — see `skills/discovery/SKILL.md`).

Scan the codebase for quality issues, technical debt, and improvement opportunities within the requested scope.

Do NOT skip the interactive triage phase. Every finding must be confirmed by the user before issue creation. Evidence before assertions.
