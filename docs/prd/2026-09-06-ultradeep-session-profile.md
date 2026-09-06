# Feature: ultradeep — ein benanntes Profil für die Session-Form, die bereits gefahren wird

**Date:** 2026-09-06
**Author:** Bernhard Götzendorfer + Claude (Session `main-2026-09-06-deep-1`, Discovery-Agent d14)
**Status:** Draft — Entscheidung im Synthesis-Gate der Session
**Appetite:** Medium Batch (2 Wochen); erster Schnitt in dieser Session
**Parent Project:** session-orchestrator

> Keine Issue-Nummern im Kopfbereich (archive-closed-prds.mjs archiviert PRDs mit geschlossenen `#NNN` im Header).

## 1. Problem

Die 5-Wellen-Form von `deep` deckt 744 von 902 ausgeführten deep-Sessions ab (82,5 %; gemessen 2026-09-06 über 3.262 `sessions.jsonl`-Records aus 46 Metrikdateien). **53 Sessions (5,9 %) liefen bereits mehr als 5 Wellen** (46×6, 6×7, 1×8). Diese Sessions haben jedes Mal dieselben Bausteine improvisiert: Research-Agenten mit Web-Zugriff, ein Koordinator-Synthese-Gate vor der ersten Implementierung, ein Reviewer-Panel statt einer Quality-Welle, eine Release-Welle. Nichts davon steht im Plan-Skill; jede Session leitet es neu her, mit unterschiedlichem Ergebnis und ohne Telemetrie, die die Abweichung sichtbar macht.

Der Mehrwert ist nicht eine neue Fähigkeit, sondern **eine benannte, messbare und reproduzierbare Form für eine bereits gefahrene Praxis.**

## 2. Entscheidung: Profil, nicht Enum-Wert

Ein vierter Enum-Wert berührt 48 Dateien (12 Code, 16 Skills/Commands/Hooks, 10 Docs, 10 Tests), davon 9 harte Closed Sets; `classifyMode()` wirft bei unbekanntem Wert, `telemetry/schema.mjs:83` degradiert still zu `other`, `session-close-backfill.mjs:71` labelt still `housekeeping`. Zwei stille Fehlmodi derselben Klasse wie CLAUDE.md-Gotcha #1020.

**ultradeep ist ein PROFIL über `session-type: deep`.** `/session ultradeep` wird in `commands/session.md` zu `session-type: deep` + `session-profile: ultradeep` aufgelöst (STATE.md-Frontmatter). Downstream sieht `deep`. Berührpunkte: ~8 Dateien. Telemetrie: additives optionales Feld `session_profile` (erlaubt per `docs/telemetry.md` § Schema evolution, kein Versions-Bump; der Server führt kein Enum, nur `MAX_SESSION_TYPE = 32`).

Von sieben Bedarfen sind fünf bereits Config-Keys (`wave-reviewers`, `max-turns`, `cross-repo`, `worker-pool`, `custom-phases`). Neu sind genau zwei Formen: die **Research-Rolle** und das **Synthesis-Gate**.

## 3. Definition

| Achse | deep (heute) | ultradeep |
|---|---|---|
| Wellen | 5 | 7 |
| Rollen | Discovery, Impl-Core, Impl-Polish, Quality, Finalization | Research + Code-Discovery, **Synthesis-Gate**, Impl-Core, Impl-Polish, **Review-Panel**, Quality, Release/Finalization |
| agents-per-wave | 6 (`deep: 18`) | `ultradeep: 18` (Research-Welle bis 18, Impl-Wellen ≤ 8) — die Override-Syntax parst beliebige Keys, kein Code-Change |
| max-turns | 25 | pro Rolle: 40 (Research/Discovery), 25 (Impl), 15 (Finalization) |
| Reviewer | `wave-reviewers.enabled: false` | `true`, `[architect-reviewer, qa-strategist, security-reviewer]` |
| Isolation | auto | `worktree` erzwungen, sobald #1070 (npm-Root in Worktrees) geschlossen ist; bis dahin `none` mit Scope-Manifesten |
| Web-Zugriff | keiner | Research-Rolle: `WebSearch`, `WebFetch`, `ref`-MCP; Belegpflicht URL + Abrufdatum (PSA-006-Analogon) |
| Modell | inherit | Opus für Research, Synthesis, Review-Panel, Impl-Core; Sonnet für Polish, Quality, Finalization (Fehler in den Opus-Wellen werden von keiner späteren Welle korrigiert) |

## 4. Wann wählen (Mode-Selector)

Empfohlen, wenn **mindestens zwei** Signale zutreffen (Zwei-Signal-Disziplin wie `host-resources.md` HR-104):

- Scope ≥ 8 Issues oder Complexity-Score 5–6 (Tier „Complex" ausgeschöpft)
- ≥ 5 Top-Level-Verzeichnisse in der Scope-Baseline-Owner-Boundary
- Research nötig (Frage nicht aus dem Repo beantwortbar)
- Release beabsichtigt (`version`-Bump im Scope)
- `carryover_ratio ≥ 0.30` in der letzten Session desselben Repos

Regel-Reihenfolge (first match): Express-Path-Bedingungen → housekeeping; ≥ 2 ultradeep-Signale → deep + Profil ultradeep; completion_rate < 0.50 → plan-retro; sonst deep mit Complexity-Tier.

## 5. Wellenform

| W | Rolle | Agents | Schreibt? | Gate danach |
|---|---|---|---|---|
| 1 | Research + Code-Discovery | ≤ 18, getrennt gescopet | nein | keins |
| 2 | **Synthesis-Gate** | **0 (koordinator-direkt)** | Audit-Report, STATE.md, Plan | **AUQ, blockierend** |
| 3 | Impl-Core | ≤ 8 | ja | Quality-Lite |
| 4 | Impl-Polish | ≤ 8 | ja | Quality-Lite |
| 5 | Review-Panel | 3 (read-only) | nein | Findings-Triage (RCR-007) |
| 6 | Quality | `min(cap, ceil((HIGH+MED)/3))` | Tests | Full Gate |
| 7 | Release/Finalization | ≤ 4 | ja | Full Gate + Publish |

W2 ist die einzige echte Änderung an der Wellen-Mechanik: sie dispatcht null Agenten und muss von der Empty-Role-Regel in `skills/session-plan/SKILL.md` Step 2 **explizit ausgenommen** sein — sonst löscht die Regel das Gate. Der Koordinator konsolidiert W1, schreibt `docs/audits/<datum>-<slug>.md` und stellt EINE `AskUserQuestion` (Scope bestätigen / kürzen / abbrechen).

## 6. Pflicht-Artefakte

1. `docs/audits/<YYYY-MM-DD>-<slug>.md` — vom Synthesis-Gate geschrieben, je W1-Agent Befund + Messkommando + Messzeit.
2. Decision Record — jede Gate-Entscheidung als STATE.md-Deviation; architekturrelevante als ADR.
3. CHANGELOG-Eintrag — ein Lauf ohne CHANGELOG-Delta ist ein Fehlalarm des Selektors (`ultradeep_missing_audit`-Event bei fehlendem Audit-Report).

## 7. Budgets (parity-exempt Block, außerhalb `## Session Config`)

```yaml
ultradeep:                    # <!-- consistency:exempt:parity-exempt-ultradeep-block -->
  max-agents-total: 60
  max-wall-clock-hours: 6
  max-output-tokens: 12000000 # ≈ 3,5 × deep-5w-Median (3.362.514, n = 49)
  on-breach: ask              # ask | stop
```

Prüfung nur am Inter-Wave-Checkpoint (nie mitten in einer Welle). 80 % → WARN, 100 % → AUQ bzw. harter Stop nach der laufenden Welle. Budgets werden erst nach drei gemessenen Läufen scharf (HR-105: keine Schwelle ohne Firing-Rate).

## 8. Kostenformel

`cost(session) = Σ_agents (token_in × price_in + token_out × price_out) + coordinator_tokens`; `overhead_ratio = total_token_output(ultradeep) / MEDIAN_DEEP_5W`. Rohdaten: `subagents.jsonl` (`token_input`, `token_output`, `total_cost_usd`), `sessions.jsonl` (`total_token_output`, `total_agents`). Baseline deep/5w: Median 3.362.514 Output-Tokens (n = 49; Maximum 2.013.195.505 ist korrupt und wird ausgeschlossen), `total_agents` Median 12 (n = 744). Wirtschaftlich, wenn `overhead_ratio ≤ 3.5` bei ≥ 2× geschlossenen Issues; nach dem dritten Lauf neu messen.

## 9. Akzeptanzkriterien (EARS)

- **AC-1** The system shall accept `ultradeep` as `/session` argument and resolve it to `session-type: deep` + `session-profile: ultradeep` in STATE.md frontmatter.
- **AC-2** When `session-profile: ultradeep` is active, session-plan shall produce a 7-wave plan whose wave 2 declares zero agents and `coordinator-direct: true`.
- **AC-3** While wave 2 is active, wave-executor shall not dispatch any `Agent()` call and shall not proceed to wave 3 until an AskUserQuestion has been answered.
- **AC-4** If a wave-2 plan contains zero tasks, the Step-2 empty-role rule shall NOT remove the wave.
- **AC-5** When wave 1 dispatches, `WebSearch`/`WebFetch` shall be granted only to agents whose role is `Research`, never to a write-capable agent.
- **AC-6** While the profile is active, the telemetry client shall emit `session_type: "deep"` and `session_profile: "ultradeep"`; never `session_type: "ultradeep"`.
- **AC-7** When any `ultradeep.max-*` budget reaches 100 % at an inter-wave checkpoint, the system shall stop dispatching further waves and surface an AskUserQuestion.
- **AC-8** If a session closes with the profile active and no file under `docs/audits/` was created, session-end shall record `ultradeep_missing_audit` in `events.jsonl`.
- **AC-9** The system shall reject `/session ultradeep` in a repo whose Session Config sets `waves < 7`, naming the conflict.

## 10. Tests (je ein benannter Bug, TV-001)

| AC | Test | Gefangener Bug |
|---|---|---|
| 1 | `tests/commands/session-argument-alias.test.mjs` | Alias fällt still auf `deep`, Profil verschwindet |
| 2/4 | `tests/skills/session-plan/ultradeep-wave-shape.test.mjs` | Empty-Role-Regel löscht das Synthesis-Gate |
| 5 | `tests/lib/wave-executor/research-tool-grant.test.mjs` | write-fähiger Agent erhält Web-Tools |
| 6 | `tests/telemetry/profile-field.test.mjs` | `session_type: ultradeep` im Ping → serverseitig `other` |
| 7 | `tests/lib/ultradeep-budget.test.mjs` | Budget-Prüfung killt Agenten mitten in der Welle |
| 9 | `tests/lib/config-schema-ultradeep.test.mjs` | `waves: 5` + Profil → 2 Wellen still verloren |

## 11. Migration

- Kein neuer Enum-Wert → 3.262 historische Records bleiben valide; `claude-md-drift-check` Check 6 (Key-Parität) unberührt; der Budget-Block liegt außerhalb `## Session Config` mit `consistency:exempt`-Marker.
- `session_profile` ist ein additives optionales Feld (Schema v1). Vor dem Merge prüfen, ob `server/ingest/validate.mjs` unbekannte Felder durchlässt.
- Reihenfolge: Alias + Profil-Feld + 7-Wellen-Plan → Synthesis-Gate-Ausnahme mit Test → Budgets nach drei gemessenen Läufen.

## 12. Granularität (Begleitentscheidungen)

- Feiner: Quality → Review-Panel (read-only, immer) + Test-Writing (Kapazität verdient); Discovery → Code-Discovery + Research; `max-turns` pro Rolle.
- Breiter: `feature` als Alias auf `deep` deprecaten (94 von 3.262 Records = 2,9 %; 40 der 72 ausgeführten liefen die vollen 5 Wellen). `housekeeping` bleibt (Express-Path-Spur, 94 % wellenlos).

## 13. Offene Fragen

1. Verwirft `server/ingest/validate.mjs` unbekannte Felder?
2. Warum fehlt `sessions.jsonl` in diesem Repo (betrifft die Kostenmessung des ersten Laufs)?
3. `total_token_output`-Maximum 2.013.195.505 ist korrupt — Aggregations-Bug vor jeder Budget-Schwelle klären.
4. Modell-Defaults sind Fehlerpropagations-Argument, nicht Messung — A/B über zwei Läufe.
