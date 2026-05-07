---
status: skizze
appetite: 6w (Big Batch — Shape Up)
created: 2026-05-07
updated: 2026-05-07
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

> **Status: SKIZZE** — This is a Phase-Sketch for a future `/plan feature` or `/plan retro` session, not a fully-shaped PRD. Sections marked `[OPEN]` need user input. Do not implement until promoted to `status: shaped`.

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

## 4. Key open questions [OPEN]

- [OPEN-1] **Issue selection criteria.** "Ready" = `status:ready + priority:auto`? Or any `status:ready`? Or labelled `autopilot:eligible`?
- [OPEN-2] **N-concurrency cap.** Static (e.g., 3) or derived from resource-probe (free-RAM / peer-claude-count heuristic)?
- [OPEN-3] **Stop-condition.** Run until backlog empty? Until N successful loops complete? Until first kill-switch trips?
- [OPEN-4] **Cross-loop dependency handling.** If story B is blocked-by story A, must B wait for A's PR-merge? Or just A's commit on its branch?
- [OPEN-5] **Failure isolation.** If one loop hits SPIRAL kill-switch, does it abort all sibling loops or just itself?
- [OPEN-6] **PR-creation policy.** Auto-create draft MR with TODO list of tests? Or wait for first green test run?

## 5. Suggested architecture (sketch — not final)

```
scripts/autopilot.mjs                    [existing, --headless single-story]
scripts/autopilot-multi.mjs              [NEW, --multi-story orchestrator]
scripts/lib/dep-graph.mjs                [NEW, builds DAG from glab/gh issues]
scripts/lib/worktree-pipeline.mjs        [NEW, per-story loop driver]
scripts/lib/autopilot-multi-killswitch.mjs [NEW, includes STALE_SUBAGENT_MIN]
.orchestrator/metrics/autopilot.jsonl    [extend schema with worktree_path, parent_run_id]
```

## 6. Risks

- **Auth/PR collisions:** parallel `glab mr create` from worktrees against the same issue could race. Mitigation: one-issue-one-loop invariant + PR check before create.
- **Worktree cleanup:** abandoned worktrees consume disk. Mitigation: cleanup-on-exit + nightly stale-worktree GC script.
- **Schema-drift in autopilot.jsonl:** adding fields needs a Migrate-CLI v3 clause for backward-compat.
- **Resource exhaustion:** N concurrent Claude sessions can spike RAM beyond resource-probe's safety margin if the probe is point-in-time. Mitigation: continuous resource sampling per loop, kill-switch on threshold breach.

## 7. Out of scope (explicitly)

- Auto-merge after PR review (v3.5+).
- Cross-host distribution (single-host concurrency only).
- Cross-repo orchestration (single-repo per autopilot run).
- Live human-in-the-loop intervention during a running loop (kill-only, no resume-with-input).

## 8. Definition of "promoted to shaped"

Before this PRD is implementation-ready, all 6 [OPEN] questions must have answered with explicit user decision recorded inline. A `/plan feature` session against this skizze is the right vehicle.

## 9. Estimated work

- 1 wave: dep-graph + issue-selection + N-cap heuristic
- 2 waves: worktree-pipeline driver + per-loop kill-switches
- 1 wave: schema-extend autopilot.jsonl + Migrate-CLI v3 clause + tests
- 1 wave: integration test harness + smoke run on a small backlog
- 1 wave: docs (CLAUDE.md, README, command reference) + release-cut to v3.4.0

Total: ~5 waves over 2-3 deep sessions, well within the Big Batch 6w appetite.
