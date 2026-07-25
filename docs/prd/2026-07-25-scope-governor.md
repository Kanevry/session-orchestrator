# Feature: Scope Governor — Loop-Termination über Scope statt über Retry-Cap

**Date:** 2026-07-25
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 1w
**Parent Project:** session-orchestrator (standalone Feature, kein Epic-Kind)

> Quelle der Doktrin: [`openclaw/agent-skills` § `skills/autoreview/SKILL.md`](https://github.com/openclaw/agent-skills/blob/main/skills/autoreview/SKILL.md) (MIT), § "Scope Governor". Adoptiert werden **vier** von dreizehn geprüften Mustern; die übrigen neun sind in § 2 Out-of-Scope mit Begründung festgehalten, damit die Nicht-Adoption als Entscheidung lesbar ist und nicht als Lücke.

> **Revisionshistorie — vier Runden, viermal dieselbe Fehlerklasse in neuer Verkleidung.** Der Reviewer hat das Muster am Ende selbst benannt, und es ist die wichtigste Lektion dieses Dokuments: *jedes Mal wurde ein Verhältnis definiert, indem die eine Seite auf Prosa verwies und die andere gerechnet wurde.*
>
> - **R1 → R2:** Baseline lag in `wave-scope.json` — einer Datei, die der Harness pro Session selbst löscht. Die genannte Datenquelle (`over_delivery_ratio`) existierte nicht als Code. Ein konkurrierender Schwellwert 1.3 war unerwähnt. LOC-Achse gestrichen (YAGNI).
> - **R2 → R3:** Dieselbe Klasse **invertiert** — die Baseline wurde nie gelöscht, überlebte den Session-Wechsel und wäre nur einmal pro Repo eingefroren worden. Zusätzlich: Numerator/Denominator filterten Test-Dateien unterschiedlich, eine planmäßige Session hätte `0,67` gelesen.
> - **R3 → R4:** Dieselbe Klasse **eine Ebene tiefer** — der Vergleichs-Key hieß `session-id`, das Schema kennt aber `session` (§ 4 Session-Scoping); und die „wiederverwendete" Filterliste ist in sich **nicht gleichartig** (`reclassify` vs. `exclude`) und schließt ein Verzeichnis aus, in dem ein geplantes Deliverable liegt (§ 4 Symmetrie-Invariante). Die gepinnte 1,0-Invariante war unerfüllbar.
>
> **Konsequenz für die Umsetzung:** beide Seiten des Bruchs werden an **einer** Stelle, **in Code** definiert — `DRIFT_EXCLUDE_PATTERNS` in `scripts/lib/scope-baseline.mjs`. Und der erste Test, der geschrieben wird, ist der 1,0-Fall für eine planmäßige Session; nicht der letzte.

## 1. Problem & Motivation

### What

Unser inter-Wave-Fix-Loop begrenzt sich über einen **Retry-Cap**: `verification-auto-fix.max-retries` (Default 2) Fixer-Dispatches, danach Diagnostics-Bundle und harter Wave-Abbruch (`.claude/rules/quality-gates-autofix.md:8-18`, `scripts/lib/quality-gate.mjs::runQualityGateWithRetry`). Der Cap beendet den Loop **nach Budget**, nicht nach Qualität: bei Erreichen von Retry 2 ist völlig unbestimmt, ob die Findings gelöst, unlösbar oder außerhalb des Auftrags sind.

Dieses Feature ersetzt die Abbruch-Semantik durch eine **Scope-Semantik**. Drei Bausteine:

1. Eine **Scope-Baseline**, die vor Wave 1 einmalig pro Session einfriert, was der Auftrag ist. Sieben Felder, davon **fünf neu** (`intent`, `owner-boundary`, `planned-files`, `session`, `frozen-at`) und **zwei wiederverwendet** — `branch` und `session-start-ref` führt die STATE.md-Frontmatter ohnehin schon.
2. Ein **Drift-Tripwire**, der den tatsächlichen Diff gegen diese Baseline misst und bei Überschreitung des 2×-Faktors warnt.
3. Eine **Finding-Triage-Doktrin**, die jedes Review-Finding vor dem Patchen in eine von drei Klassen einordnet — `in-scope-blocker`, `follow-up`, `stop-and-escalate` — plus die Pflicht, nach zwei nicht-konvergierenden Fix-Zyklen **alle** verbleibenden Findings neu zu klassifizieren, statt blind einen dritten Zyklus zu fahren oder abzubrechen.

Die dritte Klasse `stop-and-escalate` existiert bei uns heute nicht: `skills/session-end/SKILL.md:316-317` kennt für Review-Findings genau zwei Dispositionen (`HIGH+/blocking → fix inline oder Issue` / `MED/LOW → Report-Sektion, kein Issue`). Ein Finding, dessen korrekte Behandlung eine neue Protokoll-, Config-, Storage- oder Public-API-Entscheidung wäre, hat bei uns keinen Ausgang außer „fix it" oder „ignore it" — beides falsch.

### Why

**Der Treiber ist die Termination-Semantik, nicht ein Vorfall.** Unser `max-retries: 2` und autoreviews „two cycles" sehen identisch aus und sind Gegenteile: unseres **stoppt**, deren erzwingt **Reclassify** und darf danach weiterlaufen, solange jedes verbleibende Finding noch ein In-Scope-Blocker ist. Steinbergers berichtete 66 Runden auf einem Refactor sind nur in der zweiten Bauart erreichbar — nicht weil 66 ein Ziel wäre, sondern weil ein Loop, der auf Scope terminiert, nicht künstlich bei 2 endet.

Zwei unabhängige externe Quellen bestätigen die Diagnose:

- Ein kontrolliertes Mehr-Runden-Experiment: Runde 1 = 1 blocking finding, Runde 3 = **37 Findings / 7 blocking / 0 Fixes**, ~30 min Agent-Zeit verbrannt. Ursache war nicht Detection-Failure, sondern **Fix-Vokabular-Uneinigkeit** — Reviewer waren sich einig, dass der Bug existiert, forderten aber „reject" vs. „strip" vs. „ignore", was verschiedenen Code impliziert. Fazit der Autoren: *„Reaching a review round limit simply means the pipeline hit its allocated budget, not that security issues have been resolved."* ([Contrast Security](https://www.contrastsecurity.com/security-influencers/when-ai-reviewers-cannot-agree))
- Eine Konvergenz-Studie empfiehlt **Dual-Threshold-Circuit-Breaker** (Warn-Schwelle „wrap up", Hard-Schwelle „force terminate") und schließt **Cross-Boundary-Findings explizit aus der Konvergenz-Rechnung aus** — strukturell identisch zu `stop-and-escalate`. ([Zylos](https://zylos.ai/research/2026-03-01-multi-model-ai-code-review-convergence/))

Der **2×-Diff-Wachstums-Tripwire ist außerhalb von autoreview nirgends publiziert** (Recherche 2026-07-25, fünf Quellen). Das ist deren eigentlicher origineller Beitrag und der Teil, der bei uns am wenigsten Substitut hat.

**Eigenbeleg aus der Entstehung dieses PRDs.** Die Review-Historie oben ist selbst ein Datenpunkt für die Diagnose: drei Runden, jede fand einen fatalen Fehler, jede Korrektur erzeugte die nächste Variante derselben Klasse. Ein Cap bei zwei Runden hätte hier nach R2 beendet — mit einem grünen PRD, dessen Tripwire um seinen eigenen Schwellwert stumpf gewesen wäre. Nicht weil das Budget schlecht gewählt war, sondern weil ein Runden-Zähler nichts über Konvergenz weiß. Genau dafür existiert RCR-008.

**Was wir schon haben — und warum es die Lücke nicht schließt.** Zwei bestehende Mechanismen berühren dieselbe Metrik-Familie:

- `over_delivery_ratio = files_changed / max(planned_files_count, 1)` (`skills/wave-executor/wave-loop.md:732-733`) hat sehr wohl einen Schwellwert **und** eine Konsequenz: `skills/session-plan/SKILL.md:115` und `:401` inflationieren die „Files to change"-Schätzung, wenn der **Median über die letzten ~5 Sessions** `R > 1.3` liegt. Das ist ein **retrospektiver Planungs-Regler** — er verbessert die Größenschätzung der *nächsten* Session. Er bremst keinen Drift in der *laufenden*.
- Die „Unplanned (scope creep)"-Liste (`skills/session-end/plan-verification.md:38-41`) ist rein informativ und läuft erst bei Session-Ende (`:32` — „Informational — does **NOT** block the session close").

Die Lücke ist also nicht „keine Messung", sondern **kein Signal zur Laufzeit, gegen einen eingefrorenen Auftrag, mit einer Schwelle, die den aktuellen Zyklus betrifft**. Das ist eine andere Zeitachse, kein Duplikat — siehe § 4 Schwellwert-Abgleich.

### Who

**Koordinator + Wave-Agents (in-run-Achse).** Kein Endnutzer, keine menschliche Persona — der Konsument ist der Koordinator-Thread, der Findings entgegennimmt und Fix-Zyklen dispatcht, plus die Wave-Agents, deren Fix-Aufträge aus der Triage folgen. Der Operator ist sekundärer Konsument: er liest den Tripwire-WARN und entscheidet bei `stop-and-escalate`.

Voraussetzung erfüllt: **#876 ist gelandet** (`23f7812`, 2026-07-25). Vor diesem Fix schnitt `print-applicable-rules --context coordinator` bei exakt 65.536 B über die Pipe ab, und `receiving-review.md` fiel dabei **vollständig** aus dem Koordinator-Payload — neue RCR-Klauseln wären wirkungslos gewesen. Die Koordinator-Fläche liegt jetzt bei 102.401 B und wird vollständig geliefert (gemessen via `computeInstructionBudget({context:'coordinator'})`, 2026-07-25).

## 2. Solution & Scope

### In-Scope

- [ ] **S1 — Scope-Baseline-Modul.** Neues `scripts/lib/scope-baseline.mjs` mit `writeBaseline()`, `readBaseline()`, `computeDrift()` und der exportierten Konstante `DRIFT_EXCLUDE_PATTERNS`. Die Baseline wird als **fünf flache Keys** in die STATE.md-Frontmatter geschrieben (`scope-baseline-intent`, `-owner-boundary`, `-planned-files`, `-session`, `-frozen-at`); `branch` und `session-start-ref` werden aus der bestehenden Frontmatter gelesen, nicht dupliziert. Session-Scoping vergleicht gegen das **kanonische `session`-Feld** über `parseSessionId()`. Schreibpfad ist `withStateMdLock()`, in try/catch gewrappt.
- [ ] **S2 — Drift-Berechnung + 2×-Tripwire auf der Datei-Achse, warn-only.** `computeDrift()` vergleicht die Anzahl geänderter, nicht-ausgeschlossener Dateien seit `session-start-ref` gegen `scope-baseline-planned-files`. Schwelle 2.0, konfigurierbar, `>=` gilt als gerissen. **Beide Seiten des Bruchs verwenden `DRIFT_EXCLUDE_PATTERNS` — dieselbe Konstante, im selben Modul, in Code** (Symmetrie-Invariante, § 4). Ausgabe ist ein WARN auf stderr plus ein Feld im Wave-Checkpoint — **niemals ein Deny, niemals ein Exit ≠ 0**.
- [ ] **S3 — RCR-007: Drei-Klassen-Finding-Triage.** Neue Klausel in `.claude/rules/receiving-review.md`: Pflicht-Klassifikation vor dem Patchen in `in-scope-blocker` / `follow-up` / `stop-and-escalate`, mit den fünf enumerierten Escalate-Triggern und der **geschlossenen** Kritisch-Ausnahmeliste (aktiver Datenverlust, Crash, kaputtes Install/Upgrade, Release-Blocker, konkrete Security-Exposure — nichts sonst rechtfertigt Scope-Bruch).
- [ ] **S4 — RCR-008: Two-Cycle-Reclassify.** Nach zwei Fix-Zyklen ohne Konvergenz: Pause, **alle** verbleibenden Findings neu klassifizieren, nur weiterfahren wenn jedes davon noch `in-scope-blocker` ist. Plus Landing-Lane-Hygiene: keine gestackten oder gepushten Fix-Commits während Klassifikation oder Proof offen sind.
- [ ] **S5 — Idle-Reset-Regel.** `skills/session-start/SKILL.md` § Idle Reset bekommt eine Regel 7: die fünf `scope-baseline-*`-Keys werden über denselben `updateFrontmatterFields(contents, {field: null})`-Mechanismus gelöscht, den Regel 6 für die v1.1-Recommendation-Keys schon etabliert. Das ist der Gürtel; der `session`-Vergleich in S1 ist der Hosenträger. **Wenn das Appetite reißt, ist S5 der Kandidat zum Streichen** — es ist der einzige In-Scope-Punkt, den dieses PRD selbst als redundant ausweist.
- [ ] **S6 — Tests.** Unit-Tests für S1/S2. Der **erste** geschriebene Test ist der 1,0-Fall für eine exakt planmäßige Session (§ 3 FA2, Szenario 1) — das ist die Invariante, an der drei Revisionen gescheitert sind. Dazu der **Fake-Regression-Nachweis** für den Tripwire (er muss auf synthetischem Drift ROT werden — ein grüner Guard beweist nichts, `.claude/rules/testing.md` § "Negative-Assertion Fake-Regression Check") und ein Rules-Test, der Präsenz, inhaltliche Vollständigkeit und Byte-Grenze von RCR-007/008 pinnt (Verifikationsmethode für S3/S4, siehe § 3 FA3/FA4).

### Out-of-Scope

- **Extraktion der Noise-Filter in ein von `plan-verification.md` geteiltes Modul** — die *prinzipielle* Form des Symmetrie-Fixes. Sie würde die Prosa-Duplizierung retten, die diesen Fehler erst erzeugt hat, berührt aber eine bestehende dokumentierte Phase (session-end 1.1a), braucht eigene Regressions-Abdeckung und ist allein ein 2–3-Tage-Schnitt. v1 nimmt die *billige* Form: die Konstante lebt im neuen Modul, und `plan-verification.md` bekommt **einen** Satz, der darauf zeigt. Wenn dieses PRD auf 2w umgelabelt wird, ist das der erste Punkt, der hereinkommt.
- **LOC-Achse des Tripwire** (`nonTestLocBudget` / `locRatio`) — in R1 noch in-scope, gestrichen. Konsument ohne Produzent: nichts in S1–S6 hätte je ein LOC-Budget *gesetzt* — kein Config-Key, kein Default, keine Operator-Fläche. Zum Zeitpunkt Pre-Wave-1 existiert kein Diff, aus dem ein Denominator ableitbar wäre; autoreview hat es leichter, weil dessen Baseline ein realer Intended-PR-Diff ist. Das Rückgabeobjekt ist erweiterbar — die Achse kann additiv nachgezogen werden, sobald ein Produzent existiert.
- **Mechanisches Blocking des Tripwire** — `getEnforcementLevel()` defaultet bei Parse-Fehler auf `strict` (`scripts/lib/scope-gate.mjs:50-57`). Ein fehlerhafter Tripwire würde Waves hart blocken. Warn-only zuerst, Enforcement erst nach beobachteten True-Positives.
- **Source-blindes Behavior-Gate** (`behavior-validator`, Score 0.54) — zweitplatzierter Kandidat, eigenes Appetite. #817 besitzt die macOS-Hälfte und den Evidence-Contract bereits; eine Adoption ohne Koordination würde doppelt bauen.
- **Severity-Floor / P0-only-Default** (Score 0.39) — verlangt eine Umkehr von `discovery-severity-threshold` (heute `low` = maximale Verbosität) plus Reviewer-seitige Filter. Eigenes Feature; #617 hat den schmerzhaftesten Teil (Issue-Spam aus MED/LOW) bereits gelöst.
- **Reviewer-Engine-Isolation** — wir haben keine externe Reviewer-Engine: alle Reviewer sind in-Harness-Subagents mit `sandbox-tier: read-only`. Das Muster adressiert ein Problem, das unsere Architektur nicht hat.
- **Secret-Pre-Scan vor Model-Dispatch** — echte Lücke (alle unsere Gates sitzen an git/publish-Grenzen, keiner an der Dispatch-Grenze), aber Security-Scope mit eigenem Risikoprofil. Gehört in ein Security-Feature, nicht in ein Loop-Feature.
- **Bounded Passes / no silent truncation** — echte Lücke (`skills/persona-panel/SKILL.md:159-162` truncated bei >20 Personas alphabetisch und **verwirft** den Rest). Sibling-Klasse #876 ist gerade gelandet; diese Instanz braucht ein eigenes Ticket.
- **Release-Branch-Freeze-Discipline** — wir fahren main-only mit Tags, keine Release-Branches. Kein Substrat.
- **Regression-Provenance-Rollen** — Single-Operator-Repo ohne PR-Merger-Trennung und ohne Automerge-Bot. Der Unterscheidungsgewinn ist null.
- **Bug-Class-Sweep** — kollidiert direkt mit `.claude/rules/quality-gates-autofix.md:31-32` („MUST NOT broaden scope … no 'while we're here' changes"). Der Widerspruch ist echt und gehört nach #886 (T3) als neunter Widerspruch, nicht in dieses PRD.
- **Fleet-Sync in `projects-baseline`** — Koordinationsbedarf mit #703/#742/#888.
- **Jede Änderung an `.claude/rules/quality-gates-autofix.md`** — Kollisionsvermeidung mit #884, siehe § 5.

## 3. Acceptance Criteria

### FA1 — Scope-Baseline-Freeze

```gherkin
Given eine STATE.md mit session: main-2026-07-26-feature-1, branch: main,
      session-start-ref: 23f7812 und ohne scope-baseline-* Keys
When writeBaseline({repoRoot, intent, ownerBoundary, plannedFiles: 5}) aufgerufen wird
Then enthält die STATE.md-Frontmatter genau fünf neue Keys: scope-baseline-intent,
     -owner-boundary, -planned-files, -session, -frozen-at
And scope-baseline-session trägt den Wert des kanonischen Frontmatter-Felds session
And scope-baseline-frozen-at ist ein ISO-8601-UTC-Zeitstempel
And branch und session-start-ref bleiben unverändert und werden NICHT dupliziert
And alle übrigen Frontmatter-Keys bleiben unverändert
```

```gherkin
Given eine STATE.md deren scope-baseline-session via parseSessionId() dem
      kanonischen session-Feld GLEICHT
When writeBaseline() ein zweites Mal mit abweichenden Werten aufgerufen wird
Then bleiben alle scope-baseline-* Keys unverändert
And der Rückgabewert ist {written: false, reason: "already-frozen"}
```

```gherkin
Given eine STATE.md deren scope-baseline-session von einer FRÜHEREN Session stammt
      und dem kanonischen session-Feld NICHT gleicht
When writeBaseline() aufgerufen wird
Then wird die veraltete Baseline vollständig überschrieben
And scope-baseline-session trägt danach den aktuellen session-Wert
And der Rückgabewert ist {written: true}
```

```gherkin
Given eine STATE.md OHNE das optionale session-Feld (state-ownership.md:28 —
      "readers MUST tolerate their absence") und ohne scope-baseline-* Keys
When writeBaseline() aufgerufen wird
Then wird die Baseline geschrieben und scope-baseline-session auf null gesetzt
And der Rückgabewert ist {written: true}
And bei einem späteren readBaseline() gilt "beide Seiten null" als MATCH,
    nicht als stale — eine fehlende Session-ID darf den Tripwire nicht
    dauerhaft inert schalten
```

```gherkin
Given eine STATE.md ohne scope-baseline-* Keys
When readBaseline() aufgerufen wird
Then ist der Rückgabewert null
And es wird keine Exception geworfen
```

```gherkin
Given eine STATE.md deren scope-baseline-session nicht dem kanonischen session-Feld gleicht
When readBaseline() aufgerufen wird
Then ist der Rückgabewert {stale: true, baselineSession, currentSession}
And der Rückgabewert ist NICHT null — computeDrift() muss "keine Baseline" von
    "veraltete Baseline" unterscheiden können, ohne die Frontmatter zweitzulesen
```

```gherkin
Given der STATE.md-Lock ist über die Timeout-Dauer hinaus von einem anderen Writer gehalten
When writeBaseline() aufgerufen wird
Then ist der Rückgabewert {written: false, reason: "lock-timeout"}
And es wird KEINE Exception nach außen geworfen
And die STATE.md bleibt unverändert
```

### FA2 — Drift-Berechnung und 2×-Tripwire (Datei-Achse)

```gherkin
Given scope-baseline-planned-files: 5, berechnet als die nach DRIFT_EXCLUDE_PATTERNS
      nicht-ausgeschlossene Teilmenge der sieben geplanten Dateien
And der Diff seit session-start-ref enthält genau diese sieben geplanten Dateien
      (fünf gezählte plus die zwei ausgeschlossenen Test-Dateien)
When computeDrift() aufgerufen wird
Then ist filesRatio genau 1.0
And breached ist false
And dies ist der ERSTE zu schreibende Test — drei Revisionen sind an genau
    dieser Invariante gescheitert
```

```gherkin
Given scope-baseline-planned-files: 5
And der Diff enthält .claude/rules/receiving-review.md als eine der geänderten Dateien
When computeDrift() aufgerufen wird
Then wird diese Datei GEZÄHLT, nicht ausgeschlossen
And DRIFT_EXCLUDE_PATTERNS verengt plan-verification.md:45 bewusst:
    .claude/rules/** ist ein Deliverable, kein Session-Artefakt
```

```gherkin
Given scope-baseline-planned-files: 10
And der Diff seit session-start-ref enthält 14 gezählte Dateien
When computeDrift() aufgerufen wird
Then ist filesRatio 1.4 und breached false
```

```gherkin
Given scope-baseline-planned-files: 10
And der Diff seit session-start-ref enthält 21 gezählte Dateien
When computeDrift() aufgerufen wird
Then ist filesRatio 2.1 und breached true
```

```gherkin
Given scope-baseline-planned-files: 10
And der Diff seit session-start-ref enthält genau 20 gezählte Dateien
When computeDrift() mit threshold 2.0 aufgerufen wird
Then ist filesRatio 2.0 und breached true
And die Grenze ist inklusiv — ">=" gilt als gerissen, nicht ">"
```

```gherkin
Given ein Drift-Ergebnis mit breached: true
When der Wave-Checkpoint es verarbeitet
Then wird ein WARN auf stderr ausgegeben, das filesRatio, plannedFiles, actualFiles
     und die Schwelle nennt
And der Prozess-Exit-Code bleibt 0
And die nächste Wave wird dispatcht
```

### FA3 — Drei-Klassen-Finding-Triage (RCR-007) — DOCTRINE (non-executable)

> **Diese Kriterien sind Doktrin, nicht Code.** Sie beschreiben eine Urteilsentscheidung des Koordinators, die kein Unit-Test assertieren kann — es gibt keinen mechanisierbaren Output. Sie dürfen NICHT in Unit-Tests übersetzt werden.
>
> **Verifikationsmethode:** `tests/rules/check-rules-handwritten.test.mjs` prüft, dass RCR-007 in `.claude/rules/receiving-review.md` präsent ist, alle drei Klassennamen führt, alle fünf enumerierten Escalate-Trigger enthält und die fünfstellige geschlossene Kritisch-Ausnahmeliste vollständig nennt. Das verifiziert die *Auslieferung* der Doktrin, nicht ihre Befolgung.

```gherkin
Given ein Review-Finding, das durch den aktuellen Diff eingeführt wurde
And es betrifft dieselbe Owner-Boundary
And es ist ohne Änderung des Auftrags-Contracts behebbar
When der Koordinator es klassifiziert
Then lautet die Klasse in-scope-blocker
And es wird im aktuellen Zyklus gefixt
```

```gherkin
Given ein Review-Finding, dessen korrekte Behebung ein neues Protokoll, eine neue Config-Fläche,
      eine Storage-Änderung, einen Public-API-Contract, eine andere Owner-Boundary
      oder eine Release-Prozess-Änderung verlangt
When der Koordinator es klassifiziert
Then lautet die Klasse stop-and-escalate
And es wird NICHT gepatcht, unabhängig davon wie klein der Patch aussieht
And der Scope-Bruch wird an den Operator berichtet statt ihn zu überbauen
```

```gherkin
Given ein Review-Finding, das real ist aber eine benachbarte Bug-Klasse oder Sibling-Surface betrifft
When der Koordinator es klassifiziert
Then lautet die Klasse follow-up
And es wird nach der bestehenden Disposition aus skills/session-end/SKILL.md:316-317 behandelt
```

### FA4 — Two-Cycle-Reclassify (RCR-008) — DOCTRINE (non-executable)

> Wie FA3: Urteilsentscheidung, kein assertierbarer Output. **Verifikationsmethode:** derselbe Rules-Test prüft, dass RCR-008 präsent ist, die Reclassify-Pflicht nach zwei Zyklen formuliert und die No-Stack/No-Push-Klausel enthält.

```gherkin
Given zwei abgeschlossene Fix-Zyklen, in denen die Anzahl blockierender Findings nicht strikt gesunken ist
When der Koordinator einen dritten Zyklus erwägt
Then klassifiziert er zuerst JEDES verbleibende Finding neu
And ein dritter Zyklus startet nur, wenn danach jedes verbleibende Finding in-scope-blocker ist
And andernfalls wird die kleinste sicher landbare Teilmenge bestimmt und der Rest zum Follow-up
```

```gherkin
Given eine offene Scope-Klassifikation oder ein offener Focused-Proof
When ein review-getriggerter Fix-Commit erwogen wird
Then wird nicht gestackt und nicht gepusht
And die Edits bleiben lokal, bis der Zyklus als in-scope nachgewiesen ist
```

### FA5 — Idle-Reset-Bereinigung

```gherkin
Given eine STATE.md mit status: completed und fünf scope-baseline-* Keys
When session-start den Idle Reset auf dem completed-Zweig ausführt
Then sind alle fünf scope-baseline-* Keys aus der Frontmatter entfernt
And ## What Not To Retry und ## Open Questions bleiben byte-identisch erhalten
And die Löschung nutzt updateFrontmatterFields(contents, {field: null}) — denselben
    Mechanismus wie Regel 6 für die v1.1-Recommendation-Keys
```

### FA6 — Skip-Präzedenz, Edge Cases und Fehlerbehandlung

```gherkin
Given mehrere Skip-Bedingungen treffen gleichzeitig zu (z. B. veraltete Baseline
      UND unauflösbarer session-start-ref)
When computeDrift() den reason bestimmt
Then wird die Kette in dieser festen Reihenfolge ausgewertet, erste Übereinstimmung gewinnt:
     no-state-md → unreadable-state-md → no-baseline → stale-baseline → unresolvable-ref
And der zurückgegebene reason ist damit deterministisch und in Tests
    mit toEqual assertierbar, nicht nur mit toContain
```

```gherkin
Given eine STATE.md ohne scope-baseline-* Keys (Baseline nie eingefroren)
When computeDrift() aufgerufen wird
Then ist der Rückgabewert {ok: true, skipped: true, reason: "no-baseline"}
And es wird kein WARN ausgegeben — Abwesenheit einer Baseline ist kein Drift
```

```gherkin
Given eine STATE.md deren scope-baseline-session von einer früheren Session stammt
When computeDrift() aufgerufen wird
Then ist der Rückgabewert skipped mit reason "stale-baseline"
And es wird KEIN filesRatio berechnet — ein frischer Diff gegen einen alten
    Denominator ist keine Messung, sondern Rauschen
```

```gherkin
Given eine STATE.md deren session-start-ref-Feld FEHLT (nicht: unauflösbar ist)
When computeDrift() aufgerufen wird
Then wird der dokumentierte Fallback aus plan-verification.md:37 verwendet:
     git diff --name-only origin/main...HEAD
And das Ergebnis ist KEIN skip — der Fallback ist weniger präzise, aber funktional
And das verwendete Vergleichs-Ref wird im Rückgabeobjekt als refUsed ausgewiesen
```

```gherkin
Given keine STATE.md im Repo (persistence: false)
When readBaseline() oder computeDrift() aufgerufen wird
Then ist der Rückgabewert skipped mit reason "no-state-md"
And es wird keine Exception geworfen
```

```gherkin
Given eine STATE.md mit syntaktisch kaputter Frontmatter
When readBaseline() oder computeDrift() aufgerufen wird
Then wird keine Exception geworfen
And der Rückgabewert markiert skipped mit reason "unreadable-state-md"
And das Verhalten ist explizit NICHT fail-closed — siehe § 4 Fail-Open-Asymmetrie
```

```gherkin
Given ein session-start-ref, der vorhanden aber nicht mehr auflösbar ist
      (rebase, force-push, gelöschter Commit)
When computeDrift() den Diff berechnen will
Then ist der Rückgabewert skipped mit reason "unresolvable-ref"
And der Exit-Code bleibt 0
```

```gherkin
Given ein Diff, der ausschließlich Test-, Lock- und Generated-Dateien enthält
When computeDrift() aufgerufen wird
Then ist filesRatio 0
And DRIFT_EXCLUDE_PATTERNS ist die EINZIGE Filterquelle für beide Seiten
```

## 3.A Acceptance Criteria (EARS)

### FA1 — Scope-Baseline-Freeze

**Ubiquitous:**
- The scope-baseline module shall persist the baseline as flat keys in STATE.md frontmatter and shall not introduce an additional artefact path.
- The scope-baseline module shall never throw; every failure — including a lock timeout — shall be expressed in the returned object.
- The scope-baseline module shall reuse the existing `branch` and `session-start-ref` frontmatter fields rather than writing its own copies.
- The scope-baseline module shall read session identity from the canonical `session` frontmatter field via `parseSessionId()`, and shall never read a `session-id` key.

**State-driven:**
- While `scope-baseline-session` equals the current `session` value, the module shall reject further `writeBaseline()` calls with `{written: false, reason: "already-frozen"}`.
- While `scope-baseline-session` differs from the current `session` value, the module shall treat the stored baseline as stale and shall overwrite it on the next `writeBaseline()`.
- While both `scope-baseline-session` and the current `session` field are absent, the module shall treat them as matching — an absent optional field shall never render the tripwire permanently inert.

**Event-driven:**
- When `writeBaseline()` is called on a STATE.md without a baseline, the module shall write exactly `scope-baseline-intent`, `-owner-boundary`, `-planned-files`, `-session` and `-frozen-at`.
- When two writers race, `withStateMdLock()` shall serialize them so exactly one write succeeds.
- When `withStateMdLock()` throws on lock-acquisition failure, `writeBaseline()` shall catch it and return `{written: false, reason: "lock-timeout"}`.
- When `readBaseline()` finds a stale baseline, it shall return `{stale: true, …}` rather than `null`, so callers can distinguish "absent" from "stale" without re-parsing.

**Optional feature:**
- Where `persistence: false` is configured and no STATE.md exists, the module shall return `skipped` with reason `no-state-md` instead of creating one.

**Unwanted behaviour:**
- If the STATE.md frontmatter is unreadable or malformed, then `readBaseline()` shall return null and shall not mutate the file.

### FA2 — Drift-Berechnung und 2×-Tripwire

**Ubiquitous:**
- The drift check shall derive both the denominator (at freeze time) and the numerator (at measure time) from the single exported constant `DRIFT_EXCLUDE_PATTERNS`, so an exactly-on-plan session reads 1.0.
- `DRIFT_EXCLUDE_PATTERNS` shall exclude test globs, lock/generated artefacts, and the per-session state files `STATE.md` / `wave-scope.json` / `metrics/**` under every platform state directory — and shall **retain** `.claude/rules/**`, deliberately narrowing `plan-verification.md:45`.
- The drift check shall measure only the files dimension in v1 and shall expose an extensible return object so a second dimension can be added additively.
- The drift check shall exit 0 in every outcome, including a breach.

**State-driven:**
- While `breached` is true, the wave checkpoint shall emit a WARN naming `filesRatio`, `plannedFiles`, `actualFiles` and the configured threshold.

**Event-driven:**
- When the measured ratio is greater than **or equal to** the threshold (default 2.0), the drift check shall set `breached` true.
- When several skip conditions hold at once, the drift check shall resolve `reason` by first match in the fixed order `no-state-md` → `unreadable-state-md` → `no-baseline` → `stale-baseline` → `unresolvable-ref`.

**Optional feature:**
- Where a threshold is configured explicitly, the drift check shall use it instead of the 2.0 default.
- Where the `session-start-ref` field is absent, the drift check shall fall back to `origin/main...HEAD` per `plan-verification.md:37` and shall report the ref actually used as `refUsed`.

**Unwanted behaviour:**
- If no baseline exists, the baseline is stale, no STATE.md exists, the frontmatter is malformed, or a present `session-start-ref` is unresolvable, then the drift check shall return `skipped` with a machine-readable reason and shall emit no WARN.

### FA3 / FA4 — Triage- und Reclassify-Doktrin

**Ubiquitous:**
- The coordinator shall assign every review finding exactly one of `in-scope-blocker`, `follow-up`, `stop-and-escalate` before applying any patch for it.

**State-driven:**
- While a finding is classified `stop-and-escalate`, the coordinator shall not patch it and shall report the scope break.
- While a scope classification or a focused proof is unresolved, the coordinator shall not stack or push review-triggered fix commits.

**Event-driven:**
- When two fix cycles have completed without a strict decrease in blocking findings, the coordinator shall reclassify every remaining finding before starting another cycle.

**Optional feature:**
- Where a critical exception applies, the coordinator may exceed the frozen scope — and the exception set shall be exactly: active data loss, crash, broken install/upgrade, release blocker, concrete security exposure.

**Unwanted behaviour:**
- If a finding would require a new protocol, config surface, storage shape, public API contract, different owner boundary, or release-process change, then the coordinator shall classify it `stop-and-escalate` regardless of how small the patch appears.

### FA5 — Idle-Reset-Bereinigung

**Event-driven:**
- When session-start performs the Idle Reset on the `completed` branch, it shall delete all five `scope-baseline-*` keys via `updateFrontmatterFields(contents, {field: null})`.

**Unwanted behaviour:**
- If the Idle Reset runs, then `## What Not To Retry` and `## Open Questions` shall remain byte-for-byte intact — the new rule shall not widen the reset's blast radius.

### Byte-Budget (querschnittlich)

**Ubiquitous:**
- The added RCR-007 + RCR-008 clauses shall grow `.claude/rules/receiving-review.md` by no more than 2.000 bytes over its 2026-07-25 baseline of **6.225 B as reported by `computeInstructionBudget()`** (frontmatter-stripped; raw `wc -c` reports 6.270 B — the rules-test and this criterion shall both use the `computeInstructionBudget()` figure).

**Unwanted behaviour:**
- If the always-on surface total would exceed its recorded pre-change value by more than 2.000 bytes, then the clauses shall be shortened rather than the budget raised.

## 4. Technical Notes

### Affected Files

Sieben Dateien. Zwei davon fallen unter `DRIFT_EXCLUDE_PATTERNS` → **fünf gezählte**, das ist der Wert für `scope-baseline-planned-files`:

*Gezählt (5):*
- `scripts/lib/scope-baseline.mjs` — **neu.** `writeBaseline()`, `readBaseline()`, `computeDrift()`, `DRIFT_EXCLUDE_PATTERNS`. Nutzt `parseStateMd`/`serializeStateMd` (`scripts/lib/state-md.mjs:14`), `parseSessionId()` (`scripts/lib/session-id.mjs`) und `withStateMdLock` (definiert in `scripts/lib/locks/state-md-lock.mjs:285`, öffentlich re-exportiert über `scripts/lib/session-lock.mjs:60` — dieselbe Import-Fläche, die `session-id.mjs:38` verwendet).
- `.claude/rules/receiving-review.md` — **+RCR-007, +RCR-008.** Letzte bestehende Klausel ist RCR-006, die Nummern sind frei. Frontmatter ist bereits `tier: always` (seit #880), also kein Never-always-on-Brandmauer-Verstoß. Byte-Delta ≤ 2.000 B. **Diese Datei ist der Grund, warum `DRIFT_EXCLUDE_PATTERNS` `.claude/rules/**` behält** — sie ist ein Deliverable dieses Features.
- `skills/wave-executor/wave-loop.md` — Pre-Wave-1 ruft `writeBaseline()`; der Inter-Wave-Checkpoint ruft `computeDrift()` und rendert den WARN.
- `skills/session-end/plan-verification.md` — § 1.1a bekommt die Drift-Zeile in den bestehenden Report-Block (`:46-53`) **plus einen Satz, der auf `DRIFT_EXCLUDE_PATTERNS` als geteilte Quelle zeigt**. Die vollständige Extraktion der Filter in ein gemeinsames Modul ist out-of-scope (§ 2).
- `skills/session-start/SKILL.md` — § Idle Reset bekommt Regel 7 (S5).

*Ausgeschlossen (2):*
- `tests/lib/scope-baseline.test.mjs` — **neu.**
- `tests/rules/check-rules-handwritten.test.mjs` — **erweitert.**

### Architecture

**Warum die Baseline in die STATE.md-Frontmatter gehört — und ausdrücklich NICHT in `wave-scope.json`.** R1 wollte sie in `wave-scope.json` legen, weil das „das eingefrorene Per-Wave-Manifest" sei. Denkfehler: *per-wave*-eingefroren ist nicht *session*-eingefroren. Der Harness schreibt diese Datei **pro Wave neu** (`wave-loop.md:990`), überschreibt sie **mitten in der Wave** bei einer #796-Assertion-Verletzung (`:1027`) und **löscht sie** beim Quality-Wave-Phasenwechsel (`:1032` — wörtlich „After simplification agents complete, **delete** `<state-dir>/wave-scope.json`").

STATE.md ist der richtige Ort, aus vier Gründen, die alle auf bestehende Mechanik zeigen:

1. **Sie führt genau diese Art von Wert schon.** `session-start-ref` ist ein write-once, session-gepinnter Commit — dasselbe Muster. Zwei von sieben Baseline-Feldern existieren bereits und werden wiederverwendet.
2. **Es gibt einen dokumentierten Accessor.** `plan-verification.md:12-23` liest `session-start-ref` bereits über `parseFrontmatter` aus STATE.md.
3. **Sie ist im Coordinator-Carveout von `enforce-scope.mjs`.** `COORDINATOR_CARVEOUT_PATHS` (`:220-225`) listet die vier `STATE.md`-Pfade explizit; der Carveout-Aufruf steht bei `:201-203`. Ein Baseline-Write braucht keinen `allowedPaths`-Eintrag.
4. **Sie überlebt Wave-Churn und ist host-lokal.** Nichts löscht oder resettet STATE.md mitten in der Session (verifiziert: kein `unlinkSync`/`rm`-Pfad gegen STATE.md in `skills/`, `scripts/`, `hooks/`; der Idle Reset läuft ausschließlich bei *session-start* auf dem `completed`-Zweig), und sie ist gitignored (`.gitignore:16`).

Der in R1 genannte Gegengrund — der `withStateMdLock`-Schreibpfad — war keiner: der Lock existiert genau dafür, dass konkurrierende Writer sich nicht überschreiben (PSA-005).

**Session-Scoping: das kanonische Feld heißt `session`, nicht `session-id`.** R3 verglich gegen `session-id` — ein Key, den das Schema **nicht kennt**. `skills/_shared/state-ownership.md:20` dokumentiert `session: <session-id>`, wobei `<session-id>` nur der Wert-Platzhalter ist; `:28` listet `session` unter den **optionalen** Feldern mit der ausdrücklichen Leseregel „writers SHOULD populate these fields but readers MUST tolerate their absence" und verlangt `parseSessionId()` für die Dual-Format-Kompatibilität (semantisch seit #573, legacy UUID-v4 davor). Der Code liest entsprechend `parsed.frontmatter?.session` (`scripts/lib/session-id.mjs:169`).

Warum das gefährlich und nicht kosmetisch war: die **live STATE.md dieses Repos führt beide Keys** mit identischem Wert (`session-id:` in Zeile 4, `session:` in Zeile 5) — ein undokumentiertes Duplikat, das kein Code liest. Ein Smoke-Test auf dieser Maschine wäre grün gewesen. Auf jeder schema-konformen STATE.md — Bootstrap-Platzhalter, anderes Plattform-State-Dir, pre-#573-Datei — wäre `frontmatter['session-id']` `undefined` gewesen, die Regel „weicht ab → stale" hätte **immer** gegriffen, und der Tripwire wäre dauerhaft still inert gewesen. Genau die Inertness, für die die LOC-Achse gestrichen wurde, durch einen Ein-Wort-Namensfehler wieder eingebaut.

Daraus folgen drei Regeln: gegen `frontmatter.session` vergleichen; über `parseSessionId()` lesen; und **das Fehlen des optionalen Feldes explizit behandeln** — beide Seiten `null` gilt als MATCH (einfrieren, nicht dauerhaft stale), eine Seite `null` führt zu frischem Freeze.

Der Session-Scoping-Fix ist zweischichtig, und die Reihenfolge ist Absicht:

- **Primär (Mechanik, S1):** `scope-baseline-session` + der `parseSessionId()`-Vergleich. `readBaseline()` liefert `{stale: true, …}`, `computeDrift()` liefert `skipped: 'stale-baseline'`; `writeBaseline()` behandelt eine fremde Session als *überschreibbar*, nicht als `already-frozen`. Die Baseline ist damit **selbstvalidierend**.
- **Sekundär (Hygiene, S5):** Idle-Reset-Regel 7 räumt zusätzlich auf.

Die Primär-Schicht trägt allein. Eine Lösung, die *nur* aus S5 bestünde, wäre „session-start muss daran denken" — Disziplin statt Mechanik, die Klasse, die uns beim STATE.md-Write-Race schon getroffen hat (PSA-005).

**Symmetrie-Invariante: eine Filterquelle, in Code, für beide Seiten.** R2 filterte den Numerator und nicht den Denominator (planmäßige Session → `0,67`). R3 „verwendete `plan-verification.md:42-45` wieder" — aber diese drei Zeilen sind **nicht gleichartig**:

- `:43` — Test-Dateien mit korrespondierender Produktionsdatei „**are reclassified as expected (not scope creep)**". Das ist eine Bucket-Umbuchung, bedingt, **keine** Mengen-Exklusion; die Datei bleibt gezählt.
- `:44` — Generated/Lock-Dateien „**are excluded** from both planned and actual sets".
- `:45` — die Verzeichnisse `.claude/`, `.codex/`, `.cursor/` „**are excluded** — they are session artifacts, not code".

`:45` schließt damit **ganz `.claude/`** aus — und `.claude/rules/receiving-review.md` ist eine der fünf gezählten geplanten Dateien. Wörtlich angewendet hätte eine planmäßige Session `(7 − 1) / 5 = 1,2` gelesen; liest man `:43` als Exklusion (die erkennbare Absicht), `4/5 = 0,8`; die Herleitung in § Data Model benutzte eine dritte Lesart. **Keine** Lesart ergibt die gepinnte 1,0 — die Invariante war unerfüllbar. Verschärfend: `grep -rln "__tests__\|scope creep" scripts/lib/*.mjs` findet **nichts**, `:42-45` ist nirgends implementiert. „Wiederverwenden" hätte zwei handsynchronisierte Prosa-Listen bedeutet — das Disziplin-statt-Mechanik-Muster, das zwei Absätze weiter oben abgelehnt wird.

Der Fix ist eine **exportierte Konstante im neuen Modul**, die beide Seiten speist:

```js
export const DRIFT_EXCLUDE_PATTERNS = [
  // Tests — auf BEIDEN Seiten ausgeschlossen (nicht "reclassified" wie :43)
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**',
  // Generated / Lock (deckt :44)
  'package-lock.json', 'pnpm-lock.yaml', '*.lock', 'dist/**', 'node_modules/**',
  // Per-Session-State — verengt :45 bewusst auf die ARTEFAKTE statt des
  // ganzen Verzeichnisses. `.claude/rules/**` bleibt GEZÄHLT: eine Rule-Datei
  // ist ein Deliverable, kein Session-Artefakt.
  '.claude/STATE.md', '.claude/wave-scope.json', '.claude/metrics/**',
  '.codex/STATE.md', '.codex/wave-scope.json', '.codex/metrics/**',
  '.cursor/STATE.md', '.cursor/wave-scope.json', '.cursor/metrics/**',
  '.pi/STATE.md', '.pi/wave-scope.json', '.pi/metrics/**',
];
```

Gematcht wird mit `pathMatchesPattern()` aus `scope-gate.mjs` — derselbe Matcher, den `enforce-scope.mjs` Gate 7 verwendet, also keine vierte Glob-Semantik im Repo. `plan-verification.md` bekommt einen Satz, der auf diese Konstante als geteilte Quelle zeigt; die vollständige Extraktion ist out-of-scope (§ 2).

**Schwellwert-Abgleich: warum 2.0 neben dem bestehenden 1.3 keine Dublette ist.** Es gibt bereits einen Schwellwert auf der Familie „Dateien vs. geplante Dateien" — `R > 1.3` in `session-plan/SKILL.md:115` und `:401`:

| | bestehend (1.3) | neu (2.0) |
|---|---|---|
| Zeithorizont | **Median über die letzten ~5 Sessions** | **momentan, kumulativ in dieser Session** |
| Denominator | geplante Dateien *dieser Wave*, ungefiltert | eingefrorene gezählte `plannedFiles` *dieser Session* |
| Numerator | `files_changed` der Wave, **ungefiltert** | gezählte Dateien seit `session-start-ref` |
| Symmetrie | beide Seiten ungefiltert | beide Seiten über `DRIFT_EXCLUDE_PATTERNS` |
| Konsequenz | inflationiert die Schätzung der **nächsten** Session | WARN in der **laufenden** Session |
| Ausschlüsse | Discovery/Finalization-Waves | Tests, Lock/Generated, Per-Session-State — auf **beiden** Seiten |

Zwei Zahlen für zwei Fragen. Beide sind intern symmetrisch — der bestehende Regler filtert auf keiner Seite, der neue auf beiden. Zu dokumentieren, nicht zu vereinheitlichen.

**Warum `computeDrift()` selbst rechnet und `over_delivery_ratio` NICHT als Datenquelle nutzt.** `grep -rn "planned_files_count\|plannedFiles" scripts/ hooks/` liefert **null Treffer** (verifiziert 2026-07-25) — `wave-loop.md:732-733` ist Prosa an den Koordinator-LLM, kein aufrufbares Modul; die einzigen Code-Treffer sind Tests, die die Prosa assertieren. Ein Test, der „Übereinstimmung pinnt", wäre außerdem unschreibbar — die beiden Zahlen können per Konstruktion nicht übereinstimmen (siehe Tabelle).

**Sync/Async-Regel.** `readBaseline()` und `computeDrift()` sind **synchron** (`readFileSync`, `execFileSync` für `git diff --name-only`) — reine Lesepfade, deren Aufrufer Prosa-Flächen ohne Async-Zwang sind. `writeBaseline()` ist **async**, weil `withStateMdLock()` async ist; das ist der einzige Grund und die einzige Ausnahme. Damit bleibt die `scope-gate.mjs`-Konvention („all-sync für Hook-Hot-Paths") überall erhalten, wo sie ohne Lock erreichbar ist.

**Lock-Fehler müssen abgefangen werden.** `withStateMdLock()` wirft **absichtlich**: `scripts/lib/locks/state-md-lock.mjs:266-270` dokumentiert wörtlich „throws a labelled Error so callers see the failure as an exception rather than a silent `{ok:false}` return. This is the contract that lets call sites use plain `await withStateMdLock(repoRoot, async () => …)` without branching." Da FA1 „shall never throw" fordert, MUSS `writeBaseline()` den Lock-Aufruf in try/catch wrappen und den Throw in `{written: false, reason: 'lock-timeout'}` übersetzen.

**`readBaseline()` muss zwei Zustände unterscheiden.** Ein `null` für „keine Baseline" **und** „veraltete Baseline" hätte `computeDrift()` gezwungen, die Frontmatter ein zweites Mal zu parsen, um die beiden Skip-Gründe auseinanderzuhalten — zwei Lesepfade auf dieselbe Datei, die auseinanderdriften. Daher: `null` nur für „keine Baseline", `{stale: true, baselineSession, currentSession}` für veraltet.

**Warum warn-only statt Gate 8 in `enforce-scope.mjs`:** `getEnforcementLevel()` defaultet fail-closed auf `strict`. Ein Tripwire mit Rechenfehler würde damit nicht warnen, sondern Waves hart blocken — genau in der Situation, in der der Operator am wenigsten Lust auf einen Harness-Bug hat. Enforcement ist der 2-Wochen-Pfad.

**Fail-Open-Asymmetrie — bewusste Ausnahme von einer modulweiten Konvention.** Dieses Modul ist bei unlesbaren Daten **fail-open** (`skipped`). Das weicht von einer **dokumentierten Modul-Konvention** der Scope-Domäne ab: `getEnforcementLevel()` (`scope-gate.mjs:50-57`) und `gateEnabled()` (`:68-79`) fallen beide Richtung Enforcement, und `assertFileScopeSubset()` deklariert im Docstring „Fail-closed & no-throw (module convention)" (`:195-197`). Begründung: ein *blockierender* Gate muss bei Unlesbarkeit misstrauisch sein, ein *warnendes* Signal muss schweigen — ein WARN auf unlesbaren Daten ist Rauschen, das die Glaubwürdigkeit des Guards zerstört. Diese Begründung MUSS als Kommentar im Modul stehen und die Konvention beim Namen nennen, damit der nächste Leser eine bewusste Ausnahme sieht und keinen Flüchtigkeitsfehler „vereinheitlicht".

### Data Model Changes

Additive Erweiterung der STATE.md-Frontmatter um fünf flache Keys — keine DB, keine Migration, keine Schema-Version-Erhöhung (`schema-version: 1` bleibt; verifiziert: kein `additionalProperties`/`allowedKeys` in `scripts/lib/state-md.mjs`, und `serializeStateMd` iteriert `Object.entries(frontmatter)` ohne Allowlist). Flache Keys sind Pflicht, nicht Stil: der Parser stützt nur **eine** Nesting-Ebene und die ausschließlich für eingerückte `- key: value`-Sequenzen (`scripts/lib/state-md/yaml-parser.mjs:8`) — eine verschachtelte Map wäre nicht round-trip-fähig.

```yaml
---
schema-version: 1
session-type: feature
session: main-2026-07-26-feature-1                 # KANONISCH (state-ownership.md:20), optional
branch: main                                       # bereits vorhanden — wiederverwendet
session-start-ref: 23f7812                         # bereits vorhanden — wiederverwendet
# ---- neu (5 Keys) ----
scope-baseline-intent: "Scope Governor: Baseline-Freeze + 2x-Tripwire (Datei-Achse, warn-only) + RCR-007/008"
scope-baseline-owner-boundary: "scripts/lib/ + .claude/rules/receiving-review.md + skills/ + tests/"
scope-baseline-planned-files: 5
scope-baseline-session: main-2026-07-26-feature-1
scope-baseline-frozen-at: 2026-07-26T08:00:00Z
---
```

**Herleitung der 5.** § 4 Affected Files listet sieben Dateien. `DRIFT_EXCLUDE_PATTERNS` schließt davon zwei aus (`tests/lib/scope-baseline.test.mjs`, `tests/rules/check-rules-handwritten.test.mjs` via `**/*.test.*`). `.claude/rules/receiving-review.md` wird **gezählt** — die Konstante verengt `:45` genau dafür. Bleiben fünf. Eine Session, die genau diese sieben Dateien anfasst, liest `5/5 = 1,0`.

### API Changes

Vier neue named exports aus einem neuen Modul. Keine bestehende Signatur ändert sich.

```js
export const DRIFT_EXCLUDE_PATTERNS  // string[] — die EINZIGE Filterquelle für beide Seiten

// ASYNC — weil withStateMdLock() async ist (die einzige Ausnahme von der sync-Regel)
writeBaseline({ repoRoot, intent, ownerBoundary, plannedFiles })
  → Promise<{ written: boolean, reason?: string }>
  // reason ∈ 'already-frozen' | 'no-state-md' | 'unreadable-state-md' | 'lock-timeout'
  // branch, session-start-ref und session werden aus der bestehenden Frontmatter
  // gelesen (session via parseSessionId()), nicht übergeben. Eine fremde Session
  // gilt als STALE und wird überschrieben — nicht als 'already-frozen' abgewiesen.

// SYNC — reiner Lesepfad. Drei unterscheidbare Rückgaben, damit computeDrift()
// die Frontmatter nicht zweitlesen muss.
readBaseline(repoRoot)
  → null                                              // keine Baseline
  | { stale: true, baselineSession, currentSession }   // veraltet
  | { intent, ownerBoundary, plannedFiles, session, frozenAt, branch, sessionStartRef }

// SYNC — readFileSync + execFileSync('git', ['diff','--name-only', …])
computeDrift({ repoRoot, threshold = 2.0 })
  → { ok: true, skipped: true, reason: string }
  | { ok: true, skipped: false, filesRatio, plannedFiles, actualFiles,
      breached, threshold, refUsed }
  // reason-Präzedenz (erste Übereinstimmung gewinnt):
  //   no-state-md → unreadable-state-md → no-baseline → stale-baseline → unresolvable-ref
  // refUsed weist aus, ob session-start-ref oder der origin/main-Fallback benutzt wurde
```

## 5. Risks & Dependencies

| Risk | Impact | Mitigation | Triage |
|------|--------|------------|--------|
| Tripwire feuert auf legitime Waves (False Positive) und erodiert Vertrauen | Mittel — ein ignorierter WARN ist schlimmer als keiner | Warn-only in v1; Schwelle konfigurierbar; der WARN nennt `plannedFiles` und `actualFiles`, nicht nur „Drift" | Implement |
| Tripwire ist stumpf, weil beide Seiten unterschiedlich filtern | Hoch — grün und wirkungslos zugleich (R2- **und** R3-Blocker, zweimal in Folge) | Eine exportierte Konstante, in Code, für beide Seiten; `pathMatchesPattern()` als geteilter Matcher; die 1,0-Invariante ist der ERSTE zu schreibende Test | Implement |
| Vergleich gegen einen Key, den das Schema nicht kennt → dauerhaft inert | Hoch — still, und auf dieser Maschine wegen eines Key-Duplikats **nicht** reproduzierbar (R3-Blocker) | Gegen `frontmatter.session` via `parseSessionId()`; explizite Regel für das Fehlen des optionalen Feldes; ein Test mit einer STATE.md, die **nur** `session` trägt | Implement |
| Veraltete Baseline aus der Vorsession verfälscht die Messung ab Session 2 | Hoch — still und dauerhaft (R2-Blocker) | Zweischichtig: `scope-baseline-session` macht die Baseline selbstvalidierend (Mechanik), Idle-Reset-Regel 7 räumt auf (Hygiene). Die Mechanik trägt allein | Implement |
| RCR-007/008 als Prosa ohne Mechanik = Disziplin-statt-Mechanik | Mittel — die Klasse, die uns beim STATE.md-Write-Race schon getroffen hat (PSA-005) | Bewusst akzeptiert: die Triage ist eine Urteilsentscheidung, die kein Hook treffen kann. Der Tripwire ist der mechanische Anteil. Der Rules-Test verifiziert die Auslieferung | Implement |
| `stop-and-escalate` wird zur Ausrede, unbequeme Findings wegzurouten | Hoch, wenn es passiert — invers zum Zweck | Escalate-Trigger **enumeriert**, Kritisch-Ausnahmeliste **geschlossen**; der Rules-Test pinnt die Vollständigkeit beider Listen | Implement |
| Zwei Schwellwerte (1.3 / 2.0) auf verwandten Metriken verwirren | Mittel — Bug-Generator, wenn undokumentiert | Abgrenzungstabelle mit sechs Achsen in § 4; beide Zahlen bleiben absichtlich verschieden | Implement |
| Byte-Budget: zwei neue always-on-Klauseln wachsen die Koordinator-Fläche (102.401 B) | Niedrig, aber kumulativ | Harte Grenze ≤ 2.000 B (§ 3.A), gemessen mit `computeInstructionBudget()` vor/nach. #885 schafft parallel ~28 KB Luft | Implement |
| Lock-Timeout wirft und bricht den Wave-Start ab | Niedrig | try/catch → `{written:false, reason:'lock-timeout'}`; FA1 hat ein eigenes Szenario | Implement |
| `DRIFT_EXCLUDE_PATTERNS` und `plan-verification.md:42-45` driften auseinander | Mittel — die billige Form des Fixes lässt zwei Quellen bestehen | Bewusst akzeptiert für 1w: `plan-verification.md` bekommt einen Zeiger auf die Konstante. Die vollständige Extraktion ist als erster 2w-Kandidat in § 2 vermerkt | Defer |
| `persistence: false` deaktiviert das Feature vollständig | Niedrig für dieses Repo (`persistence: true`), aber eine echte Abdeckungs-Regression der Verlagerung | Bewusst akzeptiert: in R1 lag die Baseline in `wave-scope.json`, das der Harness unabhängig von `persistence` schreibt. Für `persistence: false`-Repos liefert S2 dauerhaft `skipped: 'no-state-md'`. Alternative wäre ein zweiter Speicherort — genau die Duplizierung, die R1 zum Scheitern brachte | Defer |
| Mechanisches Enforcement zu früh: Rechenfehler blockt Waves hart | Hoch — Harness-Bug im Blockierpfad | Explizit out-of-scope; `enforcement`-Default `strict` ist der Grund. 2-Wochen-Pfad | Reject (in v1) |
| LOC-Achse fehlt, „wenige Dateien, sehr viele Zeilen" wird nicht erkannt | Niedrig-Mittel | Bewusst akzeptiert, in Out-of-Scope begründet: ohne Produzent wäre jeder Denominator erfunden. Rückgabeobjekt erweiterbar | Defer |

### Dependencies

- **#876 (Koordinator-Payload-Truncation) — ✅ ERFÜLLT, gelandet als `23f7812` am 2026-07-25.** War harte Voraussetzung: davor fiel `receiving-review.md` komplett aus dem Koordinator-Payload, neue RCR-Klauseln wären wirkungslos gewesen. Issue closed.
- **#884 (Batch 2 / T1 — `quality-gates-autofix.md` MERGE/DEMOTE) — Kollision, durch Design aufgelöst.** #884 will die Datei demoten, weil sie hinter dem deaktivierten `verification-auto-fix`-Flag hängt. Dieses PRD dockt **nicht** dort an, sondern an `receiving-review.md` (Doktrin) + `wave-loop.md`/`plan-verification.md`/`session-start/SKILL.md` (Mechanik). Keine gemeinsame Datei; das muss beim Umsetzen so bleiben.
- **#882 (Always-on-TOTAL-Budget) — Kopplung, budgetiert.** Harte 2.000-B-Grenze als Akzeptanzkriterium statt additivem Draufpacken.
- **#886 (Batch 2 / T3 — acht belegte Instruction-Widersprüche) — Übergabe.** Der Bug-Class-Sweep-Widerspruch (`quality-gates-autofix.md:31-32` vs. autoreviews Klassen-Fix-Pflicht) ist ein belegter neunter Widerspruch und gehört dorthin.
- **#868 (kumulatives `files-touched`-Ledger in STATE.md) — optionale Aufwertung, nicht blockierend.** Wenn #868 landet, wird das Ledger die genauere Quelle für `actualFiles` über mehrere Waves — und es landet in derselben Datei, die dieses Feature bereits beschreibt. Achtung: das Ledger müsste `DRIFT_EXCLUDE_PATTERNS` respektieren, sonst kehrt die Asymmetrie über die Hintertür zurück.
- **#817 (macOS-E2E-Profil) — Nachbar, kein Konflikt.** Besitzt den Evidence-Contract für das source-blinde Behavior-Gate. Relevant erst, wenn Kandidat 2 (Score 0.54) gebaut wird.
