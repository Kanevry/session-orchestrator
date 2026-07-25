# Feature: Context-Engineering — Messen, Routen, Trimmen

**Date:** 2026-07-24
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Approved
**Epic:** #874 (Epic A — dieses Repo) · #875 (Epic B — projects-baseline)
**Appetite:** 2w (Batch 1). Phase 3 „Trimmen" ist vollständig geplant und als Batch 2 terminiert — siehe § 2.5.
**Parent Project:** session-orchestrator (Epic A) + projects-baseline (Epic B)

**Issues:** Batch 1 → #876 (FA1) · #877 (FA2) · #878 (FA2b+c) · #879 (FA3) · #880 (FA5) · #881 (FA6-0) · #882 (FA6-1+2) · #883 (FA6-3). Batch 2 → #884 (T1) · #885 (T2) · #886 (T3) · #887 (T4) · #888 (T5) · #889 (T6) · #890 (T7) · #891 (T8).

> **Zwei Epics, eine PRD.** Epic A (FA1–FA3, FA5) ist repo-intern und teilt die These „Routing, nicht Inhalt". Epic B (FA6) ist Fleet-Deployment-Sicherheit in `projects-baseline` — anderes Repo, andere Fehlerklasse, **keine Code-Abhängigkeit zu Epic A**. Sie stehen hier zusammen, weil der Operator die Reichweite „Repo + Baseline-Fleet" gewählt hat und beide dieselbe Messgrundlage brauchen; sie werden als getrennte Epics gefiled und können unabhängig laufen.

---

## 0. Korrekturen aus der Umsetzung (2026-07-25, Session `main-2026-07-25-deep-1`)

> **Append-only Korrektur-Log.** Batch 1 (#876/#877/#878/#879/#880) wurde am 2026-07-25 geliefert. Die Umsetzung hat mehrere Behauptungen dieser PRD widerlegt und einige bestätigt. Der Originaltext unten bleibt stehen — die Korrekturen stehen hier, damit nachvollziehbar ist, was geglaubt und was gemessen wurde. Jede Zeile ist mit einem ausgeführten Transkript belegt (PSA-006).

### Widerlegt

| # | Behauptung der PRD | Gemessen | Konsequenz |
|---|---|---|---|
| K1 | § 3 FA2: `bySurface.coordinator + bySurface.wave === totalBytes` | Unerfüllbar — Tiers sind verschachtelt, nicht disjunkt. `102.401 + 62.391 = 164.792 ≠ 102.401` | Kriterium ersetzt durch `coordinator === totalBytes` + `always ⊆ wave ⊆ coordinator` |
| K2 | § 2.1 / § 3 FA2c: `eval-judge.md` überschreitet ein **1.024-Zeichen-Limit** | **Kein solches Limit existiert im Repo.** `validate-plugin` 140/0 auf dieser Datei | Ausreißer statt Verstoß; rangbasierte Top-N-Meldung statt Schwellwert |
| K3 | § 2.1 FA2c: Description-Fläche „**~27 KB**" | 27.200 Zeichen naiv vs. **34.808 Zeichen / 34.941 B** block-scalar-gefaltet (+27 %) | Die 27-KB-Zahl ist selbst das Produkt des naiven Scanners, vor dem die PRD warnt |
| K4 | § 2.1 FA2c: **2 Skills** nutzen Block-Scalar-`description:` | **22 SKILL.md** (+1 weitere Datei unter `skills/`); `agents/` und `commands/` null | Der blinde Fleck ist 11× größer als angenommen |
| K5 | § 2.2 FA3: Reference „dokumentiert bereits jeden Key"; Check 10b erzwinge CLAUDE.md↔Reference-Parität | `auto-skill-dispatch` fehlte in **beiden** Dateien. Check 10b vergleicht **Template→Reference** (`checker.mjs:1236-1244`), nie CLAUDE.md | Check 10b war strukturell blind für genau diese Lücke |
| K6 | § 1 / FA1: Die Suite bleibe grün, weil `spawnSync` „die Pipe laufend leert" | Falsch — die Race ist **schreiberseitig**. `execFileSync` trunkiert identisch bei 65.536 B | Grün war die Suite wegen **38-Byte-Fixtures**. Der Regressionstest braucht ein >64-KiB-Fixture, nicht einen anderen Spawn-Mechanismus |
| K7 | § 1 / FA1: Wave-Pfad 62.617 B, „trunkiert heute **nicht**", 2.919 B Restluft | Gilt nur für den **Default-Scope** (`allowedPaths: []`). Ein realistischer Wave-`allowedPaths`-Union misst **105.268 B** — 61 % über der Grenze | Der Wave-Pfad trunkierte **bereits**. Live beim Dispatch dieser Session getroffen: 37,7 % Verlust, dabei fielen `testing.md` und `verification-before-completion.md` **vollständig** weg |
| K8 | § 2.2 / FA5: Enforcement-Punkt sei `scripts/lib/validate-vendored-rules.mjs` | Das CI-verdrahtete Gate ist `scripts/lib/validate/check-rules.mjs` (`validate-plugin.mjs:244`). `validate-vendored-rules.mjs` läuft nur beim Vendoring | FA5 dort implementiert, wo es CI erreicht |
| K9 | FA5: „11 von 18 Rules ohne Aktivierungsachse **und** ohne Review-Datum" | Ohne Review-Datum: korrekt (11/18). Ohne Achse: **0/18** — alle tragen `tier:`, das der rule-loader als Gate honoriert | Echte unbedingte Last = `tier: always` = **62.538 B**, nicht 102.672 B |

### Bestätigt — nicht anfassen

62.617 B und 102.775 B (§ 1) reproduzieren exakt auf dem Baseline-Commit · 40.134 B `coordinator-only` (§ 1) exakt · „vier von elf `tier: coordinator-only`" exakt · 102.672 B für die 11 always-on-Rules exakt · „~27 KB" korrekt **als naive Zahl** (nur als Flächen-Gesamtzahl falsch etikettiert) · `validate-vendored-rules.mjs` hat tatsächlich nur einen Importer.

### Während der Umsetzung neu entdeckt

- **Der Fix für FA1 erzeugte zunächst eine eigene Regression:** das Entfernen von `process.exit(0)` änderte den EPIPE-Kontrakt — ein früh schließender Leser (`| head`, `| grep -q`) lieferte exit 1 plus Stacktrace statt exit 0. Da der wave-executor non-zero als „inject nothing" behandelt, hätte das **null Regeln** injiziert. Behoben im selben Durchlauf durch einen `stdout`-`error`-Handler; beide Verhalten sind jetzt getestet.
- **Die Bug-Klasse wurde im selben Change-Set reproduziert:** `scripts/lib/description-surface.mjs` — in derselben Session neu angelegt — trug `process.exit(0)` direkt nach `process.stdout.write`. Gefunden vom Quality-Panel, nicht vom Autor.
- **`validate-vendored-rules.mjs:278-285`** begründet seinen `paths-frontmatter`-Fehler damit, dass der rule-loader `paths:` nicht kenne. Seit #795 ist jede Einzelaussage dieser Meldung falsch (`rule-loader.mjs:275`/`:313`). Die *Absicht* (kanonisches `globs:`, siehe #742) bleibt gültig.

---

## 1. Problem & Motivation

### What

Die Instruction-Architektur dieses Repos liefert Text über **einen** Kanal — das Kontextfenster des Modells — an **vier** Konsumenten: das Modell (Verhalten), die Runtime (Policy), den Operator/Auditor (Nachvollziehbarkeit) und die Fleet (Codex, Cursor, Pi, 23 vendored Consumer-Repos). Anthropics Juli-2026-Guidance entwertet genau einen davon — das Modell — und dieser eine trägt die vollen Kosten für die anderen drei.

Der Architekturfehler ist **Routing, nicht Inhalt**. Erst ehrlich messen, dann korrekt routen, zuletzt trimmen.

Drei Befunde, gemessen am 2026-07-24:

1. **Der Auslieferungskanal ist bei 95,5 % Auslastung und verliert danach still Daten.** `scripts/print-applicable-rules.mjs` schreibt auf stdout und ruft unmittelbar `process.exit(0)` (`:235-236` JSON-Pfad, `:246-247` Markdown-Pfad). Über eine Pipe bricht das bei 65.536 B ab. Der **Live-Wave-Pfad** (`skills/wave-executor/wave-loop.md:331`) übergibt `--context wave` und erzeugt **62.617 B — 2.919 B unter der Grenze (95,5 %)**. Er trunkiert heute *nicht*; eine einzige mittelgroße Regel in einem `tier: always`- oder `tier: wave-only`-File kippt ihn, ohne Fehlermeldung und ohne dass ein Test es merkt. Der Koordinator-Payload (`--context coordinator`, 102.775 B) trunkiert dagegen reproduzierbar: **10/10 Läufe bei exakt 65.536 B**, Verlust **37.239 B / 36,2 %**, mitten im Satz. Vier Always-on-Rules fallen dabei vollständig weg (`quality-gates-autofix.md`, `receiving-review.md`, `security.md`, `verification-before-completion.md`); der Schnitt landet innerhalb von `parallel-sessions.md` (51.562–70.386 B) — also mitten in PSA-006, der Beweisstandard-Regel selbst. Kein Test kann das fangen: die Harness nutzt `spawnSync`, das die Pipe laufend leert, und die Fixtures sind ~100 B groß.

2. **Das Messinstrument misst das Falsche.** `instruction-budget-guard.mjs` zählt Markdown-Zeilen, die mit Bullet, Ziffer oder `##` beginnen. Verifiziert: **52,9 % der Always-on-Bytes** liegen auf Zeilen, die der Zähler nie ansieht (46,5 % Prosa, 6,1 % Code-Fences). CLAUDE.md wird nicht gezählt. ~27 KB Skill/Agent/Command-Descriptions ebenfalls nicht. Vier von elf gezählten Dateien sind `tier: coordinator-only` (40.134 B, 119 Directives) und erreichen nie einen Wave-Agent, werden aber voll berechnet. 455/480 ist damit kein Signal.

3. **Das byte-bewusste Instrument ist rot und abgeklemmt.** `claude-md-budget-lint.mjs` meldet für dieses CLAUDE.md `status: invalid` — **7 Verstöße** (6× Zeile über 400 Zeichen, 1× `max-lines`), plus `provenance-header` als achter, der nur unter `--require-provenance` feuert (Default `false`, `:83`). CLI-Default ist `--mode hard` (exit 1); die einzigen zwei Aufrufer stehen in `skills/bootstrap/` und übergeben `--mode warn`. Session-start ruft es nie auf.

Der Wachstumsstopper war nie der Ratchet. Es ist ein Pipe-Buffer mit 4,5 % Restluft.

### Why

Kein Einzeltreiber — allgemeines Verbesserungsthema mit ausgenutzten Synergien. Vier Gründe für jetzt:

- **Korrektheit vor Optimierung.** Der Koordinator-Pfad verliert heute 36 % seiner Regeln. Der Wave-Pfad ist eine Regel von derselben Klasse entfernt.
- **Jede Reduktions-Behauptung ist derzeit unbelegbar.** Genau daran ist #688 gescheitert — die Trim-Liste existiert seit Wochen und wurde unausgeführt geschlossen.
- **Distribution zementiert den Fehler.** v3.17.0 ist auf npm `latest`. `projects-baseline` verteilt per `cp` an 23 Repos; ≥5 inkompatible Generationen, **87 % der Fleet stale**.
- **Synergien sind reif.** Fünf offene Issues adressieren Teilaspekte, zwei laufen entgegen (§ 5).

Ehrlichkeits-Klausel: die „über 80 %", die Anthropic entfernt hat, sind **nirgends quantifiziert** (keine Token-, Zeilen- oder Byte-Zahl, kein benannter Eval-Suite) und betreffen **Claude Codes Produkt-System-Prompt** — eine Oberfläche, die der Artikel selbst als „you will likely never modify" bezeichnet. Keine Quelle empfiehlt, 80 % der eigenen CLAUDE.md zu löschen. Diese PRD adoptiert deshalb die dokumentierten, falsifizierbaren Zielwerte: CLAUDE.md < 200 Zeilen, SKILL.md < 500 Zeilen, und den Pro-Zeile-Test „Würde das Entfernen dieser Zeile Claude Fehler machen lassen?"

### Who

- **Primär: der Koordinator-Agent.** Er ist der einzige Agent, den die `globs:`/`tier:`-Mechanik strukturell **nicht** schützt, und der einzige, dessen Payload heute trunkiert. Er macht Routing, AUQ und Review — die Arbeit, bei der Instruction-Following am meisten zählt.
  > **Beweislage, explizit:** dass alle 18 Rule-Dateien den Koordinator erreichen, ist in-repo korroboriert (`docs/session-config-reference.md:1179`: *„the Claude Code harness injects ALL `.claude/rules/*.md` into the coordinator context regardless of each rule's `globs:` frontmatter"*, ebenso `:1008`), und die planende Session hat es first-person im eigenen Kontextfenster verifiziert. Die **primäre Messung des #687-Verdikts liegt im privaten Meta-Vault** und ist aus diesem Repo heraus nicht reproduzierbar. Wer die Behauptung nachprüfen will, prüft sie am eigenen Kontext, nicht an einem Repo-Artefakt.
- **Sekundär: die Wave-Agents** — heute nicht betroffen, aber mit 4,5 % Restluft die nächsten.
- **Tertiär: 23 Consumer-Repos** über `projects-baseline`, plus externe Adopter über npm/Marketplace.
- **Nicht adressiert in Batch 1: Codex-, Cursor- und Pi-Nutzer.** Risiken erfasst (§ 5), Umsetzung Batch 2 (T7).

---

## 2. Solution & Scope

### 2.1 Epic A / Phase 1 — Messen

- [ ] **FA1 — Delivery-Channel-Integrität.** Flush-vor-Exit an beiden Schreibstellen (`:235-236`, `:246-247`). Regressionstest mit >65.536-B-Fixture durch eine **echte Pipe** (nicht `spawnSync`). Zusätzlich Doc-Drift-Reparatur: der Code-Fence in `skills/_shared/config-reading.md:198` zeigt einen Aufruf **ohne** `--context`, während die kanonische Live-Invocation in `wave-loop.md:331` `--context wave` trägt — ein Agent, der dem Referenzdokument folgt, erzeugt den trunkierenden Aufruf.
- [ ] **FA2 — Ehrliche Messung.** `computeInstructionBudget` **additiv** erweitern: `totalBytes`, `perFile[].bytes`, `bySurface: {coordinator, wave, always}` via `entry.tier` + optionaler `context`-Param. Bestehende Felder (`totalDirectives`, `perFile[].count`, `ceiling`, `overBudget`, `severity`) bleiben unverändert. `countDirectives` (`:176`, aktuell nicht exportiert) exportieren, damit der Byte-Walk dieselbe Fence/Frontmatter-Logik nutzt.
- [ ] **FA2b — Den roten Lint verdrahten.** `claude-md-budget-lint.mjs` in session-start Phase 4 aufnehmen, damit die 7 Verstöße bei jedem Sessionstart sichtbar sind statt bei Bootstrap zu versanden.
- [ ] **FA2c — Description-Fläche messen** (Synergie #726). Die ~27 KB Frontmatter-Descriptions als dritte Messfläche erfassen. Zwei konkrete Defekte, die dabei sichtbar werden müssen: `agents/eval-judge.md` (1.180 Zeichen) liegt **über** dem 1.024-Limit, und `skills/eval/SKILL.md:16` + `skills/evolve/SKILL.md:18` schreiben ihre `description:` als **YAML-Block-Scalar** (`description: >`) — für einen zeilenbasierten `^description:`-Scanner unsichtbar, und nicht konform zur Check-11-Konvention, die `.claude/rules/anti-pattern-agents-md-…-a462fce.md` bereits dokumentiert. Der Scanner darf diesen Fehler nicht selbst machen.

### 2.2 Epic A / Phase 2 — Routen

- [ ] **FA3 — CLAUDE.md Kommentar-Diät.** Die 9.569 B erklärende `#`-Kommentarprosa aus dem `## Session Config`-Block (Zeilen 33–185) nach `docs/session-config-reference.md` verschieben, die bereits jeden Key dokumentiert (Check 10b erzwingt genau diese Parität). Keys bleiben, wo sie sind. Die fünf „Parser-Gotcha"-Kommentare werden **verschoben, nicht gelöscht** — sie kodieren einen echten Parser-Vertrag.
- [ ] **FA5 — Brandmauer für menschliche Autoren** (Synergie #723). Die Invariante aus `scripts/lib/reconcile/emitter.mjs` (Doc-Comment `:12-19`, durchgesetzt per `throw` in `:220`) — ≥1 Aktivierungsachse, `learning-key`, `expires-at` — symmetrisch auf handgeschriebene Rules anwenden und an `scripts/lib/validate-vendored-rules.mjs` durchsetzen. Macht Epic B (#723) sicher reaktivierbar, statt zur nächsten Akkretionsquelle.

### 2.3 Epic B / Phase 2 — Baseline-Fleet-Sicherheit

- [ ] **FA6 — in der vom Blast-Radius-Audit empfohlenen Reihenfolge:**
  - **FA6-0 (Prerequisite, blockiert alles Übrige):** `DRY_RUN` in `compliance-push.sh`, `sync-baseline.sh`, `setup-project.sh` verdrahten. Die Variable wird in `scripts/lib/common.sh:110` bereits geparst und in allen drei Skripten **ignoriert** (`grep -c DRY_RUN scripts/compliance-push.sh` → 0), obwohl die Hilfe sie dokumentiert.
  - **FA6-1:** Accounting-Korrektur 8 → 12 in `projects-baseline/{CLAUDE,AGENTS}.md:103/:101`, plus explizite Nennung der 4 zusätzlichen Always-on-Rules unter `templates/shared/` (Gesamt: 16, nicht 12).
  - **FA6-2:** Always-on-TOTAL-Budget, **warn-only auf dem gemessenen Wert** (632/480 = 132 %). Scan-Fläche von Anfang an inkl. `templates/shared/.claude/rules/` (4 Dateien, 31.546 B, 147 Directives = 23,3 % der Directives) — sonst entsteht ein Laundering-Kanal.
  - **FA6-3:** `globs:`-Frontmatter für `frontend-a11y-perf.md` (deklariert sich in der H1 als „Path-scoped", trägt aber keine Frontmatter → mechanisch always-on, 51 Directives).

### 2.4 Out-of-Scope (mit Begründung)

- **Vollständige Auslagerung des `## Session Config`-Blocks aus CLAUDE.md** — strukturell blockiert, siehe § 4 „Verworfene Alternative". FA3 holt **78,5 % des Byte-Gewinns bei null Blast-Radius**.
- **`autonomous-agent-safety.md` glob-scopen** — ursprünglich als Teil von FA6-3 geplant, **herausgenommen**: seine H1 deklariert „Always-on for any autonomous agent loop", ein `globs:` wäre dort eine **Verhaltensänderung an Safety-Direktiven**, keine Etikettenkorrektur. Es ist 52 der ursprünglich veranschlagten 103 Directives wert; ohne es lautet das FA6-Ziel **632 → 581**, nicht 529. Braucht ein eigenes Risiko-Review → Batch 2.
- **FA4 Platform/enforced-by-Achse** — nach YAGNI-Einwand nach Batch 2 (T7) verschoben. Die PRD hätte eine Achse gebaut, die sie selbst erst in Batch 2 anwendet, und `host-class:` mit **1 von 18** Adoptionen ist der direkte Beweis, dass eine ungenutzte Achse ungenutzt bleibt. Sie landet zusammen mit ihrem ersten Konsumenten.
- **`DEFAULT_BYTE_CEILING` + `byte-ceiling`-Config-Key** — dieselbe Logik: die Konstante kommt mit dem Gate, das sie liest. Batch 1 liefert nur die **Messung** (`totalBytes`, `bySurface`), kein Ceiling.
- **Ersetzen des Directive-Zählers durch ein Byte-Meter** — der Zähler ist der bessere Proxy für *Wachstum* (edit-förmig, monoton), das Byte-Meter für *Kosten*. Ein Byte-Ceiling unter dem Namen `ceiling` würde jeden Adopter-Wert still uminterpretieren.
- **Token-Zählung** — bräuchte einen Tokenizer und bräche die „stdlib-only"-Zusage beider Module.
- **Fleet-Migrations-Sweep über die 23 Consumer-Repos** — Batch 2 (T5). Zwei Repos tragen Hand-Edits größer als das Original; die müssen vorher gesichert werden.
- **`/doctor` als Automatisierung** — laufen lassen ja, verlassen nein: es trimmt CLAUDE.md, aber **keine Skill-Bodies**, und `claude doctor` im Terminal trimmt gar nichts (read-only).
- **#840** — während dieser Planung von einer parallelen Session **geschlossen** (Commit `654962c`, refs #870/#840/#864/#836). Die rule-scoping-Probe misst wieder korrekt; kein Batch-1-Aufwand mehr nötig.

### 2.5 Batch 2 — vollständig geplant, terminiert nach Batch 1

Auf Operator-Anforderung wird Phase 3 **jetzt** als Issues angelegt, nicht später rekonstruiert. Das schließt die Verlustklasse, an der #668 → #687 → #688 gescheitert ist: die Audit-Artefakte liegen nur im Vault, eine bei `docs/` beginnende Initiative entdeckt alles von Null neu.

| # | Batch-2-Arbeitspaket | Abhängig von | Quelle |
|---|---|---|---|
| T1 | #688-Trimliste ausführen (`lsp` ~4, `owner-persona` ~6, `development` §Code-Style ~8-10 + §Package-Lifecycle ~10-15, `quality-gates-autofix` ~10) | FA2, FA5 | #688 (geschlossen, Liste fertig) |
| T2 | `loop-and-monitor.md` (33.353 B = 32,5 % der Always-on-Last, `tier: coordinator-only`) nach ADR-0010/Doku pointer-isieren | FA4 (T7) | #688 |
| T3 | Die 8 belegten Widersprüche auflösen (C-1…C-8, § 5) | — | Audit dieser Session |
| T4 | Skills-Diät: `session-start` 1.119 Z., `session-end` 1.117 Z. gegen die 500-Zeilen-Grenze; 13 Monolithen ≥12 KB ohne Sub-Files splitten | FA2c | Anthropic-Doku |
| T5 | Fleet-Migrations-Sweep, per-Repo mit `git diff`-Review, nach Sicherung der 2 Hand-Edit-Divergenzen | FA6-0 | Blast-Radius-Audit |
| T6 | `/sunset-review` einmal vollständig über die kalte Skill/Flag-Tail (10+ Skills mit null Nutzung, ~25 Opt-in-Flags aus) | #595 | #866, Telemetrie-PRD |
| T7 | **FA4** `platform:`/`enforced-by:`-Achse anlegen **und anwenden**; Cursor-`.mdc` regenerieren (9 Dateien, 7 seit 2026-04-07 unverändert, mit dangling refs) | FA2 | #726 |
| T8 | `autonomous-agent-safety.md` Scoping-Entscheid mit eigenem Safety-Review | FA6-2 | § 2.4 |

**RISKY-KEEP, nicht trimmen** (aus #688 übernommen, hier bestätigt): `ask-via-tool.md`, `verification-before-completion.md`, `parallel-sessions.md`, `security.md`, `receiving-review.md`. Jeder Trim dort braucht ein eigenes Review unter `enforcement: strict`.

---

## 3. Acceptance Criteria

### FA1 — Delivery-Channel-Integrität

```gherkin
Given .claude/rules/ erzeugt einen Koordinator-Payload von 102.775 Bytes
When print-applicable-rules.mjs --context coordinator über eine Pipe konsumiert wird
Then wird der Payload vollständig geliefert, byte-identisch zum in-process berechneten Wert
And der Exit-Code ist 0
And das gilt in 10 von 10 aufeinanderfolgenden Läufen
```

```gherkin
Given ein hermetisches Fixture-Repo mit Rule-Dateien über 65.536 Bytes Gesamtgröße
When der Regressionstest den CLI durch eine echte Pipe konsumiert, nicht über spawnSync
Then assertiert er die Ausgabe-Byte-Länge gegen den in-process berechneten Wert
And der Test wird rot, wenn write-then-exit wieder eingeführt wird
```

```gherkin
Given der --json-Pfad mit derselben write-then-exit-Struktur in Zeile 235-236
When der JSON-Payload 65.536 Bytes überschreitet
Then wird er ebenfalls vollständig geliefert
```

```gherkin
Given der Code-Fence in skills/_shared/config-reading.md Zeile 198
When er mit der kanonischen Invocation in skills/wave-executor/wave-loop.md Zeile 331 verglichen wird
Then trägt er dieselbe --context wave Flag
And ein Agent, der dem Referenzdokument folgt, erzeugt keinen Aufruf ohne --context
```

### FA2 — Ehrliche Messung

```gherkin
Given computeInstructionBudget wird auf diesem Repo aufgerufen
When das Ergebnis inspiziert wird
Then enthält es totalDirectives, perFile[].count, ceiling, overBudget und severity unverändert
And zusätzlich totalBytes, perFile[].bytes und bySurface mit den Schlüsseln coordinator, wave, always
And bySurface.coordinator entspricht totalBytes
And es gilt die Verschachtelung always ⊆ wave ⊆ coordinator
```

> **Korrigiert 2026-07-25 (deep-1).** Das ursprüngliche Kriterium lautete `Summe von bySurface.coordinator und bySurface.wave entspricht totalBytes` — das ist **mathematisch unerfüllbar**. Die Tiers sind **verschachtelt, nicht disjunkt**: ein Wave-Agent bekommt `tier: always` + `tier: wave-only`, der Koordinator bekommt dieselben PLUS `tier: coordinator-only`. Eine Addition doppelt den `always`-Anteil. Gemessen am 2026-07-25: `coordinator 102.401` + `wave 62.391` = 164.792 ≠ `totalBytes 102.401`. Die gelieferte Implementierung (`scripts/lib/instruction-budget-guard.mjs`) pinnt die Nicht-Identität als Negativtest.

```gherkin
Given die bestehende Testsuite tests/scripts/instruction-budget-guard.test.mjs mit 25 Tests
When die additive Erweiterung eingespielt ist
Then bleiben alle 25 Tests grün
And DEFAULT_CEILING ist unverändert 480
And die strikte Überschreitungs-Semantik (Gleichheit ist nicht over) gilt weiter
```

```gherkin
Given countDirectives ist bisher modul-privat
When der Byte-Walk implementiert ist
Then nutzt er dieselbe exportierte Zeilenklassifikation
And Fences und YAML-Frontmatter werden in beiden Dimensionen identisch behandelt
```

### FA2b — Den roten Lint verdrahten

```gherkin
Given CLAUDE.md verletzt claude-md-budget-lint mit 7 Verstößen
When eine Session startet
Then rendert Phase 4 eine Warn-Zeile, die die Verstoßanzahl und die verletzten Regelnamen nennt
And der Sessionstart wird nicht blockiert
And der Exit-Code des Probes wird nicht als Gate ausgewertet
```

```gherkin
Given ein Repo, dessen CLAUDE.md alle Schwellen einhält
When eine Session startet
Then rendert Phase 4 keine Zeile für diesen Probe
```

### FA2c — Description-Fläche messen

```gherkin
Given agents/eval-judge.md trägt eine description von 1.180 Zeichen
When die Description-Fläche gemessen wird
Then wird eval-judge.md als größter Eintrag der Description-Fläche ausgewiesen
```

> **Korrigiert 2026-07-25 (deep-1).** Das ursprüngliche Kriterium verlangte eine Meldung als „Überschreitung des 1.024-Zeichen-Limits". **Ein solches Limit existiert nirgends im Repo** — verifiziert dort, wo ein Description-Gate stehen müsste: `grep -rn '1024' scripts/lib/validate/` → **0 Treffer**, `grep -rn '1024' .claude-plugin/` → **0 Treffer**. (Ein breiter `grep -rn '1024\|1,024'` über `scripts/ tests/ hooks/ skills/ docs/ .claude/` liefert **187 Zeilen in 73 Dateien** — durchweg `maxBuffer`-Arithmetik, `events-rotation`-MB-Grenzen und RAM-Rechnung, kein Description-Gate. Eine frühere Fassung dieses Absatzes nannte hier „20 Treffer"; diese Zahl war aus einem Agent-Report übernommen und **nicht nachgefahren** — genau der PSA-006-Fehler, den dieses Log korrigieren soll. Gefunden vom session-reviewer in Phase 1.8 derselben Session.) `validate-plugin` lässt `agents/eval-judge.md` mit 140/0 passieren. Die 1.180 Zeichen sind korrekt, aber sie machen die Datei zum **Ausreißer**, nicht zum **Verstoß**. Ein Kriterium, das gegen eine nicht existierende Regel prüft, wäre ein Assert-Nothing-Test.

```gherkin
Given skills/eval/SKILL.md und skills/evolve/SKILL.md schreiben description als YAML-Block-Scalar
When die Description-Fläche gemessen wird
Then werden beide mit ihrer tatsächlichen Zeichenzahl erfasst, nicht als leer
And der Scanner meldet die Block-Scalar-Form als Konventionsabweichung
```

### FA3 — CLAUDE.md Kommentar-Diät

```gherkin
Given CLAUDE.md mit 9.569 Bytes Kommentarprosa im Session-Config-Block
When die Prosa nach docs/session-config-reference.md verschoben ist
Then erzeugt node scripts/parse-config.mjs vor und nach der Änderung byte-identisches JSON
```

```gherkin
Given die fünf Parser-Gotcha-Kommentare, die dokumentieren dass bestimmte Key-Zeilen keinen Inline-Kommentar tragen dürfen
When die Diät angewendet ist
Then sind alle fünf in docs/session-config-reference.md wiederauffindbar
And keiner ist ersatzlos entfallen
```

```gherkin
Given claude-md-drift-check Check 6 vergleicht Spalte-0-Schlüssel
When die Diät angewendet ist
Then meldet Check 6 unverändert null Errors
```

### FA5 — Brandmauer für menschliche Autoren

```gherkin
Given eine neue handgeschriebene Rule-Datei ohne globs, ohne paths, ohne mode und ohne host-class
When validate-vendored-rules.mjs darüber läuft
Then meldet es einen Verstoß, dessen Meldung eine Aktivierungsachse verlangt
```

```gherkin
Given eine der 11 bestehenden Always-on-Rules ohne expires-at
When die Migration angewendet ist
Then trägt sie ein explizites Review-Datum
And sie lädt weiterhin always-on, bis sie bewusst gescoped wird
```

### FA6 — Baseline-Fleet-Sicherheit

```gherkin
Given compliance-push.sh wird mit --dry-run gegen mindestens ein Consumer-Repo aufgerufen
When der Lauf beendet ist
Then wurde in keinem Consumer-Repo eine Datei geschrieben, überschrieben oder gelöscht
And die Ausgabe listet, welche Dateien geschrieben und welche per rm -f entfernt worden wären
```

```gherkin
Given frontend-a11y-perf.md deklariert sich in seiner H1 als Path-scoped, trägt aber keine Frontmatter
When globs: ergänzt ist
Then matcht mindestens ein Pattern mindestens eine getrackte Datei im Ziel-Archetyp
And der Always-on-Directive-Zähler der Baseline sinkt von 632 auf 581
```

```gherkin
Given das Always-on-TOTAL-Budget wird eingeführt
When es erstmals läuft
Then umfasst seine Scan-Fläche sowohl .claude/rules/ als auch templates/shared/.claude/rules/
And es läuft warn-only auf dem gemessenen Ausgangswert
And es blockiert keine unbeteiligte Regeländerung
```

### Edge Cases

```gherkin
Given ein Repo ohne .claude/rules/ Verzeichnis
When computeInstructionBudget aufgerufen wird
Then liefert es eine sichere Leerform und wirft nie
```

```gherkin
Given ein Adopter-Repo auf einer älteren Plugin-Version
When es eine Config mit unbekannten Kindschlüsseln unter instruction-budget liest
Then werden die unbekannten Schlüssel ignoriert und das Verhalten bleibt unverändert
```

---

## 3.A Acceptance Criteria (EARS)

### FA1 — Delivery-Channel-Integrität

**Ubiquitous:** Das CLI soll seinen vollständigen Payload liefern, unabhängig von Payload-Größe und Ziel-Deskriptor-Typ.
**Event-driven:** Wenn der Prozess terminiert, soll das CLI alle stdout-Schreibvorgänge abschließen, bevor der Exit-Code gesetzt wird.
**Unwanted behaviour:** Falls ein Payload unvollständig geliefert würde, dann soll der Regressionstest fehlschlagen.
**Optional feature:** Wo `--json` gesetzt ist, soll dieselbe Vollständigkeitsgarantie gelten.

### FA2 — Ehrliche Messung

**Ubiquitous:** Das Meter soll `totalDirectives` als Zeilen-Zähler und `totalBytes` als Byte-Zähler getrennt führen.
**State-driven:** Solange `instruction-budget.enabled` false oder `mode` off ist, soll das Meter `null` liefern, unabhängig von der Byte-Dimension.
**Event-driven:** Wenn die Directive-Zahl das Ceiling überschreitet, soll das Banner zusätzlich Byte- und Oberflächen-Zahlen nennen.
**Unwanted behaviour:** Falls ein neuer Konfigurationsschlüssel als Spalte-0-Schlüssel im Session-Config-Block landen würde, dann soll die Änderung abgelehnt werden — Kindschlüssel unter `instruction-budget:` sind der einzig zulässige Ort.

### FA6 — Baseline-Fleet-Sicherheit

**Ubiquitous:** Ein als Vorschau deklarierter Lauf soll nie in ein Consumer-Repo schreiben.
**Unwanted behaviour:** Falls `--dry-run` gesetzt ist und dennoch ein Schreibpfad erreicht würde, dann soll das Skript mit einem Fehler abbrechen statt zu schreiben.
**Optional feature:** Wo das Always-on-TOTAL-Budget aktiviert ist, soll es warnen und nie blockieren.

---

## 4. Technical Notes

### Affected Files

| Datei | FA | Änderung |
|---|---|---|
| `scripts/print-applicable-rules.mjs` | FA1 | Flush-vor-Exit an `:235-236` und `:246-247` |
| `tests/scripts/print-applicable-rules.test.mjs` | FA1 | Großpayload-Test durch echte Pipe |
| `skills/_shared/config-reading.md` | FA1 | `--context wave` im Fence bei `:198` (Stand nach Commit `654962c`) |
| `scripts/lib/instruction-budget-guard.mjs` | FA2 | Additive Felder, `countDirectives` exportieren, optionaler `context`-Param |
| `scripts/lib/claude-md-budget-lint.mjs` | FA2b/FA2c | Session-start-Aufruf, Description-Fläche |
| `skills/session-start/SKILL.md` | FA2b | Phase-4-Probe (⚠️ `reconcile-nudge-skill-wiring.test.mjs:38-48` pinnt String-Reihenfolge in dieser Datei) |
| `CLAUDE.md` | FA3 | Kommentarprosa raus, Keys bleiben |
| `docs/session-config-reference.md` | FA3 | Prosa-Aufnahme |
| `scripts/lib/validate-vendored-rules.mjs` | FA5 | Aktivierungsachse für menschliche Autoren |
| `.claude/rules/*.md` (11 always-on) | FA5 | Review-Datum ergänzen |
| `docs/rule-authoring.md` | FA5 | Review-Datum-Konvention |
| `projects-baseline/scripts/{compliance-push,sync-baseline,setup-project}.sh` | FA6-0 | `DRY_RUN` verdrahten |
| `projects-baseline/{CLAUDE,AGENTS}.md` | FA6-1 | Accounting 8 → 12 (+4 in `templates/shared/`) |
| `projects-baseline/.claude/rules/frontend-a11y-perf.md` | FA6-3 | `globs:` ergänzen |

### Architecture

**Additiv, nie ersetzend.** Jede Messerweiterung kommt als zusätzliches Feld neben bestehende. Begründung: zwölf Assertions in `tests/scripts/instruction-budget-guard.test.mjs` referenzieren `totalDirectives`, `perFile[].count` oder die strikte Ceiling-Grenze, und zwei davon (`:255`/`:266`, das `paths:`-Ausschluss-Paar aus #795) enthalten eine bewusste Fake-Regression-Kontrolle. Sie zu löschen, um Platz für ein Byte-Metrik zu schaffen, würde diesen Regressionsschutz still stilllegen.

**Kindschlüssel statt Top-Level-Schlüssel.** `claude-md-drift-check` Check 6 vergleicht ausschließlich Spalte-0-Schlüssel innerhalb des `## Session Config`-Blocks. Ein Kindschlüssel unter `instruction-budget:` ist für Check 6 strukturell unsichtbar, und `_parseInstructionBudget` ignoriert unbekannte Kinder bereits über einen `default`-Zweig — vorwärts- und rückwärtskompatibel ohne Zusatzaufwand. (In Batch 1 wird kein neuer Schlüssel gebraucht; die Regel gilt für Batch 2.)

**Zeilen- vs. Byte-Basis, einmal benannt.** `wc -l CLAUDE.md` liefert **201** (Newline-Zähler), `claude-md-budget-lint` meldet **202** (`split('\n')` auf einer Datei mit abschließendem Newline). Beide sind korrekt; die PRD nennt Bytes als Primärmaß, weil FA3 Bytes bewegt und Zeilen praktisch nicht: von 153 Blockzeilen sind nur **6** reine Kommentarzeilen, 95 tragen Inline-Kommentare. Das Entfernen der Prosa senkt den Block um 9.569 B, aber nur um ~6 Zeilen — CLAUDE.md landet bei ~195 Zeilen und erfüllt `DEFAULT_MAX_LINES = 150` **nicht**. Das ist eine bewusste Teil-Erfüllung, kein Versäumnis.

**Verworfene Alternative — vollständige Session-Config-Auslagerung.** Nach Blast-Radius-Audit verworfen. Drei Eigenschaften ergeben ein untragbares Risikoprofil: (a) `parse-config.mjs` liefert bei fehlendem Block **exit 0 mit vollständigen Defaults** — `vault-integration: off`, `drift-check: off`, `vcs: null`, ohne Fehlerkanal auf irgendeiner Ebene; (b) das Bootstrap-Gate ist **Prosa, die ein LLM ausführt** — es existiert weder eine Bash- noch eine JS-Implementierung, 16 Skills würden unabhängig `GATE_CLOSED` entscheiden und Re-Bootstrap erzwingen, ohne dass ein Test das bemerkt; (c) `scripts/lib/skill-evolution/blast-radius-classifier.mjs:104` hardcodiert `rel === 'CLAUDE.md' || rel === 'AGENTS.md'`, sodass die Self-Evolution-Engine die Datei, von der sie neu abhinge, nie reparieren könnte. Die Fehlerform ist identisch zur 8-Pipeline-Regression, die CLAUDE.md als Mahnmal führt. Der volle Umbau wären 35–45 Dateien plus Fleet-Migration hinter einem Dual-Read-Fenster.

Zur oft zitierten Präzedenz: `## Skill Evolution` und `## Dispatcher Autonomy` liegen außerhalb der **H2-Grenze**, aber **in derselben Datei** — genau damit die 34 Whole-File-Parser sie weiter finden. Das Repo hat „außerhalb des paritätsgeprüften H2" zweimal bewiesen, „außerhalb der Datei" null Mal.

### Data Model Changes

Keine. `.orchestrator/metrics/*.jsonl`-Schemata unverändert.

### API Changes

Rein additiv: `computeInstructionBudget` liefert drei zusätzliche Felder, `countDirectives` wird exportiert, ein optionaler `context`-Parameter kommt hinzu. Keine Signatur ändert sich rückwärtsinkompatibel. Kein neuer Config-Schlüssel in Batch 1.

---

## 5. Risks & Dependencies

| Risk | Impact | Mitigation | Triage |
|---|---|---|---|
| `--dry-run` ist dokumentiert, wird geparst und ignoriert | **Kritisch** — ein Preview-Lauf ist ein echter 23-Repo-Schreibvorgang mit `rm -f`-Pruning | FA6-0 ist Prerequisite Nr. 0, blockiert alles Übrige in FA6 | Implement |
| Fleet-Push zerstört Hand-Edits in zwei Consumer-Repos, deren Rule-Kopien **größer** sind als das Baseline-Original (Slugs bewusst nicht genannt — CP6/owner-privacy; sie stehen im Blast-Radius-Audit) | Hoch — unwiederbringlich bei untracked Dateien wegen `rm -f`-Pruning | `DRY_RUN` zuerst; beide Divergenzen vor dem Sweep sichern und upstreamen statt überschreiben; Sweep ist Batch 2 (T5) | Implement |
| Wave-Pfad kippt über die Puffergrenze, bevor FA1 landet | Hoch — 2.919 B Restluft, still, kein Test fängt es | FA1 ist das erste Arbeitspaket in Batch 1; bis dahin keine Rule in `tier: always`/`wave-only` vergrößern | Implement |
| FA6-2 als Gate scharfstellen macht Baseline sofort rot (632/480 = 132 %) | Hoch — blockiert jede unbeteiligte Regeländerung | Warn-only auf dem **gemessenen** Wert starten, erst nach FA6-3 anziehen | Implement |
| FA6-2 unterzählt: die 4 Shared-Template-Rules liegen außerhalb `.claude/rules/` | Mittel — 147 von 632 Directives = **23,3 %** unsichtbar; erzeugt einen Laundering-Kanal | Scan-Fläche von Anfang an erweitern (eigenes AC) | Implement |
| Kommentar-Diät verliert einen Parser-Gotcha | Mittel — vier Session-Config-Keys brechen, wenn ihre Header-Zeile einen Inline-Kommentar trägt | Eigenes AC: alle fünf müssen in der Reference wiederauffindbar sein | Implement |
| ~~Parallele Session in `config-reading.md` + `checker.mjs`~~ — **aufgelöst** | — | PSA-002 während der Planung erkannt, Commit bis nach ihrem Push zurückgestellt. Ihre 5 Commits sind gelandet und gepusht; `config-reading.md` ist jetzt in committetem Zustand, FA1 setzt darauf auf. | Implement |
| `#729` Zwei-Master-Entscheid unimplementiert, schon einmal gekippt (Option 1 am 04.07. → Option 2* am 10.07.), AIAT-Master off-host ohne Drift-Check | Mittel — Baseline-Änderungen könnten später doppelt nötig werden | Unter Option 2* ist die persönliche Baseline der Rules-Master; FA6 ist Rules-Domäne. Als Annahme dokumentiert. | Defer |
| Byte-Messung feuert später bei jeder Prosa-Umformulierung | Niedrig in Batch 1 — es gibt kein Byte-Gate | Banner bleibt vom Directive-Ceiling gesteuert; Byte-Zahlen nur informativ | Defer |

### Dependencies

| Ref | Beziehung |
|---|---|
| **#840** | **CLOSED 2026-07-24**, Commit `654962c`. Die rule-scoping-Probe war die Vorbedingung für belastbare FA2-Messwerte — sie ist erfüllt, bevor Batch 1 startet. Kein Aufwand mehr in dieser PRD. |
| **#866** | Wird von dieser PRD abgelöst — als Epic verwenden oder als superseded schließen. Achtung: seine Prämisse „2 mislabelte Rules" stammt aus `aiat-kreativprojekte` und **reproduziert in diesem Repo nicht** (alle „Path-scoped"-betitelten Rules tragen hier korrekte `globs:`). |
| **#742** | Fleet-Sweep `paths:`→`globs:` in Off-Host-Consumer-Repos — dieselbe Reichweite wie T5. Zusammenlegen. |
| **#688** | Geschlossen, enthält die fertige Trimliste. Quelle für T1/T2, nicht wieder-öffnen. |
| **#723 Epic B** | FA5 ist der Enabler: erst mit der Brandmauer für menschliche Autoren ist die Learning→Rule-Pipeline sicher reaktivierbar. |
| **#726 Epic E** | FA2c erfüllt dessen Checklistenpunkt „Skill-Frontmatter-Description-Budget-Audit". T7 erfüllt den Multi-Harness-Teil. |
| **#703** | **Läuft entgegen** — will ~41 Rules in die Baseline syncen, also Always-on-Fläche hinzufügen, während wir sie reduzieren. Hinter FA6-2 gaten. Ohnehin von #729 blockiert. |
| **#595** | Vorbedingung für T6. |
| **#729** | Baseline-Split-Entscheid; Annahme siehe Risikotabelle. |

### Messbare Erfolgskriterien

Alle Vorher-Werte gemessen am 2026-07-24. Zielhorizont: Ende Batch 1 (2 Wochen, also 2026-08-07).

| Metrik | Vorher | Ziel Batch 1 |
|---|---|---|
| Koordinator-Payload-Verlust (`--context coordinator`, durch Pipe) | 37.239 B / 36,2 %, in 10/10 Läufen | **0 B, in 10/10 Läufen** |
| Wave-Payload-Restluft zur Pufferschwelle | 2.919 B (95,5 % Auslastung) | Irrelevant — Puffergrenze ist keine Schranke mehr |
| CLAUDE.md Session-Config-Block, Bytes | 12.403 B (davon 9.569 B Kommentarprosa) | **≤ 3.000 B** |
| CLAUDE.md gesamt, Bytes | 19.805 B | ≤ 10.500 B |
| `claude-md-budget-lint`-Sichtbarkeit | 7 Verstöße, nur bei Bootstrap, warn | Bei jedem session-start sichtbar |
| Messflächen | Directives auf 11 Rule-Dateien | + Bytes, + `bySurface`, + Description-Fläche (~27 KB) |
| Baseline Always-on-Directives | 632 / 480 = 132 %, ungemessen | Gemessen, warn-only-Ratchet, nach FA6-3 **581** |
| Baseline `--dry-run` | dokumentiert, ignoriert (0 Vorkommen im Skript) | Funktionsfähig, per AC verifiziert |
| Rules ohne Aktivierungsachse **und** ohne Review-Datum | 11 von 18 | **0** |
