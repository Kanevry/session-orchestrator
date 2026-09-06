---
auto-generated: true
consolidated: true
alwaysApply: false
description: "Who am I, and does this artefact belong to me? Session-identity resolution, lock liveness, and the shared-working-copy traps that make an identity check self-confirming."
globs:
  - ".claude/**"
  - "hooks/**"
  - "scripts/**"
  - "scripts/lib/**"
  - "scripts/lib/session-identity/**"
  - "skills/_shared/**"
  - "tests/integration/**"
  - "tests/lib/**"
paths:
  - ".claude/**"
  - "hooks/**"
  - "scripts/**"
  - "scripts/lib/**"
  - "scripts/lib/session-identity/**"
  - "skills/_shared/**"
  - "tests/integration/**"
  - "tests/lib/**"
learning-key: anti-pattern/aufgezeichneter-pid-als-lebendbeweis-wenn-ihn-ein-kurzlebiger-subprozess-schrieb
expires-at: 2026-10-01
---

# Identity and Locks (consolidated)

Every rule here answers one question — *is this artefact mine?* — and every one of them was learned the same way: a check that looked like it measured identity was in fact measuring the working copy, or itself. The shared thread (HR-102 applied to identity): **a process-local witness REPLACES a shared one, it never unions with it**, because a union lets the weakest witness win.

**`expires-at` is 2026-10-01 — the EARLIEST of the 8 absorbed dates.** A merged file must not outlive its shortest-lived content: a single date covering several learnings expires when the FIRST of them is due for review, never when the last is.

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A recorded PID is no proof of life when a short-lived subprocess wrote it

`session.lock` stores the PID of the `node -e`/hook subprocess that WROTE the file, not the session's. That subprocess dies within ~1s, so `isPidAliveOnHost(lock.pid)` reported "dead" same-host essentially always — including for the lock of the session that was heartbeating at that very moment. The `stale-pid-alive` branch was therefore structurally unreachable and the recovery AUQ claimed "confirmed dead" for EVERY stale lock, a measurement it had never made. The fix is not a better PID check but deleting the question: ONE reason (`stale-heartbeat`) from the same signal the live gate already uses, plus `heartbeatAgeMinutes` as the evidence.

**Evidence** — GitLab #1137, Discovery W1-D2 @ `01eb35d`: 7/7 recorded PIDs dead; `session-lock.mjs:570/587` before the fix; live `checkStale` after: `{pid:35186 (dead), isLive:true, heartbeatAgeMinutes:0.049}`.

### A working-copy artefact (STATE.md, session.lock) is not a process-local identity witness — rank witnesses, never union them

Deriving your own session identity from STATE.md `session` or from `session.lock` adopts the LOCK OWNER's identity: both files are written by whichever session owns the working copy. A union (`some()`) over witnesses of differing strength lets the WEAKEST win, and cannot be vetoed by a contradicting process-local id. Rule (HR-102): only a process-local witness (hook-payload `session_id`, `CLAUDE_CODE_SESSION_ID`) may confirm a lock; when it is absent the keys are OMITTED, never filled from a peer value.

**Evidence** — W3 reviewer, Security panel (MED 0.85) and Architect panel (HIGH 0.9) reproduced independently: lock=peer, STATE.md=peer, `CLAUDE_CODE_SESSION_ID`=me → `attributionForRecord()` stamped the PEER ids. FX1 introduced `readProcessLocalSessionIds()` in `own-session.mjs`; test (c4) pins the case. P5 had already refuted `readOwnSessionIds()` (tier 3 = lock ⇒ guard vacuous).

### Unioning identity with a repo-global artefact is self-confirming in a shared working copy

Asking "is this me?" must not union a source that ALL sessions of the working copy share: `session.lock` holds exactly ONE identity, so a peer's manifest matched via the peer's own lock id and Gate 7 locked the second session out (#1194 — precisely the #1082 lockout that G3b was meant to end). Process-local tiers REPLACE the shared source, they do not supplement it (HR-102). The residual cost — a writer that stamps a foreign id into its own manifest disarms its own guard — belongs on the WRITER side.

**Evidence** — `hooks/enforce-scope.mjs` G3b: `readOwnSessionIds(projectRoot,…)` → `new Set(readProcessLocalSessionIds({hookInput}))`. Two existing tests inverted (`tests/hooks/enforce-scope.test.mjs`); the regression test failed before the fix (deny instead of allow), 1066/1066 green in `tests/hooks/` after.

### Two writers, two identity-resolution paths: the duplicate shares not one key

When two writers fill the same append-only ledger and resolve identity by DIFFERENT routes (hook: `current-session.json` → semantic id; CLI: `lock.acquired` else a synthetic id), each session yields a second record sharing NO key with the first. Dedupe by `session_id` structurally cannot see it; only the millisecond-identical timestamps give it away. The repair is two-part: read the second bridge that was already there (`session.ended` has carried `semantic_session_id` since #1068 AC1 but nobody read it), AND stamp the RAW UUID into the record so the join becomes possible at all.

**Evidence** — 2026-09-02 @ `c3ab480`: `jq -r '[.started_at,.completed_at,.status]|@tsv' sessions.jsonl | sort | uniq -d` → 9 tuples (8 abandoned pairs + 1 older exact dup). `jq -s '[.[]|select(.raw_session_id != null)]|length'` → 0 of 286. Fake-regression: disabling the ended-bridge turned the test red (1 failed | 37 passed).

### A dispatched subagent carries the coordinator's RAW session id, never its own

`CLAUDE_CODE_SESSION_ID` inside a subagent process is the RAW UUID of the coordinator that launched it — a subagent never receives an id of its own. Any mechanism needing "my own session id" (lock authorisation, scope attribution) must check that against a PROCESS-LOCAL match of the raw id, never against an assumed subagent identity.

**Evidence** — 2026-09-02, W1-D5 (identity-class fix sites): *"measured: subagent carries PARENT raw session id in `CLAUDE_CODE_SESSION_ID`, no own id."* Applied in #1194 (`enforce-scope` G3b, `readProcessLocalSessionIds`) and #1188 (memory-propose raw→semantic lookup), commit `2ccea0f2`.

### An advisory lock proves no occupancy — annotate, do not filter

When a signal (here: ownership of `.orchestrator/session.lock`) is only a HINT of non-liveness, it must never move into the DISCOVERY layer as a filter, only as an ADDITIVE field. The filter attempt for GH#67 (discard registry entries with foreign lock ownership) turned 9 pinned tests red, because a second session demonstrably runs WITHOUT a lock in the same working copy (#1085). The additive form (`registryOnly`/`lockSuperseded`/`lockOwnerId`, only on registry-derived entries) left all 126 baseline tests green and moves the decision to the consumer, who is allowed to make it.

**Evidence** — 2026-09-02 GH#67: filter variant → 9 red tests (peer-discovery B1/B3/H2/H3/I1b/I5/I10b + 2 in `tests/integration/session-identity-boundaries.test.mjs`). Annotation variant: 131 passed / 0 failed over 5 files. Fake-regression: `lockSuperseded` pinned to `false` → K1 + K5 red.

### Shared repo artefacts with no session field: one missing reference, three different damages in a day

`wave-scope.json`, `current-session.json` and the session-end archive phase all bind to the WORKING COPY instead of to the SESSION. The damages differ and are all invisible to whoever caused them: (1) `allowedPaths: []` for a read-only panel locked an uninvolved session out — and since `skills/wave-executor/wave-loop.md` prescribes `allowedPaths: []` for EVERY discovery wave, every discovery wave of this plugin locks out parallel sessions; (2) `current-session.json` carried session A's head and collected session B's errors; (3) `archive-closed-prds` deleted a foreign session's 20-minute-old committed file. Before any write or delete to a `.orchestrator/` or `<state-dir>/` artefact: does it carry a session id, and is it mine?

**Evidence** — 2026-08-22, one working copy, two parallel sessions: #1082 `note_83488` (deny-all), `current-session.json` head-vs-body measured, #1112 (deleted PRD, restored). All three reported by the OTHER party; none noticed by the causer.

### Session-registry: fresh malformed claim files must be age-gated, not swept

Malformed semantic-id claim files in the session registry can be legitimate IN-FLIGHT registration state. Zombie sweeps must preserve fresh malformed files and remove only aged ones, by filesystem `mtime`. This describes a LIVE invariant, not a fixed defect: `scripts/lib/session-registry.mjs:318-323` still carries the age-gate verbatim, and `age = (now - info.mtimeMs) / 60_000` is what separates `stale-heartbeat` from `malformed-entry` at line 338. A future edit to `sweepZombies` that reads "malformed" as "delete now" re-opens the race, and nothing but this rule and one test says otherwise.

**Evidence** — Wave 4 reproduced a full-suite race where `sweepZombies` removed fresh malformed claim files before `registerSelf` could overwrite them. `tests/lib/session-registry.test.mjs:224` pins it (*"keeps fresh malformed entries because they may be semantic-id claim files"*).

<!-- untrusted-content:end -->

## Provenance

Consolidated 8 generated rules into this file (2026-09-06, 43→8 rule consolidation).
The reconcile engine dedupes on these markers — removing a pair regenerates that learning as a standalone file.

Frontmatter `learning-key:` is a scalar and duplicates only the FIRST bullet; `defaultReadMaterializedProvenance()` unions frontmatter with body, so every bullet below is load-bearing.
- learning-key: `anti-pattern/aufgezeichneter-pid-als-lebendbeweis-wenn-ihn-ein-kurzlebiger-subprozess-schrieb`
- learning-id: `8f0b4e63-ad2c-463e-9f7b-de19c65845fc`
- learning-key: `anti-pattern/ein-arbeitskopie-artefakt-state-md-session-lock-ist-kein-prozesslokaler-identitaetszeuge-zeugen-stufen-nicht-vereinigen`
- learning-id: `1e3f362b-2c95-4858-9265-3eacf407455d`
- learning-key: `anti-pattern/identitaets-union-mit-einem-repo-globalen-artefakt-ist-in-geteilter-arbeitskopie-selbstbestaetigend`
- learning-id: `4ad4b89f-44ac-484c-b5b9-19de8d192fe6`
- learning-key: `anti-pattern/zwei-schreiber-zwei-identitaets-aufloesungswege-das-duplikat-teilt-keinen-einzigen-schluessel`
- learning-id: `eee01f54-fdcf-4b9e-b5e6-b6cb494818fb`
- learning-key: `convention/ein-dispatchter-subagent-traegt-die-rohe-session-id-des-koordinators-nie-eine-eigene`
- learning-id: `14d5440d-1ffa-4d69-9365-1d50a3b52760`
- learning-key: `proven-pattern/ein-advisory-lock-beweist-keine-belegung-annotieren-statt-filtern`
- learning-id: `b60b49d1-0028-404a-a333-abb3859afe0b`
- learning-key: `recurring-issue/geteilte-repo-artefakte-ohne-session-feld-derselbe-fehlende-bezug-drei-verschiedene-schaeden-an-einem-tag`
- learning-id: `81d7e70a-2fa0-4e39-ad54-78bd9ec428f0`
- learning-key: `recurring-issue/session-registry-fresh-claim-files-must-be-age-gated`
- learning-id: `0e7b2bc7-4eef-4b9c-875d-d151af713e7d`

- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
