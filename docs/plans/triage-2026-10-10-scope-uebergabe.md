# S1026: Dateibesitz nach Agent-Abschluss

Phase 1, Analyse und Lead-Vorlage vom 2026-10-10. Refs #1026 Punkt 1;
#1030 ausschließlich als bestehender Quellenvertrag. Keine Welle gestartet.

## Auftrag und Ergebnis

Der Owner-Entscheid vom 2026-10-09 gilt: `--assert-disjoint` bleibt eine
reproduzierbare Prüfung des deklarierten Plans. Abschluss eines Agents ändert
keine Dateizuweisung. Eine Übergabe erfolgt durch explizite Besitzeränderung im
kanonischen `{id, files}`-Array, erneute Materialisierung beider Formen und
erneutes Assert. Kein `done: true`, keine neue Autorisierungssemantik.

Die ältere Triage-Prämisse „festlegen, ob das CLI statisch bleibt“ ist erledigt.
Offener Arbeitsauftrag ist diese Zustandsfall-Analyse; ein neuer Produktdefekt
ist nicht belegt. Das Sammel-Issue wird weder pauschal geschlossen noch werden
seine weiteren Punkte erneut implementiert. Labels erteilen keine Freigabe.

## Messgrundlage

Main-SHA: `fb94819e31e04fe435b7180dde2ab49d97bd4cd8`; Messdatum `2026-10-10T07:14:45Z`.
Anker aus `git show <Main-SHA>:<datei> | nl -ba` für die unten genannten Vertragsdateien.
Die Planphase erteilt keine Freigabe für echte Scopeübernahmen, Runtime-Schreibvorgänge oder Codeänderungen.

## Prämisse je Kandidat

Für jede Zeile gilt der volle gemessene freigegebene SHA
`fb94819e31e04fe435b7180dde2ab49d97bd4cd8`, erneut gelesen am
`2026-10-10T07:14:45Z`.

| Kandidat | Prämisse und Datei:Zeile | Urteil / Rest |
| --- | --- | --- |
| #1026 Punkt 1 | `scripts/validate-wave-scope.mjs:725–729`: Sidecar plus `knownRepoFiles()`, keine Liveness-Eingabe; `docs/scope-collision-guard.md:232`: ausdrücklich statisch, Übergabe durch Planänderung | Entscheidungsprämisse erledigt; nur angeforderte Zustandsfall-Analyse offen |
| #1026 Punkt 2 | `scripts/validate-wave-scope.mjs:697–701,730–734`: Sibling-Warnung nur bei roh disjunktem Plan | Historische Unsichtbarkeit überholt; keine Expansion vor dem harten Check |
| #1026 Punkt 3 | `scripts/lib/scope-gate.mjs:1328–1338,1343–1375`: gemeinsame kanonische Schreibweise, abschließender Slash bleibt Präfix | Erledigt; kein Normalisierungssweep |
| #1026 Punkt 4 | `scripts/validate-wave-scope.mjs:42–52,209–220`: explizites `--no-manifest`, ohne Flag fehlendes stdin weiter Fehler | Erledigt; kein Dummy-Manifest-Fix |
| #1026 Punkt 5 / #1030 | `scripts/lib/scope-gate.mjs:468–473`: Verweis auf datierte Mess-SSOT in `skills/wave-executor/references/wave-loop-scope-manifest.md` | Erledigt; keine neuen Zahlen oder eigenständige Implementierung für #1030 |

## CLI-/Hook-Vertragsgrenze

CLI: Es prüft alle deklarierten Besitzer einschließlich `coordinator` und
erkennt eine Doppelzuweisung unabhängig vom Abschlussstatus. Ein unverändertes
Array ergibt bei unverändertem Dateibestand dasselbe Urteil. `--no-manifest`
ist ein Plancheck ohne Manifest, keine Schreibfreigabe; `--union` berechnet die
Union, beseitigt aber keinen Besitzkonflikt.

Hook: Er prüft Kollisionen des aktuellen Dispatches gegen sein Dispatch-Ledger
und kann abgeschlossene Partner ausnehmen. Der positive Abschlussnachweis ist
an Dispatch und letzte Aktivierung gebunden; eine Wiederaufnahme öffnet den
Dispatch erneut (`docs/scope-collision-guard.md:191–195`). Im lokalen Code liegt
die Kollisions-/Abschlussentscheidung in `hooks/pre-task-scope-disjoint.mjs:2203–2287`.
Ein Hook-ALLOW ersetzt weder das kanonische Array noch den CLI-Plancheck.

Die Hook-Fallbacks sind begrenzt: ohne positiven Nachweis besteht die dokumentierte
TTL-Näherung; außerdem existieren Warn-/ALLOW-Pfade bei nicht auswertbaren
Signalen (`docs/scope-collision-guard.md:197,203–210`). Die unten formulierte
fail-closed-Abnahme ist deshalb die Pflicht des Übergabeverfahrens, keine
Behauptung, alle bestehenden Hooks würden mechanisch fail-closed arbeiten.

## Drei Zustandsfälle und Abnahme

Als gemeinsame Datei dient ausschließlich die synthetische Datei
<!-- path-check: example -->
`docs/fixture-shared.md`; A ist bisheriger Besitzer, B der vorgeschlagene neue.

| Zustand | Erforderlicher Beleg | Erwartung und Abnahme |
| --- | --- | --- |
| Aktiv | Synthetischer Dispatch ohne terminalen Abschluss nach letzter Aktivierung | A behält die Datei; gemeinsame Datei nicht übernehmen. A/B seriell planen. Doppelzuweisung im Array muss CLI Exit 1 ergeben. |
| Abgeschlossen mit Beleg | Synthetischer positiver, zur letzten Aktivierung gehörender Abschluss; kein bloßes „done“ oder Launch-ACK | Das unveränderte Doppelzuweisungsarray bleibt CLI Exit 1. Nur eine ausdrücklich gedeckte Planänderung entfernt die Datei bei A und weist sie B zu; beide Formen erneut materialisieren, dann Assert Exit 0 als notwendige Vorbedingung. |
| Abschluss unbekannt | Fehlender, unklarer, veralteter oder nicht zur Aktivierung passender Abschlussnachweis | Keinen Abschluss unterstellen. Besitz bleibt bei A, Übernahme parken. Ein Hook-ALLOW durch TTL ist kein Übergabebeleg; Doppelzuweisung bleibt CLI Exit 1. |

Fail-closed-Regeln: fehlender/unklarer Abschlussbeleg, unbekannte Fremdflächen,
fehlgeschlagene Materialisierung, beschädigte/fehlende Sidecars oder ein
gescheiterter Plancheck erteilen keine Schreibfreigabe. Kein `done: true`,
keine pauschale Liveness-Ausnahme und kein Entfernen eines fremden Ledgers.
Ein echter Übergabenachweis erfordert außerdem die bestehende Autorität für
die konkrete Planänderung; Identität, Abschluss, Label und Exit 0 schaffen sie
nicht selbst. Vor Übernahme Wiederaufnahme und weitere Besitzer ausschließen.

Geplante Übergabekette nach expliziter Deckung: Datei aus A herausnehmen und B
zuweisen; `coordinator` einbeziehen; das kanonische Array erneut mit
`materialize-wave-scope.mjs --state-dir <eigener-state-dir> --wave <N>` schreiben;
per-Agent-`string[]` und aggregierte `{id, files}`-Records prüfen;
`--assert-disjoint` wiederholen; Union und finales Manifest nach dem Runbook
erneut erzeugen und die Subset-/Dispatch-Prüfungen durchführen.
Materialisierung nach bereits begonnenem Dispatch ist ein benannter Risikopfad
(`scripts/materialize-wave-scope.mjs:330–345`): vorher serialisieren und den
Eigentümernachweis prüfen. Hier wird keine reale Übergabe durchgeführt.

## Isoliertes Reproduktionsverfahren, nur geplant

Keine Fixture-Ausführung in Phase 1. Nach ausdrücklichem Lead-Entscheid darf
eine reine Vertragsprobe in einem frischen temporären Fixture-Verzeichnis
folgende Arrays vergleichen, ohne echte Sessions, Prozesse oder Transkripte:

```json
[{"id":"A","files":["docs/fixture-shared.md"]},{"id":"B","files":["docs/fixture-shared.md"]},{"id":"coordinator","files":[]}]
```

```json
[{"id":"A","files":[]},{"id":"B","files":["docs/fixture-shared.md"]},{"id":"coordinator","files":[]}]
```

Geplante konkrete Aufrufe aus dem Repo, wobei `fixture_dir` ein frisch erzeugtes
Verzeichnis unter dem temporären Laufordner ist, niemals ein realer State-Dir:

```sh
perl -e 'alarm shift; exec @ARGV' 30 node scripts/materialize-wave-scope.mjs --state-dir "$fixture_dir/state" --wave 1 < "$fixture_dir/collision.json"
perl -e 'alarm shift; exec @ARGV' 30 node scripts/validate-wave-scope.mjs --assert-disjoint "$fixture_dir/state/filescopes/wave-1.scopes.json" --no-manifest
perl -e 'alarm shift; exec @ARGV' 30 node scripts/materialize-wave-scope.mjs --state-dir "$fixture_dir/state" --wave 1 < "$fixture_dir/transfer.json"
perl -e 'alarm shift; exec @ARGV' 30 node scripts/validate-wave-scope.mjs --assert-disjoint "$fixture_dir/state/filescopes/wave-1.scopes.json" --no-manifest
```

Sollfolge: Materialisierung 0, Kollision 1, Materialisierung 0, disjunkt 0;
jeweils tatsächlichen Exit, stdout/stderr, beide Formen und geprüften SHA sichern.
Die drei Abschlusszustände liegen außerhalb des CLI-Inputs: dasselbe
Kollisionsarray bleibt für alle drei rot. Hook-Verträge gegebenenfalls mit
vorhandenen synthetischen Fixtures und injiziertem `isFinished` prüfen,
einschließlich Wiederaufnahme/unklarem ACK; keine Live-Transkript-Census.
Fehlendes Manifest ohne Flag, fehlender Sidecar und beschädigter Input müssen
als negative Kontrollen scheitern. Sollverhalten zuerst am Runbook bewerten;
erwartete statische Kollision ist kein zu reparierender Defekt.

## Entscheidungsvorlage

| Variante | Bewertung |
| --- | --- |
| Statischen Plan beibehalten, explizite Übergabe im bestehenden Array | Bereits entschiedene und empfohlene Variante; reproduzierbarer CLI-Vertrag, zwei Formen bleiben konsistent |
| CLI akzeptiert Abschluss-/Übergabenachweis als neue Eingabe | Würde eine neue Vertrags- und Autorisierungsfläche schaffen; nicht beauftragt, nicht implementierungsreif, ausdrücklich geparkt |

Keine neue Owner-Entscheidung erforderlich. Eine Abweichung vom bestehenden
Entscheid muss separat zum Lead; diese Vorlage eröffnet sie nicht erneut.

## Dateifläche und Kollisionsmatrix

Vollständige Produkt-Schreibfläche: ausschließlich
`docs/plans/triage-2026-10-10-scope-uebergabe.md`.
Künftige Implementierungsfläche unvollständig, nicht freigegeben.

| Gegenbündel / Fläche | Beleglage | Urteil |
| --- | --- | --- |
| S1157, S856, S1021, S1032, S990 | Laut Brief vollständig disjunkte Planartefakte; keine lokalen vollständigen Listen nachgeliefert | Parallel planbar nach übergebener Matrix; Lead bestätigt die konkreten Flächen vor Dispatch erneut |
| Reguläre / laufende Sessions | Keine vollständige Besitzliste; Starter-Prämisse „keine Session“ ist keine eigene Live-Messung | Ungeklärt; keine Implementierungswelle und keine echte Besitzübernahme starten |
| Jeder bestätigte Besitzer derselben Datei | Gemeinsame Datei | Seriell; danach main und Dateibesitz erneut messen |

Aus der Planfläche folgt keine globale Disjunktheit; vollständige Besitzlisten bleiben erforderlich.

## Wellenplan für den Lead, nicht gestartet

Deep-Grundform laut Session Config fünf Rollen; Umfang einfach (ein Issue,
ein neuer Dokupfad), keine Füllwellen. Für diesen Lauf sind alle Wellen gesperrt.

| Welle / Rolle | Vorgesehene Besetzung und Scope | Abnahme / Freigabe |
| --- | --- | --- |
| 1 Discovery / Planreview | Zwei unabhängige Leser und Architektur-/Sicherheitsreview beim Lead; ausschließlich dieses Repo und Plan-/Vertragsdateien lesend | SHA, Owner-Anker, Zustandsfälle, zwei Formen und Kollisionsmatrix gegeneinander prüfen; kein Dispatch hier |
| 2 Impl-Core | 0 Agents | Keine Codefreigabe; übersprungen |
| 3 Impl-Polish | 0 Agents | Keine Codefreigabe; übersprungen |
| 4 Quality | Lead prüft Doku-Diff; vorhandene Repo-Gates über CI-MR am finalen Commit | CI-Endstatus und Pflichtjobs belegen; keine lokale Vollsuite |
| 5 Finalization | Lead, nach Review; nur Planartefakt ins Produkt | Commit/Push/MR beim Lead; kein automatisches Schließen von #1026 |

Maximal vier gleichzeitige Agents. Native SO-Code-/Testarbeit mit Ermessen
bleibt beim Lead und außerhalb dieser Planphase. Heavy Roles (Tests,
Build, Lint, Audit) später zulässiger m5-Offload oder CI; keine neuen Heavy Jobs
in diesem Lauf. Eine Fortsetzung mit `/go` ersetzt nicht den ausdrücklich
erforderlichen Lead-Entscheid über konkrete Phase-2-Arbeit und vollständige Scopes.

## Repo-Gates und Außenwirkung

`.gitlab-ci.yml:61–78` verwendet gemeinsame Branch-/MR-Regeln ohne Doku-Pfadfilter.
Deshalb sind auch beim reinen Doku-Diff die vorhandenen MR-Gates erforderlich:
`gitleaks-scan`, `npm-audit`, `npm-audit-signatures`, `semgrep`, `lint`,
`typecheck`, `owner-leakage`, `fixture-shape`, `plugin-schema-validate`,
`hook-import-set-check`, `package-manager-guard`, `test` (drei Shards),
`pack-lifecycle`, `commitlint`, `schema-drift-check` und `pipeline-gate`.
`test-value-bans` ist beratend. Coverage ist nur auf dem Default-Branch
erforderlich (`:758–761`); die Fan-in-Prüfung steht bei `:908–951`.

Konkrete vorhandene Befehle: `npm run lint`, `npm run typecheck`,
`node scripts/lib/validate/check-owner-leakage.mjs .`,
`node scripts/validate-plugin-manifests.mjs .`,
`node scripts/generate-hook-import-set.mjs --plugin-root . --check`,
`node scripts/check-package-manager.mjs`, die drei CI-Aufrufe
`npm test -- --shard=<1|2|3>/3`, `npm run test:pack` und das Commitlint-
Range-Gate aus dem bestehenden CI-Job. Die volle Pipeline einschließlich
Security-/Schema-Jobs und Ergebnisverifier bleibt das Integrationsgate;
hier kein isolierter Test als Ersatz. Vollsuite/Build hier ausdrücklich nicht
erneut gestartet. Lokal nur Diffprüfung des neuen Dokuments; Prettier ignoriert
Markdown gemäß `.prettierignore`, also keine Formatabnahme aus dessen Exit 0.

Die GitLab-main-Pipeline enthält keinen automatischen Prod-/Release-/Publish-
Job; `vault-watcher` ist scheduled-only (`:1032–1033`). Der GitHub-Mirror-main-
Push löst dagegen Vercel-Prod aus (`.claude/rules/security.md:100`). Kein Mirror-
Push und keine vollständige `/close`-Kette; bei unklarer Kopplung parkt der Lead
den Merge. npm-Publishing ist ein separater Runbook-Schritt
(`.claude/rules/development.md:93`). Auf main soll allein das Planartefakt landen.

## Beantwortete Fragen, Parkplatz und Risiken

Beantwortet: statisch bleiben (Owner-Entscheid), nur Punkt-1-Analyse auswählen
(Brief und Anker), #1030 nicht zusätzlich implementieren (bestehende SSOT),
kein Netz/Commit/Branchwechsel (Offload-Vorspann), keine Vollsuite (Lead-Vorgabe),
lokalen Plan trotz fehlendem Remote-Ref erstellen (freigegebenes Objekt vorhanden,
relevante Verträge identisch; Integration bleibt offen).

Geparkt: aktueller Remote-main-/CI-Beleg und Branchzuordnung;
vollständige Besitzlisten regulärer Sessions; Live-Prozess-/Transkriptproben;
reale Scopeübernahmen; Autorisierungsänderungen und weitere Issue-Punkte;
Phase 2 ohne Lead-Entscheid; Prod/Release/Publish/Mirror-Push/Servereingriffe,
Versand und neue Owner-Entscheide. Keine Nachrichten an Dritte verschickt.

Unbeaufsichtigte Risiken: unbekannte Peer-Flächen, veralteter Ref, Wiederaufnahme
nach Abschluss, Materialisierung während Dispatch, nur eine statt zwei Formen,
Hook-ALLOW als vermeintliche Schreibfreigabe, timeout als vermeintlich grünes
Gate und versehentlicher Mirror-Deploy. Diese Grenzen bleiben vor Integration
offen. Kein OS-Verhalten geändert; keine Ziel-OS-Abnahme behauptet. Eigene
Gate-Kinder vor Abschluss prüfen. Kein bezahlter API-Aufruf.

Commit-Vorschlag für den Lead:
`docs(scope): Dokumentiere die statische Dateibesitzübergabe`.

## Prüfbelege und Übergabestatus

Main-SHA: `fb94819e31e04fe435b7180dde2ab49d97bd4cd8`.
Messdatum: `2026-10-10T07:14:45Z`.
Methode: `git show <Main-SHA>:<datei> | nl -ba` für Scope-Runbook, Validator, Scope-Gate, Hook und Materialisierung.
Ergebnis: statischer CLI-Vertrag und explizite Besitzeränderung bestätigt; Zustandsfälle analysiert, synthetische Reproduktion nur geplant.
