---
name: evolve
user-invocable: false
tags: [learning, intelligence, meta]
model: sonnet
model-preference: sonnet
model-preference-codex: gpt-5.4-mini
model-preference-cursor: claude-sonnet-4-6
args-schema:
  - flag: --apply
    description: "Apply dialectic-derived diff to USER.md + AGENT.md"
  - flag: --dry-run
    description: "Show diff without writing (default)"
  - flag: --model <name>
    description: "Override single-pass LLM (haiku|sonnet|opus)"
  - flag: --budget-tokens <N>
    description: "Token budget for derivation prompt (default 8000)"
description: >
  Use this skill when extracting session patterns into reusable learnings. Three modes: analyze (extract from session history),
  review (edit/manage existing learnings), list (display active learnings). Manages .orchestrator/metrics/learnings.jsonl.
---

> **Platform Note:** State files use the platform's native directory: `.claude/` (Claude Code), `.codex/` (Codex CLI), or `.cursor/` (Cursor IDE). Shared metrics live in `.orchestrator/metrics/` (v2) with fallback to `<state-dir>/metrics/` for pre-v2.0 legacy data. See `skills/_shared/platform-tools.md`.

# Evolve Skill

## Phase 0: Bootstrap Gate

Read `skills/_shared/bootstrap-gate.md` and execute the gate check. If the gate is CLOSED, invoke `skills/bootstrap/SKILL.md` and wait for completion before proceeding. If the gate is OPEN, continue to Phase 1.

<HARD-GATE>
Do NOT proceed past Phase 0 if GATE_CLOSED. There is no bypass. Refer to `skills/_shared/bootstrap-gate.md` for the full HARD-GATE constraints.
</HARD-GATE>

## Phase 1: Config & Data Loading

**Telemetry start marker (#1200):** note the current wall-clock time before Step 1.1 runs (e.g. `date +%s%3N`, or the coordinator's own turn-start instant). Every `orchestrator.evolve.completed` emit in Phase 1 / Phase 3 below reports `duration_ms` (placeholder `DURATION_MS`) as the elapsed milliseconds since this marker — same in-memory-value convention as `CT`/`AC`/`ASK`/`DROP` in `skills/session-end/SKILL.md`'s `orchestrator.handover.gated` emits.

### 1.1 Read Session Config

Read and parse Session Config per `skills/_shared/config-reading.md`. Store result as `$CONFIG`.

### 1.2 Check Persistence

Extract `persistence` from `$CONFIG`. If `persistence` is `false`, abort with message:

> "Learnings require persistence to be enabled in Session Config. Add `persistence: true` to your Session Config block (CLAUDE.md for Claude Code, AGENTS.md for Codex CLI)."

**Telemetry on abort (#1200, #1206):** before stopping, emit the abort form of the run-completion event. Kept as a minimal `emit-event.mjs` call, not routed through `scripts/sweep-expired-learnings.mjs` — no store-write CLI has run yet at this gate (it fires before Step 1.4 even reads `learnings.jsonl`), so there is no mechanical pipeline call site to fold this emit into, unlike the Step 3.5(5)/(6) success path below:

```bash
node scripts/emit-event.mjs --type orchestrator.evolve.completed --payload \
  "$(node -e "process.stdout.write(JSON.stringify({aborted: 'persistence-disabled', reason: 'Learnings require persistence to be enabled in Session Config.'.slice(0,300), duration_ms: DURATION_MS}))")"
```

### 1.3 Determine Mode

Read mode from `$ARGUMENTS`:
- If empty or not provided, default to `analyze`
- Valid modes: `analyze`, `review`, `list`, `dialectic`
- If invalid mode provided, report error and list valid modes

### 1.4 Load Data

**Lazy-create defensive (#185):** If `.orchestrator/metrics/learnings.jsonl` does not exist (pre-#185 repo or bootstrap skipped), create an empty file and emit an info log — do NOT hard-fail:

```bash
LEARNINGS_FILE=".orchestrator/metrics/learnings.jsonl"
if [[ ! -f "$LEARNINGS_FILE" ]]; then
  mkdir -p "$(dirname "$LEARNINGS_FILE")"
  : > "$LEARNINGS_FILE"
  echo "info(#185): auto-created $LEARNINGS_FILE (was missing)" >&2
fi
```

This defensive step is idempotent and cheap — it ensures `/evolve analyze|review|list` never fails because of a missing artifact file.

1. Read `.orchestrator/metrics/sessions.jsonl` (session history). If it does not exist, check `<state-dir>/metrics/sessions.jsonl` as a legacy fallback (where `<state-dir>` is `.claude/`, `.codex/`, or `.cursor/` per platform). If neither exists, warn: "No session history found. Run at least one session first."
2. Read `.orchestrator/metrics/learnings.jsonl` if it exists. If not found, check `<state-dir>/metrics/learnings.jsonl` as a legacy fallback.
3. Count existing learnings, note any where `expires_at` < current date (expired)

## Phase 2: Mode Dispatch

Route based on mode:
- `analyze` → Phase 3
- `review` → Phase 4
- `list` → Phase 5
- `dialectic` → Phase 6

---

## Phase 3: Analyze Mode (default)

Extracts learnings from session history: pattern extraction across the 9 built-in analyzer types plus `evolve.extra-sources`, deduplication, relation judgment (#1016), the AskUserQuestion confirmation gate, and the archive-safe write pipeline (through the C2 auto-repair feeder). See [references/evolve-analyze-mode.md](references/evolve-analyze-mode.md). **Read WHEN:** Phase 2's Mode Dispatch routes to `analyze` (the default mode).

---

## Phase 4: Review Mode

Interactive management of existing learnings.

### Step 4.1: Load Learnings

- Read `.orchestrator/metrics/learnings.jsonl`. If not found, check `<state-dir>/metrics/learnings.jsonl` as a legacy fallback.
- If neither exists or both are empty: "No learnings found. Run `/evolve analyze` first."
- Parse each line as JSON

### Step 4.2: Display Learnings

Present a formatted table grouped by type. Include the **Effective** column — the
recency-decayed surfacing score (#670) — so stale high-confidence entries are visible
as decay candidates next to their static confidence:

```
## Active Learnings

| # | Type | Subject | Confidence | Effective | Expires | Insight |
|---|------|---------|------------|-----------|---------|---------|
| 1 | fragile-file | src/lib/auth.ts | 0.80 | 0.78 | 2026-07-05 | Changed in 4 of last 5 sessions |
| 2 | effective-sizing | feature-session-sizing | 0.65 | 0.61 | 2026-06-20 | Feature sessions work well with 3 agents/wave |
| ... | ... | ... | ... | ... | ... | ... |

Summary: N active learnings (M high confidence, K expiring soon)
```

> **Effective (decayed) score — #670.** Retrieval/surfacing ranks by an
> `effectiveScore = max(confidence × 0.5^(ageDays / halfLifeDays), confidence × floorFactor)`
> blend, NOT raw confidence. `ageDays` derives from `last_reinforced` / `last_accessed` /
> `updated_at` when present, else `created_at`. So a stale high-confidence learning ranks
> below a fresh mid-confidence one, while the `floorFactor` (default 0.1) guarantees a
> durable learning never collapses to ~0. Tuned under the existing `evolve:` Session Config
> block (`decay-enabled: true`, `decay-half-life-days: 90`, `decay-floor-factor: 0.1` — all
> conservative defaults; set `decay-enabled: false` to restore pure-confidence ordering).
> Implemented in `scripts/lib/learnings/surface.mjs` (`effectiveScore` + `surfaceTopN`).
> The confidence FILTER (`> 0.3`) is unchanged — decay re-ranks survivors, it does not
> change eligibility.

### Step 4.3: Interactive Management

Use AskUserQuestion with options:

> On Codex CLI where AskUserQuestion is unavailable, present as a numbered Markdown list.

```
AskUserQuestion({
  questions: [{
    question: "What would you like to do with your learnings?",
    header: "Learnings",
    options: [
      { label: "Confidence ändern", description: "Pick the learnings, then the direction: +0.15 or -0.2. Cheapest fix when a learning is merely mis-weighted." },
      { label: "Ablauf verlängern", description: "Keeps a still-useful learning alive: its expiry date moves to today plus the configured window. Confidence is untouched." },
      { label: "Delete specific learnings", description: "Takes the selected learnings out of the store. They are archived rather than shredded, but they stop influencing anything." },
      { label: "Done — no changes", description: "Leaves the store exactly as it is and ends the review. Nothing is written." }
    ]
  }]
})
```

If user selects "Confidence ändern", "Ablauf verlängern", or "Delete specific learnings", present a follow-up AskUserQuestion with `multiSelect: true` listing all learnings by `# | type | subject` so the user can select which ones to modify. For "Confidence ändern" the same follow-up also asks for the direction — **Boost** (+0.15) or **Reduce** (-0.2). Both operations are unchanged; only the point at which the direction is chosen moved, because a single AskUserQuestion accepts at most 4 options and the previous list had 5.

> On Codex CLI where AskUserQuestion is unavailable, present as a numbered Markdown list.

### Step 4.4: Apply Changes

Use the same archive-safe pipeline as Phase 3, Step 3.5 — **never** a hand-rolled `>` rewrite (#1017):

1. Read all lines from `learnings.jsonl`
2. Apply the selected operation to selected learnings:
   - **Boost:** +0.15 confidence (cap 1.0), reset expires_at to +`learning-expiry-days`
   - **Reduce:** -0.2 confidence
   - **Delete:** omit the selected entries from the next generation — do NOT delete them by hand.
     `pruneLearnings()` detects every **record** that left the store — reconciled by `id`, or by a
     content fingerprint when a record carries no usable `id` — and archives it with
     `_archive_reason: "pruned"`, so a `learning-id` referenced by a rendered rule stays resolvable.
   - **Extend:** reset expires_at to current date + `learning-expiry-days`
3. Steps 3–5 of the old prose (prune / consolidate / rewrite) are `pruneLearnings()` — run the
   **exact** Step 3.5(5) invocation, writing the post-operation entry set to the `--entries`
   sidecar. It prunes
   (`expires_at` < now → `expired`; `confidence <= 0.0` → `pruned`), consolidates duplicates
   (same `type` + non-empty `subject`, highest confidence wins, loser archived `superseded` with
   `_superseded_by`; null-subject entries preserved individually per #284), and rewrites through
   `rewriteLearnings()` with its `.bak-<ISO>` snapshot.

Report: "Updated N learnings. Total active: K. Archived: A (<byReason>)."

---

## Phase 5: List Mode

Simple read-only display.

### Step 5.1: Load and Display

- Read `.orchestrator/metrics/learnings.jsonl`. If not found, check `<state-dir>/metrics/learnings.jsonl` as a legacy fallback.
- If neither exists: "No learnings yet. Run `/evolve analyze` to extract patterns from session history."
- Parse each line as JSON

### Step 5.2: Formatted Output

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

### Step 5.3: Summary

Display summary line:

```
N active learnings (M high confidence, K expiring soon)
```

- **High confidence** = confidence > 0.7
- **Expiring soon** = expires_at within 14 days of current date

---

## Phase 6: Dialectic Mode

Single-pass LLM derivation of USER.md + AGENT.md (peer cards) updates from current learnings + sessions + steering files, dry-run-default per #506 EARS contract. See [references/evolve-dialectic-mode.md](references/evolve-dialectic-mode.md). **Read WHEN:** Phase 2's Mode Dispatch routes to `dialectic`.

---

## Critical Rules

- **NEVER** modify `learnings.jsonl` without reading it first — race condition prevention
- **NEVER** skip the deduplication check — duplicates degrade the intelligence system
- **NEVER** write learnings without user confirmation — always present via AskUserQuestion first (on Codex CLI where AskUserQuestion is unavailable, present as a numbered Markdown list)
- **ALWAYS** use uuid-v4 for new learning IDs (generate via `uuidgen` or equivalent bash command)
- **ALWAYS** preserve a candidate-supplied `expires_at`; otherwise derive it from `LEARNING_TTL_DAYS[type]` via `deriveExpiresAt()` rather than hard-coding `learning-expiry-days`
- **ALWAYS** present findings to user before writing — no silent writes
- **ALWAYS** route store writes through `pruneLearnings()` / `rewriteLearnings()` — never a shell
  `>` rewrite and never an append `>>`. Those helpers own the schema validation, the `.bak-<ISO>`
  snapshot, and the atomic tmp+rename; a hand-rolled redirect owns none of them (#721, #1017)
- **ALWAYS** let a removed entry land in `learnings-archive.jsonl` — a record may leave the STORE,
  but it may never leave the CORPUS. Rendered `.claude/rules/*.md` cite `learning-id` as provenance;
  a hard delete turns that citation into a dangling pointer (#1017 measured 11 of 13 dead)
- **ALWAYS** cap confidence at 1.0 — never exceed

## Anti-Patterns

- **DO NOT** write learnings without user confirmation — always present via AskUserQuestion first (on Codex CLI where AskUserQuestion is unavailable, present as a numbered Markdown list)
- **DO NOT** append to `learnings.jsonl` with `>>`, and **DO NOT** rewrite it with `>` — call
  `pruneLearnings()` (Step 3.5(5)); a shell redirect bypasses validation, backup, and the archive
- **DO NOT** hard-delete a learning. Every record that leaves the store is archived with an
  `_archive_reason` (`expired` | `pruned` | `superseded` | `merged`) and, for the last two, a
  `_superseded_by` / `_merged_into` tombstone naming its replacement
- **DO NOT** create duplicate learnings — always check type + subject match first
- **DO NOT** set confidence above 1.0 or forget to cap it
- **DO NOT** fabricate patterns — only extract from actual session data with verifiable evidence
- **DO NOT** skip the pruning step — expired and zero-confidence entries must be removed on every write
