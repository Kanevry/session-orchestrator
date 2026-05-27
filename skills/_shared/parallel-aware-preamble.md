# Parallel-Aware Preamble

> Single source of truth for the parallel-session-detection preamble.
> Referenced by: autopilot, session-start, session-plan, wave-executor, session-end (5 orchestrator entry-points).

## Purpose

Every session-orchestrator entry-point runs this preamble silently at Phase-0.x (after the bootstrap-gate, before config-reading). It detects other active sessions in the same repository worktree-family, classifies the caller's mode against the exclusivity-matrix, and either passes through, offers Worktree-Auto-Promotion (P3), or blocks via AskUserQuestion.

When no parallel session is detected, execution continues with zero overhead. When a conflict is detected, the appropriate AUQ from `parallel-aware-auq.md` fires.

## Gate Classes

The preamble applies one of three gate semantics based on the caller's mode-class:

<HARD-GATE>
**Exclusive class** (`bootstrap`, `housekeeping`, `memory-cleanup`):
If any other active session exists in the worktree-family, you MUST NOT proceed. The preamble fires the Exclusive-Conflict AUQ from `parallel-aware-auq.md` (`[Warten / Andere Session beenden / Abbrechen]`).
There is no bypass. There is no exception for urgent housekeeping. The ONLY valid next action is the user's AUQ response.
</HARD-GATE>

<SOFT-GATE>
**Parallel-OK class** (`deep`, `feature`):
If another `parallel-ok`-class session is active in the same worktree, the preamble offers Worktree-Auto-Promotion via the Promotion AUQ from `parallel-aware-auq.md` (`[Worktree anlegen + starten (Recommended) / Manuell / Abbrechen]`). The user may proceed in-place by selecting "Manuell" — the preamble logs a Deviation but does not block.

If an `exclusive`-class session is also active, the Exclusive-Conflict AUQ takes precedence (HARD-GATE wins).
</SOFT-GATE>

**Always-OK class** (`discovery`, `evolve`, `plan`, `repo-audit`, `portfolio`):
The preamble passes through with zero AUQ regardless of other active sessions. Read-only modes never conflict.

## Preamble Algorithm

Execute these steps in order. Any classification determines outcome.

```
1. Call discoverActiveSessions(repoRoot) from scripts/lib/session-discovery.mjs.
   - Returns: Array<{worktreePath, sessionId, mode, startedAt, pid, host, branch}>
   - 2-second timeout built-in. On timeout or git failure: A1 fallback (single-worktree mode).
   - Empty array → no parallel context → PASS_THROUGH (continue immediately).

2. Classify the caller's mode via classifyMode(callerMode) from scripts/lib/exclusivity-matrix.mjs.
   - GOTCHA: classifyMode throws on unknown mode. Wrap in try/catch; on throw, default to 'parallel-ok' (most permissive default) and log a stderr WARN.
   - Returns: 'exclusive' | 'parallel-ok' | 'always-ok'

3. Apply the decision matrix:
   - If callerClass === 'always-ok' → return PASS_THROUGH (no AUQ; preamble done).
   - For each active session, classify entry.mode via classifyMode (same safe fallback).
   - If any entry has entryClass === 'exclusive' AND callerClass !== 'always-ok':
       → fire Exclusive-Conflict AUQ from parallel-aware-auq.md
       → block until user response
   - Else if callerClass === 'parallel-ok' AND any entry has entryClass === 'parallel-ok':
       → fire Promotion AUQ from parallel-aware-auq.md
       → user may pick "Worktree anlegen" (P3 fills the action), "Manuell" (in-place + Deviation), or "Abbrechen" (exit)
   - Otherwise (no overlap) → return PASS_THROUGH.

4. Record any non-PASS_THROUGH outcome as a Deviation in STATE.md via appendDeviationOnDisk().
```

## Implementation (JavaScript reference)

```js
import { discoverActiveSessions } from '../../scripts/lib/session-discovery.mjs';
import { classifyMode } from '../../scripts/lib/exclusivity-matrix.mjs';

async function runParallelAwarePreamble({ repoRoot, callerMode, callerSessionId }) {
  // Step 1: discover active sessions (with built-in 2s timeout fallback)
  let active;
  try {
    active = await discoverActiveSessions(repoRoot);
  } catch (err) {
    process.stderr.write(`[parallel-aware-preamble] WARN: discoverActiveSessions failed: ${err.message} — passing through (A1 fallback)\n`);
    return { outcome: 'PASS_THROUGH', reason: 'discovery-error' };
  }

  // Step 2: classify caller (safe — never throw)
  let callerClass;
  try {
    callerClass = classifyMode(callerMode);
  } catch {
    process.stderr.write(`[parallel-aware-preamble] WARN: unknown mode '${callerMode}' — defaulting to 'parallel-ok'\n`);
    callerClass = 'parallel-ok';
  }

  // Step 3: always-ok passes through
  if (callerClass === 'always-ok') return { outcome: 'PASS_THROUGH', callerClass, active };

  // Step 4: empty active list → no conflict
  if (!Array.isArray(active) || active.length === 0) {
    return { outcome: 'PASS_THROUGH', callerClass, active: [] };
  }

  // Step 5: classify each entry (safe)
  const classifiedActive = active.map((entry) => {
    let entryClass;
    try { entryClass = classifyMode(entry.mode); } catch { entryClass = 'parallel-ok'; }
    return { ...entry, _class: entryClass };
  });

  // Step 6: decision matrix
  const exclusiveActive = classifiedActive.find((e) => e._class === 'exclusive' && e.sessionId !== callerSessionId);
  if (exclusiveActive && callerClass !== 'always-ok') {
    return { outcome: 'EXCLUSIVE_BLOCKED', callerClass, blockingSession: exclusiveActive, active: classifiedActive };
  }

  const parallelPeer = callerClass === 'parallel-ok'
    ? classifiedActive.find((e) => e._class === 'parallel-ok' && e.sessionId !== callerSessionId)
    : null;
  if (parallelPeer) {
    return { outcome: 'PROMOTION_OFFER', callerClass, parallelPeer, active: classifiedActive };
  }

  return { outcome: 'PASS_THROUGH', callerClass, active: classifiedActive };
}
```

## Outcome Handling

The skill consuming the preamble translates the outcome:

| Outcome | Action |
|---------|--------|
| `PASS_THROUGH` | Continue immediately. No AUQ. Pre-P1.3 behavior. |
| `EXCLUSIVE_BLOCKED` | Fire Exclusive-Conflict AUQ from `parallel-aware-auq.md`. Block until user response. On "Abbrechen": exit cleanly. On "Andere Session beenden": surface to user (preamble does NOT kill other session). On "Warten": pause Phase 0; re-run preamble on user retry. |
| `PROMOTION_OFFER` | Fire Promotion AUQ from `parallel-aware-auq.md`. On "Worktree anlegen": call enterWorktree() from worktree-pipeline.mjs (see parallel-aware-auq.md outcome-handling). On "Manuell": append Deviation (`Worktree-Auto-Promotion declined; running in-place alongside session_id=<peer.sessionId>`) and continue. On "Abbrechen": exit. |

## Cross-References

- **Discovery layer:** `scripts/lib/session-discovery.mjs` (`discoverActiveSessions`, `findWorktrees`) — shipped in P1.1 #569
- **Classification:** `scripts/lib/exclusivity-matrix.mjs` (`EXCLUSIVITY_MATRIX`, `classifyMode`) — shipped in P1.1 #569
- **Lock integration:** `scripts/lib/session-lock.mjs:acquire()` extended in P1.2 #570 — accepts pre-computed `activeSessions[]` and returns matrix-aware reasons (`active-incompatible-exclusive`, `active-compatible-parallel`, `active-readonly-bypass`)
- **AUQ patterns:** `parallel-aware-auq.md` (three reusable AUQ blocks) — sibling file
- **Deviation logging:** `scripts/lib/state-md.mjs:appendDeviationOnDisk()`

## Idempotency

The preamble is read-only relative to repository state (no file writes unless the user picks an action). Repeated invocation produces the same outcome given the same active-session set. Safe to call multiple times in the same skill invocation if the caller wants to re-check after a wait period.

The Promotion AUQ's "Worktree anlegen" path (P3.1) creates a new sibling worktree and is NOT idempotent — re-running after promotion discovers the new worktree as an active session (which is intended behavior).

## See Also

- `bootstrap-gate.md` — sibling Phase-0 gate (HARD; orthogonal layer)
- `.claude/rules/parallel-sessions.md` — PSA-001 through PSA-006 (behavioural rules complementing this mechanical layer)
- `docs/prd/2026-05-26-parallel-aware-sessions.md` § 3 P1 + § 3.A P1 — acceptance criteria this preamble satisfies
