# PRD — Mode-Selector Skill (Phase B)

**Epic:** [#276 v3.2 Autopilot — Mode-Selector Skill](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/276)
**Phase:** B (Mode-Selector)
**Appetite:** 2w
**Visibility:** internal
**Status:** scaffold 2026-04-24
**Dependencies:** Phase A shipped (#272 Parser · #273 Writer · #274 Reader · #275 Vault-Mirror)

## Problem

Session-start currently asks the user to pick a mode via AskUserQuestion with no pre-computed suggestion beyond the Phase A banner. Phase A writes a single `recommended-mode` frontmatter field (v0 heuristic, three-branch), but that field is read by session-start as display-only — no structured computation step mediates between the raw STATE.md fields and the final mode choice.

**Concrete symptom:** every consumer (session-start AUQ pre-selection, future /autopilot Phase C) must independently re-derive mode from `recommended-mode` + `carryover-ratio` + `completion-rate` + learnings + sessions.jsonl + backlog. There is no shared contract; any consumer that wants to extend the logic (e.g. learnings-weighted selection) must patch its own code path.

**Goal:** a dedicated `selectMode(signals)` pure function in `scripts/lib/mode-selector.mjs` that centralises mode computation and returns a typed `{mode, rationale, confidence, alternatives}` tuple. All current and future consumers share one selector. Phase B ships the scaffold + contract; the full heuristic (learnings-weighted, backlog-weighted) is Phase B follow-up.

## Non-Goals

This Phase B scaffold ships exactly:

- This PRD (`docs/prd/2026-04-25-mode-selector.md`)
- `scripts/lib/mode-selector.mjs` — exports `selectMode(signals)` returning `{mode, rationale, confidence, alternatives}`; v0 implementation is passthrough of Phase A `recommendedMode` at confidence 0.5, empty alternatives
- `skills/mode-selector/SKILL.md` — doc-only scaffold describing the skill contract and forward roadmap
- Tests for the scaffold contract (written in W3)

Explicit non-goals for this phase:

- No learnings consumption or confidence-weighted analysis
- No sessions.jsonl trend analysis or historical scoring
- No VCS backlog scan or open-issue-by-priority ranking
- No session-start wiring (session-start continues to show Phase A banner only)
- No /autopilot integration (Phase C)
- No `mode-selector-accuracy` learnings feedback loop
- No STATE.md mutations (selector is pure — zero side effects)
- No vault metadata reads

Each item above is a separate follow-up sub-issue to be filed at session close.

## Contract

### Inputs

`selectMode(signals)` accepts a single `signals` object. All fields are optional and may be null — the selector degrades gracefully when any field is absent.

| Field | Type | Description |
|-------|------|-------------|
| `recommendedMode` | `string\|null` | Phase A `recommended-mode` frontmatter field |
| `topPriorities` | `number[]\|null` | Phase A `top-priorities` (pre-sorted issue IDs) |
| `carryoverRatio` | `number\|null` | Phase A `carryover-ratio` float 0.00–1.00 |
| `completionRate` | `number\|null` | Phase A `completion-rate` float 0.00–1.00 |
| `previousRationale` | `string\|null` | Phase A `rationale` string ≤ 120 chars |
| `learnings` | `object[]\|null` | Reserved for Phase B-1 (learnings-weighted heuristic) |
| `recentSessions` | `object[]\|null` | Reserved for Phase B-1 (sessions.jsonl trend analysis) |
| `backlog` | `object[]\|null` | Reserved for Phase B-3 (VCS backlog scan) |
| `bootstrapLock` | `object\|null` | Reserved for future (project-type signal) |
| `vaultStaleness` | `object\|null` | Reserved for future (vault staleness pressure) |

### Output

`selectMode` always returns an object with exactly these 4 keys:

| Field | Type | Range / Constraints |
|-------|------|---------------------|
| `mode` | string enum | `housekeeping` \| `feature` \| `deep` \| `discovery` \| `evolve` \| `plan-retro` |
| `rationale` | string | ≤ 120 chars, single-line, human-readable; names the rule branch that fired |
| `confidence` | float | `0.0`–`1.0`; `0.0` = pure fallback, `1.0` = highly confident |
| `alternatives` | array of `{mode, confidence}` | 0–3 entries, second-best options for user-override preview; never null, never undefined |

## v0 Scaffold Heuristic (this session only)

Intentionally minimal — full rule-set is Phase B-1 follow-up.

```js
selectMode(signals) {
  if (signals === null || signals === undefined)
    return { mode: 'feature', rationale: 'scaffold: null signals → default', confidence: 0.0, alternatives: [] };

  if (signals.recommendedMode && isValidMode(signals.recommendedMode))
    return { mode: signals.recommendedMode, rationale: 'scaffold: passthrough of Phase A recommended-mode', confidence: 0.5, alternatives: [] };

  return { mode: 'feature', rationale: 'scaffold: missing/invalid recommendedMode → default', confidence: 0.0, alternatives: [] };
}
```

`isValidMode` re-uses the enum from `scripts/lib/recommendations-v0.mjs` (6 valid modes).

## Fallback Behavior

| Confidence | Caller interpretation |
|------------|----------------------|
| `0.0` | Selector is declining to choose; caller falls back to its own logic (AUQ with no pre-selection) |
| `< 0.5` | Suggestion only — never auto-execute; surface as a hint in AUQ, not a default |
| `≥ 0.5` | Acceptable pre-selection for AUQ default; still requires user confirmation |
| `≥ 0.8` | (Future Phase C) Safe for /autopilot auto-execute path with kill-switch guards |

Phase C (/autopilot) defines its own confidence threshold for autonomous execution. Phase B does not set that threshold.

## Ownership Matrix

| Component | Role | Writes? |
|-----------|------|---------|
| `selectMode()` in `mode-selector.mjs` | Pure function, sole computation point | No side effects |
| session-start (future Phase B-2) | Consumer | May render banner + pre-select AUQ default option |
| /autopilot (future Phase C) | Consumer | May auto-execute when `confidence ≥ threshold` |
| `learnings.jsonl` | Future input (Phase B-1) | Read-only in Phase B |
| `mode-selector-accuracy` learning | Future output (Phase B-4) | Written by session-start AFTER user confirms or overrides |

## Q-Decisions

- **Q1 — Pure function instead of class/instance?** A pure function is deterministic, trivially testable, and carries no state between calls. A class would add lifecycle complexity with no benefit until learnings caching is needed (Phase B-1 concern, not B-scaffold).
- **Q2 — Why scaffold with passthrough instead of the full heuristic?** Phase A just landed; contract stability before behavior. Scaffold lets session-start and /autopilot begin wiring integration points without waiting for the full learnings-weighted rule-set. The output shape is locked here; the heuristic inside can evolve independently.
- **Q3 — Why confidence 0.5 for passthrough?** Phase A's v0 three-branch rule is itself a coarse heuristic with modest accuracy (no learnings, no backlog data). Signalling 0.5 communicates "accept as a suggestion, do not auto-execute" — consistent with the fallback-behavior table above.
- **Q4 — Why separate `rationale` from `mode`?** Debuggability and UI. The session-start banner shows `rationale`; sweep.log traces selector decisions. Without `rationale`, a confidence drop has no human-readable explanation.
- **Q5 — Why allow `alternatives` to be empty in v0?** Passthrough has no basis to rank second-best options — there is only one input (Phase A's field) and no scoring model. Future heuristic will populate alternatives from scored candidates. Forcing a non-empty array now would require fabricating confidence values.

## Validation

Tests (written in W3) must cover:

- Valid `recommendedMode` in signals → returned unchanged, confidence exactly 0.5
- Null signals → `{mode: 'feature', confidence: 0.0}`, rationale contains `'scaffold'`
- Unknown-mode string in `recommendedMode` → falls through to `'feature'` at confidence 0.0
- Shape contract: every return value has all 4 keys (`mode`, `rationale`, `confidence`, `alternatives`)
- `alternatives` is always an array — never `null`, never `undefined`, regardless of input
- `rationale` is a string with length ≤ 120 on all return paths

## Phase B Follow-Up Sub-Issues (to be filed at /close)

- `[Phase B-1] Mode-Selector heuristic v1 — rule-set consuming Phase A signals + learnings-weighted confidence scoring`
- `[Phase B-2] session-start integration — render Mode-Selector output as pre-selected AUQ default; archive accuracy learning post-confirm`
- `[Phase B-3] VCS backlog scan signal — open-issue-by-priority ranking as backlog input to selectMode`
- `[Phase B-4] learnings feedback loop — write mode-selector-accuracy learning after user confirms or overrides`

## Phase C Forward-Reference

`/autopilot` Loop Command (Phase C, issue #277, appetite:6w) will consume `selectMode` output and chain session-start → session-plan → wave-executor → session-end autonomously when `confidence ≥ threshold`. Mode-Selector is one of three Phase C building blocks:

1. **Mode-Selector** (this phase) — determines what kind of session to run
2. **Confidence-gated execution** — Phase C's threshold logic; never auto-executes below threshold
3. **Kill-switches** — SPIRAL detection, FAILED wave guard, carryover > 50% abort

The `selectMode` contract is stable for Phase C consumption — Phase C does not modify the function signature or output shape.
