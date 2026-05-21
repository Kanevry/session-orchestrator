# Feature: Learning & Memory System Modernization

**Date:** 2026-05-21
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning, Opus 4.7 1M)
**Status:** Draft
**Appetite:** 6w (Big Batch — phased, with cooldown between Phase 1 and Phase 2)
**Parent Project:** session-orchestrator
**Visibility:** internal

---

## Research Provenance

This PRD is the product of a five-axis research dive completed on 2026-05-21:

1. **Inventory of our learning system** — 10 subsystems mapped (soul, owner persona, auto-memory, learnings, steering, sessions log, vault mirror, persona panel, memory-cleanup, lifecycle hooks).
2. **Cross-repo reality audit** — 19 active repos surveyed; 8 ACTIVE (42%), 2 STALE, 6 INSTALLED-UNUSED, 3 NOT-INSTALLED. **58% cold-start abandonment** is the headline finding.
3. **Hermes Agent reverse-engineering** — `github.com/NousResearch/hermes-agent` (160K stars, MIT, Python). Memory: `SOUL.md` + `USER.md` (1,375 char cap) + `MEMORY.md` (2,200 char cap) + SQLite session DB + 3-tier system prompt + inactivity-triggered Curator.
4. **Hermes feedback + competitor survey** — 13 systems compared (Letta, mem0, Claude Code auto-memory, Claude Skills, ChatGPT memory, Cursor Rules, Goose, CrewAI, LangMem, AutoGen/MAF, Aider, Hermes, MemGPT). Hermes deal-breakers: ALLOW-ALL security default (Issue #7826), unreliable self-eval, tiny memory caps, overwrites manual edits.
5. **Vault data flow audit** — Two vaults exist (`~/Projects/vault/` 48 files; `~/Projects/Bernhard/vault/` 1300+ files); `~/Projects/vault/` is redundant; buchhaltgenie writes to broken path (`/Users/bernhardg./...` — username drift); 100% dead-link rate in 10 most-recent learnings; 03-daily/ empty in the redundant vault.
6. **Honcho deep-dive** — `plastic-labs/honcho` (AGPL-3.0, 3.7K stars). Their unique angle is **reasoning at consolidation time, not query time** (the "Deriver" pattern). Decided NOT to adopt as backend (AGPL contagion, recurring LLM cost), but to STEAL three patterns: Peer abstraction, Two-layer context, Cadence knob.

---

## 1. Problem & Motivation

### What

Modernize the session-orchestrator's learning and memory subsystem in two sequenced phases:

- **Phase 1 — Refactor (Foundation Stabilization)**: consolidate the two parallel vaults into the canonical `~/Projects/Bernhard/vault/`, fix the broken vault-mirror path in buchhaltgenie, introduce a quality gate that prevents skeletal mirrored notes, and address the 58% cold-start abandonment rate via a post-bootstrap nudge.
- **Phase 2 — Adopt (Architecture Modernization)**: introduce four patterns derived from Hermes and Honcho — an agent-writable memory-proposal tool with AUQ-confirm safety; an auto-dream post-session hook (dry-run-default); a visible "what I remembered" session-start banner; per-project Peer Cards (`USER.md` + `AGENT.md`) refreshed by a new dialectic-deriver pass over `sessions.jsonl` + `learnings.jsonl`, ordered through `/evolve --dialectic` with a Session-Config cadence knob.

### Why

The current state has three honest weaknesses surfaced by the research dive:

1. **58% of audited repos never get past bootstrap.** Six repos (claude-usage-tracker, Macchiato, onenote, ai-factory-n8n, aiat-pmo, launchpad-ai-factory) have full `CLAUDE.md` + `.orchestrator/` provisioning but zero `sessions.jsonl` entries. The most damning is launchpad-ai-factory: full deluxe setup (CLAUDE.md + AGENTS.md + bootstrap.lock standard-tier) and zero sessions. Bootstrap fires, the system stays silent, and the operator never returns. This is the single highest-leverage adoption fix.
2. **The vault is half-dead with confused fragmentation.** Two parallel vaults exist; the redundant one accumulates skeletal machine-mirrored sessions while the real one (where 32 daily notes and the rich `decisions.md` narratives live) stopped receiving writes on 2026-05-17. One key producer (`buchhaltgenie`) writes to a path that doesn't exist (`/Users/bernhardg./...` — a username-drift bug), which explains the 100% dead-link rate in `~/Projects/vault/40-learnings/`. The hand-authored exception (`macos-app-notarization-nested-helpers-must-be-presigned.md`) proves the format CAN produce valuable content; the machine pipeline currently produces 1KB skeletons that read like template extrusions.
3. **Our memory architecture is one generation behind the field.** Letta, mem0, Hermes, LangMem all support mid-session memory writes — we extract learnings only at session-end. Our `/memory-cleanup` is manual-only, so drift accumulates between runs. We have no per-project identity layer (Hermes has `SOUL.md`/`USER.md`/`MEMORY.md` separation; Honcho has Peer Cards); we have steering files that hold domain context but no behavioural identity per repo. We have no surface UI for "what was loaded this session", which compounds the cold-start problem because the operator has no signal that the system is doing anything intelligent.

The Phase 2 work has a fourth driver: the `count-drift-recurrence` learning (S55→S68→S73, three sessions burned re-diagnosing the same pattern under different phrasing) is empirical proof that keyword-only recall fails on our own data. Hermes/Honcho/Letta solve this by reasoning at consolidation time rather than searching at query time — that's the architectural insight we adopt, deliberately leaving out the costly parts (Hermes' ALLOW-ALL security default, Honcho's AGPL+per-message-LLM-token-bill, embeddings sidecars premature for our <100-learnings-per-repo scale).

### Who

- **Primary persona:** Bernhard — deep-tier operator running session-orchestrator across 10+ active repos (mail-assistant 75 sessions, gotzendorfer-v2 52, aiat-pmo-module 47, AngebotsChecker 38, kalender-sync 31, wien-forschungsfragen-klima 30, aiat-kreativprojekte 12, buchhaltgenie 11). He feels every adoption gap directly because his work spans them.
- **Secondary persona:** Future contributors / external installers — the 58% cold-start abandonment rate suggests they currently churn before the system shows value. Phase 1.3's nudge targets exactly this cohort.
- **Tertiary persona:** Other session-orchestrator forks / consumers who would adopt the plugin from public release. The phased structure means they can opt out of Phase 2 entirely (Session-Config gated) without losing Phase 1 benefits.

---

## 2. Solution & Scope

### In-Scope — Phase 1 (Refactor: Foundation Stabilization)

- [ ] **F1.1 — Vault Consolidation.** One-shot migration script `scripts/vault-consolidate.mjs` that folds `~/Projects/vault/` content into `~/Projects/Bernhard/vault/` with per-file conflict resolution; archives the redundant vault under `.vault-backup-<timestamp>/`; finally deletes `~/Projects/vault/` after operator confirmation. Also fixes `buchhaltgenie/CLAUDE.md` vault-dir path (`/Users/bernhardg./...` → `/Users/bernhardg./Projects/Bernhard/vault`); scans all 19 audited repos for similar drift and reports.
- [ ] **F1.2 — Vault-Mirror Quality Gate.** New filter inside `scripts/vault-mirror.mjs` driven by Session-Config keys `vault-mirror.quality.min-narrative-chars` (default 400) and `vault-mirror.quality.min-confidence` (default 0.5, applies to learnings only). Below threshold → new action `skipped-quality-low` (joins the existing 6 actions). Session report surfaces skip count.
- [ ] **F1.3 — Cold-Start Abandonment Fix.** New `scripts/lib/cold-start-detector.mjs` reads `bootstrap.lock.timestamp` against `sessions.jsonl` line count. If `sessions.jsonl` is empty and bootstrap is ≥1h old, the `SessionStart` hook emits a "First session not yet" banner with a `/session housekeeping` suggestion and a one-line "what this gives you" pitch. Auto-silences after first session-end. Configurable via `cold-start.nudge-after-hours` (default 1) and `cold-start.silence-after-sessions` (default 1). One-shot migration step also scans the 6 already-installed-unused repos and seeds them with a `.orchestrator/welcome-banner-pending` marker so the nudge appears on their next open.

### In-Scope — Phase 2 (Adopt: Architecture Modernization)

- [ ] **F2.1 — Agent-writable Memory-Tool with AUQ-confirm.** New tool `memory.propose({type, subject, insight, evidence, confidence})` available to wave-executor agents. Writes to `.orchestrator/metrics/proposals.jsonl` (NOT `learnings.jsonl` directly). Coordinator collects proposals at session-end Phase 3.6.5, presents them via single AUQ call, and only confirmed entries flow into `learnings.jsonl` (with `_provenance: agent-proposed@<wave-id>` field). Quota: max 5 proposals per wave per agent (Session-Config: `memory.proposals.quota-per-wave` default 5); confidence floor 0.5; dropped proposals counted in session report.
- [ ] **F2.2 — Auto-Dream Post-Session-Hook (dry-run-default).** Session-end Phase 3.6.5 fires when (`MEMORY.md` > `memory-cleanup-soft-limit` lines, default 180) OR (sessions-since-last-cleanup ≥ `memory-cleanup-threshold`, default 5). Dispatches `/memory-cleanup --dry-run`; the proposed consolidation diff is written to `.orchestrator/pending-dream.md` and surfaced in the session report. User applies in next session via `/memory-cleanup --apply-pending`. No silent rewrites of `MEMORY.md`. (Avoids Hermes' "overwrites manual edits" bug.)
- [ ] **F2.3 — Visible "what I remembered" Session-Start Banner.** New session-start Phase 6.7 renders a single banner block: top-5 surfaced learnings (subject + confidence + type), memory-stats line (`N memory files · M sessions ever · last cleanup K days ago`), and (when Phase 2.4 exists) a one-line excerpt from `USER.md` + `AGENT.md`. Suppressible via `memory.banner.enabled: false`. Goal: transparency for the cold-start cohort + signal-of-intelligence for established operators.
- [ ] **F2.4 — USER.md + AGENT.md Peer Cards.** Per-project under `.orchestrator/peers/`, written by F2.5's dialectic pass. `USER.md` = operator-specific facts (preferences, patterns, history with this repo); `AGENT.md` = repo-specific behavioral identity (conventions to honour, gotchas to avoid, things tried-and-rejected). Vault-frontmatter schema (`type: peer-card`); hand-editable; merger (not overwriter) on next dialectic pass. Cards age-out: session-start warns if `updated` > 30 days. Empty state: cards don't exist until first dialectic pass — no scaffolding noise.
- [ ] **F2.5 — Dialectic-Deriver via `/evolve --dialectic`.** New mode of `/evolve`. Reads top-N learnings (default 50) + last-K sessions (default 10) + existing peer cards + project steering files; runs single LLM-pass with `dialectic.model` (default `haiku`) and `dialectic.budget-tokens` (default 8000); produces diff for `USER.md` + `AGENT.md`; dry-run-default. Triggered three ways: (a) manual `/evolve --dialectic [--apply]`; (b) session-end auto-trigger when sessions-since-last-dialectic ≥ `dialectic.cadence` (default 5); (c) honour kill-switch `dialectic.cadence: 0` for full opt-out. Token cost visible in session report.

### Out-of-Scope

- **Honcho SaaS / self-host adoption** — AGPL-3.0 contagion risk for the server, recurring LLM-token bill for the Deriver, opacity of derived conclusions vs our git-tracked deterministic `learnings.jsonl` lifecycle. We steal three patterns instead (see Architecture).
- **Embeddings / vector-store semantic search** — premature at our <100-learnings-per-repo scale; dialectic-deriver substitutes by reasoning over the full set rather than indexing it. Revisit when any single repo exceeds 1000 learnings.
- **Replacing Claude Code's harness-managed auto-memory** — `MEMORY.md` is harness magic; we don't control trigger or relevance heuristic. F2.3's banner reads the existing harness output rather than reimplementing it.
- **Multi-vault federation** — single canonical vault at `~/Projects/Bernhard/vault/`; cross-machine sync is git's job.
- **Memory dashboard UI** — terminal-first; the operator's vault browser is Obsidian.
- **Per-user cloud-synced profile** — `owner.yaml` stays per-host. Profile migration is operator-driven via `/bootstrap --owner-reset`.
- **Hermes-style messaging-gateway adapters** (Telegram/Discord/Slack/WhatsApp) — wrong product surface; we are a dev-tool plugin, not an end-user agent.
- **Memory-cleanup execution by an agent** — `/memory-cleanup --apply-pending` requires explicit operator command; no agent may apply consolidation autonomously.
- **Rich UI for "what I remembered"** — markdown text only; no HTML, no images.
- **Vault-mirror for arbitrary `.orchestrator/metrics/*.jsonl` files** — scoped to `sessions.jsonl` + `learnings.jsonl`; new files don't auto-mirror.

---

## 3. Acceptance Criteria

### F1.1 — Vault Consolidation
```gherkin
Given two vaults exist at "~/Projects/vault/" (48 files) and "~/Projects/Bernhard/vault/" (1300+ files)
When I run "node scripts/vault-consolidate.mjs --dry-run"
Then it lists every file in "~/Projects/vault/" with a planned action ("copy", "merge", "conflict-needs-review", "skip-already-present")
And it exits 0 without modifying either vault
```

```gherkin
Given the dry-run output identifies N conflict-needs-review files
When I run "node scripts/vault-consolidate.mjs --apply"
Then for each conflict file the script invokes AskUserQuestion with the two file contents shown
And the user-chosen resolution is written to the canonical vault
And the original conflicting source file is archived under "~/Projects/vault/.vault-backup-<ISO-timestamp>/"
```

```gherkin
Given the consolidation has finished successfully
When the script's final phase runs
Then it prompts "Delete redundant vault at ~/Projects/vault/?" via AskUserQuestion
And on confirmation, removes "~/Projects/vault/" recursively
And updates any repo CLAUDE.md "vault-integration.vault-dir" pointing to the redundant path to point to "~/Projects/Bernhard/vault"
```

```gherkin
Given buchhaltgenie's CLAUDE.md has "vault-integration.vault-dir: /Users/bernhardg./Projects/vault"
When the script's fix-paths phase runs
Then buchhaltgenie's CLAUDE.md is updated to "vault-integration.vault-dir: /Users/bernhardg./Projects/Bernhard/vault"
And a 1-line summary appears in the script output: "buchhaltgenie: fixed vault-dir (username drift)"
And the next vault-mirror invocation from buchhaltgenie produces no "skipped" actions
```

### F1.2 — Vault-Mirror Quality Gate
```gherkin
Given Session Config has "vault-mirror.quality.min-narrative-chars: 400"
When session-end Phase 3.7 invokes vault-mirror for a session whose narrative summary is 150 characters
Then vault-mirror emits "{\"action\":\"skipped-quality-low\",\"reason\":\"narrative-chars:150 < min:400\",\"path\":...,\"kind\":\"session\"}"
And the file is NOT written
And the session report includes a line "vault-mirror: 1 quality-skipped (set vault-mirror.quality.* to tune)"
```

```gherkin
Given Session Config has "vault-mirror.quality.min-confidence: 0.5" and a learning with confidence 0.3
When vault-mirror processes that learning entry
Then it emits "skipped-quality-low" with "reason: confidence:0.30 < min:0.50"
And the file is NOT written
```

```gherkin
Given vault-mirror.quality.min-confidence is unset (i.e. defaults to 0.5)
And no entries are quality-skipped during a session
Then no quality summary line appears in the session report (silence on success)
```

### F1.3 — Cold-Start Abandonment Fix
```gherkin
Given a repo where bootstrap.lock exists with timestamp >1h ago
And sessions.jsonl is empty (0 lines)
When the user opens Claude Code in that repo
Then the SessionStart hook prints a banner: "First session not yet — try /session housekeeping to see the orchestrator surface real work in your repo."
And the banner includes a single-line value pitch and the timestamp of bootstrap completion
```

```gherkin
Given a repo with sessions.jsonl line count = 1 (first session closed)
When SessionStart hook runs
Then the cold-start banner is NOT printed
And subsequent sessions never see the banner again for this repo
```

```gherkin
Given an existing INSTALLED-UNUSED repo (e.g. launchpad-ai-factory) where the migration scan has placed ".orchestrator/welcome-banner-pending"
When the user next opens Claude Code in that repo
Then the cold-start banner appears once
And ".orchestrator/welcome-banner-pending" is deleted after banner emission
```

```gherkin
Given Session Config has "cold-start.nudge-after-hours: 24"
When the user opens Claude Code in a repo bootstrapped 12h ago with 0 sessions
Then the cold-start banner is NOT printed
And the next open after the 24h threshold passes WILL print the banner
```

### F2.1 — Agent-Writable Memory-Tool
```gherkin
Given a wave-executor agent processing a task
When it calls memory.propose({type: "workflow-pattern", subject: "agent dispatch prefix rule", insight: "Plugin agents need session-orchestrator: prefix", evidence: "Confirmed S58 + S62 + S68", confidence: 0.85})
Then a new line is appended to .orchestrator/metrics/proposals.jsonl
And the returned value is {status: "queued", position: "1/5"}
And the proposal is NOT yet visible in learnings.jsonl
```

```gherkin
Given 7 proposals have been queued in a single wave (quota = 5)
When the agent calls memory.propose() for the 6th time
Then the tool returns {status: "quota-exceeded", quota: 5, dropped: 1}
And proposals 6 and 7 are NOT written to proposals.jsonl
And the session report includes "memory.proposals: 5 queued, 2 dropped (quota: 5)"
```

```gherkin
Given proposals.jsonl has 5 queued entries at session-end Phase 3.6.5
When the coordinator collects and presents them via AskUserQuestion (multiSelect)
Then the user can approve any subset
And approved entries are written to learnings.jsonl with _provenance="agent-proposed@<wave-id>"
And rejected entries are removed from proposals.jsonl (with .rejected.log archive)
And the session report shows "memory.proposals: 5 queued → 3 approved, 2 rejected"
```

```gherkin
Given memory.propose() is called with confidence 0.3 (below floor 0.5)
When the tool processes the request
Then it returns {status: "rejected-low-confidence", floor: 0.5}
And the proposal is NOT written to proposals.jsonl
And no AUQ is triggered at session-end for this proposal
```

### F2.2 — Auto-Dream Post-Session-Hook
```gherkin
Given MEMORY.md is 195 lines (> memory-cleanup-soft-limit of 180)
When session-end Phase 3.6.5 fires
Then it dispatches /memory-cleanup --dry-run as a subagent
And the proposed consolidation diff is written to ".orchestrator/pending-dream.md"
And the session report appends "auto-dream: dry-run produced — apply with /memory-cleanup --apply-pending in next session"
And MEMORY.md is NOT modified
```

```gherkin
Given sessions-since-last-cleanup = 5 (== memory-cleanup-threshold)
And MEMORY.md is 100 lines (under soft-limit)
When session-end Phase 3.6.5 fires
Then auto-dream still dispatches /memory-cleanup --dry-run (threshold OR soft-limit triggers)
```

```gherkin
Given ".orchestrator/pending-dream.md" exists from a prior session
When the user runs "/memory-cleanup --apply-pending" in a new session
Then the pending consolidation is applied to MEMORY.md
And ".orchestrator/pending-dream.md" is deleted after successful apply
And a confirmation line is printed: "auto-dream applied: -42 lines, +7 consolidated entries"
```

```gherkin
Given Session Config has "memory-cleanup-threshold: 0"
When session-end Phase 3.6.5 fires
Then auto-dream is bypassed entirely (kill-switch)
And no .orchestrator/pending-dream.md is produced
```

### F2.3 — Visible "What I Remembered" Banner
```gherkin
Given session-start Phase 6.6 surfaced 15 active learnings (sorted by confidence DESC)
When Phase 6.7 (banner) runs
Then a banner block is printed with: "📚 Loaded from memory" header
And lines for the top-5 learnings showing: subject, confidence (1 decimal), type
And a memory-stats line: "N memory files · M sessions ever · last cleanup K days ago"
```

```gherkin
Given Phase 2.4 peer cards exist (USER.md and AGENT.md)
When the banner runs
Then it appends one excerpt line from USER.md (first non-empty section header + first content line) and one from AGENT.md
```

```gherkin
Given Session Config has "memory.banner.enabled: false"
When session-start Phase 6.7 runs
Then no banner is printed (suppression honoured)
```

```gherkin
Given a fresh repo with 0 sessions and 0 learnings
When session-start Phase 6.7 runs
Then a single line is printed: "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward."
And no top-N section appears
```

### F2.4 — USER.md + AGENT.md Peer Cards
```gherkin
Given a repo without ".orchestrator/peers/"
When /evolve --dialectic --apply runs for the first time
Then ".orchestrator/peers/" is created
And ".orchestrator/peers/USER.md" is written with valid vault frontmatter (id, type=peer-card, target=user, created, updated, source_sessions)
And ".orchestrator/peers/AGENT.md" is written with frontmatter (id, type=peer-card, target=agent, created, updated, source_sessions)
And both files contain non-empty body sections (USER.md: Preferences/Patterns/History; AGENT.md: Identity/Behavior/Competencies/Avoid)
```

```gherkin
Given existing peer cards with hand-edits in USER.md
When the next /evolve --dialectic runs
Then the dialectic pass produces a MERGE diff (not overwrite) preserving hand-added sections
And conflict regions are surfaced (not silently auto-resolved)
And the operator can accept/reject per-section
```

```gherkin
Given USER.md "updated" field is 35 days ago
When session-start runs
Then a warning line is printed: "⚠ USER.md stale (35d) — consider running /evolve --dialectic"
```

```gherkin
Given peer cards are valid vault-frontmatter conformant
When vault-sync runs at session-end
Then peer cards pass validation (type=peer-card is in the allowed enum)
And no validation errors are emitted for the peer-card files
```

### F2.5 — Dialectic-Deriver
```gherkin
Given Session Config has "dialectic.cadence: 5" and sessions-since-last-dialectic = 5
When session-end finalizes
Then /evolve --dialectic --dry-run is auto-triggered
And the produced diff is attached to the session report
And ".orchestrator/dialectic-last-run" is updated with the new timestamp
And the diff is NOT applied (dry-run only)
```

```gherkin
Given dialectic.model = "haiku" and dialectic.budget-tokens = 8000
When /evolve --dialectic runs
Then the LLM call uses claude-haiku-4-5
And token usage is capped at 8000 input + 4000 output
And actual token usage appears in the run output
```

```gherkin
Given Session Config has "dialectic.cadence: 0"
When session-end finalizes
Then dialectic auto-trigger is bypassed (kill-switch)
And manual /evolve --dialectic still works
```

```gherkin
Given a session with 0 new learnings and 0 new sessions since last dialectic run
When auto-trigger checks preconditions
Then dialectic does NOT run (nothing to derive over)
And the session report includes "dialectic: skipped (no new input since last run)"
```

---

## 3.A Acceptance Criteria (EARS)

> Companion to Section 3 — these EARS statements feed `/write-executable-plan` for 1:1 vitest stub generation.

### Feature Area F1.1 — Vault Consolidation

**Ubiquitous:**
- The vault-consolidate script shall preserve every file from `~/Projects/vault/` either by copying to the canonical vault or by archiving under `.vault-backup-<timestamp>/`.

**Event-driven:**
- When the user invokes `node scripts/vault-consolidate.mjs --dry-run`, the script shall emit one JSON line per source file with `{action, source, target}` and exit 0 without filesystem writes.
- When the user invokes `--apply` and a slug collision exists with differing content, the script shall invoke AskUserQuestion before writing either version.

**Unwanted behaviour:**
- If `~/Projects/Bernhard/vault/` does not exist, the script shall exit with code 2 and message `"canonical vault not found at ~/Projects/Bernhard/vault — refusing to consolidate"`.
- If the script is invoked from outside the operator's host (`uname -n` differs from bootstrap.lock host), the script shall warn and require `--force` to proceed.

### Feature Area F1.2 — Vault-Mirror Quality Gate

**Ubiquitous:**
- The vault-mirror script shall accept all entries that meet both quality thresholds.

**State-driven:**
- While `vault-mirror.quality.min-narrative-chars > 0`, the script shall reject session entries whose extracted narrative falls below the threshold.
- While `vault-mirror.quality.min-confidence > 0`, the script shall reject learning entries whose `confidence` field is below the threshold.

**Optional feature:**
- Where the operator sets `vault-mirror.quality.min-narrative-chars: 0` and `vault-mirror.quality.min-confidence: 0`, the script shall behave identically to the pre-F1.2 implementation (all entries mirrored).

### Feature Area F1.3 — Cold-Start Abandonment Fix

**Ubiquitous:**
- The cold-start banner shall never be emitted for a repo with `sessions.jsonl` line count ≥ `cold-start.silence-after-sessions`.

**Event-driven:**
- When `SessionStart` hook runs and `sessions.jsonl` is empty AND `bootstrap.lock.timestamp` is older than `cold-start.nudge-after-hours`, the hook shall emit the cold-start banner.

**Unwanted behaviour:**
- If `sessions.jsonl` does not exist or is unreadable, the hook shall log the error and skip the banner (not fail the session).
- If `bootstrap.lock` does not exist, the hook shall NOT emit the cold-start banner (this repo is not yet bootstrapped — bootstrap-gate would have already handled it).

### Feature Area F2.1 — Agent-Writable Memory-Tool

**Ubiquitous:**
- A `memory.propose()` call shall never write directly to `.orchestrator/metrics/learnings.jsonl`.

**Event-driven:**
- When the agent calls `memory.propose()` with valid arguments and quota remaining, the tool shall append to `.orchestrator/metrics/proposals.jsonl` and return `{status: "queued", position: "N/Q"}`.
- When session-end Phase 3.6.5 runs and `proposals.jsonl` has entries, the coordinator shall present them via a single `AskUserQuestion` multiSelect call.

**State-driven:**
- While quota-per-wave has been exhausted, the tool shall return `{status: "quota-exceeded", quota: N, dropped: M}` without writing.

**Unwanted behaviour:**
- If `memory.propose()` is called with `confidence < memory.proposals.confidence-floor`, the tool shall return `{status: "rejected-low-confidence", floor: F}` without writing.
- If the agent attempts to call `memory.propose()` from outside a wave-executor context (e.g. from the coordinator), the tool shall return `{status: "rejected-wrong-context"}`.

### Feature Area F2.2 — Auto-Dream Post-Session-Hook

**Event-driven:**
- When session-end Phase 3.6.5 runs and (`MEMORY.md` lines > `memory-cleanup-soft-limit` OR sessions-since-last-cleanup ≥ `memory-cleanup-threshold`), Phase 3.6.5 shall dispatch `/memory-cleanup --dry-run` and write the diff to `.orchestrator/pending-dream.md`.
- When the user runs `/memory-cleanup --apply-pending`, the skill shall apply `.orchestrator/pending-dream.md` to `MEMORY.md` and then delete the pending file.

**Unwanted behaviour:**
- If `memory-cleanup-threshold: 0` is set, Phase 3.6.5 shall not trigger auto-dream.
- If a pending-dream file is older than 14 days, `--apply-pending` shall refuse and instead suggest a fresh `--dry-run`.

### Feature Area F2.3 — "What I Remembered" Banner

**Ubiquitous:**
- The banner shall never expose raw `learnings.jsonl` JSON to the operator — only formatted summaries.

**Event-driven:**
- When session-start Phase 6.7 runs and `learnings.jsonl` has ≥1 active entry, the banner shall display the top-5 learnings.

**Optional feature:**
- Where `memory.banner.enabled: false`, the banner shall not be emitted.
- Where peer cards exist, the banner shall append one excerpt line from each card.

### Feature Area F2.4 — Peer Cards

**Ubiquitous:**
- Peer cards shall always carry valid vault-frontmatter (id, type, created, updated, source_sessions).
- Peer cards shall always be hand-editable; the dialectic pass shall merge (not overwrite).

**State-driven:**
- While a peer card's `updated` field is more than 30 days ago, session-start shall emit a staleness warning.

**Unwanted behaviour:**
- If the dialectic pass would produce a peer-card without an `id` field, the pass shall fail with `"peer-card missing required field: id"` and write nothing.

### Feature Area F2.5 — Dialectic-Deriver

**Event-driven:**
- When sessions-since-last-dialectic ≥ `dialectic.cadence`, session-end shall auto-trigger `/evolve --dialectic --dry-run`.

**State-driven:**
- While `dialectic.budget-tokens` is exceeded during a run, the deriver shall stop and emit `{status: "budget-exceeded", used: N, budget: M}` rather than truncate output.

**Optional feature:**
- Where `dialectic.cadence: 0`, the auto-trigger shall be permanently disabled (manual `/evolve --dialectic` remains available).

**Unwanted behaviour:**
- If `dialectic.model` is unknown (not in `["haiku", "sonnet", "opus"]`), the deriver shall fail-fast at startup with a clear error.
- If a dialectic pass produces a diff that would EMPTY a peer card (delete all sections), the pass shall warn and require explicit `--allow-emptying` flag.

---

## 4. Technical Notes

### Architecture

Phase 1 is pure infrastructure work — no LLM calls, deterministic, mostly file IO + path manipulation. The cold-start detector and quality gate are small (<200 LOC each); the consolidation script is bigger (~400 LOC) because it owns conflict resolution and migration safety.

Phase 2 introduces two new LLM call sites: the dialectic-deriver (haiku, periodic) and the memory-proposal-summarizer (AUQ rendering, no LLM unless we add a "pre-summarize-rejections" feature in v2). Peer Cards use the existing vault frontmatter schema (validated by `skills/vault-sync/`) extended with `type: peer-card` (currently allowed types are `note|daily|project|person|reference|idea|learning|session` — we add the eighth: `peer-card`).

Memory proposals use a 2-stage pipeline that ensures **no agent can write directly to the learning store**: stage 1 is proposal-write to `proposals.jsonl` (cheap, agent-controlled); stage 2 is AUQ-confirmation at session-end that commits approved entries to `learnings.jsonl` with provenance tag. This mirrors Hermes' `memory` tool architecturally but adds the safety gate that Hermes lacks (their "overwrites manual edits" critique).

Auto-Dream reuses the existing `memory-cleanup` skill body unchanged — it adds two new mode flags (`--dry-run` writes to `.orchestrator/pending-dream.md`; `--apply-pending` reads + applies + deletes). This keeps the cleanup logic in one place.

The Dialectic-Deriver runs as a SubagentStop-style sub-process from session-end Phase 3.6 (after vault-mirror Phase 3.7 but before STATE.md write in Phase 3.7a). Token cost is capped via `dialectic.budget-tokens`; the deriver fails-stop rather than truncate.

### Affected Files

| File | Change |
|------|--------|
| `scripts/vault-mirror.mjs` | Add `vault-mirror.quality.*` gate; new `skipped-quality-low` action |
| `scripts/parse-config.mjs` | Add new config keys: `vault-mirror.quality`, `dialectic`, `cold-start`, `memory.proposals`, `memory.banner`, `memory-cleanup-soft-limit` |
| `skills/session-start/SKILL.md` | Add Phase 6.7 (banner), document USER/AGENT card staleness check |
| `skills/session-end/SKILL.md` | Add Phase 3.6.5 (proposal collection + auto-dream + dialectic trigger), revise 3.7 |
| `skills/memory-cleanup/SKILL.md` | Add `--dry-run` and `--apply-pending` modes |
| `skills/evolve/SKILL.md` | Add `--dialectic` mode (new 4th alongside analyze/review/list) |
| `skills/vault-mirror/SKILL.md` | Document quality gate flags |
| `skills/vault-sync/SKILL.md` | Extend allowed `type` enum with `peer-card` |
| `hooks/on-session-start.mjs` | Emit cold-start banner when conditions met |
| `hooks/hooks.json` | Register new pre-bash entry for `memory.propose()` audit (defense-in-depth) |
| `docs/session-config-template.md` | Add all new keys with documentation |
| `docs/session-config-reference.md` | Canonical reference for new keys |
| `.claude/rules/owner-persona.md` | Cross-reference Peer Cards as related but distinct (host vs project scope) |
| `NEW scripts/vault-consolidate.mjs` | One-shot migration script |
| `NEW scripts/dialectic-deriver.mjs` | LLM-pass implementation |
| `NEW scripts/lib/cold-start-detector.mjs` | Detection logic |
| `NEW scripts/lib/vault-quality-gate.mjs` | Quality filter |
| `NEW scripts/lib/memory-proposals/{schema,collector,sink}.mjs` | Proposal pipeline |
| `NEW scripts/lib/peer-cards/{schema,reader,writer,merger}.mjs` | Peer-card I/O |
| `NEW agents/memory-proposal-collector.md` | Sub-agent spec for AUQ-presentation |
| `NEW tests/scripts/vault-consolidate.test.mjs` | Unit tests for migration |
| `NEW tests/scripts/dialectic-deriver.test.mjs` | Unit tests with mocked LLM |
| `NEW tests/scripts/lib/cold-start-detector.test.mjs` | Unit tests |
| `NEW tests/scripts/lib/memory-proposals/*.test.mjs` | Pipeline tests |
| `NEW tests/scripts/lib/peer-cards/*.test.mjs` | Merger tests (preserve hand-edits) |

### Data Model Changes

- **NEW file:** `.orchestrator/metrics/proposals.jsonl` — extends learnings.jsonl schema with `proposal_status` (`pending|approved|rejected`), `_provenance: agent-proposed@<wave-id>`, `_proposed_at` ISO timestamp.
- **NEW file:** `.orchestrator/peers/USER.md` — vault-frontmatter `{id, type: "peer-card", target: "user", created, updated, source_sessions, _generator}` + body sections (Preferences/Patterns/History).
- **NEW file:** `.orchestrator/peers/AGENT.md` — vault-frontmatter `{id, type: "peer-card", target: "agent", created, updated, source_sessions, _generator}` + body sections (Identity/Behavior/Competencies/Avoid).
- **NEW file:** `.orchestrator/pending-dream.md` — auto-dream diff awaiting `--apply-pending`.
- **NEW file:** `.orchestrator/dialectic-last-run` — single-line ISO timestamp.
- **NEW file:** `.orchestrator/welcome-banner-pending` — empty marker file (migration helper).
- **Extension:** vault-mirror output now includes `skipped-quality-low` action; counts surfaced in session report.
- **NEW Session-Config keys** (added to `docs/session-config-template.md`):
  ```yaml
  vault-mirror:
    quality:
      min-narrative-chars: 400    # session minimum narrative length
      min-confidence: 0.5          # learning minimum confidence
  cold-start:
    nudge-after-hours: 1           # don't nudge sooner than this
    silence-after-sessions: 1      # silence after N closed sessions
  memory:
    proposals:
      enabled: true
      quota-per-wave: 5
      confidence-floor: 0.5
      confirm-at-session-end: true # always true in v1
    banner:
      enabled: true
  memory-cleanup-soft-limit: 180   # auto-dream trigger
  dialectic:
    cadence: 5                     # auto-trigger every Nth session; 0 = off
    model: haiku                   # haiku | sonnet | opus
    budget-tokens: 8000            # input cap
    dry-run-default: true
  ```

### API Changes

- **New CLI subcommands:**
  - `/memory-cleanup --dry-run` — produces `.orchestrator/pending-dream.md`, no in-place writes.
  - `/memory-cleanup --apply-pending` — applies the pending dream, deletes the pending file.
  - `/evolve --dialectic [--apply] [--peer USER|AGENT]` — manual dialectic pass.
- **New tool (wave-executor agents only):**
  - `memory.propose({type, subject, insight, evidence, confidence}) -> {status, position?, dropped?}` — proposes a learning for end-of-session AUQ confirmation.

### Migration Strategy

Phase 1 is operator-driven via `node scripts/vault-consolidate.mjs --dry-run` followed by `--apply`. The script is idempotent and reversible (originals archived). The buchhaltgenie path fix is included in the same script's `--fix-paths` phase.

Phase 2 is config-gated: if `memory.proposals.enabled: false` (overridable per-repo), no behaviour change. Defaults are conservative (banner on, proposals on, auto-dream on, dialectic auto-trigger on with cadence 5). Operators who want zero behaviour change can set:
```yaml
memory:
  proposals: { enabled: false }
  banner: { enabled: false }
memory-cleanup-soft-limit: 9999
dialectic:
  cadence: 0
cold-start:
  nudge-after-hours: 999999
```

### Cross-Cutting Concerns

- **Multi-vendor support (Claude / Codex / Cursor):** All Phase 1 features are platform-agnostic (pure file IO). Phase 2 features assume `AskUserQuestion` availability for confirmation flows — on Codex CLI, fall back to numbered Markdown list per `skills/_shared/platform-tools.md`. Peer Cards work everywhere (they're just markdown).
- **Parallel-session safety (PSA-001/002/003):** Auto-dream and dialectic-deriver write to dedicated single-writer files (`.orchestrator/pending-dream.md`, `.orchestrator/dialectic-last-run`, `.orchestrator/peers/*.md`). Concurrent sessions in the same repo cannot collide because session-end already holds the session-lock. Memory proposals from concurrent sessions get a separate `proposals.jsonl` line per session-id; the AUQ collector groups by session-id.
- **Destructive-command guard (PSA-003):** Vault consolidation's `--apply` deletes files; this is gated by `--apply` requirement + explicit per-conflict AUQ + final "delete redundant vault?" prompt. The script never operates without explicit operator commands.
- **Privacy / public-mirror compatibility (epic #462):** Peer Cards may contain operator preferences (PII-adjacent). Scope is `local` by default; vault-mirror's existing privacy regex (P6) applies before any export. USER.md and AGENT.md are excluded from `scope=public` learning exports unless the operator explicitly opts in.

### Open Technical Questions (to resolve during impl)

- Should `proposals.jsonl` be per-session or per-repo? (Default proposal: per-repo with `session_id` field; pruned after AUQ-confirm.)
- Should peer-card schema extend the vault frontmatter via a Zod refine, or duplicate into a peer-card-specific schema? (Default proposal: extend with `type: peer-card` discriminator.)
- Cold-start banner i18n: bind to `owner.language`? (Default proposal: yes — banner string template lives in `skills/_shared/cold-start-banner.md` with `{{owner.language}}` slot.)
- Should dialectic-deriver also update `learnings.jsonl` confidence (decay-revive) based on whether a learning appears in derived narrative? (Default proposal: NO in v1 — preserve learning lifecycle as-is to avoid double-counting; revisit in v2.)
- Should auto-dream and dialectic share a kill-switch? (Default proposal: NO — independent triggers, independent disable.)

---

## 5. Risks & Dependencies

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Dialectic-deriver hallucinates facts about the operator/agent and pollutes peer cards | Medium | High (trust erosion) | Dry-run-default; explicit `--apply` gate; diff visible at session report; hand-editable cards; staleness warning after 30d; `--allow-emptying` flag prevents accidental card wipes |
| Agent-writable memory floods `learnings.jsonl` with low-value entries | Medium | Medium (surface-top-N drowns useful entries) | Quota 5/wave; confidence floor 0.5; AUQ-confirm at session-end; quality-decay applies normally; `_provenance` tag enables agent-source filtering |
| Vault-consolidation merge conflicts → data loss | Low | High (irreversible loss of hand-authored content) | Idempotent script; `--dry-run` default; per-file AUQ for conflicts; originals archived under `.vault-backup-<timestamp>/`; never executes without `--apply` |
| Cold-start banner becomes annoying / ignored | High | Low (operators learn to skim past it) | Auto-silence after first session; configurable cadence; banner text iterates after measurement (treat as A/B-testable copy) |
| Quality-gate threshold tuning drift | Medium | Medium (vault loses good entries if too strict; keeps noise if too loose) | Defaults derived from current hand-authored exemplar (`macos-app-notarization...`) at ~3300 chars; allow per-repo override; quality-skip count surfaced for tuning |
| Buchhaltgenie-style path drift recurs after fix | Low | Medium (silent vault-mirror failures) | Bootstrap adds vault-dir path-resolution check + warning; `vault-consolidate --fix-paths` documented as repeat-runnable |
| Two new LLM call sites raise per-session token cost | Certain | Low ($0.01-0.05 with haiku) | `dialectic.cadence` default 5 (every Nth); `budget-tokens` cap; cost surfaced in session report; `cadence: 0` for full opt-out |
| Peer cards become stale if dialectic disabled | Medium | Low (cards drift apart from reality) | Session-start staleness warning at 30d; manual `/evolve --dialectic` always available |
| 58% cold-start fix helps only NEW bootstraps | Certain | Medium (6 existing INSTALLED-UNUSED repos remain dormant) | One-shot migration step seeds `.orchestrator/welcome-banner-pending` in those 6 repos; banner appears on next open |
| Hermes-style ALLOW-ALL security trap | Low | Critical (we've already invested in PSA-003 + destructive guard) | Memory-proposal pipeline explicitly architected as 2-stage with operator confirm; no agent may apply, only propose; documented as departure from Hermes design |
| Honcho-style AGPL contagion | Excluded | N/A | We don't adopt Honcho — we steal the design pattern (out-of-scope confirms this) |
| Token cost monitoring gap | Medium | Low (operators may not notice gradual cost creep) | Session report includes `dialectic.token_usage` line; quarterly cost-review checklist documented |
| Codex/Cursor parity slips behind Claude | Medium | Medium (multi-vendor positioning weakens) | All Phase 1 features platform-agnostic; Phase 2 designed with `platform-tools.md` fallbacks; CI matrix covers all three (existing) |
| Vault-consolidation script fails partway (network/disk error) | Low | High (vault in partial state) | Transaction model: all moves staged under `.vault-backup-<timestamp>/`; if any step fails, script aborts with rollback instructions; vault state never partially modified |
| Operator dislikes the dialectic-deriver's writing style | Medium | Low (cards feel inauthentic) | Cards are hand-editable; merger preserves operator edits; `dialectic.style-prompt` config (added in v2 if requested) |

### Dependencies

**Existing infrastructure (no new packages):**
- `learnings.jsonl` schema (extended) — `scripts/lib/learnings/schema.mjs`
- `sessions.jsonl` (unchanged read path)
- Vault frontmatter schema — `skills/vault-sync/SKILL.md` (extend allowed `type` enum)
- Hooks system — `hooks/hooks.json`
- AskUserQuestion tool (Claude Code) + numbered-list fallback (Codex/Cursor) — `skills/_shared/platform-tools.md`
- `/memory-cleanup` skill — unchanged body, new flags
- `/evolve` skill — unchanged body, new mode
- `parse-config.mjs` — extend
- vault-mirror.mjs — extend

**External:**
- `claude-haiku-4-5` (for dialectic) — already in use across plugin
- Claude Code harness auto-memory — coexists, never modified

**Blocked by:** Nothing visible. Can start immediately.

**Related issues (cross-reference):**
- **#185** (count-drift-recurrence) — Phase 2.5 dialectic-deriver directly mitigates this pattern; close once Phase 2.5 lands and ≥1 dialectic-derived narrative is observed surfacing the would-be-redundant insight.
- **#277** (autopilot-loop) — Orthogonal but benefits from dialectic; autopilot's between-iteration carryover gains a synthesis step.
- **#336** (rule glob-scoping) — Phase 2.4 Peer Cards may eventually adopt similar glob-scoping for per-area cards; deferred to v2.
- **#366** (Stop-hook verification loop) — Phase 2.2 auto-dream uses similar SubagentStop pattern; cross-reference in implementation notes.
- **#462** (privacy/public-mirror epic) — Peer Cards subject to same privacy contract; `scope=public` requires explicit opt-in + redaction.

**New issues to file (mapped to Phase 3 of this PRD process):**
- One Epic for the umbrella feature
- Eight sub-issues (one per Feature Area F1.1, F1.2, F1.3, F2.1, F2.2, F2.3, F2.4, F2.5)
- One migration issue for the INSTALLED-UNUSED repo nudge seeding
