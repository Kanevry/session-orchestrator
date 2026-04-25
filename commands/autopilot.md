---
description: Autonomous session-orchestration loop with kill-switches (Phase C-1 partial — 5 of 8 kill-switches shipped)
argument-hint: [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X] [--dry-run]
---

# Autopilot

You are entering autonomous session-orchestration mode. The user has invoked `/autopilot` with arguments: **$ARGUMENTS**

## Status

**Phase C-1 partial (issue #295). Runtime exists at `scripts/lib/autopilot.mjs`.** Five of the eight kill-switches are enforced this phase: `max-sessions-reached`, `max-hours-exceeded`, `resource-overload`, `low-confidence-fallback`, `user-abort`. The remaining three (`spiral`, `failed-wave`, `carryover-too-high`) plus `autopilot_run_id` propagation into `sessions.jsonl` are deferred to Phase C-1.b — they require wave-executor to expose the relevant signals on its return shape.

If the user asks to actually run multi-iteration autopilot before C-1.b lands, inform them:

> The runtime is functional for single-iteration / dry-run / max-sessions usage. Multi-iteration loops with session-result-dependent kill-switches (spiral, failed-wave, carryover-too-high) require Phase C-1.b. For now, prefer manual `/session [type]` for sessions where those signals matter.

## Argument Parsing

Parse `$ARGUMENTS` for these flags. Unrecognized flags are ignored. Out-of-range values silently clamp to bounds.

| Flag | Default | Bounds |
|------|---------|--------|
| `--max-sessions=N` | `5` | 1..50 |
| `--max-hours=H` | `4.0` | 0.5..24.0 |
| `--confidence-threshold=0.X` | `0.85` | 0.0..1.0 |
| `--dry-run` | `false` | flag |

Use `parseFlags` from `scripts/lib/autopilot.mjs` for canonical parsing — never re-implement clamping inline.

## Invocation

**Invoke the autopilot skill.** Follow `skills/autopilot/SKILL.md` precisely. Do NOT re-implement loop logic inline — the skill and `scripts/lib/autopilot.mjs` are authoritative.

The runtime entrypoint is `runLoop(opts)`. Production callers wire injectable dependencies as follows:

- `modeSelector`: invokes `selectMode` from `scripts/lib/mode-selector.mjs` with live signals from session-start Phase 7.5.
- `sessionRunner`: invokes the standard session-start → session-plan → wave-executor → session-end lifecycle for one iteration; returns `{session_id}` on success.
- `resourceEvaluator`: calls `evaluate(probe(), thresholds)` from `scripts/lib/resource-probe.mjs`.
- `peerCounter`: calls `detectPeers({sessionId})` from `scripts/lib/session-registry.mjs` and returns the array length.
- `abortSignal`: hooked to Ctrl+C / Esc handlers.

Loop semantics, kill-switches, resource-adaptive cap logic, and telemetry contract are documented in the skill. The PRD at `docs/prd/2026-04-25-autopilot-loop.md` is the underlying design document.

## Critical Rules

- Never invoke `/autopilot` from inside a running session — top-level command only.
- Never modify `selectMode` output to force a specific mode — use `/session [mode]` manually for that.
- Iteration boundaries are atomic; do NOT abort sessions mid-flight.
- Kill-switches are enforced by `scripts/lib/autopilot.mjs`, not by this command file or by Claude inline.
- The runtime writes ONE record to `.orchestrator/metrics/autopilot.jsonl` per invocation via atomic tmp+rename. Do not append directly to that file from any other code path.
