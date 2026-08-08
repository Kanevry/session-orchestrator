---
description: Start a development session (housekeeping, feature, deep)
argument-hint: "[housekeeping|feature|deep]"
---

# Session Start

You are beginning a new development session. The user has invoked `/session` with type: **$ARGUMENTS** (if empty, default to **`deep`**).

**Default rationale (measured, not assumed):** `deep` is the default because it is what operators actually run — 77.3 % of 489 recorded sessions across 5 repos, and 115 of 228 (50.4 %) in this repo's own `.orchestrator/metrics/sessions.jsonl`. The former `feature` default made the majority case the one that had to be typed out every time. A `deep` default costs a downgrade keystroke in the minority case; a `feature` default cost an upgrade keystroke in the majority case.

**Argument validation:** Valid session types are `housekeeping`, `feature`, and `deep`. An explicit `$ARGUMENTS` value ALWAYS wins over the default — `/session housekeeping` and `/session feature` behave exactly as before. If `$ARGUMENTS` is not empty and does not match any valid type, inform the user: "Invalid session type '$ARGUMENTS'. Valid types: housekeeping, feature, deep." Then fall back to `deep`.

> **Not read from Session Config.** There is deliberately no `session-type:` (or equivalent) key in the `## Session Config` block — `scripts/lib/config.mjs` `parseSessionConfig()` does not emit one, so any such key in a repo's CLAUDE.md (or its Codex CLI equivalent AGENTS.md) is inert prose. The `session-type:` scalar that IS live lives in STATE.md frontmatter (read by `scripts/print-applicable-rules.mjs` for rule mode-gating) and is written per session, not configured per repo. Do not reintroduce a Session Config key here without wiring it into the parser first.

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

**Cold-start banner (PRD #500):** If `bootstrap.lock` exists with timestamp older than `cold-start.nudge-after-hours` (default 1h) and `sessions.jsonl` is empty, the SessionStart hook emits a one-time first-session nudge. Auto-silenced once `sessions.jsonl` has ≥ `cold-start.silence-after-sessions` entries (default 1).

**Invoke `session-orchestrator:session-start` via the `Skill` tool.** Follow its instructions precisely. Do NOT skip any phase. Do NOT make assumptions — verify everything in code and on the VCS platform.
