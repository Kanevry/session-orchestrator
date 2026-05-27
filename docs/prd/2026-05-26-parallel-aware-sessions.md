# Feature: Parallel-Aware Sessions

**Date:** 2026-05-26
**Author:** Bernhard + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 6w (3 phases: P1=2w, P2=1w, P3=2w sequential, +1w Cooldown)
**Parent Project:** session-orchestrator
**Source Brief:** `docs/specs/2026-05-26-parallel-aware-sessions-design.md` (Brainstorm-Output)

## 1. Problem & Motivation

### What

Eine cross-cutting Parallel-Aware-Schicht für die fünf Orchestrierungs-Entry-Points (`autopilot`, `session-start`, `session-plan`, `wave-executor`, `session-end`), die andere aktive Sessions detektiert (auch in Schwester-Worktrees), per Drei-Klassen-Exclusivity-Matrix klassifiziert, und bei kompatiblen Konflikten Worktree-Auto-Promotion mit semantischer session-id anbietet. Drei inkrementelle Phasen, jede standalone-shippable.

### Why

Heute kann effektiv nur eine Claude-Code-Session pro Repo+Branch aktiv sein: `acquire()` in `scripts/lib/session-lock.mjs:221–253` ist mode-blind und worktree-lokal. Das blockiert legitime Parallelarbeit (zwei `deep`-Sessions an disjunkten Scopes) **und** verschleiert eine Schema-↔-Implementation-Lücke: `skills/_shared/state-ownership.md:20` dokumentiert die semantische session-id `<branch>-<YYYY-MM-DD>-<mode>-<n>`, aber `hooks/on-session-start.mjs:230` generiert nur UUID-v4 — die generierende Funktion fehlt komplett.

PSA-001 bis PSA-006 sind als Behavioural-Layer formalisiert (`.claude/rules/parallel-sessions.md`), aber ohne Detection-Surface bleibt es **Disziplin-statt-Mechanik**. Eat-your-own-Dogfood-Validierung lieferte diese Brainstorm-Session selbst: eine Parallel-Session hat den Phase-4-Spec-Write via `enforce-scope.mjs` blockiert weil ihre `wave-scope.json` strict-mode aufspannte — der Operator hatte keinen Mechanismus zu erkennen warum, oder welche Session welchen Scope hält.

### Who

**Primärer Nutzer:** Der session-orchestrator-Operator (Solo-Engineer, multi-Terminal-Workflow). Häufige Szenarien:
- Zwei `deep`-Sessions parallel an disjunkten Scopes (z.B. Frontend-Refactor in Tab 1, Backend-Migration in Tab 2)
- `housekeeping` läuft in Background-Terminal, Operator will gleichzeitig `discovery` für Quick-Triage in Foreground-Terminal
- Autopilot-multi spawn-zeit weitet Mehrfach-Worktrees auf (heute: implizit, ohne Detection-Surface — #341 Anwendungsfall)

**Sekundär:** alle Konsumenten von session-orchestrator (heute primär session-orchestrator selbst + clank). Skill-Authors die neue Orchestrierungs-Skills schreiben profitieren vom Pattern.

## 2. Solution & Scope

### In-Scope

- [ ] **P1: `scripts/lib/session-discovery.mjs`** — `discoverActiveSessions(repoRoot)` API; enumeriert alle Worktrees via `git worktree list --porcelain`, liest jede `.orchestrator/session.lock`, returns `{ worktreePath, sessionId, mode, startedAt, pid, host, branch }[]`
- [ ] **P1: `scripts/lib/exclusivity-matrix.mjs`** — statisches Objekt mit Drei-Klassen: `exclusive` (`bootstrap`, `housekeeping`, `memory-cleanup`), `parallel-ok` (`deep`, `feature`), `always-ok` (`discovery`, `evolve`, `plan`, `repo-audit`, `portfolio`)
- [ ] **P1: `acquire()` Erweiterung in `session-lock.mjs:221–253`** — konsultiert die Matrix; neue Status-Codes `active-incompatible-exclusive`, `active-compatible-parallel`, `active-readonly-bypass`
- [ ] **P1: `skills/_shared/parallel-aware-preamble.md`** — Phase-0.x Pattern analog zu `bootstrap-gate.md` (13 Spokes)
- [ ] **P1: `skills/_shared/parallel-aware-auq.md`** — Reusable AUQ-Pattern aligned an existing Stale-Lock-AUQ (`session-start/SKILL.md:55–67`)
- [ ] **P1: Adoption** — Preamble in genau 5 SKILL.md: `autopilot`, `session-start`, `session-plan`, `wave-executor`, `session-end`
- [ ] **P2: `scripts/lib/session-id.mjs`** — `resolveSemanticSessionId({ branch, mode, activeSessions })` generiert `<branch>-<YYYY-MM-DD>-<mode>-<n>` (n=kleinste freie Nummer im aktiven Set)
- [ ] **P2: `hooks/on-session-start.mjs:230`** — ersetze `randomUUID()` mit `resolveSemanticSessionId()`; STATE.md frontmatter `session-id` zeigt semantische ID
- [ ] **P2: Backward-compat-Lesepfad** — `parseSessionId(id)` akzeptiert beide Formate (UUID-v4 OR semantische ID); explizite Tests
- [ ] **P3: Worktree-Auto-Promotion-AUQ** — bei `parallel-ok`-Konflikt: `[Worktree anlegen + starten (Recommended) / Manuell / Abbrechen]`
- [ ] **P3: Hybrid-Cleanup-Pattern** (Anthropic-Style) — `/close` mit clean-check: clean → auto-remove + WARN-log; dirty → AUQ `[Löschen / Behalten / Manuell]`; `/housekeeping`-Sweep ergänzt nach `stale-branch-days` (7d default)
- [ ] **P3: EnterWorktree-Reuse** — `scripts/lib/autopilot/worktree-pipeline.mjs` als Library benutzt (read-only), nicht refactored

### Out-of-Scope

- **`/deep 2`, `/deep 3` CLI-Argument-Syntax** — Worktree-Auto + semantic-id liefert funktional was `/deep 2` versprach. Falls Telemetrie später zeigt dass Operatoren explizit /deep N tippen wollen → separates Follow-up-Issue
- **STATE-N.md per Slot** — STATE.md bleibt singulär pro Worktree (physische Isolation ersetzt symbolisches Namespacing)
- **Adoption in den 32 utility/query Skills** — Wave-1-Q2 hat `parallel-aware-preamble.md` explizit auf die 5 Orchestrierungs-Skills begrenzt; YAGNI für `/discovery`, `/evolve`, etc.
- **`always-ok`-Bypass für Bootstrap-Gate** — Wave-1-Q5 hat `bootstrap-gate.md:10-20` HARD-GATE-Semantik bestätigt; zwei orthogonale Layer
- **`worktree-auto-cleanup` Session Config Knob** — Wave-1-Q4 hat Hybrid-Pattern als fixed Default angenommen; Config-Surface wächst sonst weiter
- **#341 Re-Scoping** — Wave-1-Q3 + VCS-Research bestätigen: #341 alignment passt as-is, nur `relates_to`
- **autopilot-multi Refactor** — `#448` (terminal-reason race) bleibt eigenes Issue (wir blockieren auf #448 als is-blocked-by)
- **Cross-host Detection** — `discoverActiveSessions()` ist host-local; Lock-Schema unterstützt `host`-Feld bereits aber Discovery erweitert nicht auf NFS/sshfs
- **Process-Tabellen-Scan (A3-Variante)** — Brainstorm-Wave-2 verworfen als Noise + Privacy-Smell
- **Mode-Selector-Integration** — `selectMode()` bleibt unverändert; Parallel-Aware greift NACH der Mode-Wahl

## 3. Acceptance Criteria

### P1 — Discovery + Exclusivity-Matrix + Preamble

```gherkin
Given a repo with an active session.lock in the main worktree
When discoverActiveSessions(repoRoot) is called from any of the 5 orchestrator entry-points
Then it returns an array of session objects covering every Worktree of the repo
And each object contains worktreePath, sessionId, mode, startedAt, pid, host, branch
```

```gherkin
Given an active session in main worktree with mode "housekeeping" (exclusive class)
When a second skill invocation tries to start (any mode)
Then the parallel-aware-preamble triggers an AUQ blocking with options [Warten / Andere Session beenden / Abbrechen]
And the second skill does not progress past Phase-0.x
```

```gherkin
Given an active session in main worktree with mode "deep" (parallel-ok class)
When the operator invokes /deep again from a separate terminal
Then the parallel-aware-preamble triggers an AUQ offering [Worktree anlegen + starten (Recommended) / Manuell / Abbrechen]
And selecting "Manuell" exits cleanly without modifying any state
```

```gherkin
Given an active session-lock with PID that no longer exists on same host (dead-PID)
When discoverActiveSessions() is called
Then that lock is classified as inactive (filtered out)
And does NOT count toward parallel-conflict detection
```

```gherkin
Given an "always-ok" mode skill invocation (e.g., /discovery, /evolve)
And one or more other sessions active in the worktree-family
When the parallel-aware-preamble runs
Then no AUQ is fired
And the skill proceeds without latency penalty
```

### P2 — Semantic Session-ID

```gherkin
Given a fresh session start with branch=main, mode=deep, no other active sessions
When resolveSemanticSessionId() is called
Then it returns "main-2026-05-26-deep-1"
```

```gherkin
Given an existing semantic session-id "main-2026-05-26-deep-1" in worktree A
When a second /deep starts via Worktree-Auto-Promotion in worktree B
Then resolveSemanticSessionId() returns "main-2026-05-26-deep-2"
And n increments from max(activeSessions.n) + 1, never filling gaps
```

```gherkin
Given an existing STATE.md with UUID-v4 session-id (pre-P2 vintage)
When any post-P2 code reads STATE.md frontmatter
Then both formats are accepted (parseSessionId handles both)
And no migration is required for existing files
```

```gherkin
Given two skill-preambles racing to call resolveSemanticSessionId() simultaneously
When the ID-generation runs
Then it is serialized via existing withStateMdLock mutex (PSA-005)
And no two sessions ever get the same n
```

### P3 — Worktree-Auto-Promotion + Hybrid Cleanup

```gherkin
Given parallel-ok mode conflict with operator selecting "Worktree anlegen + starten"
When the AUQ resolves
Then a new git worktree is created at sibling path "../session-orchestrator-<sessionId>/"
And new session inherits the next-free semantic session-id
And the new worktree has its own STATE.md scoped to that worktree
```

```gherkin
Given /close in a Worktree-Auto-promoted session
And the worktree is clean (no uncommitted changes, no untracked files, no unpushed commits)
When /close runs cleanup-step
Then the worktree is auto-removed via `git worktree remove`
And a WARN line is logged to stderr
```

```gherkin
Given /close in a Worktree-Auto-promoted session
And the worktree is dirty (uncommitted OR untracked OR unpushed)
When /close runs cleanup-step
Then an AUQ prompts [Löschen / Behalten / Manuell ich mach's selbst]
And no destructive action runs without explicit user authorization
```

```gherkin
Given a stale Worktree-Auto-promoted session (worktree older than stale-branch-days=7)
When /housekeeping runs its worktree-pruning sweep
Then the stale worktree is offered for removal in the existing housekeeping-prune AUQ
And the operator can batch-decide
```

### Edge Case / Error Handling

```gherkin
Given `git worktree list` fails (not a git repo, or git not installed)
When discoverActiveSessions() is called
Then it emits a WARN to stderr
And falls back to single-worktree mode (only reads .orchestrator/session.lock in current directory)
And does not crash the preamble
```

```gherkin
Given the parallel-aware-preamble takes longer than 2 seconds
When the timeout fires
Then it falls back to single-worktree mode (A1)
And the skill proceeds without hanging
```

```gherkin
Given a "parallel-ok" and an "exclusive" session both try acquire() simultaneously
When both reach the matrix-check
Then the exclusive call wins ordering
And the parallel-ok call gets a wait-for-exclusive status
```

## 3.A Acceptance Criteria (EARS)

> Companion to Section 3 — for `/write-executable-plan` consumption.

### P1 — Discovery + Exclusivity

**Ubiquitous**
- The `discoverActiveSessions(repoRoot)` function shall return all active sessions across the repo's worktree-set with fields `{ worktreePath, sessionId, mode, startedAt, pid, host, branch }`.
- The exclusivity-matrix shall expose three classes: `exclusive`, `parallel-ok`, `always-ok` — with stable mode-membership documented in `state-ownership.md`.

**State-driven (`While …`)**
- While an `exclusive`-mode session is active in the same worktree-family, the parallel-aware-preamble shall block any other skill invocation via AUQ.
- While a `parallel-ok`-mode session is active in the main worktree, the parallel-aware-preamble shall offer Worktree-Auto-Promotion via AUQ.
- While an `always-ok`-mode skill is invoked alongside any other session, the parallel-aware-preamble shall pass through without AUQ.

**Event-driven (`When …`)**
- When `acquire()` is called in `session-lock.mjs`, it shall consult the exclusivity-matrix and `discoverActiveSessions()` before responding.
- When `git worktree list` fails, the discovery API shall emit WARN to stderr and fall back to single-worktree mode (A1 fallback).

### P2 — Semantic Session-ID

**Ubiquitous**
- The semantic session-id shall match regex `^[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+$`.

**Event-driven**
- When `resolveSemanticSessionId({branch, mode, activeSessions})` is called, it shall generate `<branch>-<YYYY-MM-DD>-<mode>-<n>` with n = max(activeSessions.n) + 1.

**Unwanted behaviour (`If … then …`)**
- If two skill-preambles call `resolveSemanticSessionId()` concurrently, then ID-generation shall be serialized via `withStateMdLock` mutex.
- If STATE.md frontmatter contains a pre-P2 UUID-v4 session-id, then the read-path shall accept both formats without migration.

### P3 — Worktree-Auto-Promotion + Cleanup

**Event-driven**
- When the operator selects "Worktree anlegen + starten", a new git worktree shall be created at the sibling path `../session-orchestrator-<semantic-id>/` with its own STATE.md.
- When `/close` runs on a Worktree-Auto-promoted session and the worktree is clean, the worktree shall be auto-removed with a WARN log line.
- When `/close` runs on a dirty Worktree-Auto-promoted session, an AUQ shall prompt before any destructive action.

**State-driven**
- While a Worktree-Auto-promoted session is older than `stale-branch-days` (7d), the next `/housekeeping` sweep shall offer it for removal.

**Unwanted behaviour**
- If the parallel-aware-preamble takes longer than 2 seconds, then it shall fall back to single-worktree mode (A1) without hanging the skill.
- If a `parallel-ok` and an `exclusive` session call `acquire()` simultaneously, then the `exclusive` shall win ordering and the `parallel-ok` shall receive `wait-for-exclusive`.

## 4. Technical Notes

### Affected Files

**New files (P1):**
- `scripts/lib/session-discovery.mjs` — `discoverActiveSessions(repoRoot)` + helpers
- `scripts/lib/exclusivity-matrix.mjs` — static three-class object + `classifyMode(mode)` helper
- `skills/_shared/parallel-aware-preamble.md` — Phase-0.x pattern (mirrors `bootstrap-gate.md` shape)
- `skills/_shared/parallel-aware-auq.md` — reusable AUQ template (aligned to `session-start/SKILL.md:55–67`)

**Modified files (P1):**
- `scripts/lib/session-lock.mjs:221–253` — `acquire()` extended to consult exclusivity-matrix; new status codes
- `skills/autopilot/SKILL.md` — Phase-0.x preamble invocation
- `skills/session-start/SKILL.md` — Phase-0.x preamble (replaces today's standalone stale-lock-AUQ at Phase 1.2)
- `skills/session-plan/SKILL.md` — Phase-0.x preamble invocation
- `skills/wave-executor/SKILL.md` — Phase-0.x preamble invocation
- `skills/session-end/SKILL.md` — Phase-0.x preamble invocation (lock-release path keeps current behavior)

**New files (P2):**
- `scripts/lib/session-id.mjs` — `resolveSemanticSessionId()` + `parseSessionId()` (dual-format reader)

**Modified files (P2):**
- `hooks/on-session-start.mjs:230` — replace `randomUUID()` with `resolveSemanticSessionId()`
- `skills/_shared/state-ownership.md:20` — schema doc reflects actual format generated

**New files (P3):**
- (none — P3 is integration + UX work in existing skill bodies)

**Modified files (P3):**
- `skills/_shared/parallel-aware-auq.md` — extend with Worktree-Auto-Promotion options
- `skills/session-end/SKILL.md` — `/close` cleanup-step (clean-check + AUQ-on-dirty)
- `skills/memory-cleanup/SKILL.md` — `/housekeeping` worktree-sweep extension (already does pruning, adds stale-detection for Auto-promoted)
- `scripts/lib/autopilot/worktree-pipeline.mjs` — read-only consumer; potentially exposes one helper as named export

### Architecture

Layered approach with three clean seams:

1. **Discovery Layer (P1)** — pure helpers, no AUQ. `discoverActiveSessions()` + `exclusivityMatrix` + `classifyMode()`. Side-effect-free; testable in isolation.
2. **Preamble Layer (P1)** — invoked from 5 SKILL.md files as Phase-0.x. Mirrors the `bootstrap-gate.md` pattern (13 existing spokes). Calls Discovery, classifies, fires AUQ on conflict.
3. **Identity Layer (P2)** — `resolveSemanticSessionId()` + dual-format reader. Serialized via existing `withStateMdLock` (PSA-005, `session-lock.mjs:724`).
4. **Promotion Layer (P3)** — `EnterWorktree` helper from `worktree-pipeline.mjs` reused as library. Hybrid-Cleanup-Pattern in `/close` and `/housekeeping`.

All locks via existing `withStateMdLock` infrastructure. No new lockfile types. Reuses `git worktree list --porcelain` (already used by `/housekeeping`).

### Data Model Changes

**None new.** STATE.md frontmatter `session-id` field was always documented as semantic (`state-ownership.md:20`); P2 just makes the generator match the schema. Backward-compat-reader handles transition.

### API Changes

**`session-lock.mjs:acquire()`** — return-shape extended:
- Pre-P1: `{ ok, reason: 'active' | 'stale-pid-dead' | 'stale-pid-alive' | 'fs-error', existingLock? }`
- Post-P1: above + `{ reason: 'active-incompatible-exclusive' | 'active-compatible-parallel' | 'active-readonly-bypass', exclusivityClass, allActiveSessions[] }`
- Callers: only 5 entry-points + tests; new fields are additive.

**New public exports:**
- `scripts/lib/session-discovery.mjs` → `discoverActiveSessions`, `findWorktrees`
- `scripts/lib/exclusivity-matrix.mjs` → `EXCLUSIVITY_MATRIX`, `classifyMode`
- `scripts/lib/session-id.mjs` → `resolveSemanticSessionId`, `parseSessionId`

## 5. Risks & Dependencies

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **`session-lock.mjs` Hot-File** — 9 commits in 30d; high merge-conflict probability while Epic in-flight | High | Strict sequential phasing P1→P2→P3; daily rebase against main; mark Epic `status:in-progress` early to signal Other-Contributors |
| **Worktree-Cleanup aggressive — könnte uncommitted Work löschen** | Critical | Hybrid Anthropic-Pattern enforced by tests (PSA-003 compliance): clean→auto, dirty→AUQ; never destructive without user-OK |
| **Backward-compat-Lesepfad für STATE.md UUID-Sessions** | Medium | P2 implements `parseSessionId()` with explicit unit tests covering both formats + round-trip |
| **Bootstrap-Gate vs always-ok-Klasse Verwechslung** (zwei semantische Layer mit "always allowed" framing) | Medium | Doc explicit in CLAUDE.md + `state-ownership.md`: bootstrap-gate ist HARD outer Layer, parallel-aware ist inner Layer; `always-ok` Klasse referenziert NUR Parallel-Aware |
| **#448 (autopilot-multi terminal-reason race) inherited by P3** wenn unfixed | Medium | List #448 as `is-blocked-by`; alternativ run P3 with #448 still open ONLY if architect-reviewer audits the closure-capture path as safe für read-only consumer |
| **Pre-Skill-Preamble Latenz >100ms p95** in der Praxis | Low | `git worktree list` + N lock-reads = O(N) für typical N≤5; benchmark in P1 acceptance; 2s hard timeout fallback |
| **Worktree-Pfad-Kollision** (sibling path bereits da) | Low | `resolveSemanticSessionId` increment-n verhindert; plus existence-check vor `git worktree add` |
| **#341 in-flight + Cross-link** — könnte Re-Scope-Erwartungen wecken | Low | VCS-Research bestätigt #341 alignment already; nur `relates_to`, kein blocker-edge |

### Dependencies

**Blocks** (this Epic must land first):
- `#297` Phase C-3 cap-decision threshold calibration — needs N≥10 autopilot RUN-volume that Phase-D (worktree-pipelines) accumulates
- `#298` Phase C-4 `/evolve` type 8 autopilot-effectiveness learnings — same RUN-volume gate

**Is-blocked-by** (we wait for):
- `#490` `[follow-up][adr-0003] durableCommit must commit sessions.jsonl + STATE.md` — P3 Worktree-Auto-promoted sessions write STATE.md + sessions.jsonl; durable-commit-expansion is prerequisite for that to be safe across `/close` boundaries
- `#448` `[refactor] autopilot-multi.mjs terminal-reason race` — P3 reuses `worktree-pipeline.mjs`; closure-capture fragility could surface multi-loop finalize() issues; safer to land #448 first

**Relates-to** (no scheduling-coupling but cross-link for context):
- `#341` `tracking: Autopilot Phase D — multi-story worktree pipelines` — Konsument; #341 PRD aligned, no re-scope needed
- `#565` `feat(agent-status): set-status push helper for per-agent tmux side-channel` — komplementär, kann semantische session-id konsumieren
- `#484` `[follow-up][adr-0002] Agent Teams Adapter spike` — orthogonale Parallel-Spur
- `#485` `[follow-up][adr-0003] Routines Adapter — empirical spin-up + durable telemetry` — adjacent zu #490, wird mit dem mitwachsen
- `#378` `[Plan] /test command` — Parallel-Track Epic, geteilter telemetry-substrate aber kein Scope-Overlap

### Open Questions

**None — all five Open Questions from the Brainstorm Spec resolved in Wave 1 Q&A:**

1. ✅ #341 Re-Scoping → relates_to only, no re-scope (Q3 answer)
2. ✅ STATE.md Backward-Compat → dual-format reader in P2 (absorbed into P2 AC)
3. ✅ Bootstrap-Gate vs always-ok-Klasse → bootstrap stays HARD-GATE (Q5 answer)
4. ✅ Worktree-Cleanup-Trigger → Hybrid Anthropic-Pattern (Q4 answer)
5. ✅ Wave-Scope-Interaktion → implicit resolved by P3 Worktree-Auto-Promotion (each session → own worktree → own wave-scope.json)

---

## Post-Implementation Hardening (2026-05-27, Epic #583)

A live-verification session (`main-2026-05-27-deep-5`) ran the parallel-aware preamble against a real active peer (deep-4) and discovered the detection did not fire. W1 Discovery (agents W1-D1 through W1-D4) reproduced five compounding wiring defects. W2 fixed all five. Epic #583 closes sub-issues #584–#588.

### D1 — No mechanical trigger for `acquire()`

**Root cause:** The lock was only created if the coordinator faithfully executed Phase 1.2 prose. The `on-session-start.mjs` hook — the only mechanical entry-point — never called `acquire()`. Grep evidence (W1-D1):

```
$ grep -rn "from .*session-lock\|require.*session-lock" --include="*.mjs" scripts/ hooks/ | grep -v "\.test\."
scripts/lib/autopilot/worktree-pipeline.mjs:35:import { acquire, release } from '../session-lock.mjs';   ← ONLY acquire/release importer
```

The sole `acquire` importer in non-test code was `worktree-pipeline.mjs`, wired only to the `/autopilot-multi` flow, NOT to `/session` or `/deep`.

**Fix (#584):** `hooks/_lib/lock-bootstrap.mjs` (`bootstrapLock()`) is invoked mechanically from `on-session-start.mjs`. Every session now writes `session.lock` on `SessionStart`, regardless of whether the coordinator reaches Phase 1.2.

### D2 — PID-source bug (`pid` = hook subprocess, not session)

**Root cause:** `acquire()` records `process.pid` (the hook subprocess PID, ~500ms lifetime). Once the hook exits, `isPidAlive(pid) === false` → `discoverActiveSessions()` filters the lock out as stale → preamble sees NO active sessions → no AUQ fires.

Confirmed empirically: the host registry contained 5 entries with PIDs confirmed dead by `ps -p`, yet all marked `status: active`.

**Fix (#585):** Lock schema v2 introduces `last_heartbeat` (ISO-8601). Liveness is now:

```
isAlive = (Date.now() - Date.parse(last_heartbeat)) < ttl_hours * 3600 * 1000
```

The `pid` field is retained for forensic audit only; it is no longer used for liveness. This is the PostgreSQL pattern (W1-D4 §1.5: `postmaster.pid` uses `start_time` not `kill -0` alone; proper-lockfile npm uses `mkdir` + periodic mtime touch).

### D3 — `resolveSemanticSessionId` ignored history

**Root cause:** `scripts/lib/session-id.mjs:168-204` computed `n = max(activeSessions.n) + 1` where `activeSessions` was the output of `discoverActiveSessions()`. Because D2 caused all locks to appear stale, `discoverActiveSessions()` always returned `[]`, and `n` was always `1` — producing duplicate `deep-1` session IDs.

**Fix (#586):** `resolveSemanticSessionId` now consults `.orchestrator/metrics/sessions.jsonl` + sibling worktree STATE.md frontmatter to derive a historically-correct `n`, independent of whether live locks exist.

### D4 — `semantic_session_id` was dead code on Claude Code

**Root cause:** Claude Code always passes a UUID-v4 via stdin. The `resolveSemanticSessionId` branch in `on-session-start.mjs:236-313` (~78 LOC) executed only on Codex/Cursor — never on Claude Code. The resulting `session.lock` recorded the UUID as `session_id` with no semantic form, conflicting with the documented contract in `state-ownership.md` and PRD §3 P2.

**Fix (#587):** Lock schema v2 adds `semantic_session_id` — always the `<branch>-<YYYY-MM-DD>-<mode>-<n>` form, even when `session_id` is a UUID. `bootstrapLock()` derives this independently of the stdin path.

### D5 — Host-registry missing `mode` field

**Root cause:** `session-registry.mjs:registerSelf()` entry schema omitted `mode`. The hook caller (`on-session-start.mjs:449`) never passed a mode parameter. `discoverActiveSessions()` fallback `r.mode ?? 'session'` masked the absence. As a result, every cross-repo registry entry fed `classifyMode('session')` → `parallel-ok` default, bypassing the exclusivity-matrix entirely for host-registry peers.

**Fix (#588):** Registry entry schema-v2 adds `mode` field. Writer and caller updated to pass mode through.

### Confirmation of PRD §1 warning

PRD line 20 stated:

> *"ohne Detection-Surface bleibt es **Disziplin-statt-Mechanik**"*

The live-verification confirmed this one architectural layer up: the *Detection-Surface* (preamble, acquire, AUQ) shipped in Epic #568, but its *Trigger* (mechanical `session.lock` write on `SessionStart`) remained prose-only. Epic #583 closes that gap by making `bootstrapLock()` the unconditional mechanical trigger.

**See Epic #583 + sub-issues #584–#588 for the full implementation, tests, and W1-D1..D4 audit artifacts.**
