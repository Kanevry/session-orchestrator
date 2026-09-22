---
id: agent-card
type: peer-card
target: agent
created: "2026-05-25T17:34:29.831Z"
updated: "2026-09-22T13:55:37.788Z"
source_sessions: ["evolve-2026-05-25T1638", "evolve-2026-05-28-0839", "evolve-2026-05-28-1152", "evolve-2026-05-30-0913", "evolve-2026-07-04-session-3-reviewed-no-changes", "main-2026-08-05-deep-1", "main-2026-09-06-session-17", "main-2026-09-09-session-10", "main-2026-09-22-housekeeping-0834", "main-2026-09-21-session-4", "main-2026-09-20-session-3", "main-2026-09-19-session-18", "main-2026-09-19-session-9", "main-2026-09-19-session-1", "main-2026-09-18-session-10", "main-2026-09-18-session-1", "main-2026-09-17-session-23", "main-2026-09-16-session-6", "main-2026-09-13-session-42", "c33eb804-46cd-47b8-9392-b98c0a5b2598", "main-2026-09-12-session-26", "5de6560c-ae9c-4c4a-8212-f102c4576ff0", "main-2026-09-13-session-9", "main-2026-09-07-session-11", "main-2026-09-11-session-25"]
---

<!-- BEGIN MANAGED: guard-and-protocol-migration -->
## Guard and protocol-migration discipline

- Contract-Lock before fan-out: when N wave agents will all build against ONE shared contract surface (a factored signature, a shared test helper, a schema), dispatch the agent that OWNS that surface ALONE and serially FIRST, let it freeze the contract, then fan out the N followers against the frozen surface. Prevents N agents re-inventing the same contract in parallel and lets the followers stay file-disjoint.
- When migrating an output protocol (channel, envelope, exit-code semantics), enumerate consumers by WHO SPAWNS the binary — never by grepping the payload field name. A consumer that pins only the channel or the exit code is structurally invisible to a payload grep and surfaces only at the Full Gate. Cross-check the census with a second, differently-shaped measurement.
- A Discovery census is a claim about the PAST the moment a later wave changes the surface it measured. Before re-briefing a count/scope-map into a downstream wave, re-verify it at the current HEAD — a mid-session refactor (e.g. an earlier wave decoupling a module) silently invalidates the earlier map.
<!-- END MANAGED: guard-and-protocol-migration -->

<!-- BEGIN MANAGED: parallelism-and-file-discipline -->
## Parallelism and file discipline

- `isolation:none + enforcement:strict + file-disjoint W2` is the proven default pattern across 15+ consecutive green sessions. Do not deviate without an explicit reason.
- File-disjoint `allowedPaths` per agent is enforced at the prompt level regardless of worktree isolation mode. When worktree isolation is dropped due to RAM pressure, allowedPaths must still be strictly disjoint.
- When 2+ planned tasks share >50% file scope, merge them into one agent before W2 dispatch to avoid parallel-write conflicts.
- When 2 agents both want to edit a shared file, have one localize its changes to a sister file — prefer clean separation over coord-merge work.
- Do not dispatch concurrent agents to edit CLAUDE.md; collect proposed YAML additions verbatim in agent reports and apply them coord-direct in W5 Finalization.
- When an implementer needs to compare a file's prior state or test against a known-good baseline, name `git show HEAD:<file>` explicitly in the dispatch prompt. Two separate implementer agents reached for `git stash` for exactly this need in the same session (a PSA-007 violation each time, even when self-corrected) — offering the stash-free alternative up front removes the temptation rather than relying on the agent to recall the rule.
- When several agents in one wave edit hook-reachable modules, `hooks/_lib/hook-import-set.json` drifts the moment one agent adds an import — and because `validate-plugin` runs as vitest's `globalSetup`, every sibling's own `npx vitest run` aborts before its workers even start. Dispatch hook-graph-changing agents first, alone, or regenerate the import set at the first escalation and again at wave end.
- `isolation: worktree` creates every review/fix-pass worktree from HEAD. If the wave's own results are still uncommitted in the main tree — the normal state before `/close` commits — a reviewer or fixer dispatched into that worktree sees none of the work it is meant to check, and correctly reports no findings against code it never saw. Any wave that reviews or fixes uncommitted results from a prior wave must run in-place (`isolation: none`, `enforcement: strict`).
<!-- END MANAGED: parallelism-and-file-discipline -->

<!-- BEGIN MANAGED: wave-execution -->
## Wave execution

- Use the resolved session shape and explicit user request. Discovery → Impl-Core → Impl-Polish → Quality → Finalization is an established sequence, not a requirement to invent work for every stage.
- Housekeeping may use the single-wave Express Path when eligible. An explicit request for waves, parallel subagents, or a larger approved scope takes precedence; do not collapse that request into coordinator-direct execution merely because the session type is housekeeping.
- For thin-slice epics, freeze shared contracts before parallel implementation. Adjust later waves to work already absorbed and to the current resource gate rather than repeating historical agent counts.
- Inter-wave Quality-Lite after Impl-Core must include relevant tests when production fixes touch files with adjacent tests; typecheck and lint alone cannot verify the changed behavior.
- When a reviewer reports a blocker, add its verified repair to the next suitable wave where dependencies allow, then re-verify. Do not restart an earlier wave solely to preserve its label.
- Test-writers must run the relevant tests and lint before reporting done, quoting the actual result and exit code.
- A red-before-fix test needs a causal check: disable the newly added behavior and confirm the intended assertion fails while unrelated controls remain green. Use isolated mutant copies when the SUT is outside the agent's file scope or loaded by live hooks; rewrite static and dynamic relative imports, keep an unmodified control, and reject missing-module failures as mutation evidence.
- When a wave fixes a recurring anti-pattern, inspect the remaining diff for the same pattern before Quality closes. Independent reviewers should examine the full current diff, including uncommitted results.
- Classify findings against the frozen scope. Fix in-scope blockers and enumerated same-pattern sites within the owned files; route adjacent findings to follow-up. A contract or owner-boundary change needs an explicit disposition, not automatic absorption based on a MEDIUM label.
- Verify coordinator-declared paths before materializing scope. Write both per-agent scope files and the aggregate including coordinator edits; a phantom path or a missing shape can leave the intended protection ineffective.
- A fix-pass dispatch needs the same scope materialization as a planned wave. Read-only review of uncommitted work must see the working tree containing that work, rather than a fresh worktree containing only HEAD.
- Dispatched agents should incorporate a post-report correction into a complete replacement report. Keep the original findings, verification receipts, and final status together so an addendum cannot displace them.
<!-- END MANAGED: wave-execution -->

<!-- BEGIN MANAGED: discovery-and-scope-adjustment -->
## Discovery and scope adjustment

- W1 Discovery findings that warrant scope reduction or expansion must surface via AUQ before W2 dispatch.
- When Discovery reveals the planned work was already shipped by a prior session, immediately reduce scope rather than re-implementing.
- For sessions where issue bodies claim external submission status (e.g., "awesome-list"), W1 must web-fetch the upstream list to confirm current state before dispatching W2 work.
- W1 agents must grep-verify all file-location claims and API-shape assumptions from the issue body before W2 scope takes shape. Pattern: issue claims "function X exported from module Y" → grep Y for the export; issue lists N callsites → grep the repo to verify only those N exist. Pre-dispatch verification catches mismatches (CLI-only vs importable, file renames, missing exports, SUT mis-attribution) before W2 wastes effort. Quote the exact grep pattern, file scope, and result count in the Discovery report.
- When Discovery grep-verifies that an issue AC is factually impossible or wrong (e.g., AC says "filter in file X" but grep proves file X has 0 references to the filter), the coordinator MUST surface the ambiguity via AUQ BEFORE Impl-Core dispatches against the wrong locus. The agent role is to report the contradiction with evidence; the coordinator decides how to proceed (adapt AC, reduce scope, ask user for clarification). Never let Impl agents silently resolve factual contradictions.
- A read-only premise-check wave (one grep per claim, cited with date + command) before the first edit can refute a meaningful fraction of issue premises outright (measured: 3 of 16 already held, needed no fix). Run it — it is cheaper than a single wasted fix.
- A census that returns a quantified, high false-positive rate for a proposed build (e.g. 47 of 48 candidates are legitimate once re-measured against the real denominator) is itself a complete deliverable. "Do not build this" backed by the measured rate closes the session item; it is not an incomplete result requiring a build anyway.
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
- When wiring automation or telemetry into an existing seam (e.g., post-tool-batch hook), grep for the WRITER of the trigger field across scripts/, skills/, and hooks/, not just the reader. A seam that is tested and read but never written is dormant — distinguish wired from live in your issue tracking.
- A plain `await import()` smoke-probe only exercises module top-level evaluation; a `ReferenceError` inside a hoisted exported function body (never called at import time) is invisible to it. Pair the probe with ESLint `no-undef` (static, analyses the function body) — this is the difference between catching the defect pre-commit and an 8-minute host-wide Bash/Edit lock, measured when a hook-imported module was saved mid-rename with an undefined identifier.
- Never leave a module imported by a live PreToolUse/PostToolUse hook in a stale intermediate state (e.g. mid-rename of a function or constant), even briefly. Every Edit/Write in the working copy re-triggers that hook's import; a `ReferenceError` there blocks Bash/Edit for every session sharing the working copy, not just the one editing it, and the only recovery channel available is one the hook itself doesn't block (e.g. the Monitor tool).
- A Node smoke-probe that passes its target module path as a positional `argv[1]` argument makes that module's OWN main-guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) evaluate true, executing `main()` as a side effect of merely importing the module for a probe. Pass the target via an environment variable instead so no main-guard can match argv.
- `console.log(...); process.exit()` can silently drop everything past the ~64 KiB kernel pipe buffer on a piped stdout (macOS) — harmless while an exit CODE alone carried the decision, but fatal once the decision moved into the stdout JSON body with exit 0: a truncated envelope parses as no-decision and the tool call is ALLOWED. Fix is two-part: clamp the payload to a measured worst case, AND write synchronously (`fs.writeSync(1)` with an EAGAIN retry loop) — clamping alone doesn't protect a caller that bypasses it, sync-write alone still ships oversized envelopes.
- In any guard that both computes a tamper/integrity hash AND performs an ownership/classification check, compute the hash FIRST. An early "not mine, skip" branch that runs before the hash calculation can suppress the very manipulation notice the hash exists to raise (e.g. a manifest rebound to a foreign session id was silently skipped instead of flagged).
- A comment-handling or ambiguous-terminator default must be judged by the CONSUMER's damage model, not by one global fail-open/fail-closed rule for "the file": a block PARSER must return lines unfiltered on an unterminated comment (nothing may vanish silently), while a bypass SCANNER checking the same file for an opt-in flag must treat the identical ambiguity as NOT-armed (an uncertain "is this commented out?" must never reactivate an opt-in guard-weakening switch).
- Deleting a dead-code cluster's reported ROOT can promote the modules it dragged into new roots outside the current sweep's scope. Size a dead-code sweep by the whole cluster (via the tool's `--list` output plus the drag chain), not by the reported roots alone, or budget a second wave for the newly-promoted roots.
- When `package.json` has no `exports` map, every deep-importable function under `scripts/lib/**` is effectively public API — changing its return shape (e.g. `string[]|null` → `{status, names}`) is a MAJOR change even inside a patch release. Ship a new additively-named function instead and keep the old signature as a thin wrapper.
- Never treat two absolute timing numbers (ms) captured at different moments as evidence of a regression — host load between measurements is not controlled. Run both versions (current + `git show HEAD:<file>`) in the same process, interleaved, under identical load, before calling a timing delta a regression.
<!-- END MANAGED: architecture-and-code-patterns -->

<!-- BEGIN MANAGED: ci-and-verification -->
## CI and verification

- CI status at session-start is authoritative. Never claim CI green from local `npm test` alone. Phase 4 CI banner is load-bearing.
- A top-level `process.exit()` during test file import crashes the vitest fork worker. Subsequent test files in the same fork lose their `vi.mock` registry — diagnostic signature is `ERR_MODULE_NOT_FOUND chunks/utils.*.js`. Guard CLI entry points with `if (import.meta.url === pathToFileURL(process.argv[1]).href)` before calling `main()`.
- Vitest 4 does not fix tinypool worker-exit hang on Linux CI; the timeout wrapper is still required for GitLab/GitHub Ubuntu runners.
- Integration tests with real fixtures often surface wiring drift that unit-mocks hide (e.g., module-A output shape differs from module-B input contract). Use integration tests to verify cross-module boundaries, not just to repeat unit-test scenarios with different dependencies.
- A platform-specific error property set only for real Node module resolution (e.g. Node 24's `err.url`, set for relative specifiers but not bare packages) must be pinned via a real `spawnSync(node, ...)` child process, never measured in-process under vitest — the vite-node runner does not reproduce the platform's own error shape and the assertion is vacuously green or red.
- Rewrite a test that pins a SKILL.md prose table or a numbered-list marker the moment that prose is retired in favour of "the code computes this" — a plain re-cite of the old text goes red on every subsequent prose rewrite. Assert the prose→code seam (the CLI/module is cited, no competing table survives) plus the code's own behaviour instead; delete pure list-marker pins.
- `grep` silently produces no output on a file it classifies as binary (e.g. a gate log containing ANSI control sequences) even when the pattern matches exactly once — indistinguishable from "not present". Always add `-a` when grepping tool/CI/gate logs, and treat an empty grep result on a log file as inconclusive until the file's text-ness is confirmed.
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
<!-- END MANAGED: incremental-epic-delivery --><!-- BEGIN MANAGED: crashed-session-recovery -->
## Crashed session recovery

- Re-verify the STATE.md mission premise against the issue tracker, PRDs, and actual code before resuming. Closed or unrelated references require regrounding the mission, not blindly continuing it.
- Locate the current harness's wave-scope artifact and verify its ownership. Compare its planned paths with modified and untracked files to distinguish the intended work from the remaining gap; a stale shared artifact is not proof of the current session's identity.
- Verify inherited work with relevant tests and an independent review before landing it. A green suite alone does not establish that an unreviewed security change is sound.
- After an interrupted or failed agent, inspect every changed file for leftover mutation branches, disabled checks, temporary aliases, and fixtures. Syntax checks and successful imports cannot detect a syntactically valid mutation such as `if (false && ...)`.
- Preserve resume watermarks only when their session identity matches. Never carry a prior session's completion state into a new session solely because the working-copy artifact is readable.
<!-- END MANAGED: crashed-session-recovery --><!-- BEGIN MANAGED: review-discipline-refutation-mandate -->
## Review discipline — the refutation mandate

- Dispatch review panels with an explicit instruction to REFUTE the coordinator's premises and the wave's own green gate, not merely to confirm them. Across three separate sessions this repeatedly surfaced real defects a green Full Gate, existing tests, and the author's own check all passed: a fail-open branch written to guard against fail-open, `argv[1]` triggering a probed module's own main-guard, a documented callback interface that never matched the real async call shape, and coordinator measurement errors (a chmod test recipe that discriminated nothing, a name-census counting the scanner's own denylist). A clean gate is never evidence that a refutation-mandated pass would find nothing.
- Budget for the expected residue: a panel run under this mandate against its own preceding wave typically returns 1 HIGH + several MEDIUM findings even at 0-failure Full Gate. A short fixpass (3-4 agents, ~20-30 min) is the normal cost of this pattern, not a plan-scope overrun.
- When a reviewer reports a finding, require it to cite the specific measurement (command + file scope), not just a claim — this is the same discipline that resolves disputed counts: most "wrong number" disputes turn out to be two correctly-measured but differently-scoped populations, not a measurement error.
- Two reviewers (or a reviewer and the coordinator) can both measure correctly and still contradict each other because they counted different POPULATIONS (the whole file vs. the extracted sub-block that actually runs, all matches vs. only the real writes among them). Resolve the conflict by naming both populations explicitly — never by recounting the same ambiguous scope a second time.
- A dispatched agent that partially refuses an instruction after MEASURING a genuine order-dependency (e.g. adding catalog entries that a downstream check would then flag as errors) is behaving correctly, not non-compliantly — grade a grounded partial refusal the same as a review panel's refutation.
- The coordinator's own ad-hoc counts (grep/wc/ls) are not exempt from this discipline: an unnamed grep that silently includes comment lines, or targets a different scope than the one under dispute, is the same defect class as an agent's ungrounded number — verify the coordinator's own claim before using it to override an agent's.
<!-- END MANAGED: review-discipline-refutation-mandate --><!-- BEGIN MANAGED: session-identity-and-lock-artifacts -->
## Session identity and lock artifacts

- A repo-global working-copy artifact (STATE.md's `session` field, `session.lock`, `current-session.json`) describes the WORKING COPY, not the reading or writing session — never union it with a process-local session-id witness (`CLAUDE_CODE_SESSION_ID`, a hook-payload `session_id`). Rank witnesses by strength instead: a weaker shared witness must never override, dilute, or be `some()`-merged with a stronger process-local one.
- Every NEW reader of a shared `.orchestrator`-style artifact needs its OWN explicit ownership check against the raw stdin/env identity — an ownership check written for the artifact's original caller does not automatically protect a later reader of the same file, and a repo has repeatedly added such readers unguarded.
- An ownership predicate is self-confirming and worthless if it compares a value against the fallback it was JUST assigned (`if (id === null) id = recordedId` then later `id === recordedId`); decide ownership from the RAW input before any fallback substitution runs.
- A dispatched subagent's `CLAUDE_CODE_SESSION_ID` is the RAW UUID of the coordinator that spawned it — a subagent never gets its own session id. Any mechanism needing "my own session id" (lock authorization, scope binding) must check a process-local match against that raw id, never assume a distinct subagent identity.
- An advisory-only signal (e.g. holding a lock file) is evidence of possible occupancy, never proof of non-liveness — add it as an ADDITIVE field for the consumer to weigh, never use it to FILTER results out of a discovery/registry layer (a filtering attempt once broke 9 pinned tests against a live, lock-less second session).
- The session-lock heartbeat is currently only renewed inside the wave loop. A session that spends longer than the lock TTL in session-start/session-plan (e.g. an overnight plan-AUQ) can have its lock reaped by an unrelated session's cleanup while still alive, silently producing an unbound wave-scope manifest. If a Deviation notes a lock reap while the session is demonstrably still running, re-`acquire()` the lock and re-merge scope before continuing.
<!-- END MANAGED: session-identity-and-lock-artifacts --><!-- BEGIN MANAGED: remote-dispatch -->
## Remote dispatch

- Give every concurrent `offload`/remote dispatch run its OWN job-id. Several parallel runs sharing one job-id write into the same log/output file; the later runs silently overwrite the earlier ones and the tool returns identical, plausible-looking short outputs instead of an error.
- A remote/offload account that has hit its usage-window limit returns a NORMAL CLI response (`result.is_error: true`, exit code 1) — indistinguishable from a genuine failure by exit code alone. Read the reset time out of the error message before treating it as a code bug and retrying blindly.
```
<!-- END MANAGED: remote-dispatch --><!-- BEGIN MANAGED: probe-and-measurement-boundaries -->
## Probe and measurement boundaries

- Match a probe's observation window to the effect it claims to measure. An import that resolves successfully can still be followed by an asynchronous process exit; use a child process and a bounded settling window, and verify a known-bad control before trusting the probe.
- Distinguish existence, successful reading, and completeness. A file being present does not mean it was consumed; skipped malformed records or missing archives must remain visible in the result. Unknown or unmeasured is not a measured zero.
- A checker of a construct's form does not prove the construct exists. Exercise both checks on the same missing-construct fixture when their coverage is complementary.
- Derive instruction-budget targets from the same canonical measurement the writer uses, including its treatment of frontmatter. Surface approaching capacity and the measured backlog before a writer refuses an approved addition; do not change the ceiling to avoid consolidation.
<!-- END MANAGED: probe-and-measurement-boundaries -->