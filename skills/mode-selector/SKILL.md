---
name: mode-selector
description: >
  Deterministic mode selection for session-start. Reads Phase A STATE.md
  recommendations + (future) learnings, sessions, backlog, bootstrap signals
  and returns {mode, rationale, confidence, alternatives}. Pure-function
  contract — no side effects, no STATE.md writes. Phase B scaffold (issue #276);
  full heuristic is follow-up sub-issues.
user-invocable: false
tags: [phase-b, autopilot, mode-selection, scaffold]
---

# Mode-Selector Skill

## Status

Scaffold only. Contract is stable; the full Phase B-1 heuristic (consuming learnings.jsonl,
recent sessions trend, VCS backlog priority-weighting, and bootstrap.lock tier) is deferred
to follow-up sub-issues #TBD. Not yet wired into session-start or any other invocation point.

## Purpose

Mode-Selector centralizes the session-mode decision across all consumers: session-start Phase 1.5
banner, `/autopilot` (Phase C), and any future caller that needs a structured recommendation rather
than ad-hoc heuristics inline at the call site. Before this skill existed, mode-picking logic was
either implicit (user-typed free text) or embedded directly in session-start with no reuse path.

Phase A (`state-md.mjs::parseRecommendations`, issue #272) established the `recommended-mode`
frontmatter field written by session-end Phase 3.7a. Phase B is the skill that reads that field
(plus future signals) and returns a structured recommendation. The key output is a four-field
tuple: `{mode, rationale, confidence, alternatives}`. `mode` is the recommended session type.
`rationale` is a ≤120-char human-readable explanation. `confidence` is a float (0.0–1.0)
indicating how strongly the selector commits to the recommendation. `alternatives` is an ordered
list of `{mode, confidence}` objects representing the next-best choices, enabling callers to offer
override options without re-running the selector.

The selector is a pure function: given the same `signals` object it always returns the same output.
No file I/O, no network calls, no global state. This makes it trivially testable and safe to call
from any skill without side-effect risk.

## Contract

### Input: `signals` object

- `recommendedMode` (string|null) — Phase A frontmatter field; the `recommended-mode` key from `parseRecommendations()`
- `topPriorities` (number[]|null) — issue numbers from the `top-priorities` frontmatter field
- `carryoverRatio` (number|null) — float 0.0–1.0 from Phase A; fraction of issues carried over from previous session
- `completionRate` (number|null) — float 0.0–1.0 from Phase A; ratio of planned issues completed
- `previousRationale` (string|null) — the `rationale` string written by session-end Phase 3.7a
- `learnings` (object[]|null) — RESERVED; not consumed in scaffold; Phase B-1 heuristic input
- `recentSessions` (object[]|null) — RESERVED; not consumed in scaffold; recent-sessions trend input
- `backlog` (object[]|null) — RESERVED; not consumed in scaffold; VCS backlog scan input (Phase B-3)
- `bootstrapLock` (object|null) — RESERVED; not consumed in scaffold; tier-aware sizing hints

### Output: `Recommendation` object

| Field | Type | Range / Values | Purpose |
|---|---|---|---|
| `mode` | string enum | `housekeeping` \| `feature` \| `deep` \| `discovery` \| `evolve` \| `plan-retro` | Recommended session type |
| `rationale` | string | ≤120 chars | Human-readable explanation for the recommendation |
| `confidence` | float | 0.0–1.0 | Selector commitment; see Fallback Behavior for threshold semantics |
| `alternatives` | `{mode, confidence}[]` | 0–3 entries; may be empty, never null | Next-best modes with partial confidence scores |

## Invocation Points

### Current (scaffold)

None wired. Tests in `tests/lib/mode-selector.test.mjs` exercise the contract.

### Future (follow-up sub-issues)

- **session-start Phase 1.5 banner** — render `selectMode` output as banner text before AUQ; pre-select the first AUQ option with the recommended mode.
- **`/autopilot` (Phase C, #277)** — if `confidence ≥` configurable threshold AND SPIRAL/FAILED/carryover-50% guards pass, auto-execute without user prompt.

## Scaffold Heuristic (v0)

The v0 scaffold implements a minimal three-branch passthrough. It is intentionally thin so
the contract is exercisable by tests before the full Phase B-1 rule-set lands.

```
selectMode(signals):
  if signals is null/undefined:
    → {mode: 'feature', rationale: 'scaffold: null signals → default', confidence: 0.0, alternatives: []}
  if signals.recommendedMode is valid mode:
    → {mode: <recommendedMode>, rationale: 'scaffold: passthrough of Phase A recommended-mode', confidence: 0.5, alternatives: []}
  otherwise:
    → {mode: 'feature', rationale: 'scaffold: missing/invalid recommendedMode → default', confidence: 0.0, alternatives: []}
```

Note: the full Phase B heuristic — rule-set consuming learnings.jsonl, recent sessions trend,
VCS backlog priority-weighting, and bootstrap.lock tier — is the Phase B-1 follow-up sub-issue.

## Fallback Behavior

- `confidence = 0.0` means the selector is declining to choose; caller should fall back to its own
  logic (v0 heuristic) or prompt the user without pre-selecting any option.
- `0.0 < confidence < 0.5` means low-confidence; caller should present as a suggestion, never
  auto-execute; AUQ should show the recommended mode without marking it as "Recommended".
- `confidence ≥ 0.5` means accept as default; present as the pre-selected AUQ option; user can
  still override.
- `confidence ≥ 0.85` (future Phase C threshold) means suitable for autonomous execution in
  `/autopilot` mode without user prompt, subject to kill-switch guards.

## Integration with Other Skills

- **`state-md.mjs::parseRecommendations`** → read Phase A frontmatter fields; consumed via
  `signals.recommendedMode`, `signals.carryoverRatio`, `signals.completionRate`, etc.
- **`recommendations-v0.mjs::isValidMode`** → mode enum validation; import and use — do not
  redefine the six-value enum inline.
- **`learnings.mjs::readLearnings`** → reserved for Phase B-1 heuristic input via
  `signals.learnings`
- **`session-schema.mjs::normalizeSession`** → reserved for recent-sessions trend input via
  `signals.recentSessions`
- **`bootstrap-lock-freshness.mjs::parseBootstrapLock`** → reserved for tier-aware sizing hints
  via `signals.bootstrapLock`
- **`gitlab-ops.md`** → reserved for VCS backlog scan (Phase B-3) via `signals.backlog`

## Critical Rules

- **Pure function only.** No I/O, no side effects, no throws, no dynamic imports. `selectMode`
  must be synchronous and referentially transparent.
- **Never write STATE.md.** session-start or Phase C writes any derived state; the selector is
  read-only. session-end Phase 3.7a is the sole writer of `recommended-mode`.
- **Every return path returns all 4 keys.** The `{mode, rationale, confidence, alternatives}`
  shape is enforced by tests; missing keys are a contract violation.
- **`alternatives` is always an array.** Never `null`, never `undefined`, may be empty (`[]`).
- **Use `isValidMode` from `recommendations-v0.mjs`.** Do not redefine the mode enum; drift
  between selector and validator is a schema bug.

## Anti-Patterns

- Do not call `selectMode` from inside session-end. session-end Phase 3.7a is the SOLE producer
  of the `recommended-mode` frontmatter field; the selector is a consumer only.
- Do not add logging inside `selectMode` — the function must stay pure. Logging (breadcrumbs,
  sweep.log events) happens at the call site, not inside the selector.
- Do not expand the scaffold to consume `learnings` inside this session. That is Phase B-1
  follow-up work; the RESERVED fields in `signals` are intentionally ignored here.
- Do not treat `confidence` as binary. Threshold semantics (`0.5` accept-as-default, `0.85`
  auto-execute) live at the call site, not in the selector. The selector emits a float; the
  caller decides what to do with it.

## References

- Implementation: `scripts/lib/mode-selector.mjs`
- Tests: `tests/lib/mode-selector.test.mjs` (written in Wave 3)
- PRD: `docs/prd/2026-04-25-mode-selector.md`
- Epic: [#271 v3.2 Autopilot](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/271)
- Issue: [#276 Phase B Mode-Selector](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/276)
- Phase A Contract PRD: `docs/prd/2026-04-24-state-md-recommendations-contract.md`
- Phase A parser: `scripts/lib/state-md.mjs::parseRecommendations` (issue #272)
- Phase A writer: `skills/session-end/SKILL.md` Phase 3.7a (issue #273)
- Mode enum: `scripts/lib/recommendations-v0.mjs::isValidMode`

## Open Questions (for Phase B-1 follow-up)

- Learnings freshness window — default 30d? Configurable per-type or a single global TTL?
- Backlog priority weighting — rule-based (`priority:critical = +0.2` confidence bonus) vs.
  learned from historical completion rates?
- Alternative-generation algorithm — top-N non-selected modes scored by partial signal match, or
  fixed set derived from v0 heuristic branches?
- Confidence computation — additive bonuses per signal (each signal adds a fixed delta) or
  multiplicative penalties (each contradicting signal scales down a base score)?
- Per-session-type thresholds — should `housekeeping` require higher confidence for auto-execution
  than `deep` given the asymmetry in effort and risk?
