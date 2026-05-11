---
description: Multi-story autopilot orchestrator — runs N parallel issue pipelines in isolated git worktrees (v3.6 Phase D thin-slice)
argument-hint: [--dry-run|--apply] [--max-stories=N] [--max-hours=H] [--inactivity-timeout=S] [--stall-seconds=S] [--draft-mr=off|on-loop-start|on-green] [--json] [--verbose]
---

# Autopilot Multi

Phase D `--multi-story` autopilot orchestrator. Runs N parallel issue pipelines in isolated git worktrees with per-loop kill-switches. v1 thin-slice — dry-run plan + basic apply mode. The user has invoked `/autopilot-multi` with arguments: **$ARGUMENTS**.

## Status

**v3.6 Phase D thin-slice (deep-1 2026-05-11).** Built on ADR-364 substrate: sessions.jsonl optional fields (`agent_identity`, `worktree_path`, `parent_run_id`), autopilot.jsonl extensions, 10th `STALL_TIMEOUT` kill-switch, `scripts/gc-stale-worktrees.mjs`, `validateWorkspacePath` helper. Runtime entrypoint at `scripts/autopilot-multi.mjs` with libs under `scripts/lib/autopilot/{dep-graph,worktree-pipeline,multi-killswitch,mr-draft,stall-sampler}.mjs`.

Production-ready in v1: dry-run plan emission, basic apply mode (issue fetch + worktree spawn). Deferred to Phase D.2: cross-loop commit-wait, real SIGTERM cohort enforcement, on-green MR-draft trigger.

## Usage

```bash
node scripts/autopilot-multi.mjs [OPTIONS]
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--max-stories <N>` | `3` | Max parallel loops (clamped 1..10) |
| `--max-hours <H>` | `8` | Wall-clock budget in hours (0.5..24) |
| `--inactivity-timeout <S>` | `300` | Seconds without completion → stop (60..3600) |
| `--draft-mr <policy>` | `off` | `off` \| `on-loop-start` \| `on-green` |
| `--stall-seconds <S>` | `600` | Per-loop STALL_TIMEOUT threshold in seconds (60..3600) |
| `--dry-run` | `true` | Emit plan only, do not execute |
| `--apply` | `false` | Execute the plan (mutex with `--dry-run`) |
| `--json` | `false` | Machine-readable canonical envelope output |
| `--verbose` | `false` | Diagnostic output to stderr |
| `-h`, `--help` | — | Show usage and exit |
| `--version` | — | Print plugin version and exit |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | User error (bad flags, mutex violation) |
| `2` | System error (libs/binaries/probe failed) |

## Behaviour

**Issue selection (OPEN-1):** queries `glab issue list --label "status:ready"`. Only issues with that label are eligible for parallel pickup.

**Concurrency cap (OPEN-2):** `min(--max-stories, floor(free_ram_gb / 4) - 1)`. On a 24 GB host this typically resolves to 3 parallel loops; on a 16 GB host, 2.

**Stop condition (OPEN-3):** first of (a) any loop kill-switch trips, (b) backlog drained, (c) inactivity timeout exceeded, (d) wall-clock `--max-hours` exhausted.

**Cross-loop wait (OPEN-4):** loop B waits for loop A's **commit on its branch** (not MR-merge). B rebases onto A's branch when A's commit lands. Dependency graph computed via `scripts/lib/autopilot/dep-graph.mjs`.

**Failure isolation (OPEN-5):** first `SPIRAL` triggers a retry on the affected loop. A second `SPIRAL` triggers a cohort abort — all sibling loops receive SIGTERM (Phase D.2 will enforce a real kill; v1 marks them for abort and lets them exit naturally).

**Draft MR (OPEN-6):** opt-in via `--draft-mr=on-loop-start` (immediate draft on worktree spawn) or `--draft-mr=on-green` (deferred until quality gates green — Phase D.2). Default `off` — no auto-merge in v1.

**Worktree isolation:** every loop runs in its own `git worktree` rooted at `.orchestrator/worktrees/<issue-id>/`. `validateWorkspacePath` defence-in-depth runs before any `fsP.rm` from the gc sweeper. Stale worktrees are reaped by `scripts/gc-stale-worktrees.mjs` (run separately as housekeeping).

## Critical Rules

- Never invoke `/autopilot-multi` from inside a running session — top-level command only.
- `--dry-run` and `--apply` are mutually exclusive. The runtime rejects the invocation with exit code 1 if both are passed.
- Telemetry routes to `.orchestrator/metrics/autopilot.jsonl` (not `failures.jsonl`) per ADR-364 cross-connection rule 4.
- Each loop atomically writes one autopilot.jsonl record per iteration via tmp+rename. Do not append directly to that file from any other code path.

## See Also

- `docs/prd/2026-05-07-autopilot-phase-d.md` — full PRD (status: shaped)
- `docs/adr/2026-05-10-364-remote-agent-substrate.md` — ADR-364 substrate
- `scripts/lib/autopilot/{dep-graph,worktree-pipeline,multi-killswitch,mr-draft,stall-sampler}.mjs` — implementation
- [`/autopilot`](autopilot.md) — single-session headless driver (Phase C-1.b)
