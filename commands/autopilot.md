---
description: Autonomous session-orchestration loop with kill-switches (Phase C scaffold — implementation pending)
argument-hint: [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X] [--dry-run]
---

# Autopilot

You are entering autonomous session-orchestration mode. The user has invoked `/autopilot` with arguments: **$ARGUMENTS**

## Status

**Phase C scaffold (issue #277). Runtime implementation pending — Phase C-1 follow-up.**

When the user invokes `/autopilot`, the skill currently emits the loop semantics from the PRD as a preview but does NOT execute sessions autonomously. The full runtime (`scripts/lib/autopilot.mjs::runLoop` with kill-switch enforcement, `autopilot.jsonl` writer, resource-adaptive cap logic) ships in a follow-up sub-issue.

If the user asks to actually run autopilot before Phase C-1 lands, inform them:

> `/autopilot` runtime is not yet implemented. The contract is specified in `skills/autopilot/SKILL.md` and `docs/prd/2026-04-25-autopilot-loop.md`. Track progress on the Phase C-1 implementation sub-issue. For now, run sessions manually via `/session [type]`.

## Argument Parsing (when implemented)

Parse `$ARGUMENTS` for these flags. Unrecognized flags are warned but ignored. Out-of-range values silently clamp to bounds.

| Flag | Default | Bounds |
|------|---------|--------|
| `--max-sessions=N` | `5` | 1..50 |
| `--max-hours=H` | `4.0` | 0.5..24.0 |
| `--confidence-threshold=0.X` | `0.85` | 0.0..1.0 |
| `--dry-run` | `false` | flag |

## Invocation

**Invoke the autopilot skill.** Follow `skills/autopilot/SKILL.md` precisely. Do NOT re-implement loop logic inline — the skill and `scripts/lib/autopilot.mjs` are authoritative.

Loop semantics, kill-switches, resource-adaptive cap logic, and telemetry contract are all documented in the skill. The PRD at `docs/prd/2026-04-25-autopilot-loop.md` is the underlying design document.

## Critical Rules

- Never invoke `/autopilot` from inside a running session — top-level command only.
- Never modify `selectMode` output to force a specific mode — use `/session [mode]` manually for that.
- Iteration boundaries are atomic; do NOT abort sessions mid-flight.
- Kill-switches are enforced by `scripts/lib/autopilot.mjs`, not by this command file or by Claude inline.
