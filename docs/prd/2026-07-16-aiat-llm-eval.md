# Feature: aiat-llm-eval — Eval-Standard v1 + `/eval` Skill (Session-Prozess-Eval)

**Date:** 2026-07-16
**Author:** Bernhard + Claude (AI-assisted planning)
**Status:** Approved (Reviewer 1/3 PASS + Operator-Freigabe 2026-07-16)
**Epic:** #803
**Appetite:** 2w
**Parent Project:** session-orchestrator

## 1. Problem & Motivation

### What

Wir kodifizieren die in drei AIAT-Produktions-Eval-Programmen (PDF-Accessibility-Engine, Doc-VLM-Benchmark, PDF-Remediation-Tool) und im Meta-Vault erarbeiteten LLM-Eval-Best-Practices zu einem versionierten, öffentlichen Standard — **aiat-llm-eval v1** — und bauen den ersten Consumer: einen `/eval` Skill, der jede Orchestrator-Session als Session-Prozess-Eval gegen eine Rubrik bewertet (deterministisch zuerst, optionaler advisory LLM-Judge) und pro Run einen KPI-Record schreibt (Modell-ID, Modell-Provenienz, Plugin-Version, Plattform, Tokens, Scores). Jeder Run erzeugt zusätzlich einen eigenständigen, reproduzierbaren HTML-Report (sichtbare Evidenz, per-Dimension-Drill-down).

Der Standard ist die Grundlage für zwei spätere, hier explizit ausgeklammerte Ausbaustufen: ein öffentliches Leaderboard auf session-orchestrator.com und Modell-Experimente/Finetuning-Vergleiche, die dasselbe Record-Schema nutzen.

### Why

Drei Treiber:

1. **Der Standard existiert, ist aber verstreut.** Pre-Registration, Deterministic-before-Judge, frozen content-hashed Gold, per-Dimension-Scores (nie ein Globalscore), κ-Kalibrierung mit Bootstrap-CIs, Infra-Split (Tech-Fehler ≠ Modell-Fehler), Wilson-CIs mit Tie-Ehrlichkeit, Append-only-Run-Records mit voller Versions-Provenienz — all das ist in den drei Quell-Programmen und im Meta-Vault erarbeitet und teils mehrfach bezahlt worden. Ohne Kodifizierung driftet es und ist nicht wiederverwendbar.
2. **session-orchestrator misst sich selbst heute nicht nach diesem Standard.** Modell-ID und Modell-Version werden in keinem Metrics-Stream erfasst (grep-verifiziert über sessions/events/learnings/autopilot/subagents/audit.jsonl: 0 Treffer für ein Modell-Feld). Damit ist keine spätere Auswertung „welches Modell/Setup liefert welche Session-Qualität" möglich — genau die Datenbasis, die ein Leaderboard und anonyme Auswertungen brauchen.
3. **Publikations-Vorbereitung.** Eine geplante AI:AT-Artikelserie zu ehrlicher LLM-Messung (Launch ab August 2026, separat gemanagt, nicht Teil dieses Repos) referenziert denselben Standard. Saubere Trennung: dieses Repo liefert Standard + Tooling (englisch, öffentlich); die Serie liefert Narrativ und Zahlen aus ihren eigenen Programmen. Synergie ohne Vermischung.
4. **Der Markt-Gap ist real, aber nur als Fusion.** Landscape-Research (2026-07-16): Reproduzierbarkeits-Scaffolding (BridgeBench-Journal/Offline-Replay, Inspect-AI-Logs), CIs (Artificial Analysis), objektives Grading (LiveBench/Aider), agentic Benchmarks (Terminal-Bench/SWE-bench) und EU-Achse (EuroEval) existieren jeweils einzeln — **niemand kombiniert offene Pre-Registration + reproduzierbare Standalone-Run-Reports + CI-/Tie-Ehrlichkeit + agentic Sessions + Sovereignty-Achse + per-Use-Case-Verdicts.** Pre-Registration ist die am wenigsten kopierte Praxis im ganzen Feld und strukturell schwer nachrüstbar. Der Hook für Praktiker ist eine *Aktion*, keine Lesestoff-Seite: `/eval` läuft gegen die eigene Session und liefert einen Report, den man besitzt.

### Who

- **Primär:** Operator dieses Repos (Bernhard) — jede Session bekommt am Close einen Eval-Record + Report; Qualitätstrends werden sichtbar.
- **Sekundär:** Nutzer des session-orchestrator-Plugins (Claude Code + Codex CLI) — können `/eval` on-demand oder als opt-in Close-Phase fahren; optionaler selbstgewählter Handle statt erzwungener Anonymität.
- **Später (out-of-scope hier):** Leaderboard-Submitter und Leser der Artikelserie.

## 2. Solution & Scope

### In-Scope

- [ ] **S1 — Standard-Dokument `docs/eval/aiat-llm-eval-v1.md`** (englisch, öffentlich, versioniert): die kodifizierten Regeln des Standards, destilliert aus den drei Quell-Programmen + Meta-Vault (u.a. Pre-Registration, Deterministic-before-Judge, per-Dimension statt Globalscore, 3-State-Verdicts mit Abstention, „don't fake perfect" — undefined → `null`, Infra-Split, CI-/Tie-Ehrlichkeit, volle Versions-Provenienz pro Run, Append-only-Records, Kosten+Latenz als First-Class-KPIs, NDA-Firewall via Hashes). Quellen in tracked Files nur generisch benannt; das konkrete Repo-Mapping liegt in `docs/_private/aiat-llm-eval-sources.md` (gitignored).
- [ ] **S2 — Record-Schema + Sink**: `scripts/lib/eval/schema.mjs` (Zod-frei, Muster `skill-judgments-schema.mjs`/`audit.jsonl`), Append-only-Sink `.orchestrator/metrics/eval.jsonl` — **Journal als Single Source of Truth; der HTML-Report ist ein abgeleiteter, jederzeit rebuildbarer View** (BridgeBench-Muster). Felder u.a.: `schema_version`, `record_kind` (v1: `session-eval`), `run_id`, `session_id`, `standard_version`, `rubric_version`, `provenance {rubric_sha256, engine_commit}` (hash-gebundene Drift-Detection), `model {id, source}`, `harness {plugin_version, platform, host_class, hostname_hash}`, KPIs (Dauer, Waves, Agents, Tokens in/out, Carryover), `dimensions[]` (3-State + optional score), `handle` (optionales selbstgewähltes Pseudonym, default `null`), `anonymized`. Plus exportierte `SUBMISSION_FIELDS`-Whitelist (Data-Minimization für die spätere Submission — keine Pfade, Prompts, Repo-Namen).
- [ ] **S3 — Deterministischer Eval-Engine**: `scripts/eval-session.mjs` (CLI, `--json`, Exit-Codes 0/1/2 per .claude/rules/cli-design.md) + `scripts/lib/eval/*`-Module. Liest `sessions.jsonl`/`events.jsonl`/Quality-Gate-Evidenz und bewertet rubric-v1-Dimensionen deterministisch (L0). Fehlende Quelldaten ⇒ `cannot-determine`, nie geraten. Zusätzlich `--verify <run-id>`: credential-freies Offline-Re-Verify — re-evaluiert dieselbe Session aus den lokalen Quelldaten und diffed gegen den gespeicherten Record (deterministische Reproduzierbarkeit als ausführbarer Beweis, nicht als Behauptung).
- [ ] **S4 — `/eval` Skill + Command**: `skills/eval/SKILL.md` + `skills/eval/rubric-v1.md` + `commands/eval.md`. On-demand lauffähig; Claude-Code- UND Codex-kompatibel (skills/_shared/platform-tools.md, instruction-file-resolution.md). Modell-Capture: Koordinator-Self-Report mit `model.source`-Provenienzfeld (`self-report` | `env` | `config`) — ehrliche Kennzeichnung der Messquelle.
- [ ] **S5 — HTML-Run-Report**: eigenständige, self-contained HTML-Datei pro Run unter `.orchestrator/eval/reports/<run-id>.html` (gitignored, aus dem Record regenerierbar, keine externen Assets — portabel/hostbar ohne Backend): per-Dimension-Drill-down mit sichtbarer Evidenz je Check, KPI-Block, hash-gebundener Provenienz-Block (Modell + source, Plugin-Version, standard/rubric_version, rubric_sha256, engine_commit), Report-Header mit dem exakten Re-Verify-Kommando, Ehrlichkeits-Sektion **„What this report does not prove"** (u.a.: Einzel-Run ohne CIs, Judge uncalibrated, Selbstvermessung) + Anomalie-/Triage-Block (cannot-determine-Anteil, fehlende Quelldaten); byte-stabil (Zeitstempel als Parameter, kein `Date.now()` im Renderer).
- [ ] **S6 — /close-Integration**: neuer opt-in `eval:`-Config-Block (`enabled`, `mode: warn|off`, `judge: off|haiku|sonnet`, `report: html|none`, `handle`), Parser `scripts/lib/config/eval.mjs` (Muster `dialectic.mjs`, fail-fast auf unbekannte Werte), session-end-Phase nach Phase 3.7 (Session-Record existiert) und vor Phase 4 (damit `eval.jsonl` mit committet wird); advisory — blockiert nie den Close. Template-Parität: Keys auch in `docs/session-config-template.md` (drift-check Check 6).
- [ ] **S7 — Advisory LLM-Judge (opt-in)**: read-only Judge-Agent für subjektive Dimensionen, 1:1 nach dem skill-applied-judge-Muster (DI'd dispatch, untrusted-data nonce fence, Koordinator schreibt den Sink, per-call Budget, `validateModel()`); Output immer `advisory: true` + `calibration_status: "uncalibrated"` bis eine κ-Kalibrierung existiert (explizit spätere Ausbaustufe). *Circuit-Breaker-Kandidat: läuft die Appetite aus, wird S7 zuerst geshedded (deterministischer Kern S1–S6/S8 shippt ohne Judge vollständig).*
- [ ] **S8 — Tests + Docs + Domain**: vitest-Suites pro Modul (Fixture-Metrics-Tree, Fake-Regression für Negative-Assertions per .claude/rules/testing.md), E2E: `/eval` gegen Fixture-Session ⇒ Record + Report; README/components-Eintrag; Chore: Domain session-orchestrator.com registrieren (Operator; WHOIS 2026-07-16: „No match" = frei) + Namens-Handles defensiv prüfen.

### Out-of-Scope

- **Leaderboard-Site auf session-orchestrator.com** (Vercel, DB auf bestehender privater Infra, Submission-API/-Pipeline) — eigenes Follow-up-Epic; braucht erst gesammelte Records. Die Domain wird nur *gesichert*, nicht bebaut.
- **Golden-Task-Benchmark-Suite** (frozen Task-Set + Sandbox-Verifier für Modellvergleiche, SWE-bench/Terminal-Bench-Muster) — eigenes Epic; das Record-Schema sieht dafür nur den `record_kind`-Diskriminator vor (explizit vom Operator beauftragte Ausbaustufe, kein spekulatives Feature).
- **Finetuning-/Modell-Experimente** — späterer Consumer desselben Schemas.
- **κ-Kalibrierung des Judges** (Gold-Set, Persona-Panel, CI-basierte Graduierung) — der Judge bleibt in v1 explizit „uncalibrated/advisory"; Kalibrierung folgt dem Standard-Kapitel dazu, wenn genug Records existieren.
- **Anonyme Submission/Upload** — Schema-Vorbereitung ja (`SUBMISSION_FIELDS`, `handle`, Consent-Doktrin im Standard-Doc), Transport/Server nein.
- **Artikelserien-Content** — Narrativ, Zahlen, Launch-Plan der AI:AT-Serie bleiben außerhalb dieses Repos.

## 3. Acceptance Criteria

### FA1 — Standard-Dokument

```gherkin
Given ein frischer Checkout des Repos
When ich docs/eval/aiat-llm-eval-v1.md lese
Then finde ich einen versionierten Standard (standard_version "aiat-llm-eval/1.0") mit mindestens den Kapiteln: Prinzipien (inkl. Pre-Registration als Leitprinzip, Deterministic-before-Judge, per-Dimension statt Globalscore, 3-State-Verdicts, Don't-fake-perfect, Infra-Split, Versions-Provenienz, CI-/Tie-Ehrlichkeit, Journal-as-SSOT mit Reports als derived Views, Offline-Re-Verify), Record-Schema-Referenz, Judge-Doktrin (advisory bis kalibriert), Consent-/Privacy-Doktrin (opt-in, Data-Minimization, optionaler Handle), Limits-Kapitel ("What this standard does not claim" — keine Superlative, kein Globalscore, Reproduzierbarkeit = Evidenz+Scoring-Replay, nie deterministische Modell-Outputs), Governance (Versionierung des Standards selbst)
And kein tracked File nennt Quell-Repo- oder Kundennamen (Owner-Leakage-Scanner + Direktive 2026-07-02)
```

```gherkin
Given docs/_private/ ist gitignored (Eintrag existiert, .gitignore Zeile "docs/_private/")
When das Quell-Mapping docs/_private/aiat-llm-eval-sources.md geschrieben wird
Then ist es via git check-ignore als untracked/ignoriert verifiziert
```

### FA2 — Record-Schema + Sink

```gherkin
Given eine abgeschlossene Session mit Session-Record in sessions.jsonl
When ein Eval-Run einen Record erzeugt
Then enthält der Record schema_version, record_kind "session-eval", run_id, session_id, standard_version, rubric_version, model.id, model.source ∈ {self-report, env, config}, harness.plugin_version, harness.platform, harness.host_class, KPI-Felder und dimensions[]
And der Record wird append-only in .orchestrator/metrics/eval.jsonl geschrieben (atomic append)
And handle ist null solange kein Handle konfiguriert ist
```

```gherkin
Given die exportierte SUBMISSION_FIELDS-Whitelist
When ein Record auf die Whitelist projiziert wird
Then enthält die Projektion keine Dateipfade, keine Prompts, keine Repo-Namen und keinen unhashed Hostname
And ein Test beweist das mit einem absichtlich kontaminierten Fixture-Record (Fake-Regression: Whitelist temporär erweitert ⇒ Test rot)
```

### FA3 — Deterministischer Eval-Engine

```gherkin
Given ein Fixture-Metrics-Tree mit vollständigen sessions/events-Daten
When node scripts/eval-session.mjs --session <id> --json läuft
Then liefert stdout valides JSON mit per-Dimension-Ergebnissen (jede Dimension: id, method "deterministic", status ∈ {pass, fail, not-applicable, cannot-determine}, evidence)
And es existiert KEIN aggregiertes Globalscore-Feld (kein overall/mean/total) — per Konstruktion wie im Standard gefordert
And Exit-Code ist 0
```

```gherkin
Given ein Fixture-Metrics-Tree, in dem events.jsonl fehlt
When der Engine eine Dimension bewerten soll, deren Quelldaten fehlen
Then ist deren status "cannot-determine" mit Begründung in evidence
And der Run schlägt NICHT fehl (Abstention statt Raten; Exit-Code 0)
```

```gherkin
Given ein geschriebener Eval-Record und unveränderte lokale Quelldaten
When node scripts/eval-session.mjs --verify <run-id> läuft (ohne Netzwerk, ohne Credentials)
Then wird die Session re-evaluiert und gegen den gespeicherten Record gediffed; bei Übereinstimmung Exit 0, bei Drift Exit 1 mit per-Dimension-Diff auf stdout
```

### FA4 — `/eval` Skill + Command (cross-platform)

```gherkin
Given Claude Code mit installiertem Plugin
When der Operator /eval aufruft
Then läuft der deterministische Engine, ein Record wird geschrieben, der Report (sofern report: html) erzeugt und ein kompaktes per-Dimension-Summary im Chat ausgegeben
And das Modell wird per Self-Report erfasst und model.source dokumentiert die Quelle
```

```gherkin
Given Codex CLI (SO_PLATFORM=codex, AGENTS.md statt CLAUDE.md)
When /eval dort ausgeführt wird
Then funktioniert der Flow ohne AskUserQuestion-/Agent-Tool-Abhängigkeit (Fallbacks per skills/_shared/platform-tools.md)
And der Record trägt harness.platform "codex"
```

### FA5 — HTML-Run-Report

```gherkin
Given ein geschriebener Eval-Record
When der Report-Renderer läuft
Then entsteht eine einzelne self-contained HTML-Datei (keine externen Assets/CDNs) unter .orchestrator/eval/reports/<run-id>.html
And sie zeigt: hash-gebundenen Provenienz-Block (Modell + source, Plugin-Version, standard/rubric_version, rubric_sha256, engine_commit, Session-ID), KPI-Block, per-Dimension-Drill-down mit Evidenz, Abstention-/Triage-Block, das exakte Re-Verify-Kommando im Header und eine "What this report does not prove"-Sektion (Einzel-Run ohne CIs, Judge uncalibrated, Selbstvermessung)
And der Renderer ist byte-stabil: gleicher Record + gleicher Zeitstempel-Parameter ⇒ byte-identisches HTML (Golden-File-Test)
```

### FA6 — /close-Integration

```gherkin
Given Session Config enthält eval.enabled: true und mode: warn
When /close die session-end-Phase nach 3.7 erreicht
Then läuft der Eval gegen die gerade geschlossene Session, eval.jsonl wird in Phase 4 mitgestaged
And ein Eval-Fehlschlag blockiert den Close NIE (advisory; WARN auf stderr)
```

```gherkin
Given Session Config OHNE eval:-Block (Default)
When /close läuft
Then wird die Eval-Phase übersprungen (Null-Overhead, byte-identisches Verhalten zu heute)
And claude-md-drift-check Check 6 meldet keine Parity-Verletzung (Keys in docs/session-config-template.md ergänzt)
```

### FA7 — Advisory Judge (opt-in)

```gherkin
Given eval.judge: haiku in Session Config
When der Eval-Run die Judge-Dimensionen erreicht
Then wird ein read-only Judge dispatcht (DI-Muster wie skill-judge.mjs), dessen Ergebnis advisory: true und calibration_status "uncalibrated" trägt
And Judge-Dimensionen sind im Record und Report klar von deterministischen getrennt (method "judge")
And bei eval.judge: off entstehen keine Judge-Dimensionen und kein Agent-Dispatch
```

### FA8 — Tests, Docs, Domain (Edge/Absicherung)

```gherkin
Given die komplette Test-Suite
When npm test läuft
Then sind alle neuen Module durch vitest-Suites gedeckt (Schema-Validierung happy+invalid, Engine gegen Fixtures, Renderer-Golden-File, Config-Parser fail-fast)
And mindestens eine Fake-Regression pro Negative-Assertion ist dokumentiert ausgeführt (.claude/rules/testing.md)
```

```gherkin
Given der Operator registriert session-orchestrator.com
When die Registrierung abgeschlossen ist
Then ist der Nachweis im Chore-Issue dokumentiert (Registrar + Datum); DNS/Vercel-Setup bleibt explizit dem Leaderboard-Epic vorbehalten
```

## 4. Technical Notes

### Affected Files

- `docs/eval/aiat-llm-eval-v1.md` — NEU: Standard-Dokument (englisch, öffentlich)
- `docs/_private/aiat-llm-eval-sources.md` — NEU (gitignored): Quell-Repo-Mapping + NDA-Kontext
- `scripts/lib/eval/schema.mjs` — NEU: Record-Schema, `SUBMISSION_FIELDS`, Validator
- `scripts/lib/eval/engine.mjs` — NEU: deterministische Dimension-Checks (liest sessions/events.jsonl)
- `scripts/lib/eval/report.mjs` — NEU: self-contained HTML-Renderer (byte-stabil)
- `scripts/eval-session.mjs` — NEU: CLI-Orchestrator (`--json`, Exit 0/1/2)
- `scripts/lib/config/eval.mjs` — NEU: `eval:`-Block-Parser (Muster `dialectic.mjs`)
- `skills/eval/SKILL.md`, `skills/eval/rubric-v1.md` — NEU: Skill + versionierte Rubrik
- `commands/eval.md` — NEU: Command-Wrapper
- `agents/eval-judge.md` — NEU (S7): read-only Advisory-Judge (Frontmatter per agents/AGENTS.md, `sandbox-tier: read-only`)
- `skills/session-end/SKILL.md` — Phase-Einschub nach 3.7 + Staging-Liste Phase 4 um `eval.jsonl` ergänzen
- `docs/session-config-template.md` + `docs/session-config-reference.md` — `eval:`-Keys (Check-6-Parität)
- `tests/eval/*.test.mjs` — NEU: Suites + Fixtures (`tests/fixtures/eval/`)
- `README.md` / `docs/components.md` — Komponenten-Eintrag (docs-parity Check 10 beachten)

### Architecture

- **Muster-Wiederverwendung statt Neubau:** Record-Shape nach `audit.jsonl` (`scripts/harness-audit.mjs` schreibt bereits `{rubric_version, harness_version, categories[], summary}`); Judge nach `scripts/lib/skill-judge.mjs` (advisory, DI'd dispatch, Koordinator schreibt); Config-Parser nach `scripts/lib/config/dialectic.mjs` (fail-fast); Phase-Gating nach dem 3.6.x-Advisory-Tail-Muster von session-end.
- **Rubric v1 (Session-Prozess-Dimensionen, deterministisch):** verification-evidence (Quality-Gate-Läufe + Exit-Codes vorhanden), plan-fidelity (Missions geplant vs. abgeschlossen, Carryover-Rate), gate-health (Full-Gate-Ergebnis der Session), process-safety (Destructive-Guard-/Loop-Guard-Events), efficiency-KPIs (Tokens/Dauer/Agents — reported, nicht benotet). Judge-Dimensionen (opt-in, advisory): instruction-adherence, report-quality. Exakte Check-Definitionen werden in `rubric-v1.md` pre-registriert, BEVOR der erste echte Run gewertet wird (Standard-Prinzip Pre-Registration).
- **Journal-as-SSOT, Report als derived View** (BridgeBench-Muster): `eval.jsonl` ist die einzige Wahrheit; HTML-Reports sind jederzeit aus Records rebuildbar. `--verify` macht Reproduzierbarkeit zum ausführbaren Beweis (Aider-Reproduce-Command + BridgeBench-Offline-Replay als Vorbilder).
- **Kein Globalscore per Konstruktion** — Schema hat kein overall-Feld; Aggregation (CIs, Trends, Rankings) ist Sache späterer Auswertung über viele Records, nicht des Einzel-Records. Einzel-Run-Reports labeln explizit „n=1, keine CIs".
- **Modell-Capture ehrlich:** Self-Report des Koordinators + `model.source`-Provenienz; wo `ANTHROPIC_MODEL`/Config verfügbar, wird die deterministische Quelle bevorzugt und als solche gekennzeichnet.
- **Cross-Platform:** Skill-Body nutzt nur platform-neutrale Bausteine; Engine/Renderer sind reine Node-CLIs (laufen auf beiden Harnesses identisch).

### Data Model Changes

Neuer Append-only-Stream `.orchestrator/metrics/eval.jsonl` (committed, wie sessions.jsonl; Rotation via events-rotation-Registrierung prüfen). Neue gitignorierte Artefakte unter `.orchestrator/eval/reports/`. Keine Änderungen an bestehenden Streams (additiv).

### API Changes

Keine (keine Endpoints in dieser Phase; Submission-API ist Leaderboard-Epic).

## 5. Risks & Dependencies

| Risk | Impact | Mitigation | Triage |
|------|--------|------------|--------|
| Modell-Self-Report falsch/lückenhaft (kein Harness-SSOT für die laufende Modell-ID) | KPI-Kernfeld unzuverlässig | `model.source`-Provenienzfeld; deterministische Quellen bevorzugen, wo vorhanden; Auswertungen können nach source filtern | Implement |
| Judge unkalibriert ⇒ Scheinpräzision | Glaubwürdigkeitsschaden für den Standard | Hard-Label `advisory + uncalibrated` in Record UND Report; Judge default off; κ-Kalibrierung als definierte Ausbaustufe im Standard-Doc | Implement |
| Leak von Quell-/Kundennamen in den öffentlichen Mirror | Direktiven-/NDA-Verstoß | Anonymisierte Quellen in tracked Files, Mapping nur in docs/_private/ (gitignored, verifiziert), Owner-Leakage-Pre-Commit-Scanner läuft ohnehin | Implement |
| Schema-Drift vor Leaderboard-Epic | Migrationsaufwand | `schema_version` von Tag 1, additive-only-Policy im Standard-Doc verankert, `SUBMISSION_FIELDS` als expliziter Kontrakt | Implement |
| Eval bewertet die eigene, noch offene Session (Timing) | verzerrte/leere Records | Phase läuft NACH 3.7 (Session-Record geschrieben); on-demand-/eval bewertet default die letzte abgeschlossene Session | Implement |
| Scope-Sog Richtung Leaderboard/Benchmark („wo wir schon dabei sind") | Appetite-Bruch | Explizite Out-of-Scope-Liste; Leaderboard-Epic separat; nur `record_kind`-Diskriminator als Schnittstelle | Implement |
| Über-Claiming des Standards (Marketing vor Substanz) | Reputationsrisiko | Limits-Kapitel im Standard-Doc + Report-Sektion "What this report does not prove"; drei harte Don'ts verankert: keine Superlative, kein Globalscore/aggregierter Index als autoritativ, Reproduzierbarkeit nur als Evidenz+Scoring-Replay claimen (nie deterministische Modell-Outputs) | Implement |

### Dependencies

- Session-Record-Schema v2 (`scripts/lib/session-schema.mjs`): Engine liest dessen Felder — additiv konsumieren, keine Änderung nötig: erfüllt
- `custom-phases`/Config-Parser-Infrastruktur + drift-check Check 6: existiert; Template-Parität ist Teil von FA6
- Domain-Registrierung: Operator-Aktion (Chore-Issue), blockiert nichts in diesem Epic
- Leaderboard-Epic (Follow-up): konsumiert `SUBMISSION_FIELDS` + `handle` + Consent-Doktrin aus diesem PRD
