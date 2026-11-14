---
format: agentic-designer/design-context
version: 2
product: 'session-orchestrator.com, Überarbeitung der statischen Website (Worktree so-57-web)'
source: { document: '', revision: 0 }
updated: 2026-11-13
languages: ['en', 'de']
formality: informal
motion: orchestrated
latitude: bold
density: balanced
claims: 'scripts/site-numbers.mjs (Beleg site/_census.json), docs/telemetry/telemetry-claims.md, CHANGELOG.md'
voiceProfile: 'Kein eigenes Stimmprofil im Repo gefunden; Maßstab sind die bestehenden Texte in site/index.html und README.md'
value: 'My coding agent agrees a plan with me before it changes anything, checks every round with my own tests and leaves a handover for the next session, and I can see the one line that installs it.'
constraints:
  - 'Bleibt statisch: HTML, CSS und JS unter site/, ausgeliefert ohne Build (vercel.json outputDirectory site, buildCommand null). Kein Next.js-Neubau: Entscheid des Leads 2026-11-13; das PRD vom 2026-07-25 ist nicht Teil dieses Auftrags.'
  - "Alles vom eigenen Host (CSP in vercel.json): default-src, font-src und connect-src 'self', script-src und style-src 'self' 'unsafe-inline', img-src 'self' data:, frame-src 'none', form-action 'none'. Keine fremden Schriften, kein CDN, kein Embed, kein Formular, kein Newsletter-Feld."
  - 'Datenschutz verspricht cookielose Reichweitenmessung (Vercel Web Analytics same-origin unter /_vercel/insights/), keine Cookies, nichts in localStorage oder sessionStorage, kein weiteres Tracking (site/datenschutz/index.html). Nichts Neues darf speichern oder messen.'
  - 'Marke bleibt: nur dunkel (color-scheme dark), Limette als einziger Akzent, Space Grotesk, Source Sans 3, IBM Plex Mono, Logo A3 (site/brand/preferred.json). „Herzhafter, wie von einem Grafiker“ heißt Form, Maßstab und Komposition, keine neuen Farben (Brief des Leads 2026-11-13).'
  - 'Hauptbild ist das echte Produkt: ein echter Ablauf /session, /go, /close im Terminal, aus einem echten Transkript gesetzt, gekürzt und als gekürzt gekennzeichnet. Keine erfundene Oberfläche. Die KI-Illustration „agent production“ verlässt die Rolle des Hauptbilds.'
  - 'Keine KI-erzeugten Personen in neuen Bildern (Brief des Leads, DES-005). Die vorhandenen Illustrationsreihen zeigen eine KI-erzeugte Person (site/img/README.md); ob sie an anderer Stelle bleiben, entscheidet der Owner.'
  - 'Englisch zuerst. Deutsch nur für Startseite (/de) und Befehle (/de/commands). Guide, Lead und alle weiteren Seiten bleiben englisch.'
  - 'Keine App-Seiten, kein Login, kein Konto, keine Warteliste: das Produkt ist ein lokales Plugin. Genau eine Hauptaktion: installieren.'
  - 'Impressum und Datenschutz sind nicht Teil der Gestaltung; die Links im Fuß bleiben.'
  - 'Zahlen nur als data-metric-Spans, geschrieben von scripts/site-numbers.mjs, nie von Hand. Repository-Zahlen beschreiben Entwicklungsaktivität, keine Nutzer.'
  - 'Werkzeugvergleich bleibt ehrlich: Codex setzt die Dateiliste je Agent nur als Anweisung um, Cursor und Pi arbeiten nacheinander und blockieren über eine Brücke (site/index.html, Tabelle „What works in which coding tool“).'
  - '1440 ist die Hauptbreite, 390 und 320 sind voll benutzbar, ohne waagrechtes Scrollen (Vorgabe des Leads 2026-11-13). Grund: Vercel Web Analytics, abgefragt 2026-11-13, zählt in 30 Tagen 133 Besucher am Desktop und 19 am Handy (87,5 % Desktop), in 90 Tagen 280 und 49, und in 30 Tagen stiegen 112 Besucher auf / ein; kleine Zahlen, kein Anteil wird als Wirkung gedeutet. Ausnahme von der Zahlenregel unten: interne Messung für Gestaltungsentscheide, nie Text auf der Seite.'
  - 'Jede Bewegung hat ein Standbild für prefers-reduced-motion; schwere Teile laden nur, wenn sie laufen dürfen (Muster site/assets/how.js).'
# prettier-ignore
productState: {"access":"open","note":"Kostenloses MIT-Plugin ohne Konto; Hauptaktion: Installationsbefehl für das eigene Werkzeug kopieren"}
---

# Design context

Product: session-orchestrator.com, Überarbeitung der statischen Website. Noch keine Owner-Wahl einer Richtung. Weitere Dateien: Logo und Palette `site/brand/README.md`, Bildherkunft `site/img/README.md`, Zahlenbeleg `site/_census.json`.

Wichtigstes zuerst (Freitext wird bei 4000 Zeichen gekappt): Der erste Bildschirm zeigt das echte Produkt groß: ein Terminal, in dem `/session feature …` einen Plan vorschlägt und auf ein Ja wartet, `/go` in Runden arbeitet und nach jeder Runde die Tests laufen, `/close` prüft, committet und den Rest als Issues ablegt. Darüber ein kurzer Satz, was das ist: ein kostenloses Workflow-Plugin für Claude Code, Codex CLI, Cursor IDE und Pi, das selbst keinen Code schreibt. Die H1 heute lautet „From your task to checked work.“ (site/index.html). Eine Hauptaktion: Installieren, mit dem kopierbaren Befehl für das eigene Werkzeug. In fünf Sekunden muss klar sein: Du sagst Ja zum Plan, jede Runde wird mit deinen Tests geprüft, die nächste Session macht dort weiter. Abschnittsfolge heute (Eyebrows in site/index.html): Kopf, How it works (darin „Nothing gets lost“), Which command, How it fits together, It learns, Your coding tool, My recommendation, Made by, Install, Under the hood, A few practical questions, For your next project. Die neue Folge ist offen.

Für wen: Menschen, die Claude Code, Codex CLI, Cursor IDE oder Pi schon an einem Git-Repository nutzen und vor dem Start der Agenten einen vereinbarten Plan, nach jeder Runde eine Prüfung und eine schriftliche Übergabe an die nächste Session wollen, kostenlos und lokal (README.md, „Who it is for“). Sie kommen meist aus einem Plugin-Katalog oder von GitHub und wollen wissen: was macht es, läuft es in meinem Werkzeug, welche Zeile füge ich ein.

## Value

My coding agent agrees a plan with me before it changes anything, checks every round with my own tests and leaves a handover for the next session, and I can see the one line that installs it. Der erste Bildschirm wird mit diesem Satz verglichen, spätere Abschnitte nach ihrer eigenen Aussage.

## Deviations

Die constraints im Kopf sind bewusste Abweichungen mit Grund, kein Befund.

## Product state

`open`: Jeder installiert das Plugin kostenlos (MIT) ohne Konto, über den Plugin-Marktplatz von Claude Code, den Installer für Codex CLI und Cursor IDE oder den Paketmanager von Pi. Entwurf und Prüfung schlagen keine Handlung vor, die das ausschließt: kein Registrieren, kein Login, kein Preis, kein Formular.

`productState` bleibt JSON in einer Zeile; `# prettier-ignore` darüber hält Prettier davon ab, es umzubrechen.

## Brand and signature

Marke session orchestrator, Wortmarke klein geschrieben. Erkennungszeichen ist das Logo A3: eine Person an einer gemeinsamen Werkbank mit drei Terminal-Modulen mit `>_`-Öffnungen (`site/brand/a3-terminalmodule/`).

Tokens aus `site/assets/site.css` (`:root`, `color-scheme: dark`):
- Farben: `--bg` #101113 (Graphit, Grund), `--surface` #191b1e (Flächen), `--fg` #f5f3ee (Warmweiß, Text), `--fg-2` #bbc0c5 (Nebentext), `--line` #34383c (Linien), `--accent` #d5f478 (Limette, einziger Akzent), `--accent-fg` #101113 (Text auf Limette), `--code-bg` #222529 (Code und Terminal), `--ring` #d5f478 (Fokus).
- Schriften, alle aus `/fonts`: `--font-display` Space Grotesk, `--font-body` Source Sans 3, `--font-mono` IBM Plex Mono.
- Maße: `--text-meta` .8125rem, `--text-body` 1rem, `--text-code` .8125rem, `--radius` 10px, `--gap` 28px, `--sec-pad` clamp(60px, 7.5vw, 104px), `--measure` 68ch.

Das Terminal ist das Markenmittel dieser Seite: Mono-Schrift, `--code-bg`, Limette für die Eingabe. Dazu zwei spätere Tokens in `site/assets/site.css` (Block „2026-10 landing“): `--fail` #ff7a59 (Fehler, auch in `site/assets/how.js`) und `--surface-2` #202327 (zweite Fläche).

## Voice

Direkt, ruhig, ohne Werbesprache. Kurze Sätze, Verben, sagt auch, wo etwas aufhört. Englisch mit „you“, Deutsch mit „du“. Beispiel aus site/index.html: „It is not another AI: your coding tool writes the code, this plugin keeps the work in order.“ Kein Gedankenstrich als Satzzeichen, keine Superlative, keine Zahl ohne Quelle. Der Abschnitt „Made by“ spricht in der ersten Person.

## Imagery

Hauptbild ist ein echter Terminal-Ablauf, gesetzt als Text, nicht als Bild eines Modells. Beispieldaten sind als Beispiel gekennzeichnet. Kennzeichnung je Bildart wie heute auf der Seite: echt „Recreated from a real /session overview, shortened; repository and numbers made up.“, vereinfacht „Schematic, not a screenshot.“, KI „made with AI“. Keine KI-Personen, keine Stockfotos, keine Kundenlogos, keine Zitate oder Testimonials, keine erfundenen Oberflächen.

## Motion

`orchestrated` als Obergrenze für die neue Gestaltung. Signaturmoment: der Ablauf im Terminal läuft einmal durch, das Ja vor `/go` ist sichtbar, nach der Prüfung steht ein grünes Ergebnis. Text und Hauptaktion stehen sofort. Mit reduzierter Bewegung steht der fertige Ablauf als Standbild. Das vorhandene three.js-Modell und der KI-Film sind heutiger Stand; ob sie bleiben, entscheidet der Owner.

## Creative latitude and density

`bold` und `balanced`: eine eigene gestalterische Idee innerhalb der bestehenden Marke, keine neue Marke. Je Abschnitt eine Aussage, Details aufklappbar; der erste Bildschirm eher luftig.

## Rules

- Ein Mittel aus der Marke ist in Ordnung, eines aus der Schablone nicht.
- Echt vor nachgebaut vor KI-generiert. Ein Modell rendert nie lesbare Oberflächen oder Text.
- Kein Text über Gesichtern. Leere Fläche füllt ein Beleg, keine Dekoration.

## Was wahr ist

Jede Aussage mit Fundstelle. Zahlen nur mit Metrik-ID aus `node scripts/site-numbers.mjs --json` (gezählt 2026-11-13 an 40b914e3) oder mit Claim aus `docs/telemetry/telemetry-claims.md`.

- Kostenlos, MIT, kein Konto, läuft lokal: `LICENSE`, `package.json` (license), README.md „Who it is for“.
- Läuft in Claude Code, Codex CLI, Cursor IDE und Pi: README.md, `.orchestrator/steering/product.md`.
- Die Befehle `/session` (feature, deep, housekeeping), `/go`, `/close`, `/plan`, `/evolve`, `/reconcile`, `/bootstrap` gibt es: `commands/session.md`, `skills/{go,close,plan,evolve,reconcile,bootstrap}/SKILL.md`. Auf Codex heißen sie `$session-orchestrator:<name>` (site/index.html).
- Vor `/go` wird nichts gebaut, der Plan wartet auf das Ja: site/index.html „How it works“.
- Nach jeder Runde laufen Tests und Typecheck; `/close` führt den vollen Check (test, typecheck, lint) aus, vergleicht mit dem Plan, committet und legt den Rest als Issues auf GitLab oder GitHub an: README.md „How it works“.
- Agenten nebeneinander auf Claude Code und Codex, nacheinander auf Cursor und Pi: site/index.html, Werkzeugtabelle.
- Der Befehlswächter hat 18 Regeln (`blocked-commands`, `.orchestrator/policy/blocked-commands.json`): 14 blockieren, 4 warnen nur (site/index.html, „14 blocking rules and 4 warning rules“). Er greift auf Claude Code und Codex, auf Cursor und Pi über eine Brücke. Nie „blockiert 18 Befehle“.
- Eine Lektion wird nur mit Zustimmung zur Regel; Regeln tragen ein Ablaufdatum: site/index.html „It learns, with your yes“.
- Ohne eigenen Server; die Update-Abfrage bei npm lässt sich abschalten (`SO_DISABLE_UPDATE_CHECK=1`, `DO_NOT_TRACK=1`); Nutzungsdaten sind aus, bis man zustimmt: site/index.html FAQ, `docs/telemetry.md`.
- macOS und Linux in CI, Windows ungetestet: site/index.html FAQ.
- Repository-Zahlen: Version 5.19.0 (`version`), 52 Skills (`skills`), 31 Befehle (`commands`), 14 Agenten (`agents`), 33 Hook-Dateien (`hooks`), 870 Testdateien (`tests`), 330 Sessions in diesem Repo (`sessions`), 44 Lektionen in diesem Repo (`learnings`), 3054 npm-Downloads in 30 Tagen (`npm-downloads-30d`, Schnappschuss, mit automatischen Abrufen), 53 GitHub-Sterne (`github-stars`, Schnappschuss).
- „15,000+ vitest tests“ (Claim in telemetry-claims.md, Stand 2026-09).
- Maintainer-Korpus, nur mit „Stand 2026-06, vom Maintainer gemeldet, nicht unabhängig prüfbar“: 645 Sessions, 1,680 Lektionen, 7,700+ Agentenläufe, up to 34 parallele Agenten, 17 Repos (Claims in telemetry-claims.md).

## Was nicht behauptet wird

- Keine Prozentzahlen zu Produktivität, Zeitersparnis oder Geschwindigkeit. Die 98.8 % des Claims-Registers sind eine Abschlussquote des Maintainer-Korpus, keine Produktivität, und aus diesem Repo nicht nachrechenbar; nicht im Kopf verwenden.
- Keine Nutzerzahlen. Sessions, Lektionen, Downloads und Sterne sind keine Nutzer.
- Geplantes nur als geplant: Messvergleiche zweier Skill-Fassungen sind „planned, not shipped“ (site/index.html); das Close-Gate der Design-Prüfung bleibt nur Warnung (CHANGELOG.md 5.19.0).
- Grenzen der Lernschleife: trainiert kein Modell, ändert sich nicht ohne Zustimmung, eine Lektion ist keine Regel ohne Ja (site/index.html).
- Sicherheit: nichts über die Einträge unter 5.19.0 „Security“ in CHANGELOG.md hinaus. Die Prüfungen garantieren keinen korrekten Code; kein „sicher“, kein „Sandbox“, kein „verhindert Fehler“.
- Keine Windows-Unterstützung, kein Jira oder Linear, keine Team-Funktionen über die FAQ hinaus, keine Nähe zu Anthropic, OpenAI oder Cursor.
- Nichts aus dem PRD-Entwurf vom 2026-07-25 (Next.js, Remotion, Leaderboard) als Tatsache.
