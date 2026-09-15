# ECC × Session Orchestrator: gezielte Übernahme statt zweites System

Stand: 2026-09-15. Architektur-, Workflow- und Quelltextvergleich mit drei
parallelen Sol-Reviewern, anschließenden Korrekturen und Gegenprüfung.

## Ergebnis

ECC ist eine ergiebige Quelle für bessere Einrichtung, Diagnose und einzelne
Arbeitsverfahren. Session Orchestrator (SO) besitzt bereits wesentlich mehr
Mechanik für Dateibesitz, Wave-Abnahme, Recovery und evidenzgebundenes Lernen.
Der sinnvolle Ausbau konzentriert diese Mechanik hinter verständlicheren
Aufrufen. Ein zusätzlicher Scheduler, Instinct-Store oder pauschaler Import des
ECC-Katalogs würde die Wartung vergrößern, ohne einen nachgewiesenen Nutzen zu
liefern.

Diese Aussage vergleicht sichtbare Verträge und Implementierungen. Sie ist kein
Benchmark für Ergebnisqualität, Geschwindigkeit oder Tokenverbrauch.

## Quellen und Untersuchungstiefe

| Repository | Fixierter Commit | Getrackte Dateien | Rolle |
|---|---|---:|---|
| [ECC](https://github.com/affaan-m/ECC/tree/8321021c54d670126ce3b2969d5deb880b4b0c2a) | `8321021c54d670126ce3b2969d5deb880b4b0c2a` | 3.716 | Hauptvergleich |
| [SO](https://github.com/Kanevry/session-orchestrator/tree/ca214376526873729b0f8707c25e93636cada222) | `ca214376526873729b0f8707c25e93636cada222` | 2.206 | Ausgangsbasis |
| [AgentShield](https://github.com/affaan-m/agentshield/tree/b0891303bdcd6037376a94263d45cfd2ff3dfb98) | `b0891303bdcd6037376a94263d45cfd2ff3dfb98` | 244 | Von ECC verknüpfter Security-Scanner |
| [CCG](https://github.com/fengshao1227/ccg-workflow/tree/f349e3de191f3b12609f9d4448772eddddc7e37b) | `f349e3de191f3b12609f9d4448772eddddc7e37b` | 445 | Separater Backend-Wrapper für ECCs Multi-Workflows |

Inventarmethode: `git ls-files -z` am genannten SHA; kanonische Skill-Bodies
unter `skills/**/SKILL.md`, Agent-Bodies unter `agents/**/*.md`. Damit hat ECC
292 Skill-Bodies und 68 Agent-Bodies, SO 44 und 14. Generierte Spiegel und
Übersetzungen sind nicht zusätzliche kanonische Fähigkeiten. Zahlen beschreiben
Umfang, nicht Qualität.

**Breite:** vollständiges getracktes Inventar und Kategorisierung der relevanten
Oberflächen. **Tiefe:** Quelltext- und Vertragsprüfung der entscheidungsrelevanten
Pfade; keine Zeilenprüfung jeder Sprach-Anleitung, Übersetzung oder Testdatei.
Fremdrepositories wurden nicht installiert und ihre Modellschleifen nicht
gestartet. Ein vorhandener Test ist ein überprüfbarer Vertrag, kein Beleg, dass
dieser Test hier ausgeführt wurde.

| Prüfbereich | Detailpfade / konkrete Fragen |
|---|---|
| Architektur | Runtime gegen Prompt-Rezepte, öffentliche Interfaces, Adapter und Zustandsquellen |
| Parallelisierung | Worker-Pool, Dependencies, Barrieren, Cancellation, Filescopes, Worktrees, Multi-Host |
| Hooks | Lifecycle, Ein-/Ausgabe, Timeout, Fehler, Profile, tatsächliche Harness-Registrierung |
| Sicherheit | Enforcement, Eingabegrenzen, Policy-Floor, lokale Daten, Install-/Quellenvertrauen |
| Skills/Agenten | Aufrufkosten, Katalogbreite, Research-first, Verifikation, spezialisierte Rollen |
| Lernen | Erfassung, Confidence, Scope, Widersprüche, Verfall, Promotion, Herkunft |
| Kontext | Compaction, Handoff, Persistenz, stale Session-/Worktree-Zustände |
| Qualität/Evals | reale Commands, Prozessrubrik, Replay, Arm-Isolation, Testwert |
| Distribution | Profile, Ownership, Install-State, Paketinhalt, Lifecycle-Tests |
| Produkt/Ergonomie | erste Einrichtung, Diagnose, Anzahl nötiger Konzepte, sinnvolle Defaults |

Der optionale private Baseline-Vergleich liegt separat. Dieser öffentliche
Bericht enthält keine daraus gewonnenen privaten Implementierungsdetails.

## 1. Architektur: vorhandene Module vertiefen

SOs gute fachliche Oberfläche ist `/session → /go → /close`. Dahinter liegen
echte Module für Scope-Disjointness, Union, Session-Identität, Locks, Gate-Runner,
lokale und entfernte Dispatch-Adapter. Die Schwäche liegt in der großen Menge
prozeduraler Skill-Anweisungen: Aufrufreihenfolgen, Seitendateien und Fehlerpfade
müssen noch zu oft im Kontext des koordinierenden Agenten zusammenfinden.

Die Architekturfrage ist deshalb **Locality**: Wo kann ein bestehendes Modul
mehr Verhalten hinter einer kleineren **Interface** bündeln? Der Löschtest
hilft: Verschwindet Komplexität beim Entfernen eines Wrappers, war er unnötig;
taucht sie bei vielen Aufrufern wieder auf, hatte das Modul echten Nutzen.

ECCs [tmux/worktree-Orchestrator](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/scripts/lib/tmux-worktree-orchestrator.js)
legt Worker, Checkouts und Handoff-Artefakte an. Die
[Session-Ansicht](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/scripts/lib/orchestration-session.js)
fasst Task, Status und Pane zusammen. Das kleine Lese-Interface ist ein gutes
Vorbild. Die vielen `/multi-*`-Rezepte sind davon zu unterscheiden: ECC selbst
[verweist auf einen getrennten CCG-Installationsschritt](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/README.md#L568).

**Übernehmen:** eine Ansicht über vorhandene SO-Quellen, mit „unbekannt“ und
„veraltet“ als echten Zuständen. **Nicht übernehmen:** ein zweiter Status-Store
oder ein zusätzlicher Worker-Runner für Arbeit, die der native Harness bereits
ausführen kann.

## 2. Parallelisierung: Ereignisse, Ownership und Resultate

SOs Pool-/Abort-, Filescope- und Remote-Adapter-Verträge sind weiter entwickelt
als ECCs lokaler Launcher. Das bedeutet nicht, dass jeder Vertrag in jedem
Harness durchgesetzt wird. Insbesondere native Codex-Dispatches müssen
Instruktions- und Laufzeitgarantien getrennt ausweisen.

CCG bietet im
[Go-Executor](https://github.com/fengshao1227/ccg-workflow/blob/f349e3de191f3b12609f9d4448772eddddc7e37b/codeagent-wrapper/executor.go#L291)
echte topologische Sortierung, Semaphore und Fehlerisolation. Die Ausführung
wartet jedoch auf eine komplette Schicht, bevor die nächste beginnt; ein DAG
allein beseitigt die Wave-Barriere nicht. Seine
[TaskResult-Struktur](https://github.com/fengshao1227/ccg-workflow/blob/f349e3de191f3b12609f9d4448772eddddc7e37b/codeagent-wrapper/config.go#L56)
mit Task-ID, Exit-Code, Session-ID und Logpfad ist gut verständlich.

**Adaptieren:** ein konsistentes Resultat über bestehende Dispatch-Adapter und
deren Recovery-Fixtures. **Experiment:** kompakte Fan-out/Fan-in-Deklaration,
die an SOs bestehenden Scope-/Gate-Kern bindet. Voraussetzung: ein realer
wiederholter Workflow, bei dem sie messbar weniger Aufruffehler verursacht.

**Ablehnen:** neue Warte-/Polling-Schleifen über nativen Completion-Ereignissen;
modellbasierte Rollenzuweisung ohne Evidenz für die konkrete Aufgabe;
automatisches Überschreiben der gewählten Modelle oder Reasoning-Einstellungen.

## 3. Hooks: registriert ist nicht durchgesetzt

SOs [Codex-Manifest](https://github.com/Kanevry/session-orchestrator/blob/ca214376526873729b0f8707c25e93636cada222/hooks/hooks-codex.json)
hat ein leeres `PreToolUse`; ECCs
[Codex-Manifest](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/hooks/codex-hooks.json)
enthält nur SessionStart. Das belegt eine Lücke in den **ausgelieferten
Adaptern**, keine allgemeine Aussage darüber, was eine beliebige aktuelle
Codex-Version unterstützt. Native Protokolltests müssen einer Aktivierung
vorausgehen.

Eine sinnvolle Capability-Ansicht unterscheidet:

1. im Paket vorhanden;
2. im konkreten Harness registriert;
3. durch Profil/Einstellungen aktiviert;
4. mit Testpayload nachweislich ausgeführt;
5. erzwingend, nachträglich prüfend, nur instruiert oder nicht unterstützt.

ECCs explizite Hook-Offenlegung ist ein guter Produktimpuls. Dafür braucht SO
zunächst verständliche Information über Nebenwirkungen, Daten und Grenzen,
keine zusätzliche Freigabe bei jeder bestehenden Installation.

**Direkt korrigiert:** Der eigene Hook-Development-Skill zeigte ein falsches
Settings-Schema ohne äußeres `hooks`, ein ungültiges Stop-`approve` und weitere
veraltete Payload-/Lifecycle-Angaben. Beispiele wurden anhand der
[offiziellen Hooks-Referenz](https://code.claude.com/docs/en/hooks) korrigiert.

## 4. Sicherheitsstandards kritisch übernehmen

CCGs [Codex-Startargumente](https://github.com/fengshao1227/ccg-workflow/blob/f349e3de191f3b12609f9d4448772eddddc7e37b/codeagent-wrapper/executor.go#L778)
deaktivieren standardmäßig Sandbox und Freigabeprüfungen, sofern keine
Gegenkonfiguration gesetzt ist. Diesen Default nicht übernehmen. Ebenso sind
forcierte Worktree-Bereinigung und Stash-Checkpoints keine geeigneten Defaults
für gemeinsame Arbeitsverzeichnisse.

Im ECC [Bash-Dispatcher](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/scripts/hooks/pre-bash-dispatcher.js#L6)
und [GateGuard](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/scripts/hooks/gateguard-fact-force.js#L1228)
wurde ein verdächtiger Pfad gefunden: Eingabeabschneidung ohne Truncation-Signal
kann ungültiges JSON erzeugen, das ein Guard erlaubt. Das ist ein statischer
Befund; die Erreichbarkeit mit einem echten Client-Payload und die genaue
gesamte Dispatcher-Wirkung sind vor einer Security-Meldung zu reproduzieren.
Für unsere Übernahmen folgt daraus: Größe, Parsefehler und Failure-Policy
müssen zum Input-Vertrag gehören.

Die ursprüngliche Reviewer-Empfehlung, SOs unbekanntes Profil auf `minimal`
zurückzusetzen, wurde verworfen. `full` erhält die Guard-Abdeckung. Ein
möglicher Warnspam rechtfertigt keine Abschwächung der Policy.

[AgentShield](https://github.com/affaan-m/agentshield/tree/b0891303bdcd6037376a94263d45cfd2ff3dfb98)
ist als zusätzlicher Konfigurationsscanner interessant. Pilot zunächst
advisory: Treffer nachprüfen, Fehlalarme dokumentieren, Abdeckung und
Überschneidung mit bestehenden Prüfungen messen. Ein Scanner ersetzt keine
runtimewirksame Berechtigungsgrenze.

## 5. Skills und Lernen: Katalogumfang ist kein Ausbauziel

ECC deckt viele Sprachen und fachliche Verfahren ab. Einzelne Anleitungen
können Lücken schließen. Ein Massentransfer erzeugt jedoch mehr Auswahl- und
Kontextkosten und konkurrierende Anweisungen.

ECCs [Continuous Learning v2](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/skills/continuous-learning-v2/SKILL.md)
hat echte Erfassung und Projektisolation. Aussagen über umfassendes Lernen
müssen mit Observer-Aktivierung, Betriebssystemgrenzen und tatsächlich
implementiertem Verfall/Widerspruchsverhalten abgeglichen werden.

SO besitzt bereits Schema, Quellen-/Evidenzbindung, zeitabhängiges Surfacing,
Archive/Tombstones sowie Reconcile mit Scope und Instruction-Budget. Ein
zweiter Instinct-Store hätte keinen benannten zusätzlichen Verbraucher.

**Adaptieren:** ECCs
[Research-Ausgabe](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/skills/research-ops/SKILL.md)
macht Evidenz, Inferenz und Empfehlung sichtbar. Ein kurzer gemeinsamer
[Recherchevertrag](../../skills/_shared/research-evidence.md) ist jetzt mit
`/plan` und der Research-Wave von `session-plan` verbunden. Er hält vorhandene
lokale Lösungen, Quellstand und einen widerlegbaren nächsten Prüfschritt fest.

**Bestehenden Recovery-Vertrag vertiefen:** [Unified Memory](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/skills/unified-memory/SKILL.md)
liefert Anregungen für stets untrusted Handoff-Daten. Handoff und Compaction
werden als zusätzliche Fälle in die geplanten Operation-Receipts und
Recovery-Fixtures integriert. Kein neuer Store, kein zweiter Receipt-Pfad und
keine automatische Regelpromotion. Einen echten Harness-Wechsel anhand der
vorhandenen STATE-/Recovery-Quellen prüfen.

## 6. Qualität und Evals

SOs konfigurierter Quality-Gate-Runner ist geeigneter als ein generisches
Verification-Rezept mit abgeschnittenen Shell-Pipelines. Die Prozessrubrik von
`/eval` beantwortet eine andere Frage als ein Leistungsbenchmark.

ECCs [Capsule](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/scripts/lib/eval-harness/capsule.js)
und [Replay](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/scripts/lib/eval-harness/replay.js)
sind gute Vorbilder für nachvollziehbare Testartefakte. Kandidatenausführung
bleibt dort bewusst deaktiviert, solange nachgewiesene OS-Isolation fehlt. Deshalb
ist das kein fertiger Ersatz für SOs Benchmark-Plan.

**Beibehalten:** unveränderlicher Test-Harness, echte Exit-Codes, getrennte
Reviews und „nicht bestimmbar“. **Ablehnen:** Selbstbewertung als Qualitätsbeweis,
mehr Tests allein als Erfolgsmaß oder generische Coverage-Vorgaben über den
Projektvertrag hinweg.

## 7. Installation und Produktverständlichkeit

ECCs [Profile](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/manifests/install-profiles.json)
und [Install-State](https://github.com/affaan-m/ECC/blob/8321021c54d670126ce3b2969d5deb880b4b0c2a/scripts/lib/install-state.js)
verbinden Auswahl, Quelle, angewandte Operationen und Ownership. Das ist ein
starker Ausbaukandidat, sofern er auf konkrete SO-Installationspfade begrenzt
wird. Native Plugin-Lifecycle-Funktionen sollen erhalten bleiben.

SO hat bereits Paketlisten-/Leakage-Tests, etwa
[`pack-policy-floor.test.mjs`](../../tests/scripts/pack-policy-floor.test.mjs).
Die verbleibende Frage ist der **ausgeführte Lifecycle aus dem tatsächlich
gepackten Artefakt**: isoliert installieren, Entry-Points aufrufen, lokale
Änderungen erhalten, Update/Deinstallation prüfen und Digest beilegen. Das ist
präziser als die pauschale Behauptung „SO testet seine Pakete nicht“.

## Entscheidungen und Reihenfolge

| Priorität | Entscheidung | Nächster überprüfbarer Schritt |
|---|---|---|
| Jetzt | Research-Evidenzvertrag und Hook-Beispiele korrigieren | Skill-/Link-/Plugin-Validator, Review der tatsächlichen Aufrufstellen |
| Als Nächstes | Gepackten Install-Lifecycle prüfen | ein isolierter Linux-Pfad mit Digest, echten Aufrufen und Erhaltung lokaler Dateien |
| Bestehenden Plan vertiefen | Capability-Metadaten und Generator-SSOT | registriert/aktiv/ausgeführt/erzwingend getrennt zeigen |
| Bestehenden Plan vertiefen | Read-only Attention-/Worker-Ansicht | vorhandene Quellen lesen; stale/unknown sichtbar; kein neuer Store |
| Bestehenden Plan vertiefen | Recovery-/Result-Vertrag | Session-ID, HEAD/Worktree, Zustand und Fehler über Adapter-Fixtures prüfen |
| Bestehenden Plan vertiefen | Recovery-Fixtures um Handoff und Compaction-Herkunft erweitern | realer Harness-Wechsel, veralteten/fremden Zustand ablehnen; kein neuer Store |
| Begrenzter Pilot | AgentShield | kleinste relevante Regelmenge, manuelle Treffer-Triage und dokumentierter Zusatznutzen |
| Erst bei wiederholtem Bedarf | Deklarative Workflow-Oberfläche | gleicher Scope-/Gate-Kern; weniger reale Aufruffehler im Vergleich |
| Verwerfen | zweiter Scheduler/Instinct-Store, Massenskillimport, unsichere Defaults | erst neu öffnen, wenn ein konkreter unerfüllter Vertrag belegt ist |

Der interne Backlog-Abgleich hat vorhandene Vorhaben für Attention-Ansicht,
Recovery, Generatoren, Harness-Metadaten, Skill-Kürzung und isolierte Benchmarks
gefunden. Diese erhalten zusätzliche Evidenz, statt als neue Ideen doppelt
angelegt zu werden. Neue Arbeiten brauchen benannte Abnahmekriterien und einen
Trigger für die Wiederaufnahme.

## Erfolg messen

Vor jedem größeren Umbau 5–10 repräsentative Aufgaben als Instrument-Pilot
festlegen: gleicher Ausgangsstand, gleiches Modell/Reasoning, unveränderliche
Abnahme, getrennte Zustände. Bearbeitungszeit, akzeptiertes Ergebnis, manuelle
Korrekturen und Kontext-/Tokenkosten gemeinsam erfassen. So kleine Stichproben
prüfen zunächst die Messmethode; sie tragen keine allgemeine Überlegenheits-
oder Kostensenkungsbehauptung.

Das Ziel ist eine kleinere Menge an Dingen, die ein Agent richtig wissen und
aufrufen muss — mit mindestens gleich gut nachweisbaren Ergebnissen.
