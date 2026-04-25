---
description: Autonomous session-orchestration loop with kill-switches (Phase C-1.b — all 8 kill-switches shipped)
argument-hint: [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X] [--dry-run]
---

# Autopilot

You are entering autonomous session-orchestration mode. The user has invoked `/autopilot` with arguments: **$ARGUMENTS**

## Status

**Phase C-1.b complete (issues #295 + #300). Runtime at `scripts/lib/autopilot.mjs`.** All 8 kill-switches enforced — pre-iteration: `max-sessions-reached`, `max-hours-exceeded`, `resource-overload`, `low-confidence-fallback`, `user-abort`; post-session: `spiral`, `failed-wave`, `carryover-too-high`. Post-session gates read schema-canonical fields off the `sessionRunner` return shape (`agent_summary.{spiral, failed}` numeric counts, `effectiveness.{carryover, planned_issues}`); absent fields are forward-compatible (no kill).

Production `sessionRunner` callers MUST persist `args.autopilotRunId` into the per-iteration `sessions.jsonl` record (additive optional field, schema_version 1 compatible). Manual sessions write `null` or omit the field — readers treat both identically.

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
