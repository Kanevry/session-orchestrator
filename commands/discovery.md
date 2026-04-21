---
description: Systematic quality discovery and issue detection
argument-hint: "[all|code|infra|ui|arch|session|audit]"
---

# Quality Discovery

The user wants to run systematic quality discovery. Invoke the discovery skill with scope: **$ARGUMENTS** (if empty, default to `all`).

**Argument validation:** Valid scopes: `all`, `code`, `infra`, `ui`, `arch`, `session`, `audit` (comma-separated for multiple). If any scope is invalid, inform the user: "Invalid scope '[token]'. Valid scopes: all, code, infra, ui, arch, session, audit." and default that token to `all`.

Scan the codebase for quality issues, technical debt, and improvement opportunities within the requested scope.

Do NOT skip the interactive triage phase. Every finding must be confirmed by the user before issue creation. Evidence before assertions.
