# Pending Dialectic (auto-dialectic dry-run, session main-2026-05-27-deep-6)

First dialectic pass since the peer cards were created manually 2026-05-25 (62 learnings accumulated, never auto-derived). Conservative — only 2 durable, evidence-grounded additions to AGENT.md proposed. USER.md needs NO change (existing managed sections already capture the operator's preferences + the file-follow-ups-for-MED/LOW pattern).

Review and apply with `/evolve --dialectic --apply` in the next session.

## Proposed: AGENT.md

### Addition 1 — § wave-execution (append one bullet)

```diff
   - 5W×6A thin-slice epics with shipped substrate: W1 6 parallel Explore, W2 6 file-disjoint code-implementers, W3 typically reduces to 4 after W2 absorption, W4 test-writers + security-reviewer, W5 2-3 agents.
+  - Test-writers must verify both `npm test` (all tests pass) AND `npm run lint` (zero lint errors) before reporting done. Lint-only verification allows stylistic regressions to slip to Full Gate.
```

**Rationale:** learning `test-writer-verification-must-include-lint` (deep-2 #481, conf 0.75). deep-6 W3-T1's new `session-lock-cross-process.test.mjs` shipped with an unused `workerPath` var that only the canonical `npm run lint` caught at the inter-wave Full Gate — exactly the regression class this bullet prevents.

### Addition 2 — § discovery-and-scope-adjustment (append one bullet)

```diff
   - For sessions where issue bodies claim external submission status (e.g., "awesome-list"), W1 must web-fetch the upstream list to confirm current state before dispatching W2 work.
+  - W1 agents must grep-verify all file-location claims and API-shape assumptions from the issue body before W2 scope takes shape. Pattern: issue claims "function X exported from module Y" → grep Y for the export; issue lists N callsites → grep the repo to verify only those N exist. Pre-dispatch verification catches mismatches (CLI-only vs importable, file renames, missing exports, SUT mis-attribution) before W2 wastes effort.
```

**Rationale:** learnings `discovery-d5-cli-only-api-mismatch` (conf 0.8) + `discovery-saves-waves-when-issue-bodies-partial` (conf 0.9). deep-6 D2 grep-verified that #591 H3's SUT was `session-discovery.mjs` NOT `session-registry.mjs` (issue mis-attribution) and that AP2's strict-UUID regex would break tests — both caught pre-W3 via grep, preventing wrong-file edits. This is the RCR-006 skeptical-posture made mechanical at the Discovery layer.

## NOT proposed (already covered — deriver was conservative)
- File-disjoint W2/W3 enforcement → already in AGENT.md § parallelism-and-file-discipline.
- Coordinator files MED/LOW follow-ups rather than blocking → already in USER.md.
- RCR-006 skeptical posture → lives in `.claude/rules/receiving-review.md` (rule, not peer-card material).
- Mutation-proven falsifiability → no recurring multi-session learning signal yet (deep-6 was strong but single-session); revisit next dialectic.

<!-- DIALECTIC_USAGE: in=77000 out=1200 model=haiku -->
