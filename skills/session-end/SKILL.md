---
name: session-end
user-invocable: false
tags: [orchestration, verification, commits, issues]
model-preference: sonnet
model-preference-codex: gpt-5.4-mini
model-preference-cursor: claude-sonnet-4-6
description: >
  Full session close-out: verifies all planned work against the agreed plan, creates issues
  for gaps, runs quality gates, commits cleanly, mirrors to GitHub, and produces a session
  summary. Triggered by /close command.
---

# Session End Skill

> **Platform Note:** State files (STATE.md, wave-scope.json) live in the platform's native directory: `.claude/` (Claude Code), `.codex/` (Codex CLI), or `.cursor/` (Cursor IDE). All references to `.claude/` below should use the platform's state directory. Shared metrics live in `.orchestrator/metrics/`. See `skills/_shared/platform-tools.md`.

## Phase 1: Plan Verification

Read back the session plan that was agreed at the start. For EACH planned item:

### 1.1 Done Items
- **Verify with evidence**: read the changed files, check git diff, run relevant test
- Confirm acceptance criteria are met
- Mark as completed

### 1.2 Partially Done Items
- Document what was completed and what remains
- Create a VCS issue for the remaining work with:
  - Title: `[Carryover] <original task description>`
  - Labels: `priority:<original>`, `status:ready`
  - Description: what's done, what's left, context for next session
- Link to original issue if applicable

### 1.3 Not Started Items
- Document WHY (blocked? de-scoped? out of time?)
- If still relevant: ensure original issue remains `status:ready`
- If no longer relevant: close with comment explaining why

### 1.4 Emergent Work
- Tasks that were NOT in the plan but were done (fixes, discoveries)
- Document and attribute to relevant issues
- If new issues were identified: create them on the VCS platform

### 1.5 Discovery Scan (if enabled)

Check if `discovery-on-close` is `true` in Session Config. If not configured or `false`, skip this section.

When enabled, invoke the discovery skill in **embedded mode**:
- Run discovery Phases 0-3 only (Config, Stack Detection, Probe Execution, Verification & Scoring)
- Scope: `session` probes always run; additional probes per `discovery-probes` config
- Collect verified findings from the discovery skill output
- Parse the discovery output for the **findings array** and **stats object** (schema defined in discovery skill Phase 3.6)
- Store the stats object for Phase 1.7 metrics collection (`discovery_stats` field)

> **Parsing discovery output:** When discovery runs in embedded mode, it returns two data structures: (1) a **findings array** — JSON array of objects with `probe`, `category`, `severity`, `confidence`, `title`, `description` fields; (2) a **stats object** — JSON with `probes_run`, `findings_raw`, `findings_verified`, `false_positives`, `by_category`. Extract these from the discovery agent's output. Store stats as `discovery_stats` in session metrics (Phase 1.7).
- Incorporate findings into issue management:
  - Findings with severity `critical` or `high` → create issues immediately (Phase 5)
  - Findings with severity `medium` or `low` → list in the Final Report under "Discovery Findings (deferred)"
- Report: "Discovery scan: [N] findings ([X] critical/high → issues, [Y] medium/low → deferred)"

### 1.6 Safety Review

> Skip if `persistence` is `false` in Session Config (STATE.md won't exist).

Review safety metrics from the session. This is informational — it does NOT block the session close.

1. Read `<state-dir>/STATE.md` to extract:
   - **Circuit breaker activations**: agents that hit maxTurns (`PARTIAL`), agents that spiraled (`SPIRAL`), agents that failed (`FAILED`)
   - **Worktree status**: which agents used worktree isolation, any fallbacks or merge conflicts
2. Read enforcement hook logs from stderr (if captured): count of scope violations blocked/warned, command violations blocked/warned
3. Summarize:
   ```
   Safety review:
   - Agents: [X] complete, [Y] partial (hit turn limit), [Z] spiral/failed
   - Enforcement: [N] scope violations, [M] command blocks
   - Isolation: [K] agents in worktrees, [J] fallbacks
   ```
4. If any agents were `SPIRAL` or `FAILED`, ensure carryover issues exist (cross-reference with Phase 1.2)

### 1.7 Metrics Collection

> Gate: Only run if `persistence` is enabled in Session Config.

Finalize session metrics by reading the wave data accumulated during execution:

1. Read `<state-dir>/STATE.md` Wave History to extract per-wave data: agent counts, statuses, files changed

> **Graceful degradation:** If STATE.md is missing expected fields (no Wave History, missing frontmatter keys, malformed YAML), degrade gracefully: report what is available, skip metrics fields that cannot be parsed. Do NOT fail the session close because STATE.md is incomplete — a crashed session may leave partial STATE.md behind.

2. Compute session totals:
   - `total_duration_seconds`: from `started_at` to now (ISO 8601 diff)
   - `total_waves`: count of completed waves
   - `total_agents`: sum of agents across all waves
   - `total_files_changed`: unique files changed across entire session (from `git diff --stat`)
   - `agent_summary`: `{complete: N, partial: N, failed: N, spiral: N}`
3. Prepare the JSONL entry (written in Phase 3.7):
   ```json
   {
     "session_id": "<branch>-<YYYY-MM-DD>-<HHmm>",
     "session_type": "<type>",
     "platform": "<claude|codex>",
     "started_at": "<ISO 8601>",
     "completed_at": "<ISO 8601>",
     "duration_seconds": N,
     "total_waves": N,
     "total_agents": N,
     "total_files_changed": N,
     "agent_summary": {"complete": N, "partial": N, "failed": N, "spiral": N},
     "waves": [
       {"wave": 1, "role": "Discovery", "agent_count": N, "files_changed": N, "quality": "pass|fail|skip"},
       ...
     ],
     "discovery_stats": {
       "probes_run": N,
       "findings_raw": N,
       "findings_verified": N,
       "false_positives": N,
       "user_dismissed": N,
       "issues_created": N,
       "by_category": {
         "code": {"findings": N, "actioned": N},
         "infra": {"findings": N, "actioned": N},
         "ui": {"findings": N, "actioned": N},
         "arch": {"findings": N, "actioned": N},
         "session": {"findings": N, "actioned": N}
       }
     },
     "review_stats": {
       "total_findings": N,
       "high_confidence": N,
       "auto_fixed": N,
       "manual_required": N
     },
     "effectiveness": {
       "planned_issues": N,
       "completed": N,
       "carryover": N,
       "emergent": N,
       "completion_rate": 0.0
     }
   }
   ```

> The `session_id` uses `<HHmm>` from the `started_at` timestamp to ensure uniqueness when multiple sessions run on the same branch in one day.

> **Conditional fields:**
> - `discovery_stats`: populated ONLY when `discovery-on-close: true` in Session Config AND Phase 1.5 executed successfully. Source: the stats object returned by the discovery skill (see discovery skill Phase 3.6 for schema). When discovery runs in **embedded mode** (Phases 0-3 only), `user_dismissed`, `issues_created`, and `actioned` per category will always be `0` — embedded mode does not perform user triage (Phase 4) or issue creation (Phase 5).
> - `review_stats`: populated ONLY when Phase 1.8 dispatched the session-reviewer agent AND it returned findings. Source: the session-reviewer's output summary.
> - `effectiveness`: ALWAYS populated from Phase 1 plan verification results. `completion_rate` = `completed / planned_issues` (0.0-1.0, where 0.0 means nothing was completed).

### 1.8 Session Review

Dispatch the session-reviewer agent to verify implementation quality before the quality gate:

> On Codex CLI, dispatch via the `session-reviewer` agent role defined in `.codex-plugin/agents/session-reviewer.toml`.

1. Invoke `subagent_type: "session-orchestrator:session-reviewer"` with:
   - **Scope**: all files changed this session (from `git diff --name-only` against the base branch)
   - **Context**: the session plan (issues, acceptance criteria) and all wave results from STATE.md
2. Wait for the reviewer's **Verdict**:
   - **PROCEED** — continue to Phase 2
   - **FIX REQUIRED** — address each listed item before proceeding. For quick fixes (<2 min each), fix inline. For larger items, create carryover issues (same as Phase 1.2) and note them as unresolved review findings in the Final Report

## Phase 2: Quality Gate

> **Verification Reference:** See `verification-checklist.md` in this skill directory for the full quality gate checklist.

Run ALL checks listed in the verification checklist. If any check fails: fix if quick (<2 min), otherwise create a `priority:high` issue. Do NOT commit broken code.

## Phase 3: Documentation Updates

### 3.0 Defensive Cleanup

Delete `<state-dir>/wave-scope.json` if it still exists:

```bash
rm -f <state-dir>/wave-scope.json
```

This should have been cleaned up by wave-executor after the final wave, but crashed sessions or interrupted executions may leave it behind. A stale scope manifest from a previous session could incorrectly restrict the next session's enforcement hooks.

### 3.1 SSOT Files
- Update `STATUS.md` / `STATE.md` if they exist (metrics, dates, status)
- Update `CLAUDE.md` if patterns or conventions changed during this session
- Check `<state-dir>/rules/` — if a new pattern was established, suggest a new rule file

### 3.2 Session Handover (for significant sessions)
If this session made substantial changes, create or update:
- `<state-dir>/session-handover/` doc with: tasks completed, resume point, metrics changed, issues opened/closed
- Or update `<state-dir>/STATE.md` with session digest

### 3.3 Claude Rules Freshness
Review `<state-dir>/rules/` files that are relevant to this session's work:
- Are the rules still accurate after this session's changes?
- Should any rule be updated with new patterns?
- Should a new path-scoped rule be created?
- Suggest changes but DO NOT modify without user confirmation

### 3.4 Update STATE.md

> Gate: Only run if `persistence` is enabled in Session Config and `<state-dir>/STATE.md` exists.
1. Set frontmatter `status: completed`
2. Record final wave count and completion time in the frontmatter
3. Keep the file as a record — do NOT delete it (next session-start reads it)

If STATE.md doesn't exist, skip this subsection.

### 3.5 Session Memory

> Gate: Only run if `persistence` is enabled in Session Config.

1. Create `~/.claude/projects/<project>/memory/session-<YYYY-MM-DD>.md` with:
   - Frontmatter: `name`, `description` (1-line summary), `type: project`
   - `## Outcomes` — per-issue status (completed / partial / not started) with evidence
   - `## Learnings` — patterns discovered, architectural insights, gotchas
   - `## Next Session` — priority recommendations, suggested session type, blockers
2. Update `~/.claude/projects/<project>/memory/MEMORY.md`:
   - Under a `## Sessions` heading (create if missing), add:
     `- [Session <date>](session-<date>.md) — <one-line summary>`

### 3.5a Learning Extraction

> Gate: Only run if `persistence` is enabled in Session Config.

Analyze the completed session to extract reusable learnings for future sessions.

**What to extract:**
- **Fragile files**: use `git log --name-only --format="" $SESSION_START_REF..HEAD | sort | uniq -c | sort -rn | head -10` to find files changed most frequently across commits this session. Files appearing in 3+ commits are candidates for fragile-file learnings. Cross-reference with `<state-dir>/STATE.md` Wave History to correlate with specific waves.
- **Effective sizing**: actual agent count vs. planned — what worked for this complexity level
- **Recurring issues**: same issue type appearing across waves (e.g., type errors, missing imports)
- **Scope guidance**: was the scope too large/small? How many issues fit comfortably in one session?
- **Deviation patterns**: read the `## Deviations` section from `<state-dir>/STATE.md` — were there plan adaptations? What triggered them? Extract as `deviation-pattern` type if a pattern emerges across sessions (e.g., "scope expansion during Impl-Core is common for this project")

**Learning format** (append each as one JSONL line to `.orchestrator/metrics/learnings.jsonl`):
```json
{
  "id": "<uuid-v4>",
  "type": "fragile-file|effective-sizing|recurring-issue|scope-guidance|deviation-pattern",
  "subject": "<what the learning is about>",
  "insight": "<the actionable insight>",
  "evidence": "<what happened this session>",
  "confidence": 0.5,
  "source_session": "<session_id>",
  "created_at": "<ISO 8601>",
  "expires_at": "<ISO 8601 + learning-expiry-days (default: 30)>"
}
```

**Confidence updates for existing learnings:**
Before writing new learnings, read `.orchestrator/metrics/learnings.jsonl` and check for existing entries with the same `type` + `subject` (exact string match on both fields):
- If this session **confirms** an existing learning: note the update — increment `confidence` by +0.15 (cap at 1.0) and reset `expires_at` to current date + `learning-expiry-days` (default: 30)
- If this session **contradicts** an existing learning: note the update — decrement `confidence` by -0.2
- If no existing match: note as a new learning with confidence 0.5

**File I/O strategy:** Track all updates in memory during extraction. Do NOT modify `learnings.jsonl` here — Phase 3.6 handles the actual file write. Pass the list of new/updated learnings to Phase 3.6.

**Subject matching:** Match on exact `type` + `subject` string equality. For `fragile-file`, `subject` is the file path. For other types, use a short canonical identifier (e.g., `type-errors-in-api`, `scope-too-large`, `missing-imports`).

### 3.6 Memory Cleanup & Learnings Write

> Gate: Only run if `persistence` is enabled in Session Config.

1. Count session memory files matching `session-*.md` in the memory directory
2. If count exceeds `memory-cleanup-threshold` (default: 5), suggest:
   "You have [N] session memory files. Consider running `/memory-cleanup` to consolidate."
3. This is a suggestion only — not blocking
4. **Write learnings** to `.orchestrator/metrics/learnings.jsonl` (if file exists or new learnings were extracted):
   a. Read all existing lines from `learnings.jsonl` (if exists)
   b. Apply confidence updates from Phase 3.5a (confirmed: +0.15 capped at 1.0 AND reset `expires_at` to current date + `learning-expiry-days` (default: 30); contradicted: -0.2)
   c. Append new learnings from Phase 3.5a (those with no existing match)
   d. Prune: remove entries where `expires_at` < current date OR `confidence` <= 0.0
   e. Consolidate duplicates (same `type` + `subject`): keep the one with highest confidence
   f. Write the entire result back to `learnings.jsonl` (atomic rewrite with `>`, not append with `>>`)
   g. If no existing file and no new learnings: skip

### 3.7 Write Session Metrics

> Gate: Only run if `persistence` is enabled in Session Config.

1. Ensure `.orchestrator/metrics/` directory exists: `mkdir -p .orchestrator/metrics`
2. Append the prepared JSONL entry (from Phase 1.7) as a single line to `.orchestrator/metrics/sessions.jsonl`
   > **Concurrent write safety**: Use shell `>>` append for the single JSONL line — this is atomic on POSIX systems for writes under PIPE_BUF (typically 4096 bytes). Do NOT read-modify-write the file.
3. Create the file if it does not exist
4. Verify: read back the last line to confirm valid JSON

## Phase 4: Commit & Push

### 4.1 Stage Changes
- **Stage files individually**: `git add <file>` — NEVER `git add .` or `git add -A`
- **Always stage these session artifacts** (if modified):
  - `.orchestrator/metrics/sessions.jsonl` (session summary from Phase 3.7)
  - `.orchestrator/metrics/learnings.jsonl` (learnings from Phase 3.6)
  - `<state-dir>/STATE.md` (session state, if persistence enabled)
  - Any files created or modified by wave agents
- Review staged changes: `git diff --cached` — verify every change is from THIS session
- If you see changes you did NOT make, ask the user (parallel session awareness)

### 4.2 Commit
Use Conventional Commits format:
```
type(scope): description

- [bullet points of what changed]
- Closes #IID1, #IID2 (if applicable)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

For sessions with many changes, prefer ONE commit per logical unit (not one mega-commit).

### 4.3 Push
```bash
git push origin HEAD
```

### 4.4 GitHub Mirror (if configured in Session Config)
```bash
# Only attempt if 'mirror: github' is in Session Config AND remote exists
git remote get-url github 2>/dev/null && git push github HEAD 2>/dev/null || echo "GitHub mirror: not configured"
```

## Phase 5: Issue Cleanup

> **VCS Reference:** Use CLI commands per the "Common CLI Commands" section of the gitlab-ops skill.

1. **Close resolved issues**: Use the issue close and note commands per the "Common CLI Commands" section of the gitlab-ops skill. Note: some VCS platforms require separate note and close commands.
2. **Update in-progress issues**: ensure labels reflect actual state using the issue update command
3. **Create carryover issues**: for partially-done work (from Phase 1.2), use the issue create command with appropriate labels
4. **Create gap issues**: for newly-discovered problems
5. **Update milestones**: if milestone progress changed

## Phase 6: Final Report

Present to the user:

```
## Session Summary

### Completed
- [x] Issue #N: [description] — [evidence: tests passing, files changed]
- [x] Issue #M: [description]

### Carried Over
- [ ] Issue #P: [what's left] — new issue #Q created
- [ ] [description] — blocked by [reason]

### New Issues Created
- #R: [title] (priority: [X], status: ready)
- #S: [title] (priority: [X], status: ready)

### Metrics
- Duration: [total wall-clock time]
- Waves: [N completed]
- Agents: [total dispatched] ([X complete, Y partial, Z failed])
- Files changed: [N]
- Per-wave breakdown:
  - Wave 1 (Discovery): [duration] — [N agents] — [K files]
  - Wave 2 (Impl-Core): [duration] — [N agents] — [K files]
  - ...
- Tests: [passing/total]
- TypeScript: 0 errors
- Commits: [N] pushed to [branch]
- Mirror: [synced/skipped]
- Enforcement: [N violations blocked / M warnings] (or "N/A" if enforcement off)
- Circuit breaker: [N agents hit limits, M spirals detected] (or "none")
- Metrics written to: `.orchestrator/metrics/sessions.jsonl`
- Learnings: [N] new, [M] confirmed, [K] contradicted/expired — written to `.orchestrator/metrics/learnings.jsonl`

### Next Session Recommendations
- Priority: [what should be tackled next]
- Type: [housekeeping/feature/deep recommended]
- Notes: [any context for next session]
```

## Sub-File Reference

| File | Purpose |
|------|---------|
| `verification-checklist.md` | Phase 2 quality gate checklist and checks |

## Anti-Patterns

- **DO NOT** commit before running quality gates — a "clean commit" with TypeScript errors is not clean
- **DO NOT** mark issues as closed without verifying the implementation actually addresses them
- **DO NOT** skip creating tracking issues for unfinished work — "I'll remember for next session" always fails
- **DO NOT** use `git add .` or `git add -A` — parallel sessions may have uncommitted work in the tree
- **DO NOT** push to mirrors before verifying origin push succeeded — broken state propagates

## Critical Rules

- **NEVER claim work is done without running verification** — evidence before assertions
- **NEVER commit with TypeScript errors** — 0 errors is non-negotiable
- **NEVER use `git add .`** — stage files individually to avoid capturing parallel session work
- **NEVER skip issue updates** — VCS must reflect reality after every session
- **ALWAYS create issues for unfinished work** — nothing should be "remembered" without a ticket
- **ALWAYS push to origin** — local-only work is lost work
- **ALWAYS mirror to GitHub** if configured — keep mirrors in sync
- **ALWAYS review `git diff --cached`** before committing — verify only YOUR changes are staged
