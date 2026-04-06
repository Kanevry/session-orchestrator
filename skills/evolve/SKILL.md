---
name: evolve
user-invocable: false
tags: [learning, intelligence, meta]
model-preference: sonnet
description: >
  Extract session patterns into reusable learnings. Three modes: analyze (extract from session history),
  review (edit/manage existing learnings), list (display active learnings). Manages .claude/metrics/learnings.jsonl.
---

# Evolve Skill

## Phase 0: Config & Data Loading

### 0.1 Read Session Config

Run `bash "$CLAUDE_PLUGIN_ROOT/scripts/parse-config.sh"` to get the validated config JSON. If it exits with code 1, read stderr for the error and report to the user. Store the JSON output as `$CONFIG`.

If the script is not available, fall back to reading CLAUDE.md manually per `docs/session-config-reference.md`.

### 0.2 Check Persistence

Extract `persistence` from `$CONFIG`. If `persistence` is `false`, abort with message:

> "Learnings require persistence to be enabled in Session Config. Add `persistence: true` to your Session Config block in CLAUDE.md."

### 0.3 Determine Mode

Read mode from `$ARGUMENTS`:
- If empty or not provided, default to `analyze`
- Valid modes: `analyze`, `review`, `list`
- If invalid mode provided, report error and list valid modes

### 0.4 Load Data

1. Read `.claude/metrics/sessions.jsonl` (session history) — if it does not exist, warn: "No session history found. Run at least one session first."
2. Read `.claude/metrics/learnings.jsonl` if it exists (current learnings)
3. Count existing learnings, note any where `expires_at` < current date (expired)

## Phase 1: Mode Dispatch

Route based on mode:
- `analyze` → Phase 2
- `review` → Phase 3
- `list` → Phase 4

---

## Phase 2: Analyze Mode (default)

Extract learnings from session history.

### Step 2.1: Read Session Data

- Read all entries from `.claude/metrics/sessions.jsonl`
- Parse each JSONL line as JSON
- Sort by `completed_at` descending (most recent first)
- If no sessions found, abort: "No session data available. Complete at least one session before running evolve."

### Step 2.2: Pattern Extraction

For each of the 5 learning types, apply these heuristics:

#### 1. fragile-file (type: `fragile-file`)

- Look at wave data: if the same file appears in 3+ waves' `files_changed` within a session, it is fragile
- Cross-session: if a file appears in 3+ different sessions' `files_changed`, flag it
- Subject = file path (relative to project root)

#### 2. effective-sizing (type: `effective-sizing`)

- Compare `total_agents` and `total_waves` across session types
- Calculate average agents per wave for each session type
- Subject = canonical identifier like `deep-session-sizing` or `feature-session-sizing`
- Insight = "Deep sessions average X agents across Y waves" or "Feature sessions work well with X agents/wave"

#### 3. recurring-issue (type: `recurring-issue`)

- Look at `agent_summary` — if `failed` or `partial` > 0 across multiple sessions, flag
- Check wave `quality` fields — repeated failures indicate recurring issues
- Subject = issue pattern identifier (e.g., "test-failures-in-wave-execution", "lint-regressions")

#### 4. scope-guidance (type: `scope-guidance`)

- Cross-reference `effectiveness.planned_issues` vs `effectiveness.completion_rate`
- **Skip sessions that lack the `effectiveness` field** (early sessions may not have it)
- If completion_rate is consistently 1.0 with N issues, note "N issues per session works well"
- If completion_rate < 0.7, note "scope was too large"
- Subject = `optimal-scope-per-session-type`

#### 5. deviation-pattern (type: `deviation-pattern`)

- Read `.claude/STATE.md` if it exists and check `## Deviations` section
- Cross-reference with session duration vs planned waves
- Subject = pattern name (e.g., "scope-creep-in-feature-sessions", "underestimated-complexity")

### Step 2.2b: Zero Patterns Check

If no patterns were extracted across all 5 types, report: "No patterns found in session history. This can happen with very few sessions or sessions that lack detailed wave/agent data." and skip to end (do not proceed to AskUserQuestion).

### Step 2.3: Deduplicate Against Existing Learnings

For each extracted pattern, check if a learning with same `type` + `subject` already exists in `learnings.jsonl`:

- **If exists:** propose confidence update (+0.15 if confirmed by new evidence, -0.2 if contradicted)
- **If new:** propose as new learning with confidence 0.5

### Step 2.4: Present Findings via AskUserQuestion

Present extracted patterns to the user for confirmation. Use AskUserQuestion with `multiSelect: true`:

```
AskUserQuestion({
  questions: [{
    question: "Which learnings should be saved?\n\nExtracted patterns from session history:",
    header: "Evolve — Confirm Learnings",
    options: [
      {
        label: "[type] subject",
        description: "insight | evidence: ... | confidence: 0.5 (new) or +0.15 (update)"
      },
      ...
      {
        label: "Skip all",
        description: "Do not save any learnings this time"
      }
    ],
    multiSelect: true
  }]
})
```

If user selects "Skip all" or selects nothing, abort gracefully: "No learnings saved."

### Step 2.5: Write Confirmed Learnings

For confirmed learnings, use atomic rewrite strategy:

1. Read ALL existing lines from `.claude/metrics/learnings.jsonl` (if exists) into memory
2. Apply confidence updates for confirmed existing learnings:
   - Increment confidence by +0.15
   - Cap at 1.0
   - Reset `expires_at` to current date + 90 days
3. Apply confidence decrements for contradicted learnings (-0.2)
4. Append new learnings with:
   - `id`: generate a uuid-v4 (use `uuidgen` or equivalent)
   - `type`: one of `fragile-file`, `effective-sizing`, `recurring-issue`, `scope-guidance`, `deviation-pattern`
   - `subject`: the pattern subject
   - `insight`: human-readable description of the pattern
   - `evidence`: specific data points that support the pattern
   - `confidence`: 0.5 for new learnings
   - `source_session`: session ID from which the pattern was extracted
   - `created_at`: current ISO 8601 date
   - `expires_at`: current date + 90 days (ISO 8601)
5. **Prune:** remove entries where `expires_at` < current date OR `confidence` <= 0.0
6. **Consolidate duplicates:** if same `type` + `subject` appears more than once, keep the entry with highest confidence
7. Write entire result back to `.claude/metrics/learnings.jsonl` with `>` (atomic rewrite, NOT append `>>`)

Report: "Saved N new learnings, updated M existing. Total active: K."

---

## Phase 3: Review Mode

Interactive management of existing learnings.

### Step 3.1: Load Learnings

- Read `.claude/metrics/learnings.jsonl`
- If file does not exist or is empty: "No learnings found. Run `/evolve analyze` first."
- Parse each line as JSON

### Step 3.2: Display Learnings

Present a formatted table grouped by type:

```
## Active Learnings

| # | Type | Subject | Confidence | Expires | Insight |
|---|------|---------|------------|---------|---------|
| 1 | fragile-file | src/lib/auth.ts | 0.80 | 2026-07-05 | Changed in 4 of last 5 sessions |
| 2 | effective-sizing | feature-session-sizing | 0.65 | 2026-06-20 | Feature sessions work well with 3 agents/wave |
| ... | ... | ... | ... | ... | ... |

Summary: N active learnings (M high confidence, K expiring soon)
```

### Step 3.3: Interactive Management

Use AskUserQuestion with options:

```
AskUserQuestion({
  questions: [{
    question: "What would you like to do with your learnings?",
    header: "Evolve — Review",
    options: [
      { label: "Boost confidence", description: "Select learnings to boost (+0.15)" },
      { label: "Reduce confidence", description: "Select learnings to reduce (-0.2)" },
      { label: "Delete specific learnings", description: "Select learnings to remove" },
      { label: "Extend expiry", description: "Reset expires_at to +90 days from now" },
      { label: "Done — no changes", description: "Exit without changes" }
    ]
  }]
})
```

If user selects "Boost confidence", "Reduce confidence", "Delete specific learnings", or "Extend expiry", present a follow-up AskUserQuestion with `multiSelect: true` listing all learnings by `# | type | subject` so the user can select which ones to modify.

### Step 3.4: Apply Changes

Use the same atomic rewrite strategy as Phase 2, Step 2.5:

1. Read all lines from `learnings.jsonl`
2. Apply the selected operation to selected learnings:
   - **Boost:** +0.15 confidence (cap 1.0), reset expires_at to +90 days
   - **Reduce:** -0.2 confidence
   - **Delete:** remove selected entries
   - **Extend:** reset expires_at to current date + 90 days
3. Prune entries where `expires_at` < current date OR `confidence` <= 0.0
4. Consolidate duplicates (same type + subject): keep highest confidence
5. Write entire result back with `>` (atomic rewrite)

Report: "Updated N learnings. Total active: K."

---

## Phase 4: List Mode

Simple read-only display.

### Step 4.1: Load and Display

- Read `.claude/metrics/learnings.jsonl`
- If file does not exist: "No learnings yet. Run `/evolve analyze` to extract patterns from session history."
- Parse each line as JSON

### Step 4.2: Formatted Output

Display a formatted table grouped by type:

```
## Active Learnings

### fragile-file
| Subject | Confidence | Expires | Insight |
|---------|------------|---------|---------|
| ... | ... | ... | ... |

### effective-sizing
| Subject | Confidence | Expires | Insight |
|---------|------------|---------|---------|
| ... | ... | ... | ... |

(repeat for each type that has entries)
```

### Step 4.3: Summary

Display summary line:

```
N active learnings (M high confidence, K expiring soon)
```

- **High confidence** = confidence > 0.7
- **Expiring soon** = expires_at within 14 days of current date

---

## Critical Rules

- **NEVER** modify `learnings.jsonl` without reading it first — race condition prevention
- **NEVER** skip the deduplication check — duplicates degrade the intelligence system
- **NEVER** write learnings without user confirmation — always present via AskUserQuestion first
- **ALWAYS** use uuid-v4 for new learning IDs (generate via `uuidgen` or equivalent bash command)
- **ALWAYS** set `expires_at` to current date + 90 days for new learnings
- **ALWAYS** present findings to user before writing — no silent writes
- **ALWAYS** use atomic rewrite (read all, modify, write all with `>`) — never append with `>>`
- **ALWAYS** cap confidence at 1.0 — never exceed

## Anti-Patterns

- **DO NOT** write learnings without user confirmation — always present via AskUserQuestion first
- **DO NOT** append to `learnings.jsonl` — always use atomic rewrite (read all, modify, write all)
- **DO NOT** create duplicate learnings — always check type + subject match first
- **DO NOT** set confidence above 1.0 or forget to cap it
- **DO NOT** fabricate patterns — only extract from actual session data with verifiable evidence
- **DO NOT** skip the pruning step — expired and zero-confidence entries must be removed on every write
