---
name: quality-gates
user-invocable: false
description: >
  Canonical quality check commands for typecheck, test, and lint.
  Defines 4 variants (Baseline, Incremental, Full Gate, Per-File) used by
  session-start, wave-executor, session-end, and session-reviewer.
  Reference skill — not invoked directly.
---

# Quality Gates — Reference Skill

This skill defines the canonical quality check commands. Do NOT invoke this skill directly.
Consuming skills (session-start, wave-executor, session-end, session-reviewer) reference the
variant they need and execute the commands inline.

## Session Config Fields

Read these from the project's `## Session Config` section in CLAUDE.md:

- **`test-command`** — Custom test command. Default: `pnpm test --run`
- **`typecheck-command`** — Custom typecheck command. Default: `tsgo --noEmit`
- **`lint-command`** — Custom lint command. Default: `pnpm lint`

If a field is missing, use the default. If set to `skip`, skip that check entirely.

## Variant 1: Baseline

**Used by:** session-start (Phase 3)
**Purpose:** Quick health check at session start — non-blocking.

Commands:
1. Run `{typecheck-command} 2>&1 | tail -5`
2. Run `{test-command} 2>&1 | tail -5`

Behavior: Report results but do NOT block the session. Capture error counts and store them
as the session baseline for later comparison.

## Variant 2: Incremental

**Used by:** wave-executor (after implementation waves)
**Purpose:** Verify implementation waves did not break anything.

Commands:
1. Run `{test-command}` on changed files only (e.g., `pnpm test -- <changed-test-files>`).
2. Run `{typecheck-command}`.

Behavior: Report failures. If issues are found, add fix tasks to the next wave automatically.
Do not block wave progression — let the next wave address regressions.

## Variant 3: Full Gate

**Used by:** session-end (Phase 2)
**Purpose:** Final quality gate before commit — MUST pass.

Commands:
1. Run `{typecheck-command}` — must produce 0 errors.
2. Run `{test-command}` — must pass (exit code 0).
3. Run `{lint-command}` — must pass (warnings OK, errors NOT OK).
4. Check changed files for debug artifacts: `console.log`, `debugger`, `TODO: remove`.

Behavior: BLOCKING. Do not commit if any check fails. Fix quick issues (<2 min) inline.
For anything longer, create a `priority:high` issue and proceed without committing the
affected files.

## Variant 4: Per-File

**Used by:** session-reviewer agent
**Purpose:** Targeted quality check on specific changed files.

Commands:
1. Run `{test-command}` on specific file paths passed by the reviewer.
2. Run `{typecheck-command}`.

Behavior: Report per-file pass/fail status. The reviewer uses these results to annotate
its review output.

## Graceful Degradation

Handle missing tools without failing the session:

- If `{typecheck-command}` fails with "command not found" → skip TypeScript checks, note "No TypeScript configured".
- If `{test-command}` fails with "command not found" → skip tests, note "No test runner configured".
- If `{lint-command}` fails with "command not found" → skip lint, note "No linter configured".
- Non-TypeScript projects should set `typecheck-command: skip` in Session Config.

Always continue with the remaining checks — never abort a variant because one tool is missing.

## How Other Skills Reference This

When a consuming skill needs quality checks, include this directive:

> **Quality Reference:** Run [Baseline|Incremental|Full Gate|Per-File] quality checks
> per the quality-gates skill. Read `test-command`, `typecheck-command`, and `lint-command`
> from Session Config (defaults: `pnpm test --run`, `tsgo --noEmit`, `pnpm lint`).

Replace the bracketed variant name with the specific variant required by that phase.
