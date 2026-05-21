---
description: Manual memory consolidation — review, consolidate, and prune memory files (Dream-equivalent)
argument-hint: "[--dry-run | --apply-pending]"
---

# Memory Cleanup

The user wants to consolidate the project's auto-memory store. Invoke the `memory-cleanup` skill.

## Flags

The skill accepts two optional, mutually-exclusive flags (see PRD #502):

| Flag | Behavior |
|---|---|
| `--dry-run` | Run Phases 1-3 read-only. Writes a unified-diff proposal to `.orchestrator/pending-dream.md` (atomic write). Prints `pending-dream written: <N> lines proposed` (or `no consolidation needed`). Exit 0. |
| `--apply-pending` | Reads `.orchestrator/pending-dream.md`, refuses if older than 14 days, applies the diff, deletes the pending file. Prints `auto-dream applied: -<X> lines, +<Y> entries`. Exit 0 on apply; exit 1 when pending file is missing (`no pending dream to apply`) or stale (`pending dream is stale (>14d), re-run --dry-run`). |

Passing both flags is an error. Absence of both = legacy interactive 4-phase mode.

The auto-dream subsystem at session-end Phase 3.6.5 (`scripts/lib/auto-dream.mjs`) is the primary producer of `.orchestrator/pending-dream.md`; `--apply-pending` is the operator-confirmed consumer in the next session. The sidecar file is single-writer — concurrent sessions cannot collide because the writer holds the session-lock.

## Default (no flag)

Run the 4-phase Dream process (Orient → Gather Signal → Consolidate → Prune & Index) against `~/.claude/projects/<encoded-cwd>/memory/`. Report files changed, `MEMORY.md` line count before/after, contradictions resolved, and any items that need manual attention.
