# Sichtbarkeits-Audit — session-orchestrator.com und die Distributionsflächen

**Datum:** 2026-08-16
**Gegenstand:** die Produktdomain plus die Kanäle, über die das Werkzeug tatsächlich gefunden und installiert wird
**Verfahren:** 8-Rollen-Panel über drei Domains; dieses Dokument enthält den Teil, der dieses Repo betrifft. Die vollständige Auswertung inklusive der Geschwister-Domains liegt im Host-App-Repo unter `docs/audits/2026-08-16-seo-geo-audit.md`.

---

## Die Kernaussage

**Für dieses Produkt ist SEO nicht der erste Hebel — und das ist gemessen, nicht vermutet.**

Für `session-orchestrator` existiert als einziger der auditierten Properties echte Referrer-Telemetrie:

```
gh api /repos/<owner>/session-orchestrator/traffic/views     (14 Tage)
   -> count 44   uniques 31
gh api .../traffic/popular/referrers
   -> github.com 10 Views / 7 Uniques · Google 5/5 · Bing 4/1
gh api .../traffic/clones                                     (14 Tage)
   -> count 1371  uniques 489
npm downloads/Monat: 661   (~22/Tag)
CI-Checkouts, obere Schranke: ~64
```

Rund **zwei einzelne Menschen pro Tag** erreichen die Repo-Seite. Suchmaschinen liefern **6 von 31 Uniques in zwei Wochen**. Dem stehen geschätzt **35–55 Installationen pro Tag** gegenüber.

Die Leute, die installieren, kommen also nicht über eine Seite. Sie kommen über `/plugin marketplace add`, über eine kopierte `git clone`-Zeile, über `pi install npm:`.

**Der Engpass ist nicht das Ranking. Der Engpass ist, dass die Kanäle, die tatsächlich Installationen liefern, kaputt oder nicht gelistet sind.**

Eine Einschränkung, die dazugehört: Die 489 Unique-Cloner sind die eine Zahl, die nicht vollständig zuzuordnen ist. CI-Checkouts wurden auf ~64 begrenzt, aber Drittanbieter-Mirrors, Security-Scanner und eigene Mehrmaschinen-Worktrees lassen sich nicht ausschließen. Fiele ein großer Anteil auf Automatisierung, verengt sich das Verhältnis — die unabhängig gemessenen 661 npm-Downloads pro Monat stünden aber weiterhin für sich.

---

## Der teuerste Einzelbefund

```
anthropics/claude-plugins-community/.claude-plugin/marketplace.json
   session-orchestrator -> source.sha = fdb27d9…   (2026-04-07)
gh api compare/fdb27d9...main  ->  ahead_by: 730 Commits
Beschreibung: "Session-level orchestration for Claude Code…"   (nennt Codex/Cursor/Pi nicht)
homepage:     <alte Autor-Domain>/en/session-orchestrator  ->  301  ->  github.com
```

**Der offizielle In-Product-Kanal installiert seit vier Monaten einen April-Build und beschreibt ein Werkzeug, das drei seiner vier Harnesses verschweigt.** Am 2026-07-18 waren es 588 Commits Rückstand, heute 730 — die Lücke wächst.

Das ist der einzige Hebel im gesamten Audit, der ändert, *was ein Nutzer bekommt* — nicht nur, was er liest. Aufwand ~30 Minuten; der Einreichungstext liegt fertig in `docs/distribution/submission-kit.md` §A1. Nachgetragen an Issue #824.

Nicht betroffen: `/plugin marketplace add <owner>/session-orchestrator` — dort löst `marketplace.json` mit `source: "./"` auf HEAD auf. Nur Installationen über den Community-Katalog sind veraltet.

---

## Weitere Befunde

### Der Live-Build ist veraltet — zum zweiten Mal in vier Wochen

```
Repo (HEAD 957b21b):   3.20.0, npm-publiziert 2026-08-13
Live:                  JSON-LD softwareVersion 3.19.0
                       llms.txt / llms-full.txt / sichtbarer Text: 3.19.0
Cache-busted nachgeprüft: identischer ETag, weiterhin 3.19.0 -> kein CDN-Artefakt
```

Ursache: kein Deploy-Stage in der CI. `scripts/release.mjs:502` *druckt* `cd site && vercel --prod` als Checklistenzeile. Eine Checklistenzeile ist kein Mechanismus — das ist die eigene Doktrin, hier verletzt. → #1043

**Zweite Driftebene:** Der „Numbers"-Block in `llms-full.txt` ist auch **in der Repo-Quelle** veraltet, nicht nur live. Gemessen am 2026-08-03 bei HEAD `d2de3ca`, binnen 12 Tagen sind 5 von 9 Kennzahlen falsch (Version, Hook-Dateien 24→25, Test-Dateien 556→580, Sessions 210→241, Learnings 95→131). `release.mjs:122-130` pflegt nur die Versionsliterale.

Das ist die teuerste Sorte Inhalt: Präzise, datierte Zahlen sind das Zitierfähigste, was man publizieren kann — und das Schädlichste, wenn sie falsch werden, weil sie überprüfbar sind. Ein Produkt, dessen Kernthese mechanische Strenge ist, liefert veraltete Messwerte aus.

Gleiche Klasse: **`v3.18.0` wurde nie auf npm publiziert** (Registry führt 3.16.0, 3.17.0, 3.19.0, 3.20.0). Und die von Suchmaschinen **zwischengespeicherte** GitHub-Beschreibung nennt „37 skills · 18 commands · 13 agents" gegen real 46 / 25 / 15 — Retrieval-Systeme lesen den Cache, nicht die API. Lehre: volatile Zahlen zur Bauzeit generieren oder gar nicht publizieren.

### Rechtliche Lücke

`/impressum`, `/datenschutz`, `/legal`, `/privacy`, `/imprint` → **alle 404.** Als österreichischer Unternehmer greifen §5 ECG und §25 MedienG unabhängig von der `.com`-Endung. Alle drei Geschwister-Domains haben vollständige Rechtsseiten inklusive KI-Transparenz nach EU AI Act Art. 50 Abs. 4 — diese eine nicht. Zugleich E-E-A-T-Defizit: die Seite nennt keinen Verantwortlichen. ~30 Minuten. → #1044

### Entitätslos

```
JSON-LD @graph:  WebSite + SoftwareApplication + Offer
  @id / sameAs / author / publisher / codeRepository / downloadUrl:  je 0
Links auf die Autoren-Domain im HTML:  0
```

Die Domain gehört sichtbar niemandem. `agentic-cutter.com` macht es richtig vor. Der Bruch geht in beide Richtungen: die Personen-Domain führt diese hier ebenfalls nicht in ihrem `sameAs`. Ausgerechnet das Projekt mit der stärksten Fremdbestätigung ist entitätsseitig nicht mit seinem Autor verbunden. Zusätzlich zeigt das GitHub-Repo-Feld `homepage` auf eine andere Marke — ein Feld-Edit, und es ist der meistgeklickte Ausgangs-Slot des Repos. → #1046

**Ertragserwartung ehrlich:** Eine kontrollierte Ahrefs-Analyse fand, dass das *Hinzufügen* von Schema praktisch keinen messbaren Effekt auf AI-Zitationsraten hat. Der belastbare Grund ist Entitäts-Konsolidierung, nicht Ranking. Nicht mehr davon erwarten, als es leistet.

### Duplikate und Header

Drei indexierbare Formen einer Ein-Seiten-Site (`apex`, `www`, `/index.html`), alle mit identischem ETag, entschärft nur durch ein korrektes Canonical. Security-Header auf HSTS reduziert, während die Geschwister den vollen Satz führen — kein Rankingfaktor, aber ein Glaubwürdigkeitsfaktor bei einem sicherheitspositionierten Produkt. → #1045

### Sichtbarkeit in Katalogen und Listen

- **`claudemarketplaces.com`:** 2.629 Marketplaces indiziert, dieses Repo **nicht** darunter; `/marketplace/<owner>` → 404. Ein Katalog mit 31.507 URLs, der die Spitze der „claude code plugin/skill/mcp"-Suche besetzt.
- **Awesome-Listen:** 0 Treffer in `awesome-claude-code` (52.363 Stars) und `awesome-claude-skills` (72.552 Stars).
- **Marketplace-Eintrag ohne `category` und `author`** — Felder, die 94 % bzw. 99 % der 2.281 Einträge ebenfalls fehlen. Billige Differenzierung.
- **GitHub-Releases enden bei v3.17.0 (2026-07-21).** Drei ausgelieferte Tags ohne Release. Ein wöchentlich veröffentlichendes Produkt sieht seit 3½ Wochen tot aus — bei Watcher = 1 sind Releases der einzige Push-Kanal.
- **Null Analytics auf der Seite.** Jede Content- oder SEO-Investition ist konstruktionsbedingt unmessbar. Das ist der Grund, warum Seitenoptimierung in der Reihenfolge hinten steht: der Erfolg wäre nicht nachweisbar.
- **Die eigenen Properties verlinken das Produkt nicht.** Beide Blogposts *über* dieses Werkzeug verlinken ausschließlich eine andere eigene Domain.

### Der Befund, der nicht in die Kategorien passt

**Nutzer betreiben das Werkzeug auf GitHub Copilot CLI** — einem Harness, den das Produkt nirgends erwähnt (`grep -ril copilot README.md site/index.html docs/` → 0 Treffer). Ein externer Beitragender hat dafür sogar einen Fix eingereicht. Von 7 fremden Issues stammen 3 von echten Nutzern.

Das ist die höchstwertige Nutzerforschung im ganzen Repo, und sie steht in keinem Marketing-Text. Entscheidung nötig: unterstützen und bewerben, oder Nicht-Unterstützung dokumentieren. Beides schlägt Schweigen.

---

## Wohin die ersten Stunden gehen

| # | Maßnahme | Aufwand | Warum es eine SEO-Stunde schlägt |
|---|---|---|---|
| 1 | Marketplace-Pin + Metadaten (#824) | ~30 Min | Ändert, *was* Nutzer bekommen, nicht nur was sie lesen |
| 2 | Deploy automatisieren (#1043) | ~20 Min | Ohne das verfällt jeder Content-Fix wieder |
| 3 | GitHub-`homepage` + 3 Releases nachtragen | ~20 Min | Repo ist die Hauptlandefläche (37 von 44 Views) |
| 4 | Eigene Properties verlinken lassen | ~15 Min | Zwei Posts ranken bereits auf den Produktnamen und verlinken falsch |
| 5 | Submission-Kit abarbeiten (#824) | ~3–4 h | Text existiert; jede Listung ist Backlink *und* Discovery-Fläche |
| 6 | Analytics + `sameAs` (#1046) | ~1 h | Macht Schritt 7 entscheidbar statt Glaubenssache |
| 7 | **Dann** Docs auf der eigenen Domain | M–L | Jetzt messbar, mit Links, Inhalt existiert bereits |

Schritte 1–6 sind zusammen etwa **sechs Stunden** und berühren jeden Kanal, der heute Installationen liefert.

### Das Gegenargument, fair dargestellt

Jede Listung konvertiert gegen die Landingpage — eine kaputte Seite deckelt also alle Kanäle. Genau das war die Begründung, C1 in der Distributionsanalyse auf Platz drei zu setzen. **Dieses Argument ist inzwischen weitgehend erfüllt:** Die Seite wurde am 2026-08-03 neu gebaut, lädt in 288 ms mit Brotli, hat Canonical, strukturierte Daten, `og.png`, `llms.txt` und eine Vier-Harness-Installationsmatrix. Im Lighthouse-Vergleich ist sie mit **Performance 99 / LCP 1,7 s mobil** die schnellste aller drei auditierten Domains — die beiden Next.js-Geschwister liegen bei 4,2–4,8 s.

Sie ist nicht mehr der Engpass. Außer dass sie die falsche Version ausliefert — und das ist ein Deploy-Problem, kein SEO-Problem.

---

## Dokumentation: die eine SEO-Maßnahme mit Substanz

Heute: **369 getrackte Markdown-Dateien, davon null auf einer eigenen Domain.** Die Sitemap hat 1 URL; `/docs`, `/install`, `/comparison` liefern 404.

| Option | Dafür | Dagegen |
|---|---|---|
| **GitHub-only (Status quo)** | null Pflege; GitHub rankt bereits auf Markenanfragen; Docs bleiben neben dem Code und können nicht driften | alle Autorität fließt zu github.com; eigene Docs-Seite kann nie ranken; Sitemap bleibt bei 1 URL |
| **`/docs` auf der eigenen Domain** | macht vorhandene Inhalte zu indexierbaren, zitierbaren URLs; interne Verlinkung entsteht überhaupt erst; per-Harness-Installationsseiten treffen echte Long-Tail-Anfragen | braucht Build-Schritt; **zwei Wahrheiten, außer es wird zur Bauzeit generiert**; veraltete Docs sind schlimmer als keine |
| **`docs.`-Subdomain** | saubere Trennung, fertige Docs-Themes | teilt Autorität auf zwei Hosts bei 2 eingehenden Links insgesamt; **keine der 24 gemessenen Vergleichs-Properties macht das** |

**Die schärfere Frage ist nicht welche Option, sondern welche Teilmenge.** 46 Skills + 25 Commands + 16 Agents wären ~87 Seiten — genug, um generiert und dünn zu wirken. 10–15 kuratierte Seiten (Commands, Lebenszyklus, Guardrails, je Harness eine Installationsseite) sind verteidigbar; alle 369 zu publizieren ist ein Content-Qualitätsrisiko, kein Gewinn.

**Und der Kostenpunkt entscheidet die Reihenfolge:** Der Ertrag dieser Option ist unmessbar, solange keine Analytics existiert. Docs sind damit *abhängig von* Schritt 6, nicht von der Lust darauf.

---

## Was der Benchmark relativiert

24 fremde Properties gemessen. Drei Erkenntnisse widersprechen der Erwartung:

**`llms.txt` ist erledigt, nicht rückständig.** Wir haben es auf 3 von 3 Domains, das Vergleichsfeld auf 1 von 12. Zugleich zeigt die Recherche: **keine große Engine liest es nachweislich** — Google hat es öffentlich mit dem Keywords-Meta-Tag verglichen; OpenAI und Anthropic dokumentieren kein Lesen. Anthropic *veröffentlicht* eine, was regelmäßig mit Konsumieren verwechselt wird. Behalten, weil es nichts kostet. Aber **nichts ausschließlich dort ablegen** — und keine Werkzeuge darum herum bauen.

**Stars kaufen keine Web-Sichtbarkeit.** Eine Vergleichs-Property mit 103.251 Stars hat eine **0-URL-Sitemap, keine robots.txt und kein Schema**. Eine andere mit 240.265 Stars liefert 12 URLs. Volumen ist in diesem Feld nicht das Spiel.

**Das übertragbare Muster ist `/for/<Host>`, nicht `/vs/<Wettbewerber>`.** Vergleichsseiten gegen benannte Konkurrenten: 1 von 12. Host-Ökosystem-Seiten: 4 von 12 — und sie fangen fast dieselbe Absicht bei einem Bruchteil der Pflege- und Reputationskosten, weil man das *eigene* Verhalten in fremdem Kontext beschreibt statt ein fremdes Produkt, das sich weiterentwickelt. Vier Harnesses = vier Seiten, deren Inhalt als H3-Blöcke bereits existiert.

**Nicht kopieren:** die 31.507 programmatischen URLs des Katalog-Anbieters (ein durch Sponsoring finanziertes Datenpipeline-Geschäft — dort *gelistet werden*, nicht nachbauen); alle 369 Markdown-Dateien publizieren; einen zweiten Blog eröffnen (eine Vergleichs-Property hat einen Blog mit *einem* Post seit Juni — sichtbar tot ist schlechter als gar keiner).

**Sprache:** Englisch-only ist richtig und sollte nicht revidiert werden. Repo, CLI, Docs, Kataloge und jeder rankende Wettbewerber sind englisch. Eine zweite Locale verdoppelt die Textfläche auf einer Seite, die derzeit nicht einmal *eine* Fassung mit ihrem eigenen Repo synchron hält.

---

## Was nicht verifiziert werden konnte

| Bereich | Grund |
|---|---|
| **Search Console / Indexstatus** | Keine GSC-Property für diese Domain. Das ist selbst ein Befund — jede Maßnahme bleibt bis dahin unmessbar |
| **`cursor.directory`, `claudepluginhub`** | HTTP 429 bzw. Bot-Schutz. Listungsstatus **unbekannt**, nicht „nicht gelistet" |
| **Pi-Gallery** | nicht geprüft |
| **Welchen Katalog `claude.com/plugins/*` rendert** | `/session-orchestrator` → 404, Kontrollen → 200. Der Kontrast ist verifiziert, der Mechanismus nicht. **Nicht allein darauf handeln** |
| **Rankings, SERP-Positionen** | keine Messung durchgeführt. Das Argument zur Namenskollision („session orchestrator" ist Standardvokabular in Kubernetes, Telco und Streaming) ist **abgeleitet**, nicht gemessen |
| **Website-Traffic** | strukturell unbekannt — keine Analytics |
| **Fremdpräsenz** (HN, Reddit, YouTube, Blogs) | Rechercheteil erreichte den Bericht nicht. Verifiziert ist nur die **Abwesenheit** aus zwei Awesome-Listen und die Präsenz von 3 externen Beitragenden. Als **ungemessen** behandeln, nicht als null |
| **Star-Wachstum** | Zeitreihe verifiziert (5 Stars in 4 Monaten, letzter 2026-08-02); die Ursache der Verlangsamung nicht |

---

## Verweise

- Vollständiges Audit über alle Domains: `docs/audits/2026-08-16-seo-geo-audit.md` (Host-App-Repo)
- Issues: #824 (Katalog-Submits, mit frischer Messung kommentiert) · #1043 (Deploy) · #1044 (Recht) · #1045 (Duplikate/Header) · #1046 (Entität) · #978 (Release-als-ein-Dispatch, berührt die npm-Lücke)
- Vorarbeit: `docs/distribution/2026-07-18-distribution-options.md` · `docs/distribution/submission-kit.md` · `docs/prd/2026-07-25-session-orchestrator-com-redesign.md` (dessen Faktenlage ist überholt — siehe Statusabgleich im Panel-Bericht)
