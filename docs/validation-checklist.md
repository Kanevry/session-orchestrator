# Validation Checklist — Issue #21: Integration Testing v2.0

Full lifecycle validation checklist for session-orchestrator v2.0. Each item maps to a test plan entry from issue #21. Use the integration test config at `docs/examples/integration-test-config.md` as the Session Config for the test repository.

---

## 1. Full Session Lifecycle (`/session feature` -> `/go` -> `/close`)

**What to test:**
- Run `/session feature` in a test repo with the full integration test config in CLAUDE.md
- Verify session-start reads every Session Config field and reflects them in the Session Overview
- Approve the plan, run `/go` to execute waves, then `/close` to finalize
- Confirm the cycle completes end-to-end without errors

**Expected behavior:**
- Session-start presents a structured Session Overview referencing the test repo state
- Custom quality commands (`npm test`, `npx tsc --noEmit`, `npx eslint .`) appear in baseline checks
- `special` field value appears in session context
- `ecosystem-health: false` means no health checks are attempted
- `cross-repos: []` means Phase 4 is skipped
- Wave plan uses 5 waves with role-per-wave mapping
- All waves execute in order with inter-wave quality checks
- Session-end runs Full Gate with custom commands, commits, and produces final report

**Files to verify:**
- `.claude/STATE.md` — created at wave start, updated per wave, set to `completed` at close
- `.claude/wave-scope.json` — created before each wave, deleted after final wave
- `.claude/metrics/sessions.jsonl` — JSONL entry appended at close
- `~/.claude/projects/<project>/memory/session-<date>.md` — session memory created
- `~/.claude/projects/<project>/memory/MEMORY.md` — index updated

**Pass criteria:**
- No unhandled errors during the full cycle
- Every Session Config field is read and applied (not defaulted)
- Final report includes Metrics section with wave breakdown

---

## 2. STATE.md Persistence

**What to test:**
- Start a session and verify STATE.md is created before Wave 1 dispatch
- After each wave completes, read STATE.md and verify it is updated
- After `/close`, verify STATE.md reflects completed status
- Start a new session and verify session-start detects the previous completed session

**Expected behavior:**
- STATE.md is created at `.claude/STATE.md` with YAML frontmatter (`session-type`, `branch`, `issues`, `started`, `status: active`, `current-wave: 0`, `total-waves: 5`)
- After each wave: `current-wave` increments, `## Wave History` gains an entry with agent results
- After `/close`: `status` changes to `completed`, completion time is recorded
- Next `/session` reads the completed STATE.md and notes previous session context

**Files to verify:**
- `.claude/STATE.md` — check frontmatter fields and Markdown body after each phase

**Pass criteria:**
- Frontmatter `current-wave` matches actual wave count after each wave
- `## Wave History` contains one entry per completed wave with agent status
- `## Deviations` is populated if any plan adaptations occurred
- `status: completed` is set at close, not `active`

---

## 3. Session Memory

**What to test:**
- Complete a session with `persistence: true`
- Check that a session memory file is written to the user-level memory directory
- Check that MEMORY.md index is updated with a reference to the new file
- Run a second session and verify the previous session context is surfaced in Phase 5.5

**Expected behavior:**
- File created at `~/.claude/projects/<project>/memory/session-<YYYY-MM-DD>.md`
- Contains frontmatter (`name`, `description`, `type: project`) and sections: `## Outcomes`, `## Learnings`, `## Next Session`
- MEMORY.md under `## Sessions` heading gains a link line: `- [Session <date>](session-<date>.md) — <summary>`
- On next session, Phase 5.5 reads recent session files and includes context in Session Overview under **Previous Sessions**

**Files to verify:**
- `~/.claude/projects/<project>/memory/session-<date>.md` — exists with correct structure
- `~/.claude/projects/<project>/memory/MEMORY.md` — contains new link under `## Sessions`

**Pass criteria:**
- Session memory file has all three sections populated with actual session data
- MEMORY.md link points to a valid file with matching date
- Second session surfaces previous session context without errors

---

## 4. Enforcement Hooks

**What to test:**
- Run a session with `enforcement: strict`
- Verify `.claude/wave-scope.json` is written before each wave with correct `enforcement` and `allowedPaths`
- Attempt (or observe) an out-of-scope file edit during a wave
- Verify Discovery wave has empty `allowedPaths` (read-only enforcement)
- Verify Quality wave restricts `allowedPaths` to test file patterns

**Expected behavior:**
- `wave-scope.json` contains `"enforcement": "strict"` for every wave
- Discovery wave: `allowedPaths` is `[]`, agent prompts include "You are READ-ONLY"
- Impl-Core/Impl-Polish waves: `allowedPaths` lists specific file paths from agent specs
- Quality wave: `allowedPaths` restricted to `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`
- With `strict` enforcement, out-of-scope edits are **blocked** (hook returns `{"decision": "block"}`)
- Blocked commands (`rm -rf`, `git push --force`, `DROP TABLE`, `git reset --hard`, `git checkout -- .`) are rejected

**Files to verify:**
- `.claude/wave-scope.json` — read before each wave starts to confirm structure
- Agent prompts — verify Discovery agents include read-only instruction

**Pass criteria:**
- `strict` enforcement blocks (not warns) out-of-scope operations
- `wave-scope.json` is cleaned up (deleted) after final wave
- No production files are modified during Quality wave
- No files are modified during Discovery wave

---

## 5. Circuit Breaker

**What to test:**
- Run a session with `max-turns: 15` (set in the test config)
- Verify every agent prompt includes `TURN LIMIT: You have a maximum of 15 turns`
- Simulate or observe an agent that cannot complete within 15 turns
- Check for spiral detection: an agent editing the same file 3+ times

**Expected behavior:**
- Agent prompts contain the turn limit instruction with the configured value (15)
- An agent exceeding the limit reports `PARTIAL` with accomplished work and remaining tasks
- Spiral detection flags agents that edit the same file 3+ times within their execution
- PARTIAL agents get carryover tasks in the next wave
- SPIRAL agents get their changes reverted and tasks re-scoped narrower
- All circuit breaker activations are logged in `.claude/STATE.md` under Wave History

**Files to verify:**
- `.claude/STATE.md` — Wave History entries show agent statuses (done/PARTIAL/SPIRAL/FAILED)
- Agent prompts (in wave-executor dispatch) — verify turn limit text

**Pass criteria:**
- Turn limit matches `max-turns` config value (15), not auto-calculated defaults
- At least one PARTIAL or completion-within-limit is observable
- Spiral detection correctly identifies thrashing patterns (not false positives on different agents editing the same file)

---

## 6. Worktree Isolation

**What to test:**
- Run a feature session with `isolation: worktree`
- Verify agents are dispatched with `isolation: "worktree"` in Agent tool calls
- Observe worktree creation, agent execution in isolation, and post-wave merge
- Verify worktrees are cleaned up after session ends

**Expected behavior:**
- Each agent in Impl-Core and Impl-Polish waves runs in its own git worktree
- Discovery agents are read-only (worktree isolation still applies but they make no changes)
- Post-wave merge integrates changes: fast-forward if clean, conflict resolution strategy applied if not
- Merge conflicts documented in wave progress update
- Worktree fallback: if creation fails, agent runs in shared directory with a warning

**Files to verify:**
- `git worktree list` output — worktrees created during wave, removed after session
- Wave progress updates — merge results documented
- `.claude/STATE.md` — isolation mode noted per wave if deviations occurred

**Pass criteria:**
- Worktrees are created for each agent during implementation waves
- All worktrees are cleaned up (none remain after `/close`)
- Post-wave merge produces a consistent codebase state
- Fallback to shared directory works without crashing if worktree creation fails

---

## 7. Session Metrics (`sessions.jsonl`)

**What to test:**
- Complete a full session with `persistence: true`
- Read `.claude/metrics/sessions.jsonl` after `/close`
- Verify the JSONL entry structure and field values

**Expected behavior:**
- `.claude/metrics/` directory is created if it did not exist
- A single JSONL line is appended to `sessions.jsonl` with these fields:
  - `session_id`: `<branch>-<YYYY-MM-DD>-<HHmm>` format
  - `session_type`: `"feature"` (or whichever type was run)
  - `started_at`, `completed_at`: valid ISO 8601 timestamps
  - `duration_seconds`: positive integer matching wall-clock time
  - `total_waves`: matches number of completed waves (5 for the test config)
  - `total_agents`: sum of agents across all waves
  - `total_files_changed`: non-negative integer
  - `agent_summary`: object with `complete`, `partial`, `failed`, `spiral` counts
  - `waves`: array with per-wave records (`wave`, `role`, `agent_count`, `files_changed`, `quality`)
- Second session shows "1 previous session tracked" in Session Overview

**Files to verify:**
- `.claude/metrics/sessions.jsonl` — parse the last line as valid JSON, verify all fields present

**Pass criteria:**
- JSONL entry is valid JSON on a single line
- `session_id` format matches the convention
- `total_waves` matches actual wave execution count
- `agent_summary` counts sum to `total_agents`
- File uses atomic append (shell `>>`) not read-modify-write

---

## 8. Cross-Session Learnings (`learnings.jsonl`)

**What to test:**
- Complete a session that has fix-waves (agents that needed corrections or produced PARTIAL results)
- Read `.claude/metrics/learnings.jsonl` after `/close`
- Verify learning entries are extracted from session outcomes
- Run a second session and verify learnings are surfaced in Phase 5.6 (Project Intelligence)

**Expected behavior:**
- Learnings are extracted during session-end Phase 3.5a (Learning Extraction)
- Each learning is a single JSONL line with fields: `id` (UUID), `type`, `subject`, `insight`, `evidence`, `confidence` (0.5 for new), `source_session`, `created_at`, `expires_at` (+90 days)
- Learning types: `fragile-file`, `effective-sizing`, `recurring-issue`, `scope-guidance`, `deviation-pattern`
- On second session, existing learnings with matching `type` + `subject` get confidence updates (+0.15 if confirmed, -0.2 if contradicted)
- Learnings with confidence <= 0.0 are removed; expired learnings are pruned at close

**Files to verify:**
- `.claude/metrics/learnings.jsonl` — parse each line as valid JSON
- Session-start output — check for "Project Intelligence" section referencing learnings

**Pass criteria:**
- At least one learning entry is written after a session with fix-waves or deviations
- `confidence` starts at 0.5 for new learnings
- Second session surfaces active learnings (confidence > 0.3) in Session Overview
- Expired learnings (past `expires_at`) are pruned during close

---

## 9. Adaptive Wave Sizing

**What to test:**
- Run sessions with different scope sizes to trigger different complexity tiers
- Simple: 1 issue, 1-5 files, 1 directory
- Moderate: 2-3 issues, 6-15 files, 2-3 directories
- Complex: 4+ issues, 16+ files, 4+ directories
- Verify agent counts per wave change based on the tier

**Expected behavior:**
- Session-plan Step 3 produces a complexity score (0-6) from three factors: files to change, cross-module scope, issue count
- Score maps to tier: Simple (0-1), Moderate (2-3), Complex (4-6)
- Agent counts per wave follow the tier table:
  - Feature/Simple: Discovery 2-3, Impl-Core 3-4, Impl-Polish 2-3, Quality 2, Finalization 1
  - Feature/Moderate: Discovery 4-5, Impl-Core 5-6, Impl-Polish 4-5, Quality 3-4, Finalization 2
  - Feature/Complex: Discovery 5-6, Impl-Core 6, Impl-Polish 5-6, Quality 4, Finalization 2
- All counts are capped by `agents-per-wave: 6`
- If project intelligence (learnings) suggests different sizing, learnings take precedence

**Files to verify:**
- Session plan output — verify tier and agent counts are shown
- Wave-executor dispatch — verify actual agent count matches plan

**Pass criteria:**
- Different scope sizes produce different agent counts (not always the same)
- No wave dispatches more agents than `agents-per-wave` cap
- Complexity tier is explicitly shown in the session plan
- Historical learnings override formula when available

---

## 10. Wave Roles with Different Wave Counts

**What to test:**
- Test with `waves: 3`: roles should combine (W1=Discovery+Impl-Core, W2=Impl-Polish+Quality, W3=Finalization)
- Test with `waves: 5`: one role per wave (W1=Discovery, W2=Impl-Core, W3=Impl-Polish, W4=Quality, W5=Finalization)
- Verify combined waves inherit the more restrictive verification level

**Expected behavior:**
- With `waves: 3`:
  - Wave 1 runs both Discovery and Impl-Core agents; verification uses Incremental checks (Impl-Core level)
  - Wave 2 runs Impl-Polish and Quality agents; verification uses Full Gate (Quality level)
  - Wave 3 runs Finalization agents with final review
- With `waves: 5`:
  - Each wave maps to exactly one role
  - Discovery (no verification), Impl-Core (Incremental), Impl-Polish (Incremental), Quality (Full Gate), Finalization (git status)
- Role-to-wave mapping table is followed for any configured wave count (3, 4, 5, 6+)

**Files to verify:**
- Session plan output — verify wave-role mapping matches the table
- Inter-wave quality checks — verify correct verification level per combined role

**Pass criteria:**
- `waves: 3` produces exactly 3 waves with correctly combined roles
- `waves: 5` produces exactly 5 waves with one role each
- Combined waves use the more restrictive verification (not the less restrictive)
- Agent prompts in combined waves include scope constraints for both roles

---

## 11. Full Integration: Strict Enforcement + Worktree Isolation + Persistence

**What to test:**
- Run a complete session with `enforcement: strict`, `isolation: worktree`, `persistence: true` — all three v2.0 safety features active simultaneously
- This is the highest-rigor configuration and tests that the features compose correctly

**Expected behavior:**
- STATE.md tracks the full session lifecycle (persistence)
- Every agent runs in an isolated worktree (isolation)
- Scope violations are blocked, not warned (enforcement)
- Circuit breaker enforces `max-turns: 15` on every agent
- Post-wave merges from worktrees respect scope enforcement
- Metrics and learnings are written at close
- Discovery probes run during `/close` (discovery-on-close: true)
- Session memory and MEMORY.md index are updated
- wave-scope.json is created per wave and cleaned up at end

**Files to verify:**
- `.claude/STATE.md` — full lifecycle tracking with all wave history entries
- `.claude/wave-scope.json` — created with `"enforcement": "strict"` per wave, deleted at end
- `.claude/metrics/sessions.jsonl` — complete JSONL entry with per-wave data
- `.claude/metrics/learnings.jsonl` — populated if deviations or fix-waves occurred
- `~/.claude/projects/<project>/memory/session-<date>.md` — session memory with outcomes
- `~/.claude/projects/<project>/memory/MEMORY.md` — index updated
- `git worktree list` — no orphaned worktrees remain after close

**Pass criteria:**
- All three safety features operate without conflicting (no deadlocks, no skipped features)
- Strict enforcement does not block legitimate agent work within declared scope
- Worktree merges succeed and produce correct combined output
- Persistence artifacts (STATE.md, metrics, learnings, memory) are all consistently written
- Session-end final report includes Safety Review with enforcement counts, circuit breaker stats, and isolation summary
- `/close` runs discovery probes and creates issues for critical/high findings
- The session completes end-to-end: no feature is silently skipped due to interactions between the three

---

## Quick Reference: Expected Artifacts After a Complete Test Run

| Artifact | Location | Created by |
|----------|----------|------------|
| STATE.md | `.claude/STATE.md` | wave-executor (pre-Wave 1) |
| wave-scope.json | `.claude/wave-scope.json` | wave-executor (per wave, deleted at end) |
| sessions.jsonl | `.claude/metrics/sessions.jsonl` | session-end (Phase 3.7) |
| learnings.jsonl | `.claude/metrics/learnings.jsonl` | session-end (Phase 3.5a) |
| Session memory | `~/.claude/projects/<project>/memory/session-<date>.md` | session-end (Phase 3.5) |
| MEMORY.md update | `~/.claude/projects/<project>/memory/MEMORY.md` | session-end (Phase 3.5) |
