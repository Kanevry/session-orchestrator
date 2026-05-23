---
id: prd-2026-05-23-pattern-quality-followup-503-peer-cards
type: project
target: agent
created: 2026-05-23T07:40:53Z
updated: 2026-05-23T09:30:00Z
title: Pattern Quality Followup + #503 Peer Cards F2.4 foundation
status: implemented
source_sessions: [main-2026-05-23-0740-deep]
tags: [prd, deep-session, peer-cards, pattern-quality, epic-498]
---

# Pattern Quality Followup + #503 Peer Cards F2.4 Foundation

## Source
Deep-session 2026-05-23 (~3h, 5 waves, 27 agents). Scope: close W5 follow-ups #526/#527/#528 from deep-session 2026-05-22 + start Epic #498 Phase 2 with #503 Peer Cards foundation.

## Scope (4 issues)
- **#526 HIGH** — Pattern 4 banner ecosystem coherence (SoT consolidation + return-shape standardisation)
- **#527 MED** — Pattern 1+4 seam hygiene (test-only privacy + speculative-seam removal)
- **#528 LOW** — Auto-Fix-Loop polish (mandatory repoRoot + maxBuffer test + PRD audit broadened)
- **#503 HIGH** — F2.4 Peer Cards foundation (schema + reader + writer + merger + staleness-banner)

## #503 Implementation Summary

### Modules shipped (5 NEW)
- `scripts/lib/peer-cards/schema.mjs` — pure validator, no IO. Exports `validatePeerCardFrontmatter`, `computeStalenessDays`, `STALENESS_THRESHOLD_DAYS=30`, `PEER_CARD_TARGETS=['user','agent']`, predicates.
- `scripts/lib/peer-cards/reader.mjs` — reads `<repoRoot>/.orchestrator/peers/{USER,AGENT}.md`, parses frontmatter via canonical `parseStateMd`, computes staleness with injectable clock.
- `scripts/lib/peer-cards/writer.mjs` — atomic tmp+rename. EARS unwanted-behaviour gate: refuses to write without `id`. Auto-fills `type`, `target`, `created`, `updated`, `source_sessions`.
- `scripts/lib/peer-cards/merger.mjs` — sentinel-region merge using `<!-- BEGIN MANAGED: <name> -->` / `<!-- END MANAGED: <name> -->`. Preserves hand-edits byte-exact outside sentinels. Surfaces conflicts (duplicate-section, orphan-begin) — never auto-resolves.
- `scripts/lib/peer-cards/staleness-banner.mjs` — session-start Phase 4 banner. Returns `null | {severity:'warn', message}` matching the 4 existing Phase 4 banners.

### Schema extension
- `skills/vault-sync/validator.mjs` — added `'peer-card'` to `vaultNoteTypeSchema` enum (sentinel-fenced block; 9 values total).
- `scripts/sync-vault-schema.mjs` — vendor-ahead note added to header; upstream `projects-baseline/zod-schemas/vault-frontmatter.ts` does NOT yet have `peer-card`. Documented as upstream-sync-debt; CI gated by SCHEMA_DRIFT_TOKEN.

### Wiring
- `skills/session-start/SKILL.md` Phase 4 — added 5th banner alongside bootstrap-lock / vault-staleness / ci-status / qg-command-drift. Cross-references `.claude/rules/owner-persona.md` and `skills/vault-sync/SKILL.md`.
- `skills/vault-sync/SKILL.md` — `type` enum docs note added; explains `peer-card` role under `.orchestrator/peers/`.

### Tests (130 new)
- `tests/scripts/lib/peer-cards/schema.test.mjs` (49 tests)
- `tests/scripts/lib/peer-cards/reader.test.mjs` (11 tests)
- `tests/scripts/lib/peer-cards/writer.test.mjs` (20 tests)
- `tests/scripts/lib/peer-cards/merger.test.mjs` (26 tests)
- `tests/scripts/lib/peer-cards/staleness-banner.test.mjs` (13 tests)
- `tests/unit/state-md-mutators-guards.test.mjs` (11 tests)

### EARS contract verified
- Ubiquitous: peer cards always carry valid vault frontmatter (id, type, target, created, updated) — enforced by writer.mjs:111.
- Ubiquitous: peer cards always hand-editable; merger preserves hand text byte-exact and surfaces conflicts (never auto-resolves).
- State-driven: while `updated > 30d ago`, session-start emits the staleness warning (Phase 4 banner integration).
- Unwanted: writer refuses to write when `id` missing → returns `{ok: false, errors: ['peer-card missing required field: id']}` AND no disk write occurs.

## Known gaps (filed as F4 follow-ups)

1. Architect YELLOW findings (4) — peer-cards module surface trimming:
   - Y1: `staleness-banner.mjs::renderBanner` is a speculative seam (zero external consumers)
   - Y2: `schema.mjs` `isValidPeerCardTarget`/`isValidPeerCardId`/`isValidIsoTimestamp` predicates exported but only used internally
   - Y3: `schema.mjs` `STALENESS_THRESHOLD_DAYS` + `isStalePeerCard` overlap with `computeStalenessDays` consumed inline by reader.mjs (3 exports for one concept)
   - Y4: `writer.mjs::writePeerCards` (plural) is YAGNI thin wrapper without cross-file atomicity guarantee

2. QA coverage gaps (Q2 MED + LOW):
   - MED-1: vault-sync validator `peer-card` enum addition has no direct unit test
   - MED-2: full read → merge → write roundtrip lacks E2E integration test
   - MED-3: `writePeerCards` partial-failure (cross-file non-atomicity) documented but not asserted
   - MED-4: merger empty-body + managed-only-body branches not covered
   - MED-5: `qg-command-drift-banner` E2E with real CLAUDE.md (currently all mocked)
   - LOW-1: `parseSections` regex state-leakage guard not tested
   - LOW-2: STALENESS_THRESHOLD_DAYS hardcoded in banner message
   - LOW-3: writer tmp-file cleanup on rename failure untested
   - LOW-4: title length boundary at exactly 200 chars not pinned

3. Q5 known gaps:
   - #503 AC3 E2E session-start flow with stale card
   - #503 AC4 vault-sync peer-card round-trip test

4. Upstream sync debt: `projects-baseline/zod-schemas/vault-frontmatter.ts` needs `peer-card` enum addition; sync-vault-schema CI may report drift until landed.

## Pipeline
- Pre-commit verification: Full Gate GREEN (6845/11sk/0f), lint PASS, typecheck PASS (217 files).
- Pipeline: <to be filled by F3 post-push>

## Cross-references
- Epic #498 Learning & Memory Modernization (Phase 1 closed; this opens Phase 2)
- Prior session: deep-2026-05-22 (Track A Pattern Quality #522-#525 closed)
- Next: #506 Dialectic-Deriver via /evolve --dialectic (blocked on #503 — now unblocked)
- Architectural reference: LANGUAGE.md "one-adapter rule", `.claude/rules/parallel-sessions.md` PSA-005
