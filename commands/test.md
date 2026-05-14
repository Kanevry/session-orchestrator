---
description: Agentic end-to-end test orchestrator — drive web/macOS flows, evaluate UX rubric, reconcile issues
argument-hint: "[scope|profile-name]"
---

# Test

Run agentic end-to-end tests against the current project or a named target. The user invoked `/test` with arguments: **$ARGUMENTS**

This command resolves a test target and profile, dispatches the appropriate driver (Playwright for web, Peekaboo for macOS), invokes the `ux-evaluator` agent against the captured artifacts, and reconciles findings with the open issue tracker. All logic lives in `skills/test-runner/SKILL.md` — this file is the user-facing entry point only.

## Argument Validation

Parse `$ARGUMENTS` before doing anything else.

Recognized flags and positional arguments:

- `--target <name>` — explicit target name (e.g. `aiat-pmo-module`, `mail-assistant`). Sets `explicit_target = true`.
- `--profile <name>` — explicit profile name (e.g. `smoke`, `full`, `a11y`, `onboarding`). Sets `explicit_profile = true`.
- `--dry-run` — resolve target and profile, print the dispatch plan, but do NOT invoke any driver or create any issues. Sets `dry_run = true`.
- `[scope]` — any unrecognized positional token is treated as a profile name (same as `--profile <scope>`).

If `$ARGUMENTS` contains an unrecognized flag (i.e. starts with `--` but is not one of the above), inform the user:

```
Unknown flag '<flag>'. Recognized flags: --target <name>, --profile <name>, --dry-run.
```

Then continue with the remaining valid arguments.

## Argument Precedence Resolution

Resolve `target` and `profile` using the following precedence (highest → lowest). Stop at the first rule that produces a value for each variable.

1. **Explicit flags** — `--target <name>` sets `target`; `--profile <name>` sets `profile`. Highest priority. Both may be provided together.
2. **Profile from policy, target explicit** — if only `--target <name>` is provided (no `--profile`), pass `target` to the test-runner skill; the skill resolves the profile from `.orchestrator/policy/test-profiles.json` or its default.
3. **Target from policy, profile explicit** — if only `--profile <name>` is provided (no `--target`), pass `profile` to the test-runner skill; the skill resolves the target via convention-based detection.
4. **Positional token as profile** — if a bare positional argument (no `--` prefix) is present in `$ARGUMENTS`, treat it as `profile`. The test-runner skill resolves the target via convention.
5. **Session Config default** — if the Session Config block contains `test-runner.default-profile`, use that value for `profile`. Target is still resolved by the skill via convention.
6. **Interactive AUQ** — if no target or profile could be resolved from steps 1–5, proceed to the Profile Selection section below before invoking the skill.

## Profile Selection

**Only execute this section when steps 1–5 above produced neither `target` nor `profile`.**

Present the user with a structured choice via `AskUserQuestion`:

```
AskUserQuestion({
  questions: [{
    question: "Which test profile should be run?",
    header: "Test Command: profile selection",
    options: [
      { label: "smoke (Recommended)", description: "Quick sanity pass — key flows, axe critical/serious, console errors." },
      { label: "full", description: "All checks at full depth — slower, used before release." },
      { label: "a11y", description: "Accessibility-focused pass — axe-core exhaustive scan." },
      { label: "onboarding", description: "Onboarding step-count + Liquid Glass conformance checks." }
    ],
    multiSelect: false
  }]
})
```

Set the user's selection as `profile`. The test-runner skill will resolve the target from convention.

## Invoke Test-Runner Skill

**Invoke the test-runner skill.** Follow its instructions precisely.

Read `skills/test-runner/SKILL.md` and execute all phases in order. Do NOT skip Phase 0 (bootstrap gate). Do NOT inline driver artifact content into the coordinator context — all artifacts go to disk under the run directory.

Pass the following handoff contract to the skill entry point.

## Handoff Contract

The five named arguments below are the canonical contract between this command and `skills/test-runner/SKILL.md`. The skill reads them from context; do NOT reconstruct them inside the skill.

| Argument | Type | Value |
|---|---|---|
| `target` | `string \| undefined` | Resolved target name, or `undefined` if not yet known (skill resolves via convention) |
| `profile` | `string \| undefined` | Resolved profile name, or `undefined` if not yet known (skill applies `test-runner.default-profile` or `smoke`) |
| `dry_run` | `boolean` | `true` if `--dry-run` was passed; `false` otherwise |
| `explicit_target` | `boolean` | `true` if `--target` was present in `$ARGUMENTS`; `false` otherwise |
| `explicit_profile` | `boolean` | `true` if `--profile` was present in `$ARGUMENTS`; `false` otherwise |

The skill is the single source of truth for all further resolution, driver dispatch, evaluation, and issue reconciliation. Do NOT re-implement profile logic, driver selection, or issue triage in this command file.
