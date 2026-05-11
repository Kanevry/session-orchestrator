---
status: shaped
appetite: 6w (Big Batch — Shape Up)
created: 2026-05-07
updated: 2026-05-11
discovery_session: discovery-2026-05-07
inspired_by:
  - https://github.com/stephenleo/bmad-autonomous-development
  - 2026-05-07 /discovery benchmark synthesis
visibility: internal
related_issues:
  - "#341"
  - "#297 (data-gated)"
  - "#298 (data-gated)"
---

# Autopilot Phase D — Per-Story Worktree Pipelines (Multi-Story Concurrency)

> **Status: SHAPED — implementation underway in session main-2026-05-11-deep-1**

## 1. Why

The v3.2 Autopilot loop (Phases A/B/C-1/C-1.b/C-1.c/C-2/C-5) ships a single-story sequential walk-away CLI driver: `claude -p "/session <mode>"`, one session at a time. That's correct for v3.2 but caps throughput at 1 in-flight session per host.

stephenleo's BAD repo (https://github.com/stephenleo/bmad-autonomous-development) demonstrates the next step: a dependency-graph driver over the issue backlog, spawning N parallel pipelines in isolated git worktrees, each running an end-to-end Spec→Tests→Dev→TestReview→CodeReview→PR cycle. Per-pipeline staleness watchdogs prevent zombies. The closed-loop auto-merge phase makes the system actually walk away.

For Session Orchestrator, this is the natural Phase D — and crucially, it generates the RUN volume that unblocks data-gated #297 (cap-decision threshold calibration, needs 10+ runs) and #298 (/evolve type 8, needs ≥20 paired runs/mode).

## 2. Goal (one sentence)

Add a `--multi-story` mode to `/autopilot` that reads ready-state issues from the backlog, builds a dependency graph from `blocks/blocked-by` relations, and spawns up to N parallel session loops in isolated git worktrees with per-loop kill-switches.

## 3. Constraints

- **Resource gate:** existing `scripts/lib/resource-probe.mjs` must veto multi-story spawn when free RAM < threshold or peer-Claude count > limit. Re-use, do not duplicate.
- **Worktree isolation:** each story gets its own worktree at `~/.so-worktrees/<repo>/<issue-id>/`. Kill-switch on staleness. Worktree cleanup on completion.
- **No auto-push, no auto-merge in v1:** opt-in MR/PR draft creation, but human approval gates merge. Auto-merge is a separate v3.5 epic.
- **Telemetry compatibility:** every loop writes to the same `.orchestrator/metrics/autopilot.jsonl` schema (already Zod-validated); add `worktree_path` + `parent_run_id` fields.

## 4. Key decisions (all OPEN questions resolved)

### OPEN-1 — Issue selection criteria

[DECIDED]: Adopt `status:ready` label only.

Query: `glab issue list --label "status:ready" --output json`

Justification: zero migration cost — the label is already canonical in session-start/issue-close/spiral-carryover flows. "status:ready" is broad enough to admit all priorities without requiring a new `priority:auto` label. Future escalation path: add `priority:auto` label and filter on both if scheduling pathology (starvation of high-priority work) emerges in practice.

### OPEN-2 — N-concurrency cap

[DECIDED]: Hybrid formula `N = min(3, max(1, floor(free_ram_gb / 4) - 1))`.

- Static floor: 3 (proven safe at v3.2 `maxSessions=5` single-loop).
- Resource ceiling: 1 looper per 4 GB RAM, minus 1 for system buffer.
- On current M4 Pro (24 GB, ~22 GB free): `min(3, max(1, floor(22/4) - 1))` = `min(3, 4)` = 3.
- On 8 GB hosts: yields 1.
- Below 4 GB free: emit WARN and recommend `--max-sessions=1` (single-story fallback).

Implementation location: NEW `scripts/lib/autopilot/multi-killswitch.mjs` — export `calculateConcurrencyCap(snapshot)`.

### OPEN-3 — Stop-condition

[DECIDED]: Layered policy — orchestrator exits on FIRST of:

1. Any active looper hits a kill-switch (`SPIRAL` / `STALL_TIMEOUT` / `FAILED_WAVE` / `TOKEN_BUDGET_EXCEEDED` / `RESOURCE_OVERLOAD`).
2. Ready backlog empty AND no active loopers.
3. Inactivity timeout 300 s — no completed sessions in 5 min implies deadlock.

Justification: respects kill-switch precedence, enables graceful empty-backlog exit, and includes zombie-run safety via inactivity timeout. Condition 3 aligns with #297/#298 RUN-volume goals (3-concurrency over a 30-issue backlog → 10+ runs per session).

### OPEN-4 — Cross-loop dependency handling

[DECIDED]: Wait for A's commit on A's branch (NOT MR-merge).

Pattern:
- Query A's PR's `head.ref` branch for a commit whose timestamp is ≥ A's `resolved_at`.
- B rebases onto A's branch before running tests.
- A's commit SHA is documented in B's PR description for reviewer spot-check.
- Timeout: 30 min. If A's branch produces no qualifying commit after 30 min, return `BLOCKED_ISSUE_UNRESOLVABLE` and skip B.

Justification: requiring MR-merge would re-serialize the pipeline back to 1-at-a-time — exactly what Phase D exists to avoid. Commit-based dependency tracking matches the BMAD precedent. Risk: A's commit is reverted post-B's rebase — mitigated by SHA traceability in B's PR description.

### OPEN-5 — Failure isolation

[DECIDED]: Cohort abort on SPIRAL with single-retry hybrid.

Pattern:
- Each loop tracks `spiral_recovery_count` in its autopilot state.
- First SPIRAL on a loop → re-spawn that loop with a fresh mode-selector (transient recovery attempt).
- Second SPIRAL on the same loop, OR any other loop's first SPIRAL → `SIGTERM` all sibling loops, mark them `aborted_by_cohort: true` in `autopilot.jsonl`, orchestrator exits with `COHORT_ABORT`.

Justification: spiral typically signals a systemic issue (infra, config, or prompt topology); fail-fast on the second occurrence preserves forensic state. Single-retry handles transient noise.

Three NEW optional `AutopilotState` fields (mirrors deep-3 `stall_recovery_count` pattern):
- `blocked_by_issue: number | null`
- `aborted_by_cohort: boolean`
- `spiral_recovery_count: number`

These wire into `scripts/lib/autopilot/loop.mjs` per #341. Agent C6 (parallel to C1) adds them.

### OPEN-6 — PR-creation policy

[DECIDED]: Hybrid opt-in `--draft-mr={off|on-loop-start|on-green}`, default `off`. v1 has no auto-merge.

Implementation:
- Execution: `execFile('glab' | 'gh', [arg, vector, ...], { shell: false, timeout: 10000 })` with binary allowlist.
- Security: shell-metachar rejection regex `/[;&|`\$(){}\[\]<>!]/` applied to title and description (ADR-364 C5 finding).
- Collision detection: `glab mr list --source-branch <branch> --state opened --output json` BEFORE `mr create`; if an existing MR is found, log and skip.
- Title template: `[WIP] <issue.title> (Autopilot Loop #<runId>)`.
- Description: TODO checklist with tests/code-review checkboxes.
- Module path: `scripts/lib/autopilot/mr-draft.mjs` (NEW, P4 in Wave 3).

## 5. Architecture

```
scripts/autopilot.mjs                             [existing, --headless single-story]
scripts/autopilot-multi.mjs                       [NEW, --multi-story orchestrator]
scripts/lib/dep-graph.mjs                         [NEW, builds DAG from glab/gh issues]
scripts/lib/worktree-pipeline.mjs                 [NEW, per-story loop driver]
scripts/lib/autopilot/multi-killswitch.mjs        [NEW, calculateConcurrencyCap + STALE_SUBAGENT_MIN]
scripts/lib/autopilot/mr-draft.mjs                [NEW, draft MR creation with security guards]
.orchestrator/metrics/autopilot.jsonl             [extend schema: worktree_path, parent_run_id,
                                                   blocked_by_issue, aborted_by_cohort,
                                                   spiral_recovery_count]
```

## 6. Risks

- **Auth/PR collisions:** parallel `glab mr create` from worktrees against the same issue could race. Mitigation: one-issue-one-loop invariant + PR check before create (OPEN-6 collision detection).
- **Worktree cleanup:** abandoned worktrees consume disk. Mitigation: cleanup-on-exit + nightly stale-worktree GC via `scripts/gc-stale-worktrees.mjs` (shipped in deep-3).
- **Schema-drift in autopilot.jsonl:** adding fields needs a Migrate-CLI v3 clause for backward-compat.
- **Resource exhaustion:** N concurrent Claude sessions can spike RAM beyond resource-probe's safety margin if the probe is point-in-time. Mitigation: continuous resource sampling per loop, kill-switch on threshold breach. See §10 gap note.

## 7. Out of scope (explicitly)

- Auto-merge after PR review (v3.5+).
- Cross-host distribution (single-host concurrency only).
- Cross-repo orchestration (single-repo per autopilot run).
- Live human-in-the-loop intervention during a running loop (kill-only, no resume-with-input).

## 8. Definition of "promoted to shaped"

All 6 [OPEN] questions have been answered with explicit decisions recorded in §4. This PRD was promoted from `skizze` to `shaped` in session main-2026-05-11-deep-1 (Phase D thin-slice, Wave 2 Impl-Core C1).

## 9. Estimated work

- 1 wave: dep-graph + issue-selection + N-cap heuristic
- 2 waves: worktree-pipeline driver + per-loop kill-switches
- 1 wave: schema-extend autopilot.jsonl + Migrate-CLI v3 clause + tests
- 1 wave: integration test harness + smoke run on a small backlog
- 1 wave: docs (CLAUDE.md, README, command reference) + release-cut to v3.4.0

Total: ~5 waves over 2-3 deep sessions, well within the Big Batch 6w appetite. This session (main-2026-05-11-deep-1) is the first.

## 10. Substrate Readiness

ADR-364 thin-slice MVP (deep-3 + deep-1 follow-ups) provides all required substrate:

- `sessions.jsonl` optional fields: `agent_identity`, `worktree_path`, `parent_run_id`, `lease_acquired_at`, `lease_ttl_seconds`, `expected_cost_tier`.
- `autopilot.jsonl` state extensions: `worktree_path`, `parent_run_id`, `stall_recovery_count`.
- 10th kill-switch `STALL_TIMEOUT` (post-iteration, `scripts/lib/autopilot/kill-switches.mjs`).
- `scripts/gc-stale-worktrees.mjs` (CLI + programmatic, with `validateWorkspacePath` defence-in-depth).
- `validateWorkspacePath` helper (`scripts/lib/worktree/lifecycle.mjs`) — CWE-23 hardened via `isPathInside()`.

**Gap:** `resource-probe.mjs` is point-in-time only. Phase D v1 uses per-iteration `probe()` calls (one call per loop tick); continuous background sampling is deferred to Phase D.2. This is accepted for v1 — the concurrency cap formula (OPEN-2) and the `RESOURCE_OVERLOAD` kill-switch provide sufficient guard rails without continuous sampling.
