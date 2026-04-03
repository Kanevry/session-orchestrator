---
name: session-end
user-invocable: false
description: >
  Full session close-out: verifies all planned work against the agreed plan, creates issues
  for gaps, runs quality gates, commits cleanly, mirrors to GitHub, and produces a session
  summary. Triggered by /close command.
---

# Session End Skill

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
- Incorporate findings into issue management:
  - Findings with severity `critical` or `high` → create issues immediately (Phase 5)
  - Findings with severity `medium` or `low` → list in the Final Report under "Discovery Findings (deferred)"
- Report: "Discovery scan: [N] findings ([X] critical/high → issues, [Y] medium/low → deferred)"

### 1.6 Safety Review

> Skip if `persistence` is `false` in Session Config (STATE.md won't exist).

Review safety metrics from the session. This is informational — it does NOT block the session close.

1. Read `.claude/STATE.md` to extract:
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

1. Read `.claude/STATE.md` Wave History to extract per-wave data: agent counts, statuses, files changed
2. Compute session totals:
   - `total_duration_seconds`: from `started` to now (ISO 8601 diff)
   - `total_waves`: count of completed waves
   - `total_agents`: sum of agents across all waves
   - `total_files_changed`: unique files changed across entire session (from `git diff --stat`)
   - `agent_summary`: `{complete: N, partial: N, failed: N, spiral: N}`
3. Prepare the JSONL entry (written in Phase 3.7):
   ```json
   {
     "session_id": "<branch>-<YYYY-MM-DD>-<HHmm>",
     "session_type": "<type>",
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

> Fields `discovery_stats` and `review_stats` are optional — only populated when discovery or review ran in this session. The `effectiveness` object is always populated from Phase 1 plan verification results. `completion_rate` is calculated as `completed / planned_issues` (0.0-1.0).

## Phase 2: Quality Gate

Run ALL checks — do NOT skip any:

> **Quality Reference:** Run Full Gate quality checks per the quality-gates skill. Read `test-command`, `typecheck-command`, and `lint-command` from Session Config (defaults: `pnpm test --run`, `tsgo --noEmit`, `pnpm lint`).

1. **Full Gate checks**: TypeScript (0 errors), tests (must pass), lint (must pass, warnings OK)
2. **Git status**: `git status` → understand all changes
3. **Uncommitted changes**: everything should be staged for commit
4. **No debug artifacts**: search for `console.log`, `debugger`, `TODO: remove` in changed files

If any check fails:
- Fix it if quick (<2 min)
- Otherwise create a `priority:high` issue for immediate follow-up
- Do NOT commit broken code

## Phase 3: Documentation Updates

### 3.1 SSOT Files
- Update `STATUS.md` / `STATE.md` if they exist (metrics, dates, status)
- Update `CLAUDE.md` if patterns or conventions changed during this session
- Check `.claude/rules/` — if a new pattern was established, suggest a new rule file

### 3.2 Session Handover (for significant sessions)
If this session made substantial changes, create or update:
- `.claude/session-handover/` doc with: tasks completed, resume point, metrics changed, issues opened/closed
- Or update `.claude/STATE.md` with session digest

### 3.3 Claude Rules Freshness
Review `.claude/rules/` files that are relevant to this session's work:
- Are the rules still accurate after this session's changes?
- Should any rule be updated with new patterns?
- Should a new path-scoped rule be created?
- Suggest changes but DO NOT modify without user confirmation

### 3.4 Update STATE.md

If `persistence` is enabled in Session Config and `.claude/STATE.md` exists:
1. Set frontmatter `status: completed`
2. Record final wave count and completion time in the frontmatter
3. Keep the file as a record — do NOT delete it (next session-start reads it)

After updating STATE.md, also delete `.claude/wave-scope.json` if it exists (cleanup — enforcement hooks only apply during active waves).

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
- **Fragile files**: files that needed 3+ iterations across waves or caused cascading failures
- **Effective sizing**: actual agent count vs. planned — what worked for this complexity level
- **Recurring issues**: same issue type appearing across waves (e.g., type errors, missing imports)
- **Scope guidance**: was the scope too large/small? How many issues fit comfortably in one session?
- **Deviation patterns**: read the `## Deviations` section from `.claude/STATE.md` — were there plan adaptations? What triggered them? Extract as `deviation-pattern` type if a pattern emerges across sessions (e.g., "scope expansion during Impl-Core is common for this project")

**Learning format** (append each as one JSONL line to `.claude/metrics/learnings.jsonl`):
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
  "expires_at": "<ISO 8601 + 90 days>"
}
```

**Confidence updates for existing learnings:**
Before writing new learnings, read `.claude/metrics/learnings.jsonl` and check for existing entries with the same `type` + `subject`:
- If this session **confirms** an existing learning: increment `confidence` by +0.15 (cap at 1.0). Rewrite the line.
- If this session **contradicts** an existing learning: decrement `confidence` by -0.2. If confidence reaches 0.0, remove the line.
- If no existing match: append as new learning with confidence 0.5.

### 3.6 Memory Cleanup Check

> Gate: Only run if `persistence` is enabled in Session Config.

1. Count session memory files matching `session-*.md` in the memory directory
2. If count exceeds `memory-cleanup-threshold` (default: 5), suggest:
   "You have [N] session memory files. Consider running `/memory-cleanup` to consolidate."
3. This is a suggestion only — not blocking
4. **Prune expired learnings** from `.claude/metrics/learnings.jsonl` (if file exists):
   - Remove entries where `expires_at` < current date
   - Remove entries where `confidence` = 0.0
   - Consolidate duplicate entries (same `type` + `subject`): keep the one with highest confidence

### 3.7 Write Session Metrics

> Gate: Only run if `persistence` is enabled in Session Config.

1. Ensure `.claude/metrics/` directory exists: `mkdir -p .claude/metrics`
2. Append the prepared JSONL entry (from Phase 1.7) as a single line to `.claude/metrics/sessions.jsonl`
   > **Concurrent write safety**: Use shell `>>` append for the single JSONL line — this is atomic on POSIX systems for writes under PIPE_BUF (typically 4096 bytes). Do NOT read-modify-write the file.
3. Create the file if it does not exist
4. Verify: read back the last line to confirm valid JSON

## Phase 4: Commit & Push

### 4.1 Stage Changes
- **Stage files individually**: `git add <file>` — NEVER `git add .` or `git add -A`
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
- Metrics written to: `.claude/metrics/sessions.jsonl`
- Learnings: [N] new, [M] confirmed, [K] contradicted/expired — written to `.claude/metrics/learnings.jsonl`

### Next Session Recommendations
- Priority: [what should be tackled next]
- Type: [housekeeping/feature/deep recommended]
- Notes: [any context for next session]
```

## Critical Rules

- **NEVER claim work is done without running verification** — evidence before assertions
- **NEVER commit with TypeScript errors** — 0 errors is non-negotiable
- **NEVER use `git add .`** — stage files individually to avoid capturing parallel session work
- **NEVER skip issue updates** — VCS must reflect reality after every session
- **ALWAYS create issues for unfinished work** — nothing should be "remembered" without a ticket
- **ALWAYS push to origin** — local-only work is lost work
- **ALWAYS mirror to GitHub** if configured — keep mirrors in sync
- **ALWAYS review `git diff --cached`** before committing — verify only YOUR changes are staged
