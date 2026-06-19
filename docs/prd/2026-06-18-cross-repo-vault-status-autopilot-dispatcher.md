# Feature: Cross-Repo Vault-Status Mirror + Autopilot Dispatcher

**Date:** 2026-06-18
**Author:** Bernhard + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 6w (3-phase epic — each phase ships independent value)
**Parent Project:** session-orchestrator (plugin epic)

> One-line: Vom Vault aus sehen, welches Repo gerade aktiv ist und in welchem Status — und aus einem Startverzeichnis heraus per Owner-Abstimmung ein freies Repo + Session-Typ wählen, fest gekoppelt mit dem Autopiloten, so autonom wie sinnvoll und so sicher wie möglich.

---

## 1. Problem & Motivation

### What
Three coupled capabilities, delivered as three phases of one epic:

- **P1 — Vault Session-Status Mirror.** Make the live and durable session status of every repo visible *from the vault*. A host-local board (`01-projects/_active-sessions.md`) shows, per repo, whether it is `frei | in-progress | closed | force-closed` with session-id + heartbeat (source: the local session registry/lease). Separately, the durable per-repo narrative (Wave History, Deviations, "What Not To Retry", mission-status rollup) is mirrored to the vault for traceability.
- **P2 — Cross-Repo Free-Repo Dispatcher.** Start from a single directory, enumerate candidate repos, determine which are *free* (no live lease), rank them, and — after **owner confirmation via AUQ** — route into the right entry point (`/session housekeeping|deep`, `/plan`, `/discovery`) for the chosen repo.
- **P3 — Autonomy-Suitability Gate + Loop Coupling.** A per-repo autonomy dial (`off | advisory | autonomous-gated`, mirroring the existing `skill-evolution` pattern) plus an *autonomy-suitability verdict* that tells the operator whether a worked-out session is safe to run autonomously or should be aligned first. Opt-in coupling to the existing autopilot loop, with effectiveness reflected back over time via `/evolve` + dialectic peer-cards.

### Why
- **Concrete gap, proven by a live example.** `FeedFoundryV2` (`~/Projects/FeedFoundryV2/.claude/STATE.md`, inspected 2026-06-18) maintains a rich live STATE.md — `mission-status[]` item progression, `## Wave History`, `## Deviations` (timestamped owner-approved decisions, live-spend, go-live findings), `## What Not To Retry` — yet has **no vault entry at all** (`01-projects/feedfoundry*` absent). The most valuable session knowledge never reaches the vault. A crashed `status: active` session would stay "active" forever — there is no `force-closed` today.
- **The dangerous operational case.** When the operator fans out parallel terminals from one starting directory and works cross-repo, nothing prevents two terminals from grabbing the same free repo. A host-local board + lease check closes this.
- **Traceability for handover.** "Wenn jemand krank ist" — or simply for review — one must be able to read in the vault, per repo, what the best practices are, what worked, what failed, and what changed. Today this lives only inside each repo's `.claude/STATE.md` and `.orchestrator/metrics/`.
- **Autonomy with a safety net.** External best-practice (Anthropic, *Measuring Agent Autonomy*) cautions against rigid per-action approval gates ("friction without necessarily producing safety benefits") and favors outcome-monitoring + the agent surfacing its own uncertainty. The leverage decision worth confirming is *which repo + which type*; the run itself is already guarded by 10 kill-switches, checkpoints, and verification gates.

### Who
- **Primary persona — the Operator (Bernhard, or any human driving the orchestrator).** Works across ~27 repos under `~/Projects`, often from parallel terminals on a single machine. Wants to start from a directory, be routed to the next valuable free repo, confirm once, and let it run.
- **Secondary persona — the Reviewer / stand-in.** Reads the vault to understand, per repo, current status + durable best-practices/decisions without opening the repo or being the original author.
- **Existing personas reused:** the autopilot loop, mode-selector, session-start/-end lifecycle, vault-mirror — all extended, none replaced.

## 2. Solution & Scope

### In-Scope
- [ ] **P1.1** Host-local live board `01-projects/_active-sessions.md` in the vault: idempotent (plugin `_generator` marker), git-ignorable per machine, listing per repo `frei | in-progress | closed | force-closed` + session-id + last-heartbeat + branch + mode. Source = local session registry + `session.lock` (v2 lease).
- [ ] **P1.2** Live-status refresh at session-start (→ in-progress), via heartbeat during the session, and at session-end (→ closed). Status enum extended with a terminal `force-closed`. Liveness uses the existing `session.lock` v2 ttl (`ttl_hours`, **default 4h**) — the single authoritative staleness threshold for this feature.
- [ ] **P1.3** Staleness sweep: a board entry whose backing lease is dead (heartbeat older than the v2 ttl, default 4h) flips `in-progress → force-closed` (never silently drops to closed).
- [ ] **P1.4** Durable per-repo narrative mirror: at session-end (and optionally inter-wave), mirror STATE.md `## Wave History`, `## Deviations`, `## What Not To Retry`, and the `mission-status[]` rollup into the vault per-repo durable surface (synced; reuses existing `50-sessions/` + per-project narrative). Never writes the sven-owned `_overview.md`.
- [x] **P2.1** Candidate-repo enumeration from a starting directory, reusing the cross-repo confinement root (`~/Projects`, `scripts/lib/config/cross-repo.mjs`) and vault `01-projects/*` registration. _(deep-1 2026-06-18: `scripts/lib/dispatcher/enumerate.mjs`, #676 — FS scan of confinement-root children with `.git` + `validatePathInsideProject` guard; vault remote-ids have no local path so enumeration is FS-driven, vault registration is metadata-only.)_
- [x] **P2.2** Free/busy resolution per candidate via the local lease (`session-discovery.mjs` / `peer-discovery.mjs` / `session-registry.mjs`) — single-machine authoritative; the board is the human-readable mirror. _(deep-1: `isLockLive(readLock({repoRoot}))` per candidate, mirrors board-writer collectRows; busy listed not selected.)_
- [x] **P2.3** Ranking of free candidates by **priority × staleness × readiness** (open-issue priority labels via `glab`/`gh`, days-since-last-session, CI-not-red/resource-ok). _(deep-1: `scripts/lib/dispatcher/rank.mjs`, #677 — pure `scoreCandidate` + DI `rankCandidates`; glab/gh-missing → staleness-only + warning, never blocks.)_
- [x] **P2.4** Owner-confirmation AUQ: present the recommended repo + recommended session-type with rationale; the human confirms or overrides. Routes to `/session housekeeping|deep`, `/plan`, or `/discovery`. _(deep-1: `skills/dispatcher/SKILL.md` Phase 2 (AUQ) + Phase 4 (route); mode-selector surfaces discovery/plan-retro as non-execution suggestions, #678.)_
- [x] **P2.5** Atomic claim of the chosen repo (lease acquire) before launch, so a second terminal cannot select the same repo. _(deep-1: `cli.mjs claimRepo` → `acquire()` linkSync create-or-fail; race loser re-ranks excluding R (SKILL Phase 3), #678.)_
- [x] **P3.1** Per-repo `dispatcher-autonomy` config block (`autonomy: off | advisory | autonomous-gated`, `confidence-floor`, optional caps), parsed by a new `scripts/lib/config/dispatcher-autonomy.mjs` mirroring `config/skill-evolution.mjs` (fail-closed default `off`). _(#679, deep-2026-06-19: `_parseDispatcherAutonomy` + `resolveDispatcherAutonomy` host-local override (env `SO_DISPATCHER_AUTONOMY` > owner.yaml `dispatcher.autonomy` > committed > off); wired into config.mjs + owner-yaml.mjs `dispatcher:` section + docs. Caps deferred to #682. 41 tests, security PASS. Block outside `## Session Config` (drift-check Check-6 parity-exempt); committed-block adoption in CLAUDE.md = #681's migration.)_
- [x] **P3.2** Autonomy-suitability verdict engine (`scripts/lib/autonomy/suitability.mjs`) mirroring the `skill-evolution/engine.mjs` quadruple-gate shape: combine mode-selector confidence (≥ `confidence-floor`, default 0.5), per-repo kill-switch rate (**< 0.2 over the last N≥5 autopilot runs**; when fewer than 5 runs exist, this signal is omitted and the verdict uses confidence + CI/resource only), CI status, resource verdict, and the `autonomy-verdict` learning into `{ suitable: bool, confidence, rationale, warnings }`. _(#680, deep-2026-06-19: pure never-throws `computeSuitabilityVerdict(deps)`, 4-gate AND (confidence≥floor ∧ kill-switch-rate<0.2 ∧ CI≠red ∧ resource≠critical), CI-red/resource-critical force suitable=false regardless of confidence, <5-runs omission. DI seam — NOT wired into dispatcher launch (that is #682). The `autonomy-verdict` LEARNING input remains #683/P3.5. 61 tests, security ARM-READINESS PASS.)_
- [x] **P3.3** One-time-per-repo autonomy capture at **two triggers**: (a) bootstrap (new project) and (b) migration — first session-start on an already-bootstrapped repo after this feature ships. Guard = **committed `dispatcher-autonomy:` block absent** (no separate marker file). On any answer (including `off`) the block is written, so it fires exactly once per repo and travels with the repo. A machine/person that wants to differ sets a **host-local override** (env / owner.yaml) which wins over the committed default (mirrors the #653 host-path precedence). _(#681, deep-2026-06-19-deep-2: NEW `scripts/lib/config/dispatcher-autonomy-capture.mjs` (4 exports: question-def, raw `/^dispatcher-autonomy:\s*$/m` presence guard [NOT resolved value — can't distinguish absent vs present-with-off], standalone-H2 renderer, idempotent committed-default-only writer with defensive double-write guard); bootstrap Phase 3.5.1 + session-start Phase 1.1 migration trigger; committed block dogfooded into root CLAUDE.md (value `off`). 66 tests, security SAFE-TO-ARM, round-trips through `_parseDispatcherAutonomy`. AUQ-via-tool, no host-local leak into CLAUDE.md.)_
- [x] **P3.4** Opt-in coupling to the autopilot loop: when `autonomy: autonomous-gated` and the verdict is green, the dispatcher may proceed without per-selection confirmation; otherwise it informs the operator and asks. Reuses all 10 existing kill-switches. _(#682, deep-2026-06-19-deep-2: NEW `scripts/lib/autopilot/recent-runs.mjs` (no-throw repo-scoped autopilot.jsonl tail reader, TRUE-count preserved — NICE-a); dispatcher Phase 1.5 verdict-gate (fail-closed on BOTH `autonomy === 'autonomous-gated'` AND `verdict.suitable === true` — engine dial is advisory-only, caller does the autonomy half) + autopilot Pre-Loop gate + commands/{dispatcher,autopilot}.md. NICE-b null-not-malformed ci/resource, NICE-c forcedFail end-to-end (CI red/resource critical → suitable=false at conf 0.99). Spans dispatcher surface per §3.A FA-2. 43 tests incl. real-SUT integration, security ARM-READINESS PASS, 10 kill-switches reused not duplicated.)_
- [ ] **P3.5** New learning type `autonomy-verdict` (`scripts/lib/evolve/autonomy-verdict.mjs`) reusing type-8 `autopilot-effectiveness` + skill-judge signals; reflected via `/evolve` and dialectic peer-cards (AGENT.md "Autonomy Readiness" section).

### Out-of-Scope
- **Multi-machine authoritative locking** (vault-as-truth for free/busy with cross-host claim/fencing) — explicitly deferred. Decided single-machine authoritative; collaboration is non-concurrent on a given repo. Tracked as a P3+ follow-up if demand appears.
- **Unattended cross-repo dauerlauf without any opt-in** — autonomy is always behind the per-repo dial + green verdict; "never asks at all" is not a target.
- **Replacing the autopilot/mode-selector/vault-mirror engines** — this epic extends them; no rewrite.
- **Writing the sven-owned `_overview.md`** — the plugin uses its own surfaces only (the vault-mirror "no `_generator` marker → never touch" rule is respected).
- **Making `discovery`/`plan-retro` auto-*executed* modes** — they remain read-only precursors; the dispatcher *menu* routes to them, the recommendation engine may *suggest* them, but they are not turned into execution-wave modes.

## User Stories

### US-1 (→ FA-1 Vault Status Mirror)
**Als** Operator **möchte ich** im Vault auf einen Blick sehen, welches Repo gerade `in-progress`, `closed`, `force-closed` oder `frei` ist, **damit** ich beim Arbeiten aus parallelen Terminals nicht versehentlich zweimal dasselbe Repo starte.
- ↳ AC: §3 FA-1 (board rendering + status enum), §3.A FA-1 event-driven + unwanted-behaviour.

### US-2 (→ FA-1 Vault Status Mirror)
**Als** Reviewer/Vertretung **möchte ich** im Vault pro Repo die Wave-History, Deviations und "What Not To Retry" nachlesen, **damit** ich nachvollziehen kann, was zuletzt gemacht wurde und was nicht erneut versucht werden soll — ohne das Repo zu öffnen oder der Autor zu sein.
- ↳ AC: §3 FA-1 (durable narrative mirror).

### US-3 (→ FA-2 Dispatcher)
**Als** Operator **möchte ich** aus einem Startverzeichnis heraus ein freies, lohnendes Repo + passenden Session-Typ vorgeschlagen bekommen und einmal bestätigen, **damit** ich nicht selbst entscheiden muss, woran als Nächstes gearbeitet wird.
- ↳ AC: §3 FA-2 (enumeration, ranking, owner-AUQ, routing), §3.A FA-2 event-driven.

### US-4 (→ FA-2 Dispatcher)
**Als** Operator mit zwei parallelen Terminals **möchte ich**, dass ein gewähltes Repo atomar beansprucht wird, **damit** das zweite Terminal es nicht ebenfalls auswählt.
- ↳ AC: §3 Edge Cases (atomic claim race).

### US-5 (→ FA-3 Autonomy Gate)
**Als** Operator **möchte ich** vorab erfahren, ob eine herausgearbeitete Session autonomiefähig ist oder besser abgestimmt wird, und pro Repo einstellen, wie viel Autonomie ich erlaube, **damit** sichere Repos autonom laufen und riskante zur Abstimmung kommen.
- ↳ AC: §3 FA-3 (config dial + suitability verdict + informed gate), §3.A FA-3.

### US-6 (→ FA-3 Autonomy Gate)
**Als** Operator **möchte ich** pro Repo genau einmal nach meiner Autonomie-Präferenz gefragt werden — bei Projektanlage und beim ersten Lauf nach dem Plugin-Update — wobei der committete Wert der geteilte Repo-Default ist und jede Maschine ihn host-lokal überschreiben kann, **damit** das Feature für Neu- und Bestands-Repos sauber initialisiert wird, ohne mich zu wiederholen, und trotzdem jede Maschine sich selbst einstellen kann.
- ↳ AC: §3 FA-3 (one-time capture, two triggers), §3.A FA-3 unwanted-behaviour (never ask twice).

### US-7 (→ FA-3 Autonomy Gate)
**Als** Operator **möchte ich**, dass das System über `/evolve` lernt, ob Autonomie pro Repo gut oder schlecht lief, **damit** sich die Eignungs-Bewertung über die Zeit verbessert.
- ↳ AC: §3 FA-3 (autonomy-verdict learning + reflection).

## 3. Acceptance Criteria

### FA-1 — Vault Session-Status Mirror (Phase 1)
```gherkin
Given vault-integration.enabled is true and a session starts in repo R
When session-start completes lease acquisition
Then 01-projects/_active-sessions.md contains a row for R with status "in-progress",
  the semantic session-id, branch, mode, and a fresh heartbeat timestamp,
  written with the plugin _generator marker and without touching sven's _overview.md
```
```gherkin
Given a repo R has a board row with status "in-progress"
When the session for R closes cleanly via session-end
Then the row transitions to "closed" with the completed-at timestamp
```
```gherkin
Given a repo R has status "in-progress" but its session.lock heartbeat is older than ttl
When any session-start or dispatcher run performs the staleness sweep
Then R's board row transitions to "force-closed" (never silently to "closed" or dropped)
```
```gherkin
Given a session in repo R produced STATE.md sections Wave History, Deviations and What Not To Retry
When session-end runs the durable-narrative mirror
Then the vault per-repo durable surface contains those sections plus the mission-status rollup,
  is idempotent on re-run (skipped-noop when unchanged), and skips hand-authored files lacking the generator marker
```

### FA-2 — Cross-Repo Free-Repo Dispatcher (Phase 2)
```gherkin
Given the operator invokes the dispatcher from a starting directory under the confinement root
When candidate repos are enumerated and free/busy is resolved via the local lease
Then only repos with no live lease are eligible, and busy repos are listed as such (not selected)
```
```gherkin
Given two or more free candidate repos exist
When the dispatcher ranks them
Then the ranking applies priority × staleness × readiness (open-issue priority, days-idle, CI-not-red/resource-ok)
  and presents the top candidate as the recommended option
```
```gherkin
Given a recommended repo + recommended session-type
When the dispatcher asks the operator via AskUserQuestion
Then the human can confirm or override both repo and type, and on confirmation the dispatcher
  routes to /session housekeeping|deep, /plan, or /discovery for that repo
```

### FA-3 — Autonomy-Suitability Gate + Loop Coupling (Phase 3)
```gherkin
Given a repo with dispatcher-autonomy.autonomy = "autonomous-gated" and confidence-floor 0.5
When the dispatcher computes the autonomy-suitability verdict
Then suitable is true only if mode-selector confidence ≥ floor AND per-repo kill-switch rate < 0.2 over the
  last N≥5 autopilot runs (signal omitted when <5 runs exist) AND CI is not red AND resource verdict is not
  critical; otherwise suitable is false with warnings
```
```gherkin
Given a repo whose committed dispatcher-autonomy config block is absent
When session-start runs for the first time after this feature ships (migration trigger)
Then the operator is asked exactly once for the autonomy preference, the committed config block is written
  (even when the answer is "off"), and because the block is now present no subsequent session re-asks
```
```gherkin
Given autonomy = "advisory" (or the verdict is not green)
When the dispatcher reaches the launch decision
Then it INFORMS the operator of the verdict and asks for confirmation before launching (never auto-launches)
```
```gherkin
Given ≥1 autopilot run and ≥1 skill-judge signal exist for repo R
When /evolve analyze runs
Then an autonomy-verdict learning for R is produced/confirmed with confidence in [0,1],
  and dialectic derivation can synthesize an "Autonomy Readiness" note for that repo
```

### Edge Case / Error Handling
```gherkin
Given two parallel terminals both select the same free repo R
When the first terminal acquires R's lease (atomic claim)
Then the second terminal's claim fails and it re-ranks, excluding R
```
```gherkin
Given the vault is unavailable or vault-integration is off
When session-start/-end or the dispatcher runs
Then status mirroring degrades silently (no board write, no error) and free/busy falls back to the local registry only
```
```gherkin
Given glab/gh is missing or times out during ranking
When the dispatcher computes readiness/priority
Then ranking falls back to staleness-only and surfaces a warning, never blocking the run
```

## 3.A Acceptance Criteria (EARS)

### Feature Area 1 — Vault Session-Status Mirror
**Ubiquitous:**
- The status mirror shall write only files carrying the plugin `_generator` marker and shall never modify `_overview.md`.

**State-driven (`While …`):**
- While a session holds a live lease for repo R, the board shall show R as `in-progress` with a heartbeat no older than ttl.

**Event-driven (`When …`):**
- When a session starts, the board shall set R to `in-progress`; when it ends cleanly, to `closed`.
- When session-end runs, the durable mirror shall append/update the per-repo Wave History, Deviations, What-Not-To-Retry and mission-status rollup idempotently.

**Optional feature (`Where …`):**
- Where `vault-integration.enabled` is true, the mirror shall run; where false or vault absent, it shall no-op silently.

**Unwanted behaviour (`If … then …`):**
- If a board row is `in-progress` but its lease heartbeat exceeds ttl, then the sweep shall set it to `force-closed`.
- If a target vault file is hand-authored (no generator marker), then the mirror shall skip it (skipped-handwritten).

### Feature Area 2 — Cross-Repo Free-Repo Dispatcher
**Ubiquitous:**
- The dispatcher shall confirm repo + session-type with the operator before launch unless P3's autonomy gate is green.

**State-driven (`While …`):**
- While a candidate repo holds a live lease, the dispatcher shall treat it as busy and exclude it from selection.

**Event-driven (`When …`):**
- When the operator confirms a selection, the dispatcher shall atomically claim the repo's lease before routing.
- When ranking, the dispatcher shall order free candidates by priority × staleness × readiness.

**Optional feature (`Where …`):**
- Where no free candidate exists, the dispatcher shall report "all repos busy" and offer to resume or wait, rather than forcing a selection.

**Unwanted behaviour (`If … then …`):**
- If an atomic claim fails (race), then the dispatcher shall re-rank excluding that repo.

### Feature Area 3 — Autonomy-Suitability Gate
**Ubiquitous:**
- The autonomy dial shall default to `off` (fail-closed) when the config block is absent or malformed.

**State-driven (`While …`):**
- While CI is red or the resource verdict is critical, the suitability verdict shall be non-green regardless of confidence.

**Event-driven (`When …`):**
- When a repo has no committed autonomy config at first post-update session-start, the system shall ask exactly once and persist the committed config block.

**Optional feature (`Where …`):**
- Where `autonomy = autonomous-gated` and the verdict is green, the dispatcher may launch without per-selection confirmation.
- Where a host-local override (env / owner.yaml) is set, the effective autonomy shall be the override, not the committed default.

**Unwanted behaviour (`If … then …`):**
- If the committed autonomy config block is already present, then the system shall not ask again.
- If autonomy is `off`, then every launch shall require explicit operator confirmation (never autonomous).

## 4. Technical Notes

### Affected Files
- `scripts/lib/vault-status/board-writer.mjs` — **new**; renders/updates `_active-sessions.md` idempotently (mirror the `gitlab-portfolio/markdown-writer.mjs` + `vault-mirror/utils.mjs` generator-marker pattern).
- `scripts/lib/vault-status/narrative-mirror.mjs` — **new**; extracts STATE.md `## Wave History` / `## Deviations` / `## What Not To Retry` + `mission-status[]` rollup → per-repo durable vault surface.
- `scripts/lib/session-discovery.mjs`, `peer-discovery.mjs`, `session-registry.mjs`, `session-lock.mjs` — reuse for free/busy + atomic claim; add a `force-closed` derivation on dead-lease sweep.
- `scripts/lib/config/cross-repo.mjs` — reuse confinement-root enumeration for candidate repos.
- `skills/dispatcher/SKILL.md` + `commands/dispatcher.md` — **new**; the front-door (enumerate → rank → owner-AUQ → claim → route). May alias from `/autopilot` entry.
- `scripts/lib/dispatcher/rank.mjs` — **new**; priority × staleness × readiness scorer.
- `scripts/lib/config/dispatcher-autonomy.mjs` — **new**; parses the `dispatcher-autonomy:` block (mirror `config/skill-evolution.mjs`, fail-closed `off`).
- `scripts/lib/autonomy/suitability.mjs` — **new**; the verdict engine (mirror `skill-evolution/engine.mjs` gate shape).
- `scripts/lib/evolve/autonomy-verdict.mjs` — **new**; the new learning type (reuse `evolve/autopilot-effectiveness.mjs` + skill-judge reads).
- `scripts/lib/mode-selector.mjs`, `scripts/lib/recommendations-v0.mjs`, `scripts/lib/mode-selector/scoring.mjs` — extend to surface `discovery`/`plan-retro` as dispatcher suggestions (not as execution modes).
- `skills/session-start/SKILL.md` — board write on start (in-progress), staleness sweep, one-time autonomy-capture migration trigger.
- `skills/session-end/SKILL.md` — board update (closed) + durable narrative mirror + `autonomy-verdict` learning extraction.
- `skills/bootstrap/SKILL.md` — one-time autonomy-capture at project creation.
- `skills/autopilot/SKILL.md` + `commands/autopilot.md` — opt-in loop coupling to the dispatcher + verdict.
- `skills/evolve/SKILL.md`, `agents/dialectic-deriver.md` — consume `autonomy-verdict`; synthesize AGENT.md "Autonomy Readiness".
- `docs/session-config-reference.md` — document the `dispatcher-autonomy:` block; `.claude/rules/` autonomy posture note.
- `tests/lib/vault-status/`, `tests/lib/dispatcher/`, `tests/lib/autonomy/`, `tests/lib/config/dispatcher-autonomy.test.mjs` — **new** coverage.

### Architecture
- **Reuse over rebuild.** Free/busy is the existing `session.lock` v2 lease (heartbeat + ttl) + host-local registry — already a lease/fencing pattern matching distributed-systems best practice. The board and the durable mirror are render-only consumers; the registry stays the source of truth (single-machine authoritative).
- **Two distinct vault surfaces.** (a) Host-local *live board* `_active-sessions.md` (coarse status, git-ignorable per machine, source = registry). (b) *Durable narrative* (synced, for traceability), reusing `50-sessions/` + per-project files. Neither touches the sven-owned `_overview.md`.
- **Autonomy gate mirrors a proven precedent.** The `skill-evolution` dial (`off|advisory|autonomous-gated`) + evidence-floor + quadruple-gate (`engine.mjs`) is copied in shape for `dispatcher-autonomy`. Verdict = AND of {confidence ≥ floor (0.5), kill-switch rate < 0.2 over last N≥5 runs (omitted when <5 runs), CI not red, resource not critical}.
- **Outcome-monitoring, not per-action gating** (per Anthropic guidance). The single confirmed decision is repo + type; the run is guarded by the existing 10 kill-switches + checkpoints + verification gates.
- **One-time capture, guarded by config presence (no marker file).** Migration trigger fires at session-start when the committed `dispatcher-autonomy` block is absent; bootstrap covers new repos. Writing the block on any answer (incl. `off`) makes it present → exactly-once. Effective autonomy resolves host-local override (env / owner.yaml) > committed block > fail-closed `off`, mirroring the #653 host-path precedence.

### Data Model Changes
- **STATE.md frontmatter:** extend the session `status` vocabulary surfaced to the board with a terminal `force-closed` (derived, not a new persisted lifecycle state in STATE.md itself — computed by the sweep from a dead lease).
- **New vault file:** `01-projects/_active-sessions.md` (host-local, generator-marked).
- **New config block:** `dispatcher-autonomy:` in CLAUDE.md/AGENTS.md (outside `## Session Config` to avoid drift-check Check-6 parity, like `skill-evolution`). Its **presence is the one-time-capture guard** (no separate marker file). Effective value precedence: host-local override (env `SO_DISPATCHER_AUTONOMY` / owner.yaml) > committed block > `off`.
- **New learning type:** `autonomy-verdict` in `learnings.jsonl` (schema_version 1 compatible; subject form `<repo-or-scope>-autonomy-readiness`).

### API Changes
- **New CLI/skill:** `/dispatcher` (enumerate → rank → confirm → claim → route). JSON-first per `cli-design.md` (`--json`, exit codes 0/1/2).
- **New config getter:** `dispatcher-autonomy` exposed on the parsed `$CONFIG` object.
- **No HTTP endpoints.**

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| Collision with sven-owned `_overview.md` | Vault writes clobbered / data loss | Plugin uses only generator-marked surfaces; respect the existing "no marker → never touch" rule; assert in board/narrative writers |
| Two-terminal race for the same free repo | Duplicate work / lock corruption | Atomic lease claim before launch (existing `session-lock` acquire); loser re-ranks; fencing via heartbeat ttl |
| `force-closed` false positives (slow session looks dead) | Healthy session shown as force-closed | Tie the sweep strictly to the v2 lease ttl + heartbeat (already tuned, 4h default); never infer from STATE.md alone |
| Autonomy gate over-trusts a repo (auto-launches a bad session) | Wasted tokens / risky changes | Fail-closed default `off`; AND-gate with CI/resource veto; all 10 kill-switches still apply; verdict is advisory until `autonomous-gated` is explicitly armed |
| One-time capture asks repeatedly or never | Operator annoyance / silent skip | Exactly-once via committed `dispatcher-autonomy:` block presence (no marker file); host-local override wins over the committed default; covered by tests for both bootstrap + migration triggers |
| `autopilot-effectiveness`/`autonomy-verdict` data-gated (needs ≥N runs) | Verdict weak early | Degrade gracefully to confidence + CI/resource signals only; learning sharpens over time; document the cold-start behavior |
| Board churn / merge noise if accidentally synced | Vault git noise across machines | Host-local by design; document git-ignore; generator-marked + idempotent skipped-noop on unchanged |
| Scope creep into multi-machine authoritative locking | Epic balloons past 6w | Explicitly out-of-scope; single-machine authoritative decided; follow-up only on demand |

### Dependencies
- **#660** `[tracking][vault] Named per-directory vaults + per-project write-isolation (commit-guard)`: cross-referenced; this epic delivers the per-repo vault visibility #660 anticipates (kept separate, not absorbed).
- **#305** `tracking: vault-integration warn → strict watcher`: related vault hardening; informs the mirror's mode handling.
- **#341** `tracking: Autopilot Phase D — multi-story worktree pipelines`: P3 loop-coupling aligns with autopilot evolution; cross-reference, no hard dependency.
- **#298** `[Phase C-4] /evolve type 8 — autopilot-effectiveness learnings`: P3.5 builds on this type; both still data-gated on real autopilot runs.
- **#653** host-local path resolution (shipped): the host-local board follows the same privacy-clean, machine-independent philosophy.
- **Reuse (no change required to land P1):** `session-lock.mjs` v2, `session-registry.mjs`, `vault-mirror/*`, `gitlab-portfolio/markdown-writer.mjs`.
