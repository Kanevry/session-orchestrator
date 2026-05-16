---
description: Run a 4-phase systematic debugging investigation before proposing any fix. Iron Law — NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST. Produces a `.orchestrator/debug/` artifact the fixer agent must reference.
argument-hint: "[bug-description-or-issue-ref]"
---

# Debug

Invokes the `debug` skill. Runs 4 phases (Root Cause → Pattern → Impact → Solution) and writes an artifact to `.orchestrator/debug/<session>-<n>.md` before any fix code is written.

## Argument Validation

The optional argument is a short bug description or issue reference (e.g. `"test timeout in CI"` or `#408`). If absent, the skill will inspect recent errors and git log to surface the most likely candidate, then confirm with the user.

## Behavior

1. **Bootstrap gate** — reads `skills/_shared/bootstrap-gate.md`. Gate CLOSED blocks all further steps.
2. **Phase 1: Root Cause Investigation** — quotes error verbatim, reproduces, checks recent commits via `git log --oneline -20`, instruments component boundaries, traces data flow backward. Writes artifact to `.orchestrator/debug/<session-id>-<n>.md`.
3. **Phase 2: Pattern Identification** — recurrence? class of bug? missing test? similar code paths in the codebase?
4. **Phase 3: Impact Analysis** — what else does the root-caused code touch? callers, dependents, transitive effects.
5. **Phase 4: Solution** — proposes minimal fix + identifies test cases. Records resolution in the artifact.

## Iron Law

The skill enforces: **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.** Skipping Phase 1 is forbidden regardless of how obvious the fix appears. The artifact from Phase 1 is a prerequisite for Phase 4, not optional documentation.

## Artifact location

`.orchestrator/debug/<session-id>-<sequence>.md`

Sequence resets per session (1, 2, 3, …). The artifact records: exact error, reproduction command, suspect commits, instrumentation data, hypothesized root cause (ONE sentence + confidence level), and eventually the resolution.

## Related

- `skills/debug/SKILL.md` — full skill spec (GH #37, umbrella #35)
- `.claude/rules/verification-before-completion.md` — verify the fix passes fresh (#38)
- `agents/code-implementer.md` — bugfix-classified tasks reference this skill
