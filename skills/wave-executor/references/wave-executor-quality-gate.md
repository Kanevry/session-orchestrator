# Wave Executor — Inter-Wave Quality-Gate (Auto-Fix Loop, #521)

> Reference of the wave-executor skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`, `wave-loop.md` → `../wave-loop.md`, `circuit-breaker.md` → `../circuit-breaker.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.
> Read after each wave completes, before proceeding to the next wave or session-end — see `../SKILL.md` § Inter-Wave Quality-Gate for the pointer.

## Inter-Wave Quality-Gate (with Auto-Fix Loop — #521)

After each wave, run the Quality-Gate. If `verification-auto-fix.enabled: true`
in Session Config, the gate uses `runQualityGateWithRetry()` from
`scripts/lib/quality-gate.mjs` which dispatches up to `max-retries` (default 2)
fixer-agent dispatches on failure.

**Quality-wave Full-Gate mandate (#724 C6):** the inter-wave gate following the **Quality wave** is ALWAYS the Full Gate (typecheck + test + lint) — never the cached Incremental short-circuit. The wave-executor threads the wave's `waveRole` into `shouldSkipIncremental` (see `wave-loop.md § Baseline cache check`); when `waveRole === 'Quality'` the cache is bypassed mechanically, so a valid cache or a narrow diff cannot downgrade the Quality-wave close-safety gate. See `skills/quality-gates/SKILL.md § Variant 3: Full Gate` — its dual consumers are session-end (Phase 2) and the Quality wave, and its Baseline-Cache invariant records that both are un-skippable.

### Invocation

```javascript
import { runQualityGateWithRetry } from '../../scripts/lib/quality-gate.mjs';

const result = await runQualityGateWithRetry({
  maxRetries: config['verification-auto-fix']?.['max-retries'] ?? 2,
  repoRoot: process.cwd(),
  dispatchFixer: async ({ failures, correctiveContext, changedFiles }) => {
    // Coordinator dispatches a code-implementer fixer subagent here with:
    //   - failures (gate + output)
    //   - correctiveContext (from .orchestrator/current-session.json)
    //   - changedFiles (since last green SHA)
    // Subagent's task: fix the failing gate, never broaden scope.
    await dispatchFixerSubagent({ failures, correctiveContext, changedFiles });
  },
});
```

### Decision flow

- `result.ok === true` → Wave green, proceed to next wave or session-end.
- `result.ok === false` → Hard abort.
  - quality-gate.mjs writes `.orchestrator/metrics/verification-failures/<ts>.json` (diagnostics bundle — automatic, redacted per `redactDiagnosticsBundle()`).
  - **Coordinator** (not fixer-subagent) appends a deviation entry to STATE.md via `appendDeviationOnDisk()` — see `wave-loop.md` § STATE.md Deviation — Auto-Fix Result.
  - Wave execution is blocked; operator must manually fix or disable auto-fix.
- `result.attempts > 1` → **Coordinator** logs a Deviation in STATE.md via `appendDeviationOnDisk()`: `auto-fix used N retries to clear Wave <wave>`.

### Skip Conditions

- `verification-auto-fix.enabled: false` (default) → fall back to single-shot
  quality-gate, abort on first failure (current behavior preserved per PRD § 3
  Gherkin negative path).
- `verification-auto-fix.max-retries: 0` → equivalent to disabled.

### Anti-pattern (BE-012 awareness)

The fixer-agent prompt MUST include a reminder of `.claude/rules/testing.md` § "Test Quality — False-Positive Prevention"
"test-the-mock" anti-pattern. A fix that makes tests green by mocking out the
real failure is a regression vector. The fixer prompt should explicitly say:
"Do NOT change test mocks to make tests pass. Fix the actual code defect."

### Heartbeat cadence at inter-wave checkpoints (#590-3)

After each quality-gate PASS, the coordinator refreshes the session-lock heartbeat via the post-wave STATE.md step. See `wave-loop.md § 3a. Post-Wave: Update STATE.md` — step 5 contains the `updateHeartbeat` instruction and best-effort framing. The `sessionId` passed to `updateHeartbeat` is the session identifier established by session-start Phase 1.2 `acquire()` and stored in `.orchestrator/session.lock` (its `session_id` field); it matches the STATE.md frontmatter `session:` field written during Pre-Wave 1b initialization.

