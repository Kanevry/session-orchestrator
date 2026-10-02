# STATE.md Ownership Contract

> Defines who can read and write `<state-dir>/STATE.md` and under what conditions.
> Referenced by: wave-executor, session-end, session-start, evolve.

## Schema

```yaml
---
schema-version: 1
session-type: feature|deep|housekeeping|none
branch: <current branch>
issues: [<issue numbers>]
started_at: <ISO 8601 with timezone>
status: active|paused|completed|idle
current-wave: <N>
total-waves: <N>
# Optional fields (schema-version 1, additive for backward-compat):
updated: <ISO 8601 UTC>      # last write timestamp, touched by any writer
session: <session-label>     # attribution/history label; normally semantic since #573, legacy UUID-v4 remains readable; never a lock/registry ownership key
session-id: <raw id>         # the RAW/native harness session id from session.lock (#1368); omit when absent; never a lock/registry ownership key
session-start-ref: <sha>     # git ref at session start
---
```

### Required vs. optional fields

- `schema-version`, `session-type`, `branch`, `issues`, `started_at`, `status`, `current-wave`, `total-waves` — **required** in every session-owned STATE.md.
- `session-id` — **optional**, additive under `schema-version: 1` (#1368). The RAW/native harness session id, taken from `.orchestrator/session.lock` via `resolveSessionIds()` (`scripts/lib/state-md.mjs`). Writers OMIT the key when the lock yields none; readers MUST tolerate its absence. It exists so `/close`'s #429 pre-check can join STATE.md to sessions.jsonl on a NATIVE identity (`findRecordedSession`'s UUID fast path) instead of falling through to the semantic label. Like `session`, it grants no lock or registry ownership.
- `started_at` is SOURCED from the same lock (`resolveSessionStartedAt()`), never from the writer's clock — see `skills/wave-executor/references/wave-executor-state-init.md` § Pre-Wave 1b for the template and the 48-minute drift that motivated it (#1368). On the READ side `started_at` is a CORROBORATING signal, never an identity key: `findRecordedSession()` (`scripts/lib/session-close-backfill.mjs`) joins STATE.md to `sessions.jsonl` on the native `session-id` FIRST and never consults `started_at` on that path — only the legacy-LABEL path compares the two timestamps, and it tolerates up to `STARTED_AT_DRIFT_TOLERANCE_MS` = **6 h** of drift (`session-close-backfill.mjs:559`, the single definition) before vetoing a label match: wider than any plausible write-lag (the 48 minutes above), narrower than the day the label's own date component already distinguishes.
- `updated`, `session`, `session-start-ref` — **optional**. Added by #184. STATE.md files without these fields remain valid and should be treated as `updated: null` / `session: null`. Writers SHOULD populate these fields but readers MUST tolerate their absence. `session` is an attribution/history label, normally `<branch>-<YYYY-MM-DD>-<mode>-<n>` since #573 (Epic #568 Parallel-Aware Sessions P2.2); pre-#573 files may contain a UUID-v4 — both formats are read via `parseSessionId()` from `scripts/lib/session-id.mjs` per PRD §3 P2 row 3 (backward-compat). Neither form grants lock or registry ownership.

The `session-type: none` + `status: idle` combination is used only for bootstrap-scaffolded placeholder files (no active session).

### Body Sections

| Section | Purpose | Updated by |
|---------|---------|------------|
| `## Current Wave` | Next wave to execute | wave-executor (post-wave) |
| `## Wave History` | Completed wave records | wave-executor (post-wave) |
| `## Deviations` | Plan adaptation log | wave-executor (step 3) |
| `## What Not To Retry` | Failed/abandoned approaches not to repeat (#623) | session-end (Phase 1.6) |
| `## Open Questions` | Unresolved user-facing questions (agent → gate → next session) | wave-executor (inter-wave) + session-end (marks answered) |

Wave History lines MAY include a `→ issue #NNN` suffix (or `→ existing #NNN` when a duplicate was detected) for SPIRAL/FAILED agents, linking to the auto-created carryover issue (#261). This is optional and backward-compatible; readers that do not recognize the notation can skip it. Session-end Phase 1.6 uses the presence of this suffix to decide whether to retro-file a carryover as a fallback safety net.

### `## What Not To Retry` (cross-session continuity slot, #623)

A log of failed or abandoned approaches that future sessions should NOT re-attempt. Each entry has the shape `{approach, why_failed, session_id, date}` and renders as:

```markdown
## What Not To Retry

- **<approach>** (<session_id>, <date>)
  - why: <SPIRAL|FAILED> — <one-line context> (evidence: <file:line or path>)
```

`why_failed` MUST cite at least one concrete file (and line, if applicable) that grounds the failure — a bare narrative reason without a file reference is not acceptable.

- **Writer:** session-end Phase 1.6 — for every SPIRAL/FAILED agent it appends one entry via `appendWhatNotToRetryOnDisk(repoRoot, entry)`; the coordinator MAY also add a free-text entry through the same helper.
- **Reader:** session-start Phase 6.5.1 — surfaces the section as a forced-read block wrapped in the HISTORICAL guard banner (`scripts/lib/historical-guard.mjs`). It is a READER only and never mutates the slot.
- **Cap:** at most `MAX_WHAT_NOT_TO_RETRY` (10) entries, pruned FIFO (oldest dropped) on each append — a simple last-N trim, NOT a per-entry success-clear.
- **Idle-Reset preservation (load-bearing):** **`## What Not To Retry` SURVIVES the completed-branch Idle Reset** — unlike per-session `## Deviations` (which is emptied) and `## Wave History` (which is demoted into `## Previous Session`). It is a cross-session continuity record, so session-start's Idle Reset MUST NOT clear, demote, or drop it.

Helpers: `appendWhatNotToRetry` (pure), `readWhatNotToRetry` (pure), `appendWhatNotToRetryOnDisk` (lock-guarded write) — all exported from `scripts/lib/state-md.mjs`.

### `## Open Questions` (Close Handover-Alignment-Gate, PRD 2026-07-07)

A log of unresolved, user-facing questions surfaced by wave agents during a session, collected at inter-wave checkpoints, and (optionally) marked answered by session-end or a later Handover-Alignment-Gate run. Each entry has the shape `{question, source, priority, answered, answer?}` and renders as:

```markdown
## Open Questions

- [ ] <question> (source: <source>, prio: <high|medium|low>)
- [x] <question> (source: <source>, prio: <p>) → Antwort: <answer>
```

- **Writer:** wave-executor — at each inter-wave checkpoint, collects deduped `OPEN-QUESTIONS:` lines from the wave's agent reports and appends one entry per question via `appendOpenQuestionOnDisk(repoRoot, entry)`. session-end MAY flip an entry to answered via `markOpenQuestionAnsweredOnDisk(repoRoot, question, answer)` when the gate resolves it during close.
- **Reader:** the Handover-Alignment-Gate (session-end / session-start) reads unanswered entries via `readOpenQuestions` to decide what to surface to the operator across the session boundary.
- **Cap:** at most `MAX_OPEN_QUESTIONS_STORED` (20) entries, pruned FIFO (oldest dropped) on each append — a storage cap, distinct from the gate's own `max-open-questions` config (which caps how many questions are ASKED per gate run, not how many are stored).
- **Idle-Reset preservation (load-bearing):** **`## Open Questions` SURVIVES the completed-branch Idle Reset** — unlike per-session `## Deviations` (which is emptied) and `## Wave History` (which is demoted into `## Previous Session`). Unanswered questions are exactly the ones that need to reach the NEXT session's operator, so session-start's Idle Reset MUST NOT clear, demote, or drop it — mirroring `## What Not To Retry` above (#623).

Helpers: `readOpenQuestions` (pure), `appendOpenQuestion` (pure), `markOpenQuestionAnswered` (pure), `appendOpenQuestionOnDisk` (lock-guarded write), `markOpenQuestionAnsweredOnDisk` (lock-guarded write) — all exported from `scripts/lib/state-md.mjs`.

## Session Identity and Lock Ownership (#1085)

This contract distinguishes a physical live-session key from labels that make a
session intelligible to people and history readers. It does not add an identity
layer.

- **`session_id` is the only live ownership key.** It is the native raw identity
  supplied by the active harness, or a generated UUID when no trustworthy raw
  identity is available. Lock acquisition, registry membership, self-exclusion,
  proof checks, and lock release use this physical key.
- **`semantic_session_id` and STATE.md `session` are attribution/history
  labels, never ownership.** They may describe the same work to a human, but
  equality of either label cannot acquire, refresh, release, or reclaim a lock.
  A legacy UUID in STATE.md remains readable only as historical data.
- **Never bridge a raw mismatch with a label or a proof.** If the current raw
  id and a live lock's raw id differ, ownership is ambiguous. Leave the live
  lock visible and let its TTL/Reaper lifecycle resolve it; do not substitute a
  semantic match, STATE.md `session` match, or owner-proof match.
- **There is no `logical_session_id`.** A true cross-harness restart-continuity
  contract requires a trusted native resume identifier and remains a follow-up.
  In particular, a host rotation that changes both raw and semantic values has
  no guaranteed continuity.
- **Registry `role` (`'navigator'`) is display, never ownership.** The
  authoritative claim is the navigator lease (`leases/navigator.json` under
  `~/.config/navigator/`, see `skills/_shared/fleet-protocol.md`); `registerSelf()`
  does not carry the field across a repeated SessionStart, so a navigator
  (operated outside this plugin) has to re-set it on every round via
  `heartbeat(id, { role })` (#1462).

The peer-discovery and issue-budget procedures below apply these rules at their
narrow surfaces; neither creates a second ownership model.

## CCU-009 — Status = Index, Never History (#730/H6)

> Adopted from an external-repo fleet-mining finding (2026-07-02): narrative
> status content accreting into a project's primary instruction file, never
> routed to a durable history channel.

**The convention:** any status-bearing document — STATE.md, a CLAUDE.md
"Current State" section, a dashboard file — MUST hold only the CURRENT
(and optionally the immediately-PRIOR) state, never an append-only narrative
log. This is not new here: `## Wave History` demotion to `## Previous Session`
on Idle-Reset, the preserved single-slot `## What Not To Retry`, and session
memory files already implement the split — CCU-009 is the explicit NAME of
the pattern so it can be checked for, not just followed by convention.

**Where narrative belongs instead (durable-history channels):**
`.orchestrator/metrics/sessions.jsonl` (per-session record), session memory
(`~/.claude/projects/<project>/memory/`), and vault-mirror `50-sessions/`
notes. A CLAUDE.md "Current State" or STATE.md free-text block that keeps
growing across sessions is the CCU-009 anti-pattern.

## Ownership Model

| Skill | Access | Operations |
|-------|--------|------------|
| **wave-executor** | Read + Write (owner) | Creates STATE.md (Pre-Wave 1b), updates after each wave (current-wave, Wave History, Deviations); appends deduped `## Open Questions` at inter-wave checkpoints via `appendOpenQuestionOnDisk` (see `wave-loop.md` § 3e + Post-Wave step 6). |
| **session-end** | Read + Status-only write | Reads for metrics extraction (Phase 1.7), sets `status: completed` (Phase 3.4). Exception: only fields modified are `status` in frontmatter and marking entries answered in `## Open Questions` via `markOpenQuestionAnsweredOnDisk` (Close Handover-Alignment-Gate). |
| **session-start** | Read + conditional reset | Reads for continuity checks (Phase 1.5): inspects `status` field to detect crashed/paused sessions. Surfaces `## What Not To Retry` as a forced-read HISTORICAL block (Phase 6.5.1). May reset STATE.md to idle at the boundary between a completed session and a new session — only when prior `status: completed`. The reset clears `current-wave` (→ 0), sets `status: idle`, demotes `## Wave History` into `## Previous Session`, and empties `## Deviations` — but PRESERVES `## What Not To Retry` (cross-session continuity, #623) and `## Open Questions` (Close Handover-Alignment-Gate, PRD 2026-07-07). Never resets on `active` or `paused` (those paths are user-interactive). |
| **evolve** | Read-only | Reads `## Deviations` section for deviation pattern extraction (Step 2.2, pattern 5) |

### Shared-File Single-Writer Rule (`isolation: none` waves)

The Ownership Model above resolves *STATE.md* specifically, but the same discipline generalizes to any file more than one dispatched agent could plausibly need to touch inside a single `isolation: none` wave (STATE.md, CLAUDE.md / AGENTS.md — the Codex CLI alias, central Session Config, other cross-cutting configs). Such a file MUST NEVER be given two writers in the same wave — the wave plan picks exactly one of:

- **Designated single-writer agent** — one agent in the wave owns the file in its declared file-scope; every other agent that would otherwise touch it is scoped away from it and reports its intended change (if any) back to the coordinator instead of editing directly.
- **Coordinator-direct defer** — no agent in the wave touches the file at all; the coordinator applies the accumulated edits itself at the inter-wave checkpoint, after all agents report.

This is the wave-plan-time analog of PSA-007 (subagents never race the shared git index) applied one layer up, to shared *files* rather than the git index — see [`../../.claude/rules/parallel-sessions.md`](../../.claude/rules/parallel-sessions.md) § PSA-007.

### `wave-scope.json` Session Binding (#1123)

The rule above deconflicts writers *inside one wave*. The same working copy is also shared across SESSIONS, and `<state-dir>/wave-scope.json` is the one control artefact that constrains writes rather than describing them. It lives in the working copy, not in the session — so before #1123 a manifest written by session A governed session B's every Edit. Measured 2026-08-22 (#1082): a Discovery wave's `allowedPaths: []` — prescribed for every Discovery wave — denied all writes of an unrelated parallel session, with a deny reason that could only tell it to fix a wave plan it does not own.

**The manifest is SESSION-BOUND since #1123.** The coordinator that writes it names itself in two optional fields, `session_id` (the raw harness session id) and `semantic_session_id` (renamed from `session` / `semantic_session` in #1153 P2 to match `session.lock` and `current-session.json`; the legacy pair is still READ until the next minor release), both from ONE `sessionAttribution(repoRoot)` call (`scripts/lib/events.mjs`) — see `skills/wave-executor/wave-loop.md` § Scope Manifest 1. `hooks/enforce-scope.mjs` Gate 3b classifies the manifest with `readProcessLocalSessionIds()` + `classifyManifestSession()` (`scripts/lib/session-identity/own-session.mjs`) — process-local tiers only (hook payload, `CLAUDE_CODE_SESSION_ID`), never the repo-global `session.lock`, which is shared by every session in the checkout and made a peer's manifest read `own` (#1194):

- **`foreign`** (ids present, none of them ours) → the gate ALLOWS the write and emits one `orchestrator.scope.foreign_session_ignored` event. A foreign manifest is somebody else's wave plan; it never had authority here, and the event keeps the skip counted rather than silent.
- **`own`** → enforce, unchanged.
- **`unknown`** — no id in the manifest (legacy, pre-#1123) or our own identity unresolvable → enforce, unchanged. Only what is PROVABLY foreign is treated as foreign; a guess would turn "cannot tell" into a silent enforcement-off.

Two consequences for anyone touching this artefact. A stale manifest left by a crashed or finished PEER session no longer scopes this session out of its own writes — but a stale manifest of THIS session still does, so the § Scope Manifest lifecycle (delete `wave-scope.json` with `filescopes/` at session end) remains the operator's job. And an empty id is never an honest "unbound": `scripts/validate-wave-scope.mjs` (`validateSession()`) rejects `"session": ""` as an ERROR while an ABSENT key is only a warning, because an empty id matches nobody and would make every reader treat the manifest as foreign where the writer meant "binds everyone".

Mechanism, disposition table and named limits: [`../../docs/scope-collision-guard.md`](../../docs/scope-collision-guard.md) § 2.3.

## Guards

### Branch Validation

Before reading STATE.md, verify the `branch` field matches the current branch:

```bash
STATE_BRANCH=$(grep '^branch:' <state-dir>/STATE.md | sed 's/branch: *//')
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$STATE_BRANCH" != "$CURRENT_BRANCH" ]]; then
  # STATE.md belongs to a different branch — treat as stale
  echo "⚠ STATE.md is from branch '$STATE_BRANCH' but current branch is '$CURRENT_BRANCH'. Ignoring."
fi
```

### Schema Version

The `schema-version` field enables future migration. Current version: `1`. If a skill reads a STATE.md with an unrecognized schema-version, it should warn and proceed with best-effort parsing rather than failing.

## Concurrency

STATE.md is NOT safe for concurrent access. Only one session should be active per branch at a time. If session-start detects `status: active`, it prompts the user to resume or start fresh (which overwrites the stale STATE.md).

- **Discovery grep-verification** — distributional claims in W1 outputs (e.g., "N of M callers", "100% adopt pattern X") MUST quote the executed grep + file scope + count. See [`../../.claude/rules/parallel-sessions.md`](../../.claude/rules/parallel-sessions.md) § PSA-006.

## STATE.md Write-Size Guard (#739)

Every STATE.md disk write routes through `writeStateMd()` (`scripts/lib/state-md/frontmatter-mutators.mjs`), the lock-guarded read-transform-write helper. Before committing a write, `writeStateMd()` runs `evaluateSizeCeiling(before, after)` and REFUSES the write (WARN to `process.stderr`, no throw by default, prior on-disk contents left intact as last-known-good) when either:

- **Absolute:** `after` byte-size exceeds `DEFAULT_STATE_MD_SIZE_CEILING_BYTES` (256 KB), or
- **Ratio:** `after` byte-size exceeds `STATE_MD_SIZE_CEILING_RATIO` (5×) the prior on-disk (`before`) size — skipped on first-writes (`before === ''`), since there is no prior size to ratio against.

This is the mechanical backstop against the 6.3 MB frontmatter-balloon incident class. Callers may opt into `opts.throwOnCeiling: true` for a thrown `Error` (`.code === 'STATE_MD_SIZE_CEILING'`) instead of the default no-op-with-WARN.

The size ceiling is the **symptom-level backstop**; the root cause is fixed. The underlying `yaml-parser` parse/serialize asymmetry that produced the balloon was closed in #747 (`parseScalar` now JSON-unescapes the double-quoted branch, `serializeScalar` force-quotes coercible strings), and the previously-deferred round-trip-verification gate is now SHIPPED as an active second guard: `evaluateFrontmatterSafe(after)` in `writeStateMd()` refuses any write whose frontmatter block is not a `serialize(parse(after))` byte-fixpoint (WARN + `written: false`, no-throw; opt-in `opts.throwOnFrontmatterUnsafe: true` for a thrown `Error` with `.code === 'STATE_MD_FRONTMATTER_UNSAFE'`). The historical false-positive on operator-authored scalars with literal quote characters no longer applies post-#747. Reinforces the existing guidance: mutate STATE.md via the structured writers (`scripts/lib/state-md.mjs`, `writeStateMd()`) or literal writes — never regex over the frontmatter block, which is the class of edit that produced the original balloon.

## Worktree-Auto-Promotion (#574, Epic #568 P3.1)

When a session is promoted to a sibling worktree via `enterWorktree({basePath, sessionId, branch, repoRoot})` from `scripts/lib/autopilot/worktree-pipeline.mjs`, the new worktree gets its OWN STATE.md scoped to that worktree. The original repo's STATE.md is unaffected.

- Original worktree (where PROMOTION_OFFER was issued): retains its STATE.md, no changes from the promotion event.
- New sibling worktree: runs `session-start` from scratch in the new tree; Phase 1.2 acquires its own session-lock; Phase 1b writes its own STATE.md.
- Cleanup ownership: `session-end` Phase 4a in the promoted worktree handles `git worktree remove` after Phase 4 commit+push completes. The cleanup writes a deviation entry to its own STATE.md before removing the worktree.

Cross-references:
- `skills/session-end/SKILL.md § Phase 4a` (cleanup)
- `scripts/lib/autopilot/worktree-pipeline.mjs § enterWorktree` (creation)
- `skills/_shared/parallel-aware-auq.md` (PROMOTION_OFFER AUQ)

## Session Lock Schema (v2, since Epic #583)

The `.orchestrator/session.lock` file is written mechanically by `hooks/_lib/lock-bootstrap.mjs` on every `SessionStart` hook invocation (Epic #583 D1 fix). Prior to Epic #583, the lock was only created when the coordinator-LLM executed Phase 1.2 prose — a silent-skip risk.

### Lock body (schema v2)

```json
{
  "session_id":          "<native-raw-id OR generated-UUID>",
  "semantic_session_id": "<attribution-label>",
  "started_at":          "<ISO-8601 UTC>",
  "last_heartbeat":      "<ISO-8601 UTC>",
  "mode":                "deep|feature|housekeeping|session|...",
  "pid":                 12345,
  "host":                "hostname",
  "ttl_hours":           4
}
```

### Field notes

| Field | Required since | Description |
|---|---|---|
| `session_id` | v1 | The physical live lock/registry ownership key: a native raw harness identity, or a generated UUID when no trustworthy raw identity exists. Never use a semantic label here. |
| `semantic_session_id` | v2 (Epic #583) | An attribution/history label, normally `<branch>-<YYYY-MM-DD>-<mode>-<n>`, surfaced alongside the raw key. It never establishes lock or registry ownership, including when it equals STATE.md `session`. |
| `started_at` | v1 | ISO-8601 timestamp when the lock was written. |
| `last_heartbeat` | v2 (Epic #583) | ISO-8601 timestamp updated by the `SessionStart` hook and by `PostToolBatch`/`Stop` hooks. **Basis for liveness determination** — replaces PID-liveness (see below). |
| `mode` | v1 | Session mode consulted by exclusivity-matrix. May be `"unknown"` in the provisional lock written by the hook before Session Config + AUQ have settled. |
| `pid` | v1 | **Forensic only — do NOT use for liveness.** Records the writer's process PID (the hook subprocess, ~500ms lifetime). Dead PIDs are expected and normal. See D2 / D3 notes below. |
| `host` | v1 | `os.hostname()` of the machine that wrote the lock. Cross-host locks skip PID checks. |
| `ttl_hours` | v1 | Maximum age before the lock is considered stale regardless of other signals. Default 4h. |

### Liveness rule (v2)

```
isAlive = (Date.now() - Date.parse(last_heartbeat)) < ttl_hours * 3600 * 1000
```

This replaces the v1 PID-liveness check (`process.kill(pid, 0)`) which was fundamentally broken because the recorded `pid` belongs to the ephemeral hook subprocess (dies in <1s), not the long-lived Claude coordinator process. The PostgreSQL pattern — use a heartbeat timestamp rather than PID to establish liveness — is the authoritative reference (see W1-D4 best-practices §1.5).

### #744 — heartbeat is the SOLE active gate (incident + fix)

Despite the v2 liveness rule above existing since Epic #583, `acquire()`'s conflict classifier (`scripts/lib/session-lock.mjs`, the `classifyExisting()` closure) and `checkStale()` still let `pidAlive`/TTL-age act as an independent veto — which let an external `/close` observe the lock's recorded `pid` (the ephemeral hook subprocess / `node -e acquire()` PID, routinely dead within <1s) as dead and misclassify a live, actively-heartbeating session as `stale-pid-dead`, hijacking it mid-wave. Fixed in #744:

- `classifyExisting()` now checks `isLockLive(existing)` **first** and unconditionally returns `{ reason: 'active' }` when true — a dead recorded `pid` can never veto a fresh `last_heartbeat`.
- Only once `isLockLive()` is false is the lock classified stale — see the #1137 follow-up below for the single reason it now returns.
- `checkStale()` surfaces the same `isLockLive()` result as an additive `isLive` field alongside the legacy `ttlExpired` signal, so recovery-flow diagnostics can observe when the two diverge.

Net: `pid` (field notes above) stays forensic-only; `last_heartbeat` freshness is the sole determinant of "is this session still active" everywhere in `session-lock.mjs`.

### #1137 — one stale reason, `stale-heartbeat`

#744 left the *stale* half still keyed on `pidAlive`: `stale-pid-dead` when the recorded pid was confirmed dead, `stale-pid-alive` otherwise. Measured 2026-08-23 across the fleet's live locks: **7 of 7 recorded pids were dead**, including the lock of the session that was heartbeating at that very moment. The pid on a lock is the `node -e` / hook subprocess that wrote it, and it exits within about a second of genesis. Two consequences, both live defects:

- `stale-pid-alive` was **structurally unreachable** same-host — nothing could produce it except a pid-number collision.
- The Phase-1.2 recovery AUQ rendered "pid=… is confirmed dead" for **every** same-host stale lock, presenting a measurement it had not made as the operator's reason to reclaim.

The fix removes the question rather than re-answering it. `classifyExisting()` returns exactly one stale reason, `stale-heartbeat`, carrying `ageHours` (age from `started_at`, unchanged) and `heartbeatAgeMinutes` (age from `last_heartbeat`) — the quantity the liveness rule actually thresholds against, so a recovery prompt states the measured heartbeat age instead of a liveness verdict. `checkStale()` gains the same `heartbeatAgeMinutes` field.

**#1151 follow-up — the `pidAlive` stub is GONE.** #1137 left `checkStale()` returning `pidAlive: null` as a shape-compatible placeholder. It was removed outright: measured @ `f0766e1`, zero production readers repo-wide, so the field only invited a reader to treat `null` as "unknown liveness" — a question this code no longer asks. `checkStale()` now returns `isLive` (the verdict) and `heartbeatAgeMinutes` (the magnitude behind it); anything reasoning about a lock's liveness reads those two. `isPidAliveOnHost` stays exported for `file-lock.mjs` and `lock-reaper.mjs`, where the pid IS the process being asked about.

`isPidAliveOnHost` remains exported from `session-lock.mjs` and is unaffected — `file-lock.mjs` and `lock-reaper.mjs` are legitimate callers, because there the pid IS the process being asked about.

### Schema v1 → v2 backward-compat — ENDED 2026-10-02 (#595)

Lock readers no longer tolerate a v1 lock. A `session.lock` without `last_heartbeat` is foreign or damaged — no writer has produced one since Epic #583 (`buildLock()`, `hooks/_lib/lock-bootstrap.mjs` and `updateHeartbeat()` all set it) — and it is handled as **visible but not live**:

- `parseLock()` returns it unchanged: still shape-valid (`isLockShape()` does not require `last_heartbeat`), so `readLockDetailed()` reports `ok` and the lock is never silently dropped.
- `isLockLive()` and its stdlib-only mirror `lockIsLive()` in `scripts/lib/harness-audit/categories/category4.mjs` call it NOT live; there is no `started_at` fallback any more.
- `heartbeatAgeMinutes` is `null` (no heartbeat, so no heartbeat age) in both `acquire()`'s result and `checkStale()`.
- `acquire()` classifies it `stale-heartbeat`, so the SessionStart bootstrap reclaims it instead of the repo staying blocked for a TTL window that nothing heartbeats.

Rejecting such a lock outright was considered and refused: `readLock()` would return `null`, the create-or-fail in `acquire()` would hit `EEXIST` on the file still there, and the vanished-race branch would answer `active` with `existingLock: null` on every attempt, so a lock nobody can see would block every new session.

`semantic_session_id` stays optional by schema, not as a v1 artefact: when absent, treat it as unknown.

#### Schema v1 Sunset — decided 2026-10-02 (#595)

**History.** The 90-day window from Epic #583 (target 2026-08-25) was evaluated on 2026-08-15 and the tolerance RETAINED. The blocker then was not v1 data but a second production copy of the rule (the `category4.mjs` mirror, pinned by `tests/lib/lock-ttl-parity.test.mjs` *for a v1 lock*) plus v1-shaped test fixtures: a removal attempt turned 18 tests red across 4 files.

**Precondition, re-measured 2026-10-02 on this host (read-only):**

- `find ~/Projects -maxdepth 4 -path '*/.orchestrator/session.lock'` → **8 files, 8/8 carry a non-empty `last_heartbeat`**.
- `~/.config/session-orchestrator/sessions/active/*.json` → **10 entries, 10/10 carry `last_heartbeat` and the `mode` key**.

**Decision (owner-approved scope, 2026-10-02):**

1. **Lock side: the fallback is REMOVED** from all three readers in `scripts/lib/session-lock.mjs` (`parseLock()` normalisation, `isLockLive()`, `heartbeatAgeMinutes()`) and from the `category4.mjs` mirror in the same change. The mirror stays, because the audit path must not import the lock manager. `lock-ttl-parity.test.mjs` now asserts that both copies call a heartbeat-less lock not live, so a copy that grows the fallback back breaks parity. The default-lock fixture factories in `tests/lib/session-discovery.test.mjs` and `tests/lib/session-discovery-fallback.test.mjs` now set `last_heartbeat`; at the measurement those two files carried 17 of the 19 tests the removal turned red.
2. **Registry side: `_validEntry()` keeps accepting an entry without `mode`.** This is no longer framed as v1 compat. It is a deliberate fail-open for peer visibility: rejecting a mode-less entry would drop a possibly LIVE peer from `readRegistry()` / `detectPeers()` and hide it from parallel-session detection, while an unclassifiable peer mode already degrades to `parallel-ok` in `acquire()`. This follows `.claude/rules/development.md` § Guard & Threshold Design.

**Not yet covered:** `scripts/lib/lock-reaper.mjs` `ageHoursOf()` still falls back to `started_at` for the age figure it reports. It is diagnostic only, since the reaper's liveness gate is `isLockLive()`, and it is tracked as a follow-up.
