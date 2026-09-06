# Phase 1.2 + 1.2.1: Session Lock Acquire and Peer-Guard

> Sub-file of the session-start skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-start/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 1.2: Session Lock Acquire (#330)

> **See also Phase 0.5 (Parallel-Aware Preamble)** — the cross-worktree detection runs first. This Phase 1.2 handles the single-worktree local-lock semantics that complement the preamble.

> Skip this phase if `persistence` config is `false`.

Acquire a distributed session-lock to detect parallel sessions in the same repo before initializing STATE.md. This prevents two concurrent Claude/Codex sessions from stomping each other's wave state and metrics writes.

**Mechanical wiring (Epic #583, 2026-05-27):** The SessionStart hook (`hooks/on-session-start.mjs` → `hooks/_lib/lock-bootstrap.mjs`) now writes `.orchestrator/session.lock` mechanically BEFORE this skill's prose runs. The prose Phase 1.2 becomes confirmatory — it verifies the lock exists with the expected shape via `readLock({ repoRoot: process.cwd() })`. Re-call `acquire()` only if `readLock()` returns `null` (mechanical hook failed) OR the existing lock's raw `session_id` does not exactly match the current session's raw id (a rare divergence — surface via AUQ before overwriting). A matching `semantic_session_id`, STATE.md `session`, or owner proof cannot repair that mismatch. The decision flow below still applies to all three outcomes (active / stale / fs-error) when the prose path needs to acquire.

```javascript
import { acquire, forceAcquire } from 'scripts/lib/session-lock.mjs';
const result = acquire({ sessionId, mode: sessionType, ttlHours: 4, repoRoot: process.cwd() });
```

Where `sessionId` is the physical raw identity for this invocation: the native harness-provided raw id, or a generated UUID when no trustworthy raw id exists. It is the only value passed to `acquire()` and the only live lock/registry ownership key. `semanticSessionId` may be recorded separately as an attribution/history label and may populate STATE.md `session`; neither label is a substitute for `sessionId`. `sessionType` is the session mode (`housekeeping`, `feature`, or `deep`).

### Decision flow

1. **`result.ok === true`** → lock is held. Continue to Phase 1.5 (Session Continuity). The lock must be released in session-end.

2. **`result.ok === false`** with `reason === 'active'**:
   - Another Claude/Codex session holds an active lock in this repo.
   - Present a choice via `AskUserQuestion`:
     ```js
     AskUserQuestion({
       questions: [{
         question: `Another session holds the lock here — started ${ageHours}h ago, mode=${existingLock.mode}, host=${existingLock.host}, pid=${existingLock.pid}. Wait, or take the lock?`,
         header: "Session lock",
         multiSelect: false,
         options: [
           { label: "Abort (Recommended)", description: "Stop here and let the other session finish, then start again. Nothing is written until it releases the lock, and two sessions sharing one wave state overwrite each other's metrics." },
           { label: "Force-take the lock", description: "Overwrites the active lock and starts anyway. Only when that session is certainly gone — otherwise both keep writing the same wave state and one of them loses everything." },
         ],
       }],
     });
     ```
   - **Codex CLI / Cursor IDE fallback (numbered Markdown list):**
     ```
     Another session holds the lock here — started <ageHours>h ago, mode=<mode>, host=<host>, pid=<pid>. Wait, or take the lock?
     1. Abort (Recommended) — stop here and let the other session finish, then start again; nothing is written until it releases the lock.
     2. Force-take the lock — overwrites the active lock. Only when that session is certainly gone, otherwise both keep writing the same wave state and one loses everything.
     Reply with the number of your choice.
     ```
   - On **Abort**: exit session-start cleanly with a brief stderr note (`session-lock: aborted — active lock held by session_id=<id>`). Do NOT initialize STATE.md.
   - On **Force-take**: call `forceAcquire({ sessionId, mode: sessionType, ttlHours: 4, repoRoot: process.cwd() })`. After Phase 1.5 initializes STATE.md, append a deviation via `appendDeviation()`:
     `Force-took session lock from session_id=<existingLock.session_id>, age=<ageHours>h, mode=<existingLock.mode>, pid=<existingLock.pid>`. Continue.

3. **`result.ok === false`** with `reason === 'stale-heartbeat'`:
   - A stale lock was found (its last heartbeat is older than its ttl). Likely left behind by a session that crashed or was force-killed. The lock's recorded `pid` is NOT consulted — it belongs to the ephemeral hook subprocess that wrote the lock, never to the session; measured 2026-08-23: 7 of 7 recorded pids were dead, including the live heartbeating session's own (#1137).
   - Present a choice via `AskUserQuestion`:
     ```js
     // `heartbeatAgeMinutes` and `ageHours` come straight off the acquire() result (#1137);
     // `sameHost` is not on the result — compute it first. Use hostnamesMatch, NEVER a raw
     // `===` against os.hostname(): the hostname flips spelling on a single machine
     // (measured 2026-08-24: `Mac.home` and `Ferdinands-MacBook-Pro.local` ten minutes apart),
     // so a raw comparison labels this machine's OWN lock "another machine" (#1072).
     // `||`, not `??` — an EMPTY-STRING host_id must fall back to `host`, or
     // hostnamesMatch('', …) is false and this machine reads its own lock as
     // cross-host. Production uses `lockHostCandidate()` from host-identity.mjs.
     const sameHost = hostnamesMatch(existingLock.host_id || existingLock.host, os.hostname());
     AskUserQuestion({
       questions: [{
         question: `A stale session lock is in the way — started ${ageHours}h ago on host=${existingLock.host}${sameHost ? '' : ' (another machine)'}, its ttl=${existingLock.ttl_hours}h has expired, and its last heartbeat was ${Math.round(heartbeatAgeMinutes)} minutes ago. Reclaim it?`,
         header: "Stale lock",
         multiSelect: false,
         options: [
           { label: "Reclaim (Recommended)", description: "Overwrites the stale lock and continues, because its time-to-live has run out. When that process is really dead, nothing of the old session is lost." },
           { label: "Abort — investigate manually", description: "Stops here and writes nothing. The lock file `.orchestrator/session.lock` (it names the process that wrote it) tells you whether that session is still alive." },
         ],
       }],
     });
     ```
   - **Codex CLI / Cursor IDE fallback (numbered Markdown list):**
     ```
     A stale session lock is in the way — started <ageHours>h ago on <host>, ttl=<ttlHours>h expired, last heartbeat <heartbeatAgeMinutes> minutes ago. Reclaim it?
     1. Reclaim (Recommended) — overwrites the stale lock and continues, because its time-to-live has run out and that process is no longer holding anything.
     2. Abort — stops here and writes nothing. The lock file `.orchestrator/session.lock` (it names the process that wrote it) tells you whether that session is still alive.
     Reply with the number of your choice.
     ```
   - On **Reclaim**: call `forceAcquire({ sessionId, mode: sessionType, ttlHours: 4, repoRoot: process.cwd() })`. After Phase 1.5 initializes STATE.md, append a deviation:
     `Stale-lock reclaim: replaced lock from session_id=<existingLock.session_id>, age=<ageHours>h, pid=<existingLock.pid>`. Continue.
   - On **Abort**: exit cleanly.

4. **`result.ok === false`** with `reason === 'fs-error'**:
   - Filesystem error when writing the lock file. Log `⚠ session-lock: acquire failed — <error>. Continuing without lock (degraded mode).` and proceed without a lock. Do NOT block the session for a transient FS error.

> **New reasons from P1.2 #570:** When called with the optional `activeSessions` argument, `acquire()` can also return `active-incompatible-exclusive`, `active-compatible-parallel`, or `active-readonly-bypass`. Session-start invokes `acquire()` WITHOUT `activeSessions` (the preamble in Phase 0.5 already handled cross-worktree detection); these new reasons surface only in callers that bypass the preamble. Other entry-points (autopilot, session-plan, wave-executor, session-end) follow the same pattern.

### Cross-host behaviour

When `hostnamesMatch(existingLock.host_id || existingLock.host, os.hostname())` is **false** — never a raw `existingLock.host !== os.hostname()`, which labels this machine's own lock "another machine" the moment the hostname flips spelling (#1072; mirror the Phase-1.2 snippet above) — the lock was written on another machine and nothing local can corroborate its heartbeat. `checkStale()` carries no `pidAlive` field at all (REMOVED in #1151; #1137 had left it as an always-`null` stub) — `heartbeatAgeMinutes` is the magnitude to reason from, and `isLive` the verdict. In this case:
- For `reason === 'active'`: the recommendation is **Abort** — cross-host locks cannot be verified as dead.
- For stale reasons: the recommendation is still **Reclaim** only if TTL is clearly expired (>2× ttl_hours). Otherwise default to **Abort**.
- **Never auto-reclaim cross-host locks** under any circumstance — always present the AUQ and let the user decide.
- The AUQ question text for cross-host cases should note: `"(cross-host — the heartbeat cannot be corroborated locally)"`. Do NOT phrase it as PID liveness: the pid on a lock belongs to the ephemeral writer subprocess, not the session, and is never probed (#1137/#1151).

## Phase 1.2.1: Peer-Guard (Epic #583 defense-in-depth)

> Skip this phase if `persistence` config is `false`.

After Phase 1.2 acquires (or confirms) the lock, use `findPeers(repoRoot, { mySessionId: callerSessionHint })` for the STATE.md peer guard. `callerSessionHint` is the original semantic attribution label when one exists, otherwise the raw `sessionId`: `findPeers` may translate the semantic hint for the discovered lock/registry surface only after the exact raw binding check in `parallel-aware-preamble.md`, while keeping the original hint for STATE.md. This catches the rare case where lock-based detection missed an active peer (e.g., the peer's `session.lock` was force-deleted by an out-of-band sweep but STATE.md is still `status: active`, OR the peer's registry write succeeded but the lock-bootstrap hook crashed before the lock landed).

```javascript
import { findPeers } from '$PLUGIN_ROOT/scripts/lib/peer-discovery.mjs';
// Keep the STATE.md comparison in its original attribution-label space.
// findPeers performs the guarded semantic→raw translation only for discovered peers.
const callerSessionHint = semanticSessionId ?? sessionId;
const { peers } = await findPeers(process.cwd(), { mySessionId: callerSessionHint });
const peer = peers.find((p) => p.source === 'state-md') ?? null;
// Phase 1.2.1 consumes only the 'state-md' subset (STATE.md surface only).
if (peer) {
  // STATE.md is owned by an active peer — do NOT overwrite.
  // peer.sessionId, peer.mode, peer.currentWave, peer.ageHours are populated.
  // Fire the Worktree-Promotion AUQ from parallel-aware-auq.md.
}
```

GH#67 note: the `lockSuperseded` advisory-downgrade described in Phase 0.5's outcome handling applies only to the `discovered` peer subset — this phase's `peer` is always `source: 'state-md'`, so a `discovered`-side `lockSuperseded: true` never suppresses this guard; the Worktree-Promotion AUQ still fires exactly as below whenever a live STATE.md peer is found.

### Decision flow

1. **`peer === null`** → no active peer owns STATE.md. Continue to Phase 1.5.
2. **`peer !== null`** → STATE.md is owned by a live peer session. **Do NOT proceed with the default Phase 1.5/1b STATE.md overwrite.** Fire the Worktree-Promotion AUQ from `skills/_shared/parallel-aware-auq.md` (same options the Phase 0.5 preamble would emit on `PROMOTION_OFFER`).
   - User picks "Worktree anlegen + starten" → call `enterWorktree({ ..., rawSessionId, reason: 'worktree-promotion' })` from `scripts/lib/autopilot/worktree-pipeline.mjs` — since #1170 this ONE call also releases the source root: it calls `leaveSourceRoot({ repoRoot, sessionId: rawSessionId, semanticSessionId, reason })` from `scripts/lib/session-transition.mjs` internally, on BOTH success exits, so no separate `leaveSourceRoot` call is made at this site. `rawSessionId` is the RAW physical `session_id` read from this root's `.orchestrator/session.lock` via `readLock({ repoRoot })`, never the semantic label and never `current-session.json` (which may describe a peer, #863) — (#1069 process boundary: this site runs AFTER Phase 1.2 already acquired the lock, so the old root MUST be deregistered and its lock released here, or the new worktree's own Phase 1.2 finds a phantom owner). The return value's `left` field carries `leaveSourceRoot()`'s result; it never throws, so on `left.ok !== true` `enterWorktree` itself emits the stderr WARN `enterWorktree: leaveSourceRoot: <reason>` and the promotion continues regardless — the destination worktree already exists, so aborting here would leave exactly the two-live-roots state the call prevents. Then exit Phase 1 immediately (the new worktree's own session-start runs from scratch).
   - User picks "Manuell — in-place daneben" → append a Deviation describing the missed peer detection, continue to Phase 1.5. STATE.md WILL be overwritten — the user has explicitly accepted that risk.
   - User picks "Abbrechen" → exit cleanly.

### Soft-gate semantics

This is a SOFT-GATE — the operator can override via the AUQ — but the warning is mandatory and must not be silenced. Treat any `checkPeerStateMd` failure (read error, malformed STATE.md, etc.) as `peer === null` (fail-open: do not block the session for a corrupted STATE.md file; the rest of the parallel-aware machinery still applies).

### Why this complements Phase 1.2

Phase 1.2 owns the `.orchestrator/session.lock` file; Phase 1.2.1 owns the STATE.md frontmatter. The two surfaces can disagree (briefly, during a crash; durably, if a sweep deleted one but not the other). The Peer-Guard treats STATE.md as a second, independent source of truth — if EITHER source says a peer is active, the coordinator must pause before stomping shared state.

