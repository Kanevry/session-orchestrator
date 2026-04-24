# PRD — STATE.md Recommendations Contract (v1.1)

**Epic:** [#271 v3.2 Autopilot — Autonomous Session Orchestration](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/271)
**Phase:** A (Foundation)
**Appetite:** 1w (4 sub-issues)
**Visibility:** internal
**Status:** shipped 2026-04-24
**Sub-issues:** #272 (Parser + v0-Heuristik) · #273 (session-end Writer) · #274 (session-start Reader + Docs) · #275 (Vault-Mirror)

## Problem

Session-to-session handoffs today are either implicit (next session's coordinator re-reads `sessions.jsonl` + `learnings.jsonl` and re-derives context) or manual (user re-types what they want done next). Neither path produces a structured, machine-readable recommendation the next session can act on without re-interpreting chat history.

**Concrete symptom:** after a multi-session day, the 4th session's coordinator has no deterministic way to know that "the previous 3 sessions finished all their planned work and a natural next step would be a feature session starting from the top-priority backlog" vs "the previous session had 40% carryover and a deep session is warranted". The coordinator makes that call heuristically from `sessions.jsonl` trends and learnings — slow, inconsistent, and unauditable.

**Goal:** a structured handoff field set persisted in STATE.md frontmatter that session-end writes (deterministic v0 heuristic) and session-start reads (one-line banner + future Phase B Mode-Selector input). The handoff is session-to-session only — not persisted to metrics, not mirrored to vault (except snapshot-PRD copy for humans), not cross-repo.

## Non-Goals

- Phase A does NOT add automatic mode-selection. session-start still asks the user via AskUserQuestion after showing the banner — the user retains veto.
- Phase A does NOT consume learnings or historical sessions.jsonl — the heuristic is purely in-memory-metrics-driven from the just-closed session.
- Phase A does NOT add a new `schema-version` value — the new fields are additive under `schema-version: 1`.
- Phase A does NOT change existing session-end or session-start logic paths — all additions are new subsections; existing flows are unchanged.

## Contract

### Schema (additive under `schema-version: 1`)

5 optional frontmatter fields in STATE.md:

| Field | Type | Range |
|-------|------|-------|
| `recommended-mode` | string enum | `housekeeping` \| `feature` \| `deep` \| `discovery` \| `evolve` \| `plan-retro` |
| `top-priorities` | integer[] | 0–5 entries, pre-sorted (priority:critical/high first, FIFO tiebreak) |
| `carryover-ratio` | float (2 decimals) | `0.00`–`1.00`; `carryover_count / planned_issues` (0 when planned=0) |
| `completion-rate` | float (2 decimals) | `0.00`–`1.00`; `completed_issues / planned_issues` |
| `rationale` | string | ≤ 120 chars, single-line; names the v0 rule branch that fired |

### Writer (session-end Phase 3.7a — issue #273)

Runs AFTER Phase 3.7 (sessions.jsonl write, so in-memory metrics are finalized) and BEFORE Phase 3.4 (status: completed write, so the fields land while STATE.md is still `status: active` for crash-safety).

Pseudo-code:

```js
const rec = computeV0Recommendation({completionRate, carryoverRatio, carryoverIssues});
updateFrontmatterFields(statePath, {
  'recommended-mode': rec.mode,
  'top-priorities': rec.priorities,
  'carryover-ratio': round2(carryoverRatio),
  'completion-rate': round2(completionRate),
  'rationale': rec.rationale,
});
```

On exception (compute failure, I/O failure), a `recommendation-compute-failed` event is written to `.orchestrator/metrics/sweep.log` and the Writer returns silently — Phase 3.4 still sets `status: completed` normally. Next session-start's Reader handles absent fields gracefully (no banner).

### Reader (session-start Phase 1.5 — issue #274)

On the `status: completed` branch only, renders a banner:

```
📋 Previous session recommended: <mode> — <rationale> (completion: XX%, carryover: XX%)
  Suggested issues: #<id>, #<id>, ...
```

- Partial fields → missing numerics show `—`; WARN `state-md-partial-recommendation` to sweep.log.
- Type-mismatch (`top-priorities` not an array) → field treated as null; WARN `state-md-type-mismatch`; other fields still render.
- Pre-v1.1 STATE.md → silent no-op (no banner, no WARN).
- Unknown `recommended-mode` → banner shows `(unknown-mode)`.

Idle Reset (same Phase 1.5) archives the 5 fields into `## Previous Session` body as readable markdown (not YAML) and removes them from the frontmatter.

### v0 Heuristic (issue #272)

Deterministic three-branch rule, evaluated in order — first match wins:

1. `completion_rate < 0.50` → `plan-retro` (`v0: completion <50% → retro`)
2. `carryover_ratio ≥ 0.30` → `deep` (`v0: carryover ≥30% → deep`)
3. otherwise → `feature` (`v0: default clean completion`)

Implemented in `scripts/lib/recommendations-v0.mjs`.

## Ownership

| Field | Writer | Reader | Archival |
|-------|--------|--------|----------|
| All 5 recommendation fields | session-end Phase 3.7a (sole writer) | session-start Phase 1.5 banner + future Phase B Mode-Selector | session-start Idle Reset rule 6 (archives to body block, removes from frontmatter) |

See `skills/_shared/state-ownership.md` for the full STATE.md ownership matrix.

## Q-Decisions

- **Q1 — Where to persist?** STATE.md frontmatter (not a new file). Rationale: STATE.md is the existing session-to-session handoff file; adding a sibling would fragment the contract.
- **Q2 — Additive or new schema-version?** Additive under `schema-version: 1`. Rationale: absence of the fields is a valid `schema-version: 1` state (pre-v1.1 compatibility); bumping schema-version would force every reader to handle a v0/v1 split. Cost of additive is a trivial `parseRecommendations(fm) → null` fallback.
- **Q3 — Writer placement in session-end?** AFTER Phase 3.7 and BEFORE Phase 3.4. Rationale: in-memory metrics are finalized at 3.7; Phase 3.4 sets `status: completed` which is the final-write in the Phase 3 chain. Writing between the two keeps STATE.md `status: active` during the recommendation write, so a crash leaves a resume-able STATE.md with both status:active and recommendations rather than status:completed-without-recommendations.
- **Q4 — Single writer or multi-writer?** Single writer (session-end Phase 3.7a). Rationale: avoids split-brain scenarios where wave-executor or session-start could compete for the fields. session-end owns the full outcome picture (all metrics finalized).
- **Q5 — Banner timing?** Render BEFORE Idle Reset archives the fields. Rationale: banner needs the fields in frontmatter (easy to read). Archiving is a human-readability concern; the banner doesn't need the archived form.

## Validation

- **Tests:**
  - `tests/lib/state-md.test.mjs` — 8 new cases in `describe('recommendations v1.1')`: full fields, pre-v1.1 (null), partial, type-mismatch (defensive coercion), additive-write-preserves-unknowns, roundtrip idempotent, null-value deletes key, no-op on non-frontmatter input.
  - `tests/lib/recommendations-v0.test.mjs` — 11 cases: 3 rule branches + branch-1-wins + 4 boundary cases + 2 throw cases; plus 3 `isValidMode` cases.
  - `tests/integration/state-md-handoff.test.mjs` — 5 integration cases: Writer AC1 (all fields written), AC1 additive (custom-extension preserved), AC2 (status: active during write), AC3 (exception path writes sweep.log + preserves STATE.md), AC3 follow-on (Phase 3.4 can still set status: completed).
- **Full Gate:** typecheck 38 OK, lint clean, 1637/10 tests, coverage 71.8/66.51/76.71/73.91 — all above thresholds.

## Phase B Forward-Reference

Phase B (issue #276 Mode-Selector Skill, appetite:2w) will consume these 5 fields as its primary input for autonomous mode selection. The contract is stable — Phase B does NOT change the writer, reader, or schema. It replaces the v0 heuristic's three-branch rule with a learnings-driven selector, gated on `learnings-surface-top-n` and the current session's backlog priorities.

Phase C (issue #277 /autopilot Loop Command, appetite:6w) then chains Phase B's output into a session-start → session-plan → wave-executor → session-end loop with kill-switches (SPIRAL/FAILED/carryover > 50%).
