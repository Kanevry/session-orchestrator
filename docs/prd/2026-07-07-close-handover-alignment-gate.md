# Feature: /close Handover-Alignment-Gate (AUQ vor der Übergabe)

**Date:** 2026-07-07
**Author:** Bernhard + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 1w (Small Batch) + 1 separates Follow-up-Issue (Telemetrie)
**Parent Project:** session-orchestrator — Epic #724 (Session-Lifecycle & Close-Friction)

## 1. Problem & Motivation

### What

Ein interaktives **Handover-Alignment-Gate** in `/close` (session-end): Bevor Carryover-Issues erzeugt werden und die Session an die Folgesession übergibt, stimmt der Koordinator offene Punkte per `AskUserQuestion` mit dem Operator ab — im Normalfall ≤2 AUQ-Calls (Status-Gate + eine Triage/Fragen-Runde); nur bei >4 Middle-Band-Items zusätzliche 4er-Batches nach dem Phase-3.6.3-Muster (Anthropic-Auto-Mode-/Linear-Autopilot-Muster). Dazu gehört ein neuer **Open-Questions-Kanal** (Agent-Report-Feld → STATE.md `## Open Questions` → Gate → Folgesession), damit ungeklärte Userfragen erstmals eine explizite Repräsentation haben.

### Why

Die Carryover-Erzeugung läuft heute komplett stumm: session-end Phase 1.2 (Partially Done), 1.3 (Not Started), 1.6 (SPIRAL/FAILED-Retro-Filing) und 5.3 (Issue-Erstellung) filen `[Carryover]`-Issues ohne jede Rückfrage. Alle 9 existierenden AUQs in session-end sind Quality-Gate-Escape-Hatches (vault-sync, drift, custom-phases, memory-proposals, worktree-cleanup) — keine fragt nach den offenen *inhaltlichen* Punkten der Session. Offene **Userfragen** haben systemweit keinen Kanal: kein `blocked`-Agent-Status (Enum ist `done|partial|failed`), keine STATE.md-Sektion, kein sessions.jsonl-Feld. Eine Frage, die ein Wave-Agent nicht klären konnte, verschwindet bestenfalls im Freitext eines Carryover-Issues; die Folgesession konsumiert Carryover nur als generisches Backlog. Operator-Beobachtung (repo-übergreifend): Sessions werden mit offenen Blockern/Fragen geclosed, die nie gestellt, sondern still akzeptiert und übertragen werden.

Gegencheck aus den Metriken: `effectiveness.carryover` ist in 44/44 Session-Records `0` (Mess-Blind-Spot — real wurden 3 `[Carryover]`-Issues gefiled), und die letzten ~11 Housekeeping-Sessions sind `abandoned` (Close-Through-Problem, Epic #724). Konsequenz für das Design: Das Gate muss **friction-minimal** sein — es feuert nur, wenn es offene Punkte gibt, und kostet im Normalfall ≤2 Prompts. Der Telemetrie-Blind-Spot wird bewusst NICHT hier gefixt (separates Follow-up-Issue).

### Who

Der Operator (Bernhard) in interaktiven Sessions (`/close` nach housekeeping/feature/deep) — auf diesem Host wie in allen Repos, die das Plugin nutzen. Autonome Kontexte (autopilot, headless `claude -p`) sind explizit ausgenommen: dort gibt es keinen User am Keyboard, das Gate skippt fail-open (Status quo = stilles Carryover).

## 2. Solution & Scope

### In-Scope

- [ ] **Candidate-Collection statt Sofort-Filing:** Phasen 1.2/1.3/1.4/1.6 sammeln Carryover-Kandidaten in eine In-Memory-Liste (mit Herkunft, Prio, Task-Text); gefiled wird ausschließlich in Phase 5 Schritt 3 (im Folgenden „5.3") auf Basis der Gate-Entscheidung. Aus Phase 1.4 (Emergent Work) werden nur UNFERTIGE/undispositionierte Emergent-Items Kandidaten („unfertig/undispositioniert" = bei Close weder Issue erstellt noch Arbeit abgeschlossen) — Doku-Issues für bereits abgeschlossene Emergent-Arbeit bleiben ungegated wie heute. Das Gate gated nur das OB der Erstellung; das Issue-Template bleibt quellen-spezifisch (1.2 → `[Carryover]`-Template, 1.4 → normales Issue).
- [ ] **Neue Phase 1.65 „Handover Alignment Gate"** in `skills/session-end/SKILL.md` — Position: nach Phase 1.6.6 (What-Not-To-Retry), vor Phase 1.7 (Metrics; die Gate-Entscheidung muss in die Carryover-Zählung einfließen): AUQ-Call 1 = Status-Gate, AUQ-Call 2 = Triage-multiSelect + bis zu 3 offene Userfragen.
- [ ] **Routing-Heuristik** (deterministisch, `scripts/lib/handover-gate.mjs`): auto-carry (nur im Gate-Summary gelistet, nicht abwählbar) für `priority:critical|high`-Kandidaten, SPIRAL/FAILED-Safety-Net-Items UND jeden Kandidaten OHNE Origin-Issue (Grill-Entscheidung: Drop ohne Origin-Issue wäre echtes Vergessen — Critical Rule `SKILL.md:853` bleibt wortwörtlich intakt); `medium|low`/not-started/emergent MIT Origin-Issue → Triage-multiSelect (vorausgewählt = carry), wobei Drop nur „kein `[Carryover]`-Duplikat" bedeutet — das Origin-Issue bleibt unverändert offen. Kein Auto-Drop in v1.
- [ ] **Open-Questions-Kanal:** optionales `OPEN-QUESTIONS:`-Feld im Wave-Agent-Report-Format (prose-only, wave-executor Boilerplate); Koordinator sammelt an Inter-Wave-Checkpoints in neue STATE.md-Sektion `## Open Questions` (Schreiben nur unter `withStateMdLock`, PSA-005); Eintrag in `skills/_shared/state-ownership.md` inkl. **Idle-Reset-Präservation**: die Sektion überlebt den completed→new Idle Reset analog `## What Not To Retry` (#623) — sonst wäre der Roundtrip (FA4) tot.
- [ ] **Folgesession-Roundtrip:** Carryover-Template (gitlab-ops) erhält optionale Sektion `### Open Questions`; ungeklärte Fragen bleiben in STATE.md `## Open Questions` erhalten; session-start rendert die Sektion als Forced-Read (analog What-Not-To-Retry, HISTORICAL-Guard, kein eigenes AUQ) und listet sie als Entscheidungs-Kandidaten im bestehenden Phase-8-Alignment-AUQ.
- [ ] **Session-Config-Key `handover-gate:`** (`enabled: true`, `max-open-questions: 3`) inkl. Parity-Pflege: `docs/session-config-template.md`, `docs/session-config-reference.md`, CLAUDE.md Session Config dieses Repos (drift-check Check 6).
- [ ] **Fail-open-Semantik:** Gate skippt (= alle Kandidaten carryoven, exakter Status quo) bei `enabled: false`, autopilot-Invocation (Embedded-Mode-Präzedenz: discovery unterdrückt AUQ per AUQ-004), headless/AUQ-Fehler, oder 0 Kandidaten + 0 offenen Fragen.
- [ ] **Tests:** Unit-Tests für `handover-gate.mjs` (Routing, Kandidaten-Normalisierung), Config-Parsing-Tests für den neuen Key, bestehende Parity-/Konsistenz-Gates bleiben grün.
- [ ] **Follow-up-Issue anlegen** (nicht implementieren): Telemetrie + Metrics-Blind-Spot (`effectiveness.carryover` überall 0; `session.ended`-Event ohne Carryover-Payload; Gate-Outcome-Event fehlt).

### Out-of-Scope

- **Neuer `blocked`-Agent-Status im wave-executor** — der In-Run-Blocker-Fluss (Major-Blocker-AUQ in wave-loop.md:712) existiert bereits; ein neues Status-Enum wäre ein Eingriff in Circuit-Breaker/Wave-History-Format ohne Notwendigkeit für das Gate.
- **Autopilot-/Headless-Beteiligung mit Timeout-Auto-Eskalation** — HITL-Timeout-Mechanik existiert in AUQ nicht nativ; Scope-Creep für v1.
- **Telemetrie-Implementierung + Metrics-Blind-Spot-Fix** — eigenes Follow-up-Issue (siehe In-Scope letzter Punkt); vermischt sonst Mess- mit Verhaltens-Thema.
- **sessions.jsonl-/events.jsonl-Schema-Änderungen** — folgt mit dem Telemetrie-Follow-up.
- **Auto-Drop trivialer Items (Linear-P4-Muster)** — v1 droppt nichts ohne explizite User-Abwahl („sicher" vor „bequem"); nachrüstbar, wenn Triage-Fatigue real beobachtet wird.
- **Änderungen an /goal, Backlog-Drain (Phase 1.3a) oder dem Recommendations-Banner** — bestehende Advisory-Mechanik bleibt unberührt.

## 3. Acceptance Criteria

### FA1 — Handover-Gate in session-end (Status + Triage)

```gherkin
Given eine interaktive Session mit ≥1 Carryover-Kandidat oder ≥1 offener Frage in STATE.md ## Open Questions
When /close Phase 1.65 erreicht wird
Then stellt der Koordinator AUQ-Call 1 (Status-Gate) mit den Optionen
  "Closen + Triage (Recommended)" | "Alle carryoven (ohne Triage)" | "Weiterarbeiten (Close abbrechen)"
And die Frage nennt die Anzahl der Kandidaten (nach Klasse) und der offenen Fragen
```

```gherkin
Given der User wählt "Closen + Triage"
When AUQ-Call 2 gerendert wird
Then enthält er genau eine multiSelect-Frage pro Kandidaten-Batch über die Middle-Band-Kandidaten (vorausgewählt = carry)
And bis zu handover-gate.max-open-questions (Default 3) Einzelfragen für die höchstprioren offenen Fragen, je mit 2-4 Antwort-Optionen (Empfehlung zuerst), die im ERSTEN Call mitreiten
And kein Call überschreitet 4 Fragen und keine multiSelect-Frage 4 Optionen (AUQ-003); bei >4 Middle-Band-Items wird im "Batch N of M"-Muster in 4er-Batches gebatcht (Entscheidungsbaum-Präzedenz: Phase 3.6.3 — 0→skip, 1-4→ein multiSelect, 5+→sequenzielle 4er-Batches)
```

```gherkin
Given der User wählt "Weiterarbeiten (Close abbrechen)"
When das Gate endet
Then bricht session-end sauber ab (kein Commit, kein Lock-Release, keine Issue-Erstellung)
And die Session bleibt offen; der Koordinator arbeitet mit den offenen Punkten weiter
```

```gherkin
Given eine Session ohne Carryover-Kandidaten und ohne offene Fragen
When /close Phase 1.65 erreicht wird
Then wird KEIN AUQ gestellt (Zero-Friction bei sauberem Close) und session-end fährt unverändert fort
```

### FA2 — Carryover-Erzeugung ist Gate-autoritativ

```gherkin
Given das Gate hat eine Triage-Entscheidung produziert (carry-Liste + drop-Liste)
When Phase 5.3 Carryover-Issues erstellt
Then werden ausschließlich Items der carry-Liste gefiled (auto-carry-Klasse + user-bestätigte Middle-Band-Items)
And abgewählte Items werden im Final Report unter "Dropped at Handover Gate" mit Begründungs-Slot dokumentiert
And VOR Phase 1.65 wird an keiner Stelle (1.2/1.3/1.4/1.6) ein [Carryover]-Issue erzeugt
```

```gherkin
Given ein Kandidat stammt aus einem geplanten Issue mit priority:critical oder priority:high, stammt aus dem SPIRAL/FAILED-Safety-Net (Phase 1.6), oder hat KEIN Origin-Issue
When die Routing-Heuristik läuft
Then wird er als auto-carry klassifiziert und im Status-Gate-Text gelistet, erscheint aber NICHT als abwählbare multiSelect-Option
```

```gherkin
Given ein Middle-Band-Kandidat MIT Origin-Issue wird im Triage abgewählt (Drop)
When Phase 5.3 läuft
Then wird kein [Carryover]-Issue erzeugt und das Origin-Issue bleibt unverändert offen
And der Drop wird im Final Report unter "Dropped at Handover Gate" mit Origin-Issue-Referenz dokumentiert
```

### FA3 — Open-Questions-Kanal (Agent → STATE.md → Gate)

```gherkin
Given ein Wave-Agent meldet in seinem Report eine OPEN-QUESTIONS:-Zeile (Frage + Kontext + optionale Antwort-Kandidaten)
When der Koordinator den Inter-Wave-Checkpoint verarbeitet
Then appendet er die Frage dedupliziert an STATE.md ## Open Questions im Format
  "- [ ] <Frage> (source: W<N>/<agent>, prio: high|medium|low)"
And der Schreibzugriff läuft unter withStateMdLock (PSA-005)
```

```gherkin
Given eine offene Frage wird im Gate (AUQ-Call 2) beantwortet
When das Gate abschließt
Then wird der Eintrag in STATE.md als "- [x] <Frage> → Antwort: <gewählte Option>" markiert
And impliziert die Antwort neue Arbeit, reiht der Koordinator sie als carry-Kandidat ein (Issue via Phase 5.3, Antwort als Kontext im Body); reine Entscheidungen ohne To-do werden nur in STATE.md + Final Report dokumentiert
And Fragen jenseits des max-open-questions-Caps bleiben unverändert "- [ ]" stehen
```

### FA4 — Folgesession-Roundtrip

```gherkin
Given beim Close verbleiben unbeantwortete offene Fragen
When ein Carryover-Issue erstellt wird
Then enthält es eine Sektion "### Open Questions" mit den unbeantworteten Fragen (gitlab-ops Carryover-Template)
```

```gherkin
Given STATE.md enthält eine non-empty ## Open Questions Sektion mit ≥1 unbeantworteter Frage
When session-start die Findings präsentiert
Then rendert es die Sektion als Forced-Read-Block (HISTORICAL-Guard, analog What-Not-To-Retry, ohne eigenes AUQ)
And das bestehende Phase-8-Alignment-AUQ nennt die offenen Fragen als Entscheidungs-Kandidaten für die Session
```

### FA5 — Konfiguration, Geltung & Fail-open (Edge Cases)

```gherkin
Given handover-gate.enabled: false in Session Config
When /close läuft
Then verhält sich session-end byte-identisch zum Status quo (alle Kandidaten werden ohne Rückfrage gefiled)
```

```gherkin
Given session-end wird aus autopilot heraus invoked (Embedded-Kontext) ODER AskUserQuestion ist nicht verfügbar/liefert einen Fehler
When Phase 1.65 erreicht wird
Then skippt das Gate fail-open mit einer WARN-Zeile und verfährt wie "Alle carryoven" (Status quo)
And der Close hängt niemals auf ein nicht beantwortbares AUQ
```

```gherkin
Given der neue Session-Config-Key handover-gate ist in docs/session-config-template.md eingetragen
When claude-md-drift-check Check 6 (session-config-parity) läuft
Then meldet er keine Key-Paritäts-Verletzung für dieses Repo
```

## 3.A Acceptance Criteria (EARS)

### Feature Area — Routing-Helper `scripts/lib/handover-gate.mjs`

**Ubiquitous:**
- The routing helper shall classify every carryover candidate into exactly one of `autoCarry` or `ask` (no candidate is dropped by classification).

**State-driven:**
- While session-end runs in an embedded/autopilot context (or AskUserQuestion is unavailable), the gate shall skip fail-open with a stderr WARN and treat every candidate as carry.

**Event-driven:**
- When a candidate carries `priority:critical` or `priority:high`, originates from the SPIRAL/FAILED safety-net, or has no origin issue, the helper shall route it to `autoCarry`.
- When a candidate with an origin issue carries `priority:medium`, `priority:low`, or no priority, or originates from not-started/emergent buckets (emergent = unfertige Phase-1.4-Items), the helper shall route it to `ask`.

**Optional feature:**
- Where `handover-gate.max-open-questions` is configured, the gate shall present at most that many open questions in AUQ-Call 2 (default 3, integer ≥0; 0 = keine Fragen im Gate, Kanal bleibt aktiv). Effektiv gedeckelt auf 3 Fragen im ersten Call (4-Fragen-Limit minus multiSelect); überzählige Fragen bleiben unbeantwortet `- [ ]` stehen (FA3-Semantik).

**Unwanted behaviour:**
- If the candidate list is empty and STATE.md has no unanswered open questions, then the gate shall emit no AUQ and produce an `autoCarry=[] / ask=[]` result.
- If a malformed candidate record is encountered (missing task text), then the helper shall route it to `ask` with a `malformed: true` flag instead of throwing.

### Feature Area — Config-Parsing `handover-gate`

**Ubiquitous:**
- The config layer shall expose `handover-gate.enabled` (boolean, default `true`) and `handover-gate.max-open-questions` (integer, default `3`).

**Unwanted behaviour:**
- If `max-open-questions` is malformed or negative, then the parser shall fall back to `3` with a stderr WARN (analog `reconcile.min-rule-days`-Semantik).

## 4. Technical Notes

### Affected Files

- `skills/session-end/SKILL.md` — neue Phase 1.65 (Handover Alignment Gate); Phasen 1.2/1.3/1.4/1.6 auf Candidate-Collection umstellen (kein Sofort-Filing; 1.4 nur für unfertige Emergent-Items); Phase 5.3 konsumiert die carry-Liste; Final Report um "Dropped at Handover Gate" ergänzen.
- `skills/session-end/plan-verification.md` — Kandidaten-Record-Format (task, source-phase, origin-issue, priority, bucket) neben den bestehenden 1.1-1.4-Buckets dokumentieren.
- `scripts/lib/handover-gate.mjs` (neu) — pure functions: `routeCandidates(candidates)` → `{autoCarry, ask}`, `normalizeCandidate(raw)`; keine I/O, damit trivial testbar.
- `scripts/lib/config/…` bzw. `scripts/parse-config.mjs` — neuen Top-Level-Key `handover-gate` parsen (Muster: bestehende Block-Keys wie `state-md-lock`).
- `skills/wave-executor/wave-loop.md` — Agent-Report-Boilerplate: optionale `OPEN-QUESTIONS:`-Zeile; Inter-Wave-Checkpoint: Sammel-Anweisung (dedup, prio, `withStateMdLock`).
- `skills/_shared/state-ownership.md` — `## Open Questions` als kanonische STATE.md-Body-Sektion + Ownership (Koordinator-only Writer, Format-Spez).
- `skills/session-start/SKILL.md` — Forced-Read-Rendering der `## Open Questions`-Sektion (analog Phase 6.5.1 What-Not-To-Retry) + Erwähnung im Phase-8-Alignment + Idle-Reset-Schritt: `## Open Questions` in die Präservations-Liste aufnehmen (analog `## What Not To Retry`, #623).
- `skills/gitlab-ops/SKILL.md` — Carryover-Template: optionale Sektion `### Open Questions`.
- `docs/session-config-template.md`, `docs/session-config-reference.md`, `CLAUDE.md` (Session Config Block) — neuer Key + Doku (Check-6-Parität).
- `tests/` — Unit-Tests `handover-gate.test.mjs` (Routing-Matrix, malformed-Fälle), Config-Parsing-Tests (Defaults, malformed fallback).

### Architecture

Skill-Prose-first mit minimalem mechanischem Kern — dasselbe Muster wie memory-proposals (Phase 3.6.3): Der LLM-Koordinator führt die AUQ-Interaktion, eine kleine pure-`.mjs`-Lib macht die deterministische Klassifikation testbar. Kein Hook, kein neuer Agent, kein neues Event-Schema. Die Gate-Position (nach 1.6.6, vor 1.7) garantiert, dass alle vier Kandidaten-Quellen (Partially Done, Not Started, unfertige Emergent-Items, SPIRAL/FAILED-Walk) bereits berechnet sind, noch kein Issue gefiled wurde und die Gate-Entscheidung in die Phase-1.7-Carryover-Zählung einfließt. Fail-open ist die tragende Sicherheitsentscheidung: jeder Nicht-Interaktiv-/Fehlerpfad degradiert exakt zum heutigen Verhalten, nie zu Datenverlust. AUQ-Shapes folgen `.claude/rules/ask-via-tool.md` AUQ-003 (Empfehlung zuerst, 2-4 Optionen, ≤4 Fragen/Call); die Batching-Mechanik übernimmt das erprobte "Batch N of M"-Muster aus Phase 3.6.3.

### Data Model Changes

Keine DB. Neu: STATE.md-Body-Sektion `## Open Questions` (session-übergreifend persistent: STATE.md ist committed UND die Sektion wird beim completed→new Idle Reset explizit präserviert, analog `## What Not To Retry` #623); Format siehe FA3. sessions.jsonl/events.jsonl unverändert (Follow-up).

### API Changes

None (CLI/Skill-intern). Neuer Session-Config-Key `handover-gate` (additiv, abwärtskompatibel — fehlender Key = Defaults).

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| Mehr Close-Friction in einem Flow mit 27%-Close-Through-Problem (#724) | Operator bricht /close noch öfter ab | Gate feuert nur bei offenen Punkten (Zero-Friction bei sauberem Close); Fast-Path „Alle carryoven"; ≤2 AUQ-Calls im Normalfall (Middle-Band ≤4), darüber 1 Status-Gate + ⌈M/4⌉ Triage-Batches |
| Question-Fatigue / Rubber-Stamping, wenn Agenten OPEN-QUESTIONS fluten | Gate verliert Signalwert | Koordinator-Dedup bei Collection; Cap `max-open-questions: 3`; Middle-Band vorausgewählt (ein Enter = sinnvoller Default) |
| STATE.md-Write-Races bei paralleler Session | Verlorene/duplizierte Fragen | Alle `## Open Questions`-Writes unter `withStateMdLock` (PSA-005); Sektion in state-ownership.md verankert |
| Headless/autopilot hängt auf unbeantwortbarem AUQ | Blockierter autonomer Run | Fail-open-Skip (Embedded-Kontext, AUQ-Fehler, enabled:false) → Status-quo-Verhalten, WARN-Zeile |
| High-Prio-Arbeit wird im Triage versehentlich gedroppt | Verlust geplanter Arbeit | auto-carry-Klasse (critical/high + SPIRAL/FAILED + ohne Origin-Issue) ist nicht abwählbar; Drop mit Origin-Issue lässt das Original offen; kein Auto-Drop in v1 |
| Check-6-Parity-Bruch durch neuen Config-Key | Drift-Check rot in Konsumenten-Repos | Template + Reference + CLAUDE.md im selben Commit; additiver Key mit Defaults |

### Dependencies

- Epic #724 (Session-Lifecycle & Close-Friction): offen, in-progress — dieses Feature wird dort als Feature-Area angebunden.
- #459 (persona-panel Carryover-Generierung): offen, related — nutzt später dieselbe Gate-autoritative carry-Liste.
- #261 (closed): Prior Art — SPIRAL/FAILED-Eskalation ohne Carryover-Issue; die dortige Safety-Net-Lösung (`spiral-carryover.mjs`) bleibt als auto-carry-Quelle erhalten.
- `.claude/rules/ask-via-tool.md` (AUQ-001/003/004) und `skills/_shared/state-ownership.md` (PSA-005-Lock): normative Grundlagen, keine Blocker.
- Follow-up-Issue (wird in Phase 6 miterstellt): Handover-Gate-Telemetrie + Metrics-Blind-Spot (`effectiveness.carryover` 0 in 44/44 Records, `session.ended` ohne Carryover-Payload, Gate-Outcome-Event) — `priority:medium`, related zu #724.
