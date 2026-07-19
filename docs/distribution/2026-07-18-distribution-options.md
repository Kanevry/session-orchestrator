# Distribution & Etablierung — Optionsmatrix (W2-Synthese)

> Session: main-2026-07-18-session-1 (deep, Research). Quellen: 6 Research-Agents (R1–R6), alle Kanäle fetch-verifiziert Stand 2026-07-18. Vollständige Reports im Session-Transkript.

## Ausgangslage (verifiziert)

- Public GitHub-Mirror `Kanevry/session-orchestrator`: 46 Stars, MIT, `.claude-plugin/plugin.json` + `marketplace.json` v3.14.0
- **Bereits gelistet** im offiziellen Anthropic-Community-Marketplace (`anthropics/claude-plugins-community`, 2.248 Plugins) — **aber SHA-gepinnt auf `fdb27d9` (2026-04-07), 588 Commits hinter HEAD**; Katalog-Metadaten (Description, Homepage zeigte noch die alte Author-Domain-URL statt session-orchestrator.com) veraltet; der dokumentierte CI-Auto-Bump greift bei uns nicht
- **Nicht auf npm publiziert** → `pi-package`-Keyword inert, Pi-Gallery-Unsichtbarkeit, kein npx-Einstieg; Name `session-orchestrator` auf npm frei
- Nicht indexiert in claudemarketplaces.com (300k Besucher/M, Auto-Crawl) und claudepluginhub.com
- Landing Page session-orchestrator.com live (Platzhalter-Charakter), Setup-Docs für Codex/Cursor/Pi vorhanden

## Schlüssel-Erkenntnisse aus den Benchmarks (R5/R6)

1. **Official Marketplace + npm schlagen Awesome-Listen.** superpowers: 966k Installs via `claude-plugins-official`; gsd-core: 38,9k npm-Downloads/M via npx-One-Liner. KEINES der 8 untersuchten Tools steht in awesome-claude-code.
2. **Owner-Video ist der stärkste Einzelhebel.** BMAD-Masterclass 329k Views (eigener Kanal, 34,5k Subs) → löste 230k-Views-Drittvideos aus.
3. **npx-Reibungsarmut korreliert mit Downloads.** npx-Tools: 117k–375k/M; pipx-Tool (SuperClaude): 59k; clone-only (ccpm): stagniert trotz 8k Stars.
4. **Multi-Harness in Satz 1 + genau eine Install-Zeile pro Harness** (superpowers 10 Harnesses, gsd 9). Wir haben die Story (Claude Code/Codex/Cursor/Pi), spielen sie aber nicht aus.
5. **Release-Kadenz ist ein Adoption-Signal** (ruflo: tägliche Releases + r/ClaudeAI-Announce pro Major; SuperClaude: 4 Monate still → Stagnation).
6. **HN ist irrelevant** für diese Kategorie (alle Tools <7 Punkte).

## Optionsmatrix

Aufwand: S (<1h) / M (1–4h) / L (Projekt). Reichweite/Fit: hoch/mittel/niedrig. ✋ = externer Schritt braucht Operator (Browser-Login) bzw. Freigabe.

### Track A — Claude-Code-Ökosystem (Fix & Submit)

| # | Kanal | Aktion | Aufwand | Reichweite | Fit | Blocker/Notiz |
|---|---|---|---|---|---|---|
| A1 | **Anthropic `claude-community`** (bereits gelistet!) | plugin.json-Metadaten aktualisieren (Homepage → session-orchestrator.com, Description modernisieren), `claude plugin validate --strict` grün, dann Pin-Refresh via Console-Form ✋ / Auto-Bump-Ursache klären | M | hoch (In-Product-Kanal) | hoch | **Dringendster Fix**: Installs laufen heute gegen 3-Monate-alten Code. `experimental.monitors` vor Submission gegen --strict prüfen |
| A2 | **claudemarketplaces.com** (300k Bes./M) | Indexierungs-Gap klären (Auto-Crawl auf marketplace.json), ggf. Issue bei mertbuilds/claudemarketplaces.com ✋ | S | hoch | hoch | Zero-Cost wenn Crawl greift; Ursachen-Kandidaten: Schema-Detail, Crawl-Discovery |
| A3 | **claudepluginhub.com** | Submit-Formular (Repo-URL) ✋ | S | mittel | mittel-hoch | 403-Bot-Schutz → Browser nötig; Konkurrenz-Orchestratoren sind dort gelistet |
| A4 | **awesome-claude-code** (50,3k Stars) | Issue-Form (NICHT PR), nüchterne Ein-Zeilen-Beschreibung ✋ | S | mittel | hoch | Annahme ungewiss („best-effort, selektiv"); Benchmark zeigt: nicht der Kanal der Gewinner |
| A5 | **Anthropic Official Marketplace** | KEIN Self-Serve — Partner-Kontakt + Traktion nötig | L | sehr hoch | mittel (heute) | Later-Stage; Voraussetzung: A1 gefixt + Install-Traktion. Widerspruchs-Note: R6-Muster #1 behauptete dokumentierten Submission-Prozess — R1s Docs-Zitat ist stärker: „There is no application process" |
| A6 | wshobson/agents (38k Stars) | Maintainer-Outreach für git-subdir-Eintrag ✋ | S | mittel | mittel | Multi-Harness-Story als Argument; Ermessens-Entscheid des Maintainers |
| A7 | Kleinere Kataloge (tonsofskills/ccpi, cc-marketplace, ComposioHQ) | PR/Formulare | S–M | niedrig | niedrig-mittel | Nur bei Restkapazität; ComposioHQ hat 238 offene PRs (Merge-Stau) |

### Track B — Multi-Harness (Codex / Cursor / Pi)

| # | Kanal | Aktion | Aufwand | Reichweite | Fit | Blocker/Notiz |
|---|---|---|---|---|---|---|
| B1 | **npm-Publish** (Pi + npx-Fundament) | `files`-Whitelist in package.json, `npm pack --dry-run` + Owner-Leakage-Check auf Tarball, Publish ✋ (npm-Auth), docs/pi-setup.md auf `pi install npm:session-orchestrator` umstellen | M | hoch (Pi: 6,6M Agent-DL/M, 5,3k Pakete) | hoch | **Ohne Publish strukturell unsichtbar in Pi.** Gefahr: Tarball dürfte heute tests/ + .orchestrator/metrics/ mitnehmen → Leakage-Check zwingend. „Recently published"-Sortierung = Launch-Fenster |
| B2 | **Codex-Plugin-Adapter** | `.codex-plugin/plugin.json` (+ ggf. Codex-marketplace.json) shippen → `codex plugin marketplace add Kanevry/session-orchestrator` funktioniert | M | mittel-hoch | hoch | Struktur (skills/, hooks/ auf Root) passt bereits; Voraussetzung für B3 |
| B3 | **Codex-Listings**: awesome-codex-cli-PR (Kategorie „Multi-Agent Orchestration"), Show-and-tell-Discussion in openai/codex, OpenAI Developer Showcase-Formular | je S ✋ | mittel | hoch | Nach B2; Konkurrenz dort kleiner als wir denken (Einträge teils <46 Stars) |
| B4 | **cursor.directory** (jetzt offizielles Community-Verzeichnis) | Repo-URL via cursor.directory/plugins/new einreichen ✋ — Auto-Detection matcht `skills/*/SKILL.md` + `agents/*.md` heute | S | mittel-hoch („84.9k+ devs" nur Snippet-Evidenz) | hoch | 10 Minuten; Security-Scan läuft automatisch; Gaps (Rules als .md statt .mdc, hooks.json-Layout) später |
| B5 | Cursor Official Marketplace | `.cursor-plugin/plugin.json`-Port + manuelles Review | L | hoch | mittel | Later-Stage, erst nach B4-Signal |
| B6 | OpenAI Official Plugin Directory | Identity-Verifikation + 5+3 Test-Cases + Policy-Scan aller Skills | L | sehr hoch | mittel | Later-Stage; eigenes Projekt |
| B7 | **Pi-Community**: Discord-Announce + Mario Zechner (Graz — AT-Bezug) via Bluesky/Mastodon | S ✋ | mittel | hoch | Nach B1; organische Gallery-Sichtbarkeit bei 5,3k Paketen gering, Discord = Erstkontakt. Wettbewerb existiert (pi-spine „parallel wave support") → USP schärfen |

### Track C — Playbook-Maßnahmen (aus Benchmarks)

| # | Maßnahme | Aufwand | Hebel | Evidenz |
|---|---|---|---|---|
| C1 | **README + Landing Page repositionieren**: Multi-Harness in Satz 1, eine Install-Zeile pro Harness (Claude Code / Codex / Cursor / Pi), npm-Badge nach B1, Verification-Gates als Pfeiler-Story (opengsd-Muster) | M | hoch | superpowers/gsd-Muster; unsere aktuelle Description erwähnt Pi nicht mal |
| C2 | **npx-Einstieg** `npx session-orchestrator init` (nach B1) | M–L | hoch | 117k–375k DL/M bei npx-Tools vs. Stagnation bei clone-only |
| C3 | **Owner-Masterclass-Video** (30–60 min Deep-Session end-to-end) | L (Operator) | sehr hoch | BMAD: 329k Views → Dritt-Videos mit 230k Views |
| C4 | **Announce-Disziplin**: Release-Posts pro Major (r/ClaudeAI, Pi-Discord, Show-and-tell) | S je Release | mittel | ruflo-Kadenz vs. SuperClaude-Stille |
| C5 | Zwei Onboarding-Pfade (`/session` Greenfield vs. Bestandsrepo-Onboarding) dokumentieren | M | mittel | gsd `/gsd-new-project` vs `/gsd-onboard`; cc-sessions Kickstart |

## Empfohlene Reihenfolge (Koordinator-Empfehlung)

1. **A1 Pin-Refresh + Metadaten** — wir verlieren heute aktiv Nutzer an einen 3-Monate-alten Stand
2. **B1 npm-Publish (mit Leakage-Gate)** — schaltet Pi-Gallery + npx-Story + Downloads-Badge frei
3. **C1 README/Landing-Repositionierung** — Voraussetzung, damit alle Listings konvertieren
4. **B2 Codex-Adapter** → B3-Listings, **B4 cursor.directory**, **A2/A3** Index-Gaps — die billigen Submits
5. **A4 awesome-claude-code** + B7 Pi-Community — flankierend
6. Later-Stage: A5/B5/B6 (offizielle kuratierte Kataloge), C2/C3 als eigene Vorhaben

## Tote/aussortierte Kanäle

- claudecodemarketplace.com (404, tot) · claude-plugins.dev (Submission-Mechanik unauffindbar) · qualisero/awesome-pi-agent (archiviert 2026-06) · anthropics/skills (kein Verzeichnis, PRs versanden) · AGENTS.md/agents.md (kein Tooling-Verzeichnis — Feature-Claim, kein Kanal) · HN (kategorie-irrelevant, Evidenz R5) · community.openai.com (Bug-Report-Kultur, kein Showcase)
