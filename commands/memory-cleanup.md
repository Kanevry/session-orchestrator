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
| `--dry-run` | Run Phases 1-3 read-only. Writes a complete-replacement MEMORY.md proposal (single fenced ` ```markdown ` block; topic-file changes carried as separate `### Topic-file change:` sections after it — never git-style diff hunks, see #717) to `.orchestrator/pending-dream.md` (atomic write). Prints `pending-dream written: <N> lines proposed` (or `no consolidation needed`). Exit 0. |
| `--apply-pending` | Reads `.orchestrator/pending-dream.md`, refuses if older than 14 days, applies the proposal, deletes the pending file. Prints `auto-dream applied: -<X> lines, +<Y> entries`. Exit 0 on apply; exit 1 when pending file is missing (`no pending dream to apply`), stale (`pending dream is stale (>14d), re-run --dry-run`), or unsupported-format (`auto-dream NOT applied: pending-dream.md contains git-style diff hunks this applier cannot consume. MEMORY.md left untouched, sidecar preserved. Re-run /memory-cleanup --dry-run to regenerate a complete-body proposal.`). |

Passing both flags is an error. Absence of both = legacy interactive 4-phase mode.

Session-end Phase 3.6.5 (`scripts/lib/auto-dream.mjs`) is nudge-only (#614) — it never dispatches a subagent to write the sidecar. The only real producer of `.orchestrator/pending-dream.md` is a manual `/memory-cleanup --dry-run` run; `--apply-pending` is the operator-confirmed consumer in a later session. The sidecar file is single-writer — concurrent sessions cannot collide because the writer holds the session-lock.

## Default (no flag)

Run the 4-phase Dream process (Orient → Gather Signal → Consolidate → Prune & Index) against `~/.claude/projects/<encoded-cwd>/memory/`. Report files changed, `MEMORY.md` line count before/after, contradictions resolved, and any items that need manual attention.
