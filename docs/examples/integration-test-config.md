# Example: Integration Test Config (v2.0 Full Coverage)

This is a reference Session Config block designed to exercise **every v2.0 feature** of session-orchestrator. Add this to the `CLAUDE.md` of a test repository to validate the full lifecycle: `/session feature` -> `/go` -> `/close`.

Every field is set explicitly (many to non-default values) so that tests can verify the orchestrator reads and applies each one rather than falling back to defaults.

## Session Config

```
## Session Config

- **session-types:** [housekeeping, feature, deep]
- **agents-per-wave:** 6
- **waves:** 5
- **cross-repos:** []
- **ssot-files:** [STATUS.md]
- **cli-tools:** [gh]
- **mirror:** none
- **ecosystem-health:** false
- **vcs:** github
- **health-endpoints:** []
- **special:** "Integration test repo for session-orchestrator v2.0"
- **test-command:** npm test
- **typecheck-command:** npx tsc --noEmit
- **lint-command:** npx eslint .
- **ssot-freshness-days:** 3
- **plugin-freshness-days:** 14
- **recent-commits:** 15
- **issue-limit:** 25
- **stale-branch-days:** 5
- **stale-issue-days:** 14
- **discovery-on-close:** true
- **discovery-probes:** [code, arch]
- **discovery-exclude-paths:** [node_modules, dist, .next]
- **discovery-severity-threshold:** medium
- **discovery-confidence-threshold:** 70
- **persistence:** true
- **memory-cleanup-threshold:** 3
- **enforcement:** strict
- **isolation:** worktree
- **max-turns:** 15
```

## Field Notes

Each field is set to a specific value for testing. The table below explains what behavior each value exercises and how it differs from the default.

### Core orchestration

| Field | Value | Default | What it tests |
|-------|-------|---------|---------------|
| `session-types` | `[housekeeping, feature, deep]` | same | All three types are available; test each one to verify role mapping |
| `agents-per-wave` | `6` | `6` | Agent dispatch cap. Verify no wave exceeds 6 agents regardless of complexity tier |
| `waves` | `5` | `5` | Full 5-wave layout: Discovery, Impl-Core, Impl-Polish, Quality, Finalization — one role per wave |

### External integrations

| Field | Value | Default | What it tests |
|-------|-------|---------|---------------|
| `cross-repos` | `[]` | `[]` | Empty list: session-start Phase 4 should be skipped cleanly without errors |
| `ssot-files` | `[STATUS.md]` | n/a | SSOT freshness check against `ssot-freshness-days` (set to 3 below) |
| `cli-tools` | `[gh]` | n/a | GitHub CLI; used for issue queries, PR status, CI checks |
| `mirror` | `none` | `none` | No mirror push at session-end Phase 4.4 |
| `ecosystem-health` | `false` | `false` | Health monitoring disabled; session-start should skip health endpoint checks |
| `vcs` | `github` | auto-detect | Explicit VCS; forces `gh` CLI usage even if remote could be ambiguous |
| `health-endpoints` | `[]` | `[]` | No endpoints; combined with `ecosystem-health: false` confirms health is fully off |
| `special` | `"Integration test..."` | none | Free-text instruction; verify it appears in session context |

### Quality commands

| Field | Value | Default | What it tests |
|-------|-------|---------|---------------|
| `test-command` | `npm test` | `pnpm test --run` | Custom test runner; quality-gates must use this instead of default |
| `typecheck-command` | `npx tsc --noEmit` | `tsgo --noEmit` | Custom typecheck; verify session-end Phase 2 uses it |
| `lint-command` | `npx eslint .` | `pnpm lint` | Custom lint; verify all three quality gates use custom commands |

### Thresholds and limits

| Field | Value | Default | What it tests |
|-------|-------|---------|---------------|
| `ssot-freshness-days` | `3` | `5` | Lower threshold; STATUS.md older than 3 days should be flagged stale |
| `plugin-freshness-days` | `14` | `30` | Tighter plugin check; useful for catching outdated plugin quickly in tests |
| `recent-commits` | `15` | `20` | Fewer commits shown; verify `git log` uses this value |
| `issue-limit` | `25` | `50` | Fewer issues fetched; verify VCS queries respect the limit |
| `stale-branch-days` | `5` | `7` | Tighter stale threshold; branches idle >5 days flagged |
| `stale-issue-days` | `14` | `30` | Issues without progress >14 days flagged for triage |

### Discovery integration

| Field | Value | Default | What it tests |
|-------|-------|---------|---------------|
| `discovery-on-close` | `true` | `false` | Discovery runs automatically at `/close` (Phase 1.5); verify probes execute |
| `discovery-probes` | `[code, arch]` | `[all]` | Subset of probes; only code and arch categories should run, not all |
| `discovery-exclude-paths` | `[node_modules, dist, .next]` | `[]` | Excluded paths; verify discovery skips these directories |
| `discovery-severity-threshold` | `medium` | `low` | Higher threshold; low-severity findings should be suppressed |
| `discovery-confidence-threshold` | `70` | `60` | Higher threshold; findings with confidence below 70 are auto-deferred instead of presented for triage |

### v2.0 persistence and safety

| Field | Value | Default | What it tests |
|-------|-------|---------|---------------|
| `persistence` | `true` | `true` | STATE.md creation, session memory writes, metrics collection all active |
| `memory-cleanup-threshold` | `3` | `5` | Lower threshold; cleanup suggestion triggers after just 3 session memory files |
| `enforcement` | `strict` | `warn` | **Key test**: scope violations are blocked (not just warned). Out-of-scope edits should fail. |
| `isolation` | `worktree` | `auto` | Explicit worktree isolation; every agent gets its own git worktree |
| `max-turns` | `15` | `auto` | Fixed turn limit; agents exceeding 15 turns must report PARTIAL |

## Test Scenarios

These scenarios map config fields to observable behaviors during a full `/session feature` -> `/go` -> `/close` cycle.

### Scenario 1: Session lifecycle with persistence

**Fields exercised:** `persistence`, `ssot-files`, `ssot-freshness-days`

- `/session feature` creates `.claude/STATE.md` with `status: active`
- Each wave updates STATE.md `current-wave` and appends to `## Wave History`
- `/close` sets STATE.md `status: completed`
- Session memory file is created at `~/.claude/projects/<project>/memory/session-<date>.md`
- MEMORY.md index is updated with a link to the new session file
- STATUS.md freshness is checked against 3-day threshold

### Scenario 2: Strict enforcement blocks scope violations

**Fields exercised:** `enforcement`, `isolation`

- `.claude/wave-scope.json` is written before each wave with `enforcement: strict`
- An agent attempting to edit a file outside `allowedPaths` should be blocked (not just warned)
- Discovery agents (Wave 1) should have empty `allowedPaths` and be read-only
- Quality agents (Wave 4) should only be allowed to modify test files

### Scenario 3: Circuit breaker with fixed turn limit

**Fields exercised:** `max-turns`

- Every agent prompt includes `TURN LIMIT: You have a maximum of 15 turns`
- An agent that cannot complete within 15 turns reports `PARTIAL`
- Spiral detection catches agents editing the same file 3+ times
- PARTIAL and SPIRAL agents are logged in STATE.md

### Scenario 4: Worktree isolation

**Fields exercised:** `isolation`

- Each agent in feature/deep sessions runs in its own git worktree
- Post-wave merge integrates worktree changes back to main branch
- Merge conflicts are resolved with documented strategy
- Worktrees are cleaned up after session ends

### Scenario 5: Metrics and learnings pipeline

**Fields exercised:** `persistence`, `memory-cleanup-threshold`

- `.claude/metrics/sessions.jsonl` receives a JSONL entry after `/close`
- Entry contains `session_id`, `duration_seconds`, `total_waves`, `total_agents`, `agent_summary`
- `.claude/metrics/learnings.jsonl` is populated with extracted learnings (fragile files, sizing, recurring issues)
- After 3+ session memory files, cleanup suggestion is shown

### Scenario 6: Custom quality commands

**Fields exercised:** `test-command`, `typecheck-command`, `lint-command`

- Quality wave runs `npm test` (not default `pnpm test --run`)
- TypeScript check uses `npx tsc --noEmit` (not default `tsgo --noEmit`)
- Lint check uses `npx eslint .` (not default `pnpm lint`)
- Session-end Full Gate uses all three custom commands

### Scenario 7: Discovery on close

**Fields exercised:** `discovery-on-close`, `discovery-probes`, `discovery-exclude-paths`, `discovery-severity-threshold`

- `/close` Phase 1.5 triggers discovery scan automatically
- Only `code` and `arch` probe categories execute
- `node_modules`, `dist`, `.next` are excluded from scanning
- Only findings with severity `medium` or higher are reported
- Critical/high findings create issues; medium findings are listed as deferred

### Scenario 8: Adaptive wave sizing

**Fields exercised:** `agents-per-wave`, `waves`

- Session-plan complexity scoring produces a tier (simple/moderate/complex)
- Agent counts per wave follow the tier table but never exceed `agents-per-wave: 6`
- With `waves: 5`, roles map 1:1 (Discovery, Impl-Core, Impl-Polish, Quality, Finalization)
- Project intelligence (learnings) overrides formula-based sizing when available

### Scenario 9: VCS and threshold integration

**Fields exercised:** `vcs`, `cli-tools`, `issue-limit`, `recent-commits`, `stale-branch-days`, `stale-issue-days`

- Session-start uses `gh` CLI for all VCS operations
- Issue queries fetch at most 25 issues
- `git log` shows 15 recent commits
- Branches with no commits in 5+ days are flagged stale
- Issues with no progress in 14+ days are flagged for triage

### Scenario 10: Confidence threshold filtering

**Fields exercised:** `discovery-confidence-threshold`, `discovery-severity-threshold`

- Discovery Phase 3.2a scores each finding using pattern specificity, file context, and historical signal
- With `discovery-confidence-threshold: 70`, findings scoring below 70 are auto-deferred (not the default 60)
- A medium-severity finding in a test fixture (baseline 40 + 0 specificity + 0 context = 40) is auto-deferred
- A high-specificity finding in production source (baseline 40 + 20 + 20 = 80) passes the threshold and is presented for triage
- Critical-severity findings get a minimum confidence of 70 and are never auto-deferred
- Auto-deferred findings appear in a collapsed informational section, not in interactive triage
