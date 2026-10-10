# #856: Entscheidungsvorlage für GitHub-CI-Verlauf

Status: Plan/Analyse; keine Umsetzung freigegeben. Refs #856.
Empfehlung: Workflow-Runs als Zeilenquelle mit einer zusammengeführten, konservativen Commit-Sicht zur Bestimmung von `lastGreen`. Ein einzelner erfolgreicher Workflow darf keinen insgesamt roten Commit zum letzten grünen Commit machen. Die Wahl und die unten vorgeschlagenen Grenzen bleiben Owner-/Lead-Entscheide.

## Auftrag, Messung und Besitz

- Freigegebener Main-SHA: `e9674ea2df3afedd2790f904ce9188575e3d6d2d`.
- Neue lokale Messung: `2026-10-10T07:50:57Z`; Objekt mit `git cat-file -t` als Commit bestätigt. Dateivergleich gegen HEAD Exit 0 für Quelle, Fixtures, CI, Validator und Verifikationsregel.
- Offload-HEAD: `84508434c644a3457186d8ce049bc4ee4d2ef72e` (Starter-Snapshot), detached HEAD. `git rev-list --left-right --count <Main-SHA>...HEAD` ergibt `0 1`; das ist keine Aussage über den heutigen Serverstand. Der Snapshot fügt ausschließlich `skills/claude-md-drift-check/package-lock.json` hinzu; fremder Starterbestand, nicht ändern.
- `origin/main` ist hier nicht vorhanden. Alle Main-Koordinaten unten stammen aus `git show <freigegebener-SHA>:<datei> | nl -ba`, nicht aus einem Drei-Punkte-Diff. Kein Fetch/Netz und keine neu angelegte Remote.
- Zu Beginn keine getrackten oder ungetrackten Änderungen. Die Plan-Datei existierte weder im freigegebenen Tree noch im Arbeitsbaum. Aktuelle vollständige Gegenflächen anderer Läufe fehlen; keine Behauptung einer neu gemessenen freien Flotte.
- Vollständige Produkt-Schreibfläche dieses Laufs: `docs/plans/triage-2026-10-10-ci-verlauf.md`. <!-- path-check: planned #856 -->
- Betriebsprotokoll separat gemäß Offload-Vorspann: `.fleet-m5/parkplatz.txt`. <!-- path-check: planned #856 -->
- Künftige Code-/Testfläche ausdrücklich **unvollständig und ungefreigegeben**. Vor Umsetzung müssen Dateien und Kollisionsmatrix neu festgelegt werden. Bereits existierende Anker sind `scripts/lib/ci-status-banner.mjs` und `tests/lib/ci-status-banner.test.mjs`; daraus entsteht keine Schreibfreigabe.

## Sessionstart unter der engeren Offload-Freigabe

Bootstrap offen: `CLAUDE.md`, Session Config und `.orchestrator/bootstrap.lock` mit `version`/`tier` vorhanden. Session Config und die drei Dateien unter `.orchestrator/steering/` gelesen. Modus deep, begrenzte Planaufgabe M, Phase-1-Deckel 1500 s. Die gewöhnliche Deep-Ausführung mit fünf Wellen wird hier durch den ausdrücklichen Planstopp ersetzt; null Ausführungswellen gestartet.

Der Starter-Grenzbeleg `frei` und die übernommene Aussage „keine Session läuft“ gelten als Auftragslage. Keine eigene Slot-/Prozessidentität daraus ableiten. Kein zweiter Worktree, keine Lock-/STATE-/Metrics-Schreibvorgänge, keine Vault-/Portfolio-Suche, keine Skill-Selbstmeldung außerhalb der Schreibfläche. Repo-interne historische STATE-/Metrics-Dateien waren hier nicht vorhanden; keine daraus abgeleitete Fortsetzung. Host-Konfiguration außerhalb des Arbeitsordners wird nicht gelesen. Defaults für Ausgabe gelten.

VCS-Deep-Dive, aktuelle Issues/MRs, CI-Endstatus, externe Projektkonfiguration, globale Ressourcen-/Peer-Erfassung und Baseline-Vollsuite sind unter dem Netz-/Scopevertrag nicht messbar beziehungsweise nicht ausgeführt. Labels und Issue-Prämisse stammen aus dem Brief; nur der Quellbefund wird neu bestätigt. Keine Issue-Statusänderung oder Schließung. Die zwingende Schreibflächenbegrenzung hat Vorrang vor den normalen persistierenden Sessionstart-Phasen; dieser Plan behauptet keinen vollständig ausgeführten Live-Sessionstart.

## Prämisse je Kandidat

Einziger Kandidat: #856. Main-SHA und Messdatum wie oben; historische Komplettbehauptungen werden auf den belegten Rest reduziert.

| Prämisse | Main-Datei:Zeile | Urteil |
| --- | --- | --- |
| Laufende/wartende GitLab-Pipelines fehlen | `scripts/lib/ci-status-banner.mjs:915–925` | Bereits erledigt: unknown mit pipeline-running/pending |
| Abbruch wird nicht gesondert benannt | `scripts/lib/ci-status-banner.mjs:996–1003` | Bereits erledigt: GitLab bleibt red, reason pipeline-canceled |
| GitHub kennt nur red/green und keinen Checknamen | `scripts/lib/ci-status-banner.mjs:1092–1153` | Widerlegt: Lifecycle-Zähler, unknown-Gründe und failingJobName vorhanden; Kommentar bei 1023 ist überholt |
| GitHub liefert noch keinen Verlauf | `scripts/lib/ci-status-banner.mjs:1111–1120` | Offen: Failure liefert Placeholder, weder lastGreen noch redCount |
| GitHub-Lifecycle braucht einen Komplettbau | `tests/lib/ci-status-banner.test.mjs:1917–1969` | Widerlegt durch bestehende Offline-Matrix; erhalten |
| Failure-Name/Placeholder nur hypothetisch | `tests/lib/ci-status-banner.test.mjs:800–823` | Bestehender Fixtureanker; gezielte Ausführung unten |

Synergie: nur den Verlauf an die vorhandenen Begriffe anschließen. GitLab-Statusmechanik, Consumer, Releasepolitik und GitLab-Historienfilter gehören nicht zum Bündel.

## Bestehender Vertrag und Begriffsgrenzen

GitLab liest 15 Pipeline-Zeilen nach `updated_at` absteigend (`scripts/lib/ci-status-banner.mjs:831–834`). Der aktuelle SHA wird mit Ref-Präferenz und Statuspriorität ausgewählt. Im Lookback nach der gewählten Zeile werden alle Zeilen des abgefragten SHA entfernt; erster success ist `lastGreen` (`:938–940`). Der historische Lookback filtert aktuell keinen Branch; nicht still als Branch-Vertrag übernehmen oder in diesem Schnitt reparieren.

`redCount` zählt die aktuelle Zeile plus die anschließenden **non-success-Zeilen**, also auch running/canceled/skipped, bis zum ersten success (`:942–949`). `agePipelines = redCount`; `ageCommits` zählt unterschiedliche beobachtete SHAs, keine Git-DAG-Distanz (`:957–965`). `ageDays` ist floor der Tage seit created_at, ungültige Zeit ergibt null (`:786–789`). Zeilen, Commits und Wiederholungen sind verschiedene Einheiten.

GitHub bewertet Check-Runs: failure/action_required dominiert; nur vollständig completed success ergibt green. Cancelled allein, running, queued, skipped, neutral und unbekannte Werte bleiben unknown (`:1095–1153`). GitLab-canceled red und GitHub-cancelled unknown bleiben absichtlich verschieden. Nicht auf timeout/stale_success neue Erfolgskategorien erfinden; der bestehende timeout-Conclusion fällt gegenwärtig unter other.

Die Rückgabeformen bleiben unverändert: tatsächliche Lesung mit green/red/unknown; degraded für nicht lesbare Daten; null nur für gemessene Abwesenheit (`scripts/lib/ci-status-banner.mjs:1160–1175`). Fail-open bedeutet: Diagnose blockiert den Sessionstart nicht. Es bedeutet niemals „fehlende Daten sind grün“. Historienfehler dürfen einen bereits belegten roten Head nicht verdecken.

## Alternativen und Kostenmodell

Die API-Formen unten sind Entwurfsannahmen, keine hier geprüften Anbieterzusagen. Vor Umsetzung nativ die offiziellen GitHub-/gh-Verträge für Felder, Pagination, Permissions, Enterprise-Version und Wiederholungen prüfen; reale Abfragen und Authentifizierung bleiben geparkt.

| Variante | Aussage und Aufwand | Grenze / Entscheidung |
| --- | --- | --- |
| Check-Runs pro Commit | Passt zum aktuellen Verdict und erfasst auch Checks fremder Apps. Commit-Reihenfolge zuerst bestimmen, danach pro SHA paginierte Checks; Aufwand O(Commitkandidaten × Checkseiten). | Einzelchecks sind keine Pipeline-Zeilen. Branch-/Event-Zuordnung und vollständige Checkmenge aus Check-Runs allein nicht sicher belegt; redCount als Checkanzahl irreführend. Nicht empfohlen als einzige Historienquelle. |
| Workflow-Runs | Lauf-ID, SHA, Branch, Workflow-Identität und Versuche liefern eine plausible Pipeline-Zeilensicht; begrenzte paginierte Listen statt Abfrage jedes Checks. | Actions-only; einzelner success beweist keine grüne Gesamtsicht. Andere Apps und path-gefilterte fehlende Workflows bleiben unsichtbar. Nur wählen, wenn Owner Actions-only ausdrücklich als Vertrag akzeptiert. |
| Zusammengeführte Commit-Sicht (Empfehlung) | Workflow-Läufe liefern Reihenfolge/Zeilen; Checks und Vollständigkeit je Kandidaten-SHA beweisen success für die relevante Menge. | Höhere Kosten, konservativ öfter kein lastGreen; Branch-/Event-Provenienz muss stimmen. Unter Grenzen nur „letzter belegter Erfolg im Fenster“, niemals unbeschränkte Historie. |

Empfehlung ist eine strenge Evidenzkombination, keine Mischung von Erfolgen unterschiedlicher SHAs. Workflow-Zeilen dienen nur zur Zählung; ein SHA wird nur bei vollständiger kohärenter Check-/Workflow-Menge ein grüner Anker.

## Vorgeschlagener Vertrag zur Wahl

1. **Identität und Auswahl:** Host/Repository aus bestehenden gepinnten Resolvern; abgefragten vollständigen SHA einmal fixieren, nicht mehrfach bewegliches HEAD lesen. Historie an den gemessenen Branch und denselben Event-Kontext binden. Detached HEAD, expliziter SHA außerhalb des lokalen Branches, PR-Merge-SHA oder fehlende Branch-Provenienz: aktuelle Lesung erhalten, Historie unavailable. Kein Fallback auf Default-Branch oder fremde Refs.
2. **Relevante Menge:** Ohne neue Config-Fläche zunächst alle eindeutig diesem Branch/Event zugeordneten Actions-Workflows sowie Checks nach bestehender Head-Semantik. Vergleichsschlüssel Workflow-ID, Event und Check-App-ID/Checkname; keine bloßen Anzeigenamen. Nicht aus einem einzigen Payload ableiten, dass abwesende Checks irrelevant seien. Eine vollständige stabile Menge muss belegbar sein; Workflowwechsel, path-gefilterte Lücken oder branchfremde App-Checks führen zu incomplete. Das bewusst konservative Verhalten und eine spätere explizite Auswahl sind Owner-Entscheide; kein automatischer Ruleset-/Branchschutz-Zugriff.
3. **Reihenfolge:** Erst nach SHA gruppieren; je SHA/Workflow/Event/Run-ID den neuesten eindeutig belegten Versuch für den Verdict bestimmen. Gruppenzeit ist die größte unveränderliche Erstellungszeit dieser maßgeblichen Läufe; Gruppen absteigend, Tie-break größter Run-ID und SHA. Innerhalb einer Gruppe Zeilen nach created_at/Run-ID/attempt sortieren, nicht updated_at. Die vollständige Gruppe des abgefragten SHA ist der aktuelle Anker, kein einzelner beliebig ausgewählter Workflow. Interleavierte SHA-Zeilen werden somit bewusst als Commit-Gruppen ausgewertet. Andere Gruppen müssen älter als die aktuelle Gruppe und nach lokal vorhandenen Git-Objekten Vorfahren des abgefragten SHA sein; unbekannte/fehlende Objekte kosten keine Netzabfrage, sondern incomplete. Ohne eindeutig zuordenbare aktuelle Workflow-Gruppe mit mindestens einer non-success-Zeile keinen exakten Zeilenzähler aus Checknamen konstruieren. Diese Gruppensortierung ist weder Git-DAG-Distanz noch ein globaler Laufzeilen-Zeitstrahl.
4. **Duplikate und Wiederholungen:** Identische (Run-ID, run_attempt)-Zeilen aus zwei Seiten einmal zählen; verschiedene Runs desselben SHA bleiben verschiedene Zeilen. Versuchsauswahl pro (SHA, Workflow-ID, Event, Run-ID): nur neuester eindeutig belegter Versuch dieses Runs bestimmt dessen Verdict. Bei mehreren Run-IDs desselben Workflows müssen konservativ alle maßgeblichen Runs success sein; ein neuer success-Run verdeckt keinen separaten failed-Run. Damit ist „neuster Versuch eines Runs“ ausdrücklich nicht „neuster Run eines Workflows“. Ziffer 3 verwendet genau diese maßgeblichen Runs für die Gruppenzeit. Frühere failed-Versuche werden nicht zu eigener grüner Historie; sichtbare ältere Versuche zählen als non-success-Zeilen, wenn die SHA-Gruppe insgesamt nichtgrün ist. Alle Zeilen des aktuellen SHA aus dem historischen Anker-Suchraum ausschließen. Fehlende Versuchsfelder, historische Versuche nur teilweise sichtbar oder widersprechende Zuordnung: keine behauptete vollständige Versuchszahl. Vorläufiger Zähler bezieht sich ausschließlich auf sichtbare Laufzeilen/Versuche, nicht auf alle jemals gestarteten Wiederholungen.
5. **Grüner Anker:** `lastGreen.sha` muss älter und verschieden vom abgefragten SHA sein, vollständig zugeordnet, alle relevanten Workflows und Checks completed success. Erfolg eines Workflows neben failed/cancelled/running/fehlendem Check reicht nicht. Neutral/skipped sind keine success. API-Erfolg mit leerer Liste ist kein CI-Erfolg. Kein Anker aus einer fremden App ohne Branch-/Event-Provenienz.
6. **Zähler:** `redCount` zählt ausschließlich belegte non-success-Laufzeilen der aktuellen Gruppe und aller älteren Gruppen bis vor den vollständig grünen SHA-Anker, nicht fehlgeschlagene Checks oder rote Commits. Success-Zeilen innerhalb einer nichtgrünen Gruppe zählen nicht und stoppen die Suche nicht; das ist eine ausdrücklich vorgeschlagene GitHub-Gruppenregel, kein byte-identischer GitLab-Zeilenalgorithmus. Mehrere sichtbare non-success-Workflows/Versuche pro SHA erhöhen die Zeilenanzahl. `agePipelines = redCount`; `ageCommits` = verschiedene SHAs der tatsächlich gezählten non-success-Zeilen, einschließlich aktueller SHA, keine Parent-Distanz. Eine nichtgrüne Gruppe ohne zuordenbare non-success-Laufzeile ist eine Evidenzlücke (etwa ein fehlgeschlagener externer App-Check bei ausschließlich erfolgreichen Actions-Läufen): top-level Zähler weglassen. Alle Zeilen des grünen Anker-SHA werden als Gruppe ausgeschlossen. Die Gleichsetzung von GitHub-Workflow-Lauf und Pipeline ist ausdrücklich Teil der noch unbestätigten Wahl.
7. **Lücken:** Running/queued/cancelled sind non-success-Zeilen, solange ihre Identität sicher ist. Unzuordenbare oder unvollständige Gruppen dürfen keinen exakten Zähler übersprungen werden: kein top-level redCount/lastGreen, nur additive details über Grund und beobachtete Untergrenze. Vollständiges Fenster ohne grünen Anker: kein lastGreen; redCount nur als ausdrücklich gekennzeichnete Fenster-Untergrenze in details, nicht als vermeintlich unbeschränkter top-level Wert. Leere Historie liefert unavailable. Ein früher belegter Anker kann nur verwendet werden, wenn das ganze Intervall bis dorthin vollständig ist.
8. **Shape:** Bestehende optionalen top-level Felder erhalten. `lastGreen.pipelineId` soll die ID des repräsentativen erfolgreichen Workflow-Laufs im Anker-SHA tragen (neueste Erstellungszeit, deterministischer Tie-break); kein Check-ID-Ersatz. `ageDays` an dessen created_at binden, Datum mit injiziertem now prüfen. Additive details sollen Quelle, Scope, Vollständigkeit, gezählte Einheit, Seiten-/Abfragezahl und reason ausweisen. Namen/Schema dieser neuen details sind noch nicht festgelegt. Keine Consumer-Änderung voraussetzen; eine einzelne repräsentative ID beweist nicht allein die Commit-Gesamtsicht.
9. **Fehler:** Head-Query-Fehler weiter degraded nach vorhandenem Vertrag. Nur historische Query scheitert: current status/ok/failingJobName/checkRunCounts unverändert, keine erfundenen Zähler; additive history reason für API-/Parse-/Timeout-/Rate-Limit-/Budgetfehler. Placeholder für fehlende Implementierung erst nach Vertragsfreigabe sinnvoll ersetzen, keine neuen status-Werte.

Beispiel zur Einheitenwahl: aktueller SHA A hat zwei non-success-Laufzeilen; älterer SHA B hat eine; SHA C ist vollständig grün. Bei vollständig belegtem Intervall sind redCount/agePipelines 3, ageCommits 2, lastGreen.sha C. Zwei identische Seitenkopien eines Laufs auf A erhöhen keinen Wert. Eine success-Zeile auf A macht A nicht zu seinem eigenen lastGreen. <!-- path-check: example -->

## Abfrage-, Zeit- und Rate-Limit-Grenzen (Vorschlag, keine Livewerte)

- Keine unbeschränkte `--paginate`-Schleife. Maximal zwei Workflow-Seiten mit je höchstens 100 Zeilen und vier historische Kandidaten-SHAs, je höchstens zwei Checkseiten mit 100 Checks. Maximal zehn zusätzliche HTTP-Anfragen: zwei Listen- und acht Check-Anfragen. Mehr nötige Seiten machen die Evidenz incomplete; total_count/next-Link und Duplikate auswerten. Jeder HTTP-Seitenabruf zählt, auch unter einer gh-CLI-Ausführung.
- Repository-Lookup und aktueller Head bleiben Teil der bestehenden Abfrage; vorgeschlagen höchstens zwei Head-Checkseiten. Somit höchstens 13 GitHub-Abfragen einschließlich Repository-Lookup; lokale Git-Aufrufe getrennt zählen. Falls der bestehende Headpfad diese Pagination nicht ohne Semantikänderung aufnehmen kann, muss der Lead dessen Codefläche ausdrücklich ergänzen.
- Bestehender Timeout ist 8000 ms je CLI (`scripts/lib/ci-status-banner.mjs:44`). Vorschlag: Geschichte zusätzlich insgesamt maximal 20 s, je Aufruf höchstens 8 s oder Restbudget; Gesamtlauf maximal 40 s einschließlich lokaler Identitätsermittlung. Ein engeres Aufruferbudget gewinnt. Bei Deadline Kinder abbrechen und abwarten; keine Hintergrundfortsetzung. Diese zusätzliche Latenz ist noch nicht freigegeben und muss gegen Sessionstart-Probenbudget geprüft werden.
- Bei 403/429 oder erschöpftem belegtem Rate-Budget stoppen, nicht schlafen/retryen oder Token wechseln. Paginationfehler nicht als leere Seite deuten. Angegebene remaining/reset/Retry-After nur als Diagnose verwenden, keine Token/Header-Geheimnisse loggen. Kein API-Limit als konstante Anbieterzahl behaupten; keine reale Rate-/Latenzmessung vorhanden.
- Kostenbegrenzung durch Request-/Zeit-/Datenfenster, keine Zusatzdienste, keine neuen Auth-Rechte ohne Owner. Geldkosten und Enterprise-Verhalten hier nicht messbar. Keine bezahlten Modell-API-Aufrufe; native Abo-/Harness-Subagents verwendet.

## Offline-Fixturevertrag für eine spätere Umsetzung

Vorhandene Fixtures erhalten, neue Fälle später im vorhandenen Testanker ergänzen. Keine Tests oder Code in diesem Planlauf schreiben. Mock muss jeden erwarteten Befehl bedienen und unerwartete Requests ablehnen; keine echten gh-/glab-Aufrufe. Feste SHAs, Zeiten und Seiten; lokale Ancestry/Branch-Proben ebenfalls stubben.

| Fall | Erwartung / zu fangender Fehler |
| --- | --- |
| Früherer vollständig grüner SHA | lastGreen älter/verschieden, repräsentative ID, feste ageDays; niemals HEAD selbst |
| Drei Zeilen über zwei SHAs | redCount/agePipelines 3, ageCommits 2; Zeile ≠ Commit |
| Success und Failure desselben SHA; mehrere Workflows | Kein Anker aus nur einem grünen Workflow; komplette Gruppe nötig |
| Teil-success in nichtgrüner Gruppe; interleavierte SHAs | A mit success + failure, B mit failure, C vollständig grün ergibt redCount/agePipelines 2 und ageCommits 2; success auf A zählt nicht und stoppt nicht. Seiten-Reihenfolge ändert keine Gruppensortierung |
| Re-run failed → success; doppelte Seite; fehlendes attempt | Verdict nur aus gültiger neuester Versuchssicht; Duplikat zählt einmal; fehlende Versuchshistorie ausdrücklich begrenzt |
| Zwei Run-IDs eines Workflows auf gleichem SHA | Älterer success + neuer failure sowie älterer failure + neuer success sind kein grüner Anker; alle maßgeblichen Runs müssen success sein. Davon getrennt: neuer success-Versuch derselben Run-ID kann deren älteren failed-Versuch ersetzen |
| Gemischte Apps/Checks, Namensgleichheit | App-/Workflow-IDs verhindern Zusammenwerfen; fehlende erwartete Checks incomplete |
| Abbruch, Running, Queued, Waiting, stale success | Aktuelle vorhandene Statusmatrix bleibt unverändert; keine nachträgliche Grünfreigabe |
| Fremder Branch/Event, PR-Merge-SHA, detached, expliziter SHA | Keine fremde Historie; aktueller Befund bleibt erhalten |
| Fehlende oder unvollständige Historie | lastGreen fehlt, kein unqualifizierter redCount; Fenster-Untergrenze/Grund sichtbar |
| Pagination: Erfolg auf Seite 2, dritte Seite nötig | Anker nur bei vollständigem Intervall; Seite-3-Bedarf beendet Suche incomplete |
| Neu aktualisierter alter Run, gleiche Zeitstempel | Stabile created_at/ID/attempt-Reihenfolge, kein updated_at-Scheinabstand |
| Historische API-/JSON-/Rate-/Timeoutfehler | Belegtes current red erhalten; keine Erfolgsausgabe und keine weiteren Requests nach Budgetende |
| Head-API-Fehler, leere/malformed Checkliste | Bestehendes degraded/unknown-Verhalten erhalten, niemals green |
| Fehlende lokale Commitobjekte, Workflowmenge geändert | Ancestry/Scope nicht raten, Historie incomplete |

## Kollisionsmatrix und gesperrte Fortsetzung

| Gegenbündel | Beleglage gegenüber der vollständigen Planfläche | Konsequenz |
| --- | --- | --- |
| S1157, S1026, S1021, S1032, S990 jeweils | Laut übernommener Triage a disjunkt; deren vollständige Schreiblisten liegen hier nicht vor | Laut Brief parallel planbar ausschließlich für die dort erklärten Listen; nicht unabhängig neu bestätigt |
| Laufende/neu gestartete Bündel | Keine aktuelle vollständige Gegenfläche | Ungeklärt, keine parallele Codeumsetzung daraus ableiten |
| Gemeinsame Plan-Datei in irgendeinem neuen Bündel | Gemeinsame Datei wäre belegt | Seriell; danach Main und Besitz neu messen |
| Künftige Umsetzung #856 | Code-/Testfläche unvollständig | Nicht freigegeben; vorher neue Scope- und Kollisionsprüfung |

Es gibt keine ausführbare `/go`-Freigabe aus diesem Dokument. Der allgemeine Phase-1-Text „Resume mit /go“ wird für S856 ausdrücklich durch „Vertragswahl, dann neuen Umsetzungsbrief“ ersetzt.

| Schritt / mögliche spätere Welle | Rollen / Modell | Ort / Bedingung |
| --- | --- | --- |
| Dieser Planlauf: Quell-/Fixtureanalyse, Alternativen, Vorlage, Gegenprüfung | Koordinator im vorhandenen Codex-Harness; lesender Fixtureprüfer gpt-6.1-sol medium; lesender Vertragsreview gpt-6.1-sol medium. Opus 5.5 ist in diesem Harness nicht verfügbar; nicht als benutzt ausgeben | Eigener win-wsl-Offload-Job; keine Ausführungswelle |
| Nach ausdrücklicher Vertragswahl: Scope-/API-Verträge und Fixtures festlegen | Nativ Opus für Vertrags-/Architekturreview; Routine Sol 6.1 medium | Lead nativ; reale Abfragen nur separat autorisiert |
| Später: Implementierung und unabhängiges Review | Nativ Opus für Code mit Ermessen/Review; genaue Agentenzahl erst nach vollständiger Fläche | Nicht gestartet; keine automatische Phase 2 |
| Später: Quality | Sol-Routine-Gates mit Opus-Review der Befunde | Zulässiger Offload mit Zeitdeckeln, anschließend CI auf Head-SHA |
| Lead: Doku-MR / eventuell spätere Umsetzung | Lead verantwortet Commit/Push/MR/Merge | Auf main soll aus diesem Lauf ausschließlich die Entscheidungsvorlage landen; #856 bleibt offen |

Versionierte Main-Wirkung: `.gitlab-ci.yml:37–78` definiert Prüfungsstages und Branch-/MR-Workflow ohne Doku-Pfadausnahme; `:518–524` entfernt die Manifest-Pfadausnahme; `:917–939` verlangt reguläre Sicherheits-/Validierungs-/Test-/Fan-in-Gates. Coverage nur Default-Branch (`:732–761`), nach Merge vom Lead kontrollieren. Vault-watcher ausschließlich schedule (`:1032–1033`). Kein Prod-Deploy-/Release-/Publish-Job im gelesenen vollständigen CI-Tree; npm-Publishing separat gemäß `.claude/rules/development.md:89–93`. Externe Projektkonfiguration bleibt ohne Netz nicht messbar; Merge-/Releaseentscheidung beim Lead, dieser Lauf führt sie nicht aus.

## Beantwortete und geparkte Fragen / Risiken

Beantwortet und gedeckt: ausschließlich #856-Verlaufsrest statt Komplettbau; vorhandene Lifecycle-Fixtures erhalten; isolierter Plan statt Deep-Wellen; freigegebenen SHA direkt lesen, da origin/main fehlt; kein Commit/Push; npm-kanonisches Repo, daher keine pnpm-Installation. Zeitgedeckelte Offline-Fixtureprüfung zulässig im vorhandenen Offload-Job.

Geparkt und ungedeckt: Wahl Check-Runs/Workflow-Runs/Kombination; Definition und Beleg der relevanten vollständigen Menge; sichtbare Zeilen versus komplette Versuchshistorie; repräsentative pipelineId; konservative Auslassung oder Untergrenzenanzeige; 10 Zusatzrequests/20-s-Historienbudget/40-s-Gesamtbudget. Empfehlung jeweils wie oben, keine stillschweigende Umsetzung dieser Wahl.

Geparkt: offizielle API-/gh-Versionverträge und Live-Abfragen, Tokens/Rechte, aktuelle Issue-/MR-/CI-Lage, externe Projektkonfiguration, alle Außenwirkung, Release/Publish und Code. Größtes fachliches Risiko: falsches lastGreen aus einem Teilworkflow. Größtes Betriebsrisiko: zusätzliche Sessionstart-Latenz und unbekannte Gegenflächen. Der strenge Vollständigkeitsvertrag kann häufig keinen Verlauf liefern; das ist vor Umsetzung bewusst zu entscheiden. Sandbox-Grün ist kein macOS-/Windows-native-/Live-GitHub-Beleg; reine Doku benötigt keine neue Ziel-OS-Wirkungsprüfung.

## Prüfbelege und Übergabe

Alle ausgeführten Prüfungen laufen im Arbeitsordner auf win-wsl/Linux mit Node v24.21.0, gegen Offload-HEAD `84508434c644a3457186d8ce049bc4ee4d2ef72e` plus uncommitted Plan-Diff. Ein Commit-SHA für den neuen Plan existiert bewusst nicht. Logpfade unter `/tmp/so-bb4-856/` sind lokal und müssen vom Starter/Lead gesichert werden; keine erfundene externe Job-ID.

| Prüfung | Befehl / Ort | Exit / Beleg |
| --- | --- | --- |
| Freigegebene Anker unverändert | git diff --exit-code Main-SHA HEAD -- Quelle Fixtures CI Validator Verifikationsregel; offload | 0; Main-Tree-Belege oben, Snapshotänderung außerhalb dieses Scopes |
| Vorhandene Offline-Fixtures | timeout -k 30 120 node_modules/.bin/vitest --run tests/lib/ci-status-banner.test.mjs --reporter=default; offload | 124 (äußerer Zeitdeckel), TESTENDE gelesen; 0 Fixtures ausgeführt, globalSetup scheiterte mit spawnSync /usr/local/bin/node EPERM, status=null/signal=SIGTERM; Log /tmp/so-bb4-856/fixtures.log |
| Separate vorhandene Pfadprüfung | timeout -k 30 30 node scripts/lib/validate/check-skill-script-paths.mjs; offload | 124, TESTENDE gelesen; nur Überschrift, kein Abschlussbefund, nicht messbar; Log /tmp/so-bb4-856/paths.log |
| Plan-/Pluginprüfung inklusive Pfade | timeout -k 30 600 node scripts/validate-plugin.mjs; offload | 124, tatsächliches TESTENDE gelesen 2026-10-10T08:04:36Z; keine gültige Results-Summe, leere Kindprüfungen und fehlende Vergleichsmarker, nicht messbar; Log /tmp/so-bb4-856/validate-plugin.log |
| CI nach Push/Merge | Lead: reguläre Pipeline auf neuem vollem Head-SHA, Coverage auf Main | Nicht ausgeführt, offen; keine CI-Grünbehauptung |

Für reinen Doku-Diff keine eigene Vitest-Vollsuite; obige Einzeldatei reproduziert nur die historischen Anker. Typecheck prüft mjs-Code, ESLint JS/mjs, beide berühren diese Markdown-Datei nicht; Dokumentationsausnahme `.claude/rules/verification-before-completion.md:59`. CI-Jobpflicht wird dadurch nicht aufgehoben. Validator-Pfadprüfung scannt auch docs und erwartet geplante Pfade auf gleicher/unmittelbar voriger Zeile (`scripts/lib/validate/check-skill-script-paths.mjs:1–60`).

Review: unabhängiger lesender Sol-6.1-medium-Prüfer bestätigte die Main-Anker; erste Blocking-Lücken (Gruppenanker/Intervall und mehrere Run-IDs) wurden in Ziffern 3/4/6 und Fixtures präzisiert. Nachprüfung: beide geschlossen, keine neuen Blocking-Befunde. Das ist Vertragsreview, kein Gate-Erfolg.

Ursachenprüfung nach Debug-Anleitung, ausschließlich lesend: `tests/setup/validate-plugin.mjs:20–25` startet den Pflichtvalidator per spawnSync mit 120000-ms-Deckel vor Testworkern; `vitest.config.mjs:19` bindet dieses Setup ein. Tatsächliches Fehlerlog nennt EPERM, keinen fehlgeschlagenen #856-Assert. Betroffene Quell-/Setup-Dateien wurden nicht verändert, keine Instrumentierung oder Umgehung. Dediziertes Debug-Artefakt außerhalb der vollständigen Schreibfläche ist nicht freigegeben; Befund und Logs bleiben in dieser Vorlage. Sandbox-/Kindprozessursache ist eine Hypothese, kein nativer Zielsystembefund. Vollständigen Validator und Fixture-Reproduktion muss der Lead auf einem zulässigen Runner nachholen.

Abschließende Übergabe: vollständige Produktänderung ausschließlich diese neue Plan-Datei. `git status --porcelain --untracked-files=all` meldet `?? docs/plans/triage-2026-10-10-ci-verlauf.md`; keine getrackten Änderungen, kein Index geschrieben. `git status --porcelain --ignored=traditional` meldet das neue Plan-Verzeichnis und ignoriert `.fleet-m5/`, `node_modules/`, `marketing/remotion/node_modules/`, `skills/claude-md-drift-check/node_modules/`, `skills/vault-sync/node_modules/`, `skills/vault-sync/package-lock.json`. Nur Parkplatz ist eigener ignorierter Bestand; übrige Reste waren vor Arbeit vorhanden und wurden nicht behandelt. Starter-Snapshot-Lockfile ist bereits in HEAD und gehört nicht zu diesem Diff. Eigene Logs verbleiben unter exakt `/tmp/so-bb4-856/`; nichts gelöscht. Vollständige Statusausgaben dort in status-untracked.txt und status-ignored.txt sichern. Parkplatz ist Betriebsprotokoll, nicht Teil des Doku-Commits.

Alle drei gestarteten Prüfungen sind beendet; beide lesenden Subagents abgeschlossen. `ps -eo pid,ppid,comm` liefert in dieser Sandbox nur PID 1 codex sowie die aktuelle Shell/timeout/ps-Kette (Exit 0); damit keine hostweite Waisenprüfung behaupten. Hostweite Prozesskontrolle ist nicht messbar, kein fremder Prozess angefasst. Linux wurde mit uname -s gemessen; win-wsl ist die Starterangabe, kein Windows-nativer Nachweis. Endprüfung/Log-Sicherung beim Lead; kein CI-Grün, keine Codeabnahme und keine automatische Fortsetzung.

Commit-Vorschlag für den Lead: `docs(ci): Bereite den GitHub-Verlaufsvertrag vor`. Keine Issue-Schließung aus diesem Teilplan. Dieser Lauf endet nach der Entscheidungsvorlage; Implementierung bleibt bis Vertragswahl und neuem freigegebenem Scope geparkt.
