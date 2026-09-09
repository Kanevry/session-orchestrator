---
description: Start a development session (housekeeping, feature, deep; ultradeep = deep + profile)
argument-hint: "[housekeeping|feature|deep|ultradeep]"
---

# Session Start

You are beginning a new development session. The user has invoked `/session` with type: **$ARGUMENTS** (if empty, default to **`deep`**).

**Default rationale (measured, not assumed):** `deep` is the default because it is what operators actually run — 77.3 % of 489 recorded sessions across 5 repos, and 115 of 228 (50.4 %) in this repo's own `.orchestrator/metrics/sessions.jsonl`. The former `feature` default made the majority case the one that had to be typed out every time. A `deep` default costs a downgrade keystroke in the minority case; a `feature` default cost an upgrade keystroke in the majority case.

**Argument validation:** Valid session types are `housekeeping`, `feature`, and `deep`. An explicit `$ARGUMENTS` value ALWAYS wins over the default — `/session housekeeping` and `/session feature` behave exactly as before. `ultradeep` is additionally accepted as an ARGUMENT ALIAS (see below); it is not a fourth type. If `$ARGUMENTS` is not empty and does not match any valid type or the alias, inform the user: "Invalid session type '$ARGUMENTS'. Valid types: housekeeping, feature, deep (alias: ultradeep)." Then fall back to `deep`. Once the type (and any profile) is settled, the resolved execution shape is recorded at plan time by `node scripts/session-shape.mjs` (event `orchestrator.session.shape_resolved`), so the ledger can answer "how many waves did this session actually run".

### Argument alias: `ultradeep` (PRD `docs/prd/2026-09-06-ultradeep-session-profile.md`)

`/session ultradeep` is an alias, NOT a fourth `session_type`. Resolve it to TWO STATE.md frontmatter values and then continue exactly as a `deep` session would:

```yaml
session-type: deep          # what every downstream consumer sees
session-profile: ultradeep  # the only place the alias survives
```

- **`session-type` NEVER becomes `ultradeep`.** The value is a closed set in `scripts/lib/session-schema/constants.mjs` (`VALID_SESSION_TYPES`) and in `scripts/lib/wave-sizing.mjs`; a fourth member would degrade silently in two places (`scripts/lib/telemetry/schema.mjs` maps an unknown type to `"other"`, `scripts/lib/session-close-backfill.mjs` labels it `housekeeping`). The alias exists so that no closed set has to change.
- **`session-profile` is optional and absent by default.** A plain `/session deep` writes NO `session-profile` key. Absent means "no profile" — never write an empty string, `none`, or `null` to mean absence. Read/write helpers: `readSessionProfile` / `setSessionProfile` in `scripts/lib/state-md.mjs`.
- **What the profile changes** is the WAVE SHAPE, not the session type: 7 waves with a coordinator-direct Synthesis-Gate at wave 2. See `skills/session-plan/SKILL.md` § Role-to-Wave Mapping and `skills/wave-executor/SKILL.md` § Ultradeep Profile.
- **The profile OWNS its wave count.** `resolveSessionShape({ profile: 'ultradeep' })` returns 7 waves and reports `wavesConfigHonored: false` together with the ignored value; the `waves` key never applies to the profile (PRD AC-9 dropped 2026-09-09). Nothing to reconcile, nothing to ask the user about — read the count from `node scripts/session-shape.mjs --session-type deep --profile ultradeep`.
- **Cost — why the alias stays the exception.** Measured 2026-09-09 over 6 ultradeep runs in three repos: 362–507 min wall-clock vs 131–164 min for deep, at similar output-token volume — use only with a named research question.
- **Budgets are deliberately not implemented yet** (PRD § 7): no `ultradeep.max-*` key is read anywhere. Do not invent one; the PRD defers thresholds until three runs have been measured.

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
