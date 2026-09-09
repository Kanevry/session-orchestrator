# Wave Executor — STATE.md Initialization (Pre-Wave 1b)

> Reference of the wave-executor skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`, `wave-loop.md` → `../wave-loop.md`, `circuit-breaker.md` → `../circuit-breaker.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.
> Read at Pre-Wave 1b, before dispatching Wave 1 — see `../SKILL.md` § Pre-Wave 1b for the pointer.

## Pre-Wave 1b: Initialize STATE.md

> Skip this section entirely if `persistence: false`.

Before dispatching Wave 1, write `<state-dir>/STATE.md` with YAML frontmatter and Markdown body:

```yaml
---
schema-version: 1
session-type: feature|deep|housekeeping
branch: <current branch>
issues: [<issue numbers from plan>]
started_at: <ISO 8601 timestamp with timezone>
status: active
current-wave: 0
total-waves: <from session plan>
---
```

```markdown
## Current Wave

Wave 0 — Initializing

## Wave History

(none yet)

## Deviations

(none yet)
```

Create the `<state-dir>` directory if needed (`mkdir -p <state-dir>`) before writing. This file is the persistent state record — other skills and resumed sessions read it.

**Then VALIDATE `total-waves` against the resolved shape — do not skip this.** A plan whose wave count the shape does not produce must never be dispatched silently:

```bash
node scripts/session-shape.mjs --repo-root "$PWD" \
  --session-type <session-type> [--profile <session-profile>] [--known-scope true|false] \
  --no-event | jq .totalWaves
```

`--no-event` is used HERE because the plan-time run already recorded `orchestrator.session.shape_resolved` — this is a re-read, not a second resolution. Compare the printed number with the plan's wave count (the value just written to `total-waves`):

- **Equal** → continue to Wave 1.
- **Mismatch** → STOP. Surface it via `AskUserQuestion` per `.claude/rules/ask-via-tool.md`, with the shape's number and the plan's number both in the option descriptions: **re-plan to the shape (Recommended)** — rebuild the wave plan at the shape's wave count, the only outcome that keeps STATE.md, the ledger and the dispatch loop describing the same session — versus **proceed with a logged Deviation**, which requires appending the divergence to STATE.md `## Deviations` (`appendDeviationOnDisk()` from `scripts/lib/state-md.mjs`) before the first dispatch.

#### Pre-Wave 1b Extension: Docs Tasks Persistence (A3 / #230)

After writing the base STATE.md frontmatter above, conditionally persist the docs tasks block emitted by session-plan:

**Condition:** BOTH of the following must be true:
1. The session plan contains a `### Docs Tasks (machine-readable)` section with a YAML code block.
2. `$CONFIG."docs-orchestrator".enabled` is `true`.

If either condition is false → omit the `docs-tasks` field entirely. Do NOT write an empty key (`docs-tasks: []`). Absence means "no docs tasks planned this session" — downstream consumers (session-end Phase 3.2) treat absence the same as an empty list.

When the condition is met, parse the YAML block from the session plan's `### Docs Tasks (machine-readable)` section and append the following field to the STATE.md YAML frontmatter (alongside the base fields above):

```yaml
docs-tasks:
  - id: <task id from plan>
    audience: <user|dev|vault>
    target-pattern: <glob pattern from plan>
    rationale: <rationale string from plan>
    wave: <wave number the task is assigned to>
    status: planned
```

Each entry's `status` is initialized to `planned`. session-end Phase 3.2 (Docs Verify) writes the terminal value per task: `ok` (diff is substantive), `partial` (diff region contains `<!-- REVIEW: source needed -->` markers), or `gap` (no matching diff). wave-executor does NOT perform intermediate status updates — `planned` remains until session-end runs.

> **Schema note:** `schema-version: 1` now includes the optional `docs-tasks` array. The field is backwards-compatible — its absence is a valid schema-version-1 STATE.md meaning "no docs tasks planned". Readers MUST treat a missing `docs-tasks` key identically to `docs-tasks: []`.

> **Ownership clarification:** session-plan does NOT write STATE.md directly. The wave-executor owns ALL STATE.md writes — initialization here (Pre-Wave 1b) is the canonical write point for `docs-tasks`. session-plan only emits the source `### Docs Tasks (machine-readable)` block for the coordinator to consume. See `skills/_shared/state-ownership.md` for the full ownership matrix.

> **Consumer cross-reference:** session-end reads `STATE.md` frontmatter's `docs-tasks` field (if present) during Phase 3.2 Docs Verify — see `skills/session-end/SKILL.md`. The field is also readable by the docs-writer agent if it needs to know which tasks were planned for the current session.

> **Ownership:** STATE.md is owned by the wave-executor. Only the wave-executor writes to it (initialization + post-wave updates). session-end reads it for metrics extraction and sets `status: completed`. session-start reads it only for continuity checks (Phase 0.5). No other skill should write to STATE.md.

