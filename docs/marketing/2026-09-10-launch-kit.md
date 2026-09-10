# Launch-Kit: Session Orchestrator, TetherCam und WalkAITalkie

Stand: 10. September 2026. Die Texte dienen der gezielten Verwendung nach den Kriterien im [Portfolio-Audit](2026-09-10-portfolio-audit.md). SO, TetherCam und WalkAITalkie sind auf Product Hunt als teamprivate Entwürfe gespeichert und in der Oberfläche geprüft. Die frische Ansicht unter @kanevry zeigt drei Drafts, null geplante und null veröffentlichte Launches; alle drei Bearbeitungslinks sind erreichbar. Es wurde kein Community-Beitrag veröffentlicht und kein Launch terminiert.

Die SO-Integrationsangaben sind der Stand vor dem Merge; die abschließenden CI- und Live-Belege werden in SO #1304 fortgeschrieben.

Die drei Website-Redesigns sind umgesetzt und lokal gebaut beziehungsweise statisch validiert sowie visuell geprüft. SO bleibt öffentlich bei Version 4.2.0. Der finale Remotion-Film ist gerendert, trägt aber weiterhin eine Kennzeichnung als Vorschau für geplante 4.3. Die native Pencil-Arbeit ist abgeschlossen. TetherCam und WalkAITalkie sind inzwischen integriert und mit READY-Deployment live geprüft; die konkreten Belege stehen unten. Der SO-MR und dessen Website-Deployment stehen noch aus. Ein neuer App- oder Store-Release wurde nicht durchgeführt.

## 1. Session Orchestrator

### Ein Satz

**DE:** Session Orchestrator gibt der Arbeit mit Coding-Agenten einen wiederholbaren Ablauf: Projekt verstehen, Arbeit planen, Ergebnisse prüfen und beim nächsten Mal wieder anknüpfen.

**EN:** Session Orchestrator adds a repeatable workflow to AI coding: understand the project, plan the work, check the result and pick up where you left off.

Zielgruppe: Entwickler, die Coding-Agenten regelmäßig einsetzen und dieselben Projektregeln oder offenen Aufgaben immer wieder erklären. Primärer Link: [session-orchestrator.com](https://session-orchestrator.com). Öffentliche Quellen und Installation: [GitHub](https://github.com/Kanevry/session-orchestrator).

### Product Hunt: gespeicherter, teamprivater Entwurf

**Status:** In der Oberfläche als gespeichert und ohne Termin geprüft. Die folgenden Texte sind die redaktionellen Vorlagen; vor einem späteren Termin die tatsächlich gespeicherten Felder und Medien mit dem aktuellen Paket abgleichen.

**Name:** Session Orchestrator

**Tagline:** Plan, run and close your AI coding sessions

**Description:**

Session Orchestrator adds a repeatable workflow to Claude Code, Codex, Cursor and Pi: read the project, plan the work, run checked steps and leave a useful handover. MIT-licensed and built from the prompts I kept reusing across my own projects. Guard support differs by tool; Codex follows instructions without enforcing the plugin's file-scope or destructive-command guards.

**Maker comment:**

I used to keep a Notion page with 20 or 30 prompts for different projects. Before a coding session, I would find the right row, copy it and explain the same working rules again.

That collection gradually became a workflow: plan the work, run it, then close with checks and a record of what is still open. I use it across my own projects on two Macs.

Session Orchestrator packages that workflow for Claude Code, Codex, Cursor and Pi. A small job can stay small. Independent tasks can run in parallel on Claude Code and Codex; Cursor and Pi use sequential execution. The CSV-export example on the site shows the sequence with illustrative data.

The plugin is free under the MIT licence. You still need your coding tool. Its guard support depends on the host and configuration; in Codex, the plugin's file-scope and destructive-command rules are instructions only. It can still make mistakes, so the checks and handover matter.

Where do you usually lose the thread between one coding session and the next?

**Felder und Medien:** Preis Free; Themen Open Source, Developer Tools, Artificial Intelligence. Haupt-URL ohne Trackingparameter, GitHub als zusätzlicher Link, Bernhard als Maker. Der vorhandene Draft verwendet die obige Tagline. Beschreibung und Kommentar hier sind die abschließend geprüfte Copy-Fassung und müssen vor dem Termin mit den tatsächlich gespeicherten Feldern verglichen werden.

Galerie:

1. Werkstattmotiv mit Mensch am Leitstand als gekennzeichnete Illustration, kombiniert mit einer kurzen Produktbeschreibung.
2. Lesbares Plan-/Go-/Close-Beispiel mit konkreter Aufgabe. Nachgestellte Inhalte sichtbar als Beispiel kennzeichnen.
3. Ein überprüfbarer Ausschnitt aus Ergebnis und Übergabe. Echte Laufdaten nur aus einer tatsächlich ausgeführten, bereinigten Session.

Das finale Logo ist A3 mit Person und Terminalmodulen. [Logo-Dateien und Handoff](../../site/brand/README.md), [Remotion-Handoff](../../marketing/remotion/README.md) und [fertiger Vorschaufilm](../../site/video/session-orchestrator-4.3-preview.mp4) liegen vor. Der Film dauert 22 Sekunden; der textfreie Website-Loop neun Sekunden. Erklärende Produktionsbilder sind als Illustrationen bezeichnet. Die Fußzeile kennzeichnet die Kampagne als geplant und nennt 4.2.0 als aktuellen Release. Der Schriftzug oben rechts wurde auf Wunsch entfernt; der Film bleibt der Entwurf für 4.3. Er wird dadurch nicht zur Belegaufnahme eines veröffentlichten 4.3-Produkts. Vor einem PH-Termin gespeicherte Galeriebilder und ein gegebenenfalls hinterlegtes Video mit diesen finalen Assets abgleichen.

### Reddit: kurzer Eintrag für den passenden Self-Promotion-Thread

**Einsatz:** aktueller Weekly Self Promotion Thread in r/ChatGPTCoding. Konto, aktuelle Regeln und bereits vorhandene Beiträge unmittelbar vorher prüfen. Der folgende Text ist kein Vorschlag für einen unmarkierten allgemeinen Feed-Post.

I made Session Orchestrator to stop copying the same project instructions into every coding session.

It gives Claude Code, Codex, Cursor and Pi a repeatable sequence: read the repository, agree the scope, work through the task, check the result and leave a handover. The site shows a small CSV-export example, and the GitHub repo includes installation steps for each tool.

It is MIT-licensed. Parallel work and guard enforcement depend on the host. In Codex, the plugin's file-scope and destructive-command guards are instructions only.

Source and setup: https://github.com/Kanevry/session-orchestrator

Where does a workflow like this add useful structure for you, and where does it become ceremony?

### r/ClaudeAI: technischer Beitrag, noch nicht postfertig

**Arbeitstitel:** The workflow I use to carry a Claude Code task into the next session

Der Titel hat nur dann einen passenden eigenen Beitrag, wenn ein tatsächlicher Claude-Code-Durchlauf vorliegt. Dafür sammeln: Ausgangsaufgabe, geplanter Scope, konkreter Beitrag Claudes, ein gefundenes Problem oder eine notwendige Entscheidung und die erzeugte Übergabe. Zwei kurze echte Ausschnitte reichen. Keine Messwerte oder Logs erfinden, um einen Werbetext wie einen Erfahrungsbericht aussehen zu lassen.

Die gelesenen Regeln erlauben eigene Claude-Projekte mit klarer Funktionsbeschreibung, konkretem Claude-Beitrag und kostenloser Testmöglichkeit; sie nennen außerdem eine Konto-Voraussetzung von mehr als 100 OP-Karma. Die aktuelle Regelansicht entscheidet. Fehlt die Eignung, den passenden Showcase-Thread prüfen und keinen Ersatzaccount oder getarnten Fragenpost verwenden.

### GitHub-About-Vorschlag

Plan, run and close AI coding sessions across Claude Code, Codex, Cursor and Pi. Open-source workflows with checks and useful handovers.

Homepage: https://session-orchestrator.com

Die vorhandenen Topics können um konkrete Produktbegriffe gepflegt werden. Neue Topics sind kein Anlass, beliebige Modell- oder Firmennamen für Reichweite hinzuzufügen. Der Quiet-Supportlink bleibt im Footer oder README: [Support the work](https://paypal.me/Kanevry).

## 2. WalkAITalkie

### Ein Satz

**DE:** Sprich deine Nachricht, Notiz oder deinen Prompt und arbeite mit dem Text weiter. WalkAITalkie übernimmt Diktieren und Bereinigen lokal auf deinem Mac.

**EN:** Speak your next message, note or prompt and work with the text. WalkAITalkie handles dictation and cleanup locally on your Mac.

Die Kurzfassung führt immer zur Seite mit Voraussetzungen und Kanalvergleich. Das lokale Standardverhalten ist keine Behauptung, dass optionale Cloud-Modelle oder Kaufdienste ohne Netzwerk arbeiten.

### Product Hunt: zweiter Launch am bestehenden Produkt gespeichert

**Status:** Der [zweite WalkAITalkie-Launch](https://www.producthunt.com/products/walkaitalkie?launch=walkaitalkie-2) ist am vorhandenen Produkt gespeichert und in der Oberfläche geprüft. Der frühere Launch wird dort relativ als sieben Monate zurückliegend angezeigt. Ein zweites Produktprofil wäre ein Duplikat. Der neue Entwurf ist nicht terminiert; Maker und aktuelles Konto sind @kanevry.

**Offene Profilpflege:** Die bestehende Produktseite enthält noch das frühere Cloud-Framing und einen überholten Store-Review-Stand. Sie zeigt weiterhin „Is this yours? Join“ und verlangt Eigentümerzugriff für ihre kanonischen Produktfelder. Das betrifft die alte Produktbeschreibung, nicht den Zugriff auf die drei gespeicherten Launchentwürfe. Das aktuelle Makerprofil ist @kanevry; die frühere Anzeige eines berni-Handles war veralteter UI-Zustand. Die alte Produktbeschreibung erst nach geklärtem Eigentümerzugriff korrigieren.

**Name:** WalkAITalkie

**Tagline:** Local dictation and text cleanup for your Mac

**Description:**

Dictate messages, notes and prompts on an Apple-silicon Mac with macOS 26+. The direct download includes local dictation, Raw and Clean, and 10 history entries for free. Pro adds formats, translation and microphone-session summaries through a one-time purchase. Review the generated text before using it. The Mac App Store app uses the clipboard; its version, features and purchases may differ.

**Maker comment:**

WalkAITalkie turns a spoken thought into a draft you can work with. Start a recording from a keyboard shortcut, speak, then check the transcript. Clean can help with punctuation, grammar and filler words. Raw leaves the initial transcript as it is.

The direct app includes local dictation and cleanup for free. Pro adds formats, translation, summaries from microphone recordings and up to 200 history entries with export through a one-time purchase. The app requires macOS 26 and Apple Silicon. Local processing works after the models have been downloaded; optional cloud models use your own API key and need a separate opt-in.

There are two distribution channels. The direct app can paste into the active text field with Accessibility permission. The Mac App Store app copies the result to the clipboard. Their versions and purchases can differ, so the website explains them separately.

The before-and-after on the site is an illustrative example. It keeps the uncertainty in the original thought. The app's output still needs a read-through, especially names, decisions and anything you plan to send.

What kind of text would you want to dictate first: a message, a note or a prompt?

**Gespeicherte Einordnung:** Paid with a free option, also kostenloser Basisumfang mit optional bezahltem Pro. Keine vollständig kostenlose Preiskategorie wählen. Die Beschreibung nennt absichtlich keinen Store-Preis. Direct-Preis und Währung werden am Launch-Tag mit der Website und dem tatsächlichen Kaufziel abgeglichen. Aktueller lokaler Seitenstand: 7,99 € in DE und 7,99 US-Dollar in EN, einmalig.

**Haupt-URL:** https://walkaitalkie.com

**Zusätzliche Links:** [Mac App Store](https://apps.apple.com/app/walkaitalkie/id6759335293), [öffentlicher Homebrew-Tap](https://github.com/Kanevry/homebrew-walkaitalkie). Kein Link auf das private Applikationsrepository als öffentliche Quelle.

**Gespeicherte Medien:** Drei frisch exportierte Pencil-Galeriebilder und das bestehende App-Icon sind im Entwurf gespeichert. Die Galerie nutzt reale App-Aufnahmen, ein klar beschriftetes Raw/Clean-Beispiel und einen übersichtlichen Kanal-/Free-Pro-Vergleich. Die aktualisierten Marketing-Frames 01 und 03 enthalten echte UI-Aufnahmen. Frame 05 für Sessions enthält weiterhin einen sichtbaren Platzhalter und darf nicht veröffentlicht werden. Das aktuelle Textbeispiel behält „I think“ und „please double-check“. Ein modelliertes Beispiel bleibt als solches beschriftet. Bilder älterer Appstände sind kein Beleg der aktuellen Releaseversion.

### Reddit: für einen später geeigneten r/macapps-Slot

**Status:** zurückgestellt. Am 9. September gab es bereits einen TetherCam-Beitrag im App-Pile. Die gelesenen r/macapps-Regeln begrenzen Werbung grundsätzlich je Entwickler, nicht nur je App. Frühestens am 9. Oktober erneut prüfen; das Datum ist keine automatische Freigabe. Entwicklerhinweis und passende Free/Pro- beziehungsweise Lifetime-Einordnung bleiben nötig.

**Titelentwurf:** I made a Mac dictation app with free local cleanup and an optional one-time Pro purchase

I'm the developer of WalkAITalkie. It is a menu bar app for dictating messages, notes and prompts on Apple-silicon Macs running macOS 26 or later.

The direct download includes unlimited local dictation, Raw and Clean, and 10 history entries. Pro is an optional one-time purchase for more formats, translation, microphone recordings with summary drafts and other tools.

Local dictation and cleanup work offline after the models are downloaded. If you choose a cloud model, it uses your own API key and sends the required content after a separate opt-in. The app does not capture system audio from Zoom or Teams.

The direct app can insert text into the active field. The Mac App Store build uses the clipboard, and its current version and purchases may differ. Details and downloads: https://walkaitalkie.com

I'd like feedback on the free dictation and cleanup flow: where does the result still need too much editing?

Die Schlussfrage eignet sich nur, wenn tatsächlich Zeit für Antworten und Rückfragen bleibt. Keine Benutzererlebnisse, Vorher/Nachher-Ergebnisse oder Hintergrundgeschichte hinzufügen, die Bernhard nicht berichtet beziehungsweise selbst geprüft hat.

### Öffentliches Listing und GitHub

**Listing-Kurztext:** WalkAITalkie is a Mac menu bar app for dictation and text cleanup. Local dictation is free in the direct download; optional Pro adds formats, translation and other tools through a one-time purchase. Requires macOS 26+ and Apple Silicon. Direct and Mac App Store versions may differ.

**About für den öffentlichen Tap:** Homebrew cask for the direct WalkAITalkie Mac app. Local dictation and text cleanup, with optional one-time Pro.

Homepage: https://walkaitalkie.com

Bei TrustMRR ersetzt ein solcher Text die veraltete 39-Dollar-/Cloud-Fallback-Erzählung erst nach sichtbarer Speicherung. Keine Umsatz- oder Kundenzahl aus dem Listing in die Launch-Copy übernehmen.

## 3. TetherCam

### Ein Satz

**DE:** Dein iPhone statt Webcam: zwei kostenlose Apps, ein USB-Kabel. Wähle TetherCam als Kamera am Mac; für OBS gibt es ein eigenes Plugin mit Mikrofonton.

**EN:** Your iPhone, instead of a webcam: two free apps and one USB cable. Choose TetherCam as your Mac camera, or use the separate OBS plugin for video and microphone audio.

### Product Hunt: gespeicherter, teamprivater Entwurf

**Status:** In der Oberfläche gespeichert und ohne Termin geprüft. Eine spätere Veröffentlichung setzt die geklärte Firmenhistorie voraus. Der Entwurf ist kein zugesagter zweiter Termin nach SO.

**Name:** TetherCam

**Tagline:** Use your iPhone as a wired webcam for your Mac

**Description:**

Two free apps turn your iPhone into a USB webcam for your Mac. Select TetherCam in Zoom, Teams, Meet or another app that lists system cameras. The Mac app outputs 1080p30 video; choose a separate microphone for calls. The optional OBS plugin receives video and iPhone microphone audio. Requires iOS 17+ and macOS 14+ for the Mac app. Free and open source.

**Maker comment:**

Continuity Camera stopped working in my recording setup after an iOS and macOS version mismatch. I wanted a small tool I could inspect and fix, so I built TetherCam.

Install the iPhone app and the Mac app, connect the USB cable, and choose TetherCam as the camera. The Mac app outputs 1080p30 video. For recordings and streams in OBS, a separate plugin brings in both video and the phone's microphone.

Continuity Camera can also use USB. TetherCam is a separate implementation with its own setup and limits: the phone app stays in the foreground, only one receiver can connect at a time, and the Mac camera carries video only. You approve its camera extension once in macOS settings.

Both downloads and the source are linked on the site. The iPhone app and Mac tools have separate release versions. I'd be interested in which camera app you use on your Mac and whether its setup instructions are clear enough.

**Preis:** Free. Haupt-URL [tethercam.app](https://tethercam.app); zusätzliche Links [GitHub](https://github.com/Kanevry/tethercam) und [iPhone App Store](https://apps.apple.com/us/app/tethercam/id6808997521). Die Lizenzen unterscheiden sich zwischen OBS-Plugin und den übrigen Komponenten; nicht das gesamte Projekt als ausschließlich MIT bezeichnen.

**Galerie:** die beiden Apps und der USB-Weg; tatsächliche Kameraauswahl beziehungsweise klar beschriftete schematische Darstellung; reale OBS-Quelle mit korrekter Audioerklärung. Keine 1-ms-„Kameralatenz“ und kein pauschales 60-fps-Versprechen auf einer Mac-App-Folie.

Dieser Entwurf rechtfertigt keinen zweiten Launch oder neuen Reddit-Versuch während offener Reviews. Bestehende Beiträge und Einreichungen zuerst prüfen. Der PH-Firmenabstand gilt auch bei der Reihenfolge mehrerer Produkte desselben Makers.

### GitHub-About-Vorschlag

Use your iPhone as a wired webcam on Mac. Two free apps, plus an OBS plugin with video and microphone audio. Open source.

Homepage: https://tethercam.app

### Antwortbaustein für vorhandene Diskussionen

The Mac app and the OBS plugin are separate paths. For a video call, install the Mac app and select TetherCam as the camera, then choose a microphone separately. For an OBS recording or stream, use the plugin to receive both the picture and the iPhone microphone. Only one of those receivers can connect to the phone at a time.

Nur als direkte hilfreiche Antwort auf eine entsprechende Frage verwenden. Es ist kein vorformulierter Vorwand für eine weitere Produktplatzierung.

## 4. Persönlicher Blogartikel

Der eigenständige DE/EN-Plan ist fertig und im internen GotzendorferV2-Issue #431 als herunterladbarer Anhang gesichert. Er ist die redaktionelle Grundlage im Website-Projekt; dieses Launch-Kit führt keine zweite konkurrierende Artikelfassung weiter.

**Titel DE:** Wie meine Prompt-Bibliothek zu Plan, Go, Close wurde

**Title EN:** How my Notion prompt library became Plan, Go, Close

Der Plan enthält sechs Abschnitte je Sprache, einen deutschen Einstieg mit 199 Wörtern und einen englischen mit 212, fertige Metadaten, freie Slugs, interne Verlinkung, eine Bildidee und eine Faktenmatrix. Kategorie: `behind-the-scenes`.

Die Geschichte beginnt mit Bernhards Notion-Sammlung und dem wiederholten Verwenden von Prompts über Projekte hinweg. Die ungefähr 20–30 Zeilen sind persönliche Erinnerung. Der erste im Git-Verlauf aufgezeichnete Plugin-Commit ist vom 2. April 2026; er belegt weder den Beginn der Vorgeschichte noch den ersten öffentlichen Veröffentlichungstag. Die Formulierung eines zweijährigen öffentlichen Plugin-Alters wird nicht verwendet.

Für den vollständigen Artikel bleibt ein realer, öffentlich beschreibbarer Vorgang auszuwählen. Er soll Auftrag, Entscheidung während der Arbeit, Prüfung und Anschlussarbeit zeigen. Eine nachgebaute Notion-Ansicht wird als Rekonstruktion bezeichnet. Neue biografische Details werden vor Veröffentlichung in die bestehende Faktenquelle übernommen. Der jetzige Arbeitsstand ist ein Plan mit Einstiegen, kein publizierter Artikel und kein angelegtes MDX-Paar.

## 5. Übergabe vor Veröffentlichung

Für Product Hunt gelten laut abgerufener Anleitung: reiner Produktname, Tagline bis 60 Zeichen, Beschreibung bis 500 Zeichen, höchstens drei Themen, unveränderte Haupt-URL ohne Tracking. Thumbnail quadratisch; empfohlen sind 240×240, unter 3 MB, sowie mindestens zwei Galeriebilder mit empfohlenen 1270×760. Ein optionales Video wird über einen vollständigen öffentlichen YouTube-Link hinterlegt. Die aktuelle Oberfläche entscheidet bei abweichenden Feldern. [Vorbereitung](https://www.producthunt.com/launch/preparing-for-launch).

Vor dem Termin die gespeicherten Felder, Medien, Preise und Maker-Zuordnung tatsächlich durchsehen. Ein Draft ist noch kein Launch. Product Hunt nennt sechs Monate Abstand für dasselbe Produkt oder dieselbe Firma und empfiehlt bei mehreren Produkten in kurzer Folge gegebenenfalls eine Bündelung. Deshalb werden nicht drei konkurrierende Termine festgelegt. SO ist als erster Kandidat vorgeschlagen; TetherCam und WAT benötigen danach eine eigenständige Prüfung ihrer Eignung innerhalb derselben Firmenhistorie. Bei WAT kann die relative Anzeige des vor sieben Monaten erfolgten Launches den individuellen Produktabstand erfüllen. Sie klärt nicht die gemeinsame Firmenregel oder den noch offenen Zugriff auf die Produktseite. [Scheduling](https://help.producthunt.com/en/articles/2724119-how-to-schedule-a-post), [Relaunch-Regeln](https://help.producthunt.com/en/articles/484934-can-i-relaunch-my-product).

Vor jedem Community-Beitrag stehen ein fertiger Text, passende aktuelle Regeln, ein geeignetes Konto, ein funktionierender Download und eine Prüfung auf vorhandene Beiträge. Nach dem Post öffentlich sichtbaren Status prüfen und Fragen beantworten. Weder Upvotes erbitten noch einen gefilterten Beitrag mit kleinen Änderungen erneut einschleusen.

Die fertige Copy braucht keine künstliche Dringlichkeit, Perfektionsversprechen oder Nutzungszahlen. Wenn Zahlen sinnvoll sind, gehören Zeitraum und Quelle dazu. Clones, Healthchecks und eigene Sessionanzahlen bleiben aus den Nutzerclaims heraus.


## 6. Integration und Folgearbeit

| Gegenstand | Bestätigter Arbeitsstand | Noch einzutragender Abschluss |
|---|---|---|
| SO-Website, Marke und Film | Umsetzung, lokale Prüfungen, finale A3-Medien, Render und native Pencil-Arbeit abgeschlossen | SO-MR, aktuelle Pipeline und gegebenenfalls tatsächliche Merge-/Deploymentbelege |
| TetherCam | MR !1 mit Asset-Commit `5fc577d` und erfolgreicher Pipeline 9109 integriert; Produktionsstand `f28a32b1` live, Deployment READY bestätigt | Spätere Store-Metadaten und Screenshot-Uploads bleiben separat |
| WalkAITalkie | MR !25, finaler Commit `aae5d036`; maximal 200 Pro-Verlaufseinträge in allen elf gerenderten Preislisten geprüft. Pipeline 9110 erfolgreich; MR als `f0f16ec3` integriert und an den öffentlichen Mirror übertragen | Produktionsstand `f0f16ec3` auf [walkaitalkie.com](https://walkaitalkie.com) live, Deployment READY; alle elf H1 und Preislisten sowie 19 Assets live geprüft |
| Product Hunt SO / TC | Teamprivate, unterminierte Entwürfe gespeichert und sichtbar geprüft | Gemeinsame Firmenhistorie, fertige Medien und ein geeigneter tatsächlicher Termin |
| Product Hunt WAT | Zweiter Launch am bestehenden Produkt gespeichert und unter @kanevry geprüft; drei Galeriebilder und App-Icon hinterlegt, ohne Termin | Zugriff auf die alte kanonische Produktbeschreibung klären und veraltete öffentliche Produkttexte anschließend korrigieren |

Die folgenden Arbeitspakete sind bereits angelegt beziehungsweise ergänzt:

- SO #1304: Launch-Kampagne.
- SO #1305: Messung.
- GotzendorferV2 #431: persönlicher Blogartikel mit dem DE/EN-Plan.
- Ausgearbeitete Notizen an den bestehenden Paketen SO #824, TC #31, WAT #466 und WAT #485.

Das [Makerprofil @kanevry](https://www.producthunt.com/@kanevry) ist gespeichert und öffentlich geprüft: Bernhard Götzendorfer, die Headline „I build coding tools and Mac apps.“, eine persönliche Geschichte in drei Absätzen, das vom Nutzer ausgewählte Porträt, Website-, GitHub- und LinkedIn-Links sowie die Interessen Developer Tools, AI und Mac. My Products zeigt drei Drafts, null Scheduled und null Posted. SO und TetherCam bieten „Manage product“; nur die alte WAT-Produktbeschreibung verlangt weiterhin Eigentümerzugriff.

Offene Felder werden erst mit dem konkreten Beleg geschlossen. CI-Nachweise gelten jeweils für den genannten Commit. TetherCam ist inzwischen integriert und live; die übrigen Integrationsstände stehen in der Tabelle. Die drei gespeicherten Launchentwürfe haben weiterhin keinen Termin.

Vor einer späteren npm-Veröffentlichung den Paketinhalt mitprüfen: Die bestehende `assets/`-Freigabe schließt derzeit auch rund 1,7 MB Marketingbilder und Exporte ein. Dieses Websitepaket veröffentlicht keine neue npm-Version; der Paketumfang wird deshalb bei der tatsächlichen Releasevorbereitung entschieden.
