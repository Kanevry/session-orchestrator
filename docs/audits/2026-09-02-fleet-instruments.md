# Fleet-Mining v2 — Instrumenten-Audit über 18 Repos

**Datum:** 2026-09-02 (HEAD `a019d5a4`)
**Gegenstand:** Nachfolger von Epic #723 (2026-07-02) — kein Neu-Ernten, sondern der Delta nach zwei Monaten: was die eigenen Telemetrie-Instrumente tatsächlich messen, und was der Orchestrator daraus bauen sollte.
**Verfahren:** 10 Discovery-Agenten (D1–D10) derselben Welle, alle gegen dieselbe HEAD-Referenz, gemessen über die Learnings-, Event- und Session-Ledger von 18 Repos auf einem Betreiber-Host plus die anonyme Telemetrie-Ingest-Datenbank. Eine der 19 gesichteten Arbeitskopien war eine identifizierte **Kopie** eines anderen Fleet-Repos (identische Wave-Zählstände, proportional gleiche Event-Verteilung) und ist überall ausgeschlossen.

Dieses Dokument ist der öffentliche, bereinigte Auszug aus dem privaten Fleet-Mining-Bericht (Meta-Vault). Repo-Namen außer `session-orchestrator`, Personennamen, Host-Pfade und anonyme Telemetrie-IDs sind entfernt; Kennzahlen bleiben fleet-weit summiert.

---

## 1. Zweck und Grundgesamtheit

| Korpus | Zahl |
|---|---|
| Repos (ohne die eine Kopie) | 18 |
| Learnings gesamt | 1.587 |
| davon eligible (`filterEligible`, roh) | 440 |
| Reconcile-Kandidaten | 909 |
| generierte Regeln | 90 |
| Learnings ohne jeden Konsumenten | 252 |
| Events, parsebar, ohne Kopie | 143.967 |
| unparsebare Event-Zeilen | 0 in allen 19 Repos |
| Telemetrie-Records (anonyme Ingest-DB) | 347 / 6 `anon_id` |

Drei Zensus-Agenten deckten die 18 Repos in disjunkten Gruppen ab (4 + 6 + 8), zwei mit semantischer Lektüre der aktiven Subjects, einer mit einem priorisierten Keyword-Klassifikator über alle Records — jede Methode nennt ihre eigene Einschränkung (Counts als Untergrenze bzw. bewusst ungeclusterter Rest). Die Messzeitpunkte der zehn Artefakte liegen zwischen 13:03 und 15:12 UTC; zwei trugen einen Mitternachts-Platzhalter im `measured_at`-Feld, ihr echtes Laufzeitfenster ergibt sich aus Dateizeitstempeln. Mehrfach beobachtete +1/+2-Abweichungen gegen eine ~60 Minuten ältere Zwischenzahl sind laufender Schreibverkehr, kein Widerspruch.

Die zwei dominanten Ablehnungsgründe für Reconcile-Kandidaten sind fleet-weit identisch: `empty-file_paths` (Grund Nr. 1 in 15 von 18 Repos) und `type-not-in-allowlist`. Confidence gatet die Eligibility gar nicht — sie ist ein Auslieferungs-Gate auf Proposals, nicht auf Kandidaten.

## 2. Instrumenten-Verdikte

Nenner der Feuerraten ist die Zahl distinkter `session_id` aus `orchestrator.session.started` = **1.692**.

| Instrument | Verdikt | Kernzahl | Kommando/Nachweis |
|---|---|---|---|
| `orchestrator.agent.stopped` | outcome-blind | 87.334 Records (60,7 % aller Events), 0 mit Status; `agent` leer in **86,7 %** (89.991/103.763); dominante Key-Form `[agent,event,timestamp]` = 97,8 %, also unjoinbar | `jq -c 'select(.event=="orchestrator.agent.stopped")|keys' \| sort \| uniq -c` |
| `orchestrator.session.stopped` | outcome-blind | `duration_ms` ist **8.127 von 8.127** literal 0; kein Status-/Exit-Feld im Schema | `jq -r 'select(.event=="orchestrator.session.stopped")|.duration_ms' \| sort \| uniq -c` |
| `orchestrator.session.ended` | unfalsifiable | `reason` zu **96,3 %** `other` (**1.286/1.335**); echte Gründe: completed 27, resume 12, clear 8, error 1, close 1. Nenner: alle `~/Projects/*/.orchestrator/metrics/events.jsonl` ohne die `<duplicated-working-copy>`, nachgemessen 2026-09-02 (W4a F-F) | `for d in ~/Projects/*/; do case "$d" in *<copy>*) continue;; esac; jq -c 'select(.event=="orchestrator.session.ended")' "$d.orchestrator/metrics/events.jsonl"; done \| jq -s 'group_by(.reason)'` |
| `discovery_validator_violation` | broken **+ falsch gezielt** | feuert in 238/1.692 = **14,1 %** der Sessions, 6.946 Events fleet-weit; **14,0×** Duplikatfaktor; scope-bereinigte Präzision auf einer n=60-Stichprobe: **0/60** | deterministische Stichprobe (`shuf --random-source=<(yes 11)`, n=60) |
| `orchestrator.destructive_guard.blocked` | broken | **205/1.692 = 12,1 %**; `rule` zu 100 % gesetzt | Session-Feuerrate über `orchestrator.session.started`-Nenner |
| `orchestrator.destructive_guard.warned` | working | 75/1.692 = 4,4 %, outcome-tragend über `rule` | s.o. |
| `orchestrator.quality_gate.passed/.failed` | repo-only | 8.836/13 fleet-weit, davon **99,4 %** aus `session-orchestrator` selbst; Emitter ist fleet-weiter Code, die Aufrufstelle ist Koordinator-Prosa | `jq -c 'select(.event\|test("quality_gate"))' … group_by(.repo)` |
| `orchestrator.auq_clarity.allowed/.denied` | **working — Prämisse korrigiert** | 515 allowed / **74 denied** = 12,6 % Ablehnungsquote. Die behauptete „`.blocked` = 0" nennt ein Verb, das im Quelltext nicht existiert (der Hook emittiert nur `.allowed`/`.denied`) — kein Unfalsifiable-Fall | `jq -r 'select(.event\|test("auq_clarity"))|.event' \| sort \| uniq -c` |
| `orchestrator.express_path.evaluated` | unfalsifiable | 36 Records in 7 Repos, `activated=true` nur **2/36 = 5,6 %** | `jq -r 'select(.event=="orchestrator.express_path.evaluated")|.activated' \| sort \| uniq -c` |
| `session.lock.acquired/.released` | unfalsifiable | **1.050 acquired vs. 95 released**; mit reaped(9)+reconcile_attempted(14)+release_failed(1)=119 → nur **11,3 %** der Acquisitionen tragen überhaupt ein Auflösungs-Event | `jq -r 'select(.event\|test("session.lock"))|.event' \| sort \| uniq -c` |
| `orchestrator.wave.started/.completed` | working (nur Lebenszyklus) | started 1.018 / completed 722 → Lücke **296**, und **296 == Zahl der Wave-Runs**, in jedem Repo einzeln; Klasse „Re-Fire": 0 | strukturelle Lauf-Rekonstruktion (`completed(N)`/`started(N+1)` teilen den Zeitstempel) |
| `tmux-layout.*` | repo-only | 4.098+3.752+346 Records, **100 %** aus einem einzigen Repo, seit 2026-08-07 inaktiv | `jq -r 'select(.event\|startswith("tmux-layout"))|.event'` |
| `orchestrator.reconcile/evolve/dialectic.*` | **existiert nicht** | 0 Events in 164.361; einziger Homonym-Treffer `session.lock.reconcile_attempted` (×15) | `… \| jq -r '.event//empty' \| grep -iE 'reconcil\|evolve\|dialectic' \| sort \| uniq -c` |

**Korrelations-Blindstelle:** `semantic_session_id` deckt fleet-weit **8,1 %** der Events ab, `session_id` 23,2 %. Bei Wave-Events sind es **1.700 von 1.740 (97,7 %) ohne jeden Session-Schlüssel** — die Anreicherung beginnt erst am 2026-09-02T05:24:27Z. Jede per-Session-Paarung auf dem historischen Korpus ist damit unmöglich; nur die strukturelle Lauf-Rekonstruktion oben umgeht das.

## 3. Cross-Repo-Themen (Top 15, gemergt)

Rang = Repo-Zahl, dann Σ (Summe der Teilzählungen — nicht dedupliziert, Themen können überlappen).

| # | Thema | Repos | Σ | Relevanz | Plugin-Fläche |
|---|---|---|---|---|---|
| T1 | Ein grünes Signal (CI, Test, HTTP-200, deploy-ok) beweist die Wirkung nicht — nur eine Live-Messung tut das | 12 | 101 | high | Gate (Live-Verify-Probe vor Issue-Close) |
| T2 | Eine alte, ungemessene Prämisse (Issue-Text, SSOT-Doku, Agenten-Selbstbericht) wird als Tatsache in die Welle gescoped | 16 | 73 | high | Probe (W1-Prämissencheck, verpflichtend) |
| T3 | Ein Reviewer mit ausdrücklichem Widerlegungsauftrag findet nach grünem Gate reale Defekte | 7 | 27 | high | Rolle/Regel (Panel, RCR-009) |
| T4 | Paralleler Datei-Scope / geteilter Arbeitsbaum / geteilter git-Index kollidiert zwischen Agenten und Sessions | 11 | 57 | high | Hook (Scope-Guard, Index-Lock) |
| T5 | Der Dispatch-Kanal ist verlustbehaftet: Agenten sterben am Turn-Limit, Acks und Inhalte müssen nachgezählt werden | 12 | 27 | high | Event+Hook (`agent.stopped`-Outcome, Started-Set-Verifikation) |
| T6 | Ein Wächter misst die falsche Größe oder greift am Matcher vorbei | 10 | 41 | high | Hook/Gate (Kategorie-Trennung statt Schwellen-Anhebung) |
| T7 | STATE.md / session.lock / Registrierung sind Maschinenverträge, kein Prosa-Feld — und veralten still | 7 | 21 | high | Regel+Event (state-ownership, Lock-Telemetrie) |
| T8 | CLI-Werkzeuge scheitern still: Batch-Verluste, fehlendes Word-Splitting, typografische Anführungszeichen, `--help` lügt | 10 | 31 | high | Skill-Referenz (gitlab-ops) + Probe |
| T9 | Migration, Deploy-Trigger und Code sind entkoppelt — Reihenfolge und Cache erzeugen stille Drift | 12 | 43 | medium | Probe (Deploy-Reihenfolge, Env-Parität) |
| T10 | Schema-/Vertragsdrift zwischen Produzent und Konsument (Frontmatter, Exports, Lockfiles) | 9 | 46 | medium | Gate (contract-version-bump, Parity-Check) |
| T11 | Datenbank-RLS: GRANT und REVOKE sind asymmetrisch, Verifikation braucht die echte Rolle | 5 | 22 | medium | Probe (RLS-Rollen-Test) |
| T12 | Secrets lecken über Nebenwege (Build-Artefakt, unvollständige Redaktion) | 5 | 17 | medium | Hook (Pre-Commit-Leak-Scanner, SEC-021) |
| T13 | Fremdmodell- und Peer-Arbeit braucht semantische Nachprüfung, nicht nur Diff-Größe | 7 | 14 | high | Regel (Pflicht-Review nach Foreign-Dispatch) |
| T14 | Session-Größe und mode-selector-Treffsicherheit — teils Maschinen-Records, keine organischen Learnings | 9 | 27 | medium | Event (statt Learnings-Record) |
| T15 | Browser-/UI-Automatisierung: Screenshot-Blindstellen, fehlendes Session-Flag, geteilte Test-Host-Ressourcen | 8 | 21 | medium | Skill (test-runner, agent-browser-Konvention) |

T7 ist vollständig, und Teile von T3/T4/T5/T14 sind selbstreferenziell (Plugin-eigene Records) — alle vier bestätigen sich aber **cross-repo** außerhalb des Plugin-Repos, gehen also als echte Flotten-Muster in §7 ein. Ein separater Einzel-Repo-Bucket „repo-spezifische Tool-Eigenheiten" (n=28, 6 Repos) ist bewusst als Auffangeimer markiert und zählt nicht als Thema.

## 4. Telemetrie

**Bestand:** 347 Records, 6 `anon_id`, 2026-07-20 … 2026-09-02, gemessen über die schreibgeschützte anonyme Ingest-Datenbank.

**Wöchentlich:** W29 = 0 (Platzhalterzeile ohne Rohdaten), W33 = 2 (1 id), W34 = 51 (2), W35 = 160 (4), W36 laufend = 65 roh. Digest-Nachrechnung für W35 (2026-08-24…30) stimmt exakt mit dem gespeicherten Aggregat überein: 160 total, darwin 147 / linux 12 / win32 1, claude 159 / codex 1, Top-3-Skills session-end 92, session-start 91, session-plan 71. **Aber:** W30–W32 haben Rohdaten und keine `aggregates_weekly`-Zeilen — eine Backfill-Lücke des Digest-Jobs, unabhängig vom unten beschriebenen Fix.

**Zwei echte Fremdnutzer** — nur nach Plattform, ohne ID. Bewusst **kein** gemeinsames Tupel aus Version, Zeitfenster, Record-Zahl und Skill-Auswahl je Nutzer: bei einer Grundgesamtheit von zwei ist genau dieses Tupel das Identifikationsmerkmal, das die Anonymisierung entfernen soll. Alles Weitere steht nur summiert:

- Ein Nutzer auf **Linux/x64**, auf zwei Harnesses (claude und codex).
- Ein Nutzer auf **Windows-on-ARM (win32/arm64)**, nur claude.

Aggregat über beide zusammen: **20 Records**; `session-start` erscheint in **0 von 20**; die Mehrzahl der Sessions läuft länger als drei Stunden.

**Die `session-start`-Anomalie.** Der Einstiegspunkt schreibt seit 2026-05-21 einen expliziten Skill-Tool-Aufruf vor; lokal feuert er zuverlässig (93 Records). Bei beiden Fremdnutzern zusammen: 0 von 20 Records. Statische Code-Inspektion löst das nicht auf — es bräuchte Laufzeitbelege von den fremden Maschinen. Der Fix ist unabhängig von der Ursache: `session-start` bekommt denselben expliziten Selbstmelde-Block, den `session-end` bereits hat.

**Windows-Portabilität.** Die Hook-Kette ruft jeden Hook über eine `sh`-Wrapper-Datei auf, die selbst `#!/bin/sh` ist. Auf einem nackten Windows ohne POSIX-Shell auf `PATH` ist diese Kette nicht lauffähig. Für den gemessenen Windows-Fremdnutzer ist das **kein bestätigter** Defekt — seine Records tragen korrektes OS/Arch und korrekte Skill-Auswahl, es läuft dort also eine sh-fähige Shell (vermutlich Git Bash). Bleibt ein Portabilitätsrisiko für Installationen ohne Git Bash/WSL — ein Follow-up, kein Fix dieser Session.

## 5. Delta gegen den letzten Fleet-Bericht (2026-07-02)

Fleet-Totale, keine Repo-Aufschlüsselung:

| Behauptung damals | Wert damals | Wert heute (2026-09-02) | Richtung |
|---|---|---|---|
| reconcile/evolve/dialectic-Events | 0 | weiterhin 0 in 164.361 Events | unverändert |
| Repos ohne je gelaufenen `/reconcile` | 3 | **10 von 18** | verschoben, nicht behoben |
| Learnings ohne Konsumenten | ~350+ | **252** | besser |
| archivierte Learnings | 122 | **145** | erwartbar gestiegen |
| Learnings mit `file_paths` | 0/101 (ein Repo) | **1.055/1.587 (66 %) fehlen fleet-weit** | besser, weiterhin dominant |
| Feld-Dialekte je Repo | 4–9 (handkuratiert) | nicht vergleichbar: mechanisch gezählt reichen die Key-Set-Formen von 1 bis 33 | Metrik gewechselt, Drift wirkt schlechter |

`reconcile.enabled` steht fleet-weit in **jedem** Repo auf `false` — auch in `session-orchestrator`, das den Konfigurationsblock committet und trotzdem inaktiv lässt. Jede Reconcile-Kandidatenliste, die existiert, kam per on-demand-Aufruf zustande, nie über den automatischen Sessionsabschluss.

## 6. In dieser Session umgesetzt

| Issue | Fix in einer Zeile |
|---|---|
| **#1189** | Telemetrie klassifiziert Kommandos: eine Klassifikationspasse über die Vereinigung von Skill- und Kommandonamen mit Präfix-Strip gegen die Roster-Kommandos — heute schreibt kein Hook je ein Kommando-Feld, das Feld ist per Konstruktion immer leer |
| **#1190** | `orchestrator.agent.stopped` bekommt Nutzlast: `agent` nur noch wenn nicht-leer, dazu optional Agent-ID, Agent-Typ-Metadaten, Tool-Use-ID, Transkript-Fund, Dauer+Dauer-Quelle, Status — kein Integer-Bump, da es gar keine Payload-Registry gibt |
| **#1191** | `discovery-validator` Default zurück auf `false` (opt-in) plus zwei nicht mitgeflippte Doku-Flächen; ein Scope-Follow-up ist separat erfasst |
| **#1192** | Ein neues Event für abgeschlossene Reconcile-Läufe — als Wrapper um die Engine, nicht inline, weil die Engine drei Rückgabepunkte hat und ein Inline-Emit zwei davon verfehlen würde; ohne Repo-Kontext wird der Emit übersprungen |
| **#1193** | Die fehlende finale Wave-Abschluss-Meldung wird beim Sessionsende idempotent nachgetragen, über eine neue Hochwassermarke im Session-Statusobjekt |

## 7. Kandidaten für den Orchestrator (gerankt)

`Art`: **F** = Flotten-Muster, **S** = Selbstdefekt (Plugin-eigenes Instrument).

| # | Mechanismus | Fläche | Aufwand | Nutzen | Art |
|---|---|---|---|---|---|
| K1 | discovery-validator liest das Subagenten- statt das Haupt-Transkript; dedupe je (Session, Claim-Text); Negativ-Kontext-Guard gegen Plan/Intent/Score-Prosa | Hook | M | Instrument macht erstmals seinen genannten Job (0/60 → erwartet ≈3/60) | S |
| K2 | Deterministischer Reconcile-Auslöser statt `enabled:false`-Stillstand + ein Abschluss-Event als Falsifikationsspur | Event+Gate | M | §723-Punkt 1 endlich messbar | S |
| K3 | Abschluss-Events für die evolve- und dialectic-Pipeline (beide reine Prosa-Aufrufstellen ohne jeden Emit) | Event | S | zwei blinde Pipelines werden falsifizierbar | S |
| K4 | `session.ended.reason` aus dem `other`-Sammeleimer holen (96,3 %) — echte Gründe an den Aufrufstellen setzen | Event | S | Abbruchquote wird zum ersten Mal lesbar | S |
| K5 | `session.stopped.duration_ms` tatsächlich messen statt 0 zu schreiben | Event | S | Sitzungsdauer ohne Fremdquelle | S |
| K6 | `session.lock.released`-Abdeckung: Release-Emit an allen Auflösungspfaden inkl. Reaper | Event | M | Lock-Leichen werden zählbar (T7) | S |
| K7 | Quality-Gate-Emit von Koordinator-Prosa auf einen deterministischen Hook umhängen | Hook | M | Gate-Telemetrie fleet-weit vergleichbar | S |
| K8 | Skill-Selbstmeldung für prosa-aufgerufene Skills: `session-start` bekommt den Block, den `session-end` schon hat | Hook/Skill | S | Fremdnutzer-Journeys werden vollständig | S |
| K9 | Telemetrie-Digest-Backfill für die Lücke W30–W32 | Job | S | Wochenreihe ohne Loch | S |
| K10 | Live-Verify-Probe vor dem Schließen deploy- oder fix-tragender Issues: ein echter Endpunkt-/Render-Beleg statt CI-grün | Gate | M | größtes Flotten-Muster überhaupt (T1) | F |
| K11 | Verpflichtender W1-Prämissencheck: jedes gescopte Issue braucht eine frische Messung gegen den Live-Code vor der Implementierungswelle | Probe | M | verhindert die teuerste Fehlklasse (T2) | F |
| K12 | Konsumenten-Hygiene-Probe für Fremd-Repos: Hooks, die eine Umgebungsvariable statt stdin lesen, sind permanente No-Ops; Windows-Portabilität des sh-Wrappers | Probe | M | fängt still tote Guards in Konsumenten-Repos | F |

## 8. Anhang

### Artefakte (Discovery-Agenten dieser Welle)

| Agent | Größe | Inhalt |
|---|---|---|
| D1 | 44,3 KB | 29 Themen, semantisch, 4 Repos |
| D2 | 34,9 KB | 22 Themen, semantisch, 6 Repos |
| D3 | 85,0 KB | 33 Themen, Keyword-Klassifikator + Feld-Dialekte, 8 Repos |
| D4 | 74,7 KB | 12 Instrumenten-Verdikte, Feuerraten-Klassen |
| D5 | 22,5 KB | Telemetrie, Nutzer-Journeys, #1189-Ursache |
| D6 | 20,1 KB | Zensus + Delta gegen §723 |
| D7 | 21,9 KB | `agent.stopped`-Spezifikation |
| D8 | 40,6 KB | discovery-validator, n=60-Stichprobe |
| D9 | 23,5 KB | Reconcile-Abschluss-Event-Spezifikation |
| D10 | 14,0 KB | Wellen-Lebenszyklus, Lückenanalyse |

### Verify-Kommandos für die Kopfzahlen

```bash
# Learnings fleet-weit (ohne die eine Kopie)
for f in ~/Projects/*/.orchestrator/metrics/learnings.jsonl; do wc -l < "$f"; done | awk '{s+=$1} END{print s}'

# file_paths fehlend
for f in ~/Projects/*/.orchestrator/metrics/learnings.jsonl; do jq -c 'select(.file_paths==null)' "$f"; done | wc -l

# Repos, die /reconcile nie gelaufen haben
for d in ~/Projects/*/; do f="$d.orchestrator/runtime/reconcile-candidates.jsonl"; [ -f "$f" ] || echo "$(basename "$d") NEVER-RUN"; done

# agent.stopped: leerer agent-String
cat ~/Projects/*/.orchestrator/metrics/events.jsonl \
  | jq -r 'select(.event=="orchestrator.agent.stopped") | (if .agent=="" then "EMPTY" else "nonempty" end)' \
  | sort | uniq -c

# reconcile/evolve/dialectic — Gegenprobe auf 0
cat ~/Projects/*/.orchestrator/metrics/events.jsonl \
  | jq -r '.event//empty' | grep -iE 'reconcil|evolve|dialectic' | sort | uniq -c

# auq_clarity — .denied ist NICHT 0
cat ~/Projects/*/.orchestrator/metrics/events.jsonl \
  | jq -r 'select(.event|test("auq_clarity"))|.event' | sort | uniq -c

# session.stopped.duration_ms
cat ~/Projects/*/.orchestrator/metrics/events.jsonl \
  | jq -r 'select(.event=="orchestrator.session.stopped")|.duration_ms' | sort | uniq -c

# discovery-validator: Stichprobe reproduzieren (deterministischer Seed)
jq -c 'select(.event=="discovery_validator_violation")|{t:.timestamp,c:.claim_text}' \
  ~/Projects/*/.orchestrator/metrics/events.jsonl | shuf -n 20 --random-source=<(yes 11)

# Telemetrie (nur lesend, gegen die anonyme Ingest-DB)
docker exec <ingest-container> node <query-script>   # SELECT COUNT(*), COUNT(DISTINCT anon_id) FROM records
```
