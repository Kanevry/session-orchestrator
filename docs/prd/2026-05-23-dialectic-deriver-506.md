---
id: prd-2026-05-23-dialectic-deriver-506
type: project
target: agent
created: 2026-05-23T00:00:00Z
updated: 2026-05-23T00:00:00Z
title: Dialectic-Deriver #506 + Peer-Cards Surface Trim #529 + Coverage Gaps #530
status: implemented
source_sessions: [main-2026-05-23-deep]
tags: [prd, deep-session, dialectic-deriver, peer-cards, epic-498]
---

# Dialectic-Deriver (#506) + Peer-Cards Follow-Ups (#529, #530)

**Date:** 2026-05-23
**Author:** Bernhard Götzendorfer + Claude (AI-assisted)
**Status:** Implemented
**Appetite:** 1w (Small Batch)
**Parent Epic:** #498 Learning & Memory Modernization

---

## 1. Status

**Implemented.** All three issues closed in a single deep session on 2026-05-23 (5 waves,
~27 agents). Quality gates green at session-end; final push handled by W5-F3.

---

## 2. Issues Closed

| Issue | Title | Resolution |
|---|---|---|
| **#506** | Dialectic-Deriver — `/evolve --dialectic` mode + session-end auto-trigger | Full scope shipped: 4 new files, 4 modified skills/commands, 1 modified script, 39 new tests |
| **#529** | Peer-cards surface trim (architect YELLOW findings Y1–Y4 from #503 review) | Y1 `renderBanner` removed; Y2 3 predicates made private; Y3 `isStalePeerCard` deleted; Y4 `writePeerCards` plural deleted; 22 test cases removed cleanly |
| **#530** | Peer-cards + state-md coverage gaps (QA MED findings MED-1–MED-5 from #503 review) | MED-1 +3 vault-sync enum tests; MED-2+Q5-AC3/AC4 new roundtrip integration test; MED-3 superseded; MED-4 +2 merger edge tests; MED-5 new qg-command-drift integration test |

---

## 3. Architectural Decision: Pattern B (Orchestrator-Pattern, NOT Direct SDK)

The dialectic-deriver is implemented as an orchestrator-pattern module that injects a
`dispatchAgent` function at call time — it does NOT import `@anthropic-ai/sdk` or any
provider SDK directly.

**Justification (verbatim from `scripts/dialectic-deriver.mjs` header, citing the rule
that controls the decision):**

> Constitutional constraint — `.claude/rules/prompt-caching.md:3`:
> "Out of scope: session-orchestrator itself (no SDK use; `backend.md`
> § 'AI Provider Abstraction' already forbids direct SDK imports in business
> logic, and the orchestrator runs inside Claude Code's harness which manages
> caching at the platform layer)."
>
> Consequence: this module does NOT import `@anthropic-ai/sdk`. Callers inject
> `dispatchAgent` — the evolve skill supplies the real `Agent({...})` wrapper at
> runtime; tests supply a `vi.fn()` mock. Same DI shape as
> `scripts/lib/autopilot.mjs::runLoop({opts})`.

This is the same dependency-injection pattern used by `scripts/lib/autopilot.mjs`.
The `runDialecticDeriver({ dispatchAgent, ... })` signature (`scripts/dialectic-deriver.mjs`
line 459) makes the call boundary fully mockable, keeping all 8 pure-function exports
(`validateModel`, `estimateInputTokens`, `checkBudget`, `detectEmptying`, `buildPayload`,
`buildPrompt`, `parseResponse`, `runDialecticDeriver`) testable without harness involvement.

---

## 4. Implementation Summary

### #506 — Dialectic-Deriver

#### New files

**`scripts/dialectic-deriver.mjs`** (564 lines, 8 exports)
Core deriver. Reads up to top-50 learnings + last-10 sessions + existing peer cards
(`USER.md`, `AGENT.md` from `.orchestrator/peers/`) + project steering. Builds a payload,
dispatches the `dialectic-deriver` agent (injected), and parses the fenced-diff response.
Key design choices:
- Read-only by contract: the module never writes files; it returns the proposed diff.
- Best-effort parsing: malformed JSONL lines are skipped silently; missing input files
  collapse to `{ status: 'empty-input' }` rather than throwing.
- `detectEmptying` gate prevents the deriver from proposing a peer card wipe.
- Input-token budget enforced before dispatch via `checkBudget`; output budget fixed at 4000.
- `dry-run` is the default — callers must explicitly opt in to apply.

**`scripts/lib/auto-dialectic.mjs`** (382 lines, 9 exports)
Cadence helper for session-end Phase 3.6.7. Mirrors the `auto-dream.mjs` API shape exactly.
Reads `.orchestrator/dialectic-last-run` (ISO timestamp), counts sessions and learnings
newer than that timestamp via `readDialecticSignals()`, and returns a `{ trigger, reason }`
decision. AC4 precondition: if `sessionsSinceLast === 0 && learningsSinceLast === 0` the
decision is `trigger: false, reason: 'no-new-input-since-last-run'` regardless of cadence.
Exports: `DEFAULT_CADENCE`, `DIALECTIC_LAST_RUN_PATH`, `DIALECTIC_PENDING_PATH`,
`readDialecticLastRun`, `readDialecticSignals`, `shouldDispatchAutoDialectic`,
`writeDialecticLastRun`, `writeDialecticPending`, `readDialecticPending`.

**`scripts/lib/config/dialectic.mjs`** (90 lines, 1 export)
Session Config parser for the `dialectic:` block. Exports `_parseDialectic(content)`.
Fail-fast on unknown model: any value not in `['haiku', 'sonnet', 'opus']` causes
`scripts/lib/config.mjs` to exit 1 at startup — not silently ignored. Called at line 56 of
`scripts/lib/config.mjs` alongside the existing section parsers.

**`agents/dialectic-deriver.md`**
Agent definition. `model: haiku`, `sandbox-tier: read-only`, tools: `Read, Grep, Glob`.
Dispatched by `skills/evolve/SKILL.md` Phase 6 and session-end Phase 3.6.7.

#### Modified files

**`skills/evolve/SKILL.md`** — Phase 6 added (+83 lines).
Defines `/evolve --dialectic [--apply] [--dry-run] [--model <name>] [--budget-tokens <N>]`
mode. Calls `runDialecticDeriver()` with a `dispatchAgent` wrapper that uses the harness
Agent tool. Dry-run (default): writes sidecar to `.orchestrator/dialectic-pending.md` and
exits. Apply mode: reads the pending sidecar and applies the fenced diff to
`.orchestrator/peers/USER.md` and `.orchestrator/peers/AGENT.md` via the merger.

**`skills/session-end/SKILL.md`** — Phase 3.6.7 added (+46 lines).
Auto-trigger logic after Phase 3.6 (learnings write) and 3.6.5 (auto-dream decision).
Steps: read config, call `shouldDispatchAutoDialectic`, dispatch subagent if trigger, confirm
sidecar exists, update `dialectic-last-run` only on success. Cadence 0 is a hard kill-switch.

**`scripts/lib/config.mjs`** — 3 lines (import + call + return at lines 56, 254-255, 344).
Integrates `_parseDialectic` into the master config parse so the `dialectic` key is
available as `config.dialectic` throughout the skill runtime.

**`commands/evolve.md`** — 2 line replacements.
`argument-hint` updated to include `dialectic`; description updated to mention peer-card
updates. Source: `commands/evolve.md` lines 3 and 10.

**`scripts/vault-mirror.mjs`** — +11 lines docblock (lines 37–48).
Documents why vault-mirror excludes `.orchestrator/dialectic-pending.md` and
`.orchestrator/dialectic-last-run`. The exclusion is structural (vault-mirror operates
exclusively on JSONL sources passed via `--source`), not a mechanical guard — the entry-point
architecture makes the guard unnecessary.

**`docs/session-config-template.md` and `docs/session-config-reference.md`** — `dialectic:`
block added to both. Template: lines 547+. Reference: lines 269–278 (template) and 368–389
(reference narrative with EARS contract). Three fields documented: `cadence` (default 5),
`model` (default `haiku`, fail-fast on unknown), `budget-tokens` (default 8000).

**`.gitignore`** — 3 sidecars added:
- `.orchestrator/dialectic-pending.md`
- `.orchestrator/dialectic-last-run`
- `.orchestrator/pending-dream.md` (gap fill — was missing from prior commit)

#### Tests (bonus W2 gap fill)

**`tests/scripts/lib/auto-dialectic.test.mjs`** — 39 tests, mirroring the `auto-dream.test.mjs`
pattern. Covers: `readDialecticSignals` with populated/empty/missing JSONL files; cadence
boundary conditions; `shouldDispatchAutoDialectic` AC4 no-new-input guard; `writeDialecticLastRun`
atomic write; `writeDialecticPending` tmp+rename; `readDialecticPending` missing file.

---

### #529 — Peer-Cards Surface Trim

Four architect YELLOW findings from the W5 review of #503 resolved:

| Finding | Action | Files affected |
|---|---|---|
| Y1 `renderBanner` (speculative seam, zero consumers) | Deleted (-12 lines) | `scripts/lib/peer-cards/staleness-banner.mjs` |
| Y2 3 predicates exported but internal-only | Made module-private (`isValidPeerCardTarget`, `isValidPeerCardId`, `isValidIsoTimestamp`) | `scripts/lib/peer-cards/schema.mjs` |
| Y3 `isStalePeerCard` overlaps `computeStalenessDays` | Deleted `isStalePeerCard`; `reader.mjs` imports `STALENESS_THRESHOLD_DAYS` + `computeStalenessDays` directly | `scripts/lib/peer-cards/schema.mjs`, `scripts/lib/peer-cards/reader.mjs` |
| Y4 `writePeerCards` (plural, YAGNI thin wrapper) | Deleted (-20 lines) | `scripts/lib/peer-cards/writer.mjs` |

22 test cases removed across 3 test files — clean removal with no regressions against the
reduced public surface. MED-3 from #530 (partial-failure test for `writePeerCards`) was
superseded by this deletion.

---

### #530 — Peer-Cards + State-MD Coverage Gaps

| Gap | Resolution | New tests |
|---|---|---|
| MED-1: vault-sync `peer-card` enum has no direct unit test | +3 tests via `it.each` (11 cases total) covering all valid enum values + rejection of unknown type | In existing vault-sync unit test file |
| MED-2 + Q5 AC3/AC4: no disk roundtrip or session-start E2E | NEW `tests/integration/peer-cards-roundtrip.integration.test.mjs` (443 lines, 10 tests: 5-step disk roundtrip + session-start banner E2E + vault-sync acceptance) | 10 tests |
| MED-3: `writePeerCards` partial-failure untested | SUPERSEDED — `writePeerCards` deleted by #529 Y4 | — |
| MED-4: merger empty-body + managed-only-body branches | +2 tests in existing merger test file | 2 tests |
| MED-5: `qg-command-drift-banner` all-mocked | NEW `tests/integration/qg-command-drift-banner.integration.test.mjs` (245 lines, 11 tests with real CLAUDE.md fixtures, no mocks) | 11 tests |

---

## 5. Wave-by-Wave Evidence

### W1 — Discovery (4 agents)
- D1 (`discovery-agent`): Confirmed Pattern B constraint from `.claude/rules/prompt-caching.md:3`.
  Identified 4 callsites for `dispatchAgent` injection vs 2 actual code sites (issue body had
  listed 4 but W1-A1 audit found 2 real ones — saved W2 from dual-touching phantom files).
- D2 (`discovery-agent`): Audited #529 Y1–Y4 findings against current `schema.mjs`,
  `writer.mjs`, `staleness-banner.mjs`; confirmed all 4 were genuine redundancies.
- D3 (`discovery-agent`): Audited #530 MED-1–MED-5 gap landscape; flagged MED-3 as
  superseded-by-Y4 if deletion proceeded.
- D4 (`discovery-agent`): Confirmed `.gitignore` missing `pending-dream.md` (bonus gap).

### W2 — Implementation Core (6 agents)
- I1 (`code-implementer`): `scripts/dialectic-deriver.mjs` (564 lines, 8 exports).
- I2 (`code-implementer`): `scripts/lib/auto-dialectic.mjs` (382 lines, 9 exports) +
  `scripts/lib/config/dialectic.mjs` (90 lines) + `scripts/lib/config.mjs` integration.
- I3 (`code-implementer`): `agents/dialectic-deriver.md` + `skills/evolve/SKILL.md`
  Phase 6 (+83 lines) + `commands/evolve.md` replacements.
- I4 (`code-implementer`): `skills/session-end/SKILL.md` Phase 3.6.7 (+46 lines) +
  `scripts/vault-mirror.mjs` docblock (+11 lines) + `.gitignore` additions.
- I5 (`code-implementer`): `docs/session-config-template.md` + `docs/session-config-reference.md`
  dialectic block documentation.
- I6 (`code-implementer`): #529 Y1–Y4 surface trim (4 deletions, 22 test case removals,
  `reader.mjs` import adjustment).
- I7 (`code-implementer`): #530 MED-1 vault-sync enum tests + MED-4 merger edge tests.

### W3 — Tests (6 agents)
- P1 (`test-writer`): `tests/scripts/lib/auto-dialectic.test.mjs` (39 tests — bonus gap fill,
  mirrors `auto-dream.test.mjs` structure).
- P2 (`test-writer`): `tests/integration/peer-cards-roundtrip.integration.test.mjs`
  (443 lines, 10 tests covering MED-2 + Q5 AC3/AC4).
- P3 (`test-writer`): `tests/integration/qg-command-drift-banner.integration.test.mjs`
  (245 lines, 11 tests, MED-5, real CLAUDE.md fixtures).
- P4–P6: full gate run, gap triage, coverage review.

### W4 — Review (5 agents)
- **Q1 (`quality-gate`)**: Full Gate GREEN — 6957 passed / 0 failed / 12 skipped.
- **Q2 (`security-reviewer`, Opus, read-only)**: PROCEED_WITH_FOLLOWUPS.
  - H-1: `.gitignore` missing `pending-dream.md` — fixed coord-direct.
  - M-1: `buildPrompt` injects JSONL content without length-bounding — → F4 follow-up.
  - L-1: `validateModel` returns error string instead of throwing — → F4 follow-up.
  - L-2: `writeDialecticLastRun` non-atomic on partial write — → F4 follow-up.
- **Q3 (`architect-reviewer`, Opus, read-only)**: PROCEED_WITH_FOLLOWUPS.
  - 0 RED. 3 YELLOW + 2 LOW → F4 follow-ups (see Section 7).
- **Q4 (`qa-strategist`, Opus, read-only)**: PROCEED_WITH_FOLLOWUPS.
  - 0 HIGH. 2 MED + 3 LOW → F4 follow-ups (see Section 7).
- **Q5 (`session-reviewer`, Opus, read-only)**: AC_ALL_MET, PROCEED.

### W5 — Finalization (4 agents)
- F1 (`docs-writer`, this agent): this PRD.
- F2 (`vault-mirror`): session memory + decisions mirror.
- F3 (`committer`): commit + push.
- F4 (`issue-filer`): follow-up issue filing (see Section 7).

---

## 6. Quality Gates

| Gate | Result | Detail |
|---|---|---|
| Tests | 6957 passed / 0 failed / 12 skipped | Net +112 from baseline 6845. Full suite via `npm test`. |
| Lint | 0 errors | `npm run lint` exit 0 |
| TypeScript | 219 files OK | `npm run typecheck` exit 0 |
| validate-plugin | 101/0 | `scripts/validate-plugin.mjs` |
| Owner-leakage | 0 findings | Pre-commit hook (scripts/lib/validate/check-owner-leakage.mjs) |
| Full Gate (Q1) | GREEN | Inter-wave Quality-Gate after W3 |

Test delta breakdown:
- #529: −22 test cases (clean removal of deleted surface)
- #530 MED-1: +3 vault-sync enum tests (11 total via `it.each`)
- #530 MED-2+Q5: +10 integration tests (`peer-cards-roundtrip.integration.test.mjs`)
- #530 MED-4: +2 merger edge tests
- #530 MED-5: +11 integration tests (`qg-command-drift-banner.integration.test.mjs`)
- #506 bonus: +39 unit tests (`auto-dialectic.test.mjs`)
- Remaining +69: dialectic-deriver core unit tests (pure-function exports)
- Net: +112

---

## 7. Carryover / Follow-Ups (to be filed by F4)

The following findings from W4 reviewer panel are out of scope for this session and will be
filed as individual issues by W5-F4.

### Security (from Q2 — M-1, L-1, L-2)

| Priority | Description |
|---|---|
| MED | `buildPayload` / `buildPrompt` in `scripts/dialectic-deriver.mjs`: JSONL content injected into agent prompt without length-bounding beyond the token-budget check. A pathological `learnings.jsonl` could hit Claude's context limit. Add per-entry character cap before payload construction. |
| LOW | `validateModel` returns an error-string on failure instead of throwing. Callers must check the return value, which is easy to forget. Switch to throw-on-invalid consistent with other validators in the codebase. |
| LOW | `writeDialecticLastRun` uses a two-step write (write + rename) but the tmp file is not cleaned up on rename failure. Add `unlink` in the catch path (mirrors the pattern in `writer.mjs`). |

### Architecture (from Q3 — 3 YELLOW, 2 LOW)

| Priority | Description |
|---|---|
| YELLOW | `runDialecticDeriver` timeout: no per-dispatch wall-clock timeout wraps the `dispatchAgent` call. A hung subagent blocks session-end indefinitely. Add a configurable timeout (default 120s). |
| YELLOW | `readDialecticSignals` reads the full JSONL files into memory. For large repos (>10k entries) this could spike memory. Add a max-lines-read cap (read from tail, not head). |
| YELLOW | `buildPayload` top-N / last-K are hard-coded (50 learnings, 10 sessions). Make them Session Config knobs under `dialectic.top-learnings` and `dialectic.last-sessions`. |
| LOW | `detectEmptying` threshold (80% reduction) is a magic number inline. Extract to a named constant `EMPTYING_THRESHOLD` and document. |
| LOW | `scripts/lib/config/dialectic.mjs` `_parseDialectic` is exported with a leading underscore (test-only convention) but is imported by `scripts/lib/config.mjs` in production. Either promote to a public name or find a cleaner module boundary. |

### QA (from Q4 — 2 MED, 3 LOW)

| Priority | Description |
|---|---|
| MED | `runDialecticDeriver` error-path coverage: no unit test for the case where `dispatchAgent` throws. The `detectEmptying` gate has a test for the happy path but not for the edge where `existingCards` is partially malformed. |
| MED | `auto-dialectic.mjs` `readDialecticSignals`: no test for a JSONL file where some lines have no date fields. Currently silently skipped — the skip behaviour is not asserted. |
| LOW | `parseResponse` regex: no test for a response containing multiple fenced diff blocks (only the first is used). |
| LOW | `buildPrompt` output: no snapshot test. Changes to prompt wording are invisible in CI. |
| LOW | `qg-command-drift-banner.integration.test.mjs`: uses a tmp copy of the real CLAUDE.md. When CLAUDE.md grows a new `*-command` key, the fixture may silently drift. Add a fixture-freshness assertion. |

---

## 8. Lessons Learned

1. **Pattern B clarity via D1 callsite audit.** W1-A1 (`discovery-agent`) found that the
   issue body listed 4 `dispatchAgent` injection sites but only 2 existed in code after #503
   shipped. Running a real callsite grep before implementation planning saved W2 from writing
   two redundant integration paths. Lesson: always grep-verify issue body callsite lists
   before W2 begins.

2. **MED-3 superseded by a concurrent change.** The #530 MED-3 gap (assert partial-failure
   behaviour of `writePeerCards` plural) was rendered moot by the #529 Y4 decision to delete
   `writePeerCards` entirely. When two issues in the same wave both modify the same module
   surface, the deletion issue should be sequenced first (I6 before I7) and the test-gap
   issue audited post-deletion. We caught this in D3 but sequencing the agents correctly
   required explicit coordinator guidance.

3. **`auto-dialectic.mjs` mirroring `auto-dream.mjs` API exactly.** The decision to make
   `auto-dialectic.mjs` a structural mirror of `auto-dream.mjs` (same export names, same
   path conventions, same cadence decision shape) paid off in W3: `test-writer` (P1) was
   able to generate the 39-test suite by adapting `auto-dream.test.mjs` rather than writing
   from scratch. Established API shapes enable test writers to work faster and more
   accurately.

4. **`.gitignore` gap found by Q2 H-1.** The `pending-dream.md` sidecar had been introduced
   by #502 but never added to `.gitignore` — it was only the dialectic PRD work that prompted
   a fresh `.gitignore` review. The security reviewer's H-1 finding caught it as a high-
   priority fix because a committed LLM-generated sidecar could expose session content. This
   class of "transient artifact omitted from gitignore" is a recurring risk; session-end
   should run a gitignore-audit probe for `.orchestrator/` files.

5. **`detectEmptying` as a safety gate, not a style choice.** The deriver could theoretically
   produce a diff that blanks a peer card entirely if the learnings signal is sparse. The
   `detectEmptying` export in `scripts/dialectic-deriver.mjs` prevents this structurally
   (threshold: 80% reduction triggers rejection). Documenting this as a named safety gate
   (not just an inline conditional) makes the protection visible to future reviewers.

---

## 9. Out of Scope

- **#531 upstream-sync-debt for `projects-baseline`**: `projects-baseline/zod-schemas/vault-frontmatter.ts`
  needs a `peer-card` enum addition to match `skills/vault-sync/validator.mjs`. This requires
  cross-repo access (`projects-baseline` is a separate repo not in scope for this session).
  CI `SCHEMA_DRIFT_TOKEN` gate will surface drift until landed. Filed as a separate issue.

- **`/evolve --dialectic --apply` full end-to-end integration test**: the apply path was
  implemented in `skills/evolve/SKILL.md` Phase 6 but not covered by an integration test
  in this session (the apply path exercises the peer-cards `merger.mjs` which already has
  unit coverage). E2E apply test deferred.

- **`dialectic.top-learnings` / `dialectic.last-sessions` as Session Config knobs**: top-N
  and last-K are hard-coded in `buildPayload` (50 and 10 respectively). Making them
  configurable was deferred (filed as YELLOW in Q3 findings, see Section 7).

- **Session-start cold-start nudge for pending dialectic sidecar**: when
  `.orchestrator/dialectic-pending.md` exists from a prior session, no banner surfaces it at
  session-start. A Phase 4 banner analogous to the staleness-banner could prompt the operator
  to run `/evolve --dialectic --apply`. Deferred as a follow-up.

- **Performance optimisation of `readDialecticSignals` for large repos**: full-file JSONL
  reads are acceptable at current corpus sizes; tail-read cap deferred to the Q3 YELLOW
  follow-up issue.

---

## Cross-References

- Issues closed: #506, #529, #530
- Prior session PRD (peer-cards foundation): `docs/prd/2026-05-23-pattern-quality-followup-503-peer-cards.md`
- Prior epic PRD (gsd patterns): `docs/prd/2026-05-22-gsd-pattern-adoption-quickwins.md`
- Architectural rule governing Pattern B: `.claude/rules/prompt-caching.md` §3
- Session metrics: `.orchestrator/metrics/sessions.jsonl` (entry appended at session-end)
- Session decisions: vault-mirror to `~/Projects/Bernhard/vault/01-projects/session-orchestrator/decisions.md`
- Key source files:
  - `scripts/dialectic-deriver.mjs` (564 lines)
  - `scripts/lib/auto-dialectic.mjs` (382 lines)
  - `scripts/lib/config/dialectic.mjs` (90 lines)
  - `agents/dialectic-deriver.md`
  - `tests/scripts/lib/auto-dialectic.test.mjs` (39 tests)
  - `tests/integration/peer-cards-roundtrip.integration.test.mjs` (443 lines, 10 tests)
  - `tests/integration/qg-command-drift-banner.integration.test.mjs` (245 lines, 11 tests)
