# Feature: Verschlankung — den vorhandenen Fast-Path zum Feuern bringen, statt einen zweiten zu bauen

**Date:** 2026-08-22
**Author:** Bernhard Götzendorfer + Claude (AI-gestützte Planung)
**Status:** Draft, Revision 2 — Optionen NICHT abgestimmt
**Appetite:** 1w `[ANNAHME]` (Revision 1 sagte 2w)
**Parent Project:** session-orchestrator

> **Revision 2 nach unabhängiger Prüfung — und sie hat die Hauptthese umgedreht.**
> Revision 1 schlug einen Housekeeping-Fast-Path vor. Der Prüfer wies nach, dass es ihn gibt: `skills/session-start/SKILL.md:1181`, **Phase 8.5 Express Path (#214)**, aktiviert bei `session_type: housekeeping` + Scope ≤ 3 Issues, ausdrücklich *„executes tasks coordinator-direct (bypassing session-plan and wave-executor)"*. Ebenso widerlegt: der zweite Arbeitsstrang (Regelkorpus) löste ein Problem, das nicht existiert — der Korpus liegt **unter** der Grenze.
> Was von Revision 1 hält: die Messung 22/30, die Phasenzahlen, die 12 abgeschalteten Subsysteme, die Löschkandidaten — letztere um **6 von 8** gekürzt, weil sie die eigene Zwei-Signale-Regel nicht bestanden.
> Das Ergebnis ist ein kleineres, richtigeres Dokument. Das Änderungsprotokoll steht am Ende.

> Schwester-Dokument zu [`2026-08-22-wellen-supervision.md`](./2026-08-22-wellen-supervision.md). Bewusst getrennt: die Befunde hier haben null Überschneidung mit Supervision und hängen nicht an deren Messung.

---

## 1. Problem & Motivation

### What

**(1) Die modale Session fährt keine Welle — und ob der dafür gebaute Fast-Path greift, weiß niemand.**

Eigene Messung über `.orchestrator/metrics/sessions.jsonl`, letzte 30 Sessions. `waves` ist ein **Array**, kein Zähler; ein Filter auf `.waves == 0` misst still gar nichts:

```
tail -30 .orchestrator/metrics/sessions.jsonl \
  | jq -s '{n:length, zero_wave_sessions: ([.[]|select(((.waves//[])|length)==0)]|length),
            by_type: (group_by(.session_type)|map({type:.[0].session_type, n:length,
                      zero:([.[]|select(((.waves//[])|length)==0)]|length)}))}'
```
```json
{ "n": 30, "zero_wave_sessions": 22,
  "by_type": [ {"type":"deep","n":7,"zero":0}, {"type":"housekeeping","n":23,"zero":22} ] }
```

22 von 30 Sessions fahren null Wellen, **alle 22 sind `housekeeping`** — und jede der 7 `deep`-Sessions hat Wellen gefahren. Der Session-Typ sagt den Wellen-Einsatz mit einer einzigen Ausnahme vorher.

Für genau diesen Fall existiert **Phase 8.5 Express Path (#214)**. Ob er greift, ist jedoch nicht feststellbar:

```
grep -n "express-path" CLAUDE.md                        → keine Treffer
node scripts/parse-config.mjs | jq '."express-path"'    → null
grep -c "express" .orchestrator/metrics/events.jsonl    → 0

grep -o '"express_path":[^,}]*' .orchestrator/metrics/sessions.jsonl | sort | uniq -c
   14  "express_path":false
    6  "express_path":true
    1  "express_path":{"activated":true      ← abweichende Form
  258  (Feld fehlt vollständig)
```

Drei Befunde in einem: der Konfigschlüssel ist im Parser **unbekannt** (`null`, obwohl der Skill-Text `default: true` behauptet), es gibt **kein** Ereignis in `events.jsonl`, und die Aktivierung ist in **258 von ~265** Sessions überhaupt nicht protokolliert — bei zwei verschiedenen Feldformen dort, wo sie es ist.

Das ist die Systemkrankheit dieses Repos („gebaut, aber nicht eingeschaltet", 6 Fälle an einem Tag am 2026-08-08) in ihrer Beobachtungs-Variante: **das Feature existiert, aber es ist unentscheidbar, ob es läuft.**

**(2) Zwölf eigene Subsysteme laufen im Referenz-Repo abgeschaltet, 42 dokumentierte Konfigschlüssel fehlen ganz.**

`enabled: false` in der eigenen `## Session Config` (`grep -c` → 12): `docs-orchestrator`, `vault-staleness`, `docs-staleness`, `moc-staleness`, `context-coverage`, `worktree-orphans`, `wave-reviewers`, `broken-window-budget`, `slopcheck`, `verification-auto-fix`, `frontend-slop-hook`, `reconcile`.

Dazu **42 Top-Level-Schlüssel**, die in `docs/session-config-template.md` dokumentiert sind, in `CLAUDE.md` aber fehlen und still auf ihren Default fallen. `scripts/parse-config.mjs` ist 149 Zeilen ohne Schlüssel-Allowlist — ein fehlender Schlüssel ist nie ein Fehler, immer ein stilles Aus. `express-path` (Befund 1) ist genau dieser Fall.

**(3) Der Learnings-Korpus wird zu unter einem Prozent gelesen — und die Zahl selbst ist instabil.**

144 Einträge / 210.217 Byte. Der je Dispatch injizierte Index (`node scripts/print-learnings-index.mjs | wc -c`) ergab in derselben Session **zweimal verschiedene Werte: 2.217 und 1.234** — der Index ist scope-abhängig, gekappt auf `LEARNINGS_INDEX_MAX_CHARS = 2000` (`scripts/lib/learnings/select.mjs:150`). Leserate: unter 1 %, aber **keine einzelne Byte-Zahl ist als Kennzahl brauchbar**; wer eine zitiert, zitiert eine Momentaufnahme eines Dateiscopes.

### Why

Alle drei Befunde sind dieselbe Sache: **Ebenen, die Kontext und Pflege kosten und deren Wirkung niemand messen kann.** Das Framework hat dafür bereits einen mechanischen Fänger (`check-unwired-features.mjs`); er findet unverdrahtete *Konfigschlüssel*, nicht unbeobachtbare *Phasen*.

Der harte Beleg, dass das Gewicht nicht theoretisch ist: von 144 Learnings betreffen **126** den eigenen Messapparat.
```
grep -cEi '"(subject|insight)":"[^"]*(test|gate|hook|validat|check-|lint|vitest|mock|assert|grep|audit|exit.code|guard|census|parity|regression|suite)' \
  .orchestrator/metrics/learnings.jsonl   → 126
```
*Rev-2-Korrektur: Revision 1 behauptete „58 von 144 (40 %)" **ohne Befehl** — ein Verstoß gegen die eigene EARS-Regel „jede Zahl trägt den Befehl". Der Prüfer maß 126 mit derselben Wortliste. Die obige Zeile ist der Befehl; die Zahl ist damit reproduzierbar und deutlich höher als behauptet.*

### Who

Jede Session in jedem Repo mit diesem Plugin — 21 Repos auf diesem Host mit `.orchestrator/`. Der Nutzen ist am größten bei den 73 % Housekeeping-Sessions.

---

## 2. Solution & Scope

### In-Scope `[ANNAHME]`

- [ ] **VS-1 — Express Path beobachtbar und konfigurierbar machen.** Nicht neu bauen: den Schlüssel `express-path` dem Parser bekannt machen, die Aktivierung als Ereignis emittieren, das `express_path`-Feld in `sessions.jsonl` auf **eine** Form vereinheitlichen. Danach ist die Frage „greift er?" beantwortbar — heute ist sie es nicht.
- [ ] **VS-2 — Belegte Löschungen, auf zwei Signale eingedampft.** Nur was **0 Invocations UND 0 eingehende Referenzen** hat. Nach Nachprüfung: 2 Skills, 3 Skripte, 1 Hook. (Revision 1 nannte 8 Skills und 6 Skripte.)
- [ ] **VS-3 — Ein Wirkungs-Messpunkt.** Vorher/Nachher für (a) Express-Path-Aktivierungsrate bei Housekeeping-Sessions und (b) entfernte LOC. Ohne ihn ist „schlanker" eine Behauptung.

### Out-of-Scope — mit Begründung, weil vier davon in Revision 1 noch In-Scope waren

- **Einen zweiten Housekeeping-Fast-Path bauen.** *Er existiert:* `skills/session-start/SKILL.md:1181` Phase 8.5, Vollbeschreibung in `phase-8-5-express-path.md`. Zusätzlich verzweigen Phase 7 und 7.1 bereits auf `housekeeping`. Ein zweiter Mechanismus wäre BV-001.1.
- **Den Always-on-Regelkorpus „unter die Grenze bringen".** *Er ist darunter.* Live gemessen über `computeInstructionBudget()` aus `scripts/lib/instruction-budget-guard.mjs`:
  ```
  totalDirectives 465 / 480    overBudget      false
  totalBytes  113.957 / 114.000  overByteBudget  false
  ```
  Revision 1 verglich eine rohe `wc -c`-Summe (114.758, **mit** Frontmatter) mit einer Grenze für eine Zahl **ohne** Frontmatter und schloss daraus „bereits darüber". Die bindende Achse ist ohnehin nicht Byte, sondern **Direktiven** (`tests/rules/receiving-review.test.mjs:43-51`). Was bleibt, ist eine Randbedingung, kein Arbeitsstrang: **15 Direktiven Luft** — jede neue Always-on-Regel muss sich das leisten können.
- **Die 216.698 Byte aus `session-start` + `session-end` als „Wellen-Apparat" kürzen.** Falsche Einordnung: `skills/session-plan/` und `skills/wave-executor/` sind **eigene Skills, die nur bei Aufruf geladen werden**. Von den 30 session-start-Phasen ist genau **eine** Wellen-Apparat (Phase 9, Handoff), plus Phase 7.5 als wellennah. Die übrigen sind Zustandsanalyse, Locking und Gedächtnis — was eine Housekeeping-Session am meisten braucht. Konkret: Phase 4 trägt die Projekt-Hygiene-Sonde, Phase 7 erzeugt im Housekeeping-Zweig per `token-audit.sh` + `claude-md-drift-check` **die Arbeitsliste der Session**. Wer die kürzt, entfernt Fähigkeit von genau dem Session-Typ, dem er helfen will.
- **`hooks/wave-scope-commit-guard.mjs` löschen.** Es ist **nicht** unverdrahtet: `git log --all -S"wave-scope-commit-guard" -- hooks/hooks.json` ist leer, weil es dort nie stehen sollte. Verdrahtet in `.husky/pre-commit:139`, dokumentiert in `SECURITY.md:174` und `.orchestrator/steering/structure.md:33` („intentionally NOT a plugin hook … #821, supersedes the #801 unwired-on-disk framing"), abgedeckt von 3 Testdateien. Revision 1 hat eine mit #821 geschlossene Frage neu aufgeworfen. **Das ist das bessere Lehrstück für ein falsches Todes-Signal als `bootstrap/`** — es hatte *kein* Todes-Signal, nur ein missverstandenes.
- **`skills/bootstrap/` löschen.** 0 Invocations, aber **25 eingehende Referenzen**; feuert per Konstruktion nur in frischen Repos. Die Null ist ein Stichproben-Artefakt.
- **Die 12 `enabled: false`-Subsysteme entfernen.** Als Block hochriskant: jedes hat Tests in der Suite und potenzielle Konsumenten in 20 weiteren Repos. Eigener Schnitt, pro Subsystem.
- **`session-config-reference.md` + `-template.md` zusammenlegen** (2.723 Zeilen). `claude-md-drift-check` Check 6 erzwingt Template↔CLAUDE.md-Parität für **jedes** nachgelagerte Repo; Schlüssel zu entfernen ändert dort die Urteile. Eigener Schnitt mit Flotten-Abstimmung.
- **STATE.md-Struktur umbauen.** Hängt am Supervisions-Strang.
- **Den tests:src-Korridor angreifen.** `node scripts/lib/tests-src-ratio.mjs --json` → **1,5204** bei Decke 1,60, `withinCorridor: true`. Innerhalb; `test-value.md` § TV-003 verbietet Pauschalschnitte.

---

## 3. Acceptance Criteria

### VS-1 — Express Path beobachtbar

```gherkin
Given eine Housekeeping-Session startet
When Phase 8.5 ausgewertet wird
Then entsteht genau ein Ereignis in .orchestrator/metrics/events.jsonl,
     das aussagt OB der Express Path aktiviert wurde und WARUM NICHT, falls nicht
```

```gherkin
Given der Schlüssel express-path steht in docs/session-config-template.md
When scripts/parse-config.mjs die Session Config liest
Then liefert es für express-path einen Wert und nicht null
  And der Default stimmt mit dem überein, was skills/session-start/SKILL.md:1183 behauptet
```

```gherkin
Given sessions.jsonl trägt heute zwei Formen (express_path: true und express_path: {activated: true})
When VS-1 abgeschlossen ist
Then schreiben neue Sessions genau eine Form
  And bestehende Records bleiben lesbar
```

```gherkin
Given 20 Housekeeping-Sessions sind nach VS-1 gelaufen
When die Aktivierungsrate ausgewertet wird
Then ist sie eine Zahl und keine Vermutung
  And falls sie 0 % ist, ist das ein Befund, kein Erfolg
```

### VS-2 — Belegte Löschungen

```gherkin
Given ein Löschkandidat
When über die Löschung entschieden wird
Then liegen ZWEI unabhängige Todes-Signale vor:
     0 Einträge in skill-invocations.jsonl UND 0 eingehende grep-Referenzen
       über skills/, scripts/, hooks/, commands/, agents/, tests/, docs/, .claude/rules/,
       .gitlab-ci.yml, package.json und .husky/
  And der Grep-Beleg steht im Commit
```

```gherkin
Given ein Kandidat hat nur ein Todes-Signal
When er bewertet wird
Then wird er zurückgestellt und nicht gelöscht
```

### VS-3 — Wirkungsmessung

```gherkin
Given VS-1 und VS-2 sind umgesetzt
When die Wirkung berichtet wird
Then trägt der Bericht Vorher- und Nachher-Zahl für
     (a) Express-Path-Aktivierungsrate und (b) entfernte LOC
  And jede Zahl trägt den Befehl, der sie erzeugt hat
```

### Edge Cases

```gherkin
Given ein Skill zeigt 0 Einträge in skill-invocations.jsonl
When seine Nutzung bewertet wird
Then wird auch events.jsonl geprüft
  And tmux-layout dient als Gegenbeispiel: 0 im Skill-Ledger, 4.098 tmux-layout.invoked-Ereignisse
```

```gherkin
Given ein Emitter hat 0 Records für einen Fehlerpfad
When das bewertet wird
Then wird 0 NICHT als "tot" gelesen
  And ein Fehlerpfad ohne je einen Record ist ununterscheidbar von einem kaputten Emitter
      (host-resources.md § HR-105)
```

---

## 3.A Acceptance Criteria (EARS)

**Ubiquitous:** Jede Löschung soll zwei unabhängige Todes-Signale samt Grep-Beleg vorweisen.

**Ubiquitous:** Jede Verschlankungs-Behauptung soll eine Vorher- und eine Nachher-Zahl samt erzeugendem Befehl tragen.

**Event-driven:** Wenn Phase 8.5 ausgewertet wird, soll genau ein Ereignis entstehen — auch bei Nicht-Aktivierung, mit Grund.

**Optional feature:** Wo `express-path.enabled: false` gesetzt ist, soll die Auswertung übersprungen und das Überspringen protokolliert werden.

**Unwanted behaviour:** Wenn ein Löschkandidat nur ein Todes-Signal hat, soll er zurückgestellt werden.

**Unwanted behaviour:** Wenn eine Änderung eine neue Always-on-Regel hinzufügt, soll sie gegen die verbleibenden 15 Direktiven geprüft werden, bevor sie landet.

---

## 4. Technical Notes

### Löschkandidaten nach Nachprüfung

Revision 1 nannte 8 Skills und 6 Skripte. Der Prüfer hat das zweite Signal für alle nachgemessen — **6 der 8 Skills fallen durch die eigene Regel**:

| Kandidat | Zweites Signal | Verbleibt? |
|---|---|---|
| `skills/spinout/` | referenziert aus `.claude/rules/development.md:72` — einer **Always-on-Regel** | ❌ raus |
| `skills/domain-model/`, `skills/ubiquitous-language/` | gepinnt von `tests/skills/architecture-ddd-trio.test.mjs` | ❌ raus |
| `skills/daily/` | 2 Testdateien + `docs/vault-docs-architecture.md` | ❌ raus |
| `skills/convergence-monitoring/` | 2 ADRs | ❌ raus |
| `skills/mcp-builder/` | 3 ADRs | ❌ raus |
| **`skills/contract-version-bump/`** | keine | ✅ Kandidat |
| **`skills/skill-creator/`** | keine | ✅ Kandidat |
| `scripts/lifecycle-sim-v6.mjs` | eigene Testdatei unter `tests/scripts/` | ⚠️ nur mit Test-Löschung |
| `scripts/backfill-learnings-expires.mjs` | eigene Testdatei | ⚠️ nur mit Test-Löschung |
| `scripts/migrate-learnings-jsonl.mjs` | als Konventions-Referenz zitiert von `scripts/migrate-cold-start-seed.mjs:146` | ❌ raus |
| **`scripts/upload-social-preview.mjs`**, **`scripts/migrate-subagents-jsonl.mjs`**, **`scripts/fleet-instruction-scan.mjs`** | keine | ✅ Kandidaten (~653 LOC) |
| **`hooks/post-tooluse-frontend-slop.mjs`** + `frontend-slop-hook:`-Block | `orchestrator.frontend_slop.warning` = 0 von 27.530 Ereignissen **und** `enabled: false` | ✅ in beiden Dimensionen tot |

**Verbleibende sichere Menge: 2 Skills, 3 Skripte (~653 LOC), 1 Hook.** Die Skills werden **degradiert** (aus der Standardliste genommen), nicht gelöscht — es sind Slash-Kommandos, ein Mensch kann sie morgen tippen.

Zwei Ereignisnamen mit 0 Records sind ausdrücklich **keine** Kandidaten: `orchestrator.session.lock.read_anomaly` und `orchestrator.session.lock.release_failed` sind Fehlerpfade; 0 kann korrekt sein (HR-105).

### Warum VS-1 kein Bau, sondern eine Verdrahtung ist

Die Mechanik steht. Was fehlt, ist an drei Stellen dasselbe: **Sichtbarkeit.**
1. `scripts/parse-config.mjs` kennt `express-path` nicht → der dokumentierte Default ist Prosa, kein Wert.
2. Kein Ereignis in `events.jsonl` → keine Aktivierungsrate berechenbar.
3. Zwei Feldformen in `sessions.jsonl`, in 258 von 265 Records gar keine → keine Historie.

Das ist ein Nachmittag Arbeit und beantwortet eine Frage, die sonst jede künftige Verschlankungs-Debatte neu stellt.

### Affected Files (Skizze)

- `scripts/parse-config.mjs` — `express-path` bekannt machen
- `skills/session-start/phase-8-5-express-path.md` — Ereignis-Emission bei Aktivierung **und** Nicht-Aktivierung
- `scripts/lib/` Sessions-Schema — `express_path`-Feldform vereinheitlichen
- `scripts/` — 3 Skripte entfernen
- `hooks/hooks.json` + `hooks/post-tooluse-frontend-slop.mjs` — Abgang
- Skill-Registrierung — 2 Skills degradieren
- Ein Messpunkt für VS-3

### Data Model / API Changes

Ein zusätzliches Ereignis in `events.jsonl` (Name beim Bau festzulegen, Form nach dem Vorbild bestehender `orchestrator.*`-Ereignisse) und die Vereinheitlichung eines bestehenden `sessions.jsonl`-Feldes. Keine neue Datei, kein neues Verzeichnis.

---

## 5. Risks & Dependencies

| Risiko | Impact | Mitigation | Triage |
|---|---|---|---|
| VS-1 zeigt, dass Express Path nie aktiviert — und es gibt keinen Plan dafür | mittel | Genau das ist der Zweck. Das Ergebnis geht als Issue weiter, nicht in diesen Schnitt | Experiment |
| Ein degradiertes Skill wird gebraucht und ist nicht auffindbar | mittel | Degradieren ≠ löschen | Implement |
| Ein gelöschtes Skript wird in einem der 20 anderen Repos aufgerufen | mittel | Vor dem Löschen `grep` über **alle** Repos mit `.orchestrator/` | Implement |
| **Löschungen kollidieren mit der Parallel-Session** | hoch | Am 2026-08-22 lagen **73** uncommitted Pfade (`git status --porcelain \| wc -l`) in `scripts/`, `hooks/`, `skills/`, `.claude/rules/`, `tests/`. **Erst nach deren `/close` beginnen** | Implement |
| Die 22-von-30-Messung veraltet | niedrig | An `sessions.jsonl` zum Stand 2026-08-22 gebunden; der erzeugende Befehl steht in § 1 | Implement |
| Eine neue Always-on-Regel verbraucht die verbleibenden 15 Direktiven | mittel | Vor dem Landen `computeInstructionBudget()` laufen lassen. Diese Randbedingung gilt für **jeden** Schnitt in diesem Repo, nicht nur für diesen | Implement |
| Der 1w-Appetit reicht nicht | niedrig | Ehrliche Schätzung: VS-1 ≈ 1 d · VS-2 ≈ 1–2 d · VS-3 ≈ 1 d = **3–4 d**. Revision 1 sagte 2w, hatte aber VS-3 (aufgelöst) und einen 4–6-d-Fast-Path-Bau darin | Implement |

### Dependencies

- **Parallel-Session `session-orchestrator-fa`** — hielt am 2026-08-22 73 uncommitted Pfade und hat am selben Tag `paths:`-Frontmatter an 16 Regeldateien ergänzt (gemessen 186.993 → 113.798 Byte Always-on, ≈ 18.300 Token je Dispatch). **Jede Regel-Zahl in diesem Dokument ist gegen den Stand nach dieser Änderung gemessen.** Restarbeit: **#1108**.
- **#1108** — Restarbeit Regel-Scoping. Berührt dieses Dokument nur noch als Randbedingung, nicht mehr als Arbeitsstrang.
- **#214** — Express Path. VS-1 ist dessen Verdrahtung, kein neues Feature.
- **#821** — schloss die Frage nach `wave-scope-commit-guard.mjs`. Hier nur als Gegenbeispiel zitiert.
- **#929** (Epic „Instrumente reparieren — Mechanik statt Prosa") — der passende Dach-Epic für VS-1 und VS-3.
- **#1035** (Epic „Eine Tatsache, zwei Kopien") — passt für die zwei `express_path`-Feldformen.
- **`2026-08-22-wellen-supervision.md`** — unabhängig.

---

## Rev-2-Änderungsprotokoll

| # | Beanstandung | Erledigung |
|---|---|---|
| 1 | VS-1 schlug einen Fast-Path vor, den es gibt (Phase 8.5 / #214) | **These umgedreht**: nicht bauen, sondern beobachtbar machen. Neuer Befund: Parser kennt `express-path` nicht, 0 Ereignisse, 258/265 Sessions ohne Feld |
| 2 | VS-3 (Regelkorpus) löste ein nicht existierendes Problem | **Arbeitsstrang gestrichen.** Live: 465/480 Direktiven, 113.957/114.000 Byte, `overBudget: false`. Bleibt als Randbedingung |
| 3 | 216.698 B als „Wellen-Apparat" falsch eingeordnet | Korrigiert: `session-plan`/`wave-executor` sind eigene, nur bei Aufruf geladene Skills; 1 von 30 Phasen ist Wellen-Apparat |
| 4 | `wave-scope-commit-guard.mjs` ist per Husky verdrahtet (#821) | Aus den Kandidaten entfernt, als Lehrstück für ein *missverstandenes* Todes-Signal nach Out-of-Scope verschoben |
| 5 | 6 von 8 Skills haben eingehende Referenzen | Liste auf 2 gekürzt, je Kandidat mit Fundstelle des zweiten Signals |
| 6 | Learnings-Index-Zahl falsch und instabil | Zwei eigene Messungen (2.217 und 1.234) offengelegt; die Byte-Zahl als Kennzahl verworfen |
| 7 | „58 von 144" ohne Befehl | Befehl ergänzt; Zahl ist **126**, nicht 58 |
| 8 | Skriptliste zu breit | Von 6 auf 3 gekürzt (~653 LOC); zwei mit Testdatei gesondert markiert, einer als referenziert entfernt |
| 9 | STATE.md-Deutung nicht messbar | Aussage vollständig entfernt — sie gehört zum Supervisions-Dokument, nicht hierher |
| 10 | 2w-Appetit unglaubwürdig | Auf 1w gesetzt, mit Aufschlüsselung. Der Umfang ist entsprechend kleiner |
| 11 | Veraltete Nenner | 27.311 → 27.530 Ereignisse; 63 → 73 dirty paths; tests:src 1,5201 → 1,5204 |
