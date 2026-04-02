---
name: session-end
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
- Create a GitLab issue for the remaining work with:
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
- If new issues were identified: create them on GitLab

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

1. **Close resolved issues**: Use the issue close command for the detected VCS platform. To add a closing comment, use the issue note/comment command first, then close. **Important for GitLab:** The `--comment` flag does NOT exist on `glab issue close` — use TWO separate commands: `glab issue note <IID> -m "comment"` THEN `glab issue close <IID>`.
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
- Files changed: [N]
- Tests: [passing/total]
- TypeScript: 0 errors
- Commits: [N] pushed to [branch]
- Mirror: [synced/skipped]

### Next Session Recommendations
- Priority: [what should be tackled next]
- Type: [housekeeping/feature/deep recommended]
- Notes: [any context for next session]
```

## Critical Rules

- **NEVER claim work is done without running verification** — evidence before assertions
- **NEVER commit with TypeScript errors** — 0 errors is non-negotiable
- **NEVER use `git add .`** — stage files individually to avoid capturing parallel session work
- **NEVER skip issue updates** — GitLab must reflect reality after every session
- **ALWAYS create issues for unfinished work** — nothing should be "remembered" without a ticket
- **ALWAYS push to origin** — local-only work is lost work
- **ALWAYS mirror to GitHub** if configured — keep mirrors in sync
- **ALWAYS review `git diff --cached`** before committing — verify only YOUR changes are staged
