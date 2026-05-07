---
description: Start a development session (housekeeping, feature, deep)
argument-hint: [housekeeping|feature|deep]
---

# Session Start

You are beginning a new development session. The user has invoked `/session` with type: **$ARGUMENTS** (if empty, auto-detect from the project's `## Session Config` block or default to `feature`).

**Argument validation:** Valid session types are `housekeeping`, `feature`, and `deep`. If `$ARGUMENTS` is not empty and does not match any valid type, inform the user: "Invalid session type '$ARGUMENTS'. Valid types: housekeeping, feature, deep." Then auto-detect from the project's `## Session Config` block or default to `feature`.

## Resume Support

When `<state-dir>/STATE.md` exists with `status: active` or `status: paused`, session-start surfaces a resume prompt (Phase 0.5). The `## Mission Status` body section in STATE.md — written by wave-executor via `setMissionStatus` from `scripts/lib/state-md.mjs` — identifies where execution left off:

1. Read the `## Mission Status` section entries using `readMissionStatus(stateContent, taskId)` (one call per task ID from the wave plan).
2. The task with the most-advanced status that is NOT yet `completed` is the **resume-from point**:
   - `in-dev` entry → that agent was in-flight; re-dispatch it (or skip if its files show work done)
   - `validated` entry with no `in-dev` items → the wave was approved but not started; begin wave dispatch
   - All items `completed` → wave finished; proceed to the next wave
3. Items still at `brainstormed` were not yet user-approved; re-present the plan excerpt for approval.
4. Items at `testing` had implementation complete but Quality gate not yet run; treat as the Quality wave starting point.

This read is informational — session-start uses it to populate the resume banner and recommend which wave to re-enter. The wave-executor then applies the actual transitions when `/go` is confirmed.

**Your job: Autonomously research the full project state, then present structured findings with recommendations for the user to approve before creating a wave plan.**

**Invoke the session-start skill.** Follow its instructions precisely. Do NOT skip any phase. Do NOT make assumptions — verify everything in code and on the VCS platform.
