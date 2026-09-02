# Parallel-Aware AUQ Templates

> Three reusable AskUserQuestion blocks for the parallel-aware preamble (`parallel-aware-preamble.md`).
> Consumed by: autopilot, session-start, session-plan, wave-executor, session-end (5 orchestrator entry-points).

## When to fire which AUQ

Driven by the preamble's outcome (see `parallel-aware-preamble.md` § Outcome Handling):

| Preamble outcome | AUQ to fire |
|------------------|-------------|
| `EXCLUSIVE_BLOCKED` | Exclusive-Conflict AUQ (below) |
| `PROMOTION_OFFER` | Worktree-Promotion AUQ (below) |
| `PASS_THROUGH` | No AUQ |

The third variant — **Always-OK Pass-Through** — fires no AUQ; documented here only for completeness so callers don't reinvent it.

## Exclusive-Conflict AUQ (PRD §3 P1 row 2)

Fires when an `exclusive`-class session (`bootstrap`, `housekeeping`, `memory-cleanup`) is already active in the worktree-family AND the caller is NOT `always-ok`-class.

### Claude Code (AskUserQuestion)

```js
// Unpacked once so the question reads as one sentence instead of five key=value pairs.
const { mode, host, pid, worktreePath } = blockingSession;

AskUserQuestion({
  questions: [{
    question: `A ${mode} session (process ${pid} on ${host}) started ${ageHours}h ago in ${worktreePath}. What now?`,
    header: "Repo belegt",
    multiSelect: false,
    options: [
      { label: "Warten (Recommended)", description: "Nothing else can start here until that session closes. This command does not retry — run it again afterwards." },
      { label: "Andere Session beenden", description: "You close it yourself, then run this command again. Nothing here stops the other session for you." },
      { label: "Abbrechen", description: "Exit now. Nothing is written: no STATE.md, no lock." },
    ],
  }],
});
```

### Codex CLI / Cursor IDE / Pi fallback (numbered Markdown list)

```
A <mode> session (process <pid> on <host>) started <ageHours>h ago in <worktreePath>. What now?

1. Warten (Recommended) — nothing else can start here until that session closes; this command does not retry, so run it again afterwards.
2. Andere Session beenden — you close it yourself, then run this command again. Nothing here stops the other session for you.
3. Abbrechen — exit now. Nothing is written: no STATE.md, no lock.

Reply with the number of your choice.
```

The four slots are `blockingSession.mode`, `blockingSession.host`, `blockingSession.pid` and `blockingSession.worktreePath`; `<ageHours>` is the age of that session in hours.

### Outcome handling

- **Warten** → exit Phase-0 cleanly with stderr note `parallel-aware: waiting on exclusive session_id=<id>`. No retry loop.
- **Andere Session beenden** → exit Phase-0 cleanly with stderr note `parallel-aware: deferred to operator — exclusive session_id=<id>`. No automatic termination.
- **Abbrechen** → exit Phase-0 immediately. No file writes.

## Worktree-Promotion AUQ (PRD §3 P1 row 3)

Fires when the caller is `parallel-ok`-class AND another `parallel-ok` session is active in the SAME worktree (i.e., main worktree collision).

### Claude Code (AskUserQuestion)

```js
// Unpacked once so the question reads as one sentence instead of three key=value pairs.
const { mode, pid } = parallelPeer;

AskUserQuestion({
  questions: [{
    question: `A ${mode} session (process ${pid}) started ${ageHours}h ago in this same folder. Run separately or alongside?`,
    header: "Wo starten?",
    multiSelect: false,
    options: [
      { label: "Worktree anlegen + starten (Recommended)", description: "Creates a second working folder beside this one and starts there — isolates your edits, so nothing collides." },
      { label: "Manuell — in-place daneben", description: "Both sessions write in this same folder — conflicts are likely and you resolve them yourself. A Deviation is logged." },
      { label: "Abbrechen", description: "Exit now. Nothing is written: no STATE.md, no lock." },
    ],
  }],
});
```

The second working folder is a git worktree at `<basePath>/<repo-name>-<sessionId>/`; `enterWorktree()` from `scripts/lib/autopilot/worktree-pipeline.mjs` creates it (see Outcome handling below). Running in-place puts PSA-001/PSA-002/PSA-004 discipline on the operator.

### Codex CLI / Cursor IDE / Pi fallback (numbered Markdown list)

```
A <mode> session (process <pid>) started <ageHours>h ago in this same folder. Run separately or alongside?

1. Worktree anlegen + starten (Recommended) — creates a second working folder beside this one and starts there; isolates your edits, so nothing collides.
2. Manuell — in-place daneben — both sessions write in this folder; conflicts are likely and you resolve them. A Deviation is logged.
3. Abbrechen — exit now. Nothing is written: no STATE.md, no lock.

Reply with the number of your choice.
```

The two slots are `parallelPeer.mode` and `parallelPeer.pid`; `<ageHours>` is the age of that session in hours.

### Outcome handling

- **Worktree anlegen + starten** → invoke `enterWorktree({ basePath, sessionId, branch, repoRoot, rawSessionId, reason: 'worktree-promotion' })` from `scripts/lib/autopilot/worktree-pipeline.mjs`. The helper creates a sibling worktree at `<basePath>/<repo-name>-<sessionId>/`, runs idempotency + boundary checks, and logs a WARN line to stderr on fresh creation. When `<branch>` is already checked out by another worktree — the normal case, since Phase 0.5 passes the current HEAD — the worktree lands on a fresh `so/<sessionId>` branch created at `<branch>` and the helper returns `{ branch: 'so/<sessionId>', promotedFrom: '<branch>' }` (#1067); the new worktree's STATE.md `branch` MUST record `so/<sessionId>` and note `promoted from <branch>@<repoRoot>`. Since #1170, `enterWorktree` releases the source root ITSELF once the destination worktree provably exists — it calls `leaveSourceRoot({ repoRoot, sessionId: rawSessionId, semanticSessionId: sessionId, reason })` from `scripts/lib/session-transition.mjs` internally, on BOTH success exits, so this AUQ handler makes no separate `leaveSourceRoot` call. `rawSessionId` — **read from this root's `.orchestrator/session.lock` via `readLock({ repoRoot })`, never the semantic label, and never `current-session.json`, which may describe a peer session (#863)** — is the RAW physical `session_id` owning this root's lock/registry entry; a wrong id aborts the teardown with `left.ok: false, reason: 'lock-session-mismatch:<owner>'` and removes nothing. In detail: the promotion is a PROCESS BOUNDARY, not a live migration (#1069) — the old root is deregistered and its `session.lock` released BEFORE the new worktree's own Phase 1.2 acquires, so the two roots never both own a live claim at once. `enterWorktree`'s return value carries the outcome as `left: { ok, steps, reason? }`; `leaveSourceRoot()` never throws, so on `left.ok !== true` `enterWorktree` itself emits the stderr WARN `enterWorktree: leaveSourceRoot: <reason>` and the promotion continues regardless (the destination worktree already exists — aborting here would leave the two-live-roots state the call prevents). Then exit the current preamble flow — the new worktree's own session-start runs from scratch (Phase 1 onwards). On failure (`WorktreeBoundaryError` or `git worktree add` non-zero exit), emit a stderr warning `parallel-aware: enterWorktree failed: <error>; falling back to Manuell` and proceed via the Manuell path.
- **Manuell** → append a Deviation via `appendDeviationOnDisk()`:
  `Worktree-Auto-Promotion declined; running in-place alongside session_id=<peer.sessionId>, mode=<peer.mode>, pid=<peer.pid>. PSA-001/PSA-002/PSA-004 discipline applies.`
  Continue Phase-0 — and run the **Peer-Scope-Union** protocol below before the first write.

### Peer-Scope-Union (Manuell only, #1195)

In-place beside a peer is survivable when the two scopes are DECLARED to each other rather than discovered by collision. Measured 2026-09-02 in a consumer repo: a 4-subagent session ran beside a deep session (wave 4, `enforcement: strict`) in ONE checkout, no worktree, zero collisions — the peer's paths were carried in the deep session's `allowedPaths` union (19 → 41, `--assert-subset` green) across a wave rollover.

Four steps, in order. Steps 1 and 2 are the protocol; 3 and 4 are what keeps it honest.

1. **Declare the COMPLETE path list.** The arriving session sends the peer every path it will write — including the ones a script produces (fixtures, snapshots, result files, temp helpers), not only the ones it plans to edit by hand. A path omitted here is a path the peer's guard reports as a violation. In the same message it adopts the peer's resource rules.
2. **The peer unions.** The receiving coordinator adds those paths to its `allowedPaths` as ONE record `peer-session-<id>` in the wave's scope manifest, re-asserts subset/disjointness, and re-materializes them on every wave rollover (`skills/wave-executor/wave-loop.md` § Scope Manifest).
3. **Probe with ONE real write.** Before dispatching any agent, make one small PLANNED Edit from the declared list. A denial here costs one edit; the same denial found after a fan-out costs the wave.
4. **Announce before committing.** The arriving session sends its final file list, the peer sequences its own push behind it, and the SHAs come back. The git index is shared (PSA-007) — sequencing it is the only thing that makes two sessions in one checkout committable.

Message template for step 1 (`SendMessage`, first line self-contained per `.claude/rules/cross-session-messaging.md`):

```
Scope-union request: I will write exactly these paths in <repo> — please add them to your allowedPaths.

Paths (complete, incl. files my scripts write):
- <path>
- <path>

Resource rules I adopt from you: no build, no dev-server ports, no service stop/restart,
commit only via `git commit --only <my files>` after announcing, no push, no tag.

I will probe with ONE planned edit before dispatching, announce my final file list before
committing, and send you the SHAs afterwards.
```

Delivery is never guaranteed (CSM-004): an unanswered request establishes nothing. Without a confirmed union, do not write beside the peer — take the worktree instead.
- **Abbrechen** → exit Phase-0 immediately. No file writes.

## Always-OK Pass-Through (no AUQ)

Fires when the caller's mode is in the `always-ok` class (`discovery`, `evolve`, `plan`, `repo-audit`, `portfolio`). The preamble returns `PASS_THROUGH` immediately regardless of other active sessions. No AUQ, no Deviation, no latency penalty.

```js
// Conceptual — there is NO AUQ for this case.
// The preamble returns { outcome: 'PASS_THROUGH', callerClass: 'always-ok', active }.
// The caller skill continues to Phase 1 unconditionally.
```

PRD §3 P1 row 5 specifies this is a hard guarantee — read-only modes never produce an interrupt.

## See Also

- `parallel-aware-preamble.md` — the preamble that fires these AUQs
- `.claude/rules/ask-via-tool.md` — AUQ-001 through AUQ-005 (always use the tool, not prose)
- `.claude/rules/parallel-sessions.md` — PSA-001/PSA-002 (overlap-check discipline)
- "Parallel-Aware Sessions" (#568; archived in the private Meta-Vault) § 3 P1 — Gherkin rows 2, 3, 5 that these AUQs satisfy
