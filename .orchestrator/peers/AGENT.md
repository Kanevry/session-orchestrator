---
id: agent-card
type: peer-card
target: agent
created: "2026-05-25T17:34:29.831Z"
updated: "2026-05-28T11:52:26.975Z"
source_sessions: ["evolve-2026-05-25T1638", "evolve-2026-05-28-0839", "evolve-2026-05-28-1152"]
---

<!-- BEGIN MANAGED: parallelism-and-file-discipline -->
## Parallelism and file discipline

- `isolation:none + enforcement:strict + file-disjoint W2` is the proven default pattern across 15+ consecutive green sessions. Do not deviate without an explicit reason.
- File-disjoint `allowedPaths` per agent is enforced at the prompt level regardless of worktree isolation mode. When worktree isolation is dropped due to RAM pressure, allowedPaths must still be strictly disjoint.
- When 2+ planned tasks share >50% file scope, merge them into one agent before W2 dispatch to avoid parallel-write conflicts.
- When 2 agents both want to edit a shared file, have one localize its changes to a sister file — prefer clean separation over coord-merge work.
- Do not dispatch concurrent agents to edit CLAUDE.md; collect proposed YAML additions verbatim in agent reports and apply them coord-direct in W5 Finalization.
<!-- END MANAGED: parallelism-and-file-discipline -->

<!-- BEGIN MANAGED: wave-execution -->
## Wave execution

- 5W structure default: Discovery → Impl-Core → Impl-Polish → Quality → Finalization.
- Housekeeping sessions: single-wave Express Path, 0-6 agents, coordinator-direct. No multi-wave planning needed.
- 5W×6A thin-slice epics with shipped substrate: W1 6 parallel Explore, W2 6 file-disjoint code-implementers, W3 typically reduces to 4 after W2 absorption, W4 test-writers + security-reviewer, W5 2-3 agents.
- Inter-wave Quality-Lite gate after Impl-Core must include `npm test` when production fixes touch files with adjacent test files — typecheck+lint alone is insufficient.
- When session-reviewer reports BLOCK at end of W2, add the fix as a new agent in W3 (Impl-Polish); do not restart W2.
- Test-writers must verify both `npm test` (all tests pass) AND `npm run lint` (zero lint errors) before reporting done. Lint-only verification allows stylistic regressions to slip to Full Gate.
- When a test-writer agent runs tests against production code, then mutates the SUT to a known-broken state and re-runs to observe failure, this falsifiability cycle proves the test catches the regression it claims to cover. Mutation+revert cycles are expected in test delivery.
- When a wave ships a fix for a recurring anti-pattern, run a pattern-replication audit on the rest of the diff before W4 closes — the agent who just fixed the bug is the most likely to re-introduce it elsewhere in the same change set. A single-agent review misses the recurrence; a multi-reviewer W4 panel catches it. Add a 1-line grep of the diff for other instances of the just-fixed pattern.
<!-- END MANAGED: wave-execution -->

<!-- BEGIN MANAGED: discovery-and-scope-adjustment -->
## Discovery and scope adjustment

- W1 Discovery findings that warrant scope reduction or expansion must surface via AUQ before W2 dispatch.
- When Discovery reveals the planned work was already shipped by a prior session, immediately reduce scope rather than re-implementing.
- For sessions where issue bodies claim external submission status (e.g., "awesome-list"), W1 must web-fetch the upstream list to confirm current state before dispatching W2 work.
- W1 agents must grep-verify all file-location claims and API-shape assumptions from the issue body before W2 scope takes shape. Pattern: issue claims "function X exported from module Y" → grep Y for the export; issue lists N callsites → grep the repo to verify only those N exist. Pre-dispatch verification catches mismatches (CLI-only vs importable, file renames, missing exports, SUT mis-attribution) before W2 wastes effort. Quote the exact grep pattern, file scope, and result count in the Discovery report.
- When Discovery grep-verifies that an issue AC is factually impossible or wrong (e.g., AC says "filter in file X" but grep proves file X has 0 references to the filter), the coordinator MUST surface the ambiguity via AUQ BEFORE Impl-Core dispatches against the wrong locus. The agent role is to report the contradiction with evidence; the coordinator decides how to proceed (adapt AC, reduce scope, ask user for clarification). Never let Impl agents silently resolve factual contradictions.
<!-- END MANAGED: discovery-and-scope-adjustment -->

<!-- BEGIN MANAGED: architecture-and-code-patterns -->
## Architecture and code patterns

- When splitting a parent module into child submodules, extract schema/leaf types to a sibling module first. The dependency graph must be unidirectional: schema → io/filters → barrel. A barrel that re-exports children that import from the parent creates a real ESM circular import.
- The file-conflict matrix (D5 Discovery) checks file overlap, not dependency direction. Architect-reviewer is required to catch circular-import risks from module splits.
- Production modules that may be `vi.mock`ed in sibling test files must use lazy dynamic imports (`await import(...)`) instead of top-level static imports. Top-level static imports cache the real module in the vitest fork pool, preventing mock interception.
- `promisify(execFile)` silently ignores `AbortSignal`; use raw `spawn()` with `controller.signal` for genuine cancellation.
- For ESM SUTs that use default imports (`import fs from 'node:fs'`), test files can intercept calls via `vi.spyOn(fs, 'method')` if the test file also uses the same default import. The key step: capture the original before mocking with `const orig = fs.method.bind(fs)`, then pass-through calls that don't match the fault target via `orig.apply(fs, args)`. The `.bind(fs)` is load-bearing — without it, `this` inside the original implementation may be undefined.
- `vi.spyOn` on ESM named exports fails with `Cannot redefine property`; use real filesystem error injection (e.g., `chmodSync(dir, 0o555)`) instead.
- ESLint `eqeqeq` rejects `x == null`; write `x === null || x === undefined` explicitly or use nullish-coalescing.
- `existsSync(target)` is not an authorization check — it answers "does this path exist", not "is this the RIGHT path". For any write-gate where writing to the wrong target is the failure mode (vault mirror, deploy target, backup destination), guard on an IDENTITY probe (git remote get-url origin, a sentinel marker file, a known UUID) and host-qualify the match (`endsWith('host.tld/org/repo')`) so a same-named repo on a different host is still rejected. Fail closed: any non-zero probe exit OR non-matching identity is a whole-run `exit(2)`, not a per-entry skip. Provide a load-bearing env-var bypass for tests that legitimately target non-canonical tmp dirs, and cover the guard black-box with the bypass off.
<!-- END MANAGED: architecture-and-code-patterns -->

<!-- BEGIN MANAGED: ci-and-verification -->
## CI and verification

- CI status at session-start is authoritative. Never claim CI green from local `npm test` alone. Phase 4 CI banner is load-bearing.
- A top-level `process.exit()` during test file import crashes the vitest fork worker. Subsequent test files in the same fork lose their `vi.mock` registry — diagnostic signature is `ERR_MODULE_NOT_FOUND chunks/utils.*.js`. Guard CLI entry points with `if (import.meta.url === pathToFileURL(process.argv[1]).href)` before calling `main()`.
- Vitest 4 does not fix tinypool worker-exit hang on Linux CI; the timeout wrapper is still required for GitLab/GitHub Ubuntu runners.
- Integration tests with real fixtures often surface wiring drift that unit-mocks hide (e.g., module-A output shape differs from module-B input contract). Use integration tests to verify cross-module boundaries, not just to repeat unit-test scenarios with different dependencies.
<!-- END MANAGED: ci-and-verification -->

<!-- BEGIN MANAGED: security-review-integration -->
## Security review integration

- A W3 cross-spike security-reviewer can catch RCE-class design flaws in PRDs before implementation. Include security-reviewer in W3 when any PRD involves shell execution, subprocess spawning, or user-supplied path/command handling.
- MEDIUM security findings from reviewers are filed as follow-up issues and do not block session completion. HIGH/BLOCK findings require redesign before W4.
<!-- END MANAGED: security-review-integration -->

<!-- BEGIN MANAGED: incremental-epic-delivery -->
## Incremental epic delivery

- Phase A (contract) → Phase B Scaffold → Phase B-N (fill + wire) shipped as distinct sessions over 24h is the proven cadence for v3.x epics. Each session is narrow-scope (1-2 issues), narrow-file.
- For appetite:2w issues, split at natural seams: pure-function-checkable work now vs wave-executor-signal-dependent work later. This avoids partial-state corruption and enables mid-cycle pivots.
- PRD → skill scaffold → command stub → vault mirror → narrative → numbered sub-issues for runtime impl is the proven Phase scaffold sequence for new capabilities.
<!-- END MANAGED: incremental-epic-delivery -->