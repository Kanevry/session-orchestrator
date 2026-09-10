# Portfolio-Audit und Launch-Stand

Stand: 10. September 2026. Gegenstand: Session Orchestrator, TetherCam und WalkAITalkie. Dieser Bericht beschreibt den geprüften lokalen Arbeitsstand und die separat beobachteten öffentlichen Angebote. Die Website-Redesigns sind lokal umgesetzt, gebaut beziehungsweise mit den passenden statischen Prüfungen validiert und visuell getestet. Ein gespeicherter Entwurf und ein veröffentlichtes Produkt bleiben getrennte Zustände. Der Integrationsstand unten nennt die jeweils bestätigten MRs, Pipelines und Deployments.

Die drei Seiten erklären ihren jeweiligen Nutzen jetzt früher und zeigen einen passenden nächsten Schritt. Bei Session Orchestrator steht ein nachvollziehbarer Arbeitsablauf im Mittelpunkt, bei TetherCam die Verbindung zwischen iPhone und Mac, bei WalkAITalkie der Weg vom gesprochenen Gedanken zum überprüfbaren Text. Daraus lässt sich noch keine bessere Conversion oder zusätzliche Nutzung ableiten. Ein Vergleich mit echten neuen Besuchern wurde nicht durchgeführt.

## 1. Was fertig ist, was öffentlich ist

| Oberfläche | Öffentlich belegter Stand | Lokale Arbeit in diesem Paket | Noch vor einem Launch zu erledigen |
|---|---|---|---|
| Session Orchestrator | Version 4.2.0; öffentliche Website, GitHub und npm | EN/DE-Startseiten, Guide, README, Metadaten und Faktenseiten fertig überarbeitet und lokal geprüft; A3-Logo, Werkstattmotiv und native Pencil-Gestaltung fertig; Supportlink ergänzt | SO-MR wird noch angelegt. Aktuelle CI, Merge und tatsächliches Deployment anschließend separat belegen |
| SO auf Product Hunt | Teamprivater Entwurf gespeichert und in der Oberfläche geprüft, ohne Termin | Produktfelder und Launch-Copy vorbereitet; finale Medien liegen vor | Gespeicherte Medien mit dem finalen Satz abgleichen und gemeinsame Firmenhistorie prüfen. Kein Launch terminiert |
| SO-Kampagnenfilm | Kein zusätzlicher Produktrelease durch dieses Marketingpaket | Finale Remotion-Fassung mit A3 gerendert: 22 Sekunden Film, 9 Sekunden Website-Loop und Poster; native Pencil-Arbeit abgeschlossen | Film ist als Vorschau für geplante 4.3 gekennzeichnet. Öffentlich veröffentlichte Produktversion bleibt 4.2.0. Kampagnenfreigabe und Websiteeinbindung getrennt prüfen |
| TetherCam | iPhone im App Store 0.2.0; Mac-App und OBS-Plugin auf GitHub 0.3.0; Website-Redesign auf `f28a32b1` live, Deployment READY bestätigt | EN/DE-Redesign, direkte Downloads, Installationsweg, README und Faktenpflege geprüft; finales Pencil-Dokument, zehn Exporte und Hashmanifest dauerhaft übernommen | MR !1 mit Asset-Commit `5fc577d` und erfolgreicher Pipeline 9109 integriert. Store-Metadaten und neue Screenshot-Uploads bleiben separat |
| TetherCam auf Product Hunt | Teamprivater Entwurf gespeichert und in der Oberfläche geprüft, ohne Termin | Name, Produkttext und Medien als Entwurf angelegt | Kein konkurrierender Termin zu SO. Eignung und Firmenhistorie vor einem Launch klären |
| WalkAITalkie | Direct 2.6.0 laut veröffentlichtem Appcast; öffentliche Mac-App-Store-Seite 2.1.3 | Website in elf Sprachen, reale Appbilder, bedeutungstreues Textbeispiel, Kanalvergleich und Faktenpflege geprüft; Pencil-Dokument samt Exporten übernommen. Die Begrenzung auf 200 Pro-Verlaufseinträge ist in allen elf Preislisten geprüft | MR !25, finaler Commit `aae5d036`; Pipeline 9110 ist erfolgreich; MR als `f0f16ec3` integriert, öffentlicher Mirror aktualisiert. Produktionsstand auf [walkaitalkie.com](https://walkaitalkie.com) live und Deployment READY bestätigt. Frame 05 enthält weiter einen Platzhalter. Kein neuer Store-Release |
| WalkAITalkie auf Product Hunt | Bestehendes Produkt mit früherem Launch; [zweiter Launchentwurf](https://www.producthunt.com/products/walkaitalkie?launch=walkaitalkie-2) gespeichert und geprüft | Unter @kanevry mit drei frischen Pencil-Galeriebildern, App-Icon, lokaler Diktier-Tagline und Paid with a free option hinterlegt | Kein Termin. Nur die alte kanonische Produktbeschreibung verlangt weiterhin Eigentümerzugriff; veraltete öffentliche Copy anschließend korrigieren. Firmenhistorie vor einem Launch prüfen |

Die App-Quellen von WalkAITalkie bleiben privat. Der öffentliche [Homebrew-Tap](https://github.com/Kanevry/homebrew-walkaitalkie) dient der Distribution. Ein früher Recherchebefund zu einem per authentifizierter API lesbaren Repository war kein Nachweis seiner öffentlichen Sichtbarkeit. Weder ein öffentlicher Source-Link noch eine Umstellung der Sichtbarkeit ist Teil dieses Pakets.

Beim SO-Logo hat der Nutzer Variante A3, „Person mit Terminalzeichen“, als finale Richtung gewählt. Die übrigen Varianten bleiben Entwürfe. Das Werkstattmotiv, das Logo und der Film sind Gestaltungsmittel; sie belegen keine tatsächlich ausgeführte Session. Der finale Film wurde mit A3 gerendert, und die native Pencil-Gestaltung ist abgeschlossen. [Logo-Handoff](../../site/brand/README.md) und [Remotion-Handoff](../../marketing/remotion/README.md) halten die verwendeten Assets und Reproduktionsschritte fest. Eine fertig gerenderte Vorschau ist kein Release-Nachweis.

## 2. Vorher und nachher

### Session Orchestrator

Vorher begann die Seite mit „It reads first, asks, then works in checked steps.“ Die Erklärung wechselte zwischen einem allgemeinen Einstieg für Nichttechniker, technischen Rollen und fünf Durchläufen. Mehrere Illustrationen und ein eigener animierter Hero konkurrierten mit dem Ablauf. Die technische Beschreibung konnte den Eindruck erwecken, dass dieselben Schutzmechanismen in allen Coding-Tools aktiv seien.

Jetzt lautet der Einstieg „Give your agents a working rhythm.“ beziehungsweise „Ein klarer Ablauf. Für deine KI-Agenten.“ Direkt darunter stehen Planen, geprüfte Ausführung und Wiederaufnahme. Eine Beispielsession zeigt einen CSV-Export: Projekt verstehen und Scope festlegen, unabhängige Teile bearbeiten und zusammenführen, Ergebnis prüfen und offene Arbeit festhalten. Das Beispiel ist ausdrücklich illustrativ und kein Livebericht.

Der Umfang folgt der Aufgabe: Housekeeping kann eine Welle verwenden, Deep verwendet fünf, das Ultradeep-Profil sieben. Das ersetzt die pauschale Erzählung, jede Änderung brauche denselben großen Ablauf. Installationsbefehle bleiben je Tool auffindbar; technische Details liegen in aufklappbaren Abschnitten statt im ersten Bildschirm.

Die persönliche Geschichte bleibt klein und belegt: eine Notion-Sammlung mit ungefähr 20 bis 30 Promptzeilen, daraus nach und nach Plan, Go und Close, heute im eigenen Alltag auf zwei Macs. Der sichtbare Repository-Verlauf beginnt im April 2026. Die Vorgeschichte der Prompts darf nicht als Alter des öffentlichen Plugins ausgegeben werden.

### TetherCam

Die bisherige Headline war bereits passend. Das Problem lag darunter: lange Aufzählungen, wiederholte App-Namen und ein Mac-Button, der zunächst zu einem weiteren Abschnitt führte. Ein OBS-Screenshot dominierte, obwohl die Mac-App inzwischen der Standardweg für Videoanrufe ist.

Die neue Seite behält „Your iPhone, instead of a webcam.“ beziehungsweise „Dein iPhone statt Webcam.“ Sie erklärt zwei kostenlose Apps und ein USB-Kabel. Beide Downloads sind unmittelbar erreichbar. Der OBS-Weg bleibt sichtbar und bekommt seine eigene Anleitung. Detaillierte Kompatibilität, Einrichtung und Messwerte bleiben erhalten, bestimmen aber nicht mehr die erste Entscheidung.

Der Kamerawähler im Einstiegsbild ist eine schematische Darstellung; das Vorschaubild ist eine generierte Studioszene. Die Beschriftung sagt das. Reale OBS- und iPhone-Aufnahmen bleiben gesonderte Produktbelege. Ein Symbolbild wird nicht nachträglich zum verifizierten Screenshot erklärt.

### WalkAITalkie

Vorher versprach die Seite „Speak. Get perfect text.“ und „100% private“. Das alte Vorher/Nachher machte aus einer unsicheren Aussage eine feste Zusage. Die strukturierte Beschreibung verband die aktuelle Direct-Version mit einem Store-Download, obwohl die Vertriebskanäle abweichen. Die Startseite enthielt sehr viele animierte Abschnitte.

Jetzt lautet der Einstieg „Say what you mean. Keep your voice.“ beziehungsweise „Sprich deinen Gedanken. Schreib in deinem Stil.“ Das Textbeispiel behält die Unsicherheit über eine Budgetfreigabe und die Bitte um Gegenprüfung. Es ist als illustratives Beispiel gekennzeichnet. Echte vorhandene Appbilder zeigen das Menü und Einstellungen; eine manuelle Galerie lässt sich per Tastatur steuern und startet nicht automatisch. Die Marketing-Frames 01 und 03 enthalten echte UI-Aufnahmen. Frame 05 für Sessions enthält weiterhin einen sichtbaren Platzhalter und ist nicht veröffentlichungsbereit.

Lokale Verarbeitung, Modell-Download, optionale Cloud-Nutzung und Kaufdienste werden dort erklärt, wo sie die Entscheidung beeinflussen. „Kostenlos“ bezeichnet den tatsächlich beschriebenen Basisumfang des Direct-Downloads. Die Store-App nutzt die Zwischenablage; Direct kann mit entsprechender Berechtigung ins aktive Feld einfügen.

## 3. Zielgruppen und passende Belege

| Produkt | Erste Zielgruppe und Aufgabe | Was die Seite dafür zeigt | Was sie nicht versprechen sollte |
|---|---|---|---|
| Session Orchestrator | Entwickler, die regelmäßig mit Coding-Agenten an mehreren Projekten arbeiten und beim Wiederanfang Kontext verlieren | Konkrete Session, getrennte Installationswege, offene Arbeit am Ende | Fehlerfreier Code, eine universelle Sandbox, automatisch fünf nötige Wellen oder Produktivitätsfaktoren |
| TetherCam | Mac-Nutzer mit iPhone, die eine kabelgebundene Kamera für Anrufe, Aufnahmen oder Streams suchen | Zwei Downloads, Auswahl der Kamera, expliziter OBS-Weg, überprüfte Apps und Grenzen | Mikrofonton über die Mac-Kamera, 60 fps über jeden Weg oder individuell geprüfte Unterstützung jeder Video-App |
| WalkAITalkie | Apple-Silicon-Nutzer, die Nachrichten, Notizen oder Prompts diktieren und den Entwurf anschließend prüfen | Reale Appbilder, bedeutungstreues Beispiel, Free/Pro und Direct/Store im Vergleich | Perfekte Texte, gleich gute Erkennung in jeder Sprache oder vollständige Aufzeichnung von Online-Meetings |

Die gemeinsame Personenmarke entsteht über Arbeitsweise, klare Belege und zurückhaltende Sprache. Eine identische Headline, ein identisches Roboterbild oder dieselbe Featureliste für drei verschiedene Aufgaben würde diese Unterschiede verdecken.

## 4. Design und Bedienung

Session Orchestrator verwendet Graphit, warmes Weiß und Limette als Aktionsfarbe. Space Grotesk prägt die Überschriften, Inter den Fließtext; Monospace bleibt Befehlen vorbehalten. Die Schriften liegen mit Lizenzhinweisen im Repository. Das Werkstattmotiv zeigt eine gesamte Arbeitsumgebung und einen Menschen am Leitstand. Es wird vollständig statt als enger Ausschnitt präsentiert.

WalkAITalkie verwendet dieselbe klare Hierarchie mit eigener Korallfarbe, Inter Tight für Überschriften, Inter und passenden CJK-Schriften für Fließtext. Das vorhandene App-Icon bleibt erhalten. TetherCam behält seine bestehende Identität und verbessert vor allem Abstände, Einstieg und Download-Reihenfolge.

Pro Produkt bleibt das vorhandene Pencil-Dokument maßgeblich. Das Anlegen beliebig vieler konkurrierender Hauptdesigns ist kein Ergebnis dieses Auftrags. Zusätzliche responsive Ansichten und Kampagnenmedien gehören in dasselbe Produktdokument. Die native SO-Pencil-Arbeit und der finale Remotion-Render sind abgeschlossen. Die gerenderten Dateien und Gestaltungsspezifikationen liegen im Repository; ihre Integration und Veröffentlichung bleiben eigene Prüfpunkte. Die native SO-Datei `session-orchestrator.pen` bleibt als lokales Handoff erhalten und ist wegen eines vom Secret-Scanner beanstandeten internen Metadatenfelds nicht Teil des Commits. Exporte und benötigte Bilddateien sind versioniert.

Lokale Browserprüfungen haben schmale 320px-Ansichten und Desktopansichten abgedeckt. Bei TetherCam wurden Hell-/Dunkelmodus und die Installation betrachtet. Bei WalkAITalkie wurden EN, DE und JA unabhängig visuell geprüft; der implementierende Worker prüfte alle elf Sprachrouten bei 320px. Das ersetzt keine native sprachliche Redaktion jeder Übersetzung und keine Studie mit neuen Nutzern.

## 5. Produktwahrheit: die relevanten Grenzen

### Session Orchestrator

Claude Code kann die Guard-Hooks direkt ausführen. Cursor und Pi verwenden Brücken mit dokumentierten Ereignisgrenzen. Codex bietet Skills und parallele Agenten, setzt die destruktiven Befehlsregeln und den Dateiscope dieses Plugins jedoch nur als Anweisungen um. Das Plugin erzwingt diese beiden Guards dort nicht.

Bei aktivem kompatiblem Scope-Hook blockiert strict die unterstützten Änderungen außerhalb des Scopes, warn meldet sie ohne Ablehnung und off deaktiviert diese Scope-Prüfung. Die separate Richtlinie für destruktive Befehle definiert zehn blockierende und vier warnende Regeln. Die Anzahl der Regeln allein beweist keine Durchsetzung im konkreten Tool.

Das Plugin ist MIT-lizenziert und benötigt kein eigenes Konto. Die verwendeten Coding-Tools können Kosten und Netzwerkverbindungen verursachen. Optionale Telemetrie ist nicht ohne Zustimmung aktiv; der standardmäßige npm-Updatecheck wird separat erklärt. „Lokal“ darf diese Verbindungen nicht verschweigen.

### TetherCam

Die Mac-App benötigt macOS 14 oder neuer und eine Freigabe der Kameraerweiterung. Sie liefert 1920×1080 bei 30 fps und Video ohne Ton. Für einen Anruf wird ein Mikrofon separat gewählt. Das OBS-Plugin kann den iPhone-Mikrofonton in den OBS-Mixer übernehmen; OBS Virtual Camera transportiert selbst ebenfalls nur Video. Die iPhone-App muss im Vordergrund bleiben. Mac-App und Plugin können nicht gleichzeitig denselben Stream empfangen.

Die Kompatibilitätsliste unterscheidet individuell überprüfte Apps von erwarteter Unterstützung über den Systemkamerawähler. Zoom und Teams wurden laut Produktnachweis am 10. September geprüft; daraus folgt kein individueller Test von Webex, Slack oder Discord. Apple Continuity Camera kann ebenfalls USB verwenden. Der Unterschied darf nicht als „Apple nur drahtlos“ erklärt werden.

Die Transport- und Startmessungen stammen aus einem einzelnen beschriebenen Aufbau. USB-Ping und Zeit bis zum ersten dekodierten Frame sind keine Ende-zu-Ende-Kameralatenz. „1 ms Latenz“ wäre deshalb eine falsche Verkürzung.

### WalkAITalkie

Der Direct-Download benötigt macOS 26 oder neuer und Apple Silicon. Free umfasst lokales Diktieren, Raw und Clean sowie zehn Verlaufseinträge. Pro ergänzt unter anderem Formate, Übersetzung, Mikrofonaufnahmen mit Zusammenfassungsentwürfen und bis zu 200 Verlaufseinträge mit Export. Der Speicher ist begrenzt; die frühere Formulierung zum unbegrenzten Verlauf wurde in allen Sprachfassungen und Begleittexten korrigiert. Die elf gerenderten Preislisten wurden bei 320px auf die 200-Einträge-Grenze und Überbreite geprüft. Die lokale Website zeigt 7,99 € für die entsprechenden europäischen Sprachfassungen und 7,99 US-Dollar in der englischen Fassung; Preisformatierung stammt aus der vorhandenen Preisquelle. Store-Preise und Käufe werden nicht daraus abgeleitet.

Parakeet deckt 25 europäische Sprachen ab, WhisperKit mehr als 100; Pro-Übersetzung bietet 38 Zielsprachen. Das sind Angaben zur Abdeckung, keine Qualitätsgarantie. Übersetzung erfolgt nach der Transkription. Mikrofonaufnahmen erfassen Stimmen im Raum, nicht das Systemaudio von Zoom oder Teams.

Nach dem Modell-Download können Diktieren und lokale Bereinigung offline arbeiten. Optionale Cloud-Modelle verwenden den eigenen API-Key und senden nach ausdrücklicher Auswahl die nötigen Inhalte an den Anbieter. Kauf, Aktivierung und Updates bleiben eigene Netzwerkvorgänge. Die öffentliche Formulierung muss diese Entscheidung sichtbar halten.

## 6. SEO, GEO und öffentliche Profile

Die wichtigste Verbesserung für Suche und generative Antworten ist ein einzeln verständlicher, sachlich richtiger Absatz. Metadaten und Maschinenformate unterstützen das; sie sind kein Beleg für Ranking, Indexierung oder KI-Zitate.

| Bereich | Umgesetzt oder geprüft | Grenze / nächste Kontrolle |
|---|---|---|
| SO | Klare EN/DE-Titel und Beschreibungen, kanonische Seiten, passende Social Card, FAQ/JSON-LD-Parität, Guide, llms.txt und vollständige Faktenseite | Logo und Medien liegen final vor; Einbindung und zugehörige Metadaten bei der Integration prüfen. Nach Deployment tatsächliche Antworten und Indexstand beobachten |
| TetherCam | Suchintention iPhone-als-Mac-Webcam im Einstieg; EN/DE-Kanonisierung und hreflang; FAQ-Antworten stimmen mit JSON-LD überein; Installationshilfe, Social Card und llms.txt gepflegt | Der bestehende Store-Text stellt noch stärker OBS heraus. Externe Beschreibungen nachziehen; keine Keyword-Zählung als Qualitätsbeweis |
| WalkAITalkie | Lokalisierte Metadaten und Social Cards; Direct-Angebot im SoftwareApplication-Schema; FAQ-Schema auf der Homepage statt pauschal in jedem Layout; reale Bilder, klare Kanalgrenzen in llms.txt | Weder private Quellen als öffentliches Repo verlinken noch den Store automatisch mit der Direct-Version versehen. Suchsnippets nach dem tatsächlichen Deploy neu beobachten |
| READMEs | Nutzen, Installation und Grenzen vor Details; aktuelle Wege und Supportlinks | SO und TetherCam sind öffentliche Einstiege. WAT-App-README bleibt intern; der öffentliche Tap ist separat |
| TrustMRR | Im Audit als veraltetes WAT-Listing erkannt | Preis von 39 US-Dollar und altes Cloud-Framing angleichen. Keine Änderung als erledigt ausgeben, bevor das Listing öffentlich neu geprüft wurde |

Die GitHub-Beschreibung für SO sollte den Sessionablauf benennen. Bei TetherCam sollten Mac-App und OBS-Weg gemeinsam verständlich sein. Eine Änderung der GitHub-Felder ist erst abgeschlossen, wenn sie gespeichert und sichtbar geprüft wurde. Die Repository-Dateien in diesem Paket allein ändern keine About-Felder oder externen Listings.

## 7. Zahlen ohne erfundene Adoption

Am 10. September ergab die öffentliche GitHub-Abfrage für SO 50 Stars und sieben Forks. Die npm-API meldete 425 Downloads für den Zeitraum 3. bis 9. September. Das sind datierte Plattformwerte. Sie sind keine Zahl aktiver Anwender und kein Nachweis erfolgreicher Installationen. [GitHub](https://github.com/Kanevry/session-orchestrator), [npm-Zeitraumabfrage](https://api.npmjs.org/downloads/point/2026-09-03:2026-09-09/session-orchestrator).

Der vorhandene Website-Census enthält andere, jeweils eigene Messfenster: beispielsweise einen 30-Tage-Downloadwert und die vom Projekt erfassten Session-Datensätze. Unterschiedliche Zeiträume werden nicht direkt verglichen. Die Überarbeitung verändert die bestehenden Census-Werte nicht und bezeichnet Sessions ausdrücklich als Entwicklungsaktivität.

| Quelle | Was sie tatsächlich erfasst | Was daraus nicht folgt |
|---|---|---|
| GitHub Stars / Forks | Plattformaktionen bis zum Abrufzeitpunkt | Aktive Nutzer, zahlende Kunden oder erfolgreich eingerichtete Projekte |
| npm-Downloads | Downloadrequests im angegebenen Zeitraum, einschließlich Automatisierung | Eindeutige Installationen oder regelmäßige Nutzung |
| GitHub-Traffic / Clones | Seiten- und Clone-Ereignisse mit plattformeigener Zählung | Dass jeder Clone ein Mensch oder neuer Entwickler ist |
| Session-Ledger | Eigene Entwicklungsdatensätze, teilweise mehrfach je Session und mit verschiedenen Schemata | Nutzerzahl oder abgeschlossene erfolgreiche Sessions allein aufgrund eines Zeitstempels |
| Infrastruktur-Logs | Requests auf untersuchte Endpunkte und im untersuchten Dateizeitraum | Produktnutzung; erfolgreiche Healthchecks sind keine Anwendersessions |
| Release-Asset-Zähler | Abrufe je DMG, PKG, ZIP oder Prüfsummendatei | Die Summe als Zahl installierter Personen |
| Externe Umsatzseite | Die dort ausdrücklich angegebene verknüpfte Zahlungsquelle | Vollständiger Umsatz aller Kanäle oder Kundenzahl |

Interne Host-, Traffic- und Kontodaten werden hier nicht veröffentlicht. Aus der internen Logprüfung entsteht kein öffentlicher Nutzungsclaim. Eine spätere Auswertung muss Session-IDs kanonisch zusammenführen, den letzten gültigen Datensatz bestimmen und Erfolg, Abbruch sowie unbekannten Status getrennt behandeln.

Für die Launch-Auswertung genügen zunächst nachvollziehbare Linkaufrufe, Downloadversuche und freiwillig berichtete erfolgreiche Einrichtung. Jede Stufe bekommt eine Definition, Zeitraum und bekannte Lücken. Eine Messung wird nicht rückwirkend aus vorhandenen Healthchecks konstruiert.

## 8. Voice- und Humanize-Prüfung

Grundlage war Bernhards Voice-Profil, Fassung vom 27. Juli 2026, einschließlich der Unterscheidung zwischen harten Verboten und kontextabhängigen Sprachregeln. Die tatsächlichen Funktionen hasAntiPattern und countStimmMarker aus speaker-kit-patterns.ts wurden auf extrahierte Prosa angewendet. Der normale Speaker-Kit-CLI-Lauf wäre hier ungeeignet: Er überspringt Website-Pfade.

Die Extraktion umfasste 25 Dokumente: drei SO-HTML-Seiten, drei TetherCam-HTML-Seiten, elf gerenderte WAT-Homepages, vier READMEs und vier llms-Fassungen. Sichtbare Beschriftungen, Alttexte und beschreibende Metadaten wurden mitgelesen. Scripts, Styles, SVG-Code, Befehle und Codeblöcke wurden entfernt. Anschließend erfolgte eine inhaltliche Prüfung der englischen und deutschen Hauptprosa. Der neue WAT-Changelog-Eintrag wurde separat gegen die veröffentlichten Release-Informationen geprüft.

Ergebnis des ersten Laufs: kein Em-Dash-, Superlativ- oder künstliches Dringlichkeitsmuster in dieser extrahierten Hauptprosa. Ein konkreter Rest blieb: der Autorenname war auf den drei TC-Seiten, in dessen llms.txt und in allen elf WAT-Copyright-Fußzeilen mit oe statt ö ausgeschrieben. Das Voice-Profil verlangt dort „Götzendorfer“. Der Coordinator hat die Korrektur übernommen; die drei HTML-Dateien, TC-llms.txt und alle elf WAT-Sprachdateien wurden danach im Quellstand erneut geprüft. Technische URLs und Identifier bleiben unverändert. Auch die abschließende Korrektur auf 200 Pro-Verlaufseinträge wurde inzwischen im integrierten WAT-Stand über alle elf gerenderten Preislisten geprüft.

Die breite Unicode-Prüfung erkannte das Copyrightzeichen als potenzielles Bildsymbol. Das ist ein Fehlalarm und kein Anlass, Copyrightangaben zu entfernen. Ein „We follow Conventional Commits“ in der SO-Beitragsdokumentation beschreibt eine Projektkonvention und wurde nicht als erfundene Corporate-Stimme gewertet.

Die positiven Marker lieferten fünf Treffer in drei Dokumenten, verteilt auf konkrete Begründung, Privatbezug und technische Nuance. Die Kategorienzählung ist kein Authentizitätswert. Insbesondere bei englischer oder japanischer Prosa ist das Ausbleiben eines deutschen Regex kein Mangel. Auch deutsche Webtexte werden nicht mit künstlich eingefügtem „ehrlich gesagt“ aufgefüllt.

Inhaltlich relevant sind die entfernten Perfektionsversprechen, die erhaltene Unsicherheit im WAT-Beispiel, der konkrete SO-Ablauf, die singuläre Maker-Stimme und sichtbare Grenzen statt großer Kennzahlen. Die WAT- und TC-Prosa wurde von einem anderen Worker als dem jeweiligen Implementierer gelesen. Bei SO wurde die Copy erneut geprüft; den Gesamt- und Medienreview hat der Coordinator übernommen. Der abschließende Berichtsabgleich wurde von einem weiteren Worker vorgenommen. Eine muttersprachliche Redaktion aller neun weiteren WAT-Sprachen wurde nicht durchgeführt.

## 9. Verifikation und ihre Reichweite

| Prüfung | Ergebnis | Was damit nicht belegt ist |
|---|---|---|
| SO: gezielte Website-/Dokumentations-Tests | 178 Tests bestanden, einschließlich der vier neuen Brand-Seiten; Plugin-Validierung 229/229; ESLint, JavaScript-Syntax und Diff-Whitespace geprüft | Remote-CI und Deployment des abschließend integrierten Stands |
| SO: Browser | Desktop und 320/390px geprüft; keine horizontale Überbreite; Kopieren, Menü per Escape, Detailanker und FAQ ohne JavaScript geprüft | Ein neuer vollständiger Tool-Installationsdurchlauf oder Guard-Durchsetzung in jedem Host |
| SO: Film und Gestaltung | Finale A3-Fassung gerendert; Film H.264 1920×1080, 30 fps, 22 Sekunden; Loop MP4/WebM 960×640, 9 Sekunden; ohne Audiospur. Render-Verifikation und native Pencil-Arbeit abgeschlossen | Ein öffentlicher 4.3-Release, ein hochgeladenes Kampagnenvideo oder dessen Freigabe für einen Launch |
| TC: Browser und Links | EN/DE bei 320px; Desktop hell/dunkel; keine fehlenden referenzierten lokalen Bilder; DMG, PKG und App-Store-Ziel erreichbar; FAQ und JSON-LD mit je 15 Antworten konsistent | Erneuter Hardwaretest während dieses Marketingreviews oder Freigabe eines neuen Store-Builds |
| TC: Integration und Remote-CI | Pipeline 9109 zu MR !1 auf Asset-Commit `5fc577d` erfolgreich; integrierter Produktionsstand `f28a32b1` live und Deployment READY bestätigt | Ein neuer App- oder Store-Release |
| WAT: Website | Produktionsbuild mit 49/49 generierten Seiten, TypeScript und vollständiges pnpm lint bestanden; unabhängige Ansichten EN/DE/JA, Tastaturgalerie und FAQ ohne JavaScript geprüft. Alle elf Preislisten zeigen bei 320px korrekt bis zu 200 Pro-Verlaufseinträge. Produktionsstand `f0f16ec3` live und READY: alle elf H1 und Preislisten sowie 19 Assets mit HTTP 200 geprüft; EN bei 390px und DE bei 320px ohne horizontalen Überlauf | Store-Build, Kaufabschluss und Erkennungsqualität bleiben eigene Prüfpunkte |
| WAT: Downloads und Changelog | Direct-Link und versioniertes 2.6.0-DMG erreichbar; Appcast-Datum geprüft; 2.5.0-Eintrag bytegleich zur damaligen Releasefassung wiederhergestellt; beide versionierten DMGs HTTP 200 | Dass ein HTTP-200-Abruf einer Neuinstallation und Lizenzaktivierung entspricht |
| WAT: strukturierte Daten / Social Cards | FAQ-Antworten EN/DE/JA in sichtbarem Text und JSON-LD identisch; DE/JA-Social-Cards bei 1200×630 visuell geprüft | Validierung in jedem externen Crawler oder eine Verbesserung der Suchplatzierung |

Lokale Vorschauen melden den Vercel-Analytics-Endpunkt teilweise als nicht verfügbar. Diese Plattformroute fehlt im lokalen Server; daraus wurde kein Fehler des Produktionsdeployments abgeleitet. Umgekehrt wird eine lokale Testserie nicht als „CI grün“ bezeichnet. Nach weiteren Änderungen werden die betroffenen Prüfungen erneut ausgeführt, statt alte Ergebnisse auf neue Dateien zu übertragen.

## 10. Kanäle: jetzt vorbereiten, später veröffentlichen

Die Regeln wurden am 10. September auf den verlinkten Primärseiten recherchiert. Teilweise stammt die gelieferte Ansicht aus dem Suchindex. Unmittelbar vor einem Submit sind die sichtbaren Regeln, die Konto-Eignung und bestehende Beiträge erneut zu prüfen.

| Kanal | Jetzt | Später / Freigabekriterium |
|---|---|---|
| Eigene Seiten / öffentliche Repositories | Fertige Änderungen integrieren, prüfen und kontrolliert veröffentlichen | Live-Seiten und tatsächliche Linkziele anschließend prüfen |
| Product Hunt | SO, TC und WAT als teamprivate Entwürfe unter @kanevry gespeichert und geprüft; drei Drafts, null Scheduled, null Posted | SO zuerst vorgeschlagen. Keine drei konkurrierenden Termine. Weitere Launches erst nach geklärter Produkt- und Firmenhistorie |
| r/ClaudeAI | SO-Beitrag mit konkretem Einsatz und Funktionsbeschreibung vorbereiten | Aktuelle Konto-Eignung prüfen; die gelesenen Regeln nennen mehr als 100 OP-Karma, klaren Claude-Beitrag und kostenlose Testmöglichkeit |
| r/ChatGPTCoding | SO-Kurzfassung für den aktuellen Self-Promotion-Thread | Ein eigener Engineering-Beitrag braucht einen konkreten technischen Lernwert; keine verkleidete Werbung |
| r/macapps | Bestehenden TetherCam-Eintrag und Reaktionen betreuen | WAT-Start verschieben. Gelesene Regel: zehn lokales Karma, Entwicklerhinweis, üblicherweise ein Werbeeintrag je Entwickler in 30 Tagen; konservativ ab 9. Oktober erneut prüfen |
| r/SideProject | Vorhandenen TetherCam-Kontext erhalten | Ein einzelner späterer SO- oder WAT-Beitrag mit eigenem Anlass, nach erneuter Frequenzprüfung |
| r/obs, r/microsaas, r/IMadeThis | Status der bestehenden gefilterten TetherCam-Beiträge und Review-Anfragen prüfen | Keine Varianten oder Wiederholungen zum Umgehen der Moderation |
| OBS-Forum / awesome-obs | Bestehende Einreichung beziehungsweise PR prüfen | Erst nach bestätigter Annahme als Listing bezeichnen; keine Doppeleinreichung |
| Show HN, r/LocalLLaMA, r/opensource, weitere Fachkanäle | Passenden technischen Inhalt und konkrete Demo vorbereiten | Regeln sind in diesem Paket nicht abschließend geprüft. Erst mit sofort ausprobierbarem Nutzen beziehungsweise reproduzierbarem Vergleich entscheiden |
| Eigener Blog | DE/EN-Plan mit Gliederungen, Einstiegen, SEO und Faktenmatrix fertig; in Issue #431 erfasst | Vollständigen Artikel mit einem belegten Praxisbeispiel ausarbeiten; biografische Details vor Veröffentlichung in die Faktenquelle übernehmen |

Quellen: [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/), [r/ChatGPTCoding](https://www.reddit.com/r/ChatGPTCoding/), [r/macapps](https://www.reddit.com/r/macapps/), [Product-Hunt-Vorbereitung](https://www.producthunt.com/launch/preparing-for-launch), [Scheduling](https://help.producthunt.com/en/articles/2724119-how-to-schedule-a-post), [Relaunch-Regeln](https://help.producthunt.com/en/articles/484934-can-i-relaunch-my-product).

Product Hunt nennt sechs Monate Abstand für dasselbe Produkt oder dieselbe Firma. Der frühere WAT-Launch liegt laut relativer UI-Anzeige sieben Monate zurück; das kann den individuellen Produktabstand erfüllen, klärt aber noch nicht die gemeinsame Firmenhistorie. Die aktuelle Maker-Zuordnung der drei Entwürfe ist @kanevry. Die drei Entwürfe bekommen deshalb keine parallel konkurrierenden Termine. SO bleibt der vorgeschlagene erste Kandidat.

Der TetherCam-Verlauf ist ein konkreter Grund, jetzt keine neue Serie ähnlicher Posts zu starten. Drei Einreichungen wurden am Vortag gefiltert; die Ursache ist nicht belegt. Ein sichtbarer Beitrag und ein sichtbarer App-Pile-Kommentar sind positive Sichtbarkeitsnachweise, jedoch noch kein Installationsnachweis. [SideProject-Beitrag](https://www.reddit.com/r/SideProject/comments/1wbgju8/my_iphone_kept_disconnecting_while_recording/), [App-Pile-Kommentar](https://www.reddit.com/r/macapps/comments/1w4brkd/comment/p8ppyzr/), [awesome-obs-PR](https://github.com/Pralhad-Nasane/awesome-obs/pull/10).

## 11. Kriterien für einen konkreten Launch

1. Der verlinkte Live-Stand erklärt dieselben Funktionen und Grenzen wie das tatsächlich angebotene Artefakt. Version, Betriebssystem, Free/Pro und Direct/Store stimmen je Kanal.
2. Ein neuer Besucher findet den richtigen Download beziehungsweise die richtige Installation. Der aktuelle veröffentlichte Weg wurde nachvollzogen; lokale Builds werden nicht als Releasebeleg verwendet.
3. Die Galerie zeigt reale Produktbilder oder ausdrücklich bezeichnete Beispiele. Versionen in Video, Thumbnail, Landingpage und Post passen zusammen. Der fertig gerenderte 4.3-Vorschaufilm bleibt ausdrücklich als Vorschau gekennzeichnet; eine Releasefassung benötigt einen belegten passenden Produktrelease.
4. Finale Änderungen sind integriert; passende lokale Prüfungen und die tatsächlich aktuelle CI sind dokumentiert. Das Live-Deployment ist anschließend sichtbar geprüft.
5. Der konkrete Kanal und das Konto sind geeignet. Vorhandene Drafts, Beiträge und Reviews wurden geprüft; es entsteht kein Duplikat. Bei Product Hunt bleibt der Draft bis dahin unterminiert.
6. Eine Person kann nach Veröffentlichung Rückfragen beantworten. Erfolg wird anhand definierter Beobachtungen bewertet, nicht durch eine feste Postingquote oder aufgeblähte Nutzungszahlen.

Priorität hat derzeit SO als erster ausgearbeiteter PH-Kandidat, weil bereits ein gespeicherter Draft und eine öffentliche Installationsbasis bestehen. Das ist eine Priorisierung nach dem aktuellen Arbeitsstand. Sie ist keine Zusage, dass SO zuerst veröffentlicht werden muss, wenn ein anderes Produkt früher alle Kriterien erfüllt.

## 12. Belege und nächste Arbeiten

Öffentliche Produktquellen: [SO-Website](https://session-orchestrator.com), [SO-GitHub](https://github.com/Kanevry/session-orchestrator), [SO-npm](https://www.npmjs.com/package/session-orchestrator), [TetherCam-Website](https://tethercam.app), [TetherCam-Releases](https://github.com/Kanevry/tethercam/releases), [TetherCam im App Store](https://apps.apple.com/us/app/tethercam/id6808997521), [WalkAITalkie](https://walkaitalkie.com), [WAT-Appcast](https://oj0jtcebfrfsieei.public.blob.vercel-storage.com/releases/appcast.xml), [WAT im Mac App Store](https://apps.apple.com/us/app/walkaitalkie/id6759335293?mt=12), [WAT-TrustMRR](https://trustmrr.com/startup/walkaitalkie).

Der [SO-Product-Hunt-Draft](https://www.producthunt.com/products/session-orchestrator?launch=session-orchestrator), der TetherCam-Entwurf und der [zweite WalkAITalkie-Launch](https://www.producthunt.com/products/walkaitalkie?launch=walkaitalkie-2) sind teamprivat gespeichert, sichtbar geprüft und nicht terminiert. Die frische My-Products-Ansicht unter @kanevry zeigt drei Drafts, null Scheduled und null Posted; alle drei Bearbeitungslinks sind erreichbar. Der WAT-Entwurf enthält die Tagline „Local dictation and text cleanup for your Mac“, die Einordnung Paid with a free option, drei frische Pencil-Galeriebilder und das bestehende App-Icon.

Das [Makerprofil @kanevry](https://www.producthunt.com/@kanevry) wurde gespeichert und öffentlich geprüft: Name Bernhard Götzendorfer, Headline „I build coding tools and Mac apps.“, eine persönliche Geschichte in drei Absätzen, ein echtes WSAM-Porträt, Website-, GitHub- und LinkedIn-Links sowie die Interessen Developer Tools, AI und Mac. Die frühere berni-Anzeige war veralteter UI-Zustand. SO und TetherCam zeigen „Manage product“. Die alte kanonische WAT-Produktseite zeigt weiterhin „Is this yours? Join“ und benötigt Eigentümerzugriff; deshalb bleiben dort die veralteten Cloud- und Store-Review-Aussagen noch öffentlich. Dieser offene Zugriff betrifft nur die bestehende Produktbeschreibung, nicht die drei Launchentwürfe.

Der [Launch-Kit-Entwurf](2026-09-10-launch-kit.md) enthält verwendbare Texte und die Bedingungen dafür. Die Folgearbeit ist inzwischen konkret erfasst:

| Arbeitspaket | Erfasster Stand |
|---|---|
| SO #1304: Launch-Kampagne | Angelegt; fertige Gestaltung und Entwürfe mit Eignung, Termin und tatsächlichem Produktrelease abstimmen |
| SO #1305: Messung | Angelegt; Link-, Download- und Einrichtungsereignisse mit Definitionen und Messfenstern planen |
| GotzendorferV2 #431: Blog | Angelegt; der DE/EN-Plan aus dem Website-Projekt ist im Issue als herunterladbarer Anhang gesichert |
| SO #824 | Bestehendes Arbeitspaket um eine ausgearbeitete Notiz ergänzt |
| TC #31 | Bestehendes Arbeitspaket um eine ausgearbeitete Notiz ergänzt |
| WAT #466 und #485 | Bestehende Arbeitspakete um ausgearbeitete Notizen ergänzt |

**Integrationsbelege:** TC-MR !1 mit Asset-Commit `5fc577d` und erfolgreicher Pipeline 9109 ist integriert; Produktionsstand `f28a32b1` ist live und das Deployment READY. WAT-MR !25 steht auf `aae5d036`; die Korrektur auf 200 Pro-Verlaufseinträge ist geprüft, Pipeline 9110 erfolgreich und MR als `f0f16ec3` integriert. Der öffentliche Mirror ist aktualisiert; Produktionsstand `f0f16ec3` ist auf [walkaitalkie.com](https://walkaitalkie.com) live und Deployment READY bestätigt. Alle elf H1 und Preislisten sowie 19 Assets wurden live geprüft; EN bei 390px und DE bei 320px zeigen keinen horizontalen Überlauf. Alle drei PH-Entwürfe sind gespeichert und unter @kanevry zugänglich.

**Noch einzutragende Abschlussbelege:** SO-MR und aktuelle Pipeline sowie dessen tatsächlicher Deploymentabschluss. Die bestätigten TetherCam- und WalkAITalkie-Veröffentlichungen gelten für die Websites und nicht als neue App- oder Store-Releases.
