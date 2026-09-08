# Phase 3: Documentation Updates

> Sub-file of the session-end skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-end/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 3: Documentation Updates

> **Final heartbeat (#590-3)** — at Phase 3 entry, refresh the session-lock heartbeat BEFORE the multi-minute close-out chain (vault-mirror, dialectic, durable-commit, metrics). A long-idle deep session may not have had PostToolBatch activity for >4h; without a refresh the 4h-TTL lock would lapse mid-close and appear stale to a concurrent session. Place this call BEFORE Phase 3.8 Session Lock Release (which deletes the lock — refreshing a deleted lock is a no-op). Best-effort: a failure must NOT block the close.
>
> ```js
> // Final heartbeat (#590-3) — refresh before the multi-minute close-out (vault-mirror, dialectic, durable-commit)
> // so a long-idle deep session's 4h-TTL lock does not lapse mid-close.
> // BEFORE Phase 3.8 lock-release (which deletes the lock).
> import { updateHeartbeat } from 'scripts/lib/session-lock.mjs';
> updateHeartbeat({ sessionId, repoRoot: process.cwd() });
> ```
>
> Skip silently if `persistence: false` in Session Config (no session.lock exists in that mode).

### 3.0 Defensive Cleanup

Delete `<state-dir>/wave-scope.json` if it still exists:

```bash
rm -f <state-dir>/wave-scope.json
```

This should have been cleaned up by wave-executor after the final wave, but crashed sessions or interrupted executions may leave it behind. A stale scope manifest from a previous session could incorrectly restrict the next session's enforcement hooks.

### 3.1 SSOT Files
- Update `STATUS.md` / `STATE.md` if they exist (metrics, dates, status)
- Update `CLAUDE.md` (or `AGENTS.md` on Codex CLI) if patterns or conventions changed during this session
- Check `<state-dir>/rules/` — if a new pattern was established, suggest a new rule file

### 3.2 Docs Verification (docs-orchestrator integration)

> Skip this subsection if `docs-orchestrator.enabled` config is not `true` (default: `false`). Also skip entirely if `docs-orchestrator.mode` is `off`.

Reads `docs-tasks` from STATE.md frontmatter (written by wave-executor Pre-Wave 1b), computes `CHANGED_FILES` via `git diff --name-only "$SESSION_START_REF..HEAD"`, and runs a per-task verification loop (outcome: `ok`/`partial`/`gap`). In `warn` mode logs results non-blocking; in `strict` mode blocks on any gap and presents an AskUserQuestion override prompt. Emits a `### Documentation Coverage (docs-orchestrator)` block for inclusion in the Phase 6 Final Report.

**See `phase-3-2-docs-verification.md` for full details.**

### 3.2a Session Handover (for significant sessions)
If this session made substantial changes, create or update:
- `<state-dir>/session-handover/` doc with: tasks completed, resume point, metrics changed, issues opened/closed
- Or update `<state-dir>/STATE.md` with session digest

### 3.3 Claude Rules Freshness
Review `<state-dir>/rules/` files that are relevant to this session's work:
- Are the rules still accurate after this session's changes?
- Should any rule be updated with new patterns?
- Should a new path-scoped rule be created?
- Suggest changes but DO NOT modify without user confirmation

### 3.4 Update STATE.md

> **Ownership Reference:** See `skills/_shared/state-ownership.md`. session-end is authorized to set `status: completed` plus the optional `updated` timestamp (#184), and — as of Phase A of Epic #271 — the 5 Recommendation fields written by Phase 3.7a. No other fields.

> **Runtime Ordering Note (Epic #271 Phase A):** Phase 3.4's `status: completed` write executes LAST in Phase 3, AFTER Phase 3.7 (sessions.jsonl) and Phase 3.7a (Compute and Write Recommendations). The ordinal position here (3.4) is kept for historical compatibility; the canonical runtime order is `3.1 → 3.2 → 3.3 → 3.4a → 3.5 → 3.5a → 3.6 → 3.6.3 → 3.6.4 → 3.6.5 → 3.6.6 → 3.6.7 → 3.6.8 → 3.7 → 3.45 → 3.7a → 3.7b → 3.7c → 3.7d → 3.4` (3.6.3/3.6.4/3.6.6 were missing from this note pre-#724; the Tail-Diät skip-plan dispatcher now dispatches the full six-phase tail mechanically, so the note is corrected to list all six). Rationale: Phase 3.7a reads in-memory session metrics and writes the 5 Recommendation fields via `updateFrontmatterFields`; that write must complete BEFORE the STATE.md frontmatter is finalized with `status: completed` so the Recommendation fields are visible to the next session-start while STATE.md is still `status: active`. Crash-resilience: if `/close` aborts between 3.7a and 3.4, STATE.md carries `status: active` + Recommendations; session-start Phase 1.5 offers resume (and the banner renders). If the reverse ordering were used (status: completed first), a crash would leave `status: completed` without Recommendations — the Reader would silently no-op the banner, losing the handoff. Phase 3.45 (Telemetry Flush, #844) sits AFTER Phase 3.7 because it drains the send-queue with the just-written `sessions.jsonl` record already included, and BEFORE Phase 3.7a because it is a fire-and-forget side-effect with no dependency on the Recommendation-write ordering below it. Phase 3.7d (Session-Eval, #803) sits AFTER Phase 3.7 because it scores the `sessions.jsonl` record that phase just wrote — the record must exist first — and BEFORE Phase 3.4 because its `eval.jsonl` output is advisory and must never block the close.

> Gate: Only run if `persistence` is enabled in Session Config and `<state-dir>/STATE.md` exists.
1. Set frontmatter `status: completed`
2. Record final wave count and completion time in the frontmatter
3. Touch `updated: <ISO 8601 UTC>` in the frontmatter (issue #184). Use `scripts/lib/state-md.mjs` → `touchUpdatedField` for safety:
   ```bash
   node --input-type=module -e "
   import {readFileSync, writeFileSync} from 'node:fs';
   import {touchUpdatedField} from '${PLUGIN_ROOT}/scripts/lib/state-md.mjs';
   const p = '<state-dir>/STATE.md';
   writeFileSync(p, touchUpdatedField(readFileSync(p, 'utf8'), new Date().toISOString()));
   "
   ```
   Silent no-op if the file has no frontmatter.
4. Keep the file as a record — do NOT delete it (next session-start reads it)

If STATE.md doesn't exist, skip this subsection.

### 3.4a Coordinator Snapshot Cleanup (#196)

Pre-dispatch snapshots (`refs/so-snapshots/<sessionId>/wave-*`) are created by wave-executor before each wave dispatch so that session-start can offer recovery if a session is interrupted mid-wave. On a clean close those snapshots are no longer needed and should be deleted. In addition, orphaned refs from older sessions that were never cleaned up (e.g. after a hard crash) are garbage-collected using an age-based policy (14 days).

> Gate: Only run if `persistence` is `true` in Session Config. Skip entirely when persistence is off (snapshots are never written in that mode).

```bash
node --input-type=module -e "
import { listSnapshots, deleteSnapshot, gcSnapshots } from '${PLUGIN_ROOT}/scripts/lib/coordinator-snapshot.mjs';

// Step A: delete this session's snapshots (clean close → we don't need them)
const mine = await listSnapshots({ sessionId: '${SESSION_ID}' });
for (const s of mine) {
  const r = await deleteSnapshot({ refName: s.ref });
  if (!r.ok) console.error('snapshot cleanup:', r.error);
}

// Step B: GC orphans older than 14 days (non-fatal)
const gc = await gcSnapshots({ olderThanDays: 14 });
console.log(\`snapshot cleanup: deleted \${mine.length} from this session + \${gc.deletedCount} expired orphans (scanned \${gc.scanned}).\`);
"
```

Failures in either step are logged to stderr but do **not** block session close — a missed cleanup is self-healing via the 14-day GC on the next session.

This cleanup is the counterpart to the session-start Phase 1.5 recovery prompt: once a session closes cleanly, future sessions must not be offered recovery for its snapshots.

### 3.45: Telemetry Flush (advisory, #844)

> Skip silently when `persistence: false` in Session Config. There is **no dedicated config key** for this phase — the send-gate is `resolveConsent()` inside `sync.mjs` itself (fail-closed: a `disabled` / `no-consent` / headless posture makes `flush()` a no-op in <5ms, sending nothing). This phase runs late in the close, after Phase 3.7 has written `sessions.jsonl`, so any session-summary event enqueued at metrics-write time is included in the drain; the ordinal position `3.45` is kept for readability (mirrors the Phase 3.4 Runtime Ordering Note idiom of ordinal ≠ runtime order).

Drain the host-local telemetry send-queue once, fire-and-forget. The flush is **advisory** — the close must never fail, stall, or surface an error because of telemetry:

```javascript
import { flush } from '${PLUGIN_ROOT}/scripts/lib/telemetry/sync.mjs';

// Fire-and-forget. flush() is contractually never-throw + internally gated (resolveConsent)
// + 3s-timeout-bounded; the try/catch is defense-in-depth, never a real failure path.
try { await flush(); } catch { /* nie blockierend — der Close darf durch Telemetrie nie scheitern */ }
```

**Semantics.** `flush()` is fire-and-forget with an internal ~3s timeout. When the ingest endpoint is unreachable (offline), events stay in the bounded host-local queue (oldest-dropped on overflow) and are retried on a later close — nothing is lost or blocked. A one-line result MAY be surfaced in the Phase 6 close summary (`Telemetry: sent` / `queued` / `gated`), but a failure NEVER renders an error banner: under no circumstances may telemetry make `/close` fail or take materially longer than ~3s. The gate lives in the module (fail-closed via `resolveConsent`), so this phase carries no config-key check of its own beyond the `persistence: false` skip above.

Cross-reference: GitLab #844 (Epic #841); `docs/telemetry.md`; flush API in `scripts/lib/telemetry/sync.mjs` (`flush` — fire-and-forget, gated, never-throw).

Historical design: archived PRD `docs/prd/2026-07-20-anonymous-usage-telemetry.md` FA3. <!-- path-check: historical -->

### 3.5 Session Memory

> Gate: Only run if `persistence` is enabled in Session Config AND platform is Claude Code (session memory at `~/.claude/projects/` is Claude Code-only). Learnings (Phase 3.5a) and metrics (Phase 3.7) still write to `.orchestrator/metrics/` on all platforms.

1. Create `~/.claude/projects/<project>/memory/session-<YYYY-MM-DD>.md` with:
   - Frontmatter: `name`, `description` (1-line summary), `type: project`
   - `## Outcomes` — per-issue status (completed / partial / not started) with evidence
   - `## Learnings` — patterns discovered, architectural insights, gotchas
   - `## Next Session` — priority recommendations, suggested session type, blockers
2. Update `~/.claude/projects/<project>/memory/MEMORY.md`:
   - Under a `## Sessions` heading (create if missing), add:
     `- [Session <date>](session-<date>.md) — <one-line summary>`

### 3.5a Learning Extraction + 3.6 Memory Cleanup & Learnings Write

Read `skills/session-end/learning-patterns.md` for extraction heuristics, confidence updates, passive decay, and JSONL write procedure.

### Phase 3.6.x Tail — Mechanical Skip-Plan (#724)

> The Phase 3.6.x tail (3.6.3 Memory-Proposals, 3.6.4 Expired-Sweep, 3.6.5 Auto-Dream, 3.6.6 Skill-Judge, 3.6.7 Auto-Dialectic, 3.6.8 Reconcile) is the historical close-out abort-attractor: six phases that in the overwhelming majority of sessions do nothing (no proposals queued, nothing expired, under cadence, judge off, reconcile off). Each already ships a mechanical fast-path in its own lib. This dispatcher computes — side-effect-free — WHICH of the six actually need to run, so you load ONLY the detail procedure for the `run: true` phases and emit a one-line skip report for the rest.

Run the aggregator ONCE. Config gates short-circuit FIRST (no disk touch); the input-detection helpers run only when the config gate passed. It NEVER throws — a per-phase probe error fail-opens to `run: true` (run the phase rather than silently lose it):

```javascript
import { planTailPhases } from '${PLUGIN_ROOT}/scripts/lib/session-end/phase-skip.mjs';

const { plan, skippedReport } = await planTailPhases({
  repoRoot: process.cwd(),
  config,        // parsed Session Config (from $CONFIG)
  sessionId,     // physical session.lock `session_id` only (or null), never STATE.md `session`
  platform,      // 'claude' | 'codex' | 'cursor'
});
// plan: Array<{ phase, run, reason, inputSource }>, already in ascending phase order.
```

Then:

1. **For every entry with `run: true`** — load its detail procedure from [`phase-3-6-tail.md`](../phase-3-6-tail.md) (the phase headings there match the `phase` id) and execute it exactly as written. The aggregator only DECIDES; the sub-file holds the full unabridged procedure.
2. **For every entry with `run: false`** — do nothing for that phase; its `reason` is already captured for the report.
3. **Execute `run: true` phases in ascending phase order** (3.6.3 → 3.6.4 → 3.6.5 → 3.6.6 → 3.6.7 → 3.6.8), matching the Phase 3.4 Runtime Ordering Note. The returned `plan` is already in that order.
4. **Emit `skippedReport`** as a single line in the Phase 6 Final Report (under the Learnings/metrics block), e.g. `Tail-Diät: 3.6.3 skipped (proposals empty) · 3.6.5 skipped (under-threshold) · 3.6.7 RUN (2 new sessions) · …`.

**Full detail procedures:** [`phase-3-6-tail.md`](../phase-3-6-tail.md).

### 3.7 Write Session Metrics

Read `skills/session-end/session-metrics-write.md` for JSONL append, vault-mirror invocation, and behavior matrix.

> **Token Rollup (#644):** Before emitting the JSONL record (step 2 of session-metrics-write.md), step 1a calls `rollupSessionTokens({ parentSessionId })` from `scripts/lib/session-token-rollup.mjs` and merges three optional fields onto the in-memory record: `total_token_input`, `total_token_output`, and `subagents_with_tokens` (coverage count). Null totals mean "no token data captured" — not zero cost. The rollup is non-blocking: a missing `subagents.jsonl` or all-null session still writes cleanly with null/0 values.

### 3.7a Compute and Write Recommendations (Epic #271 Phase A)

> Gate: Only run if `persistence` is `true` in Session Config AND `<state-dir>/STATE.md` exists. Skip silently otherwise.

> **Ownership Reference:** See `skills/_shared/state-ownership.md`. session-end is the ONLY writer of the 5 Recommendation fields (`recommended-mode`, `top-priorities`, `carryover-ratio`, `completion-rate`, `rationale`). No other skill may write these keys.

> **Ordering:** Runs AFTER Phase 3.7 (sessions.jsonl is just-written — reads in-memory session metrics, NOT JSONL) and BEFORE Phase 3.4 `status: completed` setting. See the Phase 3.4 Runtime Ordering Note for rationale.

Calls `computeV0Recommendation({completionRate, carryoverRatio, carryoverIssues})` from in-memory session metrics and writes 5 fields to STATE.md frontmatter via `updateFrontmatterFields`. Inputs MUST come from in-memory metrics, NOT re-read from `sessions.jsonl`. On any exception writes `recommendation-compute-failed` to `sweep.log` and does NOT block Phase 3.4.

**See `phase-3-7a-recommendations.md` for full details.**

### 3.7b Durable-Commit Session Telemetry (#490 AC2)

> Gate: Always runs when persistence is enabled. Local execution is a no-op (`enabled: false`).

> **Ordering:** Runs AFTER Phase 3.7a (Recommendations written to STATE.md) and BEFORE Phase 3.4 (`status: completed`). See the Phase 3.4 Runtime Ordering Note canonical order.

Wraps the already-completed Phase 3.7 + 3.7a writes with `withDurableCommit` (from `scripts/lib/autopilot/durable-telemetry.mjs`) for the two session-end-owned files: `.orchestrator/metrics/sessions.jsonl` and `<state-dir>/STATE.md`. `enabled: false` keeps local closes a no-op (`{ok: true, skipped: true}`); the flag flips `true` only in cloud Routines execution so telemetry survives ephemeral-clone reclamation. `autopilot.jsonl` is NOT in scope here — `scripts/lib/autopilot/loop.mjs` owns its commit (#490 Wave-2).

**See `phase-3-7a-recommendations.md` § Phase 3.7b for the full `withDurableCommit` invocation.**

### Phase 3.7c: Vault Board → Closed (#674)

> Gate: Skip silently when `vault-integration.enabled` is not `true` in Session Config (the underlying helper also self-no-ops, so this is defense-in-depth, not the sole gate).

> **Ordering:** Runs AFTER Phase 3.7b (durable-commit) and BEFORE Phase 3.7d (Session-Eval, #803), Phase 3.4 (`status: completed`) and Phase 3.8 (Session Lock Release). See the Phase 3.4 Runtime Ordering Note canonical order. Running before lock-release is deliberate — the session-lock lease still exists when the board is finalized, so the board's `in-progress → closed` transition is derived against a live lock rather than a phantom one. This mirrors the #490 durableCommit ordering discipline: persist/finalize the cross-repo status while the lease is still held, then release.

Transition THIS repo's live-status board row to `closed` so a cross-repo observer sees the session has ended. Invoke `mirrorBoard` from `scripts/lib/vault-status/board-writer.mjs` with an explicit `closed` status for the current repo:

```javascript
import { mirrorBoard } from 'scripts/lib/vault-status/board-writer.mjs';

const boardResult = await mirrorBoard({
  repoRoot: process.cwd(),
  explicitStatus: 'closed',        // force THIS repo's row to `closed`
});
// boardResult.action ∈ { 'written', 'skipped-noop', 'skipped-handwritten', 'skipped-vault-disabled', 'dry-run' }
```

> **Note (single-repo close path):** with `repos` omitted, `mirrorBoard` builds the repo descriptor itself as `[{ repoRoot, status: explicitStatus }]` — this is the supported single-repo shape, so `explicitStatus: 'closed'` lands on THIS repo's row. (When a caller DOES pass `repos`, each element must be a `{ repoRoot, repoName?, status? }` object, NOT a bare path string — bare strings are silently skipped by `collectRows`.) The board at `<vault-dir>/01-projects/_active-sessions.md` is generator-owned: `mirrorBoard` refuses to touch any file lacking the `session-orchestrator-active-sessions@1` marker, hard-refuses `_overview.md`, and is idempotent (a re-run after the row is already `closed` returns `skipped-noop`). Rows for repos NOT in this update are preserved verbatim by the idempotent merge.

**Non-blocking:** a `mirrorBoard` failure (any non-`written`/`skipped-*` outcome, thrown error, or unreachable vault) MUST NOT block the close. Log a single `WARNING: vault board → closed failed — <reason>; continuing close` line and proceed to Phase 3.4 / 3.8. The board is an observability convenience, not a close-out invariant.

### Phase 3.7d: Session-Eval (opt-in — #803)

> Gate: Run ONLY when Session Config has `eval.enabled: true` AND `eval.mode` is not `off` (the `eval:` block is parsed by `scripts/lib/config/eval.mjs`; defaults are `enabled:false / mode:warn / judge:off / report:html / handle:null`). With no `eval:` block at all, skip silently — zero overhead and byte-identical close behaviour to a repo that never adopted eval (FA6 Gherkin 2).

> **Ordering:** Runs AFTER Phase 3.7 (sessions.jsonl) and Phase 3.7c (vault board) and BEFORE Phase 3.4 (`status: completed`) and Phase 4 (commit). The position AFTER Phase 3.7 is load-bearing: the eval scores the session record that Phase 3.7 just appended to `sessions.jsonl`, so that record MUST already exist. The position BEFORE Phase 3.4 keeps the resulting `eval.jsonl` record inside the same session commit — but the record is purely advisory, so a failure here NEVER blocks the close. See the Phase 3.4 Runtime Ordering Note canonical order.

Evaluate the just-closed session deterministically and, when configured, with an advisory LLM judge. This phase is a thin hook — the full evaluation flow lives in `skills/eval/SKILL.md`; only the close-out integration is described here.

1. **Deterministic run.** Invoke `node scripts/eval-session.mjs --json` — with no `--session`, the cascade (`resolveSession`, revised #822) walks records newest-to-oldest (source order) and evaluates the first one that is either `status:'completed'` or non-abandoned with evidence of completed work (typically the record Phase 3.7 just appended). Model capture: the coordinator passes `--model-id <id> --model-source self-report`; the `$ANTHROPIC_MODEL` env var wins automatically when set. Pass the configured pseudonym through with `--handle <eval.handle>` (omit when `null`). The CLI appends the eval record to `.orchestrator/metrics/eval.jsonl` (`appendEvalRecord` is never-throw).
2. **Advisory judge (opt-in).** When `eval.judge` is not `off`, run the judge flow per `skills/eval/SKILL.md` § Phase 3: the coordinator dispatches the read-only `eval-judge` agent (DI'd dispatch, untrusted-data nonce fence), merges the advisory judge dimensions (`method: "judge"`, `advisory: true`, `calibration_status: "uncalibrated"`) into the record, and appends the merged record. When `eval.judge: off`, no agent is dispatched and no judge dimensions are produced.
3. **HTML report (opt-in).** When `eval.report: html` (the default), call `writeEvalReport(record, …)` from `scripts/lib/eval/report.mjs` to emit the self-contained run report under `.orchestrator/eval/reports/<run-id>.html` (gitignored, regenerable from the record). When `eval.report: none`, skip the report.

**Advisory — never blocks the close (FA6):** an eval failure — a non-zero `eval-session.mjs` exit, a judge-dispatch error, or a report-write error — MUST NOT abort `/close`. Under `mode: warn`, log a single `WARNING: session-eval failed — <reason>; continuing close` line to stderr and proceed to Phase 3.8 / Phase 4. There is NO exit-code gate on this phase. See `skills/eval/SKILL.md` for the full deterministic-engine + judge + report detail flow.

