# Pending Dialectic (manual /evolve --dialectic dry-run, evolve-2026-05-28-0839)

Second dialectic pass since deep-6/deep-7 applied the first (test-writer lint-discipline + W1 grep-verify bullets, 2026-05-27). 14 new learnings accrued since; deep-1 explicitly recommended this run. Deriver: haiku, top-50 learnings (conf 0.8–1.0) + last-10 sessions + both peer cards + steering. Budget raised to 30K (default 8K can't fit the 71-learning corpus). Estimated input ~26.2K tokens.

Deriver verdict: `status: ok`, no `would-empty-card` (USER target omitted; AGENT body full + non-empty). Conservative — **4 new bullets + 1 extended bullet to AGENT.md; USER.md NO change.**

Review and apply with `/evolve --dialectic --apply` in the next session. **One transcription fix required on apply — see ⚠ below.**

## Proposed: AGENT.md

### Addition 1 — § wave-execution (append one bullet)

```diff
   - Test-writers must verify both `npm test` (all tests pass) AND `npm run lint` (zero lint errors) before reporting done. Lint-only verification allows stylistic regressions to slip to Full Gate.
+  - When a test-writer agent runs tests against production code, then mutates the SUT to a known-broken state and re-runs to observe failure, this falsifiability cycle proves the test catches the regression it claims to cover. Mutation+revert cycles are expected in test delivery.
```

**Rationale:** learnings from deep-6 (#590-2 `acquire()` TOCTOU fix proven by SUT-mutation falsifiability — H1 fails under `<`→`<=`, H4 under linkSync→rename) + deep-1 (#599 all 4 SUT-mutation falsification-checked). The deep-6 pending artifact explicitly deferred this bullet ("no recurring multi-session signal yet; revisit next dialectic") — it is now multi-session (deep-6 + deep-1), so the deferral resolves to an addition.

### Addition 2 — § discovery-and-scope-adjustment (extend the grep-verify bullet)

```diff
-  - W1 agents must grep-verify all file-location claims and API-shape assumptions from the issue body before W2 scope takes shape. Pattern: issue claims "function X exported from module Y" → grep Y for the export; issue lists N callsites → grep the repo to verify only those N exist. Pre-dispatch verification catches mismatches (CLI-only vs importable, file renames, missing exports, SUT mis-attribution) before W2 wastes effort.
+  - W1 agents must grep-verify all file-location claims and API-shape assumptions from the issue body before W2 scope takes shape. Pattern: issue claims "function X exported from module Y" → grep Y for the export; issue lists N callsites → grep the repo to verify only those N exist. Pre-dispatch verification catches mismatches (CLI-only vs importable, file renames, missing exports, SUT mis-attribution) before W2 wastes effort. Quote the exact grep pattern, file scope, and result count in the Discovery report.
```

**Rationale:** PSA-006 (#555 FL-2) now mandates quoting the executed pattern + file scope + count. deep-1 W1 grep-verify caught 3 wrong issue-body premises (migrate-* path, #492 M7 file-count, emitAction count) by quoting transcripts. This makes the existing bullet's evidence-quoting requirement explicit.

### Addition 3 — § discovery-and-scope-adjustment (append one bullet)

```diff
+  - When Discovery grep-verifies that an issue AC is factually impossible or wrong (e.g., AC says "filter in file X" but grep proves file X has 0 references to the filter), the coordinator MUST surface the ambiguity via AUQ BEFORE Impl-Core dispatches against the wrong locus. The agent role is to report the contradiction with evidence; the coordinator decides how to proceed (adapt AC, reduce scope, ask user for clarification). Never let Impl agents silently resolve factual contradictions.
```

**Rationale:** deep-4 #566 (AC factually impossible per Discovery grep — `auto-dream.mjs` 0 confidence refs → AUQ-resolved scope), deep-6 D2 (2 factually-wrong #591 ACs caught via grep), deep-1 W1 (3 wrong premises reshaped W2). Strong 3-session signal that the coordinator's AUQ-on-contradiction step is a distinct responsibility from the agent's grep-report step.

### Addition 4 — § architecture-and-code-patterns (insert one bullet)

```diff
+  - For ESM SUTs that use default imports (`import fs from 'node:fs'`), test files can intercept calls via `vi.spyOn(fs, 'method')` if the test file also uses the same default import. The key step: capture the original before mocking with `const orig = fs.method.bind(fs)`, then pass-through calls that don't match the fault target via `orig.apply(fs, args)`. The `.bind(fs)` is load-bearing — without it, `this` inside the original implementation may be undefined.
```

**Rationale:** deep-7 agent-proposed learning (conf 0.90, "fs-spy ESM pattern proven" — MED-1a/1b/2 session-lock fault-injection). Complements (does NOT contradict) the existing "`vi.spyOn` on ESM **named** exports fails with `Cannot redefine property`" bullet: named-export spying fails, default-import spying works. The deriver correctly kept both.

### Addition 5 — § ci-and-verification (append one bullet)

```diff
+  - Integration tests with real fixtures often surface wiring drift that unit-mocks hide (e.g., module-A output shape differs from module-B input contract). Use integration tests to verify cross-module boundaries, not just to repeat unit-test scenarios with different dependencies.
```

**Rationale:** learning from 2026-05-23-1534-deep (integration-test wiring drift surfaced cross-module contract mismatch that unit-mocks masked).

## ⚠ Transcription fix required on `--apply`

The deriver emitted a FULL-BODY replacement and corrupted one existing line in § ci-and-verification:

```diff
-  ...Guard CLI entry points with `if (import.meta.url === pathToFileURL(process.argv[1]).href)` before calling `main()``.
+  ...Guard CLI entry points with `if (import.meta.url === pathToFileURL(process.argv[1]).href)` before calling `main()`.
```

A stray double-backtick (` ``. `) was introduced. The `--apply` step (or merger) MUST preserve the original single-backtick form. This is the known full-body-replacement corruption risk — flagged so it is not propagated.

## NOT proposed (deriver was conservative)

- **USER.md — zero changes.** Existing 5 managed sections already capture session preferences, wave structure, discovery/scope, quality/verification, and resource management. No new user-facing preference or deviation surfaced in the last 10 sessions.
- Heuristic-provenance anti-pattern (deep-7 D3) → architectural debt lesson specific to #594, not general agent guidance.
- RCR-006 skeptical posture → lives in `.claude/rules/receiving-review.md` (rule, not peer-card material).
- File-disjoint W2/W3, coord-direct CLAUDE.md fold-in → already in AGENT.md § parallelism-and-file-discipline.
- MED/LOW follow-up filing → already in USER.md § session-preferences.

<!-- DIALECTIC_USAGE: in=26232est out=~650 model=haiku budget=30000 -->
